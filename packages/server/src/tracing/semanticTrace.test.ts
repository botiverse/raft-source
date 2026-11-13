import { strict as assert } from "node:assert";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan } from "@botiverse/raft-shared";
import { getActiveTraceContext, runWithActiveSpan } from "@botiverse/raft-trace-client";
import { afterEach, describe, test, vi } from "vitest";
import {
  addTraceEvent,
  createTraceDbQueryTracer,
  getCurrentTraceContext,
  recordTraceEvent,
  runWithTraceSpan,
  setDefaultTraceTracer,
  startDroppedTraceEventReporter,
  takeDroppedTraceEventCounts,
  traceMiddlewarePhase,
  tracePhase,
  withMiddlewarePhaseTrace,
  withTraceChildSpan,
  withTraceRoot,
} from "./semanticTrace";

const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

test("semantic trace facade emits phase and db events on the current span", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });

  await runWithTraceSpan(span, async () => {
    addTraceEvent("sidebar_order.load.started");
    const result = await tracePhase(
      async () => ["a", "b"],
      (durationMs, rows) => ({
        name: "sidebar_order.loaded",
        attrs: {
          duration_seen: durationMs >= 0,
          rows_count: rows.length,
        },
      }),
    );
    assert.deepEqual(result, ["a", "b"]);

    const traceQuery = createTraceDbQueryTracer("sidebar_order.loaded");
    await traceQuery("servers.sidebar_order_by_member_sanitized", async () => [1, 2, 3], (rows) => ({
      input_count: rows.length,
    }));
  });

  span.end();

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  assert.deepEqual(
    recorded.events.map((event) => event.name),
    [
      "sidebar_order.load.started",
      "sidebar_order.loaded",
      "db.query.finished",
    ],
  );
  const dbEvent = recorded.events.find((event) => event.name === "db.query.finished");
  assert.equal(dbEvent?.attrs?.event_kind, "db_query");
  assert.equal(dbEvent?.attrs?.outcome, "success");
  assert.equal(dbEvent?.attrs?.reason, "query_completed");
  assert.equal(dbEvent?.attrs?.query_name, "servers.sidebar_order_by_member_sanitized");
  assert.equal(dbEvent?.attrs?.phase, "sidebar_order.loaded");
  assert.equal(dbEvent?.attrs?.row_count, 3);
  assert.equal(dbEvent?.attrs?.input_count, 3);

  const dbRow = traceEventRowsForSpan(recorded, TRACE_EVENT_ROW_TEST_RESOURCE)
    .find((row) => row.event_name === "db.query.finished");
  assert.ok(dbRow);
  assert.equal(dbRow.event_kind, "db_query");
  assert.equal(dbRow.outcome, "success");
  assert.equal(dbRow.reason, "query_completed");
});

test("semantic trace facade is no-op without an active span", async () => {
  addTraceEvent("no.active.span");
  await tracePhase(async () => "ok", () => ({ name: "phase.without.span" }));
  const traceQuery = createTraceDbQueryTracer("missing.phase");
  assert.deepEqual(await traceQuery("query.without.span", async () => [1]), [1]);
});

test("a middleware phase records one `middleware.phase.finished` (phase + duration_ms only) when it hands the request on", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  const forwarded: unknown[][] = [];
  const next = ((...args: unknown[]) => { forwarded.push(args); }) as never;

  await runWithTraceSpan(span, async () => {
    const authNext = traceMiddlewarePhase("auth", next);
    await new Promise((resolve) => setTimeout(resolve, 5));
    authNext();
    authNext(); // a second hand-off is forwarded but not recorded again
    // A middleware that answers the request itself never calls next: nothing recorded.
    traceMiddlewarePhase("answered", next);
    const failure = new Error("boom");
    traceMiddlewarePhase("server_membership", next)(failure);
    await new Promise<void>((resolve) => {
      withMiddlewarePhaseTrace("rate_limit.message", (_req, _res, limiterNext) => { limiterNext(); resolve(); })(
        {} as never, {} as never, next,
      );
    });
  });
  span.end();

  assert.equal(forwarded.length, 4);
  assert.equal(forwarded[2]?.[0] instanceof Error, true);
  const events = sink.getAllSpans()[0]!.events;
  assert.deepEqual(events.map((event) => event.name), Array(3).fill("middleware.phase.finished"));
  assert.deepEqual(events.map((event) => event.attrs?.phase), ["auth", "server_membership", "rate_limit.message"]);
  for (const event of events) assert.deepEqual(Object.keys(event.attrs ?? {}).sort(), ["duration_ms", "phase"]);
  assert.ok(Number(events[0]!.attrs?.duration_ms) >= 4);
  assert.equal(Number.isInteger(events[0]!.attrs?.duration_ms), true);
  const row = traceEventRowsForSpan(sink.getAllSpans()[0]!, TRACE_EVENT_ROW_TEST_RESOURCE)
    .find((candidate) => candidate.event_name === "middleware.phase.finished");
  assert.equal(row?.phase, "auth");
});

