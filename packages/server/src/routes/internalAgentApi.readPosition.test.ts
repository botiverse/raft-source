import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// An agent's read position must never pass a message it was not handed.
//
// Pins:
//   1. /events `has_more` is true whenever the durable inbox pull stopped at a
//      cap (here: 5 rows per conversation), so a client paging on it drains all;
//   2. an agent's own send advances its cursor only when nothing unread from
//      others lies below its message; otherwise those stay unread and are pulled;
//   3. the agent's own message never comes back to it through its own pull;
//   4. a human's send still advances the human's cursor as before.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { userChannelReadCursors, users } from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  addAgent,
  addHuman,
  createChannel,
  getAgentLegacyReadCursor,
  markAgentLegacyRead,
  type AgentInboxChainSelection,
} from "../services/channelService";
import {
  broadcastAndDeliver,
  createMessage,
  drainSenderReadReceiptsForTests,
  __setExternalAgentInboxChainSelectorForTests,
} from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { withChannelDelivery } from "../test/orchestratorStub";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

__setExternalAgentInboxChainSelectorForTests(async (agentId: string): Promise<AgentInboxChainSelection> => (
  { source: "chain", rows: await referenceAgentInboxChain(agentId) }
));

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user!;
}

async function seed() {
  const owner = await seedUser("read-position-owner");
  const other = await seedUser("read-position-other");
  const server = await createServer("Read Position", `read-position-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, `ReadPos${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, `read-position-${randomUUID().slice(0, 6)}`);
  await addMember(server.id, other.id);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, other.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "read-position", issuedVia: "computer", createdByUserId: null });
  return { owner, other, serverId: server.id, channelId: channel.id, agentId: agent.id, apiKey: minted.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function humanMessage(f: Fixture, content: string, senderId = f.owner.id) {
  const message = await createMessage(f.channelId, "user", senderId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: f.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

/** The send pipeline (persist, sender read position, delivery), as the send routes run it. */
async function send(app: { io: unknown }, senderType: "user" | "agent", senderId: string, f: Fixture, content: string) {
  const orchestrator = withChannelDelivery({ deliverMessage: async () => ({ status: "queued", reason: "replayable_inbox" }) }) as unknown as AgentOrchestrator;
  const sent = await broadcastAndDeliver(app.io as Parameters<typeof broadcastAndDeliver>[0], orchestrator, {
    channelId: f.channelId,
    senderType,
    senderId,
    senderName: "sender",
    content,
  });
  await drainSenderReadReceiptsForTests();
  return sent as { id: string; seq: number };
}

async function events(baseUrl: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/events`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(res.status, 200);
  return await res.json() as { events: Array<{ seq: number; message_id: string }>; has_more: boolean };
}

test("/events: a conversation cut at the per-conversation cap reports has_more; the next call returns the rest", async ({ app }) => {
  const f = await seed();
  const sent = [];
  for (let i = 0; i < 10; i += 1) sent.push(await humanMessage(f, `unread ${i}`));
  app.app.set("agentOrchestrator", new AgentOrchestrator());

  const first = await events(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), sent.slice(0, 5).map((m) => m.seq));
  assert.equal(first.has_more, true, "5 of 10 unread returned: there is more");
  const second = await events(app.baseUrl, f.apiKey);
  assert.deepEqual(second.events.map((e) => e.seq), sent.slice(5).map((m) => m.seq));
  assert.equal(second.has_more, false);
  assert.deepEqual((await events(app.baseUrl, f.apiKey)).events, []);
});

test("agent send with unread from others below: cursor stays, the unread is still pulled, the own message is not", async ({ app }) => {
  const f = await seed();
  const base = await humanMessage(f, "read");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const unread1 = await humanMessage(f, "not handed over yet 1");
  const unread2 = await humanMessage(f, "not handed over yet 2");

  const own = await send(app, "agent", f.agentId, f, "the agent's reply");
  assert.ok(own.seq > unread2.seq);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), base.seq, "the send did not read through unseen messages");

  app.app.set("agentOrchestrator", new AgentOrchestrator());
  const pulled = await events(app.baseUrl, f.apiKey);
  assert.deepEqual(pulled.events.map((e) => e.seq), [unread1.seq, unread2.seq], "still delivered; the own message is not");
  assert.ok(!pulled.events.some((e) => e.message_id === own.id));
  assert.deepEqual((await events(app.baseUrl, f.apiKey)).events, [], "and nothing loops");
});

test("agent send with nothing unread below: the cursor advances to the own message", async ({ app }) => {
  const f = await seed();
  const base = await humanMessage(f, "read");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const own = await send(app, "agent", f.agentId, f, "reply with nothing pending");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), own.seq);

  // Its own earlier messages below do not hold the cursor back either.
  const ownAgain = await send(app, "agent", f.agentId, f, "second reply");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), ownAgain.seq);
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  assert.deepEqual((await events(app.baseUrl, f.apiKey)).events, [], "own messages never come back through the pull");
});

test("human send: the sender's cursor still advances to its own message regardless of unread below", async ({ app }) => {
  const f = await seed();
  await humanMessage(f, "from the other human, unread for the owner", f.other.id);
  const own = await send(app, "user", f.owner.id, f, "owner writes");
  const [cursor] = await getDb().select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
    .from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, f.owner.id), eq(userChannelReadCursors.channelId, f.channelId)));
  assert.equal(cursor?.lastReadSeq, own.seq);
});
