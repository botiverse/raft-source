// ---------------------------------------------------------------------------
// The agent_event_tail attachment of a feedback report (task #1230).
//
// A bounded, whitelisted projection of ONE agent's daemon trace events in the
// 15 minutes before the report, uploaded as its own object after the
// transcript result frame was sent. Everything a reader may say about it is
// decided here:
//
// - the per-event-kind attribute table (closed key sets, enums, ids) — no
//   free-form attributes, nothing that is not in the table;
// - one strict parser (`parseFeedbackAgentEventTail`) that is the only
//   definition of a readable object, with every count relation enforced;
// - the reader rules a consumer (Lens) applies: identity correlation, raw
//   download, and what an empty event list may be described as.
//
// v1 makes NO coverage claim: `coverage.status` is always "unknown" and the
// covered range is null. Input cost is bounded by independent scan caps; when
// a scan stops early the object says so (`scan.status: "incomplete"`), and all
// counts then describe only the scanned part.
// ---------------------------------------------------------------------------
import { readFeedbackTranscriptRequestId } from "./feedbackTranscriptOutcome";

export const FEEDBACK_AGENT_EVENT_TAIL_TYPE = "feedback_agent_event_tail";
export const FEEDBACK_AGENT_EVENT_TAIL_SCHEMA_VERSION = 1;
/** Newest matched events kept (count cap, applied before the byte cap). */
export const FEEDBACK_AGENT_EVENT_TAIL_MAX_EVENTS = 200;
/** Cap on the WHOLE decompressed UTF-8 JSON object, metadata included. */
export const FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES = 32 * 1024;
/** Gzip headroom for the signed upload size (gzip can exceed its input slightly). */
export const FEEDBACK_AGENT_EVENT_TAIL_MAX_UPLOAD_BYTES = FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES + 4096;
/** The window: report time − 15 min … report time. */
export const FEEDBACK_AGENT_EVENT_TAIL_WINDOW_MS = 15 * 60 * 1000;
/** Server-owned object key prefix: `feedback-agent-event-tails/<serverId>/<machineId>/<uploadId>.json.gz`. */
export const FEEDBACK_AGENT_EVENT_TAIL_OBJECT_KEY_PREFIX = "feedback-agent-event-tails/";

/** Why a collection produced no events/counts at all. */
export const FEEDBACK_AGENT_EVENT_TAIL_FAILURES = [
  /** No local trace corpus on this daemon (local tracing disabled / no machine dir). */
  "corpus_unavailable",
  /** The trace directory could not be listed. */
  "corpus_unreadable",
  /** Even with zero events the object exceeds the byte cap. */
  "over_byte_cap",
  /** The projection threw (a bug); nothing about events is claimed. */
  "projection_error",
] as const;
export type FeedbackAgentEventTailFailure = (typeof FEEDBACK_AGENT_EVENT_TAIL_FAILURES)[number];

/** Why the input scan stopped before every listed file was read. */
export const FEEDBACK_AGENT_EVENT_TAIL_SCAN_STOP_REASONS = [
  /** `scan.maxFiles` files were attempted. */
  "max_files",
  /** The next file would exceed `scan.maxBytes` read bytes. */
  "max_bytes",
  /** The scan's own time budget elapsed (checked between files AND inside a file). */
  "time_budget",
  /** Another tail scan held the daemon's single-flight scan slot for this scan's whole time budget; nothing was read. */
  "busy",
] as const;
export type FeedbackAgentEventTailScanStopReason = (typeof FEEDBACK_AGENT_EVENT_TAIL_SCAN_STOP_REASONS)[number];

// ---------------------------------------------------------------------------
// The per-event-kind attribute table (v1).
// ---------------------------------------------------------------------------

export type AgentEventTailAttrSpec =
  /** Closed set; any other value is withheld (null) and counted invalid. */
  | { kind: "enum"; values: readonly string[] }
  /** Open family; known values pass, any other string becomes "other" (not counted invalid). */
  | { kind: "enum_or_other"; values: readonly string[] }
  /** Non-negative safe integer. */
  | { kind: "count" }
  /** Safe integer (any sign). */
  | { kind: "integer" }
  | { kind: "boolean" }
  /** Opaque daemon/server-minted id: 1–128 chars of [A-Za-z0-9._:-]. */
  | { kind: "id" }
  /** POSIX signal name: ^SIG[A-Z0-9]{1,10}$. */
  | { kind: "signal" }
  /** `[recycled_]<base>[_with_memory]` with base from the closed prompt-source list. */
  | { kind: "runtime_input_source" };

/** Where an output attribute is read from in the local trace record. */
export interface AgentEventTailAttrSource {
  spec: AgentEventTailAttrSpec;
  /** Source attribute keys, first present wins; `@status` / `@duration_ms` read the span record's own fields. */
  from: readonly string[];
}

export interface AgentEventTailEventSpec {
  /** The local trace record type this name is written as. */
  record: "event" | "span";
  attrs: Readonly<Record<string, AgentEventTailAttrSource>>;
}

