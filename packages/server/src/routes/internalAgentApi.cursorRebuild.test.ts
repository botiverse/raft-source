import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
// CS-4 (CL-CURSOR-SPLIT) — rebuild external-agent pending deliveries from the
// durable per-channel ack watermark after the volatile buffer is lost (server
// restart/deploy). Contract pins (Kai, #wg-external-agent):
//   1. per-channel watermark, never a global/merged cursor;
//   2. channels without a cursor row ARE rebuilt from the agent's join time
//      (cold-start fallback — pre-join history treated as consumed);
//   3. the watermark never feeds freshness/model-seen (CS-2 guard);
//   4. rebuilt entries are buffer-native snake_case AgentMessage — /history's
//      camelCase enriched rows must not leak onto the /events wire.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import { channelAgents, inboxTargetMuteStates, messages, threadFollows, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addAgent, addHuman, removeAgent, markAgentLegacyRead, getAgentLegacyReadCursor, getOrCreateThread } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedExternalFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `cursor-rebuild-${suffix}@slock.test`,
    name: `cursor-rebuild-${suffix}`,
    displayName: "Cursor Rebuild Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Cursor Rebuild Test", `cursor-rebuild-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "CursorRebuildExt", { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, "cursor-rebuild-room");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "cursor-rebuild-test",
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

async function sendHumanMessage(f: Fixture, content: string, channelId = f.channelId) {
  const message = await createMessage(channelId, "user", f.ownerId, content);
  const [agentMember] = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, f.agentId)))
    .limit(1);
  if (agentMember) {
    await recordInboxNotificationFacts([{
      receiverType: "agent",
      receiverId: f.agentId,
      serverId: f.serverId,
      kind: "channel",
      sourceChannelId: channelId,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: message.createdAt,
      personalMention: false,
      unreadEligible: true,
    }]);
  }
  return message;
}

async function sendSystemMessage(f: Fixture, content: string, channelId = f.channelId) {
  const message = await createMessage(channelId, "user", "system", content, "system");
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

// Cold-start rebuild keys the post-join boundary on `channel_agents.added_at`
// vs `messages.created_at` (see `rebuildExternalAgentPendingInner`). Both
// default to `now()`, which on a fast PGlite-backed test can collide at
// millisecond precision between an `addAgent` insert and the immediately
// following `createMessage` — the strict `>` in the candidate-EXISTS check
// then drops the legitimate post-join row. We pin the three timestamps
// explicitly so the boundary is unambiguous and the test is wall-clock-free.
async function pinJoinBoundary(
  channelId: string,
  agentId: string,
  preMessageId: string,
  postMessageId: string,
): Promise<void> {
  const db = getDb();
  const base = new Date(Date.now() - 1000);
  const preAt = new Date(base.getTime());
  const addedAt = new Date(base.getTime() + 50);
  const postAt = new Date(base.getTime() + 100);
  await db.update(messages).set({ createdAt: preAt }).where(eq(messages.id, preMessageId));
  await db.update(channelAgents).set({ addedAt }).where(
    and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)),
  );
  await db.update(messages).set({ createdAt: postAt }).where(eq(messages.id, postMessageId));
}

async function fetchEvents(baseUrl: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/events`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as { events: any[]; has_more: boolean };
}

async function fetchWakeHints(baseUrl: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/wake-hints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as { wake_hints: any[]; has_more: boolean };
}

