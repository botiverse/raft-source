import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type TransportUpstreamLayer =
  | "local_daemon_loopback"
  | "dns"
  | "tcp"
  | "tls"
  | "fly_edge"
  | "http_status"
  | "read_timeout"
  | "body_decode_failure"
  | "proxy_connect"
  | "unknown";

export type TransportNormalizedCode = "transport_failure" | "server_5xx";

export type TransportTargetHostClass = "api.slock.ai" | "api.raft.build" | "custom_server" | "local_daemon";
export type TransportRouteFamily =
  | "action/prepare"
  | "agent-api/activity"
  | "agent-api/attachments"
  | "agent-api/attachments/comments"
  | "agent-api/events"
  | "agent-api/inbox"
  | "agent-api/messages/reactions"
  | "agent-api/send"
  | "attachments/download"
  | "attachments/upload"
  | "channel-members"
  | "channels/join"
  | "channels/leave"
  | "integrations"
  | "knowledge"
  | "profile"
  | "reminders"
  | "resolve-channel"
  | "server"
  | "tasks"
  | "tasks/claim"
  | "tasks/update"
  | "threads"
  | "threads/unfollow"
  | "unknown";

export interface CliTransportNormalizedErrorAttrs {
  producer: "cli";
  normalized_code: TransportNormalizedCode;
  route_family: TransportRouteFamily;
  /**
   * Same meaning as daemon.agent.proxy.failure's response_started: whether
   * the upstream returned any response bytes before this normalized failure.
   */
  response_started: boolean;
  upstream_layer: TransportUpstreamLayer;
  upstream_status?: number | null;
  original_message?: string;
  serverId?: string | null;
  agentId?: string | null;
  machineId?: string | null;
  target_host_class: TransportTargetHostClass;
}

type TraceSinkForTest = (name: "cli.transport.normalized_error", attrs: CliTransportNormalizedErrorAttrs) => void;

/**
 * Every span name the CLI writes. A closed set on purpose: a span name is
 * data that leaves the machine, so adding one is a reviewed change here.
 */
export type CliTraceSpanName =
  | "cli.transport.normalized_error"
  | "cli.draft.held"
  | "cli.draft.resolved"
  | "cli.continuation.created"
  | "cli.continuation.answered"
  | "cli.continuation.refused"
  | "cli.guidance.decision";

/** Flat scalar attributes only; undefined, null and "" are left off the record. */
export type CliTraceSpanAttrs = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface CliTraceSpanShape {
  /**
   * `error` only for a failure: the daemon's observed-failure summary counts
   * `status === "error"` records (shared/observedFailureSummary.ts).
   */
  status: "ok" | "error";
  kind: "client" | "internal";
}

/** The JSONL record as written, for tests that assert exactly what ships. */
export interface CliTraceSpanRecord {
  type: "span";
  schema_version: 1;
  trace_id: string;
  span_id: string;
  parent_span_id: null;
  name: CliTraceSpanName;
  surface: "cli";
  kind: CliTraceSpanShape["kind"];
  status: CliTraceSpanShape["status"];
  start_time: string;
  end_time: string;
  duration_ms: 0;
  attrs: Record<string, string | number | boolean>;
  events: [];
}

type CliTraceSinkForTest = (record: CliTraceSpanRecord) => void;

const CLI_TRACE_DIR_ENV = "SLOCK_CLI_TRANSPORT_TRACE_DIR";
// The daemon uploads every `traces/daemon-trace-*.jsonl` as is (no span-name
// filter, daemon/src/traceBundleUpload.ts), and its sink budgets files by this
// prefix (trace-client `traceFileFamily`). Every CLI span keeps it, so a new
// span name ships without a daemon change.
const CLI_TRACE_FILE_PREFIX = "daemon-trace-cli-transport-";
// The agent's runtime id, set by the daemon in the spawn env
// (daemon/src/drivers/cliTransport.ts `RAFT_CURRENT_RUNTIME_ENV`).
const CLI_TRACE_RUNTIME_ENV = "RAFT_CURRENT_RUNTIME";
const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TRACE_ID_HEX_LENGTH = 32;
const SPAN_ID_HEX_LENGTH = 16;
let traceSinkForTest: TraceSinkForTest | null = null;
let cliTraceSinkForTest: CliTraceSinkForTest | null = null;
let traceFilePath: string | null = null;

export function __setCliTransportTraceSinkForTest(sink: TraceSinkForTest | null): void {
  traceSinkForTest = sink;
}

