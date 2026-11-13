// Channel create and member adds from an action card: a frozen or
// reconfirm-required card is the card's typed 409, not a 500, and a card of
// another server is refused exactly like a missing card.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { actionCards, channels, servers, users } from "../db/schema";
import { createServer, addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addHuman, createChannel, isChannelAgent, isChannelHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest();

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: "not-used-by-this-token-authenticated-test",
    emailVerified: true,
  }).returning();
  assert.ok(user);
  return user;
}

async function seed(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(slug, slug, owner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await addMember(server.id, member.id);
  const requester = await createAgent(server.id, `${slug}-req`.slice(0, 30), { runtime: "codex" });
  const target = await createAgent(server.id, `${slug}-tgt`.slice(0, 30), { runtime: "codex" });
  const channel = await createChannel(server.id, `${slug}-room`.slice(0, 30));
  await addHuman(channel.id, owner.id);
  const message = await createMessage(channel.id, "agent", requester.id, "card");
  await getDb().insert(actionCards).values({
    serverId: server.id,
    messageId: message.id,
    requesterAgentId: requester.id,
    actionType: "channel:create",
    payload: { type: "channel:create", name: "from-card" },
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await accessTokenForTest(owner.id)}`,
    "X-Server-Id": server.id,
  };
  return { owner, member, server, target, channel, messageId: message.id, headers };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function post(baseUrl: string, path: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

/** Each route that takes an action card, and whether its write took effect. */
function routes(f: Fixture) {
  return [
    {
      label: "POST /channels",
      path: "/api/channels",
      body: { name: "card-made" },
      wrote: async () => (await getDb().select({ id: channels.id }).from(channels)
        .where(and(eq(channels.serverId, f.server.id), eq(channels.name, "card-made")))).length > 0,
    },
    {
      label: "POST /channels/:id/members/batch",
      path: `/api/channels/${f.channel.id}/members/batch`,
      body: { agentIds: [f.target.id] },
      wrote: () => isChannelAgent(f.channel.id, f.target.id),
    },
    {
      label: "POST /channels/:id/members (agent)",
      path: `/api/channels/${f.channel.id}/members`,
      body: { agentId: f.target.id },
      wrote: () => isChannelAgent(f.channel.id, f.target.id),
    },
    {
      label: "POST /channels/:id/members (user)",
      path: `/api/channels/${f.channel.id}/members`,
      body: { userId: f.member.id },
      wrote: () => isChannelHuman(f.channel.id, f.member.id),
    },
  ];
}

test("a frozen or reconfirm-required card is the card's 409 on each channel route, not a 500", async ({ app }) => {
  const f = await seed("chcard-409");
  for (const [freezeState, code] of [
    ["frozen", "action_card_conversion_frozen"],
    ["reconfirm_required", "action_card_reconfirmation_required"],
  ] as const) {
    await getDb().update(actionCards).set({ freezeState }).where(eq(actionCards.messageId, f.messageId));
    for (const route of routes(f)) {
      const res = await post(app.baseUrl, route.path, f.headers, { ...route.body, actionCardMessageId: f.messageId });
      assert.equal(res.status, 409, `${route.label} ${freezeState}: ${res.text}`);
      const body = JSON.parse(res.text) as { code?: string; error?: string };
      assert.equal(body.code, code, `${route.label} ${freezeState}`);
      assert.ok(body.error, route.label);
      assert.equal(await route.wrote(), false, `${route.label} wrote despite the ${freezeState} card`);
    }
  }
});

test("another server's card is refused on each channel route exactly like a missing card", async ({ app }) => {
  const a = await seed("chcard-scope-a");
  const b = await seed("chcard-scope-b");
  for (const freezeState of ["ready", "reconfirm_required"] as const) {
    await getDb().update(actionCards).set({ freezeState }).where(eq(actionCards.messageId, b.messageId));
    for (const route of routes(a)) {
      const missing = await post(app.baseUrl, route.path, a.headers, { ...route.body, actionCardMessageId: randomUUID() });
      assert.equal(missing.status, 409, `${route.label} missing: ${missing.text}`);
      const res = await post(app.baseUrl, route.path, a.headers, { ...route.body, actionCardMessageId: b.messageId });
      assert.equal(res.status, missing.status, `${route.label} ${freezeState}: ${res.text}`);
      assert.equal(res.text, missing.text, `${route.label} ${freezeState}`);
      assert.equal(await route.wrote(), false, `${route.label} wrote with another server's ${freezeState} card`);
    }
  }
  // Control: server B's own owner can use its ready card.
  await getDb().update(actionCards).set({ freezeState: "ready" }).where(eq(actionCards.messageId, b.messageId));
  const own = await post(app.baseUrl, `/api/channels/${b.channel.id}/members`, b.headers, { agentId: b.target.id, actionCardMessageId: b.messageId });
  assert.equal(own.status, 200, own.text);
  assert.ok(await isChannelAgent(b.channel.id, b.target.id));
});