test("restart rebuild: durable rows above the ack watermark come back through /events; ack re-advances the watermark so they do not loop", async ({ app }) => {
  const f = await seedExternalFixture();
  const acked = await sendHumanMessage(f, "acked before restart");
  await markAgentLegacyRead(f.agentId, f.channelId, acked.seq);
  const lost1 = await sendHumanMessage(f, "undrained one");
  const lost2 = await sendHumanMessage(f, "undrained two");

  // "Restart": a fresh orchestrator with an empty volatile buffer — the
  // pre-CS-4 state where lost1/lost2 were permanently invisible to check.
  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(
    first.events.map((e) => e.seq),
    [lost1.seq, lost2.seq],
    "exactly the rows above the watermark, in seq order",
  );
  // Shape parity: buffer-native snake_case AgentMessage on the wire, not
  // /history's camelCase enriched row.
  const rebuilt = first.events[0];
  assert.equal(rebuilt.channel_id, f.channelId);
  assert.equal(rebuilt.channel_name, f.channelName);
  assert.equal(rebuilt.sender_type, "human");
  // Live fan-out parity: sender_name is the @mention-able UNIQUE name, not
  // the enriched display name ("Cursor Rebuild Owner" in this fixture).
  assert.equal(rebuilt.sender_name, f.ownerUniqueName);
  assert.equal(rebuilt.message_id, lost1.id);
  assert.equal(rebuilt.content, "undrained one");
  assert.equal("senderName" in rebuilt, false, "enriched camelCase senderName must not leak");
  assert.equal("reactions" in rebuilt, false, "enriched reactions must not leak");

  // /events claimed + acked the batch → watermark re-advanced durably.
  const cursor = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  assert.equal(cursor, lost2.seq);

  // No redelivery loop: the same rows must not be rebuilt again.
  const second = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(second.events, []);
});

test("restart rebuild records one aggregate trace event without raw ids", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const acked = await sendHumanMessage(f, "acked before restart");
  await markAgentLegacyRead(f.agentId, f.channelId, acked.seq);
  const lost1 = await sendHumanMessage(f, "trace undrained one");
  const lost2 = await sendHumanMessage(f, "trace undrained two");

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), [lost1.seq, lost2.seq]);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent-api/events"
  );
  assert.ok(span, "expected GET /internal/agent-api/events root span");
  const event = span.events.find((candidate) => candidate.name === "external_agent.cursor_rebuild.finished");
  assert.ok(event, "expected aggregate cursor rebuild trace event");
  assert.equal(event.attrs?.route, "events");
  assert.equal(event.attrs?.candidate_channel_count, 1);
  assert.equal(event.attrs?.cursor_candidate_channel_count, 1);
  assert.equal(event.attrs?.cold_start_candidate_channel_count, 0);
  assert.equal(event.attrs?.pending_before_count, 0);
  assert.equal(event.attrs?.inspected_message_count, 2);
  assert.equal(event.attrs?.rebuilt_message_count, 2);
  assert.equal(event.attrs?.deduped_pending_count, 0);
  assert.equal(event.attrs?.delivery_failure_count, 0);
  const attrs = event.attrs ?? {};
  assert.equal("agent_id" in attrs, false);
  assert.equal("channel_id" in attrs, false);
  assert.equal("message_id" in attrs, false);
  assert.ok(!Object.values(attrs).includes(f.agentId));
  assert.ok(!Object.values(attrs).includes(f.channelId));
  assert.ok(!Object.values(attrs).includes(lost1.id));
  assert.ok(!Object.values(attrs).includes(lost2.id));
});

test("restart rebuild suppresses muted ordinary rows but preserves pierce facts", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "acked before mute");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    sourceChannelId: f.channelId,
    muteFromSeq: base.seq + 1,
  });

  await sendHumanMessage(f, "muted ordinary after restart");
  const pierced = await createMessage(f.channelId, "user", f.ownerId, `@CursorRebuildExt pierce after restart`);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: f.channelId,
    messageId: pierced.id,
    messageSeq: pierced.seq,
    activityAt: pierced.createdAt,
    personalMention: true,
    unreadEligible: true,
  }]);

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((event) => event.message_id), [pierced.id]);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent-api/events"
  );
  assert.ok(span, "expected GET /internal/agent-api/events root span");
  const rebuildEvent = span.events.find((candidate) => candidate.name === "external_agent.cursor_rebuild.finished");
  assert.ok(rebuildEvent, "expected aggregate cursor rebuild trace event");
  assert.equal(rebuildEvent.attrs?.skipped_muted_count, 1);
  assert.equal(rebuildEvent.attrs?.rebuilt_message_count, 1);
});

