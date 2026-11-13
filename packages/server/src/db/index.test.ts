import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, noopTracer, traceSpanFactRowForSpan } from "@botiverse/raft-shared";
import type pg from "pg";
import { dbQueryDuration, dbQueryErrorsTotal, pgPoolReadOnlyClientRecycledTotal } from "../metrics";
import { traceQuerySpan } from "../tracing/queryTrace";
import { runWithTraceSpan, setDefaultTraceTracer } from "../tracing/semanticTrace";
import {
  executeCancellablePgPoolSql,
  executeSearchSqlWithPrimaryFallback,
  getSqlTraceHash,
  instrumentPool,
  isReadOnlyTransactionError,
  searchReplicaFallbackReason,
  setDbTracer,
  withDbTraceAttributes,
} from "./index";
import { withLockOrderRecording } from "./lockOrderRecorder";
import { withStatementStats } from "./statementStats";

const realDateNow = Date.now;
const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

afterEach(() => {
  Date.now = realDateNow;
  setDbTracer(noopTracer);
  setDefaultTraceTracer(null);
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

test("connection spans say whether the client was reused and how long the first statement's round trip took", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);

  // First checkout of a new client: the 40ms checkout includes opening it.
  now = 0;
  const pending = pool.connect();
  now = 40;
  const first = await pending;
  // The first statement's result comes back 150ms after it is sent; a second
  // statement does not change first_query_ms.
  client.beforeQueryReturn = () => { now += 150; };
  await first.query("SELECT id, retired_at FROM users WHERE id = $1");
  client.beforeQueryReturn = () => { now += 5; };
  await first.query("SELECT 1");
  first.release();

  // The same client checked out again is a reused connection.
  now = 500;
  const second = await pool.connect();
  client.beforeQueryReturn = () => { now += 120; };
  await second.query("SELECT email_verified FROM users WHERE id = $1");
  second.release();

  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.attrs?.connection_reused, false);
  assert.equal(spans[0]!.attrs?.connect_ms, spans[0]!.attrs?.queue_ms);
  assert.equal(spans[0]!.attrs?.first_query_ms, 150);
  assert.equal(spans[1]!.attrs?.connection_reused, true);
  assert.equal(spans[1]!.attrs?.connect_ms, undefined, "no connect time for a reused client");
  assert.equal(spans[1]!.attrs?.first_query_ms, 120);
});

test("every new connection is recorded; reused ones only past 100 ms, and record_condition says which rule applied", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);

  // A new connection held only 20 ms is still recorded (complete new-connection counts).
  const first = await pool.connect();
  client.beforeQueryReturn = () => { now += 20; };
  await first.query("SELECT 1");
  first.release();
  // A reused connection held 20 ms is not recorded.
  now = 1_000;
  const second = await pool.connect();
  await second.query("SELECT 1");
  second.release();
  // A reused connection held 150 ms is.
  now = 2_000;
  const third = await pool.connect();
  client.beforeQueryReturn = () => { now += 150; };
  await third.query("SELECT 1");
  third.release();

  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.deepEqual(
    spans.map((span) => [span.attrs?.connection_reused, span.attrs?.record_condition]),
    [[false, "new_connection"], [true, "hold_over_100ms"]],
  );
});

/**
 * A FakeClient whose query goes through a socket the way pg's does: the
 * statement is written (the write callback fires once flushed), then reply
 * bytes arrive as a "data" event, then the result resolves.
 */
