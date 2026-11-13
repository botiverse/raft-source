import assert from "node:assert/strict";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db";
import { jointChannelAdmissions, jointChannelMembers, serverMembers, servers } from "../db/schema";
import { removeHuman } from "../services/channelService";
import { ServerMemberRoleTransitionError, addMember, removeMember, transitionMemberRole } from "../services/serverService";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { connected } from "./jointHumanMembershipScenarios";
import { addHuman, createJointChannel } from "../services/channelService";
import type { createSeed } from "./integration/seed";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function untilBlocked(db: Database) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock(hashtextextended%' AND pid <> pg_backend_pid()`);
    if (Number(result.rows[0]?.n) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("second source mutation/backfill did not queue on the shared joint lock");
}
async function jointLockHeld(tx: DatabaseExecutor, jointId: string): Promise<boolean> {
  const lock = await tx.execute(sql`SELECT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
      AND classid = ((hashtextextended(${`joint-human-membership:${jointId}`}, 0) >> 32) & 4294967295)::oid
      AND objid = (hashtextextended(${`joint-human-membership:${jointId}`}, 0) & 4294967295)::oid
      AND objsubid = 1
  ) AS held`);
  return lock.rows[0]?.held === true;
}

export async function jointHumanMembershipConcurrency(f: { db: Database; seed: ReturnType<typeof createSeed> }) {
  const { db } = f;
  const x = await connected(f); const j = x.joint.jointChannel.id;
  const historicalSources: { serverId: string; generation: number }[] = [];
  const assertGone = async () => {
    const admissions = await db.select({ serverId: jointChannelAdmissions.serverId, generation: jointChannelAdmissions.generation })
      .from(jointChannelAdmissions)
      .where(and(eq(jointChannelAdmissions.jointChannelId, j), eq(jointChannelAdmissions.userId, x.peer.id)))
      .orderBy(asc(jointChannelAdmissions.generation), asc(jointChannelAdmissions.serverId));
    assert.deepEqual(admissions, [...historicalSources].sort((a, b) => a.generation - b.generation || a.serverId.localeCompare(b.serverId)),
      "revocation retains each source from every join episode");
    assert.equal((await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, j), eq(jointChannelMembers.userId, x.peer.id)))).length, 0, "last concurrent source removal must delete the member");
  };
  async function queued(first: (tx: DatabaseTransaction) => Promise<void>, second: () => Promise<void>) {
    const ready = deferred(), release = deferred(); let finished = false;
    const a = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      await first(tx);
      // removeMember uses getDb().transaction internally. The ambient adapter
      // joins it as a SAVEPOINT; prove its J lock survives the service return,
      // rather than silently relying on that adapter behavior for the barrier.
      assert.equal(await jointLockHeld(tx, j), true, "source service must retain this J lock on the outer backend until commit");
      ready.resolve(); await release.promise;
    });
    // Rejecting the first writer must fail the test instead of hanging on ready.
    await Promise.race([ready.promise, a.then(() => { throw new Error("first writer completed before barrier"); })]);
    const b = second().then(() => { finished = true; });
    try { await untilBlocked(db); assert.equal(finished, false); }
    finally { release.resolve(); await Promise.all([a, b]); }
  }
  for (const [generation, first, second] of [[1, x.joint.channel.id, x.target.id], [2, x.target.id, x.joint.channel.id]] as const) {
    await addHuman(x.joint.channel.id, x.peer.id); await addHuman(x.target.id, x.peer.id);
    // Rejoining after the last removal starts another episode through A; the
    // add through B finds a current member and records nothing. Audit rows
    // from the previous generation remain.
    historicalSources.push({ serverId: x.a.id, generation });
    await queued(async (tx) => { await removeHuman(first, x.peer.id, { self: true }, tx); }, async () => { await removeHuman(second, x.peer.id, { self: true }); });
    await assertGone();
  }
  await addHuman(x.joint.channel.id, x.peer.id);
  historicalSources.push({ serverId: x.a.id, generation: 3 });
  // Leaving B first keeps them in through A's identity; leaving A below then
  // takes them out (no connected identity left).
  await removeMember(x.b.id, x.peer.id);
  // Removal commits first: a queued join over every projection must re-read
  // after waiting, not apply an earlier preview of CH. This uses the
  // production removeMember service.
  await queued(async () => { await removeMember(x.a.id, x.peer.id); }, () => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    const mirror = await prepareJointHumanMembershipMirror(tx, { jointIds: [j] }, "join"); await mirror.apply();
  }));
  await assertGone();
}


/** The actual membership/role services must not take J locks for unrelated
 * people or joints. Inspect exact lock keys before their ambient commit. */
export async function jointHumanMembershipPersonScope(f: { db: Database; seed: ReturnType<typeof createSeed> }) {
  const { db, seed } = f; const x = await connected(f);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, x.a.id));
  const other = await createJointChannel({ hostServerId: x.a.id, createdByUserId: x.owner.id,
    name: "unrelated-joint", targetServerSlug: x.b.slug, invitedPeople: [`@${x.owner.name}`] });
  const j = x.joint.jointChannel.id, unrelated = other.jointChannel.id;
  const assertScope = async (tx: DatabaseExecutor, expected: boolean) => {
    assert.equal(await jointLockHeld(tx, j), expected, "only an actual source of the target person is locked");
    assert.equal(await jointLockHeld(tx, unrelated), false, "a server's other joint must stay unlocked");
  };
  await db.transaction(async tx => { await removeMember(x.a.id, x.peer.id); await assertScope(tx, true); });
  const absent = await seed.human(); await addMember(x.a.id, absent.id);
  await db.transaction(async tx => { await removeMember(x.a.id, absent.id); await assertScope(tx, false); });
  await addMember(x.a.id, x.peer.id); await addHuman(x.joint.channel.id, x.peer.id);
  // The real role service, on a legal change (no role change makes a Guest, #wg-rbac:#15).
  await db.transaction(async tx => {
    await transitionMemberRole({ serverId: x.a.id, actorUserId: x.owner.id, targetUserId: x.peer.id, nextRole: "admin" });
    await assertScope(tx, true);
  });
  const bystander = await seed.human(); await addMember(x.a.id, bystander.id);
  await db.transaction(async tx => {
    await transitionMemberRole({ serverId: x.a.id, actorUserId: x.owner.id, targetUserId: bystander.id, nextRole: "admin" });
    await assertScope(tx, false);
  });
  // Demotion to Guest is refused with no side effects.
  const state = async () => ({
    role: await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, x.a.id), eq(serverMembers.userId, x.peer.id))),
    admissions: await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, j), eq(jointChannelAdmissions.userId, x.peer.id))),
    members: await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, j), eq(jointChannelMembers.userId, x.peer.id))),
  });
  const before = await state();
  await assert.rejects(
    transitionMemberRole({ serverId: x.a.id, actorUserId: x.owner.id, targetUserId: x.peer.id, nextRole: "guest" }),
    (error: unknown) => error instanceof ServerMemberRoleTransitionError && error.code === "transition_forbidden",
  );
  assert.deepEqual(await state(), before, "a refused demotion changes no role, source or membership");
}
