// POST /api/app-installation/agent-reminder-messages: an official app writes a
// due reminder into an agent's private `dm:@reminders` conversation.
//
// Pins: official + agent_reminder_write only (403 otherwise, and the group is
// only grantable to official apps); 404 for agents outside the installation's
// Server; idempotent per (app, agent, key); the surface is agent-only; the
// message is unread for the agent with an inbox fact; the agent can read and
// search it, sees it named dm:@reminders, and cannot send to it; delivery goes
// to a local agent through the orchestrator and to an external agent as an
// inbox push notice; the route is traced.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BasicTracer, MemoryTraceSink, type AgentMessage } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agentPrivateSurfaces,
  agents,
  appAgentMessages,
  channelAgents,
  channelHumans,
  channels,
  dmChannelIdentities,
  inboxNotificationFacts,
  messages,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { agentApi, postReminder, seedReminderApp, seedReminderWorld } from "../test/appAgentReminderFixture";
import { AgentOrchestrator, type AgentMessageDeliveryResult, type DeliverMessageOptions } from "../services/agentOrchestrator";
import { createAppOutboundPermissionRevision } from "../services/appOutboundPermissionService";
import { canAgentPostToChannel, resolveAgentFacingChannelRef, resolveAgentFacingDmRefs } from "../services/channelService";
import { createAgent } from "../services/agentService";
import { createOAuthClient } from "../services/oauthService";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import { startAgentInboxPushWorker } from "../services/agentInboxPushService";
import type { WebhookPost } from "../services/appNotificationDeliveryService";
import { traceAgentIdHash } from "../tracing/traceIdentity";
import { withChannelDelivery } from "../test/orchestratorStub";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));

type Delivery = { agentId: string; message: AgentMessage; options?: DeliverMessageOptions };

function recordingOrchestrator(app: { app: { set: (key: string, value: unknown) => void } }) {
  const deliveries: Delivery[] = [];
  app.app.set("agentOrchestrator", withChannelDelivery({
    deliverMessage: async (agentId: string, message: AgentMessage, options?: DeliverMessageOptions): Promise<AgentMessageDeliveryResult> => {
      deliveries.push({ agentId, message, options });
      return { status: "queued", reason: "replayable_inbox" };
    },
  }));
  return deliveries;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "condition not reached in time");
}

test("official app with the group writes once; the same key replays the same message", async ({ app }) => {
  const world = await seedReminderWorld();
  const deliveries = recordingOrchestrator(app);
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { client, token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });

  const body = { agentId: world.agent.id, idempotencyKey: "rem-1:fire-1", text: "Reminder: check the deploy (anchor #ops:abcd1234)" };
  const first = await postReminder(app.baseUrl, token, body);
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.body.created, true);
  assert.deepEqual(first.body.surface, { channelType: "dm", channelName: "reminders", target: "dm:@reminders" });

  const second = await postReminder(app.baseUrl, token, { ...body, text: "a different body is ignored on replay" });
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.body.created, false);
  assert.equal(second.body.messageId, first.body.messageId);

  const [message] = await getDb().select().from(messages).where(eq(messages.id, first.body.messageId));
  assert.equal(message.senderType, "user");
  assert.equal(message.senderId, "system");
  assert.equal(message.messageType, "system");
  assert.equal(message.systemSubtype, "agent.reminder_due");
  assert.equal(message.causalActorId, null, "no causal actor: unread for the agent");
  assert.equal(message.content, body.text);
  const surfaceMessages = await getDb().select().from(messages).where(eq(messages.channelId, message.channelId));
  assert.equal(surfaceMessages.length, 1, "the replay wrote nothing");
  const ledger = await getDb().select().from(appAgentMessages).where(eq(appAgentMessages.clientId, client.id));
  assert.deepEqual(ledger.map((row) => [row.agentId, row.idempotencyKey, row.messageId]), [[world.agent.id, "rem-1:fire-1", message.id]]);

  // Local agent: one targeted, intrinsic, mute-bypassing delivery named dm:@reminders.
  assert.equal(deliveries.length, 1, "only the created write delivers");
  assert.equal(deliveries[0].agentId, world.agent.id);
  assert.equal(deliveries[0].message.message_id, message.id);
  assert.equal(deliveries[0].message.channel_type, "dm");
  assert.equal(deliveries[0].message.channel_name, "reminders");
  assert.equal(deliveries[0].message.sender_type, "system");
  assert.equal(deliveries[0].options?.intrinsic, true);

  const spans = sink.getAllSpans().filter((span) => span.name === "server.app_agent_message");
  assert.deepEqual(spans.map((span) => [span.attrs?.outcome, span.attrs?.delivery]), [["created", "accepted"], ["replayed", "accepted"]]);
  const agentHash = traceAgentIdHash(world.agent.id);
  assert.ok(agentHash);
  for (const span of spans) {
    assert.equal(span.attrs?.agent_id_hash, agentHash);
    assert.equal(span.attrs?.client_id, client.id);
  }
});

