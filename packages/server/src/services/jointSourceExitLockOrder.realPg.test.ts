// Real-PostgreSQL lock-order proofs for joint source exit. One canonical order:
// identity/resource rows (servers, server_members, agent members, channel and
// projection rows, bound Guests' member rows) -> source-exit flag shared lock
// -> J. Activation holds nothing before its exclusive flag lock except the
// flag writers' config-version lock, which no membership writer takes.
//
// 1. A server leave holding the person's server_members row (A), a channel
//    write through lockComputedJointActor needing that row (B), and activation
//    queued for the flag's exclusive lock (C). With B pinning the flag before
//    its row locks, A's flag request queues behind C, C behind B, B behind A:
//    a deadlock. With the flag after the rows, all three complete.
// 2. A departure cleanup batch (whose audit row references the departed
//    server) against deleting that server (servers FOR UPDATE, then J). The
//    batch must lock the server row before J, not through its audit INSERT.
//
// Each competitor is started outside every ambient transaction and shown
// waiting on a lock before the paused holder resumes. A failure on the old
// order shows up as `deadlock detected` / `lock timeout` (or, in case 1, as
// activation queued behind the channel writer).
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { test } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { jointChannelMembers, jointMembershipDepartures } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { setJointFlags, sourceExitJoint } from "../test/jointSourceExitScenario";
import { withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import { disconnectJointChannel, removeHuman } from "./channelService";
import { getFeatureFlagConfigVersion } from "./featureFlagService";
import { activateJointSourceExit } from "./jointSourceExitActivation";
import { cleanJointMembershipDepartureBatch, configureJointDepartureEffects, JOINT_DEPARTURE_BATCH_SIZE, type JointMembershipDepartureId } from "./jointMembershipDeparture";
import { deleteServer, removeMember } from "./serverService";

const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
const start = <T>(run: () => Promise<T>) => {
  const promise = outside(async () => {
    assert.equal(isInTransaction(), false, "a competitor must not join another transaction");
    return run();
  });
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
};
type Settled = Awaited<ReturnType<typeof start>>;

async function until(observer: pg.Client, what: string, sqlText: string, done?: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done?.()) return;
    const { rows } = await observer.query<{ n: number }>(sqlText);
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waiting = (queryLike: string, waitEvent?: string) => `SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' ${waitEvent ? `AND wait_event = '${waitEvent}'` : ""}
    AND query ILIKE '${queryLike}' AND cardinality(pg_blocking_pids(pid)) > 0`;

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) parts.push(e instanceof Error ? e.message : String(e));
  return parts.join(" <- ");
}
function assertNoLockFailure(results: Record<string, Settled>) {
  for (const [name, result] of Object.entries(results)) {
    if (result.ok) continue;
    const text = describeError(result.error);
    assert.doesNotMatch(text, /deadlock detected|lock timeout|canceling statement due to lock timeout/i, `${name} failed on a lock cycle: ${text}`);
  }
}

