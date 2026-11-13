// View Context (v0): the wire contract between the Server and a Computer for
// showing what an agent's model saw when it produced one Raft message. Shared
// protocol only; the daemon (reader, index, redaction) and the Server (route,
// flag, relay to the web) implement it.
//
// Flow:
// 1. Server flag `agent_context_view_v0` (server-scoped, default off; key in
//    featureFlags.ts) gates the whole feature on the Server.
// 2. A daemon that can answer advertises `DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0`
//    on `ready.capabilities`. The Server answers `old_daemon` for a Computer
//    that did not, without sending anything.
// 3. The daemon reports, per agent, whether a context view is possible
//    (`agent:context_view_availability`). The Server adds whether the
//    Computer is online and serves that to the web (`AgentContextViewStatus`,
//    agentContextViewStatus.ts).
// 4. Server -> daemon, over the existing Computer control WebSocket:
//    `agent:context_view_request` {requestId, agentId, messageId, maxBytes}.
//    The Server never sends a file path; the daemon resolves the message to a
//    session and request through its own local index.
// 5. Daemon -> Server, NOT over the WebSocket: at most one HTTPS POST (none
//    for a request it only gets to after the TTL below) to
//    `agentContextViewResultPath(requestId)`, authenticated with the Computer
//    credential (`Authorization: Bearer <machine key>`, as every
//    /internal/computer route). Body: `AgentContextViewResultBody` as JSON,
//    optionally `Content-Encoding: gzip`. See the constants below for the
//    size cap, TTL and first-POST-wins rule.
//
// Compatibility: additive only. New message types are ignored by older peers
// (the daemon's and the Server's unmatched-type fallthrough). New failure
// reasons, unsupported reasons, part kinds and redaction kinds may be added;
// the parsers below fold what they do not know instead of rejecting the body.
import type { Brand } from "./brandedIds";
import type { DiagnosticRedactionCounts } from "./diagnosticRedaction";
import { isDiagnosticRedactionKind } from "./diagnosticRedaction";
import { isJsonValue, type JsonValue } from "./jsonValue";
import { makeIsMember } from "./typeGuards";

/**
 * Daemon capability (on `ready.capabilities`): the daemon handles
 * `agent:context_view_request` and answers with one result POST, and sends
 * `agent:context_view_availability`. Without it the Server answers
 * `old_daemon` and sends no request.
 */
export const DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0 = "agent-context-view:v0";

/**
 * A daemon that reads a Codex agent's context only from `<Codex home>/sessions`
 * (#13469). A 1.0.65 daemon allowed the whole Codex home, `auth.json`
 * included, so the Server views or searches a Codex agent only on a Computer
 * advertising this, and answers `old_daemon` otherwise. Other runtimes don't
 * need it.
 */
export const DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_CODEX_ROOT_V1 = "agent-context-view-codex-root:v1";

/** The capabilities a Computer needs before the Server views or searches an agent of `runtime` there. */
export function agentContextViewRuntimeCapabilities(runtime: string | null | undefined): readonly string[] {
  return runtime === "codex" ? [DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_CODEX_ROOT_V1] : [];
}

/** Server -> daemon message type (`AgentContextViewRequestMessage`). */
export const AGENT_CONTEXT_VIEW_REQUEST_TYPE = "agent:context_view_request";
/** Daemon -> Server message type (`AgentContextViewAvailabilityMessage`). */
export const AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE = "agent:context_view_availability";

/**
 * How long a request id stays open, from when the Server sends the request.
 * A result POST after this is refused (410). The viewer does not wait that
 * long: the Server answers the viewer `expired` when no result has started
 * within AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS. The id lives the full TTL so a
 * late POST is still told apart from an unknown id, and the whole request (a
 * body still streaming included) ends at this deadline.
 */
export const AGENT_CONTEXT_VIEW_REQUEST_TTL_MS = 60_000;

/**
 * How long the viewer waits for a result to start (well inside the request
 * TTL); after it the Server has already answered the viewer `expired`. A
 * daemon that only gets to a request after this long skips it: nobody is
 * waiting for the restore.
 */
export const AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS = 30_000;

/**
 * Upper bound on a result body in bytes AFTER decompression (32 MiB). The
 * request's `maxBytes` is at most this. The Server stops reading (and
 * inflating) once past the cap and ends the request `too_large`; the daemon
 * checks its serialized JSON against `maxBytes` first and posts `too_large`
 * itself instead of a body it knows is over.
 */
