/**
 * RFC 071 part 3 (second slice): the terminal-failure breaker wired into the
 * REAL start path and wake entries. Real DB rows; the real
 * `handleMachineMessage` (app-inbox wake request, outbox frames, `ready`,
 * `agent:status`), `deliverMessageToAgent` (message wake) and `startAgent`
 * paths. Only the machine socket and the inbox-chain source are stubbed.
 *
 * Without Redis the orchestrator's #1119 store and the terminal store are the
 * process-local fallbacks that share one #1119 record, exactly as in a
 * single-replica deployment, so the combined claim is the production code.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import {
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  type MachineToServerMessage,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentChannelReadCursors, agents, machines, serverMembers, servers, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { localTerminalFailureBreakerStore } from "../terminalFailureBreakerRedisStore";
import { localWakeCrashLoopStateStore } from "../replicaRouter";
import { TerminalFailureBreaker, terminalStateFromStored, type TerminalFailureBreakerStore } from "../terminalFailureBreakerStore";
import {
  freshTerminalFailureBreakerState,
  raiseCatchupObligation,
  spawnErrorRetryJitterMs,
  type TerminalFailureBreakerState,
} from "../terminalFailureBreaker";
import { agentWakePauseTransitionsTotal } from "../metrics";
import { AgentOrchestrator, TerminalBreakerStorageUnavailableError } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { createMessage, deliverMessageToAgent } from "./messageService";

afterEach(async () => {
  await closeTestDatabase();
});

type StartMessage = Extract<ServerToMachineMessage, { type: "agent:start" }>;

class CapturingOrchestrator extends AgentOrchestrator {
  readonly sent: ServerToMachineMessage[] = [];
  /** When true, agent:start sends report "not sent" (machine offline). */
  failStartSend = false;
  /** When true, the inbox chain is unavailable (RFC O-1: the batch cannot be built). */
  chainUnavailable = false;

  get starts(): StartMessage[] {
    return this.sent.filter((m): m is StartMessage => m.type === "agent:start");
  }

  wakeOutcomes() {
    return this.sent.filter((m): m is Extract<ServerToMachineMessage, { type: "agent:wake:outcome" }> => m.type === "agent:wake:outcome");
  }

  acks() {
    return this.sent.filter((m) => m.type === "agent:outcome:ack");
  }

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start" && this.failStartSend) return false;
    this.sent.push(msg);
    return true;
  }

  /** Activity writes not yet settled (they are fire-and-forget in production). */
  readonly persisting = new Set<Promise<unknown>>();

  protected override persistActivityEvent(...args: unknown[]): Promise<boolean> {
    const write = (super.persistActivityEvent as (...a: unknown[]) => Promise<boolean>).apply(this, args);
    this.persisting.add(write);
    void write.finally(() => this.persisting.delete(write)).catch(() => {});
    return write;
  }

  /** Let in-flight activity writes finish before teardown closes the test database. */
  async settle(): Promise<void> {
    while (this.persisting.size > 0) await Promise.allSettled([...this.persisting]);
  }

  protected override async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    if (this.chainUnavailable) return { source: "unavailable", reason: "rw_error" };
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) } as channelService.AgentInboxChainSelection;
  }
}

