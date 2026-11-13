import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";

type ConnectionMotionPhase = "idle" | "success" | "handoff" | "settled";
type ConnectionMotionState = {
  computerExpanded: boolean;
  phase: ConnectionMotionPhase;
};
export type ConnectionMotionAction =
  | { type: "toggle" }
  | { type: "start" }
  | { type: "handoff" }
  | { type: "settle" }
  | { type: "skip" }
  | { type: "cancel" };

export function connectionMotionReducer(state: ConnectionMotionState, action: ConnectionMotionAction): ConnectionMotionState {
  switch (action.type) {
    case "toggle":
      return { ...state, computerExpanded: !state.computerExpanded };
    case "start":
      return { computerExpanded: true, phase: "success" };
    case "handoff":
      return { computerExpanded: false, phase: "handoff" };
    case "settle":
      return { ...state, phase: "settled" };
    case "skip":
      return { computerExpanded: false, phase: "settled" };
    case "cancel":
      return { computerExpanded: true, phase: "settled" };
  }
}

/**
 * The connection motion timers are scheduled in parallel from one start, not
 * chained: `handoff` at 1400ms and `settle` at 2040ms are independent. `settle`
 * is the moment the step stops animating and hands the screen back to the user,
 * so its arrival time is the quantity worth pinning — see the timing assertion
 * in `serverSetupComputerRuntimeMotion.behavior.test.tsx` (removed in the 2026-11 web DOM test prune).
 *
 * Exported for that test: the schedule is real behavior, and asserting it from
 * source text would only prove the code was written, not that it still runs.
 */
export function startConnectionMotion(
  dispatch: (action: ConnectionMotionAction) => void,
  reducedMotion: boolean,
): () => void {
  if (reducedMotion) {
    dispatch({ type: "skip" });
    return () => undefined;
  }

  dispatch({ type: "start" });
  const handoffTimer = setClockTimeout(() => dispatch({ type: "handoff" }), 1_400);
  const settleTimer = setClockTimeout(() => dispatch({ type: "settle" }), 2_040);

  return () => {
    clearClockTimeout(handoffTimer);
    clearClockTimeout(settleTimer);
  };
}
