import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  createTraceContext,
  TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
  type TraceEventRecord,
} from "@botiverse/raft-shared";
import { jitteredFlushDelayMs, ScopeDbTraceEventSink } from "./scopeDbTraceEventSink.js";

function makeEventRecord(overrides: Partial<TraceEventRecord> = {}): TraceEventRecord {
  return {
    span: {
      context: createTraceContext({
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
      }),
      name: "server.agent.activity.resolve",
      surface: "server",
      kind: "internal",
      startTimeMs: 1_000,
      attrs: {
        agent_id: "agent-1",
        server_id: "server-1",
        route_pattern: "/api/agents/:id/activity",
      },
    },
    event: {
      name: "activity.hint.candidate",
      timeMs: 1_001,
      attrs: {
        event_kind: "activity_snapshot",
        hint_source: "redis",
        resolved_activity: "working",
        machine_affinity_route: "aws_replay",
        replay_status: 503,
        raw_payload: "must not pass through",
      },
    },
    eventIndex: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

class FakeIngestStream {
  readonly pending: unknown[] = [];
  readonly flushed: unknown[][] = [];
  readonly flushedAtMs: number[] = [];
  shutdownCount = 0;
  flushCount = 0;
  failFlush = false;
  blockFirstFlush: Promise<void> | null = null;

  async send(record: unknown): Promise<void> {
    this.pending.push(record);
  }

  async flush(): Promise<{ num_rows_inserted: number } | null> {
    this.flushCount += 1;
    if (this.blockFirstFlush && this.flushCount === 1) {
      await this.blockFirstFlush;
    }
    if (this.failFlush) {
      throw new Error("private upstream detail");
    }
    if (this.pending.length === 0) return null;
    const rows = this.pending.splice(0);
    this.flushed.push(rows);
    this.flushedAtMs.push(Date.now());
    return { num_rows_inserted: rows.length };
  }

  async shutdown(): Promise<{ num_rows_inserted: number } | null> {
    this.shutdownCount += 1;
    return this.flush();
  }
}

function makeFakeClient(
  streamFactory: () => FakeIngestStream = () => new FakeIngestStream(),
  schemaColumns: readonly (readonly [string, string])[] = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
) {
  const streams: FakeIngestStream[] = [];
  const statements: string[] = [];
  let schemaReads = 0;
  const builderOptions: Array<{ flushIntervalMs?: number; channelCapacity?: number }> = [];
  const client = {
    table() {
      const table = {
        withSchema: () => table,
        tableSchema: async () => {
          schemaReads += 1;
          return {
            fields: () => schemaColumns.map(([name, dataType]) => ({
              name: () => name,
              dataType: () => dataType,
            })),
          };
        },
      };
      return table;
    },
    ingestStream(statement: string) {
      statements.push(statement);
      const options: { flushIntervalMs?: number; channelCapacity?: number } = {};
      builderOptions.push(options);
      return {
        flushInterval(value: number) {
          options.flushIntervalMs = value;
          return this;
        },
        channelCapacity(value: number) {
          options.channelCapacity = value;
          return this;
        },
        build() {
          const stream = streamFactory();
          streams.push(stream);
          return stream;
        },
      };
    },
  };

  return { client, streams, statements, builderOptions, schemaReads: () => schemaReads };
}

test("jitteredFlushDelayMs keeps flushes inside the configured window", () => {
  assert.equal(jitteredFlushDelayMs(4_000, 1_000, () => 0), 4_000);
  assert.equal(jitteredFlushDelayMs(4_000, 1_000, () => 0.999), 4_999);
  assert.equal(jitteredFlushDelayMs(4_000, 0, () => 0.5), 4_000);
});

for (const rowsPerSecond of [100, 110]) {
  test(`512-row batches stay timer-bound at ${rowsPerSecond} rows/s`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: 0 });
    const fake = makeFakeClient();
    const sink = new ScopeDbTraceEventSink({
      endpoint: "https://scopedb.example",
      token: "test-token",
      serviceName: "slock-server-test",
      batchSize: 512,
      flushIntervalMs: 4_000,
      flushJitterMs: 0,
      validateLiveSchema: false,
      client: fake.client as never,
    });
    const tickMs = Math.floor(1_000 / rowsPerSecond);
    const recordsPerWindow = Math.ceil(4_000 / tickMs);

    for (let window = 0; window < 2; window += 1) {
      for (let row = 0; row < recordsPerWindow; row += 1) {
        sink.recordEvent(makeEventRecord());
        vi.advanceTimersByTime(tickMs);
      }
      await sink.flush();
    }

    assert.equal(fake.streams.length, 1);
    assert.equal(fake.streams[0]?.flushed.length, 2);
    const [firstFlushAt, secondFlushAt] = fake.streams[0]?.flushedAtMs ?? [];
    assert.ok(firstFlushAt !== undefined && secondFlushAt !== undefined);
    assert.ok(secondFlushAt - firstFlushAt >= 4_000);
    await sink.shutdown();
  });
}

