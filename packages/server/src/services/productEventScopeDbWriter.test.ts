import assert from "node:assert/strict";
import { Client } from "scopedb";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { register } from "../metrics";
import {
  flushProductEventIngestSummary,
  resetProductEventIngestSummaryForTest,
  startProductEventIngestSummary,
} from "./productEventIngestSummary";
import {
  createProductEventSinkFromEnv,
  resolveProductScopeDbConfig,
  PUBLIC_VISITORS_COLUMNS,
  ScopeDbProductEventSink,
  ScopeDbPublicVisitorSink,
  type ProductEventRow,
} from "./productEventScopeDbWriter";

/** A ScopeDB client whose Table.append() calls `append` with the NDJSON and `schema.table`. */
function appendClient(append: (data: string, table: string) => Promise<{ num_rows_inserted: number }>) {
  return {
    table: (name: string, options?: { schema?: string }) => ({
      append: async (data: string) => ({ status: "succeeded" as const, ...await append(data, `${options?.schema}.${name}`) }),
    }),
  } as never;
}

function row(index: number): ProductEventRow {
  return {
    uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    event: "activity_open",
    source: "web",
    timestamp: "2026-10-05T10:00:00.000Z",
    received_at: "2026-10-05T10:00:01.000Z",
    analytics_id: null,
    server_id: null,
    client_session_id: "tab-1",
    app_version: null,
    platform: null,
    properties: { from: "rail" },
  };
}

async function ingestCount(outcome: string): Promise<number> {
  const metric = await register.getSingleMetric("slock_product_event_ingest_total")?.get();
  return metric?.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

test("rows are written in batches to product.events as strictly encoded Append NDJSON", async () => {
  const inserts: Array<{ lines: number; table: string; data: string }> = [];
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, flushIntervalMs: 60_000 }, appendClient(async (data: string, table: string) => {
      inserts.push({ lines: data.split("\n").length, table, data });
      return { num_rows_inserted: data.split("\n").length };
    }));
  const writtenBefore = await ingestCount("written");

  sink.enqueue([row(1)]);
  assert.equal(inserts.length, 0, "below batch size: waits for the timer");
  sink.enqueue([row(2), row(3)]);
  await sink.flush();

  assert.deepEqual(inserts.map((insert) => insert.lines), [2, 1]);
  assert.ok(inserts.every((insert) => insert.table === "product.events"));
  assert.equal(
    inserts[1]!.data,
    '{"uuid":"00000000-0000-4000-8000-000000000003","event":"activity_open","source":"web",'
      + '"timestamp":"2026-10-05T10:00:00.000Z","received_at":"2026-10-05T10:00:01.000Z","analytics_id":null,'
      + '"server_id":null,"client_session_id":"tab-1","app_version":null,"platform":null,'
      + '"properties":{"from":"rail"},"deployment_environment":null}',
  );
  assert.equal((await ingestCount("written")) - writtenBefore, 3);
});

test("a batch that keeps failing and a full queue are counted as lost, never thrown", async () => {
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, maxQueueSize: 3, flushIntervalMs: 60_000, maxAttempts: 1 }, appendClient(async () => {
      throw new Error("insert failed for 11111111-1111-4111-8111-111111111111");
    }));
  const lostBefore = await ingestCount("lost");

  sink.enqueue([row(1)]);
  sink.enqueue([row(2), row(3), row(4), row(5)]); // 5 queued > max 3: 2 dropped
  await sink.flush();

  assert.equal((await ingestCount("lost")) - lostBefore, 5);
});

test("concurrent flushes share one drain, so shutdown waits for every queued row", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const written: number[] = [];
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, flushIntervalMs: 60_000 }, appendClient(async (data: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      written.push(data.split("\n").length);
      return { num_rows_inserted: data.split("\n").length };
    }));

  sink.enqueue([row(1), row(2)]); // full batch: starts a drain
  sink.enqueue([row(3), row(4), row(5)]); // more rows while it runs
  await Promise.all([sink.flush(), sink.flush()]);

  assert.equal(maxInFlight, 1, "never two writes at once");
  assert.equal(written.reduce((a, b) => a + b, 0), 5, "the awaited flush covers rows queued mid-drain");
});

