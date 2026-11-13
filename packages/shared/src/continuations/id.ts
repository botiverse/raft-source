// Continuation ids and the idempotency keys steps pass to external writes.

import { asContinuationId, CONTINUATION_ID_ALPHABET, CONTINUATION_ID_LENGTH, type ContinuationId } from "./record";

export function newContinuationId(): ContinuationId {
  const bytes = new Uint8Array(CONTINUATION_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return asContinuationId(Array.from(bytes, (byte) => CONTINUATION_ID_ALPHABET.charAt(byte & 31)).join(""));
}

/**
 * The idempotency key `ctx.step(stepId)` hands its function: the same on every
 * replay of the chain, so a write that happened before a crash is not done twice.
 */
export function stepIdempotencyKey(rootId: ContinuationId, stepId: string): string {
  return `continuation:${rootId}:${stepId}`;
}
