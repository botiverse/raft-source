import assert from "node:assert/strict";
import {
  createTraceContext,
  TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
  type TraceEventRecord,
} from "@botiverse/raft-shared";
import { Client } from "scopedb";
import { classifyScopeDbAppendFailure } from "@botiverse/raft-shared";
import { jitteredFlushDelayMs, ScopeDbTraceEventSink } from "./scopeDbTraceEventSink";

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

class FakeAppendStream {
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

type BuilderOptions = {
  flushIntervalMs?: number;
  channelCapacity?: number;
  maxConcurrentBatches?: number;
  attemptTimeoutMs?: number | null;
  maxRetries?: number;
  maxElapsedTimeMs?: number;
};

function makeFakeClient(
  streamFactory: () => FakeAppendStream = () => new FakeAppendStream(),
  schemaColumns: readonly (readonly [string, string])[] = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
) {
  const streams: FakeAppendStream[] = [];
  const appendTables: string[] = [];
  const catalogTables: string[] = [];
  let schemaReads = 0;
  const builderOptions: BuilderOptions[] = [];
  const client = {
    table(name: string, options?: { database?: string; schema?: string }) {
      const identifier = `${options?.database ?? "scopedb"}.${options?.schema ?? "public"}.${name}`;
      return {
        catalog() {
          return {
            async get() {
              schemaReads += 1;
              catalogTables.push(identifier);
              return {
                etag: '"1"',
                definition: {
                  name,
                  columns: schemaColumns.map(([columnName, dataType]) => ({ name: columnName, data_type: dataType })),
                },
              };
            },
          };
        },
        appendStream() {
          appendTables.push(identifier);
          const options: BuilderOptions = {};
          builderOptions.push(options);
          return {
            flushIntervalMs(value: number) {
              options.flushIntervalMs = value;
              return this;
            },
            channelCapacity(value: number) {
              options.channelCapacity = value;
              return this;
            },
            maxConcurrentBatches(value: number) {
              options.maxConcurrentBatches = value;
              return this;
            },
            attemptTimeoutMs(value: number | null) {
              options.attemptTimeoutMs = value;
              return this;
            },
            maxRetries(value: number) {
              options.maxRetries = value;
              return this;
            },
            maxElapsedTimeMs(value: number) {
              options.maxElapsedTimeMs = value;
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
    },
  };

  return { client, streams, appendTables, catalogTables, builderOptions, schemaReads: () => schemaReads };
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

test("ScopeDbTraceEventSink writes addEvent-time rows through the SDK Append stream without touching OTLP", async () => {
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

  assert.deepEqual(fake.appendTables, ["scopedb.raft.trace_events_v2"]);
  assert.deepEqual(fake.catalogTables, ["scopedb.raft.trace_events_v2"]);
  assert.equal(fake.schemaReads(), 1);
  assert.deepEqual(fake.builderOptions, [{
    flushIntervalMs: 60_000,
    channelCapacity: 1,
    maxConcurrentBatches: 1,
    attemptTimeoutMs: 10_000,
    maxRetries: 2,
    maxElapsedTimeMs: 30_000,
  }]);
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
    route_pattern: "/api/agents/:id/activity",
    caller_kind: null,
    db_system: null,
    query_name: null,
    phase: null,
    query_fingerprint: null,
    outcome: null,
    reason: null,
    source: null,
    authority: null,
    activity_write_site: null,
    activity_source: null,
    hint_source: "redis",
    resolved_activity: "working",
    previous_activity: null,
    next_activity: null,
    repair_kind: null,
    action: null,
    error_class: null,
    sqlstate: null,
    timeout_bucket: null,
    retryable: null,
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
    error_message: null,
  });
  // Append records carry exactly the projection columns, in projection order.
  assert.deepEqual(
    Object.keys(fake.streams[0]?.flushed[0]?.[0] as object),
    TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([column]) => column),
  );
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
    route_pattern: null,
    caller_kind: null,
    db_system: null,
    query_name: null,
    phase: null,
    query_fingerprint: null,
    outcome: "timeout",
    reason: "missed_heartbeat",
    source: null,
    authority: null,
    activity_write_site: null,
    activity_source: null,
    hint_source: null,
    resolved_activity: null,
    previous_activity: null,
    next_activity: null,
    repair_kind: null,
    action: null,
    error_class: null,
    sqlstate: null,
    timeout_bucket: null,
    retryable: null,
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
    error_message: null,
  });
});

test("ScopeDbTraceEventSink fails visibly before opening a stream when the live schema drifts", async () => {
  const fake = makeFakeClient(
    () => new FakeAppendStream(),
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
    const stream = new FakeAppendStream();
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
    const stream = new FakeAppendStream();
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
    const stream = new FakeAppendStream();
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
    const stream = new FakeAppendStream();
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

async function requestBodyText(init: RequestInit | undefined): Promise<string> {
  const bytes = await new Response(init?.body as BodyInit).arrayBuffer();
  if (new Headers(init?.headers).get("content-encoding") !== "gzip") return new TextDecoder().decode(bytes);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

test("ScopeDbTraceEventSink sends strictly encoded NDJSON to the 0.4 Append endpoint through the real SDK", async () => {
  const requests: Array<{ url: string; method?: string; body: string; auth: string | null }> = [];
  const client = new Client("https://scopedb.example", {
    apiKey: "test-token",
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.method === undefined || init.method === "GET") {
        requests.push({ url, method: "GET", body: "", auth: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({
          name: "trace_events_v2",
          columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType })),
        }), { status: 200, headers: { "content-type": "application/json", etag: '"1"' } });
      }
      const body = await requestBodyText(init);
      requests.push({ url, method: init.method, body, auth: new Headers(init.headers).get("authorization") });
      const rows = body.split("\n").filter((line) => line.trim()).length;
      return new Response(JSON.stringify({ status: "committed", num_rows_inserted: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const exported: number[] = [];
  const errors: Error[] = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 2,
    flushIntervalMs: 60_000,
    client,
    onError: (err) => errors.push(err),
    observer: {
      setQueueSize: () => {},
      recordFlush: () => {},
      recordRowsExported: (count) => exported.push(count),
      recordRowsDropped: () => assert.fail("no rows should drop"),
    },
  });

  sink.recordEvent(makeEventRecord());
  sink.recordEvent(makeEventRecord({ event: { name: "second", timeMs: 1_002.6 }, eventIndex: 1 }));
  await sink.shutdown();

  assert.deepEqual(errors, []);
  assert.deepEqual(exported, [2]);
  assert.equal(requests[0]?.url, "https://scopedb.example/v1/catalog/databases/scopedb/schemas/raft/tables/trace_events_v2");
  const appends = requests.filter((request) => request.method === "POST");
  assert.equal(appends.length, 1);
  assert.equal(appends[0]?.url, "https://scopedb.example/v1/catalog/databases/scopedb/schemas/raft/tables/trace_events_v2/ingest");
  assert.equal(appends[0]?.auth, "Bearer test-token");
  assert.equal(requests.some((request) => request.url.endsWith("/v1/ingest")), false);
  const lines = appends[0]!.body.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 2);
  const second = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(second), TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([column]) => column));
  assert.equal(second.event_time, "1970-01-01T00:00:01.002Z");
  assert.equal(second.event_time_ms, 1_002);
  assert.equal(second.replay_status, null);
  assert.equal(second.event_index, 1);
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(first.replay_status, 503);
  assert.equal(first.event_time, "1970-01-01T00:00:01.001Z");
  assert.equal("raw_payload" in first, false);
});

test("ScopeDbTraceEventSink re-queues a batch refused with a plain-text 429 (real SDK) and exports it once", async () => {
  const posts: Array<{ status: number; rows: string[] }> = [];
  let appendCalls = 0;
  const client = new Client("https://scopedb.example", {
    apiKey: "test-token",
    fetch: async (_input, init) => {
      if (init?.method === undefined || init.method === "GET") {
        return new Response(JSON.stringify({
          name: "trace_events_v2",
          columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType })),
        }), { status: 200, headers: { "content-type": "application/json", etag: '"1"' } });
      }
      appendCalls += 1;
      const rows = (await requestBodyText(init)).split("\n").filter((line) => line.trim());
      if (appendCalls === 1) {
        // A gateway-style throttle: no structured ScopeDB error body, so the
        // SDK reports outcome "ambiguous" and its stream does not replay it.
        posts.push({ status: 429, rows });
        return new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } });
      }
      posts.push({ status: 200, rows });
      return new Response(JSON.stringify({ status: "committed", num_rows_inserted: rows.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const exported: number[] = [];
  const dropped: Array<{ reason: string; count: number }> = [];
  const flushes: string[] = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 2,
    flushIntervalMs: 5,
    flushJitterMs: 0,
    client,
    onError: () => {},
    observer: {
      setQueueSize: () => {},
      recordFlush: (outcome) => flushes.push(outcome),
      recordRowsExported: (count) => exported.push(count),
      recordRowsDropped: (reason, count) => dropped.push({ reason, count }),
    },
  });

  sink.recordEvent(makeEventRecord({ event: { name: "first", timeMs: 1 }, eventIndex: 0 }));
  sink.recordEvent(makeEventRecord({ event: { name: "second", timeMs: 2 }, eventIndex: 1 }));
  const deadline = Date.now() + 2_000;
  while (exported.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await sink.shutdown();

  assert.deepEqual(dropped, []);
  assert.deepEqual(exported, [2]);
  assert.deepEqual(flushes, ["error", "success"]);
  assert.deepEqual(posts.map((post) => post.status), [429, 200], "one SDK attempt per flush; the sink re-sent the batch");
  assert.deepEqual(posts[1]!.rows.map((line) => JSON.parse(line).event_name), ["first", "second"]);
  assert.equal(sink.getDroppedCount(), 0);
});

function failingStream(errors: unknown[]): () => FakeAppendStream {
  return () => {
    const stream = new FakeAppendStream();
    const flush = stream.flush.bind(stream);
    stream.flush = async () => {
      const next = errors.shift();
      if (next !== undefined) {
        stream.pending.splice(0);
        throw next;
      }
      return flush();
    };
    return stream;
  };
}

test("ScopeDbTraceEventSink honours Retry-After before re-sending a throttled batch", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: 0 });
  // The SDK's shape for a plain-body 429: synthesized "ambiguous" with the HTTP failure as cause.
  const throttled = Object.assign(new Error("Too Many Requests"), {
    httpStatus: 429, retryAfterMs: 2_000, outcome: "ambiguous", cause: Object.assign(new Error("Too Many Requests"), { httpStatus: 429 }),
  });
  const fake = makeFakeClient(failingStream([throttled]));
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 10,
    flushJitterMs: 0,
    validateLiveSchema: false,
    client: fake.client as never,
    onError: () => {},
  });

  sink.recordEvent(makeEventRecord());
  await vi.advanceTimersByTimeAsync(1);
  // A new full batch does not bypass the backoff.
  sink.recordEvent(makeEventRecord({ event: { name: "later", timeMs: 3 }, eventIndex: 1 }));
  await vi.advanceTimersByTimeAsync(1_900);
  assert.equal(fake.streams.flatMap((stream) => stream.flushed).length, 0);
  await vi.advanceTimersByTimeAsync(200);
  await sink.shutdown();

  const exportedRows = fake.streams.flatMap((stream) => stream.flushed).flat() as Array<{ event_name: string }>;
  assert.deepEqual(exportedRows.map((row) => row.event_name), ["activity.hint.candidate", "later"]);
  assert.equal(sink.getDroppedCount(), 0);
});

