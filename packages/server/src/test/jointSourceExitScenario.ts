import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import type { Database } from "../db";
import {
  channelHumans,
  durableTasks,
  featureFlags,
  integrationAuditEvents,
  jointChannelAdmissions,
  jointChannelMembers,
  jointMembershipDepartures,
  jointMembershipGenerations,
  jointMembershipRemovals,
  serverMembers,
  servers,
  taskEvents,
  tasks,
  threadFollows,
} from "../db/schema";
import {
  acceptJointChannelInvite,
  addHuman,
  canUserAccessChannel,
  createJointChannel,
  disconnectJointChannel,
  filterUserAccessibleChannelIds,
  getChannelMembers,
  removeHuman,
} from "../services/channelService";
import { addMember, deleteServer, removeMember } from "../services/serverService";
import { assignTask, createTasks } from "../services/taskService";
import { evaluateFeatureFlag, getFeatureFlagConfigVersion } from "../services/featureFlagService";
import {
  getJointHumanDeliveryRows,
  JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY,
} from "../services/jointHumanMembershipAccess";
import {
  assertJointReconnectReady,
  cleanJointMembershipDepartureBatch,
  JOINT_DEPARTURE_BATCH_SIZE,
  type JointMembershipDepartureId,
} from "../services/jointMembershipDeparture";
import { activateJointSourceExit, JointSourceExitActivationRefusedError } from "../services/jointSourceExitActivation";
import { enableExternalChannelsFlag } from "./externalInviteFixture";
import type { createSeed } from "./integration/seed";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };
type Human = Awaited<ReturnType<Fixture["seed"]["human"]>>;

/** Computed membership on everywhere; source exit per `setSourceExit`. */
export async function setJointFlags(db: Database, sourceExit: boolean) {
  await db.insert(featureFlags).values({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: sourceExit,
    randomizationUnit: "server", salt: "source-exit" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: sourceExit } });
}

/** Host H (hostOwner) and participant B (peerOwner), joint J connected. */
export async function sourceExitJoint({ db, seed }: Fixture, name: string) {
  const hostOwner = await seed.human(), peerOwner = await seed.human();
  const h = await seed.server({ owner: hostOwner }), b = await seed.server({ owner: peerOwner });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, b.id]));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name,
    targetServerSlug: b.slug, invitedPeople: [`@${peerOwner.name}`] });
  const target = await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id });
  const J = created.jointChannel.id;
  const hLocal = created.channel.id, bLocal = target.id;
  const member = async (userId: string) => (await db.select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, J), eq(jointChannelMembers.userId, userId))))[0];
  const sources = async (userId: string) => db.select().from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, J), eq(jointChannelAdmissions.userId, userId)));
  const jointAudit = async (userId: string) => (await db.select().from(integrationAuditEvents).where(and(
    inArray(integrationAuditEvents.eventType, ["channel.member_left", "channel.member_removed"]),
    eq(integrationAuditEvents.targetId, userId))))
    .filter((row) => row.metadata.jointChannelId === J);
  /** A person on H and B who joined J through B: B is their only source. */
  const viaB = async () => {
    const person = await seed.human();
    await addMember(h.id, person.id); await addMember(b.id, person.id);
    await addHuman(bLocal, person.id);
    return person;
  };
  /** Seeded at scale: members of H and B with only a B source (generation 1). */
  const seedViaB = async (count: number) => {
    const people: Human[] = [];
    for (let i = 0; i < count; i++) people.push(await seed.human());
    const ids = people.map((person) => person.id);
    await db.insert(serverMembers).values(ids.flatMap((userId) => [
      { serverId: h.id, userId, role: "member" as const }, { serverId: b.id, userId, role: "member" as const }]));
    await db.insert(jointChannelMembers).values(ids.map((userId) => ({ jointChannelId: J, userId, generation: 1 })));
    await db.insert(jointMembershipGenerations).values(ids.map((principalId) => ({ jointChannelId: J, principalKind: "user" as const, principalId, lastGeneration: 1 })));
    await db.insert(jointChannelAdmissions).values(ids.map((userId) => ({ jointChannelId: J, userId, serverId: b.id, generation: 1 })));
    await db.insert(channelHumans).values(ids.map((userId) => ({ channelId: bLocal, userId })));
    return people;
  };
  return { hostOwner, peerOwner, h, b, J, hLocal, bLocal, created, member, sources, jointAudit, viaB, seedViaB };
}

