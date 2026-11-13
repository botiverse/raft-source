import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { jointAdmissionRecoveries, jointChannelAdmissions, jointChannelMembers, jointChannelServers, serverMembers, servers } from "../db/schema";
import { resolveChannelActorContext, channelActorHasCapability } from "../lib/channelActorPermissions";
import {
  acceptJointChannelInvite,
  acceptJointChannelInvites,
  createJointChannel,
  getChannel,
  inviteServerToJointChannel,
  JointInviteAccepterError,
} from "../services/channelService";
import { recordOrdinaryJointAdmissions } from "../services/jointAdmissionKind";
import {
  getComputedJointHumanPublicRowsForScopes,
  jointHumanCurrentSourceSql,
  resolveJointHumanMembershipScopes,
} from "../services/jointHumanMembershipAccess";
import { addHumanWithMembershipSystemMessage } from "../services/messageService";
import { createApiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";

// The 'recovery' kind of joint membership source (#wg-rbac:#23): a live
// source like any other, authorizes nothing, never makes anybody a member,
// and an ordinary admission of the same live tuple turns it into an ordinary
// 'admission' (its joint_admission_recoveries record stays).
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const OLD = new Date("2020-01-01T00:00:00Z");

type Tuple = { jointChannelId: string; userId: string; serverId: string; generation: number };

const tupleWhere = (t: Tuple) => and(
  eq(jointChannelAdmissions.jointChannelId, t.jointChannelId),
  eq(jointChannelAdmissions.userId, t.userId),
  eq(jointChannelAdmissions.serverId, t.serverId),
  eq(jointChannelAdmissions.generation, t.generation),
);

async function admissionRow(t: Tuple) {
  const [row] = await getDb().select().from(jointChannelAdmissions).where(tupleWhere(t));
  return row ?? null;
}

async function recoveryRecords(t: Tuple) {
  return getDb().select().from(jointAdmissionRecoveries).where(and(
    eq(jointAdmissionRecoveries.jointChannelId, t.jointChannelId),
    eq(jointAdmissionRecoveries.userId, t.userId),
    eq(jointAdmissionRecoveries.serverId, t.serverId),
    eq(jointAdmissionRecoveries.generation, t.generation),
  ));
}

/** What the later ops tool will write: a recovery source row and its record (written directly here). */
async function writeRecovery(t: Tuple, options: { ended?: boolean; replace?: boolean } = {}) {
  if (options.replace) await getDb().delete(jointChannelAdmissions).where(tupleWhere(t));
  await getDb().insert(jointChannelAdmissions).values({ ...t, kind: "recovery", admittedBy: null, admittedAt: OLD, endedAt: options.ended ? OLD : null });
  await getDb().insert(jointAdmissionRecoveries).values({ ...t, runId: "run-test", approvalRef: "approval-test" });
}

async function liveSource(t: Omit<Tuple, "generation">): Promise<boolean> {
  const result = await getDb().execute<{ live: boolean }>(sql`SELECT ${jointHumanCurrentSourceSql(sql`${t.jointChannelId}::uuid`, sql`${t.userId}::uuid`, sql`${t.serverId}::uuid`)} AS live`);
  return result.rows[0]!.live;
}

async function projection(jointChannelId: string, serverId: string) {
  const [row] = await getDb().select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.serverId, serverId)));
  assert.ok(row);
  return row.localChannelId;
}

async function member(jointChannelId: string, userId: string) {
  const [row] = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, jointChannelId), eq(jointChannelMembers.userId, userId)));
  return row ?? null;
}

/** Host H (owner), connected P1 (acceptor owns it; `plain` is an ordinary member of P1 and of P2). */
async function seedJoint(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const acceptor = await seed.human();
  const plain = await seed.human();
  const newcomer = await seed.human();
  const h = await seed.server({ owner: owner, members: [newcomer] });
  const p1 = await seed.server({ owner: acceptor, members: [plain] });
  const p2 = await seed.server({ owner: acceptor, members: [plain] });
  for (const server of [h, p1, p2]) await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: owner.id, name: "recovery-kind", targetServerSlug: p1.slug, invitedPeople: [`@${acceptor.name}`] });
  await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: p1.id, acceptedByUserId: acceptor.id });
  const jointId = created.jointChannel.id;
  const p1Channel = await projection(jointId, p1.id);
  // plain joins on P1 as an ordinary member (an admin's add): one 'admission' source, P1.
  const added = await addHumanWithMembershipSystemMessage({ channel: (await getChannel(p1Channel))!, userId: plain.id, userName: plain.name, causalActor: { type: "user", id: acceptor.id } });
  assert.equal(added.added, true);
  return { owner, acceptor, plain, newcomer, h, p1, p2, created, jointId, p1Channel };
}

