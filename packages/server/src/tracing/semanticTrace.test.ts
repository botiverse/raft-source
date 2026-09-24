import { strict as assert } from "node:assert";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan } from "@botiverse/raft-shared";
import { addTraceEvent, createTraceDbQueryTracer, getCurrentTraceContext, runWithTraceSpan, tracePhase, withTraceRoot } from "./semanticTrace.js";

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
    }),
    TypeError,
  );

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  assert.equal(recorded.status, "error");
  assert.equal(recorded.events.at(-1)?.name, "error");
  assert.equal(recorded.events.at(-1)?.attrs?.error_class, "TypeError");
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
