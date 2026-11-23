/**
 * Focus in the orchestrator: `agentFocus` reaches only a Computer that
 * declared DAEMON_CAPABILITY_AGENT_FOCUS_V1 (start config and
 * `server:features` alike), and a focused conversation's message is tagged on
 * the live delivery path, on a stored payload that is sent again and on the
 * messages of `agent:start`, each time decided anew. Real DB
 * rows (PGlite); only Redis is a stand-in, as in
 * agentOrchestrator.turnEndCompactionGate.test.ts.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  AGENT_FOCUS_FEATURE_FLAG_KEY,
  DAEMON_CAPABILITY_AGENT_FOCUS_V1,
  asChannelId,
  type AgentConfig,
  type AgentMessage,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentFocusTargets, agents, featureFlagRules, messageMentions, users } from "../db/schema";
import { __clearAutoFocusTriesForTests } from "./agentFocusAuto";
import { __clearFocusSetCacheForTests } from "./agentFocusDelivery";
import { focus, unfocus } from "./agentFocusService";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createAgent } from "./agentService";
import * as channelService from "./channelService";
import { addAgent, createChannel, getOrCreateThreadForChannel } from "./channelService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { registerMachine } from "./machineService";
import {
  ensureMentionDeliveryOccurrences,
  getMentionDeliveryOccurrence,
  recordMentionDeliveryDaemonTransition,
  recordMentionDeliveryServerDecision,
} from "./mentionDeliveryOccurrenceService";
import { createMessage } from "./messageService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

afterEach(async () => {
  __clearFocusSetCacheForTests();
  __clearAutoFocusTriesForTests();
  await closeTestDatabase();
});

const store = {
  isAvailable: () => false,
  setReadyOwedWakeAt: async () => {},
  getReadyOwedWakeAt: async () => null,
  registerMachineReplica: async () => "generation-1",
  restoreMachineReplicaGeneration: async () => {},
  unregisterMachineReplica: async () => {},
  refreshMachineReplica: async () => "refreshed",
  hasMachineReplica: async () => true,
  getMachineReplicaOwner: async () => "replica-1",
  bumpMachineStatusVersion: async () => 1,
  getMachineStatusVersion: async () => 1,
  acquireWakeLock: async () => true,
  releaseWakeLock: async () => {},
  setAgentActivity: async () => {},
  getAgentActivity: async () => null,
  getWakeCrashLoopState: async () => null,
  compareAndSetWakeCrashLoopState: async () => true,
  setAgentRuntimeError: async () => {},
  getAgentRuntimeError: async () => null,
  setAgentContextViewAvailability: async () => {},
  getAgentContextViewAvailability: async () => null,
  clearAgentContextViewAvailability: async () => {},
  setMachineMeta: async () => {},
  getMachineMeta: async () => null,
  clearMachineMeta: async () => {},
} as ReplicaStateStore;

/** Records what would leave for the agent instead of sending it. */
class CapturingOrchestrator extends AgentOrchestrator {
  readonly featureAnswers: Array<Extract<ServerToMachineMessage, { type: "server:features" }>> = [];
  readonly handedOn: AgentMessage[] = [];
  readonly resent: AgentMessage[] = [];
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];
  /** When true the live path runs the real applyDirectDelivery (its inbox and send ends are still recorded). */
  realDirectDelivery = false;
  stubAgent: Record<string, unknown> | null = null;
  capable: boolean | null = null;

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "server:features") this.featureAnswers.push(msg);
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }

  // The durable inbox chain comes from RisingWave in production; read the reference over the same rows.
  protected override async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) } as channelService.AgentInboxChainSelection;
  }

  // The two ends of the live path, after the gates.
  protected override async applyDirectDelivery(...args: Parameters<AgentOrchestrator["applyDirectDelivery"]>) {
    if (this.realDirectDelivery) return super.applyDirectDelivery(...args);
    this.handedOn.push(args[1]);
    return { status: "queued" as const, reason: "replayable_inbox" as const };
  }

  protected override async applyWakeAction(...args: Parameters<AgentOrchestrator["applyWakeAction"]>) {
    this.handedOn.push(args[1]);
    return { status: "queued" as const, reason: "replayable_inbox" as const };
  }

  protected override async enqueueToLocalInboxIfStillActive(...args: Parameters<AgentOrchestrator["enqueueToLocalInboxIfStillActive"]>): Promise<boolean> {
    this.resent.push(args[2]);
    return true;
  }

  protected override async sendAgentDeliveryWithAckRetry(...args: Parameters<AgentOrchestrator["sendAgentDeliveryWithAckRetry"]>): Promise<boolean> {
    this.resent.push(args[1].message);
    return true;
  }

  protected override async getAuthoritativeAgentForDelivery(agentId: string): Promise<any> {
    return this.stubAgent ?? super.getAuthoritativeAgentForDelivery(agentId);
  }

  override async machineAdvertisesCapability(machineId: string, capability: string): Promise<boolean> {
    return this.capable ?? super.machineAdvertisesCapability(machineId, capability);
  }
}