test("a member whose only source is a recovery keeps a live source and the same membership", async ({ seed }) => {
  const x = await seedJoint(seed);
  const generation = (await member(x.jointId, x.plain.id))!.generation;
  const t = { jointChannelId: x.jointId, userId: x.plain.id, serverId: x.p1.id, generation };
  assert.equal((await admissionRow(t))?.kind, "admission", "ordinary rows default to 'admission'");
  await writeRecovery(t, { replace: true });

  assert.ok(await member(x.jointId, x.plain.id), "still a member");
  assert.equal(await liveSource(t), true, "jointHumanCurrentSourceSql counts a recovery source as live");
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [x.created.channel.id] })).get(x.created.channel.id)!;
  const rows = await getComputedJointHumanPublicRowsForScopes([scope], [x.plain.id]);
  assert.deepEqual(rows.map((row) => row.human.servers.map((s) => s.id)), [[x.p1.id]], "the roster labels the recovered source");

  // Ended: no longer live, as for an ordinary source.
  await getDb().update(jointChannelAdmissions).set({ endedAt: new Date() }).where(tupleWhere(t));
  assert.equal(await liveSource(t), false);
});

test("a recovery source authorizes nothing: management, invite and connect checks are unchanged", async ({ seed }) => {
  const x = await seedJoint(seed);
  const generation = (await member(x.jointId, x.plain.id))!.generation;
  const t = { jointChannelId: x.jointId, userId: x.plain.id, serverId: x.p1.id, generation };
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [x.created.channel.id] })).get(x.created.channel.id)!;

  // A server invite to P2 for plain, sent while they were its admin; they are
  // an ordinary member of P2 again by the time they would connect it.
  const p2Member = and(eq(serverMembers.serverId, x.p2.id), eq(serverMembers.userId, x.plain.id));
  await getDb().update(serverMembers).set({ role: "admin" }).where(p2Member);
  const [p2] = await getDb().select({ slug: servers.slug }).from(servers).where(eq(servers.id, x.p2.id));
  const sent = await inviteServerToJointChannel({ localChannelId: x.created.channel.id, fromServerId: x.h.id, invitedByUserId: x.owner.id, targetServerSlug: p2!.slug, invitedPeople: [`@${x.plain.name}`] });
  await getDb().update(serverMembers).set({ role: "member" }).where(p2Member);

  const observe = async () => {
    const onP1 = await resolveChannelActorContext(x.p1.id, x.p1Channel, "user", x.plain.id);
    const onHost = await resolveChannelActorContext(x.h.id, x.created.channel.id, "user", x.plain.id);
    assert.ok(onP1);
    const connect = await acceptJointChannelInvite({ inviteId: sent.invites[0]!.id, targetServerId: x.p2.id, acceptedByUserId: x.plain.id })
      .then(() => "connected", (error: unknown) => error instanceof JointInviteAccepterError ? error.code : String(error));
    const [publicRow] = await getComputedJointHumanPublicRowsForScopes([scope], [x.plain.id]);
    return {
      onP1,
      onHost,
      federate: channelActorHasCapability(onP1, "federateChannels"),
      removeMembers: channelActorHasCapability(onP1, "removeChannelMembers"),
      archive: channelActorHasCapability(onP1, "archiveChannels"),
      connect,
      isManager: publicRow?.human.isManager ?? null,
    };
  };

  // Without any source on P1 (the row removed), then with only a recovery source.
  await getDb().delete(jointChannelAdmissions).where(tupleWhere(t));
  const withoutSource = await observe();
  await writeRecovery(t);
  const withRecovery = await observe();
  assert.deepEqual(withRecovery, withoutSource);
  assert.equal(withRecovery.federate, false, "no invite authority");
  assert.equal(withRecovery.connect, "authorizer_not_admin", "cannot connect a server");
  assert.equal(withRecovery.isManager, false, "not a manager");
});

