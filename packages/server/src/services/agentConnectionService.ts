/**
 * Account connections (e.g. "Connect GitHub") for agents provisioned on a
 * hosted runtime provider — the raft-agent-provider.v1 connections extension.
 *
 * The provider owns the OAuth flow and the resulting token; the token never
 * passes through Raft. Raft only:
 *   POST   …/by-raft-agent/:raftAgentId/connections/:provider?raftServerId=  {returnUrl, initiatedBy:{raftUserId}, access?,
 *            connectorId?, actingRole?}   (both or neither: a reconnect in place of that connector)
 *          → {url, expiresAt, scopes, reconnect?}   (one-time URL the browser opens)
 *   GET    …/connections/:provider?raftServerId=  → {connected, account, connectedAt, connectedBy, scopes?, requestedScopes?}
 *   DELETE …/connections/:provider?raftServerId=  → 204
 * A provider 404 on these routes is ambiguous (the provider answers unknown
 * routes and unknown agents alike with 404 `not_found`), so Raft asks once
 * more: `GET …/by-raft-agent/:raftAgentId?raftServerId=`. 404 there → the
 * provider does not know the agent (stale provisioning); 2xx → the agent
 * exists, so the connections route is missing ("not supported", older
 * provider); anything else → that call's error.
 *
 *   POST   …/connections/:provider/confirm?raftServerId=  {pending, raftUserId}
 *          → {connected, connectorId, account, connectedAt, connectedBy}; 404 = expired/used/mismatch
 *
 * Connections are tenant-level (per Raft server) "connectors"; an agent's
 * mount points at one of them. The GET status also lists every connector of
 * the server (`connectors: [{id, account, creatorRaftUserId, createdAt, current}]`,
 * never a token). The status and each connector carry the provider's health
 * (`oauthStatus` connected|disconnected|error, `lastCheckError`,
 * `lastCheckedAt`), passed through as sent (readProviderHealth); `error` is
 * "needs reconnecting", read by the web from that field, never a refusal. So do
 * `scopes` (granted) and `requestedScopes` (asked for): string arrays, or null
 * for "not recorded", each only when sent (readProviderScopes). And:
 *   PUT    …/connections/:provider?raftServerId=  {connectorId, actingRaftUserId, actingRole}
 *          → switch this agent to that connector
 *   DELETE {base}/provision/connectors/:connectorId?raftServerId=  {actingRaftUserId, actingRole}
 *          → disconnect the connector for every agent using it; 409 {outcome: "not_cleared",
 *            retry: true, agents: [...]} = partially done (some agents still hold its
 *            credential; their bindings and the connector are kept), calling again completes it
 * The agent-level DELETE answers a clear that did not take the same way (409
 * `outcome: "not_cleared"`, `agents: [thisAgent]`, binding kept). Branch on
 * `outcome`, never on the status (antiproton#1131).
 * A removal that took may still say the provider could not reach a copy it had
 * handed out (`revoke_on_github`, see `saysRevokeOnGithub`); Raft passes that on
 * as `revokeOnGithub: true`.
 * The provider knows no roles: Raft decides (decideAgentConnectorAuthority)
 * and sends `actingRole` "creator" | "admin"; the provider re-checks creator
 * (`403 not_creator`).
 *
 * The provider refuses with `{error: {code, message}}`. The codes a client acts
 * on map to failures here (PROVIDER_REFUSALS, the 404s by the call that got
 * them) and to listed refusal codes in routes/agents.ts; any other 4xx is the
 * generic provider refusal with the provider's message passed through.
 * The agent-level DELETE above only detaches this agent (the connector stays).
 *
 * After OAuth the provider redirects the browser to
 * `returnUrl?connection=<provider>&status=pending&pending=<id>&by=<raftUserId>`
 * (or `status=denied|failed`). Nothing is attached until Raft confirms the
 * pending id server-to-server, for the signed-in user (never the query `by`),
 * after re-checking that user's permission on the agent.
 * The returnUrl is always built from this Raft's own public origin (the
 * provider only accepts URLs under the agent's registered raftOrigin): it is
 * the API bounce `GET /api/connections/callback/:serverId/:agentId`, which
 * redirects to the web landing page `/connections/callback`.
 */
