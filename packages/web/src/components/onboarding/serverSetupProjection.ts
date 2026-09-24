import { create } from "zustand";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import api from "../../api/client";

export type ServerSetupSurface = "none" | "computer_runtime" | "create_agent" | "complete" | "retry";
export type ServerSetupPhase = "not_started" | "in_progress" | "deferred" | "complete" | null;
export type ServerSetupStep = "computer_runtime" | "create_agent" | null;
/** `defer` bypasses an unfinished setup; `reset` rolls it back. Mirrors the server's enum. */
export type ServerSetupAllowedExit = "defer" | "reset" | "return_to_server" | "retry";
export type ServerSetupGateReason =
  | "actor_not_human"
  | "insufficient_permission"
  | "state_not_found"
  | "computer_offline"
  | "computer_status_unknown"
  | "runtime_not_ready"
  | "runtime_checking"
  | "runtime_error"
  | "runtime_status_unknown"
  | "official_onboarding_agent_missing"
  | "official_onboarding_agent_unusable"
  | "official_onboarding_agent_status_unknown"
  | "completion_pending"
  | "setup_complete"
  | "resolver_error"
  | null;

export type ServerSetupComputerStatus = "online" | "offline" | "unknown";

export type ServerSetupRuntimeStatus =
  | "ready_recommended"
  | "ready_other"
  | "not_ready"
  | "checking"
  | "error"
  | "unknown";

export type ServerSetupProjection = {
  /**
   * The steps that follow Create Cindy, derived from persisted server state rather
   * than held in the browser. Closing the tab on the survey or the handoff and
   * coming back lands you on the same screen.
   */
  postSetup?: {
    surveyPending: boolean;
    handoffPending: boolean;
  };
  surface: ServerSetupSurface;
  phase: ServerSetupPhase;
  currentStep: ServerSetupStep;
  blocksChat: boolean;
  allowedExits: ServerSetupAllowedExit[];
  sideEffectState: {
    transitions: "enabled" | "disabled";
    completion: "enabled" | "disabled";
  };
  gateReason: ServerSetupGateReason;
  /**
   * Screen B's two facts, decided by the server. The browser used to re-derive them
   * from the socket-fed machine store, which gave the runtime card and the Next
   * button separate answers to the same question. Draw these; do not recompute them.
   */
  computerStatus?: ServerSetupComputerStatus;
  runtimeStatus?: ServerSetupRuntimeStatus;
  runtimeOptions?: RuntimeSelectionOption[];
  /**
   * A non-revoked computer exists on this server — DURABLE, unaffected by the laptop being
   * asleep. "You have a computer, it is off" and "you have never connected one" are
   * different sentences and must not render alike.
   */
  hasConnectedComputer?: boolean;
  /** Their sleeping computers, BY NAME — from `computers`, same source as the fact above. */
  offlineComputers?: Array<{ id: string; name: string; lastHeartbeat: string | null; isComputer?: boolean }>;
};

export async function getServerSetupProjection(serverId: string): Promise<ServerSetupProjection> {
  const { data } = await api.get<ServerSetupProjection>(`/servers/${serverId}/setup-projection`);
  return data;
}

/**
 * "Let's Go". A command with a durable effect (the owner's handoff acknowledgment), not a
 * hint to the client. It returns the fresh projection, so the caller never has to guess.
 */
export async function acknowledgeSetupHandoff(serverId: string): Promise<ServerSetupProjection> {
  const { data } = await api.post<ServerSetupProjection>(`/servers/${serverId}/setup-handoff`);
  return data;
}

export async function transitionServerSetup(
  serverId: string,
  action: "start" | "defer" | "complete",
): Promise<ServerSetupProjection> {
  const { data } = await api.post<ServerSetupProjection>(`/servers/${serverId}/setup-transition`, { action });
  return data;
}

/**
 * Throw this half-built server away and start again.
 *
 * Not a transition — a rollback. The server revokes every computer and rewinds setup to the
 * top, and it re-checks for itself that the server never had an agent before it destroys
 * anything (a 409 comes back if it did). `revokedComputers` is how many machines we just
 * cut loose, which the screen owes the user: revoking does not uninstall, so those laptops
 * still have a daemon on them holding a key that will never work again.
 */
export async function resetServerSetup(
  serverId: string,
): Promise<ServerSetupProjection & { revokedComputers: number }> {
  const { data } = await api.post<ServerSetupProjection & { revokedComputers: number }>(
    `/servers/${serverId}/setup-reset`,
    {},
  );
  return data;
}

/**
 * The setup projection has two readers: the gate (which owns the modal) and the settings
 * panel (which owns the "Finish setup" button). They each fetched it into their own local
 * state, so Settings could reopen setup server-side and the gate would never find out —
 * the button "worked", navigated you to the channel, and nothing happened. This is the
 * one line between them: anyone who changes setup state bumps it, and the gate refetches.
 */
export const useServerSetupRevision = create<{ revision: number; bump: () => void }>((set) => ({
  revision: 0,
  bump: () => set((state) => ({ revision: state.revision + 1 })),
}));

export function bumpServerSetupRevision() {
  useServerSetupRevision.getState().bump();
}

/**
 * What the gate keeps when a projection refetch FAILS.
 *
 * A failed read is not a reading of "nothing". The gate used to drop the projection to
 * `null` on any error, which fell through to the legacy modal — so one flaky request (a
 * socket event during a redeploy, a tab waking from sleep) could yank someone mid-setup
 * into a different screen entirely. Keep the last thing the server actually said; only
 * admit we have nothing when we have never had anything.
 */
export function projectionAfterRefreshFailure(
  current: ServerSetupProjection | null,
): ServerSetupProjection | null {
  return current;
}
