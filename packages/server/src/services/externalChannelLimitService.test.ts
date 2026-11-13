// What makes a channel external for the free plan's one-external-channel rule
// (#wg-rbac:#16, P2a-2). The Guest side is covered through the API in
// routes/externalInviteAccept.api.test.ts; this covers joint channels.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { servers, users } from "../db/schema";
import { acceptJointChannelInvite, createChannel, createJointChannel } from "./channelService";
import { assertCanAdmitExternalGuest, ExternalChannelLimitError, hasOtherExternalChannel } from "./externalChannelLimitService";
import { createServer } from "./serverService";

async function seedServer(label: string, plan: "free" | "pro") {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(`${label} ${suffix}`, `${label}-${suffix}`, owner!.id);
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  return { owner: owner!, server };
}

test("a joint channel another server joined is external, for its host and for the joined server; a pending one is not", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const peer = await seedServer("peer", "pro");
  const room = await createChannel(host.server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: host.owner.id });
  const peerRoom = await createChannel(peer.server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: peer.owner.id });
  const joint = await createJointChannel({
    hostServerId: host.server.id,
    createdByUserId: host.owner.id,
    name: `joint-${randomUUID().slice(0, 8)}`,
    jointInvites: [{ targetServerSlug: peer.server.slug, invitedPeople: [peer.owner.email] }],
  });
  const now = new Date();

  // Only invited so far.
  assert.equal(await hasOtherExternalChannel(getDb(), host.server.id, room.id), false);
  await assertCanAdmitExternalGuest(getDb(), { serverId: host.server.id, channelId: room.id, now });

  await acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: peer.server.id, acceptedByUserId: peer.owner.id });
  assert.equal(await hasOtherExternalChannel(getDb(), host.server.id, room.id), true, "hosting a joined joint");
  assert.equal(await hasOtherExternalChannel(getDb(), peer.server.id, peerRoom.id), true, "participating in one");
  assert.equal(await hasOtherExternalChannel(getDb(), host.server.id, joint.channel.id), false, "the joint itself is not another channel");
  await assert.rejects(
    assertCanAdmitExternalGuest(getDb(), { serverId: host.server.id, channelId: room.id, now }),
    (error: unknown) => error instanceof ExternalChannelLimitError && error.code === "free_external_limit",
  );
  // The peer is paid: not limited.
  await assertCanAdmitExternalGuest(getDb(), { serverId: peer.server.id, channelId: peerRoom.id, now });
});
