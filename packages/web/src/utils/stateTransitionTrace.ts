import {
  buildStateTransitionTraceAttrs,
} from "@botiverse/raft-shared";
import type {
  StateTransitionTraceInput,
} from "@botiverse/raft-shared";
import { emitWebEvent, emitWebEventAndFlushBeforeUnload } from "./webAuthTrace";

type StateTransitionEmitter = typeof emitWebEvent;

let emitter: StateTransitionEmitter = emitWebEvent;

type UrgentStateTransitionEmitter = (name: "slock.state.transition", attrs: Record<string, unknown>) => void;

const sendBeforeUnload: UrgentStateTransitionEmitter = (name, attrs) => {
  void emitWebEventAndFlushBeforeUnload(name, attrs);
};

let urgentEmitter: UrgentStateTransitionEmitter = sendBeforeUnload;

export function __setStateTransitionEmitterForTest(next: StateTransitionEmitter | null): void {
  emitter = next ?? emitWebEvent;
}

export function __setUrgentStateTransitionEmitterForTest(next: UrgentStateTransitionEmitter | null): void {
  urgentEmitter = next ?? sendBeforeUnload;
}

/**
 * `extraAttrs`: flat attributes beside key/meta (e.g. `tab.visibility`).
 * `beforeUnload`: the page is going away, so send at once with keepalive instead of queueing (the queue dies with the page).
 */
export function emitStateTransitionTrace(
  input: StateTransitionTraceInput,
  extraAttrs?: Readonly<Record<string, string>>,
  opts?: { beforeUnload?: boolean },
): void {
  try {
    const attrs = buildStateTransitionTraceAttrs(input) as unknown as Record<string, unknown>;
    const full = extraAttrs ? { ...attrs, ...extraAttrs } : attrs;
    if (opts?.beforeUnload) urgentEmitter("slock.state.transition", full);
    else emitter("slock.state.transition", full);
  } catch {
    // Trace emission must never affect state transitions.
  }
}
