import assert from "node:assert/strict";
import { test } from "vitest";
import { EventEmitter } from "node:events";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan, traceSpanFactRowForSpan } from "@botiverse/raft-shared";
import { httpRequestDuration, httpRequestsTotal } from "../metrics.js";
import { attachAuthTraceIdentity, bucketHttpStatus, inferHttpCallerKind, normalizeObservedRoutePattern, requestObservabilityMiddleware } from "./requestObservability.js";

const EXPECTED_LABELS = {
  route_pattern: "/api/servers/:id/members/:memberId/profile",
  method: "GET",
  status_bucket: "5xx",
};
const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

test("normalizeObservedRoutePattern keeps route templates while excluding query shape", () => {
  const req: any = {
    originalUrl: "/api/servers/550e8400-e29b-41d4-a716-446655440000/members/123/profile?limit=20",
    url: "/api/servers/550e8400-e29b-41d4-a716-446655440000/members/123/profile?limit=20",
    baseUrl: "/api/servers",
    route: { path: "/:id/members/:memberId/profile" },
  };

  assert.equal(
    normalizeObservedRoutePattern(req),
    "/api/servers/:id/members/:memberId/profile",
  );
});

test("normalizeObservedRoutePattern collapses unmatched requests to a stable label", () => {
  const req: any = {
    originalUrl: "/api/unknown/550e8400-e29b-41d4-a716-446655440000?foo=bar",
    url: "/api/unknown/550e8400-e29b-41d4-a716-446655440000?foo=bar",
    baseUrl: "",
    route: undefined,
  };

  assert.equal(normalizeObservedRoutePattern(req), "unmatched");
});

test("bucketHttpStatus groups codes into low-cardinality buckets", () => {
  assert.equal(bucketHttpStatus(204), "2xx");
  assert.equal(bucketHttpStatus(302), "3xx");
  assert.equal(bucketHttpStatus(429), "4xx");
  assert.equal(bucketHttpStatus(503), "5xx");
  assert.equal(bucketHttpStatus(101), "other");
});

test("requestObservabilityMiddleware records request totals and duration with normalized labels", async () => {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();

  const req: any = {
    method: "GET",
    originalUrl: "/api/servers/550e8400-e29b-41d4-a716-446655440000/members/123/profile?limit=20",
    url: "/api/servers/550e8400-e29b-41d4-a716-446655440000/members/123/profile?limit=20",
    baseUrl: "/api/servers",
    route: { path: "/:id/members/:memberId/profile" },
  };
  const res: any = new EventEmitter();
  res.statusCode = 503;

  let nextCalled = false;
  requestObservabilityMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  res.emit("finish");

  const requestTotals = await httpRequestsTotal.get();
  const totalSample = requestTotals.values.find((sample) =>
    sample.labels.route_pattern === EXPECTED_LABELS.route_pattern
    && sample.labels.method === EXPECTED_LABELS.method
    && sample.labels.status_bucket === EXPECTED_LABELS.status_bucket,
  );
  assert.ok(totalSample);
  assert.equal(totalSample.value, 1);

  const requestDuration = await httpRequestDuration.get();
  const countSample = requestDuration.values.find((sample) =>
    sample.metricName === "slock_http_request_duration_seconds_count"
    && sample.labels.route_pattern === EXPECTED_LABELS.route_pattern
    && sample.labels.method === EXPECTED_LABELS.method
    && sample.labels.status_bucket === EXPECTED_LABELS.status_bucket,
  );
  assert.ok(countSample);
  assert.equal(countSample.value, 1);
});