test("ScopeDbTraceEventSink drops, never replays, a batch whose outcome is unknown after a timeout", async () => {
  const timedOut = Object.assign(new Error("write request timed out"), {
    httpStatus: undefined,
    outcome: "ambiguous",
    writeDetails: { reason: "timeout", outcome: "ambiguous" },
  });
  const dropped: Array<{ reason: string; count: number }> = [];
  const fake = makeFakeClient(failingStream([timedOut]));
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    validateLiveSchema: false,
    client: fake.client as never,
    onError: () => {},
    observer: { setQueueSize: () => {}, recordFlush: () => {}, recordRowsExported: () => {}, recordRowsDropped: (reason, count) => dropped.push({ reason, count }) },
  });

  sink.recordEvent(makeEventRecord());
  await sink.flush();
  await sink.shutdown();

  assert.deepEqual(dropped, [{ reason: "export_error", count: 1 }]);
  assert.equal(fake.streams.flatMap((stream) => stream.flushed).length, 0);
});

test("ScopeDbTraceEventSink counts a throttled batch at shutdown as dropped instead of holding it", async () => {
  const throttled = Object.assign(new Error("Service Unavailable"), {
    httpStatus: 503, outcome: "ambiguous", cause: Object.assign(new Error("Service Unavailable"), { httpStatus: 503 }),
  });
  const dropped: Array<{ reason: string; count: number }> = [];
  const fake = makeFakeClient(failingStream([throttled]));
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 10,
    flushIntervalMs: 60_000,
    validateLiveSchema: false,
    client: fake.client as never,
    onError: () => {},
    observer: { setQueueSize: () => {}, recordFlush: () => {}, recordRowsExported: () => {}, recordRowsDropped: (reason, count) => dropped.push({ reason, count }) },
  });

  sink.recordEvent(makeEventRecord());
  await sink.shutdown();

  assert.deepEqual(dropped, [{ reason: "export_error", count: 1 }]);
  assert.equal(sink.getDroppedCount(), 1);
});

