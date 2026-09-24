import assert from "node:assert/strict";
import test from "node:test";
import {
  TRACE_EVENT_ROW_V2_INGEST_STATEMENT,
  TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
} from "@botiverse/raft-shared";
import type { Client } from "scopedb";
import {
  projectTraceEventRows,
  ScopeDbTraceEventProjector,
  type ProjectableTraceRecord,
} from "./traceEventProjector.js";

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

function mockTable(
  columns: readonly (readonly [string, string])[] = TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS,
) {
  const table = {
    withSchema: () => table,
    tableSchema: async () => ({
      fields: () => columns.map(([name, dataType]) => ({
        name: () => name,
        dataType: () => dataType,
      })),
    }),
  };
  return table;
}

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
  let statement = "";
  const client = {
    table: () => mockTable(),
    insert: async (input: string, inputStatement: string) => {
      payload = input;
      statement = inputStatement;
      return { num_rows_inserted: 1 };
    },
  } as unknown as Pick<Client, "insert" | "table">;
  const projector = new ScopeDbTraceEventProjector({
    endpoint: "https://scopedb.test",
    token: "test-token",
    client,
  });

  await assert.rejects(
    projector.project([RECORD], { serviceName: "slock-daemon" }),
    /ScopeDB inserted 1\/2 projected trace rows/,
  );
  assert.equal(payload.split("\n").length, 2);
  assert.equal(JSON.parse(payload.split("\n")[0]).row_kind, "event");
  assert.equal(JSON.parse(payload.split("\n")[1]).row_kind, "span_fact");
  assert.equal(statement, TRACE_EVENT_ROW_V2_INGEST_STATEMENT);
});

test("ScopeDbTraceEventProjector accepts unordered live schema rows", async () => {
  let insertCalls = 0;
  const unorderedColumns = [
    ...TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(11),
    ...TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, 11),
  ];
  const client = {
    table: () => mockTable(unorderedColumns),
    insert: async () => {
      insertCalls += 1;
      return { num_rows_inserted: 2 };
    },
  } as unknown as Pick<Client, "insert" | "table">;
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

test("ScopeDbTraceEventProjector fails visibly before insert when the live schema drifts", async () => {
  let insertCalls = 0;
  const client = {
    table: () => mockTable(TRACE_EVENT_ROW_V2_PROJECTION_COLUMNS.slice(0, -1)),
    insert: async () => {
      insertCalls += 1;
      return { num_rows_inserted: 2 };
    },
  } as unknown as Pick<Client, "insert" | "table">;
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