import {
  AGENT_CONNECTION_CALLBACK_STATUSES,
  AGENT_CONNECTION_CONNECTOR_ID_RE,
  AGENT_CONNECTION_OAUTH_STATUSES,
  AGENT_CONNECTION_PENDING_ID_RE,
  isAgentConnectionProvider,
  type AgentConnectionCallbackStatus,
  type AgentConnectionHealthView,
  type AgentConnectionOAuthStatus,
  type AgentConnectionProvider,
  type AgentConnectionScopesView,
  type AgentConnectionStartView,
  type AgentConnectionStatusView,
  type AgentConnectionConnectorView,
  type AgentConnectorActingRole,
  type AgentRuntimeProviderKind,
  type ServerRole,
} from "@botiverse/raft-shared";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentRuntimeProvisions, serverMembers, users } from "../db/schema";
import { connectorAssignableToAgent, decideAgentConnectorAuthority } from "../lib/actorPermissions";
import { UUID_RE } from "../lib/messageId";
import { getAppUrl } from "../config/appUrl";
import {
  getRaftOrigin,
  providerAgentByRaftIdPath,
  providerAgentConnectionConfirmPath,
  providerAgentConnectionPath,
  providerConnectorPath,
  providerRequest,
  resolveProviderConfig,
  type ProviderCallResult,
} from "./agentRuntimeProviderService";
import { isAgentRuntimeProviderKillSwitched } from "./agentRuntimeProviderFeature";

export const AGENT_CONNECTION_CALLBACK_API_PATH = "/api/connections/callback";
export const AGENT_CONNECTION_CALLBACK_WEB_PATH = "/connections/callback";

const MAX_TEXT = 500;

export type AgentConnectionFailure =
  | { kind: "not_hosted" }
  | { kind: "not_active"; state: string }
  | { kind: "disabled"; provider: AgentRuntimeProviderKind }
  | { kind: "not_configured" }
  | { kind: "unsupported" }
  /** The provider answered 404 `not_found`: it has no agent for this Raft agent (stale provisioning). */
  | { kind: "agent_missing_at_provider"; message: string | null }
  | { kind: "pending_invalid"; providerCode: string | null; message: string | null }
  /** The connector is not (or no longer) one of this server's connectors at the provider. */
  | { kind: "connector_not_found" }
  /**
   * The provider's `403 not_creator`: Raft vouched for the caller as the connector's creator and the provider's record
   * says otherwise (a reconnect, switch or disconnect). The same rule Raft checks first, so the same refusal.
   */
  | { kind: "connector_forbidden"; httpStatus: number; providerCode: string; message: string | null }
  /**
   * The provider's `409 account_mismatch`: a reconnect was authorized by another GitHub account than the connector's.
   * Nothing changed at the provider (not the connector, not any agent's mount).
   */
  | { kind: "account_mismatch"; httpStatus: number; providerCode: string; message: string | null }
  /**
   * The provider disconnected the connector but some agents still hold its credential (`outcome: "not_cleared"`);
   * calling again completes it. `revokeOnGithub`: as on `AgentConnectionRemoved`, said by this call only.
   */
  | { kind: "connector_disconnect_partial"; failedCount: number; revokeOnGithub: boolean }
  /** The provider could not clear this agent's mount (`outcome: "not_cleared"`); the connection was kept and calling again completes it. */
  | { kind: "connection_disconnect_not_cleared" }
  /** `message` is the provider's own reason (sanitized), e.g. why the agent cannot be connected. */
  | { kind: "provider_error"; httpStatus: number | null; code: string; message: string | null };

export type AgentConnectionOutcome<T> = { ok: true; value: T } | { ok: false; failure: AgentConnectionFailure };

/**
 * A removal that took. `revokeOnGithub`: the provider could not reach a copy of
 * the credential it had handed to an agent (that agent's storage is gone), so
 * the person should also revoke the authorization on GitHub.
 */
export type AgentConnectionRemoved = { revokeOnGithub: boolean };

type Target = { config: { baseUrl: string; token: string }; raftOrigin: string; provider: AgentRuntimeProviderKind };

