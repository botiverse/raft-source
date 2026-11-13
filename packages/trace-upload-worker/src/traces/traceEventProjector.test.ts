import assert from "node:assert/strict";
import { TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS } from "@botiverse/raft-shared";
import { fakeScopeDbTraceEventClient } from "../testing/fakeScopeDbTraceEventClient";
import { Client } from "scopedb";
import {
  projectTraceEventRows,
  ScopeDbTraceEventProjector,
  traceEventSchemaCheckSkipCounts,
  type ProjectableTraceRecord,
} from "./traceEventProjector";

const RECORD: ProjectableTraceRecord = {
  type: "span",
  schema_version: 1,
  trace_id: "0123456789abcdef0123456789abcdef",
  span_id: "0123456789abcdef",
  parent_span_id: "fedcba9876543210",
  name: "daemon.agent.delivery.routed",
  surface: "daemon",
  kind: "internal",
  status: "ok",
  start_time: "2026-07-14T08:00:00.000Z",
  end_time: "2026-07-14T08:00:00.012Z",
  attrs: {
    agentId: "agent-record",
    sessionId: "session-1",
    outcome: "stdin_written",
    raw_payload: "must-not-be-promoted",
  },
  events: [{
    name: "daemon.agent.stdin.written",
    time: "2026-07-14T08:00:00.010Z",
    attrs: {
      eventKind: "delivery",
      errorClass: "none",
      unexpected_secret: "must-not-be-promoted",
    },
  }],
};

test("projectTraceEventRows preserves exact identities and promotes only closed schema fields", () => {
  const rows = projectTraceEventRows([RECORD], {
    serviceName: "slock-daemon",
    deploymentEnvironment: "production",
    serviceVersion: "0.72.13",
    serviceRevision: "revision-1",
    serverId: "server-metadata",
    machineId: "machine-metadata",
    agentId: "agent-metadata",
  });

  assert.equal(rows.length, 2);
  const [event, spanFact] = rows;
  assert.equal(event.row_kind, "event");
  assert.equal(event.trace_id, RECORD.trace_id);
  assert.equal(event.span_id, RECORD.span_id);
  assert.equal(event.parent_span_id, RECORD.parent_span_id);
  assert.equal(event.event_index, 0);
  assert.equal(event.event_name, "daemon.agent.stdin.written");
  assert.equal(event.server_id, "server-metadata");
  assert.equal(event.machine_id, "machine-metadata");
  assert.equal(event.agent_id, "agent-record");
  assert.equal(event.session_id, "session-1");
  assert.equal(event.event_kind, "delivery");
  assert.equal(event.error_class, "none");
  assert.equal(event.service_instance_id, null);
  assert.equal("raw_payload" in event, false);
  assert.equal("unexpected_secret" in event, false);

  assert.equal(spanFact.row_kind, "span_fact");
  assert.equal(spanFact.event_index, null);
  assert.equal(spanFact.event_name, RECORD.name);
  assert.equal(spanFact.span_status, "ok");
  assert.equal(spanFact.span_start_time_ms, Date.parse(RECORD.start_time));
  assert.equal(spanFact.span_end_time_ms, Date.parse(RECORD.end_time));
});

test("projectTraceEventRows preserves neutral unset status but still rejects unknown statuses", () => {
  const [spanFact] = projectTraceEventRows([{
    ...RECORD,
    status: "unset",
    events: [],
  }], { serviceName: "slock-web" });

  assert.equal(spanFact.row_kind, "span_fact");
  assert.equal(spanFact.span_status, "unset");
  assert.throws(
    () => projectTraceEventRows([{ ...RECORD, status: "unknown" }], { serviceName: "slock-web" }),
    /Unsupported trace status: unknown/,
  );
});

test("ScopeDbTraceEventProjector requires a committed exact row count", async () => {
  let payload = "";
  let target = "";
  const client = fakeScopeDbTraceEventClient({
    append: (input, table) => {
      payload = input;
      target = table;
      return { num_rows_inserted: 1 };
    },
  });
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb.test",
    token: "test-token",
    client,
  });

  await assert.rejects(
    projector.project([RECORD], { serviceName: "slock-daemon" }),
    /ScopeDB inserted 1\/2 projected trace rows/,
  );
  assert.equal(target, "scopedb.raft.trace_events_v2");
  assert.equal(payload.split("\n").length, 2);
  assert.equal(JSON.parse(payload.split("\n")[0]).row_kind, "event");
  assert.equal(JSON.parse(payload.split("\n")[1]).row_kind, "span_fact");
});

