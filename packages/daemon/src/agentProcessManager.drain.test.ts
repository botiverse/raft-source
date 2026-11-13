// Reconciler step 13 (PR 2) on the legacy host: `beginDrain` holds new
// deliveries, reminders, notices and starts, and resolves once every live
// process is quiet (agentIdle.ts with `ignoreUntoldInbox`) or at the
// deadline; it stops nothing. Control (a Stop, a turn interrupt) is never
// held. `endDrain` hands over what was held, except what the agent already
// read meanwhile.
//
// RED proof: count the untold inbox in drainProgress (drop
// `ignoreUntoldInbox`) and "a delivery during the drain is held" waits until
// its deadline; drop `this.drain.check()` in reconcileProcess and the busy
// test is not quiet at its turn end; drop the drain gate in deliverMessage
// and the held message is written at the turn end; drop the pump hold and the
// new agent spawns during the drain; drop the backgroundTasks clause and the
// background-task test is quiet at once.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.serverFeatures.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { providerLimitCredentialKey } from "./providerLimitLedger";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = { write: (chunk: string) => { this.stdinWrites.push(chunk); return true; } };
  kills = 0;

  constructor(private readonly deferExit: boolean) {
    super();
  }

  get killed(): boolean {
    return this.kills > 0;
  }

  kill(): boolean {
    this.kills += 1;
    if (!this.deferExit) this.exitNow();
    return true;
  }

  /** SIGTERM, as the daemon sends: node reports code 143 with the signal. */
  exitNow(): void {
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
  }
}

interface FakeDriverOptions {
  /** A per-turn runtime (gemini, cursor, copilot, opencode): a process per turn, ended at its end. */
  perTurn?: boolean;
  supportsSubagents?: boolean;
  supportsNativeStandingPrompt?: boolean;
  /** kill() leaves the process running until the test calls exitNow(). */
  deferExit?: boolean;
}

class FakeClaudeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle: RuntimeDriver["lifecycle"];
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt: boolean;
  readonly terminateProcessOnTurnEnd: boolean;
  readonly supportsSubagents: boolean;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  failNextSpawn = false;
  /** Called while the manager is starting the process: it is registered, the start has not committed. */
  onSpawn: ((ctx: SpawnContext) => void) | null = null;

  constructor(private readonly options: FakeDriverOptions = {}) {
    this.terminateProcessOnTurnEnd = options.perTurn === true;
    this.lifecycle = options.perTurn
      ? { kind: "per_turn", start: "immediate", exit: "terminate_on_turn_end", inFlightWake: "spawn_new" }
      : { kind: "persistent", stdin: "direct", inFlightWake: "steer" };
    this.supportsSubagents = options.supportsSubagents === true;
    this.supportsNativeStandingPrompt = options.supportsNativeStandingPrompt ?? true;
  }

  spawn(ctx: SpawnContext): SpawnResult {
    const onSpawn = this.onSpawn;
    this.onSpawn = null;
    onSpawn?.(ctx);
    if (this.failNextSpawn) {
      this.failNextSpawn = false;
      throw new Error("spawn failed (test)");
    }
    this.spawnCalls.push(ctx);
    const child = new FakeChildProcess(this.options.deferExit === true);
    this.processes.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) ?? [];
  }

  encodeStdinMessage(text?: string): string | null {
    return text ? JSON.stringify({ text }) : null;
  }

  /** Claude Code's stream-json interrupt (drivers/claude.ts). */
  encodeInterruptRequest(): string {
    return JSON.stringify({ type: "control_request", request_id: "raft-interrupt-1", request: { subtype: "interrupt" } });
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "claude-agent",
    displayName: "Claude Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    // No credential id: a stop would revoke it over the network.
    agentCredentialId: null,
    ...overrides,
  };
}

type Ctx = { driver: FakeClaudeDriver; manager: AgentProcessManager; events: Array<{ name: string; attrs: Record<string, unknown> }>; sent: MachineToServerMessage[]; homeDir: string };