test("ScopeDbTraceEventSink drops only the row it cannot encode, as encode_error", async () => {
  const dropped: Array<{ reason: string; count: number }> = [];
  const exported: number[] = [];
  const fake = makeFakeClient();
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 3,
    flushIntervalMs: 60_000,
    validateLiveSchema: false,
    client: fake.client as never,
    onError: () => {},
    observer: { setQueueSize: () => {}, recordFlush: () => {}, recordRowsExported: (count) => exported.push(count), recordRowsDropped: (reason, count) => dropped.push({ reason, count }) },
  });

  const bad = makeEventRecord({ event: { name: "bad", timeMs: 2 }, eventIndex: 1 });
  sink.recordEvent(makeEventRecord({ event: { name: "good-1", timeMs: 1 }, eventIndex: 0 }));
  sink.recordEvent({ ...bad, span: { ...bad.span, startTimeMs: Number.POSITIVE_INFINITY } });
  sink.recordEvent(makeEventRecord({ event: { name: "good-2", timeMs: 3 }, eventIndex: 2 }));
  await sink.shutdown();

  assert.deepEqual(dropped, [{ reason: "encode_error", count: 1 }]);
  assert.deepEqual(exported, [2]);
  assert.deepEqual((fake.streams[0]?.flushed[0] as Array<{ event_name: string }>).map((row) => row.event_name), ["good-1", "good-2"]);
});

