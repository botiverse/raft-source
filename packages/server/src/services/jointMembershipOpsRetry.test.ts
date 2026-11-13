import assert from "node:assert/strict";
import { test } from "vitest";
import pg from "pg";
import { attachJointOpsConnectionErrorHandlers, jointSourceRunReceipt, retryTransient, transientKindOf } from "../../scripts/joint-human-membership-ops";

const pgError = (code: string) => Object.assign(new Error("server message with connection data"), { code });
// As drizzle wraps a failed query: DrizzleQueryError -> pg error.
const wrapped = (cause: Error) => Object.assign(new Error("Failed query: SELECT ..."), { cause });
const noSleep = async () => {};

async function attemptsUntil(failure: Error, options: { readOnly?: boolean }) {
  let calls = 0;
  const result = await retryTransient(async () => { if (++calls === 1) throw failure; return "ok"; }, { ...options, sleep: noSleep });
  return { calls, ...result };
}

test("joint ops retry: replica conflicts and connection loss are retried only for read-only work", async () => {
  assert.equal(transientKindOf(wrapped(pgError("40001"))), "replica_or_connection");
  assert.equal(transientKindOf(wrapped(pgError("57014"))), "lock_timeout");
  assert.equal(transientKindOf(wrapped(new Error("Connection terminated unexpectedly"))), "replica_or_connection");
  assert.equal(transientKindOf(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), "replica_or_connection");
  assert.equal(transientKindOf(wrapped(pgError("23505"))), null);
  assert.equal(transientKindOf(new Error("Something else")), null);

  for (const failure of [wrapped(pgError("40001")), wrapped(new Error("Connection terminated unexpectedly")), wrapped(pgError("57P01"))]) {
    const result = await attemptsUntil(failure, { readOnly: true });
    assert.deepEqual([result.calls, result.attempts, result.value], [2, 2, "ok"], "read-only: succeeds on the second attempt");
  }
  // Write work never re-runs on connection loss or a recovery conflict.
  for (const failure of [wrapped(pgError("40001")), wrapped(new Error("Connection terminated unexpectedly"))]) {
    let calls = 0;
    await assert.rejects(retryTransient(async () => { calls++; throw failure; }, { sleep: noSleep }),
      error => error instanceof Error && "category" in error && error.category === "database_error" && "attempts" in error && error.attempts === 1);
    assert.equal(calls, 1);
  }
  // Lock/statement timeouts: still retried in every mode, still three attempts.
  assert.equal((await attemptsUntil(wrapped(pgError("55P03")), {})).attempts, 2);
  let lockCalls = 0;
  await assert.rejects(retryTransient(async () => { lockCalls++; throw wrapped(pgError("57014")); }, { readOnly: true, sleep: noSleep }), /after 3 attempts/);
  assert.equal(lockCalls, 3);
  // Non-transient: one attempt, the driver message never surfaces.
  let calls = 0;
  await assert.rejects(retryTransient(async () => { calls++; throw wrapped(pgError("23505")); }, { readOnly: true, sleep: noSleep }),
    error => error instanceof Error && error.message === "Database operation failed");
  assert.equal(calls, 1);
  // Exhaustion: five read-only attempts, with growing backoff.
  const delays: number[] = [];
  let replicaCalls = 0;
  await assert.rejects(retryTransient(async () => { replicaCalls++; throw wrapped(pgError("40001")); },
    { readOnly: true, sleep: async ms => { delays.push(ms); } }),
  error => error instanceof Error && "category" in error && error.category === "retry_exhausted" && /after 5 attempts/.test(error.message));
  assert.equal(replicaCalls, 5);
  assert.equal(delays.length, 4);
  assert.ok(delays.every((ms, i) => ms >= 500 * 2 ** i && ms <= Math.min(10_000, 1000 * 2 ** i)), `backoff ${delays.join(",")}`);
});

test("joint ops pool: an idle or checked-out client error is logged without crashing or leaking the message", () => {
  const pool = new pg.Pool({ connectionString: "postgresql://user:secret@127.0.0.1:1/none" });
  const lines: string[] = [];
  attachJointOpsConnectionErrorHandlers(pool, line => lines.push(line));
  assert.doesNotThrow(() => pool.emit("error", new Error("Connection terminated unexpectedly"), {} as pg.PoolClient));
  const client = new pg.Client();
  pool.emit("connect", client);
  assert.doesNotThrow(() => client.emit("error", Object.assign(new Error("terminating connection: password=secret"), { code: "57P01" })));
  assert.deepEqual(lines.map(line => JSON.parse(line)), [
    { event: "connection_error", source: "pool", sqlState: null, kind: "replica_or_connection" },
    { event: "connection_error", source: "client", sqlState: "57P01", kind: "replica_or_connection" }]);
  assert.ok(!lines.join("").includes("secret"));
  return pool.end();
});

test("joint source run receipt: skipped ids are bound; without them the digest is unchanged", () => {
  const base = { mode: "source-recovery-preview", after: null, through: null, joints: [{ jointId: "j1", digest: "d" }], failures: [] };
  assert.equal(jointSourceRunReceipt({ ...base, skipped: undefined }), jointSourceRunReceipt(base));
  assert.notEqual(jointSourceRunReceipt({ ...base, skipped: [] }), jointSourceRunReceipt(base));
  assert.notEqual(jointSourceRunReceipt({ ...base, skipped: ["j2"] }), jointSourceRunReceipt({ ...base, skipped: ["j3"] }));
  assert.equal(jointSourceRunReceipt({ ...base, skipped: ["j3", "j2"] }), jointSourceRunReceipt({ ...base, skipped: ["j2", "j3"] }));
});
