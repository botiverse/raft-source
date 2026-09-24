import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertSpanEvent,
  assertSpanOrder,
  assertTraceEventRowV2TableSchema,
  BasicTracer,
  createTraceScopeStack,
  createScopedTracer,
  createTraceScopeTracer,
  createTraceContext,
  eventsForSpan,
  formatTraceparent,
  isTraceEventRowV2CompatibleIngestStatement,
  isTraceEventRowV2CompatibleSchemaFingerprint,
  isSpanId,
  isTraceFlags,
  isTraceId,
  MemoryTraceSink,
  noopTracer,
  parseTraceparent,
  projectTraceScopeAttrs,
  spanNames,
  traceEventRowForRecord,
  traceEventRowsForSpan,
  traceSpanFactRowForSpan,
  TRACE_B0_FIELD_DEFINITIONS,
  TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT,
  TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS,
  TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
  TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_TABLE,
  TRACE_LIFECYCLE_SHADOW_SIGNAL_SITE_VALUES,
  TRACE_SCOPE_ATTR_REGISTRY,
  type CompletedTraceSpan,
  type TraceFieldDefinition,
  type TraceEventRecord,
} from "../index.js";

function makeSequence(values: string[]) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1]!;
}

function makeNumberSequence(values: number[]) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1]!;
}

const TEST_TRACE_RESOURCE = { serviceName: "test-service" };

test("trace context uses W3C-compatible lowercase hex fields", () => {
  const context = createTraceContext({
    traceIdGenerator: () => "1".repeat(32),
    spanIdGenerator: () => "1".repeat(16),
  });

  assert.equal(context.traceId, "1".repeat(32));
  assert.equal(context.spanId, "1".repeat(16));
  assert.equal(context.parentSpanId, null);
  assert.equal(context.traceFlags, "00");
  assert.equal(isTraceId(context.traceId), true);
  assert.equal(isSpanId(context.spanId), true);
  assert.equal(isTraceFlags(context.traceFlags), true);
});

test("child trace context inherits trace identity and flags from parent", () => {
  const parent = createTraceContext({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: "01",
  });
  const child = createTraceContext({
    parent,
    spanIdGenerator: () => "c".repeat(16),
  });

  assert.equal(child.traceId, parent.traceId);
  assert.equal(child.spanId, "c".repeat(16));
  assert.equal(child.parentSpanId, parent.spanId);
  assert.equal(child.traceFlags, "01");
});

test("invalid trace context values are rejected early", () => {
  assert.throws(
    () => createTraceContext({ traceId: "not-hex", spanId: "1".repeat(16) }),
    /Invalid traceId/,
  );
  assert.throws(
    () => createTraceContext({ traceId: "1".repeat(32), spanId: "NOTHEXNOTHEXNOTH" }),
    /Invalid spanId/,
  );
  assert.throws(
    () => createTraceContext({ traceId: "0".repeat(32), spanId: "1".repeat(16) }),
    /Invalid traceId/,
  );
  assert.throws(
    () => createTraceContext({ traceId: "1".repeat(32), spanId: "0".repeat(16) }),
    /Invalid spanId/,
  );
});

test("traceparent helpers round-trip a self-contained remote parent", () => {
  const context = createTraceContext({
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: "01",
  });

  const traceparent = formatTraceparent(context);
  assert.equal(traceparent, `00-${"1".repeat(32)}-${"2".repeat(16)}-01`);
  assert.deepEqual(parseTraceparent(traceparent), {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: null,
    traceFlags: context.traceFlags,
  });
});