test("restart rebuild keeps followed-thread rows independent from the parent mute boundary", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
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

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((event) => event.message_id), [beforeMute.id, boundary.id]);
  assert.equal(first.events[0]?.parent_channel_id, f.channelId);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent-api/events"
  );
  assert.ok(span, "expected GET /internal/agent-api/events root span");
  const rebuildEvent = span.events.find((candidate) => candidate.name === "external_agent.cursor_rebuild.finished");
  assert.ok(rebuildEvent, "expected aggregate cursor rebuild trace event");
  assert.equal(rebuildEvent.attrs?.skipped_muted_count, 0);
  assert.equal(rebuildEvent.attrs?.rebuilt_message_count, 2);
});

test("restart rebuild preserves persisted system sender rows without UUID profile lookup", async ({ app }) => {
  const f = await seedExternalFixture();
  const acked = await sendHumanMessage(f, "acked before system event");
  await markAgentLegacyRead(f.agentId, f.channelId, acked.seq);
  const system = await sendSystemMessage(f, "system event after restart");

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e) => e.seq), [system.seq]);
  assert.equal(first.events[0].sender_id, "system");
  assert.equal(first.events[0].sender_name, "system");
  assert.equal(first.events[0].sender_description, null);
  assert.equal(first.events[0].sender_type, "system");
  assert.equal(first.events[0].message_id, system.id);
  assert.equal(first.events[0].content, "system event after restart");

  const cursor = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  assert.equal(cursor, system.seq);
});

test("per-channel watermark: a fully-acked channel at a higher seq does not mask another channel's unacked backlog (no global cursor)", async ({ app }) => {
  const f = await seedExternalFixture();
  const channelB = await createChannel(f.serverId, "cursor-rebuild-room-b");
  await addHuman(channelB.id, f.ownerId);
  await addAgent(channelB.id, f.agentId);

  // Channel B accrues backlog above its (low) watermark...
  const bBase = await sendHumanMessage(f, "b acked", channelB.id);
  await markAgentLegacyRead(f.agentId, channelB.id, bBase.seq);
  const bLost = await sendHumanMessage(f, "b undrained", channelB.id);
  // ...then channel A is fully acked at a HIGHER global seq. A merged/global
  // cursor would fabricate consumption of bLost and skip it.
  const aSeen = await sendHumanMessage(f, "a acked at higher seq");
  await markAgentLegacyRead(f.agentId, f.channelId, aSeen.seq);

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const { events } = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(events.map((e) => e.seq), [bLost.seq]);
  assert.equal(events[0].channel_id, channelB.id);
});

test("cold-start: a channel with no cursor row IS rebuilt from the agent's join time; own agent sends above the watermark are not redelivered", async ({ app }) => {
  const f = await seedExternalFixture();
  // No-cursor channel: the agent was added after some messages existed.
  // Cold-start fallback rebuilds messages sent AFTER the agent joined.
  const noCursorChannel = await createChannel(f.serverId, "cursor-rebuild-no-cursor");
  await addHuman(noCursorChannel.id, f.ownerId);
  // Pre-join message — should NOT be rebuilt (before agent joined).
  const preJoinMsg = await sendHumanMessage(f, "before agent joined", noCursorChannel.id);
  await addAgent(noCursorChannel.id, f.agentId);
  // Post-join message — SHOULD be rebuilt (cold-start fallback).
  const postJoinMsg = await sendHumanMessage(f, "after agent joined", noCursorChannel.id);
  // Make the join boundary deterministic: pin pre.createdAt < addedAt < post.createdAt
  // by direct UPDATE so the cold-start strict `>` comparison cannot collide on
  // millisecond-precision `now()` defaults.
  await pinJoinBoundary(noCursorChannel.id, f.agentId, preJoinMsg.id, postJoinMsg.id);

  const base = await sendHumanMessage(f, "base");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const ownSend = await createMessage(f.channelId, "agent", f.agentId, "agent's own message");
  const humanAfter = await sendHumanMessage(f, "human after agent send");
  assert.ok(ownSend.seq > base.seq);

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const { events } = await fetchEvents(app.baseUrl, f.apiKey);
  const seqs = events.map((e: any) => e.seq);
  assert.ok(seqs.includes(postJoinMsg.seq), "post-join message in no-cursor channel should be rebuilt");
  assert.ok(!seqs.includes(preJoinMsg.seq), "pre-join message should NOT be rebuilt");
  assert.ok(seqs.includes(humanAfter.seq), "cursor-based channel should still rebuild");
  assert.ok(!seqs.includes(ownSend.seq), "agent's own send should not be redelivered");
});