export const AGENT_CONTEXT_VIEW_MAX_BYTES = 32 * 1024 * 1024;

/** Default days a Computer keeps the send index and captured requests (a report's `retentionDays` wins). */
export const AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS = 30;

/**
 * Content encodings the result POST may use (`Content-Encoding` header;
 * absent = identity). The body is always `application/json` UTF-8.
 */
export const AGENT_CONTEXT_VIEW_RESULT_CONTENT_ENCODINGS = ["identity", "gzip"] as const;
export type AgentContextViewResultContentEncoding = (typeof AGENT_CONTEXT_VIEW_RESULT_CONTENT_ENCODINGS)[number];
export const isAgentContextViewResultContentEncoding = makeIsMember(AGENT_CONTEXT_VIEW_RESULT_CONTENT_ENCODINGS);

/**
 * Optional header on the result POST: the body's length in bytes after
 * decompression, as the daemon serialized it. The server may refuse with
 * `too_large` before sending any response header when it is over
 * `AGENT_CONTEXT_VIEW_MAX_BYTES`; it is a hint for that early refusal only,
 * and the server still counts the bytes it actually forwards against the cap.
 */
export const AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER = "x-raft-context-uncompressed-bytes";

/**
 * Route of the result POST (Server router pattern). Only the first POST for
 * a request id is accepted, whatever its body; any later POST is refused
 * (409) and changes nothing. The id is bound to the Computer it was sent to:
 * a POST with another Computer's credential is refused (404) and does not
 * consume the id.
 *
 * The Server's answer to the POST (`{ok, code}` JSON); every status is final,
 * the daemon never retries:
 * - 200 `delivered`: the viewer got the answer (a failure body included).
 * - 404 `not_found`: a malformed id, or another Computer's credential (the
 *   request stays open, nothing consumed).
 * - 409 `already_claimed`: an earlier POST for this id was accepted (the
 *   first POST claims the id, whatever its body).
 * - 409 `agent_moved`: the agent is on another Computer than the one asked.
 * - 403 `refused`: the agent is gone or the viewer may no longer view its
 *   context (checked again when the POST arrives; the viewer gets the same
 *   answer as any refusal).
 * - 410 `expired`: an unknown or expired id, no viewer waits any more, or
 *   the request reached its deadline while the body was still arriving.
 * - 413 `too_large`: over the cap (the uncompressed-bytes hint, or counted
 *   after decompression).
 * - 415 `unsupported_encoding`: a Content-Encoding other than identity or gzip.
 * - 400 `read_failed`: bad gzip, not JSON, or not a result body.
 */
export const AGENT_CONTEXT_VIEW_RESULT_ROUTE = "/internal/computer/agent-context/:requestId";

/** Path of the result POST for one request (relative to the Server URL). */
export function agentContextViewResultPath(requestId: AgentContextViewRequestId): string {
  return `/internal/computer/agent-context/${encodeURIComponent(requestId)}`;
}

/** One context-view request. Opaque; minted by the Server only. */
export type AgentContextViewRequestId = Brand<string, "AgentContextViewRequestId">;

const REQUEST_ID_PATTERN = /^ctxv_[A-Za-z0-9_-]{16,64}$/;

/** The Server's mint for a new request id. */
export function mintAgentContextViewRequestId(): AgentContextViewRequestId {
  return `ctxv_${globalThis.crypto.randomUUID().replace(/-/g, "")}` as AgentContextViewRequestId;
}

/** The only other mint: a request id received over the wire (message or route param), checked. */
export function asAgentContextViewRequestId(value: string): AgentContextViewRequestId | null {
  return REQUEST_ID_PATTERN.test(value) ? (value as AgentContextViewRequestId) : null;
}

