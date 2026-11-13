import assert from "node:assert/strict";
import { createTraceContext, type CompletedTraceSpan } from "@botiverse/raft-shared";
import {
  normalizeOtlpTracesEndpoint,
  OtlpHttpTraceSink,
  toOtlpSpan,
  type OtlpExportFailure,
  type OtlpExportObserver,
  type OtlpHttpTraceSinkFetch,
  type OtlpSignal,
} from "./otlpHttpTraceSink";

function makeSpan(overrides: Partial<CompletedTraceSpan> = {}): CompletedTraceSpan {
  const parent = createTraceContext({
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: "01",
  });
  return {
    context: createTraceContext({
      parent,
      spanId: "3".repeat(16),
    }),
    name: "server.agent.activity.ingest",
    surface: "server",
    kind: "server",
    status: "ok",
    startTimeMs: 1_000,
    endTimeMs: 1_025,
    durationMs: 25,
    attrs: {
      agentId: "agent_123",
      count: 2,
      accepted: true,
      nested: { reason: "stale_launch_guard" },
      ignored: undefined,
    },
    events: [
      {
        name: "activity.ingest.received",
        timeMs: 1_001,
        attrs: {
          activity: "working",
        },
      },
    ],
    ...overrides,
  };
}

test("normalizeOtlpTracesEndpoint accepts base endpoint and traces path", () => {
  assert.equal(
    normalizeOtlpTracesEndpoint("slock-telescope-staging.internal:4318"),
    "http://slock-telescope-staging.internal:4318/v1/traces",
  );
  assert.equal(
    normalizeOtlpTracesEndpoint("http://127.0.0.1:4318/v1/traces"),
    "http://127.0.0.1:4318/v1/traces",
  );
});

test("toOtlpSpan maps Slock span context, timing, attrs, events, and status", () => {
  const span = toOtlpSpan(makeSpan());

  assert.equal(span.traceId, "1".repeat(32));
  assert.equal(span.spanId, "3".repeat(16));
  assert.equal(span.parentSpanId, "2".repeat(16));
  assert.equal(span.kind, 2);
  assert.equal(span.startTimeUnixNano, "1000000000");
  assert.equal(span.endTimeUnixNano, "1025000000");
  assert.deepEqual(span.status, { code: 1 });
  assert.ok(span.attributes?.some((attr) => attr.key === "slock.surface" && "stringValue" in attr.value && attr.value.stringValue === "server"));
  assert.ok(span.attributes?.some((attr) => attr.key === "count" && "intValue" in attr.value && attr.value.intValue === "2"));
  assert.ok(span.attributes?.some((attr) => attr.key === "accepted" && "boolValue" in attr.value && attr.value.boolValue === true));
  assert.ok(span.attributes?.some((attr) => attr.key === "nested" && "stringValue" in attr.value && attr.value.stringValue === "{\"reason\":\"stale_launch_guard\"}"));
  assert.equal(span.attributes?.some((attr) => attr.key === "ignored"), false);
  assert.equal(span.events?.[0]?.name, "activity.ingest.received");
  assert.equal(span.events?.[0]?.timeUnixNano, "1001000000");
});

test("toOtlpSpan preserves neutral unset status", () => {
  assert.deepEqual(toOtlpSpan(makeSpan({ status: "unset" })).status, { code: 0 });
});

test("OtlpHttpTraceSink exports queued spans as one OTLP HTTP request", async () => {
  const requests: Array<{ input: string | URL; init: Parameters<OtlpHttpTraceSinkFetch>[1] }> = [];
  const fetchImpl: OtlpHttpTraceSinkFetch = async (input, init) => {
    requests.push({ input, init });
    return {
      ok: true,
      status: 200,
      text: async () => "",
    };
  };
  const sink = new OtlpHttpTraceSink({
    endpoint: "http://collector:4318",
    serviceName: "slock-server-test",
    deploymentEnvironment: "test",
    serviceVersion: "0.1.0",
    serviceRevision: "abc123def456",
    serviceInstanceId: "ecs:opaque-task",
    deploymentInstanceSource: "aws_ecs_task",
    deploymentIdentityState: "resolved",
    ecsTaskId: "opaque-task",
    ecsTaskFamily: "slock-prod",
    ecsTaskRevision: "16",
    flyAppName: "slock-server-test",
    flyImageRef: "registry.fly.io/slock-server-test:deployment-123",
    flyMachineId: "32870155ced958",
    flyInstanceId: "inst-123",
    flyAllocId: "alloc-123",
    flyRegion: "sjc",
    batchSize: 2,
    flushIntervalMs: 60_000,
    fetchImpl,
  });

  sink.record(makeSpan({ context: createTraceContext({ traceId: "4".repeat(32), spanId: "5".repeat(16) }) }));
  sink.record(makeSpan({ context: createTraceContext({ traceId: "6".repeat(32), spanId: "7".repeat(16) }) }));
  await sink.shutdown();

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0].input), "http://collector:4318/v1/traces");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["content-type"], "application/json");

  const body = JSON.parse(requests[0].init.body);
  const resourceAttrs = body.resourceSpans[0].resource.attributes;
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "service.name" && attr.value.stringValue === "slock-server-test"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "service.version" && attr.value.stringValue === "0.1.0"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "service.revision" && attr.value.stringValue === "abc123def456"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "service.instance.id" && attr.value.stringValue === "ecs:opaque-task"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.deployment_instance_source" && attr.value.stringValue === "aws_ecs_task"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.deployment_identity_state" && attr.value.stringValue === "resolved"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.ecs_task_id" && attr.value.stringValue === "opaque-task"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "aws.ecs.task.family" && attr.value.stringValue === "slock-prod"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "aws.ecs.task.revision" && attr.value.stringValue === "16"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.fly_app_name" && attr.value.stringValue === "slock-server-test"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.fly_image_ref" && attr.value.stringValue === "registry.fly.io/slock-server-test:deployment-123"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.fly_machine_id" && attr.value.stringValue === "32870155ced958"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.fly_instance_id" && attr.value.stringValue === "inst-123"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.fly_alloc_id" && attr.value.stringValue === "alloc-123"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "slock.fly_region" && attr.value.stringValue === "sjc"));
  assert.ok(resourceAttrs.some((attr: any) => attr.key === "deployment.environment" && attr.value.stringValue === "test"));
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 2);
});