/** Leave/kick from the last source server ends J membership (flag on) with its
 * family cleanup and one audit event; flag off keeps today's identity rule. A
 * live source anywhere keeps an entry through any server valid. */
export async function jointSourceExitLeaveScenario(f: Fixture) {
  const { db } = f;
  await setJointFlags(db, false);
  const x = await sourceExitJoint(f, "source-exit-leave");
  const access = (userId: string) => canUserAccessChannel(x.hLocal, userId, asServerId(x.h.id));

  // Flag off: leaving B ends the B source but H identity keeps J (today).
  const kept = await x.viaB();
  await removeMember(x.b.id, kept.id, { reason: "left" });
  assert.ok((await x.member(kept.id)), "flag off: identity on H keeps the member");
  assert.ok((await x.sources(kept.id)).every((row) => row.endedAt), "flag off: the B source ended");
  assert.equal(await access(kept.id), true, "flag off: a no-source member keeps access");

  await setJointFlags(db, true);
  // Flag on: the source-less member from above is denied by every reader, and
  // allowed again when the flag is off (each builder's revert check).
  const leaver = await x.viaB(), kicked = await x.viaB(), multi = await x.viaB();
  assert.equal(await access(leaver.id), true, "a source on B permits the entry through H");
  const readers = async (userId: string) => ({
    access: await access(userId),
    batch: (await filterUserAccessibleChannelIds([x.hLocal], userId, asServerId(x.h.id))).has(x.hLocal),
    delivery: (await getJointHumanDeliveryRows([x.hLocal])).some((row) => row.id === userId),
    roster: (await getChannelMembers(x.hLocal)).humans.some((row) => row.id === userId),
  });
  const allowed = { access: true, batch: true, delivery: true, roster: true };
  const denied = { access: false, batch: false, delivery: false, roster: false };
  assert.deepEqual(await readers(kept.id), denied, "flag on: no live source, no entry");
  assert.deepEqual(await readers(leaver.id), allowed, "flag on: a live B source keeps every reader's entry through H");
  const [task] = (await createTasks(x.created.jointChannel.canonicalChannelId, "user", x.hostOwner.id,
    [{ title: "source exit" }, { title: "assign check" }], { initiatingServerId: x.h.id })).tasks;
  const assignCheck = (await db.select().from(tasks).where(and(eq(tasks.channelId, x.created.jointChannel.canonicalChannelId), eq(tasks.title, "assign check"))))[0]!;
  assert.equal(await assignTask(assignCheck.id, { type: "user", id: kept.id }, "user", x.hostOwner.id, { serverId: x.h.id }),
    "assignee is not a member of this channel", "flag on: a no-source member is not assignable");
  await setJointFlags(db, false);
  assert.deepEqual(await readers(kept.id), allowed, "flag off: the same member is allowed again");
  assert.notEqual(typeof await assignTask(assignCheck.id, { type: "user", id: kept.id }, "user", x.hostOwner.id, { serverId: x.h.id }), "string");
  await setJointFlags(db, true);

  // The leaver: a claimed open task and follows on H's and B's faces.
  await assignTask(task!.id, { type: "user", id: leaver.id }, "user", x.hostOwner.id, { serverId: x.h.id });
  const unrelated = await f.seed.channel({ server: x.h, members: [] });
  const follow = (threadChannelId: string) => ({ threadChannelId, followerType: "user" as const, followerId: leaver.id,
    parentTaskId: task!.id, reason: "manual" as const });
  await db.insert(threadFollows).values([follow(x.hLocal), follow(x.bLocal), follow(unrelated.id)]);
  await removeMember(x.b.id, leaver.id, { reason: "left" });
  assert.equal(await x.member(leaver.id), undefined, "the last source's server exit ends J membership");
  assert.equal(await access(leaver.id), false);
  assert.deepEqual(await db.select().from(channelHumans).where(and(eq(channelHumans.userId, leaver.id),
    inArray(channelHumans.channelId, [x.hLocal, x.bLocal]))), [], "no CH row left in the J family");
  assert.deepEqual((await db.select().from(threadFollows).where(eq(threadFollows.followerId, leaver.id))).map((row) => row.threadChannelId),
    [unrelated.id], "follows across the whole J family go; others stay");
  const [settled] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(settled!.claimedById, null, "the open J task is unassigned");
  assert.ok((await db.select().from(taskEvents).where(eq(taskEvents.taskId, task!.id)))
    .some((row) => row.eventType === "assignee_changed" && (row.payload as { previousAssigneeId?: string }).previousAssigneeId === leaver.id));
  const left = await x.jointAudit(leaver.id);
  assert.deepEqual(left.map((row) => [row.eventType, row.metadata.reason, row.actorId]),
    [["channel.member_left", "server_departure", leaver.id]], "one audit event for the ended J");

  // Kick: the remover is the actor.
  await removeMember(x.b.id, kicked.id, { reason: "removed", actorUserId: x.peerOwner.id });
  assert.equal(await x.member(kicked.id), undefined);
  assert.deepEqual((await x.jointAudit(kicked.id)).map((row) => [row.eventType, row.metadata.reason, row.actorId]),
    [["channel.member_removed", "server_departure", x.peerOwner.id]]);

  // Two sources: leaving B ends only that one; H's keeps J and H's entry.
  const [current] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.J), eq(jointChannelMembers.userId, multi.id)));
  await db.insert(jointChannelAdmissions).values({ jointChannelId: x.J, userId: multi.id, serverId: x.h.id, generation: current!.generation });
  await removeMember(x.b.id, multi.id, { reason: "left" });
  assert.ok(await x.member(multi.id), "another live source keeps J");
  assert.deepEqual((await x.sources(multi.id)).map((row) => [row.serverId, row.endedAt === null]).sort(),
    [[x.b.id, false], [x.h.id, true]].sort(), "only B's source ended");
  assert.equal(await access(multi.id), true);
  assert.deepEqual(await x.jointAudit(multi.id), [], "no J membership ended, no J audit");

  // Rejoining B restores neither source nor membership.
  await addMember(x.b.id, leaver.id);
  assert.equal(await x.member(leaver.id), undefined, "rejoin does not restore J");
  assert.equal(await canUserAccessChannel(x.bLocal, leaver.id, asServerId(x.b.id)), false);
}

