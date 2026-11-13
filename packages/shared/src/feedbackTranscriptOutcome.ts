// ---------------------------------------------------------------------------
// Feedback transcript: content kind, lookup/upload outcomes, and the
// transcript_outcome attachment (task #1228 deliverable ①).
//
// The daemon decides WHAT bytes it read at the one place it reads them
// (getSessionTranscript) and says so with a closed content kind. A daemon
// placeholder (the workspace handoff file) is never uploaded as a transcript.
// Every lookup and upload result is a typed OBSERVATION: codes say what this
// daemon saw, never a conclusion it cannot verify (e.g. "the agent is not on
// this machine").
//
// The transcript_outcome object is a small, strict JSON document uploaded as
// its own attachment kind, best-effort and after the result frame. It never
// claims anything about its own storage: whether it was stored is known only
// from its own ledger entry (or a server span), never from the object itself.
// ---------------------------------------------------------------------------

/** What the bytes read for a feedback transcript are. Decided where they are read. */
export const FEEDBACK_TRANSCRIPT_CONTENT_KINDS = [
  /** The runtime's own session file (a conversation log). */
  "native_session_file",
  /** The runtime's own STATE file (e.g. the legacy kimi CLI's state.json): not necessarily a conversation. */
  "native_state_file",
  /** The daemon-written workspace handoff file. NEVER uploaded as a transcript. */
  "placeholder",
  /** Nothing was read. */
  "absent",
] as const;
export type FeedbackTranscriptContentKind = (typeof FEEDBACK_TRANSCRIPT_CONTENT_KINDS)[number];

/** The only content kinds that may be uploaded (and signed) as a transcript. */
export const FEEDBACK_TRANSCRIPT_UPLOADABLE_CONTENT_KINDS = ["native_session_file", "native_state_file"] as const;
export type FeedbackTranscriptUploadableContentKind = (typeof FEEDBACK_TRANSCRIPT_UPLOADABLE_CONTENT_KINDS)[number];

export function isFeedbackTranscriptUploadableContentKind(value: unknown): value is FeedbackTranscriptUploadableContentKind {
  return typeof value === "string" && (FEEDBACK_TRANSCRIPT_UPLOADABLE_CONTENT_KINDS as readonly string[]).includes(value);
}

/**
 * Why no transcript was read. Each code names an OBSERVATION on this daemon.
 * - no_config_in_memory: neither a live process nor a restart snapshot for the
 *   agent is in this daemon's memory. Says nothing about where the agent ran;
 *   `workspaceDirPresent` reports what the local directory lookup saw.
 * - no_session_id: a config is known (in memory, or the server's copy sent
 *   with the request) but no session id is bound to it.
 * - runtime_has_no_native_lookup: this daemon has no lookup for the runtime's
 *   own session files (cursor, gemini, copilot, opencode today).
 * - native_session_file_not_found: the lookup ran (see lookupMethod) and
 *   found no file. Which paths it searched stays in the daemon's LOCAL lookup
 *   diagnostic; it never leaves the machine.
 * - session_file_empty: the file was found and is 0 bytes on disk.
 * - window_empty: the file has bytes, but the bounded/aligned read window
 *   kept none.
 * - path_rejected: containment / symlink / regular-file checks refused the path.
 * - read_failed: an I/O error while reading.
 * - collector_error: the daemon's collection threw before producing a result.
 */
export const FEEDBACK_TRANSCRIPT_LOOKUP_REASONS = [
  "no_config_in_memory",
  "no_session_id",
  "runtime_has_no_native_lookup",
  "native_session_file_not_found",
  "session_file_empty",
  "window_empty",
  "path_rejected",
  "read_failed",
  "collector_error",
] as const;
export type FeedbackTranscriptLookupReason = (typeof FEEDBACK_TRANSCRIPT_LOOKUP_REASONS)[number];

/** How the daemon looked. `in_memory_agent_config` = the process map + restart snapshot. */
export const FEEDBACK_TRANSCRIPT_LOOKUP_METHODS = [
  "claude_jsonl",
  "codex_jsonl",
  "grok_session_jsonl",
  "kimi_sdk_index",
  "pi_jsonl",
  "builtin_jsonl",
  "none",
  "in_memory_agent_config",
] as const;
export type FeedbackTranscriptLookupMethod = (typeof FEEDBACK_TRANSCRIPT_LOOKUP_METHODS)[number];

