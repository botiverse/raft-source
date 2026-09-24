import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";

import { getDb } from "../db/index.js";
import { agents, channels, messageMentions, messages, servers, users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { ensureMentionDeliveryOccurrences } from "./mentionDeliveryOccurrenceService.js";


/**
 * HOTFIX PROBE (mention-push incident 2026-08-27), sibling to
 * agentOrchestrator.mentionRedriveDelivery.test.ts and bound to the same
 * judge-by-side-effect rule from @Kabi's review of #6700: a returned status
 * string is NOT the acceptance criterion — the delivery must happen AND the
 * occurrence row must end in an observable state.
 *
 * Regressed behavior pinned here: applyDirectDelivery silently demoted every
 * tracked mention whose session identity was not cached
 * ({status:"queued",reason:"replayable_inbox"}) BEFORE creating any span or
 * ws event — for machines whose daemon never established launchId/sessionId,
 * an @ produced literally zero trace until the next contact replayed the
 * inbox. The hotfix abandons instrumentation (terminal INSTRUMENT_FAILED) and
 * delivers untracked instead.
 */

const at = new Date("2026-08-27T00:00:00.000Z");

afterEach(async () => {
  await closeTestDatabase();
});

const identity = {
  machineId: "00000000-0000-4000-8000-000000000005",
  launchId: "launch-1",
  sessionId: "session-1",
};

class FallbackProbeOrchestrator extends AgentOrchestrator {
  deliveries = 0;

  protected override async getAuthoritativeAgentForDelivery(): Promise<any> {
    return {
      machineId: identity.machineId,
      expectedLaunchId: identity.launchId,
      sessionId: identity.sessionId,
      runtime: "codex",
    };
  }

  protected override async hasPassiveDeliveryScope(..._args: Parameters<AgentOrchestrator["hasPassiveDeliveryScope"]>): Promise<boolean> {
    return true;
  }

  protected override async canAgentAccessDeliveryTarget(..._args: Parameters<AgentOrchestrator["canAgentAccessDeliveryTarget"]>): Promise<boolean> {
    return true;
  }

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

  // The eligibility gate reads this.agentStateCache directly; expose seeding
  // without reaching into privates from the assertions themselves.
  seedIdentity(agentId: string): void {
    (this as unknown as { agentStateCache: Map<string, unknown> }).agentStateCache.set(agentId, {
      serverId: "server-unknown",
      expectedLaunchId: identity.launchId,
      sessionId: identity.sessionId,
      runtimeState: undefined,
    });
  }
}

async function seedTrackedMention(options: { agentStatus: "active" | "stopped" }) {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `fallback-${suffix}@raft.test`,
    name: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Fallback ${suffix.slice(0, 8)}`,
    slug: `fallback-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `agent-${suffix}`,
    runtime: "codex",
    status: options.agentStatus,
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

  // Fresh fanout state exactly as the send path creates it: no decision, no
  // identity snapshots yet. The state under test decides whether a machine
  // without established session identity can still receive its @ immediately.
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id,
    messageId: message.id,
    serverId: server.id,
    agentId: agent.id,
    deliveryPayload: payload,
  }]);

  return { agent, mention, message, payload };
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readRow(messageId: string, agentId: string) {
  const { getMentionDeliveryOccurrence } = await import("./mentionDeliveryOccurrenceService.js");
  return getMentionDeliveryOccurrence(messageId, agentId);
}

test("REGRESSION: missing session identity still DELIVERS the @ and abandons the occurrence terminal", async () => {
  const { agent, mention, payload } = await seedTrackedMention({ agentStatus: "active" });
  const orch = new FallbackProbeOrchestrator();
  // No seedIdentity(): cachedAgent has no expectedLaunchId/sessionId — the old-daemon shape.
  const result = await orch.deliverMessage(agent.id, payload as never, {
    mentionDeliveryOccurrenceId: mention.id,
  });
  assert.equal(result.status, "queued", `expected queued delivery, got ${JSON.stringify(result)}`);
  assert.ok(orch.deliveries >= 1, `the @ must actually be pushed (inbox/ws counter), saw ${orch.deliveries}`);
  await waitFor(async () => {
    const row = await readRow(payload.message_id!, agent.id);
    return row?.state === "terminal_error" && row?.terminalErrorCode === "INSTRUMENT_FAILED";
  }, "occurrence abandoned terminal INSTRUMENT_FAILED");
});