class SocketFakeClient extends FakeClient {
  readonly connection: { stream: { write: (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean; on: (event: string, listener: () => void) => void } };
  private readonly dataListeners: Array<() => void> = [];
  writeFlushAfterMs = 0;
  firstByteAfterMs = 0;
  resultAfterMs = 0;

  constructor(private readonly clock: { now: number }) {
    super();
    const flushes: Array<() => void> = [];
    this.connection = {
      stream: {
        write: (_chunk, encoding, callback) => {
          const done = typeof encoding === "function" ? encoding : callback;
          if (typeof done === "function") flushes.push(done as () => void);
          return true;
        },
        on: (event, listener) => {
          if (event === "data") this.dataListeners.push(listener);
        },
      },
    };
    this.beforeQueryReturn = () => {
      // pg writes parse/bind/execute/sync separately; the last flush counts.
      this.connection.stream.write("parse", undefined, undefined);
      this.connection.stream.write("sync", () => {});
      this.clock.now += this.writeFlushAfterMs;
      for (const flush of flushes.splice(0)) flush();
      this.clock.now += this.firstByteAfterMs;
      for (const listener of this.dataListeners) listener();
      this.clock.now += this.resultAfterMs;
    };
  }
}

test("connection spans carry connection_id, idle_ms and the first statement split into write and first byte", async () => {
  const clock = { now: 0 };
  Date.now = () => clock.now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => clock.now }));

  const client = new SocketFakeClient(clock);
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);

  // Connect path, new client: flushed after 2ms, first reply byte at 902ms, done at 905ms.
  client.writeFlushAfterMs = 2;
  client.firstByteAfterMs = 900;
  client.resultAfterMs = 3;
  const first = await pool.connect();
  await first.query("SELECT id FROM users WHERE id = $1");
  first.release();

  // pool.query path, reused after 4s idle: flushed after 1ms, first byte at 1,201ms.
  clock.now += 4_000;
  client.writeFlushAfterMs = 1;
  client.firstByteAfterMs = 1_200;
  client.resultAfterMs = 5;
  await pool.query("SELECT revoked_at FROM session_families WHERE id = $1");

  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.attrs?.connection_id, spans[1]!.attrs?.connection_id, "one client, one connection_id");
  assert.equal(typeof spans[0]!.attrs?.connection_id, "number");
  assert.equal(spans[0]!.attrs?.idle_ms, undefined, "a new client has no idle time");
  assert.equal(spans[0]!.attrs?.first_query_ms, 905);
  assert.equal(spans[0]!.attrs?.first_query_write_ms, 2);
  assert.equal(spans[0]!.attrs?.first_query_first_byte_ms, 902);
  assert.equal(spans[1]!.attrs?.connection_reused, true);
  assert.equal(spans[1]!.attrs?.idle_ms, 4_000);
  assert.equal(spans[1]!.attrs?.first_query_ms, 1_206);
  assert.equal(spans[1]!.attrs?.first_query_write_ms, 1);
  assert.equal(spans[1]!.attrs?.first_query_first_byte_ms, 1_201);
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
  // pool.query's single statement is the whole hold; a fresh client is not reused.
  assert.equal(spans[0].attrs?.first_query_ms, 210);
  assert.equal(spans[0].attrs?.connection_reused, false);

  // The same client used again (pool.query or connect) counts as reused.
  client.beforeQueryReturn = () => { now = 500; };
  now = 300;
  await pool.query("SELECT pg_sleep(0.2)");
  const again = sink.getAllSpans().filter((span) => span.name === "server.db.connection")[1]!;
  assert.equal(again.attrs?.connection_reused, true);
  assert.equal(again.attrs?.connect_ms, undefined);
  assert.equal(again.attrs?.first_query_ms, 200);
});

test("instrumentPool names the connection span after the work statement, not the closing COMMIT", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));

  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("search", pool);

  now = 10;
  const checkedOut = await pool.connect();
  await checkedOut.query("BEGIN READ ONLY");
  await checkedOut.query("SELECT set_config('work_mem', $1, true)", ["32MB"]);
  await withDbTraceAttributes(
    { db_callsite: "messages.search" },
    () => checkedOut.query("SELECT id FROM messages WHERE search_vector @@ $1", ["q"]),
  );
  await checkedOut.query("COMMIT");
  now = 200;
  checkedOut.release();

  // A checkout that only ran transaction control keeps that as its identity.
  now = 300;
  const emptyTx = await pool.connect();
  await emptyTx.query("BEGIN");
  await emptyTx.query("ROLLBACK");
  now = 450;
  emptyTx.release();

  const spans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(spans.length, 2);
  assert.equal(spans[0].attrs?.statement_kind, "select");
  assert.equal(spans[0].attrs?.query, "SELECT id FROM messages WHERE search_vector @@ $1");
  assert.equal(spans[0].attrs?.db_callsite, "messages.search");
  assert.equal(spans[1].attrs?.statement_kind, "transaction");
  assert.equal(spans[1].attrs?.query, "ROLLBACK");
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
  const recycleEvent = sink.getAllLogEvents().find((event) => event.name === "server.db.pool.read_only_client_recycled");
  assert.equal(recycleEvent?.attrs?.pool, "primary");
  assert.equal(recycleEvent?.attrs?.sqlstate, "25006");
  assert.equal(recycleEvent?.attrs?.outcome, "client_discarded");
  assert.equal(recycleEvent?.attrs?.reason, "read_only_transaction");
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

