import { AgentProxyBindError } from "./spawnFailureErrors";
import { fetchUsesHttpProxy } from "./proxy";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import {
  AGENT_API_EVENTS_ACK_HEADER,
  AGENT_API_EVENTS_ACK_LEASE,
  agentInboxAppItemDismissTarget,
  agentApiHistoryConsumptionScopeSchema,
  type AgentApiHistoryConsumptionScope,
  type AgentApiInboxDismissResponse,
  errorClassOf,
  isThirdPartyEventId,
  normalizeThirdPartyEventId,
  formatTraceparent,
  noopTracer,
  parseAgentApiAppSourceAckReject,
  parseTraceparent,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  RAFT_COMPUTER_VERSION_HEADER,
  RAFT_DAEMON_VERSION_HEADER,
  RAFT_RUNTIME_HEADER,
  RAFT_CLI_ENTRY_HEADER,
  RAFT_CLI_STABLE_ENTRY,
  PROC_CAPABILITY,
  sourceRefIdentityKey,
  type ActiveSpan,
  type AgentInboxSourceRef,
  type AgentMessage,
  type TraceStatus,
  type Tracer,
  AGENT_GATED_WRITES,
  agentGatedWriteForPath,
  agentWriteLandingTarget,
  agentWriteSourceMessageId,
  agentTaskWriteKey,
  formatAgentTaskRef,
  type AgentGatedWriteAction,
} from "@botiverse/raft-shared";
import type { ApmHeldFreshnessEnvelopeBody } from "./apmStateMachine";
import {
  maxInboxMessageSeq,
  normalizeInboxVisibleMessages,
  planAgentInboxSideEffect,
  sortInboxMessagesBySeq,
  type AgentInboxStateMachineEffect,
} from "./agentInboxStateMachine";
import { projectAgentInboxSnapshot, projectAgentInboxSnapshotWithoutAppItems } from "./agentInboxProjection";
import { formatProxyVisibleMessageTarget } from "./agentVisibleDeliveryLedger";
import type { AgentInboxTargetRow } from "./agentInboxProjection";
import type { AgentAppInboxStore } from "./agentAppInbox";
import { daemonFetch, type DaemonFetchOptions } from "./daemonFetch";
import { logger } from "./logger";
import { REMINDER_SERVER_ACK_CAPABILITY } from "./reminderServerAck";
import { handleProcRequest, type ProcJobManager } from "./procJobs";
import {
  __resetRetiredLaunchesForTest,
  agentNotRunningRefusal,
  launchSupersededRefusal,
  rememberRetiredLaunch,
  retiredLaunchForToken,
  stableEntryAgentMismatchRefusal,
  type LocalProxyRefusal,
} from "./agentProxyLaunchLifecycle";
import {
  createThirdPartyEventDeliveryReporter,
  thirdPartyEventIdsFromEvents,
} from "./thirdPartyEventDeliveryReporter";

type ProxyRegistration = {
  serverUrl: string;
  apiKey: string;
  agentId: string;
  launchId: string | null;
  activeCapabilities: string;
  inboxCoordinator?: AgentProxyInboxCoordinator;
  /** For a launch with no coordinator (the OAR host): `recordMessageCommitted`, on its own. */
  recordMessageCommitted?: AgentProxyInboxCoordinator["recordMessageCommitted"];
  /** For a launch with no coordinator (the OAR host): `recordSendOutcome`, on its own. */
  recordSendOutcome?: AgentProxyInboxCoordinator["recordSendOutcome"];
  /** Phase 1 typed app Inbox store (Computer-local). Optional for legacy tests. */
  appInbox?: AgentAppInboxStore;
  tracer: Tracer;
  daemonVersion: string | null;
  computerVersion: string | null;
  /** The agent's runtime (`claude`, `codex`, ...), named on every forwarded request. */
  runtime: string | null;
  /** Task #178: third-party events served under lease, keyed by batch id. Lives with the registration, so a relaunch voids them. */
  thirdPartyLeases?: Map<string, ThirdPartyEventLease>;
  /** RFC 081: the agent's current `AgentConfig.inboxItems`, read at each `inbox check`. Absent: off. */
  inboxItems?: () => boolean;
  /** The agent's stable entry wrapper this launch wrote, named when the launch's transport is used after it ended. */
  stableEntryPath: string | null;
};



// Task #178 — serve = lease, ack = consume + report. A leased event stays in
// the Local Inbox: a later /events re-serves it under a new batch (voiding the
// old one) and an expired lease simply rejects a late ack. Leases live only in
// memory: a daemon restart means "never acked" and the server re-pushes.
type ThirdPartyEventLease = {
  batchId: string;
  eventIds: Set<string>;
  messages: AgentProxyVisibleMessage[];
  expiresAt: number;
  timer: NodeJS.Timeout;
};
const THIRD_PARTY_EVENT_LEASE_MS = 60_000;
let thirdPartyEventLeaseMs = THIRD_PARTY_EVENT_LEASE_MS;
export function __setThirdPartyEventLeaseMsForTest(ms: number | undefined): void {
  thirdPartyEventLeaseMs = ms ?? THIRD_PARTY_EVENT_LEASE_MS;
}

function thirdPartyEventIdOf(message: unknown): string | null {
  const id = (message as { third_party_event?: { id?: unknown } | null } | null)?.third_party_event?.id;
  return isThirdPartyEventId(id) ? normalizeThirdPartyEventId(id) : null;
}

function voidThirdPartyLeasesCovering(registration: ProxyRegistration, eventIds: Iterable<string>): void {
  const leases = registration.thirdPartyLeases;
  if (!leases) return;
  const ids = new Set(eventIds);
  for (const [batchId, lease] of leases) {
    for (const id of lease.eventIds) {
      if (ids.has(id)) {
        clearTimeout(lease.timer);
        leases.delete(batchId);
        break;
      }
    }
  }
}

function leaseThirdPartyEvents(
  registration: ProxyRegistration,
  messages: AgentProxyVisibleMessage[],
): { batch_id: string; event_ids: string[]; expires_at: string } {
  const leases = (registration.thirdPartyLeases ??= new Map());
  const eventIds = new Set<string>();
  for (const message of messages) {
    const id = thirdPartyEventIdOf(message);
    if (id) eventIds.add(id);
  }
  voidThirdPartyLeasesCovering(registration, eventIds);
  const batchId = randomUUID();
  const expiresAt = Date.now() + thirdPartyEventLeaseMs;
  const timer = setTimeout(() => {
    leases.delete(batchId);
  }, thirdPartyEventLeaseMs);
  timer.unref?.();
  leases.set(batchId, { batchId, eventIds, messages, expiresAt, timer });
  return { batch_id: batchId, event_ids: [...eventIds], expires_at: new Date(expiresAt).toISOString() };
}

function clearThirdPartyLeases(registration: ProxyRegistration): void {
  for (const lease of registration.thirdPartyLeases?.values() ?? []) clearTimeout(lease.timer);
  registration.thirdPartyLeases?.clear();
}

type ProxyHandle = {
  proxyUrl: string;
  proxyToken: string;
  /** Settles when this registration's server-ack backfill run ends (tests await it). */
  serverAckBackfill?: Promise<void>;
};

type ProxyServerState = {
  server: http.Server;
  proxyUrl: string;
};

type ProxyServerFactory = (handler: http.RequestListener) => http.Server;

type AppSourceAckAcceptedResponse = {
  ok: true;
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  ackAttemptId: string;
};

export type AgentProxyVisibleMessage = {
  third_party_event?: Pick<NonNullable<AgentMessage["third_party_event"]>, "id">;
  seq?: number;
  id?: string;
  message_id?: string;
  channel_id?: string;
  channelId?: string;
  sender_id?: string;
  senderId?: string;
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  /** The parent channel of a thread message, when the server sends it (#proj-raft-computer:#27). */
  parent_channel_id?: string;
  /** Task v2: the message is in this task's own conversation (target = task ref). */
  task_conversation_number?: number;
  sender_type?: string;
  sender_name?: string;
  sender_description?: string | null;
  sender_timezone?: string | null;
  senderType?: string;
  senderName?: string;
  senderDescription?: string | null;
  senderTimezone?: string | null;
  content?: string;
  timestamp?: string;
  createdAt?: string;
};

export type AgentProxyInboxCoordinator = {
  getBoundary(target: string): number | undefined;
  getPendingMessages(target: string): AgentProxyVisibleMessage[];
  isMessageModelSeen?(input: { target: string; message: AgentProxyVisibleMessage }): boolean;
  /** Exact model-seen seqs for a target, ascending (task #360); merged into a send's `seenExactSeqs`. */
  getExactSeenSeqs?(target: string): number[];
  /** The id of the model context the agent is in now (new on compaction), or null when none was published. */
  getContextId?(): string | null;
  /**
   * Local Inbox contract for daemon-managed runners:
   * `/internal/agent-api/events` and `slock message check` MUST drain this
   * daemon-local queue before asking the remote server for events. The server
   * `/events` endpoint is a sync/repair fallback after local pending is empty,
   * not the primary source while the daemon has already accepted delivery.
   */
  getAllPendingMessages?(): AgentProxyVisibleMessage[];
  recordInboxSnapshot?(input: AgentProxyInboxProjectionTraceInput): void;
  consumeVisibleMessages(input: {
    historyScope?: AgentApiHistoryConsumptionScope;
    target?: string;
    messages: AgentProxyVisibleMessage[];
    boundarySeq?: number;
    source: "server_held_context" | "agent_api_events_local" | "agent_api_events_server" | "agent_api_history" | "agent_api_inbox_read" | "agent_api_send_commit" | "side_effect_preflight_context";
    /** Telemetry only: size of the response body the messages came from. */
    responseBytes?: number;
  }): void;
  /**
   * A held task write's context reached the model: the Server's
   * `seenUpToSeq` covers `target` for that same write's rerun only
   * (`writeKey`, agentTaskWriteKey), never for another write, a send or
   * delivery (agentVisibleDeliveryLedger recordHeldWriteSpan).
   */
  recordHeldWriteSpan?(input: { target: string; writeKey: string; seenUpToSeq: number }): void;
  /** What a hold of this same write booked, in the model's current context (recordHeldWriteSpan). */
  getHeldWriteSpan?(input: { target: string; writeKey: string }): number | undefined;
  /**
   * The thread under `parentTarget` the model saw message `messageId` in,
   * when it is a reply there (not the thread of its own): where a task
   * created from it lands.
   */
  getThreadTargetOfMessage?(input: { parentTarget: string; messageId: string }): string | undefined;
  recordFreshnessDecision?(input: AgentProxyFreshnessDecision): void;
  /** What the Server said about a forwarded message send: accepted (with its id) or held as a draft. */
  recordSendOutcome?(input: { state: "sent"; messageId?: string } | { state: "held" }): void;
  /**
   * The Server accepted a message the agent sent (a 2xx `sent` or reconciled
   * `committed` answer with its id), by `raft message send` or `raft task
   * reply`. View Context indexes it; must not throw or block.
   */
  recordMessageCommitted?(input: { messageId: string; route: "send" | "task_reply" }): void;
  recordDrainOutcome?(input: AgentProxyDrainOutcome): void;
  recordProxyFailure?(input: AgentProxyFailure): void;
  recordTransportNormalizedError?(input: AgentProxyTransportNormalizedError): void;
};

export type AgentProxyInboxProjectionTraceInput = {
  source: "agent_api_inbox_check";
  rows: AgentInboxTargetRow[];
  pendingMessageCount: number;
};

export type AgentProxyFreshnessAction = AgentGatedWriteAction;

export type AgentProxyFreshnessDecision = {
  action: AgentProxyFreshnessAction;
  decision: "local_hold" | "syncing_hold" | "forward" | "bypass";
  freshnessContextMode?: "inline" | "withheld";
  producerFactId?: string;
  target?: string;
  inboxTrustState: "trusted" | "untrusted";
  reason: string;
  pendingCount?: number;
  pendingMaxSeq?: number;
  modelSeenSeq?: number;
  heldMessageCount?: number;
  omittedMessageCount?: number;
};

export type AgentProxyDrainOutcome = {
  /** `daemon_pending` is Local Inbox served directly; `server_events` is the remote fallback after Local Inbox is empty. */
  source: "daemon_pending" | "server_events";
  sinceCursorKind: "latest" | "seq" | null;
  notifiedCount: number;
  drainedCount: number;
  hasMore?: boolean;
};

export type AgentProxyFailure = {
  method: string;
  pathname: string;
  queryKeys: string[];
  correlationId?: string;
  errorName: string;
  errorMessage: string;
  errorCause?: string;
  routeFamily?: AgentProxyTransportRouteFamily;
  failureClass?: AgentProxyFailureClass;
  responseStarted?: boolean;
  responseComplete?: boolean;
  causeCode?: string;
  upstreamLayer?: AgentProxyTransportNormalizedError["upstreamLayer"];
  upstreamStatus?: number;
  launchId?: string | null;
  targetHostClass?: AgentProxyTransportNormalizedError["targetHostClass"];
  downstreamCaller?: AgentProxyTransportNormalizedError["downstreamCaller"];
  upstream?: AgentProxyTransportNormalizedError["upstream"];
  responseStatusCode?: number;
  responseCode?: string;
  responseError?: string;
  suggestedNextAction?: string;
  lifecycleInvalidAgentId?: string;
  lifecycleInvalidContext?: string;
};

export type AgentProxyFailureClass =
  | "pre_response_transport"
  | "mid_response_transport"
  | "post_response_local"
  | "upstream_http_response";

export type AgentProxyTransportRouteFamily =
  | "action/prepare"
  | "agent-api/attachments"
  | "agent-api/attachments/comments"
  | "agent-api/events"
  | "agent-api/inbox"
  | "agent-api/messages/resolve"
  | "agent-api/messages/reactions"
  | "agent-api/send"
  | "attachments/download"
  | "attachments/upload"
  | "channel-members"
  | "channels/join"
  | "channels/leave"
  | "integrations"
  | "knowledge"
  | "proc"
  | "profile"
  | "reminders"
  | "runtime-version"
  | "resolve-channel"
  | "server"
  | "tasks"
  | "tasks/claim"
  | "tasks/update"
  | "threads"
  | "threads/unfollow"
  | "unknown";

export type AgentProxyTransportNormalizedError = {
  normalizedCode: "transport_failure" | "server_5xx" | "local_daemon_state_invalid" | "local_post_response_failure";
  routeFamily: AgentProxyTransportRouteFamily;
  /**
   * Same byte meaning as daemon.proxy.failed: true after any upstream
   * response bytes were observed; false for connect/early transport failures.
   */
  responseStarted: boolean;
  responseComplete: boolean;
  failureClass: AgentProxyFailureClass;
  causeCode: string;
  upstreamLayer:
    | "dns"
    | "tcp"
    | "tls"
    | "fly_edge"
    | "http_status"
    | "read_timeout"
    | "body_decode_failure"
    | "proxy_connect"
    | "unknown";
  upstreamStatus?: number;
  originalMessage?: string;
  launchId?: string | null;
  targetHostClass: "api.slock.ai" | "api.raft.build" | "custom_server" | "local_daemon";
  /** The upstream fetch went through an HTTP proxy from the env (#47: tells proxy failures from direct ones). */
  viaHttpProxy?: boolean;
  /** Addresses Node tried before the connect failed (autoSelectFamily), and how many of them timed out. */
  connectAttemptedAddresses?: number;
  connectTimedOutAddresses?: number;
  downstreamCaller: "cli" | "runtime" | "daemon_internal";
  upstream: "server" | "local_daemon";
};

const registrations = new Map<string, ProxyRegistration>();

/**
 * `raft proc` (procJobs.ts): the daemon's job manager, set once the machine
 * dir is known on a platform that runs jobs (not Windows in v1). While it is
 * set the proxy declares `proc@1`; proc routes are never forwarded to the
 * Server, set or not.
 */
let procJobManager: ProcJobManager | null = null;

export function setAgentProcJobManager(manager: ProcJobManager | null): void {
  procJobManager = manager;
}

/** What this daemon runs for its agents, as `runtime-version` and the proc routes name it. */
function daemonRunCapabilities(): string[] {
  return procJobManager ? [PROC_CAPABILITY] : [];
}

function isProcPath(pathname: string): boolean {
  return pathname === "/internal/agent-api/proc" || pathname.startsWith("/internal/agent-api/proc/");
}

const THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS = 5_000;
let thirdPartyEventDeliveryReportRetryBaseMs = THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS;
const thirdPartyEventDeliveryReporter = createThirdPartyEventDeliveryReporter({
  // The agent's newest registration: a relaunch replaces the runner credential.
  resolveTarget: (agentId) => {
    let latest: ProxyRegistration | null = null;
    for (const registration of registrations.values()) {
      if (registration.agentId === agentId) latest = registration;
    }
    return latest ? { serverUrl: latest.serverUrl, apiKey: latest.apiKey } : null;
  },
  fetch: (url, init) => daemonFetch(url, init, process.env, { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY }),
  retryBaseMs: () => thirdPartyEventDeliveryReportRetryBaseMs,
  onOutcome: (outcome) => {
    if (outcome.outcome === "reported") return;
    logger.warn(
      `[Agent ${outcome.agentId}] Third-party event delivery report ${outcome.outcome} (events=${outcome.eventCount}, pending=${outcome.pendingCount}${outcome.httpStatus ? `, http=${outcome.httpStatus}` : ""})`,
    );
  },
});

