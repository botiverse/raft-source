import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// The preparing agent learns how its action card resolved through a durable
// system reply in the card's thread that @mentions it: an unread personal
// mention fact (replayable) + ordinary delivery for managed agents, and the
// same durable row through /events for external agents. The reply is never a
// carrier for secret material.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, inboxNotificationFacts, jointChannels, jointChannelServers, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { prepareActionCard } from "../services/actionCardsService";
import { __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// CI has no RisingWave: serve the external inbox chain from the reference view.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({
  source: "chain",
  rows: await referenceAgentInboxChain(agentId),
}));

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function authHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

type Delivery = { agentId: string; payload: Record<string, unknown>; options: Record<string, unknown> | undefined };

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
  // Exactly the orchestrator surface these flows use (no catch-all: a method
  // the code starts calling must be added here, not silently answered).
  const deliverMessage = async (agentId: string, payload: Record<string, unknown>, options?: Record<string, unknown>) => {
    deliveries.push({ agentId, payload, options });
    return { status: "queued", reason: "test" };
  };
  const stub = {
    deliverMessage,
    deliverMessagesOnChannel: (
      _channelId: string,
      batch: ReadonlyArray<{ agentId: string; message: Record<string, unknown>; options?: Record<string, unknown> }>,
    ) => batch.map(({ agentId, message, options }) => deliverMessage(agentId, message, options)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  };
  app.set("agentOrchestrator", stub);
  return deliveries;
}

async function findResultReply(agentName: string, threadChannelId?: string) {
  const rows = await getDb().select().from(messages).where(eq(messages.systemSubtype, "action_card.result_reply"));
  return rows.filter((row) => row.content.startsWith(`@${agentName} `) && (!threadChannelId || row.channelId === threadChannelId));
}

async function execute(baseUrl: string, messageId: string, token: string, serverId: string) {
  return fetch(`${baseUrl}/api/actions/${messageId}/execute`, {
    method: "POST",
    headers: authHeaders(token, serverId),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ expectedState: "prepared" }),
  });
}

