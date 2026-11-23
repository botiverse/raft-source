/**
 * Conservative client-side photo resize before a message attachment upload
 * (#triage:#545). Upload time grows with the body the client has to send
 * (p90: 2.4s under 1 MB, 20s at 3–6 MB, 42s at 6–10 MB, 150s at >= 10 MB),
 * and the server is not the bottleneck. Large camera photos are the bulk of
 * the slow uploads, so they are scaled down before they are sent.
 *
 * The rule (product decision, no user toggle):
 *   - only JPEG / WebP (by MIME; by .jpg/.jpeg/.webp when the MIME is empty),
 *     and only at >= 3 MiB;
 *   - decoded with EXIF orientation applied, scaled so the long edge is at
 *     most 2560 px (never upscaled), re-encoded to the same type at 0.85
 *     (WebP falls back to JPEG, with the extension fixed, when the browser
 *     cannot encode WebP);
 *   - kept only when the result is under 70% of the original; on any failure,
 *     timeout or missing API the original is uploaded unchanged.
 * The re-encoded file carries no EXIF (GPS included) — accepted.
 *
 * Resizes run one at a time (a module-level queue): a full-size decode of a
 * 12 MP photo is ~48 MB, and ten picked at once would exhaust memory on iOS.
 */

export const IMAGE_RESIZE_MIN_BYTES = 3 * 1024 * 1024;
/** Above this the decode alone could exhaust memory; such files go up unchanged. */
export const IMAGE_RESIZE_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const IMAGE_RESIZE_MAX_LONG_EDGE = 2560;
export const IMAGE_RESIZE_QUALITY = 0.85;
/** The resized file is kept only when it is smaller than this share of the original. */
export const IMAGE_RESIZE_MAX_RATIO = 0.7;
/**
 * The resize must never hold an upload back for long: past this, the original
 * goes. Counted from when this file's own decode starts (not its queue wait).
 */
export const IMAGE_RESIZE_TIMEOUT_MS = 15_000;
/**
 * How long a file waits for the resize slot (see `resizeQueueTail`) before it
 * gives up and goes as the original. Bounds the wait behind a decode that
 * never settles.
 */
export const IMAGE_RESIZE_QUEUE_TIMEOUT_MS = 60_000;

export type ResizableImageType = "image/jpeg" | "image/webp";

export type ImageResizeOutcome =
  | "resized"
  | "not_eligible"      // not JPEG/WebP, under 3 MiB, or too large to decode safely
  | "already_prepared"  // the output of an earlier resize (a retry)
  | "unsupported"       // no createImageBitmap / canvas in this browser
  | "decode_failed"
  | "encode_failed"
  | "not_smaller"       // the result was not under 70% of the original
  | "timeout"
  | "error";

export type PreparedAttachmentFile = Readonly<{
  /** What to upload: the resized file, or the original. */
  file: File;
  outcome: ImageResizeOutcome;
  originalBytes: number;
  /** Dimensions of the resized file (only when outcome = "resized"). */
  width?: number;
  height?: number;
}>;

export type DecodedImage = Readonly<{
  width: number;
  height: number;
  close: () => void;
}>;

/** The browser-dependent half, injectable so the decision logic is testable without a canvas. */
export interface ImageResizeCodec {
  /** Decode with EXIF orientation applied. Rejects when the browser cannot decode the file. */
  decode(file: Blob): Promise<DecodedImage>;
  /**
   * Draw the image at `width` x `height` and encode it. Resolves to null when
   * encoding fails. The blob's `type` is what the browser actually produced
   * (browsers silently fall back to PNG for types they cannot encode).
   */
  encode(image: DecodedImage, width: number, height: number, type: ResizableImageType, quality: number): Promise<Blob | null>;
}

const JPEG_EXTENSIONS = /\.(jpe?g)$/i;
const WEBP_EXTENSION = /\.webp$/i;

/** The type a resize keeps the file in, or null when this file is never resized. */
export function resizableImageType(file: Pick<File, "type" | "name">): ResizableImageType | null {
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "image/jpeg") return "image/jpeg";
  if (mime === "image/webp") return "image/webp";
  if (mime !== "") return null;
  if (JPEG_EXTENSIONS.test(file.name)) return "image/jpeg";
  if (WEBP_EXTENSION.test(file.name)) return "image/webp";
  return null;
}

export function isImageResizeCandidate(file: File): boolean {
  return resizableImageType(file) !== null
    && file.size >= IMAGE_RESIZE_MIN_BYTES
    && file.size <= IMAGE_RESIZE_MAX_INPUT_BYTES;
}