/**
 * Report third-party events whose body the daemon handed to the model outside
 * this proxy (a start's first prompt). Same reporter, retries and target as the
 * `/events` and lease-ack reports. An agent with no proxy registration has no
 * credential to report with, so nothing is attempted (a report would only
 * retry until dropped); the event stays `delivering` and is re-delivered.
 * Returns whether the report was handed to the reporter.
 */
export function reportThirdPartyEventsDelivered(agentId: string, eventIds: readonly string[]): boolean {
  let registered = false;
  for (const registration of registrations.values()) {
    if (registration.agentId === agentId) registered = true;
  }
  if (!registered) return false;
  thirdPartyEventDeliveryReporter.report(agentId, eventIds);
  return true;
}

/**
 * `raft message read --target agent-event:<id>` re-reads one event through
 * `/history` (task #257), and the response carries its body. Only a read that
 * consumes counts: `consume=false` is for output that may never reach the model.
 */
function isAgentEventHistoryRead(method: string, target: URL): boolean {
  return method === "GET"
    && target.pathname === "/internal/agent-api/history"
    && /^agent-event:/i.test(target.searchParams.get("channel")?.trim() ?? "")
    && target.searchParams.get("consume") !== "false";
}

function thirdPartyEventIdsFromHistoryResponse(responseText: string): string[] {
  try {
    const messages = (JSON.parse(responseText) as { messages?: unknown } | null)?.messages;
    return Array.isArray(messages) ? thirdPartyEventIdsFromEvents(messages) : [];
  } catch {
    return [];
  }
}
let proxyServerState: ProxyServerState | null = null;
let proxyServerStartPromise: Promise<ProxyServerState> | null = null;
let proxyServerFactory: ProxyServerFactory = createProxyServer;
const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Undici is supposed to decode compressed upstream bodies transparently, but
 * that does not hold on every Node build (observed on the Node 26 SEA
 * binaries with an upstream that compresses regardless of accept-encoding).
 * When it fails, responseHeadersForLocalProxy has already stripped
 * content-encoding per the decoded-forwarding contract, so the CLI receives
 * headerless gzip — the 2026-09-10 "INVALID_JSON_RESPONSE / empty body"
 * fleet incident. Decode here by sniffing: a declared encoding whose magic
 * bytes are still present means undici did NOT decode; anything else passes
 * through untouched, so an already-decoded body is never double-inflated.
 */
async function decodedUpstreamBuffer(
  upstream: Response,
  onDecodeFailed: (encoding: string) => void,
): Promise<Buffer> {
  const raw = Buffer.from(await upstream.arrayBuffer());
  const encoding = (upstream.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return raw;
  try {
    if ((encoding === "gzip" || encoding === "x-gzip") && raw.subarray(0, 2).equals(GZIP_MAGIC)) return gunzipSync(raw);
    if (encoding === "deflate") return inflateSync(raw);
    if (encoding === "br") return brotliDecompressSync(raw);
  } catch {
    // Usually an already-decoded body under a stale header (harmless). If it
    // was really encoded, the CLI gets unreadable bytes, so make it countable.
    onDecodeFailed(encoding);
    return raw;
  }
  return raw;
}
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const LOCAL_HELD_CONTEXT_LIMIT = 3;
const AGENT_CREDENTIAL_PROXY_HOST = "127.0.0.1";
const AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS = 3;
const AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY = "agent-credential-proxy";
const AGENT_CREDENTIAL_PROXY_UPLOAD_FETCH_ISOLATION_KEY = "agent-credential-proxy:attachment-upload";
const DEFAULT_AGENT_CREDENTIAL_PROXY_UPLOAD_HEADERS_TIMEOUT_MS = 5 * 60_000;

function attachmentUploadHeadersTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AGENT_CREDENTIAL_PROXY_UPLOAD_HEADERS_TIMEOUT_MS;
}

function agentCredentialProxyFetchOptions(
  pathname: string,
  env: NodeJS.ProcessEnv,
): DaemonFetchOptions {
  if (pathname === "/internal/agent-api/upload") {
    return {
      isolationKey: AGENT_CREDENTIAL_PROXY_UPLOAD_FETCH_ISOLATION_KEY,
      headersTimeoutMs: attachmentUploadHeadersTimeoutMs(env),
    };
  }
  return { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY };
}

function shouldRelayAgentAttachmentRedirect(pathname: string): boolean {
  return /^\/internal\/agent-api\/attachments\/[^/]+$/.test(pathname);
}

export function __setThirdPartyEventDeliveryReportRetryBaseMsForTest(ms: number | undefined): void {
  thirdPartyEventDeliveryReportRetryBaseMs = ms ?? THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS;
}

export function __agentCredentialProxyFetchOptionsForTest(
  pathname: string,
  env: NodeJS.ProcessEnv,
): DaemonFetchOptions {
  return agentCredentialProxyFetchOptions(pathname, env);
}

function createProxyRequestHandler(): http.RequestListener {
  return (req, res) => {
    void handleProxyRequest(req, res);
  };
}

function createProxyServer(handler: http.RequestListener): http.Server {
  return http.createServer(handler);
}

function listenOnLoopback(server: http.Server): Promise<ProxyServerState> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== "number") {
        reject(new Error("local proxy listen succeeded without a TCP port"));
        return;
      }
      resolve({
        server,
        proxyUrl: `http://${AGENT_CREDENTIAL_PROXY_HOST}:${address.port}`,
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, AGENT_CREDENTIAL_PROXY_HOST);
  });
}

function closeServerBestEffort(server: http.Server): void {
  try {
    server.close();
  } catch {
    // The server may not have reached the listening state.
  }
}