const EXIT_REASONS = [
  "explicit_stop", "silent_stop", "cold_idle_recycle", "clean_exit_deferred", "cold_start_failed",
  "recoverable_error_no_wake", "provider_stream_failure", "startup_timeout", "startup_request_error", "nonrecoverable_crash",
] as const;
const VISIBLE_CONSUMED_SOURCES = [
  "agent_api_inbox_check", "agent_api_history", "agent_api_events_local", "agent_api_events_server", "agent_api_send_commit",
  "spawn_wake_message", "spawn_resume_catchup_inbox", "spawn_starting_inbox_update",
  "stdin_thread_context_delivery", "busy_stdin_notification", "stdin_idle_delivery", "stdin_busy_delivery",
] as const;
const TURN_REASONS = [
  "spawn", "stdin-idle-delivery", "runtime-profile", "runtime-progress", "app-inbox-notice",
  "runtime-error-backoff-idle-delivery", "session-ready-delivery-retry",
] as const;
export const AGENT_EVENT_TAIL_RUNTIME_INPUT_SOURCE_BASES = [
  "runtime_profile_control", "runtime_profile_control_message", "resume_prompt", "wake_inbox_update", "wake_thread_context",
  "transient_wake_message", "resume_catchup_inbox", "starting_thread_context", "starting_inbox_update",
  "resume_unread_summary", "resume_empty", "cold_start",
] as const;

const count = (...from: string[]): AgentEventTailAttrSource => ({ spec: { kind: "count" }, from });
const bool = (...from: string[]): AgentEventTailAttrSource => ({ spec: { kind: "boolean" }, from });
const id = (...from: string[]): AgentEventTailAttrSource => ({ spec: { kind: "id" }, from });
const LAUNCH_ID = id("launchId", "launch_id");

// Deliberately absent, because the local trace sink never writes them (pinned
// by the daemon's real-sink test): `wake_message_transient` (a `message`
// segment is content-like) and `session_id_present` (superseded by the sink's
// own `session_id_hash_present`).
const START_ATTRS = {
  wake_message_present: bool("wake_message_present"),
  resume_messages_count: count("resume_messages_count"),
  unread_channels_count: count("unread_channels_count"),
  resume_prompt_present: bool("resume_prompt_present"),
  launchId: LAUNCH_ID,
  start_dispatch_id: id("start_dispatch_id"),
} as const;

export const FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS = {
  "daemon.agent.inbox.dropped_on_exit": {
    record: "event",
    attrs: {
      exit_reason: { spec: { kind: "enum", values: EXIT_REASONS }, from: ["exit_reason"] },
      dropped_count: count("dropped_count"),
      expected: bool("expected"),
      launchId: LAUNCH_ID,
    },
  },
  "daemon.agent.inbox.visible_consumed": {
    record: "event",
    attrs: {
      source: { spec: { kind: "enum_or_other", values: VISIBLE_CONSUMED_SOURCES }, from: ["consume_source", "source"] },
      messages_count: count("messages_count"),
      already_seen_count: count("already_seen_count"),
      suppressed_pending_count: count("suppressed_pending_count"),
    },
  },
  "daemon.agent.model_seen.reported": {
    record: "event",
    attrs: { conversations_count: count("conversations_count"), messages_count: count("messages_count"), launchId: LAUNCH_ID },
  },
  "daemon.agent.start.requested": { record: "event", attrs: START_ATTRS },
  "daemon.agent.start.ignored": {
    record: "event",
    attrs: { ...START_ATTRS, reason: { spec: { kind: "enum", values: ["already_running", "already_starting", "already_queued"] }, from: ["reason"] } },
  },
  "daemon.agent.spawn.started": { record: "event", attrs: START_ATTRS },
  "daemon.runtime.turn": {
    record: "span",
    attrs: {
      reason: { spec: { kind: "enum_or_other", values: TURN_REASONS }, from: ["reason"] },
      status: { spec: { kind: "enum", values: ["ok", "error", "cancelled"] }, from: ["@status"] },
      duration_ms: count("@duration_ms"),
      runtime_input_source: { spec: { kind: "runtime_input_source" }, from: ["runtime_input_source"] },
      runtime_input_session_present: bool("runtime_input_session_present"),
      runtime_input_resume_prompt_present: bool("runtime_input_resume_prompt_present"),
      runtime_input_unread_channels_count: count("runtime_input_unread_channels_count"),
      launchId: LAUNCH_ID,
    },
  },
  "daemon.agent.wake_recycle": {
    record: "event",
    attrs: { reason: { spec: { kind: "enum", values: ["cold_gap_large_context"] }, from: ["reason"] } },
  },
  "daemon.runtime.process.exit": {
    record: "event",
    attrs: {
      exit_code: { spec: { kind: "integer" }, from: ["exit_code"] },
      exit_signal: { spec: { kind: "signal" }, from: ["exit_signal"] },
      launchId: LAUNCH_ID,
    },
  },
} as const satisfies Record<string, AgentEventTailEventSpec>;

export type AgentEventTailEventName = keyof typeof FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS;
export const FEEDBACK_AGENT_EVENT_TAIL_EVENT_NAMES = Object.keys(FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS) as AgentEventTailEventName[];