test("a recovery row never makes a member; the person's ordinary add later upgrades it", async ({ seed }) => {
  const x = await seedJoint(seed);
  // Not a joint member yet: the add below gives them generation 1.
  assert.equal(await member(x.jointId, x.newcomer.id), null);
  const t = { jointChannelId: x.jointId, userId: x.newcomer.id, serverId: x.h.id, generation: 1 };
  const before = await resolveChannelActorContext(x.h.id, x.created.channel.id, "user", x.newcomer.id);
  await writeRecovery(t);
  const after = await resolveChannelActorContext(x.h.id, x.created.channel.id, "user", x.newcomer.id);
  assert.deepEqual(after, before, "a recovery row alone changes no access");
  assert.equal(after?.canAccessChannel ?? false, false, "no access without a current member row");
  assert.equal(after?.isChannelMember ?? false, false);
  assert.equal(await member(x.jointId, x.newcomer.id), null, "and creates no member");
  assert.equal(await liveSource(t), false, "not a live source without the membership");

  // An admin's add (jointHumanMembershipMirror's join): the ordinary admission
  // of the same tuple upgrades it, admitted by the admin, now.
  const added = await addHumanWithMembershipSystemMessage({ channel: (await getChannel(x.created.channel.id))!, userId: x.newcomer.id, userName: x.newcomer.name, causalActor: { type: "user", id: x.owner.id } });
  assert.equal(added.added, true);
  assert.equal((await member(x.jointId, x.newcomer.id))?.generation, 1);
  const row = await admissionRow(t);
  assert.equal(row?.kind, "admission");
  assert.equal(row?.admittedBy, x.owner.id);
  assert.ok(row && row.admittedAt.getTime() > OLD.getTime(), "admitted_at is the admission's");
  assert.equal(row?.endedAt, null);
  assert.equal((await recoveryRecords(t)).length, 1, "the recovery record stays");
});

test("a batch accept over a live recovery tuple upgrades it, admitted by the acceptor", async ({ seed }) => {
  const x = await seedJoint(seed);
  const batcher = await seed.human();
  const q1 = await seed.server({ owner: batcher });
  const q2 = await seed.server({ owner: batcher });
  for (const server of [q1, q2]) await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const inviteIds: string[] = [];
  for (const server of [q1, q2]) {
    const result = await inviteServerToJointChannel({ localChannelId: x.created.channel.id, fromServerId: x.h.id, invitedByUserId: x.owner.id, targetServerSlug: server.slug, invitedPeople: [`@${batcher.name}`] });
    inviteIds.push(...result.invites.map((invite) => invite.id));
  }
  // A first-time member gets generation 1.
  const t = { jointChannelId: x.jointId, userId: batcher.id, serverId: q2.id, generation: 1 };
  await writeRecovery(t);
  await acceptJointChannelInvites({ inviteIds, acceptedByUserId: batcher.id });
  assert.equal((await member(x.jointId, batcher.id))?.generation, 1);
  const rows = await getDb().select().from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, x.jointId), eq(jointChannelAdmissions.userId, batcher.id)));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.kind, "admission", row.serverId);
    assert.equal(row.admittedBy, batcher.id, row.serverId);
    assert.ok(row.admittedAt.getTime() > OLD.getTime(), row.serverId);
  }
  assert.equal((await recoveryRecords(t)).length, 1);
});