test("surface is agent-only, the message is unread with an inbox fact, and renders as dm:@reminders", async ({ app }) => {
  const world = await seedReminderWorld();
  recordingOrchestrator(app);
  const { token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
  const first = await postReminder(app.baseUrl, token, { agentId: world.agent.id, idempotencyKey: "a", text: "first reminder" });
  const second = await postReminder(app.baseUrl, token, { agentId: world.agent.id, idempotencyKey: "b", text: "second reminder" });
  assert.equal(first.status, 200, first.raw);
  assert.equal(second.status, 200, second.raw);

  const surfaces = await getDb().select().from(agentPrivateSurfaces).where(eq(agentPrivateSurfaces.agentId, world.agent.id));
  assert.equal(surfaces.length, 1, "one surface per agent");
  const channelId = surfaces[0].channelId;
  assert.equal(surfaces[0].kind, "reminders");
  assert.equal(surfaces[0].serverId, world.server.id);
  const [channel] = await getDb().select().from(channels).where(eq(channels.id, channelId));
  assert.equal(channel.type, "dm");
  assert.deepEqual((await getDb().select().from(channelAgents).where(eq(channelAgents.channelId, channelId))).map((row) => row.agentId), [world.agent.id]);
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, channelId))).length, 0);
  assert.equal((await getDb().select().from(dmChannelIdentities).where(eq(dmChannelIdentities.channelId, channelId))).length, 0);

  const facts = await getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.receiverType, "agent"),
    eq(inboxNotificationFacts.receiverId, world.agent.id),
    eq(inboxNotificationFacts.sourceChannelId, channelId),
  ));
  assert.deepEqual(facts.map((fact) => [fact.messageId, fact.kind, fact.unreadEligible]).sort(), [
    [first.body.messageId, "dm", true],
    [second.body.messageId, "dm", true],
  ].sort());

  assert.equal(await resolveAgentFacingChannelRef(world.server.id, world.agent.id, channelId), "dm:@reminders");
  // The inbox list hides DMs without a ref; the reminder DM has one, so it is listed.
  assert.equal((await resolveAgentFacingDmRefs(world.server.id, world.agent.id, [channelId])).get(channelId), "dm:@reminders");
  assert.equal(await canAgentPostToChannel(channelId, world.agent.id), false);
});

