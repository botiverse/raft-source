import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { formatAgentMessageTarget, type ActivityTurnTrigger, type AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelAgents, channels, externalActorProjections, inboxNotificationFacts, messageMentions, messages, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { upsertAgentTurnSummaries } from "../services/agentActivityLogService";
import * as channelService from "../services/channelService";
import { insertCanonicalExternalMessage } from "../services/externalProjectionService";
import { deliverExternalInboundCommittedMessageToAgents } from "../services/messageService";
import { createServer } from "../services/serverService";
import { seedJointChannel } from "../test/integration/jointFixture";

// Turn triggers named by the server (`trigger.display`, #10838 review): each
// trigger here is what the delivery path actually handed the agent, built the
// way the daemon builds it (turnTriggerFromMessages), so joint channels and
// threads, channels converted to joint, and Slack root mentions resolve.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function authHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

type App = { app: { get(name: string): unknown }; baseUrl: string };

/** Every message the test app's orchestrator is handed for an agent, as delivered. */
function recordDeliveries(app: App): Array<{ agentId: string; payload: AgentMessage }> {
  const deliveries: Array<{ agentId: string; payload: AgentMessage }> = [];
  Object.assign(app.app.get("agentOrchestrator") as object, {
    deliverMessage: async (agentId: string, payload: AgentMessage) => {
      deliveries.push({ agentId, payload });
      return { status: "queued" };
    },
  });
  return deliveries;
}

async function waitForDelivery(deliveries: Array<{ agentId: string; payload: AgentMessage }>, agentId: string, messageId: string): Promise<AgentMessage> {
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    const hit = deliveries.find((delivery) => delivery.agentId === agentId && delivery.payload.message_id === messageId);
    if (hit) return hit.payload;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no delivery of ${messageId} to ${agentId}`);
}

/** The trigger a daemon reports for a turn this message woke (daemon turnTriggerFromMessages). */
function triggerFromDelivery(payload: AgentMessage): ActivityTurnTrigger {
  return {
    target: formatAgentMessageTarget({ ...payload }),
    ...(payload.channel_id ? { channelId: payload.channel_id } : {}),
    ...(payload.sender_name ? { sender: payload.sender_name } : {}),
    ...(payload.message_id ? { messageId: payload.message_id } : {}),
  };
}

async function storeTurns(agentId: string, triggers: readonly ActivityTurnTrigger[]) {
  const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 1, problems: [], problemCount: 0, messagesSent: 0 };
  const t = Date.now() - 60 * 60_000;
  // Newest first, as the overview lists them.
  await upsertAgentTurnSummaries(agentId, triggers.map((trigger, index) => {
    const startedAt = t - index * 10_000;
    return { turnKey: `daemon:${startedAt}`, summary: { ...base, startedAt, endedAt: startedAt + 1_000, trigger } };
  }));
}

async function readTriggers(app: App, agentId: string, viewerEmail: string, serverId: string) {
  const real = new AgentOrchestrator();
  Object.assign(app.app.get("agentOrchestrator") as object, {
    getActivity: async () => ({ activity: "online", activityDetail: "" }),
    listTurnSummaries: (id: string, options: Parameters<AgentOrchestrator["listTurnSummaries"]>[1]) => real.listTurnSummaries(id, options),
    getTurnSummary: (id: string, rowId: string) => real.getTurnSummary(id, rowId),
    getRunningTurn: (id: string, afterMs: number | null) => real.getRunningTurn(id, afterMs),
  });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(viewerEmail), serverId),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summaries: Array<{ trigger?: Record<string, unknown> }> };
    return body.summaries.map((summary) => summary.trigger);
  } finally {
    real.shutdown();
  }
}

async function post(app: App, token: string, serverId: string, channelId: string, content: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(token, serverId),
    body: JSON.stringify({ channelId, content }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return (JSON.parse(text) as { id: string }).id;
}

test("activity-summaries names joint channel and joint thread triggers as delivered: this server's channel, the message in canonical storage", async ({ app }) => {
  const host = await seedUser("trigger-joint-host@slock.test", "trigger-joint-host");
  const alice = await seedUser("trigger-joint-alice@slock.test", "trigger-joint-alice");
  const hostServer = await createServer("Trigger Joint Host", "trigger-joint-host", host.id);
  const peerServer = await createServer("Trigger Joint Peer", "trigger-joint-peer", alice.id);
  const joint = await seedJointChannel({ name: "trigger-shared", serverIds: [hostServer.id, peerServer.id], createdByUserId: host.id });
  const [hostFace, peerFace] = joint.projections as [typeof joint.projections[number], typeof joint.projections[number]];
  const agent = await createAgent(hostServer.id, "trigger-joint-agent", { runtime: "claude", creatorType: "user", creatorId: host.id });
  await channelService.addHuman(hostFace.id, host.id);
  await channelService.addHuman(peerFace.id, alice.id);
  await channelService.addAgent(hostFace.id, agent.id);
  const deliveries = recordDeliveries(app);
  const aliceToken = await tokenForHuman(alice.email);

  // Alice posts from her server; the agent is handed it with the host's channel.
  const rootId = await post(app, aliceToken, peerServer.id, peerFace.id, `hello @${agent.name}`);
  const root = await waitForDelivery(deliveries, agent.id, rootId);
  assert.equal(root.channel_id, hostFace.id, "delivered with this server's channel");
  // And replies in the thread under it, through her face of the thread.
  const aliceThread = await channelService.getOrCreateThreadForChannel(peerFace.id, rootId, alice.id, "user");
  const replyId = await post(app, aliceToken, peerServer.id, aliceThread.id, `in the thread @${agent.name}`);
  const reply = await waitForDelivery(deliveries, agent.id, replyId);
  assert.notEqual(reply.channel_id, aliceThread.id, "delivered with the host's face of the thread");

  await storeTurns(agent.id, [triggerFromDelivery(root), triggerFromDelivery(reply)]);
  const triggers = await readTriggers(app, agent.id, host.email, hostServer.id);
  assert.deepEqual(triggers.map((trigger) => trigger?.display ?? trigger), [
    { kind: "channel", channelName: "trigger-shared", senderName: "trigger-joint-alice" },
    { kind: "thread", channelName: "trigger-shared", senderName: "trigger-joint-alice" },
  ]);
});

test("activity-summaries names a trigger in a channel converted to joint after the turn", async ({ app }) => {
  const owner = await seedUser("trigger-convert-owner@slock.test", "trigger-convert-owner");
  const server = await createServer("Trigger Convert", "trigger-convert", owner.id);
  const agent = await createAgent(server.id, "trigger-convert-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const channel = await channelService.createChannel(server.id, "trigger-convert-room", "convert me", "channel");
  await channelService.addHuman(channel.id, owner.id);
  await channelService.addAgent(channel.id, agent.id);
  const deliveries = recordDeliveries(app);
  const ownerToken = await tokenForHuman(owner.email);

  const messageId = await post(app, ownerToken, server.id, channel.id, `before the conversion @${agent.name}`);
  const delivered = await waitForDelivery(deliveries, agent.id, messageId);
  await storeTurns(agent.id, [triggerFromDelivery(delivered)]);
  const before = await readTriggers(app, agent.id, owner.email, server.id);
  assert.deepEqual(before[0]?.display, { kind: "channel", channelName: "trigger-convert-room", senderName: "trigger-convert-owner" });

  // POST /channels/:id/convert-to-joint is retired (#wg-rbac:#50): the conversion engine itself.
  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: channel.id, createdByUserId: owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
  const [converted] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, channel.id));
  assert.equal(converted?.type, "joint", "the channel keeps its id and is joint now");
  const [stored] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, messageId));
  assert.notEqual(stored?.channelId, channel.id, "and its messages moved to canonical storage");
  const after = await readTriggers(app, agent.id, owner.email, server.id);
  assert.deepEqual(after[0]?.display, { kind: "channel", channelName: "trigger-convert-room", senderName: "trigger-convert-owner" }, "the message now lives in canonical storage");
});

test("activity-summaries names a Slack root mention handed to the agent in the thread under it", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("trigger-slack-owner@slock.test", "trigger-slack-owner");
  const server = await createServer("Trigger Slack", "trigger-slack", owner.id);
  const channel = await channelService.createChannel(server.id, "trigger-slack-room", "bound", "channel");
  const agent = await createAgent(server.id, "trigger-slack-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id }).onConflictDoNothing();
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-trigger-root",
    installId: "install-trigger-root",
    workspaceId: "workspace-trigger-root",
    externalActorId: "UTRIGGERROOT",
    displayName: "Slack Root Author",
    handles: ["root-author"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date(Date.now() - 60_000),
  }).returning();
  const created = await db.transaction((executor) => insertCanonicalExternalMessage({
    executor,
    channelId: channel.id,
    content: `hello @${agent.name}`,
    createdAt: new Date(Date.now() - 30_000),
    projectionId: actor!.id,
    provider: "slack",
    appRegistrationId: actor!.appRegistrationId,
    installId: actor!.installId,
    workspaceId: actor!.workspaceId,
    externalActorId: actor!.externalActorId,
    externalConversationId: "CTRIGGERROOT",
    externalMessageId: "provider-trigger-root",
    actorProjectionRevision: actor!.projectionRevision,
  }));
  await db.insert(messageMentions).values({
    messageId: created.message.id,
    messageSeq: created.message.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: agent.name,
    source: "send_path",
    confidence: "exact",
    notifiableAtSend: true,
  });
  await db.insert(inboxNotificationFacts).values({
    receiverType: "agent",
    receiverId: agent.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: channel.id,
    messageId: created.message.id,
    messageSeq: created.message.seq,
    activityAt: created.message.createdAt,
    personalMention: true,
    unreadEligible: true,
  });
  const deliveries: AgentMessage[] = [];
  await deliverExternalInboundCommittedMessageToAgents({
    async deliverMessage(agentId: string, payload: AgentMessage) {
      if (agentId === agent.id) deliveries.push(payload);
      return { status: "queued" };
    },
  } as never, created.message.id);
  const [delivered] = deliveries;
  assert.ok(delivered);
  assert.equal(delivered.channel_type, "thread", "handed over in the thread under the root message");
  assert.notEqual(delivered.channel_id, channel.id);

  await storeTurns(agent.id, [triggerFromDelivery(delivered)]);
  const triggers = await readTriggers(app, agent.id, owner.email, server.id);
  assert.deepEqual(triggers[0]?.display, { kind: "thread", channelName: "trigger-slack-room", senderName: "Slack Root Author" });
});
