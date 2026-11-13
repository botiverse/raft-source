import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import AnimatedImageCanvas, { drawFrameAndClose, hasImageDecoder, sizeCanvas } from "./AnimatedImageCanvas";

/** The card's picture box (aspect-video, filled stretch); every state keeps it. */
export const CARD_BOX_CLASS = "relative mb-3 aspect-video overflow-hidden rounded-control bg-fill-muted";
const IMAGE_CLASS = "h-full w-full object-fill";
const LAYER_CLASS = "absolute inset-0 block h-full w-full";
/** Used when the box has no layout yet (it is about 189×106 in the sidebar). */
const FALLBACK_WIDTH = 320;
/** Enough bytes to tell a GIF or an animated WebP (VP8X flags at byte 20). */
const HEAD_BYTES = 21;

/** Images already checked: not animated (fetched through CORS, so the img
 *  asks the same way and takes it from the cache), or the check failed (the
 *  plain img as before, and no check again). Either way, no second check. */
const knownStill = new Set<string>();
const checkFailed = new Set<string>();

type AnimatedType = "image/gif" | "image/webp";

type Picture =
  | { src: string; kind: "plain"; cors: boolean }
  /** Animated, no ImageDecoder: a PNG of the first frame, never played. */
  | { src: string; kind: "still"; stillUrl: string }
  /** Animated: the first frame is on the still canvas; it plays on a canvas. */
  | { src: string; kind: "frames"; type: AnimatedType }
  /** Animated, but no still could be made: the empty box keeps the alt text. */
  | { src: string; kind: "unavailable" };

function canMakeBitmapStill(): boolean {
  return typeof createImageBitmap === "function" && typeof URL.createObjectURL === "function";
}

function canCheck(): boolean {
  return typeof fetch === "function" && typeof ReadableStream === "function" && (hasImageDecoder() || canMakeBitmapStill());
}

/** A GIF, or a WebP whose VP8X header sets the animation flag: read from the
 *  bytes, not the Content-Type, so a mislabelled GIF is still caught. */
function animatedType(head: Uint8Array): AnimatedType | null {
  if (head.length < 6) return null;
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  if (tag(0) === "GIF8") return "image/gif";
  return head.length >= HEAD_BYTES && tag(0) === "RIFF" && tag(8) === "WEBP" && tag(12) === "VP8X" && (head[20]! & 0x02) !== 0 ? "image/webp" : null;
}

/** Reads the first bytes of the body and hands back the whole body, unread
 *  bytes included, as a new stream: one download serves the check and the still. */
async function peek(body: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const head = new Uint8Array(Math.min(length, HEAD_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= head.length) break;
    const part = chunk.subarray(0, head.length - at);
    head.set(part, at);
    at += part.length;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, stream };
}

/** Reads the rest of the download and drops it, so the HTTP cache holds the
 *  whole image for the player's request (which asks the same way). */
function drain(stream: ReadableStream<Uint8Array>): void {
  const reader = stream.getReader();
  const next = (): Promise<void> => reader.read().then(({ done }) => (done ? undefined : next()));
  void next().catch(() => undefined);
}

/** One small PNG of the bitmap (the first frame), so only this size stays decoded. */
async function encodeStill(bitmap: ImageBitmap): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png"));
}

async function bitmapStill(stream: ReadableStream<Uint8Array>, width: number, height: number): Promise<Blob> {
  const blob = await new Response(stream).blob();
  // Decodes and scales only the first frame.
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  try {
    return await encodeStill(bitmap);
  } finally {
    bitmap.close();
  }
}

/** Draws frame 0 on the canvas as soon as its bytes arrive (`decode` with the
 *  default completeFramesOnly resolves once the whole first frame is in). The
 *  decoder alone reads the stream, to its end, so the HTTP cache keeps the
 *  whole file for the player's own fetch; it is closed once the stream is in
 *  (`completed`), which frees the encoded bytes it held. No tee: a branch
 *  nobody reads would queue every later chunk. */
async function frameStill(stream: ReadableStream<Uint8Array>, type: AnimatedType, canvas: HTMLCanvasElement, signal: AbortSignal): Promise<void> {
  const decoder = new ImageDecoder({ data: stream, type });
  const abort = () => decoder.close();
  signal.addEventListener("abort", abort);
  // Closed once the rest of the file is in (for the cache) or on abort; in the
  // background, so the still is up as soon as frame 0 is drawn.
  const release = () => {
    signal.removeEventListener("abort", abort);
    decoder.close();
  };
  try {
    const { image } = await decoder.decode({ frameIndex: 0 });
    if (signal.aborted) {
      image.close();
      release();
      return;
    }
    sizeCanvas(canvas);
    await drawFrameAndClose(canvas, image);
  } catch (error) {
    release();
    throw error;
  }
  void decoder.completed.catch(() => {}).finally(release);
}

type BoxSize = { width: number; height: number };

async function check(src: string, size: BoxSize, canvas: () => HTMLCanvasElement | null, signal: AbortSignal): Promise<Picture> {
  // The public image route is anonymous and sends CORS headers; "same-origin"
  // sends no cookies to the API origin, but keeps the operator preview's
  // same-origin, cookie-checked asset route working.
  const response = await fetch(src, { credentials: "same-origin", signal });
  if (!response.ok || !response.body) throw new Error(`image ${response.status}`);
  const { head, stream } = await peek(response.body);
  const type = animatedType(head);
  if (!type) {
    drain(stream);
    knownStill.add(src);
    return { src, kind: "plain", cors: true };
  }
  // From here on the image is known to be animated: it never goes in an img.
  try {
    const target = canvas();
    if (target && hasImageDecoder() && await ImageDecoder.isTypeSupported(type)) {
      await frameStill(stream, type, target, signal);
      return { src, kind: "frames", type };
    }
    if (canMakeBitmapStill()) {
      const still = await bitmapStill(stream, size.width, size.height);
      if (signal.aborted) return { src, kind: "unavailable" };
      return { src, kind: "still", stillUrl: URL.createObjectURL(still) };
    }
    void stream.cancel().catch(() => undefined);
  } catch (error) {
    if (!signal.aborted) console.warn("Announcement picture: could not make a still of the animated image", error);
  }
  return { src, kind: "unavailable" };
}