/** Test seam: receives every CLI span record, of any name, before it is written. */
export function __setCliTraceSinkForTest(sink: CliTraceSinkForTest | null): void {
  cliTraceSinkForTest = sink;
}

export function emitCliTransportNormalizedError(
  attrs: CliTransportNormalizedErrorAttrs,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    traceSinkForTest?.("cli.transport.normalized_error", attrs);
  } catch {
    return;
  }
  emitCliTraceSpan("cli.transport.normalized_error", { ...attrs }, { status: "error", kind: "client" }, env);
}

/**
 * The runtime id for a span's `runtime` attr, or undefined: unset (an older
 * daemon, a profile-login CLI) or not shaped like a runtime id. The agent's
 * shell can change its env, so only an id-shaped value is written.
 */
export function cliTraceRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[CLI_TRACE_RUNTIME_ENV]?.trim();
  return value && RUNTIME_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Append one span to this process's CLI trace file in
 * `$SLOCK_CLI_TRANSPORT_TRACE_DIR` (set by the daemon for the agents it runs;
 * unset, nothing is written). Never throws: tracing must not affect the
 * user-visible CLI command result.
 */
export function emitCliTraceSpan(
  name: CliTraceSpanName,
  attrs: CliTraceSpanAttrs,
  shape: CliTraceSpanShape,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const record = spanRecord(name, attrs, shape);
    cliTraceSinkForTest?.(record);
    const traceDir = env[CLI_TRACE_DIR_ENV];
    if (!traceDir) return;
    mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    if (!traceFilePath) {
      traceFilePath = path.join(
        traceDir,
        `${CLI_TRACE_FILE_PREFIX}${safeTimestamp(Date.now())}-${process.pid}-${randomHex(4)}.jsonl`,
      );
    }
    appendFileSync(traceFilePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Tracing must never affect the user-visible CLI command result.
  }
}

export function routeFamilyForPath(pathname: string): TransportRouteFamily {
  const normalized = pathname.split("?")[0] || "/";
  if (normalized === "/internal/agent-api/send") return "agent-api/send";
  if (normalized === "/internal/agent-api/activity") return "agent-api/activity";
  if (normalized === "/internal/agent-api/events") return "agent-api/events";
  if (normalized === "/internal/agent-api/inbox" || normalized.startsWith("/internal/agent-api/inbox/")) return "agent-api/inbox";
  if (normalized === "/internal/agent-api/tasks/claim") return "tasks/claim";
  if (normalized === "/internal/agent-api/tasks/update-status") return "tasks/update";
  if (normalized === "/internal/agent-api/tasks" || normalized.startsWith("/internal/agent-api/tasks/")) {
    return "tasks";
  }
  if (
    normalized === "/internal/agent-api/attachment-upload-capabilities"
    || normalized === "/internal/agent-api/attachment-upload-sessions"
    || normalized.startsWith("/internal/agent-api/attachment-upload-sessions/")
  ) return "attachments/upload";
  if (/^\/internal\/agent-api\/attachments\/[^/]+\/comments/.test(normalized)) return "agent-api/attachments/comments";
  if (/^\/api\/attachments\/[^/]+\/comments/.test(normalized)) return "agent-api/attachments/comments";
  if (normalized.startsWith("/internal/agent-api/attachments/")) return "agent-api/attachments";
  if (normalized.startsWith("/api/attachments/")) return "attachments/download";
  if (/^\/internal\/agent-api\/messages\/[^/]+\/reactions$/.test(normalized)) return "agent-api/messages/reactions";
  if (normalized === "/internal/agent-api/server") return "server";
  if (normalized.startsWith("/internal/agent-api/history")) return "agent-api/events";
  if (normalized.startsWith("/internal/agent-api/search")) return "agent-api/events";
  if (normalized.startsWith("/internal/agent-api/channel-members")) return "channel-members";
  if (normalized.startsWith("/internal/agent-api/knowledge")) return "knowledge";
  if (normalized === "/internal/agent-api/profile" || normalized.startsWith("/internal/agent-api/profile/")) return "profile";
  if (normalized === "/internal/agent-api/integrations" || normalized.startsWith("/internal/agent-api/integrations/")) return "integrations";
  if (normalized === "/internal/agent-api/upload") return "attachments/upload";
  if (normalized === "/internal/agent-api/resolve-channel") return "resolve-channel";
  if (normalized === "/internal/agent-api/threads") return "threads";
  if (normalized === "/internal/agent-api/threads/unfollow") return "threads/unfollow";
  if (normalized === "/internal/agent-api/prepare-action") return "action/prepare";
  if (normalized === "/internal/agent-api/reminders" || normalized.startsWith("/internal/agent-api/reminders/")) return "reminders";
  if (/^\/internal\/agent-api\/channels\/[^/]+\/join$/.test(normalized)) return "channels/join";
  if (/^\/internal\/agent-api\/channels\/[^/]+\/leave$/.test(normalized)) return "channels/leave";
  if (normalized.startsWith("/internal/agent/")) {
    const parts = normalized.split("/").filter(Boolean);
    const firstAfterAgentId = parts[3] ?? "unknown";
    if (firstAfterAgentId === "server") return "server";
    if (firstAfterAgentId === "send") return "agent-api/send";
    if (
      firstAfterAgentId === "history"
      || firstAfterAgentId === "search"
      || firstAfterAgentId === "receive"
    ) {
      return "agent-api/events";
    }
    if (firstAfterAgentId === "channel-members") return "channel-members";
    if (firstAfterAgentId === "knowledge") return "knowledge";
    if (firstAfterAgentId === "profile") return "profile";
    if (firstAfterAgentId === "integrations") return "integrations";
    if (firstAfterAgentId === "upload") return "attachments/upload";
    if (firstAfterAgentId === "resolve-channel") return "resolve-channel";
    if (firstAfterAgentId === "threads") {
      return normalized.endsWith("/threads/unfollow") ? "threads/unfollow" : "threads";
    }
    if (firstAfterAgentId === "prepare-action") return "action/prepare";
    if (firstAfterAgentId === "tasks") {
      if (normalized.endsWith("/tasks/claim")) return "tasks/claim";
      if (normalized.endsWith("/tasks/update-status")) return "tasks/update";
      return "tasks";
    }
    if (firstAfterAgentId === "reminders") return "reminders";
    if (firstAfterAgentId === "messages" && normalized.endsWith("/reactions")) return "agent-api/messages/reactions";
    if (firstAfterAgentId === "channels" && normalized.endsWith("/join")) return "channels/join";
    if (firstAfterAgentId === "channels" && normalized.endsWith("/leave")) return "channels/leave";
  }
  return "unknown";
}