async function withManager(
  fn: (ctx: Ctx) => Promise<void>,
  driver = new FakeClaudeDriver(),
  extra: {
    runtimeStartScheduler?: { maxConcurrentStarts?: number; minStartIntervalMs?: number };
    slockHome?: string;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    connectedServerId?: () => string | null;
    queuedInputSettleMs?: number;
    onAgentWorkingToIdle?: (agentId: string) => void;
  } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-drain-test-"));
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    { dataDir, serverUrl: "https://daemon.example.com", driverResolver: () => driver, runtimeSessionHomeDir: dataDir, ...extra },
  );
  const events: Ctx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, events, sent, homeDir: dataDir });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A Claude session transcript where the sweep's background gates read it. */
async function writeTranscript(ctx: Ctx, sessionId: string, body = ""): Promise<string> {
  const dir = path.join(ctx.homeDir, ".claude", "projects", "-workspace-agent");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString() })}\n${body}`);
  return file;
}

async function startIdle(ctx: Ctx, agentId: string, config: Partial<AgentConfig>, transcript = true) {
  if (transcript) await writeTranscript(ctx, `session-${agentId}`);
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId: `session-${agentId}`, ...config }));
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = `session-${agentId}`;
  (ctx.manager as any).commitApmIdleState(agentId, ap, true);
  return ap;
}

function restartSnapshot(manager: AgentProcessManager, agentId: string) {
  return (manager as any).lifecycleRecords.getRestartSnapshot(agentId) as { config: AgentConfig; sessionId: string | null } | undefined;
}

function message(seq: number): AgentMessage {
  return {
    seq,
    message_id: `msg-${seq}`,
    channel_id: "channel-general",
    channel_name: "general",
    channel_type: "channel",
    sender_name: "someone",
    sender_type: "human",
    content: `hello ${seq}`,
    timestamp: new Date().toISOString(),
  } as AgentMessage;
}

const featuresStops = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);

/** The runtime ends a turn (a parsed `turn_end` on the agent's live process). */
function emitTurnEnd(ctx: Ctx, agentId: string, child = ctx.driver.processes.at(-1)!): void {
  const line = `turn-end-${agentId}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{ kind: "turn_end", sessionId: `session-${agentId}` }]);
  child.stdout.emit("data", Buffer.from(`${line}\n`));
}

/** The runtime does model work (a parsed `text` on the agent's live process). */
function emitText(ctx: Ctx, agentId: string): void {
  const line = `text-${agentId}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{ kind: "text", text: "working on it" } as ParsedEvent]);
  ctx.driver.processes.at(-1)!.stdout.emit("data", Buffer.from(`${line}\n`));
}

/**
 * A busy agent (its first turn running) told of a message mid-turn: the
 * busy inbox notice is written into the running turn (fired at once here;
 * the daemon waits STDIN_NOTIFICATION_INITIAL_DELAY_MS).
 */
async function startBusyWithNoticeWrittenMidTurn(ctx: Ctx, agentId: string) {
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId: `session-${agentId}`, enabledApps: [] }));
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = `session-${agentId}`;
  ap.sessionReadyForDelivery = true;
  const child = ctx.driver.processes.at(-1)!;
  const writes = child.stdinWrites.length;
  assert.equal(await ctx.manager.deliverMessage(agentId, message(901)), true);
  (ctx.manager as any).sendStdinNotification(agentId);
  assert.equal(child.stdinWrites.length, writes + 1, "precondition: the notice went into the running turn");
  return { ap, child };
}

/** A Claude background task's lifecycle event (task_started / task_notification). */
function emitTask(ctx: Ctx, phase: "started" | "notification", taskId: string, taskKind: "agent" | "command"): void {
  const line = `${taskId}-${phase}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{
    kind: "subagent_progress",
    source: "claude_task_lifecycle",
    phase,
    taskId,
    parentToolUseId: `toolu_${taskId}`,
    taskKind,
    ...(phase === "notification" ? { taskStatus: "completed" } : {}),
    payloadBytes: 64,
  } as ParsedEvent]);
  ctx.driver.processes.at(-1)!.stdout.emit("data", Buffer.from(`${line}\n`));
}