test("ScopeDbTraceEventSink writes addEvent-time rows through SDK ingestStream without touching OTLP", async () => {
  const fake = makeFakeClient();
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    deploymentEnvironment: "test",
    serviceRevision: "abc123",
    serviceInstanceId: "ecs:opaque-task",
    deploymentInstanceSource: "aws_ecs_task",
    deploymentIdentityState: "resolved",
    ecsTaskId: "opaque-task",
    ecsTaskFamily: "slock-prod",
    ecsTaskRevision: "16",
    batchSize: 1,
    flushIntervalMs: 60_000,
    client: fake.client as never,
  });

  sink.recordEvent(makeEventRecord());
  await sink.shutdown();

  assert.deepEqual(fake.statements, [TRACE_EVENT_ROW_V2_INGEST_STATEMENT]);
  assert.equal(fake.schemaReads(), 1);
  assert.deepEqual(fake.builderOptions, [{ flushIntervalMs: 60_000, channelCapacity: 1 }]);
  assert.equal(fake.streams.length, 1);
  assert.equal(fake.streams[0]?.shutdownCount, 1);
  assert.equal(fake.streams[0]?.flushed.length, 1);
  assert.deepEqual(fake.streams[0]?.flushed[0]?.[0], {
    row_kind: "event",
    service_name: "slock-server-test",
    deployment_environment: "test",
    service_version: null,
    service_revision: "abc123",
    service_instance_id: "ecs:opaque-task",
    deployment_instance_source: "aws_ecs_task",
    deployment_identity_state: "resolved",
    ecs_task_id: "opaque-task",
    ecs_task_family: "slock-prod",
    ecs_task_revision: "16",
    trace_id: "1".repeat(32),
    span_id: "2".repeat(16),
    parent_span_id: null,
    span_name: "server.agent.activity.resolve",
    span_kind: "internal",
    span_surface: "server",
    span_status: null,
    span_start_time_ms: 1_000,
    span_end_time_ms: null,
    event_name: "activity.hint.candidate",
    event_kind: "activity_snapshot",
    event_time: "1970-01-01T00:00:01.001Z",
    event_time_ms: 1_001,
    event_index: 0,
    server_id: "server-1",
    machine_id: null,
    agent_id: "agent-1",
    launch_id: null,
    session_id: null,
    request_id: null,
    operation_id: null,
    route_pattern: "/api/agents/:id/activity",
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
    hint_source: "redis",
    weak_source: null,
    competing_fact: null,
    resolved_activity: "working",
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
    machine_affinity_route: "aws_replay",
    replay_status: 503,
  });
});

