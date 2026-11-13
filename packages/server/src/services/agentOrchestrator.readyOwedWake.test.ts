import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink, type ServerToMachineMessage } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentChannelReadCursors, agents, channelAgents, channelHumans, channels, messageMentions, messages, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import type { AgentInboxChainRow, AgentInboxChainSelection } from "./channelService";
import { createFeatureFlag, READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY } from "./featureFlagService";
import { registerMachine } from "./machineService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

// Reconciler step 13 F9: a daemon `ready` wakes an agent only for what its
// restart lost: a conversation it is offered unread in, past its read position
// (not shown to the model, not read through the CLI, not replied after), where
// it owes something (a DM, an unread @mention, an unread task). Never for any
// unread (Tenny), never for what the agent already read (Otter).

afterEach(async () => {
  await closeTestDatabase();
});

/** Stands in for Redis: one map every orchestrator of a test reads, as every replica reads Redis. */
const readyOwedWakeMarks = new Map<string, number>();

const store = {
  isAvailable: () => true,
  setReadyOwedWakeAt: async (agentId: string, atMs: number) => { readyOwedWakeMarks.set(agentId, atMs); },
  getReadyOwedWakeAt: async (agentId: string) => readyOwedWakeMarks.get(agentId) ?? null,
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

class FakeClock {
  private nowMs = Date.now();
  private nextId = 1;
  private readonly timeouts = new Map<number, { at: number; fn: () => void }>();
  now() { return this.nowMs; }
  scheduleRepeated() { return { id: this.nextId++ }; }
  cancelRepeated() {}
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timeouts.set(id, { at: this.nowMs + ms, fn });
    return { id };
  }
  clearTimeout(handle: unknown) {
    if (handle && typeof handle === "object" && "id" in handle) this.timeouts.delete((handle as { id: number }).id);
  }
  advance(ms: number) {
    const target = this.nowMs + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timeouts) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timeouts.delete(next[0]);
      this.nowMs = next[1].at;
      next[1].fn();
    }
    this.nowMs = target;
  }
}

/** The real orchestrator; only the RisingWave chain read and the socket are stand-ins. */
class ReadyOwedWakeOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];
  readonly chain = new Map<string, AgentInboxChainRow[]>();
  chainUnavailable = false;

  protected override async selectResumeInbox(agentId: string): Promise<AgentInboxChainSelection> {
    if (this.chainUnavailable) return { source: "unavailable", reason: "rw_unconfigured" };
    return { source: "chain", rows: this.chain.get(agentId) ?? [] };
  }

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }

  override sendToLocalMachine(machineId: string, msg: ServerToMachineMessage): boolean {
    void this.sendToMachine(machineId, msg);
    return true;
  }
}

