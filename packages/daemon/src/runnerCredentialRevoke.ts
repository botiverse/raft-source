// Revoke a launch's managed runner credential when the launch ends; shared by
// every agent host (moved from AgentProcessManager).

import type { AgentConfig } from "@botiverse/raft-shared";
import { forgetRunnerCredentialLineage, runnerCredentialLineageIds } from "./runnerCredentialRenewal";

export function revokeManagedRunnerCredential(input: {
  serverUrl: string;
  daemonApiKey: string;
  agentId: string;
  config: AgentConfig;
  launchId: string | null;
  /** The host's fetch (daemonFetch in production), so tests that fake the server see the DELETE. */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  recordEvent(name: string, attrs: Record<string, unknown>, status?: "ok" | "error" | "cancelled"): void;
}): void {
  const rootId = input.config.agentCredentialId;
  if (!rootId) return;
  // #wg-rbac:#27: the config holds the launch's first credential; a renewal
  // or re-mint replaced it, so revoke what it became too (the current key
  // first matters most; the replaced ones expire within minutes anyway).
  const credentialIds = runnerCredentialLineageIds(rootId);
  forgetRunnerCredentialLineage(rootId);
  for (const credentialId of credentialIds.reverse()) revokeRunnerCredentialById(input, credentialId);
}

export type RunnerCredentialRevokeTarget = Omit<Parameters<typeof revokeManagedRunnerCredential>[0], "config">;

/** Revoke one runner credential by id (a renewal's key for a launch that ended meanwhile). */
export function revokeRunnerCredentialById(input: RunnerCredentialRevokeTarget, credentialId: string): void {
  const { agentId, launchId } = input;
  const url = new URL(
    `/internal/computer/runners/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`,
    input.serverUrl,
  );
  void input.fetchImpl(url.toString(), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${input.daemonApiKey}`,
      "X-Raft-Client": "daemon-server-session-worker",
    },
  }).then((res) => {
    input.recordEvent("daemon.runner_credential.revoke", {
      agentId,
      launchId: launchId || undefined,
      credentialId,
      http_status: res.status,
    }, res.ok ? "ok" : "error");
  }).catch((err) => {
    input.recordEvent("daemon.runner_credential.revoke", {
      agentId,
      launchId: launchId || undefined,
      credentialId,
      reason: err instanceof Error ? err.message : String(err),
    }, "error");
  });
}

/**
 * #wg-rbac:#27: a start carried by a process or start the host already has (a
 * rebind) keeps the runner credential that one holds; the credential the
 * rebound start brought is never used and must be revoked, or it stays valid
 * on the server for good. `held`: the config of what carries the start (null:
 * nothing that keeps a credential, e.g. a deferred rebind). Returns the
 * start's config with the held credential, and the start's own credential
 * when nothing will use it (revoke it once with `revokeManagedRunnerCredential`).
 */
export function carryHeldRunnerCredential(
  held: AgentConfig | null,
  incoming: AgentConfig,
): { config: AgentConfig; unused: AgentConfig | null } {
  const incomingKey = incoming.agentCredentialKey || null;
  if (held === null) {
    if (!incomingKey) return { config: incoming, unused: null };
    const { agentCredentialKey: _key, agentCredentialId: _id, agentCredentialExpiresAt: _expiresAt, ...rest } = incoming;
    return { config: rest, unused: incoming };
  }
  const heldKey = held.agentCredentialKey || null;
  // Nothing held yet: the start's own credential is the one that will run.
  if (!heldKey) return { config: incoming, unused: null };
  const { agentCredentialExpiresAt: _incomingExpiresAt, ...incomingRest } = incoming;
  return {
    config: { ...incomingRest, agentCredentialKey: heldKey, agentCredentialId: held.agentCredentialId ?? null, ...(held.agentCredentialExpiresAt !== undefined ? { agentCredentialExpiresAt: held.agentCredentialExpiresAt } : {}) },
    unused: incomingKey && incomingKey !== heldKey ? incoming : null,
  };
}
