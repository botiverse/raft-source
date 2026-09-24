import {
  buildStateViolationTraceAttrs,
} from "@botiverse/raft-shared";
import type {
  StateViolationTraceInput,
} from "@botiverse/raft-shared";
import { emitWebTrace } from "./webAuthTrace";

type StateViolationEmitter = typeof emitWebTrace;

let emitter: StateViolationEmitter = emitWebTrace;

const COALESCE_WINDOW_MS = 60_000;

interface ViolationBucket {
  windowStartMs: number;
  suppressed: number;
}

const bucketsBySignature = new Map<string, ViolationBucket>();

export function __setStateViolationEmitterForTest(next: StateViolationEmitter | null): void {
  emitter = next ?? emitWebTrace;
}

export function __resetStateViolationCoalescerForTest(): void {
  bucketsBySignature.clear();
}

function signature(input: StateViolationTraceInput): string {
  return [
    input.domain,
    input.entityId ?? "none",
    input.violationKind,
    input.epoch ?? "unknown",
    input.same_activity,
    input.same_detail_kind,
    input.same_detail_presence,
    input.same_detail_bucket,
  ].join("|");
}

function coalescedCount(input: StateViolationTraceInput, nowMs: number): number | null {
  const key = signature(input);
  const bucket = bucketsBySignature.get(key);
  if (!bucket || nowMs - bucket.windowStartMs >= COALESCE_WINDOW_MS) {
    const count = 1 + (bucket?.suppressed ?? 0);
    bucketsBySignature.set(key, { windowStartMs: nowMs, suppressed: 0 });
    return count;
  }
  bucket.suppressed += 1;
  return null;
}

export function emitStateViolationTrace(input: StateViolationTraceInput, nowMs: number = Date.now()): void {
  try {
    const count = coalescedCount(input, nowMs);
    if (count === null) return;
    emitter(
      "slock.state.violation",
      buildStateViolationTraceAttrs({ ...input, count }) as unknown as Record<string, unknown>,
    );
  } catch {
    // Trace emission must never affect state handling.
  }
}