async function startProxyServer(): Promise<ProxyServerState> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS; attempt += 1) {
    const server = proxyServerFactory(createProxyRequestHandler());
    try {
      const state = await listenOnLoopback(server);
      state.server.on("error", (err) => {
        logger.warn(`[Agent Credential Proxy] local proxy failed after bind: ${(err as Error).message}`);
      });
      state.server.unref();
      return state;
    } catch (err) {
      lastError = err;
      closeServerBestEffort(server);
      logger.warn(
        `[Agent Credential Proxy] local proxy bind attempt ${attempt}/${AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS} failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new AgentProxyBindError(
    `Agent Credential Proxy local proxy failed to bind ${AGENT_CREDENTIAL_PROXY_HOST} ` +
    `after ${AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS} attempts: ${detail}`,
  );
}

async function ensureServer(): Promise<ProxyServerState> {
  if (proxyServerState) return proxyServerState;
  if (!proxyServerStartPromise) {
    proxyServerStartPromise = startProxyServer();
  }
  try {
    proxyServerState = await proxyServerStartPromise;
    return proxyServerState;
  } finally {
    proxyServerStartPromise = null;
  }
}

export async function __resetAgentCredentialProxyForTest(): Promise<void> {
  registrations.clear();
  procJobManager = null;
  __resetRetiredLaunchesForTest();
  thirdPartyEventDeliveryReporter.reset();
  thirdPartyEventDeliveryReportRetryBaseMs = THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS;
  const state = proxyServerState;
  proxyServerState = null;
  proxyServerStartPromise = null;
  proxyServerFactory = createProxyServer;
  if (!state) return;
  await new Promise<void>((resolve) => {
    state.server.close(() => resolve());
  });
}

export function __setAgentCredentialProxyServerFactoryForTest(factory: ProxyServerFactory | null): void {
  proxyServerFactory = factory ?? createProxyServer;
}

function responseHeadersForLocalProxy(
  upstream: Response,
  proxyCarrier?: {
    correlationId: string;
    routeFamily: AgentProxyTransportRouteFamily;
    targetHostClass: AgentProxyTransportNormalizedError["targetHostClass"];
    launchId: string | null;
  },
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of upstream.headers.entries()) {
    // Node fetch transparently decodes gzip/br responses but preserves the
    // upstream encoding headers. The local proxy forwards decoded bytes, so
    // advertising the original compressed encoding makes downstream CLI fetch
    // attempt a second decode and surface null JSON payloads.
    if (DECODED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  if (proxyCarrier) {
    headers["x-raft-correlation-id"] = proxyCarrier.correlationId;
    headers["x-raft-proxy-stream-carrier"] = "1";
    headers["x-raft-proxy-route-family"] = proxyCarrier.routeFamily;
    headers["x-raft-proxy-target-host-class"] = proxyCarrier.targetHostClass;
    if (proxyCarrier.launchId) headers["x-raft-proxy-launch-id"] = proxyCarrier.launchId;
  }
  return headers;
}

async function handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  const tokenRegistration = registrations.get(token);
  if (!tokenRegistration) {
    const retired = retiredLaunchForToken(token);
    if (retired) {
      // A launch this proxy served has ended (#proj-raft-computer:#58): say
      // whether the agent runs on in a newer session, and point only at its
      // stable entry. The retired token itself never authorizes anything.
      const refusal = latestRegistrationForAgent(retired.agentId)
        ? launchSupersededRefusal(retired.stableEntryPath)
        : agentNotRunningRefusal(retired.stableEntryPath);
      logger.info(`[Agent Credential Proxy] ended launch transport used agent=${retired.agentId} outcome=${refusal.body.code}`);
      writeLocalProxyRefusal(res, refusal);
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid local agent proxy token", code: "invalid_agent_proxy_token" }));
    return;
  }
  // The stable entry (cli-transport/<agent>/current/) carries the proxy token
  // of the launch that last wrote it. It is served by the agent's current
  // launch at request time, only when the request names the credential's own
  // agent: never another agent's, never a launch that has ended.
  const viaStableEntry = firstRequestHeader(req.headers[RAFT_CLI_ENTRY_HEADER.toLowerCase()])?.trim() === RAFT_CLI_STABLE_ENTRY;
  if (viaStableEntry && firstRequestHeader(req.headers["x-agent-id"])?.trim() !== tokenRegistration.agentId) {
    logger.warn(`[Agent Credential Proxy] stable entry agent mismatch agent=${tokenRegistration.agentId}`);
    writeLocalProxyRefusal(res, stableEntryAgentMismatchRefusal());
    return;
  }
  const registration = viaStableEntry
    ? latestRegistrationForAgent(tokenRegistration.agentId) ?? tokenRegistration
    : tokenRegistration;

  const method = req.method ?? "GET";
  const correlationId = randomBytes(8).toString("hex");
  let target: URL | undefined;
  const inboundTraceparent = firstRequestHeader(req.headers.traceparent);
  const parent = parseTraceparent(inboundTraceparent);
  const traceContextState = parent
    ? "continued"
    : inboundTraceparent
      ? "malformed"
      : "new_root";
  let localPathname = "unknown";
  try {
    localPathname = new URL(req.url ?? "/", "http://agent-proxy.local").pathname;
  } catch {
    // Keep a closed unknown route for malformed request targets. The proxy
    // span must still close even when the upstream URL cannot be constructed.
  }
  const proxySpan: ActiveSpan = registration.tracer.startSpan("daemon.agent_proxy.request", {
    parent,
    surface: "daemon",
    kind: "client",
    attrs: {
      agentId: registration.agentId,
      route_family: routeFamilyForPath(localPathname),
      // route_family folds v1 and v2 send together; keep the version visible
      // so a client route change cannot hide behind the family (task #360).
      route_path_version: localPathname.startsWith("/internal/agent-api/v2/") ? "v2" : "v1",
      method: normalizedProxyMethod(method),
      trace_context_state: traceContextState,
      proxy_launch_id_present: registration.launchId !== null,
      // Which CLI entry sent it: the launch's own wrapper, or the agent's stable entry.
      via: viaStableEntry ? RAFT_CLI_STABLE_ENTRY : "launch",
      correlation_id: correlationId,
    },
  });
  const noteUpstreamDecodeFailed = (encoding: string): void => {
    proxySpan.addEvent("daemon.agent_proxy.upstream_decode_failed", {
      encoding,
      route_family: routeFamilyForPath(localPathname),
    });
  };
  let proxySpanStatus: TraceStatus = "error";
  let proxySpanEndAttrs: Record<string, unknown> = {
    outcome: "proxy_failure",
    normalized_code: "transport_failure",
    response_started: false,
    response_complete: false,
    failure_class: "pre_response_transport",
  };
  let upstreamResponseStarted = false;
  let upstreamResponseComplete = false;
  // Set when the upstream request was retried after a pre-response connection
  // failure; `outcome` is whether the retry got a response.
  let retry: { firstCauseCode: string; outcome: "ok" | "failed" } | undefined;
  // The CLI gives up on its own timeout (300 s) and may retry. An upstream
  // request it no longer waits for must not reach the Server later (a
  // connection that was still being set up can succeed after the CLI left),
  // or a retried side effect runs twice: abort it once the CLI's connection
  // closes before the response was written.
  const clientGone = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) clientGone.abort();
  });
  // Upload failures are read by size, so the upload span carries a coarse
  // bucket only (never names or bytes). The declared length covers failures
  // before the body is read; the buffered length replaces it once known.
  const sizeTracked = routeFamilyForPath(localPathname) === "attachments/upload";
  let requestBodyBytes = sizeTracked ? declaredContentLength(req.headers["content-length"]) : undefined;
  try {
    target = new URL(req.url ?? "/", registration.serverUrl);
    // The local bearer authorizes this agent's Raft server only. Absolute,
    // scheme-relative and backslash targets can otherwise replace the origin
    // before we attach the server-side credential.
    if (target.origin !== new URL(registration.serverUrl).origin) {
      proxySpanEndAttrs = {
        outcome: "target_rejected",
        normalized_code: "agent_proxy_origin_mismatch",
        http_status: 403,
      };
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Agent proxy target must use the registered server origin", code: "agent_proxy_origin_mismatch" }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      const normalizedName = name.toLowerCase();
      if (value === undefined) continue;
      if (normalizedName === "host") continue;
      if (normalizedName === "authorization") continue;
      if (normalizedName === "content-length") continue;
      // Never forward the caller's accept-encoding: undici only transparently
      // decodes compressed responses when IT negotiated the encoding, and a
      // user-supplied accept-encoding disables that (observed on Node 26).
      // Forwarding it hands us gzip bytes while responseHeadersForLocalProxy
      // strips content-encoding per the decoded-forwarding contract — the CLI
      // then parses raw gzip as JSON (INVALID_JSON_RESPONSE / "empty body").
      if (normalizedName === "accept-encoding") continue;
      if (HOP_BY_HOP_REQUEST_HEADERS.has(normalizedName)) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }
    // First line of defense: ask the upstream for an unencoded body outright.
    // decodedUpstreamBuffer above is the backstop for upstreams that compress
    // regardless (CloudFront does, for large cached responses).
    headers.set("accept-encoding", "identity");
    headers.set("Authorization", `Bearer ${registration.apiKey}`);
    headers.set("X-Agent-Id", registration.agentId);
    // The launch and model context this request belongs to: the server's
    // agent-context return events (glimpse input duplication) group what it
    // offered per context; the daemon is the authority on both.
    if (registration.launchId) headers.set("X-Agent-Launch-Id", registration.launchId);
    const contextId = registration.inboxCoordinator?.getContextId?.();
    if (contextId) headers.set("X-Agent-Context-Id", contextId);
    headers.set("X-Raft-Client", "cli");
    // The daemon is the authority on the entry: a caller's value is replaced.
    setOrDeleteHeader(headers, RAFT_CLI_ENTRY_HEADER, viaStableEntry ? RAFT_CLI_STABLE_ENTRY : null);
    // What the agent runs on, for the server's request span (task #15 in
    // #proj-analytics): the daemon is the authority, so a caller's own values
    // are replaced. The CLI's X-Raft-Client-Version passes through.
    setOrDeleteHeader(headers, RAFT_COMPUTER_VERSION_HEADER, registration.computerVersion);
    setOrDeleteHeader(headers, RAFT_DAEMON_VERSION_HEADER, registration.daemonVersion);
    setOrDeleteHeader(headers, RAFT_RUNTIME_HEADER, registration.runtime);
    headers.set("X-Slock-Agent-Active-Capabilities", registration.activeCapabilities);
    appendDaemonClientCapabilities(headers);
    // The caller-supplied context is only a parent. Always create a daemon
    // child span and overwrite the carrier so the server/preflight requests
    // are causally joined without trusting the local caller's span identity.
    headers.set("traceparent", formatTraceparent(proxySpan.context));

    let body: BodyInit | undefined;
    let rawBodyBuffer: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      rawBodyBuffer = await readRequestBody(req);
      if (sizeTracked) requestBodyBytes = rawBodyBuffer.byteLength;
      const bodyBuffer = new ArrayBuffer(rawBodyBuffer.byteLength);
      new Uint8Array(bodyBuffer).set(rawBodyBuffer);
      body = bodyBuffer;
      headers.delete("content-length");
    }
    let sendTarget: string | undefined;
    let sideEffectFreshnessContextMode: "inline" | "withheld" | undefined;
    let sideEffectTaskWriteKey: string | undefined;
    // v2 sends feed the ledger from their response but keep the v2 response
    // unreprojected, so their mode only steers consumption.
    let sendV2ConsumeFreshnessContextMode: "inline" | "withheld" | undefined;
    const sideEffectAction = agentApiSideEffectAction(target.pathname);
    const isMessageSendV2 = target.pathname === MESSAGE_SEND_V2_PATH;

    if (method === "GET" && target.pathname === "/internal/agent-api/runtime-version") {
      if (!registration.daemonVersion) {
        proxySpanEndAttrs = {
          outcome: "local_response_unavailable",
          local_response_kind: "runtime_version",
          http_status: 503,
        };
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: "The current daemon process did not expose a version.",
          code: "daemon_runtime_version_unavailable",
        }));
        return;
      }
      proxySpanStatus = "ok";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "runtime_version",
        http_status: 200,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        daemonVersion: registration.daemonVersion,
        computerVersion: registration.computerVersion,
        observation: "live_daemon_process",
        ...(daemonRunCapabilities().length > 0 ? { capabilities: daemonRunCapabilities() } : {}),
      }));
      return;
    }

    // `raft proc`: answered by the daemon as the registration's agent (a live
    // launch, or the stable entry served by the agent's current one). The
    // body carries the CLI's environment: it never leaves this process.
    if (isProcPath(target.pathname)) {
      const proc = await handleProcRequest(procJobManager, {
        agentId: registration.agentId,
        stableEntryPath: registration.stableEntryPath,
        launchId: registration.launchId,
        runtime: registration.runtime,
        method,
        pathname: target.pathname,
        query: target.searchParams,
        body: rawBodyBuffer,
      });
      proxySpanStatus = proc.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "proc",
        http_status: proc.status,
        ...(typeof proc.body.code === "string" ? { normalized_code: proc.body.code } : {}),
      };
      res.writeHead(proc.status, { "content-type": "application/json" });
      res.end(JSON.stringify(proc.body));
      return;
    }

    if (method === "GET" && target.pathname === "/internal/agent-api/inbox") {
      const localInbox = localAgentApiInboxResponse(registration);
      if (localInbox) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "inbox",
          http_status: localInbox.status,
        };
        res.writeHead(localInbox.status, { "content-type": "application/json" });
        res.end(JSON.stringify(localInbox.body));
        return;
      }
    }

    if (method === "POST" && (
      target.pathname === "/internal/agent-api/inbox/seal"
      || target.pathname === "/internal/agent-api/inbox/unseal"
    )) {
      const localSeal = localAgentApiInboxSealResponse(
        registration,
        rawBodyBuffer ?? Buffer.alloc(0),
        target.pathname.endsWith("/unseal") ? "unseal" : "seal",
      );
      proxySpanStatus = localSeal.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: `inbox_${target.pathname.endsWith("/unseal") ? "unseal" : "seal"}`,
        http_status: localSeal.status,
      };
      res.writeHead(localSeal.status, { "content-type": "application/json" });
      res.end(JSON.stringify(localSeal.body));
      return;
    }

    // Explicit app-item ack (Phase 1). inbox check itself never consumes.
    // Body was already drained into rawBodyBuffer for non-GET methods above.
    if (method === "POST" && target.pathname === "/internal/agent-api/inbox/ack") {
      const localAck = await localAgentApiInboxAckResponse(registration, headers, rawBodyBuffer ?? Buffer.alloc(0));
      proxySpanStatus = localAck.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "inbox_ack",
        http_status: localAck.status,
      };
      res.writeHead(localAck.status, { "content-type": "application/json" });
      res.end(JSON.stringify(localAck.body));
      return;
    }

    // `raft inbox dismiss --target <the target a Computer-local app item's row
    // prints>`: the item exists only in this daemon's store, so the daemon
    // removes it and answers as the Server answers one dismissed app item.
    // Every other dismiss is the Server's and is forwarded below unchanged.
    if (method === "POST" && target.pathname === INBOX_DISMISS_PATH) {
      const localDismiss = localAgentApiInboxDismissResponse(registration, rawBodyBuffer ?? Buffer.alloc(0));
      if (localDismiss) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "inbox_dismiss",
          http_status: localDismiss.status,
        };
        res.writeHead(localDismiss.status, { "content-type": "application/json" });
        res.end(JSON.stringify(localDismiss.body));
        return;
      }
    }

    // Task #178: the CLI acks a leased batch of third-party events after it
    // has written them out. Never forwarded: the lease is daemon state.
    if (method === "POST" && target.pathname === "/internal/agent-api/third-party-events/ack") {
      const localAck = localAgentApiThirdPartyEventsAckResponse(registration, rawBodyBuffer ?? Buffer.alloc(0));
      proxySpanStatus = localAck.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "third_party_events_ack",
        http_status: localAck.status,
        ...localAck.attrs,
      };
      res.writeHead(localAck.status, { "content-type": "application/json" });
      res.end(JSON.stringify(localAck.body));
      return;
    }

    // Local Inbox first: a managed runner's message check is a projection of
    // the daemon's accepted-but-not-yet-visible inbox. Do not forward to the
    // server while local pending exists, or a busy runtime can receive a
    // pending notification and then see "No new messages."
    if (method === "GET" && target.pathname === "/internal/agent-api/events") {
      // Task #178: a CLI that will ack after output declares it; only then are
      // third-party events leased instead of consumed-and-reported on finish.
      const leaseThirdParty = firstRequestHeader(req.headers[AGENT_API_EVENTS_ACK_HEADER])?.trim().toLowerCase() === AGENT_API_EVENTS_ACK_LEASE;
      const localEvents = await localAgentApiEventsResponse(registration, target, { leaseThirdPartyEvents: leaseThirdParty });
      if (localEvents) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "events",
          http_status: localEvents.status,
        };
        const servedThirdPartyEventIds = thirdPartyEventIdsFromEvents(
          Array.isArray(localEvents.body.events) ? localEvents.body.events : [],
        );
        if (servedThirdPartyEventIds.length > 0) {
          // "lease" (task #178): consumed and reported only when the CLI acks
          // the batch after writing it out (third-party-events/ack branch).
          // "finish_fallback" (task #175): for CLIs without the ack, reported
          // once the response has been written. `finish` means "handed to the
          // OS", not "the client read it", so a CLI dying mid-read loses the
          // event; the attr lets that fallback share be read from traces
          // until every CLI acks and the path is removed.
          proxySpanEndAttrs.third_party_ack_mode = leaseThirdParty ? "lease" : "finish_fallback";
          proxySpanEndAttrs.third_party_served_count = servedThirdPartyEventIds.length;
          if (!leaseThirdParty) {
            res.once("finish", () => thirdPartyEventDeliveryReporter.report(registration.agentId, servedThirdPartyEventIds));
          }
        }
        res.writeHead(localEvents.status, { "content-type": "application/json" });
        res.end(JSON.stringify(localEvents.body));
        return;
      }
    }

    if (method === "POST" && sideEffectAction) {
      const rawBody = rawBodyBuffer?.toString("utf8") ?? "";
      const prepared = await prepareAgentApiSideEffectForward(registration, headers, rawBody, sideEffectAction);
      if (prepared.localResponse) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "freshness_hold",
          http_status: 200,
        };
        const responseText = JSON.stringify(prepared.localResponse);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(responseText);
        return;
      }
      body = prepared.bodyText;
      // The target whose held context (a send's or a task write's) the response books.
      sendTarget = prepared.target;
      sideEffectFreshnessContextMode = prepared.freshnessContextMode;
      sideEffectTaskWriteKey = prepared.taskWriteKey;
      headers.set("content-type", "application/json");
      headers.delete("content-length");
    } else if (method === "POST" && isMessageSendV2) {
      // task #360 follow-up: the CLI sends through v2 since #7035, which the
      // side-effect preflight above never matched, so the daemon's model-seen
      // facts never reached a real send. Forward-only: lift `seenUpToSeq` and
      // union exact seqs; never answer a v2 send locally (the hold stays the
      // Server's). Under passive AX the coordinator's facts are scoped to the
      // model's current context, like the CLI's own (glimpse G0). The response
      // still feeds the ledger (held context, own commit) exactly as v1 does.
      const rawBody = rawBodyBuffer?.toString("utf8") ?? "";
      const prepared = await prepareAgentApiSideEffectForward(registration, headers, rawBody, "send", { localHold: false });
      body = prepared.bodyText;
      sendTarget = prepared.target;
      sendV2ConsumeFreshnessContextMode = prepared.freshnessContextMode;
      headers.set("content-type", "application/json");
      headers.delete("content-length");
    }

    const upstreamTarget = target;
    const fetchUpstream = () => daemonFetch(
      upstreamTarget,
      {
        method,
        headers,
        body,
        redirect: shouldRelayAgentAttachmentRedirect(upstreamTarget.pathname) ? "manual" : "follow",
        signal: clientGone.signal,
      },
      process.env,
      agentCredentialProxyFetchOptions(upstreamTarget.pathname, process.env),
    );
    let upstream: Awaited<ReturnType<typeof fetchUpstream>>;
    try {
      upstream = await fetchUpstream();
    } catch (err) {
      // A connection reset before any response (Clash in TUN mode, a stale
      // keep-alive socket) is retried once, only for a request the Server can
      // safely see twice. The failed socket is gone, so the retry connects anew.
      if (clientGone.signal.aborted) throw err;
      const firstError = transportNormalizedErrorForError(upstreamTarget, err, registration.launchId);
      if (!isRetryablePreResponseConnectionError(err, firstError)) throw err;
      if (!isProxyRequestSafeToRepeat(method, upstreamTarget, body)) throw err;
      retry = { firstCauseCode: firstError.causeCode, outcome: "failed" };
      logger.info(
        `[Agent Credential Proxy] retrying once after a pre-response connection failure ` +
        `(route_family=${firstError.routeFamily}, cause_code=${firstError.causeCode}, correlation_id=${correlationId})`,
      );
      await sleep(proxyPreResponseRetryDelayMs, undefined, { signal: clientGone.signal });
      upstream = await fetchUpstream();
      retry.outcome = "ok";
    }
    upstreamResponseStarted = true;

    const shouldBufferReviewerIsolationResponse =
      sideEffectFreshnessContextMode === "withheld"
      && Boolean(sideEffectAction);
    const agentEventHistoryRead = isAgentEventHistoryRead(method, target);
    if (
      upstream.status >= 500 ||
      shouldBufferReviewerIsolationResponse
      || shouldBufferJsonResponse(upstream, target.pathname, registration)
    ) {
      let responseText: string;
      try {
        responseText = (await decodedUpstreamBuffer(upstream, noteUpstreamDecodeFailed)).toString("utf8");
        upstreamResponseComplete = true;
      } catch (err) {
        if (clientGone.signal.aborted && isAbortError(err)) throw err;
        const transportError = transportNormalizedErrorForError(target, err, registration.launchId, {
          responseStarted: true,
          responseComplete: false,
        });
        const failure = proxyFailureForError(method, target, err, {
          correlationId,
          transportError,
        });
        logger.warn(formatProxyFailureLogMessage(registration, failure));
        registration.inboxCoordinator?.recordProxyFailure?.(failure);
        registration.inboxCoordinator?.recordTransportNormalizedError?.(transportError);
        proxySpanStatus = "error";
        proxySpanEndAttrs = proxyFailureSpanAttrs(transportError);
        writeProxyFailureResponse(res, failure);
        return;
      }
      if (upstream.status >= 500) {
        const transportError = transportNormalizedErrorForHttpStatus(target, upstream.status, registration.launchId);
        const failure = proxyFailureForUpstreamHttpResponse(method, target, upstream.status, {
          correlationId,
          transportError,
        });
        proxySpanStatus = "error";
        proxySpanEndAttrs = {
          outcome: "upstream_5xx",
          http_status: upstream.status,
          normalized_code: transportError.normalizedCode,
          response_started: transportError.responseStarted,
          response_complete: transportError.responseComplete,
          failure_class: transportError.failureClass,
          cause_code: transportError.causeCode,
        };
        logger.warn(formatProxyFailureLogMessage(registration, failure));
        registration.inboxCoordinator?.recordProxyFailure?.(failure);
        registration.inboxCoordinator?.recordTransportNormalizedError?.(transportError);
        if (isDeliberateServerErrorAnswer(upstream.headers, responseText) && !res.headersSent) {
          proxySpanEndAttrs.relayed_server_answer = true;
          res.writeHead(upstream.status, { "content-type": "application/json", "x-raft-correlation-id": correlationId });
          res.end(responseText);
          return;
        }
        writeProxyFailureResponse(res, failure);
        return;
      }
      proxySpanStatus = "ok";
      proxySpanEndAttrs = {
        outcome: "upstream_response",
        http_status: upstream.status,
      };
      // The ledger is the daemon's own bookkeeping. On a side-effecting route
      // the Server has already acted, so the agent must get its reply even if
      // the ledger update fails: a lost "sent" invites a duplicate send, a lost
      // hold hides the draft and its context (PROXY_5XX on 2026-10-14, thread
      // alias, see serverResolvedThreadTarget). A read can simply be retried,
      // so there the failure stays a post_response_local error.
      noteCommittedMessage(registration, target.pathname, upstream.status, responseText);
      if (!registration.inboxCoordinator) noteSendOutcomeWithoutCoordinator(registration, target.pathname, responseText);
      try {
        await consumeVisibleResponse(registration, target, sendTarget, sideEffectFreshnessContextMode ?? sendV2ConsumeFreshnessContextMode, responseText, sideEffectTaskWriteKey);
      } catch (err) {
        // `inbox read` consumed its page on the Server: losing the answer would
        // lose those messages, and the read must not be retried to get them back.
        if (!sideEffectAction && !isMessageSendV2 && target.pathname !== INBOX_READ_PATH) throw err;
        const errorMessage = truncateProxyErrorMessage(err instanceof Error ? err.message : String(err));
        logger.warn(`[Agent Credential Proxy] visible-delivery ledger update failed; forwarding the upstream response (correlation_id=${correlationId}): ${errorMessage}`);
        proxySpan.addEvent("daemon.agent_proxy.visible_ledger_failed", {
          route_family: routeFamilyForPath(target.pathname),
          error_class: err instanceof Error ? err.name : "Error",
        });
      }
      const downstreamResponseText = sideEffectFreshnessContextMode === "withheld"
        ? reprojectReviewerIsolationResponse(responseText, upstream.status, target.pathname)
        : responseText;
      // An `agent-event:` re-read hands the event body to the runtime, like a
      // Local Inbox `/events` serve: report it delivered once the response
      // has been written. Error responses (absent, ambiguous, expired) carry
      // no body and report nothing.
      const reReadThirdPartyEventIds = agentEventHistoryRead && upstream.status >= 200 && upstream.status < 300
        ? thirdPartyEventIdsFromHistoryResponse(responseText)
        : [];
      if (reReadThirdPartyEventIds.length > 0) {
        proxySpanEndAttrs.third_party_ack_mode = "history_reread";
        proxySpanEndAttrs.third_party_served_count = reReadThirdPartyEventIds.length;
        res.once("finish", () => thirdPartyEventDeliveryReporter.report(registration.agentId, reReadThirdPartyEventIds));
      }
      res.writeHead(upstream.status, responseHeadersForLocalProxy(upstream));
      res.end(downstreamResponseText);
      return;
    }

    proxySpanStatus = "ok";
    proxySpanEndAttrs = {
      outcome: "upstream_response",
      http_status: upstream.status,
    };
    res.writeHead(upstream.status, responseHeadersForLocalProxy(upstream, {
      correlationId,
      routeFamily: routeFamilyForPath(target.pathname),
      targetHostClass: daemonUpstreamTargetHostClass(target),
      launchId: registration.launchId,
    }));
    const streamEncoding = (upstream.headers.get("content-encoding") ?? "").trim().toLowerCase();
    if (upstream.body && streamEncoding && streamEncoding !== "identity") {
      // Encoded body on the streaming path: buffer-decode so the stripped
      // content-encoding header stays honest (JSON-ish responses in practice;
      // attachments are served unencoded and keep the streaming path below).
      res.end(await decodedUpstreamBuffer(upstream, noteUpstreamDecodeFailed));
      upstreamResponseComplete = true;
    } else if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      upstreamResponseComplete = true;
      res.end();
    } else {
      upstreamResponseComplete = true;
      res.end();
    }
  } catch (err) {
    if (clientGone.signal.aborted && isAbortError(err)) {
      // The CLI left first: nothing to answer, and not a transport failure.
      // Once the response had started this is how a stream ends (the bridge
      // closing its wake-hint stream), so only an unanswered request is an error.
      proxySpanStatus = upstreamResponseStarted ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "client_closed",
        response_started: upstreamResponseStarted,
        response_complete: upstreamResponseComplete,
      };
      return;
    }
    const transportError = transportNormalizedErrorForError(target, err, registration.launchId, {
      responseStarted: upstreamResponseStarted,
      responseComplete: upstreamResponseComplete,
    });
    const failure = proxyFailureForError(method, target, err, {
      correlationId,
      transportError,
    });
    logger.warn(
      formatProxyFailureLogMessage(registration, failure),
    );
    registration.inboxCoordinator?.recordProxyFailure?.(failure);
    registration.inboxCoordinator?.recordTransportNormalizedError?.(transportError);
    proxySpanStatus = "error";
    proxySpanEndAttrs = proxyFailureSpanAttrs(transportError);
    writeProxyFailureResponse(res, failure);
  } finally {
    if (requestBodyBytes !== undefined) {
      proxySpanEndAttrs = { ...proxySpanEndAttrs, body_size_bucket: bodySizeBucket(requestBodyBytes) };
    }
    if (retry) {
      proxySpanEndAttrs = {
        ...proxySpanEndAttrs,
        retried: true,
        retry_outcome: retry.outcome,
        retry_first_cause_code: retry.firstCauseCode,
      };
    }
    proxySpan.end(proxySpanStatus, { attrs: proxySpanEndAttrs });
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** The wait before the one retry of a request reset before any response. */
const PROXY_PRE_RESPONSE_RETRY_DELAY_MS = 400;
let proxyPreResponseRetryDelayMs = PROXY_PRE_RESPONSE_RETRY_DELAY_MS;

export function __setProxyPreResponseRetryDelayMsForTest(ms: number | undefined): void {
  proxyPreResponseRetryDelayMs = ms ?? PROXY_PRE_RESPONSE_RETRY_DELAY_MS;
}

/**
 * Connection-level failures that end a request before any response: the
 * socket was refused, reset or closed under us, or the connect timed out.
 * Read timeouts (UND_ERR_HEADERS_TIMEOUT) are not among them: the request
 * was sent and the Server may be working on it.
 */
const PRE_RESPONSE_RETRYABLE_CAUSE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isRetryablePreResponseConnectionError(err: unknown, error: AgentProxyTransportNormalizedError): boolean {
  if (error.normalizedCode !== "transport_failure" || error.failureClass !== "pre_response_transport") return false;
  if (PRE_RESPONSE_RETRYABLE_CAUSE_CODES.has(error.causeCode)) return true;
  // A bare ETIMEDOUT can be a read timeout; only one raised by connect counts.
  return error.causeCode === "ETIMEDOUT" && isConnectPhaseError(err);
}

function isConnectPhaseError(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof AggregateError) return true;
    if ((current as { syscall?: unknown }).syscall === "connect") return true;
  }
  return false;
}