async function resolveTarget(agent: { id: string; serverId: string }): Promise<AgentConnectionOutcome<Target>> {
  const [row] = await getDb().select({
    provider: agentRuntimeProvisions.provider,
    providerTarget: agentRuntimeProvisions.providerTarget,
    state: agentRuntimeProvisions.state,
    serverId: agentRuntimeProvisions.serverId,
  }).from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agent.id)).limit(1);
  if (!row || row.serverId !== agent.serverId || row.state === "deleting" || row.state === "deleted") {
    return { ok: false, failure: { kind: "not_hosted" } };
  }
  if (await isAgentRuntimeProviderKillSwitched(row.provider)) {
    return { ok: false, failure: { kind: "disabled", provider: row.provider } };
  }
  const config = resolveProviderConfig(row.provider, process.env, row.providerTarget);
  const raftOrigin = getRaftOrigin();
  if (!config || !raftOrigin) return { ok: false, failure: { kind: "not_configured" } };
  // The provider only knows the agent once provisioning succeeded.
  if (row.state !== "active") return { ok: false, failure: { kind: "not_active", state: row.state } };
  return { ok: true, value: { config, raftOrigin, provider: row.provider } };
}

const MAX_PROVIDER_MESSAGE = 300;
const SECRET_LIKE = /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk_[A-Za-z0-9_-]+|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;

/** The provider's reason, safe to show a user: no control characters, nothing token-shaped, bounded. */
export function sanitizeProviderMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(SECRET_LIKE, "[redacted]").trim().slice(0, MAX_PROVIDER_MESSAGE);
  return cleaned || null;
}

function sanitizeProviderCode(raw: string): string {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(raw) ? raw : "provider_error";
}

/**
 * A 404 on the connections routes: the provider uses 404 `not_found` both for
 * an unknown route and for an unknown agent, so the error code cannot tell
 * them apart. Look the agent up once: missing there → the agent is gone at the
 * provider; present → the connections route itself is missing (unsupported).
 */
async function classifyConnection404(target: Target, agent: { id: string; serverId: string }): Promise<AgentConnectionFailure> {
  const probe = await providerRequest(target.config, "GET", providerAgentByRaftIdPath(agent.id, agent.serverId));
  if (probe.kind === "response" && probe.status === 404) {
    return { kind: "agent_missing_at_provider", message: sanitizeProviderMessage(probe.error?.message) };
  }
  if (probe.kind === "response" && probe.status >= 200 && probe.status < 300) return { kind: "unsupported" };
  return failureFromCall(probe);
}

/** Failure of a connections call; a 404 is classified with one follow-up agent lookup. */
async function connectionCallFailure(
  target: Target,
  agent: { id: string; serverId: string },
  result: ProviderCallResult,
): Promise<AgentConnectionFailure> {
  if (result.kind === "response" && result.status === 404) return classifyConnection404(target, agent);
  return failureFromCall(result);
}

/**
 * The provider refusals a client acts on, by antiproton's error code
 * (`{error: {code, message}}`, cf/src/provision/handlers.ts): each becomes a
 * listed Raft refusal code (routes/agents.ts). `not_found` is not here: the
 * provider uses it for unknown routes, agents, connectors and pending ids alike,
 * so a 404 is classified by the call that got it (classifyConnection404,
 * connectorCallFailure, confirmAgentConnection). Any other code is the generic
 * provider refusal, its message passed through.
 */
const PROVIDER_REFUSALS: Readonly<Record<string, "connector_forbidden" | "account_mismatch">> = {
  // `creatorRefused`: actingRole creator, but the connector's creatorRaftUserId is someone else (PUT, DELETE
  // /connectors/:id, POST with connectorId, and confirm of a reconnect).
  not_creator: "connector_forbidden",
  // `reconnectInPlace`: the authorization is another GitHub account than the connector's; nothing was changed.
  account_mismatch: "account_mismatch",
};

function knownProviderRefusal(result: ProviderCallResult): AgentConnectionFailure | null {
  if (result.kind !== "response" || result.status < 400 || result.status >= 500 || !result.error) return null;
  const kind = Object.prototype.hasOwnProperty.call(PROVIDER_REFUSALS, result.error.code) ? PROVIDER_REFUSALS[result.error.code] : undefined;
  if (!kind) return null;
  return { kind, httpStatus: result.status, providerCode: sanitizeProviderCode(result.error.code), message: sanitizeProviderMessage(result.error.message) };
}

