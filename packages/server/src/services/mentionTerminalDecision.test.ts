import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { getDb } from "../db/index";
import { agents, channels, messageMentions, messages, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { ensureMentionDeliveryOccurrences, recordMentionDeliveryServerDecision,
  recordMentionDeliveryTerminalError, recordMentionDeliveryIdentityDriftForIdentity,
  getMentionDeliveryOccurrence, evaluateMentionDeliveryOccurrence } from "./mentionDeliveryOccurrenceService";

afterEach(async () => { vi.restoreAllMocks(); await closeTestDatabase(); });

async function seed() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({ email: `${suffix}@raft.test`, name: suffix, passwordHash: "hash" }).returning();
  const [server] = await db.insert(servers).values({ name: suffix, slug: suffix, ownerId: owner.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: suffix, runtime: "codex" }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: suffix, type: "channel" }).returning();
  const [message] = await db.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: owner.id, content: "synthetic", seq: 1 }).returning();
  const [mention] = await db.insert(messageMentions).values({ messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id, targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name }).returning();
  const payload = { channel_id: channel.id, channel_name: channel.name, channel_type: "channel" as const, sender_id: owner.id, sender_name: owner.name, sender_type: "human" as const, content: "synthetic", timestamp: new Date().toISOString(), message_id: message.id, seq: 1 };
  const identity = { machineId: randomUUID(), launchId: "carried-launch", sessionId: "carried-session" };
  await ensureMentionDeliveryOccurrences([{ occurrenceId: mention.id, messageId: message.id, serverId: server.id, agentId: agent.id, deliveryPayload: payload }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  return { occurrenceId: mention.id, messageId: message.id, agentId: agent.id, identity };
}

for (const mismatch of [false, true]) {
  test(`terminal receipt preserves original daemon code with server mismatch=${mismatch}`, async ({ db }) => {
    void db;
    const input = await seed();
    const orch = new AgentOrchestrator();
    // Replace only connection authorization/cache lookup; execute the real receipt handler and DB CAS.
    vi.spyOn(orch as any, "validateMachineAgentMessage").mockResolvedValue({ expectedLaunchId: mismatch ? "other-launch" : input.identity.launchId, sessionId: input.identity.sessionId });
    await orch.handleMachineMessage(input.identity.machineId, { type: "agent:delivery:terminal_error", agentId: input.agentId, code: "IDENTITY_UNKNOWN", mentionDelivery: { ...input.identity, occurrenceId: input.occurrenceId, messageId: input.messageId } });
    const row = await getMentionDeliveryOccurrence(input.messageId, input.agentId);
    assert.ok(row);
    assert.equal(row.terminalErrorCode, mismatch ? "IDENTITY_DRIFT" : "IDENTITY_UNKNOWN");
    assert.deepEqual(row.terminalDecision, { layer: mismatch ? "server" : "daemon", stage: "terminal_receipt", originalDaemonCode: "IDENTITY_UNKNOWN" });
    const result = evaluateMentionDeliveryOccurrence(row);
    assert.equal(result.status, "TERMINAL_ERROR");
    if (result.status === "TERMINAL_ERROR") assert.deepEqual(result.decision, row.terminalDecision);
    assert.equal(row.daemonReceivedAt, null);
  });
}

test("stage identity mismatch records its own layer without inventing a daemon rejection", async ({ db }) => {
  void db;
  const input = await seed();
  const orch = new AgentOrchestrator();
  vi.spyOn(orch as any, "validateMachineAgentMessage").mockResolvedValue({ expectedLaunchId: "other-launch", sessionId: input.identity.sessionId });
  await orch.handleMachineMessage(input.identity.machineId, { type: "agent:delivery:transition", agentId: input.agentId, stage: "daemon_received", outcome: "accepted", mentionDelivery: { ...input.identity, occurrenceId: input.occurrenceId, messageId: input.messageId } });
  const row = await getMentionDeliveryOccurrence(input.messageId, input.agentId);
  assert.ok(row);
  assert.equal(row.daemonReceivedAt, null);
  assert.deepEqual(row.terminalDecision, { layer: "server", stage: "stage_receipt", originalDaemonCode: null });
});

for (const daemonFirst of [false, true]) {
  test(`competing terminal writes preserve one complete winner, daemon scheduled first=${daemonFirst}`, async ({ db }) => {
    void db;
    const input = await seed();
    const daemon = () => recordMentionDeliveryTerminalError({ ...input, code: "DELIVERY_REJECTED" });
    const server = () => recordMentionDeliveryIdentityDriftForIdentity({ ...input, stage: "ack_receipt" });
    const results = await Promise.all(daemonFirst ? [daemon(), server()] : [server(), daemon()]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.find(Boolean)!;
    const row = await getMentionDeliveryOccurrence(input.messageId, input.agentId);
    assert.deepEqual(row, winner);
    assert.equal(row!.version, 2);
    assert.deepEqual(row!.terminalDecision, row!.terminalErrorCode === "DELIVERY_REJECTED"
      ? { layer: "daemon", stage: "terminal_receipt", originalDaemonCode: "DELIVERY_REJECTED" }
      : { layer: "server", stage: "ack_receipt", originalDaemonCode: null });
    assert.equal(await recordMentionDeliveryTerminalError({ ...input, code: "QUOTA_LIMITED" }), null);
    assert.deepEqual(await getMentionDeliveryOccurrence(input.messageId, input.agentId), winner);
  });
}

test("legacy terminal without provenance remains readable without invented reason", async ({ db }) => {
  void db;
  const input = await seed();
  const row = await getMentionDeliveryOccurrence(input.messageId, input.agentId);
  assert.ok(row);
  const result = evaluateMentionDeliveryOccurrence({ ...row, state: "terminal_error", terminalErrorAt: new Date(), terminalErrorCode: "IDENTITY_DRIFT", terminalDecision: null });
  assert.equal(result.status, "TERMINAL_ERROR");
  assert.equal(Object.hasOwn(result, "decision"), false);
});

test("a daemon's terminal error redelivers the message once, untracked, so a refusal never drops it", async ({ db }) => {
  void db;
  const input = await seed();
  const orch = new AgentOrchestrator();
  vi.spyOn(orch as any, "validateMachineAgentMessage").mockResolvedValue({ expectedLaunchId: input.identity.launchId, sessionId: input.identity.sessionId });
  const sent: unknown[] = [];
  vi.spyOn(orch as any, "sendAgentDeliveryWithAckRetry").mockImplementation(async (_machineId: unknown, msg: unknown) => { sent.push(msg); return true; });
  const receipt = { type: "agent:delivery:terminal_error" as const, agentId: input.agentId, code: "UNSUPPORTED_DELIVERY_PATH" as const, mentionDelivery: { ...input.identity, occurrenceId: input.occurrenceId, messageId: input.messageId } };
  await orch.handleMachineMessage(input.identity.machineId, receipt);
  assert.equal(sent.length, 1);
  const delivery = sent[0] as { type: string; agentId: string; message: { message_id: string }; mentionDelivery?: unknown; deliveryId?: string };
  assert.equal(delivery.type, "agent:deliver");
  assert.equal(delivery.agentId, input.agentId);
  assert.equal(delivery.message.message_id, input.messageId);
  assert.equal(delivery.mentionDelivery, undefined, "untracked: no second terminal error can come back");
  assert.notEqual(delivery.deliveryId, input.occurrenceId);
  // A repeated receipt finds the occurrence already terminal: no second copy.
  await orch.handleMachineMessage(input.identity.machineId, receipt);
  assert.equal(sent.length, 1);
});

for (const driftAtRefusal of [true, false]) {
  test(`a refusal after a stage-receipt identity drift still redelivers once (server still drifted=${driftAtRefusal})`, async ({ db }) => {
    void db;
    // Bencher (v1.21.54 bench, daemon 1.0.61): the server's session moved between its
    // decision and the daemon's daemon_received, so the stage receipt ended the
    // occurrence as IDENTITY_DRIFT and sent nothing; the daemon's refusal then found
    // the row already terminal and the message was lost.
    const input = await seed();
    const orch = new AgentOrchestrator();
    const validate = vi.spyOn(orch as any, "validateMachineAgentMessage").mockResolvedValue({ expectedLaunchId: input.identity.launchId, sessionId: "newer-session" });
    const sent: unknown[] = [];
    vi.spyOn(orch as any, "sendAgentDeliveryWithAckRetry").mockImplementation(async (_machineId: unknown, msg: unknown) => { sent.push(msg); return true; });
    const mentionDelivery = { ...input.identity, occurrenceId: input.occurrenceId, messageId: input.messageId };
    await orch.handleMachineMessage(input.identity.machineId, { type: "agent:delivery:transition", agentId: input.agentId, stage: "daemon_received", outcome: "accepted", mentionDelivery });
    assert.equal(sent.length, 0, "a stage drift alone sends nothing: the daemon may still deliver it");

    if (!driftAtRefusal) validate.mockResolvedValue({ expectedLaunchId: input.identity.launchId, sessionId: input.identity.sessionId });
    const refusal = { type: "agent:delivery:terminal_error" as const, agentId: input.agentId, code: "UNSUPPORTED_DELIVERY_PATH" as const, mentionDelivery };
    await orch.handleMachineMessage(input.identity.machineId, refusal);
    assert.equal(sent.length, 1);
    const delivery = sent[0] as { type: string; message: { message_id: string }; mentionDelivery?: unknown };
    assert.equal(delivery.type, "agent:deliver");
    assert.equal(delivery.message.message_id, input.messageId);
    assert.equal(delivery.mentionDelivery, undefined);
    const row = await getMentionDeliveryOccurrence(input.messageId, input.agentId);
    assert.ok(row);
    assert.equal(row.terminalErrorCode, "IDENTITY_DRIFT");
    assert.deepEqual(row.terminalDecision, { layer: "server", stage: "terminal_receipt", originalDaemonCode: "UNSUPPORTED_DELIVERY_PATH" });

    await orch.handleMachineMessage(input.identity.machineId, refusal);
    assert.equal(sent.length, 1, "a repeated refusal finds the drift already claimed");
  });
}

test("an ACKed or daemon-terminal occurrence is never claimed by a later refusal", async ({ db }) => {
  void db;
  const input = await seed();
  const orch = new AgentOrchestrator();
  vi.spyOn(orch as any, "validateMachineAgentMessage").mockResolvedValue({ expectedLaunchId: input.identity.launchId, sessionId: input.identity.sessionId });
  const sent: unknown[] = [];
  vi.spyOn(orch as any, "sendAgentDeliveryWithAckRetry").mockImplementation(async (_machineId: unknown, msg: unknown) => { sent.push(msg); return true; });
  const mentionDelivery = { ...input.identity, occurrenceId: input.occurrenceId, messageId: input.messageId };
  await orch.handleMachineMessage(input.identity.machineId, { type: "agent:delivery:terminal_error", agentId: input.agentId, code: "DELIVERY_REJECTED", mentionDelivery });
  assert.equal(sent.length, 1);
  await orch.handleMachineMessage(input.identity.machineId, { type: "agent:delivery:terminal_error", agentId: input.agentId, code: "UNSUPPORTED_DELIVERY_PATH", mentionDelivery });
  assert.equal(sent.length, 1, "only a stage-receipt drift is claimable");
});