function fakeWs() {
  return { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
}

function chainRow(channel: { id: string; name: string; type: string }, extra: Partial<AgentInboxChainRow>): AgentInboxChainRow {
  return {
    targetId: channel.id, storageChannelId: channel.id, kind: channel.type === "dm" ? "dm" : "channel", serverId: "s",
    channelName: channel.name, channelType: channel.type as AgentInboxChainRow["channelType"],
    parentMessageId: null, parentChannelId: null, parentChannelName: null, parentChannelType: null,
    lastReadSeq: 0, unreadCount: 0, firstUnreadSeq: null, latestSeq: null, mentionUnread: 0, maxMentionSeq: null,
    subscribed: true, offeredUnread: 0, activitySeq: 0, joinedAt: new Date(0),
    ...extra,
  };
}

async function setup(label: string, options: { random?: () => number; agentCount?: number; sessionId?: string | null } = {}) {
  const db = getDb();
  const [user] = await db.insert(users)
    .values({ email: `owed-${label}@slock.test`, name: `owed-${label}`, passwordHash: "hash", emailVerified: true })
    .returning();
  const server = await createServer(`Owed ${label}`, `owed-${label}`, user!.id);
  const { machine } = await registerMachine(server.id, user!.id, `owed-${label}-machine`);
  const agentRows = await db.insert(agents).values(Array.from({ length: options.agentCount ?? 1 }, (_, index) => ({
    serverId: server.id, name: `owed-${label}-${index}`, machineId: machine.id, status: "active" as const,
    sessionId: options.sessionId === undefined ? "session-1" : options.sessionId,
  }))).returning();
  const sink = new MemoryTraceSink();
  const clock = new FakeClock();
  const orchestrator = new ReadyOwedWakeOrchestrator(store, clock, new BasicTracer({ sink }), options.random ?? (() => 0));
  const ws = fakeWs();
  await orchestrator.registerMachine(machine.id, server.id, ws as never);

  const post = async (channelId: string, extra: Partial<typeof messages.$inferInsert> = {}) =>
    (await db.insert(messages).values({ channelId, senderType: "user", senderId: user!.id, content: "hello", ...extra }).returning())[0]!;
  const channel = async (name: string, type: "channel" | "dm", agentId = agentRows[0]!.id) => {
    const [row] = await db.insert(channels).values({ serverId: server.id, name: `${label}-${name}`, type }).returning();
    await db.insert(channelAgents).values({ channelId: row!.id, agentId });
    if (type === "dm") await db.insert(channelHumans).values({ channelId: row!.id, userId: user!.id });
    return row!;
  };
  const mention = (message: typeof messages.$inferSelect, agentId = agentRows[0]!.id) => db.insert(messageMentions).values({
    messageId: message.id, serverId: server.id, channelId: message.channelId, messageSeq: message.seq,
    targetType: "agent", targetId: agentId, handleAtSendTime: "owed",
  });
  const readThrough = (channelId: string, seq: number, agentId = agentRows[0]!.id) =>
    db.insert(agentChannelReadCursors).values({ agentId, channelId, lastReadSeq: seq })
      .onConflictDoUpdate({ target: [agentChannelReadCursors.agentId, agentChannelReadCursors.channelId], set: { lastReadSeq: seq } });
  const events = (name: string) => [...sink.getAllLogEvents(), ...sink.getAllSpans().flatMap((span) => span.events)]
    .filter((event) => event.name === name);
  const ready = (runningAgents: string[] = []) => orchestrator.handleMachineMessage(machine.id, {
    type: "ready", runtimes: [], runningAgents, daemonVersion: "1.0.64", capabilities: [],
  } as never, ws as never);
  /** Lets the pass in flight run to its end: real I/O between fake-clock steps (no step reaches the heartbeat timeout). */
  const drain = async (stepMs = 100) => {
    for (let i = 0; i < 400; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if ((orchestrator as unknown as { readyOwedWakePasses: Map<string, unknown> }).readyOwedWakePasses.size === 0) return;
      clock.advance(stepMs);
    }
    throw new Error("the ready owed wake pass did not finish");
  };
  const row = (channel: Parameters<typeof chainRow>[0], extra: Partial<AgentInboxChainRow>) => chainRow(channel, { serverId: server.id, ...extra });
  /** Another replica sharing the store: the same Computer reconnects to it. */
  const otherReplica = async () => {
    const other = new ReadyOwedWakeOrchestrator(store, clock, new BasicTracer({ sink }), () => 0);
    const otherWs = fakeWs();
    await other.registerMachine(machine.id, server.id, otherWs as never);
    const otherReady = () => other.handleMachineMessage(machine.id, {
      type: "ready", runtimes: [], runningAgents: [], daemonVersion: "1.0.64", capabilities: [],
    } as never, otherWs as never);
    return { other, otherReady };
  };
  const ackStart = (start: Extract<ServerToMachineMessage, { type: "agent:start" }>) => orchestrator.handleMachineMessage(machine.id, {
    type: "agent:start:ack", agentId: start.agentId, startDispatchId: (start as { startDispatchId?: string }).startDispatchId,
    launchId: start.launchId, queueState: "running", queueDepth: 0, queueAgeMs: 0,
  } as never);
  return { otherReplica, ackStart, db, server, machine, agents: agentRows, orchestrator, row, starts: () => orchestrator.starts, clock, post, channel, mention, readThrough, events, ready, drain };
}

test("a DM the daemon acked but the runtime never consumed wakes the agent after ready, once, with its catch-up", async ({ db: _db }) => {
  const t = await setup("debt");
  const agent = t.agents[0]!;
  const dm = await t.channel("dm", "dm");
  const delivered = await t.post(dm.id);
  // Acked by the old daemon, dropped with its process: the read position never moved.
  t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, unreadCount: 1, latestSeq: delivered.seq, firstUnreadSeq: delivered.seq, activitySeq: delivered.seq })]);

  await t.ready();
  await t.drain();

  assert.equal(t.starts().length, 1, "woken once");
  const start = t.starts()[0]!;
  assert.equal(start.agentId, agent.id);
  assert.equal(start.wakeMessage, undefined, "no wake message: the catch-up is what it owes");
  assert.ok(start.unreadSummary && Object.keys(start.unreadSummary).length > 0, "the start carries what is unread");
  assert.equal(t.events("machine.ready.owed_wake.started").length, 1);
  assert.equal(t.events("machine.ready.owed_wake.finished")[0]?.attrs?.started_count, 1);

  // A later ready that reports it running wakes nothing, though the DM is still unread.
  await t.ready([agent.id]);
  await t.drain();
  // (The unacked start itself is re-sent on ready by the pending-start retry: same launch.)
  assert.equal(new Set(t.starts().map((message) => message.launchId)).size, 1, "one launch");
  assert.equal(t.events("machine.ready.owed_wake.started").length, 1);
  await t.orchestrator.shutdown();
});

