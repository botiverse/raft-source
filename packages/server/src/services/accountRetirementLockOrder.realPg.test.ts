// Real-PostgreSQL proofs that account retirement (retireDueAccounts) takes
// every users row it names first, each once at its final strength, in
// users-id order (lockRetirementUsers, accountDeletion/cleanup.ts): the
// person's FOR UPDATE, the successors' and new agent owners' FOR KEY SHARE,
// before any server row. Before, a successor's row was taken only by the
// hand-over's FK checks (servers.owner_id, the role audit's target_user_id),
// after the person's servers FOR UPDATE.
//
// 1. Two retirements of co-owners (each the other's successor), both id
//    orders: one paused past its first server lock, the other seen waiting.
// 2. A retirement against its successor's own deletion request, both orders.
// 3. A retirement that promotes (the server has no other owner) against a
//    removal its successor makes on that server, both orders.
// Each must settle with no deadlock, after a real lock wait.
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { test } from "vitest";
import pg from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { serverMembers, servers, users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { retireDueAccounts } from "./accountDeletion/cleanup";
import { requestAccountDeletion } from "./accountDeletion/requests";
import { removeMember } from "./serverService";

type Settled<T = unknown> = { ok: true; value: T } | { ok: false; error: unknown };
const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
const start = <T>(run: () => Promise<T>): Promise<Settled<T>> => outside(async () => {
  assert.equal(isInTransaction(), false, "a competitor must not join another transaction");
  return run();
}).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) parts.push(e instanceof Error ? e.message : String(e));
  return parts.join(" <- ");
}
const lockWaiters = `SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;
async function waiting(observer: pg.Client) {
  const { rows } = await observer.query<{ n: number }>(lockWaiters);
  return Number(rows[0]?.n) > 0;
}
/** True once a backend waits on a lock (pg_stat_activity), false after `ms` without one. */
async function seenWaiting(observer: pg.Client, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await waiting(observer)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
const deadlocks = async (observer: pg.Client) => {
  await observer.query("SELECT pg_stat_clear_snapshot()");
  const { rows } = await observer.query<{ n: string }>("SELECT deadlocks::text n FROM pg_stat_database WHERE datname = current_database()");
  return Number(rows[0]?.n ?? 0);
};
async function assertNoDeadlockSince(observer: pg.Client, before: number, results: Record<string, Settled>) {
  for (const [name, result] of Object.entries(results)) {
    if (!result.ok && /deadlock|lock timeout|canceling statement/i.test(describeError(result.error))) assert.fail(`${name}: ${describeError(result.error)}`);
  }
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const now = await deadlocks(observer);
    assert.equal(now, before, `PostgreSQL detected ${now - before} deadlock(s): one side was rolled back`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withRealPg(label: string, body: (observer: pg.Client) => Promise<void>) {
  await withJointRealPgDatabase(label, async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: `${label}-observer` });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    try {
      await body(observer);
    } finally {
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}

/** Requested through the product path, due `minutesAgo` minutes ago (the earliest due retires first). */
async function requestDue(db: Database, userId: string, minutesAgo: number) {
  const requested = await requestAccountDeletion({ userId, source: "self", actorUserId: userId });
  assert.equal(requested.kind, "scheduled", JSON.stringify(requested));
  await db.execute(sql`UPDATE account_deletion_requests SET scheduled_for = now() - make_interval(mins => ${minutesAgo})
    WHERE user_id = ${userId}::uuid AND state = 'pending'`);
}
const retireOne = () => retireDueAccounts({ retirementsPerRun: 1 });

/** Two people, `first` with the lower users id when `order` is "lower-first". */
async function twoPeople(db: Database, order: "lower-first" | "higher-first") {
  const seed = createSeed(db);
  const [low, high] = [await seed.human(), await seed.human()].sort((a, b) => a.id.localeCompare(b.id));
  return { seed, ...(order === "lower-first" ? { x: low!, y: high! } : { x: high!, y: low! }) };
}
async function roleOf(db: Database, serverId: string, userId: string) {
  const [row] = await db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row?.role ?? null;
}
async function retiredIds(db: Database, ids: string[]) {
  return (await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), sql`${users.retiredAt} IS NOT NULL`))).map((row) => row.id).sort();
}

/** The hand-over's write of a successor as owner (servers.owner_id): the person's servers held FOR UPDATE. */
const atOwnerWrite = (text: string) => /^\s*update "servers" set "owner_id"/i.test(text);
/** promoteToOwner's role write (transitionMemberRoleInTransaction): the servers held FOR UPDATE. */
const atPromotion = (text: string) => /^\s*update "server_members" set "role"/i.test(text);

/**
 * `first` paused at `at` (its locks so far held), `second` started and, when
 * `expectWait`, seen waiting on a lock; then both settle with no deadlock.
 */
async function interleave<A, B>(observer: pg.Client, at: (text: string) => boolean, first: () => Promise<A>, second: () => Promise<B>,
  expectWait: boolean) {
  const before = await deadlocks(observer);
  const pause = pauseQuery((text) => at(text));
  try {
    const running = start(first);
    await pause.atPause;
    const other = start(second);
    const waited = await seenWaiting(observer, expectWait ? 10_000 : 1_000);
    if (expectWait) assert.ok(waited, "the second waited on a lock the first holds");
    pause.release();
    const results = { first: await running, second: await other };
    await assertNoDeadlockSince(observer, before, results);
    return { ...results, waited };
  } finally {
    pause.restore();
  }
}

// ── 1. Two retirements of co-owners ──

for (const order of ["lower-first", "higher-first"] as const) {
  test.skipIf(skipJointRealPg)(`two retirements of co-owners, each the other's successor (the first retiring has the ${order === "lower-first" ? "lower" : "higher"} users id): either settles`, async () => {
    await withRealPg(`ret_pair_${order.replace("-", "_")}`, async (observer) => {
      const db = getDb();
      const { seed, x, y } = await twoPeople(db, order);
      // S owned by X with Y a co-owner; U owned by Y with X a co-owner: each hand-over names the other.
      const s = await seed.server({ owner: x }), u = await seed.server({ owner: y });
      await db.insert(serverMembers).values([{ serverId: s.id, userId: y.id, role: "owner" }, { serverId: u.id, userId: x.id, role: "owner" }]);
      await requestDue(db, x.id, 2);
      await requestDue(db, y.id, 1);
      // X's retirement (due first) paused at S's new owner, past S FOR UPDATE; Y's retirement waits.
      const settled = await interleave(observer, atOwnerWrite, retireOne, retireOne, true);
      assert.ok(settled.first.ok, describeError(!settled.first.ok && settled.first.error));
      assert.ok(settled.second.ok, describeError(!settled.second.ok && settled.second.error));
      assert.deepEqual(await retiredIds(db, [x.id, y.id]), [x.id, y.id].sort(), "both retired");
    });
  }, 180_000);
}

