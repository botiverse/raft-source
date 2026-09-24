import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { sql } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, noopTracer, traceSpanFactRowForSpan } from "@botiverse/raft-shared";
import type pg from "pg";
import { pgPoolReadOnlyClientRecycledTotal } from "../metrics.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import {
  executeCancellablePgPoolSql,
  getSqlTraceHash,
  instrumentPool,
  isReadOnlyTransactionError,
  setDbTracer,
  withDbTraceAttributes,
} from "./index.js";

const realDateNow = Date.now;
const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

afterEach(() => {
  Date.now = realDateNow;
  setDbTracer(noopTracer);
});

test("getSqlTraceHash shares the pool instrumentation's parameter-insensitive SQL identity", () => {
  const first = getSqlTraceHash(sql`SELECT * FROM messages WHERE channel_id = ${"channel-a"} AND seq > ${10}`);
  const second = getSqlTraceHash(sql`SELECT * FROM messages WHERE channel_id = ${"channel-b"} AND seq > ${20}`);
  const differentShape = getSqlTraceHash(sql`SELECT id FROM messages WHERE channel_id = ${"channel-a"}`);

  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, second);
  assert.notEqual(first, differentShape);
});

test("getSqlTraceHash includes normalized SQL beyond the displayed fingerprint prefix", () => {
  const sharedPrefix = `SELECT ${"prefix_column, ".repeat(30)}`;
  const first = getSqlTraceHash(sql.raw(`${sharedPrefix} first_suffix FROM messages`));
  const second = getSqlTraceHash(sql.raw(`${sharedPrefix} second_suffix FROM messages`));

  assert.notEqual(first, second, "SQL shapes that diverge after byte 240 must have distinct exact hashes");
});

class FakeClient {
  readonly queries: unknown[][] = [];
  readonly releaseArgs: unknown[][] = [];
  beforeQueryReturn?: () => void;
  queryError?: unknown;

  async query(...args: unknown[]) {
    const callback = args[args.length - 1];
    const queryArgs = typeof callback === "function" ? args.slice(0, -1) : args;
    this.queries.push(queryArgs);
    const result = { rows: [] };
    this.beforeQueryReturn?.();
    if (this.queryError) {
      if (typeof callback === "function") {
        callback(this.queryError);
        return;
      }
      throw this.queryError;
    }
    if (typeof callback === "function") {
      callback(undefined, result);
      return;
    }
    return result;
  }

  release(...args: unknown[]) {
    this.releaseArgs.push(args);
  }
}

class FakePool {
  totalCount = 1;
  idleCount = 0;
  waitingCount = 0;
  connectError?: Error;

  constructor(private readonly client: FakeClient) {}

  connect(callback?: (err: Error | undefined, client: pg.PoolClient, release: (err?: Error | boolean) => void) => void) {
    if (this.connectError) {
      if (callback) {
        callback(this.connectError, undefined as unknown as pg.PoolClient, () => {});
        return;
      }
      return Promise.reject(this.connectError);
    }
    if (callback) {
      callback(undefined, this.client as unknown as pg.PoolClient, this.client.release.bind(this.client));
      return;
    }
    return Promise.resolve(this.client as unknown as pg.PoolClient);
  }
}

class CancellableFakeClient {
  readonly processID = 1234;
  readonly secretKey = 5678;
  readonly releaseArgs: unknown[][] = [];
  submittedQuery?: { callback?: (err: Error | undefined, result?: pg.QueryResult) => void };

  query(query: unknown) {
    this.submittedQuery = query as { callback?: (err: Error | undefined, result?: pg.QueryResult) => void };
    return query;
  }

  release(...args: unknown[]) {
    this.releaseArgs.push(args);
  }

  resolve(rows: pg.QueryResult["rows"] = []) {
    this.submittedQuery?.callback?.(undefined, {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    });
  }

  reject(error: Error) {
    this.submittedQuery?.callback?.(error);
  }
}

class CancellableFakePool {
  readonly options = {};

  constructor(readonly client: CancellableFakeClient) {}

  async connect() {
    return this.client as unknown as pg.PoolClient;
  }
}

async function withCapturedWarnings(work: () => Promise<void>): Promise<string[]> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    await work();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

async function readOnlyRecycleCounterValue(pool: string): Promise<number> {
  const json = await pgPoolReadOnlyClientRecycledTotal.get();
  const match = json.values.find((value) => value.labels.pool === pool);
  return match?.value ?? 0;
}

function readOnlyError(): Error & { code: string } {
  return Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
    code: "25006",
  });
}

