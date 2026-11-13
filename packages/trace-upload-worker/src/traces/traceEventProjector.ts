import {
  assertTraceEventRowV2TableSchema,
  assertTraceContext,
  chunkScopeDbAppendLines,
  classifyScopeDbAppendFailure,
  encodeTraceEventRowV2AppendLine,
  traceEventRowForRecord,
  TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS,
  traceEventRowV2SchemaCheckSkipReason,
  traceEventRowV2SchemaFieldsFromCatalog,
  type TraceEventRowV2SchemaCheckSkipReason,
  traceSpanFactRowForSpan,
  type CompletedTraceSpan,
  type TraceAttributes,
  type TraceEvent,
  type TraceEventRecord,
  type TraceEventRow,
  type TraceEventRowResource,
  type TraceSpanKind,
  type TraceStatus,
  type TraceSurface,
} from "@botiverse/raft-shared";
import { Client } from "scopedb";

export interface ProjectableTraceRecord {
  type: "span";
  schema_version: number;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  surface: string;
  kind: string;
  status: string;
  start_time: string;
  end_time: string;
  duration_ms?: number;
  attrs?: Record<string, unknown>;
  events?: Array<{
    name: string;
    time: string;
    attrs?: Record<string, unknown>;
  }>;
}

export interface TraceProjectionResource extends TraceEventRowResource {
  serverId?: string | null;
  machineId?: string | null;
  agentId?: string | null;
}

export interface ScopeDbTraceEventProjectorOptions {
  endpoint: string;
  token: string;
  client?: ScopeDbTraceEventProjectorClient;
  /** Test seam for the throttle backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Append refused with 429/503 after the projector's in-request retries. The
 * refused chunk did not commit, so the upload's V2 projection is reported
 * failed with this retriable class. Earlier chunks of the same upload may
 * already have committed, so a re-ingest of the whole upload can duplicate
 * those rows.
 */
export class TraceProjectionThrottledError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TraceProjectionThrottledError";
  }
}

// Bounded because the projection runs inside the upload request: at most
// three attempts per chunk, and a Retry-After beyond the cap ends the wait.
const THROTTLE_MAX_ATTEMPTS = 3;
const THROTTLE_BASE_DELAY_MS = 250;
const THROTTLE_MAX_DELAY_MS = 2_000;

export type ScopeDbTraceEventProjectorClient = Pick<Client, "table">;

export const TRACE_PROJECTION_RECORD_VALIDATION_ERROR = "TraceProjectionRecordValidationError" as const;
export type TraceProjectionSkipReasonClass = typeof TRACE_PROJECTION_RECORD_VALIDATION_ERROR;

export interface TraceProjectionResult {
  spansProjected: number;
  rowsProjected: number;
  spansSkipped: number;
  skipReasonClasses: readonly TraceProjectionSkipReasonClass[];
}

export const TRACE_UPLOAD_SCOPEDB_PERSISTENCE_TIER = "decision_support" as const;

const schemaValidationByEndpoint = new Map<string, Promise<void>>();
// Endpoint -> until when the live schema check is skipped (catalog unreadable).
const schemaCheckSkippedUntilByEndpoint = new Map<string, number>();
const warnedSchemaCheckSkips = new Set<string>();
const schemaCheckSkipCounts: Record<TraceEventRowV2SchemaCheckSkipReason, number> = { unauthorized: 0, catalog_error: 0 };

/**
 * Live schema checks this process skipped, by reason. The worker has no
 * metrics endpoint: this count is for tests, and each skip window also logs
 * `[TraceUploadWorker] V2 live schema check skipped` (warned once per
 * endpoint and reason).
 */
export function traceEventSchemaCheckSkipCounts(): Readonly<Record<TraceEventRowV2SchemaCheckSkipReason, number>> {
  return { ...schemaCheckSkipCounts };
}

const ATTR_ALIASES = {
  serverId: "server_id",
  machineId: "machine_id",
  agentId: "agent_id",
  launchId: "launch_id",
  sessionId: "session_id",
  requestId: "request_id",
  operationId: "operation_id",
  routePattern: "route_pattern",
  callerKind: "caller_kind",
  eventKind: "event_kind",
  errorClass: "error_class",
  statusBucket: "status_bucket",
} as const;

const TRACE_SURFACES = new Set<TraceSurface>(["server", "daemon", "web", "computer"]);
const TRACE_SPAN_KINDS = new Set<TraceSpanKind>(["server", "client", "internal", "producer", "consumer"]);
const TRACE_STATUSES = new Set<TraceStatus>(["unset", "ok", "error", "cancelled"]);

/**
 * Converts authenticated local/web span records into the same closed-schema V2
 * rows produced by the server sink. Unknown attributes are deliberately not
 * copied: the shared row helper promotes only its explicit allowlist.
 */
