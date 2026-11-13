import type { NextFunction, Request, Response } from "express";
import {
  ACTION_CARD_ACTION_TYPES,
  createTraceScopeTracer,
  parseTraceparent,
  projectTraceScopeAttrs,
  noopTracer,
  RAFT_CLI_ENTRY_HEADER,
  RAFT_CLI_STABLE_ENTRY,
  RAFT_CLIENT_VERSION_HEADER,
  RAFT_COMPUTER_VERSION_HEADER,
  RAFT_DAEMON_VERSION_HEADER,
  RAFT_RUNTIME_HEADER,
  type TraceAttributes,
  type TraceContext,
  type TraceScope,
  type TraceSpanAttrContracts,
  type Tracer,
  type TraceStatus,
} from "@botiverse/raft-shared";
import { httpRequestDuration, httpRequestsTotal } from "../metrics";
import { normalizeRequestRoutePattern } from "./requestRoutePattern";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import { agentIdHashAttrs, serverIdHashAttrs, traceAgentIdHash, traceMachineIdHash } from "../tracing/traceIdentity";
import { cachedTraceUserId } from "../tracing/traceUserId";
import { clientIpHashAttrs } from "../tracing/clientIpHash";
import { CLIENT_PLATFORM_HEADER_VALUES, raftVersionFromUserAgent } from "../services/productEventContext";
import { classifyPublicRequester, classifyRequesterUserAgent } from "./publicRequester";

export type HttpStatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "other";
export type HttpCallerKind = "human" | "agent" | "system";

const AGENT_ID_HEADER = "x-agent-id";
const HTTP_REQUEST_SCOPE_ATTR_KEYS = [
  "daemon_version",
  "daemon_version_present",
  "route_pattern",
  "method",
  "caller_kind",
  "user_id",
  "user_id_present",
  "server_id_present",
  "machine_id_present",
  "agent_id_present",
  "agent_id_hash",
  // The agent id a refused request claimed (claimedAgentIdHashAttrs). Not proof
  // of identity, and kept apart from agent_id_hash, which is always verified.
  "claimed_agent_id_hash",
  "server_id_hash",
  "trace_user_id",
  "session_id",
  "session_id_present",
  "auth_trace_source",
  "auth_trace_reason",
  // A route's stable failure code (setRequestTraceErrorCode), e.g. rw_overloaded.
  "error_code",
  // Coarse 4xx class next to error_code (setRequestTraceErrorCode), e.g. not_found.
  "reason_class",
  // The Computer a request waits on (setRequestTraceComputerTarget), so slow or
  // 504 answers split by Computer version and runtime.
  "target_machine_id_hash",
  // The Computer making an sk_computer_* request and the migration it names
  // (setRequestTraceComputerCaller): that credential carries no req.machineId.
  "machine_id_hash",
  "migration_id",
  "target_computer_version",
  "target_daemon_version",
  "target_runtime",
  "option_source_id",
  // How a read-only Computer probe was answered (setRequestTraceComputerProbeState):
  // ok, stale (cached after the wait budget) or unavailable.
  "computer_probe_state",
  // Which machine credential authenticated (or was refused): legacy_machine
  // (sk_machine_*/sk_daemon_*) or computer (sk_computer_*). setRequestTraceMachineKeyKind.
  "machine_key_kind",
  // The card type an agent asked to prepare (setRequestTraceActionType), so
  // refusals (error_code) split by type, e.g. plan:upgrade.
  "action_type",
  // Which limiter refused a 429 (setRequestTraceRateLimiter), so refusals
  // split by limiter, e.g. auth vs upload.
  "rate_limiter",
  // Whose limit refused a channel between two servers (setRequestTraceLimitSide):
  // the channel's host or the connecting side. Never which server.
  "limit_side",
  // A multi-connect's refused servers (setRequestTraceRefusedCodes): it answers
  // 200 with each server's outcome, so it has no error_code of its own.
  "refused_codes",
  // What the caller says it is (requestClientAttrs): its client and version,
  // and through the daemon's agent proxy the Computer, daemon and runtime.
  "client_kind",
  "client_platform",
  "client_version",
  "client_computer_version",
  "client_daemon_version",
  "client_runtime",
  // A signed-out public route's caller, as a fixed class of its User-Agent
  // (publicRequester.ts): counting only, never the raw User-Agent.
  "public_requester",
  // Every caller, as a fixed class of its User-Agent (classifyRequesterUserAgent):
  // a Raft App, an HTTP library, an AI fetcher, a bot or a browser. Never the raw value.
  "user_agent_class",
  // Where a 5xx that matched no route was headed (unmatchedPrefixAttrs).
  "unmatched_prefix",
  // The IP-keyed rate limiters' key, as a salted HMAC (tracing/clientIpHash.ts):
  // the hash, the salt's version, and whether the key is the visitor's address
  // or the CloudFront edge's. Rate limiting and abuse only; never the address.
  "client_ip_hash",
  "client_ip_hash_salt",
  "client_ip_source",
] as const;

