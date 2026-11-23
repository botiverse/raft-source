// A Guest is in its one bound channel only (channelService.addHuman), so no
// channel create path may start a new channel with a Guest in it: the create
// route refuses it with addHuman's 403, and createChannel (used by the route
// and by the create-channel action card) refuses it before any write. The
// action card leaves a Guest out, as it already leaves out a non-member.
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelHumans, channels, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addAgent, addHuman, createChannel, GUEST_OTHER_CHANNEL_CODE, GUEST_OTHER_CHANNEL_MESSAGE } from "../services/channelService";
import { createAgent } from "../services/agentService";
import { prepareActionCard } from "../services/actionCardsService";
import { asServerId } from "@botiverse/raft-shared";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

test("a new channel can't start with a Guest in it; a member is still fine", async ({ app }) => {
  const owner = await seedUser("create-guest-owner@slock.test", "createGuestOwner");
  const guest = await seedUser("create-guest-guest@slock.test", "createGuestGuest");
  const member = await seedUser("create-guest-member@slock.test", "createGuestMember");
  const server = await createServer("Create Guest Member", "create-guest-member", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]).onConflictDoNothing();
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const token = await tokenForHuman(owner.email);

  for (const visibility of ["public", "private"] as const) {
    const name = `create-guest-${visibility}`;
    const res = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ name, visibility, userIds: [member.id, guest.id] }),
    });
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(res.status, 403, `${visibility}: ${JSON.stringify(body)}`);
    assert.equal(body.code, GUEST_OTHER_CHANNEL_CODE);
    assert.equal(body.error, GUEST_OTHER_CHANNEL_MESSAGE);
    const made = await getDb().select({ id: channels.id }).from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, name)));
    assert.equal(made.length, 0, `${visibility}: nothing is created`);

    const ok = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ name, visibility, userIds: [member.id] }),
    });
    assert.equal(ok.status < 300, true, `${visibility}: a member alone is fine (${ok.status})`);
  }

  // The service itself (the create-channel action card's path) refuses too, before any write.
  await assert.rejects(
    createChannel(server.id, "create-guest-service", undefined, "private", { type: "user", id: owner.id, initialUserIds: [guest.id] }),
    { message: GUEST_OTHER_CHANNEL_MESSAGE },
  );
  const stray = await getDb().select({ channelId: channelHumans.channelId }).from(channelHumans)
    .innerJoin(channels, eq(channels.id, channelHumans.channelId))
    .where(and(eq(channelHumans.userId, guest.id), eq(channels.name, "create-guest-service")));
  assert.equal(stray.length, 0);
});

test("the create-channel action card leaves a Guest out, like a non-member, and still creates the channel", async ({ app }) => {
  const owner = await seedUser("card-guest-owner@slock.test", "cardGuestOwner");
  const guest = await seedUser("card-guest-guest@slock.test", "cardGuestGuest");
  const member = await seedUser("card-guest-member@slock.test", "cardGuestMember");
  const server = await createServer("Card Guest", "card-guest", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]).onConflictDoNothing();
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const agent = await createAgent(server.id, "card-guest-agent", { runtime: "codex" });
  const carrier = await createChannel(server.id, "card-guest-carrier");
  await addHuman(carrier.id, owner.id);
  await addAgent(carrier.id, agent.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: carrier.id,
    action: { type: "channel:create", name: "card-guest-created", visibility: "public", initialHumans: [member.id, guest.id] },
  });
  const res = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(res.status < 300, true, `${res.status} ${await res.clone().text()}`);
  const [created] = await getDb().select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "card-guest-created")));
  assert.ok(created, "the channel is created");
  const humans = await getDb().select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, created.id));
  const ids = humans.map((h) => h.userId);
  assert.ok(ids.includes(member.id), "the member is in it");
  assert.ok(!ids.includes(guest.id), "the Guest is left out");
});