function isEventName(value: unknown): value is AgentEventTailEventName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS, value);
}

function specOf(name: AgentEventTailEventName): AgentEventTailEventSpec {
  return FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS[name];
}

export type AgentEventTailAttrValue = string | number | boolean | null;

export interface FeedbackAgentEventTailEvent {
  name: AgentEventTailEventName;
  /** Event time, or a span's start time. Canonical ISO UTC with ms. */
  at: string;
  /** Exactly the table's key set for `name`. `null` = absent in the source record or withheld. */
  attrs: Record<string, AgentEventTailAttrValue>;
}

const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{1,10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRuntimeInputSource(value: string): boolean {
  let base = value;
  if (base.startsWith("recycled_")) base = base.slice("recycled_".length);
  if (base.endsWith("_with_memory")) base = base.slice(0, -"_with_memory".length);
  return (AGENT_EVENT_TAIL_RUNTIME_INPUT_SOURCE_BASES as readonly string[]).includes(base);
}

/** Validate one value against its spec. `undefined` = invalid (withheld). */
function validateAttr(spec: AgentEventTailAttrSpec, value: unknown): AgentEventTailAttrValue | undefined {
  switch (spec.kind) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? value : undefined;
    case "enum_or_other":
      if (typeof value !== "string") return undefined;
      return spec.values.includes(value) ? value : "other";
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "id":
      return typeof value === "string" && OPAQUE_ID_RE.test(value) ? value : undefined;
    case "signal":
      return typeof value === "string" && SIGNAL_RE.test(value) ? value : undefined;
    case "runtime_input_source":
      return typeof value === "string" && isRuntimeInputSource(value) ? value : undefined;
  }
}

