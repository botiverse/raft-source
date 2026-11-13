/**
 * Self-revoke of a profile's `sk_agent_*` key: the key authenticates the
 * request and the server revokes only that credential (server route
 * `POST /internal/agent-api/credentials/self/revoke`). Used by
 * `raft agent login wait` for the key a re-login replaced, and by
 * `raft agent logout` for the profile's current key.
 *
 * Goes through the shared ApiClient (`ctx.createApiClient`) with a
 * self-hosted-runner context built from the key being revoked, so the bearer
 * is always that key and never the caller's other credential. Never throws:
 * every failure is an outcome the caller reports. Key material is never
 * returned or printed.
 */

import type { CommandContext } from "../core/context";

export const AGENT_CREDENTIAL_SELF_REVOKE_PATH = "/internal/agent-api/credentials/self/revoke";

const SELF_REVOKE_TIMEOUT_MS = 15_000;

/**
 * - revoked            — 200 `{ revoked: true }`: the key no longer works.
 * - already_inactive   — 401: the server no longer accepts the key (revoked, expired or its agent deleted).
 * - not_self_revocable — 403 `credential_not_self_revocable`: the system that issued it manages it.
 * - unsupported        — 404: a server older than the route.
 * - failed             — network, timeout, 5xx or any other answer: the key may still be active.
 */
export type SelfRevokeOutcome = "revoked" | "already_inactive" | "not_self_revocable" | "unsupported" | "failed";

export interface SelfRevokableKey {
  serverUrl: string;
  agentId: string;
  serverId: string | null;
  apiKey: string;
}

export async function selfRevokeAgentKey(ctx: CommandContext, key: SelfRevokableKey): Promise<SelfRevokeOutcome> {
  const client = ctx.createApiClient({
    agentId: key.agentId,
    serverUrl: key.serverUrl,
    serverId: key.serverId,
    token: key.apiKey,
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
  });
  try {
    const res = await client.request<{ revoked?: unknown }>("POST", AGENT_CREDENTIAL_SELF_REVOKE_PATH, undefined, {
      signal: AbortSignal.timeout(SELF_REVOKE_TIMEOUT_MS),
    });
    if (res.ok) return res.data?.revoked === true ? "revoked" : "failed";
    if (res.status === 401) return "already_inactive";
    if (res.status === 403 && res.errorCode === "credential_not_self_revocable") return "not_self_revocable";
    if (res.status === 404) return "unsupported";
    return "failed";
  } catch {
    return "failed";
  }
}