export function projectTraceEventRows(
  records: readonly ProjectableTraceRecord[],
  resource: TraceProjectionResource,
): TraceEventRow[] {
  const rows: TraceEventRow[] = [];
  for (const record of records) {
    const context = {
      traceId: record.trace_id,
      spanId: record.span_id,
      parentSpanId: record.parent_span_id ?? null,
      traceFlags: "00",
    };
    assertTraceContext(context);

    const surface = readClosedValue(record.surface, TRACE_SURFACES, "surface");
    const kind = readClosedValue(record.kind, TRACE_SPAN_KINDS, "kind");
    const status = readClosedValue(record.status, TRACE_STATUSES, "status");
    const startTimeMs = readIsoTime(record.start_time, "start_time");
    const endTimeMs = readIsoTime(record.end_time, "end_time");
    if (endTimeMs < startTimeMs) throw new Error("end_time must not precede start_time");

    const spanAttrs = normalizeAttrs(record.attrs, resource, true);
    const events: TraceEvent[] = (record.events ?? []).map((event) => ({
      name: event.name,
      timeMs: readIsoTime(event.time, "event.time"),
      attrs: normalizeAttrs(event.attrs, resource, false),
    }));

    const completedSpan: CompletedTraceSpan = {
      context,
      name: record.name,
      surface,
      kind,
      status,
      startTimeMs,
      endTimeMs,
      durationMs: endTimeMs - startTimeMs,
      attrs: spanAttrs,
      events,
    };

    events.forEach((event, eventIndex) => {
      const eventRecord: TraceEventRecord = {
        span: {
          context,
          name: record.name,
          surface,
          kind,
          startTimeMs,
          attrs: spanAttrs,
        },
        event,
        eventIndex,
      };
      rows.push(traceEventRowForRecord(eventRecord, resource));
    });
    rows.push(traceSpanFactRowForSpan(completedSpan, resource));
  }
  return rows;
}

export class ScopeDbTraceEventProjector {
  private readonly client: ScopeDbTraceEventProjectorClient;
  private readonly endpoint: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ScopeDbTraceEventProjectorOptions) {
    this.client = options.client ?? new Client(options.endpoint, { apiKey: options.token });
    this.endpoint = options.endpoint;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One Append per attempt (the SDK never replays a direct append). Only a
   * refusal that cannot have committed (429/503 with no client timeout, as
   * classifyScopeDbAppendFailure reads it) is retried, so a retry never
   * duplicates; the SDK reports a plain-body 429 as outcome "ambiguous", which
   * is why the HTTP status decides. Anything else fails the projection.
   */
  private async appendChunk(table: ReturnType<ScopeDbTraceEventProjectorClient["table"]>, ndjson: string, committedRows: number) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await table.append(ndjson);
      } catch (error) {
        const failure = classifyScopeDbAppendFailure(error);
        if (!failure.retryable) throw error;
        const delayMs = Math.max(THROTTLE_BASE_DELAY_MS * 2 ** (attempt - 1), failure.retryAfterMs ?? 0);
        if (attempt >= THROTTLE_MAX_ATTEMPTS || delayMs > THROTTLE_MAX_DELAY_MS) {
          throw new TraceProjectionThrottledError(
            `ScopeDB refused a trace projection chunk (${failure.class}, HTTP ${failure.httpStatus ?? "n/a"}) after ${attempt} attempt(s); `
              + `${committedRows} row(s) of this upload were already committed, so a re-ingest can duplicate them`,
            { cause: error },
          );
        }
        await this.sleep(delayMs);
      }
    }
  }

  async project(
    records: readonly ProjectableTraceRecord[],
    resource: TraceProjectionResource,
  ): Promise<TraceProjectionResult> {
    const lines: string[] = [];
    let spansProjected = 0;
    let spansSkipped = 0;
    const skipReasonClasses = new Set<TraceProjectionSkipReasonClass>();
    for (const record of records) {
      try {
        // Encode inside the record boundary: Append rejects a whole request
        // for one value it cannot store (an out-of-range timestamp or
        // integer from an uploaded record), so such a record is skipped
        // like any other invalid one instead of failing its siblings.
        const recordLines = projectTraceEventRows([record], resource).map(encodeTraceEventRowV2AppendLine);
        lines.push(...recordLines);
        spansProjected += 1;
      } catch {
        // Fail visibly at record granularity. A malformed record must not erase
        // otherwise valid siblings from the same authenticated request batch.
        spansSkipped += 1;
        skipReasonClasses.add(TRACE_PROJECTION_RECORD_VALIDATION_ERROR);
      }
    }
    if (lines.length === 0) {
      return {
        spansProjected,
        rowsProjected: 0,
        spansSkipped,
        skipReasonClasses: [...skipReasonClasses].sort(),
      };
    }

    await validateLiveTraceEventSchema(this.client, this.endpoint);

    // Decision-support, committed Append writes (one attempt each). The
    // request/R2 boundary owns retry; this projector intentionally has no
    // process-local durability. A large upload is split into Append-sized
    // requests (4 MiB / 200k rows); if a later chunk fails after earlier ones
    // committed, the boundary's retry re-sends those rows too (duplicates in
    // a decision-support table, never loss).
    const table = this.client.table("trace_events_v2", { schema: "raft" });
    let inserted = 0;
    for (const chunk of chunkScopeDbAppendLines(lines)) {
      const result = await this.appendChunk(table, chunk.ndjson, inserted);
      inserted += result.num_rows_inserted;
    }
    if (inserted !== lines.length) {
      throw new Error(`ScopeDB inserted ${inserted}/${lines.length} projected trace rows`);
    }
    return {
      spansProjected,
      rowsProjected: lines.length,
      spansSkipped,
      skipReasonClasses: [...skipReasonClasses].sort(),
    };
  }
}