/** Long edge capped at `maxLongEdge`, aspect kept, never upscaled. */
export function resizedDimensions(
  width: number,
  height: number,
  maxLongEdge = IMAGE_RESIZE_MAX_LONG_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The original name, with only the extension changed when the type changed. */
export function filenameForResizedType(name: string, originalType: ResizableImageType, outputType: ResizableImageType): string {
  if (originalType === outputType) return name;
  const extension = outputType === "image/jpeg" ? ".jpg" : ".webp";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}${extension}`;
}

/** Files this module produced: a retry must not re-encode its own output. */
const preparedFiles = new WeakSet<File>();

type CanvasLike = Readonly<{
  getContext: (kind: "2d") => {
    drawImage: (image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) => void;
    fillRect: (x: number, y: number, w: number, h: number) => void;
    fillStyle: unknown;
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: ImageSmoothingQuality;
  } | null;
}>;

type BitmapImage = DecodedImage & Readonly<{ bitmap: ImageBitmap }>;

function drawInto(canvas: CanvasLike, image: BitmapImage, width: number, height: number, type: ResizableImageType): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  if (type === "image/jpeg") {
    // JPEG has no alpha: a transparent WebP falling back to JPEG would turn black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image.bitmap, 0, 0, width, height);
  return true;
}

/** createImageBitmap + OffscreenCanvas.convertToBlob, or a <canvas>.toBlob fallback. Null when unavailable. */
export function browserImageResizeCodec(): ImageResizeCodec | null {
  if (typeof globalThis.createImageBitmap !== "function") return null;
  const hasOffscreen = typeof globalThis.OffscreenCanvas === "function";
  const hasDocumentCanvas = typeof globalThis.document?.createElement === "function";
  if (!hasOffscreen && !hasDocumentCanvas) return null;
  return {
    async decode(file) {
      const bitmap = await globalThis.createImageBitmap(file, { imageOrientation: "from-image" });
      const image: BitmapImage = {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
      return image;
    },
    async encode(decoded, width, height, type, quality) {
      const image = decoded as BitmapImage;
      if (hasOffscreen) {
        try {
          const canvas = new OffscreenCanvas(width, height);
          if (drawInto(canvas as unknown as CanvasLike, image, width, height, type)) {
            return await canvas.convertToBlob({ type, quality });
          }
        } catch {
          // Fall through to the <canvas> path.
        }
      }
      if (!hasDocumentCanvas) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      if (!drawInto(canvas as unknown as CanvasLike, image, width, height, type)) return null;
      return new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), type, quality);
      });
    },
  };
}

class ResizeFailure extends Error {
  constructor(public readonly outcome: ImageResizeOutcome) {
    super(outcome);
  }
}

async function encodeAs(
  codec: ImageResizeCodec,
  image: DecodedImage,
  width: number,
  height: number,
  type: ResizableImageType,
): Promise<Blob | null> {
  try {
    const blob = await codec.encode(image, width, height, type, IMAGE_RESIZE_QUALITY);
    return blob && blob.type === type && blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

async function resize(
  file: File,
  type: ResizableImageType,
  codec: ImageResizeCodec,
  abandoned: () => boolean,
): Promise<PreparedAttachmentFile> {
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new ResizeFailure("decode_failed");
  }
  try {
    // Timed out (or cancelled) during the decode: release the bitmap now rather than encode for nobody.
    if (abandoned()) throw new ResizeFailure("timeout");
    if (!(image.width > 0 && image.height > 0)) throw new ResizeFailure("decode_failed");
    const { width, height } = resizedDimensions(image.width, image.height);
    let outputType: ResizableImageType = type;
    let blob = await encodeAs(codec, image, width, height, type);
    if (!blob && type === "image/webp") {
      outputType = "image/jpeg";
      blob = await encodeAs(codec, image, width, height, outputType);
    }
    if (!blob) throw new ResizeFailure("encode_failed");
    if (blob.size >= file.size * IMAGE_RESIZE_MAX_RATIO) throw new ResizeFailure("not_smaller");
    const resized = new File([blob], filenameForResizedType(file.name, type, outputType), {
      type: outputType,
      lastModified: file.lastModified,
    });
    preparedFiles.add(resized);
    return { file: resized, outcome: "resized", originalBytes: file.size, width, height };
  } finally {
    try {
      image.close();
    } catch {
      // Already released.
    }
  }
}

/**
 * The resize slot: at most one decode/encode is in flight. Each task chains on
 * the previous one and holds the slot until its own work settles, even after
 * its caller timed out and moved on, because a decode cannot be aborted;
 * that is what keeps timed-out work from piling up. A file that waits longer
 * than IMAGE_RESIZE_QUEUE_TIMEOUT_MS goes as the original and skips its turn.
 */
let resizeQueueTail: Promise<void> = Promise.resolve();

function inResizeSlot(task: () => Promise<void>): void {
  const run = resizeQueueTail.then(task);
  resizeQueueTail = run.catch(() => undefined);
}

/**
 * The file to upload for `file`: a resized copy when the rule applies and it
 * pays off, else `file` itself. Never rejects.
 */
export async function prepareAttachmentFileForUpload(
  file: File,
  options: Readonly<{
    /** null = this browser cannot resize. Defaults to the real browser codec. */
    codec?: ImageResizeCodec | null;
    timeoutMs?: number;
    queueTimeoutMs?: number;
    /** A cancelled upload leaves the queue (or drops its encode) at once. */
    signal?: AbortSignal;
  }> = {},
): Promise<PreparedAttachmentFile> {
  const original = (outcome: ImageResizeOutcome): PreparedAttachmentFile => ({ file, outcome, originalBytes: file.size });
  if (preparedFiles.has(file)) return original("already_prepared");
  const type = resizableImageType(file);
  if (!type || !isImageResizeCandidate(file)) return original("not_eligible");
  let codec: ImageResizeCodec | null;
  try {
    codec = options.codec !== undefined ? options.codec : browserImageResizeCodec();
  } catch {
    codec = null;
  }
  if (!codec) return original("unsupported");
  const resizeCodec = codec;
  const { signal } = options;
  if (signal?.aborted) return original("error");

  return new Promise<PreparedAttachmentFile>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PreparedAttachmentFile) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // Never reported: the upload rethrows the abort right after preparing.
    const onAbort = () => finish(original("error"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(original("timeout")), options.queueTimeoutMs ?? IMAGE_RESIZE_QUEUE_TIMEOUT_MS);
    inResizeSlot(async () => {
      if (settled) return; // Gave up while queued: skip the decode entirely.
      clearTimeout(timer);
      timer = setTimeout(() => finish(original("timeout")), options.timeoutMs ?? IMAGE_RESIZE_TIMEOUT_MS);
      const result = await resize(file, type, resizeCodec, () => settled).catch((error: unknown) => (
        original(error instanceof ResizeFailure ? error.outcome : "error")
      ));
      finish(result);
    });
  });
}
