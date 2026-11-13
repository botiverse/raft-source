import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan, traceSpanFactRowForSpan } from "@botiverse/raft-shared";
import { vi } from "vitest";
import { CLIENT_IP_HASH_SALT_ENV } from "../tracing/clientIpHash";
import { httpRequestDuration, httpRequestsTotal } from "../metrics";
import { traceAgentIdHash } from "../tracing/traceIdentity";
import { __traceUserIdForTests, rememberTraceUserId } from "../tracing/traceUserId";
import { attachAuthTraceIdentity, bucketHttpStatus, inferHttpCallerKind, normalizeObservedRoutePattern, requestClientAttrs, requestObservabilityMiddleware, setRequestTraceComputerCaller, setRequestTraceComputerTarget, setRequestTraceErrorCode } from "./requestObservability";

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
  // Not cached for "user-1" here, so no trace_user_id either (never the raw id).
  assert.equal(spans[0].attrs?.trace_user_id, undefined);

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

test("a refused agent request carries a hash of the agent id it claimed, never the raw id", () => {
  process.env.JWT_SECRET ??= "test-jwt-secret-for-claimed-agent-hash";
  const run = (statusCode: number, actingAgentId?: string) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    const req: any = {
      method: "GET",
      originalUrl: "/internal/agent-api/search",
      url: "/internal/agent-api/search",
      actingAgentId,
      header: (name: string) => (name.toLowerCase() === "x-agent-id" ? "agent-raw-id" : undefined),
      app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
    };
    const res: any = new EventEmitter();
    res.statusCode = statusCode;
    res.locals = {};
    requestObservabilityMiddleware(req, res, () => {});
    res.emit("finish");
    return sink.getAllSpans()[0].attrs ?? {};
  };

  const refused = run(401);
  assert.equal(refused.claimed_agent_id_hash, traceAgentIdHash("agent-raw-id"));
  assert.ok(refused.claimed_agent_id_hash);
  assert.equal("agent_id_hash" in refused, false);
  assert.equal(Object.values(refused).includes("agent-raw-id"), false);

  assert.equal("claimed_agent_id_hash" in run(200), false);
  assert.equal("claimed_agent_id_hash" in run(401, "agent-verified"), false);
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

test("an authenticated request carries the user's cached trace_user_id, never the raw id", () => {
  __traceUserIdForTests.reset();
  __traceUserIdForTests.setLoader(async () => new Map());
  try {
    rememberTraceUserId("user-9", "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a");
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    const req: any = {
      method: "GET",
      originalUrl: "/api/channels/threads/followed",
      url: "/api/channels/threads/followed",
      baseUrl: "/api/channels",
      route: { path: "/threads/followed" },
      userId: "user-9",
      app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
    };
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.locals = {};
    requestObservabilityMiddleware(req, res, () => {});
    res.emit("finish");
    const [span] = sink.getAllSpans();
    assert.equal(span.attrs?.trace_user_id, "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a");
    assert.equal(span.attrs?.user_id, undefined);
    assert.equal(Object.values(span.attrs ?? {}).includes("user-9"), false);
  } finally {
    __traceUserIdForTests.setLoader(null);
    __traceUserIdForTests.reset();
  }
});

test("requestObservabilityMiddleware records a route's error_code on the root span, leaving reason as before", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink, traceIdGenerator: () => "3".repeat(32), spanIdGenerator: () => "4".repeat(16) });
  const makeReq = (): any => ({
    method: "GET",
    originalUrl: "/api/channels/inbox",
    url: "/api/channels/inbox",
    baseUrl: "/api/channels",
    route: { path: "/inbox" },
    app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
  });

  const overloaded: any = new EventEmitter();
  overloaded.statusCode = 503;
  overloaded.locals = {};
  requestObservabilityMiddleware(makeReq(), overloaded, () => {});
  setRequestTraceErrorCode(overloaded, "rw_overloaded");
  overloaded.emit("finish");

  const plain: any = new EventEmitter();
  plain.statusCode = 500;
  plain.locals = {};
  requestObservabilityMiddleware(makeReq(), plain, () => {});
  plain.emit("finish");

  const [overloadedSpan, plainSpan] = sink.getAllSpans();
  assert.equal(overloadedSpan!.attrs?.error_code, "rw_overloaded");
  assert.equal(overloadedSpan!.attrs?.reason, "http_5xx", "reason keeps its status-derived meaning");
  assert.equal(overloadedSpan!.events.find((event) => event.name === "http.response.finished")?.attrs?.error_code, "rw_overloaded");
  assert.equal(plainSpan!.attrs?.error_code, undefined);
});

