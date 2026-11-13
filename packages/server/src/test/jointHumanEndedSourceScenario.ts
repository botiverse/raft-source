import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import {
  jointChannelAdmissions,
  jointChannelMembers,
  jointMembershipDepartures,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  createJointChannelInvite,
  disconnectJointChannel,
  addHuman,
  removeHuman,
  getChannelMembers,
  changeChannelMembershipRole,
  canUserAccessChannel,
  createChannel,
} from "../services/channelService";
import { seedBoundGuest } from "./guestFixture";
import {
  addMember,
  removeMember,
  transitionMemberRole,
} from "../services/serverService";
import { withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import {
  cleanJointMembershipDepartureBatch,
  type JointMembershipDepartureId,
} from "../services/jointMembershipDeparture";
import { asServerId } from "@botiverse/raft-shared";
import { createSeed } from "./integration/seed";

export async function jointHumanEndedSourceScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const owner = await seed.human(),
    person = await seed.human();
  const h = await seed.server({ owner, members: [person] }),
    b = await seed.server({ owner, members: [person] });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "ended-source",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
  });
  let target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  const current = async () =>
    (
      await db
        .select()
        .from(jointChannelMembers)
        .where(
          and(
            eq(jointChannelMembers.jointChannelId, created.jointChannel.id),
            eq(jointChannelMembers.userId, person.id),
          ),
        )
    )[0]!;
  const source = async (serverId: string) =>
    (
      await db
        .select()
        .from(jointChannelAdmissions)
        .where(
          and(
            eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id),
            eq(jointChannelAdmissions.userId, person.id),
            eq(jointChannelAdmissions.serverId, serverId),
            eq(jointChannelAdmissions.generation, (await current()).generation),
          ),
        )
    )[0]!;
  const removeB = () =>
    withLockedChannelActorCapability(
      {
        serverId: b.id,
        channelId: target.id,
        actorType: "user",
        actorId: owner.id,
        capability: "removeChannelMembers",
        humanSubjectIds: [person.id],
      },
      (tx, context) => removeHuman(target.id, person.id, context, tx),
    );
  const noBSource = async () => {
    await assert.rejects(removeB, /Channel capability required/);
    const roster = await getChannelMembers(created.channel.id);
    const personRow = roster.humans.find((row) => row.id === person.id);
    assert.ok(personRow?.servers);
    assert.ok(
      !personRow.servers.some((row) => row.id === b.id),
      "ended B source never reappears as a badge",
    );
    assert.equal(
      await canUserAccessChannel(target.id, person.id, asServerId(b.id)),
      true,
      "source end never denies a valid J entry",
    );
  };
  const newB = async () => {
    await removeHuman(created.channel.id, person.id, { self: true });
    await addHuman(target.id, person.id);
    assert.equal((await source(b.id)).endedAt, null);
    assert.ok((await getChannelMembers(created.channel.id)).humans.find(row=>row.id===person.id)?.servers?.some(row=>row.id===b.id),"a fresh B source is visible from H before it ends");
  };
  await addHuman(target.id, person.id);
  const episode = (await current()).generation;
  await removeMember(b.id, person.id);
  assert.ok((await source(b.id)).endedAt);
  await addMember(b.id, person.id);
  await noBSource();
  assert.equal((await current()).generation, episode);
  await addHuman(target.id, person.id);
  assert.ok(
    (await source(b.id)).endedAt,
    "an existing join cannot clear endedAt",
  );
  await newB();
  // Promotion: a valid Guest of B, bound to an ordinary channel of B
  // (#wg-rbac:#15), with an already-ended historical B source. No role change
  // makes a Guest, so the source ends by leaving B first.
  await removeMember(b.id, person.id);
  assert.ok((await source(b.id)).endedAt);
  const guestHome = await createChannel(b.id, "ended-source-guest-home", undefined, "private");
  await seedBoundGuest({ serverId: b.id, userId: person.id, channelId: guestHome.id }, db);
  await transitionMemberRole({
    serverId: b.id,
    actorUserId: owner.id,
    targetUserId: person.id,
    nextRole: "member",
  });
  await noBSource();
  await newB();
  await disconnectJointChannel(target.id, owner.id);
  const [departure] = await db
    .select()
    .from(jointMembershipDepartures)
    .where(eq(jointMembershipDepartures.localChannelId, target.id));
  assert.ok(departure);
  await cleanJointMembershipDepartureBatch(
    departure.id as JointMembershipDepartureId,
    { revoke: async () => {} },
  );
  assert.ok((await source(b.id)).endedAt);
  const invite = await createJointChannelInvite({
    jointChannelId: created.jointChannel.id,
    fromServerId: h.id,
    targetServerId: b.id,
    invitedUserId: owner.id,
    invitedByUserId: owner.id,
  });
  target = await acceptJointChannelInvite({
    inviteId: invite.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  await noBSource();
  await removeHuman(created.channel.id, person.id, { self: true });
  await addHuman(created.channel.id, person.id);
  await removeMember(h.id, person.id);
  assert.ok((await source(h.id)).endedAt);
  await addMember(h.id, person.id);
  await changeChannelMembershipRole({
    serverId: h.id,
    channelId: created.channel.id,
    requesterUserId: owner.id,
    targetType: "user",
    targetId: person.id,
    nextRole: "admin",
  });
  await newB();
  await assert.rejects(removeB, /Channel capability required/);
  await removeHuman(created.channel.id, person.id, { self: true });
  assert.equal(
    await current(),
    undefined,
    "host removal is global even after a fresh B admission",
  );
}