test("a session-less agent with an unread @mention gets its catch-up", async ({ db: _db }) => {
  const t = await setup("sessionless", { sessionId: null });
  const agent = t.agents[0]!;
  const general = await t.channel("general", "channel");
  await t.post(general.id);
  const mentioned = await t.post(general.id);
  await t.mention(mentioned);
  t.orchestrator.chain.set(agent.id, [t.row(general, {
    offeredUnread: 2, unreadCount: 2, latestSeq: mentioned.seq, firstUnreadSeq: 1, mentionUnread: 1, maxMentionSeq: mentioned.seq, activitySeq: mentioned.seq,
  })]);

  await t.ready();
  await t.drain();

  assert.equal(t.starts().length, 1);
  const start = t.starts()[0]!;
  assert.ok(start.unreadSummary && Object.keys(start.unreadSummary).length > 0, "with no session the start still carries the unread summary");
  assert.ok((start.resumeMessages ?? []).some((message) => message.message_id === mentioned.id), "and the catch-up carries the mention");
  await t.orchestrator.shutdown();
});

test("old unread the agent owes nothing for does not wake it after ready", async ({ db: _db }) => {
  const t = await setup("nothing-owed");
  const agent = t.agents[0]!;
  // Plain channel traffic it never read.
  const busy = await t.channel("busy", "channel");
  let busyLatest = await t.post(busy.id);
  for (let i = 0; i < 4; i += 1) busyLatest = await t.post(busy.id);
  // A muted channel: only a mention would pierce the mute (the view offers none here).
  const muted = await t.channel("muted", "channel");
  const mutedLatest = await t.post(muted.id);
  // A DM it saw before its last turn ended (shown to the model): read position at its latest message.
  const dm = await t.channel("dm", "dm");
  const seen = await t.post(dm.id);
  await t.readThrough(dm.id, seen.seq);
  t.orchestrator.chain.set(agent.id, [
    t.row(busy, { offeredUnread: 5, unreadCount: 5, latestSeq: busyLatest.seq, firstUnreadSeq: 1, activitySeq: busyLatest.seq }),
    t.row(muted, { subscribed: false, offeredUnread: 0, unreadCount: 1, latestSeq: mutedLatest.seq, firstUnreadSeq: 1, activitySeq: mutedLatest.seq }),
    t.row(dm, { lastReadSeq: seen.seq, latestSeq: seen.seq, activitySeq: seen.seq }),
  ]);

  await t.ready();
  await t.drain();

  assert.equal(t.starts().length, 0, "no wake for unread that owes nothing");
  assert.equal(t.events("machine.ready.owed_wake.finished")[0]?.attrs?.owed_count, 0);
  await t.orchestrator.shutdown();
});

test("a DM delivered while the agent was busy and then read by it through the CLI does not wake it after ready", async ({ db: _db }) => {
  const t = await setup("cli-read");
  const agent = t.agents[0]!;
  const dm = await t.channel("dm", "dm");
  const duringTurn = await t.post(dm.id);
  // `raft message check` mid-turn moved the server read position past it.
  await t.readThrough(dm.id, duringTurn.seq);
  // The chain view may lag the read position: it still says unread. Postgres decides.
  t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, unreadCount: 1, latestSeq: duringTurn.seq, firstUnreadSeq: duringTurn.seq, activitySeq: duringTurn.seq })]);

  await t.ready();
  await t.drain();

  assert.equal(t.starts().length, 0, "what the agent already read is never owed");
  await t.orchestrator.shutdown();
});

