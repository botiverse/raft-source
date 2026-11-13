// External (antiproton) agent trace rows: POST /api/external/antiproton-trace
// → OTLP logs (otel.logs, service.name=antiproton, event `antiproton.<kind>`).
//
// Antiproton keeps its traces per agent in its own storage, so turn timing,
// model attempts and assistant wakes could not be read next to the server's
// own telemetry (10-20 assistant doorbell / onboarding case studies, tygg
// #raft-antiproton:c473f704). Same boundary as github-refresh: a dedicated
// bearer token, an allowlist of kinds, a fixed typed field set per kind
// (anything else is dropped), and ids, numbers, booleans and fixed codes only;
// no message text, prompt, tool argument or error text gets through. Rows are
// keyed by (tenant, agent, seq), the sender's own outbox sequence (span ids are
// not unique per row for hook-written kinds), so retried batches are
// deduplicated at query time.
import type { TraceUploadWorkerEnv } from "../env";
import { constantTimeEqual } from "../shared/auth";
import { HttpError, jsonResponse, readJsonObjectWithLimit, type JsonObject } from "../shared/http";
import { compactAttributes, postOtlpLogBatch } from "../traces/otlp";

export const ANTIPROTON_TRACE_PATH = "/api/external/antiproton-trace";
const MAX_ROWS = 500;
const MAX_BYTES = 512 * 1024;
const ENVS = new Set(["production", "preview"]);
const VERDICTS = new Set(["ok", "failed", "blocked", "cancelled"]);

// Bounded identifier/code strings: no free text gets through.
const ID_RE = /^[A-Za-z0-9_.:@/|-]{1,128}$/;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
// A credential shape anywhere in an id or code drops the value, even inside a
// longer name after a separator (`x_ghp_…`, `x_sk-…`): tool names are written by the model or a program, so
// the sender's own filter is not the only line (Tenny, antiproton #1007 review).
const TOKEN_RE = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[0-9a-fA-F]{40})/;

type FieldType = "id" | "code" | "count" | "int" | "bool" | readonly string[];

// `<effect>_<scope>` counts on raft.assistant_rules (legacy = rules migrated from the old store).
const RULE_COUNT_FIELDS: Record<string, FieldType> = Object.fromEntries(
  ["mute", "always", "digest"].flatMap((effect) =>
    ["channel", "thread", "person", "kind", "dms", "legacy"].map((scope) => [`${effect}_${scope}`, "count" as const])),
);

const countFields = (names: readonly string[]): Record<string, FieldType> =>
  Object.fromEntries(names.map((name) => [name, "count" as const]));