async function waitForSubmittedQuery(client: CancellableFakeClient): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (client.submittedQuery) return;
    await Promise.resolve();
  }
  throw new Error("query was not submitted");
}

test("instrumentPool records one span per checkout with raw query and fingerprint fields", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  instrumentPool("primary", pool);

  now = 10;
  const first = await pool.connect();
  now = 30;
  await first.query("SELECT * FROM users WHERE email = 'secret@example.com'");
  now = 150;
  const releaseError = new Error("discard connection");
  first.release(releaseError);

  now = 200;
  const second = await pool.connect();
  now = 230;
  await second.query({ text: "UPDATE users SET token = 'secret' WHERE id = $1" });
  now = 360;
  second.release();

  now = 400;
  const third = await pool.connect();
  now = 430;
  await third.query("SELECT * FROM users WHERE email = 'other@example.com'");
  now = 540;
  third.release();

  assert.deepEqual(client.releaseArgs, [[releaseError], [], []]);
  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map((span) => span.attrs?.pool), ["primary", "primary", "primary"]);
  assert.deepEqual(spans.map((span) => span.attrs?.statement_kind), ["select", "update", "select"]);
  assert.deepEqual(spans.map((span) => span.attrs?.discarded), [true, false, false]);
  assert.deepEqual(spans.map((span) => span.attrs?.pool_occupancy_ms), spans.map((span) => span.attrs?.hold_ms));
  for (const span of spans) {
    assert.equal(typeof span.attrs?.query, "string");
    assert.equal(span.attrs?.db_operation, "unknown");
    assert.equal(typeof span.attrs?.query_hash, "string");
    assert.equal(typeof span.attrs?.query_exact_hash, "string");
    assert.equal(typeof span.attrs?.query_fingerprint, "string");
    assert.equal(String(span.attrs?.query_fingerprint).includes("secret@example.com"), false);
    assert.equal(String(span.attrs?.query_fingerprint).includes("other@example.com"), false);
    assert.equal(String(span.attrs?.query_fingerprint).includes("secret"), false);
  }
  assert.equal(spans[0].attrs?.query, "SELECT * FROM users WHERE email = 'secret@example.com'");
  assert.equal(spans[1].attrs?.query, "UPDATE users SET token = 'secret' WHERE id = $1");
  assert.equal(spans[0].attrs?.query_fingerprint, "SELECT * FROM users WHERE email = ?");
  assert.equal(spans[0].attrs?.query_hash, spans[2].attrs?.query_hash);
  assert.equal(spans[0].attrs?.query_exact_hash, spans[2].attrs?.query_exact_hash);
  assert.notEqual(spans[0].attrs?.query_hash, spans[1].attrs?.query_hash);
  assert.notEqual(spans[0].attrs?.query_exact_hash, spans[1].attrs?.query_exact_hash);
  assert.equal(spans[0].attrs?.event_kind, "db_connection");
  assert.equal(spans[0].attrs?.outcome, "discarded");
  assert.equal(spans[0].attrs?.reason, "release_discarded");
  assert.equal(spans[1].attrs?.outcome, "released");
  assert.equal(spans[1].attrs?.reason, "release_completed");

  const discardedRow = traceSpanFactRowForSpan(spans[0], TRACE_EVENT_ROW_TEST_RESOURCE);
  assert.equal(discardedRow.row_kind, "span_fact");
  assert.equal(discardedRow.event_name, "server.db.connection");
  assert.equal(discardedRow.event_kind, "db_connection");
  assert.equal(discardedRow.outcome, "discarded");
  assert.equal(discardedRow.reason, "release_discarded");
});

