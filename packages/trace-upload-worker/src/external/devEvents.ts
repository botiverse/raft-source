// Development-process trace (#proj-dev-trace): POST /api/dev-events.
//
// Vitest runs and test cases from developer machines and CI
// (scripts/devtrace/upload.ts) land in ScopeDB `dev.public.runs` and
// `dev.public.cases`, a database of their own, apart from production traces.
//
// Trust boundary (Tenny's review):
// - Two write-only bearer tokens, one for CI and one for developer machines.
//   The token decides `source` (`ci` / `dev`); `received_at` is ours too.
//   Every other identity field (actor, where, commit) is self-reported.
// - The target tables are constants here, never taken from the request.
// - Fixed field sets per table; anything else is dropped. Strings are
//   bounded; rows whose `started_at` is over 7 days old (or in the future)
//   are refused.
// - Duplicates (an uploader retrying a batch) are dropped within a batch and
//   against recently seen keys; analysis still dedupes on run_id / case_id.
// - Free text (argv, error text, test names, file, branch) is redacted here
//   again: the data is readable by everyone and the dev token sits on every
//   developer machine, so an old or modified reporter must not decide it.
// Self-reported data, for analysis only: never used for permissions or gates.
// Persistence tier: decision_support (docs/observability/scopedb-js-sdk-usage.md);
// the accepted count is not a gate.
import { redactDiagnosticText } from "@botiverse/raft-shared";
import { Client } from "scopedb";
import type { TraceUploadWorkerEnv } from "../env";
import { constantTimeEqual } from "../shared/auth";
import { HttpError, jsonResponse, readRequestBodyWithLimit } from "../shared/http";

export const DEV_EVENTS_PATH = "/api/dev-events";
export const DEV_EVENTS_SCOPEDB_PERSISTENCE_TIER = "decision_support" as const;
export const DEV_EVENTS_DATABASE = "dev";
export const DEV_EVENTS_SCHEMA = "public";
const MAX_ROWS = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 60 * 60 * 1000;
const SEEN_LIMIT = 50_000;

export type DevEventsSource = "ci" | "dev";
export type DevEventsTable = "runs" | "cases";

/** Structural seam for tests; production builds the SDK client. */
export interface DevEventsScopeDbClient {
  table(name: string, options: { database: string; schema: string }): { append(ndjson: string): Promise<{ num_rows_inserted?: number } | unknown> };
}

type FieldKind = "string" | "int" | "bool" | "time";
type FieldSpec = readonly [name: string, kind: FieldKind, max?: number];

const RUN_FIELDS: readonly FieldSpec[] = [
  ["schema_v", "int"], ["run_id", "string", 64], ["kind", "string", 32], ["tool", "string", 32],
  ["tool_version", "string", 64], ["package", "string", 128], ["argv", "string", 1024],
  ["started_at", "time"], ["ended_at", "time"], ["duration_ms", "int"], ["lock_wait_ms", "int"],
  ["result", "string", 32], ["exit_code", "int"], ["cases_total", "int"], ["cases_failed", "int"],
  ["cases_skipped", "int"], ["cases_flaky", "int"], ["where", "string", 16], ["actor_kind", "string", 16],
  ["actor", "string", 128], ["agent_session_id", "string", 128], ["machine", "string", 64],
  ["commit_sha", "string", 64], ["branch", "string", 256], ["base_sha", "string", 64], ["pr_number", "int"],
  ["dirty", "bool"], ["dirty_hash", "string", 64], ["task_ref", "string", 128], ["ci_run_id", "string", 64],
  ["ci_attempt", "int"], ["ci_job", "string", 128], ["ci_workflow", "string", 128], ["ci_event", "string", 64],
  ["ci_shard", "string", 32], ["os", "string", 128], ["node", "string", 32],
];

const CASE_FIELDS: readonly FieldSpec[] = [
  ["schema_v", "int"], ["run_id", "string", 64], ["started_at", "time"], ["case_id", "string", 64],
  ["package", "string", 128], ["file", "string", 512], ["suite", "string", 300], ["name", "string", 300],
  ["state", "string", 16], ["duration_ms", "int"], ["retry_count", "int"], ["flaky", "bool"],
  ["error_kind", "string", 32], ["error_fp", "string", 64], ["error_text", "string", 512],
  ["commit_sha", "string", 64], ["dirty", "bool"], ["where", "string", 16], ["actor", "string", 128],
];

const FIELDS: Record<DevEventsTable, readonly FieldSpec[]> = { runs: RUN_FIELDS, cases: CASE_FIELDS };
/** Free-text fields: redacted server-side whatever the client already did. */
const FREE_TEXT = new Set(["argv", "error_text", "name", "suite", "file", "branch"]);

function cleanText(name: string, value: string, max: number): string | null {
  if (!FREE_TEXT.has(name)) return value.slice(0, max);
  try {
    return redactDiagnosticText(value.slice(0, max * 4)).slice(0, max);
  } catch {
    return null;
  }
}
const REQUIRED: Record<DevEventsTable, readonly string[]> = {
  runs: ["run_id", "started_at", "package"],
  cases: ["run_id", "started_at", "case_id"],
};

