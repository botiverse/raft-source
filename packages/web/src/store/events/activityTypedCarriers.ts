import { isRuntimeErrorCode } from "@botiverse/raft-shared";
import type { AgentActivityDetailKind, CredentialHoldActivityDiagnostic, DeliveryConsumptionActivityDiagnostic, RuntimeErrorCode, SpawnFailureActivityDiagnostic, ToolStuckActivityDiagnostic, WakeCrashLoopActivityDiagnostic } from "@botiverse/raft-shared";

import type { AgentActivityState } from "./agentActivityEvents";

/** The typed carriers an activity snapshot (socket push or REST read) may bring. */
export interface ActivityTypedCarriers {
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  spawnFailure?: SpawnFailureActivityDiagnostic;
  toolStuck?: ToolStuckActivityDiagnostic;
  credentialHold?: CredentialHoldActivityDiagnostic;
  /** #wg-rbac:#57: the error's code (REST `activityErrorCode`; the socket's `errorCode`). */
  activityErrorCode?: RuntimeErrorCode;
}

/**
 * task #1116 / #1119: REST snapshots carry a typed carrier only with its own
 * activityDetailKind; attach each there and nowhere else.
 */
export function withTypedCarriers(state: AgentActivityState, carriers: ActivityTypedCarriers): AgentActivityState {
  // task #25: not tied to a detail kind; rides with any activity.
  if (carriers.toolStuck) state = { ...state, toolStuck: carriers.toolStuck };
  // #wg-rbac:#57: the code rides only an error (a known code; a newer one is none).
  if (state.activity === "error" && isRuntimeErrorCode(carriers.activityErrorCode)) {
    state = { ...state, errorCode: carriers.activityErrorCode };
  }
  if (state.detailKind === "delivery_unconsumed" && carriers.deliveryConsumption) {
    return { ...state, deliveryConsumption: carriers.deliveryConsumption };
  }
  if (state.detailKind === "wake_crash_loop_blocked" && carriers.wakeCrashLoop) {
    return { ...state, wakeCrashLoop: carriers.wakeCrashLoop };
  }
  // task #1123: the daemon's typed spawn-failure reason rides runtime_unavailable.
  if (state.detailKind === "runtime_unavailable" && carriers.spawnFailure) {
    return { ...state, spawnFailure: carriers.spawnFailure };
  }
  // Reconciler step 4b: the held notice's typed reason rides idle.
  if (state.detailKind === "idle" && carriers.credentialHold) {
    return { ...state, credentialHold: carriers.credentialHold };
  }
  return state;
}

/**
 * The socket push's carriers, kept next to the state they describe (mutates
 * the fresh `nextActivity`, so a later plain activity naturally drops them).
 */
export function attachSocketTypedCarriers(nextActivity: AgentActivityState, detailKind: AgentActivityDetailKind, event: ActivityTypedCarriers): void {
  // task #1116: attached only for the delivery_unconsumed frame.
  if (detailKind === "delivery_unconsumed" && event.deliveryConsumption) {
    nextActivity.deliveryConsumption = event.deliveryConsumption;
  }
  // task #1119: same rule for the server's wake crash-loop carrier.
  if (detailKind === "wake_crash_loop_blocked" && event.wakeCrashLoop) {
    nextActivity.wakeCrashLoop = event.wakeCrashLoop;
  }
  // task #1123: same rule for the typed spawn-failure reason.
  if (detailKind === "runtime_unavailable" && event.spawnFailure) {
    nextActivity.spawnFailure = event.spawnFailure;
  }
  // #wg-rbac:#57: the code rides only an error frame.
  if (nextActivity.activity === "error" && isRuntimeErrorCode(event.activityErrorCode)) {
    nextActivity.errorCode = event.activityErrorCode;
  }
  // task #25: any frame may carry it; a frame without it means "not stuck".
  if (event.toolStuck) {
    nextActivity.toolStuck = event.toolStuck;
  }
  // Reconciler step 4b: the held notice's reason rides only an idle frame.
  if (detailKind === "idle" && event.credentialHold) {
    nextActivity.credentialHold = event.credentialHold;
  }
}