function failureFromCall(result: ProviderCallResult): AgentConnectionFailure {
  if (result.kind === "network") return { kind: "provider_error", httpStatus: null, code: sanitizeProviderCode(result.code), message: null };
  const known = knownProviderRefusal(result);
  if (known) return known;
  if (result.status === 404) return { kind: "unsupported" };
  return {
    kind: "provider_error",
    httpStatus: result.status,
    code: sanitizeProviderCode(result.error?.code ?? `http_${result.status}`),
    message: sanitizeProviderMessage(result.error?.message),
  };
}

/**
 * A removal that did not take: the provider's `outcome: "not_cleared"` body,
 * whatever the status (antiproton#1131 answers 409), with the agents it is
 * about: this origin's only (another origin's are counted under `otherOrigins`).
 */
function notClearedAgents(result: ProviderCallResult): unknown[] | null {
  if (result.kind !== "response") return null;
  const body = result.body as { outcome?: unknown; agents?: unknown } | null;
  if (body?.outcome !== "not_cleared") return null;
  return Array.isArray(body.agents) ? body.agents : [];
}

/**
 * The provider could not reach a copy of the credential it had handed out, so
 * only revoking on GitHub takes it back. The bodies antiproton builds
 * (cf/src/provision/handlers.ts, the same at 2a3c272c and after):
 *  - agent-level DELETE: 200 `{binding: "removed", mount: "not_cleared", action: "revoke_on_github", message}`;
 *  - connector DELETE, its success and its 409 partial alike: `revokeOnGithub: {agents, action: "revoke_on_github",
 *    message}` for this origin's agents, `otherOrigins.revoke: <count>` for another origin's.
 * Anything else (no field, another action, a count of 0) says nothing, so nobody is told to revoke for nothing.
 */
function saysRevokeOnGithub(result: ProviderCallResult): boolean {
  if (result.kind !== "response" || typeof result.body !== "object" || result.body === null) return false;
  const body = result.body as { action?: unknown; revokeOnGithub?: { action?: unknown } | null; otherOrigins?: { revoke?: unknown } | null };
  if (body.action === "revoke_on_github" || body.revokeOnGithub?.action === "revoke_on_github") return true;
  const elsewhere = body.otherOrigins?.revoke;
  return typeof elsewhere === "number" && elsewhere > 0;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, MAX_TEXT) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 100)).slice(0, 50) : [];
}

/**
 * A scope list as the provider sent it under `key` (antiproton #1166: `scopes`,
 * what GitHub granted; `requestedScopes`, what the flow asked for): an array is
 * a bounded string list, `null` is "not recorded" and stays null, anything else
 * (absent, or neither an array nor null) is undefined, so the key is left out.
 * Never guessed, and null never becomes `[]` (which means "none named").
 */
export function readProviderScopeList(record: Record<string, unknown>, key: "scopes" | "requestedScopes"): string[] | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return Array.isArray(value) ? stringList(value) : undefined;
}

/** Both scope lists of a provider body, each only when the provider sent it (`AgentConnectionScopesView`). */
export function readProviderScopes(record: Record<string, unknown>): AgentConnectionScopesView {
  const scopes = readProviderScopeList(record, "scopes");
  const requestedScopes = readProviderScopeList(record, "requestedScopes");
  return {
    ...(scopes !== undefined ? { scopes } : {}),
    ...(requestedScopes !== undefined ? { requestedScopes } : {}),
  };
}

/**
 * The health fields as the provider sent them (antiproton: `oauthStatus`,
 * `lastCheckError`, `lastCheckedAt` on the status and on each connector). A
 * field it did not send, or sent malformed, is left out: Raft never fills one in.
 */
export function readProviderHealth(record: Record<string, unknown>): AgentConnectionHealthView {
  const health: AgentConnectionHealthView = {};
  if ((AGENT_CONNECTION_OAUTH_STATUSES as readonly unknown[]).includes(record.oauthStatus)) {
    health.oauthStatus = record.oauthStatus as AgentConnectionOAuthStatus;
  }
  if (record.lastCheckError === null) health.lastCheckError = null;
  else if (typeof record.lastCheckError === "string") health.lastCheckError = sanitizeProviderMessage(record.lastCheckError);
  if (record.lastCheckedAt === null) health.lastCheckedAt = null;
  else if (typeof record.lastCheckedAt === "string") health.lastCheckedAt = boundedString(record.lastCheckedAt);
  return health;
}