/**
 * Agent API writes whose Server handler honours a body `idempotencyKey`: a
 * repeat with the same key replays the first answer and writes nothing, and a
 * unique index makes concurrent repeats land once (messages.agent_send_key,
 * message_card_revisions.idempotency_key, agent_api_idempotency_keys).
 * `POST /assistant/notify` takes an `idempotency_key` but the Server does not
 * use it yet, so it is not here.
 */
const IDEMPOTENCY_KEYED_WRITES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/internal\/agent-api\/send$/ },
  { method: "POST", path: /^\/internal\/agent-api\/v2\/send$/ },
  { method: "POST", path: /^\/internal\/agent-api\/tasks\/reply$/ },
  { method: "POST", path: /^\/internal\/agent-api\/tasks$/ },
  { method: "POST", path: /^\/internal\/agent-api\/prepare-action$/ },
  { method: "PUT", path: /^\/internal\/agent-api\/messages\/[^/]+\/card$/ },
];

/** Only a small body the proxy already holds in memory is sent again. */
const PROXY_RETRY_MAX_BODY_BYTES = 1024 * 1024;

function isProxyRequestSafeToRepeat(method: string, target: URL, body: BodyInit | undefined): boolean {
  if (method === "GET" || method === "HEAD") {
    // GETs that consume on the Server: a repeat after a lost answer would
    // hand over the next batch (or nothing) instead of failing visibly.
    if (target.pathname === "/internal/agent-api/events") return false;
    // Any `unread=true` read (history, a task's conversation, the next route on
    // the shared history read) moves the read position: a repeat after a lost
    // answer would come back "no unread" and the agent would never see them.
    if (target.searchParams.get("unread") === "true") return false;
    return true;
  }
  if (!IDEMPOTENCY_KEYED_WRITES.some((route) => route.method === method && route.path.test(target.pathname))) return false;
  let text: string;
  if (typeof body === "string") text = body;
  else if (body instanceof ArrayBuffer) text = Buffer.from(body).toString("utf8");
  else return false;
  if (Buffer.byteLength(text, "utf8") > PROXY_RETRY_MAX_BODY_BYTES) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const key = (parsed as { idempotencyKey?: unknown }).idempotencyKey;
    return typeof key === "string" && key.trim().length > 0;
  } catch {
    return false;
  }
}

const MIB = 1024 * 1024;

export function bodySizeBucket(bytes: number): "<1MiB" | "1-10MiB" | "10-50MiB" | ">50MiB" {
  if (bytes < MIB) return "<1MiB";
  if (bytes < 10 * MIB) return "1-10MiB";
  if (bytes <= 50 * MIB) return "10-50MiB";
  return ">50MiB";
}

function declaredContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

function firstRequestHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function normalizedProxyMethod(method: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER" {
  const normalized = method.toUpperCase();
  if (
    normalized === "GET" ||
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE" ||
    normalized === "HEAD" ||
    normalized === "OPTIONS"
  ) {
    return normalized;
  }
  return "OTHER";
}

function writeProxyFailureResponse(res: http.ServerResponse, failure: AgentProxyFailure): void {
  if (res.writableEnded) return;
  if (res.headersSent) {
    // A streaming response may have already committed upstream headers and
    // partial bytes to the runtime. HTTP cannot be changed to a 502 JSON
    // envelope at that point; attempting to write headers again throws
    // ERR_HTTP_HEADERS_SENT. Close this local stream and keep the structured
    // failure in logs / inboxCoordinator instead.
    res.destroy();
    return;
  }
  const body: Record<string, unknown> = {
    error: failure.responseError ?? "failed to proxy local agent request",
    code: failure.responseCode ?? "agent_proxy_failed",
    detail: failure.errorMessage,
  };
  const proxyDiagnostics = proxyDiagnosticsForFailure(failure);
  if (proxyDiagnostics) body.proxy = proxyDiagnostics;
  if (failure.lifecycleInvalidAgentId) body.agent_id = failure.lifecycleInvalidAgentId;
  if (failure.lifecycleInvalidContext) body.invariant_context = failure.lifecycleInvalidContext;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (failure.correlationId) headers["x-raft-correlation-id"] = failure.correlationId;
  if (failure.suggestedNextAction) body.suggested_next_action = failure.suggestedNextAction;
  res.writeHead(failure.responseStatusCode ?? 502, headers);
  res.end(JSON.stringify(body));
}

function proxyFailureSpanAttrs(error: AgentProxyTransportNormalizedError): Record<string, unknown> {
  return {
    outcome: "proxy_failure",
    normalized_code: error.normalizedCode,
    response_started: error.responseStarted,
    response_complete: error.responseComplete,
    failure_class: error.failureClass,
    cause_code: error.causeCode,
    upstream_layer: error.upstreamLayer,
    target_host_class: error.targetHostClass,
    ...(error.viaHttpProxy === undefined ? {} : { via_http_proxy: error.viaHttpProxy }),
    ...(error.connectAttemptedAddresses === undefined ? {} : { connect_attempted_addresses: error.connectAttemptedAddresses }),
    ...(error.connectTimedOutAddresses === undefined ? {} : { connect_timed_out_addresses: error.connectTimedOutAddresses }),
    ...(error.upstreamStatus === undefined ? {} : { http_status: error.upstreamStatus }),
  };
}

function formatProxyFailureLogMessage(
  registration: ProxyRegistration,
  failure: AgentProxyFailure,
): string {
  return (
    `[Agent Credential Proxy] request failed ` +
    `(agent=${registration.agentId}, launch=${registration.launchId ?? "none"}, ` +
    `correlation=${failure.correlationId ?? "none"}, method=${failure.method}, path=${failure.pathname}, ` +
    `route_family=${failure.routeFamily ?? "unknown"}, failure_class=${failure.failureClass ?? "unknown"}, ` +
    `upstream_layer=${failure.upstreamLayer ?? "unknown"}, cause_code=${failure.causeCode ?? "UNKNOWN"}, ` +
    `response_started=${failure.responseStarted ?? false}, response_complete=${failure.responseComplete ?? false}, ` +
    `query_keys=${failure.queryKeys.join(",") || "none"}): ` +
    `${failure.errorName}: ${failure.errorMessage}${failure.errorCause ? ` (cause=${failure.errorCause})` : ""}`
  );
}

function proxyDiagnosticsForFailure(failure: AgentProxyFailure): Record<string, unknown> | undefined {
  if (!failure.correlationId && !failure.routeFamily && !failure.upstreamLayer) return undefined;
  const body: Record<string, unknown> = {
    layer: failure.upstream === "local_daemon" ? "local_daemon" : "local_daemon_proxy",
  };
  if (failure.correlationId) body.correlation_id = failure.correlationId;
  if (failure.routeFamily) body.route_family = failure.routeFamily;
  if (failure.failureClass) body.failure_class = failure.failureClass;
  if (failure.responseStarted !== undefined) body.response_started = failure.responseStarted;
  if (failure.responseComplete !== undefined) body.response_complete = failure.responseComplete;
  if (failure.causeCode) body.cause_code = failure.causeCode;
  if (failure.upstreamLayer) body.upstream_layer = failure.upstreamLayer;
  if (failure.upstreamStatus !== undefined) body.upstream_status = failure.upstreamStatus;
  if (failure.targetHostClass) body.target_host_class = failure.targetHostClass;
  if (failure.launchId !== undefined && failure.launchId !== null) body.launch_id = failure.launchId;
  if (failure.downstreamCaller) body.downstream_caller = failure.downstreamCaller;
  if (failure.upstream) body.upstream = failure.upstream;
  return body;
}

function proxyFailureForError(
  method: string,
  target: URL | undefined,
  err: unknown,
  context: {
    correlationId?: string;
    transportError?: AgentProxyTransportNormalizedError;
  } = {},
): AgentProxyFailure {
  const queryKeys = target ? [...new Set([...target.searchParams.keys()])].sort() : [];
  const cause = err instanceof Error ? err.cause : undefined;
  const errorMessage = truncateProxyErrorMessage(err instanceof Error ? err.message : String(err));
  const lifecycleInvalid = parseAgentNoProcessResidencyInvariant(errorMessage);
  const transportError = context.transportError;
  const failure: AgentProxyFailure = {
    method,
    pathname: target?.pathname ?? "unknown",
    queryKeys,
    errorName: errorClassOf(err),
    errorMessage,
  };
  if (context.correlationId) failure.correlationId = context.correlationId;
  if (transportError) {
    failure.routeFamily = transportError.routeFamily;
    failure.failureClass = transportError.failureClass;
    failure.responseStarted = transportError.responseStarted;
    failure.responseComplete = transportError.responseComplete;
    failure.causeCode = transportError.causeCode;
    failure.upstreamLayer = transportError.upstreamLayer;
    if (transportError.upstreamStatus !== undefined) failure.upstreamStatus = transportError.upstreamStatus;
    failure.launchId = transportError.launchId;
    failure.targetHostClass = transportError.targetHostClass;
    failure.downstreamCaller = transportError.downstreamCaller;
    failure.upstream = transportError.upstream;
  }
  if (lifecycleInvalid) {
    failure.responseStatusCode = 409;
    failure.responseCode = "agent_lifecycle_state_invalid";
    failure.responseError = "local daemon agent lifecycle state invalid";
    failure.lifecycleInvalidAgentId = lifecycleInvalid.agentId;
    failure.lifecycleInvalidContext = lifecycleInvalid.context;
  }
  const errorCause = describeProxyErrorCause(cause);
  if (errorCause) failure.errorCause = errorCause;
  if (
    failure.routeFamily === "attachments/upload" &&
    failure.upstreamLayer === "read_timeout" &&
    failure.errorCause?.startsWith("UND_ERR_HEADERS_TIMEOUT")
  ) {
    failure.responseCode = "ATTACHMENT_UPLOAD_TIMEOUT";
    failure.responseError = "Attachment upload timed out before the server responded";
    failure.suggestedNextAction =
      "The server may still have accepted the file. Wait briefly, then retry once if needed; if it fails again, share the Correlation value with an operator.";
  }
  return failure;
}

function proxyFailureForUpstreamHttpResponse(
  method: string,
  target: URL,
  status: number,
  context: {
    correlationId: string;
    transportError: AgentProxyTransportNormalizedError;
  },
): AgentProxyFailure {
  const queryKeys = [...new Set([...target.searchParams.keys()])].sort();
  return {
    method,
    pathname: target.pathname,
    queryKeys,
    correlationId: context.correlationId,
    errorName: "UpstreamHttpResponse",
    errorMessage: `upstream returned HTTP ${status}`,
    responseStatusCode: status,
    responseCode: "agent_proxy_failed",
    responseError: "upstream HTTP response failed",
    routeFamily: context.transportError.routeFamily,
    failureClass: context.transportError.failureClass,
    responseStarted: context.transportError.responseStarted,
    responseComplete: context.transportError.responseComplete,
    causeCode: context.transportError.causeCode,
    upstreamLayer: context.transportError.upstreamLayer,
    upstreamStatus: context.transportError.upstreamStatus,
    launchId: context.transportError.launchId,
    targetHostClass: context.transportError.targetHostClass,
    downstreamCaller: context.transportError.downstreamCaller,
    upstream: context.transportError.upstream,
  };
}

function parseAgentNoProcessResidencyInvariant(
  message: string,
): { context: string; agentId: string } | undefined {
  const match = /^Agent no-process residency invariant violation after ([^:]+): .+ for ([0-9a-f-]{36})\b/i.exec(message);
  if (!match) return undefined;
  return { context: match[1], agentId: match[2] };
}

function describeProxyErrorCause(cause: unknown): string | undefined {
  if (!cause) return undefined;
  if (cause instanceof Error) {
    const errorWithCode = cause as Error & { code?: unknown };
    const code = typeof errorWithCode.code === "string" ? errorWithCode.code : undefined;
    return truncateProxyErrorMessage([code, cause.message].filter(Boolean).join(" "));
  }
  if (typeof cause === "object") {
    const causeObject = cause as { code?: unknown; message?: unknown };
    const code = typeof causeObject.code === "string" ? causeObject.code : undefined;
    const message = typeof causeObject.message === "string" ? causeObject.message : undefined;
    const detail = [code, message].filter(Boolean).join(" ");
    if (detail) return truncateProxyErrorMessage(detail);
  }
  return truncateProxyErrorMessage(String(cause));
}

function truncateProxyErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

/**
 * A 5xx the Server answered on purpose: a JSON object with its own `error` and
 * `code` (Artifact storage not set up, an overload, …). The agent needs that
 * answer and its next step, as an agent calling the Server directly gets it,
 * so it is relayed as is. The Server's catch-all for an unexpected route error
 * (marked `X-Slock-Error-Id`) and any other body are still replaced by the
 * proxy's failure envelope, which never repeats an upstream body.
 */
function isDeliberateServerErrorAnswer(headers: Headers, responseText: string): boolean {
  if (headers.get("x-slock-error-id")) return false;
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const { error, code } = body as { error?: unknown; code?: unknown };
  return typeof error === "string" && typeof code === "string";
}

function transportNormalizedErrorForHttpStatus(target: URL, status: number, launchId: string | null): AgentProxyTransportNormalizedError {
  const failureClass = proxyFailureClassForPhase("upstream_http_response");
  return {
    normalizedCode: "server_5xx",
    routeFamily: routeFamilyForPath(target.pathname),
    responseStarted: true,
    responseComplete: true,
    failureClass,
    causeCode: `HTTP_${status}`,
    upstreamLayer: "http_status",
    upstreamStatus: status,
    launchId,
    targetHostClass: daemonUpstreamTargetHostClass(target),
    // Today the local credential proxy is only used by CLI wrappers. If runtime
    // or daemon-internal callers use it later, plumb the caller identity here.
    downstreamCaller: "cli",
    upstream: "server",
  };
}

function transportNormalizedErrorForError(
  target: URL | undefined,
  err: unknown,
  launchId: string | null,
  phase: { responseStarted?: boolean; responseComplete?: boolean } = {},
): AgentProxyTransportNormalizedError {
  const localDaemonStateInvalid = parseAgentNoProcessResidencyInvariant(
    sanitizeTransportOriginalMessage(err instanceof Error ? err.message : String(err)),
  );
  const responseStarted = phase.responseStarted ?? false;
  const responseComplete = phase.responseComplete ?? false;
  // Task #369: once the upstream response has been read in full, nothing the
  // network or server does can still fail this request. A throw from here on
  // (consumeVisibleResponse, the visible-delivery ledger, writing downstream)
  // is a local daemon fault and must not be reported as upstream transport.
  const localPostResponse = responseComplete;
  const local = localDaemonStateInvalid || localPostResponse;
  const sourceFailureClass: AgentProxyFailureClass = localPostResponse
    ? "post_response_local"
    : responseStarted && !responseComplete
      ? "mid_response_transport"
      : "pre_response_transport";
  const failureClass = proxyFailureClassForPhase(sourceFailureClass);
  return {
    normalizedCode: localDaemonStateInvalid
      ? "local_daemon_state_invalid"
      : localPostResponse ? "local_post_response_failure" : "transport_failure",
    routeFamily: routeFamilyForPath(target?.pathname ?? "unknown"),
    responseStarted,
    responseComplete,
    failureClass,
    causeCode: scrubbedProxyCauseCode(
      err,
      localDaemonStateInvalid ? "LOCAL_DAEMON_STATE_INVALID" : localPostResponse ? "LOCAL_POST_RESPONSE_FAILURE" : undefined,
    ),
    upstreamLayer: local ? "unknown" : target ? upstreamLayerForProxyError(err) : "unknown",
    originalMessage: sanitizeTransportOriginalMessage(err instanceof Error ? err.message : String(err)),
    launchId,
    targetHostClass: local ? "local_daemon" : target ? daemonUpstreamTargetHostClass(target) : "custom_server",
    ...(local || !target ? {} : { viaHttpProxy: fetchUsesHttpProxy(target.toString(), process.env) }),
    ...connectAttemptCountsOf(err),
    // Today the local credential proxy is only used by CLI wrappers. If runtime
    // or daemon-internal callers use it later, plumb the caller identity here.
    downstreamCaller: "cli",
    upstream: local ? "local_daemon" : "server",
  };
}