/**
 * Why a context view could not be shown. A request the Server refuses (flag
 * off, unknown agent or message, a message that is not this agent's, a
 * viewer without access) is not a failure reason: it is answered like an
 * unknown agent (404). Who produces each reason
 * (`AGENT_CONTEXT_VIEW_FAILURE_REASON_PRODUCERS`):
 * - `no_computer` (Server): the agent runs on no Computer (none bound).
 * - `offline` (Server): the agent's Computer is not connected.
 * - `old_daemon` (Server): the Computer did not advertise
 *   `DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0`.
 * - `agent_moved` (Server, daemon): the agent is no longer on the Computer
 *   asked (Server: its machine changed before the result; daemon: the agent
 *   was migrated off this Computer).
 * - `not_found` (daemon): no retained request in the daemon's index produced
 *   that message (never ran here, retention aged out). A message that is not
 *   this agent's is refused by the Server like an unknown agent (404), never
 *   `not_found`.
 * - `expired` (Server): no result started within the Server's wait (30 s),
 *   or the request reached `AGENT_CONTEXT_VIEW_REQUEST_TTL_MS` while its body
 *   was still arriving.
 * - `unsupported_runtime` (daemon): the
 *   daemon cannot read this runtime's context.
 * - `too_large` (daemon, Server): the session file is over the daemon's
 *   source cap, has too much to replay, or ran the restore out of its heap, or
 *   the restored view is over `maxBytes` (daemon), or the received body is over `AGENT_CONTEXT_VIEW_MAX_BYTES`
 *   after decompression (Server).
 * - `read_failed` (daemon, Server): the daemon could not read or restore the
 *   source; the Server also ends a request `read_failed` when the accepted
 *   POST body does not parse (`parseAgentContextViewResultBody`).
 * - `context_mismatch` (daemon): the restored context does not match what the
 *   session recorded about the request (message count or a hash). Never shown
 *   as a best guess.
 * - `media_removed` (daemon): the runtime retried the request with media
 *   removed, and the session does not record enough to repeat that.
 * - `newer_session_format` (daemon): the session was written in a format newer
 *   than this daemon's reader.
 * - `not_recorded` (daemon): the daemon records this runtime's requests itself,
 *   and didn't record the one behind this message (the feature was off, a write
 *   failed, or the record was full).
 */
export const AGENT_CONTEXT_VIEW_FAILURE_REASONS = [
  "offline",
  "old_daemon",
  "agent_moved",
  "not_found",
  "expired",
  "unsupported_runtime",
  "too_large",
  "read_failed",
  "no_computer",
  "context_mismatch",
  "media_removed",
  "newer_session_format",
  "not_recorded",
] as const;
export type AgentContextViewFailureReason = (typeof AGENT_CONTEXT_VIEW_FAILURE_REASONS)[number];
export const isAgentContextViewFailureReason = makeIsMember(AGENT_CONTEXT_VIEW_FAILURE_REASONS);

export type AgentContextViewReasonProducer = "server" | "daemon";

/** Which side may produce each failure reason (documentation, pinned by a test). */
export const AGENT_CONTEXT_VIEW_FAILURE_REASON_PRODUCERS: Readonly<Record<AgentContextViewFailureReason, readonly AgentContextViewReasonProducer[]>> = {
  offline: ["server"],
  old_daemon: ["server"],
  agent_moved: ["server", "daemon"],
  not_found: ["daemon"],
  expired: ["server"],
  unsupported_runtime: ["daemon"],
  too_large: ["server", "daemon"],
  read_failed: ["server", "daemon"],
  no_computer: ["server"],
  context_mismatch: ["daemon"],
  media_removed: ["daemon"],
  newer_session_format: ["daemon"],
  not_recorded: ["daemon"],
};

/** The reasons a daemon may put in a failure POST body. */
export const AGENT_CONTEXT_VIEW_DAEMON_FAILURE_REASONS = [
  "agent_moved",
  "not_found",
  "unsupported_runtime",
  "too_large",
  "read_failed",
  "context_mismatch",
  "media_removed",
  "newer_session_format",
  "not_recorded",
] as const satisfies readonly AgentContextViewFailureReason[];
export type AgentContextViewDaemonFailureReason = (typeof AGENT_CONTEXT_VIEW_DAEMON_FAILURE_REASONS)[number];
export const isAgentContextViewDaemonFailureReason = makeIsMember(AGENT_CONTEXT_VIEW_DAEMON_FAILURE_REASONS);

/**
 * Why the availability report says `supported: false`.
 * - `unsupported_runtime`: this daemon has no context reader for the agent's runtime.
 * - `no_session`: the runtime is supported but the daemon has nothing
 *   retained for the agent yet (never ran here, or its index was lost).
 */