/** The URL the provider sends the browser back to; always under this Raft's origin. */
export function buildAgentConnectionReturnUrl(raftOrigin: string, agent: { id: string; serverId: string }): string {
  return `${raftOrigin}${AGENT_CONNECTION_CALLBACK_API_PATH}/${encodeURIComponent(agent.serverId)}/${encodeURIComponent(agent.id)}`;
}

/**
 * A reconnect in place: the connector to mend and the capacity Raft checked the
 * initiator in (decideAgentConnectorAuthority, the rule of PUT and the connector
 * DELETE). The initiator is `initiatedBy.raftUserId`, the session user.
 */
export type AgentConnectionReconnect = { connectorId: string; actingRole: AgentConnectorActingRole };

/**
 * Starts the provider's OAuth flow. With `reconnect` the provider signs the
 * connector into the link (antiproton `connectorId` + `actingRole`), and its
 * confirm replaces that connector's tokens in place (same id, every agent on it
 * mended) instead of creating a new one. Authority is decided by the caller (the route).
 */
export async function startAgentConnection(
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
  input: { initiatedByUserId: string; access: "private" | null; reconnect?: AgentConnectionReconnect | null },
): Promise<AgentConnectionOutcome<AgentConnectionStartView>> {
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const reconnect = input.reconnect ?? null;
  const result = await providerRequest(target.value.config, "POST", providerAgentConnectionPath(agent.id, provider, agent.serverId), {
    body: {
      returnUrl: buildAgentConnectionReturnUrl(target.value.raftOrigin, agent),
      initiatedBy: { raftUserId: input.initiatedByUserId },
      ...(input.access ? { access: input.access } : {}),
      ...(reconnect ? { connectorId: reconnect.connectorId, actingRole: reconnect.actingRole } : {}),
    },
  });
  if (result.kind !== "response" || result.status < 200 || result.status >= 300) {
    // A reconnect names a connector, so its 404 is about the connector (antiproton `404 not_found`: unknown or
    // another tenant's) unless the agent is gone too; never "unsupported".
    const failure = reconnect
      ? await connectorCallFailure(target.value, agent, result)
      : await connectionCallFailure(target.value, agent, result);
    return { ok: false, failure };
  }
  const body = (result.body ?? {}) as { url?: unknown; expiresAt?: unknown; scopes?: unknown };
  const url = typeof body.url === "string" ? parseBrowserUrl(body.url) : null;
  if (!url) return { ok: false, failure: { kind: "provider_error", httpStatus: result.status, code: "invalid_connection_url", message: null } };
  return { ok: true, value: { url, expiresAt: boundedString(body.expiresAt) ?? "", scopes: stringList(body.scopes) } };
}

/** Only http(s) URLs may be handed to the browser. */
function parseBrowserUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The signed-in Raft user looking at or acting on connections, with their current role in the agent's server. */
/** `agentOwnerUserId`: the agent's owner (mcpAgentOwnerUserId), or null when it has none. */
export type AgentConnectionViewer = { userId: string; role: ServerRole | null; agentOwnerUserId: string | null };

/** A tenant connector as the provider lists it (no token), with its health and scopes when the provider sent them. */
export type ProviderConnector = AgentConnectionHealthView & AgentConnectionScopesView & {
  id: string;
  account: string | null;
  creatorRaftUserId: string | null;
  createdAt: string | null;
  current: boolean;
};

const MAX_CONNECTORS = 100;

function readProviderConnectors(raw: unknown, currentConnectorId: string | null): ProviderConnector[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const connectors: ProviderConnector[] = [];
  for (const item of raw.slice(0, MAX_CONNECTORS)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" && AGENT_CONNECTION_CONNECTOR_ID_RE.test(record.id) ? record.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    connectors.push({
      id,
      account: boundedString(record.account),
      creatorRaftUserId: boundedString(record.creatorRaftUserId),
      createdAt: boundedString(record.createdAt),
      current: typeof record.current === "boolean" ? record.current : id === currentConnectorId,
      ...readProviderHealth(record),
      ...readProviderScopes(record),
    });
  }
  return connectors;
}

