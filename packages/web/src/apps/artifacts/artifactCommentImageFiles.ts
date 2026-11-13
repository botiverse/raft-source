// Images a comment box takes (#proj-workspace:#146, phase 2): which files it accepts, and the
// bytes it uploads. The Server decides the type by the bytes and refuses what it won't keep; this
// is the box's own first check, so a wrong file is said at once instead of after an upload.
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_IMAGE_TYPES, ARTIFACT_COMMENT_MAX_IMAGES } from "@botiverse/raft-shared";
import type { ArtifactCommentImageType } from "@botiverse/raft-shared";

/** The file picker's `accept`: the types a comment may carry (never SVG). */
export const COMMENT_IMAGE_ACCEPT = ARTIFACT_COMMENT_IMAGE_TYPES.join(",");

/** An image's long edge at most, in pixels, once encoded again in the browser. */
export const COMMENT_IMAGE_MAX_EDGE = 2560;

/** JPEG and WebP quality when encoded again. */
const ENCODE_QUALITY = 0.9;

/**
 * Why the box didn't take a file: not an image it can carry, too large, no room left
 * (ARTIFACT_COMMENT_MAX_IMAGES), or a pasted file the browser could no longer read (the box's
 * `addPasted`, through materializePastedFile).
 */
export type CommentImageRefusal = "type" | "size" | "count" | "unreadable";

const TYPES: ReadonlySet<string> = new Set(ARTIFACT_COMMENT_IMAGE_TYPES);

/** The file's declared type when a comment may carry it; null for anything else (a PDF, an SVG, no type). */
export function commentImageTypeOf(file: Blob): ArtifactCommentImageType | null {
  const type = file.type.toLowerCase();
  return TYPES.has(type) ? (type as ArtifactCommentImageType) : null;
}

/**
 * The files the box takes, in order, with `room` places left (ARTIFACT_COMMENT_MAX_IMAGES less those
 * it holds), and why it left the others: not a PNG, JPEG, WebP or GIF; a PNG or GIF too large (they
 * go byte for byte, so their size is known now); more than there is room for. A JPEG's or WebP's
 * size is checked once its bytes are ready (prepareCommentImage may make them smaller).
 */
export function pickCommentImages(files: readonly File[], room: number): { taken: File[]; refused: Set<CommentImageRefusal> } {
  const refused = new Set<CommentImageRefusal>();
  const taken: File[] = [];
  for (const file of files) {
    const type = commentImageTypeOf(file);
    if (!type) refused.add("type");
    else if ((type === "image/png" || type === "image/gif") && file.size > ARTIFACT_COMMENT_IMAGE_MAX_BYTES) refused.add("size");
    else if (taken.length >= Math.max(0, Math.min(room, ARTIFACT_COMMENT_MAX_IMAGES))) refused.add("count");
    else taken.push(file);
  }
  return { taken, refused };
}

/** Whether the bytes to upload fit a comment image (ARTIFACT_COMMENT_IMAGE_MAX_BYTES; empty is no image). */
export const commentImageFits = (bytes: Blob) => bytes.size > 0 && bytes.size <= ARTIFACT_COMMENT_IMAGE_MAX_BYTES;

/** A decoded image, already turned as its EXIF orientation says. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Drawn at width × height and encoded as `type`; null when the browser can't. */
  encode: (width: number, height: number, type: string, quality: number) => Promise<Blob | null>;
  close: () => void;
}

/** How the browser decodes an image (createImageBitmap, oriented); null where it can't. Tests give their own. */
export type ImageDecoder = (file: Blob) => Promise<DecodedImage | null>;

async function canvasBlob(bitmap: ImageBitmap, width: number, height: number, type: string, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality });
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The browser's decoder: createImageBitmap with the EXIF orientation applied. */
export const browserImageDecoder: ImageDecoder = async (file) => {
  if (typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return {
    width: bitmap.width,
    height: bitmap.height,
    encode: (width, height, type, quality) => canvasBlob(bitmap, width, height, type, quality),
    close: () => bitmap.close(),
  };
};

/** The size an image is drawn at: its own, or COMMENT_IMAGE_MAX_EDGE on its long edge. */
export function commentImageSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, COMMENT_IMAGE_MAX_EDGE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The bytes the box uploads for `file`. A JPEG is always drawn again through a canvas: that drops its
 * EXIF (a phone photo's GPS among it) and turns it as its orientation says, so it shows the right way
 * up wherever it is shown. A WebP is drawn again only when its long edge is over
 * COMMENT_IMAGE_MAX_EDGE, then made that size; a JPEG over it is made that size too. PNG and GIF go
 * as they are, byte for byte (a screenshot stays lossless, an animation keeps moving); the Server
 * removes their metadata itself. Whatever the browser can't decode or encode goes as it is: the
 * Server checks the bytes and removes metadata from everything it keeps.
 */
export async function prepareCommentImage(file: Blob, decode: ImageDecoder = browserImageDecoder): Promise<Blob> {
  const type = commentImageTypeOf(file);
  if (type !== "image/jpeg" && type !== "image/webp") return file;
  let decoded: DecodedImage | null = null;
  try {
    decoded = await decode(file);
    if (!decoded) return file;
    const longEdge = Math.max(decoded.width, decoded.height);
    if (type === "image/webp" && longEdge <= COMMENT_IMAGE_MAX_EDGE) return file;
    const size = commentImageSize(decoded.width, decoded.height);
    const encoded = await decoded.encode(size.width, size.height, type, ENCODE_QUALITY);
    // A browser that encodes another type (no WebP encoder: PNG) would change what was attached.
    return encoded && encoded.type === type && encoded.size > 0 ? encoded : file;
  } catch {
    return file;
  } finally {
    decoded?.close();
  }
}