export function asFeedbackTranscriptLookupMethod(value: unknown): FeedbackTranscriptLookupMethod | null {
  return typeof value === "string" && (FEEDBACK_TRANSCRIPT_LOOKUP_METHODS as readonly string[]).includes(value)
    ? value as FeedbackTranscriptLookupMethod
    : null;
}

export const FEEDBACK_TRANSCRIPT_UPLOAD_STATUSES = ["stored", "not_attempted", "failed"] as const;
export const FEEDBACK_TRANSCRIPT_UPLOAD_REASONS = ["lookup_failed", "worker_not_configured", "upload_failed"] as const;
export const FEEDBACK_TRANSCRIPT_UPLOAD_STAGES = ["prepare", "attestation", "create", "put"] as const;
export const FEEDBACK_TRANSCRIPT_UPLOAD_HTTP_CLASSES = ["4xx", "5xx", "timeout", "network", "other"] as const;
export const FEEDBACK_TRANSCRIPT_CONTENT_LABELS = ["signed", "unsigned"] as const;

/**
 * Lookup half of an outcome. Finite enums + nullable fields only, and NO
 * paths: searched paths (absolute under a custom dataDir, or home-folded) are
 * a separate, local-only projection (the daemon's session-transcript lookup
 * diagnostic). Neither the result frame nor the transcript_outcome object
 * carries them, and the strict parser rejects an object that does.
 */
export interface FeedbackTranscriptLookupOutcome {
  reachable: boolean;
  content: FeedbackTranscriptContentKind;
  reasonCode: FeedbackTranscriptLookupReason | null;
  runtime: string | null;
  lookupMethod: FeedbackTranscriptLookupMethod | null;
  workspaceDirPresent: boolean | null;
  /**
   * Size of the source file at read time: its size on disk, or for a
   * compressed file (a codex `.jsonl.zst` rollout) its decompressed size.
   */
  sourceBytes: number | null;
  /**
   * Uncompressed bytes kept for upload, after windowing and redaction. A
   * difference from `sourceBytes` is NOT by itself truncation; truncation is
   * reported separately and only from the read geometry.
   */
  transcriptBytes: number | null;
  /** The session bound when the daemon looked, not necessarily at report time. */
  selectionBasis: "lookup_time";
}

/** Upload half of an outcome. `stored` only when the worker's PUT returned 2xx. */
export interface FeedbackTranscriptUploadOutcome {
  status: (typeof FEEDBACK_TRANSCRIPT_UPLOAD_STATUSES)[number];
  reason: (typeof FEEDBACK_TRANSCRIPT_UPLOAD_REASONS)[number] | null;
  stage: (typeof FEEDBACK_TRANSCRIPT_UPLOAD_STAGES)[number] | null;
  httpStatus: number | null;
  httpClass: (typeof FEEDBACK_TRANSCRIPT_UPLOAD_HTTP_CLASSES)[number] | null;
  /** The worker upload id of the STORED transcript (its ledger `upload_id`). */
  uploadId: string | null;
  /** Whether the server echoed the content label into the signed claims. */
  contentLabel: (typeof FEEDBACK_TRANSCRIPT_CONTENT_LABELS)[number] | null;
}

/**
 * What the reporter is told about the session record, from the Computer's
 * typed upload outcome:
 * - attached: the worker stored it.
 * - not_attached: every other typed outcome. Why is not said: `not_attempted`
 *   with `lookup_failed` covers a Computer that found no record, but also one
 *   that declined to look, could not read the file, or failed while looking,
 *   and a failed upload is no different to the reporter.
 */
export const FEEDBACK_SESSION_RECORD_ANSWERS = ["attached", "not_attached"] as const;
export type FeedbackSessionRecordAnswer = (typeof FEEDBACK_SESSION_RECORD_ANSWERS)[number];

export function isFeedbackSessionRecordAnswer(value: unknown): value is FeedbackSessionRecordAnswer {
  return typeof value === "string" && (FEEDBACK_SESSION_RECORD_ANSWERS as readonly string[]).includes(value);
}

/**
 * Null when the Computer gave no typed outcome (an older Computer): nothing is
 * known, so nothing is claimed.
 */