test("the writer reuses the trace events' ScopeDB config unless a complete product pair is set", () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const trace = { SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://trace.example", SCOPEDB_TRACE_EVENTS_WRITE_KEY: "trace-key" };

  assert.equal(resolveProductScopeDbConfig({}, warn), null);
  assert.equal(resolveProductScopeDbConfig({ SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://trace.example" }, warn), null);
  assert.deepEqual(resolveProductScopeDbConfig(trace, warn), { endpoint: "https://trace.example", apiKey: "trace-key" });
  assert.deepEqual(
    resolveProductScopeDbConfig({ ...trace, SCOPEDB_PRODUCT_ENDPOINT: "https://product.example", SCOPEDB_PRODUCT_WRITE_KEY: "product-key" }, warn),
    { endpoint: "https://product.example", apiKey: "product-key" },
  );
  assert.equal(warnings.length, 0);

  // Half a product pair is never mixed with the trace pair.
  assert.deepEqual(
    resolveProductScopeDbConfig({ ...trace, SCOPEDB_PRODUCT_ENDPOINT: "https://product.example" }, warn),
    { endpoint: "https://trace.example", apiKey: "trace-key" },
  );
  assert.equal(warnings.length, 1);
  assert.equal(createProductEventSinkFromEnv({}), null);
  assert.ok(createProductEventSinkFromEnv(trace) instanceof ScopeDbProductEventSink);
});

test("a failed write is retried with backoff instead of dropped, and rows carry the environment", async () => {
  let calls = 0;
  const written: string[] = [];
  const sink = new ScopeDbProductEventSink({
    endpoint: "x", apiKey: "y", deploymentEnvironment: "staging",
    batchSize: 2, flushIntervalMs: 60_000, retryBaseMs: 5, maxAttempts: 5,
  }, appendClient(async (data: string) => {
      calls += 1;
      if (calls <= 2) throw new Error("429 too many requests");
      written.push(...data.split("\n"));
      return { num_rows_inserted: data.split("\n").length };
    }));
  const lostBefore = await ingestCount("lost");

  sink.enqueue([row(1), row(2)]); // full batch: first attempt fails, then backs off
  const deadline = Date.now() + 2_000;
  while (written.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(calls, 3, "two failures, then the retry succeeds");
  assert.equal(written.length, 2);
  assert.equal((await ingestCount("lost")) - lostBefore, 0, "nothing lost to a transient failure");
  assert.equal(JSON.parse(written[0]!).deployment_environment, "staging");
});

// Tenny, 2026-10-14: the visitor-id table is written on its own, so a missing
// or failing product.public_visitors never costs product.events rows.
test("public visitor rows go to their own table, and their failures are counted apart", async () => {
  assert.deepEqual(PUBLIC_VISITORS_COLUMNS, [
    ["uuid", "string"],
    ["event", "string"],
    ["server_id", "string"],
    ["received_at", "timestamp"],
    ["anonymous_id", "string"],
    ["deployment_environment", "string"],
  ]);
  const written: string[] = [];
  const visitors = new ScopeDbPublicVisitorSink({ endpoint: "x", apiKey: "y", deploymentEnvironment: "staging", flushIntervalMs: 60_000, maxAttempts: 1 }, appendClient(async () => {
      throw new Error("table product.public_visitors does not exist");
    }));
  const events = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", flushIntervalMs: 60_000 }, appendClient(async (data: string) => {
      written.push(data);
      return { num_rows_inserted: data.split("\n").length };
    }));
  const lostBefore = await ingestCount("lost");
  const visitorLostBefore = await ingestCount("public_visitor_lost");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    visitors.enqueue([{
      uuid: "00000000-0000-4000-8000-000000000001",
      event: "public_page_viewed",
      server_id: "10000000-0000-4000-8000-000000000001" as never,
      received_at: "2026-10-14T10:00:00.000Z",
      anonymous_id: "20000000-0000-4000-8000-000000000001",
    }]);
    events.enqueue([row(1)]);
    await Promise.all([visitors.flush(), events.flush()]);
    assert.equal(written.length, 1, "product.events still written");
    assert.equal((await ingestCount("public_visitor_lost")) - visitorLostBefore, 1);
    assert.equal((await ingestCount("lost")) - lostBefore, 0);
    assert.ok(warn.mock.calls.every((call) => !call.join(" ").includes("20000000-0000-4000-8000-000000000001")), "no visitor id in logs");
  } finally {
    warn.mockRestore();
  }
});

/** A real scopedb 0.4 client whose transport answers each request with the next response (or throws it); `appended` gets the URL of each committed append. */
function sdkClient(responses: Array<Response | Error>, appended: string[] = []) {
  return new Client("https://scope.example", {
    apiKey: "test-key",
    fetch: async (input) => {
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      if (next.ok) appended.push(String(input));
      return next;
    },
  });
}

