import type { AgentConnectionProvider, AgentConnectionRemovedView, AgentConnectionScopesView } from "@botiverse/raft-shared";

// How the web reads the agent connection routes (`/api/agents/:id/connections/…`):
// their paths, the error codes it acts on, what a provider refusal means for
// the user, and the server's word that a removal left a copy to revoke on GitHub.

type ProviderRefusalFields = { providerCode?: unknown; providerStatus?: unknown; providerMessage?: unknown };

/**
 * The provider's own words about a refusal: under the refusal envelope's
 * `details` (the server's refuse(), docs/contracts/agent-api-refusals.md), or
 * top-level as a server from before it wrote them (and its 502s still do).
 */
function providerRefusalFields(err: unknown): ProviderRefusalFields | null {
  const data = (err as { response?: { data?: ProviderRefusalFields & { details?: unknown } } }).response?.data;
  if (!data || typeof data !== "object") return null;
  const details = data.details && typeof data.details === "object" ? data.details as ProviderRefusalFields : null;
  return {
    providerCode: details?.providerCode ?? data.providerCode,
    providerStatus: details?.providerStatus ?? data.providerStatus,
    providerMessage: details?.providerMessage ?? data.providerMessage,
  };
}

/** The provider's own reason for refusing (e.g. the agent needs exactly one GitHub plugin mount), if any. */
export function providerRefusalReason(err: unknown): string | null {
  const data = providerRefusalFields(err);
  return typeof data?.providerMessage === "string" && data.providerMessage.trim() ? data.providerMessage : null;
}

export const AGENT_MISSING_AT_PROVIDER_CODE = "agent_connection_agent_missing_at_provider";
export const CONNECTOR_DISCONNECT_PARTIAL_CODE = "agent_connection_connector_disconnect_partial";
/** Removing this agent's connection did not take (its mount still holds the credential); the same removal again completes it. */
export const DISCONNECT_NOT_CLEARED_CODE = "agent_connection_disconnect_not_cleared";
export const PROVIDER_REFUSED_CODE = "agent_connection_provider_refused";
/** The connection is gone (disconnected meanwhile): drop it from the list and reload the status. */
export const CONNECTOR_NOT_FOUND_CODE = "agent_connection_connector_not_found";
/** Only the connection's creator or a server owner/admin may change it: reload, so `canManage` hides what it can't do. */
export const CONNECTOR_FORBIDDEN_CODE = "agent_connection_connector_forbidden";
export const OWNER_REQUIRED_CODE = "agent_connection_owner_required";
/** A reconnect was authorized by another GitHub account than the connection's: nothing changed; sign in as that account. */
export const ACCOUNT_MISMATCH_CODE = "agent_connection_account_mismatch";
/** At confirm: the link expired, was used, or was started by someone else; start again. */
export const PENDING_INVALID_CODE = "agent_connection_pending_invalid";
/** Where a GitHub account's authorizations of apps are revoked (OAuth and GitHub Apps alike). */
export const GITHUB_AUTHORIZED_APPS_URL = "https://github.com/settings/applications";

export function errorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } }).response?.data?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The server's word that a removal reached everything but a copy of the
 * credential the provider had handed to an agent whose storage is gone: only
 * revoking on GitHub takes that copy back. On a removal's 200 body, or on the
 * partial disconnect's 502; absent, nothing is said.
 */
export function saysRevokeOnGithub(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as AgentConnectionRemovedView).revokeOnGithub === true;
}

/**
 * The generic provider refusal (409 `agent_connection_provider_refused`, any
 * provider 4xx without a listed code): its `error` is the provider's own
 * sentence when it reads as one, else Raft's. The web shows that sentence and
 * stops the attempt, with no automatic retry (REFUSAL_CODES). It never
 * branches on the provider's code: "needs reconnecting" is the connection's
 * `oauthStatus`, not a refusal. Null for any other error.
 */
export function providerRefusalSentence(err: unknown): string | null {
  if (errorCode(err) !== PROVIDER_REFUSED_CODE) return null;
  const sentence = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
  if (typeof sentence === "string" && sentence.trim()) return sentence.trim();
  return providerRefusalReason(err);
}

/** The provider's own words about a refusal, for "Copy Details" only (never rendered). */
export function refusalDetails(err: unknown): string | null {
  const data = providerRefusalFields(err);
  if (!data) return null;
  const head = [typeof data.providerStatus === "number" ? String(data.providerStatus) : null, typeof data.providerCode === "string" ? data.providerCode : null]
    .filter(Boolean)
    .join(" ");
  const message = providerRefusalReason(err);
  const text = [head, message].filter(Boolean).join(": ");
  return text || null;
}

export function agentConnectionPath(agentId: string, provider: AgentConnectionProvider): string {
  return `/agents/${encodeURIComponent(agentId)}/connections/${provider}`;
}

/** A tenant connector, addressed through an agent the caller manages. */
export function agentConnectorPath(agentId: string, provider: AgentConnectionProvider, connectorId: string): string {
  return `${agentConnectionPath(agentId, provider)}/connectors/${encodeURIComponent(connectorId)}`;
}

/**
 * What a GitHub connection can do, in words, from the OAuth scopes the provider
 * recorded (`AgentConnectionScopesView`):
 * - `access`: `private` (`repo`: public and private repositories), `public`
 *   (`public_repo` only), or null (not recorded, not reported, `[]` — which a
 *   working GitHub App user token also gives — or no repository scope).
 * - `short`: what was requested and GitHub did not grant (`repo` covers
 *   `public_repo` and `repo:*`; `write:x` and `admin:x` cover `read:x`). Empty
 *   when nothing is missing or either list is unknown.
 * - `granted`: the raw list, for a tooltip only.
 */
export type GithubAccess = {
  access: "private" | "public" | null;
  short: string[];
  granted: string[] | null;
};

function covers(granted: readonly string[], scope: string): boolean {
  if (granted.includes(scope)) return true;
  if ((scope === "public_repo" || scope.startsWith("repo:")) && granted.includes("repo")) return true;
  const read = /^read:(.+)$/.exec(scope);
  return Boolean(read && (granted.includes(`write:${read[1]}`) || granted.includes(`admin:${read[1]}`)));
}

export function describeGithubAccess(scopes: string[] | null | undefined, requestedScopes: string[] | null | undefined): GithubAccess {
  if (!Array.isArray(scopes)) return { access: null, short: [], granted: null };
  // `[]` says nothing either way: a GitHub App user token has no OAuth scopes and still works (contract,
  // "GitHub App user tokens"), so it is never "no access" and never "granted less than requested".
  if (scopes.length === 0) return { access: null, short: [], granted: scopes };
  const access = scopes.includes("repo") ? "private" : scopes.includes("public_repo") ? "public" : null;
  const short = Array.isArray(requestedScopes) ? requestedScopes.filter((scope) => !covers(scopes, scope)) : [];
  return { access, short, granted: scopes };
}

/** The connect flow asked for private repositories last time (or GitHub granted them): Reconnect asks again. */
export function wantsPrivate(connector: AgentConnectionScopesView): boolean {
  return Boolean(connector.requestedScopes?.includes("repo") || connector.scopes?.includes("repo"));
}