// How the request span treated the caller's traceparent (see
// inboundTraceParent). client_* name the context an external caller sent when
// it was recorded instead of continued; they are only written after the value
// parsed as a W3C traceparent, otherwise client_traceparent_invalid is set.
const HTTP_REQUEST_TRACE_PARENT_ATTR_KEYS = [
  "trace_parent_policy",
  "client_trace_id",
  "client_parent_span_id",
  "client_traceparent_invalid",
  "trace_parent_claim_mismatch",
] as const;

const HTTP_REQUEST_TRACE_ATTR_CONTRACTS = {
  "server.http.request": {
    spanAttrs: [],
    eventAttrs: {
      "http.response.finished": [
        "event_kind",
        "outcome",
        "reason",
        ...HTTP_REQUEST_SCOPE_ATTR_KEYS,
        "http.route",
        "http.request.method",
        "status_bucket",
        "http.response.status_code",
      ],
      "http.response.closed": [
        "event_kind",
        "outcome",
        "reason",
        ...HTTP_REQUEST_SCOPE_ATTR_KEYS,
        "http.route",
        "http.request.method",
        "status_bucket",
        "http.response.status_code",
      ],
    },
    endAttrs: [
      "event_kind",
      "outcome",
      "reason",
      ...HTTP_REQUEST_SCOPE_ATTR_KEYS,
      "http.route",
      "http.request.method",
      "status_bucket",
      "status_code",
      "http.response.status_code",
      ...HTTP_REQUEST_TRACE_PARENT_ATTR_KEYS,
    ],
  },
} satisfies TraceSpanAttrContracts;

export function normalizeObservedRoutePattern(req: Request): string {
  return normalizeRequestRoutePattern(req, {
    includeQuery: false,
    unmatchedLabel: "unmatched",
  });
}