test("stopped and paused agents with an owed DM are not woken after ready", async ({ db: _db }) => {
  // Stopped before the ready: the reconcile keeps it offline.
  {
    const t = await setup("stopped");
    const agent = t.agents[0]!;
    await t.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agent.id));
    const dm = await t.channel("dm", "dm");
    const owed = await t.post(dm.id);
    t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, latestSeq: owed.seq, activitySeq: owed.seq })]);
    await t.ready();
    await t.drain();
    assert.equal(t.starts().length, 0);
    await t.orchestrator.shutdown();
  }
  // Stopped by hand after the ready, before the pass reaches it: the start's manual-stop gate refuses.
  {
    const t = await setup("stopped-late", { random: () => 0.5 });
    const agent = t.agents[0]!;
    const dm = await t.channel("dm", "dm");
    const owed = await t.post(dm.id);
    t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, latestSeq: owed.seq, activitySeq: owed.seq })]);
    await t.ready();
    await t.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agent.id));
    await t.drain(1_000);
    assert.equal(t.starts().length, 0);
    assert.deepEqual(t.events("machine.ready.owed_wake.suppressed").map((event) => event.attrs?.reason), ["manual_stop"]);
    await t.orchestrator.shutdown();
  }
  // Paused by the wake-crash-loop breaker.
  {
    const t = await setup("paused");
    const agent = t.agents[0]!;
    const dm = await t.channel("dm", "dm");
    const owed = await t.post(dm.id);
    t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, latestSeq: owed.seq, activitySeq: owed.seq })]);
    (t.orchestrator as unknown as { wakeCrashLoopBreaker: { automaticWakeHold: () => Promise<unknown> } })
      .wakeCrashLoopBreaker.automaticWakeHold = async () => ({ kind: "blocked" });
    await t.ready();
    await t.drain();
    assert.equal(t.starts().length, 0);
    assert.deepEqual(t.events("machine.ready.owed_wake.suppressed").map((event) => event.attrs?.reason), ["wake_crash_loop_blocked"]);
    await t.orchestrator.shutdown();
  }
});

test("with the flag off, a ready wakes nothing new", async ({ db: _db }) => {
  {
    const t = await setup("flag-off");
    await createFeatureFlag({ key: READY_WAKE_LOST_DELIVERIES_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
    const agent = t.agents[0]!;
    const dm = await t.channel("dm", "dm");
    const owed = await t.post(dm.id);
    t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, latestSeq: owed.seq, activitySeq: owed.seq })]);
    await t.ready();
    await t.drain();
    assert.equal(t.starts().length, 0);
    assert.deepEqual(t.events("machine.ready.owed_wake.skipped").map((event) => event.attrs?.reason), ["flag_off"]);
    assert.equal(t.events("machine.ready.owed_wake.planned").length, 0, "not one owed read");
    await t.orchestrator.shutdown();
  }
});

test("with the chain unavailable, a ready wakes nothing new", async ({ db: _db }) => {
  {
    const t = await setup("chain-unavailable");
    t.orchestrator.chainUnavailable = true;
    await t.ready();
    await t.drain();
    assert.equal(t.starts().length, 0);
    assert.deepEqual(t.events("machine.ready.owed_wake.suppressed").map((event) => event.attrs?.reason), ["chain_unavailable"]);
    await t.orchestrator.shutdown();
  }
});

test("the pass starts after its random delay, checks at most two agents of a machine at a time, on process-wide slots 100 ms apart", async ({ db: _db }) => {
  const t = await setup("load", { random: () => 0.5, agentCount: 5 });
  const checks: Array<{ agentId: string; at: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gates: Array<() => void> = [];
  (t.orchestrator as unknown as { readReadyOwedTargets: (agentId: string) => Promise<string[]> }).readReadyOwedTargets = async (agentId) => {
    checks.push({ agentId, at: t.clock.now() });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => gates.push(resolve));
    inFlight -= 1;
    return [];
  };
  const startedAt = t.clock.now();
  await t.ready();
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.clock.advance(14_999);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks.length, 0, "nothing before the random delay (0.5 x 30 s)");

  for (let i = 0; i < 80 && checks.length < 5; i += 1) {
    const before: number = checks.length;
    t.clock.advance(100);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(inFlight <= 2, "at most two checks of this machine at a time");
    // Hold the checks until a slot passes with no new one, so any further worker would show.
    if (checks.length === before && inFlight > 0) gates.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  gates.splice(0).forEach((release) => release());
  assert.equal(checks.length, 5);
  assert.equal(maxInFlight, 2);
  assert.ok(checks[0]!.at - startedAt >= 15_000);
  const gaps = checks.slice(1).map((check, index) => check.at - checks[index]!.at);
  assert.ok(gaps.every((gap) => gap >= 100), `checks 100 ms apart across the process: ${gaps.join(",")}`);
  await t.drain();
  await t.orchestrator.shutdown();
});