/** A real 0.4 client: the catalog read succeeds, every Append gets `appendResponse()`; POST times are recorded. */
function throttlingSdkClient(appendResponse: () => Response, latencyMs = 0) {
  const postTimesMs: number[] = [];
  const client = new Client("https://scopedb.example", {
    apiKey: "test-token",
    fetch: async (_input, init) => {
      if (init?.method === undefined || init.method === "GET") {
        return new Response(JSON.stringify({
          name: "trace_events_v2",
          columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType })),
        }), { status: 200, headers: { "content-type": "application/json", etag: '"1"' } });
      }
      postTimesMs.push(Date.now());
      // Latency keeps a flush in flight while events arm the interval timer.
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return appendResponse();
    },
  });
  return { client, postTimesMs };
}

async function recordEventsFor(sink: ScopeDbTraceEventSink, durationMs: number, everyMs: number): Promise<void> {
  const endMs = Date.now() + durationMs;
  let index = 0;
  while (Date.now() < endMs) {
    sink.recordEvent(makeEventRecord({ event: { name: `event-${index}`, timeMs: index + 1 }, eventIndex: index }));
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

function gaps(times: readonly number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index]!);
}

test("ScopeDbTraceEventSink backoff doubles under sustained plain 429s even while events keep arriving (real SDK)", async () => {
  const sdk = throttlingSdkClient(() => new Response("Too Many Requests", { status: 429 }), 10);
  const dropped: Array<{ reason: string; count: number }> = [];
  const errors: Error[] = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 2,
    maxQueueSize: 10_000,
    flushIntervalMs: 25,
    flushJitterMs: 0,
    client: sdk.client,
    onError: (err) => errors.push(err),
    observer: { setQueueSize: () => {}, recordFlush: () => {}, recordRowsExported: () => {}, recordRowsDropped: (reason, count) => dropped.push({ reason, count }) },
  });

  // An event every 3 ms: far more often than the 25 ms flush interval and with
  // every batch-size fast path triggered, yet neither may cut the backoff short.
  await recordEventsFor(sink, 1_000, 3);
  const posts = [...sdk.postTimesMs];
  const warningsWhileThrottled = errors.length;
  await sink.shutdown();

  // Backoff 25, 50, 100, 200, 400 ms: about six POSTs in a second, not ~40.
  assert.ok(posts.length >= 4 && posts.length <= 7, `POSTs at ${posts.map((time) => time - posts[0]!)}`);
  const observed = gaps(posts);
  observed.forEach((gap, index) => {
    assert.ok(gap >= 25 * 2 ** index * 0.9, `gap ${index} was ${gap} ms (${observed})`);
  });
  assert.equal(warningsWhileThrottled, 1, "one warning per backoff episode");
  // Nothing was dropped while throttled except queue overflow; shutdown then
  // counts the refused batch and the backlog.
  assert.ok(dropped.every(({ reason }) => reason === "export_error" || reason === "shutdown"), JSON.stringify(dropped));
});