/** An announcement picture (the sidebar card's, and the modal's). An animated
 *  image (a GIF, or an animated WebP) in an `<img>` would keep every
 *  full-size frame decoded, even after the img is gone, so it is never put in
 *  one: it shows its first frame at the box's size, and while `playing` (the
 *  card or the modal is shown; never under reduced motion) it plays frame by
 *  frame on a canvas through WebCodecs ImageDecoder. Without ImageDecoder it stays a still. Anything else, or a
 *  failed check, is the plain image. */
export default function AnnouncementCardPicture({ src, alt, playing, boxClassName = CARD_BOX_CLASS, testId = "announcement-sidebar-picture", zoomLabel, onZoom }: {
  src: string;
  /** With onZoom, the picture is a button named by this label that asks to see
   *  it larger (the web app opens a centred dialog; the operator preview passes
   *  neither). */
  zoomLabel?: string;
  onZoom?: () => void;
  alt: string;
  playing: boolean;
  /** The box every state fills; the modal passes its own. */
  boxClassName?: string;
  testId?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stillCanvasRef = useRef<HTMLCanvasElement>(null);
  const checkable = canCheck() && !knownStill.has(src) && !checkFailed.has(src);
  const [picture, setPicture] = useState<Picture | null>(null);
  useEffect(() => {
    if (!checkable) return;
    const box = boxRef.current;
    // Layout size, not getBoundingClientRect: an opening dialog's scale transform would shrink it.
    const cssWidth = box && box.clientWidth > 0 ? box.clientWidth : FALLBACK_WIDTH;
    const cssHeight = box && box.clientHeight > 0 ? box.clientHeight : cssWidth * 9 / 16;
    const ratio = window.devicePixelRatio || 1;
    const size = { width: Math.max(1, Math.round(cssWidth * ratio)), height: Math.max(1, Math.round(cssHeight * ratio)) };
    const controller = new AbortController();
    let stillUrl: string | null = null;
    void check(src, size, () => stillCanvasRef.current, controller.signal).then((next) => {
      if (next.kind === "still") {
        if (controller.signal.aborted) URL.revokeObjectURL(next.stillUrl);
        else stillUrl = next.stillUrl;
      }
      return next;
    }, (error: unknown): Picture => {
      if (!controller.signal.aborted) {
        checkFailed.add(src);
        // Not known to be animated (the download failed): the plain image, as before this check existed.
        console.warn("Announcement picture: could not check the image, showing it as is", error);
      }
      return { src, kind: "plain", cors: false };
    }).then((next) => {
      if (!controller.signal.aborted) setPicture(next);
    });
    return () => {
      controller.abort();
      if (stillUrl) URL.revokeObjectURL(stillUrl);
    };
  }, [src, checkable]);

  const current = picture?.src === src ? picture : null;
  let content = null;
  // Asked through CORS where the check already was (it worked for this URL),
  // so the img's request matches the check's and is answered from the cache
  // (the route is immutable but varies on Origin). Never where it failed: a
  // CORS img without CORS headers would not load at all.
  const corsCheckedPlain = knownStill.has(src) || (current?.kind === "plain" && current.cors);
  if (!checkable || current?.kind === "plain") {
    content = <img className={IMAGE_CLASS} src={src} alt={alt} crossOrigin={corsCheckedPlain ? "anonymous" : undefined} />;
  } else if (current?.kind === "still") {
    content = <img className={IMAGE_CLASS} src={current.stillUrl} alt={alt} data-testid={`${testId}-still`} />;
  } else if (!current || current.kind === "frames") {
    // Being checked (the still canvas is there to draw frame 0 into), or the first frame drawn.
    // Only the canvas on top is named; one without a role is not announced.
    const shown = current?.kind === "frames";
    const animating = shown && playing;
    content = <>
      <canvas ref={stillCanvasRef} className={LAYER_CLASS} role={shown && !animating ? "img" : undefined} aria-label={shown && !animating ? alt : undefined} data-testid={`${testId}-still`} />
      {animating && <AnimatedImageCanvas src={src} type={current.type} alt={alt} className={LAYER_CLASS} />}
    </>;
  }
  const unavailable = current?.kind === "unavailable";
  // Keyed by the image: another announcement's picture gets fresh canvases,
  // never the last one's frame 0 while its own is decoded (or if it fails).
  const zoomable = Boolean(zoomLabel && onZoom) && !unavailable;
  // A quiet expand mark always shows (touch has no hover); on hover the picture dims a little and the mark firms up.
  const box = <div key={src} ref={boxRef} className={boxClassName} data-testid={testId} role={unavailable ? "img" : undefined} aria-label={unavailable ? alt : undefined}>
    {content}
    {zoomable && <>
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
      <span aria-hidden className="pointer-events-none absolute end-2 bottom-2 flex size-6 items-center justify-center rounded-full bg-foreground/60 text-foreground-inverse opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" data-testid={`${testId}-zoom-mark`}><Maximize2 className="size-3.5" /></span>
    </>}
  </div>;
  if (!zoomable) return box;
  return <button type="button" className="group block w-full cursor-pointer rounded-control p-0 text-start" aria-label={zoomLabel} data-testid={`${testId}-zoom`} onClick={onZoom}>{box}</button>;
}