export function bucketHttpStatus(status: number): HttpStatusBucket {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function httpOutcomeForStatus(statusCode: number): "success" | "error" {
  return statusCode >= 500 ? "error" : "success";
}

function httpReasonForStatusBucket(statusBucket: HttpStatusBucket): string {
  return `http_${statusBucket}`;
}

export function hasAgentIdHint(req: Request, routePattern: string): boolean {
  return Boolean(req.header?.(AGENT_ID_HEADER)?.trim()) || routePattern.startsWith("/internal/agent/");
}

export function inferHttpCallerKind(req: Request, routePattern: string): HttpCallerKind {
  if (hasAgentIdHint(req, routePattern)) return "agent";
  if (req.machineId || routePattern.startsWith("/internal/machine/") || routePattern === "/health" || routePattern === "/livez") return "system";
  return "human";
}

export type AuthTraceIdentitySource =
  | "email_register"
  | "email_login"
  | "passkey_login"
  | "mobile_oauth"
  | "social_oauth"
  | "device_auth"
  | "app_login"
  | "require_auth"
  | "refresh"
  | "logout";

export type AuthTraceIdentityReason =
  | "invalid_or_expired_refresh"
  | "refresh_rotation_superseded"
  // The refresh token's sign-in was revoked (sessionService.isRevokedSessionRefreshToken).
  | "refresh_session_revoked"
  | "invalid_refresh_binding"
  | "missing_refresh_token"
  | "logout_session_not_found"
  | "user_missing"
  | "password_mismatch"
  | "user_retired"
  // The first factor passed and two-step verification is on: a challenge, no session.
  | "second_factor_required"
  // ...but the web page is older than the second step (secondFactor/oldWebClient.ts): told to reload, no challenge.
  | "web_client_too_old";

export interface AuthTraceIdentity {
  userId?: string | null;
  sessionId?: string | null;
  source: AuthTraceIdentitySource;
  reason?: AuthTraceIdentityReason | null;
}

declare global {
  namespace Express {
    interface Request {
      authTraceIdentity?: AuthTraceIdentity;
    }
  }
}

export function attachAuthTraceIdentity(req: Request, identity: AuthTraceIdentity): void {
  req.authTraceIdentity = identity;
}

function buildRequestTraceScope(
  req: Request,
  routePattern: string | null,
  callerKind: HttpCallerKind | null,
  agentIdPresent: boolean | null,
): TraceScope {
  return {
    resource: {
      daemonVersion: req.daemonVersion,
    },
    request: {
      ...(routePattern ? { routePattern } : {}),
      method: req.method,
      ...(callerKind ? { callerKind } : {}),
      userId: req.authTraceIdentity?.userId,
      userIdPresent: Boolean(req.authTraceIdentity?.userId ?? req.userId),
    },
    actor: {
      serverId: req.serverId,
      machineId: req.machineId,
      // Agent-credential auth (/internal/agent-api/*) sets actingAgentId; the
      // header/route hint alone misses that surface.
      ...(typeof agentIdPresent === "boolean" ? { agentIdPresent: agentIdPresent || Boolean(traceAgentIdOf(req)) } : {}),
      sessionId: req.authTraceIdentity?.sessionId,
      sessionIdPresent: Boolean(req.authTraceIdentity?.sessionId),
    },
  };
}

/** Agent the request acts for: agent-credential auth, else the scope-checked
 *  `:id` of a machine-authenticated `/internal/agent/:id/*` call. */
function traceAgentIdOf(req: Request): string | undefined {
  return req.actingAgentId ?? req.traceAgentId;
}

/**
 * A 401 has no verified agent, so without this every refused agent request looks
 * the same in traces and "how many agents are locked out" has no answer. Hashes
 * the x-agent-id header the caller sent; nothing from the key.
 */
function claimedAgentIdHashAttrs(req: Request, statusCode: number): { claimed_agent_id_hash?: string } {
  if (statusCode !== 401 || traceAgentIdOf(req)) return {};
  const hash = traceAgentIdHash(req.header?.(AGENT_ID_HEADER)?.trim());
  return hash ? { claimed_agent_id_hash: hash } : {};
}

function buildInitialRequestTraceScope(req: Request): TraceScope {
  return {
    resource: {
      daemonVersion: req.daemonVersion,
    },
    request: {
      method: req.method,
    },
  };
}

const REQUEST_TRACE_ERROR_CODE_LOCAL = "traceErrorCode";
const REQUEST_TRACE_REASON_CLASS_LOCAL = "traceReasonClass";

/** Coarse class of a client error, from its status: what kind of wall the caller hit. */
export type RequestTraceReasonClass = "invalid_input" | "forbidden" | "not_found" | "conflict" | "gone" | "rate_limited" | "client_error";

export function requestTraceReasonClassForStatus(status: number): RequestTraceReasonClass | null {
  if (status < 400 || status >= 500) return null;
  if (status === 400 || status === 413 || status === 415 || status === 422) return "invalid_input";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 410) return "gone";
  if (status === 429) return "rate_limited";
  return "client_error";
}

/**
 * A stable, low-cardinality code for why this request failed (e.g.
 * "rw_overloaded"), recorded as error_code on server.http.request alongside the
 * status-derived `reason`, which keeps its meaning.
 */
export function setRequestTraceErrorCode(res: { locals?: Record<string, unknown> }, code: string, reasonClass?: RequestTraceReasonClass): void {
  if (!res.locals) return;
  res.locals[REQUEST_TRACE_ERROR_CODE_LOCAL] = code;
  if (reasonClass) res.locals[REQUEST_TRACE_REASON_CLASS_LOCAL] = reasonClass;
}

const REQUEST_TRACE_COMPUTER_TARGET_LOCAL = "traceComputerTarget";

/**
 * Name the Computer a request is waiting on (a model list, an option source),
 * recorded on server.http.request next to the route: its hashed id, versions,
 * runtime and option source.
 */