test("ScopeDbTraceEventProjector appends strictly encoded projection columns only", async () => {
  let payload = "";
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-append-encoding.test",
    token: "test-token",
    client: fakeScopeDbTraceEventClient({
      append: (input) => {
        payload = input;
        return { num_rows_inserted: 2 };
      },
    }),
  });

  await projector.project([RECORD], { serviceName: "slock-daemon", deploymentEnvironment: "production" });
  const [event, spanFact] = payload.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const columns = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([column]) => column);
  assert.deepEqual(Object.keys(event!), columns);
  assert.deepEqual(Object.keys(spanFact!), columns);
  assert.equal(event!.event_time, "2026-07-14T08:00:00.010Z");
  assert.equal(event!.event_time_ms, Date.parse("2026-07-14T08:00:00.010Z"));
  assert.equal(event!.span_start_time_ms, Date.parse(RECORD.start_time));
  assert.equal(event!.span_end_time_ms, null);
  assert.equal(event!.event_index, 0);
  assert.equal(event!.session_id, "session-1");
  assert.equal(spanFact!.event_index, null);
  assert.equal(spanFact!.span_end_time_ms, Date.parse(RECORD.end_time));
  assert.equal(spanFact!.event_time, "2026-07-14T08:00:00.012Z");
  assert.equal(payload.includes("must-not-be-promoted"), false);
});

test("ScopeDbTraceEventProjector skips a record Append could not store instead of failing its siblings", async () => {
  let payload = "";
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-append-skip.test",
    token: "test-token",
    client: fakeScopeDbTraceEventClient({
      append: (input) => {
        payload = input;
        return { num_rows_inserted: input.split("\n").length };
      },
    }),
  });

  const result = await projector.project([
    // Past 2262-04-11: outside ScopeDB's signed 64-bit nanosecond timestamps.
    { ...RECORD, span_id: "1111111111111111", start_time: "2300-01-01T00:00:00.000Z", end_time: "2300-01-01T00:00:00.001Z", events: [] },
    { ...RECORD, span_id: "2222222222222222", attrs: { ...RECORD.attrs, replay_status: 1e300 }, events: [] },
    RECORD,
  ], { serviceName: "slock-daemon" });

  assert.deepEqual(result, {
    spansProjected: 1,
    rowsProjected: 2,
    spansSkipped: 2,
    skipReasonClasses: ["TraceProjectionRecordValidationError"],
  });
  assert.equal(payload.split("\n").length, 2);
});

test("ScopeDbTraceEventProjector splits large uploads into Append-sized requests", async () => {
  const requests: number[] = [];
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-append-chunks.test",
    token: "test-token",
    client: fakeScopeDbTraceEventClient({
      append: (input) => {
        requests.push(Buffer.byteLength(input));
        return { num_rows_inserted: input.split("\n").length };
      },
    }),
  });
  const longName = "x".repeat(512 * 1024);
  const records = Array.from({ length: 12 }, (_, index) => ({
    ...RECORD,
    span_id: (index + 1).toString(16).padStart(16, "0"),
    name: longName,
    events: [],
  }));

  const result = await projector.project(records, { serviceName: "slock-daemon" });
  assert.equal(result.rowsProjected, 12);
  assert.ok(requests.length >= 2, String(requests));
  assert.ok(requests.every((bytes) => bytes <= 4 * 1024 * 1024), String(requests));
});

test("ScopeDbTraceEventProjector accepts unordered live schema rows", async () => {
  let insertCalls = 0;
  const unorderedColumns = [
    ...TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(11),
    ...TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, 11),
  ];
  const client = fakeScopeDbTraceEventClient({
    columns: unorderedColumns,
    append: () => {
      insertCalls += 1;
      return { num_rows_inserted: 2 };
    },
  });
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-unordered-schema.test",
    token: "test-token",
    client,
  });

  assert.deepEqual(
    await projector.project([RECORD], { serviceName: "slock-daemon" }),
    { spansProjected: 1, rowsProjected: 2, spansSkipped: 0, skipReasonClasses: [] },
  );
  assert.equal(insertCalls, 1);
});

test("ScopeDbTraceEventProjector fails visibly before append when the live schema drifts", async () => {
  let insertCalls = 0;
  const client = fakeScopeDbTraceEventClient({
    columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, -1),
    append: () => {
      insertCalls += 1;
      return { num_rows_inserted: 2 };
    },
  });
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-schema-mismatch.test",
    token: "test-token",
    client,
  });

  await assert.rejects(
    projector.project([RECORD], { serviceName: "slock-daemon" }),
    (error: unknown) => error instanceof Error && error.name === "TraceEventRowV2SchemaMismatchError",
  );
  assert.equal(insertCalls, 0);
});

function sdkClientWith(appendResponses: Response[]) {
  let appends = 0;
  const client = new Client("https://scopedb.test", {
    apiKey: "test-token",
    fetch: async (_input, init) => {
      if (init?.method === undefined || init.method === "GET") {
        return new Response(JSON.stringify({
          name: "trace_events_v2",
          columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.map(([name, dataType]) => ({ name, data_type: dataType })),
        }), { status: 200, headers: { "content-type": "application/json", etag: '"1"' } });
      }
      appends += 1;
      const next = appendResponses.shift();
      if (!next) throw new Error("unexpected append");
      return next;
    },
  });
  return { client, appends: () => appends };
}