test("ScopeDbTraceEventSink waits at least Retry-After between throttled POSTs while events keep arriving (real SDK)", async () => {
  const sdk = throttlingSdkClient(() => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } }), 10);
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 2,
    maxQueueSize: 10_000,
    flushIntervalMs: 25,
    flushJitterMs: 0,
    client: sdk.client,
    onError: () => {},
  });

  await recordEventsFor(sink, 2_300, 5);
  const posts = [...sdk.postTimesMs];
  await sink.shutdown();

  assert.ok(posts.length >= 2 && posts.length <= 3, `POSTs at ${posts.map((time) => time - posts[0]!)}`);
  for (const gap of gaps(posts)) assert.ok(gap >= 990, `gap ${gap} ms is shorter than Retry-After: 1`);
});

test("ScopeDbTraceEventSink shutdown drains a re-queued backlog batch by batch", async () => {
  const throttled = Object.assign(new Error("Too Many Requests"), {
    httpStatus: 429, retryAfterMs: 60_000, outcome: "ambiguous", cause: Object.assign(new Error("plain"), { httpStatus: 429 }),
  });
  const dropped: Array<{ reason: string; count: number }> = [];
  const exported: number[] = [];
  const fake = makeFakeClient(failingStream([throttled]));
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 4,
    flushIntervalMs: 60_000,
    validateLiveSchema: false,
    client: fake.client as never,
    onError: () => {},
    observer: { setQueueSize: () => {}, recordFlush: () => {}, recordRowsExported: (count) => exported.push(count), recordRowsDropped: (reason, count) => dropped.push({ reason, count }) },
  });

  for (let index = 0; index < 4; index += 1) sink.recordEvent(makeEventRecord({ event: { name: `e${index}`, timeMs: index + 1 }, eventIndex: index }));
  await sink.flush(); // throttled: re-queued, backing off for a minute
  for (let index = 4; index < 20; index += 1) sink.recordEvent(makeEventRecord({ event: { name: `e${index}`, timeMs: index + 1 }, eventIndex: index }));
  await sink.shutdown();

  assert.deepEqual(dropped, []);
  assert.deepEqual(exported, [4, 4, 4, 4, 4]);
  const names = fake.streams.flatMap((stream) => stream.flushed).flat().map((row) => (row as { event_name: string }).event_name);
  assert.deepEqual(names, Array.from({ length: 20 }, (_, index) => `e${index}`));
});