test("a request waiting on a Computer names it on the root span and its finished event", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink, traceIdGenerator: () => "5".repeat(32), spanIdGenerator: () => "6".repeat(16) });
  const req: any = {
    method: "GET",
    originalUrl: "/api/servers/s1/machines/m1/runtime-models/codex",
    url: "/api/servers/s1/machines/m1/runtime-models/codex",
    baseUrl: "/api/servers",
    route: { path: "/:id/machines/:machineId/runtime-models/:runtime" },
    app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
  };
  const res: any = new EventEmitter();
  res.statusCode = 504;
  res.locals = {};
  requestObservabilityMiddleware(req, res, () => {});
  setRequestTraceComputerTarget(res, { machineId: "m1", computerVersion: "1.0.48", daemonVersion: "1.0.48", runtime: "codex", sourceId: "model" });
  res.emit("finish");
  const [span] = sink.getAllSpans();
  const finished = span!.events.find((event) => event.name === "http.response.finished")?.attrs;
  for (const attrs of [span!.attrs, finished]) {
    // Hashed when the deployment has a trace identity key (JWT_SECRET); never the raw id.
    assert.ok(!Object.values(attrs ?? {}).includes("m1"));
    assert.equal(attrs?.target_computer_version, "1.0.48");
    assert.equal(attrs?.target_daemon_version, "1.0.48");
    assert.equal(attrs?.target_runtime, "codex");
    assert.equal(attrs?.option_source_id, "model");
  }
});