test("ScopeDbTraceEventSink writes span fact rows at span end without OTLP events", async () => {
  const fake = makeFakeClient();
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    deploymentEnvironment: "test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    client: fake.client as never,
  });

  sink.recordSpanFact({
    span: {
      context: createTraceContext({
        traceId: "3".repeat(32),
        spanId: "4".repeat(16),
      }),
      name: "server.machine.websocket.heartbeat_timer",
      surface: "server",
      kind: "internal",
      status: "error",
      startTimeMs: 2_000,
      endTimeMs: 2_030,
      durationMs: 30,
      attrs: {
        machine_id: "machine-1",
        outcome: "timeout",
        reason: "missed_heartbeat",
      },
      events: [],
    },
  });
  await sink.shutdown();

  assert.equal(fake.streams.length, 1);
  assert.equal(fake.streams[0]?.flushed.length, 1);
  assert.deepEqual(fake.streams[0]?.flushed[0]?.[0], {
    row_kind: "span_fact",
    service_name: "slock-server-test",
    deployment_environment: "test",
    service_version: null,
    service_revision: null,
    service_instance_id: null,
    deployment_instance_source: null,
    deployment_identity_state: null,
    ecs_task_id: null,
    ecs_task_family: null,
    ecs_task_revision: null,
    trace_id: "3".repeat(32),
    span_id: "4".repeat(16),
    parent_span_id: null,
    span_name: "server.machine.websocket.heartbeat_timer",
    span_kind: "internal",
    span_surface: "server",
    span_status: "error",
    span_start_time_ms: 2_000,
    span_end_time_ms: 2_030,
    event_name: "server.machine.websocket.heartbeat_timer",
    event_kind: null,
    event_time: "1970-01-01T00:00:02.030Z",
    event_time_ms: 2_030,
    event_index: null,
    server_id: null,
    machine_id: "machine-1",
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
    outcome: "timeout",
    reason: "missed_heartbeat",
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
  });
});

test("ScopeDbTraceEventSink fails visibly before opening a stream when the live schema drifts", async () => {
  const fake = makeFakeClient(
    () => new FakeIngestStream(),
    TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, -1),
  );
  const errors: Error[] = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    client: fake.client as never,
    onError: (error) => errors.push(error),
  });

  sink.recordEvent(makeEventRecord());
  await sink.shutdown();

  assert.equal(fake.schemaReads(), 1);
  assert.equal(fake.streams.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.name, "TraceEventRowV2SchemaMismatchError");
});

test("ScopeDbTraceEventSink drops oldest rows when event row queue is full", async () => {
  let releaseFirstIngest!: () => void;
  const firstIngestBlocked = new Promise<void>((resolve) => {
    releaseFirstIngest = resolve;
  });
  const fake = makeFakeClient(() => {
    const stream = new FakeIngestStream();
    stream.blockFirstFlush = firstIngestBlocked;
    return stream;
  });
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 2,
    maxQueueSize: 2,
    flushIntervalMs: 60_000,
    client: fake.client as never,
  });

  sink.recordEvent(makeEventRecord({ event: { name: "first", timeMs: 1 }, eventIndex: 0 }));
  sink.recordEvent(makeEventRecord({ event: { name: "second", timeMs: 2 }, eventIndex: 1 }));
  sink.recordEvent(makeEventRecord({ event: { name: "third", timeMs: 3 }, eventIndex: 2 }));
  sink.recordEvent(makeEventRecord({ event: { name: "fourth", timeMs: 4 }, eventIndex: 3 }));
  sink.recordEvent(makeEventRecord({ event: { name: "fifth", timeMs: 5 }, eventIndex: 4 }));
  releaseFirstIngest();
  await new Promise((resolve) => setImmediate(resolve));
  await sink.shutdown();

  assert.equal(sink.getDroppedCount(), 1);
  assert.equal(fake.streams.length, 1);
  assert.equal(fake.streams[0]?.flushed.length, 2);
  const rows = fake.streams[0]?.flushed[1] as Array<{ event_name: string }>;
  assert.deepEqual(rows.map((row) => row.event_name), ["fourth", "fifth"]);
});