test("a managed preparer gets an unread @mention reply in the card thread when its card executes, and when execution fails", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("card-reply-owner");
  const server = await createServer("Card Reply", `card-reply-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await channelService.createChannel(server.id, "card-reply-room");
  await channelService.addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, "card-reply-agent", { runtime: "claude" });
  await channelService.addAgent(channel.id, agent.id);
  const deliveries = installRecordingOrchestrator(app.app);
  const token = await tokenForHuman(owner.email);

  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: { type: "channel:create", name: "card-reply-created", visibility: "public" },
  });
  const executed = await execute(app.baseUrl, card.messageId, token, server.id);
  assert.equal(executed.status, 200, await executed.clone().text());

  const [thread] = await db.select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, card.messageId)));
  assert.ok(thread, "the reply opens the card's thread");
  const [reply] = await findResultReply(agent.name, thread.id);
  assert.ok(reply, "durable result reply persisted in the card thread");
  assert.match(reply.content, new RegExp(`executed by @${owner.name} on Card Reply`));
  assert.match(reply.content, /created channel #card-reply-created/);
  assert.match(reply.content, new RegExp(card.messageId.slice(0, 8)));

  const [agentFact] = await db.select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, reply.id),
    eq(inboxNotificationFacts.receiverType, "agent"),
    eq(inboxNotificationFacts.receiverId, agent.id),
  ));
  assert.ok(agentFact, "the preparer has a durable inbox fact (replayable)");
  assert.equal(agentFact.personalMention, true);
  assert.equal(agentFact.unreadEligible, true, "the reply is unread for the preparer — it must wake it");
  const confirmerFacts = await db.select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, reply.id),
    eq(inboxNotificationFacts.receiverType, "user"),
    eq(inboxNotificationFacts.receiverId, owner.id),
  ));
  assert.ok(confirmerFacts.every((fact) => fact.unreadEligible === false), "born-read for the confirming human");
  const chainRow = (await referenceAgentInboxChain(agent.id)).find((row) => row.targetId === thread.id);
  assert.ok(chainRow, "the card thread is in the agent's durable inbox chain");
  assert.ok(chainRow.unreadCount > 0 && (chainRow.latestSeq ?? 0) >= reply.seq, "the reply is durable unread for the preparer");
  assert.ok(chainRow.mentionUnread > 0, "the reply counts as an unread mention");

  const delivered = deliveries.find((delivery) => delivery.agentId === agent.id && delivery.payload.message_id === reply.id);
  assert.ok(delivered, "the managed preparer is woken with the persisted reply");
  assert.equal(delivered.payload.mentioned, true);
  assert.notEqual(delivered.options?.transient, true, "the result is not a transient notice");

  // A genuine execution failure is reported too, and the card stays pending.
  const failing = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: { type: "channel:create", name: "card-reply-created", visibility: "public" },
  });
  const failed = await execute(app.baseUrl, failing.messageId, token, server.id);
  assert.notEqual(failed.status, 200);
  const [failThread] = await db.select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, failing.messageId)));
  assert.ok(failThread);
  const [failReply] = await findResultReply(agent.name, failThread.id);
  assert.ok(failReply, "failure reply persisted in the failing card's thread");
  assert.match(failReply.content, /failed when/);
  assert.match(failReply.content, /still pending and can be retried/);
});

test("an external preparer of a Joint card receives the result reply through /events from the canonical thread", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("card-reply-joint-host");
  const peerOwner = await seedUser("card-reply-joint-peer");
  const hostServer = await createServer("Reply Host", `reply-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  const peerServer = await createServer("Reply Peer", `reply-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, "reply-joint-storage", undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, "reply-joint", undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, "reply-joint", undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
  // A human of the host server who is also eligible on the peer (target) server.
  const dual = await seedUser("card-reply-joint-dual");
  await db.insert(serverMembers).values([
    { serverId: hostServer.id, userId: dual.id, role: "member" },
    { serverId: peerServer.id, userId: dual.id, role: "member" },
  ]);
  await channelService.addHuman(hostProjection.id, dual.id);
  await channelService.addHuman(peerProjection.id, dual.id);

  const agent = await createAgent(peerServer.id, "ReplyExternal", { runtime: "external", model: "external" });
  await channelService.addAgent(peerProjection.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "reply-external", issuedVia: "computer", createdByUserId: null });
  app.app.set("agentOrchestrator", new AgentOrchestrator());

  const prepared = await fetch(`${app.baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ target: `#${peerProjection.name}`, action: { type: "channel:create", name: "reply-joint-created" } }),
  });
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { messageId } = await prepared.json() as { messageId: string };
  // Drain the agent's own earlier activity so only new items remain.
  await fetch(`${app.baseUrl}/internal/agent-api/events`, { headers: { Authorization: `Bearer ${apiKey}` } });

  const executed = await execute(app.baseUrl, messageId, await tokenForHuman(dual.email), hostServer.id);
  assert.equal(executed.status, 200, await executed.clone().text());

  const [canonicalThread] = await db.select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId)));
  assert.ok(canonicalThread, "canonical thread exists for the canonical carrier");
  const [reply] = await findResultReply(agent.name, canonicalThread.id);
  assert.ok(reply, "the reply persists in the canonical Joint thread");
  assert.match(reply.content, /on Reply Peer/);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/events`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(res.status, 200);
  const body = await res.json() as { events: Array<{ message_id?: string; content?: string }> };
  const event = body.events.find((candidate) => candidate.message_id === reply.id);
  assert.ok(event, `external preparer must receive the result reply via /events, got ${JSON.stringify(body.events.map((e) => e.message_id))}`);
  assert.match(event.content ?? "", /created channel #reply-joint-created/);
});

// #bug-triage task #29: a joint thread's local projection has no parent
// message, so the card's membership authority resolved to null and every card
// in a joint thread was refused with 403.
test("a member can confirm an action card prepared inside a Joint thread", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("card-joint-thread-host");
  const peerOwner = await seedUser("card-joint-thread-peer");
  const hostServer = await createServer("Thread Host", `thread-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  const peerServer = await createServer("Thread Peer", `thread-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, "thread-joint-storage", undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, "thread-joint", undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, "thread-joint", undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();

  const agent = await createAgent(peerServer.id, "ThreadExternal", { runtime: "external", model: "external" });
  await channelService.addAgent(peerProjection.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "thread-external", issuedVia: "computer", createdByUserId: null });
  app.app.set("agentOrchestrator", new AgentOrchestrator());

  const peerToken = await tokenForHuman(peerOwner.email);
  const root = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(peerToken, peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ channelId: peerProjection.id, content: "thread root" }),
  });
  assert.equal(root.status, 200, await root.clone().text());
  const { id: rootId } = await root.json() as { id: string };

  const prepared = await fetch(`${app.baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ target: `#${peerProjection.name}:${rootId.slice(0, 8)}`, action: { type: "channel:create", name: "thread-joint-created" } }),
  });
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { messageId } = await prepared.json() as { messageId: string };

  const executed = await execute(app.baseUrl, messageId, peerToken, peerServer.id);
  assert.equal(executed.status, 200, await executed.clone().text());
});