/**
 * Node's per-address connect attempts (autoSelectFamily) end in an
 * AggregateError with one error per address tried; undici keeps it as the
 * cause of its connect timeout. Only counts are kept, never the addresses:
 * how many were tried, and how many of those timed out rather than failed at
 * once (#47: a slow link times out every IPv4 attempt while IPv6 fails at once).
 */
function connectAttemptCountsOf(err: unknown): { connectAttemptedAddresses?: number; connectTimedOutAddresses?: number } {
  for (let current: unknown = err, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof AggregateError) {
      return {
        connectAttemptedAddresses: current.errors.length,
        connectTimedOutAddresses: current.errors.filter((e: unknown) => (e as { code?: unknown } | null)?.code === "ETIMEDOUT").length,
      };
    }
  }
  return {};
}

function proxyFailureClassForPhase(source: AgentProxyFailureClass): AgentProxyFailureClass {
  return source;
}

export function __transportNormalizedErrorForErrorForTest(
  target: URL | undefined,
  err: unknown,
  launchId: string | null,
  phase: { responseStarted?: boolean; responseComplete?: boolean } = {},
): AgentProxyTransportNormalizedError {
  return transportNormalizedErrorForError(target, err, launchId, phase);
}

export function routeFamilyForPath(pathname: string): AgentProxyTransportRouteFamily {
  if (pathname === "/internal/agent-api/runtime-version") return "runtime-version";
  if (pathname === "/internal/agent-api/proc" || pathname.startsWith("/internal/agent-api/proc/")) return "proc";
  if (pathname === "/internal/agent-api/v2/send") return "agent-api/send";
  if (pathname === "/internal/agent-api/send") return "agent-api/send";
  if (pathname === "/internal/agent-api/events") return "agent-api/events";
  if (pathname === "/internal/agent-api/inbox" || pathname.startsWith("/internal/agent-api/inbox/")) return "agent-api/inbox";
  if (pathname === "/internal/agent-api/receive-ack") return "agent-api/events";
  if (pathname === "/internal/agent-api/tasks/claim") return "tasks/claim";
  if (pathname === "/internal/agent-api/tasks/update-status") return "tasks/update";
  if (pathname === "/internal/agent-api/tasks" || pathname.startsWith("/internal/agent-api/tasks/")) return "tasks";
  if (/^\/internal\/agent-api\/attachments\/[^/]+\/comments/.test(pathname)) return "agent-api/attachments/comments";
  if (pathname.startsWith("/internal/agent-api/attachments/")) return "agent-api/attachments";
  if (/^\/internal\/agent-api\/messages\/[^/]+\/resolve$/.test(pathname)) return "agent-api/messages/resolve";
  if (/^\/internal\/agent-api\/messages\/[^/]+\/reactions$/.test(pathname)) return "agent-api/messages/reactions";
  if (pathname === "/internal/agent-api/server") return "server";
  if (pathname.startsWith("/internal/agent-api/history")) return "agent-api/events";
  if (pathname.startsWith("/internal/agent-api/search")) return "agent-api/events";
  if (pathname.startsWith("/internal/agent-api/channel-members")) return "channel-members";
  if (pathname.startsWith("/internal/agent-api/knowledge")) return "knowledge";
  if (pathname === "/internal/agent-api/profile" || pathname.startsWith("/internal/agent-api/profile/")) return "profile";
  if (pathname === "/internal/agent-api/integrations" || pathname.startsWith("/internal/agent-api/integrations/")) return "integrations";
  if (pathname === "/internal/agent-api/upload") return "attachments/upload";
  if (pathname === "/internal/agent-api/resolve-channel") return "resolve-channel";
  if (pathname === "/internal/agent-api/threads") return "threads";
  if (pathname === "/internal/agent-api/threads/unfollow") return "threads/unfollow";
  if (pathname === "/internal/agent-api/prepare-action") return "action/prepare";
  if (pathname === "/internal/agent-api/reminders" || pathname.startsWith("/internal/agent-api/reminders/")) return "reminders";
  if (/^\/internal\/agent-api\/channels\/[^/]+\/join$/.test(pathname)) return "channels/join";
  if (/^\/internal\/agent-api\/channels\/[^/]+\/leave$/.test(pathname)) return "channels/leave";
  return "unknown";
}

function daemonUpstreamTargetHostClass(url: URL): AgentProxyTransportNormalizedError["targetHostClass"] {
  const hostname = url.hostname.toLowerCase();
  // The daemon proxy target is the upstream Slock server. Localhost here means
  // a local/custom server, not CLI -> daemon loopback.
  if (hostname === "api.slock.ai") return "api.slock.ai";
  if (hostname === "api.raft.build") return "api.raft.build";
  return "custom_server";
}

function upstreamLayerForProxyError(err: unknown): AgentProxyTransportNormalizedError["upstreamLayer"] {
  const code = errorCode(err).toUpperCase();
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("dns")) return "dns";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    message.includes("socket")
  ) return "tcp";
  if (code.includes("TLS") || message.includes("certificate") || message.includes("tls")) return "tls";
  if (isExplicitUndiciReadTimeoutCode(code)) return "read_timeout";
  if (message.includes("proxy")) return "proxy_connect";
  if (message.includes("fly")) return "fly_edge";
  return "unknown";
}

function isExplicitUndiciReadTimeoutCode(code: string): boolean {
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (typeof err === "object" && err && "cause" in err) return errorCode((err as { cause?: unknown }).cause);
  return "";
}

function scrubbedProxyCauseCode(err: unknown, fallback = "UNKNOWN"): string {
  if (fallback !== "UNKNOWN") return fallback;
  const code = errorCode(err).toUpperCase();
  const mappedCode = safeProxyCauseCode(code);
  if (mappedCode) return mappedCode;
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause && cause !== err) {
    const mappedCause = safeProxyCauseCode(errorCode(cause).toUpperCase());
    if (mappedCause) return mappedCause;
  }
  const name = err instanceof Error ? err.name : "";
  const mappedName = safeProxyCauseCode(name.toUpperCase());
  if (mappedName) return mappedName;
  return "UPSTREAM_TRANSPORT_FAILURE";
}

const SAFE_PROXY_CAUSE_CODES = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UPSTREAM_TRANSPORT_FAILURE",
]);

function safeProxyCauseCode(code: string): string | undefined {
  return SAFE_PROXY_CAUSE_CODES.has(code) ? code : undefined;
}

function sanitizeTransportOriginalMessage(message: string): string {
  return truncateProxyErrorMessage(message)
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]");
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function messageSeq(message: AgentProxyVisibleMessage): number {
  return Number(message.seq ?? 0);
}

function isThirdPartyAgentEvent(message: AgentProxyVisibleMessage): boolean {
  const thirdPartyEvent = (message as AgentProxyVisibleMessage & { third_party_event?: { id?: unknown } | null }).third_party_event;
  return typeof thirdPartyEvent?.id === "string" && thirdPartyEvent.id.length > 0;
}

export function hasStableLocalMessageId(message: AgentProxyVisibleMessage): boolean {
  const id = message.message_id ?? message.id;
  return (typeof id === "string" && id.length > 0) || isThirdPartyAgentEvent(message);
}

function localAgentApiInboxResponse(
  registration: ProxyRegistration,
): { status: number; body: Record<string, unknown> } | undefined {
  const coordinator = registration.inboxCoordinator;
  if (!coordinator && !registration.appInbox) return undefined;
  const allPending = coordinator?.getAllPendingMessages?.() ?? [];
  // RFC 081, inbox items on: the Server lists the third-party events it marks
  // with an inbox item itself (`app:` rows), so the snapshot leaves them out
  // and its grouped row counts only the events the Server does not list, as
  // the wake-up notice does (the same shared split).
  const { rows, pending } = inboxItemsOn(registration)
    ? projectAgentInboxSnapshotWithoutAppItems(allPending)
    : { rows: projectAgentInboxSnapshot(allPending), pending: allPending };
  const appItems = registration.appInbox?.list() ?? [];
  const acknowledgedAppSources = registration.appInbox?.listAcknowledgedSources() ?? [];
  const seals = registration.appInbox?.listSeals() ?? [];
  const items = [
    ...rows.map((row) => ({ source: "message_target" as const, row })),
    ...appItems,
  ];
  coordinator?.recordInboxSnapshot?.({
    source: "agent_api_inbox_check",
    rows,
    pendingMessageCount: pending.length,
  });
  return {
    status: 200,
    body: {
      // message_target rows keep the legacy pure-read projection (byte-compatible).
      rows,
      // Typed union for Phase 1+ consumers (app items carry no msg id/seq/sender).
      items,
      pending_targets: rows.length,
      pending_messages: pending.length,
      pending_app_items: appItems.length,
      acknowledged_app_sources: acknowledgedAppSources,
      seals,
    },
  };
}

function isAgentInboxSourceRef(value: unknown): value is AgentInboxSourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string"
    && typeof record.id === "string"
    && (record.revision === undefined || typeof record.revision === "string");
}

function parseExactAppSourceAckSuccess(
  body: Record<string, unknown>,
  expected: {
    itemId: string;
    appId: string;
    notificationClass: string;
    sourceRef: AgentInboxSourceRef;
    ackAttemptId: string;
  },
): AppSourceAckAcceptedResponse | null {
  if (body.ok !== true) return null;
  if (body.itemId !== expected.itemId) return null;
  if (body.appId !== expected.appId) return null;
  if (body.notificationClass !== expected.notificationClass) return null;
  if (body.ackAttemptId !== expected.ackAttemptId) return null;
  if (!isAgentInboxSourceRef(body.sourceRef)) return null;
  if (sourceRefIdentityKey(body.sourceRef) !== sourceRefIdentityKey(expected.sourceRef)) return null;
  return {
    ok: true,
    itemId: body.itemId,
    appId: body.appId,
    notificationClass: body.notificationClass,
    sourceRef: body.sourceRef,
    ackAttemptId: body.ackAttemptId,
  };
}

type ServerAckTarget = {
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  actionCli?: string;
};

/**
 * One `POST /app-sources/ack` for `target`: accepted (the exact Server
 * answer), or failed with the agent-facing answer (the item is still not
 * acknowledged; refused: the same ack would be refused again; unavailable:
 * it is safe to run again). `authoritative`: the Server's refusal is final
 * for this source (a closed reject code), not a transient failure.
 */
async function postServerAppSourceAck(
  registration: ProxyRegistration,
  store: AgentAppInboxStore,
  headers: Headers,
  target: ServerAckTarget,
  ackAttemptId: string,
): Promise<
  | { kind: "accepted"; status: number; json: Record<string, unknown>; accepted: AppSourceAckAcceptedResponse | null }
  | { kind: "failed"; authoritative: boolean; response: { status: number; body: Record<string, unknown> } }
> {
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const url = new URL("/internal/agent-api/app-sources/ack", registration.serverUrl);
  const notAcknowledged = (reason: string) =>
    `${reason}; ${describeAppInboxItemForAgent(target)} is still not acknowledged.`;
  // The app may word the next step (a reminder names its full-id ack command
  // and, refused, where its current ack lines are); else a generic one.
  const nextAction = (outcome: "refused" | "unavailable") => store.ackFailureNextAction(target, outcome)
    ?? (outcome === "refused"
      ? "Nothing was acknowledged."
      : `Retry in a few seconds; it is safe to run the same ack again${target.actionCli ? `: ${target.actionCli}` : ""}`);
  let upstream: Response;
  let upstreamText: string;
  try {
    upstream = await daemonFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          itemId: target.itemId,
          appId: target.appId,
          notificationClass: target.notificationClass,
          sourceRef: target.sourceRef,
          ackAttemptId,
        }),
        redirect: "follow",
      },
      process.env,
      agentCredentialProxyFetchOptions(url.pathname, process.env),
    );
    upstreamText = await upstream.text();
  } catch (err) {
    logger.warn(`[AgentCredentialProxy] app-source ACK did not reach the Server (agent=${registration.agentId} item=${target.itemId}): ${errorClassOf(err)}`);
    return {
      kind: "failed",
      authoritative: false,
      response: {
        status: 503,
        body: {
          error: notAcknowledged("The Server could not be reached"),
          code: "app_source_ack_unavailable",
          suggested_next_action: nextAction("unavailable"),
        },
      },
    };
  }
  let upstreamJson: Record<string, unknown>;
  try {
    upstreamJson = JSON.parse(upstreamText || "{}") as Record<string, unknown>;
  } catch {
    upstreamJson = { error: upstreamText || "invalid upstream response", code: "invalid_upstream_response" };
  }
  if (upstream.status >= 400) {
    const authoritativeReject = parseAgentApiAppSourceAckReject(upstream.status, upstreamJson);
    const serverSaid = typeof upstreamJson.error === "string" && upstreamJson.error.length > 0
      ? upstreamJson.error
      : `HTTP ${upstream.status}`;
    if (!authoritativeReject) {
      return {
        kind: "failed",
        authoritative: false,
        response: {
          status: upstream.status,
          body: upstream.status >= 500
            ? {
              ...upstreamJson,
              error: notAcknowledged(`The Server could not take the ack (${serverSaid})`),
              suggested_next_action: nextAction("unavailable"),
            }
            : {
              ...upstreamJson,
              error: notAcknowledged(`The Server refused the ack (${serverSaid})`),
              suggested_next_action: nextAction("refused"),
            },
        },
      };
    }
    return {
      kind: "failed",
      authoritative: true,
      response: {
        status: upstream.status,
        body: {
          ...authoritativeReject,
          error: notAcknowledged(`The Server refused the ack (${authoritativeReject.error})`),
          suggested_next_action: nextAction("refused"),
        },
      },
    };
  }
  return {
    kind: "accepted",
    status: upstream.status,
    json: upstreamJson,
    accepted: parseExactAppSourceAckSuccess(upstreamJson, {
      itemId: target.itemId,
      appId: target.appId,
      notificationClass: target.notificationClass,
      sourceRef: target.sourceRef,
      ackAttemptId,
    }),
  };
}

const INVALID_APP_SOURCE_ACK_RESPONSE = {
  status: 502,
  body: {
    error: "Server app-source ACK response did not match the exact item it was sent for; retry the ack",
    code: "invalid_app_source_ack_response",
  },
};

/** RFC 081 `raft inbox dismiss` (agentApiContract `inboxDismiss`). */
export const INBOX_DISMISS_PATH = "/internal/agent-api/inbox/dismiss";

/**
 * A dismiss whose `target` is the one a Computer-local app item's row prints
 * (agentInboxAppItemDismissTarget, the one rule for what an agent may
 * dismiss: never a reminder or a sealed item), among the calling agent's own
 * items. Exactly one such item: it is removed here and the answer is the
 * Server's for one dismissed app item (handleInboxDismiss's `deps.answer`).
 * Undefined for everything else (no item or more than one with that target,
 * `before`, any other target or body): the request is the Server's, forwarded
 * as it came, and its answer is the agent's.
 */
function localAgentApiInboxDismissResponse(
  registration: ProxyRegistration,
  bodyRaw: Buffer,
): { status: number; body: Record<string, unknown> } | undefined {
  const store = registration.appInbox;
  if (!store) return undefined;
  let request: { target?: unknown; before?: unknown } | null;
  try {
    request = JSON.parse(bodyRaw.toString("utf8")) as { target?: unknown; before?: unknown } | null;
  } catch {
    return undefined;
  }
  if (!request || typeof request.target !== "string" || request.before !== undefined) return undefined;
  const target = request.target.trim();
  const matches = store.list().filter((item) => agentInboxAppItemDismissTarget(item) === target);
  if (matches.length !== 1) return undefined;
  const item = matches[0]!;
  if (!store.dismiss(item.itemId)) return undefined;
  const dismissed: AgentApiInboxDismissResponse = {
    dismissed: 1,
    conversations: 0,
    appItems: 1,
    skippedNeedsAck: 0,
    // When the item was minted; a value no Date holds says nothing.
    earliestActivityAt: typeof item.createdAtMs === "number" && Number.isFinite(new Date(item.createdAtMs).getTime())
      ? new Date(item.createdAtMs).toISOString()
      : null,
    remaining: 0,
  };
  return { status: 200, body: dismissed };
}

