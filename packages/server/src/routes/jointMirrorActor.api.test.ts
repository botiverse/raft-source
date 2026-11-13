import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { jointChannelServers, jointMembershipDepartures } from "../db/schema";
import { acceptJointChannelInvite, createJointChannel, deleteChannel } from "../services/channelService";
import type { createSeed } from "../test/integration/seed";

// Who ends a joint copy (joint_channel_servers.disconnected_by_user_id) and who
// its departure's removals are attributed to (joint_membership_departures
// actor_user_id), when a removal, leave or deletion empties or retires a
// partner server's side.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Seed = ReturnType<typeof createSeed>;

async function headers(userId: string, serverId: string) {
  return {
    Authorization: `Bearer ${await accessTokenForTest(userId)}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

/** A computed joint hosted by `a`, connected to `b`, whose B side is only B's owner. */
async function partnerJoint(seed: Seed) {
  const hostOwner = await seed.human();
  const peerOwner = await seed.human();
  const a = await seed.server({ owner: hostOwner });
  const b = await seed.server({ owner: peerOwner });
  const created = await createJointChannel({
    hostServerId: a.id, createdByUserId: hostOwner.id, name: "mirror-actor", targetServerSlug: b.slug,
    invitedPeople: [`@${peerOwner.name}`],
  });
  const target = await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id });
  return { hostOwner, peerOwner, a, b, hostCopy: created.channel, targetCopy: target };
}

/** B's copy after the change: its status, who disconnected it, and its departure's actor. */
async function bSide(targetCopyId: string) {
  const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, targetCopyId));
  const departures = await getDb().select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, targetCopyId));
  return { status: projection?.status, disconnectedBy: projection?.disconnectedByUserId, departureActors: departures.map((row) => row.actorUserId) };
}

test("an admin removing the last member of a partner side is recorded on its disconnect and departure", async ({ app, seed }) => {
  const x = await partnerJoint(seed);
  const res = await fetch(`${app.baseUrl}/api/channels/${x.hostCopy.id}/members/user/${x.peerOwner.id}`, { method: "DELETE", headers: await headers(x.hostOwner.id, x.a.id) });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(await bSide(x.targetCopy.id), { status: "disconnected", disconnectedBy: x.hostOwner.id, departureActors: [x.hostOwner.id] });
});

test("a self-leave that empties a partner side records the person who left", async ({ app, seed }) => {
  const x = await partnerJoint(seed);
  const res = await fetch(`${app.baseUrl}/api/channels/${x.targetCopy.id}/leave`, { method: "POST", headers: await headers(x.peerOwner.id, x.b.id) });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(await bSide(x.targetCopy.id), { status: "disconnected", disconnectedBy: x.peerOwner.id, departureActors: [x.peerOwner.id] });
});

test("deleting a joint copy records the admin who deleted it", async ({ seed }) => {
  const x = await partnerJoint(seed);
  // The route refuses a joint channel; the service retires its copy as for a converting source.
  await deleteChannel(x.targetCopy.id, { deletedByUserId: x.peerOwner.id });
  assert.deepEqual(await bSide(x.targetCopy.id), { status: "disconnected", disconnectedBy: x.peerOwner.id, departureActors: [x.peerOwner.id] });
});

test("deleting a partner server records the owner who deleted it", async ({ app, seed }) => {
  const x = await partnerJoint(seed);
  const res = await fetch(`${app.baseUrl}/api/servers/${x.b.id}`, { method: "DELETE", headers: await headers(x.peerOwner.id, x.b.id) });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(await bSide(x.targetCopy.id), { status: "disconnected", disconnectedBy: x.peerOwner.id, departureActors: [x.peerOwner.id] });
});
