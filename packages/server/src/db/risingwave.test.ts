import { strict as assert } from "node:assert";
import type pg from "pg";
import {
  asRisingWaveOverload,
  asRisingWaveReadError,
  getRisingWaveConnectionTimeoutMillis,
  getRisingWaveInboxRfc056ServingMode,
  queryRisingWave,
  RisingWaveNotConfiguredError,
  RisingWaveOverloadedError,
  RisingWaveReadError,
  UNIFIED_CHAIN_VIEWS,
  UnifiedChainViewUnavailableError,
  withUnifiedChainTransition,
  __testUnifiedChainTransition,
} from "./risingwave";
import { risingWaveInboxFailureAttrs } from "../tracing/risingWaveInboxTrace";
import { dbQueryDuration, dbQueryErrorsTotal } from "../metrics";

test("RisingWave connection timeout defaults to a bounded fail-soft value", () => {
  assert.equal(getRisingWaveConnectionTimeoutMillis({}), 1_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "750" }), 750);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "100" }), 250);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "60000" }), 10_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "1000.9" }), 1_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "not-a-number" }), 1_000);
});

test("RFC056 serving mode is fail-closed and requires an explicit shadow or on value", () => {
  assert.equal(getRisingWaveInboxRfc056ServingMode({}), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "" }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "invalid" }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: " OFF " }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: " Shadow " }), "shadow");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "ON" }), "on");
});

test("a saturated RisingWave pool (acquire timeout) surfaces as RisingWaveOverloadedError, still classified rw_acquire_timeout", async () => {
  const acquireTimeout = new Error("timeout exceeded when trying to connect");
  const pool = { connect: async () => { throw acquireTimeout; } } as unknown as pg.Pool;
  const error = await queryRisingWave(pool, "SELECT 1").then(() => null, (err: unknown) => err);
  assert.ok(error instanceof RisingWaveOverloadedError);
  assert.equal((error as Error).cause, acquireTimeout);
  assert.equal(risingWaveInboxFailureAttrs({ route: "all", error, contractVersion: 2 }).error_kind, "rw_acquire_timeout");

  // Other failures pass through unchanged; an overload is not wrapped twice.
  const queryError = new Error("relation does not exist");
  assert.equal(asRisingWaveOverload(queryError), queryError);
  assert.equal(asRisingWaveOverload(error), error);
});

test("RisingWave shedding a query (too_many_internal_resets) is an overload, traced as rw_internal_resets", async () => {
  // The prod 2026-10-15 04:24Z message, as pg surfaces it.
  const shed = Object.assign(
    new Error("Failed to execute the statement\n\nCaused by these errors (recent errors listed first):\n  1: gRPC request to batch service failed: Resource has been exhausted\n  2: status: ResourceExhausted, message: \"too_many_internal_resets\""),
    { code: "XX000" },
  );
  const released: number[] = [];
  const pool = {
    connect: async () => ({
      query: async () => { throw shed; },
      release: () => { released.push(1); },
    }),
    totalCount: 1, idleCount: 0, waitingCount: 0,
  } as unknown as pg.Pool;
  const error = await queryRisingWave(pool, "SELECT 1").then(() => null, (err: unknown) => err);
  assert.ok(error instanceof RisingWaveOverloadedError);
  assert.equal((error as RisingWaveOverloadedError).reason, "rw_internal_resets");
  assert.equal((error as Error).cause, shed);
  assert.equal(released.length, 1);
  assert.equal(risingWaveInboxFailureAttrs({ route: "all", error, contractVersion: 2 }).error_kind, "rw_internal_resets");
  // An overload, so the typed read-error wrapper leaves it alone (503, not 502).
  assert.equal(asRisingWaveReadError(error), error);

  // Exact phrase only: other "exhausted" failures stay what they were.
  const otherExhausted = Object.assign(new Error("ERROR: memory exhausted while hashing"), { code: "53200" });
  assert.equal(asRisingWaveOverload(otherExhausted), otherExhausted);
  assert.equal(risingWaveInboxFailureAttrs({ route: "all", error: otherExhausted, contractVersion: 2 }).error_kind, "rw_query_error");
  assert.equal(risingWaveInboxFailureAttrs({ route: "all", error, contractVersion: 2 }).overload_reason, "rw_internal_resets");
  assert.equal(risingWaveInboxFailureAttrs({ route: "all", error: otherExhausted, contractVersion: 2 }).overload_reason, undefined, "not an overload");
});

