import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, test, vi } from "vitest";
import {
  dbActivityCheckErrorsTotal,
  dbLockWaitingBackends,
  dbOldestXactAgeSeconds,
} from "../metrics";
import {
  PG_ACTIVITY_QUERY,
  recordPgActivity,
  resolvePgActivityMonitorTarget,
  startPgActivityMonitor,
  type PgActivityClient,
  type PgActivityRow,
} from "./pgActivityMonitor";

afterEach(() => {
  dbOldestXactAgeSeconds.reset();
  dbLockWaitingBackends.reset();
  dbActivityCheckErrorsTotal.reset();
  vi.useRealTimers();
});

const PROD = { DEPLOYMENT_ENV: "production" };

async function singleValue(metric: { get(): Promise<{ values: { value: number }[] }> }): Promise<number | undefined> {
  return (await metric.get()).values[0]?.value;
}

test("target: on in production, off elsewhere unless forced, never for PGlite", () => {
  const url = { DATABASE_URL: "postgres://pooled" };
  assert.equal(resolvePgActivityMonitorTarget({ ...PROD, ...url }), "postgres://pooled");
  assert.equal(resolvePgActivityMonitorTarget(url), null);
  assert.equal(resolvePgActivityMonitorTarget({ ...url, DEPLOYMENT_ENV: "staging" }), null);
  assert.equal(
    resolvePgActivityMonitorTarget({ ...url, DEPLOYMENT_ENV: "staging", DB_ACTIVITY_MONITOR: "on" }),
    "postgres://pooled",
  );
  for (const on of ["1", "true", "ON"]) {
    assert.equal(resolvePgActivityMonitorTarget({ ...url, DB_ACTIVITY_MONITOR: on }), "postgres://pooled", on);
  }
  for (const off of ["0", "false", "off", "OFF"]) {
    assert.equal(resolvePgActivityMonitorTarget({ ...PROD, ...url, DB_ACTIVITY_MONITOR: off }), null, off);
  }
  assert.equal(resolvePgActivityMonitorTarget({ ...PROD, DATABASE_URL: "pglite://./data" }), null);
  assert.equal(resolvePgActivityMonitorTarget(PROD), null);
});

test("query: executes against PostgreSQL pg_stat_activity and filters client backends / >5s Lock waits", async () => {
  const db = new PGlite();
  try {
    // 1. Unmodified query against live PostgreSQL catalog
    const live = await db.query<PgActivityRow>(PG_ACTIVITY_QUERY);
    assert.equal(live.rows.length, 1);
    assert.equal(Number(live.rows[0]?.oldest_xact_age_seconds), 0);
    assert.equal(Number(live.rows[0]?.lock_waiting_backends), 0);

    // 2. Filter semantics verified against PostgreSQL SQL evaluator
    await db.exec(`
      CREATE TEMP TABLE mock_pg_stat_activity (
        datname text,
        pid int,
        backend_type text,
        state text,
        xact_start timestamptz,
        wait_event_type text,
        state_change timestamptz
      );
      INSERT INTO mock_pg_stat_activity VALUES
        -- Excluded: walsender even if very old
        (current_database(), -101, 'walsender', 'active', clock_timestamp() - interval '7200 seconds', 'Lock', clock_timestamp() - interval '7200 seconds'),
        -- Excluded: own backend pid
        (current_database(), pg_backend_pid(), 'client backend', 'active', clock_timestamp() - interval '900 seconds', 'Lock', clock_timestamp() - interval '900 seconds'),
        -- Excluded: another database
        ('other_db', -102, 'client backend', 'active', clock_timestamp() - interval '900 seconds', 'Lock', clock_timestamp() - interval '900 seconds'),
        -- Excluded: idle session even if xact_start were set
        (current_database(), -103, 'client backend', 'idle', clock_timestamp() - interval '600 seconds', 'Client', clock_timestamp() - interval '600 seconds'),
        -- Included in oldest_xact_age_seconds (~320 s): stuck idle-in-transaction holding row locks
        (current_database(), -104, 'client backend', 'idle in transaction', clock_timestamp() - interval '320 seconds', 'Client', clock_timestamp() - interval '120 seconds'),
        -- Included in both (~14 s xact, >5 s active Lock wait)
        (current_database(), -105, 'client backend', 'active', clock_timestamp() - interval '14 seconds', 'Lock', clock_timestamp() - interval '14 seconds'),
        (current_database(), -106, 'client backend', 'active', clock_timestamp() - interval '9 seconds', 'Lock', clock_timestamp() - interval '9 seconds'),
        (current_database(), -107, 'client backend', 'active', clock_timestamp() - interval '6 seconds', 'Lock', clock_timestamp() - interval '6 seconds'),
        -- Excluded from lock_waiting_backends: Lock wait <= 5 s
        (current_database(), -108, 'client backend', 'active', clock_timestamp() - interval '2 seconds', 'Lock', clock_timestamp() - interval '2 seconds'),
        -- Excluded from lock_waiting_backends: non-Lock wait > 5 s
        (current_database(), -109, 'client backend', 'active', clock_timestamp() - interval '20 seconds', 'IO', clock_timestamp() - interval '20 seconds');
    `);
    const filtered = await db.query<PgActivityRow>(
      PG_ACTIVITY_QUERY.replace("FROM pg_stat_activity", "FROM mock_pg_stat_activity"),
    );
    const age = Number(filtered.rows[0]?.oldest_xact_age_seconds);
    assert.ok(age >= 319 && age < 330, `expected ~320 s oldest xact age, got ${age}`);
    assert.equal(Number(filtered.rows[0]?.lock_waiting_backends), 3);
  } finally {
    await db.close();
  }
});

