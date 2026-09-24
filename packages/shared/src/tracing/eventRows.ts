import type { CompletedTraceSpan, TraceAttributes, TraceEvent, TraceEventRecord, TraceSpanKind, TraceStatus, TraceSurface } from "./index.js";

export interface TraceEventRowResource {
  serviceName: string;
  deploymentEnvironment?: string | null;
  serviceVersion?: string | null;
  serviceRevision?: string | null;
  serviceInstanceId?: string | null;
  deploymentInstanceSource?: string | null;
  deploymentIdentityState?: string | null;
  ecsTaskId?: string | null;
  ecsTaskFamily?: string | null;
  ecsTaskRevision?: string | null;
}

export interface TraceEventRow {
  row_kind: "event" | "span_fact";
  service_name: string;
  deployment_environment: string | null;
  service_version: string | null;
  service_revision: string | null;
  service_instance_id: string | null;
  deployment_instance_source: string | null;
  deployment_identity_state: string | null;
  ecs_task_id: string | null;
  ecs_task_family: string | null;
  ecs_task_revision: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  span_name: string;
  span_kind: TraceSpanKind;
  span_surface: TraceSurface;
  span_status: TraceStatus | null;
  span_start_time_ms: number;
  span_end_time_ms: number | null;
  event_name: string;
  event_kind: string | null;
  event_time: string;
  event_time_ms: number;
  event_index: number | null;
  server_id: string | null;
  machine_id: string | null;
  agent_id: string | null;
  launch_id: string | null;
  session_id: string | null;
  request_id: string | null;
  operation_id: string | null;
  route_pattern: string | null;
  caller_kind: string | null;
  db_system: string | null;
  query_name: string | null;
  phase: string | null;
  query_fingerprint: string | null;
  inbox_backend: string | null;
  inbox_route: string | null;
  inbox_fallback_reason: string | null;
  inbox_contract_version: number | null;
  router_reason: string | null;
  stale_owner_cleanup_result: string | null;
  stale_owner_cleanup_reason: string | null;
  outcome: string | null;
  reason: string | null;
  source: string | null;
  authority: string | null;
  activity_write_site: string | null;
  activity_source: string | null;
  hint_source: string | null;
  weak_source: string | null;
  competing_fact: string | null;
  resolved_activity: string | null;
  previous_activity: string | null;
  next_activity: string | null;
  repair_kind: string | null;
  action: string | null;
  error_class: string | null;
  error_kind: string | null;
  error_subkind: string | null;
  rw_failure_stage: string | null;
  sqlstate: string | null;
  timeout_bucket: string | null;
  retryable: string | null;
  driver_code: string | null;
  rw_breaker_state: string | null;
  fallback_target: string | null;
  fallback_outcome: string | null;
  terminal_status: string | null;
  timeout_ms: number | null;
  rw_pool_total: number | null;
  rw_pool_idle: number | null;
  rw_pool_waiting: number | null;
  fallback_latency_ms: number | null;
  status_bucket: string | null;
  shadow_agent_id: string | null;
  shadow_signal_site: string | null;
  shadow_observation_class: string | null;
  shadow_prior_projection: string | null;
  shadow_projection: string | null;
  shadow_legacy_outcome: string | null;
  shadow_action: string | null;
  shadow_reason: string | null;
  shadow_direction: string | null;
  shadow_plan_kind: string | null;
  machine_affinity_route: string | null;
  replay_status: number | null;
}

type TraceEventRowStringKey = {
  [K in keyof TraceEventRow]: TraceEventRow[K] extends string | null ? K : never;
}[keyof TraceEventRow];

type TraceEventRowNumberKey = {
  [K in keyof TraceEventRow]: TraceEventRow[K] extends number | null ? K : never;
}[keyof TraceEventRow];

type TraceEventRowProjectionColumn = {
  [K in keyof TraceEventRow]: readonly [
    K,
    K extends "event_time"
      ? "timestamp"
      : TraceEventRow[K] extends number | null
        ? "int"
        : "string",
  ];
}[keyof TraceEventRow];

/**
 * The live Trace V2 ScopeDB projection. Keep executable schema ownership in
 * code so every producer uses one reviewable, type-checked statement rather
 * than copying the SQL value through deployment configuration.
 */
