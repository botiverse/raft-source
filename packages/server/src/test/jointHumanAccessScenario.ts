import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import type { Database } from "../db";
import {
  agents,
  serverAgentMembers,
  jointMembershipGenerations,
  channelHumans,
  jointChannelAdmissions,
  jointChannelMembers,
  serverMembers,
  userChannelReadCursors,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  canUserAccessChannel,
  filterUserAccessibleChannelIds,
  canUserPostToChannel,
  addHuman,
  removeHuman,
  getChannelMembers,
  getComputedJointVisibleHuman,
  listChannels,
  filterChannelIdsVisibleToHuman,
  getAgentChannels,
  addAgent,
} from "../services/channelService";
import { addMember, removeMember } from "../services/serverService";
import {
  resolveJointHumanEntrySql,
  getJointHumanDeliveryRows,
} from "../services/jointHumanMembershipAccess";
import { resolveActors } from "../services/actorResolveService";
import { createSeed } from "./integration/seed";
import { seedBoundGuest } from "./guestFixture";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };
export async function jointHumanAccessScenario({ db, seed }: Fixture) {
  const owner = await seed.human();
  const peer = await seed.human();
  const outsider = await seed.human();
  const a = await seed.server({ owner, members: [peer] });
  const b = await seed.server({ owner, members: [peer, outsider] });
  const created = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: owner.id,
    name: "computed-human-membership",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
    userIds: [peer.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  const canRead = () =>
    canUserAccessChannel(target.id, peer.id, asServerId(b.id));
  assert.equal(
    await canRead(),
    true,
    "a J member enters through B without a local CH: membership is computed",
  );
  const [participant] = await db
    .insert(agents)
    .values({ name: "joint-profile-participant", serverId: b.id })
    .returning();
  await db
    .insert(serverAgentMembers)
    .values({ serverId: b.id, agentId: participant!.id, role: "member" });
  await addAgent(target.id, participant!.id);
  assert.ok(
    (await getAgentChannels(participant!.id, peer.id)).some(
      (row) => row.id === target.id,
    ),
    "agent profile channel list admits a J member without a local CH",
  );
  assert.ok(
    !(await getAgentChannels(participant!.id, outsider.id)).some(
      (row) => row.id === target.id,
    ),
    "agent profile channel list does not reveal J to an outsider",
  );
  assert.equal(
    await canRead(),
    true,
    "one J member may enter B without B CH/admission",
  );
  assert.equal(await canUserPostToChannel(target.id, peer.id), true);
  const rawPermission = await resolveJointHumanEntrySql({ serverId: b.id }, db);
  const raw = await db.execute(
    sql`SELECT ${rawPermission(sql`${target.id}::uuid`, sql`${peer.id}::uuid`)} allowed`,
  );
  assert.equal(
    raw.rows[0]?.allowed,
    true,
    "raw SQL predicate agrees without B CH/admission",
  );
  const delivery = await getJointHumanDeliveryRows([target.id], db);
  assert.ok(
    delivery.some((row) => row.id === peer.id),
    "computed participants receive delivery without a local legacy join",
  );
  assert.equal(
    delivery.some((row) => "email" in row),
    false,
    "delivery projection preserves the existing email privacy boundary",
  );
  const beforeCursors = await db
    .select()
    .from(userChannelReadCursors)
    .where(eq(userChannelReadCursors.userId, peer.id));
  assert.equal(
    await addHuman(target.id, peer.id),
    false,
    "already a J member is not a second join",
  );
  assert.deepEqual(
    await db
      .select()
      .from(userChannelReadCursors)
      .where(eq(userChannelReadCursors.userId, peer.id)),
    beforeCursors,
    "a computed second entry does not mark unseen messages read",
  );
  assert.ok(
    (
      await filterUserAccessibleChannelIds(
        [created.channel.id, target.id],
        peer.id,
        asServerId(b.id),
      )
    ).has(target.id),
  );
  assert.equal(
    await canUserAccessChannel(target.id, peer.id, asServerId(a.id)),
    false,
    "wrong active server is not borrowed",
  );
  assert.equal(
    await canUserAccessChannel(
      created.jointChannel.canonicalChannelId,
      peer.id,
      asServerId(a.id),
    ),
    false,
    "storage is not an entry",
  );
  await db
    .delete(jointChannelAdmissions)
    .where(eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id));
  assert.equal(await canRead(), true, "source records are not authority");
  const rollbackProbe = new Error("rollback generation visibility probe");
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx
        .delete(jointMembershipGenerations)
        .where(eq(jointMembershipGenerations.principalId, peer.id));
      assert.equal(
        await canUserAccessChannel(target.id, peer.id, asServerId(b.id), {
          executor: tx,
        }),
        true,
        "access reads neither admission history nor the generation counter",
      );
      throw rollbackProbe;
    }),
    (error) => error === rollbackProbe,
  );
  const publicRows = await getChannelMembers(target.id);
  const peerPublic = publicRows.humans.find((row) => row.id === peer.id)!;
  assert.ok(peerPublic, "zero-source J members remain on the roster");
  assert.deepEqual(peerPublic.servers, []);
  assert.equal(
    peerPublic.serverId,
    "",
    "do not expose other current identities as source labels",
  );
  assert.equal(peerPublic.gravatarHash, "");
  assert.ok(
    (await listChannels(b.id, peer.id)).some((row) => row.id === target.id),
    "list includes computed member without CH",
  );
  assert.ok(
    (await filterChannelIdsVisibleToHuman(b.id, peer.id, [target.id])).has(
      target.id,
    ),
  );
  const external = await seed.human();
  await addMember(a.id, external.id);
  await addHuman(created.channel.id, external.id);
  await db
    .delete(jointChannelAdmissions)
    .where(eq(jointChannelAdmissions.userId, external.id));
  const publicProfile = (
    await getComputedJointVisibleHuman(b.id, owner.id, [external.id])
  ).get(external.id)!;
  assert.equal(
    publicProfile.serverId,
    "",
    "J public profile is visible without a source, and reveals no H identity",
  );
  const actors = await resolveActors({
    serverId: b.id,
    requesterId: owner.id,
    actors: [{ kind: "human", id: external.id }],
  });
  assert.equal(actors[0]?.id, external.id);
  assert.equal(actors[0]?.homeServerId, "");
  assert.equal(actors[0]?.gravatarHash, null);

  await db
    .insert(channelHumans)
    .values({ channelId: target.id, userId: outsider.id, role: "admin" });
  assert.equal(
    await canUserAccessChannel(target.id, outsider.id, asServerId(b.id)),
    false,
    "stale local role cannot substitute J member",
  );
  // A Guest of B, bound to a local channel of B, never the joint projection (#wg-rbac:#15).
  await seedBoundGuest({ serverId: b.id, userId: peer.id }, db);
  assert.equal(
    await canRead(),
    false,
    "phase 3 does not turn ordinary guest roles into joint access",
  );
  await db
    .update(serverMembers)
    .set({ role: "member", guestChannelId: null })
    .where(
      and(eq(serverMembers.serverId, b.id), eq(serverMembers.userId, peer.id)),
    );
  await removeHuman(created.channel.id, peer.id, { self: true });
  assert.equal(
    await canRead(),
    false,
    "real member removal denies every computed entry",
  );
  await addHuman(created.channel.id, peer.id);
  const evidence = await db
    .select()
    .from(jointChannelAdmissions)
    .where(
      and(
        eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id),
        eq(jointChannelAdmissions.userId, peer.id),
      ),
    );
  assert.equal(evidence.length, 1);
  await removeHuman(created.channel.id, peer.id, { self: true });
  assert.deepEqual(
    await db
      .select()
      .from(jointChannelAdmissions)
      .where(
        and(
          eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id),
          eq(jointChannelAdmissions.userId, peer.id),
        ),
      ),
    evidence,
    "real removal retains source evidence",
  );
  assert.equal(
    await canUserAccessChannel(created.channel.id, peer.id, asServerId(a.id)),
    false,
    "M-H24: a removed member's leftover CH/admission rows restore no access",
  );
  assert.equal(await canRead(), false);
  await addHuman(created.channel.id, peer.id);
  await removeMember(a.id, peer.id);
  assert.equal(
    await canRead(),
    true,
    "source server departure keeps a member with another connected identity",
  );
  await removeMember(b.id, peer.id);
  assert.equal(
    (
      await db
        .select()
        .from(jointChannelMembers)
        .where(
          and(
            eq(jointChannelMembers.jointChannelId, created.jointChannel.id),
            eq(jointChannelMembers.userId, peer.id),
          ),
        )
    ).length,
    0,
    "departure through computed B with no CH/admission removes the last identity",
  );
  await addMember(b.id, peer.id);
  assert.equal(
    await canRead(),
    false,
    "server rejoin does not silently rejoin the conversation",
  );
}