let seedCounter = 0;
async function seed() {
  const tag = `rfc071-${process.pid}-${seedCounter += 1}`;
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${tag}@example.com`,
    name: `Breaker Owner ${tag}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Breaker", slug: tag, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "breaker-mac",
    apiKeyHash: `hash-${tag}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "pi-agent",
    status: "inactive",
    runtime: "kimi-sdk",
    model: "devin/swe-2",
    executionMode: "byoc",
    machineId: machine!.id,
    sessionId: null,
  }).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent! };
}

const D1 = "daemon-instance-1";
const D2 = "daemon-instance-2";

function bindMachine(
  orchestrator: AgentOrchestrator,
  machineId: string,
  serverId: string,
  options: { outcomes: boolean; daemonInstanceId?: string | null },
): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: {},
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.40",
    capabilities: new Set<string>(options.outcomes ? [DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1] : []),
    runtimes: ["kimi-sdk"],
    runtimeVersions: {},
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
    daemonInstanceId: options.daemonInstanceId === undefined ? (options.outcomes ? D1 : null) : options.daemonInstanceId,
  });
}

/** The commit-1 switch is still off on this commit's base; the wiring tests run with acks on. */
function enableAcks(orchestrator: AgentOrchestrator): void {
  (orchestrator as any).runtimeOutcomeAckEnabled = true;
}

function terminalState(agentId: string): TerminalFailureBreakerState {
  return terminalStateFromStored(localTerminalFailureBreakerStore.getTerminalFailureBreakerStateSync(agentId), Date.now()).state;
}

let wakeCounter = 0;
function wakeRequest(agentId: string): Extract<MachineToServerMessage, { type: "agent:wake:request" }> {
  wakeCounter += 1;
  return {
    type: "agent:wake:request",
    agentId,
    wakeRequestId: wakeCounter.toString(16).padStart(32, "0"),
    reason: "app_inbox_notice",
    appId: "system.reminder",
    sourceRef: { kind: "reminder", id: "11111111-1111-4111-8111-111111111111", revision: String(wakeCounter) },
    pendingAppItems: 1,
  };
}

/** A daemon instance's outbox: frames with its own per-agent clientSeq. */
function daemonFrames(agentId: string, daemonInstanceId: string) {
  let seq = 0;
  const next = () => (seq += 1);
  return {
    spawned: (launchId: string, processInstanceId: string): MachineToServerMessage =>
      ({ type: "agent:process_spawned", agentId, daemonInstanceId, processInstanceId, launchId, clientSeq: next() }),
    e1: (launchId: string, fingerprint = "c4722931c8a1f172"): MachineToServerMessage => ({
      type: "agent:runtime:outcome",
      v: 1,
      agentId,
      launchId,
      sessionId: null,
      daemonInstanceId,
      clientSeq: next(),
      observedAtMs: Date.now(),
      outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint, errorClass: "RuntimeError" },
    }),
    exited: (launchId: string, processInstanceId: string): MachineToServerMessage => ({
      type: "agent:process_exited", agentId, daemonInstanceId, processInstanceId, spawnLaunchId: launchId, launchId, clientSeq: next(), code: 1, signal: null,
    }),
    /** E2: a clean turn, optionally echoing the batch it rendered (RFC 071 §6/§7). */
    e2: (launchId: string, echo?: { batchId: string; renderedRows: number }, sessionId: string | null = SESSION): MachineToServerMessage => ({
      type: "agent:runtime:outcome",
      v: 1,
      agentId,
      launchId,
      sessionId,
      daemonInstanceId,
      clientSeq: next(),
      observedAtMs: Date.now(),
      outcome: {
        kind: "turn_completed",
        textEvents: 1,
        toolCalls: 0,
        ...(echo ? { catchupBatchId: echo.batchId, catchupRenderedRows: echo.renderedRows } : {}),
      },
    }),
  };
}

const SESSION = "session-S";

/** Drive one failing automatic launch through the real app-inbox wake entry and the outbox. */
async function failingWake(
  orchestrator: CapturingOrchestrator,
  machineId: string,
  agentId: string,
  frames: ReturnType<typeof daemonFrames>,
  pi: string,
): Promise<string> {
  const before = orchestrator.starts.length;
  await orchestrator.handleMachineMessage(machineId, wakeRequest(agentId));
  assert.equal(orchestrator.starts.length, before + 1, "the wake dispatched an agent:start");
  const launchId = orchestrator.starts.at(-1)!.launchId!;
  await orchestrator.handleMachineMessage(machineId, frames.spawned(launchId, pi));
  await orchestrator.handleMachineMessage(machineId, frames.e1(launchId));
  await orchestrator.handleMachineMessage(machineId, frames.exited(launchId, pi));
  return launchId;
}

test("negative control: a tripped breaker refuses the automatic wake through the real wake entries; a human start still starts", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);

    const first = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    assert.equal(orchestrator.starts[0]!.breakerGeneration, terminalState(agent.id).currentLaunch!.generation, "the claimed start carries its generation");
    assert.equal(orchestrator.starts[0]!.humanStart, undefined, "an automatic start is not a human start");
    assert.equal(terminalState(agent.id).totalCount, 1);
    assert.equal(terminalState(agent.id).state, "closed");
    const second = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    assert.notEqual(first, second);
    assert.equal(terminalState(agent.id).state, "open", "two failures with the same fingerprint open it");
    assert.equal(orchestrator.acks().length, 6, "every frame committed, then acked");
    // RFC 9: shown once as a typed offline activity: until when, why, what retries.
    const shown = (orchestrator as any).agentActivity.get(agent.id);
    assert.equal(shown.detailKind, "terminal_failure_paused");
    assert.equal(shown.activity, "offline");
    assert.match(shown.detail, /^Automatic wake paused until \d{4}-\d\d-\d\dT.*\(compaction_failed\)\. The next message, reminder or manual start after that retries; a manual start lifts it now\.$/);

    // App-inbox / reminder wake (the field loop): refused, no agent:start.
    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore, "no agent:start while paused");
    assert.deepEqual(
      orchestrator.wakeOutcomes().at(-1),
      { type: "agent:wake:outcome", agentId: agent.id, wakeRequestId: wakeCounter.toString(16).padStart(32, "0"), outcome: "refused", reason: "terminal_failure_paused" },
    );

    // A human posts a message: the message wake is refused too, and the message stays unread.
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: second });
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    assert.ok(dm);
    const message = await createMessage(dm.id, "user", owner.id, "are you there?");
    const delivery = await deliverMessageToAgent(orchestrator, message.id, agent.id);
    assert.deepEqual(delivery, { status: "dropped", reason: "wake_suppressed" });
    assert.equal(orchestrator.starts.length, startsBefore, "no agent:start for the message either");
    assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), 0, "read cursor not advanced");
    assert.equal(terminalState(agent.id).catchupObligation?.owedCeilings[dm.id], message.seq, "the refused message is owed (RFC O-6)");

    // A person presses Start: the explicit human start (E3) is dispatched and lifts.
    const human = await orchestrator.startAgent(agent.id, { control: "human_start" });
    assert.equal(human.outcome, "dispatched");
    const start = orchestrator.starts.at(-1)!;
    assert.equal(start.humanStart, true);
    assert.equal(start.takeoverEpoch, 1);
    const lifted = terminalState(agent.id);
    assert.equal(lifted.state, "closed");
    assert.equal(lifted.totalCount, 0);
    assert.equal(lifted.currentLaunch!.launchId, start.launchId);
    assert.deepEqual(lifted.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [[start.launchId, null]], "written before dispatch");
  } finally {
    await orchestrator.shutdown();
  }
});

test("lost evidence: a critical gap marker makes automatic wakes need a person; a human start clears it", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const l1 = orchestrator.starts.at(-1)!.launchId!;
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(l1, "pi-1"));
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:runtime:outcome_gap", agentId: agent.id, daemonInstanceId: D1, gapId: "gap-1", fromSeq: 2, toSeq: 4,
      counts: { e1: 1, turnCompleted: 0, spawned: 0, exited: 1, startOutcome: 0 }, takeoverEpoch: 0,
    });
    assert.deepEqual(orchestrator.acks().at(-1), { type: "agent:outcome:ack", agentId: agent.id, gapId: "gap-1" });
    assert.equal(terminalState(agent.id).needsManual?.reason, "outcome_evidence_lost");

    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore);
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "terminal_failure_needs_manual");
    const shown = (orchestrator as any).agentActivity.get(agent.id);
    assert.equal(shown.detailKind, "terminal_failure_paused");
    assert.equal(shown.detail, "Automatic wake stopped: Runtime outcome reports for this agent were lost. A manual start is needed.");
    assert.doesNotMatch(shown.detail, /retr/i, "needs-manual never says it will retry");

    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    const human = orchestrator.starts.at(-1)!;
    assert.equal(human.humanStart, true);
    assert.equal(human.takeoverEpoch, 1, "the daemon's marker of epoch 0 is covered by this takeover");
    assert.equal(terminalState(agent.id).needsManual, null);
    // The human launch's process is confirmed: the next automatic wake passes again.
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(human.launchId!, "pi-2"));
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
  } finally {
    await orchestrator.shutdown();
  }
});

test("daemon restart: an earlier instance's protected process blocks wakes until that instance's replayed exit arrives on the new connection", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true, daemonInstanceId: D1 });
    enableAcks(orchestrator);
    const old = daemonFrames(agent.id, D1);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const l1 = orchestrator.starts.at(-1)!.launchId!;
    await orchestrator.handleMachineMessage(machine.id, old.spawned(l1, "pi-1"));
    await orchestrator.handleMachineMessage(machine.id, old.e1(l1));
    assert.equal(terminalState(agent.id).totalCount, 1, "engaged: its process entry is protected");

    // The daemon restarts as D2 (its ready omits the agent). The D1 process was never seen to exit.
    await orchestrator.handleMachineMessage(machine.id, {
      type: "ready", daemonInstanceId: D2, capabilities: [DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1], runtimes: ["kimi-sdk"], runningAgents: [], daemonVersion: "1.0.40",
    });
    assert.equal((orchestrator as any).machineConnections.get(machine.id).daemonInstanceId, D2);
    assert.equal(terminalState(agent.id).needsManual?.reason, "daemon_restarted_no_exit");
    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore);
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "terminal_failure_needs_manual");

    // D2 replays D1's queued exit: applied by its D1 identity and acked; the block lifts.
    await orchestrator.handleMachineMessage(machine.id, old.exited(l1, "pi-1"));
    assert.deepEqual(orchestrator.acks().at(-1), { type: "agent:outcome:ack", agentId: agent.id, daemonInstanceId: D1, clientSeq: 3 });
    assert.equal(terminalState(agent.id).needsManual, null);
    assert.deepEqual(terminalState(agent.id).unexited, []);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
    assert.deepEqual(
      terminalState(agent.id).unexited.map((e) => e.daemonInstanceId),
      [D2],
      "the new start's pending entry is on the new instance",
    );
  } finally {
    await orchestrator.shutdown();
  }
});

test("a dispatch that never left the replica rolls the claim back (pending entry removed, guard restored); the next wake is not stuck", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    orchestrator.failStartSend = true;
    await assert.rejects(orchestrator.startAgent(agent.id), /Machine offline/);
    const rolled = terminalState(agent.id);
    assert.equal(rolled.currentLaunch, null, "the claim is undone");
    assert.deepEqual(rolled.unexited, [], "the start provably never left: no pending entry");
    assert.equal((orchestrator as any).agentStateCache.get(agent.id)?.expectedLaunchId ?? null, null, "guard restored");

    orchestrator.failStartSend = false;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
  } finally {
    await orchestrator.shutdown();
  }
});

test("storage unavailable: no start is dispatched, automatic or human; the wake entries report a failure, not a refusal", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const down: TerminalFailureBreakerStore = {
      getTerminalFailureBreakerState: async () => { throw new Error("redis unavailable"); },
      compareAndSetTerminalFailureBreakerState: async () => { throw new Error("redis unavailable"); },
      getWakeCrashLoopState: async () => { throw new Error("redis unavailable"); },
      compareAndSetTerminalAndWakeCrashLoop: async () => { throw new Error("redis unavailable"); },
    };
    (orchestrator as any).terminalFailureBreaker = new TerminalFailureBreaker(down);
    const errors = console.error;
    console.error = () => {};
    try {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "server_error");

      const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
      const message = await createMessage(dm!.id, "user", owner.id, "hello?");
      assert.deepEqual(await deliverMessageToAgent(orchestrator, message.id, agent.id), { status: "dropped", reason: "wake_failed" });

      await assert.rejects(orchestrator.startAgent(agent.id, { control: "human_start" }), TerminalBreakerStorageUnavailableError);
      // Same on a daemon without the capability: whether the record protects the agent cannot be read.
      bindMachine(orchestrator, machine.id, server.id, { outcomes: false });
      await assert.rejects(orchestrator.startAgent(agent.id, { control: "human_start" }), TerminalBreakerStorageUnavailableError);
    } finally {
      console.error = errors;
    }
    assert.equal(orchestrator.starts.length, 0, "nothing dispatched");
  } finally {
    await orchestrator.shutdown();
  }
});

test("dormant switch: with outcome acks off, a capable daemon starts exactly as before (no breaker write, no new start fields)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    (orchestrator as any).runtimeOutcomeAckEnabled = false;
    for (let i = 0; i < 3; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", `wake ${i + 1}`);
    }
    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    for (const start of orchestrator.starts) {
      assert.equal(start.breakerGeneration, undefined);
      assert.equal(start.humanStart, undefined);
    }
    assert.equal(localTerminalFailureBreakerStore.getRawForTest(agent.id), null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("dormant switch: no path touches the terminal breaker store, so a store failure can never refuse a start", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  const touched: string[] = [];
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    (orchestrator as any).runtimeOutcomeAckEnabled = false;
    // Every breaker method fails like an unavailable store, and is recorded.
    (orchestrator as any).terminalFailureBreaker = new Proxy({}, {
      get: (_target, method) => (..._args: unknown[]) => {
        touched.push(String(method));
        return Promise.reject(new Error("terminal breaker store unavailable"));
      },
    });
    for (let i = 0; i < 2; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", `automatic wake ${i + 1}`);
    }
    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    await orchestrator.liftWakeBlockForConfigChange(agent.id, { runtimeValuesChanged: true });
    await (orchestrator as any).liftTerminalBreaker(agent.id, "human_reset");
    await (orchestrator as any).observeTerminalDaemonReady(agent.id, "daemon-instance-x");
    await (orchestrator as any).projectTerminalBlock(agent.id, { includeNeedsManual: true });
    await orchestrator.stopAgent(agent.id, "manual");
    assert.deepEqual(touched, [], "dormant: the breaker store is never consulted or written");
  } finally {
    await orchestrator.shutdown();
  }
});

test("backward compatibility: a daemon without agent:runtime-outcome-v1 starts exactly as before (no breaker write, no new start fields)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: false });
    enableAcks(orchestrator);
    for (let i = 0; i < 3; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", `wake ${i + 1}`);
      const launchId = orchestrator.starts.at(-1)!.launchId;
      // What such a daemon reports for a terminal failure: inactive without exit evidence.
      await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId });
    }
    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    for (const start of orchestrator.starts) {
      assert.equal(start.breakerGeneration, undefined);
      assert.equal(start.takeoverEpoch, undefined);
      assert.equal(start.humanStart, undefined);
    }
    assert.equal(localTerminalFailureBreakerStore.getRawForTest(agent.id), null, "the breaker record was never written");
  } finally {
    await orchestrator.shutdown();
  }
});

test("an E3 human reset lifts an open breaker and its restart is a human start; a reset without E3 does not lift", async ({ db: _db }) => {
  for (const terminalControl of ["human_reset", undefined] as const) {
    const { server, machine, agent } = await seed();
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
      enableAcks(orchestrator);
      const frames = daemonFrames(agent.id, D1);
      await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
      const last = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
      assert.equal(terminalState(agent.id).state, "open");
      await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "active", launchId: last });
      const startsBefore = orchestrator.starts.length;

      await orchestrator.resetAgent(agent.id, "session", terminalControl ? { terminalControl } : {});

      if (terminalControl) {
        assert.equal(terminalState(agent.id).state, "closed", "the reset lifted");
        assert.equal(orchestrator.starts.length, startsBefore + 1, "and restarted");
        assert.equal(orchestrator.starts.at(-1)!.humanStart, true);
      } else {
        assert.equal(terminalState(agent.id).state, "open", "a reset that is not E3 does not lift (RFC 5)");
        assert.equal(orchestrator.starts.length, startsBefore, "its restart is automatic and refused");
      }
    } finally {
      await orchestrator.shutdown();
    }
  }
});

test("an E3 reset that does not restart (stopped agent) still lifts: session reset drops the failing session (RFC 5, E-2)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    await orchestrator.stopAgent(agent.id);
    assert.equal(terminalState(agent.id).state, "open", "a manual stop is not a lift");
    const generation = terminalState(agent.id).generation;
    const startsBefore = orchestrator.starts.length;

    await orchestrator.resetAgent(agent.id, "session", { terminalControl: "human_reset", restartIfStopped: false });

    assert.equal(orchestrator.starts.length, startsBefore, "no restart");
    const lifted = terminalState(agent.id);
    assert.equal(lifted.state, "closed");
    assert.equal(lifted.generation, generation + 1);
    assert.equal(lifted.currentLaunch, null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("manual stop clears a probe in flight (half_open -> open, step unchanged); it is not a lift", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    // Let the backoff pass: the next automatic wake claims the probe.
    const opened = terminalState(agent.id);
    assert.ok(await localTerminalFailureBreakerStore.compareAndSetTerminalFailureBreakerState(
      agent.id,
      localTerminalFailureBreakerStore.getRawForTest(agent.id)!.version,
      { ...opened, blockedUntilMs: Date.now() - 1 },
    ));
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
    assert.equal(terminalState(agent.id).state, "half_open");
    const step = terminalState(agent.id).backoffStep;

    await orchestrator.stopAgent(agent.id);
    const stopped = terminalState(agent.id);
    assert.equal(stopped.state, "open");
    assert.equal(stopped.backoffStep, step);
    assert.equal(stopped.currentLaunch, null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("runtime config change: the terminal breaker lifts only when a runtime value really changed (F3)", async ({ db: _db }) => {
  for (const runtimeValuesChanged of [false, true]) {
    const { server, machine, agent } = await seed();
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
      enableAcks(orchestrator);
      const frames = daemonFrames(agent.id, D1);
      await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
      await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
      assert.equal(terminalState(agent.id).state, "open");
      await orchestrator.liftWakeBlockForConfigChange(agent.id, { runtimeValuesChanged });
      assert.equal(terminalState(agent.id).state, runtimeValuesChanged ? "closed" : "open");
    } finally {
      await orchestrator.shutdown();
    }
  }
});

test("H-13: a failed start's guard rollback restores only its own guard (compare-and-restore)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    const internals = orchestrator as any;
    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const winner = internals.agentStateCache.get(agent.id).expectedLaunchId as string;
    // A loser that snapshotted before the winner armed rolls back with its own launchId: no-op.
    internals.rollbackStartLaunchGuard(agent.id, { expectedLaunchId: "stale", launchGuardMode: "guarded" }, "loser-launch");
    assert.equal(internals.agentStateCache.get(agent.id).expectedLaunchId, winner, "the winner's guard survives");
    // The owner's own rollback restores.
    internals.rollbackStartLaunchGuard(agent.id, { expectedLaunchId: "previous", launchGuardMode: "guarded" }, winner);
    assert.equal(internals.agentStateCache.get(agent.id).expectedLaunchId, "previous");
  } finally {
    await orchestrator.shutdown();
  }
});

// --- RFC 071 §6: owed messages carried batch by batch (the start path wiring) ---

/** Open the breaker (two same-fingerprint failures), then refuse `count` DM messages as wakes. */
async function openWithRefusedMessages(
  orchestrator: CapturingOrchestrator,
  ids: Awaited<ReturnType<typeof seed>>,
  frames: ReturnType<typeof daemonFrames>,
  count: number,
) {
  const { owner, server, machine, agent } = ids;
  await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
  const second = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
  assert.equal(terminalState(agent.id).state, "open");
  await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: second });
  const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  const owed = [];
  for (let i = 1; i <= count; i += 1) {
    const message = await createMessage(dm.id, "user", owner.id, `owed ${i}`);
    assert.deepEqual(await deliverMessageToAgent(orchestrator, message.id, agent.id), { status: "dropped", reason: "wake_suppressed" });
    owed.push(message);
  }
  // From here the agent has a session the clean turns bind to (RFC 4.2 rule 4).
  await getDb().update(agents).set({ sessionId: SESSION }).where(eq(agents.id, agent.id));
  return { dm, owed };
}

async function setReadCursor(agentId: string, channelId: string, lastReadSeq: number) {
  await getDb().insert(agentChannelReadCursors).values({ agentId, channelId, lastReadSeq })
    .onConflictDoUpdate({ target: [agentChannelReadCursors.agentId, agentChannelReadCursors.channelId], set: { lastReadSeq } });
}

const ids = (messages: Array<{ message_id?: string }> | undefined) => (messages ?? []).map((m) => m.message_id);

test("O-10/O-6 the lift start carries batch B (m1, m2 in order, once each); only B's echo fulfils, not active or an echo-less E2; no read cursor moves", async ({ db: _db }) => {
  const seeded = await seed();
  const { machine, agent, server } = seeded;
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    const { dm, owed: [m1, m2] } = await openWithRefusedMessages(orchestrator, seeded, frames, 2);
    assert.deepEqual(terminalState(agent.id).catchupObligation?.owedCeilings, { [dm.id]: m2!.seq }, "O-6: the ceiling is the last refused seq");

    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    const start = orchestrator.starts.at(-1)!;
    assert.ok(start.catchupBatchId, "the lift start carries the batch id (RFC 7)");
    assert.deepEqual(ids(start.resumeMessages), [m1!.id, m2!.id], "m1 before m2, each exactly once");
    const pending = terminalState(agent.id).catchupObligation!.pendingBatch!;
    assert.equal(pending.batchId, start.catchupBatchId);
    assert.equal(pending.launchId, start.launchId);
    assert.deepEqual(pending.coverage, [{ conversationId: dm.id, fromSeqExclusive: 0, coveredUpToSeq: m2!.seq, truncated: false }]);
    assert.deepEqual(pending.messages.map((m) => [m.id, m.inPrefix]), [[m1!.id, true], [m2!.id, true]]);

    const launch = start.launchId!;
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(launch, "pi-3"));
    const before = structuredClone(terminalState(agent.id).catchupObligation);
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "active", launchId: launch });
    assert.deepEqual(terminalState(agent.id).catchupObligation, before, "agent:status active fulfils nothing");
    await orchestrator.handleMachineMessage(machine.id, frames.e2(launch));
    assert.equal(terminalState(agent.id).currentLaunch?.lastAppliedSeq?.clientSeq, 8, "the echo-less E2 applied");
    assert.deepEqual(terminalState(agent.id).catchupObligation, before, "a clean turn without the echo fulfils nothing");
    await orchestrator.handleMachineMessage(machine.id, frames.e2(launch, { batchId: start.catchupBatchId!, renderedRows: 2 }));
    assert.equal(terminalState(agent.id).catchupObligation, null, "B's echo fulfils the obligation");
    assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), 0, "no breaker step writes a read cursor");
  } finally {
    await orchestrator.shutdown();
  }
});

test("O-1 a batch that could not be built carries no id; a clean turn fulfils nothing; the next start's batch has m1, m2", async ({ db: _db }) => {
  const seeded = await seed();
  const { machine, agent, server } = seeded;
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    const { owed: [m1, m2] } = await openWithRefusedMessages(orchestrator, seeded, frames, 2);

    orchestrator.chainUnavailable = true;
    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const start = orchestrator.starts.at(-1)!;
    assert.equal(start.resumeMessages, undefined);
    assert.equal(start.catchupBatchId, undefined, "no batch, no id");
    const before = structuredClone(terminalState(agent.id).catchupObligation);
    assert.equal(before?.pendingBatch, null);
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(start.launchId!, "pi-3"));
    await orchestrator.handleMachineMessage(machine.id, frames.e2(start.launchId!));
    assert.deepEqual(terminalState(agent.id).catchupObligation, before, "E2 without an echoed batch fulfils nothing");

    orchestrator.chainUnavailable = false;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const next = orchestrator.starts.at(-1)!;
    assert.notEqual(next.launchId, start.launchId);
    assert.ok(next.catchupBatchId);
    assert.deepEqual(ids(next.resumeMessages), [m1!.id, m2!.id]);
  } finally {
    await orchestrator.shutdown();
  }
});

test("O-3 a failed lift dispatch leaves the owed ceilings and cursors; the next start carries m1", async ({ db: _db }) => {
  const seeded = await seed();
  const { machine, agent, server } = seeded;
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    const { owed: [m1] } = await openWithRefusedMessages(orchestrator, seeded, frames, 1);
    const before = terminalState(agent.id).catchupObligation!;
    orchestrator.failStartSend = true;
    await assert.rejects(orchestrator.startAgent(agent.id, { control: "human_start" }), /Machine offline/);
    const after = terminalState(agent.id).catchupObligation!;
    assert.deepEqual(after.owedCeilings, before.owedCeilings);
    assert.deepEqual(after.obligationCursor, before.obligationCursor);
    orchestrator.failStartSend = false;
    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const start = orchestrator.starts.at(-1)!;
    assert.ok(start.catchupBatchId);
    assert.deepEqual(ids(start.resumeMessages), [m1!.id]);
  } finally {
    await orchestrator.shutdown();
  }
});

test("O-8/O-13/O-16 a folded wake beyond the 5-row cut is out of prefix; the echo covers only the prefix; the next batch starts at max(read cursor, obligation cursor)", async ({ db: _db }) => {
  const seeded = await seed();
  const { owner, machine, agent, server } = seeded;
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    const { dm, owed } = await openWithRefusedMessages(orchestrator, seeded, frames, 7);
    const seqOf = (i: number) => owed[i - 1]!.seq;

    // The lift: its batch is cut at 5 rows; its launch ends without a clean turn (nothing fulfilled).
    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const lift = orchestrator.starts.at(-1)!;
    assert.deepEqual(ids(lift.resumeMessages), owed.slice(0, 5).map((m) => m.id));
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(lift.launchId!, "pi-3"));
    await orchestrator.handleMachineMessage(machine.id, frames.exited(lift.launchId!, "pi-3"));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: lift.launchId });

    // m8 arrives while closed: its message wake starts the agent, and the catch-up replaces the wake (O-8).
    const m8 = await createMessage(dm.id, "user", owner.id, "new 8");
    assert.equal((await deliverMessageToAgent(orchestrator, m8.id, agent.id)).status, "queued");
    const wake = orchestrator.starts.at(-1)!;
    assert.notEqual(wake.launchId, lift.launchId);
    assert.equal(wake.wakeMessage, undefined, "the wake message is folded into the batch");
    assert.deepEqual(ids(wake.resumeMessages), [...owed.slice(0, 5).map((m) => m.id), m8.id], "m1-m5, then m8 appended");
    const batch = terminalState(agent.id).catchupObligation!.pendingBatch!;
    assert.equal(batch.batchId, wake.catchupBatchId);
    assert.deepEqual(batch.coverage, [{ conversationId: dm.id, fromSeqExclusive: 0, coveredUpToSeq: seqOf(5), truncated: true }], "O-13: the contiguous prefix only");
    assert.deepEqual(batch.messages.at(-1), { id: m8.id, conversationId: dm.id, seq: m8.seq, inPrefix: false });

    await orchestrator.handleMachineMessage(machine.id, frames.spawned(wake.launchId!, "pi-4"));
    await orchestrator.handleMachineMessage(machine.id, frames.e2(wake.launchId!, { batchId: wake.catchupBatchId!, renderedRows: 6 }));
    const echoed = terminalState(agent.id).catchupObligation!;
    assert.deepEqual(echoed.obligationCursor, { [dm.id]: seqOf(5) }, "not m8's seq: m6, m7 stay owed");
    assert.equal(echoed.owedCeilings[dm.id], seqOf(7));
    await orchestrator.handleMachineMessage(machine.id, frames.exited(wake.launchId!, "pi-4"));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: wake.launchId });

    // The next batch starts above the echoed prefix (obligation cursor s5 > read cursor 0); its launch fails.
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const above = orchestrator.starts.at(-1)!;
    assert.deepEqual(ids(above.resumeMessages), [owed[5]!.id, owed[6]!.id, m8.id], "m6, m7, m8: m1-m5 are not re-fed");
    assert.equal(terminalState(agent.id).catchupObligation!.pendingBatch!.coverage[0]!.fromSeqExclusive, seqOf(5));
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(above.launchId!, "pi-5"));
    await orchestrator.handleMachineMessage(machine.id, frames.exited(above.launchId!, "pi-5"));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: above.launchId });

    // O-16: the agent pulled m6 (cursor s6) before the next batch: it starts at max(s6, s5) = s6.
    await setReadCursor(agent.id, dm.id, seqOf(6));
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const next = orchestrator.starts.at(-1)!;
    assert.deepEqual(ids(next.resumeMessages), [owed[6]!.id, m8.id], "m7, then the not-owed m8; m6 is not re-fed");
    const nextBatch = terminalState(agent.id).catchupObligation!.pendingBatch!;
    assert.equal(nextBatch.coverage[0]!.fromSeqExclusive, seqOf(6));
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(next.launchId!, "pi-6"));
    await orchestrator.handleMachineMessage(machine.id, frames.e2(next.launchId!, { batchId: next.catchupBatchId!, renderedRows: 2 }));
    assert.equal(terminalState(agent.id).catchupObligation, null, "fulfilled; the cursor never lowered the obligation cursor");
    assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), seqOf(6), "the breaker never moved the read cursor");
  } finally {
    await orchestrator.shutdown();
  }
});

test("opening E1 owes each unread conversation up to its latest unread seq (not the overflow fallback)", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    const unread = await createMessage(dm!.id, "user", owner.id, "unread before the opening failure");
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    const obligation = terminalState(agent.id).catchupObligation!;
    assert.equal(terminalState(agent.id).state, "open");
    assert.equal(obligation.owedOverflow, false);
    assert.deepEqual(obligation.owedCeilings, { [dm!.id]: unread.seq });
  } finally {
    await orchestrator.shutdown();
  }
});

test("dormant switch (RFC 071 §6): with outcome acks off, an open record with an obligation changes no start: no batch id, today's catch-up, record untouched", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    (orchestrator as any).runtimeOutcomeAckEnabled = false;
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    const rows = [];
    for (let i = 1; i <= 7; i += 1) rows.push(await createMessage(dm!.id, "user", owner.id, `row ${i}`));
    // A record as an acking server would have left it: open, every row owed, part already echoed.
    const record = freshTerminalFailureBreakerState();
    record.state = "open";
    record.blockedUntilMs = Date.now() + 3_600_000;
    record.catchupObligation = { ...raiseCatchupObligation(null, { [dm!.id]: rows[6]!.seq }), obligationCursor: { [dm!.id]: rows[2]!.seq } };
    assert.equal(await localTerminalFailureBreakerStore.compareAndSetTerminalFailureBreakerState(agent.id, 0, record), true);
    const raw = localTerminalFailureBreakerStore.getRawForTest(agent.id);

    // No session, no #1221 debt (#proj-runtime:#80): ordinary read-cursor
    // catch-up (rows 1-5), not from the obligation cursor (row 4), and no
    // obligation batch id.
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", "the open record does not gate");
    const sessionless = orchestrator.starts.at(-1)!;
    assert.deepEqual(ids(sessionless.resumeMessages), rows.slice(0, 5).map((m) => m.id));
    assert.equal(sessionless.catchupBatchId, undefined);
    assert.equal(sessionless.breakerGeneration, undefined);

    // With a session: today's catch-up from the read cursor (rows 1-5), not from the obligation cursor (row 4).
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: sessionless.launchId });
    await getDb().update(agents).set({ sessionId: SESSION }).where(eq(agents.id, agent.id));
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const resumed = orchestrator.starts.at(-1)!;
    assert.deepEqual(ids(resumed.resumeMessages), rows.slice(0, 5).map((m) => m.id));
    assert.equal(resumed.catchupBatchId, undefined);
    assert.equal(resumed.breakerGeneration, undefined);

    // A message wake keeps its wake message (no fold).
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: resumed.launchId });
    const live = await createMessage(dm!.id, "user", owner.id, "live");
    assert.equal((await deliverMessageToAgent(orchestrator, live.id, agent.id)).status, "queued");
    const woken = orchestrator.starts.at(-1)!;
    assert.equal(woken.wakeMessage?.message_id, live.id);
    assert.equal(woken.resumeMessages, undefined);
    assert.equal(woken.catchupBatchId, undefined);

    assert.deepEqual(localTerminalFailureBreakerStore.getRawForTest(agent.id), raw, "the record is byte-identical");
  } finally {
    await orchestrator.shutdown();
  }
});

test("RFC 6 read cursor: every owed conversation's cursor passed its ceiling ⇒ the next start's build settles the obligation (null) and carries no batch id", async ({ db: _db }) => {
  const seeded = await seed();
  const { machine, agent, server } = seeded;
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    const { dm, owed } = await openWithRefusedMessages(orchestrator, seeded, frames, 2);
    // The agent pulled both rows (handed to a tool call): consumed by the inbox's own rule.
    await setReadCursor(agent.id, dm.id, owed[1]!.seq);
    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const start = orchestrator.starts.at(-1)!;
    assert.equal(start.resumeMessages, undefined, "nothing left to feed");
    assert.equal(start.catchupBatchId, undefined, "no batch, no id");
    assert.equal(terminalState(agent.id).catchupObligation, null, "settled by the read cursor at build time, without an echo");
    assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), owed[1]!.seq, "the breaker never moves the cursor");
  } finally {
    await orchestrator.shutdown();
  }
});

test("RFC 6 read cursor, mixed: only the conversation whose cursor passed its ceiling settles (recorded as settled-by-cursor); the other keeps the echo rule", async ({ db: _db }) => {
  const seeded = await seed();
  const { machine, agent, server } = seeded;
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    const { dm: passed, owed: [p1] } = await openWithRefusedMessages(orchestrator, seeded, frames, 1);
    const db = getDb();
    const [other] = await db.insert(users).values({ email: `other-${agent.id}@example.com`, name: "Other", passwordHash: "hash", emailVerified: true }).returning();
    await db.insert(serverMembers).values({ serverId: server.id, userId: other!.id, role: "member" });
    const stillOwed = await channelService.findOrCreateDM(server.id, other!.id, agent.id);
    const q1 = await createMessage(stillOwed!.id, "user", other!.id, "still owed");
    assert.deepEqual(await deliverMessageToAgent(orchestrator, q1.id, agent.id), { status: "dropped", reason: "wake_suppressed" });
    await setReadCursor(agent.id, passed.id, p1!.seq);

    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const start = orchestrator.starts.at(-1)!;
    assert.ok(start.catchupBatchId);
    assert.deepEqual(ids(start.resumeMessages), [q1.id]);
    const obligation = terminalState(agent.id).catchupObligation!;
    assert.equal(obligation.obligationCursor[passed.id], p1!.seq, "the passed conversation is settled");
    assert.equal(obligation.obligationCursor[stillOwed!.id], undefined, "the other is not settled before its echo");
    const batch = obligation.pendingBatch!;
    assert.deepEqual(batch.settledByCursor, [{ conversationId: passed.id, readCursor: p1!.seq, ceiling: p1!.seq }]);
    assert.deepEqual(batch.coverage.map((c) => c.conversationId), [stillOwed!.id], "settled-by-cursor is not rendered coverage");

    await orchestrator.handleMachineMessage(machine.id, frames.spawned(start.launchId!, "pi-3"));
    await orchestrator.handleMachineMessage(machine.id, frames.e2(start.launchId!));
    assert.notEqual(terminalState(agent.id).catchupObligation, null, "no echo: still owed");
    await orchestrator.handleMachineMessage(machine.id, frames.e2(start.launchId!, { batchId: start.catchupBatchId!, renderedRows: 1 }));
    assert.equal(terminalState(agent.id).catchupObligation, null);
  } finally {
    await orchestrator.shutdown();
  }
});

/** task #365: the daemon's proof that a start never created a process. */
function notSpawnedFrame(agentId: string, daemonInstanceId: string, launchId: string, clientSeq: number): MachineToServerMessage {
  return { type: "agent:start:outcome", agentId, daemonInstanceId, launchId, clientSeq, result: { kind: "not_spawned", reason: "spawn_error" } };
}

async function pauseTransitions(kind: string): Promise<number> {
  const metric = await agentWakePauseTransitionsTotal.get();
  return metric.values.find((v) => v.labels.kind === kind)?.value ?? 0;
}

function setNow(orchestrator: AgentOrchestrator, nowMs: number): void {
  const clock = (orchestrator as any).clock;
  (orchestrator as any).clock = Object.assign(Object.create(Object.getPrototypeOf(clock)), clock, { now: () => nowMs });
}

test("task #365: a proven spawn error pauses wakes with its own backoff; the sweep re-serves the refused wake once, after backoff plus jitter", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    let now = Date.now();
    setNow(orchestrator, now);

    // The reminder wakes the agent; the claimed automatic start carries the connection epoch.
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const first = orchestrator.starts.at(-1)!;
    assert.equal(first.connectionEpochId, `epoch-${machine.id}`);
    // The CLI is not executable: the daemon proves no process was created.
    const countedBefore = await pauseTransitions("spawn_error_counted");
    await orchestrator.handleMachineMessage(machine.id, notSpawnedFrame(agent.id, D1, first.launchId!, 1));
    assert.equal(await pauseTransitions("spawn_error_counted"), countedBefore + 1);
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: first.launchId });
    const opened = terminalState(agent.id);
    assert.equal(opened.state, "open");
    assert.equal(opened.lastFailure?.kind, "spawn_error");
    assert.equal(opened.blockedUntilMs, now + 5 * 60_000);
    assert.equal(opened.totalCount, 0, "not a crash");
    const shown = (orchestrator as any).agentActivity.get(agent.id);
    assert.equal(shown.detailKind, "terminal_failure_paused");
    assert.match(shown.detail, /\(spawn_error\)/);

    // The next reminder is refused; nobody else would retry it.
    now += 60_000;
    setNow(orchestrator, now);
    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore);
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "terminal_failure_paused");
    assert.equal(terminalState(agent.id).wakeDemand?.seq, 2, "the admitted wake and the refused one");

    // Before the backoff (plus this agent's fixed jitter) passes: nothing.
    const jitter = spawnErrorRetryJitterMs(agent.id);
    setNow(orchestrator, opened.blockedUntilMs! + jitter - 1);
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(orchestrator.starts.length, startsBefore);

    // After it: exactly one probe, also on a second sweep (another replica would be refused the same way).
    setNow(orchestrator, opened.blockedUntilMs! + jitter);
    const dispatchedBefore = await pauseTransitions("retry_dispatched");
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(orchestrator.starts.length, startsBefore + 1);
    assert.equal(await pauseTransitions("retry_dispatched"), dispatchedBefore + 1);
    const probe = orchestrator.starts.at(-1)!;
    assert.equal(probe.humanStart, undefined, "the retry is automatic");
    assert.equal(terminalState(agent.id).state, "half_open");
    assert.equal(terminalState(agent.id).wakeDemand?.claimedLaunchId, probe.launchId);
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(orchestrator.starts.length, startsBefore + 1, "one probe at a time");
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #365: the sweep never starts an agent a person stopped", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const now = Date.now();
    setNow(orchestrator, now);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const first = orchestrator.starts.at(-1)!;
    await orchestrator.handleMachineMessage(machine.id, notSpawnedFrame(agent.id, D1, first.launchId!, 1));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: first.launchId });
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(terminalState(agent.id).wakeDemand?.seq, 2);

    // Stop cancels the demand (pure tests), but that breaker write is best
    // effort. Even when it fails, the sweep must not start a stopped agent.
    (orchestrator as any).terminalFailureBreaker.recordManualStop = async () => { throw new Error("breaker store down"); };
    await orchestrator.stopAgent(agent.id);
    assert.equal(terminalState(agent.id).wakeDemand?.seq, 2, "the demand survived the failed write");
    const startsBefore = orchestrator.starts.length;
    setNow(orchestrator, now + 24 * 3_600_000);
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(orchestrator.starts.length, startsBefore);
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #365 dormant (switch off): no sweep, no epoch on agent:start, no breaker access", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.at(-1)!.connectionEpochId, undefined);
    let touched = 0;
    (orchestrator as any).terminalFailureBreaker = new Proxy({}, { get: () => { touched += 1; return async () => { throw new Error("breaker touched while dormant"); }; } });
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(touched, 0);
    assert.equal((orchestrator as any).spawnErrorRetryTimer, null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #365: a single reminder whose start never spawns is re-served by the sweep, with no further message", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const now = Date.now();
    setNow(orchestrator, now);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const first = orchestrator.starts.at(-1)!;
    await orchestrator.handleMachineMessage(machine.id, notSpawnedFrame(agent.id, D1, first.launchId!, 1));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: first.launchId });
    assert.equal(terminalState(agent.id).wakeDemand?.seq, 1, "the admitted reminder is still owed");

    setNow(orchestrator, terminalState(agent.id).blockedUntilMs! + spawnErrorRetryJitterMs(agent.id));
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(orchestrator.starts.length, 2, "re-served once, without a second reminder");
    assert.equal(terminalState(agent.id).wakeDemand?.claimedLaunchId, orchestrator.starts.at(-1)!.launchId);
  } finally {
    await orchestrator.shutdown();
  }
});

class OwnerRoutingOrchestrator extends CapturingOrchestrator {
  readonly routedIntents: unknown[] = [];
  protected override mayRunOnOwner(_agentId: string): boolean {
    return true;
  }
  protected override async runOnOwner(agentId: string, intent: any): Promise<any> {
    this.routedIntents.push({ agentId, intent });
    return { outcome: "dispatched" };
  }
}

test("task #365: when the machine moves to another replica after the sweep listed it, the retry is skipped here and never forwarded; demand stays for the next sweep", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new OwnerRoutingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const now = Date.now();
    setNow(orchestrator, now);
    // The reminder's own start runs here (its socket is local) through the normal routing.
    (orchestrator as any).mayRunOnOwner = () => false;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    delete (orchestrator as any).mayRunOnOwner;
    const first = orchestrator.starts.at(-1)!;
    await orchestrator.handleMachineMessage(machine.id, notSpawnedFrame(agent.id, D1, first.launchId!, 1));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: first.launchId });
    setNow(orchestrator, terminalState(agent.id).blockedUntilMs! + spawnErrorRetryJitterMs(agent.id));

    // The sweep lists the machine, finds the agent due; then the socket moves away.
    const breaker = (orchestrator as any).terminalFailureBreaker;
    const read = breaker.read.bind(breaker);
    const conn = (orchestrator as any).machineConnections.get(machine.id);
    breaker.read = async (...args: unknown[]) => {
      const state = await read(...args);
      (orchestrator as any).machineConnections.delete(machine.id);
      return state;
    };
    await orchestrator.sweepSpawnErrorRetries();
    breaker.read = read;
    assert.deepEqual(orchestrator.routedIntents, [], "no internal start was handed to any replica");
    assert.equal(orchestrator.starts.length, 1, "no agent:start");
    assert.equal(terminalState(agent.id).wakeDemand?.seq, 1, "the demand is kept");
    assert.equal(terminalState(agent.id).state, "open", "nothing was claimed");

    // The socket returns here on a new connection: the next sweep starts it, stamped with that epoch.
    (orchestrator as any).machineConnections.set(machine.id, { ...conn, connectionEpochId: "epoch-reconnected" });
    await orchestrator.sweepSpawnErrorRetries();
    assert.deepEqual(orchestrator.routedIntents, []);
    assert.equal(orchestrator.starts.length, 2);
    assert.equal(orchestrator.starts.at(-1)!.connectionEpochId, "epoch-reconnected");
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #365: a start the daemon refused as stale (resent after a reconnect) stops retrying, keeps the status, and the wake is re-served once on the current connection", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    // An open local socket, so the dispatch waits for its receipt here.
    Object.assign((orchestrator as any).machineConnections.get(machine.id), { ws: { readyState: 1 }, replicaGeneration: 1 });
    enableAcks(orchestrator);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const first = orchestrator.starts.at(-1)!;
    assert.equal(first.connectionEpochId, `epoch-${machine.id}`);
    assert.ok([...(orchestrator as any).pendingAgentStartAcks.values()].some((p: any) => p.msg.launchId === first.launchId), "waiting for its receipt");

    // The machine reconnects; the server's resend carries the old epoch and the daemon refuses it.
    const conn = (orchestrator as any).machineConnections.get(machine.id);
    (orchestrator as any).machineConnections.set(machine.id, { ...conn, connectionEpochId: "epoch-new" });
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:start:outcome", agentId: agent.id, daemonInstanceId: D1, launchId: first.launchId!, clientSeq: 1,
      result: { kind: "not_spawned", reason: "stale_dispatch" },
    });
    assert.equal([...(orchestrator as any).pendingAgentStartAcks.values()].some((p: any) => p.msg.launchId === first.launchId), false, "no more resends of the refused frame");
    assert.equal(orchestrator.starts.length, 2, "re-served once");
    const again = orchestrator.starts.at(-1)!;
    assert.notEqual(again.launchId, first.launchId);
    assert.equal(again.connectionEpochId, "epoch-new");
    const state = terminalState(agent.id);
    assert.equal(state.spawnError, null, "stale is never counted");
    assert.equal(state.state, "closed");
    assert.equal(state.wakeDemand?.claimedLaunchId, again.launchId);
    const shown = (orchestrator as any).agentActivity.get(agent.id);
    assert.notEqual(shown?.detail, "Start delivery could not reach the Computer");

    // Replaying the same refusal does nothing more.
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:start:outcome", agentId: agent.id, daemonInstanceId: D1, launchId: first.launchId!, clientSeq: 1,
      result: { kind: "not_spawned", reason: "stale_dispatch" },
    });
    assert.equal(orchestrator.starts.length, 2);
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #365: a wake that passed the gate but lost the claim to another replica's probe is kept as demand and re-served when that probe never spawns", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const now = Date.now();
    setNow(orchestrator, now);
    // Open by a spawn error with no demand left (the first start's wake was re-served by nobody yet: settle it away).
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const first = orchestrator.starts.at(-1)!;
    await orchestrator.handleMachineMessage(machine.id, notSpawnedFrame(agent.id, D1, first.launchId!, 1));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: first.launchId });
    const due = terminalState(agent.id).blockedUntilMs!;
    setNow(orchestrator, due);

    // Between this replica's gate and its claim, another replica claims the probe.
    const breaker = (orchestrator as any).terminalFailureBreaker;
    const claimStart = breaker.claimStart.bind(breaker);
    let raced = false;
    breaker.claimStart = async (agentId: string, input: any) => {
      if (!raced) {
        raced = true;
        const other = await claimStart(agentId, { ...input, launchId: "other-replica-probe", wakeDemand: false });
        assert.equal(other.ok, true);
      }
      return claimStart(agentId, input);
    };
    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    breaker.claimStart = claimStart;
    assert.equal(orchestrator.starts.length, startsBefore, "this replica lost the claim");
    const afterLoss = terminalState(agent.id);
    assert.equal(afterLoss.state, "half_open");
    assert.ok(afterLoss.wakeDemand!.seq > (afterLoss.wakeDemand!.claimedSeq ?? 0), "the lost wake is newer than what the probe claimed");

    // The other replica's probe never spawns: the demand is unserved and the sweep re-serves it after the backoff.
    await orchestrator.handleMachineMessage(machine.id, notSpawnedFrame(agent.id, D1, "other-replica-probe", 2));
    const reopened = terminalState(agent.id);
    assert.equal(reopened.state, "open");
    assert.equal(reopened.wakeDemand?.claimedLaunchId, null);
    setNow(orchestrator, reopened.blockedUntilMs! + spawnErrorRetryJitterMs(agent.id));
    await orchestrator.sweepSpawnErrorRetries();
    assert.equal(orchestrator.starts.length, startsBefore + 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #365: a stale refusal of a launch that is no longer current (e.g. a probe whose lease expired) still stops its resends, and re-serves nothing", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const current = orchestrator.starts.at(-1)!;
    // An older dispatch of this agent is still being resent (its launch is no longer the breaker's current one).
    const old = { ...current, launchId: "launch-old", startDispatchId: "dispatch-old", connectionEpochId: "epoch-earlier" };
    (orchestrator as any).trackPendingAgentStart(machine.id, old);
    const pendingFor = (launchId: string) => [...(orchestrator as any).pendingAgentStartAcks.values()].some((p: any) => p.msg.launchId === launchId);
    assert.equal(pendingFor("launch-old"), true);
    assert.notEqual(terminalState(agent.id).currentLaunch?.launchId, "launch-old");

    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:start:outcome", agentId: agent.id, daemonInstanceId: D1, launchId: "launch-old", clientSeq: 1,
      result: { kind: "not_spawned", reason: "stale_dispatch" },
    });
    assert.equal(pendingFor("launch-old"), false, "no more resends of the refused frame");
    assert.equal(orchestrator.starts.length, startsBefore, "nothing re-served");
    assert.equal(terminalState(agent.id).currentLaunch?.launchId, current.launchId, "the current launch is untouched");
  } finally {
    await orchestrator.shutdown();
  }
});

// --- task #365 × #9150: who owns a proven never-created start's failure ---

function wakeState(agentId: string) {
  return localWakeCrashLoopStateStore.getWakeCrashLoopStateSync(agentId)?.state ?? null;
}

function spawnFailureActivity(agentId: string, launchId: string, reason = "runtime_spawn_failed"): MachineToServerMessage {
  return {
    type: "agent:activity", agentId, launchId, isHeartbeat: false, activity: "offline",
    detail: "Start failed", detailKind: "runtime_unavailable", spawnFailure: { reason },
  } as unknown as MachineToServerMessage;
}

function notSpawnedReason(agentId: string, launchId: string, clientSeq: number, reason: string): MachineToServerMessage {
  return { type: "agent:start:outcome", agentId, daemonInstanceId: D1, launchId, clientSeq, result: { kind: "not_spawned", reason } } as MachineToServerMessage;
}

/** Four failed automatic starts in a row (an ACK-capable daemon: activity + outbox `spawn_failed`, not counted by RFC 071). */
async function fourFailedStarts(orchestrator: CapturingOrchestrator, machineId: string, agentId: string, seq: { n: number }) {
  for (let i = 0; i < 4; i += 1) {
    await orchestrator.handleMachineMessage(machineId, wakeRequest(agentId));
    const launchId = orchestrator.starts.at(-1)!.launchId!;
    await orchestrator.handleMachineMessage(machineId, spawnFailureActivity(agentId, launchId));
    await orchestrator.handleMachineMessage(machineId, notSpawnedReason(agentId, launchId, seq.n += 1, "spawn_failed"));
    await orchestrator.handleMachineMessage(machineId, { type: "agent:status", agentId, status: "inactive", launchId });
  }
  assert.equal(wakeState(agentId)?.startFailureCount, 4);
  assert.equal(wakeState(agentId)?.blocked, false);
}

test("task #365 × #9150 premise: while L's outcome is unsettled no automatic start (wake or retry-once) is claimed", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const l = orchestrator.starts.at(-1)!.launchId!;
    // L's start failed; its outcome (outbox) has not arrived.
    await orchestrator.handleMachineMessage(machine.id, spawnFailureActivity(agent.id, l));
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: l });
    const before = orchestrator.starts.length;
    // The #9150 retry start (what its retry-once timer dispatches) is refused by L's pending entry...
    const retry = await orchestrator.startAgent(agent.id, { startCause: "start_failure_retry" });
    assert.deepEqual(retry, { outcome: "skipped", reason: "terminal_failure_needs_manual" });
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, before, "no automatic claim while L is unsettled");
    assert.equal(terminalState(agent.id).currentLaunch?.launchId, l);
  } finally {
    await orchestrator.settle();
    await orchestrator.shutdown();
  }
});

for (const order of ["activity_first", "outbox_first"] as const) {
  test(`task #365 × #9150 (${order}): a proven never-created 5th start is owned by the RFC 071 backoff, never paused by the streak`, async ({ db: _db }) => {
    const { server, machine, agent } = await seed();
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
      enableAcks(orchestrator);
      const seq = { n: 0 };
      await fourFailedStarts(orchestrator, machine.id, agent.id, seq);
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      const l = orchestrator.starts.at(-1)!.launchId!;
      if (order === "activity_first") {
        await orchestrator.handleMachineMessage(machine.id, spawnFailureActivity(agent.id, l));
        assert.equal(wakeState(agent.id)?.blocked, true, "the 5th counted failure paused automatic wakes");
        assert.equal(wakeState(agent.id)?.blockedByLaunchId, l);
        await orchestrator.handleMachineMessage(machine.id, notSpawnedReason(agent.id, l, seq.n += 1, "spawn_error"));
      } else {
        await orchestrator.handleMachineMessage(machine.id, notSpawnedReason(agent.id, l, seq.n += 1, "spawn_error"));
        await orchestrator.handleMachineMessage(machine.id, spawnFailureActivity(agent.id, l));
      }
      const wake = wakeState(agent.id)!;
      assert.equal(wake.blocked, false, "not paused by the streak");
      assert.equal(wake.startFailureCount, 4, "L counted once, by RFC 071 only");
      assert.equal(wake.startFailureOwnedLaunchId, l);
      const terminal = terminalState(agent.id);
      assert.equal(terminal.state, "open", "the bounded spawn-error backoff holds instead");
      assert.equal(terminal.spawnError?.count, 1);
      // A replay of the committed outcome changes nothing.
      await orchestrator.handleMachineMessage(machine.id, notSpawnedReason(agent.id, l, seq.n, "spawn_error"));
      assert.deepEqual(wakeState(agent.id), wake);
    } finally {
      await orchestrator.settle();
      await orchestrator.shutdown();
    }
  });
}