const drainEvents = (ctx: Ctx, outcome: string) => ctx.events.filter((event) => event.name === "daemon.agent.delivery.routed" && event.attrs.outcome === outcome);
const writesWith = (child: FakeChildProcess, needle: string) => child.stdinWrites.filter((write) => write.includes(needle)).length;

/** Whether `promise` has settled after the pending callbacks ran (no timer advanced). */
async function settledNow<T>(promise: Promise<T>): Promise<T | "pending"> {
  await flush();
  return Promise.race([promise, new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]);
}

test("drain: every agent idle resolves at once; nothing is stopped", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-idle", {});
    const summary = await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(summary.finished, "quiet");
    assert.deepEqual(summary.waitedFor, []);
    assert.equal(summary.live, 1);
    assert.equal(ctx.driver.processes[0]!.killed, false, "a drain stops nothing (one stop path: the shutdown)");
    ctx.manager.endDrain();
  });
});

test("drain: a busy agent is waited for until its turn end, at that edge (the reconcile entry)", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await settledNow(waiting), "pending", "the first turn runs");
    emitTurnEnd(ctx, "agent-busy");
    const summary = await settledNow(waiting);
    assert.notEqual(summary, "pending", "quiet at the turn end itself, not at the next poll");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.waitedFor, ["agent-busy"]);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    ctx.manager.endDrain();
  });
});

test("drain: the deadline returns with the agents still busy", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const summary = await ctx.manager.beginDrain({ deadlineMs: 40 });
    assert.equal(summary.finished, "deadline");
    assert.deepEqual(summary.notQuiet, [{ agentId: "agent-busy", reason: "agent_busy" }]);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    ctx.manager.endDrain();
  });
});

test("drain: a delivery to a busy agent is held, does not keep it busy, and goes in after endDrain", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const ap = (ctx.manager as any).agents.get("agent-busy");
    ap.sessionId = "session-agent-busy";
    ap.sessionReadyForDelivery = true;
    const child = ctx.driver.processes[0]!;
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await ctx.manager.deliverMessage("agent-busy", message(11)), true, "acked: custody, as any queued delivery");
    assert.equal(drainEvents(ctx, "held_for_drain").length, 1);
    const writes = child.stdinWrites.length;
    emitTurnEnd(ctx, "agent-busy");
    const summary = await settledNow(waiting);
    assert.equal(summary !== "pending" && summary.finished, "quiet", "the held message does not keep it busy");
    assert.equal(child.stdinWrites.length, writes, "nothing written at the turn end while held");
    assert.equal(ap.inbox.length, 1, "kept, not dropped");

    ctx.manager.endDrain();
    await flush();
    assert.ok(child.stdinWrites.length > writes, "endDrain hands it over (a new turn: the agent is idle)");
    assert.equal(ap.gatedSteering.isIdle, false);
  });
});

test("drain: a delivery to an idle agent is held; one the agent read meanwhile is not delivered again", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-idle", {});
    const child = ctx.driver.processes[0]!;
    await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    const writes = child.stdinWrites.length;
    assert.equal(await ctx.manager.deliverMessage("agent-idle", message(21)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-idle", message(22)), true);
    await flush();
    assert.equal(child.stdinWrites.length, writes, "no turn starts for a held message");
    assert.equal(ap.gatedSteering.isIdle, true);
    // The agent reads #21 itself (`raft message check` through this daemon).
    (ctx.manager as any).consumeVisibleMessages("agent-idle", { messages: [message(21)], source: "agent_api_check" });
    assert.deepEqual(ap.inbox.map((each: AgentMessage) => each.message_id), ["msg-22"]);

    ctx.manager.endDrain();
    await flush();
    assert.equal(child.stdinWrites.length, writes + 1, "one new turn for what is left");
    const written = child.stdinWrites.slice(writes).join("");
    assert.equal(written.includes("hello 21"), false, "the read message is not delivered again");
  });
});