const committed = (rows: number) => new Response(JSON.stringify({ status: "committed", num_rows_inserted: rows }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("ScopeDbTraceEventProjector retries a plain-text 429 (real SDK) and honours Retry-After", async () => {
  const sleeps: number[] = [];
  const sdk = sdkClientWith([
    new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } }),
    committed(2),
  ]);
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-throttle-retry.test",
    token: "test-token",
    client: sdk.client,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(
    await projector.project([RECORD], { serviceName: "slock-daemon" }),
    { spansProjected: 1, rowsProjected: 2, spansSkipped: 0, skipReasonClasses: [] },
  );
  assert.equal(sdk.appends(), 2);
  assert.deepEqual(sleeps, [1_000]);
});

test("ScopeDbTraceEventProjector fails a persistently throttled upload with a retriable error class", async () => {
  const sdk = sdkClientWith([
    new Response("Too Many Requests", { status: 429 }),
    new Response("Service Unavailable", { status: 503 }),
    new Response("Too Many Requests", { status: 429 }),
  ]);
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-throttle-fail.test",
    token: "test-token",
    client: sdk.client,
    sleep: async () => {},
  });

  await assert.rejects(
    projector.project([RECORD], { serviceName: "slock-daemon" }),
    (error: unknown) => error instanceof Error && error.name === "TraceProjectionThrottledError"
      && /0 row\(s\) of this upload were already committed/.test(error.message),
  );
  assert.equal(sdk.appends(), 3);
});

test("ScopeDbTraceEventProjector does not retry a structured permanent rejection", async () => {
  const sdk = sdkClientWith([
    new Response(JSON.stringify({ message: "type mismatch", details: { status: "rejected", row_errors: [] } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  ]);
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb-permanent-reject.test",
    token: "test-token",
    client: sdk.client,
    sleep: async () => assert.fail("must not back off"),
  });

  await assert.rejects(
    projector.project([RECORD], { serviceName: "slock-daemon" }),
    (error: unknown) => error instanceof Error && error.name === "AppendRowsError",
  );
  assert.equal(sdk.appends(), 1);
});

function catalogSdkClient(catalogResponse: () => Response) {
  const methods: string[] = [];
  const client = new Client("https://scopedb.test", {
    apiKey: "write-only-key",
    fetch: async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET") return catalogResponse();
      return committed(2);
    },
  });
  return { client, methods };
}

test("ScopeDbTraceEventProjector appends without the schema check when the key cannot read the catalog (real SDK, 403)", async () => {
  const sdk = catalogSdkClient(() => new Response("Forbidden", { status: 403 }));
  const before = traceEventSchemaCheckSkipCounts().unauthorized;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const projector = new ScopeDbTraceEventProjector({ endpoint: "https://scopedb-catalog-403.test", token: "write-only-key", client: sdk.client });
    for (let upload = 0; upload < 2; upload += 1) {
      assert.deepEqual(
        await projector.project([RECORD], { serviceName: "slock-daemon" }),
        { spansProjected: 1, rowsProjected: 2, spansSkipped: 0, skipReasonClasses: [] },
      );
    }
    assert.deepEqual(sdk.methods, ["GET", "POST", "POST"], "the catalog is not re-read every upload");
    assert.equal(traceEventSchemaCheckSkipCounts().unauthorized - before, 1);
    const skipWarnings = warn.mock.calls.filter((call) => String(call[0]).includes("V2 live schema check skipped"));
    assert.equal(skipWarnings.length, 1);
    assert.deepEqual(skipWarnings[0]![1], { reason: "unauthorized", http_status: 403, recheck_s: 600 });
  } finally {
    warn.mockRestore();
  }
});

test("ScopeDbTraceEventProjector still blocks when the catalog is read and the schema mismatches (real SDK)", async () => {
  const sdk = catalogSdkClient(() => new Response(JSON.stringify({
    name: "trace_events_v2",
    columns: TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, -1).map(([name, dataType]) => ({ name, data_type: dataType })),
  }), { status: 200, headers: { "content-type": "application/json", etag: '"1"' } }));
  const projector = new ScopeDbTraceEventProjector({ endpoint: "https://scopedb-catalog-mismatch.test", token: "k", client: sdk.client });

  await assert.rejects(
    projector.project([RECORD], { serviceName: "slock-daemon" }),
    (error: unknown) => error instanceof Error && error.name === "TraceEventRowV2SchemaMismatchError",
  );
  assert.deepEqual(sdk.methods, ["GET"]);
});