export function targetHostClassForUrl(url: URL): TransportTargetHostClass {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return "local_daemon";
  if (hostname === "api.slock.ai") return "api.slock.ai";
  if (hostname === "api.raft.build") return "api.raft.build";
  return "custom_server";
}

export function upstreamLayerForFetchError(url: URL, err: unknown): TransportUpstreamLayer {
  if (targetHostClassForUrl(url) === "local_daemon") return "local_daemon_loopback";
  const code = errorCode(err).toUpperCase();
  const message = errorMessage(err).toLowerCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("dns")) return "dns";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || message.includes("socket")) return "tcp";
  if (code.includes("TLS") || message.includes("certificate") || message.includes("tls")) return "tls";
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "read_timeout";
  if (message.includes("proxy")) return "proxy_connect";
  if (message.includes("fly")) return "fly_edge";
  return "unknown";
}

export function boundedOriginalMessage(err: unknown): string | undefined {
  const message = sanitizeOriginalMessage(errorMessage(err));
  return message || undefined;
}

function spanRecord(name: CliTraceSpanName, attrs: CliTraceSpanAttrs, shape: CliTraceSpanShape): CliTraceSpanRecord {
  const now = new Date().toISOString();
  return {
    type: "span",
    schema_version: 1,
    trace_id: randomHex(TRACE_ID_HEX_LENGTH / 2),
    span_id: randomHex(SPAN_ID_HEX_LENGTH / 2),
    parent_span_id: null,
    name,
    surface: "cli",
    kind: shape.kind,
    status: shape.status,
    start_time: now,
    end_time: now,
    duration_ms: 0,
    attrs: Object.fromEntries(
      Object.entries(attrs).filter((entry): entry is [string, string | number | boolean] => {
        const value = entry[1];
        return value !== undefined && value !== null && value !== "";
      }),
    ),
    events: [],
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function safeTimestamp(timeMs: number): string {
  return new Date(timeMs).toISOString().replace(/[:.]/g, "-");
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (typeof err === "object" && err && "cause" in err) return errorCode((err as { cause?: unknown }).cause);
  return "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "");
}

function sanitizeOriginalMessage(message: string): string {
  const normalized = message
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
