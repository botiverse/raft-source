import {
  assertTraceEventRowV2TableSchema,
  assertTraceContext,
  TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  traceEventRowForRecord,
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
}

export type ScopeDbTraceEventProjectorClient = Pick<Client, "insert" | "table">;

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

  constructor(options: ScopeDbTraceEventProjectorOptions) {
    this.client = options.client ?? new Client(options.endpoint, { apiKey: options.token });
    this.endpoint = options.endpoint;
  }

  async project(
    records: readonly ProjectableTraceRecord[],
    resource: TraceProjectionResource,
  ): Promise<TraceProjectionResult> {
    const rows: TraceEventRow[] = [];
    let spansProjected = 0;
    let spansSkipped = 0;
    const skipReasonClasses = new Set<TraceProjectionSkipReasonClass>();
    for (const record of records) {
      try {
        rows.push(...projectTraceEventRows([record], resource));
        spansProjected += 1;
      } catch {
        // Fail visibly at record granularity. A malformed record must not erase
        // otherwise valid siblings from the same authenticated request batch.
        spansSkipped += 1;
        skipReasonClasses.add(TRACE_PROJECTION_RECORD_VALIDATION_ERROR);
      }
    }
    if (rows.length === 0) {
      return {
        spansProjected,
        rowsProjected: 0,
        spansSkipped,
        skipReasonClasses: [...skipReasonClasses].sort(),
      };
    }

    await validateLiveTraceEventSchema(this.client, this.endpoint);

    // Decision-support, committed one-shot write. The request/R2 boundary owns
    // retry; this projector intentionally has no process-local durability.
    const payload = rows.map((row) => JSON.stringify(row)).join("\n");
    const result = await this.client.insert(payload, TRACE_EVENT_ROW_V2_INGEST_STATEMENT);
    if (result.num_rows_inserted !== rows.length) {
      throw new Error(`ScopeDB inserted ${result.num_rows_inserted}/${rows.length} projected trace rows`);
    }
    return {
      spansProjected,
      rowsProjected: rows.length,
      spansSkipped,
      skipReasonClasses: [...skipReasonClasses].sort(),
    };
  }
}

async function validateLiveTraceEventSchema(
  client: Pick<Client, "table">,
  endpoint: string,
): Promise<void> {
  let validation = schemaValidationByEndpoint.get(endpoint);
  if (!validation) {
    validation = client.table("trace_events_v2")
      .withSchema("raft")
      .tableSchema({ signal: AbortSignal.timeout(5_000) })
      .then((schema) => {
        assertTraceEventRowV2TableSchema(schema.fields().map((field) => ({
          name: field.name(),
          dataType: field.dataType(),
        })));
      })
      .catch((error) => {
        schemaValidationByEndpoint.delete(endpoint);
        throw error;
      });
    schemaValidationByEndpoint.set(endpoint, validation);
  }
  await validation;
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