/** A value a strict reader accepts for this spec (the projection's own output set). */
function isStoredAttr(spec: AgentEventTailAttrSpec, value: unknown): boolean {
  if (value === null) return true;
  if (spec.kind === "enum_or_other") return value === "other" || (typeof value === "string" && spec.values.includes(value));
  return validateAttr(spec, value) === value;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isCanonicalInstant(value: unknown): value is string {
  return typeof value === "string" && canonicalInstant(value) === value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Projection: one parsed local trace record → exactly one bucket.
// ---------------------------------------------------------------------------

export interface AgentEventTailWindow {
  requestedFrom: string;
  requestedTo: string;
}

export interface FeedbackAgentEventTailCounts {
  /** Parsed JSONL records (events and spans). Excludes `unparseable`. */
  recordsRead: number;
  /** Lines that failed JSON.parse; NOT in recordsRead. */
  unparseable: number;
  undatable: number;
  outsideWindow: number;
  notWhitelisted: number;
  /** Whitelisted name, no agent id (or conflicting `agentId`/`agent_id`). */
  unattributed: number;
  otherAgent: number;
  matched: number;
  emitted: number;
  /** Oldest matched dropped by the count cap: max(0, matched − 200). */
  overCount: number;
  /** Further-oldest dropped so the whole object fits the byte cap. */
  overBytes: number;
  /** Attribute VALUES in emitted events that failed validation (stored as null). */
  attrInvalidValues: number;
  /** Emitted EVENTS with at least one such value. */
  eventsWithInvalidAttrs: number;
}

interface Projected {
  event: FeedbackAgentEventTailEvent;
  invalidValues: number;
  atMs: number;
  seq: number;
}

/**
 * Accumulates parsed trace records for one agent and window. Each record
 * lands in exactly one bucket, assigned in order: undatable → outsideWindow →
 * notWhitelisted → unattributed → otherAgent → matched.
 */
export class AgentEventTailAccumulator {
  readonly agentId: string;
  readonly window: AgentEventTailWindow;
  private readonly fromMs: number;
  private readonly toMs: number;
  private readonly matchedEvents: Projected[] = [];
  readonly counts = { recordsRead: 0, unparseable: 0, undatable: 0, outsideWindow: 0, notWhitelisted: 0, unattributed: 0, otherAgent: 0 };

  constructor(input: { agentId: string; window: AgentEventTailWindow }) {
    this.agentId = input.agentId;
    this.window = input.window;
    this.fromMs = Date.parse(input.window.requestedFrom);
    this.toMs = Date.parse(input.window.requestedTo);
  }

  addUnparseable(): void {
    this.counts.unparseable += 1;
  }

  addRecord(raw: unknown): void {
    this.counts.recordsRead += 1;
    const record = asObject(raw);
    const type = record?.type === "span" ? "span" : "event";
    const at = canonicalInstant(type === "span" ? record?.start_time : record?.time);
    if (!record || at === null) {
      this.counts.undatable += 1;
      return;
    }
    const atMs = Date.parse(at);
    if (atMs < this.fromMs || atMs > this.toMs) {
      this.counts.outsideWindow += 1;
      return;
    }
    const name = record.name;
    if (!isEventName(name) || specOf(name).record !== type) {
      this.counts.notWhitelisted += 1;
      return;
    }
    const attrs = asObject(record.attrs) ?? {};
    const camel = typeof attrs.agentId === "string" ? attrs.agentId : null;
    const snake = typeof attrs.agent_id === "string" ? attrs.agent_id : null;
    if ((camel === null && snake === null) || (camel !== null && snake !== null && camel !== snake)) {
      this.counts.unattributed += 1;
      return;
    }
    if ((camel ?? snake) !== this.agentId) {
      this.counts.otherAgent += 1;
      return;
    }
    const out: Record<string, AgentEventTailAttrValue> = {};
    let invalidValues = 0;
    for (const [key, source] of Object.entries(specOf(name).attrs)) {
      let value: unknown;
      for (const from of source.from) {
        const candidate = from === "@status" ? record.status : from === "@duration_ms" ? record.duration_ms : attrs[from];
        if (candidate !== undefined && candidate !== null) {
          value = candidate;
          break;
        }
      }
      if (value === undefined) {
        out[key] = null;
        continue;
      }
      const validated = validateAttr(source.spec, value);
      if (validated === undefined) {
        out[key] = null;
        invalidValues += 1;
      } else {
        out[key] = validated;
      }
    }
    this.matchedEvents.push({ event: { name, at, attrs: out }, invalidValues, atMs, seq: this.matchedEvents.length });
  }

  /** Matched events, oldest → newest (stable for equal times). */
  matched(): readonly Projected[] {
    return [...this.matchedEvents].sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
  }
}

// ---------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------

export interface FeedbackAgentEventTailScan {
  /** "incomplete" ⇔ stopReason !== null || filesUnreadable > 0. All counts then cover only the scanned part. */
  status: "complete" | "incomplete";
  stopReason: FeedbackAgentEventTailScanStopReason | null;
  /** `daemon-trace-*.jsonl` files listed in the trace directory. */
  filesListed: number;
  /** Files read and parsed. */
  filesScanned: number;
  /** Files whose read failed (attempted, not parsed). */
  filesUnreadable: number;
  /** Bytes read from scanned files. */
  bytesScanned: number;
  /** The caps this daemon applied. */
  maxFiles: number;
  maxBytes: number;
}

interface FeedbackAgentEventTailBase {
  type: typeof FEEDBACK_AGENT_EVENT_TAIL_TYPE;
  schema_version: typeof FEEDBACK_AGENT_EVENT_TAIL_SCHEMA_VERSION;
  feedbackReportId: string;
  agentId: string;
  requestId: string;
  window: AgentEventTailWindow;
  /** v1: always unknown; no covered range is ever claimed. */
  coverage: { status: "unknown"; coveredFrom: null; coveredTo: null };
  completeness: "unknown";
}

export interface FeedbackAgentEventTailOk extends FeedbackAgentEventTailBase {
  collection: { status: "ok"; failure: null };
  scan: FeedbackAgentEventTailScan;
  counts: FeedbackAgentEventTailCounts;
  truncated: boolean;
  events: FeedbackAgentEventTailEvent[];
}

/** A failure object carries NO scan, counts, truncated or events: all of them are unknown. */
export interface FeedbackAgentEventTailFailed extends FeedbackAgentEventTailBase {
  collection: { status: "failed"; failure: FeedbackAgentEventTailFailure };
}

export type FeedbackAgentEventTail = FeedbackAgentEventTailOk | FeedbackAgentEventTailFailed;

export type FeedbackAgentEventTailBuildResult =
  | { ok: true; envelope: FeedbackAgentEventTail; json: string; bytes: number }
  /** Even the failure object exceeds the cap: nothing may be uploaded. */
  | { ok: false; reason: "over_byte_cap"; bytes: number };

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

interface Identity {
  feedbackReportId: string;
  agentId: string;
  requestId: string;
  window: AgentEventTailWindow;
}

function base(input: Identity): FeedbackAgentEventTailBase {
  return {
    type: FEEDBACK_AGENT_EVENT_TAIL_TYPE,
    schema_version: FEEDBACK_AGENT_EVENT_TAIL_SCHEMA_VERSION,
    feedbackReportId: input.feedbackReportId,
    agentId: input.agentId,
    requestId: input.requestId,
    window: { requestedFrom: input.window.requestedFrom, requestedTo: input.window.requestedTo },
    coverage: { status: "unknown", coveredFrom: null, coveredTo: null },
    completeness: "unknown",
  };
}

export function buildFailedFeedbackAgentEventTail(
  input: Identity & { failure: FeedbackAgentEventTailFailure; maxBytes?: number },
): FeedbackAgentEventTailBuildResult {
  const envelope: FeedbackAgentEventTailFailed = { ...base(input), collection: { status: "failed", failure: input.failure } };
  const json = JSON.stringify(envelope);
  const bytes = utf8Bytes(json);
  if (bytes > (input.maxBytes ?? FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES)) return { ok: false, reason: "over_byte_cap", bytes };
  parseFeedbackAgentEventTail(envelope, { maxBytes: input.maxBytes });
  return { ok: true, envelope, json, bytes };
}

/**
 * Build the object under the count cap and then the byte cap (whole object,
 * metadata included). Oldest events are dropped first; a contiguous newest
 * suffix is kept. If zero events still exceed the byte cap, the result is the
 * `over_byte_cap` failure object (never an emptied ok object).
 */
export function buildBoundedFeedbackAgentEventTail(
  input: Identity & { scan: FeedbackAgentEventTailScan; accumulator: AgentEventTailAccumulator; maxBytes?: number },
): FeedbackAgentEventTailBuildResult {
  const maxBytes = input.maxBytes ?? FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES;
  // Fixed, not a parameter: the parser defines overCount = max(0, matched − 200).
  const maxEvents = FEEDBACK_AGENT_EVENT_TAIL_MAX_EVENTS;
  const matched = input.accumulator.matched();
  const overCount = Math.max(0, matched.length - maxEvents);
  const afterCount = matched.slice(overCount);
  const c = input.accumulator.counts;
  const measure = (keep: number) => {
    const kept = afterCount.slice(afterCount.length - keep);
    const withInvalid = kept.filter((p) => p.invalidValues > 0);
    const overBytes = afterCount.length - keep;
    const envelope: FeedbackAgentEventTailOk = {
      ...base(input),
      collection: { status: "ok", failure: null },
      scan: { ...input.scan },
      counts: {
        recordsRead: c.recordsRead,
        unparseable: c.unparseable,
        undatable: c.undatable,
        outsideWindow: c.outsideWindow,
        notWhitelisted: c.notWhitelisted,
        unattributed: c.unattributed,
        otherAgent: c.otherAgent,
        matched: matched.length,
        emitted: kept.length,
        overCount,
        overBytes,
        attrInvalidValues: withInvalid.reduce((sum, p) => sum + p.invalidValues, 0),
        eventsWithInvalidAttrs: withInvalid.length,
      },
      truncated: overCount + overBytes > 0,
      events: kept.map((p) => p.event),
    };
    const json = JSON.stringify(envelope);
    return { ok: true as const, envelope, json, bytes: utf8Bytes(json) };
  };
  let fits = measure(afterCount.length);
  if (fits.bytes > maxBytes) {
    const none = measure(0);
    if (none.bytes > maxBytes) {
      return buildFailedFeedbackAgentEventTail({ ...input, failure: "over_byte_cap", maxBytes });
    }
    fits = none;
    let lo = 0;
    let hi = afterCount.length;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = measure(mid);
      if (candidate.bytes <= maxBytes) {
        lo = mid;
        fits = candidate;
      } else {
        hi = mid;
      }
    }
  }
  // The producer's own output must satisfy the consumer contract.
  parseFeedbackAgentEventTail(fits.envelope, { maxBytes });
  return fits;
}

// ---------------------------------------------------------------------------
// The strict parser: the only definition of a readable object.
// ---------------------------------------------------------------------------

const BASE_KEYS = ["type", "schema_version", "feedbackReportId", "agentId", "requestId", "window", "collection", "coverage", "completeness"] as const;
const OK_KEYS = [...BASE_KEYS, "scan", "counts", "truncated", "events"] as const;
const SCAN_KEYS = ["status", "stopReason", "filesListed", "filesScanned", "filesUnreadable", "bytesScanned", "maxFiles", "maxBytes"] as const;
const COUNT_KEYS = [
  "recordsRead", "unparseable", "undatable", "outsideWindow", "notWhitelisted", "unattributed", "otherAgent",
  "matched", "emitted", "overCount", "overBytes", "attrInvalidValues", "eventsWithInvalidAttrs",
] as const;

function fail(message: string): never {
  throw new Error(`agent event tail: ${message}`);
}

function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  const obj = asObject(value);
  if (!obj) fail(`${what} must be a JSON object`);
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) fail(`${what} has keys ${actual.join(",")}, expected ${expected.join(",")}`);
  return obj;
}

function nonNegInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail(`${what} must be a non-negative integer`);
  return value;
}

/**
 * Strict parser. Rejects unknown/missing keys at every level, any value
 * outside the table, and every violated invariant:
 *
 * - collection ok ⇔ failure null; ok ⇒ scan/counts/truncated/events present;
 *   failed ⇒ none of them;
 * - window.requestedTo − window.requestedFrom = 15 min exactly, canonical ISO;
 * - coverage = {unknown, null, null}; completeness = unknown;
 * - recordsRead = undatable + outsideWindow + notWhitelisted + unattributed + otherAgent + matched;
 * - matched = emitted + overCount + overBytes; overCount = max(0, matched − 200);
 * - truncated ⇔ overCount + overBytes > 0; emitted = events.length ≤ 200;
 * - eventsWithInvalidAttrs ≤ emitted; attrInvalidValues ≥ eventsWithInvalidAttrs;
 *   attrInvalidValues > 0 ⇔ eventsWithInvalidAttrs > 0;
 * - scan: incomplete ⇔ stopReason ≠ null ∨ filesUnreadable > 0;
 *   filesScanned + filesUnreadable ≤ min(filesListed, maxFiles);
 *   complete ⇒ filesScanned = filesListed; bytesScanned ≤ maxBytes;
 *   (recordsRead + unparseable) > 0 ⇒ filesScanned > 0;
 * - events sorted by `at`, each within the window, exact per-kind key set;
 * - the serialized object ≤ 32 KiB (whole object).
 */
