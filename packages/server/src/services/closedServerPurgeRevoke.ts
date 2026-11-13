// Closed-server purge: revoking a credential at its provider before our copy
// is deleted (Tenny #55 (3), credential_revoke). Best effort, one call per
// credential per run, outside any transaction:
// - Slack: auth.revoke with the install's stored bot token, through the
//   Slack Bridge runtime (it holds the cipher), injected by server.ts
//   (ClosedServerPurgeRevokers.slackInstallToken); none injected (the bridge
//   not configured): nothing can unseal the token, so there is nothing to
//   call.
// - Managed MCP OAuth Connections: OAuth 2.0 token revocation (RFC 7009) of
//   the refresh and access tokens, at the authorization server's
//   `revocation_endpoint` from the discovery metadata stored with the
//   Connection, through the managed MCP SSRF-safe fetch. No endpoint
//   published: nothing to call, deleting our copy is the action. The
//   endpoint must be on the origin of the stored `token_endpoint` or
//   `issuer` (the server that issued the tokens and already holds the client
//   secret); one elsewhere is refused (below): the tokens and the secret are
//   never sent anywhere new.
// - Header Connections and provider connections hold API keys: no provider
//   offers a revoke call for them; deleting our copy is the action.
// Each call is recorded as an integration audit event
// (`closed_server_purge.credential_revoke`, actor system, outcome success or
// failure; kept with the audit). A failure keeps the credential and the
// server waits a day; after REVOKE_ATTEMPTS failures on different runs the
// copy is deleted all the same (`gaveUp: true` on that last failure's
// event), so a provider that keeps failing never holds the purge back for
// good. A refused revoke (`refused`: the revocation endpoint is on another
// origin) calls nothing and is not retried, the stored metadata will not
// change: it is recorded as a failure with its reason
// (`revocation_endpoint_origin_mismatch`) and our copy is deleted.
import { and, eq, sql } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb, type Database } from "../db/index";
import { integrationAuditEvents } from "../db/schema";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { decryptManagedMcpSecret } from "./managedMcpCredentialService";
import { createSafeFetch } from "./managedMcpGateway";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";
import { raftManagedMcpOAuthClient } from "./managedMcpRaftOAuthClient";

/** Failed attempts (on different runs) after which our copy is deleted anyway. */
export const REVOKE_ATTEMPTS = 3;
export const CREDENTIAL_REVOKE_EVENT = "closed_server_purge.credential_revoke";

export type ClosedServerPurgeRevokeOutcome =
  | { kind: "revoked" }
  /** Nothing to call: no token, no revocation endpoint, or a key no provider revokes. */
  | { kind: "nothing_to_revoke" }
  | { kind: "failed"; failure: string }
  /** Not called, and not retried: calling would send the credential somewhere it should not go. */
  | { kind: "refused"; failure: "revocation_endpoint_origin_mismatch" };

/** The provider calls, injectable (tests; the Slack runtime from server.ts). */
export interface ClosedServerPurgeRevokers {
  /** auth.revoke for an install's stored token (SlackBridgeServerRuntime.revokeInstallToken). */
  slackInstallToken?(installId: string): Promise<{ kind: "revoked" } | { kind: "no_credential" } | { kind: "failed"; failure: string }>;
  /** RFC 7009 for one managed MCP OAuth Connection's stored tokens (default: revokeManagedMcpOAuthTokens). */
  managedMcpOAuth?(encryptedOAuth: string): Promise<ClosedServerPurgeRevokeOutcome>;
}

export type CredentialKind = "slack_install" | "managed_mcp_oauth";

/**
 * One attempt for one credential: the provider call, its audit event, and
 * what the caller does next: `delete` (revoked, nothing to revoke, or given
 * up after REVOKE_ATTEMPTS failures) or `wait` (failed; tried again next run).
 */