test("ScopeDbTraceEventSink shutdown counts what it cannot drain: the failed batch as export_error, the rest as shutdown", async () => {
  const throttled = () => Object.assign(new Error("Too Many Requests"), {
    httpStatus: 429, outcome: "ambiguous", cause: Object.assign(new Error("plain"), { httpStatus: 429 }),
  });
  const dropped: Array<{ reason: string; count: number }> = [];
  const fake = makeFakeClient(failingStream([throttled(), throttled(), throttled()]));
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 4,
    flushIntervalMs: 60_000,
    validateLiveSchema: false,
    client: fake.client as never,
    onError: () => {},
    observer: { setQueueSize: () => {}, recordFlush: () => {}, recordRowsExported: () => {}, recordRowsDropped: (reason, count) => dropped.push({ reason, count }) },
  });

  for (let index = 0; index < 10; index += 1) sink.recordEvent(makeEventRecord({ event: { name: `e${index}`, timeMs: index + 1 }, eventIndex: index }));
  await sink.flush(); // throttled, re-queued
  await sink.shutdown(); // first drain batch throttled again: export_error, then stop

  assert.deepEqual(dropped, [{ reason: "export_error", count: 4 }, { reason: "shutdown", count: 6 }]);
  assert.equal(sink.getDroppedCount(), 10);
});

test("classifyScopeDbAppendFailure matches the errors the real 0.4 SDK throws", async () => {
  const errorFor = async (status: number, body: string, stream: boolean): Promise<unknown> => {
    const client = new Client("https://scopedb.example", { apiKey: "k", fetch: async () => new Response(body, { status }) });
    const table = client.table("trace_events_v2", { schema: "raft" });
    if (!stream) return table.append('{"row_kind":"event"}').then(() => assert.fail("expected a failure"), (err: unknown) => err);
    const appendStream = table.appendStream().maxConcurrentBatches(1).maxRetries(1).initialBackoff(1).maxBackoff(2).build();
    await appendStream.send({ row_kind: "event" });
    const error = await appendStream.flush().then(() => assert.fail("expected a failure"), (err: unknown) => err);
    await appendStream.shutdown().catch(() => {});
    return error;
  };

  // The server itself says the outcome is unknown (may have committed): never re-send, even on 503.
  for (const stream of [false, true]) {
    assert.deepEqual(
      classifyScopeDbAppendFailure(await errorFor(503, JSON.stringify({ message: "maybe", details: { status: "unknown" } }), stream)),
      { class: "unknown", retryable: false, httpStatus: 503 },
    );
  }
  // A plain-body 503 is the SDK's synthesized ambiguous (a gateway's text, not ScopeDB): re-sent.
  assert.deepEqual(classifyScopeDbAppendFailure(await errorFor(503, "upstream unavailable", true)),
    { class: "unavailable", retryable: true, httpStatus: 503 });
  // 0.4: any JSON 5xx may have committed, even one whose body says rejected: never re-send.
  assert.deepEqual(
    classifyScopeDbAppendFailure(await errorFor(500, JSON.stringify({ message: "busy", details: { status: "rejected" } }), true)),
    { class: "unknown", retryable: false, httpStatus: 500 },
  );
  // ScopeDB's error envelope on a 4xx is a permanent rejection.
  assert.deepEqual(
    classifyScopeDbAppendFailure(await errorFor(400, JSON.stringify({ error: { code: "invalid_argument", message: "type mismatch" } }), false)),
    { class: "rejected", retryable: false, httpStatus: 400 },
  );
  // A JSON 4xx body without ScopeDB's error `code` is ambiguous in 0.4.
  assert.deepEqual(
    classifyScopeDbAppendFailure(await errorFor(400, JSON.stringify({ message: "type mismatch", details: { status: "rejected" } }), false)),
    { class: "unknown", retryable: false, httpStatus: 400 },
  );
});

