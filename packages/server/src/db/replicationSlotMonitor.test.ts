import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  dbReplicationSlotActive,
  dbReplicationSlotCheckErrorsTotal,
  dbReplicationSlotRetainedWalBytes,
  dbReplicationSlotWalStatus,
} from "../metrics";
import {
  recordReplicationSlots,
  resolveReplicationSlotMonitorTarget,
  startReplicationSlotMonitor,
  type ReplicationSlotClient,
  type ReplicationSlotRow,
} from "./replicationSlotMonitor";

afterEach(() => {
  dbReplicationSlotRetainedWalBytes.reset();
  dbReplicationSlotActive.reset();
  dbReplicationSlotWalStatus.reset();
  dbReplicationSlotCheckErrorsTotal.reset();
  vi.useRealTimers();
});

const PROD = { DEPLOYMENT_ENV: "production" };

async function values(gauge: { get(): Promise<{ values: { labels: object; value: number }[] }> }) {
  return (await gauge.get()).values.map((v) => ({ ...v.labels, value: v.value }));
}

const RW: ReplicationSlotRow = {
  slot_name: "rw_cdc_slot",
  slot_type: "logical",
  active: true,
  wal_status: "reserved",
  retained_wal_bytes: "73400320",
};
const DIST: ReplicationSlotRow = {
  slot_name: "slock_dist_cdc_slot",
  slot_type: "logical",
  active: false,
  wal_status: "extended",
  retained_wal_bytes: 21474836480,
};

test("target: on in production, off elsewhere unless forced, never for PGlite", () => {
  const url = { DATABASE_URL: "postgres://pooled" };
  assert.equal(resolveReplicationSlotMonitorTarget({ ...PROD, ...url }), "postgres://pooled");
  assert.equal(resolveReplicationSlotMonitorTarget(url), null);
  assert.equal(resolveReplicationSlotMonitorTarget({ ...url, DEPLOYMENT_ENV: "staging" }), null);
  assert.equal(
    resolveReplicationSlotMonitorTarget({ ...url, DEPLOYMENT_ENV: "staging", DB_REPLICATION_SLOT_MONITOR: "on" }),
    "postgres://pooled",
  );
  for (const off of ["0", "false", "off"]) {
    assert.equal(resolveReplicationSlotMonitorTarget({ ...PROD, ...url, DB_REPLICATION_SLOT_MONITOR: off }), null, off);
  }
  assert.equal(resolveReplicationSlotMonitorTarget({ ...PROD, DATABASE_URL: "pglite://./data" }), null);
  assert.equal(resolveReplicationSlotMonitorTarget(PROD), null);
});

test("record: retained bytes, active and wal_status per slot", async () => {
  recordReplicationSlots([RW, DIST]);
  assert.deepEqual(await values(dbReplicationSlotRetainedWalBytes), [
    { slot_name: "rw_cdc_slot", slot_type: "logical", value: 73400320 },
    { slot_name: "slock_dist_cdc_slot", slot_type: "logical", value: 21474836480 },
  ]);
  assert.deepEqual(await values(dbReplicationSlotActive), [
    { slot_name: "rw_cdc_slot", slot_type: "logical", value: 1 },
    { slot_name: "slock_dist_cdc_slot", slot_type: "logical", value: 0 },
  ]);
  assert.deepEqual(await values(dbReplicationSlotWalStatus), [
    { slot_name: "rw_cdc_slot", slot_type: "logical", wal_status: "reserved", value: 1 },
    { slot_name: "slock_dist_cdc_slot", slot_type: "logical", wal_status: "extended", value: 1 },
  ]);
});

test("record: a dropped slot disappears; a lost slot has no restart_lsn but keeps its status", async () => {
  recordReplicationSlots([RW, DIST]);
  recordReplicationSlots([{ ...DIST, wal_status: "lost", retained_wal_bytes: null }]);
  assert.deepEqual(await values(dbReplicationSlotRetainedWalBytes), []);
  assert.deepEqual(await values(dbReplicationSlotActive), [
    { slot_name: "slock_dist_cdc_slot", slot_type: "logical", value: 0 },
  ]);
  assert.deepEqual(await values(dbReplicationSlotWalStatus), [
    { slot_name: "slock_dist_cdc_slot", slot_type: "logical", wal_status: "lost", value: 1 },
  ]);
});

test("monitor: checks right away and every interval; a failed check keeps the last values", async () => {
  vi.useFakeTimers();
  const results: (ReplicationSlotRow[] | Error)[] = [[RW], new Error("timeout"), [RW, DIST]];
  let calls = 0;
  let ended = false;
  const client: ReplicationSlotClient = {
    async query() {
      const next = results[calls++];
      if (next instanceof Error) throw next;
      return next;
    },
    async end() {
      ended = true;
    },
  };
  const stop = startReplicationSlotMonitor("postgres://pooled", { intervalMs: 1_000, createClient: () => client });

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(calls, 1);
  assert.equal((await values(dbReplicationSlotActive)).length, 1);

  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(calls, 2);
  assert.equal((await dbReplicationSlotCheckErrorsTotal.get()).values[0]?.value, 1);
  assert.equal((await values(dbReplicationSlotActive)).length, 1, "last values kept after a failed check");

  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(calls, 3);
  assert.equal((await values(dbReplicationSlotActive)).length, 2);

  stop();
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(calls, 3, "no checks after stop");
  assert.equal(ended, true);
});

test("monitor: no target, no client", () => {
  let created = false;
  const stop = startReplicationSlotMonitor(null, {
    createClient: () => {
      created = true;
      throw new Error("unreachable");
    },
  });
  stop();
  assert.equal(created, false);
});