export const TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS = [
  ["row_kind", "string"],
  ["service_name", "string"],
  ["deployment_environment", "string"],
  ["service_version", "string"],
  ["service_revision", "string"],
  ["service_instance_id", "string"],
  ["deployment_instance_source", "string"],
  ["deployment_identity_state", "string"],
  ["ecs_task_id", "string"],
  ["ecs_task_family", "string"],
  ["ecs_task_revision", "string"],
  ["trace_id", "string"],
  ["span_id", "string"],
  ["parent_span_id", "string"],
  ["span_name", "string"],
  ["span_kind", "string"],
  ["span_surface", "string"],
  ["span_status", "string"],
  ["span_start_time_ms", "int"],
  ["span_end_time_ms", "int"],
  ["event_name", "string"],
  ["event_kind", "string"],
  ["event_time", "timestamp"],
  ["event_time_ms", "int"],
  ["event_index", "int"],
  ["server_id", "string"],
  ["machine_id", "string"],
  ["agent_id", "string"],
  ["launch_id", "string"],
  ["session_id", "string"],
  ["request_id", "string"],
  ["route_pattern", "string"],
  ["caller_kind", "string"],
  ["outcome", "string"],
  ["reason", "string"],
  ["source", "string"],
  ["authority", "string"],
  ["activity_write_site", "string"],
  ["activity_source", "string"],
  ["hint_source", "string"],
  ["resolved_activity", "string"],
  ["previous_activity", "string"],
  ["next_activity", "string"],
  ["repair_kind", "string"],
  ["action", "string"],
  ["error_class", "string"],
  ["status_bucket", "string"],
  ["shadow_agent_id", "string"],
  ["shadow_signal_site", "string"],
  ["shadow_observation_class", "string"],
  ["shadow_prior_projection", "string"],
  ["shadow_projection", "string"],
  ["shadow_legacy_outcome", "string"],
  ["shadow_action", "string"],
  ["shadow_reason", "string"],
  ["shadow_direction", "string"],
  ["shadow_plan_kind", "string"],
  ["machine_affinity_route", "string"],
  ["replay_status", "int"],
  ["db_system", "string"],
  ["query_name", "string"],
  ["phase", "string"],
  ["sqlstate", "string"],
  ["query_fingerprint", "string"],
  ["timeout_bucket", "string"],
  ["retryable", "string"],
] as const satisfies readonly TraceEventRowProjectionColumn[];

/**
 * The immediately preceding projection remains valid during the additive
 * seven-column rollout. Old workers keep using this explicit 59-column insert
 * against the expanded table while new workers write the full projection.
 */
export const TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS =
  Object.freeze(TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, 59));

export const TRACE_EVENT_ROW_V2_TABLE = "raft.trace_events_v2";

/** SHA-256 of JSON.stringify(TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS). */
export const TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT =
  "sha256:bc054cd6b79fe489eac8252fd91e8dcb4663ddc4b8d249395f5317a0c6bb5f46";

export const TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT =
  "sha256:d8cbabe44110bb2bc108a48021dbee4e37af732d6cc52c97fdcf06cb44b5e1ce";

function buildTraceEventRowV2IngestStatement(
  columns: readonly TraceEventRowProjectionColumn[],
): string {
  return [
    "SELECT",
    columns
      .map(([column, type]) => `$0["${column}"]::${type} AS ${column}`)
      .join(", "),
    `INSERT INTO ${TRACE_EVENT_ROW_V2_TABLE}`,
    `(${columns.map(([column]) => column).join(", ")})`,
  ].join(" ");
}

export const TRACE_EVENT_ROW_V2_INGEST_STATEMENT =
  buildTraceEventRowV2IngestStatement(TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS);

export const TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT =
  buildTraceEventRowV2IngestStatement(TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS);

export function isTraceEventRowV2CompatibleIngestStatement(value: string): boolean {
  return value === TRACE_EVENT_ROW_V2_INGEST_STATEMENT
    || value === TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT;
}

export function isTraceEventRowV2CompatibleSchemaFingerprint(value: string): boolean {
  return value === TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT
    || value === TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT;
}

export interface TraceEventRowV2SchemaField {
  name: string;
  dataType: string;
}

export class TraceEventRowV2SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceEventRowV2SchemaMismatchError";
  }
}