test("an owed DM older than 24 h does not wake the agent after ready; one within 24 h does", async ({ db: _db }) => {
  {
    const t = await setup("old-dm");
    const agent = t.agents[0]!;
    const dm = await t.channel("dm", "dm");
    const old = await t.post(dm.id, { createdAt: new Date(t.clock.now() - AgentOrchestrator.READY_OWED_WAKE_MAX_AGE_MS - 60_000) });
    t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, unreadCount: 1, latestSeq: old.seq, firstUnreadSeq: old.seq, activitySeq: old.seq })]);
    await t.ready();
    await t.drain();
    assert.equal(t.starts().length, 0, "older backlog stays with the existing paths");
    await t.orchestrator.shutdown();
  }
  {
    const t = await setup("recent-dm");
    const agent = t.agents[0]!;
    const dm = await t.channel("dm", "dm");
    await t.post(dm.id, { createdAt: new Date(t.clock.now() - AgentOrchestrator.READY_OWED_WAKE_MAX_AGE_MS - 60_000) });
    const recent = await t.post(dm.id, { createdAt: new Date(t.clock.now() - AgentOrchestrator.READY_OWED_WAKE_MAX_AGE_MS + 60_000) });
    t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 2, unreadCount: 2, latestSeq: recent.seq, firstUnreadSeq: 1, activitySeq: recent.seq })]);
    await t.ready();
    await t.drain();
    assert.equal(t.starts().length, 1, "a DM within 24 h is owed");
    await t.orchestrator.shutdown();
  }
});

test("the ready wake is one-time: once the woken agent has handled the DM, a later ready does not wake it again", async ({ db: _db }) => {
  const t = await setup("one-time");
  const agent = t.agents[0]!;
  const dm = await t.channel("dm", "dm");
  const owed = await t.post(dm.id);
  t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, unreadCount: 1, latestSeq: owed.seq, firstUnreadSeq: owed.seq, activitySeq: owed.seq })]);

  await t.ready();
  await t.drain();
  assert.equal(t.starts().length, 1, "woken");
  const start = t.starts()[0]!;
  // The daemon takes the start and the agent runs its turn.
  await t.orchestrator.handleMachineMessage(t.machine.id, {
    type: "agent:start:ack", agentId: agent.id, startDispatchId: (start as { startDispatchId?: string }).startDispatchId,
    launchId: start.launchId, queueState: "running", queueDepth: 0, queueAgeMs: 0,
  } as never);
  // The turn handled the DM: the model was shown it (agent:model-seen) and the read position moved past it.
  await t.readThrough(dm.id, owed.seq);
  t.orchestrator.chain.set(agent.id, [t.row(dm, { lastReadSeq: owed.seq, latestSeq: owed.seq, activitySeq: owed.seq })]);

  // The Computer restarts again; the agent is not running on the new daemon.
  await t.ready();
  await t.drain();
  assert.equal(new Set(t.starts().map((message) => message.launchId)).size, 1, "no second wake");
  assert.equal(t.events("machine.ready.owed_wake.started").length, 1);
  const finished = t.events("machine.ready.owed_wake.finished");
  assert.equal(finished.length, 2, "the second ready did check the agent");
  assert.equal(finished[1]?.attrs?.checked_count, 1);
  assert.equal(finished[1]?.attrs?.owed_count, 0);
  await t.orchestrator.shutdown();
});