export const AGENT_CONTEXT_VIEW_UNSUPPORTED_REASONS = ["unsupported_runtime", "no_session"] as const;
export type AgentContextViewUnsupportedReason = (typeof AGENT_CONTEXT_VIEW_UNSUPPORTED_REASONS)[number];
export const isAgentContextViewUnsupportedReason = makeIsMember(AGENT_CONTEXT_VIEW_UNSUPPORTED_REASONS);

/**
 * Server -> daemon on the Computer control WebSocket, only to a daemon that
 * advertised `DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0`. The daemon answers
 * with at most one result POST (`agentContextViewResultPath(requestId)`),
 * never with a WebSocket frame; it skips a request it only gets to after
 * `AGENT_CONTEXT_VIEW_REQUEST_TTL_MS`, when any POST would be refused.
 */
export type AgentContextViewRequestMessage = {
  type: typeof AGENT_CONTEXT_VIEW_REQUEST_TYPE;
  requestId: AgentContextViewRequestId;
  agentId: string;
  /** The Raft message the agent sent; the daemon looks it up in its own index. */
  messageId: string;
  /** Cap on the uncompressed result body for this request; at most `AGENT_CONTEXT_VIEW_MAX_BYTES`. */
  maxBytes: number;
};

/**
 * Daemon -> Server, one per agent: whether a context view is possible for it
 * on this Computer. Sent after `ready` for each agent the daemon knows,
 * again whenever the answer changes, and at least every 24 hours for each
 * running agent (the Server keeps a report for 7 days). The Server keeps the
 * latest per agent.
 */
export type AgentContextViewAvailabilityMessage = {
  type: typeof AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE;
  agentId: string;
  /** Raft runtime id (`RuntimeId`), as the daemon runs the agent. */
  runtime: string;
  supported: boolean;
  /** Only with `supported: false`; absent when the daemon gave none or one this build does not know. */
  unsupportedReason?: AgentContextViewUnsupportedReason;
  /** ISO 8601: the oldest request the daemon still retains for this agent; null when none. */
  retainedSince: string | null;
  /**
   * How many days this Computer keeps the send index and captured requests
   * (configurable on the Computer; `AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS`
   * by default). Absent from a daemon that does not say; readers then use the default.
   */
  retentionDays?: number;
};

export const AGENT_CONTEXT_VIEW_PART_KINDS = ["text", "thinking", "tool_use", "tool_result", "image", "compaction"] as const;
export type AgentContextViewPartKind = (typeof AGENT_CONTEXT_VIEW_PART_KINDS)[number];

/**
 * One part of a restored message. Text fields are already redacted by the
 * daemon (`redactDiagnosticSecrets`).
 * - `thinking.text` null: the runtime kept only an encrypted or provider-redacted block.
 * - `tool_result.output`: the tool's result flattened to text; images in it
 *   become their own `image` parts.
 * - `image`: the media type and size only; image bytes never cross this contract.
 * - `compaction.text`: the summary the runtime put in place of compacted
 *   history; null when it is encrypted.
 * - `unknown`: never produced by a daemon. The parser turns a part kind this
 *   build does not know (from a newer daemon) into it, so part indexes
 *   (`trigger.partIndex`) keep pointing at the same parts.
 */
export type AgentContextViewPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string | null }
  | { kind: "tool_use"; toolName: string; toolUseId: string | null; input: JsonValue }
  | { kind: "tool_result"; toolName: string | null; toolUseId: string | null; output: string; isError: boolean }
  | { kind: "image"; mediaType: string | null; sizeBytes: number | null }
  | { kind: "compaction"; text: string | null }
  | { kind: "unknown"; originalKind: string };

export const AGENT_CONTEXT_VIEW_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export type AgentContextViewMessageRole = (typeof AGENT_CONTEXT_VIEW_MESSAGE_ROLES)[number];
export const isAgentContextViewMessageRole = makeIsMember(AGENT_CONTEXT_VIEW_MESSAGE_ROLES);

export type AgentContextViewMessage = {
  role: AgentContextViewMessageRole;
  parts: AgentContextViewPart[];
};

export type AgentContextViewTool = {
  name: string;
  description: string;
  /** The tool's input JSON Schema as the runtime declared it; null when the source does not keep it. */
  inputSchema: JsonValue | null;
};