test("requestObservabilityMiddleware records an HTTP root span without sensitive values", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "1".repeat(32),
    spanIdGenerator: () => "2".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl: "/api/agents?search=secret",
    url: "/api/agents?search=secret",
    baseUrl: "/api/agents",
    route: { path: "/" },
    serverId: "server-1",
    userId: "user-1",
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};

  requestObservabilityMiddleware(req, res, () => {});
  res.emit("finish");

  const spans = sink.getAllSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "server.http.request");
  assert.equal(spans[0].status, "ok");
  assert.equal(spans[0].attrs?.route_pattern, "/api/agents/");
  assert.equal(spans[0].attrs?.["http.route"], "/api/agents/");
  assert.equal(spans[0].attrs?.method, "GET");
  assert.equal(spans[0].attrs?.["http.request.method"], "GET");
  assert.equal(spans[0].attrs?.status_bucket, "2xx");
  assert.equal(spans[0].attrs?.status_code, 200);
  assert.equal(spans[0].attrs?.["http.response.status_code"], 200);
  assert.equal(spans[0].attrs?.server_id_present, true);
  assert.equal(spans[0].attrs?.user_id_present, true);
  assert.equal(spans[0].attrs?.agent_id_present, false);
  assert.equal(spans[0].attrs?.caller_kind, "human");
  assert.equal(Object.values(spans[0].attrs ?? {}).includes("user-1"), false);

  const [eventRow] = traceEventRowsForSpan(spans[0], TRACE_EVENT_ROW_TEST_RESOURCE);
  assert.equal(eventRow.row_kind, "event");
  assert.equal(eventRow.event_name, "http.response.finished");
  assert.equal(eventRow.event_kind, "http_request");
  assert.equal(eventRow.route_pattern, "/api/agents/");
  assert.equal(eventRow.caller_kind, "human");
  assert.equal(eventRow.status_bucket, "2xx");
  assert.equal(eventRow.outcome, "success");
  assert.equal(eventRow.reason, "http_2xx");
  const spanFact = traceSpanFactRowForSpan(spans[0], TRACE_EVENT_ROW_TEST_RESOURCE);
  assert.equal(spanFact.row_kind, "span_fact");
  assert.equal(spanFact.event_name, "server.http.request");
  assert.equal(spanFact.event_index, null);
  assert.equal(spanFact.event_kind, "http_request");
  assert.equal(spanFact.route_pattern, "/api/agents/");
  assert.equal(spanFact.caller_kind, "human");
  assert.equal(spanFact.outcome, "success");
  assert.equal(spanFact.reason, "http_2xx");
});

