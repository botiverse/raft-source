import type { Agent } from "../../store/agentStore";
import type { AgentActivityState } from "../../store/events/agentActivityEvents";
import { classifyRuntimeError, classifyRuntimeErrorCode, classifyTypedRuntimeError } from "../../utils/classifyRuntimeError";

/**
 * The failure markers, from any of the fields below, that mean "sign in":
 * the error code (`auth_required`), the typed reason (`auth_failed`), and the
 * start failure's reason (`runtime_login_required`), which arrives on the
 * `runtime_unavailable` activity frame (`spawnFailure.reason`) and on the
 * stored error (`lastRuntimeError.spawnFailureReason`, #490).
 */
const SIGN_IN_MARKERS: ReadonlySet<string> = new Set(["auth_required", "auth_failed", "runtime_login_required"]);

export type FirstAgentStartFailure = {
  /** The error says the runtime needs a sign-in (the caller adds the Computer's signed-out state). */
  signIn: boolean;
};

/** The agent is being started (an automatic retry included): not a verdict either way. */
const STARTING_DETAIL_KINDS: ReadonlySet<string> = new Set(["starting", "runtime_starting"]);

/**
 * Whether the first agent failed to start, read from the fields every viewer
 * already gets. A failed start only: the `runtime_unavailable` frame, the
 * crash-loop hold (`wake_crash_loop_blocked`), the failed start #490 stores
 * (`lastRuntimeError.spawnFailureReason`), or a sign-in failure. Any other
 * error of a runtime that did start (`runtime_error`, a stall, a Computer
 * operation) is the agent page's to show, not setup's. While a start is in
 * progress the stored failed start still answers, so an automatic retry does
 * not make the notice come and go. Null while she runs.
 */
export function firstAgentStartFailure(
  agent: Pick<Agent, "status" | "lastRuntimeError"> | null | undefined,
  activity: AgentActivityState | null | undefined,
): FirstAgentStartFailure | null {
  if (!agent) return null;
  const error = agent.lastRuntimeError ?? null;
  const detailKind = activity?.detailKind;
  const starting = detailKind !== undefined && STARTING_DETAIL_KINDS.has(detailKind);
  const running = activity ? activity.activity !== "offline" && activity.activity !== "error" && !starting : agent.status === "active";
  if (running) return null;
  const code = classifyRuntimeErrorCode(activity?.errorCode ?? error?.code);
  // #490: a failed start is stored with its class (members get the class only, managers its text too).
  const storedReason = error?.spawnFailureReason;
  const markers = [code, error?.code, error?.errorReason, activity?.spawnFailure?.reason, storedReason];
  const kind = classifyTypedRuntimeError(error) ?? (error?.message && !code ? classifyRuntimeError(error.message) : null);
  const signIn = markers.some((marker) => typeof marker === "string" && SIGN_IN_MARKERS.has(marker))
    || kind === "authFailed" || kind === "notLoggedIn";
  const failedStart = detailKind === "runtime_unavailable" || detailKind === "wake_crash_loop_blocked" || storedReason !== undefined;
  return failedStart || signIn ? { signIn } : null;
}