export function feedbackSessionRecordAnswer(outcome: {
  outcomeVersion?: 1;
  upload?: FeedbackTranscriptUploadOutcome;
}): FeedbackSessionRecordAnswer | null {
  if (outcome.outcomeVersion !== 1 || !outcome.upload) return null;
  return outcome.upload.status === "stored" ? "attached" : "not_attached";
}

/**
 * What the result frame can say about the transcript_outcome object: it is
 * sent BEFORE that upload starts, so it can only say it will be attempted
 * (fate unknown to the frame) or that it will not be.
 */
export type FeedbackTranscriptOutcomeObjectPlan = "attempt_after_result" | "not_attempted_worker_not_configured";

// ---------------------------------------------------------------------------
// Signed transcript-bundle claims added by ①. Read INDEPENDENTLY of the
// window-coverage claims (an invalid coverage value must not erase them).
// ---------------------------------------------------------------------------
export interface FeedbackTraceBundleTranscriptResultMetadata {
  feedbackTranscriptContent?: FeedbackTranscriptUploadableContentKind;
  /** Size of the source file on disk at read time. */
  feedbackTranscriptSourceBytes?: number;
  /** Uncompressed bytes uploaded (after windowing/redaction); a difference is not by itself truncation. */
  feedbackTranscriptBytes?: number;
  /** The server's feedback transcript request id; links transcript ↔ outcome. */
  feedbackTranscriptRequestId?: string;
}
export const FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_RESULT_METADATA_KEYS = {
  feedbackTranscriptContent: true,
  feedbackTranscriptSourceBytes: true,
  feedbackTranscriptBytes: true,
  feedbackTranscriptRequestId: true,
} satisfies Record<keyof FeedbackTraceBundleTranscriptResultMetadata, true>;
export type FeedbackTraceBundleTranscriptResultMetadataKey = keyof typeof FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_RESULT_METADATA_KEYS;

export const FEEDBACK_TRANSCRIPT_REQUEST_ID_MAX_CHARS = 128;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]+$/;

export function readFeedbackTranscriptRequestId(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= FEEDBACK_TRANSCRIPT_REQUEST_ID_MAX_CHARS
    && REQUEST_ID_RE.test(value)
    ? value
    : null;
}

export function readFeedbackTranscriptByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// The transcript_outcome object
// ---------------------------------------------------------------------------
export const FEEDBACK_TRANSCRIPT_OUTCOME_TYPE = "feedback_transcript_outcome";
export const FEEDBACK_TRANSCRIPT_OUTCOME_SCHEMA_VERSION = 1;
/** Hard cap on the object's raw UTF-8 JSON bytes. */
export const FEEDBACK_TRANSCRIPT_OUTCOME_MAX_BYTES = 2048;
/** Upper bound on the gzipped object the server will sign for. */
export const FEEDBACK_TRANSCRIPT_OUTCOME_MAX_UPLOAD_BYTES = FEEDBACK_TRANSCRIPT_OUTCOME_MAX_BYTES + 1024;
const OUTCOME_ID_MAX_CHARS = 128;
const OUTCOME_SHORT_MAX_CHARS = 64;

export interface FeedbackTranscriptOutcomeEnvelope {
  type: typeof FEEDBACK_TRANSCRIPT_OUTCOME_TYPE;
  schemaVersion: typeof FEEDBACK_TRANSCRIPT_OUTCOME_SCHEMA_VERSION;
  feedbackReportId: string;
  agentId: string;
  requestId: string;
  daemonVersion: string | null;
  /**
   * When the daemon built this object (daemon wall clock). A display / sort
   * HINT only: never an authoritative order across retries, and never the
   * report time.
   */
  generatedAt: string;
  lookup: FeedbackTranscriptLookupOutcome;
  upload: FeedbackTranscriptUploadOutcome;
  /** The object cannot attest its own storage; read its ledger entry or the server span. */
  selfStorage: "not_self_attested";
}

const ENVELOPE_KEYS = ["type", "schemaVersion", "feedbackReportId", "agentId", "requestId", "daemonVersion", "generatedAt", "lookup", "upload", "selfStorage"] as const;
const LOOKUP_KEYS = ["reachable", "content", "reasonCode", "runtime", "lookupMethod", "workspaceDirPresent", "sourceBytes", "transcriptBytes", "selectionBasis"] as const;
const UPLOAD_KEYS = ["status", "reason", "stage", "httpStatus", "httpClass", "uploadId", "contentLabel"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${name} has an unknown field`);
  for (const key of keys) if (!(key in value)) throw new Error(`${name} is missing ${key}`);
}

function enumOrNull<T extends string>(value: unknown, values: readonly T[], name: string): T | null {
  if (value === null) return null;
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} is invalid`);
}

