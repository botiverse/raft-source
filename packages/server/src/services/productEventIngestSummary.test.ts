import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { countIngest } from "./productEventIngest";
import {
  flushProductEventIngestSummary,
  flushProductEventsBeforeExit,
  noteProductEventWriteFailure,
  PRODUCT_EVENT_SUMMARY_INTERVAL_MS,
  resetProductEventIngestSummaryForTest,
  startProductEventIngestSummary,
} from "./productEventIngestSummary";
import { productScopeDbStore, resolveProductScopeDbConfig } from "./productEventScopeDbWriter";

afterEach(() => {
  resetProductEventIngestSummaryForTest();
  vi.useRealTimers();
});

function tracer() {
  const sink = new MemoryTraceSink();
  return { sink, tracer: new BasicTracer({ sink }) };
}

function outcomes(sink: MemoryTraceSink) {
  return sink.getAllLogEvents()
    .filter((e) => e.name === "server.product_events.outcome")
    .map((e) => e.attrs);
}

test("startup names the env pair the writer uses, never a value", () => {
  const { sink, tracer: t } = tracer();
  startProductEventIngestSummary(t, "trace_events");
  const events = sink.getAllLogEvents();
  assert.deepEqual(events.map((e) => [e.name, e.attrs]), [["server.product_events.store", { store: "trace_events" }]]);
});

test("each window reports every outcome it saw, once, with counts; an idle window reports nothing", () => {
  const { sink, tracer: t } = tracer();
  let now = 1_000_000;
  startProductEventIngestSummary(t, "none", { now: () => now });

  countIngest("unconfigured", 3);
  countIngest("public_visit_flag_off", 1);
  countIngest("public_visit_flag_off", 2);
  countIngest("gated", 0); // nothing happened: not reported
  now += 600_000;
  flushProductEventIngestSummary(now);
  assert.deepEqual(outcomes(sink), [
    { outcome: "unconfigured", count: 3, window_s: 600, store: "none" },
    { outcome: "public_visit_flag_off", count: 3, window_s: 600, store: "none" },
  ]);

  sink.clear();
  now += 600_000;
  flushProductEventIngestSummary(now);
  assert.deepEqual(outcomes(sink), []);
});

test("a failed-write report says when the first and last failure of its kind happened, not only how many", () => {
  const { sink, tracer: t } = tracer();
  let now = Date.parse("2026-10-24T08:43:20Z");
  startProductEventIngestSummary(t, "product", { now: () => now });
  const rateLimited = { table: "events", error_class: "ScopeDBError", kind: "StatementFailed", http_status: 429 } as const;
  now = Date.parse("2026-10-24T08:45:31Z");
  noteProductEventWriteFailure(rateLimited);
  now = Date.parse("2026-10-24T08:45:33Z");
  noteProductEventWriteFailure({ table: "events", error_class: "TypeError", error_code: "ECONNRESET" });
  now = Date.parse("2026-10-24T08:46:02Z");
  noteProductEventWriteFailure(rateLimited);
  now = Date.parse("2026-10-24T08:53:20Z");
  flushProductEventIngestSummary(now);
  const failed = sink.getAllLogEvents()
    .filter((e) => e.name === "server.product_events.write_failed")
    .map((e) => [e.attrs?.error_class, e.attrs?.count, e.attrs?.first_at, e.attrs?.last_at]);
  assert.deepEqual(failed, [
    ["ScopeDBError", 2, "2026-10-24T08:45:31.000Z", "2026-10-24T08:46:02.000Z"],
    ["TypeError", 1, "2026-10-24T08:45:33.000Z", "2026-10-24T08:45:33.000Z"],
  ]);
});

test("the window closes on its own timer", () => {
  vi.useFakeTimers();
  const { sink, tracer: t } = tracer();
  startProductEventIngestSummary(t, "product");
  countIngest("written", 5);
  vi.advanceTimersByTime(PRODUCT_EVENT_SUMMARY_INTERVAL_MS);
  assert.deepEqual(outcomes(sink), [{ outcome: "written", count: 5, window_s: 600, store: "product" }]);
});

test("before startup nothing is kept (tests and tools never start it)", () => {
  countIngest("gated", 4);
  const { sink, tracer: t } = tracer();
  startProductEventIngestSummary(t, "product");
  flushProductEventIngestSummary();
  assert.deepEqual(outcomes(sink), []);
});

test("shutdown writes the rows, then reports the last partial window, then flushes the tracer", async () => {
  const { sink, tracer: t } = tracer();
  let now = 1_000_000;
  startProductEventIngestSummary(t, "product", { now: () => now });
  countIngest("written", 2);
  now += 90_000;
  const order: string[] = [];
  let reportedBeforeTracer: ReturnType<typeof outcomes> = [];
  await flushProductEventsBeforeExit({
    flushRows: async () => {
      await Promise.resolve();
      countIngest("written", 3);
      countIngest("lost", 1);
      order.push("rows");
    },
    shutdownTracer: async () => {
      reportedBeforeTracer = outcomes(sink);
      order.push("tracer");
    },
    now: () => now,
  });
  assert.deepEqual(order, ["rows", "tracer"]);
  assert.deepEqual(reportedBeforeTracer, [
    { outcome: "written", count: 5, window_s: 90, store: "product" },
    { outcome: "lost", count: 1, window_s: 90, store: "product" },
  ]);
});

