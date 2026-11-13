import {
  buildStateTransitionTraceAttrs,
} from "@botiverse/raft-shared";
import type {
  StateTransitionTraceInput,
} from "@botiverse/raft-shared";
import { emitWebEvent } from "./webAuthTrace";

type StateTransitionEmitter = typeof emitWebEvent;

let emitter: StateTransitionEmitter = emitWebEvent;

export function __setStateTransitionEmitterForTest(next: StateTransitionEmitter | null): void {
  emitter = next ?? emitWebEvent;
}

/** `extraAttrs`: flat attributes beside key/meta (e.g. `tab.visibility`). */
export function emitStateTransitionTrace(input: StateTransitionTraceInput, extraAttrs?: Readonly<Record<string, string>>): void {
  try {
    const attrs = buildStateTransitionTraceAttrs(input) as unknown as Record<string, unknown>;
    emitter("slock.state.transition", extraAttrs ? { ...attrs, ...extraAttrs } : attrs);
  } catch {
    // Trace emission must never affect state transitions.
  }
}