/** GET the provider's status for the agent: the raw body, or the failure (404 classified). */
async function fetchProviderStatus(
  target: Target,
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
): Promise<AgentConnectionOutcome<Record<string, unknown>>> {
  const result = await providerRequest(target.config, "GET", providerAgentConnectionPath(agent.id, provider, agent.serverId));
  if (result.kind !== "response" || result.status < 200 || result.status >= 300) {
    return { ok: false, failure: await connectionCallFailure(target, agent, result) };
  }
  return { ok: true, value: (result.body ?? {}) as Record<string, unknown> };
}

export async function getAgentConnectionStatus(
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
  viewer: AgentConnectionViewer,
): Promise<AgentConnectionOutcome<AgentConnectionStatusView>> {
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const status = await fetchProviderStatus(target.value, agent, provider);
  if (!status.ok) {
    if (status.failure.kind === "unsupported") return { ok: true, value: { provider, supported: false } };
    return status;
  }
  return { ok: true, value: await statusView(provider, status.value, agent.serverId, viewer) };
}

async function statusView(
  provider: AgentConnectionProvider,
  rawBody: unknown,
  serverId: string,
  viewer: AgentConnectionViewer,
): Promise<AgentConnectionStatusView> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const connected = body.connected === true;
  const connectedById = boundedString(body.connectedBy);
  const rawConnectorId = typeof body.connectorId === "string" && AGENT_CONNECTION_CONNECTOR_ID_RE.test(body.connectorId) ? body.connectorId : null;
  const connectorId = connected ? rawConnectorId : null;
  const connectors = readProviderConnectors(body.connectors, connectorId);
  const requestedScopes = readProviderScopeList(body, "requestedScopes");
  const creators = await resolveServerMembers(serverId, connectors.map((connector) => connector.creatorRaftUserId));
  return {
    provider,
    supported: true,
    connected,
    account: connected ? boundedString(body.account) : null,
    connectedAt: connected ? boundedString(body.connectedAt) : null,
    connectedBy: connected && connectedById ? await resolveRaftUser(connectedById) : null,
    // As it always was: [] when not connected, and for null ("not recorded") or absent alike; the current
    // connector's entry keeps them apart.
    scopes: connected ? readProviderScopeList(body, "scopes") ?? [] : [],
    ...(requestedScopes !== undefined ? { requestedScopes } : {}),
    // `oauthStatus: "error"` comes with `connected: false`: the connection needs reconnecting (not a refusal code).
    ...readProviderHealth(body),
    connectorId,
    canConnectNew: viewer.agentOwnerUserId !== null && viewer.userId === viewer.agentOwnerUserId,
    // Only what this agent may use, so nobody is offered another person's account. The connector it
    // is already on stays listed whatever its creator, so it can be cleared.
    connectors: connectors.filter((connector) => connector.current || connector.id === connectorId
      || connectorAssignableToAgent(connector.creatorRaftUserId, viewer.agentOwnerUserId)).map((connector): AgentConnectionConnectorView => ({
      id: connector.id,
      account: connector.account,
      createdAt: connector.createdAt,
      creator: connector.creatorRaftUserId
        ? { id: connector.creatorRaftUserId, ...(creators.get(connector.creatorRaftUserId) ?? { name: null, displayName: null }) }
        : null,
      current: connector.current,
      canManage: decideAgentConnectorAuthority(viewer.role, viewer.userId, connector.creatorRaftUserId) !== null,
      assignable: connectorAssignableToAgent(connector.creatorRaftUserId, viewer.agentOwnerUserId),
      ...(connector.oauthStatus !== undefined ? { oauthStatus: connector.oauthStatus } : {}),
      ...(connector.lastCheckError !== undefined ? { lastCheckError: connector.lastCheckError } : {}),
      ...(connector.lastCheckedAt !== undefined ? { lastCheckedAt: connector.lastCheckedAt } : {}),
      ...(connector.scopes !== undefined ? { scopes: connector.scopes } : {}),
      ...(connector.requestedScopes !== undefined ? { requestedScopes: connector.requestedScopes } : {}),
    })),
  };
}