// Per kind: the only attributes forwarded. `count` = non-negative safe
// integer (tokens, milliseconds, counts); `int` may be negative (exit codes).
export const ANTIPROTON_TRACE_KINDS: Record<string, Record<string, FieldType>> = {
  "model.call": {
    model: "id", stop_reason: "code", input: "count", output: "count", cache_read: "count",
    cache_write: "count", reasoning: "count", first_tool: "id", turn: "id", session: "id",
  },
  "model.attempt": {
    attempt: "count", phase: ["take", "admit", "call", "deliver"], outcome: "code", http_status: "count",
    error_class: "id", total_ms: "count", provider_ms: "count", model: "id",
  },
  "tool.call": {
    mount_index: "count",
    tool: "id", mount: "id", task: "id", run_ms: "count", exit_code: "int", denied: "bool", error_code: "code",
    http_status: "count",
  },
  "tool.refused": { tool: "id", code: "code", by: "id", from: ["model", "program"] },
  "turn.timing": {
    inbound_to_start_ms: "count", start_to_first_job_ms: "count", model_ms: "count", between_jobs_ms: "count",
    tool_ms: "count", last_answer_to_reply_ms: "count", model_jobs: "count", tools: "count", messages: "count",
    first_call_prompt_tokens: "count", first_call_cached_tokens: "count", client_wait_ms: "count",
    client_pauses: "count", prep_ms: "count",
  },
  "turn.stop": { trigger: "code", turn: "id" },
  "raft.assistant_wake": {
    mount_index: "count",
    result: ["skipped_empty", "skipped_filtered", "invoked", "unreadable", "paused", "night_deferred", "failed", "inbox_lagging",
      "check_refused", "skipped_no_check"],
    trigger: "code", conversations: "count", candidates: "count", seen: "count", unreadable: "count",
    lag_retry: "count", caught_up: "bool", caught_up_via: ["unread", "all", "mixed"], caught_up_rule: ["seq", "time"],
    muted: "count", told: "count", held: "count", said: "count", inbox_lagging_gave_up: "count",
    // RFC 077 step 2 (antiproton #1023): a check Raft ran. `raft_check` marks those rows, so Raft's counts
    // below share columns with this side's own check without being confused with them.
    check_id: "id", raft_check: "bool",
    reason: ["malformed", "version", "instruction_too_large", "no_notify", "raft_check_off", "engine_pd_unsupported"],
    instruction_bytes: "count", tools_offered: "count", tools_dropped: "count",
    placeholders_unknown: "count", placeholders_unoffered: "count",
    ...countFields(["items", "truncated", "skipped", "digest", "always", "dm", "mention", "thread", "named", "default_out", "night_held", "behind"]),
    error_code: ["inbox_refused", "inbox_shape", "not_enabled", "unexpected"], http_status: "count",
  },
  "raft.assistant_check": {
    mount_index: "count",
    check_id: "id", trigger: ["doorbell", "brief"], outcome: ["completed", "failed", "cancelled"],
    error_code: "code", attempts: "count", http_status: "count", code: "code",
  },
  "raft.assistant_notify": {
    mount_index: "count",
    state: ["sent", "duplicate", "nothing_to_send", "kept_for_brief", "not_sent", "unknown"],
    items_in: "count", items_sent: "count", dropped: "count", dropped_already_told: "count",
    dropped_rule: "count", dropped_not_confirmed: "count", dropped_decisions_in_brief: "count", dropped_other: "count",
    dropped_not_in_check: "count", held_back: "count", kept_for_brief: "count",
    check_id: "id", trigger: ["doorbell", "brief"], forwarded: "count", code: "code", http_status: "count",
  },
  // RFC 077 PR B (cody #1009): owner preference tool calls and told-message counts.
  // Counts, actions and result codes only; no names, ids, notes or channels.
  "raft.assistant_rules": {
    mount_index: "count",
    action: ["add", "mute", "unmute", "remove", "list", "quiet", "timezone", "other", ""],
    via: ["raft"], left: "count", code: "code",
    result: "code", // listed / added / … or refused:<code>; new refusal codes need no allowlist change
    effect: ["mute", "always", "digest"],
    scope: ["channel", "thread", "person", "kind", "dms"],
    removed: "count",
    rules_total: "count",
    ...RULE_COUNT_FIELDS,
  },
  // status told | reply_fallback (antiproton #1013: end-of-turn text sent to the owner's DM
  // when the turn sent nothing there itself). failed_turn (antiproton #1017): the turn failed
  // before replying, so a fixed line was sent instead of model text.
  "raft.assistant_chat_told": {
    mount_index: "count",
    told: "count", reply_fallback: "count", failed_turn: "count", result: ["sent", "held", "failed"], code: "code",
    refs: "count", skipped: "count", forwarded: "count", http_status: "count",
  },
  // RFC 077 PR 2 (antiproton #1010): sending on the owner's behalf. Result codes, target
  // kind, length and HTTP status only; never the text, names or ids.
  "raft.assistant_send_as_owner": {
    result: "code", // sent / uncertain / failed / refused:<code>
    mount_index: "count",
    target_kind: ["message", "channel", "dm", "channel_id", "other"],
    in_thread: "bool",
    chars: "count",
    http_status: "count", // the row-level `status` is a code, so the HTTP status rides here
  },
  "raft.turn_ended": {
    mount_index: "count",
    result: ["settled", "skipped", "unreadable"], reason: "code", conversations: "count",
    outcome: ["completed", "interrupted", "failed"],
  },
  // antiproton #1022: recording a turn's end failed; the pass went on. Error class only, never its text.
  "turn.end_unrecorded": { stage: ["read", "record"], error_class: "id" },
  // A context rebuild's outcome, measured on the next model job: the decision and how the cache answered.
  "rebuild.outcome": {
    decision: "id", trigger: ["window", "cold-wake", "operator"], strategy: ["summary", "briefing"],
    agreement: ["agree", "false-cold", "false-warm", "expected-cold", "unmeasured"],
    would_rebuild: "bool", predicted_cold: "bool", expected_cold: "bool", measured_cold: "bool",
    input: "count", cache_read: "count", since_decision_ms: "count",
  },
  // antiproton #1144: lines a `state` document dropped to stay under its cap. Sizes only, never the dropped
  // text. Since #1147 `memory` and `todo` refuse a growing write instead, so any row with those keys is a bug.
  "state.dropped": { mount: "id", key: ["memory", "todo", "journal", "other"], lines: "count", characters: "count" },
};

export interface AntiprotonTraceRow {
  at: string;
  kind: string;
  tenant_id: string;
  agent_id: string;
  seq: number;
  span_id?: string;
  env: string;
  status?: string;
  verdict?: string;
  ms?: number;
  attrs: Record<string, string | number | boolean>;
}