test("drain: an idle reminder and a release notice start no turn; the notice is held in the inbox", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-idle", {});
    const child = ctx.driver.processes[0]!;
    await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    const writes = child.stdinWrites.length;
    assert.equal(await ctx.manager.deliverIdleNotice("agent-idle", "Reminder: your task is still open"), "busy");
    assert.equal(await ctx.manager.deliverRuntimeProfileNotification("agent-idle", "notice-1", "daemon_release_notice", "Daemon updated"), true);
    await sleep(20);
    assert.equal(child.stdinWrites.length, writes, "nothing written");
    assert.equal(ap.inbox.length, 1, "the notice waits in the inbox");
    ctx.manager.endDrain();
    await flush();
    assert.equal(writesWith(child, "Daemon updated"), 1, "released at the end");
  });
});

// Tenny f8ae3b79 condition 3: a reminder is not kept, and an agent already
// idle sees no further Working→Idle edge. RED proof: drop the re-ask in
// releaseDrainHeld and the edges after endDrain stay [].
test("drain: an idle agent whose reminder the drain refused gets one more idle edge at endDrain (the reminder is asked again)", async () => {
  const edges: string[] = [];
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-idle", {});
    await startIdle(ctx, "agent-other", {});
    await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await ctx.manager.deliverIdleNotice("agent-idle", "Reminder: your task is still open"), "busy");
    edges.length = 0;
    ctx.manager.endDrain();
    assert.deepEqual(edges, ["agent-idle"], "only the refused one, once");
    ctx.manager.endDrain();
    assert.deepEqual(edges, ["agent-idle"]);
  }, undefined, { onAgentWorkingToIdle: (agentId) => edges.push(agentId) });
});

test("drain: no new agent starts while it holds; the start is acked as queued and spawns at endDrain", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    let started = false;
    const start = ctx.manager.startAgent("agent-new", makeConfig({ sessionId: "session-agent-new" })).then(() => { started = true; });
    assert.equal(ctx.manager.getAgentStartAcceptance("agent-new").queueState, "queued");
    await sleep(20);
    assert.equal(ctx.driver.spawnCalls.length, 0, "not spawned during the drain");
    assert.equal(started, false);
    ctx.manager.endDrain();
    await start;
    assert.equal(ctx.driver.spawnCalls.length, 1);
  }, new FakeClaudeDriver(), { runtimeStartScheduler: { minStartIntervalMs: 0 } });
});

test("drain (acceptance 1): a Stop and a turn interrupt pass through at once", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    await ctx.manager.startAgent("agent-stop", makeConfig({ sessionId: "session-agent-stop" }));
    const busyChild = ctx.driver.processes[0]!;
    const stopChild = ctx.driver.processes[1]!;
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000 });

    // Interrupt: Claude's control_request goes into the running turn now.
    const interrupted = ctx.manager.interruptTurn("agent-busy");
    assert.equal(writesWith(busyChild, "control_request"), 1, "the interrupt is written during the drain");
    emitTurnEnd(ctx, "agent-busy", busyChild);
    assert.equal((await interrupted).outcome, "interrupted");

    // Stop: the owner's stop takes effect immediately.
    await ctx.manager.stopAgent("agent-stop");
    assert.equal(stopChild.killed, true, "stopped during the drain");
    assert.equal((ctx.manager as any).agents.has("agent-stop"), false);

    const summary = await waiting;
    assert.equal(summary.finished, "quiet");
    ctx.manager.endDrain();
  });
});

test("drain (acceptance 3): a background task keeps an idle agent not quiet until it ends", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-bg", makeConfig({ sessionId: "session-agent-bg" }));
    emitTask(ctx, "started", "task-1", "command");
    emitTurnEnd(ctx, "agent-bg");
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await settledNow(waiting), "pending", "the turn ended, its background task runs");
    const progress = (ctx.manager as any).drainProgress();
    assert.deepEqual(progress.notQuiet, [{ agentId: "agent-bg", reason: "background_tasks" }]);
    emitTask(ctx, "notification", "task-1", "command");
    await waitFor(() => (ctx.manager as any).drainProgress().notQuiet.length === 0, "the task end");
    assert.equal((await waiting).finished, "quiet");
    ctx.manager.endDrain();
  });
});