test("ScopeDbTraceEventSink reports closed health events for successful flushes and queue drops", async () => {
  const queueSizes: number[] = [];
  const flushes: Array<{ outcome: string; atMs: number }> = [];
  const exported: number[] = [];
  const dropped: Array<{ reason: string; count: number }> = [];
  let releaseFirstIngest!: () => void;
  const firstIngestBlocked = new Promise<void>((resolve) => {
    releaseFirstIngest = resolve;
  });
  const fake = makeFakeClient(() => {
    const stream = new FakeIngestStream();
    stream.blockFirstFlush = firstIngestBlocked;
    return stream;
  });
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    maxQueueSize: 1,
    flushIntervalMs: 60_000,
    client: fake.client as never,
    observer: {
      setQueueSize: (size) => queueSizes.push(size),
      recordFlush: (outcome, atMs) => flushes.push({ outcome, atMs }),
      recordRowsExported: (count) => exported.push(count),
      recordRowsDropped: (reason, count) => dropped.push({ reason, count }),
    },
  });

  sink.recordEvent(makeEventRecord({ event: { name: "first", timeMs: 1 }, eventIndex: 0 }));
  sink.recordEvent(makeEventRecord({ event: { name: "second", timeMs: 2 }, eventIndex: 1 }));
  sink.recordEvent(makeEventRecord({ event: { name: "third", timeMs: 3 }, eventIndex: 2 }));
  releaseFirstIngest();
  await new Promise((resolve) => setImmediate(resolve));
  await sink.shutdown();

  assert.equal(queueSizes[0], 0);
  assert.equal(queueSizes.at(-1), 0);
  assert.deepEqual(dropped, [{ reason: "queue_full", count: 1 }]);
  assert.deepEqual(exported, [1, 1]);
  assert.deepEqual(flushes.map(({ outcome }) => outcome), ["success", "success"]);
  assert.equal(flushes.every(({ atMs }) => Number.isFinite(atMs) && atMs > 0), true);
});

test("ScopeDbTraceEventSink reports export-error drops without raw error labels", async () => {
  const dropped: Array<{ reason: string; count: number }> = [];
  const flushes: string[] = [];
  const errors: Error[] = [];
  const fake = makeFakeClient(() => {
    const stream = new FakeIngestStream();
    stream.failFlush = true;
    return stream;
  });
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 2,
    flushIntervalMs: 60_000,
    client: fake.client as never,
    onError: (err) => errors.push(err),
    observer: {
      setQueueSize: () => {},
      recordFlush: (outcome) => flushes.push(outcome),
      recordRowsExported: () => assert.fail("failed flush must not report exported rows"),
      recordRowsDropped: (reason, count) => dropped.push({ reason, count }),
    },
  });

  sink.recordEvent(makeEventRecord());
  await sink.shutdown();

  assert.deepEqual(dropped, [{ reason: "export_error", count: 1 }]);
  assert.deepEqual(flushes, ["error"]);
  assert.equal(errors.length, 1);
});

test("ScopeDbTraceEventSink rebuilds a fatal SDK stream after fail-aside export drops", async () => {
  const dropped: Array<{ reason: string; count: number }> = [];
  const errors: Error[] = [];
  let streamIndex = 0;
  const fake = makeFakeClient(() => {
    streamIndex += 1;
    const stream = new FakeIngestStream();
    stream.failFlush = streamIndex === 1;
    return stream;
  });
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    client: fake.client as never,
    onError: (err) => errors.push(err),
    observer: {
      setQueueSize: () => {},
      recordFlush: () => {},
      recordRowsExported: () => {},
      recordRowsDropped: (reason, count) => dropped.push({ reason, count }),
    },
  });

  sink.recordEvent(makeEventRecord({ event: { name: "fails", timeMs: 1 }, eventIndex: 0 }));
  await sink.flush();
  sink.recordEvent(makeEventRecord({ event: { name: "recovers", timeMs: 2 }, eventIndex: 1 }));
  await sink.shutdown();

  assert.deepEqual(dropped, [{ reason: "export_error", count: 1 }]);
  assert.equal(errors.length, 1);
  assert.equal(fake.streams.length, 2);
  assert.deepEqual((fake.streams[1]?.flushed[0] as Array<{ event_name: string }>).map((row) => row.event_name), ["recovers"]);
});
