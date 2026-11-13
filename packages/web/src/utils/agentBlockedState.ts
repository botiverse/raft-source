import type { AgentActivityDetailKind, AgentBlockedReason, AgentStatus } from "@botiverse/raft-shared";

/**
 * Why an agent is held from running, as the status UI shows it.
 *
 * - `computer_too_old`: the server sets the agent list's `blockedReason` only
 *   while the agent's Computer is below the version floor and the floor is
 *   enforced (versionGate.enforced). An unknown version reads the same as a
 *   too-old one: either way the fix is reinstalling or upgrading Raft Computer.
 * - `computer_access_revoked`: reconciler step 15 (B15). The server sets
 *   `blockedReason` while the agent's Computer has no live key on the server
 *   (revoked, e.g. its attacher left or was removed). The agent stays bound and
 *   gets no wakes; it never comes back by itself, so it reads that, not
 *   "Computer offline": move it to another computer or attach the Computer again.
 * - `computer_offline`: the agent's Computer is offline (#triage:#206). The
 *   agent has not stopped: it starts again by itself when the Computer is back
 *   and its messages wait, so it reads "Computer offline", never "Stopped"
 *   (raft-design identity-and-presence, An agent on an offline computer).
 */
export type AgentBlockedState = "computer_too_old" | "computer_access_revoked" | "computer_offline";

export function agentBlockedState(
  blockedReason: AgentBlockedReason | null | undefined,
): AgentBlockedState | null {
  switch (blockedReason) {
    case "computer_access_revoked":
      return "computer_access_revoked";
    case "computer_version_unsupported":
    case "computer_version_unknown":
      return "computer_too_old";
    default:
      return null;
  }
}

/**
 * Offline states that keep their own words while the Computer is offline: the
 * server paused automatic wakes, so only a manual start lifts them.
 */
const OWN_OFFLINE_DETAIL_KINDS: ReadonlySet<AgentActivityDetailKind> = new Set([
  "wake_crash_loop_blocked",
  "terminal_failure_paused",
]);

/**
 * Whether an agent reads "Computer offline": its Computer is offline and it
 * was not stopped by a person (a Computer shutdown keeps the agent's own
 * `status`, so a person's Stop is `status: "stopped"`). An error (crashed, no
 * quota) keeps its own words.
 */
export function agentHeldByOfflineComputer(
  agent: { status: AgentStatus } | null | undefined,
  activity: { activity: string; detailKind?: AgentActivityDetailKind } | null | undefined,
  machineOffline: boolean,
): boolean {
  if (!machineOffline || !agent || agent.status === "stopped") return false;
  if (activity?.activity === "error") return false;
  return !(activity?.detailKind && OWN_OFFLINE_DETAIL_KINDS.has(activity.detailKind));
}

/** Which runtime controls an agent offers (profile header, ⋯, Actions, sidebar menu). */
export interface AgentRuntimeControls {
  start: boolean;
  stop: boolean;
  restartReset: boolean;
}

/**
 * One rule for the runtime controls (#triage:#206). While the agent's Computer
 * is offline (`isMachineOffline`), whatever the agent's own state, a crashed
 * one too: no Start and no Restart / Reset, which need the Computer (the
 * profile's offline card takes their place). Stop stays for a running agent
 * and for one waiting to come back with its Computer (not one a person
 * stopped): the server records it and applies it on reconnect
 * (`appliesOnReconnect`), so the agent won't come back. Start and Stop never
 * both hold: `stop` says which of the two a Start/Stop control offers.
 */
export function agentRuntimeControls(input: {
  canControl: boolean;
  canStop: boolean;
  isOnline: boolean;
  computerOffline: boolean;
  /** `status: "stopped"`: a person stopped it; it is not waiting for its Computer. */
  stoppedByPerson: boolean;
}): AgentRuntimeControls {
  const { canControl, canStop, isOnline, computerOffline, stoppedByPerson } = input;
  return {
    start: canControl && !isOnline && !computerOffline,
    stop: canControl && canStop && (isOnline || (computerOffline && !stoppedByPerson)),
    restartReset: restartResetOffered(canControl, computerOffline),
  };
}

/**
 * Restart / Reset alone (the profile's Actions section, which renders it apart
 * from Start/Stop): it depends only on runtime control and the Computer, not
 * on the agent's state.
 */
export function restartResetOffered(canControl: boolean, computerOffline: boolean): boolean {
  return canControl && !computerOffline;
}