/** Like pg-pool: one physical client, and a fresh client.release on every checkout. */
class ReassigningReleasePool {
  readonly options = {};
  readonly releases: unknown[][] = [];
  readonly client = {
    query: (query: { callback?: (err: Error | undefined, result?: pg.QueryResult) => void }) => {
      this.onQuery();
      queueMicrotask(() => query.callback?.(undefined, { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] }));
      return query;
    },
    release: (..._args: unknown[]) => {},
  };

  constructor(private readonly onQuery: () => void) {}

  async connect() {
    this.client.release = (...args: unknown[]) => {
      this.releases.push(args);
    };
    return this.client as unknown as pg.PoolClient;
  }
}

test("every search checkout of a reused pool client records a connection span under its search span", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink, clock: () => now });
  setDbTracer(tracer);

  const pool = new ReassigningReleasePool(() => {
    now += 200;
  });
  instrumentPool("search", pool as unknown as pg.Pool);

  const root = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  await runWithTraceSpan(root, async () => {
    for (const phase of ["first", "second", "third"]) {
      await traceQuerySpan(
        { queryName: "messages.search", phase },
        () => executeCancellablePgPoolSql(pool as unknown as pg.Pool, sql`SELECT ${phase}::text`),
      );
    }
  }, tracer);
  root.end();

  assert.equal(pool.releases.length, 3);
  const searchSpans = sink.getAllSpans().filter((span) => span.name === "server.db.query");
  const connectionSpans = sink.getAllSpans().filter((span) => span.name === "server.db.connection");
  assert.equal(searchSpans.length, 3);
  // Before the fix only the client's first checkout was recorded.
  assert.equal(connectionSpans.length, 3);
  assert.deepEqual(
    connectionSpans.map((span) => span.context.parentSpanId),
    searchSpans.map((span) => span.context.spanId),
  );
  for (const span of connectionSpans) {
    assert.equal(span.context.traceId, root.context.traceId);
    assert.equal(span.attrs?.pool, "search");
    assert.equal(span.attrs?.statement_kind, "select");
  }
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

async function statementCount(pool: string, statement: string): Promise<number> {
  const json = await dbQueryDuration.get();
  const match = json.values.find((value) =>
    value.metricName === "slock_db_query_duration_seconds_count"
    && value.labels.pool === pool
    && value.labels.statement === statement);
  return match?.value ?? 0;
}

async function statementErrorCount(pool: string, sqlstate: string): Promise<number> {
  const json = await dbQueryErrorsTotal.get();
  const match = json.values.find((value) => value.labels.pool === pool && value.labels.sqlstate === sqlstate);
  return match?.value ?? 0;
}

test("checked-out statements are timed once each by pool and statement kind, including the transaction frame", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("metrics-checkout", pool);

  const checkedOut = await pool.connect();
  await checkedOut.query("BEGIN");
  await checkedOut.query("select * from messages where id = $1", ["x"]);
  await checkedOut.query("update messages set content = $1", ["y"]);
  await checkedOut.query("COMMIT");
  checkedOut.release();

  assert.equal(await statementCount("metrics-checkout", "transaction"), 2);
  assert.equal(await statementCount("metrics-checkout", "select"), 1);
  assert.equal(await statementCount("metrics-checkout", "update"), 1);
});

test("pool.query is timed exactly once even when the client was already instrumented by an earlier checkout", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("metrics-pool-query", pool);

  const checkedOut = await pool.connect();
  checkedOut.release();
  await pool.query("select 1");
  await new Promise<void>((resolve, reject) => {
    pool.query("select 2", (err: Error | undefined) => (err ? reject(err) : resolve()));
  });

  assert.equal(await statementCount("metrics-pool-query", "select"), 2);
});

test("statement failures count by bounded SQLSTATE: 57014 is its own series, unknown codes fold to other", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("metrics-errors", pool);

  client.queryError = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  await assert.rejects(() => pool.query("select pg_sleep(20)"));
  const checkedOut = await pool.connect();
  await assert.rejects(() => checkedOut.query("select pg_sleep(20)"));
  checkedOut.release();

  client.queryError = Object.assign(new Error("duplicate key"), { code: "23505" });
  await assert.rejects(() => pool.query("insert into users values (1)"));
  client.queryError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  await assert.rejects(() => pool.query("select 1"));

  assert.equal(await statementErrorCount("metrics-errors", "57014"), 2);
  assert.equal(await statementErrorCount("metrics-errors", "other"), 1);
  assert.equal(await statementErrorCount("metrics-errors", "no_sqlstate"), 1);
  assert.equal(await statementErrorCount("metrics-errors", "23505"), 0);
  // Failed statements still land in the duration histogram.
  assert.equal(await statementCount("metrics-errors", "select"), 3);
});