function recordingObserver() {
  const calls: Array<
    | { call: "exported"; signal: OtlpSignal; items: number }
    | { call: "exportFailed"; signal: OtlpSignal; items: number; failure: OtlpExportFailure }
    | { call: "droppedQueueFull"; signal: OtlpSignal; items: number }
  > = [];
  const depths: Array<[OtlpSignal, number]> = [];
  const observer: OtlpExportObserver = {
    exported: (signal, items) => calls.push({ call: "exported", signal, items }),
    exportFailed: (signal, items, _durationMs, failure) => calls.push({ call: "exportFailed", signal, items, failure }),
    droppedQueueFull: (signal, items) => calls.push({ call: "droppedQueueFull", signal, items }),
    queueDepth: (signal, depth) => depths.push([signal, depth]),
  };
  return { calls, depths, observer };
}

function logEvent(name: string) {
  return { name, timeMs: 1_000, surface: "server" as const, context: null };
}

test("the observer hears each batch's outcome per signal, with the failure as a bounded kind", async () => {
  const responses: Array<() => Promise<Awaited<ReturnType<OtlpHttpTraceSinkFetch>>>> = [
    async () => ({ ok: true, status: 200, text: async () => "" }),
    async () => ({ ok: false, status: 429, text: async () => "slow down" }),
    async () => ({ ok: false, status: 503, text: async () => "data refused due to high memory usage" }),
    async () => ({ ok: false, status: 400, text: async () => "bad request" }),
    async () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); },
    async () => { throw new TypeError("fetch failed"); },
  ];
  const { calls, observer } = recordingObserver();
  const sink = new OtlpHttpTraceSink({
    endpoint: "http://collector:4318",
    serviceName: "slock-server-test",
    batchSize: 1,
    flushIntervalMs: 60_000,
    fetchImpl: () => responses.shift()!(),
    observer,
    onError: () => {},
  });

  // batchSize 1: each add starts its export; flush() does not wait for one already running.
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  sink.recordLogEvent(logEvent("a"));
  await settled();
  for (let i = 0; i < 5; i++) {
    sink.record(makeSpan());
    await settled();
  }

  assert.deepEqual(calls, [
    { call: "exported", signal: "logs", items: 1 },
    { call: "exportFailed", signal: "traces", items: 1, failure: { kind: "http_429", httpStatus: 429 } },
    { call: "exportFailed", signal: "traces", items: 1, failure: { kind: "http_5xx", httpStatus: 503 } },
    { call: "exportFailed", signal: "traces", items: 1, failure: { kind: "http_4xx", httpStatus: 400 } },
    { call: "exportFailed", signal: "traces", items: 1, failure: { kind: "timeout" } },
    { call: "exportFailed", signal: "traces", items: 1, failure: { kind: "network" } },
  ]);
});

test("a full queue reports each dropped item and the depth it reached", async () => {
  const { calls, depths, observer } = recordingObserver();
  const sink = new OtlpHttpTraceSink({
    endpoint: "http://collector:4318",
    serviceName: "slock-server-test",
    batchSize: 2,
    maxQueueSize: 2,
    flushIntervalMs: 60_000,
    // Never answers, so the queue cannot drain while the test adds items.
    fetchImpl: () => new Promise(() => {}),
    observer,
  });

  sink.recordLogEvent(logEvent("a"));
  sink.recordLogEvent(logEvent("b")); // full batch: one export starts and hangs
  sink.recordLogEvent(logEvent("c"));
  sink.recordLogEvent(logEvent("d"));
  sink.recordLogEvent(logEvent("e")); // queue holds c, d: drops c

  assert.deepEqual(calls, [{ call: "droppedQueueFull", signal: "logs", items: 1 }]);
  assert.equal(Math.max(...depths.map(([, depth]) => depth)), 2);
  assert.ok(depths.every(([signal]) => signal === "logs"));
});