test("the agent reads and searches dm:@reminders but cannot send to it", async ({ app }) => {
  const world = await seedReminderWorld();
  recordingOrchestrator(app);
  const { token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
  const marker = `zebracadabra${randomUUID().slice(0, 6)}`;
  const written = await postReminder(app.baseUrl, token, { agentId: world.agent.id, idempotencyKey: "k", text: `Reminder ${marker}: rotate keys` });
  assert.equal(written.status, 200, written.raw);

  const history = await agentApi(app.baseUrl, world.agentKey, "GET", `/history?${new URLSearchParams({ channel: "dm:@reminders" })}`);
  assert.equal(history.status, 200, history.raw);
  assert.ok(history.raw.includes(marker), history.raw);

  const search = await agentApi(app.baseUrl, world.agentKey, "GET", `/search?${new URLSearchParams({ q: marker, sort: "recent" })}`);
  assert.equal(search.status, 200, search.raw);
  assert.deepEqual(search.body.results.map((result: { id: string }) => result.id), [written.body.messageId]);
  const scoped = await agentApi(app.baseUrl, world.agentKey, "GET", `/search?${new URLSearchParams({ q: marker, channel: "dm:@reminders" })}`);
  assert.equal(scoped.status, 200, scoped.raw);
  assert.equal(scoped.body.results.length, 1);

  for (const target of ["dm:@reminders", "dm:@Reminders", "dm:@reminders~agent", "dm:@reminders~human", `dm:@reminders:${written.body.messageId.slice(0, 8)}`]) {
    const sent = await agentApi(app.baseUrl, world.agentKey, "POST", "/send", { target, content: "done" });
    assert.equal(sent.status, 403, `${target}: ${sent.raw}`);
    assert.equal(sent.body.code, "DM_TARGET_NOT_SENDABLE");
    assert.equal(sent.body.error, "dm:@reminders is your private reminder conversation; nobody else reads it. Act at the reminder's anchor instead.");
  }
  const count = await getDb().select().from(messages).where(eq(messages.channelId, (await getDb().select().from(agentPrivateSurfaces).where(eq(agentPrivateSurfaces.agentId, world.agent.id)))[0].channelId));
  assert.equal(count.length, 1, "no agent message landed on the surface");

  // Another agent cannot read the first agent's reminders: dm:@reminders is
  // always the caller's own surface (it has none yet).
  const otherHistory = await agentApi(app.baseUrl, world.externalAgentKey, "GET", `/history?${new URLSearchParams({ channel: "dm:@reminders" })}`);
  assert.ok(!otherHistory.raw.includes(marker), otherHistory.raw);
  const otherSearch = await agentApi(app.baseUrl, world.externalAgentKey, "GET", `/search?${new URLSearchParams({ q: marker, sort: "recent" })}`);
  assert.equal(otherSearch.status, 200, otherSearch.raw);
  assert.equal(otherSearch.body.results.length, 0);
});

test("non-official app or missing group is 403; foreign or deleted agent is 404; bad token 401; bad body 400", async ({ app }) => {
  const world = await seedReminderWorld();
  recordingOrchestrator(app);
  const body = { agentId: world.agent.id, idempotencyKey: "k", text: "hi" };

  // A non-official app cannot even be granted the group...
  const { client: unofficial } = await createOAuthClient({
    serverId: world.publisher.id, createdByUserId: world.owner.id, name: "Unofficial", clientId: `unofficial-${randomUUID().slice(0, 8)}`,
  });
  await assert.rejects(
    createAppOutboundPermissionRevision({ clientId: unofficial.id, actor: { type: "human", id: world.owner.id }, groups: ["agent_reminder_write"], events: [] }),
    /only grantable to official apps/,
  );
  // ...and holding it anyway (seeded directly) does not authorize the write.
  const nonOfficial = await seedReminderApp(app.baseUrl, world, { official: false, groups: ["agent_reminder_write"] });
  assert.equal((await postReminder(app.baseUrl, nonOfficial.token, body)).status, 403);
  const missingGroup = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent"] });
  assert.equal((await postReminder(app.baseUrl, missingGroup.token, body)).status, 403);
  // An official app may be granted it.
  const official = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
  const revision = await createAppOutboundPermissionRevision({
    clientId: official.client.id, actor: { type: "human", id: world.owner.id }, groups: ["agent_reminder_write"], events: [],
  });
  assert.deepEqual(revision?.currentGroups, ["agent_reminder_write"]);

  const fresh = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
  assert.equal((await postReminder(app.baseUrl, fresh.token, { ...body, agentId: world.foreignAgent.id })).status, 404);
  assert.equal((await postReminder(app.baseUrl, fresh.token, { ...body, agentId: randomUUID() })).status, 404);
  const doomed = await createAgent(world.server.id, `RemDoomed${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, doomed.id));
  assert.equal((await postReminder(app.baseUrl, fresh.token, { ...body, agentId: doomed.id })).status, 404);

  assert.equal((await postReminder(app.baseUrl, "raft_installation_bogus", body)).status, 401);
  for (const bad of [
    { ...body, agentId: "nope" },
    { ...body, idempotencyKey: "" },
    { ...body, idempotencyKey: "x".repeat(201) },
    { ...body, text: "" },
    { ...body, text: "x".repeat(8001) },
  ]) {
    assert.equal((await postReminder(app.baseUrl, fresh.token, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await getDb().select().from(agentPrivateSurfaces)).length, 0, "no rejected call created a surface");
});

test("external agent gets an inbox push notice for the reminder", async ({ app }) => {
  const world = await seedReminderWorld();
  const orchestrator = new AgentOrchestrator() as AgentOrchestrator;
  app.app.set("agentOrchestrator", orchestrator);
  const registered = await agentApi(app.baseUrl, world.externalAgentKey, "PUT", "/push-webhook", {
    url: "https://receiver.example.com/raft/inbox",
    secret: "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x",
  });
  assert.equal(registered.status, 200, registered.raw);
  const posted: Array<{ targets: Array<{ target: string; latestMsgId?: string }> }> = [];
  const post: WebhookPost = async (input) => {
    posted.push(JSON.parse(input.body));
    return { status: 200 };
  };
  const worker = startAgentInboxPushWorker({
    agentOrchestrator: orchestrator,
    post,
    sweepIntervalMs: 60 * 60_000,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
  });
  try {
    const { token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
    const written = await postReminder(app.baseUrl, token, { agentId: world.externalAgent.id, idempotencyKey: "ext", text: "external reminder" });
    assert.equal(written.status, 200, written.raw);
    await waitFor(() => posted.length === 1);
    await worker.idle();
    assert.deepEqual(posted[0].targets.map((target) => target.target), ["dm:@reminders"]);
    assert.equal(posted[0].targets[0].latestMsgId?.slice(0, 8), written.body.messageId.slice(0, 8));
  } finally {
    worker.stop();
    orchestrator.shutdown();
  }
});

test("a delivery failure still answers 200: the reminder is durable", async ({ app }) => {
  const world = await seedReminderWorld();
  app.app.set("agentOrchestrator", withChannelDelivery({
    deliverMessage: async () => ({ status: "dropped", reason: "agent_unavailable" }),
  }));
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const { token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
  const written = await postReminder(app.baseUrl, token, { agentId: world.agent.id, idempotencyKey: "f", text: "durable" });
  assert.equal(written.status, 200, written.raw);
  assert.equal(written.body.created, true);
  assert.equal((await getDb().select().from(messages).where(eq(messages.id, written.body.messageId))).length, 1);
  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.app_agent_message");
  assert.equal(span?.attrs?.delivery, "failed");
  assert.equal(span?.attrs?.outcome, "created");
});

test("a soft-deleted reminders conversation is replaced, not a permanent block", async ({ app }) => {
  const world = await seedReminderWorld();
  app.app.set("agentOrchestrator", withChannelDelivery({ deliverMessage: async () => ({ status: "delivered" }) }));
  const { token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
  const first = await postReminder(app.baseUrl, token, { agentId: world.agent.id, idempotencyKey: "d1", text: "before" });
  assert.equal(first.status, 200, first.raw);
  const [firstMessage] = await getDb().select().from(messages).where(eq(messages.id, first.body.messageId));
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, firstMessage.channelId));

  const second = await postReminder(app.baseUrl, token, { agentId: world.agent.id, idempotencyKey: "d2", text: "after" });
  assert.equal(second.status, 200, second.raw);
  const [secondMessage] = await getDb().select().from(messages).where(eq(messages.id, second.body.messageId));
  assert.notEqual(secondMessage.channelId, firstMessage.channelId, "a fresh conversation was created");
  const surfaces = await getDb().select().from(agentPrivateSurfaces).where(eq(agentPrivateSurfaces.agentId, world.agent.id));
  assert.deepEqual(surfaces.map((surface) => surface.channelId), [secondMessage.channelId]);
});
