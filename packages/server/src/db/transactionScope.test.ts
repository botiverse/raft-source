import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDb, getRootDb } from "./index";
import {
  afterAmbientCommit,
  afterAmbientTransaction,
  ExecutorOnlyDatabaseAccessError,
  isInTransaction,
  runExecutorOnly,
  recordExternalSinkInsideTransaction,
  installAuditedGlobalFetch,
  setSavepointDrainTimeoutMsForTests,
  setSavepointLeakReporter,
  SavepointDrainTimeoutError,
  type SavepointLeakReport,
} from "./ambientTransaction";
import { users } from "./schema";

// The open transaction is the ambient connection (db/index.ts scopeTransactions).
// Before it, each of these reads went to a second pool connection: it could not see
// the transaction's own uncommitted row, and on the single-connection test database
// it waited forever.

async function insertUser(executor: ReturnType<typeof getDb>, email: string) {
  const [row] = await executor.insert(users).values({ email, name: email, passwordHash: "x", emailVerified: true }).returning();
  return row;
}

test("inside a transaction, getDb() reads the transaction's own uncommitted rows", async ({ db: _db }) => {
  await getDb().transaction(async (tx) => {
    const user = await insertUser(tx as never, "scope-getdb@test.com");
    const [seen] = await getDb().select().from(users).where(eq(users.id, user.id));
    assert.equal(seen?.id, user.id);
  });
});

test("a root handle taken before the transaction joins it while it is open", async ({ db: _db }) => {
  const root = getDb();
  await root.transaction(async (tx) => {
    const user = await insertUser(tx as never, "scope-handle@test.com");
    const [seen] = await root.select().from(users).where(eq(users.id, user.id));
    assert.equal(seen?.id, user.id);
  });
});

test("a root transaction opened inside one is a savepoint of it", async ({ db: _db }) => {
  const root = getDb();
  let kept = "";
  await root.transaction(async (tx) => {
    kept = (await insertUser(tx as never, "scope-outer@test.com")).id;
    await assert.rejects(root.transaction(async (inner) => {
      await insertUser(inner as never, "scope-inner@test.com");
      throw new Error("roll back the savepoint only");
    }));
  });
  const emails = (await root.select({ email: users.email }).from(users)).map((row) => row.email);
  assert.ok(emails.includes("scope-outer@test.com"));
  assert.ok(!emails.includes("scope-inner@test.com"));
  assert.ok(kept);
});