export function assertTraceEventRowV2TableSchema(
  actualFields: readonly TraceEventRowV2SchemaField[],
): void {
  const actualByName = new Map<string, string>();
  for (const field of actualFields) {
    if (actualByName.has(field.name)) {
      throw new TraceEventRowV2SchemaMismatchError(
        `Trace V2 table has duplicate column ${field.name}`,
      );
    }
    actualByName.set(field.name, field.dataType);
  }

  TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.forEach(([expectedName, expectedType]) => {
    const actualType = actualByName.get(expectedName);
    if (actualType === undefined) {
      throw new TraceEventRowV2SchemaMismatchError(
        `Trace V2 required column ${expectedName} is missing`,
      );
    }
    if (actualType !== expectedType) {
      throw new TraceEventRowV2SchemaMismatchError(
        `Trace V2 required column ${expectedName} has type ${actualType}; expected ${expectedType}`,
      );
    }
  });
}

const PROMOTED_IDENTITY_ATTRS = [
  "server_id",
  "machine_id",
  "agent_id",
  "launch_id",
  "session_id",
  "request_id",
  "operation_id",
  "route_pattern",
  "caller_kind",
  "db_system",
  "query_name",
  "phase",
  "query_fingerprint",
  "inbox_backend",
  "inbox_route",
  "inbox_fallback_reason",
] as const satisfies readonly TraceEventRowStringKey[];

const PROMOTED_CLOSED_ATTRS = [
  "router_reason",
  "stale_owner_cleanup_result",
  "stale_owner_cleanup_reason",
  "outcome",
  "reason",
  "event_kind",
  "source",
  "authority",
  "activity_write_site",
  "activity_source",
  "hint_source",
  "weak_source",
  "competing_fact",
  "resolved_activity",
  "previous_activity",
  "next_activity",
  "repair_kind",
  "action",
  "error_class",
  "error_kind",
  "error_subkind",
  "rw_failure_stage",
  "sqlstate",
  "timeout_bucket",
  "retryable",
  "driver_code",
  "rw_breaker_state",
  "fallback_target",
  "fallback_outcome",
  "terminal_status",
  "status_bucket",
  "shadow_agent_id",
  "shadow_signal_site",
  "shadow_observation_class",
  "shadow_prior_projection",
  "shadow_projection",
  "shadow_legacy_outcome",
  "shadow_action",
  "shadow_reason",
  "shadow_direction",
  "shadow_plan_kind",
  "machine_affinity_route",
] as const satisfies readonly TraceEventRowStringKey[];

export const TRACE_EVENT_ROW_PROMOTED_ATTRS = [
  ...PROMOTED_IDENTITY_ATTRS,
  ...PROMOTED_CLOSED_ATTRS,
] as const satisfies readonly TraceEventRowStringKey[];

const PROMOTED_NUMERIC_ATTRS = [
  "inbox_contract_version",
  "timeout_ms",
  "rw_pool_total",
  "rw_pool_idle",
  "rw_pool_waiting",
  "fallback_latency_ms",
  "replay_status",
] as const satisfies readonly TraceEventRowNumberKey[];

export function traceEventRowsForSpan(
  span: {
    context: TraceEventRecord["span"]["context"];
    name: string;
    surface: TraceSurface;
    kind: TraceSpanKind;
    status?: TraceStatus | null;
    startTimeMs: number;
    endTimeMs?: number | null;
    attrs?: TraceAttributes;
    events: readonly TraceEvent[];
  },
  resource: TraceEventRowResource,
): TraceEventRow[] {
  return span.events.map((event, index) => traceEventRowForEvent(span, event, index, resource));
}

export function traceSpanFactRowForSpan(
  span: CompletedTraceSpan,
  resource: TraceEventRowResource,
): TraceEventRow {
  const spanProjection = {
    context: span.context,
    name: span.name,
    surface: span.surface,
    kind: span.kind,
    status: span.status,
    startTimeMs: span.startTimeMs,
    endTimeMs: span.endTimeMs,
    ...(span.attrs ? { attrs: span.attrs } : {}),
  };
  return traceEventRowForEvent(spanProjection, {
    name: span.name,
    timeMs: span.endTimeMs,
  }, null, resource, "span_fact");
}

export function traceEventRowForRecord(
  record: TraceEventRecord,
  resource: TraceEventRowResource,
): TraceEventRow {
  return traceEventRowForEvent({
    ...record.span,
    status: null,
    endTimeMs: null,
  }, record.event, record.eventIndex, resource);
}

