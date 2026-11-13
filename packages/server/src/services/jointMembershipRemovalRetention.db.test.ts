import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { dbTest } from "../test/integration/dbTest";
import type { Database } from "../db";
import { jointChannelMembers, jointMembershipDepartures, jointMembershipRemovals } from "../db/schema";
import { acceptJointChannelInvite, addHuman, canUserAccessChannel, createJointChannel, disconnectJointChannel } from "./channelService";
import { addMember } from "./serverService";
import { cleanJointMembershipDepartureBatch, type JointMembershipDepartureId } from "./jointMembershipDeparture";
import {
  filterJointPendingRemovalEntries,
  jointMembershipRemovalPendingSql,
  resolveJointHumanMembershipScopes,
} from "./jointHumanMembershipAccess";
import { JOINT_MEMBERSHIP_REMOVAL_RETENTION_DAYS, pruneCompletedJointMembershipRemovals } from "./jointMembershipRemovalRetention";
import type { createSeed } from "../test/integration/seed";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A computed joint hosted by A and connected to B; `person` is only in B and
 * joined through B's copy. B disconnects, and its departure's cleanup runs to
 * completion.
 */
async function completedDeparture({ db, seed }: Fixture) {
  const hostOwner = await seed.human();
  const peerOwner = await seed.human();
  const person = await seed.human();
  const a = await seed.server({ owner: hostOwner });
  const b = await seed.server({ owner: peerOwner, members: [person] });
  const created = await createJointChannel({
    hostServerId: a.id, createdByUserId: hostOwner.id, name: "removal-history", targetServerSlug: b.slug,
    invitedPeople: [`@${peerOwner.name}`],
  });
  const target = await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id });
  await addHuman(target.id, person.id);
  await disconnectJointChannel(target.id, peerOwner.id);
  const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, target.id));
  assert.ok(departure);
  const id = departure.id as JointMembershipDepartureId;
  for (let i = 0; i < 5 && !(await cleanJointMembershipDepartureBatch(id, { revoke: async () => {} })); i++);
  return { hostOwner, peerOwner, person, a, b, hostCopy: created.channel, jointId: created.jointChannel.id, departureId: id };
}

async function removalRows(db: Database, departureIds: string[]) {
  return db.select().from(jointMembershipRemovals).where(inArray(jointMembershipRemovals.departureId, departureIds));
}

/** Backdate a departure's completion and its rows', as if it completed `daysAgo` days before now. */
async function completedDaysAgo(db: Database, departureId: string, daysAgo: number | null, rowsDaysAgo: number) {
  const at = (days: number) => new Date(Date.now() - days * DAY_MS);
  await db.update(jointMembershipDepartures).set({ completedAt: daysAgo === null ? null : at(daysAgo) }).where(eq(jointMembershipDepartures.id, departureId));
  await db.update(jointMembershipRemovals).set({ completedAt: at(rowsDaysAgo) }).where(eq(jointMembershipRemovals.departureId, departureId));
}

dbTest("a completed disconnect keeps who it removed, denies nobody, and lets the person rejoin", async ({ db, seed }) => {
  const x = await completedDeparture({ db, seed });
  const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.id, x.departureId));
  assert.ok(departure?.completedAt, "the departure's cleanup completed");

  const rows = await removalRows(db, [x.departureId]);
  assert.deepEqual(rows.map((row) => row.userId).sort(), [x.peerOwner.id, x.person.id].sort(), "who the disconnect removed is kept");
  assert.ok(rows.every((row) => row.removeMembership && row.membershipRemovedAt && row.completedAt), "each row is marked completed");

  // Nobody is pending removal any more: the SQL guard, the entry filter and the join check.
  for (const userId of [x.peerOwner.id, x.person.id]) {
    const pending = await db.execute<{ pending: boolean }>(sql`SELECT ${jointMembershipRemovalPendingSql(sql`${x.jointId}::uuid`, "user", sql`${userId}::uuid`)} AS pending`);
    assert.equal(pending.rows[0]?.pending, false);
  }
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [x.hostCopy.id] }, db)).get(x.hostCopy.id);
  assert.ok(scope);
  assert.equal((await filterJointPendingRemovalEntries([scope], "user", x.person.id, db)).size, 0);

  // The person joins A and rejoins the joint through A's copy.
  await addMember(x.a.id, x.person.id);
  await addHuman(x.hostCopy.id, x.person.id);
  assert.equal((await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.jointId), eq(jointChannelMembers.userId, x.person.id)))).length, 1);
  assert.equal(await canUserAccessChannel(x.hostCopy.id, x.person.id, asServerId(x.a.id)), true);
  assert.equal((await removalRows(db, [x.departureId])).length, 2, "rejoining leaves the history as it is");
});

dbTest("the retention job deletes removal rows 90 days after their departure completed, and no others", async ({ db, seed }) => {
  const old = await completedDeparture({ db, seed });
  const young = await completedDeparture({ db, seed });
  assert.equal(JOINT_MEMBERSHIP_REMOVAL_RETENTION_DAYS, 90);
  await completedDaysAgo(db, old.departureId, 91, 91);
  // Rows past the window, their departure not: the departure's completion counts.
  await completedDaysAgo(db, young.departureId, 89, 91);

  const first = await pruneCompletedJointMembershipRemovals({ batchSize: 1, pauseMs: 0 });
  assert.equal(first.deleted, 2);
  assert.equal(first.yielded, false);
  assert.equal((await removalRows(db, [old.departureId])).length, 0, "older than 90 days after completion: deleted");
  assert.equal((await removalRows(db, [young.departureId])).length, 2, "younger: kept");

  // An unfinished departure's rows are live denials, however old.
  await completedDaysAgo(db, young.departureId, null, 400);
  assert.equal((await pruneCompletedJointMembershipRemovals({ pauseMs: 0 })).deleted, 0);
  assert.equal((await removalRows(db, [young.departureId])).length, 2);

  await completedDaysAgo(db, young.departureId, 91, 91);
  assert.equal((await pruneCompletedJointMembershipRemovals({ pauseMs: 0 })).deleted, 2);
  assert.equal((await db.select().from(jointMembershipDepartures).where(inArray(jointMembershipDepartures.id, [old.departureId, young.departureId]))).length, 2, "departures themselves are not this job's");
});