export function setRequestTraceComputerTarget(
  res: { locals?: Record<string, unknown> },
  target: { machineId: string; computerVersion?: string | null; daemonVersion?: string | null; runtime: string; sourceId?: string },
): void {
  if (!res.locals) return;
  // Hashed like server_id_hash: a raw Computer id never reaches a request span.
  const machineIdHash = traceMachineIdHash(target.machineId);
  res.locals[REQUEST_TRACE_COMPUTER_TARGET_LOCAL] = {
    ...(machineIdHash ? { target_machine_id_hash: machineIdHash } : {}),
    ...(target.computerVersion ? { target_computer_version: target.computerVersion } : {}),
    ...(target.daemonVersion ? { target_daemon_version: target.daemonVersion } : {}),
    target_runtime: target.runtime.slice(0, 64),
    ...(target.sourceId ? { option_source_id: target.sourceId.slice(0, 64) } : {}),
  };
}

function requestTraceComputerTargetAttrs(res: { locals?: Record<string, unknown> }): Record<string, string> {
  const target = res.locals?.[REQUEST_TRACE_COMPUTER_TARGET_LOCAL];
  return target && typeof target === "object" ? target as Record<string, string> : {};
}

const REQUEST_TRACE_COMPUTER_CALLER_LOCAL = "traceComputerCaller";
const TRACE_MIGRATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Name the Computer making a `/internal/computer/*` request once a route has
 * resolved its machine, and the migration the route names, so a flood of one
 * route splits by Computer and migration.
 */
export function setRequestTraceComputerCaller(
  res: { locals?: Record<string, unknown> },
  caller: { machineId: string; migrationId?: unknown },
): void {
  if (!res.locals) return;
  const machineIdHash = traceMachineIdHash(caller.machineId);
  const migrationId = typeof caller.migrationId === "string" && TRACE_MIGRATION_ID_RE.test(caller.migrationId)
    ? caller.migrationId.toLowerCase()
    : null;
  res.locals[REQUEST_TRACE_COMPUTER_CALLER_LOCAL] = {
    machine_id_present: true,
    ...(machineIdHash ? { machine_id_hash: machineIdHash } : {}),
    ...(migrationId ? { migration_id: migrationId } : {}),
  };
}

function requestTraceComputerCallerAttrs(res: { locals?: Record<string, unknown> }): Record<string, string | boolean> {
  const caller = res.locals?.[REQUEST_TRACE_COMPUTER_CALLER_LOCAL];
  return caller && typeof caller === "object" ? caller as Record<string, string | boolean> : {};
}

const REQUEST_TRACE_COMPUTER_PROBE_STATE_LOCAL = "traceComputerProbeState";

/**
 * How a read-only Computer probe (runtime models, option sources, skills) was
 * answered: `ok` (the Computer answered), `stale` (its cached last answer after
 * the wait budget) or `unavailable`. An enum only, never the payload.
 */
export function setRequestTraceComputerProbeState(
  res: { locals?: Record<string, unknown>; setHeader?: (name: string, value: string) => unknown; headersSent?: boolean },
  state: ComputerProbeTraceState,
): void {
  if (res.locals) res.locals[REQUEST_TRACE_COMPUTER_PROBE_STATE_LOCAL] = state;
  // A front replica that relays this answer records the same state on its own
  // request span (machineLocalReplay reads the header back).
  if (typeof res.setHeader === "function" && !res.headersSent) res.setHeader(COMPUTER_PROBE_STATE_HEADER, state);
}

export type ComputerProbeTraceState = "ok" | "stale" | "unavailable";

/** Response header carrying the probe state from the owner replica to a relaying front replica. */
export const COMPUTER_PROBE_STATE_HEADER = "x-raft-computer-probe-state";

/** The probe state an owner replica's relayed answer carried, if it is one of ours. */
export function computerProbeTraceStateOf(value: string | null | undefined): ComputerProbeTraceState | null {
  return value === "ok" || value === "stale" || value === "unavailable" ? value : null;
}

const REQUEST_TRACE_MACHINE_KEY_KIND_LOCAL = "traceMachineKeyKind";

export type MachineKeyTraceKind = "legacy_machine" | "computer";

/** Names the machine credential kind on this request's span (machine auth calls it). */
export function setRequestTraceMachineKeyKind(res: { locals?: Record<string, unknown> }, kind: MachineKeyTraceKind): void {
  if (res.locals) res.locals[REQUEST_TRACE_MACHINE_KEY_KIND_LOCAL] = kind;
}

function requestTraceMachineKeyKindAttrs(res: { locals?: Record<string, unknown> }): { machine_key_kind?: string } {
  const kind = res.locals?.[REQUEST_TRACE_MACHINE_KEY_KIND_LOCAL];
  return typeof kind === "string" ? { machine_key_kind: kind } : {};
}

