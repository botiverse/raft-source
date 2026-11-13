import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import {
  channelHumans,
  serverMembers,
  jointChannelMembers,
  jointChannelAdmissions,
  jointMembershipGenerations,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  addHuman,
  removeHuman,
  changeChannelMembershipRole,
  getJointHumanManagerCandidateIds,
} from "../services/channelService";
import {
  channelActorHasCapability,
  resolveChannelActorContext,
  withLockedChannelActorCapability,
} from "../lib/channelActorPermissions";
import { addMember, removeMember } from "../services/serverService";
import { createSeed } from "./integration/seed";
import { seedBoundGuest } from "./guestFixture";

export async function jointHumanAuthorityScenario({
  db,
  seed,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
}) {
  const owner = await seed.human(),
    manager = await seed.human(),
    candidate = await seed.human(),
    bOnly = await seed.human();
  const h = await seed.server({ owner, members: [manager, candidate] });
  const b = await seed.server({ owner, members: [manager, candidate, bOnly] });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "computed-authority",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
    userIds: [manager.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  await db
    .update(serverMembers)
    .set({ role: "member" })
    .where(
      and(eq(serverMembers.serverId, b.id), eq(serverMembers.userId, owner.id)),
    );
  await db
    .update(serverMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(serverMembers.serverId, b.id),
        eq(serverMembers.userId, manager.id),
      ),
    );
  const context = async (
    serverId: string,
    channelId: string,
    userId: string,
  ) => {
    const c = await resolveChannelActorContext(
      serverId,
      channelId,
      "user",
      userId,
      db,
    );
    assert.ok(c);
    return c;
  };
  const change = (
    requesterUserId: string,
    targetId: string,
    nextRole: "admin" | "member",
  ) =>
    changeChannelMembershipRole({
      serverId: h.id,
      channelId: created.channel.id,
      requesterUserId,
      targetType: "user",
      targetId,
      nextRole,
    });
  const remove = (
    serverId: string,
    channelId: string,
    actorId: string,
    userId: string,
  ) =>
    withLockedChannelActorCapability(
      {
        serverId,
        channelId,
        actorType: "user",
        actorId,
        capability: "removeChannelMembers",
        humanSubjectIds: [userId],
      },
      (tx, c) => removeHuman(channelId, userId, c, tx),
    );
  const current = async (userId: string) =>
    (
      await db
        .select()
        .from(jointChannelMembers)
        .where(
          and(
            eq(jointChannelMembers.jointChannelId, created.jointChannel.id),
            eq(jointChannelMembers.userId, userId),
          ),
        )
    )[0];
  const bOwner = await context(b.id, target.id, owner.id);
  for (const cap of [
    "editChannelMetadata",
    "archiveChannels",
    "changeChannelMemberRoles",
    "removeChannelMembers",
    "federateChannels",
  ] as const)
    assert.equal(
      channelActorHasCapability(bOwner, cap),
      false,
      `H role cannot be borrowed through B: ${cap}`,
    );
  await db
    .delete(channelHumans)
    .where(
      and(
        eq(channelHumans.channelId, created.channel.id),
        eq(channelHumans.userId, manager.id),
      ),
    );
  await change(owner.id, manager.id, "admin");
  const hm = await context(h.id, created.channel.id, manager.id);
  for (const cap of [
    "editChannelMetadata",
    "archiveChannels",
    "removeChannelMembers",
  ] as const)
    assert.equal(channelActorHasCapability(hm, cap), true, cap);
  assert.equal(
    channelActorHasCapability(hm, "changeChannelMemberRoles"),
    false,
    "appointed manager cannot appoint or revoke",
  );
  assert.equal(channelActorHasCapability(hm, "federateChannels"), false);
  const bm = await context(b.id, target.id, manager.id);
  assert.equal(
    channelActorHasCapability(bm, "removeChannelMembers"),
    false,
    "B admin cannot remove a human",
  );
  assert.equal(
    channelActorHasCapability(bm, "removeChannelMembers", "agent"),
    true,
    "B admin may manage own agents",
  );
  await addHuman(target.id, bOnly.id);
  await assert.rejects(
    remove(b.id, target.id, manager.id, bOnly.id),
    /Channel capability required/,
  );
  assert.ok(
    await current(bOnly.id),
    "even a B-only introduction cannot be removed by B",
  );
  await assert.rejects(
    remove(b.id, target.id, manager.id, manager.id),
    /Channel capability required/,
  );
  // A B-introduced J member currently in H is appointable, even with no source rows.
  await addHuman(target.id, candidate.id);
  await db
    .delete(jointChannelAdmissions)
    .where(
      and(
        eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id),
        eq(jointChannelAdmissions.userId, candidate.id),
      ),
    );
  assert.ok(
    (
      await getJointHumanManagerCandidateIds(created.channel.id, [candidate.id])
    )?.has(candidate.id),
  );
  await assert.rejects(
    change(manager.id, candidate.id, "admin"),
    /permission to change channel member roles/,
  );
  await change(owner.id, candidate.id, "admin");
  await assert.rejects(
    change(manager.id, candidate.id, "member"),
    /permission to change channel member roles/,
  );
  await change(owner.id, candidate.id, "member");
  await assert.rejects(
    change(owner.id, bOnly.id, "admin"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "channel_member_required",
  );
  // Guest identity in H is not appointment eligibility; host can still remove globally.
  // Bound to a local channel of H, not the joint channel (#wg-rbac:#15).
  await seedBoundGuest({ serverId: h.id, userId: bOnly.id }, db);
  await assert.rejects(
    change(owner.id, bOnly.id, "admin"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "channel_member_required",
  );
  const first = (await current(bOnly.id))!.generation;
  await remove(h.id, created.channel.id, manager.id, bOnly.id);
  assert.equal(await current(bOnly.id), undefined);
  await addHuman(target.id, bOnly.id);
  const second = (await current(bOnly.id))!.generation;
  assert.ok(
    second > first,
    "new admission keeps source-label episodes separate",
  );
  const [counter] = await db
    .select()
    .from(jointMembershipGenerations)
    .where(
      and(
        eq(jointMembershipGenerations.jointChannelId, created.jointChannel.id),
        eq(jointMembershipGenerations.principalId, bOnly.id),
      ),
    );
  assert.equal(counter.lastGeneration, second);
  // Returning to H restores an entry but never the previous appointment. A fresh
  // explicit appointment can now use current H membership without a new source.
  await removeMember(h.id, manager.id);
  await addMember(h.id, manager.id);
  assert.equal(
    channelActorHasCapability(
      await context(h.id, created.channel.id, manager.id),
      "archiveChannels",
    ),
    false,
  );
  await change(owner.id, manager.id, "admin");
  assert.equal(
    channelActorHasCapability(
      await context(h.id, created.channel.id, manager.id),
      "archiveChannels",
    ),
    true,
  );
  await remove(h.id, created.channel.id, manager.id, owner.id);
  assert.equal(
    channelActorHasCapability(
      await context(h.id, created.channel.id, owner.id),
      "archiveChannels",
    ),
    false,
    "H owner role cannot restore globally removed membership",
  );
}