export function parseFeedbackAgentEventTail(raw: unknown, opts: { maxBytes?: number } = {}): FeedbackAgentEventTail {
  const maxBytes = opts.maxBytes ?? FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES;
  const top = asObject(raw);
  if (!top) fail("must be a JSON object");
  if (top.type !== FEEDBACK_AGENT_EVENT_TAIL_TYPE) fail("type is invalid");
  if (top.schema_version !== FEEDBACK_AGENT_EVENT_TAIL_SCHEMA_VERSION) fail("schema_version is unsupported");
  const collection = exactKeys(top.collection, ["status", "failure"], "collection");
  const ok = collection.status === "ok";
  if (ok) {
    if (collection.failure !== null) fail("collection ok must have failure null");
  } else if (collection.status === "failed") {
    if (!(FEEDBACK_AGENT_EVENT_TAIL_FAILURES as readonly unknown[]).includes(collection.failure)) fail("failed collection needs a failure from the enum");
  } else {
    fail("collection.status is invalid");
  }
  exactKeys(top, ok ? OK_KEYS : BASE_KEYS, "object");
  if (typeof top.feedbackReportId !== "string" || !UUID_RE.test(top.feedbackReportId)) fail("feedbackReportId must be a UUID");
  if (typeof top.agentId !== "string" || !UUID_RE.test(top.agentId)) fail("agentId must be a UUID");
  if (readFeedbackTranscriptRequestId(top.requestId) === null) fail("requestId must be a valid request id");
  const window = exactKeys(top.window, ["requestedFrom", "requestedTo"], "window");
  if (!isCanonicalInstant(window.requestedFrom) || !isCanonicalInstant(window.requestedTo)) fail("window timestamps must be canonical ISO");
  const fromMs = Date.parse(window.requestedFrom);
  const toMs = Date.parse(window.requestedTo);
  if (toMs - fromMs !== FEEDBACK_AGENT_EVENT_TAIL_WINDOW_MS) fail("window must be exactly requestedTo − 15 min … requestedTo");
  const coverage = exactKeys(top.coverage, ["status", "coveredFrom", "coveredTo"], "coverage");
  if (coverage.status !== "unknown" || coverage.coveredFrom !== null || coverage.coveredTo !== null) fail("v1 coverage must be unknown with a null range");
  if (top.completeness !== "unknown") fail("completeness must be unknown");

  if (ok) {
    const scan = exactKeys(top.scan, SCAN_KEYS, "scan");
    const listed = nonNegInt(scan.filesListed, "scan.filesListed");
    const scanned = nonNegInt(scan.filesScanned, "scan.filesScanned");
    const unreadable = nonNegInt(scan.filesUnreadable, "scan.filesUnreadable");
    const bytesScanned = nonNegInt(scan.bytesScanned, "scan.bytesScanned");
    const maxFiles = nonNegInt(scan.maxFiles, "scan.maxFiles");
    const scanMaxBytes = nonNegInt(scan.maxBytes, "scan.maxBytes");
    if (maxFiles === 0 || scanMaxBytes === 0) fail("scan caps must be positive");
    if (scan.stopReason !== null && !(FEEDBACK_AGENT_EVENT_TAIL_SCAN_STOP_REASONS as readonly unknown[]).includes(scan.stopReason)) fail("scan.stopReason is invalid");
    const incomplete = scan.stopReason !== null || unreadable > 0;
    if (scan.status !== (incomplete ? "incomplete" : "complete")) fail("scan.status disagrees with stopReason/filesUnreadable");
    if (scanned + unreadable > Math.min(listed, maxFiles)) fail("scan attempted more files than listed or allowed");
    if (!incomplete && scanned !== listed) fail("a complete scan reads every listed file");
    if (bytesScanned > scanMaxBytes) fail("scan.bytesScanned exceeds scan.maxBytes");
    if (scanned === 0 && bytesScanned !== 0) fail("bytes scanned without a scanned file");

    const counts = exactKeys(top.counts, COUNT_KEYS, "counts");
    const n = Object.fromEntries(COUNT_KEYS.map((k) => [k, nonNegInt(counts[k], `counts.${k}`)])) as Record<(typeof COUNT_KEYS)[number], number>;
    if (n.recordsRead + n.unparseable > 0 && scanned === 0) fail("records read but no file scanned");
    if (n.recordsRead !== n.undatable + n.outsideWindow + n.notWhitelisted + n.unattributed + n.otherAgent + n.matched) fail("recordsRead ≠ sum of its buckets");
    if (n.matched !== n.emitted + n.overCount + n.overBytes) fail("matched ≠ emitted + overCount + overBytes");
    if (n.overCount !== Math.max(0, n.matched - FEEDBACK_AGENT_EVENT_TAIL_MAX_EVENTS)) fail("overCount must be max(0, matched − 200)");
    if (top.truncated !== (n.overCount + n.overBytes > 0)) fail("truncated disagrees with overCount/overBytes");
    if (n.eventsWithInvalidAttrs > n.emitted) fail("eventsWithInvalidAttrs > emitted");
    if (n.attrInvalidValues < n.eventsWithInvalidAttrs) fail("attrInvalidValues < eventsWithInvalidAttrs");
    if ((n.attrInvalidValues > 0) !== (n.eventsWithInvalidAttrs > 0)) fail("attrInvalidValues and eventsWithInvalidAttrs disagree on zero");
    if (!Array.isArray(top.events)) fail("events must be an array");
    if (top.events.length !== n.emitted || n.emitted > FEEDBACK_AGENT_EVENT_TAIL_MAX_EVENTS) fail("emitted must equal events.length (≤ 200)");
    let prevMs = -Infinity;
    for (const [i, rawEvent] of top.events.entries()) {
      const e = exactKeys(rawEvent, ["name", "at", "attrs"], `events[${i}]`);
      if (!isEventName(e.name)) fail(`events[${i}].name is not whitelisted`);
      if (!isCanonicalInstant(e.at)) fail(`events[${i}].at must be canonical ISO`);
      const atMs = Date.parse(e.at);
      if (atMs < fromMs || atMs > toMs) fail(`events[${i}].at is outside the window`);
      if (atMs < prevMs) fail("events must be sorted oldest → newest");
      prevMs = atMs;
      const spec = specOf(e.name);
      const attrs = exactKeys(e.attrs, Object.keys(spec.attrs), `events[${i}].attrs`);
      for (const [key, source] of Object.entries(spec.attrs)) {
        if (!isStoredAttr(source.spec, attrs[key])) fail(`events[${i}].attrs.${key} is outside its spec`);
      }
    }
    if (n.attrInvalidValues > top.events.reduce((sum: number, e) => sum + Object.values((e as FeedbackAgentEventTailEvent).attrs).filter((v) => v === null).length, 0)) {
      fail("attrInvalidValues exceeds the null attribute values present");
    }
  }
  const json = JSON.stringify(top);
  if (utf8Bytes(json) > maxBytes) fail(`object exceeds ${maxBytes} bytes`);
  return top as unknown as FeedbackAgentEventTail;
}