const REQUEST_TRACE_ACTION_TYPE_LOCAL = "traceActionType";
const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set(ACTION_CARD_ACTION_TYPES);

/**
 * Names the action card type a prepare request asked for (task #proj-analytics
 * 42bee8a8: plan:upgrade attempts and why they were refused). A type Raft
 * doesn't know is `other`: what an agent typed is never written raw.
 */
export function setRequestTraceActionType(res: { locals?: Record<string, unknown> }, actionType: unknown): void {
  if (!res.locals || typeof actionType !== "string") return;
  // Trimmed as the body check reads it: " plan:upgrade " is still plan:upgrade.
  const type = actionType.trim();
  res.locals[REQUEST_TRACE_ACTION_TYPE_LOCAL] = KNOWN_ACTION_TYPES.has(type) ? type : "other";
}

const REQUEST_TRACE_RATE_LIMITER_LOCAL = "traceRateLimiter";

/** Names the limiter that refused this request (a fixed limiter name, never a key). */
export function setRequestTraceRateLimiter(res: { locals?: Record<string, unknown> }, limiter: string): void {
  if (res.locals) res.locals[REQUEST_TRACE_RATE_LIMITER_LOCAL] = limiter;
}

function requestTraceRateLimiterAttrs(res: { locals?: Record<string, unknown> }): { rate_limiter?: string } {
  const limiter = res.locals?.[REQUEST_TRACE_RATE_LIMITER_LOCAL];
  return typeof limiter === "string" ? { rate_limiter: limiter } : {};
}

const REQUEST_TRACE_LIMIT_SIDE_LOCAL = "traceLimitSide";

/**
 * Names whose limit refused this request, next to its error_code: the
 * channel's host server or the connecting one (an external channel's and a
 * joint's limit refusals, #wg-rbac:#60). A side, never a server.
 */
export function setRequestTraceLimitSide(res: { locals?: Record<string, unknown> }, limitSide: "host" | "connecting"): void {
  if (res.locals) res.locals[REQUEST_TRACE_LIMIT_SIDE_LOCAL] = limitSide;
}

function requestTraceLimitSideAttrs(res: { locals?: Record<string, unknown> }): { limit_side?: string } {
  const side = res.locals?.[REQUEST_TRACE_LIMIT_SIDE_LOCAL];
  return side === "host" || side === "connecting" ? { limit_side: side } : {};
}

const REQUEST_TRACE_REFUSED_CODES_LOCAL = "traceRefusedCodes";

/**
 * The codes of the servers a multi-connect refused (each server's answer is in
 * its 200 body, so the span has no error_code): distinct, sorted, comma
 * separated, e.g. "free_external_limit,invalid_server". Codes only, never a
 * server. Nothing set when none was refused.
 */
export function setRequestTraceRefusedCodes(res: { locals?: Record<string, unknown> }, codes: readonly string[]): void {
  if (!res.locals || codes.length === 0) return;
  res.locals[REQUEST_TRACE_REFUSED_CODES_LOCAL] = [...new Set(codes)].sort().join(",");
}

function requestTraceRefusedCodesAttrs(res: { locals?: Record<string, unknown> }): { refused_codes?: string } {
  const codes = res.locals?.[REQUEST_TRACE_REFUSED_CODES_LOCAL];
  return typeof codes === "string" ? { refused_codes: codes } : {};
}

function requestTraceActionTypeAttrs(res: { locals?: Record<string, unknown> }): { action_type?: string } {
  const type = res.locals?.[REQUEST_TRACE_ACTION_TYPE_LOCAL];
  return typeof type === "string" ? { action_type: type } : {};
}

function requestTraceComputerProbeStateAttrs(res: { locals?: Record<string, unknown> }): { computer_probe_state?: string } {
  const state = res.locals?.[REQUEST_TRACE_COMPUTER_PROBE_STATE_LOCAL];
  return typeof state === "string" ? { computer_probe_state: state } : {};
}

/** The code a route already set (setRequestTraceErrorCode), if any. */
export function requestTraceErrorCode(res: { locals?: Record<string, unknown> }): string | null {
  const code = res.locals?.[REQUEST_TRACE_ERROR_CODE_LOCAL];
  return typeof code === "string" && code ? code : null;
}