/** Disconnect (<=128 inline): a B-only-source person leaves J, audited once
 * with the disconnecting person as actor; a person with an H source keeps J
 * (entry-only). Retries never audit again; reconnection waits for cleanup. */
export async function jointSourceExitDisconnectScenario(f: Fixture) {
  const { db } = f;
  await setJointFlags(db, true);
  const x = await sourceExitJoint(f, "source-exit-disconnect");
  const gone = await x.viaB(), stays = await x.viaB();
  const [stayMember] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.J), eq(jointChannelMembers.userId, stays.id)));
  await db.insert(jointChannelAdmissions).values({ jointChannelId: x.J, userId: stays.id, serverId: x.h.id, generation: stayMember!.generation, kind: "recovery" });
  await disconnectJointChannel(x.bLocal, x.peerOwner.id);
  const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, x.bLocal));
  const removals = await db.select().from(jointMembershipRemovals).where(eq(jointMembershipRemovals.departureId, departure!.id));
  assert.equal(removals.find((row) => row.userId === gone.id)?.removeMembership, true, "no live source left: full removal");
  assert.equal(removals.find((row) => row.userId === stays.id)?.removeMembership, false, "a live recovery source on H: entry-only");
  assert.equal(await x.member(gone.id), undefined, "removed in the disconnect's own commit");
  assert.ok(await x.member(stays.id));
  assert.equal(await canUserAccessChannel(x.hLocal, stays.id, asServerId(x.h.id)), true);
  await assert.rejects(assertJointReconnectReady(db, x.J, x.b.id), /cleanup in progress/);
  const audit = async () => (await x.jointAudit(gone.id)).map((row) => [row.eventType, row.metadata.reason, row.actorId, row.serverId]);
  const once = [["channel.member_removed", "server_departure", x.peerOwner.id, x.b.id]];
  assert.deepEqual(await audit(), once);
  assert.deepEqual(await x.jointAudit(stays.id), []);
  for (let i = 0; i < 2; i++) await cleanJointMembershipDepartureBatch(departure!.id as JointMembershipDepartureId, { revoke: async () => {} });
  assert.deepEqual(await audit(), once, "retries never audit again");
  await assertJointReconnectReady(db, x.J, x.b.id);
}

/** >128 subjects: denied at once, removed in <=128 batches, audited exactly
 * once even when a batch's audit write fails and the batch is retried. */
