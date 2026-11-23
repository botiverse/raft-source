// The composer's "add the person you mentioned" offer and its execution follow
// addHuman's Guest rule: a Guest joins only its one bound channel, so Add is
// offered (and runs) for a Guest only there, never in another channel or a
// thread under one.
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import assert from "node:assert/strict";
import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";

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

type Pending = { resolutionId: string; targetType: string; availableActions: string[] };

test("Add is offered and runs for a mentioned Guest only in its bound channel", async ({ app }) => {
  const owner = await seedUser("mention-add-guest-owner@slock.test", "mentionAddGuestOwner");
  const guest = await seedUser("mention-add-guest-guest@slock.test", "mentionAddGuestGuest");
  const member = await seedUser("mention-add-guest-member@slock.test", "mentionAddGuestMember");
  const server = await createServer("Mention Add Guest", "mention-add-guest", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]).onConflictDoNothing();
  const home = await createChannel(server.id, "mention-add-guest-home");
  const other = await createChannel(server.id, "mention-add-guest-other");
  await addHuman(home.id, owner.id);
  await addHuman(other.id, owner.id);
  // Bound to #home but not in it right now (e.g. removed): #home is where it may be added back.
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: home.id, member: false });
  const parent = await createMessage(other.id, "user", owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const token = await tokenForHuman(owner.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };

  async function send(channelId: string) {
    const res = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        channelId,
        content: `hi @${guest.name} and @${member.name}`,
        mentions: [
          { type: "user", id: guest.id, name: guest.name },
          { type: "user", id: member.id, name: member.name },
        ],
      }),
    });
    const body = await res.json() as { pendingMentionActions: Pending[] };
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.pendingMentionActions;
  }
  async function execute(resolutionId: string) {
    const res = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "add", resolutionIds: [resolutionId] }),
    });
    assert.equal(res.status, 200);
    return (await res.json() as { results: Array<{ status: string; reason?: string }> }).results[0];
  }
  for (const [label, channelId] of [["another channel", other.id], ["a thread under another channel", thread.id]] as const) {
    const pending = await send(channelId);
    assert.equal(pending.length, 2, `${label}: both mentions are pending`);
    const byAdd = pending.map((p) => p.availableActions.includes("add"));
    assert.equal(byAdd.filter(Boolean).length, 1, `${label}: Add is offered for the member only, not the Guest`);
    const guestPending = pending.find((p) => !p.availableActions.includes("add"))!;
    assert.deepEqual(guestPending.availableActions, ["notify"]);
    const result = await execute(guestPending.resolutionId);
    assert.equal(result.status, "no_permission", `${label}: adding the Guest is refused before the write`);
    assert.equal(result.reason, "add_not_allowed_for_surface");
  }

  // Its bound channel: Add is offered and adds it.
  const homePending = await send(home.id);
  assert.equal(homePending.length, 2);
  for (const p of homePending) assert.deepEqual(p.availableActions, ["notify", "add"]);
  for (const p of homePending) {
    const result = await execute(p.resolutionId);
    assert.equal(result.status, "delivered", JSON.stringify(result));
  }
});