test("cancellable search statements are timed by their caller, and a caller abort is not counted as a timeout", async () => {
  const client = new CancellableFakeClient();
  const pool = new CancellableFakePool(client) as unknown as pg.Pool;
  instrumentPool("metrics-search", pool);

  const done = executeCancellablePgPoolSql(pool, sql`SELECT ${"needle"}::text AS value`);
  await waitForSubmittedQuery(client);
  client.resolve([{ value: "needle" }]);
  await done;
  assert.equal(await statementCount("metrics-search", "select"), 1);

  client.submittedQuery = undefined;
  const timedOut = executeCancellablePgPoolSql(pool, sql`SELECT ${"slow"}::text AS value`);
  await waitForSubmittedQuery(client);
  client.reject(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
  await assert.rejects(timedOut);
  assert.equal(await statementErrorCount("metrics-search", "57014"), 1);

  client.submittedQuery = undefined;
  const abort = new AbortController();
  const aborted = executeCancellablePgPoolSql(pool, sql`SELECT ${"gone"}::text AS value`, {
    signal: abort.signal,
    cancelQuery: () => {},
  });
  await waitForSubmittedQuery(client);
  abort.abort();
  client.reject(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
  await assert.rejects(aborted);
  assert.equal(await statementErrorCount("metrics-search", "57014"), 1);
  assert.equal(await statementCount("metrics-search", "select"), 2);
});

test("a pool that hands out no connection in time counts as acquire_timeout, even with tracing off", async () => {
  const client = new FakeClient();
  const fake = new FakePool(client);
  fake.connectError = new Error("timeout exceeded when trying to connect");
  const pool = fake as unknown as pg.Pool;
  instrumentPool("metrics-acquire", pool);

  await assert.rejects(() => pool.connect());
  await assert.rejects(() => pool.query("select 1"));

  assert.equal(await statementErrorCount("metrics-acquire", "acquire_timeout"), 2);
  assert.equal(await statementCount("metrics-acquire", "select"), 0);
});

test("a statement that fails with a lock conflict records db.lock_conflict before the error propagates, with no values", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);

  for (const sqlstate of ["40P01", "40001", "55P03"]) {
    client.queryError = Object.assign(new Error(`conflict ${sqlstate}`), { code: sqlstate });
    const checkedOut = await pool.connect();
    // The caller swallows it: the event must already be recorded.
    await withDbTraceAttributes({ db_callsite: "test.swallowed" }, () =>
      checkedOut.query("UPDATE external_channel_bindings SET state = 'paused' WHERE id = $1", ["b-secret"]).catch(() => null));
    checkedOut.release();
  }
  // A non-conflict failure records nothing.
  client.queryError = Object.assign(new Error("syntax"), { code: "42601" });
  const other = await pool.connect();
  await other.query("SELECT 1").catch(() => null);
  other.release();

  const events = sink.getAllLogEvents().filter((event) => event.name === "db.lock_conflict");
  assert.deepEqual(events.map((event) => event.attrs?.sqlstate), ["40P01", "40001", "55P03"]);
  for (const event of events) {
    assert.equal(event.attrs?.pool, "primary");
    assert.equal(event.attrs?.statement_kind, "update");
    assert.equal(event.attrs?.in_transaction, false);
    assert.equal(event.attrs?.db_callsite, "test.swallowed");
    assert.equal(event.attrs?.sql_fingerprint, "UPDATE external_channel_bindings SET state = ? WHERE id = ?");
    assert.equal(typeof event.attrs?.sql_hash, "string");
    assert.equal(JSON.stringify(event.attrs).includes("paused"), false, "no literal values");
    assert.equal(JSON.stringify(event.attrs).includes("b-secret"), false, "no parameters");
  }
});