/**
 * The `raft message send` call that produced the message: the `tool_use`
 * part at `messages[messageIndex].parts[partIndex]`. `toolUseId` repeats that
 * part's id for a cross-check. The whole `trigger` is null when the daemon
 * found the request but not the call in it.
 */
export type AgentContextViewTrigger = {
  messageIndex: number;
  partIndex: number;
  toolUseId: string | null;
};

/**
 * Whether the runtime had compacted history before this request.
 * `summary` null: it did, but the summary is not retained.
 */
export type AgentContextViewCompaction =
  | { happened: false }
  | { happened: true; summary: { kind: "text"; text: string } | { kind: "encrypted" } | null };

export const AGENT_CONTEXT_VIEW_SOURCE_KINDS = ["native", "captured"] as const;
export type AgentContextViewSourceKind = (typeof AGENT_CONTEXT_VIEW_SOURCE_KINDS)[number];
export const isAgentContextViewSourceKind = makeIsMember(AGENT_CONTEXT_VIEW_SOURCE_KINDS);

/**
 * Where the view was restored from. `native`: the runtime's own session
 * record (e.g. a JSONL transcript). `captured`: what the daemon recorded at
 * the provider request itself. `format` names the reader (e.g.
 * `claude-jsonl`), `version` that source's own version when it has one.
 */
export type AgentContextViewSource = {
  kind: AgentContextViewSourceKind;
  format: string;
  version: string | null;
};

/** Token usage of the request, as the provider reported it; each null when unknown. */
export type AgentContextViewTokens = {
  /** Input tokens not read from cache. */
  input: number | null;
  /** Input tokens read from the prompt cache. */
  cacheRead: number | null;
  /** The whole prompt: every input token, cached or not (context-window occupancy). */
  total: number | null;
};

/**
 * How far the restore was proven against the session's own record of the request.
 * - `verified`: a hash of the whole restored request (or its messages) matches
 *   the recorded one. For a `captured` source, its hashes match and the next
 *   request shows this message's send.
 * - `count_matched`: the session records no hash; the runtime's own code rebuilt
 *   the messages and their count matched, but they cannot be checked exactly,
 *   and may have been written by another version of that code.
 * Absent: neither was established. The source records no such check, or (Claude)
 * its digest did not match and the view is still shown; Kimi refuses on a mismatch.
 * A `captured` source refuses on a mismatch, and is absent when the send can't be shown.
 */
export const AGENT_CONTEXT_VIEW_VERIFICATIONS = ["verified", "count_matched"] as const;
export type AgentContextViewVerification = (typeof AGENT_CONTEXT_VIEW_VERIFICATIONS)[number];
export const isAgentContextViewVerification = makeIsMember(AGENT_CONTEXT_VIEW_VERIFICATIONS);

/**
 * The restored context of the one model request that produced a Raft message:
 * what the model was given (`system`, `tools`, `messages`) and the response
 * that carries the `raft message send` call (the last assistant message,
 * located by `trigger`).
 */
export type AgentContextView = {
  /** Raft runtime id (`RuntimeId`). */
  runtime: string;
  /** Model id as the runtime reported it for this request; null when the source does not say. */
  model: string | null;
  /** The runtime's own session id. */
  sessionId: string;
  /** ISO 8601: when the runtime sent this model request; null when the source has no time. */
  requestAt: string | null;
  /** The Raft message this view explains (the request's `messageId`). */
  messageId: string;
  tokens: AgentContextViewTokens;
  system: { text: string }[];
  tools: AgentContextViewTool[];
  messages: AgentContextViewMessage[];
  compaction: AgentContextViewCompaction;
  trigger: AgentContextViewTrigger | null;
  /** What the daemon's redaction replaced, per kind (`redactDiagnosticSecrets`). */
  redactions: DiagnosticRedactionCounts;
  source: AgentContextViewSource;
  /** Absent from an older daemon, or when nothing was established (see the type). */
  verification?: AgentContextViewVerification;
};

/**
 * Why a view is `too_large`, for the viewer. Optional on the wire: an older
 * daemon doesn't send it, and an unknown one is dropped.
 * - `session_file`: the session file is over the source cap, so it isn't read.
 * - `request`: the restored request itself is over the size cap.
 * - `restore_limit`: restoring it ran into a memory or record limit.
 */