test("an sk_computer request names its Computer and migration once the route resolves them", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink, traceIdGenerator: () => "9".repeat(32), spanIdGenerator: () => "a".repeat(16) });
  const migrationId = "550E8400-E29B-41D4-A716-446655440000";
  const req: any = {
    method: "GET",
    originalUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/control?role=target`,
    url: `/agent-migrations/by-id/${migrationId}/resumable/control?role=target`,
    baseUrl: "/internal/computer",
    route: { path: "/agent-migrations/by-id/:migrationId/resumable/control" },
    app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
  };
  const res: any = new EventEmitter();
  res.statusCode = 409;
  res.locals = {};
  requestObservabilityMiddleware(req, res, () => {});
  setRequestTraceComputerCaller(res, { machineId: "m1", migrationId });
  res.emit("finish");
  const [span] = sink.getAllSpans();
  const finished = span!.events.find((event) => event.name === "http.response.finished")?.attrs;
  for (const attrs of [span!.attrs, finished]) {
    assert.ok(!Object.values(attrs ?? {}).includes("m1"));
    assert.equal(attrs?.machine_id_present, true);
    assert.equal(attrs?.migration_id, migrationId.toLowerCase());
  }
});

test("a migration id that is not a UUID is left off the request span", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink, traceIdGenerator: () => "b".repeat(32), spanIdGenerator: () => "c".repeat(16) });
  const req: any = {
    method: "GET",
    originalUrl: "/internal/computer/agent-migrations/by-id/not-a-uuid",
    url: "/agent-migrations/by-id/not-a-uuid",
    baseUrl: "/internal/computer",
    route: { path: "/agent-migrations/by-id/:migrationId" },
    app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
  };
  const res: any = new EventEmitter();
  res.statusCode = 404;
  res.locals = {};
  requestObservabilityMiddleware(req, res, () => {});
  setRequestTraceComputerCaller(res, { machineId: "m1", migrationId: "not-a-uuid" });
  res.emit("finish");
  const [span] = sink.getAllSpans();
  assert.equal(span!.attrs?.migration_id, undefined);
  assert.equal(span!.attrs?.machine_id_present, true);
});

test("a request names the client, version, Computer, daemon and runtime it says it came from", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink, traceIdGenerator: () => "7".repeat(32), spanIdGenerator: () => "8".repeat(16) });
  const headers: Record<string, string> = {
    "x-raft-client": "cli",
    "x-raft-client-version": "0.0.42",
    "x-raft-computer-version": "1.0.54",
    "x-raft-daemon-version": "1.0.53",
    "x-raft-runtime": "codex",
  };
  const req: any = {
    method: "GET",
    originalUrl: "/internal/agent-api/history",
    url: "/internal/agent-api/history",
    baseUrl: "/internal/agent-api",
    route: { path: "/history" },
    header: (name: string) => headers[name.toLowerCase()],
    app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};
  requestObservabilityMiddleware(req, res, () => {});
  res.emit("finish");
  const [span] = sink.getAllSpans();
  const finished = span!.events.find((event) => event.name === "http.response.finished")?.attrs;
  for (const attrs of [span!.attrs, finished]) {
    assert.equal(attrs?.client_kind, "cli");
    assert.equal(attrs?.client_version, "0.0.42");
    assert.equal(attrs?.client_computer_version, "1.0.54");
    assert.equal(attrs?.client_daemon_version, "1.0.53");
    assert.equal(attrs?.client_runtime, "codex");
  }
});

// #proj-analytics:#17 (Tenny 4772ad78): a signed-out public route's caller as a class, never the raw User-Agent.
test("a public route names its caller's class; other routes do not", () => {
  const spanFor = (url: string, userAgent: string) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink, traceIdGenerator: () => "9".repeat(32), spanIdGenerator: () => "a".repeat(16) });
    const req: any = {
      method: "GET",
      originalUrl: url,
      url,
      baseUrl: "",
      header: (name: string) => (name.toLowerCase() === "user-agent" ? userAgent : undefined),
      app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
    };
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.locals = {};
    requestObservabilityMiddleware(req, res, () => {});
    res.emit("finish");
    const [span] = sink.getAllSpans();
    return span!;
  };
  const chatgpt = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

  const publicSpan = spanFor("/api/public/artifacts/pt_1/index.md?x=1", chatgpt);
  const finished = publicSpan.events.find((event) => event.name === "http.response.finished")?.attrs;
  for (const attrs of [publicSpan.attrs, finished]) assert.equal(attrs?.public_requester, "chatgpt_user");
  assert.equal(JSON.stringify(publicSpan).includes("ChatGPT-User/1.0"), false, "the raw User-Agent is never recorded");

  assert.equal(spanFor("/api/channels", chatgpt).attrs?.public_requester, undefined, "only /api/public/*");
});

// #proj-o11y:#26 (Warden, Tenny): the IP limiters' key as a salted hash, so their limits can be checked against traffic.
test("every request span carries the salted client_ip_hash once the salt is set, never the address", () => {
  vi.stubEnv(CLIENT_IP_HASH_SALT_ENV, `v1:${"k".repeat(40)}`);
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink, traceIdGenerator: () => "9".repeat(32), spanIdGenerator: () => "b".repeat(16) });
    const req: any = {
      method: "GET",
      originalUrl: "/api/channels",
      url: "/api/channels",
      baseUrl: "",
      ip: "198.51.100.23",
      headers: {},
      header: () => undefined,
      app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
    };
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.locals = {};
    requestObservabilityMiddleware(req, res, () => {});
    res.emit("finish");
    const [span] = sink.getAllSpans();
    const finished = span!.events.find((event) => event.name === "http.response.finished")?.attrs;
    for (const attrs of [span!.attrs, finished]) {
      assert.match(String(attrs?.client_ip_hash), /^[0-9a-f]{16}$/);
      assert.equal(attrs?.client_ip_hash_salt, "v1");
      assert.equal(attrs?.client_ip_source, "edge");
    }
    assert.equal(JSON.stringify(span).includes("198.51.100.23"), false, "the address is never recorded");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("client claims that are not a short name, a version or a known platform are dropped, never written raw", () => {
  const attrsFor = (headers: Record<string, string>) => requestClientAttrs({ header: ((name: string) => headers[name.toLowerCase()]) as never });
  // The web and App platform header, and versions with a pre-release or build part.
  assert.deepEqual(attrsFor({ "x-raft-client-platform": "pwa" }), { client_platform: "pwa" });
  assert.deepEqual(attrsFor({ "x-raft-client-version": "1.15.5+123", "x-raft-computer-version": "v1.0.54-rc.1" }), {
    client_version: "1.15.5+123",
    client_computer_version: "v1.0.54-rc.1",
  });
  assert.deepEqual(attrsFor({
    "x-raft-client": "Mozilla/5.0 (secret)",
    "x-raft-client-platform": "toaster",
    "x-raft-client-version": "latest; rm -rf",
    "x-raft-computer-version": `1.0.0-${"x".repeat(80)}`,
    "x-raft-daemon-version": "unknown",
    "x-raft-runtime": "Claude Code",
  }), {});
  // A version is short: no digit group longer than 9.
  assert.deepEqual(attrsFor({ "x-raft-client-version": `${"9".repeat(20)}.0.0` }), {});
  // Older CLIs and daemons name themselves in X-Slock-Client; clients older still send nothing.
  assert.deepEqual(attrsFor({ "x-slock-client": "cli" }), { client_kind: "cli" });
  assert.deepEqual(attrsFor({ "x-raft-client": "daemon", "x-slock-client": "cli" }), { client_kind: "daemon" });
  assert.deepEqual(attrsFor({}), {});
});

test("a call through an agent's stable CLI entry is recorded as via=stable_entry; any other value is dropped", () => {
  const attrsFor = (headers: Record<string, string>) => requestClientAttrs({ header: ((name: string) => headers[name.toLowerCase()]) as never });
  assert.deepEqual(attrsFor({ "x-raft-client": "cli", "x-raft-cli-entry": "stable_entry" }), { client_kind: "cli", via: "stable_entry" });
  assert.deepEqual(attrsFor({ "x-raft-client": "cli", "x-raft-cli-entry": "launch; drop" }), { client_kind: "cli" });
});

test("the web names its build; an App's version comes from its User-Agent", () => {
  const attrsFor = (headers: Record<string, string>) => requestClientAttrs({ header: ((name: string) => headers[name.toLowerCase()]) as never });
  assert.deepEqual(attrsFor({ "x-raft-client-platform": "desktop_app", "x-raft-client-version": "1.21.36" }), {
    client_platform: "desktop_app",
    client_version: "1.21.36",
  });
  const appUserAgent = "Raft/1.15.5+123 (Android 14; release) Mobile";
  assert.deepEqual(attrsFor({ "x-raft-client-platform": "android", "user-agent": appUserAgent }), { client_platform: "android", client_version: "1.15.5" });
  assert.deepEqual(attrsFor({ "x-raft-client-platform": "ios", "user-agent": "Raft/2.0.1 (iOS 18.1; testflight) Mobile" }), { client_platform: "ios", client_version: "2.0.1" });
  // A header the App sends itself wins; a browser's User-Agent naming Raft/ is never read; an odd one is dropped.
  assert.equal(attrsFor({ "x-raft-client-platform": "android", "x-raft-client-version": "1.16.0", "user-agent": appUserAgent }).client_version, "1.16.0");
  assert.equal(attrsFor({ "x-raft-client-platform": "browser", "user-agent": `Mozilla/5.0 Chrome/141.0 Raft/9.9.9` }).client_version, undefined);
  assert.equal(attrsFor({ "x-raft-client-platform": "android", "user-agent": "Raft/1.15 (Android 14; release) Mobile" }).client_version, undefined);
});

// #proj-o11y task #6: an outside client's traceparent is recorded, not
// continued, so one reused client span cannot fold unrelated requests into
// one trace. Internal sources (daemon proxy, web session) keep their parent.
function runWithInboundHeaders(headers: Record<string, string>, afterAuth?: (req: any) => void) {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: () => "c".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl: "/internal/agent-api/events",
    url: "/internal/agent-api/events",
    baseUrl: "/internal/agent-api",
    route: { path: "/events" },
    header: (name: string) => headers[name.toLowerCase()],
    app: {
      get: (key: string) => (key === "serverTracer" ? tracer : undefined),
    },
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};
  requestObservabilityMiddleware(req, res, () => {});
  afterAuth?.(req);
  res.emit("finish");
  const [span] = sink.getAllSpans();
  return span!;
}

const CLIENT_TRACEPARENT = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;

test("an external agent credential's traceparent is recorded, not continued", () => {
  const span = runWithInboundHeaders({ authorization: "Bearer sk_agent_external", traceparent: CLIENT_TRACEPARENT });
  assert.equal(span.context.traceId, "d".repeat(32));
  assert.equal(span.context.parentSpanId, null);
  assert.equal(span.attrs?.trace_parent_policy, "linked");
  assert.equal(span.attrs?.client_trace_id, "a".repeat(32));
  assert.equal(span.attrs?.client_parent_span_id, "b".repeat(16));
});

test("third-party app and share tokens start a new trace too", () => {
  for (const token of ["slock_at_app", "raft_share_link"]) {
    const span = runWithInboundHeaders({ authorization: `Bearer ${token}`, traceparent: CLIENT_TRACEPARENT });
    assert.equal(span.context.parentSpanId, null, token);
    assert.equal(span.attrs?.trace_parent_policy, "linked", token);
  }
});

test("the daemon proxy and web sessions keep continuing their traceparent", () => {
  const daemon = runWithInboundHeaders({
    authorization: "Bearer sk_agent_hosted",
    "x-slock-agent-active-capabilities": "read,send",
    traceparent: CLIENT_TRACEPARENT,
  });
  assert.equal(daemon.context.traceId, "a".repeat(32));
  assert.equal(daemon.context.parentSpanId, "b".repeat(16));
  assert.equal(daemon.attrs?.trace_parent_policy, "continued");
  assert.equal(daemon.attrs?.client_trace_id, undefined);

  const web = runWithInboundHeaders({ authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig", traceparent: CLIENT_TRACEPARENT });
  assert.equal(web.context.traceId, "a".repeat(32));
  assert.equal(web.attrs?.trace_parent_policy, "continued");
});

test("an external client's malformed traceparent is never written raw", () => {
  const span = runWithInboundHeaders({ authorization: "Bearer sk_agent_external", traceparent: "00-not-a-valid-parent" });
  assert.equal(span.context.parentSpanId, null);
  assert.equal(span.attrs?.trace_parent_policy, "absent");
  assert.equal(span.attrs?.client_traceparent_invalid, true);
  assert.equal(span.attrs?.client_trace_id, undefined);
  assert.doesNotMatch(JSON.stringify(span.attrs), /not-a-valid-parent/);
});

test("a daemon claim from an agent that auth finds external is flagged", () => {
  const span = runWithInboundHeaders(
    { authorization: "Bearer sk_agent_external", "x-slock-agent-active-capabilities": "read", traceparent: CLIENT_TRACEPARENT },
    (req) => { req.actingAgentIsExternal = true; },
  );
  assert.equal(span.attrs?.trace_parent_policy, "continued");
  assert.equal(span.attrs?.trace_parent_claim_mismatch, true);
});

test("normalizeObservedRoutePattern drops a stale app-level route once the request is inside a mounted router (task #9)", () => {
  // An app-level `app.post("/internal/machine/scope-attestation", ...)` that
  // calls next() leaves req.route behind; inside `app.use("/internal", ...)`
  // baseUrl is "/internal" before the inner router matches.
  const req: any = {
    originalUrl: "/internal/machine/scope-attestation",
    url: "/machine/scope-attestation",
    baseUrl: "/internal",
    route: { path: "/internal/machine/scope-attestation" },
  };
  assert.equal(normalizeObservedRoutePattern(req), "/internal/machine/scope-attestation");

  const unrelated: any = {
    originalUrl: "/internal/agent/abc/upload",
    url: "/agent/abc/upload",
    baseUrl: "/internal",
    route: { path: "/internal/machine/scope-attestation" },
  };
  assert.equal(normalizeObservedRoutePattern(unrelated), "unmatched");
});

test("normalizeObservedRoutePattern keeps templates whose params sit inside a segment or use wildcards", () => {
  const dotted: any = {
    originalUrl: "/api/files/report.xlsx",
    url: "/files/report.xlsx",
    baseUrl: "/api",
    route: { path: "/files/:name.:ext" },
  };
  assert.equal(normalizeObservedRoutePattern(dotted), "/api/files/:name.:ext");

  const wildcard: any = {
    originalUrl: "/static/a/b/c.js",
    url: "/a/b/c.js",
    baseUrl: "/static",
    route: { path: "/*splat" },
  };
  assert.equal(normalizeObservedRoutePattern(wildcard), "/static/*splat");
});

test("a real Express app labels the scope-attestation pre-parse route once, at every stage", async () => {
  const { default: express } = await import("express");
  const { createServer, request } = await import("node:http");
  const seen: string[] = [];
  const app = express();
  app.post("/internal/machine/scope-attestation", (req, _res, next) => {
    seen.push(`app:${normalizeObservedRoutePattern(req)}`);
    next();
  });
  const internal = express.Router();
  internal.post("/machine/scope-attestation", (req, res) => {
    seen.push(`inner:${normalizeObservedRoutePattern(req)}`);
    res.status(204).end();
  });
  app.use("/internal", (req, _res, next) => {
    seen.push(`mount:${normalizeObservedRoutePattern(req)}`);
    next();
  }, internal);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/internal/machine/scope-attestation" }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(seen, [
    "app:/internal/machine/scope-attestation",
    "mount:/internal/machine/scope-attestation",
    "inner:/internal/machine/scope-attestation",
  ]);
});

test("requestObservabilityMiddleware returns the request's trace id as X-Trace-Id (#proj-o11y:#18)", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: () => "c".repeat(16),
  });
  const run = (traceparent: string | undefined) => {
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      originalUrl: "/api/agents",
      url: "/api/agents",
      baseUrl: "/api/agents",
      route: { path: "/" },
      header: (name: string) => (name === "traceparent" ? traceparent : undefined),
      app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
    };
    const res: any = new EventEmitter();
    res.statusCode = 500;
    res.locals = {};
    res.setHeader = (name: string, value: string) => { headers[name] = value; };
    requestObservabilityMiddleware(req, res, () => {});
    res.emit("finish");
    return headers;
  };
  // A web session continues the browser's trace: the browser's id comes back.
  assert.deepEqual(run(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`), { "X-Trace-Id": "a".repeat(32) });
  // No (or a malformed) traceparent: the server's own new trace comes back.
  assert.deepEqual(run(undefined), { "X-Trace-Id": "d".repeat(32) });
  assert.deepEqual(run("00-not-a-valid-parent"), { "X-Trace-Id": "d".repeat(32) });
});