function boundedString(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${name} is invalid`);
  return value;
}

function nullableBoundedString(value: unknown, max: number, name: string): string | null {
  return value === null ? null : boundedString(value, max, name);
}

function nullableCount(value: unknown, name: string): number | null {
  if (value === null) return null;
  const n = readFeedbackTranscriptByteCount(value);
  if (n === null) throw new Error(`${name} is invalid`);
  return n;
}

function parseLookup(raw: unknown): FeedbackTranscriptLookupOutcome {
  if (!isPlainObject(raw)) throw new Error("lookup must be an object");
  exactKeys(raw, LOOKUP_KEYS, "lookup");
  if (typeof raw.reachable !== "boolean") throw new Error("lookup.reachable is invalid");
  const content = enumOrNull(raw.content, FEEDBACK_TRANSCRIPT_CONTENT_KINDS, "lookup.content");
  if (content === null) throw new Error("lookup.content is invalid");
  if (raw.workspaceDirPresent !== null && typeof raw.workspaceDirPresent !== "boolean") throw new Error("lookup.workspaceDirPresent is invalid");
  if (raw.selectionBasis !== "lookup_time") throw new Error("lookup.selectionBasis is invalid");
  return {
    reachable: raw.reachable,
    content,
    reasonCode: enumOrNull(raw.reasonCode, FEEDBACK_TRANSCRIPT_LOOKUP_REASONS, "lookup.reasonCode"),
    runtime: nullableBoundedString(raw.runtime, OUTCOME_SHORT_MAX_CHARS, "lookup.runtime"),
    lookupMethod: enumOrNull(raw.lookupMethod, FEEDBACK_TRANSCRIPT_LOOKUP_METHODS, "lookup.lookupMethod"),
    workspaceDirPresent: raw.workspaceDirPresent as boolean | null,
    sourceBytes: nullableCount(raw.sourceBytes, "lookup.sourceBytes"),
    transcriptBytes: nullableCount(raw.transcriptBytes, "lookup.transcriptBytes"),
    selectionBasis: "lookup_time",
  };
}

function parseUpload(raw: unknown): FeedbackTranscriptUploadOutcome {
  if (!isPlainObject(raw)) throw new Error("upload must be an object");
  exactKeys(raw, UPLOAD_KEYS, "upload");
  const status = enumOrNull(raw.status, FEEDBACK_TRANSCRIPT_UPLOAD_STATUSES, "upload.status");
  if (status === null) throw new Error("upload.status is invalid");
  const httpStatus = raw.httpStatus;
  if (httpStatus !== null && !(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) {
    throw new Error("upload.httpStatus is invalid");
  }
  return {
    status,
    reason: enumOrNull(raw.reason, FEEDBACK_TRANSCRIPT_UPLOAD_REASONS, "upload.reason"),
    stage: enumOrNull(raw.stage, FEEDBACK_TRANSCRIPT_UPLOAD_STAGES, "upload.stage"),
    httpStatus: httpStatus as number | null,
    httpClass: enumOrNull(raw.httpClass, FEEDBACK_TRANSCRIPT_UPLOAD_HTTP_CLASSES, "upload.httpClass"),
    uploadId: nullableBoundedString(raw.uploadId, OUTCOME_ID_MAX_CHARS, "upload.uploadId"),
    contentLabel: enumOrNull(raw.contentLabel, FEEDBACK_TRANSCRIPT_CONTENT_LABELS, "upload.contentLabel"),
  };
}

/** Strict: unknown fields, out-of-enum values and over-long strings are rejections. */
export function parseFeedbackTranscriptOutcome(raw: unknown): FeedbackTranscriptOutcomeEnvelope {
  if (!isPlainObject(raw)) throw new Error("transcript outcome must be a JSON object");
  exactKeys(raw, ENVELOPE_KEYS, "transcript outcome");
  if (raw.type !== FEEDBACK_TRANSCRIPT_OUTCOME_TYPE) throw new Error("transcript outcome type is invalid");
  if (raw.schemaVersion !== FEEDBACK_TRANSCRIPT_OUTCOME_SCHEMA_VERSION) throw new Error("transcript outcome schemaVersion is unsupported");
  if (raw.selfStorage !== "not_self_attested") throw new Error("transcript outcome selfStorage is invalid");
  const requestId = readFeedbackTranscriptRequestId(raw.requestId);
  if (!requestId) throw new Error("transcript outcome requestId is invalid");
  const generatedAt = boundedString(raw.generatedAt, OUTCOME_SHORT_MAX_CHARS, "transcript outcome generatedAt");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("transcript outcome generatedAt is invalid");
  }
  return {
    type: FEEDBACK_TRANSCRIPT_OUTCOME_TYPE,
    schemaVersion: FEEDBACK_TRANSCRIPT_OUTCOME_SCHEMA_VERSION,
    feedbackReportId: boundedString(raw.feedbackReportId, OUTCOME_ID_MAX_CHARS, "transcript outcome feedbackReportId"),
    agentId: boundedString(raw.agentId, OUTCOME_ID_MAX_CHARS, "transcript outcome agentId"),
    requestId,
    daemonVersion: nullableBoundedString(raw.daemonVersion, OUTCOME_SHORT_MAX_CHARS, "transcript outcome daemonVersion"),
    generatedAt,
    lookup: parseLookup(raw.lookup),
    upload: parseUpload(raw.upload),
    selfStorage: "not_self_attested",
  };
}

// ---------------------------------------------------------------------------
// Reading the typed fields of a daemon result frame (server side). The
// WebSocket layer only JSON.parses, so these fields are untrusted input.
// ---------------------------------------------------------------------------
const OUTCOME_OBJECT_PLANS: readonly FeedbackTranscriptOutcomeObjectPlan[] = ["attempt_after_result", "not_attempted_worker_not_configured"];
const RESULT_OUTCOME_INVALID_REASON_MAX_CHARS = 120;

export type FeedbackTranscriptResultOutcomeRead =
  /** outcomeVersion 1 with a strictly valid lookup + upload (and a valid plan, when present). */
  | {
    status: "typed";
    lookup: FeedbackTranscriptLookupOutcome;
    upload: FeedbackTranscriptUploadOutcome;
    outcomeObject: FeedbackTranscriptOutcomeObjectPlan | null;
  }
  /** None of the typed fields present: an older daemon. */
  | { status: "untyped" }
  /** Some typed field present but not valid. `reason` is a fixed parser message, never an echoed value. */
  | { status: "invalid"; reason: string };

/**
 * Strict and NEVER throws. A frame is typed only when every typed field is
 * valid; anything else that carries a typed field is `invalid` and none of its
 * typed fields may be used.
 */
export function readFeedbackTranscriptResultOutcome(frame: unknown): FeedbackTranscriptResultOutcomeRead {
  try {
    if (!isPlainObject(frame)) return { status: "invalid", reason: "result frame is not an object" };
    const present = (["outcomeVersion", "lookup", "upload", "outcomeObject"] as const).filter((k) => frame[k] !== undefined);
    if (present.length === 0) return { status: "untyped" };
    if (frame.outcomeVersion !== 1) return { status: "invalid", reason: "outcomeVersion is missing or unsupported" };
    const lookup = parseLookup(frame.lookup);
    const upload = parseUpload(frame.upload);
    let outcomeObject: FeedbackTranscriptOutcomeObjectPlan | null = null;
    if (frame.outcomeObject !== undefined) {
      if (!OUTCOME_OBJECT_PLANS.includes(frame.outcomeObject as FeedbackTranscriptOutcomeObjectPlan)) {
        return { status: "invalid", reason: "outcomeObject is invalid" };
      }
      outcomeObject = frame.outcomeObject as FeedbackTranscriptOutcomeObjectPlan;
    }
    return { status: "typed", lookup, upload, outcomeObject };
  } catch (err) {
    const reason = err instanceof Error && typeof err.message === "string" && err.message.length > 0 ? err.message : "typed fields are invalid";
    return { status: "invalid", reason: reason.slice(0, RESULT_OUTCOME_INVALID_REASON_MAX_CHARS) };
  }
}

export type FeedbackTranscriptOutcomeBuildResult =
  | { ok: true; envelope: FeedbackTranscriptOutcomeEnvelope; json: string; bytes: number }
  | { ok: false; reason: "invalid" | "over_byte_cap"; bytes: number; error?: string };

/**
 * Build the object. Every field is projected EXPLICITLY (never spread), so a
 * stray field on the input (e.g. a local-only searched path) can never reach
 * the uploaded object. Every field is fixed-size enough to always fit the cap;
 * the cap is still checked. Never throws.
 */
export function buildFeedbackTranscriptOutcome(input: Omit<FeedbackTranscriptOutcomeEnvelope, "type" | "schemaVersion" | "selfStorage">): FeedbackTranscriptOutcomeBuildResult {
  let bytes = 0;
  try {
    const { lookup, upload } = input;
    const candidate = {
      type: FEEDBACK_TRANSCRIPT_OUTCOME_TYPE,
      schemaVersion: FEEDBACK_TRANSCRIPT_OUTCOME_SCHEMA_VERSION,
      feedbackReportId: input.feedbackReportId,
      agentId: input.agentId,
      requestId: input.requestId,
      daemonVersion: input.daemonVersion,
      generatedAt: input.generatedAt,
      lookup: {
        reachable: lookup.reachable,
        content: lookup.content,
        reasonCode: lookup.reasonCode,
        runtime: lookup.runtime,
        lookupMethod: lookup.lookupMethod,
        workspaceDirPresent: lookup.workspaceDirPresent,
        sourceBytes: lookup.sourceBytes,
        transcriptBytes: lookup.transcriptBytes,
        selectionBasis: lookup.selectionBasis,
      } satisfies Record<(typeof LOOKUP_KEYS)[number], unknown>,
      upload: {
        status: upload.status,
        reason: upload.reason,
        stage: upload.stage,
        httpStatus: upload.httpStatus,
        httpClass: upload.httpClass,
        uploadId: upload.uploadId,
        contentLabel: upload.contentLabel,
      } satisfies Record<(typeof UPLOAD_KEYS)[number], unknown>,
      selfStorage: "not_self_attested" as const,
    };
    const json = JSON.stringify(candidate);
    bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > FEEDBACK_TRANSCRIPT_OUTCOME_MAX_BYTES) return { ok: false, reason: "over_byte_cap", bytes };
    const envelope = parseFeedbackTranscriptOutcome(JSON.parse(json));
    return { ok: true, envelope, json, bytes };
  } catch (err) {
    return { ok: false, reason: "invalid", bytes, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Consumer rule for report-ledger entries (Lens and any reader mirror this).
// ---------------------------------------------------------------------------
export interface FeedbackReportLedgerEntryClassification {
  attachment: "transcript" | "machine_log_tail" | "machine_evidence" | "transcript_outcome" | "agent_event_tail" | "unknown";
  /**
   * For transcripts: the signed content kind, or `source_unverified` when the
   * entry carries none (older daemon/server/worker; it MAY be a daemon
   * placeholder). Never defaulted to a native kind. Null for non-transcripts.
   */
  source: FeedbackTranscriptUploadableContentKind | "source_unverified" | null;
  /** The request this entry belongs to, or `unknown` for entries written before request ids. */
  requestAssociation: string;
  /** Only for `unknown`: the raw kind string (bounded), so a reader can show `unknown (kind=<raw>)`. */
  rawKind?: string;
}

export function classifyFeedbackReportLedgerEntry(record: Record<string, unknown>): FeedbackReportLedgerEntryClassification {
  const kind = record.feedback_attachment_kind;
  const requestAssociation = readFeedbackTranscriptRequestId(record.request_id) ?? "unknown";
  if (kind === undefined || kind === "session_transcript") {
    const content = record.transcript_content;
    return {
      attachment: "transcript",
      source: isFeedbackTranscriptUploadableContentKind(content) ? content : "source_unverified",
      requestAssociation,
    };
  }
  if (kind === "machine_log_tail" || kind === "machine_evidence" || kind === "transcript_outcome" || kind === "agent_event_tail") {
    return { attachment: kind, source: null, requestAssociation };
  }
  return { attachment: "unknown", source: null, requestAssociation, rawKind: typeof kind === "string" ? kind.slice(0, 128) : String(kind).slice(0, 128) };
}