function traceEventRowForEvent(
  span: {
    context: TraceEventRecord["span"]["context"];
    name: string;
    surface: TraceSurface;
    kind: TraceSpanKind;
    status?: TraceStatus | null;
    startTimeMs: number;
    endTimeMs?: number | null;
    attrs?: TraceAttributes;
  },
  event: TraceEvent,
  eventIndex: number | null,
  resource: TraceEventRowResource,
  rowKind: TraceEventRow["row_kind"] = "event",
): TraceEventRow {
  const row: TraceEventRow = {
    row_kind: rowKind,
    service_name: resource.serviceName,
    deployment_environment: normalizeString(resource.deploymentEnvironment),
    service_version: normalizeString(resource.serviceVersion),
    service_revision: normalizeString(resource.serviceRevision),
    service_instance_id: normalizeString(resource.serviceInstanceId),
    deployment_instance_source: normalizeString(resource.deploymentInstanceSource),
    deployment_identity_state: normalizeString(resource.deploymentIdentityState),
    ecs_task_id: normalizeString(resource.ecsTaskId),
    ecs_task_family: normalizeString(resource.ecsTaskFamily),
    ecs_task_revision: normalizeString(resource.ecsTaskRevision),
    trace_id: span.context.traceId,
    span_id: span.context.spanId,
    parent_span_id: span.context.parentSpanId,
    span_name: span.name,
    span_kind: span.kind,
    span_surface: span.surface,
    span_status: span.status ?? null,
    span_start_time_ms: span.startTimeMs,
    span_end_time_ms: span.endTimeMs ?? null,
    event_name: event.name,
    event_kind: null,
    event_time: new Date(event.timeMs).toISOString(),
    event_time_ms: event.timeMs,
    event_index: eventIndex,
    server_id: null,
    machine_id: null,
    agent_id: null,
    launch_id: null,
    session_id: null,
    request_id: null,
    operation_id: null,
    route_pattern: null,
    caller_kind: null,
    db_system: null,
    query_name: null,
    phase: null,
    query_fingerprint: null,
    inbox_backend: null,
    inbox_route: null,
    inbox_fallback_reason: null,
    inbox_contract_version: null,
    router_reason: null,
    stale_owner_cleanup_result: null,
    stale_owner_cleanup_reason: null,
    outcome: null,
    reason: null,
    source: null,
    authority: null,
    activity_write_site: null,
    activity_source: null,
    hint_source: null,
    weak_source: null,
    competing_fact: null,
    resolved_activity: null,
    previous_activity: null,
    next_activity: null,
    repair_kind: null,
    action: null,
    error_class: null,
    error_kind: null,
    error_subkind: null,
    rw_failure_stage: null,
    sqlstate: null,
    timeout_bucket: null,
    retryable: null,
    driver_code: null,
    rw_breaker_state: null,
    fallback_target: null,
    fallback_outcome: null,
    terminal_status: null,
    timeout_ms: null,
    rw_pool_total: null,
    rw_pool_idle: null,
    rw_pool_waiting: null,
    fallback_latency_ms: null,
    status_bucket: null,
    shadow_agent_id: null,
    shadow_signal_site: null,
    shadow_observation_class: null,
    shadow_prior_projection: null,
    shadow_projection: null,
    shadow_legacy_outcome: null,
    shadow_action: null,
    shadow_reason: null,
    shadow_direction: null,
    shadow_plan_kind: null,
    machine_affinity_route: null,
    replay_status: null,
  };

  for (const key of TRACE_EVENT_ROW_PROMOTED_ATTRS) {
    row[key] = firstStringAttr(key, event.attrs, span.attrs);
  }
  for (const key of PROMOTED_NUMERIC_ATTRS) {
    row[key] = firstNumberAttr(key, event.attrs, span.attrs);
  }
  return row;
}

function firstStringAttr(
  key: TraceEventRowStringKey,
  eventAttrs: TraceAttributes | undefined,
  spanAttrs: TraceAttributes | undefined,
): string | null {
  return normalizeString(eventAttrs?.[key]) ?? normalizeString(spanAttrs?.[key]);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstNumberAttr(
  key: TraceEventRowNumberKey,
  eventAttrs: TraceAttributes | undefined,
  spanAttrs: TraceAttributes | undefined,
): number | null {
  return normalizeNumber(eventAttrs?.[key]) ?? normalizeNumber(spanAttrs?.[key]);
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
