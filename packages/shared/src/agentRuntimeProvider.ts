/**
 * Hosted runtime providers for external agents (raft-agent-provider.v1).
 *
 * The provider (today only antiproton) is configured once per deployment
 * (env) and enabled per server by a feature flag. "Create external agent" can
 * then pick it: Raft creates the agent,
 * mints its `sk_agent_*` credential server-side and provisions the agent on
 * the provider, which runs it over the ordinary external-agent protocol.
 * Provisioning is a separate layer; the runtime protocol is unchanged.
 *
 * There is deliberately no model field anywhere: provisioned agents run on
 * the provider's default model.
 */

export const AGENT_RUNTIME_PROVIDER_KINDS = ["antiproton"] as const;
export type AgentRuntimeProviderKind = typeof AGENT_RUNTIME_PROVIDER_KINDS[number];

export function isAgentRuntimeProviderKind(value: unknown): value is AgentRuntimeProviderKind {
  return typeof value === "string" && (AGENT_RUNTIME_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * `GET /api/agent-runtime-providers/:kind` — read-only availability probe for
 * the create dialog: the deployment has the provider configured (env) AND the
 * server has the provider's feature flag. Nothing about the configuration is
 * exposed.
 */
export interface AgentRuntimeProviderAvailabilityView {
  kind: AgentRuntimeProviderKind;
  available: boolean;
}

/**
 * Provisioning lifecycle of one agent on a hosted runtime provider.
 *
 * provisioning → active            POST succeeded (edits then flow as PATCH)
 * provisioning → failed            the provider refused (4xx) or is not configured; retry is manual
 * failed       → provisioning      manual retry
 * any          → deleting          the Raft agent was deleted (credentials revoked first)
 * deleting     → deleted           provider DELETE answered 2xx/404
 */
export const AGENT_RUNTIME_PROVISION_STATES = ["provisioning", "active", "failed", "deleting", "deleted"] as const;
export type AgentRuntimeProvisionState = typeof AGENT_RUNTIME_PROVISION_STATES[number];

export interface AgentRuntimeProvisionError {
  code: string;
  message: string;
  /** HTTP status from the provider; null for network/timeout/local errors. */
  httpStatus: number | null;
  at: string;
}

/** `hostedRuntime` on agent responses for callers who can manage the agent. */
export interface AgentHostedRuntimeSummary {
  provider: AgentRuntimeProviderKind;
  state: AgentRuntimeProvisionState;
  providerAgentId: string | null;
  /** An edit (name/instructions) is waiting to be PATCHed to the provider. */
  syncPending: boolean;
  push: { registered: boolean; error: string | null } | null;
  lastError: AgentRuntimeProvisionError | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  activatedAt: string | null;
  /**
   * The provider refused the picked model (`unknown_model` / `model_locked`):
   * a retry must name the model again (`POST .../hosted-runtime/retry {model}`).
   */
  retryNeedsModel: boolean;
  /**
   * Workspace import after create (hosted Cindy's seed, a migrated
   * workspace); null when the agent has none. `failed` waits for a manual
   * retry, which re-imports without creating the agent again. Optional for
   * older servers.
   */
  import?: { state: "pending" | "done" | "failed"; error: AgentRuntimeProvisionError | null } | null;
}

/** One model a hosted-runtime provider offers (its `USER_MODELS`): what to show and the id to store. */
export interface HostedAgentModelOption {
  id: string;
  label: string;
  provider: string;
}

/**
 * `GET /api/agent-runtime-providers/:kind/models`: the models a new hosted
 * agent on this server can start on (the provider's `GET /provision/models`).
 * `default` is the deployment's default, what an agent that picked nothing
 * runs on. While `locked`, an administrator decides the model: a create or
 * retry must not name one.
 */
export interface HostedRuntimeModelsView {
  models: HostedAgentModelOption[];
  default: string | null;
  defaultLabel: string | null;
  locked: boolean;
  /**
   * Whether this server may pick a model (`antiproton_model_picker`). When
   * false, Raft decides (`HOSTED_DEFAULT_MODEL`) and clients show no picker.
   * Absent from older servers: treat as true.
   */
  picker?: boolean;
}

/** The model every hosted agent starts on where the server may not pick one. */
export const HOSTED_DEFAULT_MODEL = "deepseek-flash";

/**
 * `GET|PUT /api/agents/:id/hosted-runtime/model`: the models the provider
 * offers and what this agent's next turn runs on. `model` is an offered id,
 * or `<provider>/<model>` when an administrator set one no option names.
 * `source`: `default` (nothing picked), `chosen` (a pick), `admin` (an
 * administrator's row decides). While `locked`, a pick is refused (409).
 */
export interface HostedAgentModelView {
  models: HostedAgentModelOption[];
  default: string | null;
  defaultLabel: string | null;
  model: string | null;
  label: string | null;
  source: "default" | "chosen" | "admin";
  locked: boolean;
  /** Whether this server may pick a model (`antiproton_model_picker`); absent from older servers: true. */
  picker?: boolean;
}

/**
 * A server's spend on its hosted runtime provider, as the provider reports it
 * (`GET /api/billing/hosted-runtime-usage`, antiproton `GET /provision/usage`).
 * Estimated and display-only: Raft stores no copy and nothing bills from it.
 * `today` is the reading the provider enforces its daily limit with; `refusing`
 * means a model call would be refused now (the server's limit or the
 * platform's). `limitUsd: null` = exempt or no server limit. Days are UTC.
 */
export interface HostedRuntimeSpendView {
  currency: string;
  estimated: boolean;
  today: {
    day: string;
    spentUsd: number;
    limitUsd: number | null;
    exempt: boolean;
    platformLimitReached: boolean;
    refusing: boolean;
    resetsAt: string;
  };
  from: string;
  to: string;
  bucket: "day" | "month";
  totalUsd: number;
  /** Only periods with usage, newest first. `unpriced` lists usage not counted in `totalUsd`. */
  periods: Array<{ start: string; totalUsd: number; unpriced: string[] }>;
  /**
   * By spend, largest first. `agentId` is the Raft agent; `null` gathers spend
   * of agents Raft no longer has (deleted), as one entry.
   */
  agents: Array<{ agentId: string | null; name: string | null; totalUsd: number }>;
}

/**
 * Account connections for provider-backed agents (raft-agent-provider.v1
 * connections extension). The provider owns the OAuth flow and the token;
 * Raft only starts it, reads status and disconnects. Allowlist: GitHub only.
 */
export const AGENT_CONNECTION_PROVIDERS = ["github"] as const;
export type AgentConnectionProvider = typeof AGENT_CONNECTION_PROVIDERS[number];

export function isAgentConnectionProvider(value: unknown): value is AgentConnectionProvider {
  return typeof value === "string" && (AGENT_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Outcome the provider appends to the returnUrl after the OAuth round trip.
 * `pending` carries a `pending=<id>` that only takes effect once Raft confirms
 * it server-to-server for the signed-in user who started the flow.
 */
export const AGENT_CONNECTION_CALLBACK_STATUSES = ["pending", "denied", "failed"] as const;
export type AgentConnectionCallbackStatus = typeof AGENT_CONNECTION_CALLBACK_STATUSES[number];

/**
 * `POST /api/agents/:id/connections/:provider` body. `private` requests
 * private-repo access. `connectorId` (one of the status's `connectors`, shaped
 * like AGENT_CONNECTION_CONNECTOR_ID_RE) reconnects that connector in place:
 * confirm replaces its tokens, keeping its id, for every agent on it. It needs
 * the connector's creator or a server owner/admin (its `canManage`); the
 * authorization must be the connector's own GitHub account. No other field is
 * accepted.
 */
export interface AgentConnectionStartRequest {
  access?: "private";
  connectorId?: string;
}

/** `POST /api/agents/:id/connections/:provider/confirm` body: the provider's pending id from the return URL. */
export interface AgentConnectionConfirmRequest {
  pending: string;
}

/** Shape of a pending id the provider hands back (opaque, URL-safe). */
export const AGENT_CONNECTION_PENDING_ID_RE = /^[A-Za-z0-9_.~-]{1,200}$/;

/** `POST /api/agents/:id/connections/:provider` → one-time provider URL the browser opens. */
export interface AgentConnectionStartView {
  url: string;
  expiresAt: string;
  scopes: string[];
}

/** `PUT /api/agents/:id/connections/:provider` body: point the agent at a tenant connector. */
export interface AgentConnectionAssignRequest {
  connectorId: string;
}

/**
 * A removal that took: `DELETE /api/agents/:id/connections/:provider` (this
 * agent) or `…/connectors/:connectorId` (every agent). With nothing more to
 * say it answers 204 and no body. When the provider could not reach a copy of
 * the credential it had handed to an agent (that agent's storage is gone), it
 * answers 200 with `revokeOnGithub: true`: the person should also revoke the
 * authorization on GitHub. The 502 partial disconnect carries the same field.
 */
export interface AgentConnectionRemovedView {
  revokeOnGithub?: true;
}

/** Shape of a connector id the provider hands back (opaque, URL-safe). */
export const AGENT_CONNECTION_CONNECTOR_ID_RE = /^[A-Za-z0-9_.~-]{1,200}$/;

/** Who is acting on a connector, decided by Raft (the provider knows no roles). */
export type AgentConnectorActingRole = "creator" | "admin";

/**
 * A connection's health as the provider reports it, in the words of Raft's
 * managed-MCP OAuth connectors: `connected` (working), `disconnected` (this
 * agent has no connection) or `error` (GitHub refused to renew it: only
 * reconnecting mends it). A connector in `connectors` is `connected` or
 * `error`. "Needs reconnecting" is this field, never a refusal code.
 */
export type AgentConnectionOAuthStatus = "connected" | "disconnected" | "error";

export const AGENT_CONNECTION_OAUTH_STATUSES: readonly AgentConnectionOAuthStatus[] = ["connected", "disconnected", "error"];

/**
 * A connection's OAuth scopes as the provider recorded them (antiproton
 * #1166): `scopes`, what GitHub's token answer granted; `requestedScopes`,
 * what the connect flow asked for. `[]`: none named (for `scopes`, GitHub's
 * answer named no scope). `null`: not
 * recorded (a connector made before the provider kept them; one reconnect
 * records them). Absent: the provider does not report them (an older one).
 *
 * If the connection turns out to hold a GitHub App user token, `scopes` is
 * `[]`: such a token's access is the App's permissions plus the repositories
 * the person chose, not OAuth scopes. Then `requestedScopes` must not be shown
 * as granted (Tenny and Kirby decide the display after the first real
 * connection).
 */
export interface AgentConnectionScopesView {
  scopes?: string[] | null;
  requestedScopes?: string[] | null;
}

/**
 * The provider's health fields, passed through as it sent them. Each is
 * absent when the provider did not send it (a provider from before
 * antiproton reported health): Raft never fills one in.
 */
export interface AgentConnectionHealthView {
  oauthStatus?: AgentConnectionOAuthStatus;
  /** Why it needs reconnecting (antiproton: "OAuth authorization expired; reconnect required"), or null. */
  lastCheckError?: string | null;
  /** When the provider last checked the connection (connect, switch, renewal, the refusal that broke it), or null. */
  lastCheckedAt?: string | null;
}

/**
 * A tenant-level (per Raft server) account connection. Several agents may use
 * the same connector; no token is ever part of this view.
 */
export interface AgentConnectionConnectorView extends AgentConnectionHealthView, AgentConnectionScopesView {
  id: string;
  account: string | null;
  createdAt: string | null;
  /** The Raft user who created the connector; `name`/`displayName` are null when not a member of this server. */
  creator: { id: string; name: string | null; displayName: string | null } | null;
  /** The agent currently uses this connector. */
  current: boolean;
  /** The caller may reconnect and disconnect this connector (its creator or a server owner/admin). */
  canManage: boolean;
  /**
   * This agent may be switched to this connector: its creator is the agent's owner. False only for
   * the connector the agent is on from before the rule, which is listed so it can be cleared.
   * Absent from an older server: treat as true.
   */
  assignable?: boolean;
}

/**
 * `GET /api/agents/:id/connections/:provider`. `supported: false` when the
 * provider does not serve connections (it answered 404). The health fields
 * are this agent's connection's (`oauthStatus: "error"` while `connected` is
 * false: it needs reconnecting); each connector carries its own.
 */
export type AgentConnectionStatusView =
  | { provider: AgentConnectionProvider; supported: false }
  | (AgentConnectionHealthView & {
      /** The caller is this agent's owner, the only person who may connect a new account to it. Absent from an older server: treat as true. */
      canConnectNew?: boolean;
    provider: AgentConnectionProvider;
    supported: true;
    connected: boolean;
    account: string | null;
    connectedAt: string | null;
    /** The Raft user who completed the connection, resolved when still known. */
    connectedBy: { id: string; name: string | null } | null;
    /**
     * What GitHub granted this agent's connection (`AgentConnectionScopesView`),
     * kept as it always was: `[]` when not connected, and also when GitHub named
     * none, when the provider has not recorded them (`null`) or does not report
     * them. The current connector's entry in `connectors` tells those apart
     * (`[]` vs `null` vs absent).
     */
    scopes: string[];
    /** What the connect flow asked for, as the provider sent it (`null`: not recorded); absent when it did not send it. Not what was granted. */
    requestedScopes?: string[] | null;
    /** The tenant connector this agent uses, if any. */
    connectorId: string | null;
    /** Every tenant connector of this provider on the agent's server. */
    connectors: AgentConnectionConnectorView[];
  });

/**
 * `GET /api/agents/:id/external-diagnostics` — the debugging snapshot of an
 * external agent (runtime `external`, incl. provider-backed ones) behind the
 * agent panel's "Copy diagnostic info". Same access as the other private agent
 * surfaces (owner/admin `editAgents`, or the agent's human creator). Carries no
 * secrets: the push endpoint is reduced to its host.
 */
export interface ExternalAgentDiagnosticsView {
  agentId: string;
  runtime: string;
  generatedAt: string;
  /** Hosted runtime provisioning; null for a self-run external agent. */
  provider: {
    kind: AgentRuntimeProviderKind;
    state: AgentRuntimeProvisionState;
    providerAgentId: string | null;
    syncPending: boolean;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    activatedAt: string | null;
  } | null;
  presence: {
    /** max(credential last_used_at) over the agent's active credentials. */
    lastSeenAt: string | null;
    onlineWindowMs: number;
    /** lastSeenAt is within onlineWindowMs of generatedAt. */
    online: boolean;
  };
  status: {
    activity: string;
    detail: string | null;
    detailKind: string | null;
    /** When the live status was observed (reporter occurredAt when known). */
    observedAt: string | null;
    /** Newest activity-log entry. */
    lastActivityLogAt: string | null;
    /** First accepted raft-agent-status.v1 report; null = hook-derived status. */
    statusProtocolAdoptedAt: string | null;
  };
  push: {
    registered: boolean;
    enabled: boolean;
    /** Host of the registered endpoint only (no path/query). */
    endpointHost: string | null;
    disabledReason: string | null;
    disabledAt: string | null;
    consecutiveFailures: number;
    lastAttemptAt: string | null;
    lastDeliveryAt: string | null;
    lastError: string | null;
    nextAttemptAt: string | null;
    /** When Raft stopped probing a stopped endpoint (30 days); a new PUT clears it. */
    probeStoppedAt?: string | null;
    /** While disabled: how delivery resumes (probing, or a new PUT). Absent from older servers. */
    recovery?: string | null;
  };
  events: {
    /** Last cursor-mode `GET /internal/agent-api/events?ack=cursor` (or its ack), if any. */
    lastCursorPullAt: string | null;
    /** Durable seqs handed over by that pull and not yet acknowledged. */
    pendingCursorAckCount: number;
  };
  /**
   * Account connections (provider-backed agents only). `state`:
   * connected / not_connected / unsupported (the provider serves none) /
   * not_applicable (not provider-backed) / unavailable (`reason` says why).
   */
  connections: Array<{
    provider: AgentConnectionProvider;
    state: "connected" | "not_connected" | "unsupported" | "not_applicable" | "unavailable";
    account: string | null;
    reason: string | null;
  }>;
}