function requestTraceErrorCodeAttrs(res: { locals?: Record<string, unknown> }): { error_code?: string; reason_class?: string } {
  const code = requestTraceErrorCode(res);
  const reasonClass = res.locals?.[REQUEST_TRACE_REASON_CLASS_LOCAL];
  return {
    ...(code ? { error_code: code } : {}),
    ...(typeof reasonClass === "string" && reasonClass ? { reason_class: reasonClass } : {}),
  };
}

const CLIENT_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const CLIENT_VERSION = /^v?\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.+-]{1,48})?$/;
/** The native Apps, which name their version in the User-Agent (`Raft/<version>+<build>`) rather than a header. */
const APP_PLATFORMS: ReadonlySet<string> = new Set(["ios", "android", "harmonyos"]);

/** Every request: what sent it, as a fixed class of its User-Agent (publicRequester.ts), never the raw value. */
export function userAgentClassAttrs(req: Pick<Request, "header">): TraceAttributes {
  return { user_agent_class: classifyRequesterUserAgent(req.header?.("user-agent")) };
}

/** Only on /api/public/* (signed-out routes): who asked, as a class (publicRequester.ts). */
function publicRequesterAttrs(req: Pick<Request, "originalUrl" | "header">): TraceAttributes {
  const path = ((req.originalUrl ?? "").split("?")[0] ?? "").toLowerCase(); // Express matches paths case-insensitively
  if (!path.startsWith("/api/public/")) return {};
  return { public_requester: classifyPublicRequester(req.header?.("user-agent")) };
}

/**
 * What the caller says it is (task #15 in #proj-analytics), from its headers:
 * `X-Raft-Client` (`cli`, `daemon`, ...; older CLIs and daemons send
 * `X-Slock-Client`), `X-Raft-Client-Platform` (web and Apps),
 * `X-Raft-Client-Version` (the version of the code that sent it: the CLI's,
 * the web build's, which in the desktop app is the desktop release's; an
 * App's comes from its `Raft/<version>` User-Agent), and from the daemon's
 * agent proxy the Computer, daemon and runtime the agent runs on. These are claims, not checked
 * identity: they split traces, never steer access. A value that is not a short
 * name or a version is dropped, never written raw.
 */
export function requestClientAttrs(req: Pick<Request, "header">): TraceAttributes {
  const attrs: TraceAttributes = {};
  const read = (key: string, header: string, valid: (value: string) => boolean) => {
    const value = req.header?.(header)?.trim();
    if (value && valid(value)) attrs[key] = value;
  };
  const name = (value: string) => CLIENT_NAME.test(value);
  const version = (value: string) => CLIENT_VERSION.test(value);
  read("client_kind", req.header?.("x-raft-client") ? "x-raft-client" : "x-slock-client", name);
  read("client_platform", "x-raft-client-platform", (value) => CLIENT_PLATFORM_HEADER_VALUES.has(value));
  read("client_version", RAFT_CLIENT_VERSION_HEADER, version);
  if (!attrs.client_version && typeof attrs.client_platform === "string" && APP_PLATFORMS.has(attrs.client_platform)) {
    const appVersion = raftVersionFromUserAgent(req.header?.("user-agent"));
    if (appVersion && version(appVersion)) attrs.client_version = appVersion;
  }
  read("client_computer_version", RAFT_COMPUTER_VERSION_HEADER, version);
  read("client_daemon_version", RAFT_DAEMON_VERSION_HEADER, version);
  read("client_runtime", RAFT_RUNTIME_HEADER, name);
  // Set by the daemon's agent proxy for a call through the agent's stable CLI
  // entry (#proj-raft-computer:#58) rather than its launch's own wrapper.
  read("via", RAFT_CLI_ENTRY_HEADER, (value) => value === RAFT_CLI_STABLE_ENTRY);
  return attrs;
}

// Only the daemon's agent proxy and its managed MCP tools stamp this on
// sk_agent_* calls (the CLI only does so with a daemon-provided context).
const DAEMON_AGENT_CAPABILITIES_HEADER = "x-slock-agent-active-capabilities";

export type TraceParentPolicy = "continued" | "linked" | "absent";

interface InboundTraceParent {
  policy: TraceParentPolicy;
  parent: TraceContext | null;
  /** A traceparent header was sent but is not a valid W3C traceparent. */
  invalid: boolean;
  /** The caller presented the daemon marker on an sk_agent_* credential. */
  daemonClaimed: boolean;
}

