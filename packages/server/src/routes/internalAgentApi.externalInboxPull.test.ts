import { fixturePasswordHash } from "../test/integration/credentials";
import { traceIdentityHash } from "../tracing/traceIdentity";
import { createApiTest } from "../test/integration/apiTest";
// External agent inbox: for an external agent delivery, ack and read are the
// same act, so its durable unread IS what it has not yet received. Persisted
// messages therefore come ONLY from a pull of the agent inbox chain on each
// call (the same bounded selection managed resume uses, rows contiguous and
// oldest first per conversation); the per-process buffer serves only items
// with no durable row (third-party app events and other notices).
//
// Pins kept from the CS-4 rebuild this replaces:
//   1. per-conversation read position, never a global/merged cursor;
//   2. the read position never feeds freshness/model-seen (CS-2 guard);
//   3. entries are buffer-native snake_case AgentMessage — /history's
//      camelCase enriched rows must not leak onto the /events wire.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { channelAgents, channels, inboxTargetMuteStates, jointChannels, jointChannelServers, messageMentions, messages, threadFollows, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel, addAgent, addHuman, findOrCreateDM, markAgentLegacyRead, getAgentLegacyReadCursor, getJointThreadProjectionByLocalThread, getOrCreateThread, type AgentInboxChainSelection } from "../services/channelService";
import { broadcastAndDeliver, createMessage, drainSenderReadReceiptsForTests, RESUME_CATCHUP_MAX_CHANNELS, __setExternalAgentInboxChainSelectorForTests, __setExternalAgentInboxPullMinIntervalMsForTests } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { withChannelDelivery } from "../test/orchestratorStub";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// CI has no RisingWave: the chain read is served by the test-only reference
// derivation of the same view. `chainReads` counts pulls that read the chain.
let chainReads = 0;
let chainAvailable = true;
__setExternalAgentInboxChainSelectorForTests(async (agentId: string): Promise<AgentInboxChainSelection> => {
  chainReads += 1;
  if (!chainAvailable) return { source: "unavailable", reason: "rw_unconfigured" };
  return { source: "chain", rows: await referenceAgentInboxChain(agentId) };
});

async function seedExternalFixture() {
  chainReads = 0;
  chainAvailable = true;
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `external-inbox-${suffix}@slock.test`,
    name: `external-inbox-${suffix}`,
    displayName: "External Inbox Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("External Inbox Test", `external-inbox-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "ExternalInboxExt", { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, "external-inbox-room");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "external-inbox-test",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return {
    ownerId: owner!.id,
    ownerUniqueName: owner!.name,
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    agentId: agent.id,
    apiKey: minted.apiKey,
  };
}

type Fixture = Awaited<ReturnType<typeof seedExternalFixture>>;

// Persist + record the agent's inbox fact, as the send path does; nothing is
// delivered to the orchestrator.
async function sendHumanMessage(f: Fixture, content: string, channelId = f.channelId, personalMention = false, kind: "channel" | "dm" | "thread" = "channel") {
  const message = await createMessage(channelId, "user", f.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind,
    sourceChannelId: channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention,
    unreadEligible: true,
  }]);
  return message;
}

/** A fresh orchestrator (a new server process / another replica). */
function freshProcess(app: { app: { set: (key: string, value: unknown) => void } }) {
  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator;
}

function liveDelivery(f: Fixture, message: { id: string; seq: number; content: string }) {
  return {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel" as const,
    sender_id: f.ownerId,
    sender_name: f.ownerUniqueName,
    sender_type: "human" as const,
    content: message.content,
    timestamp: new Date().toISOString(),
    seq: message.seq,
    message_id: message.id,
  };
}

/** An item with no durable row: only the buffer can serve it. */
function thirdPartyEvent(f: Fixture) {
  const eventId = randomUUID();
  return {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel" as const,
    sender_id: randomUUID(),
    sender_name: "external-build-app",
    sender_type: "third_party_app" as const,
    content: "build ready",
    timestamp: new Date().toISOString(),
    message_id: eventId,
    third_party_event: {
      id: eventId,
      kind: "event",
      client_id: "external-build-app",
      client_name: "External Build App",
      payload_hash: "a".repeat(64),
      payload: { status: "ready" },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      source: {
        client_id: "external-build-app",
        client_name: "External Build App",
        oauth_client_id: randomUUID(),
        access_token_id_hash: "b".repeat(64),
        resource: `urn:raft:server:${f.serverId}:agent-inbound`,
      },
    },
  };
}