/** A real 0.4 client: catalog reads get `catalogResponse()`, Appends commit; requests are recorded. */
function catalogSdkClient(catalogResponse: () => Response) {
  const requests: Array<{ method: string; url: string }> = [];
  const client = new Client("https://scopedb.example", {
    apiKey: "write-only-key",
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: String(input) });
      if (method === "GET") return catalogResponse();
      const rows = (await requestBodyText(init)).split("\n").filter((line) => line.trim()).length;
      return new Response(JSON.stringify({ status: "committed", num_rows_inserted: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

test("ScopeDbTraceEventSink writes without the schema check when the key cannot read the catalog (real SDK, 403)", async () => {
  const sdk = catalogSdkClient(() => new Response("Forbidden", { status: 403 }));
  const warnings: string[] = [];
  const skipped: string[] = [];
  const skipDetails: unknown[] = [];
  const exported: number[] = [];
  const dropped: Array<{ reason: string; count: number }> = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "write-only-key",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    client: sdk.client,
    warn: (message) => warnings.push(message),
    onError: (err) => assert.fail(`no export error expected: ${err.message}`),
    observer: {
      setQueueSize: () => {},
      recordFlush: () => {},
      recordRowsExported: (count) => exported.push(count),
      recordRowsDropped: (reason, count) => dropped.push({ reason, count }),
      recordSchemaCheckSkipped: (reason, details) => {
        skipped.push(reason);
        skipDetails.push(details);
      },
    },
  });

  sink.recordEvent(makeEventRecord({ event: { name: "first", timeMs: 1 }, eventIndex: 0 }));
  await sink.flush();
  sink.recordEvent(makeEventRecord({ event: { name: "second", timeMs: 2 }, eventIndex: 1 }));
  await sink.flush();
  await sink.shutdown();

  assert.deepEqual(dropped, []);
  assert.deepEqual(exported, [1, 1]);
  assert.deepEqual(skipped, ["unauthorized"], "counted once per skip window, not per batch");
  assert.deepEqual(skipDetails, [{ httpStatus: 403, recheckMs: 600_000 }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /schema check skipped \(unauthorized, HTTP 403\)/);
  assert.deepEqual(sdk.requests.map(({ method }) => method), ["GET", "POST", "POST"], "the catalog is not re-read every batch");
});

test("ScopeDbTraceEventSink still blocks writes when the catalog is read and the schema mismatches (real SDK)", async () => {
  const sdk = catalogSdkClient(() => new Response(JSON.stringify({
    name: "trace_events_v2",
    columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, -1).map(([name, dataType]) => ({ name, data_type: dataType })),
  }), { status: 200, headers: { "content-type": "application/json", etag: '"1"' } }));
  const errors: Error[] = [];
  const dropped: Array<{ reason: string; count: number }> = [];
  const skipped: string[] = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    client: sdk.client,
    warn: () => assert.fail("a mismatch is not a skipped check"),
    onError: (err) => errors.push(err),
    observer: {
      setQueueSize: () => {},
      recordFlush: () => {},
      recordRowsExported: () => assert.fail("must not export"),
      recordRowsDropped: (reason, count) => dropped.push({ reason, count }),
      recordSchemaCheckSkipped: (reason) => skipped.push(reason),
    },
  });

  sink.recordEvent(makeEventRecord());
  await sink.shutdown();

  assert.equal(sdk.requests.some(({ method }) => method === "POST"), false);
  assert.deepEqual(dropped, [{ reason: "export_error", count: 1 }]);
  assert.deepEqual(skipped, []);
  assert.equal(errors[0]?.name, "TraceEventRowV2SchemaMismatchError");
});

test("ScopeDbTraceEventSink treats a failing catalog (503) as a skipped check, not a drop", async () => {
  const sdk = catalogSdkClient(() => new Response("upstream unavailable", { status: 503 }));
  const skipped: string[] = [];
  const exported: number[] = [];
  const sink = new ScopeDbTraceEventSink({
    endpoint: "https://scopedb.example",
    token: "test-token",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    client: sdk.client,
    warn: () => {},
    onError: (err) => assert.fail(err.message),
    observer: {
      setQueueSize: () => {},
      recordFlush: () => {},
      recordRowsExported: (count) => exported.push(count),
      recordRowsDropped: () => assert.fail("no drop expected"),
      recordSchemaCheckSkipped: (reason) => skipped.push(reason),
    },
  });

  sink.recordEvent(makeEventRecord());
  await sink.shutdown();

  assert.deepEqual(exported, [1]);
  assert.deepEqual(skipped, ["catalog_error"]);
});