// ── 2. A retirement against its successor's deletion request ──

for (const order of ["lower-first", "higher-first"] as const) {
  test.skipIf(skipJointRealPg)(`a retirement against its successor's deletion request (the retiring person has the ${order === "lower-first" ? "lower" : "higher"} users id), both orders: either settles`, async () => {
    await withRealPg(`ret_request_${order.replace("-", "_")}`, async (observer) => {
      const db = getDb();
      const world = async () => {
        const { seed, x, y } = await twoPeople(db, order);
        const co = await seed.human();
        // T: X's, Y a co-owner (reassigned). S: X's, Y an admin, co a co-owner until after X's request, so S's hand-over promotes Y.
        const t = await seed.server({ owner: x }), s = await seed.server({ owner: x });
        await db.insert(serverMembers).values([
          { serverId: t.id, userId: y.id, role: "owner" },
          { serverId: s.id, userId: y.id, role: "admin" },
          { serverId: s.id, userId: co.id, role: "owner" },
        ]);
        await requestDue(db, x.id, 1);
        await removeMember(s.id, co.id, { reason: "left", actorUserId: co.id });
        return { x, y, s, t };
      };
      const requestY = (y: { id: string }) => requestAccountDeletion({ userId: y.id, source: "self", actorUserId: y.id });

      // The retirement first, at S's promotion (X's row FOR UPDATE, Y's FOR KEY SHARE, S and T held): Y's request waits on Y's row.
      const a = await world();
      const retirementFirst = await interleave(observer, atPromotion, retireOne, () => requestY(a.y), true);
      assert.ok(retirementFirst.first.ok, describeError(!retirementFirst.first.ok && retirementFirst.first.error));
      assert.ok(retirementFirst.second.ok, describeError(!retirementFirst.second.ok && retirementFirst.second.error));
      assert.equal(await roleOf(db, a.s.id, a.y.id), "owner", "Y promoted");

      // Y's request first, holding Y's row FOR UPDATE (at its request insert); then X retires.
      const b = await world();
      const requestFirst = await interleave(observer, (text) => /^\s*insert into "account_deletion_requests"/i.test(text),
        () => requestY(b.y), retireOne, true);
      assert.ok(requestFirst.first.ok, describeError(!requestFirst.first.ok && requestFirst.first.error));
      assert.ok(requestFirst.second.ok, describeError(!requestFirst.second.ok && requestFirst.second.error));
      assert.deepEqual(await retiredIds(db, [b.x.id]), [b.x.id], "X retired");
      assert.equal(await roleOf(db, b.s.id, b.y.id), "owner", "Y promoted");
    });
  }, 180_000);
}