type EventsBody = {
  events: any[];
  reply_target: string | null;
  has_more: boolean;
  inbox_hint: { unread_conversations: number; command: string } | null;
};

async function fetchEvents(baseUrl: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/events`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as EventsBody;
}

async function fetchWakeHints(baseUrl: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/wake-hints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as { wake_hints: any[]; has_more: boolean };
}

function pullEvent(sink: MemoryTraceSink) {
  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent-api/events"
  );
  assert.ok(span, "expected GET /internal/agent-api/events root span");
  return span.events.find((candidate) => candidate.name === "external_agent.inbox_pull.finished");
}

test("unread rows above the read position come through /events on any process; the ack advances the read position so they do not loop", async ({ app }) => {
  const f = await seedExternalFixture();
  const acked = await sendHumanMessage(f, "acked earlier");
  await markAgentLegacyRead(f.agentId, f.channelId, acked.seq);
  const unread1 = await sendHumanMessage(f, "unread one");
  const unread2 = await sendHumanMessage(f, "unread two");

  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), [unread1.seq, unread2.seq], "exactly the rows above the read position, oldest first");
  assert.equal(first.inbox_hint, null, "nothing unread beyond the batch");
  // Shape parity: buffer-native snake_case AgentMessage on the wire, not
  // /history's camelCase enriched row.
  const event = first.events[0];
  assert.equal(event.channel_id, f.channelId);
  assert.equal(event.channel_name, f.channelName);
  assert.equal(event.sender_type, "human");
  // Live fan-out parity: sender_name is the @mention-able UNIQUE name, not
  // the enriched display name ("External Inbox Owner" in this fixture).
  assert.equal(event.sender_name, f.ownerUniqueName);
  assert.equal(event.message_id, unread1.id);
  assert.equal(event.content, "unread one");
  assert.equal("senderName" in event, false, "enriched camelCase senderName must not leak");
  assert.equal("reactions" in event, false, "enriched reactions must not leak");

  // /events acked the batch → read position advanced durably.
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), unread2.seq);
  assert.deepEqual((await fetchEvents(app.baseUrl, f.apiKey)).events, []);
  freshProcess(app);
  assert.deepEqual((await fetchEvents(app.baseUrl, f.apiKey)).events, [], "another process sees the same read position");
});

test("every /events pulls the durable inbox: a persisted message never delivered to this process still arrives", async ({ app }) => {
  const f = await seedExternalFixture();
  freshProcess(app);
  assert.deepEqual((await fetchEvents(app.baseUrl, f.apiKey)).events, []);
  // Persisted, fanned out on "another replica": this process never saw it.
  const elsewhere = await sendHumanMessage(f, "delivered on another replica");
  const second = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(second.events.map((e) => e.seq), [elsewhere.seq]);
  assert.equal(chainReads, 2, "/events is never rate-limited");
});

test("persisted messages are never buffered: a live delivery is served once, from the durable pull", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const orchestrator = freshProcess(app);
  const live = await sendHumanMessage(f, "delivered live");
  const receipt = await orchestrator.deliverMessage(f.agentId, liveDelivery(f, live));
  assert.equal(receipt.status, "queued");
  assert.deepEqual(orchestrator.peekPendingMessages(f.agentId), [], "the buffer holds no persisted message");

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), [live.seq], "one copy, from the inbox");
  assert.equal(pullEvent(sink)?.attrs?.message_count, 1);
  assert.deepEqual((await fetchEvents(app.baseUrl, f.apiKey)).events, []);
});

test("items with no durable row are still served from the buffer, next to pulled messages", async ({ app }) => {
  const f = await seedExternalFixture();
  const orchestrator = freshProcess(app);
  const persisted = await sendHumanMessage(f, "persisted");
  const event = thirdPartyEvent(f);
  await orchestrator.deliverMessage(f.agentId, event);
  // A persisted-shaped delivery with no durable row behind it: not buffered,
  // and the inbox does not have it either.
  await orchestrator.deliverMessage(f.agentId, liveDelivery(f, { id: randomUUID(), seq: persisted.seq + 1_000_000, content: "no row" }));
  assert.deepEqual(orchestrator.peekPendingMessages(f.agentId).map((m: any) => m.message_id), [event.message_id]);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.message_id), [event.message_id, persisted.id]);
  assert.equal(first.events[0].third_party_event?.id, event.message_id);
  assert.deepEqual((await fetchEvents(app.baseUrl, f.apiKey)).events, [], "both acked");
});

test("contiguous oldest-first: a 12-message backlog plus a live message drains in order across calls, nothing skipped", async ({ app }) => {
  const f = await seedExternalFixture();
  const backlog = [];
  for (let index = 0; index < 12; index += 1) backlog.push(await sendHumanMessage(f, `backlog ${index}`));
  const orchestrator = freshProcess(app);
  const live = await sendHumanMessage(f, "live after the backlog");
  await orchestrator.deliverMessage(f.agentId, liveDelivery(f, live));

  const expected = [...backlog, live].map((m) => m.seq);
  const received: number[] = [];
  const first = await fetchEvents(app.baseUrl, f.apiKey);
  const firstSeqs = first.events.map((e) => e.seq);
  assert.deepEqual(firstSeqs, expected.slice(0, firstSeqs.length), "the oldest rows first, contiguous");
  assert.ok(firstSeqs.length < expected.length, "the batch is bounded");
  assert.ok(!firstSeqs.includes(live.seq), "the live message does not jump the backlog");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), firstSeqs.at(-1));
  assert.deepEqual(first.inbox_hint, { unread_conversations: 1, command: "raft inbox check" }, "the conversation is still unread");
  received.push(...firstSeqs);

  for (let call = 0; call < 10 && received.length < expected.length; call += 1) {
    const next = await fetchEvents(app.baseUrl, f.apiKey);
    assert.ok(next.events.length > 0);
    received.push(...next.events.map((e) => e.seq));
    assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), received.at(-1));
  }
  assert.deepEqual(received, expected, "every row once, in order, the live message last");
  const done = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(done.events, []);
  assert.equal(done.inbox_hint, null);
});

test("bounded batch: inbox_hint counts the conversations still unread, on every /events while any remain", async ({ app }) => {
  const f = await seedExternalFixture();
  const conversations = RESUME_CATCHUP_MAX_CHANNELS * 2 + 1;
  await sendHumanMessage(f, "fixture channel unread");
  for (let index = 1; index < conversations; index += 1) {
    const channel = await createChannel(f.serverId, `external-inbox-many-${index}`);
    await addHuman(channel.id, f.ownerId);
    await addAgent(channel.id, f.agentId);
    await sendHumanMessage(f, `unread in ${index}`, channel.id);
  }
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.equal(new Set(first.events.map((e) => e.channel_id)).size, RESUME_CATCHUP_MAX_CHANNELS);
  assert.deepEqual(first.inbox_hint, { unread_conversations: conversations - RESUME_CATCHUP_MAX_CHANNELS, command: "raft inbox check" });

  const second = await fetchEvents(app.baseUrl, f.apiKey);
  assert.equal(new Set(second.events.map((e) => e.channel_id)).size, RESUME_CATCHUP_MAX_CHANNELS);
  assert.deepEqual(second.inbox_hint, { unread_conversations: 1, command: "raft inbox check" }, "still present while unread remains");

  const third = await fetchEvents(app.baseUrl, f.apiKey);
  assert.equal(third.events.length, 1);
  assert.equal(third.inbox_hint, null);
});

test("inbox unavailable: no persisted messages and no fallback; buffered items and /events still work", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  chainAvailable = false;
  const unread = await sendHumanMessage(f, "unread, but the chain is down");
  const orchestrator = freshProcess(app);
  const event = thirdPartyEvent(f);
  await orchestrator.deliverMessage(f.agentId, event);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.message_id), [event.message_id]);
  assert.equal(first.inbox_hint, null);
  assert.equal(pullEvent(sink)?.attrs?.outcome, "inbox_unavailable");
  // Nothing was read, so the pull claims no conversation count (not a misleading 0).
  assert.equal("conversation_count" in (pullEvent(sink)?.attrs ?? {}), false);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), unread.seq - 1, "the unread row stays unread");

  chainAvailable = true;
  const second = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(second.events.map((e) => e.seq), [unread.seq], "it arrives once the chain is back");
});

test("wake-hints pulls are rate-limited per agent; /events is not", async ({ app }) => {
  const f = await seedExternalFixture();
  freshProcess(app);
  // The default 2s window is about as long as three wake-hints round trips on a
  // slow test machine (0.4-1.6s each measured), so the assertion raced the clock.
  // A window no run can outlast pins the rule itself.
  __setExternalAgentInboxPullMinIntervalMsForTests(60_000);
  try {
    const unread = await sendHumanMessage(f, "unread");
    for (let i = 0; i < 3; i += 1) {
      const { wake_hints } = await fetchWakeHints(app.baseUrl, f.apiKey);
      assert.deepEqual(wake_hints.map((h) => h.seq), [unread.seq], "a rate-limited poll serves the previous pull");
    }
    assert.equal(chainReads, 1);
    await fetchEvents(app.baseUrl, f.apiKey);
    await fetchEvents(app.baseUrl, f.apiKey);
    assert.equal(chainReads, 3);
  } finally {
    __setExternalAgentInboxPullMinIntervalMsForTests(null);
  }
});

test("the pull records one aggregate trace event without raw ids", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const acked = await sendHumanMessage(f, "acked earlier");
  await markAgentLegacyRead(f.agentId, f.channelId, acked.seq);
  const unread1 = await sendHumanMessage(f, "trace unread one");
  const unread2 = await sendHumanMessage(f, "trace unread two");
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), [unread1.seq, unread2.seq]);

  const event = pullEvent(sink);
  assert.ok(event, "expected aggregate inbox pull trace event");
  assert.equal(event.attrs?.route, "events");
  assert.equal(event.attrs?.outcome, "pulled");
  assert.equal(event.attrs?.message_count, 2);
  assert.equal(event.attrs?.dropped_count, 0);
  assert.equal(event.attrs?.truncated_conversation_count, 0);
  assert.equal(event.attrs?.remaining_conversation_count, 0);
  assert.equal(event.attrs?.last_read_seq, acked.seq);
  assert.equal(event.attrs?.chain_latest_seq, unread2.seq);
  assert.equal(typeof event.attrs?.duration_ms, "number");
  // The one conversation this pull read, as its keyed hash, never the raw id.
  assert.equal(event.attrs?.conversation_count, 1);
  assert.equal(typeof event.attrs?.conversation_id_hash, "string");
  assert.equal(event.attrs?.conversation_id_hash, traceIdentityHash("conversation_id_hash", f.channelId));
  const attrs = event.attrs ?? {};
  assert.equal("agent_id" in attrs, false);
  assert.equal("channel_id" in attrs, false);
  assert.equal("message_id" in attrs, false);
  assert.ok(!Object.values(attrs).includes(f.agentId));
  assert.ok(!Object.values(attrs).includes(f.channelId));
  assert.ok(!Object.values(attrs).includes(unread1.id));
  assert.ok(!Object.values(attrs).includes(unread2.id));
});

test("the pull suppresses muted ordinary rows but keeps a piercing mention", async ({ app }) => {
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "read before mute");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const beforeMute = await sendHumanMessage(f, "unread before the mute boundary");
  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    sourceChannelId: f.channelId,
    muteFromSeq: beforeMute.seq + 1,
  });

  await sendHumanMessage(f, "muted ordinary");
  const pierced = await sendHumanMessage(f, "@ExternalInboxExt pierce", f.channelId, true);
  await getDb().insert(messageMentions).values({
    messageId: pierced.id,
    messageSeq: pierced.seq,
    serverId: f.serverId,
    channelId: f.channelId,
    targetType: "agent",
    targetId: f.agentId,
    handleAtSendTime: "ExternalInboxExt",
  }).onConflictDoNothing();
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((event) => event.message_id), [beforeMute.id, pierced.id]);
});

test("the pull keeps followed-thread rows independent from the parent mute boundary", async ({ app }) => {
  const f = await seedExternalFixture();
  const parent = await sendHumanMessage(f, "thread parent");
  await markAgentLegacyRead(f.agentId, f.channelId, parent.seq);
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: f.agentId,
    parentMessageId: parent.id,
    reason: "manual",
  });

  const beforeMute = await sendHumanMessage(f, "thread before boundary", thread.id);
  await markAgentLegacyRead(f.agentId, thread.id, beforeMute.seq - 1);
  const boundary = await sendHumanMessage(f, "thread at boundary", thread.id);
  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    sourceChannelId: f.channelId,
    muteFromSeq: boundary.seq,
  });
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((event) => event.message_id), [beforeMute.id, boundary.id]);
  assert.equal(first.events[0]?.parent_channel_id, f.channelId);
});

test("the pull preserves persisted system sender rows without UUID profile lookup", async ({ app }) => {
  const f = await seedExternalFixture();
  const acked = await sendHumanMessage(f, "acked before system event");
  await markAgentLegacyRead(f.agentId, f.channelId, acked.seq);
  const system = await createMessage(f.channelId, "user", "system", "system event", "system");
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), [system.seq]);
  assert.equal(first.events[0].sender_id, "system");
  assert.equal(first.events[0].sender_name, "system");
  assert.equal(first.events[0].sender_description, null);
  assert.equal(first.events[0].sender_type, "system");
  assert.equal(first.events[0].senderType, "system");
  assert.equal(first.events[0].message_id, system.id);
  assert.equal(first.events[0].content, "system event");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), system.seq);
});

test("per-conversation read position: a fully-read channel at a higher seq does not mask another channel's unread (no global cursor)", async ({ app }) => {
  const f = await seedExternalFixture();
  const channelB = await createChannel(f.serverId, "external-inbox-room-b");
  await addHuman(channelB.id, f.ownerId);
  await addAgent(channelB.id, f.agentId);

  const bBase = await sendHumanMessage(f, "b read", channelB.id);
  await markAgentLegacyRead(f.agentId, channelB.id, bBase.seq);
  const bUnread = await sendHumanMessage(f, "b unread", channelB.id);
  // Channel A is fully read at a HIGHER global seq. A merged/global cursor
  // would fabricate consumption of bUnread and skip it.
  const aSeen = await sendHumanMessage(f, "a read at higher seq");
  await markAgentLegacyRead(f.agentId, f.channelId, aSeen.seq);
  freshProcess(app);

  const { events } = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(events.map((e) => e.seq), [bUnread.seq]);
  assert.equal(events[0].channel_id, channelB.id);
});

test("joint channel: rows stored under the canonical channel arrive on the local projection, and the ack advances that projection", async ({ app }) => {
  const f = await seedExternalFixture();
  const db = getDb();
  const host = await createServer("External Inbox Joint Host", `external-inbox-host-${randomUUID()}`, f.ownerId);
  const [canonical, hostLocal, local] = await db.insert(channels).values([
    { serverId: host.id, name: "external-inbox-joint-canonical", type: "joint" },
    { serverId: host.id, name: "external-inbox-joint-host", type: "joint" },
    { serverId: f.serverId, name: "external-inbox-joint-local", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id,
    createdByServerId: host.id,
    createdByUserId: f.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: f.ownerId },
    { jointChannelId: joint!.id, serverId: f.serverId, localChannelId: local!.id, role: "participant", status: "active", joinedByUserId: f.ownerId },
  ]);
  await db.insert(channelAgents).values({ channelId: local!.id, agentId: f.agentId });

  const acked = await createMessage(canonical!.id, "user", f.ownerId, "joint acked earlier");
  await markAgentLegacyRead(f.agentId, local!.id, acked.seq);
  const unread = await createMessage(canonical!.id, "user", f.ownerId, "joint unread");
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.message_id), [unread.id]);
  assert.equal(first.events[0].channel_id, local!.id);
  assert.equal(first.events[0].channel_name, local!.name);
  assert.equal(first.events[0].channel_type, "channel");

  assert.equal(await getAgentLegacyReadCursor(f.agentId, local!.id), unread.seq);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, canonical!.id), 0);
  assert.deepEqual((await fetchEvents(app.baseUrl, f.apiKey)).events, []);
});

/** A joint channel whose rows live under a canonical channel on another (host) server; the agent sits in the local projection. */
async function seedJointChannelForAgent(f: Awaited<ReturnType<typeof seedExternalFixture>>, label: string) {
  const db = getDb();
  const host = await createServer(`External Inbox ${label} Host`, `external-inbox-${label}-host-${randomUUID()}`, f.ownerId);
  const [canonical, hostLocal, local] = await db.insert(channels).values([
    { serverId: host.id, name: `external-inbox-${label}-canonical`, type: "joint" },
    { serverId: host.id, name: `external-inbox-${label}-host`, type: "joint" },
    { serverId: f.serverId, name: `external-inbox-${label}-local`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id,
    createdByServerId: host.id,
    createdByUserId: f.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: f.ownerId },
    { jointChannelId: joint!.id, serverId: f.serverId, localChannelId: local!.id, role: "participant", status: "active", joinedByUserId: f.ownerId },
  ]);
  await db.insert(channelAgents).values({ channelId: local!.id, agentId: f.agentId });
  return { host, canonical: canonical!, local: local! };
}

/** The send pipeline as the agent send route runs it, then the sender read position settles. */
async function agentSend(app: { io: unknown }, f: Awaited<ReturnType<typeof seedExternalFixture>>, channelId: string, content: string) {
  const orchestrator = withChannelDelivery({ deliverMessage: async () => ({ status: "queued", reason: "replayable_inbox" }) }) as unknown as AgentOrchestrator;
  const own = await broadcastAndDeliver(app.io as Parameters<typeof broadcastAndDeliver>[0], orchestrator, {
    channelId,
    senderType: "agent",
    senderId: f.agentId,
    senderName: "ExternalInboxExt",
    content,
  }) as { id: string; seq: number };
  await drainSenderReadReceiptsForTests();
  return own;
}

test("joint channel: the agent's own send does not read through unread rows stored under the canonical channel", async ({ app }) => {
  const f = await seedExternalFixture();
  const { canonical, local } = await seedJointChannelForAgent(f, "joint-send");
  const read = await createMessage(canonical.id, "user", f.ownerId, "joint read earlier");
  await markAgentLegacyRead(f.agentId, local.id, read.seq);
  const unread = await createMessage(canonical.id, "user", f.ownerId, "joint unread, not handed over yet");

  const own = await agentSend(app, f, local.id, "the agent's reply in the joint channel");
  assert.ok(own.seq > unread.seq);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, local.id), read.seq, "the send did not read through the unread canonical row");

  freshProcess(app);
  const pulled = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(pulled.events.map((e) => e.message_id), [unread.id], "still delivered; the own message is not");
});

test("joint thread: the agent's own reply does not read through unread replies stored under the canonical thread", async ({ app }) => {
  const f = await seedExternalFixture();
  const { host, canonical, local } = await seedJointChannelForAgent(f, "joint-thread-send");
  const db = getDb();
  const root = await createMessage(canonical.id, "user", f.ownerId, "joint thread root");
  const [canonicalThread, localThread] = await db.insert(channels).values([
    { serverId: host.id, name: `canonical-joint-thread-${randomUUID()}`, type: "thread", parentMessageId: root.id },
    { serverId: f.serverId, name: `local-joint-thread-${randomUUID()}`, type: "thread", parentMessageId: null },
  ]).returning();
  await db.update(messages).set({ threadId: canonicalThread!.id }).where(eq(messages.id, root.id));
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread!.id,
    createdByServerId: host.id,
    createdByUserId: f.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointThread!.id,
    serverId: f.serverId,
    localChannelId: localThread!.id,
    role: "participant",
    status: "active",
    joinedByUserId: f.ownerId,
  });
  await db.insert(threadFollows).values({ threadChannelId: localThread!.id, followerType: "agent", followerId: f.agentId, parentMessageId: root.id, reason: "replied" });
  assert.equal((await getJointThreadProjectionByLocalThread(localThread!.id))?.canonicalThreadChannelId, canonicalThread!.id, "fixture: a live joint thread projection");

  const read = await createMessage(canonicalThread!.id, "user", f.ownerId, "joint thread reply read earlier");
  await markAgentLegacyRead(f.agentId, localThread!.id, read.seq);
  const unread = await createMessage(canonicalThread!.id, "user", f.ownerId, "joint thread reply, not handed over yet");

  const own = await agentSend(app, f, localThread!.id, "the agent's reply in the joint thread");
  assert.ok(own.seq > unread.seq);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, localThread!.id), read.seq, "the reply did not read through the unread canonical reply");
});

test("read position set at join: only post-join messages arrive; own sends are never delivered", async ({ app }) => {
  const f = await seedExternalFixture();
  const joined = await createChannel(f.serverId, "external-inbox-joined-later");
  await addHuman(joined.id, f.ownerId);
  const preJoin = await sendHumanMessage(f, "before agent joined", joined.id);
  await addAgent(joined.id, f.agentId);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, joined.id), preJoin.seq, "joining sets the read position");
  const postJoin = await sendHumanMessage(f, "after agent joined", joined.id);

  const ownSend = await createMessage(f.channelId, "agent", f.agentId, "agent's own message");
  const humanAfter = await sendHumanMessage(f, "human after agent send");
  freshProcess(app);

  const seqs = (await fetchEvents(app.baseUrl, f.apiKey)).events.map((e) => e.seq);
  assert.ok(seqs.includes(postJoin.seq), "post-join message arrives");
  assert.ok(!seqs.includes(preJoin.seq), "pre-join message does not");
  assert.ok(seqs.includes(humanAfter.seq));
  assert.ok(!seqs.includes(ownSend.seq), "the agent's own send is not delivered");
});

test("wake-hints surface durable pending without draining; CS-2: the read position never serves as freshness proof", async ({ app }) => {
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "base");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const unread = await sendHumanMessage(f, "unread");
  freshProcess(app);

  // Peek is non-draining: two polls, same hint, no duplicates.
  for (let i = 0; i < 2; i += 1) {
    const { wake_hints } = await fetchWakeHints(app.baseUrl, f.apiKey);
    assert.deepEqual(wake_hints.map((h) => h.seq), [unread.seq]);
    assert.equal("content" in (wake_hints[0] ?? {}), false, "wake hints stay content-free");
  }

  // CS-2 guard: the read position (advanced by the ack) is delivery state,
  // not model-seen proof. A send claiming only the earlier boundary must
  // still be held on the unseen message.
  const drained = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(drained.events.map((e) => e.seq), [unread.seq]);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), unread.seq);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      target: `#${f.channelName}`,
      content: "send with stale model state",
      seenUpToSeq: base.seq,
    }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(body.state, "held", "read position at unread.seq must not stand in for model-seen");
  assert.equal(body.heldMessages?.[0]?.id, unread.id);
});