test("instrumentPool preserves callback connect release semantics and labels read-replica pools", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("search", pool);

  await new Promise<void>((resolve, reject) => {
    now = 5;
    pool.connect(async (err, checkedOutClient, release) => {
      try {
        assert.equal(err, undefined);
        assert.ok(checkedOutClient);
        now = 25;
        await checkedOutClient.query("DELETE FROM search_documents WHERE id = $1");
        now = 130;
        release(true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  assert.deepEqual(client.releaseArgs, [[true]]);
  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attrs?.pool, "search");
  assert.equal(spans[0].attrs?.statement_kind, "delete");
  assert.equal(spans[0].attrs?.pool_occupancy_ms, spans[0].attrs?.hold_ms);
  assert.equal(spans[0].attrs?.query, "DELETE FROM search_documents WHERE id = $1");
  assert.equal(spans[0].attrs?.query_fingerprint, "DELETE FROM search_documents WHERE id = ?");
  assert.equal(spans[0].attrs?.discarded, true);
});

test("instrumentPool traces pool.query through the same checkout path used by drizzle", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  client.beforeQueryReturn = () => {
    now = 220;
  };

  now = 10;
  await withDbTraceAttributes(
    { db_callsite: "agent_orchestrator.cache_miss" },
    () => pool.query("SELECT pg_sleep(0.2), * FROM users WHERE id = $1", ["user-1"]),
  );

  assert.deepEqual(client.releaseArgs, [[]]);
  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attrs?.pool, "primary");
  assert.equal(spans[0].attrs?.statement_kind, "select");
  assert.equal(spans[0].attrs?.pool_occupancy_ms, 210);
  assert.equal(spans[0].attrs?.query, "SELECT pg_sleep(0.2), * FROM users WHERE id = $1");
  assert.equal(spans[0].attrs?.query_fingerprint, "SELECT pg_sleep(?), * FROM users WHERE id = ?");
  assert.equal(spans[0].attrs?.db_callsite, "agent_orchestrator.cache_miss");
  assert.equal(spans[0].attrs?.discarded, false);
});

test("isReadOnlyTransactionError recognizes SQLSTATE 25006 and read-only transaction text", () => {
  assert.equal(isReadOnlyTransactionError({ code: "25006", message: "anything" }), true);
  assert.equal(isReadOnlyTransactionError({ message: "cannot execute UPDATE in a read-only transaction" }), true);
  assert.equal(isReadOnlyTransactionError({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isReadOnlyTransactionError(null), false);
});

test("instrumentPool destroys checked-out clients that hit read-only transaction errors", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  client.queryError = readOnlyError();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  const before = await readOnlyRecycleCounterValue("primary");

  await withCapturedWarnings(async () => {
    now = 10;
    const checkedOut = await pool.connect();
    now = 30;
    await assert.rejects(() => checkedOut.query("update daemons set last_heartbeat = now()"));
    now = 150;
    checkedOut.release();
  });

  const after = await readOnlyRecycleCounterValue("primary");
  assert.equal(after - before, 1);
  assert.deepEqual(client.releaseArgs, [[client.queryError]]);
  const connectionSpan = sink.getAllSpans().find((span) => span.name === "server.db.connection");
  assert.equal(connectionSpan?.attrs?.discarded, true);
  assert.equal(connectionSpan?.attrs?.reason, "release_discarded");
  const recycleSpan = sink.getAllSpans().find((span) => span.name === "server.db.pool.read_only_client_recycled");
  assert.equal(recycleSpan?.attrs?.pool, "primary");
  assert.equal(recycleSpan?.attrs?.sqlstate, "25006");
  assert.equal(recycleSpan?.attrs?.outcome, "client_discarded");
  assert.equal(recycleSpan?.attrs?.reason, "read_only_transaction");
});

test("instrumentPool destroys pool.query read-only clients and throttles structured logs", async () => {
  let now = 10_000;
  Date.now = () => now;
  const client = new FakeClient();
  client.queryError = readOnlyError();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("pool-query-read-only", pool);
  const before = await readOnlyRecycleCounterValue("pool-query-read-only");

  const warnings = await withCapturedWarnings(async () => {
    await assert.rejects(() => pool.query("update reminders set fired_at = now()"));
    await assert.rejects(() => pool.query("update reminders set fired_at = now()"));
  });

  const after = await readOnlyRecycleCounterValue("pool-query-read-only");
  assert.equal(after - before, 2);
  assert.deepEqual(client.releaseArgs, [[client.queryError], [client.queryError]]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0]), {
    event: "db.pg_pool.read_only_client_recycled",
    pool_label: "pool-query-read-only",
    sqlstate: "25006",
    action: "destroy_client_on_release",
    suppressed_logs: 0,
  });
});

test("instrumentPool does not force-destroy checked-out clients for non-read-only errors", async () => {
  const client = new FakeClient();
  client.queryError = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);

  const checkedOut = await pool.connect();
  await assert.rejects(() => checkedOut.query("insert into users"));
  checkedOut.release();

  assert.deepEqual(client.releaseArgs, [[]]);
});

