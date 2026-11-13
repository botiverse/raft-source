import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { channelHumans, jointChannelAdmissions, jointChannelInvites, jointChannelMembers, jointChannelServers, messageMentions, channels } from "../db/schema";
import { createJointChannel, acceptJointChannelInvite } from "../services/channelService";
import { deleteServer } from "../services/serverService";
import { createMessage } from "../services/messageService";
import { executeMentionActionId } from "../services/mentionActionService";
import { startChannelToJointConversion, runChannelConversionJob, retryChannelConversionJob } from "../services/channelConversionService";
import { createSeed } from "./integration/seed";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };
export async function connected({ db, seed }: Fixture) {
  const owner = await seed.human(); const peer = await seed.human();
  const a = await seed.server({ owner, members: [peer] });
  const b = await seed.server({ owner, members: [peer] });
  const joint = await createJointChannel({ hostServerId: a.id, createdByUserId: owner.id, name: "membership-mirror", targetServerSlug: b.slug, invitedPeople: [`@${owner.name}`], userIds: [peer.id] });
  const target = await acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id });
  // The owner connected B for themselves: a source of their membership through
  // B, as the same-admin accept of a creation records it.
  await db.execute(sql`INSERT INTO joint_channel_admissions (joint_channel_id, user_id, server_id, generation, admitted_by)
    SELECT m.joint_channel_id, m.user_id, ${b.id}::uuid, m.generation, m.user_id FROM joint_channel_members m
    WHERE m.joint_channel_id=${joint.jointChannel.id}::uuid AND m.user_id=${owner.id}::uuid
    ON CONFLICT DO NOTHING`);
  return { owner, peer, a, b, joint, target };
}
export async function jointHumanMirrorCreationAndAccept(f: Fixture) {
  const { db, seed } = f;
  const owner = await seed.human(); const a = await seed.server({ owner }); const b = await seed.server({ owner });
  // A deferred constraint trigger injects failure after the real service wrote
  // all three facts. This tests its transaction boundary, not a mocked service.
  await db.execute(sql`CREATE OR REPLACE FUNCTION fail_joint_membership_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected joint membership commit failure'; END $$`);
  const failOn = async (serverId: string, table = "joint_channel_admissions") => {
    await db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER fail_joint_membership_commit AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.server_id = '${serverId}'::uuid) EXECUTE FUNCTION fail_joint_membership_commit()`));
  };
  const count = async () => {
    const r = await db.execute(sql`SELECT (SELECT count(*)::int FROM joint_channels) j, (SELECT count(*)::int FROM joint_channel_servers) p, (SELECT count(*)::int FROM joint_channel_members) m, (SELECT count(*)::int FROM joint_channel_admissions) a`); return r.rows;
  };
  const prior = await count();
  await failOn(a.id);
  try { await assert.rejects(createJointChannel({ hostServerId: a.id, createdByUserId: owner.id, name: "rollback-create", targetServerSlug: b.slug, invitedPeople: [`@${owner.name}`] })); }
  finally { await db.execute(sql`DROP TRIGGER fail_joint_membership_commit ON joint_channel_admissions`); }
  assert.deepEqual(await count(), prior, "failed create commits no joint, projection, member or admission");
  const joint = await createJointChannel({ hostServerId: a.id, createdByUserId: owner.id, name: "commit-create", targetServerSlug: b.slug, invitedPeople: [`@${owner.name}`] });
  const j = joint.jointChannel.id;
  assert.equal((await db.select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, j))).length, 1);
  assert.equal((await db.select().from(jointChannelMembers).where(eq(jointChannelMembers.jointChannelId, j))).length, 1);
  assert.equal((await db.select().from(jointChannelAdmissions).where(eq(jointChannelAdmissions.jointChannelId, j))).length, 1);
  // The creator is already a member: their accept writes the projection and no
  // source (computed membership), so the late failure is on the projection.
  const beforeAccept = await count(); await failOn(b.id, "joint_channel_servers");
  try { await assert.rejects(acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id })); }
  finally { await db.execute(sql`DROP TRIGGER fail_joint_membership_commit ON joint_channel_servers`); }
  assert.deepEqual(await count(), beforeAccept, "failed accept leaves host intact, without target projection or admission");
  assert.equal((await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, joint.invites[0]!.id)))[0]?.status, "pending");
  await acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id });
  assert.equal((await db.select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, j))).length, 2);
  assert.equal((await db.select().from(jointChannelMembers).where(eq(jointChannelMembers.jointChannelId, j))).length, 1);
  assert.equal((await db.select().from(jointChannelAdmissions).where(eq(jointChannelAdmissions.jointChannelId, j))).length, 1, "an existing member's accept records no source");
}

export async function jointHumanMirrorOtherWriters(f: Fixture) {
  const { db, seed } = f; const x = await connected(f); const j = x.joint.jointChannel.id;
  const newcomer = await seed.human();
  const server = await seed.server({ owner: x.owner, members: [x.peer, newcomer] });
  const local = await seed.channel({ server, members: [x.owner, x.peer], visibility: "channel" });
  const message = await createMessage(local.id, "user", x.owner.id, "pending mention add");
  const [mention] = await db.insert(messageMentions).values({ messageId: message.id, messageSeq: message.seq,
    serverId: server.id, channelId: local.id, targetType: "user", targetId: newcomer.id,
    handleAtSendTime: newcomer.name, notifiableAtSend: false }).returning();
  const result = await executeMentionActionId(mention!.id, server.id, "user", x.owner.id, "add");
  assert.equal(result.status, "delivered", JSON.stringify(result));
  assert.equal((await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, local.id), eq(channelHumans.userId, newcomer.id)))).length, 1);
  assert.equal((await db.select().from(jointChannelAdmissions).where(eq(jointChannelAdmissions.userId, newcomer.id))).length, 0, "ordinary mention join never creates joint facts");
  await deleteServer(x.a.id);
  assert.equal((await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, j), eq(jointChannelAdmissions.serverId, x.a.id)))).length, 2, "soft-deleting a server retains both human admission records");
  assert.equal((await db.select().from(jointChannelMembers).where(eq(jointChannelMembers.jointChannelId, j))).length, 2, "both stay: each still has B's identity");

  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: local.id, createdByUserId: x.owner.id });
  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "finalize" });
  assert.equal(failed.status, "failed");
  assert.equal((await db.select().from(jointChannelAdmissions).where(eq(jointChannelAdmissions.serverId, server.id))).length, 0, "unpublished conversion cannot admit people");
  await retryChannelConversionJob(job.id);
  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done", JSON.stringify(completed));
  const [projection] = await db.select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, local.id));
  assert.ok(projection);
  assert.equal((await db.select().from(jointChannelMembers).where(eq(jointChannelMembers.jointChannelId, projection.jointChannelId))).length, 3, "successful conversion mirrors final explicit audience");
  assert.equal((await db.select().from(channels).where(eq(channels.id, local.id)))[0]?.type, "joint");
}