// ── 3. A promotion against a removal its successor makes ──

test.skipIf(skipJointRealPg)("a retirement that promotes the successor (no other owner) against the successor removing a member of that server, both orders: either settles", async () => {
  await withRealPg("ret_promote_removal", async (observer) => {
    const db = getDb();
    const world = async () => {
      const seed = createSeed(db);
      const x = await seed.human(), y = await seed.human(), co = await seed.human(), m = await seed.human();
      const s = await seed.server({ owner: x, members: [m] });
      await db.insert(serverMembers).values([{ serverId: s.id, userId: y.id, role: "admin" }, { serverId: s.id, userId: co.id, role: "owner" }]);
      await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, s.id));
      await requestDue(db, x.id, 1);
      await removeMember(s.id, co.id, { reason: "left", actorUserId: co.id });
      return { x, y, m, s };
    };
    const removeM = (w: Awaited<ReturnType<typeof world>>) => removeMember(w.s.id, w.m.id, { reason: "removed", actorUserId: w.y.id });

    // The retirement first, at the promotion (S FOR UPDATE held): the removal waits on S.
    const a = await world();
    const retirementFirst = await interleave(observer, atPromotion, retireOne, () => removeM(a), true);
    assert.ok(retirementFirst.first.ok, describeError(!retirementFirst.first.ok && retirementFirst.first.error));
    assert.ok(retirementFirst.second.ok, describeError(!retirementFirst.second.ok && retirementFirst.second.error));
    assert.deepEqual(await retiredIds(db, [a.x.id]), [a.x.id]);
    assert.equal(await roleOf(db, a.s.id, a.y.id), "owner", "Y promoted: the real promotion ran");
    assert.equal(await roleOf(db, a.s.id, a.m.id), null, "m removed");

    // The removal first, at its member delete (S FOR SHARE, m's row held): the retirement waits on S.
    const b = await world();
    const removalFirst = await interleave(observer, (text) => /^\s*delete from "server_members"/i.test(text), () => removeM(b), retireOne, true);
    assert.ok(removalFirst.first.ok, describeError(!removalFirst.first.ok && removalFirst.first.error));
    assert.ok(removalFirst.second.ok, describeError(!removalFirst.second.ok && removalFirst.second.error));
    assert.deepEqual(await retiredIds(db, [b.x.id]), [b.x.id]);
    assert.equal(await roleOf(db, b.s.id, b.y.id), "owner", "Y promoted: the real promotion ran");
  });
}, 180_000);
