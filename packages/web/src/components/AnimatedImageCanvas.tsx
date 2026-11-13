import { useEffect, useRef } from "react";
import { useMediaQuery } from "../hooks/effectPrimitives";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** A frame with no delay, or a near-zero one, shows for 100 ms, as browsers play GIFs. */
const DEFAULT_FRAME_MS = 100;
const MIN_FRAME_MS = 10;

/** WebCodecs ImageDecoder, where the browser has it (Chromium; not every Firefox or Safari). */
export function hasImageDecoder(): boolean {
  return typeof ImageDecoder === "function" && typeof ImageDecoder.isTypeSupported === "function";
}

/** Sizes the canvas's backing store to its CSS box × devicePixelRatio (layout size,
 *  so an opening dialog's scale transform does not shrink it). */
export function sizeCanvas(canvas: HTMLCanvasElement): void {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : 320;
  const cssHeight = canvas.clientHeight > 0 ? canvas.clientHeight : cssWidth * 9 / 16;
  canvas.width = Math.max(1, Math.round(cssWidth * ratio));
  canvas.height = Math.max(1, Math.round(cssHeight * ratio));
}

/**
 * Shows a decoded frame stretched to the whole canvas (the img's object-fill
 * look), then closes it. Never `drawImage(frame)` on a 2d context: Chromium
 * records that draw and rasterizes it later, and the full-size frame then goes
 * into the decoded-image cache, one entry per frame, kept after the canvas is
 * gone (QA: 93 entries of 2.2 MB for a 960x600 GIF on a 189x106 canvas). The
 * frame is scaled to the canvas's size first (createImageBitmap copies it, no
 * cache) and handed to a bitmaprenderer context, which takes the bitmap and
 * frees the one before: one canvas-size bitmap alive at a time. No 2d
 * fallback: getContext("bitmaprenderer") is null only on a canvas that already
 * has another context, which these never do.
 */
export async function drawFrameAndClose(canvas: HTMLCanvasElement, frame: VideoFrame): Promise<void> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(frame, { resizeWidth: canvas.width, resizeHeight: canvas.height, resizeQuality: "high" });
  } finally {
    frame.close();
  }
  // These canvases only ever get a bitmaprenderer context, so it is there.
  const renderer = canvas.getContext("bitmaprenderer");
  try {
    // Ownership passes to the canvas, which frees the bitmap it showed before.
    renderer?.transferFromImageBitmap(bitmap);
  } catch (error) {
    bitmap.close();
    throw error;
  }
  if (!renderer) bitmap.close();
}

function frameDelay(durationMicros: number | null | undefined): number {
  const ms = (durationMicros ?? 0) / 1000;
  return ms > MIN_FRAME_MS ? ms : DEFAULT_FRAME_MS;
}

/** Plays an animated GIF or WebP onto the canvas frame by frame: only the
 *  frame being shown is decoded (one VideoFrame alive at a time, closed as
 *  soon as it is drawn), at the canvas's size, so the browser never holds
 *  every full-size frame the way an `<img>` of the image would. Stops (and
 *  closes the decoder) on `stop()`. Pauses while the tab is hidden. */
function play(src: string, type: string, canvas: HTMLCanvasElement): () => void {
  const controller = new AbortController();
  let decoder: ImageDecoder | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | null = null;
  const stopped = () => controller.signal.aborted;
  const onVisibility = () => {
    if (document.visibilityState !== "hidden" && wake) wake();
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, ms);
  });
  const whileHidden = () => document.visibilityState === "hidden" && !stopped()
    ? new Promise<void>((resolve) => { wake = resolve; })
    : Promise.resolve();
  document.addEventListener("visibilitychange", onVisibility);

  void (async () => {
    // Same request as the still's (the route is immutable), so it is answered from the HTTP cache.
    const response = await fetch(src, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`image ${response.status}`);
    if (stopped()) return;
    const current = new ImageDecoder({ data: response.body, type });
    decoder = current;
    await current.tracks.ready;
    const track = current.tracks.selectedTrack;
    const repetitions = track?.repetitionCount ?? Infinity;
    sizeCanvas(canvas);
    let index = 0;
    let played = 0;
    let deadline = performance.now();
    while (!stopped()) {
      let frame: VideoFrame;
      let duration: number | null;
      try {
        ({ image: frame } = await current.decode({ frameIndex: index }));
        duration = frame.duration;
      } catch (error) {
        if (stopped()) return;
        // Past the last frame: once all bytes are in the loop wraps. A
        // rejection that came before the stream finished waits for it first.
        if (index > 0 && !current.complete) await current.completed.catch(() => {});
        if (stopped()) return;
        if (index > 0 && current.complete) {
          played += 1;
          if (played > repetitions) return;
          index = 0;
          continue;
        }
        throw error;
      }
      if (stopped()) {
        frame.close();
        return;
      }
      const wait = deadline - performance.now();
      if (wait > 0) await sleep(wait);
      await whileHidden();
      if (stopped()) {
        frame.close();
        return;
      }
      await drawFrameAndClose(canvas, frame);
      deadline = performance.now() + frameDelay(duration);
      index += 1;
      if (current.complete && track && index >= track.frameCount) {
        played += 1;
        if (played > repetitions) return;
        index = 0;
      }
    }
  })().catch((error: unknown) => {
    if (!stopped()) console.warn("Animated image: playback stopped", error);
  }).finally(() => {
    decoder?.close();
    decoder = null;
  });

  return () => {
    controller.abort();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    if (wake) wake();
    decoder?.close();
    decoder = null;
  };
}

/** An animated GIF or WebP played on a canvas (never an `<img>`), stretched
 *  to fill its box. Mount it only while it should play; it does nothing under
 *  reduced motion (whatever sits under it, such as a still, stays visible). */
export default function AnimatedImageCanvas({ src, type, alt, className }: { src: string; type: string; alt: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reducedMotion || !hasImageDecoder()) return;
    return play(src, type, canvas);
  }, [src, type, reducedMotion]);
  return <canvas ref={canvasRef} className={className} role="img" aria-label={alt} data-testid="animated-image-canvas" />;
}
