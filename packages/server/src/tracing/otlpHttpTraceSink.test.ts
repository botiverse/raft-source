import assert from "node:assert/strict";
import { test } from "vitest";
import { createTraceContext, type CompletedTraceSpan } from "@botiverse/raft-shared";
import { normalizeOtlpTracesEndpoint, OtlpHttpTraceSink, toOtlpSpan, type OtlpHttpTraceSinkFetch } from "./otlpHttpTraceSink.js";

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