test("task #365 × #9150: a manual stop after the 5th pause stays; the later outcome only opens RFC 071", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const seq = { n: 0 };
    await fourFailedStarts(orchestrator, machine.id, agent.id, seq);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const l = orchestrator.starts.at(-1)!.launchId!;
    await orchestrator.handleMachineMessage(machine.id, spawnFailureActivity(agent.id, l));
    await orchestrator.stopAgent(agent.id);
    const stopped = wakeState(agent.id);
    await orchestrator.handleMachineMessage(machine.id, notSpawnedReason(agent.id, l, seq.n += 1, "spawn_error"));
    assert.deepEqual(wakeState(agent.id), stopped, "the stop's state is untouched");
    assert.equal((orchestrator as any).agentStateCache.get(agent.id)?.status, "stopped");
  } finally {
    await orchestrator.settle();
    await orchestrator.shutdown();
  }
});

for (const order of ["activity_first", "outbox_first"] as const) {
  test(`task #365 × #9150 (${order}): after a human start moved to L2, L's late activity and outcome change nothing for L2`, async ({ db: _db }) => {
    const { server, machine, agent } = await seed();
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
      enableAcks(orchestrator);
      const seq = { n: 0 };
      await fourFailedStarts(orchestrator, machine.id, agent.id, seq);
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      const l = orchestrator.starts.at(-1)!.launchId!;
      (orchestrator as any).releaseWakeLock(agent.id);
      for (const [id, pending] of [...(orchestrator as any).pendingAgentStartAcks.entries()]) {
        if (pending.msg.agentId === agent.id) (orchestrator as any).pendingAgentStartAcks.delete(id);
      }
      assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
      const l2 = orchestrator.starts.at(-1)!.launchId!;
      const afterHuman = { wake: wakeState(agent.id), terminal: terminalState(agent.id) };
      const late = order === "activity_first"
        ? [spawnFailureActivity(agent.id, l), notSpawnedReason(agent.id, l, seq.n += 1, "spawn_error")]
        : [notSpawnedReason(agent.id, l, seq.n += 1, "spawn_error"), spawnFailureActivity(agent.id, l)];
      for (const msg of late) await orchestrator.handleMachineMessage(machine.id, msg);
      const wake = wakeState(agent.id)!;
      assert.equal(wake.lastStartLaunchId, l2);
      assert.equal(wake.startFailureCount ?? 0, afterHuman.wake?.startFailureCount ?? 0);
      assert.equal(wake.blocked, false);
      assert.equal(wake.startFailureOwnedLaunchId ?? null, null, "no ownership for a launch that is not current");
      const terminal = terminalState(agent.id);
      assert.equal(terminal.currentLaunch?.launchId, l2);
      assert.equal(terminal.spawnError, afterHuman.terminal.spawnError, "a stale outcome counts nothing");
      assert.equal(terminal.state, "closed");
    } finally {
      await orchestrator.settle();
      await orchestrator.shutdown();
    }
  });
}

test("task #365 × #9150: ACK off — the streak keeps #9150's rule (the 5th failure pauses)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    for (let i = 0; i < 5; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      const launchId = orchestrator.starts.at(-1)!.launchId!;
      await orchestrator.handleMachineMessage(machine.id, spawnFailureActivity(agent.id, launchId));
      await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId });
    }
    assert.equal(wakeState(agent.id)?.blocked, true);
    assert.equal(wakeState(agent.id)?.startFailureCount, 5);
  } finally {
    await orchestrator.settle();
    await orchestrator.shutdown();
  }
});