test("IDEMPOTENCY: a second delivery of an already-abandoned occurrence must not push a second copy", async () => {
  const { agent, mention, payload } = await seedTrackedMention({ agentStatus: "active" });
  const orch = new FallbackProbeOrchestrator();
  const first = await orch.deliverMessage(agent.id, payload as never, {
    mentionDeliveryOccurrenceId: mention.id,
  });
  assert.equal(first.status, "queued");
  await waitFor(async () => {
    const row = await readRow(payload.message_id!, agent.id);
    return row?.state === "terminal_error" && row?.terminalErrorCode === "INSTRUMENT_FAILED";
  }, "first call abandons the occurrence terminal");
  const deliveredOnce = orch.deliveries;
  assert.ok(deliveredOnce >= 1);

  const second = await orch.deliverMessage(agent.id, payload as never, {
    mentionDeliveryOccurrenceId: mention.id,
  });
  assert.equal(second.status, "dropped", `second call must lose the CAS, got ${JSON.stringify(second)}`);
  assert.equal(second.status === "dropped" && second.reason, "agent_state_changed");
  assert.equal(orch.deliveries, deliveredOnce, "second call must produce zero new inbox/ws side effects");
  const row = await readRow(payload.message_id!, agent.id);
  assert.equal(row?.version, 1, "terminalization must have happened exactly once");
});

test("DECISION RACE: an occurrence already server-decided by another path is never terminalized or double-delivered", async () => {
  const { agent, mention, payload } = await seedTrackedMention({ agentStatus: "active" });
  const { recordMentionDeliveryServerDecision } = await import("./mentionDeliveryOccurrenceService.js");
  // A session/recovery path with established identity won the race and
  // recorded the server decision before our identity-missing delivery ran.
  const decided = await recordMentionDeliveryServerDecision({
    occurrenceId: mention.id,
    payload,
    identity: {
      machineId: identity.machineId,
      launchId: identity.launchId,
      sessionId: identity.sessionId,
    },
  });
  assert.ok(decided, "fixture: server decision must be recorded");

  const orch = new FallbackProbeOrchestrator();
  const result = await orch.deliverMessage(agent.id, payload as never, {
    mentionDeliveryOccurrenceId: mention.id,
  });
  assert.equal(result.status, "dropped", `raced call must not own an untracked push, got ${JSON.stringify(result)}`);
  assert.equal(orch.deliveries, 0, "raced call must produce zero inbox/ws side effects");
  const row = await readRow(payload.message_id!, agent.id);
  assert.equal(row?.state, "server_decided", "the tracked decision must survive the raced fallback");
  assert.equal(row?.terminalErrorAt, null);
});

test("0-ROW: an occurrence id with no durable row must not fall through to an owned untracked push", async () => {
  const { agent, payload } = await seedTrackedMention({ agentStatus: "active" });
  const orch = new FallbackProbeOrchestrator();
  const result = await orch.deliverMessage(agent.id, payload as never, {
    mentionDeliveryOccurrenceId: randomUUID(),
  });
  assert.equal(result.status, "dropped", `0-row CAS must not own a push, got ${JSON.stringify(result)}`);
  assert.equal(orch.deliveries, 0);
});

test("POSITIVE CONTROL: established session identity keeps the tracked path", async () => {
  const { agent, mention, payload } = await seedTrackedMention({ agentStatus: "active" });
  const orch = new FallbackProbeOrchestrator();
  orch.seedIdentity(agent.id);
  const result = await orch.deliverMessage(agent.id, payload as never, {
    mentionDeliveryOccurrenceId: mention.id,
  });
  assert.equal(result.status, "queued");
  assert.ok(orch.deliveries >= 1);
  const row = await readRow(payload.message_id!, agent.id);
  assert.equal(row?.state, "server_decided", `tracked path must record the server decision, saw ${row?.state}`);
  assert.equal(row?.sessionIdSnapshot, identity.sessionId);
  assert.equal(row?.terminalErrorAt, null);
});