/**
 * Credentials an outside client holds itself: an agent credential not sent
 * through the daemon (external runtime agents), a third-party app's OAuth
 * access token, a share token. Their traceparent is the client's own business:
 * one long-lived client span reused on every poll would otherwise fold
 * thousands of unrelated requests into a single trace, so the request starts a
 * new trace and only records the client's context.
 *
 * The decision has to be made before auth: the request span is already the
 * parent of auth's own spans. The daemon marker is a header, so it can be
 * forged; it only steers which trace a request lands in, never access, and
 * after auth a forged claim is flagged (trace_parent_claim_mismatch).
 */
function isExternalClientCredential(req: Request): { external: boolean; daemonClaimed: boolean } {
  const authorization = req.header?.("authorization");
  if (!authorization?.startsWith("Bearer ")) return { external: false, daemonClaimed: false };
  const token = authorization.slice(7);
  if (token.startsWith("sk_agent_")) {
    const daemonClaimed = Boolean(req.header?.(DAEMON_AGENT_CAPABILITIES_HEADER)?.trim());
    return { external: !daemonClaimed, daemonClaimed };
  }
  return { external: token.startsWith("slock_at_") || token.startsWith("raft_share_"), daemonClaimed: false };
}

function inboundTraceParent(req: Request): InboundTraceParent {
  const header = req.header?.("traceparent");
  const parent = parseTraceparent(header);
  const invalid = Boolean(header) && !parent;
  const { external, daemonClaimed } = isExternalClientCredential(req);
  if (!parent) return { policy: "absent", parent: null, invalid, daemonClaimed };
  if (external) return { policy: "linked", parent, invalid, daemonClaimed };
  return { policy: "continued", parent, invalid, daemonClaimed };
}

function traceParentAttrs(req: Request, inbound: InboundTraceParent): TraceAttributes {
  return {
    trace_parent_policy: inbound.policy,
    ...(inbound.policy === "linked" && inbound.parent
      ? { client_trace_id: inbound.parent.traceId, client_parent_span_id: inbound.parent.spanId }
      : {}),
    ...(inbound.invalid ? { client_traceparent_invalid: true } : {}),
    ...(inbound.daemonClaimed && req.actingAgentIsExternal ? { trace_parent_claim_mismatch: true } : {}),
  };
}

/** Response header carrying the request's trace id (see requestObservabilityMiddleware). */
export const TRACE_ID_RESPONSE_HEADER = "X-Trace-Id";