async function localAgentApiInboxAckResponse(
  registration: ProxyRegistration,
  headers: Headers,
  bodyRaw: Buffer,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const store = registration.appInbox;
  if (!store) {
    return {
      status: 404,
      body: { error: "app inbox not available for this runner", code: "app_inbox_unavailable" },
    };
  }
  let parsed: { itemId?: unknown; source?: unknown };
  try {
    parsed = JSON.parse(bodyRaw.toString("utf8") || "{}") as { itemId?: unknown; source?: unknown };
  } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "invalid_json" } };
  }
  const itemId = typeof parsed.itemId === "string" ? parsed.itemId.trim() : "";
  if (!itemId) {
    return { status: 400, body: { error: "itemId required", code: "item_id_required" } };
  }
  const item = store.list().find((entry) => entry.itemId === itemId);
  if (!item) return serverAckOfSourceNotHeld(registration, store, headers, itemId, parsed.source);
  const protectingSeal = store.findProtectingSeal(item);
  if (protectingSeal) {
    return {
      status: 409,
      body: {
        error: `Inbox source ${item.sourceRef.id} is sealed by ${protectingSeal.owner} until ${protectingSeal.until}; unseal it explicitly before acknowledging`,
        code: "item_sealed",
      },
    };
  }
  // A server-authority item (a fired reminder) is acked only by the Server,
  // whatever the inbox items flag (a flipped or stale flag must not leave a
  // Server-listed reminder acked only here): a local ack would answer
  // "acknowledged" while the Server still lists it as not acked (RFC 081 D7,
  // one read state). The local item stays until the Server accepts; a refusal
  // or an unreachable Server is the caller's error.
  const serverOnly = store.requiresServerAuthorizedAck(item);
  if (!serverOnly && store.ack(itemId)) {
    return { status: 200, body: { ok: true, itemId, remaining_app_items: store.list().length } };
  }
  const intent = store.beginServerAuthorizedAckIntent({
    itemId: item.itemId,
    ackAttemptId: randomUUID(),
  });
  if (!intent) {
    return { status: 404, body: { error: "item not found", code: "item_not_found" } };
  }
  // Unanswered or 5xx, the intent stays: the same ack is replayed under the
  // same ackAttemptId. An authoritative refusal clears it.
  const result = await postServerAppSourceAck(registration, store, headers, {
    itemId: intent.itemId,
    appId: intent.appId,
    notificationClass: intent.notificationClass,
    sourceRef: intent.sourceRef,
    ...(item.actionCli ? { actionCli: item.actionCli } : {}),
  }, intent.ackAttemptId);
  if (result.kind === "failed") {
    if (result.authoritative) {
      store.clearServerAuthorizedAckIntent({ itemId: item.itemId, ackAttemptId: intent.ackAttemptId });
    }
    return result.response;
  }
  if (!result.accepted) {
    return {
      status: 502,
      body: {
        error: "Server app-source ACK response did not match the persisted exact local item intent; retry will reuse the same attempt",
        code: "invalid_app_source_ack_response",
      },
    };
  }
  const completed = store.completeServerAuthorizedAck({ itemId: item.itemId, ackAttemptId: intent.ackAttemptId });
  if (!completed) {
    return {
      status: 409,
      body: {
        error: "Server accepted source ACK but local exact item could not be retired; refresh Inbox and retry",
        code: "local_ack_completion_failed",
      },
    };
  }
  return {
    status: result.status,
    body: {
      ...result.json,
      itemId: item.itemId,
      remaining_app_items: store.list().length,
    },
  };
}

/**
 * An ack of a server-authority source this store holds no live item for:
 * one it already acked (a daemon before reminder-server-ack@1 acked it only
 * here, so the Server may still list it), or, from `source`, one it never
 * held (a lost store, another machine). Either goes to the Server, whose
 * answer is the answer; an "already acknowledged" there is a success.
 */
async function serverAckOfSourceNotHeld(
  registration: ProxyRegistration,
  store: AgentAppInboxStore,
  headers: Headers,
  itemId: string,
  rawSource: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const notFound = { status: 404, body: { error: "item not found", code: "item_not_found" } };
  const acknowledged = store.listAcknowledgedSources().find((entry) => entry.itemId === itemId);
  let target: ServerAckTarget | null = null;
  if (acknowledged) {
    if (!store.requiresServerAuthorizedAck(acknowledged)) return notFound;
    target = {
      itemId: acknowledged.itemId,
      appId: acknowledged.appId,
      notificationClass: acknowledged.notificationClass,
      sourceRef: acknowledged.sourceRef,
    };
  } else if (rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)) {
    const source = rawSource as { appId?: unknown; notificationClass?: unknown; sourceRef?: unknown };
    if (typeof source.appId !== "string" || typeof source.notificationClass !== "string") return notFound;
    const normalized = store.normalizeServerAckSource({
      appId: source.appId,
      notificationClass: source.notificationClass,
      sourceRef: source.sourceRef,
    });
    if (!normalized || normalized.itemId !== itemId) {
      return {
        status: 400,
        body: { error: "source is not an exact server-acknowledged app source for this itemId", code: "invalid_ack_source" },
      };
    }
    target = normalized;
  }
  if (!target) return notFound;
  const protectingSeal = store.findProtectingSeal(target);
  if (protectingSeal) {
    return {
      status: 409,
      body: {
        error: `Inbox source ${target.sourceRef.id} is sealed by ${protectingSeal.owner} until ${protectingSeal.until}; unseal it explicitly before acknowledging`,
        code: "item_sealed",
      },
    };
  }
  const result = await postServerAppSourceAck(registration, store, headers, target, randomUUID());
  if (result.kind === "failed") {
    if (result.authoritative && acknowledged) store.markAcknowledgedSourceServerAck(acknowledged, "refused");
    return result.response;
  }
  if (!result.accepted) return INVALID_APP_SOURCE_ACK_RESPONSE;
  if (acknowledged) store.markAcknowledgedSourceServerAck(acknowledged, "accepted");
  return {
    status: result.status,
    body: {
      ...result.json,
      itemId: target.itemId,
      remaining_app_items: store.list().length,
    },
  };
}

/** `reminder cccccccc-… revision 1`: the item as its source names it, for agent-facing errors. */
function describeAppInboxItemForAgent(item: { sourceRef: AgentInboxSourceRef }): string {
  const { kind, id, revision } = item.sourceRef;
  return revision === undefined ? `${kind} ${id}` : `${kind} ${id} revision ${revision}`;
}

function localAgentApiInboxSealResponse(
  registration: ProxyRegistration,
  bodyRaw: Buffer,
  action: "seal" | "unseal",
): { status: number; body: Record<string, unknown> } {
  const store = registration.appInbox;
  if (!store) {
    return {
      status: 404,
      body: { error: "app inbox not available for this runner", code: "app_inbox_unavailable" },
    };
  }
  let parsed: { sources?: unknown; owner?: unknown; until?: unknown };
  try {
    parsed = JSON.parse(bodyRaw.toString("utf8") || "{}") as typeof parsed;
  } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "invalid_json" } };
  }
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = rawSources.filter((source): source is {
    appId: string;
    notificationClass: string;
    sourceRef: AgentInboxSourceRef;
  } => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;
    const value = source as Record<string, unknown>;
    return typeof value.appId === "string"
      && value.appId.trim().length > 0
      && typeof value.notificationClass === "string"
      && value.notificationClass.trim().length > 0
      && isAgentInboxSourceRef(value.sourceRef);
  });
  const identityKeys = sources.map((source) => `${source.appId}\0${source.notificationClass}\0${sourceRefIdentityKey(source.sourceRef)}`);
  if (sources.length === 0 || sources.length !== rawSources.length || new Set(identityKeys).size !== sources.length) {
    return { status: 400, body: { error: "sources must contain at least one exact app source identity", code: "sources_required" } };
  }
  if (action === "seal") {
    const owner = typeof parsed.owner === "string" ? parsed.owner.trim() : "";
    const until = typeof parsed.until === "string" ? parsed.until.trim() : "";
    if (!owner || owner.length > 120 || /[\u0000-\u001f\u007f]/.test(owner)) {
      return { status: 400, body: { error: "owner must be a single-line string of at most 120 characters", code: "invalid_owner" } };
    }
    if (!until || until.length > 500 || /[\u0000-\u001f\u007f]/.test(until)) {
      return { status: 400, body: { error: "until must be a single-line string of at most 500 characters", code: "invalid_until" } };
    }
    const sealed = store.sealSources({
      sources,
      owner,
      until,
    });
    return sealed
      ? { status: 200, body: { ok: true, affected: sealed.length } }
      : { status: 400, body: { error: "one or more seal source identities are invalid", code: "invalid_seal_source" } };
  }
  const unsealed = store.unsealSources({
    sources,
  });
  return unsealed
    ? { status: 200, body: { ok: true, affected: unsealed.length } }
    : { status: 409, body: { error: "one or more source identities are not sealed", code: "source_not_sealed" } };
}

function parseAgentApiEventsQuery(target: URL): {
  limit: number;
  sinceSeq: number | null;
  sinceCursorKind: "latest" | "seq" | null;
  error?: Record<string, string>;
} {
  const limit = Math.min(Math.max(Number(target.searchParams.get("limit")) || 50, 1), 200);
  const sinceRaw = target.searchParams.get("since")?.trim() ?? "";
  if (!sinceRaw) return { limit, sinceSeq: null, sinceCursorKind: null };
  if (sinceRaw === "latest") return { limit, sinceSeq: null, sinceCursorKind: "latest" };
  const parsed = Number(sinceRaw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      limit,
      sinceSeq: null,
      sinceCursorKind: null,
      error: {
        error: "since must be a non-negative integer (messageSeq) or 'latest'",
        code: "since_invalid",
      },
    };
  }
  return { limit, sinceSeq: Math.floor(parsed), sinceCursorKind: "seq" };
}

async function localAgentApiEventsResponse(
  registration: ProxyRegistration,
  target: URL,
  options: { leaseThirdPartyEvents: boolean } = { leaseThirdPartyEvents: false },
): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const coordinator = registration.inboxCoordinator;
  if (!coordinator) return undefined;
  const pending = coordinator.getAllPendingMessages?.() ?? [];
  const parsedQuery = parseAgentApiEventsQuery(target);
  if (parsedQuery.error && pending.length > 0) {
    return { status: 400, body: parsedQuery.error };
  }
  if (pending.length === 0) return undefined;

  // Managed-runner `/events` is the check_messages projection over the daemon
  // Local Inbox. The server endpoint is only a sync/repair fallback once this
  // local source of truth is empty; otherwise a busy runtime can be notified
  // about pending inbox messages and then incorrectly see "No new messages."
  const normalized = sortInboxMessagesBySeq(normalizeInboxVisibleMessages(pending));
  const filtered = parsedQuery.sinceSeq !== null
    ? normalized.filter((message) => {
        const seq = messageSeq(message);
        // Local pending rows are already known to be unconsumed. A stable id
        // remains sufficient when a mirror/re-serialization path omitted seq;
        // do not hide that row behind a numeric cursor and fall through to a
        // misleading empty upstream response.
        if ((!Number.isFinite(seq) || seq <= 0) && hasStableLocalMessageId(message)) return true;
        return Number.isFinite(seq) && seq > parsedQuery.sinceSeq!;
      })
    : normalized;
  const events = filtered.slice(0, parsedQuery.limit);
  const hasMore = filtered.length > events.length;
  const newestEvent = events[events.length - 1];
  const lastSeenMsgId = newestEvent?.message_id ?? newestEvent?.id ?? null;
  const lastSeenSeq = newestEvent?.seq ?? parsedQuery.sinceSeq;

  // Task #178: under an ack lease, third-party events are neither consumed nor
  // reported here; they stay pending until the CLI acks the batch (or are
  // re-served under a new batch by a later /events). Ordinary messages keep
  // their existing local consumption.
  const leasedThirdParty = options.leaseThirdPartyEvents
    ? events.filter((message) => thirdPartyEventIdOf(message) !== null)
    : [];
  const consumable = leasedThirdParty.length > 0
    ? events.filter((message) => thirdPartyEventIdOf(message) === null)
    : events;
  if (consumable.length > 0) {
    // Local drain of the daemon Local Inbox is still an /events projection: it
    // can be sparse and is often reached from a wake/@mention signal. Record
    // exact ids for duplicate suppression, but do not advance model-seen
    // high-water; only verified contiguous content consumption may do that.
    coordinator.consumeVisibleMessages({ messages: consumable, source: "agent_api_events_local" });
  }
  const thirdPartyLease = leasedThirdParty.length > 0 ? leaseThirdPartyEvents(registration, leasedThirdParty) : null;
  coordinator.recordDrainOutcome?.({
    source: "daemon_pending",
    sinceCursorKind: parsedQuery.sinceCursorKind,
    notifiedCount: pending.length,
    drainedCount: events.length,
    hasMore,
  });

  return {
    status: 200,
    body: {
      events,
      last_seen_msgId: lastSeenMsgId,
      last_seen_seq: lastSeenSeq,
      reply_target: null,
      pending_notice_ids: [] as string[],
      wake_reason: null as string | null,
      has_more: hasMore,
      ...(thirdPartyLease ? { third_party_lease: thirdPartyLease } : {}),
    },
  };
}

function localAgentApiThirdPartyEventsAckResponse(
  registration: ProxyRegistration,
  bodyRaw: Buffer,
): { status: number; body: Record<string, unknown>; attrs: Record<string, unknown> } {
  let parsed: { batchId?: unknown; eventIds?: unknown };
  try {
    parsed = JSON.parse(bodyRaw.toString("utf8") || "{}") as { batchId?: unknown; eventIds?: unknown };
  } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "invalid_json" }, attrs: { third_party_ack_outcome: "invalid" } };
  }
  const batchId = typeof parsed.batchId === "string" ? parsed.batchId.trim() : "";
  const rawIds: unknown[] = Array.isArray(parsed.eventIds) ? parsed.eventIds : [];
  if (!batchId || rawIds.length === 0 || !rawIds.every(isThirdPartyEventId)) {
    return {
      status: 400,
      body: { error: "batchId and a non-empty array of event ids are required", code: "ack_body_invalid" },
      attrs: { third_party_ack_outcome: "invalid" },
    };
  }
  const lease = registration.thirdPartyLeases?.get(batchId);
  if (!lease || lease.expiresAt <= Date.now()) {
    // Expired, voided by a later /events, or from another registration: the
    // events are still pending locally and will be served again. Nothing is
    // consumed or reported.
    if (lease) {
      clearTimeout(lease.timer);
      registration.thirdPartyLeases?.delete(batchId);
    }
    return {
      status: 409,
      body: { error: "lease is not live; the events will be served again on the next check", code: "lease_not_live" },
      attrs: { third_party_ack_outcome: "lease_not_live" },
    };
  }
  clearTimeout(lease.timer);
  registration.thirdPartyLeases?.delete(batchId);
  const acked = new Set<string>();
  for (const id of rawIds as string[]) {
    const normalized = normalizeThirdPartyEventId(id);
    if (lease.eventIds.has(normalized)) acked.add(normalized);
  }
  const messages = lease.messages.filter((message) => {
    const id = thirdPartyEventIdOf(message);
    return id !== null && acked.has(id);
  });
  if (messages.length > 0) {
    registration.inboxCoordinator?.consumeVisibleMessages({ messages, source: "agent_api_events_local" });
  }
  const ackedIds = [...acked];
  if (ackedIds.length > 0) thirdPartyEventDeliveryReporter.report(registration.agentId, ackedIds);
  return {
    status: 200,
    body: { ok: true, batchId, acked: ackedIds },
    attrs: { third_party_ack_outcome: "acked", third_party_ack_count: ackedIds.length },
  };
}

function recordFreshnessDecision(
  coordinator: AgentProxyInboxCoordinator | undefined,
  decision: AgentProxyFreshnessDecision,
): void {
  coordinator?.recordFreshnessDecision?.(decision);
}

const MESSAGE_SEND_V2_PATH = "/internal/agent-api/v2/send";
const TASK_REPLY_PATH = "/internal/agent-api/tasks/reply";
/**
 * RFC 081 `raft inbox read` (agentApiContract `inboxRead`): a destructive read.
 * What its page printed is consumed on the Server, so the daemon drops the same
 * messages from its local queue (consumeVisibleResponse) and never retries it.
 */
export const INBOX_READ_PATH = "/internal/agent-api/inbox/read";
/** `inbox read` kinds whose page the Server records as given out; a reminder's read consumes nothing. */
const INBOX_READ_CONSUMING_KINDS: ReadonlySet<string> = new Set(["conversation", "app", "app_fallback", "event"]);

/**
 * A message the Server accepted on a send or task reply route (2xx, `sent`
 * or `committed`, with its id) goes to `recordMessageCommitted`. Bookkeeping
 * only: whatever it throws is dropped, the agent gets the response as is.
 */
function noteCommittedMessage(registration: ProxyRegistration, pathname: string, status: number, responseText: string): void {
  const record = registration.recordMessageCommitted ?? registration.inboxCoordinator?.recordMessageCommitted;
  if (!record || status < 200 || status >= 300) return;
  const route = isAgentApiSendPath(pathname) ? "send" : pathname === TASK_REPLY_PATH ? "task_reply" : null;
  if (!route) return;
  try {
    const parsed = JSON.parse(responseText) as { state?: unknown; messageId?: unknown } | null;
    if (!parsed || (parsed.state !== "sent" && parsed.state !== "committed")) return;
    if (typeof parsed.messageId !== "string" || parsed.messageId.length === 0) return;
    record({ messageId: parsed.messageId, route });
  } catch {
    // not JSON, or the recorder failed: nothing to index
  }
}