test("drain (acceptance 4): written, unconsumed stdin keeps an agent not quiet until a turn takes it", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-stdin", {});
    ap.deliveryConsumption.recordWrite("delivery-1", "stdin_idle_delivery", Date.now());
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await settledNow(waiting), "pending");
    assert.deepEqual((ctx.manager as any).drainProgress().notQuiet, [{ agentId: "agent-stdin", reason: "delivery_in_flight" }]);
    emitTurnEnd(ctx, "agent-stdin");
    assert.equal((await waiting).finished, "quiet");
    ctx.manager.endDrain();
  });
});

test("drain: an in-process wakeup that starts a turn makes the agent not quiet again; the deadline is the backstop", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const ap = await startIdle(ctx, "agent-wake", {});
    const waiting = ctx.manager.beginDrain({ deadlineMs: 150 });
    assert.deepEqual((ctx.manager as any).drainProgress().notQuiet.map((each: { agentId: string }) => each.agentId), ["agent-busy"]);
    // The host's own wakeup (e.g. a ScheduleWakeup turn) starts a turn in the quiet agent.
    (ctx.manager as any).commitApmIdleState("agent-wake", ap, false);
    emitTurnEnd(ctx, "agent-busy", ctx.driver.processes[0]!);
    assert.equal(await settledNow(waiting), "pending", "agent-wake is busy now");
    const summary = await waiting;
    assert.equal(summary.finished, "deadline");
    assert.deepEqual(summary.notQuiet, [{ agentId: "agent-wake", reason: "agent_busy" }]);
    ctx.manager.endDrain();
  });
});

// Reconciler step 14 (Q-H): a /migrate source drains one agent (AgentDrains):
// the same hold and quiet predicate, for that agent only. The core then
// stops it with the hold still on and ends the drain (core.test.ts covers
// that order). RED proof: make `holds(agentId)` ignore the agent filter (the
// machine-wide drain) and "another agent's delivery" is held; drop the
// `only` filter in computeDrainProgress and the busy other agent keeps the
// wait open; route the held transients of a stopped agent again and
// `transients_dropped` is 0.
test("agent drain: only the migrating agent is held and waited for; another agent's delivery and start go on", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-move", makeConfig({ sessionId: "session-agent-move" }));
    const moveAp = (ctx.manager as any).agents.get("agent-move");
    moveAp.sessionId = "session-agent-move";
    moveAp.sessionReadyForDelivery = true;
    const moveChild = ctx.driver.processes[0]!;
    const otherAp = await startIdle(ctx, "agent-other", {});
    const otherChild = ctx.driver.processes[1]!;
    // A third agent busy all along: a machine-wide drain would wait for it.
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));

    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-move" });
    assert.equal(await settledNow(waiting), "pending", "agent-move's first turn runs");
    assert.deepEqual(ctx.manager.drainProgress("agent-move"), { live: 1, notQuiet: [{ agentId: "agent-move", reason: "agent_busy" }], notRunnable: [] });
    assert.equal(ctx.manager.drainProgress(), null, "no machine-wide drain");
    const began = ctx.events.find((event) => event.name === "daemon.agent.drain.began");
    assert.equal(began?.attrs.agentId, "agent-move");

    assert.equal(await ctx.manager.deliverMessage("agent-move", message(31)), true, "custody");
    assert.equal(drainEvents(ctx, "held_for_drain").length, 1);
    const otherWrites = otherChild.stdinWrites.length;
    assert.equal(await ctx.manager.deliverMessage("agent-other", message(32)), true);
    await flush();
    assert.ok(otherChild.stdinWrites.length > otherWrites, "another agent's delivery goes in");
    assert.equal(otherAp.gatedSteering.isIdle, false);
    await ctx.manager.startAgent("agent-new", makeConfig({ sessionId: "session-agent-new" }));
    assert.equal(ctx.driver.spawnCalls.length, 4, "no start is held");

    const moveWrites = moveChild.stdinWrites.length;
    emitTurnEnd(ctx, "agent-move", moveChild);
    const summary = await settledNow(waiting);
    assert.notEqual(summary, "pending", "quiet at its own turn end; agent-busy is not waited for");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.waitedFor, ["agent-move"]);
    assert.equal(moveChild.stdinWrites.length, moveWrites, "the held message is not written at the turn end");
    assert.equal(moveChild.killed, false, "a drain stops nothing");
  }, new FakeClaudeDriver(), { runtimeStartScheduler: { minStartIntervalMs: 0 } });
});