function unmatchedSpanAttrs(originalUrl: string, statusCode: number) {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "1".repeat(32),
    spanIdGenerator: () => "2".repeat(16),
  });
  const req: any = {
    method: "GET",
    originalUrl,
    url: originalUrl,
    baseUrl: "",
    route: undefined,
    app: { get: (key: string) => (key === "serverTracer" ? tracer : undefined) },
  };
  const res: any = new EventEmitter();
  res.statusCode = statusCode;
  res.locals = {};
  requestObservabilityMiddleware(req, res, () => {});
  res.emit("finish");
  return sink.getAllSpans()[0]?.attrs;
}

test("an unmatched 5xx names its path prefix without ids or caller input", () => {
  assert.equal(unmatchedSpanAttrs("/api/apps/widgets/more?token=secret", 500)?.unmatched_prefix, "/api/apps/widgets");
  assert.equal(unmatchedSpanAttrs("/api/v2/550e8400-e29b-41d4-a716-446655440000", 500)?.unmatched_prefix, "/api/v2/*");
  assert.equal(unmatchedSpanAttrs("/api/abcdef-123/%ZZ", 503)?.unmatched_prefix, "/api/*/*");
  assert.equal(unmatchedSpanAttrs(`/api/${"a".repeat(41)}`, 500)?.unmatched_prefix, "/api/*");
});

test("only an unmatched 5xx records a path prefix", () => {
  assert.equal(unmatchedSpanAttrs("/api/apps/widgets", 404)?.unmatched_prefix, undefined);
});