test("each failed write reaches otel.logs as bounded fields, never the store's error text (real SDK errors)", async () => {
  const traces = new MemoryTraceSink();
  startProductEventIngestSummary(new BasicTracer({ sink: traces }), "trace_events");
  const appended: string[] = [];
  const client = sdkClient([
    // A gateway throttle: plain body, so the SDK says outcome "ambiguous".
    new Response("Too Many Requests 11111111-1111-4111-8111-111111111111", { status: 429, headers: { "retry-after": "0" } }),
    // ScopeDB's structured rejection.
    new Response(JSON.stringify({
      message: "rate limited 22222222-2222-4222-8222-222222222222",
      code: "rate_limited",
      details: { status: "rejected" },
    }), { status: 429, headers: { "content-type": "application/json" } }),
    new Response("upstream unavailable", { status: 503 }),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    new Response(JSON.stringify({ status: "committed", num_rows_inserted: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
  ], appended);
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", flushIntervalMs: 60_000, maxAttempts: 10 }, client);
  const writtenBefore = await ingestCount("written");
  const lostBefore = await ingestCount("lost");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    sink.enqueue([row(1)]);
    for (let attempt = 0; attempt < 5; attempt++) await sink.flush();
    flushProductEventIngestSummary();
  } finally {
    warn.mockRestore();
    resetProductEventIngestSummaryForTest();
  }

  const logs = traces.getAllLogEvents();
  const failed = logs.filter((e) => e.name === "server.product_events.write_failed").map(({ attrs }) => {
    const { window_s: _window, first_at, last_at, ...rest } = attrs as Record<string, unknown>;
    assert.equal(typeof first_at, "string");
    assert.equal(typeof last_at, "string");
    return rest;
  });
  const base = { table: "events", error_class: "AppendRowsError", kind: "AppendRowsFailed", store: "trace_events", count: 1 };
  assert.deepEqual(failed, [
    // A plain-body 429 is rate limiting (not committed), not an unknown outcome.
    { ...base, http_status: 429, append_failure: "throttled" },
    { ...base, http_status: 429, append_failure: "throttled", error_code: "other" },
    { ...base, http_status: 503, append_failure: "unavailable" },
    // A network failure mid-request may have committed.
    { ...base, append_failure: "unknown", error_code: "ECONNRESET" },
  ]);
  // Look for the error texts' full ids: a short "1111"/"2222" also matches random trace ids and timestamps.
  assert.equal(JSON.stringify(logs).includes("11111111-1111-4111-8111-111111111111"), false, "no error text, so no row content");
  assert.equal(JSON.stringify(logs).includes("22222222-2222-4222-8222-222222222222"), false, "no error text, so no row content");
  // Retried until written, counted once, nothing lost.
  assert.equal(appended.length, 1);
  assert.equal((await ingestCount("written")) - writtenBefore, 1);
  assert.equal((await ingestCount("lost")) - lostBefore, 0);
});

test("a throttled write waits for the server's Retry-After before its retry", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const appended: string[] = [];
    const client = sdkClient([
      new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } }),
      new Response(JSON.stringify({ status: "committed", num_rows_inserted: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
    ], appended);
    const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 1, flushIntervalMs: 60_000, retryBaseMs: 10 }, client);
    const startedMs = Date.now();
    sink.enqueue([row(1)]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(appended.length, 0, "the 10 ms backoff does not undercut Retry-After: 1");
    while (appended.length === 0 && Date.now() - startedMs < 3_000) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(appended.length, 1);
    assert.ok(Date.now() - startedMs >= 1_000);
  } finally {
    warn.mockRestore();
  }
});

test("a batch rides out a ScopeDB outage of up to 10 minutes, then is counted lost", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // A 7-minute outage (the 0.6 upgrade, 2026-10-24): every write fails, then the store is back.
    let downUntil = Date.now() + 7 * 60_000;
    let attempts = 0;
    const written: string[] = [];
    const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, flushIntervalMs: 60_000 }, appendClient(async (data: string) => {
        attempts += 1;
        if (Date.now() < downUntil) throw new Error("503 service unavailable");
        written.push(...data.split("\n"));
        return { num_rows_inserted: data.split("\n").length };
      }));
    const lostBefore = await ingestCount("lost");
    sink.enqueue([row(1), row(2)]);
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    assert.equal(written.length, 2, "written once the store is back");
    assert.ok(attempts > 5, `more than the old 5 attempts (${attempts})`);
    assert.equal((await ingestCount("lost")) - lostBefore, 0);

    // An outage longer than the window: the batch is dropped and counted, not held forever.
    downUntil = Date.now() + 60 * 60_000;
    sink.enqueue([row(3), row(4)]);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    assert.equal((await ingestCount("lost")) - lostBefore, 0, "still retrying inside the window");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    assert.equal((await ingestCount("lost")) - lostBefore, 2);
  } finally {
    warn.mockRestore();
    vi.useRealTimers();
  }
});

test("a row that cannot be encoded for Append is lost on its own, not with its batch", async () => {
  const written: string[] = [];
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 10, flushIntervalMs: 60_000 }, appendClient(async (data: string) => {
    written.push(...data.split("\n"));
    return { num_rows_inserted: data.split("\n").length };
  }));
  const lostBefore = await ingestCount("lost");

  // Append rejects a timestamp without an explicit offset; the legacy cast guessed one.
  sink.enqueue([row(1), { ...row(2), timestamp: "2026-10-05T10:00:00" }, row(3)]);
  await sink.flush();

  assert.deepEqual(written.map((line) => JSON.parse(line).uuid), [row(1).uuid, row(3).uuid]);
  assert.equal((await ingestCount("lost")) - lostBefore, 1);
});

test("a batch never exceeds Append's 4 MiB NDJSON target", async () => {
  const batches: number[] = [];
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 500, flushIntervalMs: 60_000 }, appendClient(async (data: string) => {
    batches.push(Buffer.byteLength(data));
    return { num_rows_inserted: data.split("\n").length };
  }));
  const big = "x".repeat(1024 * 1024);
  sink.enqueue([0, 1, 2, 3, 4, 5].map((index) => ({ ...row(index), properties: { big } })));
  await sink.flush();

  assert.equal(batches.length, 2);
  assert.ok(batches.every((bytes) => bytes <= 4 * 1024 * 1024), String(batches));
});