async function rwStatementCount(statement: string): Promise<number> {
  const json = await dbQueryDuration.get();
  return json.values.find((value) =>
    value.metricName === "slock_db_query_duration_seconds_count"
    && value.labels.pool === "risingwave"
    && value.labels.statement === statement)?.value ?? 0;
}

async function rwErrorCount(sqlstate: string): Promise<number> {
  const json = await dbQueryErrorsTotal.get();
  return json.values.find((value) => value.labels.pool === "risingwave" && value.labels.sqlstate === sqlstate)?.value ?? 0;
}

test("RisingWave reads are timed under pool=risingwave and an acquire timeout counts as acquire_timeout", async () => {
  const selectsBefore = await rwStatementCount("select");
  const timeoutsBefore = await rwErrorCount("acquire_timeout");
  const otherBefore = await rwErrorCount("other");

  let failNext: unknown;
  const client = {
    query: async () => {
      if (failNext) throw failNext;
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client, totalCount: 1, idleCount: 0, waitingCount: 0 } as unknown as pg.Pool;
  await queryRisingWave(pool, "SELECT 1");
  failNext = Object.assign(new Error("column does not exist"), { code: "42703" });
  await assert.rejects(() => queryRisingWave(pool, "SELECT missing"));

  const saturated = { connect: async () => { throw new Error("timeout exceeded when trying to connect"); } } as unknown as pg.Pool;
  await assert.rejects(() => queryRisingWave(saturated, "SELECT 1"));

  assert.equal((await rwStatementCount("select")) - selectsBefore, 2);
  assert.equal((await rwErrorCount("other")) - otherBefore, 1);
  assert.equal((await rwErrorCount("acquire_timeout")) - timeoutsBefore, 1);
});


// RisingWave's answer for a relation that does not exist (verified on RW 3.0.3).
function rwNotFound(relation: string) {
  return Object.assign(
    new Error(`Failed to run the query\n\nCaused by these errors (recent errors listed first):\n  1: Catalog error\n  2: table or source not found: ${relation}\n`),
    { code: "42704" },
  );
}

test("unified chain transition: a missing 078 view is read from its 077 counterpart, and remembered for a minute", async () => {
  __testUnifiedChainTransition.reset();
  try {
    let clock = 1_000_000;
    const now = () => clock;
    const built = new Set(["rw_inbox_serving_v8", "rw_activity_totals_v6", "rw_agent_inbox_v6", "rw_conversation_unread_v3"]);
    const ran: string[] = [];
    const run = async (text: string) => {
      ran.push(text);
      const missing = [...text.matchAll(/\b(rw_[a-z0-9_]+)\b/g)].map((m) => m[1]!).find((name) => !built.has(name));
      if (missing) throw rwNotFound(missing);
      return text;
    };
    const fallbacks: string[][] = [];
    const onFallback = (views: string[]) => { fallbacks.push(views); };
    const query = `SELECT 1 FROM ${UNIFIED_CHAIN_VIEWS.serving} i WHERE i.receiver_id = $1`;

    assert.equal(
      await withUnifiedChainTransition(query, run, onFallback, now),
      "SELECT 1 FROM rw_inbox_serving_v8 i WHERE i.receiver_id = $1",
    );
    assert.equal(ran.length, 2, "the 078 view is tried first, then 077");
    assert.deepEqual(fallbacks, [["rw_inbox_serving_v9"]]);

    // Within the minute: straight to 077, no failed round-trip and no new report.
    ran.length = 0;
    await withUnifiedChainTransition(query, run, onFallback, now);
    assert.deepEqual(ran, ["SELECT 1 FROM rw_inbox_serving_v8 i WHERE i.receiver_id = $1"]);
    assert.equal(fallbacks.length, 1, "a remembered fallback is not reported again");

    // After the minute, still unbuilt: one failed round-trip and one report.
    clock += 60_001;
    ran.length = 0;
    await withUnifiedChainTransition(query, run, onFallback, now);
    assert.equal(ran.length, 2);
    assert.equal(fallbacks.length, 2);

    // After the minute, with 078 built: back on 078.
    built.add("rw_inbox_serving_v9");
    clock += 60_001;
    ran.length = 0;
    await withUnifiedChainTransition(query, run, onFallback, now);
    assert.deepEqual(ran, [query]);
    assert.equal(fallbacks.length, 2, "reading the current view is not a fallback");
  } finally {
    __testUnifiedChainTransition.reset();
  }
});

test("unified chain transition: with neither 078 nor 077 built, serving and totals fall back two generations to 076", async () => {
  __testUnifiedChainTransition.reset();
  try {
    let clock = 2_000_000;
    const now = () => clock;
    const built = new Set(["rw_inbox_serving_v7", "rw_activity_totals_v5"]);
    const ran: string[] = [];
    const run = async (text: string) => {
      ran.push(text);
      const missing = [...text.matchAll(/\b(rw_[a-z0-9_]+)\b/g)].map((m) => m[1]!).find((name) => !built.has(name));
      if (missing) throw rwNotFound(missing);
      return text;
    };
    const reported: Array<[string[], string[]]> = [];
    const onFallback = (missing: string[], read: string[]) => { reported.push([missing, read]); };
    const query = `SELECT 1 FROM ${UNIFIED_CHAIN_VIEWS.serving} i JOIN ${UNIFIED_CHAIN_VIEWS.totals} t ON true`;

    assert.equal(
      await withUnifiedChainTransition(query, run, onFallback, now),
      "SELECT 1 FROM rw_inbox_serving_v7 i JOIN rw_activity_totals_v5 t ON true",
    );
    assert.deepEqual(reported, [[
      ["rw_inbox_serving_v9", "rw_activity_totals_v7"],
      ["rw_inbox_serving_v7", "rw_activity_totals_v5"],
    ]], "one report, for the generation that answered");

    // Within the minute: straight to 076, one round-trip.
    ran.length = 0;
    await withUnifiedChainTransition(query, run, onFallback, now);
    assert.deepEqual(ran, ["SELECT 1 FROM rw_inbox_serving_v7 i JOIN rw_activity_totals_v5 t ON true"]);

    // No generation left: the missing-relation error surfaces instead of looping.
    __testUnifiedChainTransition.reset();
    built.clear();
    clock += 60_001;
    await assert.rejects(withUnifiedChainTransition(query, run, onFallback, now), /not found/);

    // Within the minute every generation is known missing: a named error, no SQL run
    // with a placeholder relation name.
    ran.length = 0;
    await assert.rejects(
      withUnifiedChainTransition(query, run, onFallback, now),
      (error: unknown) => error instanceof UnifiedChainViewUnavailableError
        && error.view === UNIFIED_CHAIN_VIEWS.serving
        && /rw_inbox_serving_v9, rw_inbox_serving_v8, rw_inbox_serving_v7$/.test(error.message),
    );
    assert.deepEqual(ran, [], "no query is sent once every generation is known missing");
  } finally {
    __testUnifiedChainTransition.reset();
  }
});

test("unified chain transition: a query builder reads a current-generation-only column only when the view resolved to it", async () => {
  __testUnifiedChainTransition.reset();
  try {
    let clock = 3_000_000;
    const now = () => clock;
    const built = new Set(["rw_inbox_serving_v8"]);
    const ran: string[] = [];
    const run = async (text: string) => {
      ran.push(text);
      const missing = [...text.matchAll(/\b(rw_[a-z0-9_]+)\b/g)].map((m) => m[1]!).find((name) => !built.has(name));
      if (missing) throw rwNotFound(missing);
      return text;
    };
    const resolvedTo: string[] = [];
    const query = (resolved: (view: string) => string) => {
      const servingView = resolved(UNIFIED_CHAIN_VIEWS.serving);
      resolvedTo.push(servingView);
      const anchor = servingView === UNIFIED_CHAIN_VIEWS.serving ? "i.first_mention_message_id" : "NULL";
      // Named by its current name: rewritten like a plain text.
      return `SELECT ${anchor} AS a FROM ${UNIFIED_CHAIN_VIEWS.serving} i`;
    };

    // 078 unbuilt: the builder is asked again with 077's name and projects NULL.
    assert.equal(await withUnifiedChainTransition(query, run, () => {}, now), "SELECT NULL AS a FROM rw_inbox_serving_v8 i");
    assert.deepEqual(ran, [
      "SELECT i.first_mention_message_id AS a FROM rw_inbox_serving_v9 i",
      "SELECT NULL AS a FROM rw_inbox_serving_v8 i",
    ]);
    assert.equal(resolvedTo.at(-1), "rw_inbox_serving_v8", "the last build is the text that ran");

    // 078 built (after the memo): the column is read from v9.
    built.add("rw_inbox_serving_v9");
    clock += 60_001;
    ran.length = 0;
    assert.equal(
      await withUnifiedChainTransition(query, run, () => {}, now),
      "SELECT i.first_mention_message_id AS a FROM rw_inbox_serving_v9 i",
    );
    assert.equal(ran.length, 1);
    assert.equal(resolvedTo.at(-1), UNIFIED_CHAIN_VIEWS.serving);

    // A builder naming no chain view runs once, with views resolved to themselves.
    assert.equal(
      await withUnifiedChainTransition((resolved) => `SELECT 1 FROM ${resolved("rw_messages")}`, async (text) => text),
      "SELECT 1 FROM rw_messages",
    );
  } finally {
    __testUnifiedChainTransition.reset();
  }
});

test("unified chain transition: other errors and other relations are not swallowed", async () => {
  __testUnifiedChainTransition.reset();
  try {
    const query = `SELECT 1 FROM ${UNIFIED_CHAIN_VIEWS.totals} t JOIN rw_channels c ON true`;
    let calls = 0;
    await assert.rejects(
      withUnifiedChainTransition(query, async () => { calls += 1; throw rwNotFound("rw_channels"); }),
      /rw_channels/,
    );
    await assert.rejects(
      withUnifiedChainTransition(query, async () => { calls += 1; throw new Error("timeout"); }),
      /timeout/,
    );
    assert.equal(calls, 2, "no retry");
    // A text that names no 076 view runs as is.
    assert.equal(await withUnifiedChainTransition("SELECT 1 FROM rw_messages", async (text) => text), "SELECT 1 FROM rw_messages");
  } finally {
    __testUnifiedChainTransition.reset();
  }
});

test("asRisingWaveReadError wraps only untyped RisingWave read failures", () => {
  const driverError = new Error("connect ECONNREFUSED 10.0.0.1:4566");
  const wrapped = asRisingWaveReadError(driverError);
  assert.ok(wrapped instanceof RisingWaveReadError);
  assert.equal((wrapped as RisingWaveReadError).cause, driverError);
  assert.equal(asRisingWaveReadError(wrapped), wrapped, "not wrapped twice");

  const notConfigured = new RisingWaveNotConfiguredError("sidebar unread");
  assert.equal(asRisingWaveReadError(notConfigured), notConfigured);
  const overloaded = new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"));
  assert.equal(asRisingWaveReadError(overloaded), overloaded);
  const causedByOverload = new Error("retry failed", { cause: overloaded });
  assert.equal(asRisingWaveReadError(causedByOverload), causedByOverload, "an overload in the cause chain stays an overload");
});

test("RisingWave briefly unreachable (restart) is an overload, so a recent stale body can serve; query errors are not", async () => {
  // Prod 2026-10-17 19:00:21-19:01:36Z: the node restarted. New connections got
  // the proxy's E_UPSTREAM_UNREACHABLE, in-flight ones were cut off.
  const unreachable = Object.assign(new Error("could not reach instance [E_UPSTREAM_UNREACHABLE]. request id: ca42c269-a5c5-456"), { code: "XX000" });
  const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:4566"), { code: "ECONNREFUSED" });
  const cutOff = new Error("Connection terminated unexpectedly");
  for (const [label, failure, where] of [
    ["proxy unreachable on connect", unreachable, "connect"],
    ["connection refused on connect", refused, "connect"],
    ["in-flight query cut off", cutOff, "query"],
  ] as const) {
    const pool = (where === "connect"
      ? { connect: async () => { throw failure; } }
      : {
        connect: async () => ({ query: async () => { throw failure; }, release: () => {} }),
        totalCount: 1, idleCount: 0, waitingCount: 0,
      }) as unknown as pg.Pool;
    const error = await queryRisingWave(pool, "SELECT 1").then(() => null, (err: unknown) => err);
    assert.ok(error instanceof RisingWaveOverloadedError, label);
    assert.equal((error as RisingWaveOverloadedError).reason, "rw_unreachable", label);
    assert.equal((error as Error).cause, failure, label);
    assert.equal(asRisingWaveReadError(error), error, `${label}: 503 + stale, not 502`);
    // The trace keeps saying what it was.
    assert.equal(risingWaveInboxFailureAttrs({ route: "all", error, contractVersion: 2 }).error_kind, "rw_connect_error", label);
    assert.equal(risingWaveInboxFailureAttrs({ route: "all", error, contractVersion: 2 }).overload_reason, "rw_unreachable", label);
  }

  // Exact signals only: a query error mentioning connections stays a query error.
  for (const notUnreachable of [
    Object.assign(new Error("relation \"rw_conversation_unread_v9\" does not exist"), { code: "42P01" }),
    Object.assign(new Error("Connection terminated due to connection timeout"), {}),
    Object.assign(new Error("permission denied for connection to instance"), { code: "42501" }),
  ]) {
    assert.equal(asRisingWaveOverload(notUnreachable), notUnreachable, notUnreachable.message);
  }
});