/** What the Server said about a forwarded message send (`recordSendOutcome`); null for another route or answer. */
function sendOutcomeOf(
  pathname: string,
  parsed: { state?: unknown; messageId?: unknown } | null,
): Parameters<NonNullable<AgentProxyInboxCoordinator["recordSendOutcome"]>>[0] | null {
  if (!parsed || !isAgentApiSendPath(pathname)) return null;
  if (parsed.state === "sent") return { state: "sent", ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}) };
  if (parsed.state === "held") return { state: "held" };
  return null;
}

/**
 * A launch with no coordinator (the OAR host) hears of its sends as one with
 * a coordinator does (`consumeVisibleResponse`). Bookkeeping only: whatever it
 * throws is dropped, the agent gets the response as is.
 */
function noteSendOutcomeWithoutCoordinator(registration: ProxyRegistration, pathname: string, responseText: string): void {
  if (!registration.recordSendOutcome) return;
  try {
    const outcome = sendOutcomeOf(pathname, JSON.parse(responseText) as { state?: unknown; messageId?: unknown } | null);
    if (outcome) registration.recordSendOutcome(outcome);
  } catch {
    // not JSON, or the recorder failed: nothing to count
  }
}

/** Both message send routes; v1 and v2 share the request and response shape. */
function isAgentApiSendPath(pathname: string): boolean {
  return pathname === "/internal/agent-api/send" || pathname === MESSAGE_SEND_V2_PATH;
}

/** Exported for the route-coverage guard test. */
export function __agentApiSideEffectActionForTest(pathname: string): AgentProxyFreshnessAction | "send_v2_forward_only" | undefined {
  if (pathname === MESSAGE_SEND_V2_PATH) return "send_v2_forward_only";
  return agentApiSideEffectAction(pathname);
}

/** A task write the Server can hold for freshness (agentWriteLanding.ts). */
function isAgentApiTaskWritePath(pathname: string): boolean {
  const action = agentApiSideEffectAction(pathname);
  return action !== undefined && action !== "send";
}

function agentApiSideEffectAction(pathname: string): AgentProxyFreshnessAction | undefined {
  // POST only (the caller checks): a GET of `/tasks` is the task list.
  return agentGatedWriteForPath(pathname);
}

/** The conversation a gated write's result lands in: the target its model-seen boundary is attested for. */
function sideEffectTarget(
  action: AgentProxyFreshnessAction,
  body: Record<string, unknown>,
  coordinator: AgentProxyInboxCoordinator | undefined,
): string | undefined {
  const landing = agentWriteLandingTarget(action, body);
  if (action !== "task_create" || !landing || !coordinator?.getThreadTargetOfMessage) return landing;
  // A create from a reply in a thread hangs under the thread's root, so the
  // Server checks that thread: attest what the model has seen of it, not of
  // the never-existing thread named after the reply (`#ch:<reply short>`).
  const source = agentWriteSourceMessageId(body);
  const parentTarget = landing.slice(0, landing.lastIndexOf(":"));
  return (source && coordinator.getThreadTargetOfMessage({ parentTarget, messageId: source })) || landing;
}

async function loadRecentTargetMessages(
  registration: ProxyRegistration,
  headers: Headers,
  target: string,
): Promise<AgentProxyVisibleMessage[]> {
  const historyUrl = new URL("/internal/agent-api/history", registration.serverUrl);
  historyUrl.searchParams.set("channel", target);
  historyUrl.searchParams.set("limit", "3");
  const historyHeaders = new Headers(headers);
  historyHeaders.delete("content-length");
  historyHeaders.delete("content-type");
  const res = await daemonFetch(
    historyUrl,
    { method: "GET", headers: historyHeaders },
    process.env,
    { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY },
  );
  if (!res.ok) return [];
  const parsed = await res.json().catch(() => null) as { messages?: AgentProxyVisibleMessage[] } | null;
  return Array.isArray(parsed?.messages) ? normalizeInboxVisibleMessages(parsed!.messages, target) : [];
}

async function applyAgentInboxStateMachineEffects(
  coordinator: AgentProxyInboxCoordinator,
  effects: AgentInboxStateMachineEffect[],
): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "record_freshness_decision") {
      recordFreshnessDecision(coordinator, effect.decision);
      continue;
    }
    coordinator.consumeVisibleMessages({
      target: effect.target,
      messages: effect.messages,
      boundarySeq: effect.boundarySeq,
      source: effect.source,
    });
  }
}

const MAX_FORWARDED_EXACT_SEEN_SEQS = 2_500;

/**
 * Task #360: rows the daemon delivered in full but recorded by exact id only
 * (a wake reply, a thread-join package) sit above the contiguous boundary, so
 * `seenUpToSeq` alone leaves them counted as unread and the Server holds the
 * send. Union the daemon's exact seqs above the boundary into the request's
 * `seenExactSeqs` (keeping the CLI's own), which the Server excludes exactly.
 */
function mergeDaemonExactSeenSeqs(body: Record<string, unknown>, daemonSeqs: readonly number[]): void {
  const boundary = typeof body.seenUpToSeq === "number" && Number.isFinite(body.seenUpToSeq) ? Math.floor(body.seenUpToSeq) : 0;
  const above = daemonSeqs.filter((seq) => Number.isInteger(seq) && seq > boundary);
  if (above.length === 0) return;
  const existing = Array.isArray(body.seenExactSeqs)
    ? body.seenExactSeqs.map((seq) => Math.floor(Number(seq))).filter((seq) => Number.isInteger(seq) && seq > 0)
    : [];
  body.seenExactSeqs = [...new Set([...existing, ...above])]
    .sort((a, b) => a - b)
    .slice(-MAX_FORWARDED_EXACT_SEEN_SEQS);
}

/**
 * Whether the connected Server checks task writes by landing
 * (SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, from `machine:context`). Until it
 * says so a task write attests nothing: an older Server would compare a
 * task-conversation boundary with the board and hold nearly every write.
 */
let serverChecksTaskWriteLanding = false;

export function setAgentProxyServerChecksTaskWriteLanding(capable: boolean): void {
  serverChecksTaskWriteLanding = capable;
}

/**
 * A forwarded task write names the landing its boundary is for (`seenFor`), so
 * the Server never reads it against another conversation. A conversation the
 * model never read attests 0, not nothing: an unattested write is not checked,
 * and a reply may land between this preflight and the Server's check.
 */
function attestTaskWriteLanding(action: AgentProxyFreshnessAction, body: Record<string, unknown>): void {
  if (action === "send") return;
  if (body.seenUpToSeq === undefined && !Array.isArray(body.seenExactSeqs)) body.seenUpToSeq = 0;
  body.seenFor = AGENT_GATED_WRITES[action].landing;
}

async function prepareAgentApiSideEffectForward(
  registration: ProxyRegistration,
  headers: Headers,
  rawBody: string,
  action: AgentProxyFreshnessAction,
  options: { localHold: boolean } = { localHold: true },
): Promise<
  {
    bodyText: string;
    target?: string;
    freshnessContextMode?: "inline" | "withheld";
    /** A task write's identity (agentTaskWriteKey): the hold its response books covers only its rerun. */
    taskWriteKey?: string;
    localResponse?: ApmHeldFreshnessEnvelopeBody<AgentProxyVisibleMessage>;
  }
> {
  let body: Record<string, unknown>;
  try {
    body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
  } catch {
    return { bodyText: rawBody };
  }

  const target = sideEffectTarget(action, body, registration.inboxCoordinator);
  const freshnessContextMode = body.freshnessContextMode === "withheld"
    ? "withheld"
    : "inline";
  if (action !== "send" && !serverChecksTaskWriteLanding) {
    // An older Server reads any boundary on a task write against the board:
    // send none, whoever set it (the SDK attests task writes by landing too).
    delete body.seenUpToSeq;
    delete body.seenExactSeqs;
    delete body.seenFor;
    return { bodyText: JSON.stringify(body), target, freshnessContextMode };
  }
  const coordinator = registration.inboxCoordinator;
  if (!target || !coordinator) {
    return { bodyText: JSON.stringify(body), target, freshnessContextMode };
  }
  const existingBoundary = typeof body.seenUpToSeq === "number" && Number.isFinite(body.seenUpToSeq)
    ? Math.max(0, Math.floor(body.seenUpToSeq))
    : undefined;
  if (action !== "send") {
    // A task write is never held here: it carries what the model has seen of
    // the conversation it lands in, and the Server decides (agentWriteLanding.ts),
    // because only the Server knows which lines the agent caused itself and
    // which messages count, and it attaches unseen ones instead of holding a
    // status update. Held or attached context is booked from the response.
    // The identical rerun of a held write also attests the span that hold
    // showed: the Server holds a write once per catch-up (gateTaskWriteFreshness),
    // and without it the rerun attested only the few messages shown.
    const taskWriteKey = agentTaskWriteKey(action, body);
    const heldSpan = coordinator.getHeldWriteSpan?.({ target, writeKey: taskWriteKey }) ?? 0;
    const boundary = Math.max(existingBoundary ?? 0, coordinator.getBoundary(target) ?? 0, heldSpan);
    if (boundary > 0) body.seenUpToSeq = boundary;
    mergeDaemonExactSeenSeqs(body, coordinator.getExactSeenSeqs?.(target) ?? []);
    attestTaskWriteLanding(action, body);
    return { bodyText: JSON.stringify(body), target, freshnessContextMode, taskWriteKey };
  }
  const pending = coordinator.getPendingMessages(target);

  const continueAnyway = body.continueAnyway === true;
  // A blind seat must not materialize target bodies merely to perform a
  // first-touch freshness preflight. Forward the metadata-only mode to the
  // server, whose freshness query can return the strict count-only hold.
  const shouldLoadRecent = freshnessContextMode !== "withheld"
    && pending.length === 0
    && !continueAnyway
    && Math.max(existingBoundary ?? 0, coordinator.getBoundary(target) ?? 0) <= 0;
  const recent = shouldLoadRecent ? await loadRecentTargetMessages(registration, headers, target) : [];
  const plan = planAgentInboxSideEffect({
    agentId: registration.agentId,
    action,
    target,
    continueAnyway,
    freshnessContextMode,
    existingSeenUpToSeq: existingBoundary,
    modelSeenSeq: coordinator.getBoundary(target),
    pendingMessages: pending,
    recentMessages: recent,
    isMessageModelSeen: (messageInput) => coordinator.isMessageModelSeen?.(messageInput) === true,
    heldContextLimit: LOCAL_HELD_CONTEXT_LIMIT,
  });
  if (!options.localHold && plan.localResponse) {
    // A hold the agent will not see must not record its context as consumed.
    mergeDaemonExactSeenSeqs(body, coordinator.getExactSeenSeqs?.(target) ?? []);
    return { bodyText: JSON.stringify(body), target, freshnessContextMode };
  }
  await applyAgentInboxStateMachineEffects(coordinator, plan.effects);
  if (typeof plan.forwardSeenUpToSeq === "number") body.seenUpToSeq = plan.forwardSeenUpToSeq;
  if (!plan.localResponse) mergeDaemonExactSeenSeqs(body, coordinator.getExactSeenSeqs?.(target) ?? []);
  return {
    bodyText: JSON.stringify(body),
    target,
    freshnessContextMode,
    localResponse: plan.localResponse,
  };
}

/**
 * Routes that answer with a history window the model reads, each with the
 * target its pages are booked under as seen (consumeVisibleResponse):
 * `undefined` books each message by its own metadata, `null` books nothing.
 * A route left out is never booked, so it never counts as read (task v2's
 * `/tasks/read` once was).
 */
const AGENT_API_HISTORY_WINDOW_TARGETS = new Map<string, (targetUrl: URL, answerTarget: unknown) => string | null | undefined>([
  ["/internal/agent-api/history", (targetUrl) => targetUrl.searchParams.get("channel") ?? undefined],
  // `raft task read`: a window on a task's own conversation, whose messages a
  // task write's evidence and the pending inbox both key by the task ref.
  // Booked only under the ref the request asked for, and only when the
  // Server's answer names it: the `channel` query is the board (`#proj`),
  // and booking there would count task messages as the board's. A
  // consume=false read books nothing.
  ["/internal/agent-api/tasks/read", (targetUrl, answerTarget) => {
    const ref = requestedTaskReadRef(targetUrl);
    return ref && answerTarget === ref && targetUrl.searchParams.get("consume") !== "false" ? ref : null;
  }],
]);

export function __agentApiBooksHistoryWindowForTest(pathname: string): boolean {
  return AGENT_API_HISTORY_WINDOW_TARGETS.has(pathname);
}

function shouldBufferJsonResponse(upstream: Response, pathname: string, registration: ProxyRegistration): boolean {
  if (!registration.inboxCoordinator && !registration.recordMessageCommitted && !registration.recordSendOutcome) return false;
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return false;
  if (!registration.inboxCoordinator) return isAgentApiSendPath(pathname) || pathname === TASK_REPLY_PATH;
  return isAgentApiSendPath(pathname) ||
    isAgentApiTaskWritePath(pathname) ||
    // Read only for its message id (noteCommittedMessage).
    (pathname === TASK_REPLY_PATH && Boolean(registration.inboxCoordinator.recordMessageCommitted)) ||
    pathname === "/internal/agent-api/events" ||
    pathname === INBOX_READ_PATH ||
    AGENT_API_HISTORY_WINDOW_TARGETS.has(pathname) ||
    /^\/internal\/agent-api\/messages\/[^/]+\/resolve$/.test(pathname);
}

/**
 * A thread has two addresses the Server accepts: its root message's short id
 * (`#chan:3ae9bd99`, the canonical one) and the thread channel's own id
 * (`#chan:46a146e8`, the `threadId` in message headers). A send to the second
 * is resolved by the Server, and the context it returns carries the canonical
 * target. Those messages are the Server's answer for the target it resolved,
 * so record them under that target: only when every held message names the
 * same thread in the same parent channel as the requested one.
 */