/** Parse the decompressed object text: the byte cap applies to the text as stored. */
export function parseFeedbackAgentEventTailJson(text: string, opts: { maxBytes?: number } = {}): FeedbackAgentEventTail {
  const maxBytes = opts.maxBytes ?? FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES;
  if (utf8Bytes(text) > maxBytes) fail(`object exceeds ${maxBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("object is not valid JSON");
  }
  return parseFeedbackAgentEventTail(parsed, opts);
}

// ---------------------------------------------------------------------------
// Reader rules (Lens mirrors these).
// ---------------------------------------------------------------------------

/** What an event list may be described as. Only `no_matching_events` may be worded as "no matching events". */
export type AgentEventTailEventsDescription =
  /** collection failed: events/counts are unknown. */
  | { kind: "not_applicable" }
  /** matched = 0. `scanned_part_only`: the scan was incomplete, so zero describes only the scanned part. */
  | { kind: "no_matching_events"; scope: "all_listed_files" | "scanned_part_only" }
  /** matched > 0 but every matched event was dropped by the caps: "matched N, shown 0". */
  | { kind: "matched_none_shown"; matched: number; scope: "all_listed_files" | "scanned_part_only" }
  | { kind: "shown"; emitted: number; matched: number; truncated: boolean; scope: "all_listed_files" | "scanned_part_only" };

export function describeAgentEventTailEvents(envelope: FeedbackAgentEventTail): AgentEventTailEventsDescription {
  if (envelope.collection.status !== "ok") return { kind: "not_applicable" };
  const ok = envelope as FeedbackAgentEventTailOk;
  const scope = ok.scan.status === "complete" ? "all_listed_files" : "scanned_part_only";
  if (ok.counts.matched === 0) return { kind: "no_matching_events", scope };
  if (ok.counts.emitted === 0) return { kind: "matched_none_shown", matched: ok.counts.matched, scope };
  return { kind: "shown", emitted: ok.counts.emitted, matched: ok.counts.matched, truncated: ok.truncated, scope };
}

export type AgentEventTailObjectFetch =
  | { status: "missing" }
  | { status: "read_error" }
  /** gunzip / UTF-8 decode failed. */
  | { status: "decode_error" }
  /** The decompressed UTF-8 text. */
  | { status: "ok"; text: string };

export type AgentEventTailRequestAssociation =
  /** Object requestId equals the ledger's request_id. */
  | { status: "verified"; requestId: string }
  /** The ledger has no request_id; the object's own value is shown, marked unverified, and not used to join other attachments. */
  | { status: "unverified"; requestId: string };

export type AgentEventTailIdentityMismatch =
  | "ledger_kind" | "ledger_report" | "ledger_agent" | "ledger_request_id_invalid" | "object_key"
  | "object_report" | "object_agent" | "object_request";

export type AgentEventTailUnreadableReason =
  | "object_missing" | "read_error" | "decode_error" | "unsupported_schema" | "strict_parse_failed";

export type AgentEventTailRead =
  | { state: "absent"; downloadAllowed: false }
  /** Not this report/agent/request, or the object is outside the kind's prefix. Nothing is shown or downloadable. */
  | { state: "identity_mismatch"; reason: AgentEventTailIdentityMismatch; downloadAllowed: false }
  /** Correlated by the ledger but not readable. All fields and counts are unknown (never 0/empty). */
  | { state: "unreadable"; reason: AgentEventTailUnreadableReason; downloadAllowed: boolean }
  | { state: "readable"; envelope: FeedbackAgentEventTail; requestAssociation: AgentEventTailRequestAssociation; events: AgentEventTailEventsDescription; downloadAllowed: true };

const KEY_SEGMENT_RE = /^[A-Za-z0-9-]{1,128}$/;

function objectKeyValid(key: unknown, ledger: Record<string, unknown>, serverId: string): boolean {
  if (typeof key !== "string" || !key.startsWith(FEEDBACK_AGENT_EVENT_TAIL_OBJECT_KEY_PREFIX)) return false;
  const parts = key.slice(FEEDBACK_AGENT_EVENT_TAIL_OBJECT_KEY_PREFIX.length).split("/");
  if (parts.length !== 3) return false;
  const [server, machine, file] = parts as [string, string, string];
  if (!KEY_SEGMENT_RE.test(server) || !KEY_SEGMENT_RE.test(machine) || !file.endsWith(".json.gz")) return false;
  if (!KEY_SEGMENT_RE.test(file.slice(0, -".json.gz".length))) return false;
  // Three-way identity (contract A.3): the report's server, the ledger's
  // server and machine are all required and must each equal the key segment.
  // Missing, non-string or unequal ⇒ not valid (identity_mismatch, no download).
  if (typeof ledger.server_id !== "string" || ledger.server_id !== server) return false;
  if (typeof ledger.machine_id !== "string" || ledger.machine_id !== machine) return false;
  if (typeof serverId !== "string" || serverId !== server) return false;
  return true;
}

/**
 * The reader gate. Identity is checked FIRST, from the ledger entry against
 * the report being viewed; then the object is strict-parsed; then the
 * object's own ids are checked against the report AND the ledger.
 *
 * requestId rules (the object always carries one in v1):
 * - ledger request_id present and equal → verified;
 * - ledger request_id absent → displayable, association `unverified`;
 * - ledger request_id present but invalid, or unequal → identity_mismatch.
 *
 * Download: allowed only when identity and the object key prefix are valid
 * and an object exists; an unsupported schema or unparseable content is fine.
 */
export function readAgentEventTailAttachment(input: {
  report: { feedbackReportId: string; agentId: string; serverId: string };
  ledger: Record<string, unknown> | null;
  object: AgentEventTailObjectFetch;
}): AgentEventTailRead {
  const { report, ledger } = input;
  if (!ledger) return { state: "absent", downloadAllowed: false };
  const mismatch = (reason: AgentEventTailIdentityMismatch): AgentEventTailRead => ({ state: "identity_mismatch", reason, downloadAllowed: false });
  if (ledger.feedback_attachment_kind !== "agent_event_tail") return mismatch("ledger_kind");
  if (ledger.feedback_report_id !== report.feedbackReportId) return mismatch("ledger_report");
  if (ledger.agent_id !== report.agentId) return mismatch("ledger_agent");
  const ledgerRequestId = ledger.request_id === undefined ? null : readFeedbackTranscriptRequestId(ledger.request_id);
  if (ledger.request_id !== undefined && ledgerRequestId === null) return mismatch("ledger_request_id_invalid");
  if (!objectKeyValid(ledger.object_key, ledger, report.serverId)) return mismatch("object_key");

  const fetched = input.object;
  if (fetched.status === "missing") return { state: "unreadable", reason: "object_missing", downloadAllowed: false };
  if (fetched.status === "read_error") return { state: "unreadable", reason: "read_error", downloadAllowed: true };
  if (fetched.status === "decode_error") return { state: "unreadable", reason: "decode_error", downloadAllowed: true };
  let envelope: FeedbackAgentEventTail;
  try {
    envelope = parseFeedbackAgentEventTailJson(fetched.text);
  } catch (err) {
    const unsupported = err instanceof Error && /schema_version is unsupported|type is invalid/.test(err.message);
    return { state: "unreadable", reason: unsupported ? "unsupported_schema" : "strict_parse_failed", downloadAllowed: true };
  }
  if (envelope.feedbackReportId !== report.feedbackReportId) return mismatch("object_report");
  if (envelope.agentId !== report.agentId) return mismatch("object_agent");
  if (ledgerRequestId !== null && envelope.requestId !== ledgerRequestId) return mismatch("object_request");
  return {
    state: "readable",
    envelope,
    requestAssociation: ledgerRequestId !== null
      ? { status: "verified", requestId: ledgerRequestId }
      : { status: "unverified", requestId: envelope.requestId },
    events: describeAgentEventTailEvents(envelope),
    downloadAllowed: true,
  };
}