export async function jointSourceExitLargeDisconnectScenario(f: Fixture) {
  const { db } = f;
  await setJointFlags(db, true);
  const x = await sourceExitJoint(f, "source-exit-large");
  const people = await x.seedViaB(JOINT_DEPARTURE_BATCH_SIZE + 1);
  const ids = people.map((person) => person.id);
  await disconnectJointChannel(x.bLocal, x.peerOwner.id);
  const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, x.bLocal));
  const id = departure!.id as JointMembershipDepartureId;
  assert.equal((await db.select().from(jointChannelMembers).where(inArray(jointChannelMembers.userId, ids))).length, ids.length,
    "large disconnect defers physical cleanup");
  assert.equal(await canUserAccessChannel(x.hLocal, ids[0]!, asServerId(x.h.id)), false, "denied by the fixed list at once");
  await addHuman(x.hLocal, ids[0]!).catch(() => {});
  assert.ok(await x.member(ids[0]!), "a join during cleanup changes nothing");
  assert.equal(await canUserAccessChannel(x.hLocal, ids[0]!, asServerId(x.h.id)), false, "a join cannot rescue a fixed victim");
  const auditCount = async () => (await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM integration_audit_events
    WHERE event_type='channel.member_removed' AND metadata->>'jointChannelId'=${x.J}
      AND target_id IN (${sql.join(ids.map((userId) => sql`${userId}::uuid`), sql`, `)})`)).rows[0]!.n;
  // A failing audit write rolls back the batch's cleanup and progress marker.
  await db.execute(sql`CREATE FUNCTION fail_source_exit_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`);
  await db.execute(sql`CREATE TRIGGER fail_source_exit_audit BEFORE INSERT ON integration_audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_source_exit_audit()`);
  try {
    await assert.rejects(cleanJointMembershipDepartureBatch(id, { revoke: async () => {} }));
  } finally {
    await db.execute(sql`DROP TRIGGER fail_source_exit_audit ON integration_audit_events`);
  }
  assert.equal((await db.select().from(jointChannelMembers).where(inArray(jointChannelMembers.userId, ids))).length, ids.length,
    "a failed audit removes nobody");
  assert.equal((await db.select().from(jointMembershipRemovals).where(and(eq(jointMembershipRemovals.departureId, id),
    sql`${jointMembershipRemovals.membershipRemovedAt} IS NOT NULL`))).length, 0, "and marks no progress");
  const batches: number[] = [];
  for (let done = false; !done;) {
    const before = await auditCount();
    done = await cleanJointMembershipDepartureBatch(id, { revoke: async () => {} });
    batches.push((await auditCount()) - before);
  }
  // The departure also removes the peer owner (B only), so 130 rows split 128 + 2.
  assert.ok(batches.length === 2 && batches.every((n) => n <= JOINT_DEPARTURE_BATCH_SIZE), `cleanup runs in <=128 batches: ${batches.join(",")}`);
  await cleanJointMembershipDepartureBatch(id, { revoke: async () => {} });
  assert.equal(await auditCount(), ids.length, "exactly one event per removed person");
  assert.equal((await db.select().from(jointChannelMembers).where(inArray(jointChannelMembers.userId, ids))).length, 0);
}

/** Flag off (identity rule): a disconnect that takes someone with no other
 * identity out of J audits that removal once, in its own commit; an entry-only
 * person keeps J and gets no event; a retry writes none again. */
export async function jointDepartureAuditFlagOffScenario(f: Fixture) {
  const { db, seed } = f;
  await setJointFlags(db, false);
  const x = await sourceExitJoint(f, "departure-audit-flag-off");
  const onlyB = await seed.human();
  await addMember(x.b.id, onlyB.id);
  await addHuman(x.bLocal, onlyB.id);
  const both = await x.viaB();
  const [task] = (await createTasks(x.created.jointChannel.canonicalChannelId, "user", x.hostOwner.id,
    [{ title: "followed" }], { initiatingServerId: x.h.id })).tasks;
  await db.insert(threadFollows).values([onlyB.id, both.id].map((followerId) => ({ threadChannelId: x.hLocal,
    followerType: "user" as const, followerId, parentTaskId: task!.id, reason: "manual" as const })));
  await disconnectJointChannel(x.bLocal, x.peerOwner.id);
  assert.equal(await x.member(onlyB.id), undefined, "no identity left: removed (today's rule)");
  assert.deepEqual((await db.select().from(threadFollows).where(eq(threadFollows.threadChannelId, x.hLocal))).map((row) => row.followerId),
    [both.id], "leaving J ends the person's follows in the family; an entry-only person's H follow stays");
  assert.ok(await x.member(both.id), "an H identity keeps J with the flag off");
  const events = async () => (await x.jointAudit(onlyB.id)).map((row) => [row.eventType, row.metadata.reason, row.actorId, row.serverId]);
  const once = [["channel.member_removed", "server_departure", x.peerOwner.id, x.b.id]];
  assert.deepEqual(await events(), once, "the removal is audited once");
  assert.deepEqual(await x.jointAudit(both.id), [], "entry-only: nobody left J, no event");
  const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, x.bLocal));
  for (let i = 0; i < 2; i++) await cleanJointMembershipDepartureBatch(departure!.id as JointMembershipDepartureId, { revoke: async () => {} });
  assert.deepEqual(await events(), once, "retries never audit again");
}

/** A source-exit flag rollback while a departure is pending never undoes or
 * downgrades its frozen decision, and its removals are still audited once. */
export async function jointSourceExitRollbackScenario(f: Fixture) {
  const { db } = f;
  await setJointFlags(db, true);
  const x = await sourceExitJoint(f, "source-exit-rollback");
  const people = await x.seedViaB(JOINT_DEPARTURE_BATCH_SIZE + 1);
  await disconnectJointChannel(x.bLocal, x.peerOwner.id);
  const [departure] = await db.select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, x.bLocal));
  await setJointFlags(db, false);
  const victim = people[0]!.id;
  assert.equal(await canUserAccessChannel(x.hLocal, victim, asServerId(x.h.id)), false, "still denied after the rollback");
  while (!await cleanJointMembershipDepartureBatch(departure!.id as JointMembershipDepartureId, { revoke: async () => {} }));
  const removals = await db.select().from(jointMembershipRemovals).where(eq(jointMembershipRemovals.departureId, departure!.id));
  assert.ok(removals.filter((row) => row.userId).every((row) => row.removeMembership), "no victim was downgraded to entry-only");
  assert.equal((await db.select().from(jointChannelMembers).where(inArray(jointChannelMembers.userId, people.map((p) => p.id)))).length, 0,
    "the frozen removals completed");
  const audited = async () => (await db.execute<{ userId: string; n: number }>(sql`SELECT target_id AS "userId", count(*)::int n
    FROM integration_audit_events WHERE event_type='channel.member_removed' AND metadata->>'jointChannelId'=${x.J}
      AND metadata->>'reason'='server_departure' GROUP BY target_id`)).rows;
  const expected = people.map((p) => p.id).sort();
  const once = async () => {
    const rows = await audited();
    assert.deepEqual(rows.filter((row) => expected.includes(row.userId)).map((row) => [row.userId, Number(row.n)]).sort(),
      expected.map((id) => [id, 1]), "every removed person audited exactly once after the rollback");
  };
  await once();
  await cleanJointMembershipDepartureBatch(departure!.id as JointMembershipDepartureId, { revoke: async () => {} });
  await once();
}

/** Deleting server S: a person whose remaining source is a recovery source on
 * H keeps J; a person whose only source was S leaves it. */
export async function jointSourceExitServerDeleteScenario(f: Fixture) {
  const { db } = f;
  await setJointFlags(db, true);
  const x = await sourceExitJoint(f, "source-exit-delete");
  const recovered = await x.viaB(), only = await x.viaB();
  const [current] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.J), eq(jointChannelMembers.userId, recovered.id)));
  await db.insert(jointChannelAdmissions).values({ jointChannelId: x.J, userId: recovered.id, serverId: x.h.id, generation: current!.generation, kind: "recovery" });
  await deleteServer(x.b.id, { deletedByUserId: x.peerOwner.id });
  assert.ok(await x.member(recovered.id), "a live recovery source on H keeps J");
  assert.equal(await canUserAccessChannel(x.hLocal, recovered.id, asServerId(x.h.id)), true);
  assert.equal(await x.member(only.id), undefined, "the deleted server was the only source");
  assert.deepEqual((await x.jointAudit(only.id)).map((row) => [row.metadata.reason, row.actorId]), [["server_departure", x.peerOwner.id]]);
}

/** A participant disconnect that takes the last host-side members out of J
 * queues the host-side archive in the same commit, for both batch sizes. */
export async function jointSourceExitHostSideArchiveScenario(f: Fixture, size: "small" | "large") {
  const { db } = f;
  await setJointFlags(db, true);
  const x = await sourceExitJoint(f, `source-exit-archive-${size}`);
  await enableExternalChannelsFlag(x.h.id);
  const people = size === "small" ? [await x.viaB()] : await x.seedViaB(JOINT_DEPARTURE_BATCH_SIZE + 1);
  // The host owner leaves J: the host side is now only people whose source is B.
  await removeHuman(x.hLocal, x.hostOwner.id, { self: true });
  const archiveTasks = () => db.select().from(durableTasks).where(eq(durableTasks.kind, "joint.host_side_archive"));
  assert.equal((await archiveTasks()).length, 0);
  await disconnectJointChannel(x.bLocal, x.peerOwner.id);
  const queued = await archiveTasks();
  assert.equal(queued.length, 1, "one durable archive intent, in the disconnect's commit");
  assert.deepEqual(queued[0]!.payload, { jointId: x.J, lastMemberUserId: people.map((p) => p.id).sort()[0] },
    "the causal subject is a host-side member the departure removed");
}

/** Deleting a participant that empties two joints' host sides archives each
 * with its own last host-side member as the causal subject. */
export async function jointSourceExitRetireArchiveAttributionScenario(f: Fixture) {
  const { db, seed } = f;
  await setJointFlags(db, true);
  const x = await sourceExitJoint(f, "source-exit-retire-archive-1");
  await enableExternalChannelsFlag(x.h.id);
  const second = await createJointChannel({ hostServerId: x.h.id, createdByUserId: x.hostOwner.id, name: "source-exit-retire-archive-2",
    targetServerSlug: x.b.slug, invitedPeople: [`@${x.peerOwner.name}`] });
  const secondB = await acceptJointChannelInvite({ inviteId: second.invites[0]!.id, targetServerId: x.b.id, acceptedByUserId: x.peerOwner.id });
  const people = [await seed.human(), await seed.human()].sort((a, b) => a.id.localeCompare(b.id));
  for (const person of people) { await addMember(x.h.id, person.id); await addMember(x.b.id, person.id); }
  // The larger id empties J1, the smaller J2: one shared minimum would name
  // the smaller id for both.
  const [low, high] = people as [Human, Human];
  await addHuman(x.bLocal, high.id);
  await addHuman(secondB.id, low.id);
  await removeHuman(x.hLocal, x.hostOwner.id, { self: true });
  await removeHuman(second.channel.id, x.hostOwner.id, { self: true });
  await deleteServer(x.b.id, { deletedByUserId: x.peerOwner.id });
  const queued = await db.select().from(durableTasks).where(eq(durableTasks.kind, "joint.host_side_archive"));
  assert.deepEqual(queued.map((task) => task.payload as { jointId: string; lastMemberUserId: string })
    .map((payload) => [payload.jointId, payload.lastMemberUserId]).sort(),
  [[x.J, high.id], [second.jointChannel.id, low.id]].sort(), "each joint's archive names its own last host-side member");
}

/** Activation refuses while a host's joint has a member without a live source,
 * writing nothing, and enables once there is none. */
export async function jointSourceExitActivationScenario(f: Fixture) {
  const { db } = f;
  await setJointFlags(db, false);
  const x = await sourceExitJoint(f, "source-exit-activation");
  const orphan = await x.viaB();
  await removeMember(x.b.id, orphan.id, { reason: "left" });
  assert.ok(await x.member(orphan.id), "flag off: a no-source member remains");
  const activate = async () => activateJointSourceExit({ hostServerIds: [x.h.id],
    expectedConfigVersion: await getFeatureFlagConfigVersion(), actor: { type: "human", id: x.hostOwner.id } });
  await assert.rejects(activate(), (error) => error instanceof JointSourceExitActivationRefusedError
    && error.withoutLiveSource.length === 1 && error.withoutLiveSource[0]!.jointId === x.J && error.withoutLiveSource[0]!.members === 1);
  assert.equal((await evaluateFeatureFlag({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId: x.h.id }, db)).enabled, false, "refusal writes nothing");
  await removeHuman(x.hLocal, orphan.id, { self: true });
  assert.ok(await activate());
  assert.equal((await evaluateFeatureFlag({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId: x.h.id }, db)).enabled, true);
}