test("events check trace records body_result=empty when nothing is unread", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const msg = await sendHumanMessage(f, "message to ack");
  await markAgentLegacyRead(f.agentId, f.channelId, msg.seq);
  freshProcess(app);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events, []);
  assert.equal(pullEvent(sink)?.attrs?.outcome, "nothing_unread");

  const checkEvent = sink.getAllSpans()
    .find((s) => s.name === "server.http.request" && s.attrs?.route_pattern === "/internal/agent-api/events")
    ?.events.find((e) => e.name === "external_agent.events.check.finished");
  assert.ok(checkEvent, "expected events check trace event");
  assert.equal(checkEvent.attrs?.body_result, "empty");
  assert.equal(checkEvent.attrs?.returned_count, 0);
  assert.equal(checkEvent.attrs?.is_external, true);
});

test("reply_target is the canonical send target of the newest event and /send resolves it", async ({ app }) => {
  const f = await seedExternalFixture();
  freshProcess(app);
  assert.equal((await fetchEvents(app.baseUrl, f.apiKey)).reply_target, null, "null when the batch is empty");

  const sendTo = async (target: string, content: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target, content }),
    });
    const body = await res.json() as { state?: string; messageId?: string };
    assert.equal(res.status, 200, `send to ${target} must resolve: ${JSON.stringify(body)}`);
    assert.equal(body.state, "sent");
    return body.messageId!;
  };
  const expectReplyTarget = async (expected: string, label: string) => {
    const batch = await fetchEvents(app.baseUrl, f.apiKey);
    assert.ok(batch.events.length > 0, `${label}: expected a delivered event`);
    assert.equal(batch.reply_target, expected, label);
    assert.doesNotMatch(batch.reply_target!, /^channelId:/);
    return batch.reply_target!;
  };

  // Channel.
  const parent = await sendHumanMessage(f, "channel message");
  await sendTo(await expectReplyTarget(`#${f.channelName}`, "channel"), "channel reply");

  // Channel thread.
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: f.agentId,
    parentMessageId: parent.id,
    reason: "manual",
  }).onConflictDoNothing();
  await sendHumanMessage(f, "thread message", thread.id, false, "thread");
  await sendTo(await expectReplyTarget(`#${f.channelName}:${parent.id.slice(0, 8)}`, "channel thread"), "thread reply");

  // DM: the peer's name, never the storage channel id.
  const dm = await findOrCreateDM(f.serverId, f.ownerId, f.agentId);
  assert.ok(dm);
  const dmParent = await sendHumanMessage(f, "dm message", dm.id, false, "dm");
  await sendTo(await expectReplyTarget(`dm:@${f.ownerUniqueName}`, "dm"), "dm reply");

  // DM thread.
  const dmThread = await getOrCreateThread(dmParent.id, f.ownerId, "user");
  await getDb().insert(threadFollows).values({
    threadChannelId: dmThread.id,
    followerType: "agent",
    followerId: f.agentId,
    parentMessageId: dmParent.id,
    reason: "manual",
  }).onConflictDoNothing();
  await sendHumanMessage(f, "dm thread message", dmThread.id, false, "thread");
  await sendTo(await expectReplyTarget(`dm:@${f.ownerUniqueName}:${dmParent.id.slice(0, 8)}`, "dm thread"), "dm thread reply");
});