test("traceparent parser rejects unsupported or invalid wire values", () => {
  assert.equal(parseTraceparent(null), null);
  assert.equal(parseTraceparent(""), null);
  assert.equal(parseTraceparent(`01-${"1".repeat(32)}-${"2".repeat(16)}-00`), null);
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${"2".repeat(16)}-00`), null);
  assert.equal(parseTraceparent(`00-${"1".repeat(32)}-${"0".repeat(16)}-00`), null);
  assert.equal(parseTraceparent(`00-${"1".repeat(32)}-${"2".repeat(16)}-zz`), null);
});

test("noop tracer is always callable and records nothing", () => {
  const span = noopTracer.startSpan("server.agent.deliver", {
    surface: "server",
  });

  span.addEvent("route.entered");
  span.end("ok");

  assert.equal(isTraceId(span.context.traceId), true);
  assert.equal(isSpanId(span.context.spanId), true);
});

test("basic tracer records completed spans in a memory sink", () => {
  const sink = new MemoryTraceSink();
  const clockValues = [10, 15, 25];
  const tracer = new BasicTracer({
    sink,
    clock: () => clockValues.shift() ?? 25,
    traceIdGenerator: () => "2".repeat(32),
    spanIdGenerator: () => "3".repeat(16),
  });

  const span = tracer.startSpan("server.agent.deliver", {
    surface: "server",
    kind: "server",
    attrs: { agentId: "agent-1" },
  });
  span.addEvent("route.entered", { route: "local" });
  span.end("ok", { attrs: { outcome: "delivered" } });

  const trace = sink.getTrace("2".repeat(32));
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.name, "server.agent.deliver");
  assert.equal(trace[0]?.durationMs, 15);
  assert.deepEqual(trace[0]?.attrs, { agentId: "agent-1", outcome: "delivered" });
  assert.deepEqual(trace[0]?.events, [
    { name: "route.entered", timeMs: 15, attrs: { route: "local" } },
  ]);
});

test("basic tracer notifies event sinks at addEvent time before span end", () => {
  const completed: CompletedTraceSpan[] = [];
  const events: TraceEventRecord[] = [];
  const tracer = new BasicTracer({
    sink: {
      record(span) {
        completed.push(span);
      },
      recordEvent(record) {
        events.push(record);
      },
    },
    clock: makeNumberSequence([100, 110, 120]),
    traceIdGenerator: () => "b".repeat(32),
    spanIdGenerator: () => "c".repeat(16),
  });

  const span = tracer.startSpan("server.agent.activity.resolve", {
    surface: "server",
    kind: "internal",
    attrs: { agent_id: "agent-1" },
  });
  span.addEvent("activity.hint.candidate", { hint_source: "redis" });

  assert.equal(completed.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.span.name, "server.agent.activity.resolve");
  assert.equal(events[0]?.span.attrs?.agent_id, "agent-1");
  assert.equal(events[0]?.event.name, "activity.hint.candidate");
  assert.equal(events[0]?.event.timeMs, 110);
  assert.equal(events[0]?.eventIndex, 0);

  span.end("ok");
  assert.equal(completed.length, 1);
});

test("scoped tracer keeps common attrs on the span without copying them into events", () => {
  const sink = new MemoryTraceSink();
  const tracer = createScopedTracer(new BasicTracer({
    sink,
    clock: () => 1,
    traceIdGenerator: () => "4".repeat(32),
    spanIdGenerator: () => "5".repeat(16),
  }), {
    daemonVersion: "0.55.6",
    daemon_version: "0.55.6",
    computerVersion: "0.0.23",
    computer_version: "0.0.23",
  });

  const span = tracer.startSpan("daemon.runtime.telemetry.token_usage", {
    surface: "daemon",
    attrs: {
      daemonVersion: "payload-version",
      agentId: "agent-1",
    },
  });
  span.addEvent("runtime.telemetry.token_usage", {
    daemonVersion: "event-version",
    totalTokens: 123,
  });
  span.end("ok", {
    attrs: {
      daemonVersion: "end-version",
      outcome: "recorded",
    },
  });

  const [recorded] = sink.getAllSpans();
  assert.equal(recorded?.attrs?.daemonVersion, "0.55.6");
  assert.equal(recorded?.attrs?.daemon_version, "0.55.6");
  assert.equal(recorded?.attrs?.computerVersion, "0.0.23");
  assert.equal(recorded?.attrs?.computer_version, "0.0.23");
  assert.equal(recorded?.attrs?.agentId, "agent-1");
  assert.equal(recorded?.attrs?.outcome, "recorded");
  assert.equal("daemonVersion" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal("daemon_version" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal("computerVersion" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal("computer_version" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal(recorded?.events[0]?.attrs?.totalTokens, 123);
});

test("scoped tracer keeps a differing caller-precedence event override", () => {
  const sink = new MemoryTraceSink();
  const tracer = createScopedTracer(new BasicTracer({
    sink,
    clock: () => 1,
    traceIdGenerator: () => "6".repeat(32),
    spanIdGenerator: () => "7".repeat(16),
  }), {
    agent_id: "scope-agent",
    machine_id: "machine-1",
  }, {
    attrPrecedence: "caller",
  });

  const span = tracer.startSpan("server.agent.activity.resolve", {
    surface: "server",
  });
  span.addEvent("activity.hint.candidate", {
    agent_id: "event-agent",
    machine_id: "machine-1",
  });
  span.end();

  const [recorded] = sink.getAllSpans();
  assert.equal(recorded?.attrs?.agent_id, "scope-agent");
  assert.equal(recorded?.events[0]?.attrs?.agent_id, "event-agent");
  assert.equal("machine_id" in (recorded?.events[0]?.attrs ?? {}), false);

  const eventRow = traceEventRowsForSpan(recorded!, TEST_TRACE_RESOURCE).find((row) => row.row_kind === "event");
  assert.equal(eventRow?.agent_id, "event-agent");
  assert.equal(eventRow?.machine_id, "machine-1");
});

test("trace scope projection emits registry-backed attrs and ignores arbitrary baggage", () => {
  const unknownActorFields = { rawPrompt: "must not project" } as Record<string, unknown>;
  const unknownTopLevelFields = { baggage: { raw: "must not project" } } as Record<string, unknown>;
  const attrs = projectTraceScopeAttrs({
    resource: {
      daemonVersion: " 0.57.1 ",
      computerVersion: "",
      deploymentEnvironment: "production",
    },
    request: {
      requestId: "req-1",
      routePattern: "/internal/agent-api/send",
      method: "POST",
      callerKind: "agent",
      userId: "user-1",
      userIdPresent: false,
    },
    actor: {
      serverId: "server-1",
      machineId: "machine-1",
      agentId: "agent-1",
      launchId: "launch-1",
      sessionId: "session-1",
      ...unknownActorFields,
    },
    ...unknownTopLevelFields,
  });

  assert.deepEqual(attrs, {
    daemon_version: "0.57.1",
    daemon_version_present: true,
    computer_version_present: false,
    deployment_environment: "production",
    request_id: "req-1",
    request_id_present: true,
    route_pattern: "/internal/agent-api/send",
    method: "POST",
    caller_kind: "agent",
    user_id: "user-1",
    user_id_present: false,
    server_id: "server-1",
    server_id_present: true,
    machine_id: "machine-1",
    machine_id_present: true,
    agent_id: "agent-1",
    agent_id_present: true,
    launch_id: "launch-1",
    launch_id_present: true,
    session_id: "session-1",
    session_id_present: true,
  });
  assert.equal("rawPrompt" in attrs, false);
  assert.equal("baggage" in attrs, false);
  for (const key of Object.keys(attrs)) {
    assert.ok(key in TRACE_SCOPE_ATTR_REGISTRY, `${key} should be registered`);
  }
});

test("trace scope tracer projects scope once on the span and typed event rows inherit it", () => {
  const sink = new MemoryTraceSink();
  const tracer = createTraceScopeTracer(new BasicTracer({
    sink,
    clock: () => 1,
    traceIdGenerator: () => "c".repeat(32),
    spanIdGenerator: () => "d".repeat(16),
  }), {
    actor: {
      agentId: "agent-1",
      machineId: "machine-1",
    },
  });

  const span = tracer.startSpan("server.runtime_profile.report.ingest", {
    surface: "server",
    kind: "consumer",
    attrs: { runtime: "claude" },
  });
  span.addEvent("record.started", { report_source: "turn_end" });
  span.end("ok", { attrs: { outcome: "recorded" } });

  const [recorded] = sink.getAllSpans();
  assert.equal(recorded?.attrs?.agent_id, "agent-1");
  assert.equal(recorded?.attrs?.agent_id_present, true);
  assert.equal(recorded?.attrs?.machine_id, "machine-1");
  assert.equal(recorded?.attrs?.machine_id_present, true);
  assert.equal(recorded?.attrs?.runtime, "claude");
  assert.equal(recorded?.attrs?.outcome, "recorded");
  assert.equal("agent_id" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal("machine_id" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal(recorded?.events[0]?.attrs?.report_source, "turn_end");

  const eventRow = traceEventRowsForSpan(recorded!, TEST_TRACE_RESOURCE).find((row) => row.row_kind === "event");
  assert.equal(eventRow?.agent_id, "agent-1");
  assert.equal(eventRow?.machine_id, "machine-1");
});

test("trace scope tracer filters business attrs and keeps inherited scope off the event payload", () => {
  const sink = new MemoryTraceSink();
  const tracer = createTraceScopeTracer(new BasicTracer({
    sink,
    clock: () => 1,
    traceIdGenerator: () => "e".repeat(32),
    spanIdGenerator: () => "f".repeat(16),
  }), {
    request: {
      routePattern: "/api/messages",
      method: "POST",
      callerKind: "agent",
    },
    actor: {
      agentIdPresent: true,
    },
  }, {
    spanAttrContracts: {
      "server.http.request": {
        spanAttrs: ["method"],
        eventAttrs: {
          "http.response.finished": ["status_bucket"],
        },
        endAttrs: ["status_bucket", "status_code"],
      },
    },
  });

  const span = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
    attrs: {
      method: "POST",
      raw_url: "/api/messages?secret=token",
    },
  });
  span.addEvent("http.response.finished", {
    status_bucket: "2xx",
    raw_query: "secret=token",
  });
  span.end("ok", {
    attrs: {
      status_bucket: "2xx",
      status_code: 200,
      raw_body: "must not record",
    },
  });

  const [recorded] = sink.getAllSpans();
  assert.equal(recorded?.attrs?.method, "POST");
  assert.equal(recorded?.attrs?.route_pattern, "/api/messages");
  assert.equal(recorded?.attrs?.caller_kind, "agent");
  assert.equal(recorded?.attrs?.agent_id_present, true);
  assert.equal(recorded?.attrs?.status_bucket, "2xx");
  assert.equal(recorded?.attrs?.status_code, 200);
  assert.equal("raw_url" in (recorded?.attrs ?? {}), false);
  assert.equal("raw_body" in (recorded?.attrs ?? {}), false);
  assert.equal(recorded?.events[0]?.attrs?.status_bucket, "2xx");
  assert.equal("route_pattern" in (recorded?.events[0]?.attrs ?? {}), false);
  assert.equal("raw_query" in (recorded?.events[0]?.attrs ?? {}), false);

  const eventRow = traceEventRowsForSpan(recorded!, TEST_TRACE_RESOURCE).find((row) => row.row_kind === "event");
  assert.equal(eventRow?.route_pattern, "/api/messages");
  assert.equal(eventRow?.caller_kind, "agent");
});

test("basic tracer links child spans to parent context", () => {
  const sink = new MemoryTraceSink();
  const spanIds = makeSequence(["4".repeat(16), "5".repeat(16)]);
  const tracer = new BasicTracer({
    sink,
    clock: () => 1,
    traceIdGenerator: () => "6".repeat(32),
    spanIdGenerator: spanIds,
  });

  const parent = tracer.startSpan("server.agent.deliver", { surface: "server" });
  const child = tracer.startSpan("server.agent.deliver.route", {
    parent: parent.context,
    surface: "server",
  });
  child.end();
  parent.end();

  assert.equal(child.context.traceId, parent.context.traceId);
  assert.equal(child.context.parentSpanId, parent.context.spanId);
  assert.deepEqual(spanNames(sink, parent.context.traceId), [
    "server.agent.deliver.route",
    "server.agent.deliver",
  ]);
});

test("memory trace assertion helpers stay thin and process-oriented", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    clock: () => 1,
    traceIdGenerator: () => "7".repeat(32),
    spanIdGenerator: makeSequence(["8".repeat(16), "9".repeat(16)]),
  });

  const deliver = tracer.startSpan("server.agent.deliver", { surface: "server" });
  deliver.addEvent("route.entered");
  const route = tracer.startSpan("server.agent.deliver.route", {
    parent: deliver.context,
    surface: "server",
  });
  route.addEvent("fallback.resolved", { outcome: "skip_local_inbox" });
  route.end();
  deliver.end();

  assertSpanOrder(sink, deliver.context.traceId, [
    "server.agent.deliver.route",
    "server.agent.deliver",
  ]);
  assertSpanEvent(sink, deliver.context.traceId, "server.agent.deliver.route", "fallback.resolved");
  assert.deepEqual(eventsForSpan(sink, deliver.context.traceId, "server.agent.deliver").map((event) => event.name), [
    "route.entered",
  ]);
});

test("memory sink is fixture-owned and resettable", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: () => "b".repeat(16),
  });

  tracer.startSpan("server.agent.deliver", { surface: "server" }).end();
  assert.equal(sink.getAllSpans().length, 1);

  sink.clear();
  assert.equal(sink.getAllSpans().length, 0);
});


// Frozen column snapshots. The fingerprint assertions in the rollout test below
// are self-consistency checks (constant == sha256(current array)): a middle
// insertion that updates both constants would stay green while silently
// breaking the old workers' 59-column insert. These literal snapshots pin the
// exact column sets, so any insertion/removal/reorder goes red and an additive
// rollout must append here explicitly (review-visible). (task #137)
const TRACE_EVENT_ROW_V2_FULL_SNAPSHOT_66 = [
  "row_kind", "service_name", "deployment_environment", "service_version",
  "service_revision", "service_instance_id", "deployment_instance_source", "deployment_identity_state",
  "ecs_task_id", "ecs_task_family", "ecs_task_revision", "trace_id",
  "span_id", "parent_span_id", "span_name", "span_kind",
  "span_surface", "span_status", "span_start_time_ms", "span_end_time_ms",
  "event_name", "event_kind", "event_time", "event_time_ms",
  "event_index", "server_id", "machine_id", "agent_id",
  "launch_id", "session_id", "request_id", "route_pattern",
  "caller_kind", "outcome", "reason", "source",
  "authority", "activity_write_site", "activity_source", "hint_source",
  "resolved_activity", "previous_activity", "next_activity", "repair_kind",
  "action", "error_class", "status_bucket", "shadow_agent_id",
  "shadow_signal_site", "shadow_observation_class", "shadow_prior_projection", "shadow_projection",
  "shadow_legacy_outcome", "shadow_action", "shadow_reason", "shadow_direction",
  "shadow_plan_kind", "machine_affinity_route", "replay_status", "db_system",
  "query_name", "phase", "sqlstate", "query_fingerprint",
  "timeout_bucket", "retryable",
] as const;

const TRACE_EVENT_ROW_V2_LEGACY_SNAPSHOT_59 = [
  "row_kind", "service_name", "deployment_environment", "service_version",
  "service_revision", "service_instance_id", "deployment_instance_source", "deployment_identity_state",
  "ecs_task_id", "ecs_task_family", "ecs_task_revision", "trace_id",
  "span_id", "parent_span_id", "span_name", "span_kind",
  "span_surface", "span_status", "span_start_time_ms", "span_end_time_ms",
  "event_name", "event_kind", "event_time", "event_time_ms",
  "event_index", "server_id", "machine_id", "agent_id",
  "launch_id", "session_id", "request_id", "route_pattern",
  "caller_kind", "outcome", "reason", "source",
  "authority", "activity_write_site", "activity_source", "hint_source",
  "resolved_activity", "previous_activity", "next_activity", "repair_kind",
  "action", "error_class", "status_bucket", "shadow_agent_id",
  "shadow_signal_site", "shadow_observation_class", "shadow_prior_projection", "shadow_projection",
  "shadow_legacy_outcome", "shadow_action", "shadow_reason", "shadow_direction",
  "shadow_plan_kind", "machine_affinity_route", "replay_status",
] as const;

test("Trace V2 projection columns match the frozen snapshots exactly", () => {
  assert.deepEqual(
    TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([column]) => column),
    [...TRACE_EVENT_ROW_V2_FULL_SNAPSHOT_66],
  );
  assert.deepEqual(
    TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS.map(([column]) => column),
    [...TRACE_EVENT_ROW_V2_LEGACY_SNAPSHOT_59],
  );
});

test("Trace V2 ingest statements preserve the additive 59-to-66 column rollout", () => {
  const columnNames = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([column]) => column);
  assert.equal(columnNames.length, 66);
  assert.equal(new Set(columnNames).size, 66);
  assert.deepEqual(columnNames.slice(-7), [
    "db_system",
    "query_name",
    "phase",
    "sqlstate",
    "query_fingerprint",
    "timeout_bucket",
    "retryable",
  ]);
  assert.equal(TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS.length, 59);
  const legacyColumnNames = TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS.map(([column]) => column);
  assert.deepEqual(legacyColumnNames, columnNames.slice(0, 59));

  const match = TRACE_EVENT_ROW_V2_INGEST_STATEMENT.match(
    /^SELECT (.*) INSERT INTO raft\.trace_events_v2 \((.*)\)$/,
  );
  assert.ok(match);
  const aliases = [...match[1]!.matchAll(/ AS ([a-z0-9_]+)(?:,|$)/g)].map((entry) => entry[1]);
  const insertColumns = match[2]!.split(",").map((column) => column.trim());
  assert.deepEqual(aliases, columnNames);
  assert.deepEqual(insertColumns, columnNames);
  const legacyMatch = TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT.match(
    /^SELECT (.*) INSERT INTO raft\.trace_events_v2 \((.*)\)$/,
  );
  assert.ok(legacyMatch);
  const legacyAliases = [...legacyMatch[1]!.matchAll(/ AS ([a-z0-9_]+)(?:,|$)/g)].map((entry) => entry[1]);
  const legacyInsertColumns = legacyMatch[2]!.split(",").map((column) => column.trim());
  assert.deepEqual(legacyAliases, legacyColumnNames);
  assert.deepEqual(legacyInsertColumns, legacyColumnNames);
  assert.equal(isTraceEventRowV2CompatibleIngestStatement(TRACE_EVENT_ROW_V2_INGEST_STATEMENT), true);
  assert.equal(isTraceEventRowV2CompatibleIngestStatement(TRACE_EVENT_ROW_V2_LEGACY_INGEST_STATEMENT), true);
  assert.equal(isTraceEventRowV2CompatibleIngestStatement("INSERT INTO raft.trace_events_v2"), false);
  assert.equal(TRACE_EVENT_ROW_V2_TABLE, "raft.trace_events_v2");
  assert.equal(
    TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
    `sha256:${createHash("sha256")
      .update(JSON.stringify(TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS))
      .digest("hex")}`,
  );
  assert.equal(
    TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT,
    `sha256:${createHash("sha256")
      .update(JSON.stringify(TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS))
      .digest("hex")}`,
  );
  assert.equal(isTraceEventRowV2CompatibleSchemaFingerprint(TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT), true);
  assert.equal(isTraceEventRowV2CompatibleSchemaFingerprint(TRACE_EVENT_ROW_V2_LEGACY_SCHEMA_FINGERPRINT), true);
  assert.equal(isTraceEventRowV2CompatibleSchemaFingerprint("sha256:stale"), false);

  const liveShape = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, dataType }));
  const legacyShape = TRACE_EVENT_ROW_V2_LEGACY_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, dataType }));
  assert.throws(
    () => assertTraceEventRowV2TableSchema(legacyShape),
    /required column db_system is missing/,
  );
  assert.doesNotThrow(() => assertTraceEventRowV2TableSchema(liveShape));
  assert.doesNotThrow(() => assertTraceEventRowV2TableSchema([
    ...liveShape.slice(17),
    ...liveShape.slice(0, 17),
  ]));
  assert.doesNotThrow(() => assertTraceEventRowV2TableSchema([
    { name: "future_additive_column", dataType: "string" },
    ...liveShape,
  ]));
  assert.throws(
    () => assertTraceEventRowV2TableSchema(liveShape.slice(0, -1)),
    /required column retryable is missing/,
  );
  assert.throws(
    () => assertTraceEventRowV2TableSchema(liveShape.map((field, index) => (
      index === 5 ? { ...field, name: "future_column_in_wrong_position" } : field
    ))),
    /required column service_instance_id is missing/,
  );
  assert.throws(
    () => assertTraceEventRowV2TableSchema(liveShape.map((field, index) => (
      index === 5 ? { ...field, dataType: "int" } : field
    ))),
    /required column service_instance_id has type int; expected string/,
  );
  assert.throws(
    () => assertTraceEventRowV2TableSchema([...liveShape, liveShape[5]!]),
    /duplicate column service_instance_id/,
  );
});

test("trace event row projection promotes query axes and closed fields", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    clock: makeNumberSequence([100, 110, 120]),
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: () => "e".repeat(16),
  });

  const span = tracer.startSpan("server.agent.activity.resolve", {
    surface: "server",
    kind: "internal",
    attrs: {
      agent_id: "agent-span",
      server_id: "server-1",
      route_pattern: "/api/agents/:id/activity",
      raw_payload: { prompt: "must stay out of promoted columns" },
    },
  });
  span.addEvent("activity.hint.candidate", {
    agent_id: "agent-event",
    operation_id: "operation-1",
    event_kind: "activity_snapshot",
    hint_source: "redis",
    resolved_activity: "working",
    reason: "fresh_hint",
    machine_affinity_route: "aws_replay",
    replay_status: 503,
    ignored_object: { nested: true },
  });
  span.end("ok");

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  const [row] = traceEventRowsForSpan(recorded, {
    serviceName: "slock-server",
    deploymentEnvironment: "production",
    serviceRevision: "abc123",
  });

  assert.deepEqual(row, {
    row_kind: "event",
    service_name: "slock-server",
    deployment_environment: "production",
    service_version: null,
    service_revision: "abc123",
    service_instance_id: null,
    deployment_instance_source: null,
    deployment_identity_state: null,
    ecs_task_id: null,
    ecs_task_family: null,
    ecs_task_revision: null,
    trace_id: "d".repeat(32),
    span_id: "e".repeat(16),
    parent_span_id: null,
    span_name: "server.agent.activity.resolve",
    span_kind: "internal",
    span_surface: "server",
    span_status: "ok",
    span_start_time_ms: 100,
    span_end_time_ms: 120,
    event_name: "activity.hint.candidate",
    event_kind: "activity_snapshot",
    event_time: "1970-01-01T00:00:00.110Z",
    event_time_ms: 110,
    event_index: 0,
    server_id: "server-1",
    machine_id: null,
    agent_id: "agent-event",
    launch_id: null,
    session_id: null,
    request_id: null,
    operation_id: "operation-1",
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
    reason: "fresh_hint",
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

test("trace event row projection supports immediate rows with nullable span end", () => {
  const row = traceEventRowForRecord({
    span: {
      context: createTraceContext({
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
      }),
      name: "server.agent.activity_writer.shadow",
      surface: "server",
      kind: "internal",
      startTimeMs: 1_000,
      attrs: {
        server_id: "server-1",
      },
    },
    event: {
      name: "lifecycle_v2.shadow_verdict",
      timeMs: 1_010,
      attrs: {
        shadow_agent_id: "agent-1",
        shadow_signal_site: "lifecycle_plan",
        shadow_action: "replace",
        shadow_projection: "offline",
        raw_payload: "must not pass through",
      },
    },
    eventIndex: 2,
  }, {
    serviceName: "slock-server",
    deploymentEnvironment: "test",
  });

  assert.equal(row.span_status, null);
  assert.equal(row.span_end_time_ms, null);
  assert.equal(row.row_kind, "event");
  assert.equal(row.event_index, 2);
  assert.equal(row.server_id, "server-1");
  assert.equal(row.shadow_agent_id, "agent-1");
  assert.equal(row.shadow_signal_site, "lifecycle_plan");
  assert.equal(row.shadow_action, "replace");
  assert.equal(row.shadow_projection, "offline");
  assert.equal("raw_payload" in row, false);
});

test("basic tracer notifies span-fact sinks at end without changing completed span recording", () => {
  const completed: CompletedTraceSpan[] = [];
  const facts: CompletedTraceSpan[] = [];
  const tracer = new BasicTracer({
    sink: {
      record(span) {
        completed.push(span);
      },
      recordSpanFact(record) {
        facts.push(record.span);
      },
    },
    clock: makeNumberSequence([1_000, 1_010]),
    traceIdGenerator: () => "6".repeat(32),
    spanIdGenerator: () => "7".repeat(16),
  });

  const span = tracer.startSpan("server.machine.websocket.heartbeat_timer", {
    surface: "server",
    kind: "internal",
    attrs: {
      machine_id: "machine-1",
      server_id: "server-1",
    },
  });
  span.end("error", {
    attrs: {
      outcome: "timeout",
      reason: "missed_heartbeat",
    },
  });

  assert.equal(facts.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(facts[0], completed[0]);
});

test("trace span-fact row projection uses span end time and end attrs", () => {
  const row = traceSpanFactRowForSpan({
    context: createTraceContext({
      traceId: "8".repeat(32),
      spanId: "9".repeat(16),
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
      server_id: "server-1",
      outcome: "timeout",
      reason: "missed_heartbeat",
    },
    events: [],
  }, {
    serviceName: "slock-server",
    deploymentEnvironment: "test",
  });

  assert.equal(row.row_kind, "span_fact");
  assert.equal(row.event_name, "server.machine.websocket.heartbeat_timer");
  assert.equal(row.event_kind, null);
  assert.equal(row.event_time, "1970-01-01T00:00:02.030Z");
  assert.equal(row.event_time_ms, 2_030);
  assert.equal(row.event_index, null);
  assert.equal(row.span_status, "error");
  assert.equal(row.span_end_time_ms, 2_030);
  assert.equal(row.machine_id, "machine-1");
  assert.equal(row.server_id, "server-1");
  assert.equal(row.outcome, "timeout");
  assert.equal(row.reason, "missed_heartbeat");
});

test("B0 field definitions classify query axes and content safety separately", () => {
  const byKey = new Map<string, TraceFieldDefinition>(
    TRACE_B0_FIELD_DEFINITIONS.map((definition) => [definition.key, definition]),
  );

  assert.equal(byKey.get("row_kind")?.fieldClass, "query_axis");
  assert.equal(byKey.get("row_kind")?.enumBinding, "stable");
  assert.equal(byKey.get("event_kind")?.enumBinding, "pending_457");
  assert.equal(byKey.get("lifecycle_observed_at_ms")?.fieldClass, "query_axis");
  assert.equal(byKey.get("activity_observed_at_ms")?.fieldClass, "query_axis");
  assert.equal(byKey.get("advances_observed_clock")?.valueKind, "closed_enum");
  assert.equal(byKey.get("agent_id")?.fieldClass, "query_axis");
  assert.equal(byKey.get("agent_id")?.placement, "span_or_event");
  assert.equal(byKey.get("hint_source")?.fieldClass, "family_query_axis");
  assert.equal(byKey.get("hint_source")?.scope, "family:activity");
  assert.equal(byKey.get("previous_activity")?.placement, "span_or_event");
  assert.equal(byKey.get("candidate_activity")?.placement, "span_or_event");
  assert.equal(byKey.get("served_activity")?.placement, "span_or_event");
  assert.equal(byKey.get("shadow_agent_id")?.scope, "family:lifecycle_shadow");
  assert.deepEqual(byKey.get("shadow_signal_site")?.enumValues, TRACE_LIFECYCLE_SHADOW_SIGNAL_SITE_VALUES);
  assert.ok(TRACE_LIFECYCLE_SHADOW_SIGNAL_SITE_VALUES.includes("delivery_ack"));
  assert.equal(byKey.get("authority")?.enumBinding, "pending_457");
  assert.equal(byKey.get("served_from")?.fieldClass, "query_axis");
  assert.equal(byKey.get("decided_by")?.fieldClass, "query_axis");
  assert.equal(byKey.get("raw_payload")?.fieldClass, "content_safety");
  assert.equal(byKey.get("raw_payload")?.contentRule, "drop");
});

test("TraceScopeStack composes scopes and remains compatible with span attr contracts", () => {
  const sink = new MemoryTraceSink();
  const tracer = createTraceScopeStack({
    actor: { serverId: "server-1", machineId: "machine-1" },
  }, {
    actor: { agentId: "agent-1" },
    request: { routePattern: "/api/agents/:id/activity" },
  }).tracer(new BasicTracer({
    sink,
    traceIdGenerator: () => "3".repeat(32),
    spanIdGenerator: () => "4".repeat(16),
  }), {
    spanAttrContracts: {
      "server.agent.activity.resolve": {
        spanAttrs: ["server_id", "machine_id", "agent_id", "route_pattern"],
        eventAttrs: {
          "activity.hint.candidate": ["agent_id", "hint_source", "raw_payload"],
        },
      },
    },
  });

  const span = tracer.startSpan("server.agent.activity.resolve", { surface: "server" });
  span.addEvent("activity.hint.candidate", { hint_source: "redis", raw_payload: "filtered only by row projection" });
  span.end();

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  assert.equal(recorded.attrs?.server_id, "server-1");
  assert.equal(recorded.attrs?.machine_id, "machine-1");
  assert.equal(recorded.attrs?.agent_id, "agent-1");
  assert.equal(recorded.attrs?.route_pattern, "/api/agents/:id/activity");
  assert.equal("server_id" in (recorded.events[0]?.attrs ?? {}), false);
  assert.equal("machine_id" in (recorded.events[0]?.attrs ?? {}), false);
  assert.equal("agent_id" in (recorded.events[0]?.attrs ?? {}), false);
  assert.equal("route_pattern" in (recorded.events[0]?.attrs ?? {}), false);
  assert.equal(recorded.events[0]?.attrs?.hint_source, "redis");
  assert.equal(recorded.events[0]?.attrs?.raw_payload, "filtered only by row projection");

  const eventRow = traceEventRowsForSpan(recorded, TEST_TRACE_RESOURCE).find((row) => row.row_kind === "event");
  assert.equal(eventRow?.server_id, "server-1");
  assert.equal(eventRow?.machine_id, "machine-1");
  assert.equal(eventRow?.agent_id, "agent-1");
  assert.equal(eventRow?.route_pattern, "/api/agents/:id/activity");
  assert.equal(eventRow?.hint_source, "redis");
});