test("db.lock_order lists a deadlocked attempt's explicit locks in order, with row roles and no values", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDbTracer(new BasicTracer({ sink, clock: () => now }));
  setDefaultTraceTracer(new BasicTracer({ sink, clock: () => now }));
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  const deadlock = Object.assign(new Error("deadlock"), { code: "40P01" });

  await assert.rejects(withLockOrderRecording({
    transaction: "test.tx",
    serverId: "server-1",
    rowRoles: { permission: "chan-a", request: "chan-a", stored: "chan-b" },
  }, async () => {
    const checkedOut = await pool.connect();
    await checkedOut.query("begin");
    now = 5;
    await checkedOut.query('select "id" from "channels" where "id" = $1 for no key update', ["chan-a"]);
    await checkedOut.query('insert into "messages" ("id") values ($1)', ["secret-body"]);
    now = 7;
    await checkedOut.query('update "channels" set "seq" = $1 where "id" = $2', [1, "chan-b"]);
    client.queryError = deadlock;
    now = 9;
    await checkedOut.query('select "id" from "channels" where "id" = $1 for no key update', ["chan-b"]).finally(() => {
      client.queryError = undefined;
      checkedOut.release();
    });
  }), deadlock);

  const [event] = sink.getAllLogEvents().filter((candidate) => candidate.name === "db.lock_order");
  assert.equal(event?.attrs?.trigger, "deadlock");
  assert.equal(event?.attrs?.transaction, "test.tx");
  assert.equal(event?.attrs?.server_id, "server-1");
  assert.equal(event?.attrs?.step_count, 3);
  const steps = JSON.parse(String(event?.attrs?.steps)) as Array<Record<string, unknown>>;
  assert.deepEqual(
    steps.map(({ seq, ms, table, lock, role, sqlstate }) => ({ seq, ms, table, lock, role, sqlstate })),
    [
      { seq: 1, ms: 5, table: "channels", lock: "FOR NO KEY UPDATE", role: "permission+request", sqlstate: undefined },
      { seq: 2, ms: 7, table: "channels", lock: "UPDATE", role: "stored", sqlstate: undefined },
      { seq: 3, ms: 9, table: "channels", lock: "FOR NO KEY UPDATE", role: "stored", sqlstate: "40P01" },
    ],
  );
  for (const value of ["chan-a", "chan-b", "secret-body"]) {
    assert.equal(JSON.stringify(event?.attrs).includes(value), false, "no parameters");
  }
});

test("db.lock_order records a transaction over 1 s and stays silent for a fast one", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink, clock: () => now }));
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  const run = (durationMs: number) => withLockOrderRecording({ transaction: "test.tx", rowRoles: {} }, async () => {
    const checkedOut = await pool.connect();
    await checkedOut.query("begin");
    const start = now;
    await checkedOut.query('update "agents" set "x" = 1');
    now = start + durationMs;
    checkedOut.release();
  });

  await run(1_000);
  assert.equal(sink.getAllLogEvents().filter((event) => event.name === "db.lock_order").length, 0);
  await run(1_001);
  const events = sink.getAllLogEvents().filter((event) => event.name === "db.lock_order");
  assert.deepEqual(events.map((event) => event.attrs?.trigger), ["slow"]);
});

test("db.statement_stats totals a many-statement unit per statement hash, without text or values", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink, clock: () => now }));
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  client.beforeQueryReturn = () => { now += 5; };

  await withStatementStats("test.unit", async () => {
    const checkedOut = await pool.connect();
    for (let index = 0; index < 9; index += 1) {
      await checkedOut.query("UPDATE read_cursors SET seq = $1 WHERE id = $2", [index, "secret-id"]);
    }
    await checkedOut.query("DELETE FROM read_mutations WHERE id = $1", ["secret-id"]);
    checkedOut.release();
  });

  const [event] = sink.getAllLogEvents().filter((candidate) => candidate.name === "db.statement_stats");
  assert.equal(event?.attrs?.unit, "test.unit");
  assert.equal(event?.attrs?.statement_count, 10);
  assert.equal(event?.attrs?.distinct_statement_count, 2);
  const statements = JSON.parse(String(event?.attrs?.statements)) as Array<{ count: number; total_ms: number; max_ms: number }>;
  assert.deepEqual(statements.map(({ count, total_ms, max_ms }) => ({ count, total_ms, max_ms })), [
    { count: 9, total_ms: 45, max_ms: 5 },
    { count: 1, total_ms: 5, max_ms: 5 },
  ]);
  for (const value of ["secret-id", "read_cursors", "read_mutations"]) {
    assert.equal(JSON.stringify(event?.attrs).includes(value), false, "only hashes");
  }
});