// Recently accepted keys, per process: a retried batch is not written twice.
const seen = new Set<string>();
function remember(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Test seam: forget remembered keys. */
export function resetDevEventsDedupeForTests(): void {
  seen.clear();
}

export interface DevEventRow {
  table: DevEventsTable;
  key: string;
  values: Record<string, string | number | boolean | null>;
}

/** Validates one line; returns the row to write, or a refusal reason. */
export function readDevEventRow(line: unknown, nowMs: number): DevEventRow | { refused: string } {
  if (!line || typeof line !== "object" || Array.isArray(line)) return { refused: "not_object" };
  const input = line as Record<string, unknown>;
  const table = input.table;
  if (table !== "runs" && table !== "cases") return { refused: "table_not_allowed" };
  const values: Record<string, string | number | boolean | null> = {};
  for (const [name, kind, max] of FIELDS[table]) {
    const value = input[name];
    if (value === undefined || value === null) {
      values[name] = null;
      continue;
    }
    if (kind === "string") values[name] = typeof value === "string" ? cleanText(name, value, max ?? 256) : null;
    else if (kind === "int") values[name] = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
    else if (kind === "bool") values[name] = typeof value === "boolean" ? value : null;
    else {
      const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
      values[name] = Number.isNaN(ms) ? null : new Date(ms).toISOString();
    }
  }
  for (const name of REQUIRED[table]) if (values[name] === null || values[name] === "") return { refused: `${name}_missing` };
  const startedMs = Date.parse(values.started_at as string);
  if (nowMs - startedMs > MAX_AGE_MS) return { refused: "too_old" };
  if (startedMs - nowMs > MAX_SKEW_MS) return { refused: "in_future" };
  const key = table === "runs" ? `runs:${values.run_id}` : `cases:${values.run_id}:${values.case_id}`;
  return { table, key, values };
}

function authorize(request: Request, env: TraceUploadWorkerEnv): DevEventsSource {
  const ci = env.DEV_TRACE_CI_TOKEN?.trim();
  const dev = env.DEV_TRACE_DEV_TOKEN?.trim();
  // Unconfigured = endpoint off; answer like an unknown route.
  if (!ci && !dev) throw new HttpError(404, "Not found");
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (presented && ci && constantTimeEqual(presented, ci)) return "ci";
  if (presented && dev && constantTimeEqual(presented, dev)) return "dev";
  throw rejected(401, "bad_token");
}

let cachedClient: { endpoint: string; key: string; client: DevEventsScopeDbClient } | null = null;

function client(env: TraceUploadWorkerEnv): DevEventsScopeDbClient | null {
  if (env.DEV_TRACE_SCOPEDB_CLIENT) return env.DEV_TRACE_SCOPEDB_CLIENT;
  // Own key if one is configured; otherwise the service's existing ScopeDB
  // write key (the trace_events_v2 projector's), per tygg 11-19.
  const endpoint = (env.DEV_TRACE_SCOPEDB_ENDPOINT || env.SCOPEDB_TRACE_EVENTS_ENDPOINT)?.trim();
  const key = (env.DEV_TRACE_SCOPEDB_WRITE_KEY || env.SCOPEDB_TRACE_EVENTS_WRITE_KEY)?.trim();
  if (!endpoint || !key) return null;
  if (cachedClient?.endpoint !== endpoint || cachedClient.key !== key) {
    cachedClient = { endpoint, key, client: new Client(endpoint, { apiKey: key }) as unknown as DevEventsScopeDbClient };
  }
  return cachedClient.client;
}

export async function ingestDevEvents(request: Request, env: TraceUploadWorkerEnv, nowMs = Date.now()): Promise<Response> {
  const source = authorize(request, env);
  const sink = client(env);
  // Answering 2xx without a sink would make the uploader drop its rows.
  if (!sink) throw rejected(503, "sink_not_configured");
  const text = new TextDecoder().decode(await readRequestBodyWithLimit(request, MAX_BYTES));
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length > MAX_ROWS) throw rejected(413, "too_many_rows");
  const receivedAt = new Date(nowMs).toISOString();
  const byTable: Record<DevEventsTable, string[]> = { runs: [], cases: [] };
  const refused: Record<string, number> = {};
  let duplicates = 0;
  const batchKeys = new Set<string>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      refused.not_json = (refused.not_json ?? 0) + 1;
      continue;
    }
    const row = readDevEventRow(parsed, nowMs);
    if ("refused" in row) {
      refused[row.refused] = (refused[row.refused] ?? 0) + 1;
      continue;
    }
    if (batchKeys.has(row.key) || seen.has(row.key)) {
      duplicates++;
      continue;
    }
    batchKeys.add(row.key);
    byTable[row.table].push(JSON.stringify({ received_at: receivedAt, source, ...row.values }));
  }
  let accepted = 0;
  for (const table of ["runs", "cases"] as const) {
    if (byTable[table].length === 0) continue;
    await sink.table(table, { database: DEV_EVENTS_DATABASE, schema: DEV_EVENTS_SCHEMA }).append(`${byTable[table].join("\n")}\n`);
    accepted += byTable[table].length;
  }
  for (const key of batchKeys) remember(key);
  if (Object.keys(refused).length > 0) {
    console.warn(`[TraceUploadWorker] dev-events refused rows source=${source} ${JSON.stringify(refused)}`);
  }
  return jsonResponse({ ok: true, source, accepted, duplicates, refused }, 202);
}

function rejected(status: number, reason: string): HttpError {
  console.warn(`[TraceUploadWorker] dev-events rejected status=${status} reason=${reason}`);
  return new HttpError(status, reason);
}
