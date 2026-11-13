// One bound on sharp work for the whole server process (task #158). sharp
// decodes, resizes and encodes on libuv's thread pool, holding the decoded
// pixels in memory while it does; every place the server runs sharp (comment
// images and publish-check screenshots through objectFileImages.ts,
// attachment thumbnails and SVG previews, avatars,
// App logos) shares this one limit, so a burst of uploads plus check results
// can't run many decodes at once and spike memory and CPU. Over the limit a
// call waits its turn, in call order; nothing is refused.
//
// Sized by IMAGE_DECODE_CONCURRENCY, read once when this module loads (a
// restart applies a change). sharp's own settings (sharp.concurrency(), its
// cache) are left at their defaults.
import { AsyncLocalStorage } from "node:async_hooks";
import { createConcurrencyLimiter } from "./mapWithConcurrency";
import { safeAddTraceEvent } from "../tracing/semanticTrace";

/** Image decodes at once when IMAGE_DECODE_CONCURRENCY is unset or not a number. */
export const DEFAULT_IMAGE_DECODE_CONCURRENCY = 2;
/** The most IMAGE_DECODE_CONCURRENCY may allow. */
export const MAX_IMAGE_DECODE_CONCURRENCY = 16;

/** IMAGE_DECODE_CONCURRENCY as an integer within 1..MAX, else the default. */
export function imageDecodeConcurrency(raw = process.env.IMAGE_DECODE_CONCURRENCY): number {
  const value = Number(raw?.trim());
  if (!raw?.trim() || !Number.isFinite(value)) return DEFAULT_IMAGE_DECODE_CONCURRENCY;
  return Math.min(MAX_IMAGE_DECODE_CONCURRENCY, Math.max(1, Math.floor(value)));
}

const IMAGE_DECODE_CONCURRENCY = imageDecodeConcurrency();
const limit = createConcurrencyLimiter(IMAGE_DECODE_CONCURRENCY);
// Marks work running in a slot: a call from inside one runs in that slot
// rather than waiting for a second (which, at a limit of 1, never comes). The
// mark ends with the slot: work `fn` starts without awaiting (a timer, a
// queue) still sees the store afterwards, but `held` is false by then, so it
// waits for a slot like any other call.
const holdingSlot = new AsyncLocalStorage<{ held: boolean }>();

/**
 * Run `fn` (sharp work: build the pipeline and await its output inside it)
 * in one of the process's image-decode slots, waiting for a free one first.
 * Resolves or rejects as `fn` does; the slot is given back either way. How
 * long the call waited goes on the current trace as `image_decode.slot`
 * (`wait_ms`), so a slow image can be told from a long queue.
 */
export function withImageDecodeSlot<R>(fn: () => Promise<R>): Promise<R> {
  if (holdingSlot.getStore()?.held) return fn();
  const queuedAt = performance.now();
  return limit(async () => {
    const waitMs = Math.round(performance.now() - queuedAt);
    safeAddTraceEvent("image_decode.slot", () => ({ wait_ms: waitMs, concurrency: IMAGE_DECODE_CONCURRENCY }));
    const slot = { held: true };
    try {
      return await holdingSlot.run(slot, fn);
    } finally {
      slot.held = false;
    }
  });
}