test("the shared writer: inserts new tuples, upgrades only live recovery rows, never revives an ended one or touches an admission", async ({ seed }) => {
  const x = await seedJoint(seed);
  const g = 41;
  const tuple = (serverId: string, userId: string) => ({ jointChannelId: x.jointId, userId, serverId, generation: g });
  const live = tuple(x.h.id, x.plain.id);
  const ended = tuple(x.p1.id, x.plain.id);
  const ordinary = tuple(x.p2.id, x.plain.id);
  const fresh = tuple(x.h.id, x.newcomer.id);
  await writeRecovery(live);
  await writeRecovery(ended, { ended: true });
  await getDb().insert(jointChannelAdmissions).values({ ...ordinary, admittedBy: x.acceptor.id, admittedAt: OLD });
  const endedBefore = await admissionRow(ended);
  const ordinaryBefore = await admissionRow(ordinary);

  const at = "2026-06-01T12:34:56.789123+00";
  const candidates = [live, ended, ordinary, fresh].map((t) => sql`(${t.jointChannelId}::uuid,${t.userId}::uuid,${t.serverId}::uuid,${t.generation}::integer)`);
  const run = () => getDb().transaction((tx) => recordOrdinaryJointAdmissions(tx, sql`SELECT c.joint_channel_id,c.user_id,c.server_id,c.generation,
      ${at}::timestamptz AS admitted_at,${x.owner.id}::uuid AS admitted_by
    FROM (VALUES ${sql.join(candidates, sql`, `)}) c(joint_channel_id,user_id,server_id,generation)`));
  await run();

  const upgraded = await admissionRow(live);
  assert.equal(upgraded?.kind, "admission");
  assert.equal(upgraded?.admittedBy, x.owner.id);
  const [{ same }] = (await getDb().execute<{ same: boolean }>(sql`SELECT admitted_at=${at}::timestamptz AS same FROM joint_channel_admissions
    WHERE joint_channel_id=${live.jointChannelId}::uuid AND user_id=${live.userId}::uuid AND server_id=${live.serverId}::uuid AND generation=${g}`)).rows as [{ same: boolean }];
  assert.equal(same, true, "admitted_at exactly as the insert would have written it (microseconds kept)");
  assert.equal((await recoveryRecords(live)).length, 1, "recovery record stays");
  assert.deepEqual(await admissionRow(ended), endedBefore, "an ended recovery row is not revived");
  assert.deepEqual(await admissionRow(ordinary), ordinaryBefore, "an existing admission row is unchanged");
  const inserted = await admissionRow(fresh);
  assert.equal(inserted?.kind, "admission");
  assert.equal(inserted?.admittedBy, x.owner.id);

  // A repeat is a no-op.
  const snapshot = await getDb().select().from(jointChannelAdmissions).where(eq(jointChannelAdmissions.generation, g));
  await run();
  assert.deepEqual(await getDb().select().from(jointChannelAdmissions).where(eq(jointChannelAdmissions.generation, g)), snapshot);
});

test("kind defaults to 'admission', the CHECK refuses anything else, and a recovery record needs its admission row", async ({ db, seed }) => {
  const x = await seedJoint(seed);
  const t = { jointChannelId: x.jointId, userId: x.newcomer.id, serverId: x.h.id, generation: 7 };
  await db.execute(sql`INSERT INTO joint_channel_admissions (joint_channel_id,user_id,server_id,generation) VALUES (${t.jointChannelId}::uuid,${t.userId}::uuid,${t.serverId}::uuid,7)`);
  assert.equal((await admissionRow(t))?.kind, "admission");
  await assert.rejects(
    db.execute(sql`INSERT INTO joint_channel_admissions (joint_channel_id,user_id,server_id,generation,kind) VALUES (${t.jointChannelId}::uuid,${t.userId}::uuid,${t.serverId}::uuid,8,'legacy')`),
    (error: Error & { cause?: { message?: string } }) => /joint_channel_admissions_kind_known/.test(`${error.message} ${error.cause?.message ?? ""}`),
  );
  await assert.rejects(
    db.execute(sql`UPDATE joint_channel_admissions SET kind='other' WHERE joint_channel_id=${t.jointChannelId}::uuid AND user_id=${t.userId}::uuid AND generation=7`),
    (error: Error & { cause?: { message?: string } }) => /joint_channel_admissions_kind_known/.test(`${error.message} ${error.cause?.message ?? ""}`),
  );
  const [constraint] = (await db.execute<{ convalidated: boolean }>(sql`SELECT convalidated FROM pg_constraint WHERE conname='joint_channel_admissions_kind_known'`)).rows;
  assert.equal(constraint?.convalidated, true, "validated by the second migration");
  // The record follows its admission row: refused without one, gone with it.
  await assert.rejects(db.insert(jointAdmissionRecoveries).values({ ...t, generation: 9, runId: "r", approvalRef: "a" }));
  await db.insert(jointAdmissionRecoveries).values({ ...t, runId: "r", approvalRef: "a" });
  await db.delete(jointChannelAdmissions).where(tupleWhere(t));
  assert.equal((await recoveryRecords(t)).length, 0);
});