test("live-buffer dedupe: a delivered-but-unacked row is not doubled by rebuild", async ({ app }) => {
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "base");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const pending = await sendHumanMessage(f, "delivered but unacked");

  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  // Same row sits in the volatile buffer (live fan-out) AND above the
  // durable watermark — exactly the overlap every unacked message lives in.
  await orchestrator.deliverMessage(f.agentId, {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel",
    sender_id: f.ownerId,
    sender_name: "Cursor Rebuild Owner",
    sender_type: "human",
    content: "delivered but unacked",
    timestamp: new Date().toISOString(),
    seq: pending.seq,
    message_id: pending.id,
  });

  const { events } = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(events.map((e) => e.seq), [pending.seq], "one copy, not two");
});

test("wake-hints surface rebuilt pending without draining; CS-2: the rebuild watermark never serves as freshness proof", async ({ app }) => {
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "base");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const lost = await sendHumanMessage(f, "undrained before restart");

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  // Peek is non-draining and rebuild is idempotent: two polls, same hint, no duplicates.
  for (let i = 0; i < 2; i += 1) {
    const { wake_hints } = await fetchWakeHints(app.baseUrl, f.apiKey);
    assert.deepEqual(wake_hints.map((h) => h.seq), [lost.seq]);
    assert.equal("content" in (wake_hints[0] ?? {}), false, "wake hints stay content-free");
  }

  // CS-2 guard: the durable watermark (advanced by ack/rebuild bookkeeping)
  // is delivery state, not model-seen proof. A send claiming only the
  // pre-restart boundary must still be held on the unseen message.
  const drained = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(drained.events.map((e) => e.seq), [lost.seq]);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), lost.seq);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      target: `#${f.channelName}`,
      content: "send with stale model state after rebuild",
      seenUpToSeq: base.seq,
    }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(body.state, "held", "watermark at lost.seq must not stand in for model-seen");
  assert.equal(body.heldMessages?.[0]?.id, lost.id);
});

test("events check trace records body_result=empty when no pending events exist", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const msg = await sendHumanMessage(f, "message to ack");
  await markAgentLegacyRead(f.agentId, f.channelId, msg.seq);

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const first = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(first.events.map((e: any) => e.seq), []);

  const checkEvent = sink.getAllSpans()
    .find((s) => s.name === "server.http.request" && s.attrs?.route_pattern === "/internal/agent-api/events")
    ?.events.find((e) => e.name === "external_agent.events.check.finished");
  assert.ok(checkEvent, "expected events check trace event");
  assert.equal(checkEvent.attrs?.body_result, "empty");
  assert.equal(checkEvent.attrs?.returned_count, 0);
  assert.equal(checkEvent.attrs?.is_external, true);
});

test("rebuild trace records rebuild_outcome=messages_rebuilt when messages are found", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "acked");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  await sendHumanMessage(f, "undrained after restart");

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const { events } = await fetchEvents(app.baseUrl, f.apiKey);
  assert.equal(events.length, 1);

  const rebuildEvent = sink.getAllSpans()
    .find((s) => s.name === "server.http.request" && s.attrs?.route_pattern === "/internal/agent-api/events")
    ?.events.find((e) => e.name === "external_agent.cursor_rebuild.finished");
  assert.ok(rebuildEvent, "expected rebuild trace event");
  assert.equal(rebuildEvent.attrs?.rebuild_outcome, "messages_rebuilt");

  const checkEvent = sink.getAllSpans()
    .find((s) => s.name === "server.http.request" && s.attrs?.route_pattern === "/internal/agent-api/events")
    ?.events.find((e) => e.name === "external_agent.events.check.finished");
  assert.ok(checkEvent, "expected events check trace event");
  assert.equal(checkEvent.attrs?.body_result, "returned");
  assert.equal(checkEvent.attrs?.returned_count, 1);
});