/** Handle and display name of the given users, only for members of this server (unknown ids are skipped). */
async function resolveServerMembers(
  serverId: string,
  ids: readonly (string | null)[],
): Promise<Map<string, { name: string | null; displayName: string | null }>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))];
  const resolved = new Map<string, { name: string | null; displayName: string | null }>();
  if (wanted.length === 0) return resolved;
  const rows = await getDb().select({ id: users.id, name: users.name, displayName: users.displayName })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, wanted)));
  for (const row of rows) resolved.set(row.id, { name: row.name ?? null, displayName: row.displayName ?? null });
  return resolved;
}

/**
 * The connector `connectorId` as the provider lists it for this agent's
 * server, so the route can learn its creator and decide who may act on it.
 */
export async function findAgentConnectionConnector(
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
  connectorId: string,
): Promise<AgentConnectionOutcome<ProviderConnector>> {
  if (!AGENT_CONNECTION_CONNECTOR_ID_RE.test(connectorId)) return { ok: false, failure: { kind: "connector_not_found" } };
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const status = await fetchProviderStatus(target.value, agent, provider);
  if (!status.ok) return status;
  const connectorIdNow = typeof status.value.connectorId === "string" ? status.value.connectorId : null;
  const connector = readProviderConnectors(status.value.connectors, connectorIdNow).find((item) => item.id === connectorId);
  return connector ? { ok: true, value: connector } : { ok: false, failure: { kind: "connector_not_found" } };
}

type ConnectorAction = { connectorId: string; actingRaftUserId: string; actingRole: AgentConnectorActingRole };

/** A 404 on a connector action: the agent is gone at the provider, or else the connector is. */
async function connectorCallFailure(
  target: Target,
  agent: { id: string; serverId: string },
  result: ProviderCallResult,
): Promise<AgentConnectionFailure> {
  const failure = await connectionCallFailure(target, agent, result);
  return failure.kind === "unsupported" ? { kind: "connector_not_found" } : failure;
}

/** Switch the agent's mount to a tenant connector. Authority is decided by the caller (the route). */
export async function assignAgentConnectionConnector(
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
  action: ConnectorAction,
  viewer: AgentConnectionViewer,
): Promise<AgentConnectionOutcome<AgentConnectionStatusView>> {
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const result = await providerRequest(target.value.config, "PUT", providerAgentConnectionPath(agent.id, provider, agent.serverId), {
    body: { connectorId: action.connectorId, actingRaftUserId: action.actingRaftUserId, actingRole: action.actingRole },
  });
  if (result.kind !== "response" || result.status < 200 || result.status >= 300) {
    return { ok: false, failure: await connectorCallFailure(target.value, agent, result) };
  }
  return getAgentConnectionStatus(agent, provider, viewer);
}

/** Disconnect a tenant connector: every agent using it loses access. Authority is decided by the caller (the route). */
export async function disconnectAgentConnectionConnector(
  agent: { id: string; serverId: string },
  action: ConnectorAction,
): Promise<AgentConnectionOutcome<AgentConnectionRemoved>> {
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const result = await providerRequest(target.value.config, "DELETE", providerConnectorPath(action.connectorId, agent.serverId), {
    body: { actingRaftUserId: action.actingRaftUserId, actingRole: action.actingRole },
  });
  // Partial failure: some agents still hold the credential. Not a success; the same call again completes the cleanup.
  // An unreachable copy is said here too: the retry no longer meets it (its binding is gone), so it is passed on now.
  const notCleared = notClearedAgents(result);
  if (notCleared) {
    return { ok: false, failure: { kind: "connector_disconnect_partial", failedCount: notCleared.length, revokeOnGithub: saysRevokeOnGithub(result) } };
  }
  if (result.kind !== "response" || result.status < 200 || result.status >= 300) {
    return { ok: false, failure: await connectorCallFailure(target.value, agent, result) };
  }
  return { ok: true, value: { revokeOnGithub: saysRevokeOnGithub(result) } };
}

/**
 * Completes a flow the provider parked as pending. `confirmedByUserId` is the
 * signed-in Raft user (already re-authorized by the route); the provider only
 * attaches the connection when it matches the user who started the flow.
 */