/**
 * Only a schema that was read and does not match blocks the projection. A
 * catalog that cannot be read (a write-only key refused with 401/403, or a
 * timeout/5xx) skips the check for TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS and
 * the rows are appended; Append itself rejects a real mismatch, so this never
 * loses more than blocking, which would fail every upload's projection.
 */
async function validateLiveTraceEventSchema(
  client: Pick<Client, "table">,
  endpoint: string,
): Promise<void> {
  if (Date.now() < (schemaCheckSkippedUntilByEndpoint.get(endpoint) ?? 0)) return;
  let validation = schemaValidationByEndpoint.get(endpoint);
  if (!validation) {
    const pending: Promise<void> = client.table("trace_events_v2", { schema: "raft" })
      .catalog()
      .get({ signal: AbortSignal.timeout(5_000) })
      .then(
        (snapshot) => {
          assertTraceEventRowV2TableSchema(traceEventRowV2SchemaFieldsFromCatalog(snapshot.definition));
        },
        (error: unknown) => {
          skipSchemaCheck(endpoint, traceEventRowV2SchemaCheckSkipReason(error), error);
          if (schemaValidationByEndpoint.get(endpoint) === pending) schemaValidationByEndpoint.delete(endpoint);
        },
      )
      .catch((error: unknown) => {
        if (schemaValidationByEndpoint.get(endpoint) === pending) schemaValidationByEndpoint.delete(endpoint);
        throw error;
      });
    validation = pending;
    schemaValidationByEndpoint.set(endpoint, validation);
  }
  await validation;
}

function skipSchemaCheck(endpoint: string, reason: TraceEventRowV2SchemaCheckSkipReason, error: unknown): void {
  schemaCheckSkippedUntilByEndpoint.set(endpoint, Date.now() + TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS[reason]);
  schemaCheckSkipCounts[reason] += 1;
  const key = `${endpoint}\n${reason}`;
  if (warnedSchemaCheckSkips.has(key)) return;
  warnedSchemaCheckSkips.add(key);
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
  console.warn("[TraceUploadWorker] V2 live schema check skipped; appending without it", {
    reason,
    ...(typeof status === "number" ? { http_status: status } : {}),
    recheck_s: TRACE_EVENT_ROW_V2_SCHEMA_RECHECK_MS[reason] / 1000,
  });
}

function normalizeAttrs(
  input: Record<string, unknown> | undefined,
  resource: TraceProjectionResource,
  includeResourceFallback: boolean,
): TraceAttributes {
  const attrs: TraceAttributes = { ...(input ?? {}) };
  for (const [camelKey, snakeKey] of Object.entries(ATTR_ALIASES)) {
    if (attrs[snakeKey] === undefined && attrs[camelKey] !== undefined) {
      attrs[snakeKey] = attrs[camelKey];
    }
  }
  if (includeResourceFallback) {
    if (attrs.server_id === undefined && resource.serverId) attrs.server_id = resource.serverId;
    if (attrs.machine_id === undefined && resource.machineId) attrs.machine_id = resource.machineId;
    if (attrs.agent_id === undefined && resource.agentId) attrs.agent_id = resource.agentId;
  }
  return attrs;
}

function readIsoTime(value: string, field: string): number {
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) throw new Error(`${field} must be an ISO timestamp`);
  return timeMs;
}

function readClosedValue<T extends string>(value: string, allowed: ReadonlySet<T>, field: string): T {
  if (!allowed.has(value as T)) throw new Error(`Unsupported trace ${field}: ${value}`);
  return value as T;
}