function fakeWs() {
  return { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
}

const ready = (capabilities: string[]) => ({
  type: "ready", runtimes: ["claude"], runningAgents: [], daemonVersion: "1.0.99", capabilities, daemonInstanceId: `inst-${capabilities.length}`,
}) as never;

async function setup(opts: { flag: boolean }) {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [user] = await db.insert(users).values({ email: `focus-${suffix}@slock.test`, name: `focus-${suffix}`, passwordHash: "hash", emailVerified: true }).returning();
  const server = await createServer(`Focus ${suffix}`, `focus-${suffix}`, user!.id);
  if (opts.flag) {
    await db.insert(featureFlagRules).values({ flagKey: AGENT_FOCUS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  }
  const { machine } = await registerMachine(server.id, user!.id, `focus-machine-${suffix}`);
  const created = await createAgent(server.id, `focus-agent-${suffix}`, { runtime: "claude", model: "sonnet" });
  await db.update(agents).set({ machineId: machine.id }).where(eq(agents.id, created.id));
  const orchestrator = new CapturingOrchestrator(store);
  const startConfig = async (): Promise<AgentConfig> => {
    const [row] = await db.select().from(agents).where(eq(agents.id, created.id));
    return (orchestrator as any).buildAgentConfig(row);
  };
  const askFeatures = async (ws: ReturnType<typeof fakeWs>, requestId: string) => {
    await orchestrator.handleMachineMessage(machine.id, { type: "server:features:request", requestId }, ws as never);
    const answers = orchestrator.featureAnswers.filter((answer) => answer.requestId === requestId);
    assert.equal(answers.length, 1, `one answer to ${requestId}`);
    return answers[0]!.features;
  };
  const connect = async (capabilities: string[]) => {
    const ws = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, ws as never);
    await orchestrator.handleMachineMessage(machine.id, ready(capabilities), ws as never);
    return ws;
  };
  return { user: user!, server, machine, agent: created, orchestrator, startConfig, askFeatures, connect };
}

function payload(channel: { id: string; name: string }, type: AgentMessage["channel_type"], seq: number): AgentMessage {
  return {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: type,
    sender_id: randomUUID(),
    sender_name: "sender",
    sender_type: "human",
    content: "hello",
    timestamp: "2026-11-20T09:00:00.000Z",
    seq,
    message_id: randomUUID(),
  };
}

test("agentFocus is sent only with the flag on and to a connection that declared the capability", async ({ db: _db }) => {
  const { orchestrator, startConfig, askFeatures, connect } = await setup({ flag: true });
  try {
    // Every daemon today: the flag is on, the capability is not declared.
    const old = await connect([]);
    assert.equal("agentFocus" in (await askFeatures(old, "old")), false);
    assert.equal((await startConfig()).agentFocus, undefined);

    const current = await connect([DAEMON_CAPABILITY_AGENT_FOCUS_V1]);
    assert.equal((await askFeatures(current, "current")).agentFocus, true);
    assert.equal((await startConfig()).agentFocus, true);
  } finally {
    await orchestrator.shutdown();
  }

  const off = await setup({ flag: false });
  try {
    const ws = await off.connect([DAEMON_CAPABILITY_AGENT_FOCUS_V1]);
    assert.equal("agentFocus" in (await off.askFeatures(ws, "off")), false);
    assert.equal((await off.startConfig()).agentFocus, undefined);
  } finally {
    await off.orchestrator.shutdown();
  }
});

test("a live delivery in a focused thread is tagged after the gates, as a copy, and only for a capable Computer", async ({ db: _db }) => {
  const { user, server, agent, orchestrator, connect } = await setup({ flag: true });
  try {
    const channel = await createChannel(server.id, `focus-room-${randomUUID().slice(0, 6)}`);
    await addAgent(channel.id, agent.id);
    const root = await createMessage(channel.id, "user", user.id, "thread root");
    const thread = await getOrCreateThreadForChannel(channel.id, root.id, user.id, "user");
    const quiet = await getOrCreateThreadForChannel(channel.id, (await createMessage(channel.id, "user", user.id, "another root")).id, user.id, "user");
    await focus(agent.id, asChannelId(thread.id), "manual");
    const inFocus = payload({ id: thread.id, name: thread.id }, "thread", 10);
    const notInFocus = payload({ id: quiet.id, name: quiet.id }, "thread", 11);

    // Not capable: delivered, untagged.
    await connect([]);
    await orchestrator.deliverMessage(agent.id, inFocus);
    assert.deepEqual(orchestrator.handedOn.map((message) => message.focused), [undefined]);

    await connect([DAEMON_CAPABILITY_AGENT_FOCUS_V1]);
    await orchestrator.deliverMessage(agent.id, inFocus);
    await orchestrator.deliverMessage(agent.id, notInFocus);
    assert.deepEqual(orchestrator.handedOn.map((message) => message.focused), [undefined, true, undefined]);
    assert.equal(inFocus.focused, undefined, "the caller's payload, shared with other recipients, is not changed");

    // A focus row does not open a conversation: an agent that fails the access check gets nothing.
    const outsider = await createAgent(server.id, `focus-outsider-${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
    const privateRoom = await createChannel(server.id, `focus-private-${randomUUID().slice(0, 6)}`, undefined, "private");
    await focus(outsider.id, asChannelId(privateRoom.id), "manual");
    const result = await orchestrator.deliverMessage(outsider.id, payload(privateRoom, "thread", 12));
    assert.deepEqual(result, { status: "dropped", reason: "target_access_changed" });
    assert.equal(orchestrator.handedOn.length, 3);
  } finally {
    await orchestrator.shutdown();
  }
});

/** A mention of the agent in a thread, with its occurrence row as the send path writes it (payload untagged, nothing decided). */
async function seedMention(ctx: Awaited<ReturnType<typeof setup>>, storedTag: boolean) {
  const { user, server, agent } = ctx;
  const channel = await createChannel(server.id, `focus-mention-${randomUUID().slice(0, 6)}`);
  await addAgent(channel.id, agent.id);
  const root = await createMessage(channel.id, "user", user.id, "thread root");
  const thread = await getOrCreateThreadForChannel(channel.id, root.id, user.id, "user");
  const message = await createMessage(thread.id, "user", user.id, `hello @${agent.name}`);
  const [mention] = await getDb().insert(messageMentions).values({
    messageId: message.id, messageSeq: message.seq, serverId: server.id, channelId: thread.id, targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
  }).returning();
  const stored: AgentMessage = { ...payload({ id: thread.id, name: thread.id }, "thread", message.seq), message_id: message.id, ...(storedTag ? { focused: true as const } : {}) };
  await ensureMentionDeliveryOccurrences([{ occurrenceId: mention!.id, messageId: message.id, serverId: server.id, agentId: agent.id, deliveryPayload: stored }]);
  return { thread, message, mention: mention!, stored };
}

const identityOf = (machineId: string) => ({ machineId, launchId: "launch-1", sessionId: "session-1" });

/** The daemon received the mention and holds it: the state an operator redrive starts from. */
async function daemonHolds(agentId: string, mention: { id: string }, messageId: string, identity: ReturnType<typeof identityOf>) {
  await recordMentionDeliveryDaemonTransition({ occurrenceId: mention.id, agentId, messageId, identity, stage: "daemon_received" });
  const pending = await recordMentionDeliveryDaemonTransition({ occurrenceId: mention.id, agentId, messageId, identity, stage: "daemon_pending" });
  assert.ok(pending, "fixture must reach a redrivable state");
  return pending.version;
}

test("an operator redrive decides the tag when it sends: an untagged stored payload goes out tagged, a stored tag that no longer holds is removed", async ({ db: _db }) => {
  const ctx = await setup({ flag: true });
  const { server, machine, agent, orchestrator } = ctx;
  try {
    const identity = identityOf(machine.id);
    orchestrator.stubAgent = { serverId: server.id, machineId: machine.id, expectedLaunchId: identity.launchId, sessionId: identity.sessionId };
    orchestrator.capable = true;

    // Stored before the agent focused the conversation.
    const first = await seedMention(ctx, false);
    await recordMentionDeliveryServerDecision({ occurrenceId: first.mention.id, payload: first.stored, identity });
    const firstVersion = await daemonHolds(agent.id, first.mention, first.message.id, identity);
    await focus(agent.id, asChannelId(first.thread.id), "manual");
    assert.equal((await orchestrator.redriveMentionDelivery(first.message.id, agent.id, firstVersion)).status, "REDRIVE_QUEUED");
    assert.deepEqual(orchestrator.resent.map((sent) => sent.focused), [true, true], "the inbox copy and the sent copy");
    assert.equal(orchestrator.resent[0]!.message_id, first.message.id);
    assert.equal((await getMentionDeliveryOccurrence(first.message.id, agent.id))?.deliveryPayload?.focused, undefined, "the stored row is not changed");

    // A row that carries a tag (written by an older build): never focused now, and then focused but not capable.
    for (const scenario of ["not focused", "not capable"] as const) {
      const old = await seedMention(ctx, true);
      await recordMentionDeliveryServerDecision({ occurrenceId: old.mention.id, payload: old.stored, identity });
      const version = await daemonHolds(agent.id, old.mention, old.message.id, identity);
      if (scenario === "not capable") await focus(agent.id, asChannelId(old.thread.id), "manual");
      orchestrator.capable = scenario !== "not capable";
      orchestrator.resent.length = 0;
      assert.equal((await orchestrator.redriveMentionDelivery(old.message.id, agent.id, version)).status, "REDRIVE_QUEUED");
      assert.deepEqual(orchestrator.resent.map((sent) => "focused" in sent), [false, false], scenario);
    }
  } finally {
    await orchestrator.shutdown();
  }
});

test("a tracked mention on the live path: sent tagged, stored untagged, and sent again untagged after an unfocus", async ({ db: _db }) => {
  const ctx = await setup({ flag: true });
  const { server, machine, agent, orchestrator } = ctx;
  try {
    const identity = identityOf(machine.id);
    const { thread, message, mention, stored } = await seedMention(ctx, false);
    await focus(agent.id, asChannelId(thread.id), "manual");
    // The agent runs a session this replica knows: the tracked path of the real applyDirectDelivery.
    orchestrator.stubAgent = { id: agent.id, status: "active", runtime: "claude", serverId: server.id, machineId: machine.id, expectedLaunchId: identity.launchId, sessionId: identity.sessionId };
    (orchestrator as unknown as { agentStateCache: Map<string, unknown> }).agentStateCache.set(agent.id, orchestrator.stubAgent);
    orchestrator.capable = true;
    orchestrator.realDirectDelivery = true;

    const result = await orchestrator.deliverMessage(agent.id, stored, { mentionDeliveryOccurrenceId: mention.id });
    assert.equal(result.status, "queued", JSON.stringify(result));
    assert.ok(orchestrator.resent.length >= 1);
    assert.deepEqual([...new Set(orchestrator.resent.map((sent) => sent.focused))], [true], "what leaves is tagged");
    const row = await getMentionDeliveryOccurrence(message.id, agent.id);
    assert.equal(row?.state, "server_decided", "the tracked path recorded its decision");
    assert.equal(row?.deliveryPayload?.message_id, message.id);
    assert.equal("focused" in (row?.deliveryPayload ?? {}), false, "the stored payload carries no tag");

    const version = await daemonHolds(agent.id, mention, message.id, identity);
    await unfocus(agent.id, asChannelId(thread.id));
    orchestrator.resent.length = 0;
    assert.equal((await orchestrator.redriveMentionDelivery(message.id, agent.id, version)).status, "REDRIVE_QUEUED");
    assert.deepEqual(orchestrator.resent.map((sent) => "focused" in sent), [false, false]);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a mention in a thread on the live path focuses it: the mention leaves tagged with focus_change, once, and only for a capable Computer", async ({ db: _db }) => {
  const { user, server, agent, orchestrator, connect } = await setup({ flag: true });
  try {
    const channel = await createChannel(server.id, `focus-auto-${randomUUID().slice(0, 6)}`);
    await addAgent(channel.id, agent.id);
    const root = await createMessage(channel.id, "user", user.id, "thread root");
    const thread = await getOrCreateThreadForChannel(channel.id, root.id, user.id, "user");
    const mention = (seq: number): AgentMessage => ({ ...payload({ id: thread.id, name: thread.id }, "thread", seq), mentioned: true });
    const focusRows = () => getDb().select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agent.id));

    // Not capable: delivered as before, nothing focused.
    await connect([]);
    await orchestrator.deliverMessage(agent.id, mention(10));
    assert.deepEqual(orchestrator.handedOn.map((message) => [message.focused, message.focus_change]), [[undefined, undefined]]);
    assert.deepEqual(await focusRows(), []);

    // An intrinsic delivery skips the access check, so it focuses nothing either.
    await connect([DAEMON_CAPABILITY_AGENT_FOCUS_V1]);
    await orchestrator.deliverMessage(agent.id, mention(11), { intrinsic: true });
    assert.deepEqual(await focusRows(), []);

    __clearAutoFocusTriesForTests();
    const first = mention(12);
    await orchestrator.deliverMessage(agent.id, first);
    await orchestrator.deliverMessage(agent.id, mention(13));
    const [, , told, later] = orchestrator.handedOn;
    assert.equal(told!.focused, true, "the triggering delivery itself is tagged");
    assert.deepEqual(told!.focus_change, { reason: "mentioned", focused: [`#${channel.name}:${root.id.slice(0, 8)}`], unfocused: [] });
    assert.equal(later!.focused, true);
    assert.equal(later!.focus_change, undefined, "said once");
    assert.equal(first.focus_change, undefined, "the caller's payload is not changed");
    assert.deepEqual((await focusRows()).map((row) => [row.channelId, row.source]), [[thread.id, "auto"]]);

    // A mention in the plain channel focuses nothing.
    await orchestrator.deliverMessage(agent.id, { ...payload(channel, "channel", 14), mentioned: true });
    assert.equal((await focusRows()).length, 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a tracked mention that focuses its thread: sent with focus_change, stored without it, and sent again without it", async ({ db: _db }) => {
  const ctx = await setup({ flag: true });
  const { server, machine, agent, orchestrator } = ctx;
  try {
    const identity = identityOf(machine.id);
    const { message, mention, stored } = await seedMention(ctx, false);
    orchestrator.stubAgent = { id: agent.id, status: "active", runtime: "claude", serverId: server.id, machineId: machine.id, expectedLaunchId: identity.launchId, sessionId: identity.sessionId };
    (orchestrator as unknown as { agentStateCache: Map<string, unknown> }).agentStateCache.set(agent.id, orchestrator.stubAgent);
    orchestrator.capable = true;
    orchestrator.realDirectDelivery = true;

    const result = await orchestrator.deliverMessage(agent.id, { ...stored, mentioned: true }, { mentionDeliveryOccurrenceId: mention.id });
    assert.equal(result.status, "queued", JSON.stringify(result));
    assert.ok(orchestrator.resent.length >= 1);
    assert.deepEqual([...new Set(orchestrator.resent.map((sent) => `${sent.focused}/${sent.focus_change?.reason}`))], ["true/mentioned"]);
    const row = await getMentionDeliveryOccurrence(message.id, agent.id);
    assert.equal(row?.state, "server_decided");
    assert.equal("focused" in (row?.deliveryPayload ?? {}), false);
    assert.equal("focus_change" in (row?.deliveryPayload ?? {}), false, "the stored payload tells nothing");

    // The stored payload sent again: tagged (still focused), and it does not say it a second time.
    const version = await daemonHolds(agent.id, mention, message.id, identity);
    orchestrator.resent.length = 0;
    assert.equal((await orchestrator.redriveMentionDelivery(message.id, agent.id, version)).status, "REDRIVE_QUEUED");
    assert.deepEqual(orchestrator.resent.map((sent) => [sent.focused, "focus_change" in sent]), [[true, false], [true, false]]);
  } finally {
    await orchestrator.shutdown();
  }
});

for (const capable of [true, false]) {
  test(`agent:start: the catch-up and wake messages of a focused DM go out ${capable ? "tagged" : "untagged to a Computer without the capability"}`, async ({ db: _db }) => {
    // One start that carries the unread message as catch-up, one that carries a wake message.
    for (const kind of ["catch-up", "wake"] as const) {
      const { user, server, agent, orchestrator, connect } = await setup({ flag: true });
      try {
        await connect(capable ? [DAEMON_CAPABILITY_AGENT_FOCUS_V1] : []);
        const dm = await channelService.findOrCreateDM(server.id, user.id, agent.id);
        assert.ok(dm);
        await focus(agent.id, asChannelId(dm.id), "manual");
        const unread = await createMessage(dm.id, "user", user.id, "are you there?");
        // A wake message buffered with a tag from before: the start decides it again.
        const wake: AgentMessage = { ...payload({ id: dm.id, name: "dm" }, "dm", unread.seq), message_id: unread.id, focused: true };

        const started = await orchestrator.startAgent(agent.id, kind === "wake" ? { wakeMessage: wake } : {});
        assert.equal(started.outcome, "dispatched", JSON.stringify(started));
        assert.equal(orchestrator.starts.length, 1);
        const start = orchestrator.starts[0]!;
        const carried = kind === "wake" ? [start.wakeMessage] : start.resumeMessages ?? [];
        assert.deepEqual(carried.map((item) => item?.message_id), [unread.id], kind);
        assert.deepEqual(carried.map((item) => item?.focused), [capable ? true : undefined], kind);
        assert.equal(wake.focused, true, "the caller's message is not changed");
      } finally {
        await orchestrator.shutdown();
      }
    }
  });
}