test.skipIf(skipJointRealPg)("source exit: leave holding SM, channel write and activation never form a lock cycle", async () => {
  await withJointRealPgDatabase("joint_source_exit_actor_order", async (url) => {
    // The A -> C -> B -> A cycle has a soft edge (A waits for C only by queue
    // order), which PostgreSQL's deadlock checker can resolve by reordering the
    // queue once deadlock_timeout passes. The writers' own lock_timeout is 2s;
    // with deadlock_timeout above it (as on a server tuned that way) the old
    // order surfaces as A's lock timeout instead of a 1s stall. Model that.
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    await setup.query(`ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET deadlock_timeout = '5s'`);
    await setup.end();
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: "jse-order-observer" });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    let pause: ReturnType<typeof pauseQuery> | undefined;
    try {
      const f = { db: getDb(), seed: createSeed(getDb()) };
      await setJointFlags(f.db, false);
      const x = await sourceExitJoint(f, "jse-actor-order");
      const person = await x.viaB();
      const versionBefore = await getFeatureFlagConfigVersion();

      // A: the real server leave, paused at its first flag request, holding
      // servers FOR SHARE and the person's server_members row FOR UPDATE.
      pause = pauseQuery((text) => text.includes("pg_advisory_xact_lock_shared"));
      const a = start(() => removeMember(x.b.id, person.id, { reason: "left" }));
      await pause.atPause;
      // B: a channel write through lockComputedJointActor, needing that row.
      const b = start(() => withLockedChannelActorCapability({ serverId: x.b.id, channelId: x.bLocal, actorType: "user",
        actorId: x.peerOwner.id, capability: "removeChannelMembers", humanSubjectIds: [person.id] },
      (tx, context) => removeHuman(x.bLocal, person.id, context, tx)));
      await until(observer, "the channel write to wait for the leave's server_members row", waiting("%server_members%FOR SHARE%"));
      // C: activation, queued for the exclusive lock or already through it.
      let cDone = false;
      const c = start(async () => activateJointSourceExit({ hostServerIds: [x.h.id], expectedConfigVersion: versionBefore,
        actor: { type: "human", id: x.hostOwner.id } })).then((result) => { cDone = true; return result; });
      await until(observer, "activation to queue or finish", waiting("%pg_advisory_xact_lock(%", "advisory"), () => cDone);
      // The channel write waits for a row while holding no source-exit lock,
      // so activation is never queued behind it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(cDone, true, "activation must not wait for a channel writer that is itself waiting for a row lock");
      pause.release();
      const results = { leave: await a, channelWrite: await b, activation: await c };
      assertNoLockFailure(results);
      assert.ok(results.leave.ok, describeError(!results.leave.ok && results.leave.error));
      assert.ok(results.activation.ok, describeError(!results.activation.ok && results.activation.error));
    } finally {
      pause?.restore();
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("departure cleanup locks the departed server before J, so deleting that server cannot deadlock it", async () => {
  await withJointRealPgDatabase("joint_source_exit_delete_order", async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    // Drive the cleanup batch by hand; no post-commit kick.
    configureJointDepartureEffects(null);
    const observer = new pg.Client({ connectionString: url, application_name: "jse-delete-observer" });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    let pause: ReturnType<typeof pauseQuery> | undefined;
    try {
      const f = { db: getDb(), seed: createSeed(getDb()) };
      await setJointFlags(f.db, true);
      const x = await sourceExitJoint(f, "jse-delete-order");
      const people = await x.seedViaB(JOINT_DEPARTURE_BATCH_SIZE + 1);
      await disconnectJointChannel(x.bLocal, x.peerOwner.id);
      const [departure] = await f.db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, x.bLocal));

      // The worker, paused at its audit INSERT: it holds the departure row, J
      // and its uncommitted removals.
      pause = pauseQuery((text) => /^\s*insert into "integration_audit_events"/i.test(text));
      const worker = start(() => cleanJointMembershipDepartureBatch(departure!.id as JointMembershipDepartureId, { revoke: async () => {} }));
      await pause.atPause;
      const deletion = start(() => deleteServer(x.b.id, { deletedByUserId: x.peerOwner.id }));
      await until(observer, "the deletion to wait on the worker", `SELECT count(*)::int n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`);
      pause.release();
      const results = { worker: await worker, deletion: await deletion };
      assertNoLockFailure(results);
      assert.ok(results.worker.ok, describeError(!results.worker.ok && results.worker.error));
      assert.ok(results.deletion.ok, describeError(!results.deletion.ok && results.deletion.error));
      while (!await cleanJointMembershipDepartureBatch(departure!.id as JointMembershipDepartureId, { revoke: async () => {} }));
      const left = await f.db.select().from(jointChannelMembers).where(eq(jointChannelMembers.jointChannelId, x.J));
      assert.ok(people.every((person) => !left.some((row) => row.userId === person.id)), "the frozen removals completed");
    } finally {
      pause?.restore();
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}, 120_000);