export const AGENT_CONTEXT_VIEW_TOO_LARGE_CAUSES = ["session_file", "request", "restore_limit"] as const;
export type AgentContextViewTooLargeCause = (typeof AGENT_CONTEXT_VIEW_TOO_LARGE_CAUSES)[number];
export const isAgentContextViewTooLargeCause = makeIsMember(AGENT_CONTEXT_VIEW_TOO_LARGE_CAUSES);

/** The result POST body (daemon -> Server). */
export type AgentContextViewResultBody =
  | { ok: true; context: AgentContextView }
  | { ok: false; reason: AgentContextViewDaemonFailureReason; tooLargeCause?: AgentContextViewTooLargeCause };

/** What the Server answers the web for one view (any reason, either side's). */
export type AgentContextViewResult =
  | { ok: true; context: AgentContextView }
  | { ok: false; reason: AgentContextViewFailureReason; tooLargeCause?: AgentContextViewTooLargeCause };

// ---------------------------------------------------------------------------
// Parsers. Each takes untrusted input (a decoded frame or POST body) and
// returns a fresh value with only the known fields, or null / an error.

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function nullableIsoTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  return isIsoTime(value) ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isCount(value) ? value : undefined;
}

/** The daemon's check of an incoming `agent:context_view_request` frame. */
export function readAgentContextViewRequest(frame: unknown): AgentContextViewRequestMessage | null {
  if (!isObj(frame) || frame.type !== AGENT_CONTEXT_VIEW_REQUEST_TYPE) return null;
  const requestId = typeof frame.requestId === "string" ? asAgentContextViewRequestId(frame.requestId) : null;
  if (!requestId || !isNonEmptyString(frame.agentId) || !isNonEmptyString(frame.messageId)) return null;
  const maxBytes = frame.maxBytes;
  if (!isCount(maxBytes) || maxBytes === 0 || maxBytes > AGENT_CONTEXT_VIEW_MAX_BYTES) return null;
  return { type: AGENT_CONTEXT_VIEW_REQUEST_TYPE, requestId, agentId: frame.agentId, messageId: frame.messageId, maxBytes };
}

/**
 * The Server's check of an `agent:context_view_availability` frame. An
 * `unsupportedReason` this build does not know (or one sent with
 * `supported: true`) is dropped; the rest of the report stands.
 */
export function readAgentContextViewAvailability(frame: unknown): AgentContextViewAvailabilityMessage | null {
  if (!isObj(frame) || frame.type !== AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE) return null;
  if (!isNonEmptyString(frame.agentId) || !isNonEmptyString(frame.runtime) || typeof frame.supported !== "boolean") return null;
  const retainedSince = nullableIsoTime(frame.retainedSince);
  if (retainedSince === undefined) return null;
  const report: AgentContextViewAvailabilityMessage = {
    type: AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
    agentId: frame.agentId,
    runtime: frame.runtime,
    supported: frame.supported,
    retainedSince,
  };
  if (!frame.supported && isAgentContextViewUnsupportedReason(frame.unsupportedReason)) {
    report.unsupportedReason = frame.unsupportedReason;
  }
  // A malformed retention is dropped, not fatal: readers fall back to the default.
  if (typeof frame.retentionDays === "number" && Number.isInteger(frame.retentionDays) && frame.retentionDays > 0 && frame.retentionDays <= 3650) {
    report.retentionDays = frame.retentionDays;
  }
  return report;
}

export type AgentContextViewParse =
  | { ok: true; context: AgentContextView }
  | { ok: false; error: string };

export type AgentContextViewResultBodyParse =
  | {
      ok: true;
      body: AgentContextViewResultBody;
      /** Set when a failure body's reason was not a daemon reason this build knows; `body.reason` is then `read_failed`. */
      unknownReason?: string;
    }
  | { ok: false; error: string };

class ContextViewParseError extends Error {}

function fail(path: string): never {
  throw new ContextViewParseError(path);
}