function serverResolvedThreadTarget(
  sendTarget: string | undefined,
  heldMessages: AgentProxyVisibleMessage[],
): string | undefined {
  if (!sendTarget) return sendTarget;
  const threadParent = (target: string): string | null => {
    const match = /^(#[^:]+|dm:@[^:]+):[^:]+$/.exec(target);
    return match ? match[1]! : null;
  };
  const requestedParent = threadParent(sendTarget);
  if (!requestedParent) return sendTarget;
  const resolved = new Set<string>();
  for (const message of heldMessages) {
    if (!message || typeof message !== "object" || message.third_party_event) continue;
    if (message.channel_type !== "thread" || !message.parent_channel_name || !message.channel_name) continue;
    resolved.add(formatProxyVisibleMessageTarget(message));
  }
  if (resolved.size !== 1) return sendTarget;
  const [only] = resolved;
  return only && threadParent(only) === requestedParent ? only : sendTarget;
}

async function consumeVisibleResponse(
  registration: ProxyRegistration,
  targetUrl: URL,
  sendTarget: string | undefined,
  requestedFreshnessContextMode: "inline" | "withheld" | undefined,
  responseText: string,
  taskWriteKey?: string,
): Promise<void> {
  const coordinator = registration.inboxCoordinator;
  if (!coordinator) return;
  let parsed: {
    consumption_scope?: AgentApiHistoryConsumptionScope;
    state?: string;
    seenUpToSeq?: number;
    messageId?: string;
    messageSeq?: number;
    heldMessages?: AgentProxyVisibleMessage[];
    freshnessContextMode?: "inline" | "withheld";
    events?: AgentProxyVisibleMessage[];
    messages?: AgentProxyVisibleMessage[];
    target?: string;
    unseen?: { messages?: AgentProxyVisibleMessage[]; omittedMessageCount?: number; seenUpToSeq?: number };
    entries?: AgentProxyVisibleMessage[];
  };
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    return;
  }
  const sendOutcome = sendOutcomeOf(targetUrl.pathname, parsed);
  if (sendOutcome) coordinator.recordSendOutcome?.(sendOutcome);
  if (
    (isAgentApiSendPath(targetUrl.pathname) || isAgentApiTaskWritePath(targetUrl.pathname))
    && parsed.state === "held"
    && requestedFreshnessContextMode !== "withheld"
    && parsed.freshnessContextMode !== "withheld"
    && Array.isArray(parsed.heldMessages)
  ) {
    // The Server's held context reaches the model with the response, so its
    // boundary is the model's: the identical rerun attests it and passes.
    const resolvedTarget = serverResolvedThreadTarget(sendTarget, parsed.heldMessages);
    coordinator.consumeVisibleMessages({
      target: resolvedTarget,
      messages: normalizeInboxVisibleMessages(parsed.heldMessages, sendTarget),
      boundarySeq: typeof parsed.seenUpToSeq === "number" ? parsed.seenUpToSeq : undefined,
      source: "server_held_context",
    });
    // That consume is set-only (it never moves the model-seen boundary), so
    // on its own a task write's rerun attested only the few messages shown
    // and was held again for the rest. Book the whole span for this write's
    // rerun only (the Server's write key, which names the write, not the
    // landing), as the CLI books a held send's `seenUpToSeq` for its draft:
    // under the landing it attested and the thread the Server resolved, since
    // a create from a reply the hold just showed attests that thread on the
    // rerun (sideEffectTarget).
    if (isAgentApiTaskWritePath(targetUrl.pathname) && sendTarget && taskWriteKey && typeof parsed.seenUpToSeq === "number") {
      for (const target of new Set([sendTarget, resolvedTarget ?? sendTarget])) {
        coordinator.recordHeldWriteSpan?.({ target, writeKey: taskWriteKey, seenUpToSeq: parsed.seenUpToSeq });
      }
    }
    return;
  }
  if (
    isAgentApiTaskWritePath(targetUrl.pathname)
    && requestedFreshnessContextMode !== "withheld"
    && Array.isArray(parsed.unseen?.messages)
  ) {
    // An applied task write's attached context (agentWriteLanding.ts
    // `attach`) reaches the model with the response, like a hold's. The
    // boundary moves only when every counted message was attached.
    const unseen = parsed.unseen!;
    coordinator.consumeVisibleMessages({
      target: sendTarget,
      messages: normalizeInboxVisibleMessages(unseen.messages!, sendTarget),
      boundarySeq: unseen.omittedMessageCount === 0 && typeof unseen.seenUpToSeq === "number" ? unseen.seenUpToSeq : undefined,
      source: "server_held_context",
    });
    return;
  }
  if (isAgentApiSendPath(targetUrl.pathname) && parsed.state === "sent") {
    const messageSeq = typeof parsed.messageSeq === "number" && Number.isFinite(parsed.messageSeq)
      ? Math.floor(parsed.messageSeq)
      : undefined;
    if (sendTarget && messageSeq && messageSeq > 0) {
      coordinator.consumeVisibleMessages({
        target: sendTarget,
        messages: normalizeInboxVisibleMessages([{ id: parsed.messageId }], sendTarget),
        source: "agent_api_send_commit",
      });
    }
    return;
  }
  if (targetUrl.pathname === "/internal/agent-api/events" && Array.isArray(parsed.events)) {
    const messages = normalizeInboxVisibleMessages(parsed.events);
    // Server `/events` sync/repair forward is a sparse server view, not
    // contiguous content consumption. Record exact ids for duplicate
    // suppression, but do not advance the model-seen high-water boundary.
    coordinator.consumeVisibleMessages({ messages, source: "agent_api_events_server" });
    coordinator.recordDrainOutcome?.({
      source: "server_events",
      sinceCursorKind: parseAgentApiEventsQuery(targetUrl).sinceCursorKind,
      notifiedCount: 0,
      drainedCount: messages.length,
      hasMore: Boolean((parsed as { has_more?: unknown }).has_more),
    });
    return;
  }
  // Only the kinds whose read the Server records as given out (conversation,
  // app, app_fallback, a single event). Reading a reminder writes nothing
  // there (`consumed` is always false; only its ack consumes it), and its
  // entries carry the firing event's id: dropping them here would unqueue a
  // reminder notice the agent has not acked (RFC 081 D13, Tenny #wg-ax:#19).
  if (targetUrl.pathname === INBOX_READ_PATH && Array.isArray(parsed.entries) && INBOX_READ_CONSUMING_KINDS.has(String((parsed as { kind?: unknown }).kind))) {
    // RFC 081 D1 / §7: what an `inbox read` page printed is consumed, so the
    // same messages leave the local queue by id and seq and are not pushed
    // again, as a `message read` page's are. Each entry is booked under the
    // conversation its own Server metadata names, not under the target the
    // agent typed: an alternate thread address, `~agent` or another letter
    // case reaches the same queued messages. A conversation page's entries
    // are history rows, which carry no channel name or type of their own:
    // those come from the page's `target`, the Server's canonical one (never
    // the typed one); an entry's own metadata still wins. Exact ids and seqs
    // only, never a boundary: a page is not proof that older messages were read.
    coordinator.consumeVisibleMessages({
      messages: normalizeInboxVisibleMessages(
        parsed.entries.filter((entry) => entry && typeof entry === "object"),
        typeof parsed.target === "string" ? parsed.target : undefined,
      ),
      source: "agent_api_inbox_read",
      responseBytes: Buffer.byteLength(responseText, "utf8"),
    });
    return;
  }
  const historyWindowTarget = AGENT_API_HISTORY_WINDOW_TARGETS.get(targetUrl.pathname);
  if (historyWindowTarget && Array.isArray(parsed.messages)) {
    // A history page counts as seen. `agent_api_history` books exact seqs and
    // ids only and never moves a boundary, so a --before/--after page marks
    // nothing it didn't return.
    const target = historyWindowTarget(targetUrl, parsed.target);
    if (target === null) return;
    const messages = normalizeInboxVisibleMessages(parsed.messages, target);
    const scope = agentApiHistoryConsumptionScopeSchema.safeParse(parsed.consumption_scope);
    const historyScope = scope.success && scope.data.agent_id === registration.agentId
      && scope.data.target === target ? scope.data : undefined;
    coordinator.consumeVisibleMessages({
      target,
      messages,
      boundarySeq: maxInboxMessageSeq(messages),
      source: "agent_api_history",
      responseBytes: Buffer.byteLength(responseText, "utf8"),
      ...(historyScope && { historyScope }),
    });
  }
}

/** The task ref (`#proj:#7`, `dm:@peer:#7`) a `/tasks/read` request asked for. */
function requestedTaskReadRef(targetUrl: URL): string | null {
  const channel = targetUrl.searchParams.get("channel")?.trim();
  const taskNumber = Number(targetUrl.searchParams.get("task_number"));
  if (!channel || !Number.isInteger(taskNumber) || taskNumber <= 0) return null;
  return formatAgentTaskRef(channel, taskNumber);
}

function reprojectReviewerIsolationResponse(
  responseText: string,
  status: number,
  pathname: string,
): string {
  const genericFailure = JSON.stringify({
    error: "Reviewer-isolation request failed; upstream detail withheld.",
    code: "reviewer_isolation_request_failed",
  });
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    if (status < 200 || status >= 300) return genericFailure;
    if (parsed.state === "held") {
      const rawCount = typeof parsed.withheldMessageCount === "number"
        ? parsed.withheldMessageCount
        : parsed.newMessageCount;
      const withheldMessageCount = typeof rawCount === "number" && Number.isFinite(rawCount)
        ? Math.max(0, Math.floor(rawCount))
        : 0;
      return JSON.stringify({
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount,
      });
    }
    if (pathname === "/internal/agent-api/send" && parsed.state === "sent") {
      return JSON.stringify({
        ...(parsed.ok === true ? { ok: true } : {}),
        state: "sent",
        ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
        ...(typeof parsed.messageSeq === "number" && Number.isFinite(parsed.messageSeq)
          ? { messageSeq: parsed.messageSeq }
          : {}),
      });
    }
    return responseText;
  } catch {
    return genericFailure;
  }
}

/** RFC 081 inbox items on for this agent (its `AgentConfig.inboxItems`, read per request). */
function inboxItemsOn(registration: ProxyRegistration): boolean {
  return registration.inboxItems?.() === true;
}

/**
 * What this daemon build does, added to the caller's own
 * `X-Raft-Client-Capabilities` (the CLI's tokens pass through; the CLI never
 * declares these). `reminder-server-ack@1` is unconditional: reminders are
 * acked through the Server, which this build always does. `proc@1` only while
 * this daemon runs jobs (`setAgentProcJobManager`; not on Windows in v1).
 */
function appendDaemonClientCapabilities(headers: Headers): void {
  const declared = (headers.get(RAFT_CLIENT_CAPABILITIES_HEADER) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!declared.includes(REMINDER_SERVER_ACK_CAPABILITY)) declared.push(REMINDER_SERVER_ACK_CAPABILITY);
  for (const capability of daemonRunCapabilities()) {
    if (!declared.includes(capability)) declared.push(capability);
  }
  headers.set(RAFT_CLIENT_CAPABILITIES_HEADER, declared.join(","));
}

function setOrDeleteHeader(headers: Headers, name: string, value: string | null): void {
  if (value) headers.set(name, value);
  else headers.delete(name);
}

/** The agent's newest live launch registration (registrations keep insertion order), or null when none is live. */
function latestRegistrationForAgent(agentId: string): ProxyRegistration | null {
  let latest: ProxyRegistration | null = null;
  for (const registration of registrations.values()) {
    if (registration.agentId === agentId) latest = registration;
  }
  return latest;
}

function writeLocalProxyRefusal(res: http.ServerResponse, refusal: LocalProxyRefusal): void {
  res.writeHead(refusal.status, { "content-type": "application/json" });
  res.end(JSON.stringify(refusal.body));
}

/**
 * A request the daemon itself makes to the Agent API as the agent (the idle
 * task reminder), with the agent's newest runner credential: the one its CLI
 * requests go out with, so the Server authorizes it exactly as the agent. Null
 * when no live launch of the agent has one (a legacy-token launch, a stopped
 * agent): nothing is sent.
 */
export async function fetchAgentApiAsAgent(
  agentId: string,
  pathname: string,
  init: { method: "POST"; body: unknown; signal?: AbortSignal },
): Promise<Response | null> {
  const latest = latestRegistrationForAgent(agentId);
  if (!latest) return null;
  return daemonFetch(new URL(pathname, latest.serverUrl), {
    method: init.method,
    headers: daemonAsAgentHeaders(latest),
    body: JSON.stringify(init.body),
    ...(init.signal ? { signal: init.signal } : {}),
  }, process.env, { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY });
}

/** Headers for a request the daemon itself makes to the Agent API as the agent. */
function daemonAsAgentHeaders(registration: ProxyRegistration): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${registration.apiKey}`,
    "Content-Type": "application/json",
    "X-Agent-Id": registration.agentId,
    "X-Raft-Client": "daemon",
    "X-Slock-Agent-Active-Capabilities": registration.activeCapabilities,
  });
  if (registration.launchId) headers.set("X-Agent-Launch-Id", registration.launchId);
  appendDaemonClientCapabilities(headers);
  setOrDeleteHeader(headers, RAFT_COMPUTER_VERSION_HEADER, registration.computerVersion);
  setOrDeleteHeader(headers, RAFT_DAEMON_VERSION_HEADER, registration.daemonVersion);
  setOrDeleteHeader(headers, RAFT_RUNTIME_HEADER, registration.runtime);
  return headers;
}

/** Acks one backfill batch sends at most. */
const SERVER_ACK_BACKFILL_LIMIT_PER_RUN = 100;
/**
 * Batches one run sends before leaving the rest for the next start (10,000
 * acks): a store with more than that is not drained in one launch.
 */
const SERVER_ACK_BACKFILL_MAX_BATCHES_PER_RUN = 100;
/** Pause between batches, so a long backlog is not one burst at the Server. */
const SERVER_ACK_BACKFILL_BATCH_PAUSE_MS = 200;
/** Stores with a backfill run in flight (one per store at a time). */
const serverAckBackfillsInFlight = new WeakSet<AgentAppInboxStore>();

/**
 * #wg-ax:#17: a daemon before REMINDER_SERVER_ACK_CAPABILITY acked a fired
 * reminder only in its own store, so the Server still lists it as fired and
 * not acked. Once per agent store, on the agent's first start under a build
 * that declares the token, send the Server an ack (idempotent there) for each
 * such source. Accepted or authoritatively refused (the Server holds nothing
 * to ack) settles a source; a transient failure leaves it for the next start.
 * Done (durable) only when none is left. Bounded per run; one run per store
 * at a time; a trace event carries the counts.
 */
async function runServerAckBackfill(registration: ProxyRegistration, store: AgentAppInboxStore): Promise<void> {
  if (serverAckBackfillsInFlight.has(store)) return;
  serverAckBackfillsInFlight.add(store);
  try {
    if (store.serverAckBackfillDone() === REMINDER_SERVER_ACK_CAPABILITY) return;
    // Batch after batch until none is left, not one batch per start: an
    // agent with a long local-only history (an hourly reminder at revision
    // 349) otherwise kept listing old fires for several starts after the
    // upgrade (#proj-raft-computer:27e207f5, Remy). A batch with a transient
    // failure ends the run: those sources stay pending, so another batch
    // would only resend them; the next start retries.
    let attempted = 0;
    let accepted = 0;
    let refused = 0;
    let failed = 0;
    for (let batch = 0; batch < SERVER_ACK_BACKFILL_MAX_BATCHES_PER_RUN; batch += 1) {
      // Pause before listing, so an ack the agent makes live meanwhile is
      // already settled when the next batch is listed and not posted twice.
      if (batch > 0) await new Promise((resolve) => setTimeout(resolve, SERVER_ACK_BACKFILL_BATCH_PAUSE_MS));
      const pending = store.listServerAckBackfillPending(SERVER_ACK_BACKFILL_LIMIT_PER_RUN);
      if (pending.length === 0) break;
      let batchFailed = 0;
      for (const source of pending) {
        attempted += 1;
        const result = await postServerAppSourceAck(registration, store, daemonAsAgentHeaders(registration), {
          itemId: source.itemId,
          appId: source.appId,
          notificationClass: source.notificationClass,
          sourceRef: source.sourceRef,
        }, randomUUID());
        if (result.kind === "accepted" && result.accepted) {
          store.markAcknowledgedSourceServerAck(source, "accepted");
          accepted += 1;
        } else if (result.kind === "failed" && result.authoritative) {
          store.markAcknowledgedSourceServerAck(source, "refused");
          refused += 1;
        } else {
          batchFailed += 1;
        }
      }
      failed += batchFailed;
      if (batchFailed > 0) break;
    }
    const remaining = store.listServerAckBackfillPending(SERVER_ACK_BACKFILL_LIMIT_PER_RUN).length;
    const done = remaining === 0;
    if (done) store.markServerAckBackfillDone(REMINDER_SERVER_ACK_CAPABILITY);
    store.traceServerAckBackfill({ attempted, accepted, refused, failed, remaining, done });
  } catch (err) {
    logger.warn(`[AgentCredentialProxy] reminder server-ack backfill failed (agent=${registration.agentId}): ${errorClassOf(err)}`);
  } finally {
    serverAckBackfillsInFlight.delete(store);
  }
}

export async function registerAgentCredentialProxy(input: {
  agentId: string;
  launchId?: string | null;
  serverUrl: string;
  apiKey: string;
  activeCapabilities: string;
  inboxCoordinator?: AgentProxyInboxCoordinator;
  recordMessageCommitted?: AgentProxyInboxCoordinator["recordMessageCommitted"];
  recordSendOutcome?: AgentProxyInboxCoordinator["recordSendOutcome"];
  appInbox?: AgentAppInboxStore;
  tracer?: Tracer;
  daemonVersion?: string | null;
  computerVersion?: string | null;
  runtime?: string | null;
  inboxItems?: () => boolean;
  /** The agent's stable entry wrapper this launch writes (cliTransport.ts). */
  stableEntryPath?: string | null;
}): Promise<ProxyHandle> {
  const server = await ensureServer();
  const proxyToken = `sap_${randomBytes(32).toString("base64url")}`;
  const registration: ProxyRegistration = {
    serverUrl: input.serverUrl,
    apiKey: input.apiKey,
    agentId: input.agentId,
    launchId: input.launchId ?? null,
    activeCapabilities: input.activeCapabilities,
    inboxCoordinator: input.inboxCoordinator,
    recordMessageCommitted: input.recordMessageCommitted,
    recordSendOutcome: input.recordSendOutcome,
    appInbox: input.appInbox,
    tracer: input.tracer ?? noopTracer,
    daemonVersion: input.daemonVersion?.trim() || null,
    computerVersion: input.computerVersion?.trim() || null,
    runtime: input.runtime?.trim() || null,
    ...(input.inboxItems ? { inboxItems: input.inboxItems } : {}),
    stableEntryPath: input.stableEntryPath ?? null,
  };
  registrations.set(proxyToken, registration);
  return {
    proxyUrl: server.proxyUrl,
    proxyToken,
    ...(input.appInbox ? { serverAckBackfill: runServerAckBackfill(registration, input.appInbox) } : {}),
  };
}

function retireRegistration(token: string, registration: ProxyRegistration): void {
  rememberRetiredLaunch(token, {
    agentId: registration.agentId,
    launchId: registration.launchId,
    stableEntryPath: registration.stableEntryPath,
  });
}

export function unregisterAgentCredentialProxyForLaunch(input: {
  agentId: string;
  launchId?: string | null;
}): number {
  let removed = 0;
  const launchId = input.launchId ?? null;
  for (const [token, registration] of registrations) {
    if (registration.agentId === input.agentId && registration.launchId === launchId) {
      clearThirdPartyLeases(registration);
      registrations.delete(token);
      retireRegistration(token, registration);
      removed += 1;
    }
  }
  return removed;
}

export function unregisterAgentCredentialProxiesForAgent(agentId: string): number {
  let removed = 0;
  for (const [token, registration] of registrations) {
    if (registration.agentId !== agentId) continue;
    clearThirdPartyLeases(registration);
    registrations.delete(token);
    retireRegistration(token, registration);
    removed += 1;
  }
  return removed;
}
