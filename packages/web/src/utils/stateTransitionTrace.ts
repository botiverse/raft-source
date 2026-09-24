import {
  buildStateTransitionTraceAttrs,
} from "@botiverse/raft-shared";
import type {
  StateTransitionTraceInput,
} from "@botiverse/raft-shared";
import { emitWebTrace } from "./webAuthTrace";

type StateTransitionEmitter = typeof emitWebTrace;

let emitter: StateTransitionEmitter = emitWebTrace;

export function __setStateTransitionEmitterForTest(next: StateTransitionEmitter | null): void {
  emitter = next ?? emitWebTrace;
}

export function emitStateTransitionTrace(input: StateTransitionTraceInput): void {
  try {
    emitter("slock.state.transition", buildStateTransitionTraceAttrs(input) as unknown as Record<string, unknown>);
  } catch {
    // Trace emission must never affect state transitions.
  }
}