function parsePart(raw: unknown, path: string): AgentContextViewPart {
  if (!isObj(raw) || !isNonEmptyString(raw.kind)) fail(`${path}.kind`);
  switch (raw.kind) {
    case "text":
      if (typeof raw.text !== "string") fail(`${path}.text`);
      return { kind: "text", text: raw.text };
    case "thinking": {
      const text = nullableString(raw.text);
      if (text === undefined) fail(`${path}.text`);
      return { kind: "thinking", text };
    }
    case "tool_use": {
      const toolUseId = nullableString(raw.toolUseId);
      if (!isNonEmptyString(raw.toolName)) fail(`${path}.toolName`);
      if (toolUseId === undefined) fail(`${path}.toolUseId`);
      if (!isJsonValue(raw.input)) fail(`${path}.input`);
      return { kind: "tool_use", toolName: raw.toolName, toolUseId, input: raw.input };
    }
    case "tool_result": {
      const toolName = nullableString(raw.toolName);
      const toolUseId = nullableString(raw.toolUseId);
      if (toolName === undefined) fail(`${path}.toolName`);
      if (toolUseId === undefined) fail(`${path}.toolUseId`);
      if (typeof raw.output !== "string") fail(`${path}.output`);
      if (typeof raw.isError !== "boolean") fail(`${path}.isError`);
      return { kind: "tool_result", toolName, toolUseId, output: raw.output, isError: raw.isError };
    }
    case "image": {
      const mediaType = nullableString(raw.mediaType);
      const sizeBytes = nullableCount(raw.sizeBytes);
      if (mediaType === undefined) fail(`${path}.mediaType`);
      if (sizeBytes === undefined) fail(`${path}.sizeBytes`);
      // Only type and size cross this contract; a part carrying bytes is refused.
      if ("data" in raw || "bytes" in raw || "base64" in raw) fail(`${path}.data`);
      return { kind: "image", mediaType, sizeBytes };
    }
    case "compaction": {
      const text = nullableString(raw.text);
      if (text === undefined) fail(`${path}.text`);
      return { kind: "compaction", text };
    }
    default:
      // A newer daemon's part kind (or "unknown" itself, never sent): kept as a placeholder.
      return { kind: "unknown", originalKind: raw.kind.slice(0, 64) };
  }
}

function parseCompaction(raw: unknown): AgentContextViewCompaction {
  if (!isObj(raw) || typeof raw.happened !== "boolean") fail("context.compaction.happened");
  if (!raw.happened) return { happened: false };
  const summary = raw.summary;
  if (summary === null) return { happened: true, summary: null };
  if (isObj(summary) && summary.kind === "encrypted") return { happened: true, summary: { kind: "encrypted" } };
  if (isObj(summary) && summary.kind === "text" && typeof summary.text === "string") {
    return { happened: true, summary: { kind: "text", text: summary.text } };
  }
  fail("context.compaction.summary");
}

function parseRedactions(raw: unknown): DiagnosticRedactionCounts {
  if (!isObj(raw)) fail("context.redactions");
  const counts: DiagnosticRedactionCounts = {};
  for (const [kind, count] of Object.entries(raw)) {
    if (!isCount(count)) fail(`context.redactions.${kind.slice(0, 64)}`);
    // A kind from a newer daemon is dropped: the count of known kinds stands.
    if (isDiagnosticRedactionKind(kind) && count > 0) counts[kind] = count;
  }
  return counts;
}