test("the audit records a second-connection escape hatch but not the ambient redirect", async ({ db: _db }) => {
  const dir = mkdtempSync(join(tmpdir(), "tx-audit-"));
  const file = join(dir, "audit.txt");
  writeFileSync(file, "");
  const previous = process.env.RAFT_TX_POOL_AUDIT_FILE;
  process.env.RAFT_TX_POOL_AUDIT_FILE = file;
  try {
    await getDb().transaction(async (tx) => {
      // The ambient redirect is NOT a second connection: getDb() joins the open
      // transaction, so it must not be recorded.
      await insertUser(tx as never, "audit-ambient@test.com");
      await getDb().select().from(users).where(eq(users.name, "audit-ambient@test.com"));
      // getRootDb() is the deliberate escape hatch: merely resolving it records a
      // second-connection use. (Calling it does NOT run a query, so this does not
      // deadlock the single-connection test DB the way an actual root query would.)
      getRootDb();
    });
    const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { source?: string });
    assert.equal(entries.length, 1, "exactly one second-connection use inside the transaction");
    assert.equal(entries[0].source, "getRootDb");
  } finally {
    if (previous === undefined) delete process.env.RAFT_TX_POOL_AUDIT_FILE;
    else process.env.RAFT_TX_POOL_AUDIT_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external-sink audit records only inside a transaction", async ({ db: _db }) => {
  const dir = mkdtempSync(join(tmpdir(), "tx-sink-audit-"));
  const file = join(dir, "audit.txt");
  writeFileSync(file, "");
  const previous = process.env.RAFT_TX_POOL_AUDIT_FILE;
  process.env.RAFT_TX_POOL_AUDIT_FILE = file;
  try {
    // Outside a transaction: isInTransaction is false and no HIT is recorded.
    assert.equal(isInTransaction(), false);
    assert.equal(recordExternalSinkInsideTransaction("risingwave"), false);

    // Inside a transaction: isInTransaction is true and the sink is recorded.
    await getDb().transaction(async (tx) => {
      assert.equal(isInTransaction(), true);
      assert.equal(recordExternalSinkInsideTransaction("risingwave"), true);
      assert.equal(recordExternalSinkInsideTransaction("redis"), true);
      await insertUser(tx as never, "sink-audit@test.com");
    });

    const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Hits are `{ source, stack }`; `{ armed }` records are provenance, not hits.
    const hitSources = entries.filter((e) => typeof e.source === "string").map((e) => e.source);
    assert.deepEqual(hitSources.sort(), ["redis", "risingwave"], "only the in-tx sink uses record hits");
    assert.ok(entries.some((e) => e.armed === "risingwave"), "the out-of-tx call still marks the sink armed");
  } finally {
    if (previous === undefined) delete process.env.RAFT_TX_POOL_AUDIT_FILE;
    else process.env.RAFT_TX_POOL_AUDIT_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audited global fetch records a fetch inside a transaction", async ({ db: _db }) => {
  const dir = mkdtempSync(join(tmpdir(), "tx-fetch-audit-"));
  const file = join(dir, "audit.txt");
  writeFileSync(file, "");
  const previous = process.env.RAFT_TX_POOL_AUDIT_FILE;
  process.env.RAFT_TX_POOL_AUDIT_FILE = file;
  // Install the audited global fetch (idempotent). The wrapper records the
  // source before delegating, so a refused connection still leaves a hit.
  installAuditedGlobalFetch();
  try {
    await getDb().transaction(async (tx) => {
      await insertUser(tx as never, "fetch-audit@test.com");
      await globalThis.fetch("http://127.0.0.1:9/").catch(() => undefined);
    });
    const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(entries.some((e) => e.source === "fetch"), "a fetch inside the transaction must be recorded");
    // The ambient redirect (getDb() in the transaction) is NOT a hit.
    assert.ok(!entries.some((e) => e.source === "getRootDb"));
  } finally {
    if (previous === undefined) delete process.env.RAFT_TX_POOL_AUDIT_FILE;
    else process.env.RAFT_TX_POOL_AUDIT_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Prod 2026-10-13: ~2,200 RELEASE SAVEPOINT 25P01 a day. A root transaction
// started by work the outer callback does not await joins the outer as a
// savepoint; the outer used to COMMIT and release its client under it.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function emailsInDb(): Promise<string[]> {
  return (await getRootDb().select({ email: users.email }).from(users)).map((row) => row.email);
}

async function withCapturedLeakReports<T>(work: (reports: SavepointLeakReport[]) => Promise<T>): Promise<T> {
  const reports: SavepointLeakReport[] = [];
  const previous = setSavepointLeakReporter((report) => reports.push(report));
  try {
    return await work(reports);
  } finally {
    setSavepointLeakReporter(previous);
  }
}

test("an un-awaited nested transaction finishes inside the outer before it commits", async ({ db: _db }) => {
  await withCapturedLeakReports(async (reports) => {
    const root = getDb();
    const order: string[] = [];
    let detached!: Promise<unknown>;
    await root.transaction(async (tx) => {
      await insertUser(tx as never, "drain-outer@test.com");
      detached = root.transaction(async (inner) => {
        await sleep(50);
        await insertUser(inner as never, "drain-inner@test.com");
        order.push("inner done");
      });
      order.push("outer callback returned");
    });
    order.push("outer committed");
    await detached;

    assert.deepEqual(order, ["outer callback returned", "inner done", "outer committed"]);
    const emails = await emailsInDb();
    assert.ok(emails.includes("drain-outer@test.com"));
    assert.ok(emails.includes("drain-inner@test.com"));
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report?.kind, "outer_finished_with_open_savepoints");
    if (report?.kind !== "outer_finished_with_open_savepoints") return;
    assert.equal(report.outcome, "drained");
    assert.equal(report.openSavepointStacks.length, 1);
    assert.match(report.openSavepointStacks[0]!, /transactionScope\.test\.ts/);
  });
});

test("an un-awaited nested transaction rolls back with the outer when the outer fails", async ({ db: _db }) => {
  await withCapturedLeakReports(async () => {
    const root = getDb();
    let detached!: Promise<unknown>;
    await assert.rejects(root.transaction(async (tx) => {
      await insertUser(tx as never, "fail-outer@test.com");
      detached = root.transaction(async (inner) => {
        await sleep(30);
        await insertUser(inner as never, "fail-inner@test.com");
      });
      throw new Error("outer fails");
    }), /outer fails/);
    await detached;
    const emails = await emailsInDb();
    assert.ok(!emails.includes("fail-outer@test.com"));
    assert.ok(!emails.includes("fail-inner@test.com"));
  });
});

test("a root transaction opened once the outer is finishing, or after it, runs as its own transaction", async ({ db: _db }) => {
  await withCapturedLeakReports(async (reports) => {
    const root = getDb();
    let whileFinishing!: Promise<unknown>;
    let afterCommit!: Promise<unknown>;
    await root.transaction(async (tx) => {
      await insertUser(tx as never, "own-outer@test.com");
      // Keeps the outer draining for ~80ms.
      void root.transaction(async () => { await sleep(80); });
      whileFinishing = (async () => {
        await sleep(20);
        return root.transaction(async (own) => { await insertUser(own as never, "own-finishing@test.com"); });
      })();
      afterCommit = (async () => {
        await sleep(200);
        return root.transaction(async (own) => { await insertUser(own as never, "own-after@test.com"); });
      })();
    });
    await Promise.all([whileFinishing, afterCommit]);

    const emails = await emailsInDb();
    assert.ok(emails.includes("own-finishing@test.com"));
    assert.ok(emails.includes("own-after@test.com"));
    assert.deepEqual(reports.map((r) => r.kind).sort(), [
      "outer_finished_with_open_savepoints",
      "transaction_while_outer_finishing",
    ]);
  });
});

test("an awaited nested transaction behaves as before and is not reported", async ({ db: _db }) => {
  await withCapturedLeakReports(async (reports) => {
    const root = getDb();
    await root.transaction(async (tx) => {
      await insertUser(tx as never, "awaited-outer@test.com");
      await root.transaction(async (inner) => { await insertUser(inner as never, "awaited-inner@test.com"); });
    });
    const emails = await emailsInDb();
    assert.ok(emails.includes("awaited-outer@test.com"));
    assert.ok(emails.includes("awaited-inner@test.com"));
    assert.deepEqual(reports, []);
  });
});

test("the outer rolls back when an un-awaited savepoint outlasts the drain timeout", async ({ db: _db }) => {
  const previousTimeout = setSavepointDrainTimeoutMsForTests(30);
  try {
    await withCapturedLeakReports(async (reports) => {
      const root = getDb();
      let detached!: Promise<unknown>;
      await assert.rejects(root.transaction(async (tx) => {
        await insertUser(tx as never, "timeout-outer@test.com");
        detached = root.transaction(async () => { await sleep(150); });
      }), SavepointDrainTimeoutError);
      await detached.catch(() => undefined);
      assert.ok(!(await emailsInDb()).includes("timeout-outer@test.com"));
      const finished = reports.find((r) => r.kind === "outer_finished_with_open_savepoints");
      assert.equal(finished?.kind === "outer_finished_with_open_savepoints" && finished.outcome, "timed_out");
    });
  } finally {
    setSavepointDrainTimeoutMsForTests(previousTimeout);
  }
});

test("afterAmbientTransaction work runs after the commit, outside the transaction, and sees its rows", async ({ db: _db }) => {
  const root = getDb();
  const seen: Array<{ inTx: boolean; committed: boolean }> = [];
  let userId = "";
  await root.transaction(async (tx) => {
    userId = (await insertUser(tx as never, "after-commit@test.com")).id;
    afterAmbientTransaction(() => {
      seen.push({ inTx: isInTransaction(), committed: false });
    });
    assert.deepEqual(seen, []);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.inTx, false);
  const [row] = await getRootDb().select().from(users).where(eq(users.id, userId));
  assert.ok(row);

  const now: boolean[] = [];
  afterAmbientTransaction(() => now.push(isInTransaction()));
  assert.deepEqual(now, [false]);

  const afterRollback: boolean[] = [];
  await assert.rejects(root.transaction(async () => {
    afterAmbientTransaction(() => afterRollback.push(isInTransaction()));
    throw new Error("roll back");
  }));
  assert.deepEqual(afterRollback, [false]);
});

test("afterAmbientCommit work runs once per key after the commit, outside it; nothing after a rollback", async ({ db: _db }) => {
  const root = getDb();
  const ran: Array<{ key: string; inTx: boolean }> = [];
  const note = (key: string) => () => ran.push({ key, inTx: isInTransaction() });
  await root.transaction(async () => {
    afterAmbientCommit("a", note("a"));
    // A savepoint registers on the outer transaction; the same key again is dropped.
    await root.transaction(async () => { afterAmbientCommit("a", note("a-again")); afterAmbientCommit("b", note("b")); });
    assert.deepEqual(ran, [], "nothing while the transaction is open");
  });
  assert.deepEqual(ran, [{ key: "a", inTx: false }, { key: "b", inTx: false }]);

  ran.length = 0;
  afterAmbientCommit("now", note("now"));
  assert.deepEqual(ran, [{ key: "now", inTx: false }], "with no transaction open it runs now");

  ran.length = 0;
  await assert.rejects(root.transaction(async () => {
    afterAmbientCommit("rolled-back", note("rolled-back"));
    throw new Error("roll back");
  }));
  assert.deepEqual(ran, [], "a rolled-back transaction runs none of it");
});

test("a failing statement swallowed in a savepoint leaves the transaction usable; swallowed bare, it aborts it", async ({ db: _db }) => {
  // The rule behind the 10-15 fixes: inside a transaction, a caught DB error is
  // only safe to continue past if the statement ran in a savepoint.
  const root = getDb();
  await root.transaction(async (tx) => {
    await root.transaction(async (savepoint) => {
      await savepoint.execute(sql`select 1 / 0`);
    }).catch(() => undefined);
    const [row] = await tx.execute(sql`select 1 as ok`).then((result) => result.rows as Array<{ ok: number }>);
    assert.equal(Number(row?.ok), 1);
  });

  await assert.rejects(root.transaction(async (tx) => {
    await tx.execute(sql`select 1 / 0`).catch(() => undefined);
    await tx.execute(sql`select 1`);
  }), (error: unknown) => {
    const code = (error as { code?: string; cause?: { code?: string } }).code
      ?? (error as { cause?: { code?: string } }).cause?.code;
    return code === "25P02";
  });
});

test("runExecutorOnly: inside it the root database is off limits (the ambient transaction too); the handed executor works", async ({ db: _db }) => {
  const root = getDb();
  const ran: string[] = [];
  await root.transaction(async (tx) => {
    const user = await insertUser(tx as never, "executor-only@test.com");
    const answer = await runExecutorOnly("the test section", async () => {
      // The executor it was handed: the transaction, its own uncommitted row included.
      const [seen] = await tx.select().from(users).where(eq(users.id, user.id));
      assert.equal(seen?.id, user.id);
      assert.equal(isInTransaction(), true);
      // getDb(), a handle taken earlier, a transaction of the root, the escape hatch: all refused.
      const refused = (error: unknown) => error instanceof ExecutorOnlyDatabaseAccessError && error.section === "the test section";
      assert.throws(() => getDb().select(), refused);
      assert.throws(() => root.insert(users), refused);
      assert.throws(() => getDb().transaction(async () => undefined), refused);
      assert.throws(() => getRootDb(), refused);
      // In what it awaits as well, however deep.
      await assert.rejects((async () => {
        await Promise.resolve();
        return getDb().select().from(users);
      })(), /the test section may use the database only through the executor it is handed, not getDb\(\)\.select/);
      // The outer transaction's own bookkeeping is shared.
      afterAmbientTransaction(() => ran.push("after"));
      return "done";
    });
    assert.equal(answer, "done");
    assert.deepEqual(ran, [], "registered inside the section, run with the outer transaction");
    // Past the section the ambient transaction is back.
    const [again] = await getDb().select().from(users).where(eq(users.id, user.id));
    assert.equal(again?.id, user.id);
  });
  assert.deepEqual(ran, ["after"]);
});

test("runExecutorOnly with no transaction open refuses the root too, and only inside", async ({ db: _db }) => {
  await assert.rejects(runExecutorOnly("a section", async () => getDb().select().from(users)), ExecutorOnlyDatabaseAccessError);
  await runExecutorOnly("a section", async () => {
    assert.equal(isInTransaction(), false);
    let ranNow = false;
    afterAmbientTransaction(() => { ranNow = true; });
    assert.equal(ranNow, true, "no transaction: run at once");
  });
  assert.equal((await getDb().select().from(users).limit(1)).length >= 0, true);
});