test("agent drain: stopped with the hold on, its end delivers nothing on this Computer and starts nothing", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-move", makeConfig({ sessionId: "session-agent-move" }));
    const ap = (ctx.manager as any).agents.get("agent-move");
    ap.sessionId = "session-agent-move";
    ap.sessionReadyForDelivery = true;
    const child = ctx.driver.processes[0]!;
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-move" });
    assert.equal(await ctx.manager.deliverMessage("agent-move", message(41)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-move", message(42), { transient: true }), true);
    assert.equal(drainEvents(ctx, "transient_held_for_drain").length, 1);
    emitTurnEnd(ctx, "agent-move", child);
    assert.equal((await waiting).finished, "quiet");
    const writes = child.stdinWrites.length;

    // The migration's stop, then the end of the drain (core order).
    await ctx.manager.stopAgent("agent-move", { wait: true, silent: true });
    ctx.manager.endDrain("agent-move");
    await sleep(20);
    assert.equal(child.stdinWrites.length, writes, "nothing held is written");
    assert.equal(ctx.driver.spawnCalls.length, 1, "not started again here");
    assert.equal((ctx.manager as any).agents.has("agent-move"), false);
    assert.equal(restartSnapshot(ctx.manager, "agent-move"), undefined, "no local restart config");
    const released = ctx.events.find((event) => event.name === "daemon.agent.drain.released" && event.attrs.agentId === "agent-move");
    assert.equal(released?.attrs.agent_live, false);
    assert.equal(released?.attrs.transients_dropped, 1, "the held transient is not routed again");
    assert.equal(ctx.manager.drainProgress("agent-move"), null, "released");
  });
});

test("agent drain: ended without a stop (the migration cancelled), the held message goes in and the agent keeps running", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-move", {});
    const child = ctx.driver.processes[0]!;
    const summary = await ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-move" });
    assert.equal(summary.finished, "quiet", "already idle: at once");
    const writes = child.stdinWrites.length;
    assert.equal(await ctx.manager.deliverMessage("agent-move", message(51)), true);
    assert.equal(await ctx.manager.deliverIdleNotice("agent-move", "Reminder: your task is still open"), "busy");
    await flush();
    assert.equal(child.stdinWrites.length, writes, "held");
    ctx.manager.endDrain("agent-move");
    await flush();
    assert.equal(writesWith(child, "hello 51"), 1, "delivered at the end");
    assert.equal(ap.gatedSteering.isIdle, false);
    assert.equal(child.killed, false);
  });
});

test("agent drain: the deadline returns with the agent still busy; an owner Stop passes through and ends the wait quiet", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-stuck", makeConfig({ sessionId: "session-agent-stuck" }));
    const deadline = await ctx.manager.beginDrain({ deadlineMs: 40, agentId: "agent-stuck" });
    assert.equal(deadline.finished, "deadline");
    assert.deepEqual(deadline.notQuiet, [{ agentId: "agent-stuck", reason: "agent_busy" }]);
    ctx.manager.endDrain("agent-stuck");

    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const busyChild = ctx.driver.processes[1]!;
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-busy" });
    assert.equal(await settledNow(waiting), "pending");
    await ctx.manager.stopAgent("agent-busy");
    assert.equal(busyChild.killed, true, "the owner's Stop takes effect at once");
    const summary = await waiting;
    assert.equal(summary.finished, "quiet");
    assert.equal(summary.live, 0);
    ctx.manager.endDrain("agent-busy");
  });
});

// #proj-raft-computer:#62 (Kirby): an agent idle in a provider-limit delivery
// backoff, its inbox held by it, is quiet: what is held is not delivered
// before the backoff ends and stays unread on the server. A tracked mention
// that arrives during the backoff is answered QUOTA_LIMITED; its entry used to
// stay `received` (never queued, never told), read as an open mention, so the
// drain waited `mention_in_flight` until the process was killed. RED proof:
// put back the bare `onMentionTerminalError` (no `failTrackedMention`) at the
// backoff gate in deliverMessage and the first test waits until its deadline.
const QUOTA_TEXT = "You've hit your usage limit · resets 5pm";