test("requestObservabilityMiddleware continues a valid inbound W3C traceparent", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: () => "c".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl: "/api/agents",
    url: "/api/agents",
    baseUrl: "/api/agents",
    route: { path: "/" },
    header: (name: string) => name === "traceparent"
      ? `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
      : undefined,
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};

  requestObservabilityMiddleware(req, res, () => {});
  res.emit("finish");

  const [span] = sink.getAllSpans();
  assert.equal(span.context.traceId, "a".repeat(32));
  assert.equal(span.context.parentSpanId, "b".repeat(16));
  assert.equal(span.context.traceFlags, "01");
});

test("requestObservabilityMiddleware fails open to a new root for malformed traceparent", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: () => "c".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl: "/api/agents",
    url: "/api/agents",
    baseUrl: "/api/agents",
    route: { path: "/" },
    header: (name: string) => name === "traceparent" ? "00-not-a-valid-parent" : undefined,
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};

  requestObservabilityMiddleware(req, res, () => {});
  res.emit("finish");

  const [span] = sink.getAllSpans();
  assert.equal(span.context.traceId, "d".repeat(32));
  assert.equal(span.context.parentSpanId, null);
});

test("requestObservabilityMiddleware records auth-route user and session attribution when attached", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "7".repeat(32),
    spanIdGenerator: () => "8".repeat(16),
  });
  const req: any = {
    method: "POST",
    originalUrl: "/api/auth/refresh",
    url: "/api/auth/refresh",
    baseUrl: "/api/auth",
    route: { path: "/refresh" },
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};

  requestObservabilityMiddleware(req, res, () => {
    attachAuthTraceIdentity(req, {
      userId: "user-1",
      sessionId: "session-1",
      source: "refresh",
    });
  });
  res.emit("finish");

  const [span] = sink.getAllSpans();
  assert.equal(span.attrs?.route_pattern, "/api/auth/refresh");
  assert.equal(span.attrs?.user_id, "user-1");
  assert.equal(span.attrs?.user_id_present, true);
  assert.equal(span.attrs?.session_id, "session-1");
  assert.equal(span.attrs?.session_id_present, true);
  assert.equal(span.attrs?.auth_trace_source, "refresh");
  assert.equal(span.events.at(-1)?.attrs?.user_id, "user-1");
  assert.equal(span.events.at(-1)?.attrs?.session_id, "session-1");
});

test("requestObservabilityMiddleware records auth rejection reason without fabricated identity", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "9".repeat(32),
    spanIdGenerator: () => "a".repeat(16),
  });
  const req: any = {
    method: "POST",
    originalUrl: "/api/auth/refresh",
    url: "/api/auth/refresh",
    baseUrl: "/api/auth",
    route: { path: "/refresh" },
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 401;
  res.locals = {};

  requestObservabilityMiddleware(req, res, () => {
    attachAuthTraceIdentity(req, {
      source: "refresh",
      reason: "invalid_or_expired_refresh",
    });
  });
  res.emit("finish");

  const [span] = sink.getAllSpans();
  assert.equal(span.attrs?.user_id, undefined);
  assert.equal(span.attrs?.user_id_present, false);
  assert.equal(span.attrs?.session_id, undefined);
  assert.equal(span.attrs?.session_id_present, false);
  assert.equal(span.attrs?.auth_trace_source, "refresh");
  assert.equal(span.attrs?.auth_trace_reason, "invalid_or_expired_refresh");
});

test("requestObservabilityMiddleware closes aborted request spans once without metrics", async () => {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "5".repeat(32),
    spanIdGenerator: () => "6".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl: "/internal/agent/agent-1/receive?block=true",
    url: "/internal/agent/agent-1/receive?block=true",
    baseUrl: "/internal/agent",
    route: { path: "/:id/receive" },
    header: () => undefined,
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};
  res.writableEnded = false;

  requestObservabilityMiddleware(req, res, () => {});
  res.emit("close");
  res.writableEnded = true;
  res.emit("finish");

  const spans = sink.getAllSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, "cancelled");
  assert.deepEqual(spans[0].events.map((event) => event.name), ["http.response.closed"]);
  assert.equal(spans[0].attrs?.route_pattern, "/internal/agent/:id/receive");
  assert.equal(spans[0].attrs?.["http.route"], "/internal/agent/:id/receive");
  assert.equal(spans[0].attrs?.caller_kind, "agent");

  const requestTotals = await httpRequestsTotal.get();
  assert.equal(requestTotals.values.some((sample) =>
    sample.labels.route_pattern === "/internal/agent/:id/receive"
  ), false);
});

test("requestObservabilityMiddleware classifies agent-origin HTTP without raw agent ids", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "3".repeat(32),
    spanIdGenerator: () => "4".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl: "/api/messages/channel/channel-1?limit=50",
    url: "/api/messages/channel/channel-1?limit=50",
    baseUrl: "/api/messages",
    route: { path: "/channel/:channelId" },
    serverId: "server-1",
    userId: "user-1",
    daemonVersion: "0.42.0",
    header(name: string) {
      return name.toLowerCase() === "x-agent-id" ? "agent-raw-id" : undefined;
    },
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};

  requestObservabilityMiddleware(req, res, () => {});
  res.emit("finish");

  const [span] = sink.getAllSpans();
  assert.equal(span.attrs?.caller_kind, "agent");
  assert.equal(span.attrs?.agent_id_present, true);
  assert.equal(span.attrs?.daemon_version_present, true);
  assert.equal(span.attrs?.daemon_version, "0.42.0");
  assert.equal(Object.values(span.attrs ?? {}).includes("agent-raw-id"), false);
  assert.equal(span.events.at(-1)?.attrs?.caller_kind, "agent");
  assert.equal("daemon_version" in (span.events.at(-1)?.attrs ?? {}), false);
  const responseRow = traceEventRowsForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE)
    .find((row) => row.event_name === "http.response.finished");
  assert.ok(responseRow);
  assert.equal(responseRow.route_pattern, "/api/messages/channel/:channelId");
  assert.equal(responseRow.caller_kind, "agent");
});

test("inferHttpCallerKind treats internal agent and machine routes as separate caller kinds", () => {
  assert.equal(
    inferHttpCallerKind({ header: () => undefined } as any, "/internal/agent/:id/receive"),
    "agent",
  );
  assert.equal(
    inferHttpCallerKind({ machineId: "machine-1", header: () => undefined } as any, "/internal/machine/self"),
    "system",
  );
});