// RED-GREEN: negative evidence rebuild trace tests
//
// These test the gate and classification changes in
// emitExternalAgentCursorRebuildTrace. Before these changes:
//   1. The hasWorkSignal gate suppressed the trace when candidates existed
//      but only deduped messages were found (deduped not in the flag list).
//   2. The rebuild_outcome classification fell through to
//      "no_messages_above_watermark" for pre-inspection skips (joint/no
//      membership) — a misclassification.

test("RED-GREEN: rebuild trace fires with all_filtered when all candidates are live-buffer deduped (negative evidence gate)", async ({ app }) => {
  // Before: hasWorkSignal gate suppressed this trace (deduped not in flag
  // list, so hasWorkSignal = false when only deduped messages existed).
  // After: totalCandidates > 0 gate fires the trace; all_filtered is the
  // correct outcome when inspected > 0 but rebuilt = 0.

  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "base");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  const pending = await sendHumanMessage(f, "delivered but unacked");

  // Restart with fresh orchestrator, then inject the same message into the
  // volatile buffer — simulating a delivered-but-unacked state.
  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  await orchestrator.deliverMessage(f.agentId, {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel",
    sender_id: f.ownerId,
    sender_name: f.ownerUniqueName,
    sender_type: "human",
    content: "delivered but unacked",
    timestamp: new Date().toISOString(),
    seq: pending.seq,
    message_id: pending.id,
  });

  // /events: rebuild finds the cursor candidate (seq above watermark) but
  // the message is already in the volatile buffer → deduped, rebuilt = 0.
  await fetchEvents(app.baseUrl, f.apiKey);

  const rebuildEvent = sink.getAllSpans()
    .find((s) => s.name === "server.http.request" && s.attrs?.route_pattern === "/internal/agent-api/events")
    ?.events.find((e) => e.name === "external_agent.cursor_rebuild.finished");
  assert.ok(rebuildEvent, "rebuild trace must fire when candidates exist, even if all deduped — this was suppressed by the old hasWorkSignal gate");
  assert.equal(rebuildEvent.attrs?.candidate_channel_count, 1);
  assert.equal(rebuildEvent.attrs?.inspected_message_count, 1);
  assert.equal(rebuildEvent.attrs?.deduped_pending_count, 1);
  assert.equal(rebuildEvent.attrs?.rebuilt_message_count, 0);
  assert.equal(rebuildEvent.attrs?.rebuild_outcome, "all_filtered");
});

test("RED-GREEN: rebuild_outcome=candidates_skipped when agent lost channel membership (classification fix)", async ({ app }) => {
  // Before: pre-inspection skips (skippedNoMembership > 0 but
  // inspectedMessages = 0) fell through to "no_messages_above_watermark" —
  // a misclassification that hid the real reason (agent no longer a member).
  // After: the new candidates_skipped outcome correctly distinguishes this.

  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const f = await seedExternalFixture();
  const base = await sendHumanMessage(f, "base");
  await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
  await sendHumanMessage(f, "message above watermark");

  // Remove the agent from the channel. The cursor row persists (it lives
  // in agentChannelReadCursors, not channelAgents), so the rebuild still
  // generates a candidate — but the membership check at rebuild time
  // rejects it.
  await removeAgent(f.channelId, f.agentId);

  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  const { events } = await fetchEvents(app.baseUrl, f.apiKey);
  assert.deepEqual(events, [], "no events — agent lost membership");

  const rebuildEvent = sink.getAllSpans()
    .find((s) => s.name === "server.http.request" && s.attrs?.route_pattern === "/internal/agent-api/events")
    ?.events.find((e) => e.name === "external_agent.cursor_rebuild.finished");
  assert.ok(rebuildEvent, "rebuild trace must fire when candidates exist");
  assert.equal(rebuildEvent.attrs?.candidate_channel_count, 1);
  assert.equal(rebuildEvent.attrs?.skipped_no_membership_count, 1);
  assert.equal(rebuildEvent.attrs?.inspected_message_count, 0);
  assert.equal(rebuildEvent.attrs?.rebuilt_message_count, 0);
  assert.notEqual(
    rebuildEvent.attrs?.rebuild_outcome,
    "no_messages_above_watermark",
    "pre-inspection skip must NOT be classified as no_messages_above_watermark",
  );
  assert.equal(rebuildEvent.attrs?.rebuild_outcome, "candidates_skipped");
});