export async function attemptCredentialRevoke(input: {
  serverId: ServerId;
  kind: CredentialKind;
  targetType: string;
  targetId: string;
  call: () => Promise<ClosedServerPurgeRevokeOutcome>;
  db?: Database;
}): Promise<{ next: "delete" | "wait"; outcome: ClosedServerPurgeRevokeOutcome; attempt: number; gaveUp: boolean }> {
  const db = input.db ?? getDb();
  let outcome: ClosedServerPurgeRevokeOutcome;
  try {
    outcome = await input.call();
  } catch (error) {
    outcome = { kind: "failed", failure: error instanceof Error ? error.name.slice(0, 64) : "error" };
  }
  if (outcome.kind === "nothing_to_revoke") return { next: "delete", outcome, attempt: 0, gaveUp: false };
  const [prior] = await db.select({ n: sql<number>`count(*)::int` }).from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.serverId, input.serverId),
    eq(integrationAuditEvents.eventType, CREDENTIAL_REVOKE_EVENT),
    eq(integrationAuditEvents.targetId, input.targetId),
    eq(integrationAuditEvents.outcome, "failure"),
  ));
  const attempt = Number(prior?.n ?? 0) + 1;
  const gaveUp = outcome.kind === "failed" && attempt >= REVOKE_ATTEMPTS;
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: CREDENTIAL_REVOKE_EVENT,
    outcome: outcome.kind === "revoked" ? "success" : "failure",
    source: "system",
    actor: { type: "system", id: null },
    subject: { type: "system", id: null },
    target: { type: input.targetType, id: input.targetId },
    metadata: {
      credentialKind: input.kind,
      attempt,
      ...(outcome.kind === "failed" || outcome.kind === "refused" ? { failure: outcome.failure } : {}),
      ...(gaveUp ? { gaveUp: true } : {}),
    },
  }, db);
  return { next: outcome.kind === "failed" && !gaveUp ? "wait" : "delete", outcome, attempt, gaveUp };
}

type FetchLike = typeof globalThis.fetch;

const originOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

/** The revocation endpoint is on the origin of the token endpoint or the issuer stored with it. */
function revocationEndpointTrusted(endpoint: string, metadata: unknown): boolean {
  const origin = originOf(endpoint);
  if (!origin) return false;
  const stored = metadata as { token_endpoint?: unknown; issuer?: unknown } | undefined;
  return origin === originOf(stored?.token_endpoint) || origin === originOf(stored?.issuer);
}

/**
 * RFC 7009 for a managed MCP OAuth Connection: the refresh token (revoking
 * it ends the grant at most providers), then the access token, at the
 * `revocation_endpoint` the authorization server's metadata publishes,
 * authenticated as the Connection's client (registered, Raft's, or the
 * dynamically registered one). 200 is success (RFC 7009 §2.2: also for a
 * token already invalid).
 */
export async function revokeManagedMcpOAuthTokens(encryptedOAuth: string, deps: { fetch?: FetchLike } = {}): Promise<ClosedServerPurgeRevokeOutcome> {
  let storage: ManagedMcpOAuthStorage;
  try {
    storage = decryptManagedMcpSecret(encryptedOAuth) as ManagedMcpOAuthStorage;
  } catch {
    return { kind: "nothing_to_revoke" };
  }
  const tokens = [
    storage.tokens?.refresh_token ? { token: storage.tokens.refresh_token, hint: "refresh_token" } : null,
    storage.tokens?.access_token ? { token: storage.tokens.access_token, hint: "access_token" } : null,
  ].filter((entry): entry is { token: string; hint: string } => entry !== null);
  // RFC 8414 metadata; the SDK types only the fields it uses.
  const endpoint = (storage.discoveryState?.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined)?.revocation_endpoint;
  if (tokens.length === 0 || typeof endpoint !== "string" || !endpoint.startsWith("https://")) return { kind: "nothing_to_revoke" };
  if (!revocationEndpointTrusted(endpoint, storage.discoveryState?.authorizationServerMetadata)) {
    return { kind: "refused", failure: "revocation_endpoint_origin_mismatch" };
  }

  const registered = storage.configuredClient ?? (storage.raftClient ? raftManagedMcpOAuthClient(storage.raftClient) : null);
  const dynamic = storage.clientInformation as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string } | undefined;
  const clientId = registered?.clientId ?? dynamic?.client_id;
  const clientSecret = registered?.clientSecret ?? dynamic?.client_secret;
  const method = registered?.tokenEndpointAuthMethod ?? dynamic?.token_endpoint_auth_method ?? (clientSecret ? "client_secret_post" : "none");
  if (!clientId) return { kind: "nothing_to_revoke" };

  const safe = deps.fetch ? null : createSafeFetch({ timeoutMs: 10_000 });
  const fetchFn = deps.fetch ?? safe!.fetch;
  try {
    for (const { token, hint } of tokens) {
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      if (method === "client_secret_basic" && clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
      } else {
        body.set("client_id", clientId);
        if (method === "client_secret_post" && clientSecret) body.set("client_secret", clientSecret);
      }
      let response: Response;
      try {
        response = await fetchFn(endpoint, { method: "POST", headers, body: body.toString(), redirect: "error" });
      } catch {
        return { kind: "failed", failure: "transport" };
      }
      // RFC 7009 §2.2.1: unsupported_token_type for an access token is not a failure of the grant's revocation.
      if (response.status !== 200 && !(hint === "access_token" && response.status === 400)) return { kind: "failed", failure: `http_${response.status}` };
    }
    return { kind: "revoked" };
  } finally {
    await safe?.close();
  }
}