test("db.statement_stats stays silent for a short unit and reports a slow one", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink, clock: () => now }));
  const client = new FakeClient();
  const pool = new FakePool(client) as unknown as pg.Pool;
  instrumentPool("primary", pool);
  const run = (durationMs: number) => withStatementStats("test.unit", async () => {
    const checkedOut = await pool.connect();
    await checkedOut.query("SELECT 1");
    now += durationMs;
    checkedOut.release();
  });

  await run(999);
  assert.equal(sink.getAllLogEvents().filter((event) => event.name === "db.statement_stats").length, 0);
  await run(1_000);
  assert.equal(sink.getAllLogEvents().filter((event) => event.name === "db.statement_stats").length, 1);
});

test("db.statement_stats carries attributes taken from the unit's result", async () => {
  let now = 0;
  Date.now = () => now;
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink, clock: () => now }));

  await withStatementStats(
    "test.unit",
    async () => {
      now += 1_000;
      return { compacted: 7, candidates: 9 };
    },
    (result) => result,
  );

  const [event] = sink.getAllLogEvents().filter((candidate) => candidate.name === "db.statement_stats");
  assert.equal(event?.attrs?.compacted, 7);
  assert.equal(event?.attrs?.candidates, 9);
});

test("searchReplicaFallbackReason retries replica connection failures and recovery conflicts only", () => {
  const pgError = (code: string, message = "x") => Object.assign(new Error(message), { code });
  assert.equal(searchReplicaFallbackReason(pgError("40001", "canceling statement due to conflict with recovery")), "recovery_conflict");
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "57P01", "57P03", "08006", "53300"]) {
    assert.equal(searchReplicaFallbackReason(pgError(code)), "connection", code);
  }
  assert.equal(searchReplicaFallbackReason(new Error("Connection terminated unexpectedly")), "connection");
  assert.equal(searchReplicaFallbackReason(new Error("Connection terminated due to connection timeout")), "connection");
  assert.equal(searchReplicaFallbackReason(new Error("Client has encountered a connection error and is not queryable")), "connection");
  // Not retried: statement timeout, query errors, a busy search pool, caller aborts.
  assert.equal(searchReplicaFallbackReason(pgError("57014", "canceling statement due to statement timeout")), null);
  assert.equal(searchReplicaFallbackReason(pgError("42601", "syntax error")), null);
  assert.equal(searchReplicaFallbackReason(new Error("timeout exceeded when trying to connect")), null);
  assert.equal(searchReplicaFallbackReason(Object.assign(new Error("aborted"), { name: "SearchQueryAbortedError", code: "SEARCH_QUERY_ABORTED" })), null);
});

test("executeSearchSqlWithPrimaryFallback runs a failed replica query once on the primary and records the fallback", async () => {
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink }));
  const replica = { name: "replica" } as unknown as pg.Pool;
  const primary = { name: "primary" } as unknown as pg.Pool;
  const calls: unknown[] = [];
  const execute = (async (pool: pg.Pool) => {
    calls.push(pool);
    if (pool === replica) throw Object.assign(new Error("canceling statement due to conflict with recovery"), { code: "40001" });
    return { rows: [{ id: "m1" }] };
  }) as Parameters<typeof executeSearchSqlWithPrimaryFallback>[4];

  const result = await executeSearchSqlWithPrimaryFallback(replica, primary, sql`SELECT 1`, {}, execute);

  assert.deepEqual(result.rows, [{ id: "m1" }]);
  assert.deepEqual(calls, [replica, primary]);
  const events = sink.getAllLogEvents().filter((event) => event.name === "server.db.search_replica_fallback");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.attrs?.reason, "recovery_conflict");
  assert.equal(events[0]!.attrs?.error_code, "40001");
});

test("executeSearchSqlWithPrimaryFallback does not retry statement timeouts or aborted searches", async () => {
  const replica = {} as unknown as pg.Pool;
  const primary = {} as unknown as pg.Pool;
  let primaryCalls = 0;
  const failWith = (error: Error) => (async (pool: pg.Pool) => {
    if (pool === primary) primaryCalls += 1;
    throw error;
  }) as Parameters<typeof executeSearchSqlWithPrimaryFallback>[4];

  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  await assert.rejects(executeSearchSqlWithPrimaryFallback(replica, primary, sql`SELECT 1`, {}, failWith(timeout)), timeout);

  const abort = new AbortController();
  abort.abort();
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  await assert.rejects(
    executeSearchSqlWithPrimaryFallback(replica, primary, sql`SELECT 1`, { signal: abort.signal }, failWith(reset)),
    reset,
  );
  assert.equal(primaryCalls, 0);
});
