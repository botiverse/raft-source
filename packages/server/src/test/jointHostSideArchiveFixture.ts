// Shared by the joint host-side archive API and real-PostgreSQL tests: a joint
// hosted by "JHSA Host" with its owner as the only host-side member, accepted by
// "JHSA Peer" (owner + a member), computed membership on, and the host's
// external_channels_v1 on unless `externalChannels: false`.
import assert from "node:assert/strict";
import { getDb } from "../db/index";
import { and, eq } from "drizzle-orm";
import { jointChannelMembers, serverMembers } from "../db/schema";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { seedBoundGuest } from "./guestFixture";
import { addMember } from "../services/serverService";
import { resolveJointHumanMembershipScopes } from "../services/jointHumanMembershipAccess";
import { tokenForHuman } from "./integration/credentials";
import { enableExternalChannelsFlag } from "./externalInviteFixture";
import { createServer, headers, seedUser } from "../routes/channels.api.fixtures";

export async function seedJoint(baseUrl: string, options: { externalChannels?: boolean } = {}) {
  const db = getDb();
  const hostOwner = await seedUser("jhsa-host-owner@slock.test", "jhsa-host-owner");
  const hostAdmin = await seedUser("jhsa-host-admin@slock.test", "jhsa-host-admin");
  const hostMember = await seedUser("jhsa-host-member@slock.test", "jhsa-host-member");
  const peerOwner = await seedUser("jhsa-peer-owner@slock.test", "jhsa-peer-owner");
  const peerMember = await seedUser("jhsa-peer-member@slock.test", "jhsa-peer-member");
  const hostServer = await createServer("JHSA Host", "jhsa-host", hostOwner.id);
  const peerServer = await createServer("JHSA Peer", "jhsa-peer", peerOwner.id);
  await addMember(hostServer.id, hostAdmin.id, "admin");
  await addMember(hostServer.id, hostMember.id, "member");
  await addMember(peerServer.id, peerMember.id, "member");
  const token = {
    hostOwner: await tokenForHuman(hostOwner.email),
    hostAdmin: await tokenForHuman(hostAdmin.email),
    hostMember: await tokenForHuman(hostMember.email),
    peerOwner: await tokenForHuman(peerOwner.email),
    peerMember: await tokenForHuman(peerMember.email),
  };

  const created = await fetch(`${baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(token.hostOwner, hostServer.id),
    body: JSON.stringify({ name: "jhsa-room", visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`] }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const hostProjection = await created.json() as { id: string; jointInvite: { id: string } };
  const accepted = await fetch(`${baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(token.peerOwner, peerServer.id),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const peerProjection = await accepted.json() as { id: string };
  const added = await fetch(`${baseUrl}/api/channels/${peerProjection.id}/members`, {
    method: "POST",
    headers: headers(token.peerOwner, peerServer.id),
    body: JSON.stringify({ userId: peerMember.id }),
  });
  assert.equal(added.status, 200, await added.clone().text());
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [peerProjection.id] }, db)).get(peerProjection.id);
  assert.ok(scope, "fixture: a joint projection");
  // On after creation: external channels retire creating a joint this way.
  if (options.externalChannels !== false) await enableExternalChannelsFlag(hostServer.id);
  return { hostServer, peerServer, hostProjection, peerProjection, hostOwner, hostAdmin, hostMember, peerOwner, peerMember, token };
}
export type JointHostSideFixture = Awaited<ReturnType<typeof seedJoint>>;

/**
 * P3: a Guest of the host bound to the host's copy and admitted to the joint
 * (as an accepted external invite leaves it), with a token for its own view.
 */
export async function addBoundHostGuest(f: JointHostSideFixture) {
  const guest = await seedUser("jhsa-host-guest@slock.test", "jhsa-host-guest");
  await seedBoundGuest({ serverId: f.hostServer.id, userId: guest.id, channelId: f.hostProjection.id });
  await getDb().transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [f.hostProjection.id] }, "join");
    await mirror.apply([guest.id], { actorUserId: f.hostOwner.id });
  });
  const [joined] = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.userId, guest.id)));
  assert.ok(joined, "fixture: the Guest is a joint member");
  return { guest, token: await tokenForHuman(guest.email) };
}

/** Whether the Guest still has its host membership and joint membership. */
export async function guestState(f: JointHostSideFixture, guestId: string) {
  const member = await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.hostServer.id), eq(serverMembers.userId, guestId)));
  const joint = await getDb().select().from(jointChannelMembers).where(eq(jointChannelMembers.userId, guestId));
  return { hostMember: member.length > 0, jointMember: joint.length > 0 };
}