export async function ingestAntiprotonTraceBatch(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  authorize(request, env);
  const body = await readJsonObjectWithLimit(request, MAX_BYTES);
  if (!Array.isArray(body.rows)) throw rejected(400, "rows_missing");
  if (body.rows.length > MAX_ROWS) throw rejected(413, "too_many_rows");
  // Telemetry: one bad row is dropped and reported, the rest are ingested
  // (400 stays for a malformed body only), so an odd value cannot lose a batch.
  const rows: AntiprotonTraceRow[] = [];
  const rejectedRows: Array<{ index: number; reason: string }> = [];
  body.rows.forEach((row, index) => {
    try {
      rows.push(readRow(row));
    } catch (error) {
      if (!(error instanceof RowRejected)) throw error;
      rejectedRows.push({ index, reason: error.reason });
    }
  });
  if (rejectedRows.length > 0) {
    const reasons = [...new Set(rejectedRows.map((r) => r.reason))].join(",");
    console.warn(`[TraceUploadWorker] external antiproton-trace rows rejected count=${rejectedRows.length} reasons=${reasons}`);
  }
  // No sink = nowhere to put the rows. Answering 2xx would let the sender
  // advance its cursor and lose them silently, so ask it to retry instead.
  if (!env.TRACE_INGEST_OTLP_ENDPOINT) throw rejected(503, "sink_not_configured");
  if (rows.length > 0) {
    await postOtlpLogBatch(
      env,
      compactAttributes({
        "service.name": "antiproton",
        "service.revision": env.SLOCK_RELEASE_SHA,
        "deployment.environment": env.DEPLOYMENT_ENV,
        "telemetry.sdk.name": "slock-trace-upload-external",
      }),
      "antiproton/agent-trace",
      rows.map((row) => ({
        eventKey: `${row.tenant_id}:${row.agent_id}:${row.seq}`,
        record: {
          type: "event",
          schema_version: 1,
          name: `antiproton.${row.kind}`,
          surface: "antiproton",
          time: row.at,
          attrs: {
            tenant_id: row.tenant_id,
            agent_id: row.agent_id,
            seq: row.seq,
            span_id: row.span_id,
            antiproton_env: row.env,
            status: row.status,
            verdict: row.verdict,
            duration_ms: row.ms,
            ...row.attrs,
          },
        },
      })),
      "web_events",
    );
  }
  return jsonResponse({ ok: true, accepted: rows.length, rejected: rejectedRows });
}

function authorize(request: Request, env: TraceUploadWorkerEnv): void {
  // One shared antiproton ingest secret is enough (tygg 10-21): fall back to the
  // github-refresh token when no dedicated one is set.
  const expected = (env.EXTERNAL_ANTIPROTON_TRACE_TOKEN?.trim() || env.EXTERNAL_GITHUB_REFRESH_TOKEN?.trim()) ?? "";
  // Unconfigured = endpoint off; answer like an unknown route.
  if (!expected) throw new HttpError(404, "Not found");
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!presented || !constantTimeEqual(presented, expected)) throw rejected(401, "bad_token");
}

class RowRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function readRow(value: unknown): AntiprotonTraceRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RowRejected("row_not_object");
  const row = value as JsonObject;
  const kind = typeof row.kind === "string" ? row.kind : "";
  const fields = Object.prototype.hasOwnProperty.call(ANTIPROTON_TRACE_KINDS, kind) ? ANTIPROTON_TRACE_KINDS[kind] : null;
  if (!fields) throw new RowRejected("kind_not_allowed");
  const at = typeof row.at === "string" && !Number.isNaN(Date.parse(row.at)) ? new Date(row.at).toISOString() : null;
  if (!at) throw new RowRejected("at_invalid");
  const tenant = id(row.tenant_id);
  const agent = id(row.agent_id);
  if (!tenant || !agent) throw new RowRejected("identity_invalid");
  if (!Number.isSafeInteger(row.seq) || (row.seq as number) < 0) throw new RowRejected("seq_invalid");
  if (typeof row.env !== "string" || !ENVS.has(row.env)) throw new RowRejected("env_invalid");
  const attrs: Record<string, string | number | boolean> = {};
  for (const [name, type] of Object.entries(fields)) {
    const parsed = field(row[name], type);
    if (parsed !== undefined) attrs[name] = parsed;
  }
  return {
    at,
    kind,
    tenant_id: tenant,
    agent_id: agent,
    seq: row.seq as number,
    span_id: id(row.span_id),
    env: row.env,
    status: code(row.status),
    verdict: typeof row.verdict === "string" && VERDICTS.has(row.verdict) ? row.verdict : undefined,
    ms: count(row.ms),
    attrs,
  };
}

function field(value: unknown, type: FieldType): string | number | boolean | undefined {
  if (Array.isArray(type)) return typeof value === "string" && type.includes(value) ? value : undefined;
  switch (type) {
    case "id": return id(value);
    case "code": return code(value);
    case "count": return count(value);
    case "int": return Number.isSafeInteger(value) ? (value as number) : undefined;
    case "bool": return typeof value === "boolean" ? value : undefined;
    default: return undefined;
  }
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && ID_RE.test(value) && !TOKEN_RE.test(value) ? value : undefined;
}

function code(value: unknown): string | undefined {
  return typeof value === "string" && CODE_RE.test(value) && !TOKEN_RE.test(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

// Rejections log one bounded line (status + reason, never the body) so a stuck
// sender shows up in the worker's own logs even when nothing reaches ScopeDB.
function rejected(status: number, reason: string, index?: number): HttpError {
  console.warn(`[TraceUploadWorker] external antiproton-trace rejected status=${status} reason=${reason}${index === undefined ? "" : ` row=${index}`}`);
  return new HttpError(status, reason);
}