function emitEvents(ctx: Ctx, events: ParsedEvent[]): void {
  const line = `events-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, events);
  ctx.driver.processes.at(-1)!.stdout.emit("data", Buffer.from(`${line}\n`));
}

function trackedMention(seq: number, onTerminal: (code: string) => void) {
  return {
    deliveryId: `occ-${seq}`,
    mentionDelivery: { occurrenceId: `occ-${seq}`, messageId: `msg-${seq}`, machineId: "machine-1", launchId: "launch-kirby", sessionId: "session-agent-kirby" },
    onMentionTerminalError: onTerminal,
  } as const;
}

const drainBegan = (ctx: Ctx) => ctx.events.find((event) => event.name === "daemon.agent.drain.began")?.attrs;

test("agent drain (#62): idle in a provider-limit backoff with held inbox and a mention answered QUOTA_LIMITED, the agent is quiet at once; nothing is killed", async () => {
  await withManager(async (ctx) => {
    await writeTranscript(ctx, "session-agent-kirby");
    await ctx.manager.startAgent("agent-kirby", makeConfig({ sessionId: "session-agent-kirby" }), undefined, undefined, undefined, "launch-kirby");
    const ap = (ctx.manager as any).agents.get("agent-kirby");
    ap.sessionId = "session-agent-kirby";
    ap.sessionReadyForDelivery = true;
    (ctx.manager as any).commitApmIdleState("agent-kirby", ap, true);
    const child = ctx.driver.processes[0]!;
    // The last turn: a delivery goes in, the turn fails on the provider's quota.
    assert.equal(await ctx.manager.deliverMessage("agent-kirby", message(60)), true);
    emitEvents(ctx, [
      { kind: "error", message: QUOTA_TEXT, providerLimit: { kind: "quota_exhausted" } } as ParsedEvent,
      { kind: "turn_end", sessionId: "session-agent-kirby" },
    ]);
    assert.equal(ap.runtimeErrorDeliveryBackoff.kind, "backing_off", "precondition: in the delivery backoff");
    const terminal: string[] = [];
    for (let seq = 61; seq <= 65; seq += 1) assert.equal(await ctx.manager.deliverMessage("agent-kirby", message(seq)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-kirby", message(66), trackedMention(66, (code) => terminal.push(code))), false);
    assert.deepEqual(terminal, ["QUOTA_LIMITED"]);
    assert.equal(ap.inbox.length, 6, "held by the backoff, as Kirby's 6");
    const writes = child.stdinWrites.length;

    const summary = await settledNow(ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-kirby" }));
    assert.notEqual(summary, "pending", "quiet at begin, not at the deadline");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.waitedFor, []);
    assert.equal(drainBegan(ctx)?.not_quiet, 0);
    assert.equal(drainBegan(ctx)?.not_quiet_reasons, undefined);
    assert.equal(child.killed, false, "no SIGTERM needed");
    assert.equal(child.stdinWrites.length, writes, "nothing held is written");
    assert.equal((ctx.manager as any).trackedMentionDeliveries.has("occ-66"), false, "the answered occurrence is released");
    ctx.manager.endDrain("agent-kirby");
  });
});

test("agent drain (#62 control): an inbox delivery written and not consumed, no backoff, keeps it not quiet; drain.began names the reason", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-flight", {});
    ap.sessionReadyForDelivery = true;
    assert.equal(ap.runtimeErrorDeliveryBackoff.kind, "idle");
    // The idle delivery is written into stdin (a new turn the runtime has not answered yet).
    assert.equal(await ctx.manager.deliverMessage("agent-flight", message(70)), true);
    (ctx.manager as any).commitApmIdleState("agent-flight", ap, true);
    assert.equal(ap.deliveryConsumption.snapshot().unconsumedDeliveries, 1, "precondition: written, unconsumed");
    const waiting = ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-flight" });
    assert.equal(await settledNow(waiting), "pending");
    assert.deepEqual(ctx.manager.drainProgress("agent-flight")?.notQuiet, [{ agentId: "agent-flight", reason: "delivery_in_flight" }]);
    assert.equal(drainBegan(ctx)?.not_quiet, 1);
    assert.equal(drainBegan(ctx)?.not_quiet_reasons, "delivery_in_flight");
    emitTurnEnd(ctx, "agent-flight");
    assert.equal((await waiting).finished, "quiet");
    ctx.manager.endDrain("agent-flight");
  });
});

// tygg: "很多时候 agent 根本就无法工作了，stop agent 那一步的等待时间是纯浪费".
// An agent that cannot run (its credential holds a verification_required
// record) with no turn in flight is quiet at once, although a delivery
// written to its stdin was never taken: no turn will take it before the
// deadline. Nothing is reported read for what it was given or held: it
// stays unread on the server for the target. RED proof: drop
// agentStopWaitReason from computeDrainProgress (back to agentNotIdle) and
// the first test waits `delivery_in_flight` until its deadline.
function holdCredential(ctx: Ctx, agentId: string): void {
  const ap = (ctx.manager as any).agents.get(agentId);
  (ctx.manager as any).lifecycleRecords.providerLimitLedger.recordInvalid(
    providerLimitCredentialKey(agentId, ap.config),
    { invalidReason: "user_reauth", recordedAtMs: Date.now(), code: "verification_required" },
    { host: "legacy" },
  );
}

const readReports = (sent: readonly MachineToServerMessage[]) => sent.filter((frame) => frame.type === "agent:model-seen" || frame.type === "agent:turn:ended");

test("agent drain (not runnable): idle with an invalid credential and unconsumed stdin, it is not waited for; nothing given or held is reported read", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-dead", {});
    ap.sessionReadyForDelivery = true;
    const child = ctx.driver.processes[0]!;
    assert.equal(await ctx.manager.deliverMessage("agent-dead", message(90)), true);
    (ctx.manager as any).commitApmIdleState("agent-dead", ap, true);
    assert.equal(ap.deliveryConsumption.snapshot().unconsumedDeliveries, 1, "precondition: written to stdin, never taken");
    holdCredential(ctx, "agent-dead");
    // Held for the credential: queued here, never told.
    assert.equal(await ctx.manager.deliverMessage("agent-dead", message(91)), true);
    const sentBefore = ctx.sent.length;
    const writes = child.stdinWrites.length;

    const summary = await settledNow(ctx.manager.beginDrain({ deadlineMs: 60_000, agentId: "agent-dead" }));
    assert.notEqual(summary, "pending", "not waited for: no turn will take the stdin delivery");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.notRunnable, [{ agentId: "agent-dead", reason: "credential_invalid", settled: "delivery_in_flight" }]);
    const finished = ctx.events.find((event) => event.name === "daemon.agent.drain.finished")?.attrs;
    assert.equal(finished?.not_runnable_reasons, "credential_invalid");
    assert.equal(finished?.not_runnable_settled, "delivery_in_flight");

    // The migration's stop, then the end of the drain (core order).
    await ctx.manager.stopAgent("agent-dead", { wait: true, silent: true });
    ctx.manager.endDrain("agent-dead");
    await sleep(20);
    assert.deepEqual(readReports(ctx.sent.slice(sentBefore)), [], "no model-seen or turn-ended: both messages stay unread on the server");
    assert.equal(child.stdinWrites.length, writes, "the held message is not written");
    assert.equal(ctx.driver.spawnCalls.length, 1, "not started again here");
  });
});

test("agent drain (not runnable): a turn in flight is still waited for, until the deadline", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-dead-busy", makeConfig({ sessionId: "session-agent-dead-busy" }));
    holdCredential(ctx, "agent-dead-busy");
    const summary = await ctx.manager.beginDrain({ deadlineMs: 40, agentId: "agent-dead-busy" });
    assert.equal(summary.finished, "deadline");
    assert.deepEqual(summary.notQuiet, [{ agentId: "agent-dead-busy", reason: "agent_busy" }]);
    assert.deepEqual(summary.notRunnable, []);
    ctx.manager.endDrain("agent-dead-busy");
  });
});
