import assert from "node:assert/strict";
import { noopTracer, TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS } from "@botiverse/raft-shared";
import {
  createServerTracerFromEnv,
  resetIgnoredIngestStatementWarningForTest,
  SCOPEDB_SCHEMA_CHECK_SKIPPED_EVENT,
} from "./serverTracer";
import type { TraceExportSummaryRow } from "./traceExportSummary";
import { setPrivacyModeForTest } from "../config/privacyMode";

test("createServerTracerFromEnv defaults to noop when OTLP endpoint is unset", () => {
  const runtime = createServerTracerFromEnv({});

  assert.equal(runtime.tracer, noopTracer);
});

test("createServerTracerFromEnv creates a recording tracer when OTLP endpoint is set", async () => {
  const runtime = createServerTracerFromEnv({
    SLOCK_TRACE_OTLP_ENDPOINT: "http://collector:4318",
    SLOCK_TRACE_SERVICE_NAME: "slock-server-test",
    DEPLOYMENT_ENV: "test",
  });

  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("RAFT_PRIVACY_MODE: createServerTracerFromEnv is noop even with OTLP and ScopeDB configured", async () => {
  const env = {
    SLOCK_TRACE_OTLP_ENDPOINT: "http://collector:4318",
    RAFT_TRACE_SCOPEDB_SINK: "on",
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
  };
  setPrivacyModeForTest(true);
  try {
    assert.equal(createServerTracerFromEnv(env).tracer, noopTracer);
  } finally {
    setPrivacyModeForTest(false);
  }
  // Off: unchanged.
  const runtime = createServerTracerFromEnv(env);
  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("createServerTracerFromEnv enables event rows independently from OTLP", async () => {
  const runtime = createServerTracerFromEnv({
    RAFT_TRACE_SCOPEDB_SINK: "on",
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
    SLOCK_TRACE_SERVICE_NAME: "slock-server-test",
    DEPLOYMENT_ENV: "test",
  });

  assert.notEqual(runtime.tracer, noopTracer);
  await runtime.shutdown();
});

test("createServerTracerFromEnv ignores a retired SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT pin instead of disabling the sink", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  resetIgnoredIngestStatementWarningForTest();
  try {
    for (const statement of ["SELECT $0[\"row_kind\"]::string AS row_kind INSERT INTO raft.trace_events_v2 (row_kind)", "not a statement"]) {
      const runtime = createServerTracerFromEnv({
        RAFT_TRACE_SCOPEDB_SINK: "on",
        SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
        SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
        SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT: statement,
      });

      assert.notEqual(runtime.tracer, noopTracer);
      await runtime.shutdown();
    }
    // Exactly once per process, not once per tracer.
    assert.equal(warnings.filter((args) => /INGEST_STATEMENT is ignored/.test(String(args[0]))).length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("createServerTracerFromEnv keeps configured event rows off without the explicit rollout flag", () => {
  const runtime = createServerTracerFromEnv({
    SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
    SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
  });

  assert.equal(runtime.tracer, noopTracer);
});

test("createServerTracerFromEnv fails closed for an invalid ScopeDB rollout flag", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const runtime = createServerTracerFromEnv({
      RAFT_TRACE_SCOPEDB_SINK: "enabled",
      SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
      SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
    });

    assert.equal(runtime.tracer, noopTracer);
    assert.match(String(warnings[0]?.[0]), /must be 'on' or 'off'/);
  } finally {
    console.warn = originalWarn;
  }
});

const EXPORT_SUMMARY_ENV = {
  SLOCK_TRACE_OTLP_ENDPOINT: "http://collector:4318",
  RAFT_TRACE_SCOPEDB_SINK: "on",
  SCOPEDB_TRACE_EVENTS_ENDPOINT: "https://scopedb.example",
  SCOPEDB_TRACE_EVENTS_WRITE_KEY: "test-token",
  DEPLOYMENT_ENV: "test",
};

// Keeps the event-row sink from reaching the network: its schema check fails
// and the row is dropped fail-aside.
const OFFLINE_TRACE_EVENT_CLIENT = {
  table: () => ({
    catalog: () => ({ get: async () => { throw new Error("offline"); } }),
    appendStream: () => { throw new Error("offline"); },
  }),
} as unknown as NonNullable<Parameters<typeof createServerTracerFromEnv>[2]>["traceEventSinkClient"];

test("the OTLP exporter's failures reach raft.trace_export_summary directly, not through OTLP", async () => {
  const posted: string[] = [];
  const written: TraceExportSummaryRow[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const runtime = createServerTracerFromEnv(EXPORT_SUMMARY_ENV, undefined, {
      otlpFetch: async (input) => {
        posted.push(String(input));
        return { ok: false, status: 429, text: async () => "" };
      },
      traceExportSummaryWriter: { write: async (rows) => { written.push(...rows); } },
      traceEventSinkClient: OFFLINE_TRACE_EVENT_CLIENT,
    });
    runtime.tracer.startSpan("server.test", { surface: "server" }).end();
    await runtime.shutdown();
  } finally {
    console.warn = warn;
  }

  // The offline catalog makes the event sink skip its schema check at shutdown,
  // which posts one server.scopedb.schema_check_skipped log event over OTLP.
  assert.deepEqual(posted, ["http://collector:4318/v1/traces", "http://collector:4318/v1/logs"], "the summary never goes to the collector");
  assert.deepEqual(
    written.map((row) => [row.signal, row.http_429_batches, row.dropped_export_failed]),
    [["traces", 1, 1], ["logs", 1, 1]],
  );
  assert.equal(written[0]!.deployment_environment, "test");
});

test("RAFT_TRACE_EXPORT_SUMMARY=off and the ScopeDB kill switch each keep the summary off", async () => {
  for (const env of [
    { ...EXPORT_SUMMARY_ENV, RAFT_TRACE_EXPORT_SUMMARY: "off" },
    { ...EXPORT_SUMMARY_ENV, RAFT_TRACE_SCOPEDB_SINK: "off" },
  ]) {
    const written: TraceExportSummaryRow[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const runtime = createServerTracerFromEnv(env, undefined, {
        otlpFetch: async () => ({ ok: true, status: 200, text: async () => "" }),
        traceExportSummaryWriter: { write: async (rows) => { written.push(...rows); } },
        traceEventSinkClient: OFFLINE_TRACE_EVENT_CLIENT,
      });
      runtime.tracer.startSpan("server.test", { surface: "server" }).end();
      await runtime.shutdown();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(written, []);
  }
});

type TraceEventSinkClient = NonNullable<Parameters<typeof createServerTracerFromEnv>[2]>["traceEventSinkClient"];

/** Appends succeed; the catalog read is `catalogGet`. Counts catalog reads and appended rows. */
function fakeTraceEventSinkClient(catalogGet: () => Promise<unknown>) {
  const counts = { catalogReads: 0, rowsSent: 0 };
  const stream = {
    send: async () => { counts.rowsSent += 1; },
    flush: async () => {},
    shutdown: async () => {},
  };
  const builder: Record<string, unknown> = {};
  for (const method of ["flushIntervalMs", "channelCapacity", "maxConcurrentBatches", "attemptTimeoutMs", "maxRetries", "maxElapsedTimeMs"]) {
    builder[method] = () => builder;
  }
  builder.build = () => stream;
  const client = {
    table: () => ({
      catalog: () => ({ get: () => { counts.catalogReads += 1; return catalogGet(); } }),
      appendStream: () => builder,
    }),
  } as unknown as TraceEventSinkClient;
  return { client, counts };
}

/** Two trace event rows, flushed one batch each, then shutdown; returns the standalone log events posted to /v1/logs. */
async function schemaCheckSkipLogEvents(client: TraceEventSinkClient) {
  const logRecords: Array<{ eventName: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const runtime = createServerTracerFromEnv({ ...EXPORT_SUMMARY_ENV, RAFT_TRACE_EXPORT_SUMMARY: "off", SCOPEDB_TRACE_EVENTS_BATCH_SIZE: "1" }, undefined, {
      otlpFetch: async (input, init) => {
        if (String(input).endsWith("/v1/logs")) {
          const payload = JSON.parse(String(init?.body)) as {
            resourceLogs: Array<{ scopeLogs: Array<{ logRecords: typeof logRecords }> }>;
          };
          for (const resource of payload.resourceLogs) {
            for (const scope of resource.scopeLogs) logRecords.push(...scope.logRecords);
          }
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      traceEventSinkClient: client,
    });
    const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    const span = runtime.tracer.startSpan("server.test", { surface: "server" });
    span.addEvent("first");
    await settle();
    span.addEvent("second");
    await settle();
    await runtime.shutdown();
  } finally {
    console.warn = warn;
  }
  return logRecords
    .filter((record) => record.eventName === SCOPEDB_SCHEMA_CHECK_SKIPPED_EVENT)
    .map((record) => Object.fromEntries(record.attributes.map(({ key, value }) => [key, Object.values(value)[0]])));
}

test("a skipped ScopeDB schema check is one server.scopedb.schema_check_skipped log event per skip window", async () => {
  const fake = fakeTraceEventSinkClient(async () => { throw Object.assign(new Error("Forbidden"), { httpStatus: 403 }); });
  const events = await schemaCheckSkipLogEvents(fake.client);

  assert.equal(fake.counts.catalogReads, 1, "the second batch is inside the skip window");
  assert.ok(fake.counts.rowsSent >= 2, "rows are still written");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, "unauthorized");
  assert.equal(Number(events[0]!.http_status), 403);
  assert.equal(Number(events[0]!.recheck_s), 600);
  assert.equal(events[0]!.table, "raft.trace_events_v2");
  assert.equal(events[0]!["slock.surface"], "server");
});

test("a catalog failure without an HTTP status omits http_status", async () => {
  const fake = fakeTraceEventSinkClient(async () => { throw new Error("offline"); });
  const events = await schemaCheckSkipLogEvents(fake.client);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, "catalog_error");
  assert.equal("http_status" in events[0]!, false);
  assert.equal(Number(events[0]!.recheck_s), 60);
});

test("a schema check first skipped in the shutdown flush still exports its log event", async () => {
  const fake = fakeTraceEventSinkClient(async () => { throw Object.assign(new Error("Forbidden"), { httpStatus: 403 }); });
  const logEvents: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    // Batch size above one row: nothing flushes until shutdown, so the first
    // catalog read (and the skip) happens inside runtime.shutdown().
    const runtime = createServerTracerFromEnv({ ...EXPORT_SUMMARY_ENV, RAFT_TRACE_EXPORT_SUMMARY: "off", SCOPEDB_TRACE_EVENTS_BATCH_SIZE: "100" }, undefined, {
      otlpFetch: async (input, init) => {
        if (String(input).endsWith("/v1/logs")) {
          const payload = JSON.parse(String(init?.body)) as {
            resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ eventName: string }> }> }>;
          };
          for (const resource of payload.resourceLogs) {
            for (const scope of resource.scopeLogs) logEvents.push(...scope.logRecords.map((record) => record.eventName));
          }
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      traceEventSinkClient: fake.client,
    });
    runtime.tracer.startSpan("server.test", { surface: "server" }).addEvent("only");
    assert.equal(fake.counts.catalogReads, 0, "no flush before shutdown");
    await runtime.shutdown();
  } finally {
    console.warn = warn;
  }

  assert.equal(fake.counts.catalogReads, 1);
  assert.equal(logEvents.filter((name) => name === SCOPEDB_SCHEMA_CHECK_SKIPPED_EVENT).length, 1);
});

test("shutdown exports OTLP spans before a stalled ScopeDB drain finishes", async () => {
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const stream = { send: async () => {}, flush: () => appendGate, shutdown: async () => {} };
  const builder: Record<string, unknown> = {};
  for (const method of ["flushIntervalMs", "channelCapacity", "maxConcurrentBatches", "attemptTimeoutMs", "maxRetries", "maxElapsedTimeMs"]) {
    builder[method] = () => builder;
  }
  builder.build = () => stream;
  const client = {
    table: () => ({
      catalog: () => ({
        get: async () => ({
          definition: { columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType })) },
        }),
      }),
      appendStream: () => builder,
    }),
  } as unknown as TraceEventSinkClient;
  const posted: string[] = [];
  let tracesPosted!: () => void;
  const tracesPostedSignal = new Promise<void>((resolve) => { tracesPosted = resolve; });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const runtime = createServerTracerFromEnv({ ...EXPORT_SUMMARY_ENV, RAFT_TRACE_EXPORT_SUMMARY: "off", SCOPEDB_TRACE_EVENTS_BATCH_SIZE: "100", SLOCK_TRACE_FLUSH_INTERVAL_MS: "600000" }, undefined, {
      otlpFetch: async (input) => {
        posted.push(String(input));
        if (String(input).endsWith("/v1/traces")) tracesPosted();
        return { ok: true, status: 200, text: async () => "" };
      },
      traceEventSinkClient: client,
    });
    const span = runtime.tracer.startSpan("server.test", { surface: "server" });
    span.addEvent("queued-for-scopedb");
    span.end();
    const shutdown = runtime.shutdown();
    // The ScopeDB append is stalled; the span must already have gone over OTLP.
    // Fail fast (the server suite has no test timeout) instead of hanging.
    await Promise.race([
      tracesPostedSignal,
      new Promise((_, reject) => setTimeout(() => reject(new Error("OTLP spans waited on the stalled ScopeDB drain")), 2_000)),
    ]);
    assert.ok(posted.includes("http://collector:4318/v1/traces"));
    releaseAppend();
    await shutdown;
  } finally {
    releaseAppend();
    console.warn = warn;
  }
});

test("a schema check that reads a matching catalog emits no schema_check_skipped event", async () => {
  const fake = fakeTraceEventSinkClient(async () => ({
    definition: { columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType })) },
  }));
  const events = await schemaCheckSkipLogEvents(fake.client);

  assert.ok(fake.counts.rowsSent >= 2);
  assert.deepEqual(events, []);
});