test("record: parses numeric and string pg results and ignores empty rows", async () => {
  dbOldestXactAgeSeconds.set(15);
  dbLockWaitingBackends.set(2);
  recordPgActivity([]);
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 15);
  assert.equal(await singleValue(dbLockWaitingBackends), 2);

  recordPgActivity([{ oldest_xact_age_seconds: "342.75", lock_waiting_backends: 6 }]);
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 342.75);
  assert.equal(await singleValue(dbLockWaitingBackends), 6);

  recordPgActivity([{ oldest_xact_age_seconds: 0, lock_waiting_backends: "0" }]);
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 0);
  assert.equal(await singleValue(dbLockWaitingBackends), 0);
});

test("monitor: checks immediately and on interval; failed check increments error counter and keeps last values", async () => {
  vi.useFakeTimers();
  const results: (PgActivityRow[] | Error)[] = [
    [{ oldest_xact_age_seconds: 318.5, lock_waiting_backends: 4 }],
    new Error("query_timeout"),
    [{ oldest_xact_age_seconds: 42, lock_waiting_backends: 1 }],
  ];
  let calls = 0;
  let ended = false;
  const client: PgActivityClient = {
    async query() {
      const next = results[calls++];
      if (next instanceof Error) throw next;
      return next;
    },
    async end() {
      ended = true;
    },
  };

  const stop = startPgActivityMonitor("postgres://pooled", {
    intervalMs: 1_000,
    createClient: () => client,
  });

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(calls, 1);
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 318.5);
  assert.equal(await singleValue(dbLockWaitingBackends), 4);

  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(calls, 2);
  assert.equal(await singleValue(dbActivityCheckErrorsTotal), 1);
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 318.5, "keeps last xact age after failed check");
  assert.equal(await singleValue(dbLockWaitingBackends), 4, "keeps last lock wait count after failed check");

  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(calls, 3);
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 42);
  assert.equal(await singleValue(dbLockWaitingBackends), 1);

  stop();
  assert.equal(await singleValue(dbOldestXactAgeSeconds), 0, "resets gauge to 0 on stop");
  assert.equal(await singleValue(dbLockWaitingBackends), 0, "resets gauge to 0 on stop");
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(calls, 3, "no checks after stop");
  assert.equal(ended, true);
});

test("monitor: disabled target creates no client", () => {
  let created = false;
  const stop = startPgActivityMonitor(null, {
    createClient: () => {
      created = true;
      throw new Error("unreachable");
    },
  });
  stop();
  assert.equal(created, false);
});