export async function confirmAgentConnection(
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
  input: { pending: string; confirmedByUserId: string },
  viewer: AgentConnectionViewer,
): Promise<AgentConnectionOutcome<AgentConnectionStatusView>> {
  if (!AGENT_CONNECTION_PENDING_ID_RE.test(input.pending)) return { ok: false, failure: { kind: "pending_invalid", providerCode: null, message: null } };
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const result = await providerRequest(target.value.config, "POST", providerAgentConnectionConfirmPath(agent.id, provider, agent.serverId), {
    body: { pending: input.pending, raftUserId: input.confirmedByUserId },
  });
  // antiproton's `404 connector_gone` (antiproton #1167): the connector a reconnect targeted was deleted meanwhile, so
  // the client drops it from the list; any other confirm 404 is the link (expired, used, or another user's).
  if (result.kind === "response" && result.status === 404 && result.error?.code === "connector_gone") {
    return { ok: false, failure: { kind: "connector_not_found" } };
  }
  if (result.kind === "response" && result.status === 404) {
    return {
      ok: false,
      failure: {
        kind: "pending_invalid",
        providerCode: result.error ? sanitizeProviderCode(result.error.code) : null,
        message: sanitizeProviderMessage(result.error?.message),
      },
    };
  }
  if (result.kind !== "response" || result.status < 200 || result.status >= 300) {
    return { ok: false, failure: failureFromCall(result) };
  }
  return { ok: true, value: await statusView(provider, result.body, agent.serverId, viewer) };
}

async function resolveRaftUser(id: string): Promise<{ id: string; name: string | null }> {
  if (!UUID_RE.test(id)) return { id, name: null };
  const [user] = await getDb().select({ name: users.name, displayName: users.displayName })
    .from(users).where(eq(users.id, id)).limit(1);
  return { id, name: user ? user.displayName || user.name : null };
}

/** Detach this agent from its connector (its mount); the tenant connector stays for other agents. */
export async function disconnectAgentConnection(
  agent: { id: string; serverId: string },
  provider: AgentConnectionProvider,
): Promise<AgentConnectionOutcome<AgentConnectionRemoved>> {
  const target = await resolveTarget(agent);
  if (!target.ok) return target;
  const result = await providerRequest(target.value.config, "DELETE", providerAgentConnectionPath(agent.id, provider, agent.serverId));
  // The mount still holds the credential: the connection was kept, the same call again completes it.
  if (notClearedAgents(result)) return { ok: false, failure: { kind: "connection_disconnect_not_cleared" } };
  if (result.kind !== "response" || result.status < 200 || result.status >= 300) {
    return { ok: false, failure: await connectionCallFailure(target.value, agent, result) };
  }
  // Removed, but the agent's storage is gone: what it was handed is out of the provider's reach.
  return { ok: true, value: { revokeOnGithub: saysRevokeOnGithub(result) } };
}

/**
 * The API bounce: the provider may only return to Raft's API origin, the
 * landing page lives on the web app. Only allowlisted, well-formed values are
 * forwarded; nothing here trusts the query (the landing page re-checks `by`
 * against the signed-in user and re-reads status from the provider).
 */
export function buildAgentConnectionLandingUrl(input: {
  serverId: string;
  agentId: string;
  query: Record<string, unknown>;
}): string | null {
  if (!UUID_RE.test(input.serverId) || !UUID_RE.test(input.agentId)) return null;
  const connection = input.query.connection;
  const rawStatus = input.query.status;
  const by = input.query.by;
  const pending = input.query.pending;
  const url = new URL(AGENT_CONNECTION_CALLBACK_WEB_PATH, getAppUrl());
  if (isAgentConnectionProvider(connection)) url.searchParams.set("connection", connection);
  const status: AgentConnectionCallbackStatus = (AGENT_CONNECTION_CALLBACK_STATUSES as readonly unknown[]).includes(rawStatus)
    ? rawStatus as AgentConnectionCallbackStatus
    : "failed";
  url.searchParams.set("status", status);
  if (status === "pending" && typeof pending === "string" && AGENT_CONNECTION_PENDING_ID_RE.test(pending)) {
    url.searchParams.set("pending", pending);
  }
  if (typeof by === "string" && UUID_RE.test(by)) url.searchParams.set("by", by);
  url.searchParams.set("serverId", input.serverId);
  url.searchParams.set("agentId", input.agentId);
  return url.toString();
}