test("a woken agent that does not read the DM is not woken again for it by a later ready, on this replica or another", async ({ db: _db }) => {
  const t = await setup("no-read");
  const agent = t.agents[0]!;
  const dm = await t.channel("dm", "dm");
  // Created before the wake (the test clock is the orchestrators' "now").
  const owed = await t.post(dm.id, { createdAt: new Date(t.clock.now() - 60_000) });
  const unreadRow = (latest: number) => t.row(dm, { offeredUnread: 1, unreadCount: 1, latestSeq: latest, firstUnreadSeq: owed.seq, activitySeq: latest });
  t.orchestrator.chain.set(agent.id, [unreadRow(owed.seq)]);

  await t.ready();
  await t.drain();
  assert.equal(t.starts().length, 1, "woken");
  assert.equal(readyOwedWakeMarks.has(agent.id), true, "the dispatched wake is marked in the shared store");
  await t.ackStart(t.starts()[0]!);
  // The turn never reads the DM: the read position stays where it was.

  // The Computer restarts and reconnects to the same replica.
  await t.ready();
  await t.drain();
  assert.equal(new Set(t.starts().map((message) => message.launchId)).size, 1, "not woken again on this replica");

  // It restarts again and reconnects to another replica.
  const { other, otherReady } = await t.otherReplica();
  other.chain.set(agent.id, [unreadRow(owed.seq)]);
  await otherReady();
  for (let i = 0; i < 50 && (other as unknown as { readyOwedWakePasses: Map<string, unknown> }).readyOwedWakePasses.size > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.clock.advance(100);
  }
  assert.equal(other.starts.length, 0, "not woken again by another replica either");
  const finished = t.events("machine.ready.owed_wake.finished");
  assert.equal(finished.at(-1)?.attrs?.checked_count, 1, "the other replica did check the agent");

  // A DM that arrives after the wake is owed to the next one.
  const later = await t.post(dm.id, { createdAt: new Date(t.clock.now() + 1_000) });
  t.clock.advance(2_000);
  other.chain.set(agent.id, [unreadRow(later.seq)]);
  await otherReady();
  for (let i = 0; i < 50 && (other as unknown as { readyOwedWakePasses: Map<string, unknown> }).readyOwedWakePasses.size > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.clock.advance(100);
  }
  assert.equal(other.starts.length, 1, "a newer owed message wakes it");
  await other.shutdown();
  await t.orchestrator.shutdown();
});

test("a wake a gate refused leaves no mark, so a later ready can still wake the agent", async ({ db: _db }) => {
  const t = await setup("refused-no-mark");
  const agent = t.agents[0]!;
  const dm = await t.channel("dm", "dm");
  const owed = await t.post(dm.id);
  t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, latestSeq: owed.seq, activitySeq: owed.seq })]);
  const breaker = (t.orchestrator as unknown as { wakeCrashLoopBreaker: { automaticWakeHold: (...args: unknown[]) => Promise<unknown> } }).wakeCrashLoopBreaker;
  const hold = breaker.automaticWakeHold.bind(breaker);
  breaker.automaticWakeHold = async () => ({ kind: "blocked" });

  await t.ready();
  await t.drain();
  assert.equal(t.starts().length, 0, "refused while paused");
  assert.equal(readyOwedWakeMarks.has(agent.id), false, "a refused wake writes no mark");

  breaker.automaticWakeHold = hold;
  await t.ready();
  await t.drain();
  assert.equal(t.starts().length, 1, "once the pause is lifted, the next ready wakes it");
  assert.equal(readyOwedWakeMarks.has(agent.id), true);
  await t.orchestrator.shutdown();
});

test("without a shared wake mark the owed wake is not dispatched", async ({ db: _db }) => {
  const t = await setup("no-mark-store");
  const agent = t.agents[0]!;
  const dm = await t.channel("dm", "dm");
  const owed = await t.post(dm.id);
  t.orchestrator.chain.set(agent.id, [t.row(dm, { offeredUnread: 1, latestSeq: owed.seq, activitySeq: owed.seq })]);
  const shared = (t.orchestrator as unknown as { replicaStateStore: ReplicaStateStore }).replicaStateStore;
  (t.orchestrator as unknown as { replicaStateStore: ReplicaStateStore }).replicaStateStore = {
    ...shared,
    getReadyOwedWakeAt: async () => { throw new Error("redis down"); },
  };
  await t.ready();
  await t.drain();
  assert.equal(t.starts().length, 0);
  assert.deepEqual(t.events("machine.ready.owed_wake.suppressed").map((event) => event.attrs?.reason), ["wake_mark_unavailable"]);
  await t.orchestrator.shutdown();
});