test("instrumentPool records checkout failures with query identity and db callsite", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  (pool as unknown as FakePool).connectError = new Error("timeout exceeded when trying to connect");

  now = 10;
  await assert.rejects(
    withDbTraceAttributes(
      { db_callsite: "agent_orchestrator.delivery" },
      () => pool.query("SELECT * FROM agents WHERE id = $1", ["agent-1"]),
    ),
    /timeout exceeded/,
  );

  assert.deepEqual(client.releaseArgs, []);
  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, "error");
  assert.equal(spans[0].attrs?.pool, "primary");
  assert.equal(spans[0].attrs?.checkout_failed, true);
  assert.equal(spans[0].attrs?.checkout_error_class, "Error");
  assert.equal(spans[0].attrs?.statement_kind, "select");
  assert.equal(spans[0].attrs?.query, "SELECT * FROM agents WHERE id = $1");
  assert.equal(spans[0].attrs?.query_fingerprint, "SELECT * FROM agents WHERE id = ?");
  assert.equal(spans[0].attrs?.db_callsite, "agent_orchestrator.delivery");
  assert.equal(spans[0].attrs?.discarded, true);
  assert.equal(spans[0].attrs?.event_kind, "db_connection");
  assert.equal(spans[0].attrs?.outcome, "checkout_failed");
  assert.equal(spans[0].attrs?.reason, "pool_connect_failed");
  const failureRow = traceSpanFactRowForSpan(spans[0], TRACE_EVENT_ROW_TEST_RESOURCE);
  assert.equal(failureRow.event_kind, "db_connection");
  assert.equal(failureRow.outcome, "checkout_failed");
  assert.equal(failureRow.reason, "pool_connect_failed");
});

test("withDbTraceAttributes preserves context through an awaited query inside the callback", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  client.beforeQueryReturn = () => {
    now = 180;
  };

  now = 20;
  await withDbTraceAttributes(
    { db_callsite: "agent_service.get_agent.unspecified" },
    async () => {
      await pool.query("SELECT * FROM agents WHERE id = $1", ["agent-1"]);
    },
  );

  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attrs?.db_callsite, "agent_service.get_agent.unspecified");
  assert.equal(spans[0].attrs?.query_fingerprint, "SELECT * FROM agents WHERE id = ?");
});

test("instrumentPool links db connection spans to the active trace parent", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    clock: () => now,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  setDbTracer(tracer);

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  client.beforeQueryReturn = () => {
    now = 160;
  };

  const root = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });
  now = 10;
  await runWithTraceSpan(root, async () => {
    await pool.query("SELECT * FROM agents WHERE id = $1", ["agent-1"]);
  });
  now = 170;
  root.end();

  const dbSpan = sink.getAllSpans().find((span) => span.name === "server.db.connection");
  assert.ok(dbSpan);
  assert.equal(dbSpan.context.traceId, root.context.traceId);
  assert.equal(dbSpan.context.parentSpanId, root.context.spanId);
});

test("executeCancellablePgPoolSql cancels the exact active search query and discards the client", async () => {
  const client = new CancellableFakeClient();
  const pool = new CancellableFakePool(client) as unknown as pg.Pool;
  const abort = new AbortController();
  const cancelCalls: Array<{
    client: pg.PoolClient;
    query: unknown;
    backendPid: number | null;
  }> = [];

  const queryPromise = executeCancellablePgPoolSql(pool, sql`SELECT ${"needle"}::text AS value`, {
    signal: abort.signal,
    cancelQuery: (context) => {
      cancelCalls.push(context);
    },
  });

  await waitForSubmittedQuery(client);
  abort.abort();

  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0].client, client as unknown as pg.PoolClient);
  assert.equal(cancelCalls[0].query, client.submittedQuery);
  assert.equal(cancelCalls[0].backendPid, client.processID);

  const pgCancelError = Object.assign(new Error("canceling statement due to user request"), {
    code: "57014",
  });
  client.reject(pgCancelError);

  await assert.rejects(queryPromise, (error) => {
    assert.equal((error as Error).name, "SearchQueryAbortedError");
    assert.equal((error as { code?: string }).code, "SEARCH_QUERY_ABORTED");
    return true;
  });
  assert.equal(client.releaseArgs.length, 1);
  assert.equal((client.releaseArgs[0][0] as Error).name, "SearchQueryAbortedError");
});

test("executeCancellablePgPoolSql ignores aborts after the search query has completed", async () => {
  const client = new CancellableFakeClient();
  const pool = new CancellableFakePool(client) as unknown as pg.Pool;
  const abort = new AbortController();
  const cancelCalls: unknown[] = [];

  const queryPromise = executeCancellablePgPoolSql<{ value: string }>(
    pool,
    sql`SELECT ${"done"}::text AS value`,
    {
      signal: abort.signal,
      cancelQuery: (context) => {
        cancelCalls.push(context);
      },
    },
  );

  await waitForSubmittedQuery(client);
  client.resolve([{ value: "done" }]);

  assert.deepEqual((await queryPromise).rows, [{ value: "done" }]);
  abort.abort();
  await Promise.resolve();

  assert.deepEqual(cancelCalls, []);
  assert.deepEqual(client.releaseArgs, [[]]);
});