test("a middleware phase outside a request only forwards", () => {
  let called = 0;
  traceMiddlewarePhase("auth", (() => { called += 1; }) as never)();
  assert.equal(called, 1);
});

test("semantic trace root exposes current context and closes on failure", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "e".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });

  await assert.rejects(
    () => withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, async () => {
      assert.equal(getCurrentTraceContext()?.traceId, "e".repeat(32));
      throw new TypeError("boom");
    }, "server.http.request.error"),
    TypeError,
  );

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  assert.equal(recorded.status, "error");
  assert.equal(recorded.attrs?.error_class, "TypeError");
  const [errorEvent] = sink.getAllLogEvents();
  assert.equal(errorEvent?.name, "server.http.request.error");
  assert.equal(errorEvent?.context?.spanId, recorded.context.spanId);
  assert.equal(errorEvent?.attrs?.error_class, "TypeError");
});

test("a child span under the request's span: timed, its end attributes from the result, and `statusOf` for a failure answered, not thrown", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const request = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  await runWithTraceSpan(request, async () => {
    await withTraceChildSpan("server.example.ok", { surface: "server", kind: "internal", attrs: { kind: "html" } }, async () => ({ status: 200 }), {
      onSuccess: (result) => ({ status_code: result.status }),
    });
    await withTraceChildSpan("server.example.answered", { surface: "server", kind: "internal" }, async () => ({ status: 503 }), {
      onSuccess: (result) => ({ status_code: result.status }),
      statusOf: (result) => (result.status >= 500 ? "error" : "ok"),
    });
  }, tracer);
  request.end("ok");
  const [ok, answered] = sink.getAllSpans().filter((span) => span.name.startsWith("server.example."));
  for (const span of [ok, answered]) {
    assert.equal(span?.context.parentSpanId, request.context.spanId);
    assert.equal(typeof span?.attrs?.duration_ms, "number");
  }
  assert.deepEqual([ok?.status, ok?.attrs?.kind, ok?.attrs?.status_code], ["ok", "html", 200]);
  assert.deepEqual([answered?.status, answered?.attrs?.status_code], ["error", 503]);
});

test("db query tracer labels success and failure events with db_system and duration bucket", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });

  await runWithTraceSpan(span, async () => {
    const traceQuery = createTraceDbQueryTracer("inbox.read");
    await traceQuery("channels.inbox", async () => [1]);
    const timeoutError = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    await assert.rejects(
      traceQuery("channels.inbox", async () => { throw timeoutError; }),
      timeoutError,
    );
  }, tracer);
  span.end();

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  const finished = recorded.events.find((event) => event.name === "db.query.finished");
  assert.ok(finished);
  assert.equal(finished.attrs?.db_system, "postgresql");
  assert.match(String(finished.attrs?.timeout_bucket), /^(<1s|1-5s|5-15s|>15s)$/);

  const failed = recorded.events.find((event) => event.name === "db.query.failed");
  assert.ok(failed);
  assert.equal(failed.attrs?.db_system, "postgresql");
  assert.equal(failed.attrs?.sqlstate, "57014");
  assert.equal(failed.attrs?.retryable, "true");
  assert.match(String(failed.attrs?.timeout_bucket), /^(<1s|1-5s|5-15s|>15s)$/);
  assert.equal(failed.attrs?.error_class, "Error");

  const rows = traceEventRowsForSpan(recorded, TRACE_EVENT_ROW_TEST_RESOURCE);
  const failedRow = rows.find((row) => row.event_name === "db.query.failed");
  assert.ok(failedRow);
  assert.equal(failedRow.db_system, "postgresql");
  assert.equal(failedRow.sqlstate, "57014");
  assert.equal(failedRow.retryable, "true");
  assert.notEqual(failedRow.timeout_bucket, null);
});