test("wake-hint target is the canonical send target of each pending message and /send resolves it", async ({ app }) => {
  const f = await seedExternalFixture();
  const follow = async (threadChannelId: string, parentMessageId: string) => {
    await getDb().insert(threadFollows).values({
      threadChannelId,
      followerType: "agent",
      followerId: f.agentId,
      parentMessageId,
      reason: "manual",
    }).onConflictDoNothing();
  };

  // One pending message in each conversation shape: channel, channel thread,
  // DM, DM thread.
  const parent = await sendHumanMessage(f, "channel message");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await follow(thread.id, parent.id);
  await sendHumanMessage(f, "thread message", thread.id, false, "thread");
  const dm = await findOrCreateDM(f.serverId, f.ownerId, f.agentId);
  assert.ok(dm);
  const dmParent = await sendHumanMessage(f, "dm message", dm.id, false, "dm");
  const dmThread = await getOrCreateThread(dmParent.id, f.ownerId, "user");
  await follow(dmThread.id, dmParent.id);
  await sendHumanMessage(f, "dm thread message", dmThread.id, false, "thread");
  freshProcess(app);

  const { wake_hints } = await fetchWakeHints(app.baseUrl, f.apiKey);
  const targets = [...new Set(wake_hints.map((hint) => hint.target as string | null))];
  for (const target of targets) {
    assert.ok(target, "every hint carries a target");
    assert.doesNotMatch(target, /^channelId:/);
  }
  assert.deepEqual(new Set(targets), new Set([
    `#${f.channelName}`,
    `#${f.channelName}:${parent.id.slice(0, 8)}`,
    `dm:@${f.ownerUniqueName}`,
    `dm:@${f.ownerUniqueName}:${dmParent.id.slice(0, 8)}`,
  ]));

  // Read everything (the send freshness gate holds on unseen messages), then
  // each hint target must be accepted by /send as-is.
  for (let i = 0; i < 10 && (await fetchEvents(app.baseUrl, f.apiKey)).events.length > 0; i += 1) { /* drain */ }
  for (const target of targets as string[]) {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target, content: `reply to ${target}` }),
    });
    const body = await res.json() as { state?: string };
    assert.equal(res.status, 200, `send to ${target} must resolve: ${JSON.stringify(body)}`);
    assert.equal(body.state, "sent", `send to ${target}: ${JSON.stringify(body)}`);
  }
});