test("shutdown stops the window timer, so nothing is reported twice", async () => {
  vi.useFakeTimers();
  const { sink, tracer: t } = tracer();
  startProductEventIngestSummary(t, "product");
  countIngest("written", 4);
  await flushProductEventsBeforeExit({ flushRows: async () => {}, shutdownTracer: async () => {} });
  countIngest("written", 1);
  vi.advanceTimersByTime(PRODUCT_EVENT_SUMMARY_INTERVAL_MS);
  assert.equal(outcomes(sink).length, 1);
});

test("a slow row flush holds the tracer for the budget only, and its rows are still awaited", async () => {
  vi.useFakeTimers();
  const { sink, tracer: t } = tracer();
  startProductEventIngestSummary(t, "product");
  countIngest("written", 1);
  let tracerFlushed = false;
  let rowsDone = false;
  let resolved = false;
  const exit = flushProductEventsBeforeExit({
    flushRows: () => new Promise<void>((resolve) => setTimeout(() => { rowsDone = true; resolve(); }, 8_000)),
    shutdownTracer: async () => { tracerFlushed = true; },
    budgetMs: 5_000,
  }).then(() => { resolved = true; });
  await vi.advanceTimersByTimeAsync(4_999);
  assert.equal(tracerFlushed, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(tracerFlushed, true);
  assert.equal(outcomes(sink).length, 1);
  assert.equal(resolved, false, "the rows are still being written");
  await vi.advanceTimersByTimeAsync(3_000);
  await exit;
  assert.equal(rowsDone, true);
});

test("a row flush that rejects or throws still reports the window and flushes the tracer", async () => {
  const { sink, tracer: t } = tracer();
  startProductEventIngestSummary(t, "product");
  const failing: Array<() => Promise<unknown>> = [
    () => Promise.reject(new Error("store down")),
    () => { throw new Error("sink could not be built"); },
  ];
  for (const flushRows of failing) {
    countIngest("written", 1);
    let tracerFlushed = false;
    await flushProductEventsBeforeExit({ flushRows, shutdownTracer: async () => { tracerFlushed = true; } });
    assert.equal(tracerFlushed, true);
  }
  assert.equal(outcomes(sink).length, 2);
});

test("a tracer that fails fast still waits for the rows, then reports its failure", async () => {
  vi.useFakeTimers();
  let rowsDone = false;
  const exit = flushProductEventsBeforeExit({
    flushRows: () => new Promise<void>((resolve) => setTimeout(() => { rowsDone = true; resolve(); }, 8_000)),
    shutdownTracer: () => Promise.reject(new Error("trace store down")),
  });
  let outcome: string | null = null;
  const settled = exit.then(() => { outcome = "resolved"; }, (err: Error) => { outcome = err.message; });
  await vi.advanceTimersByTimeAsync(5_000); // the tracer is asked, and fails, at the budget
  assert.equal(outcome, null, "still writing the rows");
  await vi.advanceTimersByTimeAsync(3_000);
  await settled;
  assert.equal(rowsDone, true);
  assert.equal(outcome, "trace store down");
});

test("the reported store is the pair resolveProductScopeDbConfig takes", () => {
  const trace = { SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://trace.example", SCOPEDB_TRACE_EVENTS_WRITE_KEY: "trace-key" };
  const product = { SCOPEDB_PRODUCT_ENDPOINT: "https://product.example", SCOPEDB_PRODUCT_WRITE_KEY: "product-key" };
  const quiet = () => {};
  const cases: Array<[NodeJS.ProcessEnv, string | null]> = [
    [{}, null],
    [{ SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://trace.example" }, null],
    [trace, "https://trace.example"],
    [{ ...trace, ...product }, "https://product.example"],
    [{ ...trace, SCOPEDB_PRODUCT_ENDPOINT: "https://product.example" }, "https://trace.example"],
    [{ SCOPEDB_PRODUCT_WRITE_KEY: "product-key" }, null],
    [product, "https://product.example"],
  ];
  const storeOf: Record<string, string> = {
    "https://trace.example": "trace_events",
    "https://product.example": "product",
  };
  for (const [env, endpoint] of cases) {
    assert.equal(resolveProductScopeDbConfig(env, quiet)?.endpoint ?? null, endpoint);
    assert.equal(productScopeDbStore(env), endpoint ? storeOf[endpoint] : "none", JSON.stringify(Object.keys(env)));
  }
});