test("db query tracer honors an explicit non-default db_system", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });

  await runWithTraceSpan(span, async () => {
    const traceQuery = createTraceDbQueryTracer("inbox.read", { dbSystem: "risingwave" });
    await traceQuery("channels.inbox_rw", async () => [1]);
    await assert.rejects(
      traceQuery("channels.inbox_rw", async () => { throw new Error("boom"); }),
    );
  }, tracer);
  span.end();

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  const finished = recorded.events.find((event) => event.name === "db.query.finished");
  const failed = recorded.events.find((event) => event.name === "db.query.failed");
  assert.equal(finished?.attrs?.db_system, "risingwave");
  assert.equal(failed?.attrs?.db_system, "risingwave");
  assert.equal(failed?.attrs?.retryable, "false");
  assert.equal(failed?.attrs && "sqlstate" in failed.attrs, false);
});

test("server and daemon read one active-span store", () => {
  // The server facade and the daemon-side trace-client must agree on the
  // active span, otherwise in-process work that crosses the two (built-in app
  // runtimes, tests that drive both) parents its spans to nothing.
  const tracer = new BasicTracer({ sink: new MemoryTraceSink() });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  try {
    assert.equal(getCurrentTraceContext(), null);
    assert.equal(getActiveTraceContext(), null);
    assert.deepEqual(runWithTraceSpan(span, () => getActiveTraceContext()), span.context);
    assert.deepEqual(runWithActiveSpan(span, () => getCurrentTraceContext()), span.context);
    assert.equal(getCurrentTraceContext(), null);
  } finally {
    span.end();
  }
});

describe("trace records outside a request", () => {
  afterEach(() => {
    setDefaultTraceTracer(null);
    takeDroppedTraceEventCounts();
  });

  test("recordTraceEvent uses the process default tracer when there is no request tracer", () => {
    const sink = new MemoryTraceSink();
    setDefaultTraceTracer(new BasicTracer({ sink }));
    recordTraceEvent("server.assistant.doorbell.sent", { source_count: 1 });
    assert.deepEqual(sink.getAllLogEvents().map((event) => event.name), ["server.assistant.doorbell.sent"]);
    assert.equal(takeDroppedTraceEventCounts().size, 0);
  });

  test("withTraceRoot without a tracer records through the process default tracer", async () => {
    const sink = new MemoryTraceSink();
    setDefaultTraceTracer(new BasicTracer({ sink }));
    await withTraceRoot(undefined, "server.worker.tick", { surface: "server", kind: "internal" }, async () => undefined);
    assert.deepEqual(sink.getAllSpans().map((span) => span.name), ["server.worker.tick"]);
  });

  test("records with no tracer at all are dropped and counted by name", async () => {
    recordTraceEvent("server.example.event");
    recordTraceEvent("server.example.event");
    await withTraceRoot(null, "server.example.root", { surface: "server", kind: "internal" }, async () => undefined);
    assert.deepEqual(Object.fromEntries(takeDroppedTraceEventCounts()), {
      "server.example.event": 2,
      "server.example.root": 1,
    });
    assert.equal(takeDroppedTraceEventCounts().size, 0);
  });

  test("the reporter emits one dropped event per name and nothing when counts are zero", () => {
    vi.useFakeTimers();
    try {
      const sink = new MemoryTraceSink();
      const stop = startDroppedTraceEventReporter(new BasicTracer({ sink }), 1_000);
      vi.advanceTimersByTime(1_000);
      assert.equal(sink.getAllLogEvents().length, 0);
      recordTraceEvent("server.example.event");
      vi.advanceTimersByTime(1_000);
      stop();
      const events = sink.getAllLogEvents();
      assert.deepEqual(events.map((event) => [event.name, event.attrs?.event_name, event.attrs?.count]), [
        ["server.trace_event.dropped", "server.example.event", 1],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