export function requestObservabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const endTimer = httpRequestDuration.startTimer();
  const baseTracer = (req.app?.get?.("serverTracer") as Tracer | undefined) ?? noopTracer;
  const tracer = createTraceScopeTracer(baseTracer, buildInitialRequestTraceScope(req), {
    spanAttrContracts: HTTP_REQUEST_TRACE_ATTR_CONTRACTS,
    scopeAttrPrecedence: "caller",
  });
  const inbound = inboundTraceParent(req);
  const clientAttrs = requestClientAttrs(req);
  const span = tracer.startSpan("server.http.request", {
    parent: inbound.policy === "continued" ? inbound.parent : null,
    surface: "server",
    kind: "server",
  });
  // The request's trace id goes back to the caller, so an error the web app shows can carry an id a
  // user can send us (#proj-o11y:#18). Same header and shape as the one sent to Hands
  // (handsTraceHeaders.ts): 32 lowercase hex, and nothing for a no-op or malformed trace.
  const responseTraceId = span.context?.traceId;
  if (responseTraceId && /^[0-9a-f]{32}$/.test(responseTraceId) && !/^0+$/.test(responseTraceId) && !res.headersSent) {
    res.setHeader?.(TRACE_ID_RESPONSE_HEADER, responseTraceId);
  }
  let spanEnded = false;
  const endHttpSpan = (
    eventName: "http.response.finished" | "http.response.closed",
    status: TraceStatus,
    recordMetrics: boolean,
  ) => {
    if (spanEnded) return;
    spanEnded = true;
    const routePattern = normalizeObservedRoutePattern(req);
    const callerKind = inferHttpCallerKind(req, routePattern);
    const agentIdPresent = hasAgentIdHint(req, routePattern);
    const requestScopeAttrs = {
      ...projectTraceScopeAttrs(buildRequestTraceScope(req, routePattern, callerKind, agentIdPresent)),
      ...projectAuthTraceIdentityAttrs(req),
      ...agentIdHashAttrs(traceAgentIdOf(req)),
      ...claimedAgentIdHashAttrs(req, res.statusCode),
      ...serverIdHashAttrs(req.serverId),
      ...requestTraceUserIdAttrs(req),
      ...requestTraceErrorCodeAttrs(res),
      ...requestTraceComputerTargetAttrs(res),
      ...requestTraceComputerCallerAttrs(res),
      ...requestTraceComputerProbeStateAttrs(res),
      ...requestTraceMachineKeyKindAttrs(res),
      ...requestTraceActionTypeAttrs(res),
      ...requestTraceRateLimiterAttrs(res),
      ...requestTraceLimitSideAttrs(res),
      ...requestTraceRefusedCodesAttrs(res),
      ...clientAttrs,
      ...publicRequesterAttrs(req),
      ...userAgentClassAttrs(req),
      ...clientIpHashAttrs(req),
      ...unmatchedPrefixAttrs(req, routePattern, res.statusCode),
    };
    const labels = {
      route_pattern: routePattern,
      method: req.method,
      status_bucket: bucketHttpStatus(res.statusCode),
    };
    const outcome = eventName === "http.response.closed" ? "cancelled" : httpOutcomeForStatus(res.statusCode);
    const reason = eventName === "http.response.closed" ? "response_closed" : httpReasonForStatusBucket(labels.status_bucket);
    if (recordMetrics) {
      httpRequestsTotal.labels(labels.route_pattern, labels.method, labels.status_bucket).inc();
      endTimer(labels);
    }
    span.addEvent(eventName, {
      event_kind: "http_request",
      outcome,
      reason,
      "http.route": labels.route_pattern,
      "http.request.method": labels.method,
      status_bucket: labels.status_bucket,
      "http.response.status_code": res.statusCode,
      ...requestScopeAttrs,
    });
    span.end(status, {
      attrs: {
        event_kind: "http_request",
        outcome,
        reason,
        "http.route": labels.route_pattern,
        "http.request.method": labels.method,
        status_bucket: labels.status_bucket,
        status_code: res.statusCode,
        "http.response.status_code": res.statusCode,
        ...requestScopeAttrs,
        ...traceParentAttrs(req, inbound),
      },
    });
  };

  res.on("finish", () => {
    endHttpSpan("http.response.finished", toTraceStatus(res.statusCode), true);
  });

  res.on("close", () => {
    if (res.writableEnded) return;
    endHttpSpan("http.response.closed", "cancelled", false);
  });

  runWithTraceSpan(span, next, tracer);
}

const SAFE_PATH_SEGMENT = /^(?:[a-z][a-z_-]{0,39}|v\d{1,3})$/i;

/**
 * A 5xx that matched no route says nothing about where it came from: this names
 * the first three path segments. Anything that could be an id or other caller
 * input (digits, encoded bytes, a long value) is recorded as `*`.
 */
function unmatchedPrefixAttrs(
  req: Request,
  routePattern: string,
  statusCode: number,
): { unmatched_prefix?: string } {
  if (routePattern !== "unmatched" || statusCode < 500) return {};
  const path = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
  const segments = path.split("/").filter(Boolean).slice(0, 3);
  return { unmatched_prefix: `/${segments.map((segment) => (SAFE_PATH_SEGMENT.test(segment) ? segment : "*")).join("/")}` };
}

function projectAuthTraceIdentityAttrs(req: Request): TraceAttributes {
  const identity = req.authTraceIdentity;
  if (!identity) return {};
  return {
    auth_trace_source: identity.source,
    ...(identity.reason ? { auth_trace_reason: identity.reason } : {}),
  };
}

function toTraceStatus(statusCode: number): TraceStatus {
  return statusCode >= 500 ? "error" : "ok";
}

/**
 * Every authenticated request names its user as the random trace_user_id, not
 * only the auth routes (whose raw user_id the export sink rewrites). The raw id
 * never enters the span: the value comes from the cache that this request's
 * auth check already filled (verifyActiveAccessToken), so it is a synchronous
 * hit. Lets per-user questions (e.g. one user's followed threads staying
 * incomplete across requests) be answered from traces.
 */
function requestTraceUserIdAttrs(req: Request): { trace_user_id?: string } {
  if (req.authTraceIdentity?.userId || !req.userId) return {};
  const traceUserId = cachedTraceUserId(req.userId);
  return traceUserId ? { trace_user_id: traceUserId } : {};
}