function parseContext(raw: unknown): AgentContextView {
  if (!isObj(raw)) fail("context");
  if (!isNonEmptyString(raw.runtime)) fail("context.runtime");
  const model = nullableString(raw.model);
  if (model === undefined) fail("context.model");
  if (!isNonEmptyString(raw.sessionId)) fail("context.sessionId");
  const requestAt = nullableIsoTime(raw.requestAt);
  if (requestAt === undefined) fail("context.requestAt");
  if (!isNonEmptyString(raw.messageId)) fail("context.messageId");

  const tokensRaw = raw.tokens;
  if (!isObj(tokensRaw)) fail("context.tokens");
  const input = nullableCount(tokensRaw.input);
  const cacheRead = nullableCount(tokensRaw.cacheRead);
  const total = nullableCount(tokensRaw.total);
  if (input === undefined) fail("context.tokens.input");
  if (cacheRead === undefined) fail("context.tokens.cacheRead");
  if (total === undefined) fail("context.tokens.total");

  if (!Array.isArray(raw.system)) fail("context.system");
  const system = raw.system.map((entry, index) => {
    if (!isObj(entry) || typeof entry.text !== "string") fail(`context.system[${index}].text`);
    return { text: entry.text };
  });

  if (!Array.isArray(raw.tools)) fail("context.tools");
  const tools = raw.tools.map((entry, index): AgentContextViewTool => {
    const path = `context.tools[${index}]`;
    if (!isObj(entry) || !isNonEmptyString(entry.name)) fail(`${path}.name`);
    if (typeof entry.description !== "string") fail(`${path}.description`);
    const inputSchema = entry.inputSchema;
    if (inputSchema !== null && !isJsonValue(inputSchema)) fail(`${path}.inputSchema`);
    return { name: entry.name, description: entry.description, inputSchema };
  });

  if (!Array.isArray(raw.messages)) fail("context.messages");
  const messages = raw.messages.map((entry, index): AgentContextViewMessage => {
    const path = `context.messages[${index}]`;
    if (!isObj(entry) || !isAgentContextViewMessageRole(entry.role)) fail(`${path}.role`);
    if (!Array.isArray(entry.parts)) fail(`${path}.parts`);
    return { role: entry.role, parts: entry.parts.map((part, partIndex) => parsePart(part, `${path}.parts[${partIndex}]`)) };
  });

  let trigger: AgentContextViewTrigger | null = null;
  if (raw.trigger !== null) {
    const t = raw.trigger;
    if (!isObj(t) || !isCount(t.messageIndex) || !isCount(t.partIndex)) fail("context.trigger");
    const toolUseId = nullableString(t.toolUseId);
    if (toolUseId === undefined) fail("context.trigger.toolUseId");
    const part = messages[t.messageIndex]?.parts[t.partIndex];
    // The trigger must name a tool call in this view (the `raft message send`).
    if (!part || part.kind !== "tool_use") fail("context.trigger.partIndex");
    if (toolUseId !== null && part.toolUseId !== toolUseId) fail("context.trigger.toolUseId");
    trigger = { messageIndex: t.messageIndex, partIndex: t.partIndex, toolUseId };
  }

  const sourceRaw = raw.source;
  if (!isObj(sourceRaw) || !isAgentContextViewSourceKind(sourceRaw.kind)) fail("context.source.kind");
  if (!isNonEmptyString(sourceRaw.format)) fail("context.source.format");
  const version = nullableString(sourceRaw.version);
  if (version === undefined) fail("context.source.version");

  return {
    runtime: raw.runtime,
    model,
    sessionId: raw.sessionId,
    requestAt,
    messageId: raw.messageId,
    tokens: { input, cacheRead, total },
    system,
    tools,
    messages,
    compaction: parseCompaction(raw.compaction),
    trigger,
    redactions: parseRedactions(raw.redactions),
    source: { kind: sourceRaw.kind, format: sourceRaw.format, version },
    ...(isAgentContextViewVerification(raw.verification) ? { verification: raw.verification } : {}),
  };
}

function guarded<T>(run: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof ContextViewParseError) return { ok: false, error: `invalid ${error.message}` };
    throw error;
  }
}

/** Check one `AgentContextView` (e.g. the web reading the Server's answer). */
export function parseAgentContextView(raw: unknown): AgentContextViewParse {
  const parsed = guarded(() => parseContext(raw));
  return parsed.ok ? { ok: true, context: parsed.value } : parsed;
}

/**
 * The Server's check of a decoded result POST body. A failure body with a
 * reason this build does not know, or a Server-only reason, becomes
 * `read_failed` with `unknownReason` set (truncated to 64 chars) rather than
 * being refused, so a newer daemon's reason still ends the request at once.
 */
export function parseAgentContextViewResultBody(raw: unknown): AgentContextViewResultBodyParse {
  if (!isObj(raw) || typeof raw.ok !== "boolean") return { ok: false, error: "invalid ok" };
  if (!raw.ok) {
    if (isAgentContextViewDaemonFailureReason(raw.reason)) {
      const tooLargeCause = raw.reason === "too_large" && isAgentContextViewTooLargeCause(raw.tooLargeCause) ? raw.tooLargeCause : null;
      return { ok: true, body: { ok: false, reason: raw.reason, ...(tooLargeCause ? { tooLargeCause } : {}) } };
    }
    if (!isNonEmptyString(raw.reason)) return { ok: false, error: "invalid reason" };
    return { ok: true, body: { ok: false, reason: "read_failed" }, unknownReason: raw.reason.slice(0, 64) };
  }
  const parsed = guarded(() => parseContext(raw.context));
  return parsed.ok ? { ok: true, body: { ok: true, context: parsed.value } } : parsed;
}
