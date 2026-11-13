// Real-PostgreSQL proof for joint source exit (joint_source_exit_v1): the
// activation preflight and the writers that end or add sources serialize, so a
// flag change never leaves a member silently source-less and a departure's
// frozen decision never races a source insertion. PGlite runs one transaction
// at a time, so only independent backends can show the second writer waiting.
//
// Each case holds the first writer's transaction open, starts the competitor
// outside every ambient transaction (`outside`), and proves it is a different
// backend waiting on an advisory lock held by the first one's PID before the
// first commits.
//
// Runs in `test:joint-source-preview-real-pg` on a random database created
// from JOINT_SOURCE_PREVIEW_REAL_PG_URL (test/jointRealPgDatabase.ts).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { test } from "vitest";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { jointChannelMembers, jointMembershipRemovals, jointMembershipDepartures } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { setJointFlags, sourceExitJoint } from "../test/jointSourceExitScenario";
import { disconnectJointChannel } from "./channelService";
import { evaluateFeatureFlag, getFeatureFlagConfigVersion } from "./featureFlagService";
import { recordOrdinaryJointAdmissions } from "./jointAdmissionKind";
import { acquireJointSourceExitFlagReadLock, JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY } from "./jointHumanMembershipAccess";
import { activateJointSourceExit, JointSourceExitActivationRefusedError } from "./jointSourceExitActivation";
import { removeMember } from "./serverService";

async function advisoryWaiter(observer: pg.Client, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(`SELECT a.pid FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted AND l.locktype = 'advisory'
      WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND a.wait_event = 'advisory'
        AND $1 = ANY(pg_blocking_pids(a.pid))`, [blockerPid]);
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected a backend waiting on an advisory lock held by ${blockerPid}`);
}

/** Bound at module load, outside every transaction: a competitor started
 * through it gets its own backend instead of joining a held transaction. */
const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());

/** Runs `first` in a transaction held open until `competitor` (started outside
 * it) is proven to wait on an advisory lock this backend holds. */
async function heldThen<T>(observer: pg.Client, first: () => Promise<void>, competitor: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let holderPid = 0;
  let holding!: () => void;
  const isHolding = new Promise<void>((resolve) => { holding = resolve; });
  const held = getDb().transaction(async (tx) => {
    holderPid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
    await first();
    holding();
    await released;
  });
  await Promise.race([isHolding, held.then(() => { throw new Error("first writer finished before holding"); })]);
  const second = outside(async () => {
    assert.equal(isInTransaction(), false, "the competitor must not join the held transaction");
    return competitor();
  });
  const settled = second.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
  try {
    const waiter = await advisoryWaiter(observer, holderPid);
    assert.notEqual(waiter, holderPid);
  } finally {
    release();
    await held;
  }
  return settled;
}

test.skipIf(skipJointRealPg)("source exit: activation, last-source leave and source insertion serialize with departures", async () => {
  await withJointRealPgDatabase("joint_source_exit", async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: "jse-observer" });
    observer.on("error", () => {});
    await observer.connect();
    const f = { db: getDb(), seed: createSeed(getDb()) };
    const { db } = f;
    try {
      const activate = async (hostServerId: string, actorId: string) => activateJointSourceExit({ hostServerIds: [hostServerId],
        expectedConfigVersion: await getFeatureFlagConfigVersion(), actor: { type: "human", id: actorId } });
      const sourceExitOn = async (serverId: string) => (await evaluateFeatureFlag({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId }, db)).enabled;

      // 1. The last-source leave holds its locks first (flag off, old rule:
      // the person stays without a source). Activation waits, then sees that
      // member and refuses; it never turns the flag on over them.
      await setJointFlags(db, false);
      const x1 = await sourceExitJoint(f, "jse-leave-first");
      const p1 = await x1.viaB();
      const refused = await heldThen(observer, () => removeMember(x1.b.id, p1.id, { reason: "left" }).then(() => {}),
        () => activate(x1.h.id, x1.hostOwner.id));
      assert.equal(refused.status, "rejected");
      assert.ok(refused.status === "rejected" && refused.reason instanceof JointSourceExitActivationRefusedError, String(refused.status === "rejected" && refused.reason));
      assert.ok(await x1.member(p1.id), "the old-rule leave kept the source-less member");
      assert.equal(await sourceExitOn(x1.h.id), false, "activation refused over them");

      // 2. Activation holds the exclusive lock first; the leave waits and then
      // runs under the new rule: the person leaves J instead of staying source-less.
      const x2 = await sourceExitJoint(f, "jse-activation-first");
      const p2 = await x2.viaB();
      const left = await heldThen(observer, () => activate(x2.h.id, x2.hostOwner.id).then(() => {}),
        () => removeMember(x2.b.id, p2.id, { reason: "left" }));
      assert.equal(left.status, "fulfilled", String(left.status === "rejected" && left.reason));
      assert.equal(await sourceExitOn(x2.h.id), true);
      assert.equal(await x2.member(p2.id), undefined, "the leave that waited applied source exit");
      assert.equal((await x2.jointAudit(p2.id)).length, 1);

      // A source writer with the membership writers' discipline: both flags,
      // then J, then a source of the person's current generation.
      const addHostSource = (jointId: string, userId: string, hostServerId: string) => getDb().transaction(async (tx) => {
        await acquireJointSourceExitFlagReadLock(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${jointId}`},0))`);
        await recordOrdinaryJointAdmissions(tx, sql`SELECT m.joint_channel_id,m.user_id,${hostServerId}::uuid AS server_id,m.generation,
            now() AS admitted_at,NULL::uuid AS admitted_by
          FROM joint_channel_members m WHERE m.joint_channel_id=${jointId}::uuid AND m.user_id=${userId}::uuid`);
      });
      const removal = async (localChannelId: string, userId: string) => {
        const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, localChannelId));
        return (await db.select().from(jointMembershipRemovals).where(and(eq(jointMembershipRemovals.departureId, departure!.id),
          eq(jointMembershipRemovals.userId, userId))))[0];
      };

      // 3. A fresh source wins J first: the departure's snapshot sees it and
      // keeps the person (entry-only).
      await setJointFlags(db, true);
      const x3 = await sourceExitJoint(f, "jse-source-first");
      const p3 = await x3.viaB();
      const disconnected = await heldThen(observer, () => addHostSource(x3.J, p3.id, x3.h.id),
        () => disconnectJointChannel(x3.bLocal, x3.peerOwner.id));
      assert.equal(disconnected.status, "fulfilled", String(disconnected.status === "rejected" && disconnected.reason));
      assert.equal((await removal(x3.bLocal, p3.id))?.removeMembership, false, "the source that won J keeps the person");
      assert.ok(await x3.member(p3.id));

      // 4. The departure wins J first: its frozen decision removes the person,
      // and the waiting source writer finds no current episode to add to.
      const x4 = await sourceExitJoint(f, "jse-departure-first");
      const p4 = await x4.viaB();
      const added = await heldThen(observer, () => disconnectJointChannel(x4.bLocal, x4.peerOwner.id).then(() => {}),
        () => addHostSource(x4.J, p4.id, x4.h.id));
      assert.equal(added.status, "fulfilled", String(added.status === "rejected" && added.reason));
      assert.equal((await removal(x4.bLocal, p4.id))?.removeMembership, true);
      assert.equal((await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x4.J),
        eq(jointChannelMembers.userId, p4.id)))).length, 0, "a later source insertion never undoes the departure");
    } finally {
      await observer.end();
      await app.close();
    }
  });
}, 120_000);
