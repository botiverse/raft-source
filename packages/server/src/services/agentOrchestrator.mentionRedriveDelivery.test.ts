import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";

import { getDb } from "../db/index.js";
import { agents, channels, messageMentions, messages, servers, users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import {
  ensureMentionDeliveryOccurrences,
  recordMentionDeliveryAck,
  recordMentionDeliveryDaemonTransition,
  recordMentionDeliveryServerDecision,
} from "./mentionDeliveryOccurrenceService.js";


/**
 * THE "AND NO DELIVERY HAPPENED" HALF of @Kabi's CHANGES REQUIRED on PR #6700.
 *
 * The sibling file (agentOrchestrator.mentionRedrivePlan.test.ts) pins the STATUS a caller is
 * told. That is only half of the acceptance criterion I myself set earlier the same day and then
 * failed to meet: judge by the exit code AND by whether the side effect occurred, never by the
 * log. @Kabi pointed out the omission was the half of my own rule, not an optional extra.
 *
 * PROBE SHAPE, from him: replace the real delivery call with a COUNTER and assert the
 * (verdict, count) PAIR. His warning, learned the hard way on his own probe: a count of 0 is
 * UNREADABLE unless some other arm proves the same counter can reach 1 — three arms all reading 0
 * looked like a strict gate and was actually a dead probe. Hence the positive control below.
 *
 * BOTH delivery calls are counted. The queued path delivers twice (local inbox enqueue, then the
 * ack-retry send); counting only the one that happened to be `protected` would make 0 mean "I
 * could not see one of the two ways it delivers". Widening the other to `protected` is the only
 * production change here and exists purely for this seam.
 */

const at = new Date("2026-08-20T00:00:00.000Z");

afterEach(async () => {
  await closeTestDatabase();
});

class CountingOrchestrator extends AgentOrchestrator {
  deliveries = 0;
  constructor(private readonly agentIdentity: { machineId: string; launchId: string; sessionId: string }) {
    super();
  }

  // Overridden so the arms can reach the branch under test without seeding a full agent row.
  protected override async getAuthoritativeAgentForDelivery(): Promise<any> {
    return {
      machineId: this.agentIdentity.machineId,
      expectedLaunchId: this.agentIdentity.launchId,
      sessionId: this.agentIdentity.sessionId,
    };
  }

  // Signatures must MATCH the base, including the boolean return. My first version took no
  // parameters and returned void; the tests still passed 3/3 while tsc reported two TS2416s —
  // a green suite over a type error, because at runtime a JS override does not care.
  protected override async enqueueToLocalInboxIfStillActive(
    ..._args: Parameters<AgentOrchestrator["enqueueToLocalInboxIfStillActive"]>
  ): Promise<boolean> {
    this.deliveries += 1;
    return true;
  }

  protected override async sendAgentDeliveryWithAckRetry(
    ..._args: Parameters<AgentOrchestrator["sendAgentDeliveryWithAckRetry"]>
  ): Promise<boolean> {
    this.deliveries += 1;
    return true;
  }
}

async function seedRedrivableOccurrence() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `redrive-${suffix}@raft.test`,
    name: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Redrive ${suffix.slice(0, 8)}`,
    slug: `redrive-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `agent-${suffix}`,
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `channel-${suffix}`,
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: `hello @${agent.name}`,
    seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id,
    messageSeq: 1,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: agent.name,
  }).returning();

  const payload = {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: "channel" as const,
    sender_id: owner.id,
    sender_name: owner.name,
    sender_type: "human" as const,
    content: message.content,
    timestamp: at.toISOString(),
    message_id: message.id,
    seq: 1,
  };
  const identity = {
    machineId: "00000000-0000-4000-8000-000000000005",
    launchId: "launch-1",
    sessionId: "session-1",
  };

  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id,
    messageId: message.id,
    serverId: server.id,
    agentId: agent.id,
    deliveryPayload: payload,
  }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_received",
  });
  const pending = await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_pending",
  });
  assert.ok(pending, "fixture must reach a redrivable state");

  return { agent, message, mention, identity, version: pending.version };
}

test("POSITIVE CONTROL: an exact-version redrive queues AND actually delivers", async () => {
  // Without this the two zeros below are unreadable — they would equally well mean the counter is
  // never incremented by anything. This arm is what makes deliveries===0 a finding.
  const { agent, message, identity, version } = await seedRedrivableOccurrence();
  const orch = new CountingOrchestrator(identity);
  const result = await orch.redriveMentionDelivery(message.id, agent.id, version);
  assert.equal(result.status, "REDRIVE_QUEUED");
  assert.ok(orch.deliveries >= 1, `the counter must be able to reach 1, saw ${orch.deliveries}`);
});

test("a stale expectedVersion answers CAS_MISMATCH and delivers NOTHING", async () => {
  // Another writer moved the row first. Re-delivering here is the duplicate-delivery shape, so the
  // claim being refused must leave the counter untouched — not merely return a different string.
  const { agent, message, identity, version } = await seedRedrivableOccurrence();
  const orch = new CountingOrchestrator(identity);
  const result = await orch.redriveMentionDelivery(message.id, agent.id, version + 7);
  assert.equal(result.status, "CAS_MISMATCH");
  assert.equal(orch.deliveries, 0, "a refused CAS claim must not deliver");
});

test("an already-ACKed occurrence answers ACKED and delivers NOTHING", async () => {
  // The message already arrived; redriving it would deliver a second copy to the agent.
  const { agent, message, mention, identity, version } = await seedRedrivableOccurrence();
  // The hop order is received -> pending -> drained -> acked. Skipping the drain made the ack a
  // silent null and left the row at daemon_pending — which is why the arm below first proves the
  // fixture arrived, rather than reading a REDRIVE_QUEUED as "it re-delivers ACKed messages".
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_drained",
  });
  const ack = await recordMentionDeliveryAck({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
  });
  // FIXTURE ASSERTION FIRST. If the ack silently no-ops, the arm below fails for a reason that has
  // nothing to do with the code under test — and "it re-delivered an ACKed message" is far too
  // serious a claim to publish without first proving the message was actually ACKed.
  const { getMentionDeliveryOccurrence } = await import("./mentionDeliveryOccurrenceService.js");
  const row = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.equal(row?.state, "acked", `fixture must reach state=acked (ack returned ${JSON.stringify(ack)})`);
  const orch = new CountingOrchestrator(identity);
  const result = await orch.redriveMentionDelivery(message.id, agent.id, version);
  assert.equal(result.status, "ACKED");
  assert.equal(orch.deliveries, 0, "an ACKed occurrence must never be re-delivered");
});
