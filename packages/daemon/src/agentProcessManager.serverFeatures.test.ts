// Server features in the agent manager (applyServerFeatures): the Server's
// flag-derived config fields changed, so every agent's config takes them, and
// a running process whose session drifted from them (reconciler step 6, row
// A1) is stopped once it is idle (agentIdle.ts; the cold-idle stop path,
// session kept) so its next wake starts on the new standing prompt; not idle,
// it is left alone until the fact that holds it clears (its own entry point:
// a turn end, the last background task, a purge), with the 10-minute sweep as
// the backstop. The next spawn tells the agent once what changed.
//
// RED proof: drop the `applyServerFeatures` loop over live agents and the
// idle test never stops the process; drop the turn-end entry point and the
// busy test's process survives its turn end; drop the idle check in
// reconcileSpec and the hold tests stop the process at once; drop the
// notice composition in startAgentNow and the first restart's input has no
// notice; drop the stopping-process delivery guard (deliverMessage, reconciler
// step 5) and the message that arrives after the SIGTERM is written to the
// dying process.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.wakeRecycle.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
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
  } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-server-features-test-"));
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
const NOTICE = /^Raft notice: this server's features changed: /;

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

/** Stop the process the cold-idle way and let it close (a clean exit, session kept). */
async function recycleStop(ctx: Ctx, agentId: string): Promise<void> {
  const ap = (ctx.manager as any).agents.get(agentId);
  (ctx.manager as any).beginColdIdleRecycleStop(agentId, ap, "Test");
  await flush();
}

test("unchanged features (order and duplicates aside) leave a running agent alone", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-same", { taskConversations: true, enabledApps: ["artifacts"] });
    ctx.manager.applyServerFeatures({ taskConversations: true, passiveAx: false, enabledApps: ["artifacts", "artifacts"] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.equal(ap.gatedSteering.expectedTerminationReason, null);
    assert.equal(ctx.events.some((event) => event.name === "daemon.agent.spec_restart_stop"), false);
    assert.equal((ctx.manager as any).serverFeaturesNoticeBase.size, 0, "nothing to tell");
  });
});

test("changed features stop an idle agent once, the cold-idle way, and its next spawn tells it what changed, once", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-idle", { taskConversations: true, enabledApps: [] });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    const child = ctx.driver.processes[0]!;
    await waitFor(() => child.killed, "the stop");
    await flush();

    assert.equal(child.kills, 1, "stopped: it was idle with nothing in the background");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle", "an expected termination, session kept");
    assert.deepEqual(ap.config.enabledApps, ["artifacts"]);
    assert.equal(ap.config.taskConversations, undefined);
    assert.deepEqual(featuresStops(ctx), [{
      agentId: "agent-idle",
      session_id: "session-agent-idle",
      drift: "features",
      changed_keys: "taskConversations,enabledApps",
      new_session: false,
      trigger: "signal",
      host: "legacy",
    }]);
    assert.equal(ctx.driver.spawnCalls.length, 1, "no immediate restart: the next wake starts it");

    // The same values again, and a sweep: no second stop.
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(child.kills, 1);

    const snapshot = restartSnapshot(ctx.manager, "agent-idle");
    assert.ok(snapshot, "an idle, restartable record");
    assert.deepEqual(snapshot.config.enabledApps, ["artifacts"]);
    assert.equal(snapshot.config.taskConversations, undefined);
    assert.equal(snapshot.sessionId, "session-agent-idle", "the session is kept");

    // The next wake (here a start from the snapshot, with the credential the
    // Server would carry) opens with the notice; the one after does not.
    await ctx.manager.startAgent("agent-idle", { ...snapshot.config, agentCredentialKey: "sk_agent_test" });
    assert.equal(ctx.driver.spawnCalls.length, 2);
    const first = ctx.driver.spawnCalls[1]!;
    assert.match(first.prompt, NOTICE);
    assert.match(first.prompt, /Artifacts turned on \(`raft artifact`\); Task conversations turned off for new tasks /);
    assert.deepEqual(first.config.enabledApps, ["artifacts"]);
    await recycleStop(ctx, "agent-idle");
    await ctx.manager.startAgent("agent-idle", { ...restartSnapshot(ctx.manager, "agent-idle")!.config, agentCredentialKey: "sk_agent_test" });
    assert.equal(ctx.driver.spawnCalls.length, 3);
    assert.doesNotMatch(ctx.driver.spawnCalls[2]!.prompt, /Raft notice: this server's features changed/, "told once");
  });
});

test("a busy agent takes the values at once but is stopped only at its turn end", async () => {
  await withManager(async (ctx) => {
    await writeTranscript(ctx, "session-busy");
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-busy", enabledApps: [] }));
    const ap = (ctx.manager as any).agents.get("agent-busy");
    assert.equal(ap.gatedSteering.isIdle, false, "precondition: the first turn is running");

    ctx.manager.applyServerFeatures({ vaultApp: true, enabledApps: [] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    const child = ctx.driver.processes[0]!;
    assert.equal(child.killed, false, "not under a running turn");
    assert.equal(ap.config.vaultApp, true, "the live config already has the new values");

    ctx.driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-busy" }]);
    child.stdout.emit("data", Buffer.from("turn-end\n"));
    // At the turn end itself: no settle wait.
    assert.equal(child.kills, 1, "stopped at the turn end, with an empty inbox");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle");
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["turn_end"]);
    await flush();
    assert.equal(restartSnapshot(ctx.manager, "agent-busy")?.config.vaultApp, true);
  });
});

test("a delivery the runtime has not consumed yet holds the stop; the turn that takes it ends, and it is stopped", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-unconsumed", { enabledApps: [] });
    const child = ctx.driver.processes[0]!;
    ap.deliveryConsumption.recordWrite("delivery-1", "stdin_idle_delivery", Date.now());
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(child.killed, false, "a written, unconsumed delivery holds it");

    // Written input is consumed by a turn; its end is the entry point.
    emitTurnEnd(ctx, "agent-unconsumed");
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["turn_end"]);
  });
});

test("queued messages hold the stop: the turn end hands them over as the next turn, whose own end stops it", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-queued", makeConfig({ sessionId: "session-agent-queued", enabledApps: [] }));
    const ap = (ctx.manager as any).agents.get("agent-queued");
    const child = ctx.driver.processes[0]!;
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    // Arrives mid-turn: queued for the turn boundary.
    ap.inbox.push(message(601));
    emitTurnEnd(ctx, "agent-queued");
    await flush();
    assert.equal(child.killed, false, "the queued message went in as the next turn");
    assert.equal(ap.gatedSteering.isIdle, false);

    emitTurnEnd(ctx, "agent-queued");
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["turn_end"]);
  });
});

test("untold inbox work holds the stop; a purge that removes it stops it there", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-untold", { enabledApps: [] });
    const child = ctx.driver.processes[0]!;
    // Queued, never told to this session (no notice written).
    ap.inbox.push(message(701));
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(child.killed, false, "untold work holds it");

    ctx.manager.purgeInboxMessagesForChannels("agent-untold", ["channel-general"]);
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["delivery_consumed"]);
  });
});

test("an open tracked mention holds the stop until the turn end settles it", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-mention", { enabledApps: [] });
    const child = ctx.driver.processes[0]!;
    const terminal: string[] = [];
    (ctx.manager as any).trackedMentionDeliveries.set("occ-1", {
      agentId: "agent-mention",
      messageId: "msg-801",
      message: message(801),
      state: "pending",
      context: { onMentionTerminalError: (code: string) => terminal.push(code) },
    });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(child.killed, false, "an open mention holds it");

    emitTurnEnd(ctx, "agent-mention");
    assert.deepEqual(terminal, ["DELIVERY_REJECTED"], "settled at the turn end (never told)");
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["turn_end"]);
  });
});

test("a drift no idle edge reaches is stopped by the sweep, traced as such", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-swept", makeConfig({ sessionId: "session-agent-swept", enabledApps: [] }));
    const ap = (ctx.manager as any).agents.get("agent-swept");
    const child = ctx.driver.processes[0]!;
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.equal(child.killed, false, "busy");
    // Idle again with no entry point firing (a missed idle edge).
    (ctx.manager as any).commitApmIdleState("agent-swept", ap, true);
    await sleep(30);
    assert.equal(child.killed, false);
    await (ctx.manager as any).sweepColdIdleRuntimes();
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["sweep"]);
  });
});

test("a background task holds the stop; its end stops it there, with no transcript check", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-bg", { enabledApps: [] });
    const child = ctx.driver.processes[0]!;
    // task #1260: a background task keeps isIdle true. A background shell command.
    emitTask(ctx, "started", "taskcmd1", "command");
    await flush();
    assert.equal(ap.backgroundTasks.size, 1);
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(child.killed, false, "a live background task holds it");
    assert.deepEqual(ap.config.enabledApps, ["artifacts"], "the config is updated anyway");

    // The session's transcript still shows a monitor armed: no longer read.
    await writeTranscript(ctx, "session-agent-bg", "Monitor started (task abc123)\n");
    emitTask(ctx, "notification", "taskcmd1", "command");
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["background_tasks_done"]);
  });
});

test("a sub-agent that ends on its own leaves its result for Claude's own next turn: the stop waits for that turn's end", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-subagent", makeConfig({ sessionId: "session-agent-subagent", enabledApps: [] }));
    const ap = (ctx.manager as any).agents.get("agent-subagent");
    const child = ctx.driver.processes[0]!;
    // The turn starts a sub-agent in the background and ends.
    emitTask(ctx, "started", "taskagent1", "agent");
    emitTurnEnd(ctx, "agent-subagent");
    await flush();
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.equal(child.killed, false, "the running sub-agent holds it");
    emitTask(ctx, "notification", "taskagent1", "agent");
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.equal(child.killed, false, "its result is input no turn has read yet");

    emitTurnEnd(ctx, "agent-subagent");
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["turn_end"]);
  });
});

test("a Claude session whose transcript cannot be found is stopped all the same (no transcript gate)", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-no-transcript", { enabledApps: [] }, false);
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.equal(ctx.driver.processes[0]!.kills, 1);
  });
});

test("a runtime showing an error is stopped once idle: an error is not a hold; its next spawn reads the new config", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-error", { enabledApps: [] });
    ap.lastRuntimeError = "You've hit your limit";
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    await flush();
    assert.deepEqual(restartSnapshot(ctx.manager, "agent-error")?.config.enabledApps, ["artifacts"]);
  });
});

test("a change a runtime makes nothing of updates the config without a stop", async () => {
  await withManager(async (ctx) => {
    // The fake runtime renders no sub-agent section and does not rotate sessions.
    const ap = await startIdle(ctx, "agent-irrelevant", { enabledApps: [] });
    ctx.manager.applyServerFeatures({ subagentDelegation: true, piSessionRotation: true, enabledApps: [] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.equal(ap.config.subagentDelegation, true);
    assert.equal(ap.config.piSessionRotation, true);
    // View Context state lives in the daemon, never in the session.
    ctx.manager.applyServerFeatures({ subagentDelegation: true, piSessionRotation: true, agentContextView: true, enabledApps: [] });
    await (ctx.manager as any).sweepColdIdleRuntimes();
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(featuresStops(ctx), []);
  });
  await withManager(async (ctx) => {
    // A change and its undo, both while the process is busy: nothing to restart for once idle.
    await ctx.manager.startAgent("agent-undo", makeConfig({ sessionId: "session-agent-undo", enabledApps: [] }));
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    ctx.manager.applyServerFeatures({ enabledApps: [] });
    emitTurnEnd(ctx, "agent-undo");
    await (ctx.manager as any).sweepColdIdleRuntimes();
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(featuresStops(ctx), []);
    assert.deepEqual((ctx.manager as any).idleHolds.trackedAgentIds(), [], "no hold is measured once nothing drifts");
  });
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-subagents", { enabledApps: [] });
    ctx.manager.applyServerFeatures({ subagentDelegation: true, enabledApps: [] });
    await waitFor(() => ctx.driver.processes[0]!.killed, "the stop: this runtime renders the sub-agent section");
    await flush();
    // The restart is not silent: its next start names the instruction change.
    await ctx.manager.startAgent("agent-subagents", { ...restartSnapshot(ctx.manager, "agent-subagents")!.config, agentCredentialKey: "sk_agent_test" });
    assert.match(ctx.driver.spawnCalls[1]!.prompt, /your instructions now cover working through sub-agents/);
  }, new FakeClaudeDriver({ supportsSubagents: true }));
});

test("reconciler step 5: a message that arrives after the SIGTERM is never written to the stopping process and wakes the agent at its close", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-race", { enabledApps: [] });
    ap.sessionReadyForDelivery = true;
    const wakes: unknown[] = [];
    // Record the restart without running it (it would mint a runner credential).
    (ctx.manager as any).startAgent = async (...args: unknown[]) => { wakes.push(args[2]); };
    // Told before the stop: the agent's own deferral.
    const before = message(501);
    ap.inbox.push(before);
    ap.notifications.recordNoticeWritten("fp-before", ap.sessionId, [before]);

    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    const child = ctx.driver.processes[0]!;
    await waitFor(() => child.killed, "the SIGTERM");
    const writesAtSigterm = child.stdinWrites.length;
    // Delivered during the stop's grace: kept in the inbox, never written to
    // the process being stopped (reconciler step 5; it used to be told).
    assert.equal(await ctx.manager.deliverMessage("agent-race", message(502)), true);
    assert.equal(child.stdinWrites.length, writesAtSigterm, "nothing is written to a stopping process");

    child.exitNow();
    await flush();
    assert.equal(wakes.length, 1, "the later message wakes the agent");
    assert.equal((wakes[0] as AgentMessage).seq, 502, "it, not the deferred unread, is the wake message");
  }, new FakeClaudeDriver({ deferExit: true }));
});

test("an agent with no process gets the values in its restart snapshot, credential-free, and the notice at its next start", async () => {
  await withManager(async (ctx) => {
    const before = makeConfig({ sessionId: "session-cached", agentCredentialKey: null, passiveAx: true, enabledApps: ["artifacts"] });
    (ctx.manager as any).lifecycleRecords.setRestartSnapshot("agent-cached", { config: before, sessionId: "session-cached", launchId: "launch-1" });

    ctx.manager.applyServerFeatures({ taskConversations: true, enabledApps: [] });
    const snapshot = restartSnapshot(ctx.manager, "agent-cached");
    assert.ok(snapshot);
    assert.deepEqual(snapshot, {
      config: { ...makeConfig({ sessionId: "session-cached", agentCredentialKey: null }), taskConversations: true, enabledApps: [] },
      sessionId: "session-cached",
      launchId: "launch-1",
    });
    assert.equal(ctx.driver.spawnCalls.length, 0, "nothing is started for it");

    await ctx.manager.startAgent("agent-cached", { ...snapshot.config, agentCredentialKey: "sk_agent_test" });
    assert.match(ctx.driver.spawnCalls[0]!.prompt, NOTICE);
    assert.match(ctx.driver.spawnCalls[0]!.prompt, /Artifacts turned off \(`raft artifact` no longer works here\); Task conversations turned on /);
  });
});

test("a start that fails to spawn keeps the notice for the next one", async () => {
  await withManager(async (ctx) => {
    (ctx.manager as any).lifecycleRecords.setRestartSnapshot("agent-failing", {
      config: makeConfig({ sessionId: "session-failing", agentCredentialKey: null, enabledApps: [] }),
      sessionId: "session-failing",
      launchId: null,
    });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    const config = { ...restartSnapshot(ctx.manager, "agent-failing")!.config, agentCredentialKey: "sk_agent_test" };

    ctx.driver.failNextSpawn = true;
    await ctx.manager.startAgent("agent-failing", config).catch(() => undefined);
    assert.equal(ctx.driver.spawnCalls.length, 0, "precondition: nothing spawned");
    assert.equal((ctx.manager as any).serverFeaturesNoticeBase.has("agent-failing"), true, "the notice base is kept");

    (ctx.manager as any).resetSpawnFailBackoff?.("agent-failing", "suppressed");
    await ctx.manager.startAgent("agent-failing", config);
    assert.equal(ctx.driver.spawnCalls.length, 1);
    assert.match(ctx.driver.spawnCalls[0]!.prompt, NOTICE);
    assert.equal((ctx.manager as any).serverFeaturesNoticeBase.has("agent-failing"), false, "dropped once a start committed");
  });
});

test("the notice follows a fresh session's inlined standing prompt, right before the input's own content", async () => {
  await withManager(async (ctx) => {
    (ctx.manager as any).lifecycleRecords.setRestartSnapshot("agent-fresh", {
      config: makeConfig({ sessionId: null, agentCredentialKey: null, enabledApps: [] }),
      sessionId: null,
      launchId: null,
    });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await ctx.manager.startAgent("agent-fresh", { ...restartSnapshot(ctx.manager, "agent-fresh")!.config, agentCredentialKey: "sk_agent_test" });
    const prompt = ctx.driver.spawnCalls[0]!.prompt;
    const standingAt = prompt.indexOf("claude standing prompt");
    const noticeAt = prompt.indexOf("Raft notice: this server's features changed");
    assert.equal(standingAt, 0, "the standing prompt opens a fresh session's first input");
    assert.ok(noticeAt > standingAt, "the notice comes after the instructions it refers to");
    assert.ok(prompt.slice(noticeAt).includes("No reply is needed.\n\n") && prompt.length > prompt.indexOf("No reply is needed.\n\n") + 21, "the input's own content follows it");
  }, new FakeClaudeDriver({ supportsNativeStandingPrompt: false }));
});

test("a per-turn runtime is not stopped: its next spawn reads the new config", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-per-turn", { enabledApps: [] });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await sleep(30);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(ap.config.enabledApps, ["artifacts"]);
    assert.deepEqual(featuresStops(ctx), []);
  }, new FakeClaudeDriver({ perTurn: true }));
});

test("an explicit stop drops the notice base", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-stopped", { enabledApps: [] });
    ap.backgroundTasks.set("task-live", { startedAtMs: Date.now() });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.equal(ctx.driver.processes[0]!.killed, false, "held by the background task");
    assert.equal((ctx.manager as any).startConfigFeaturesGeneration.has("agent-stopped"), true);
    await ctx.manager.stopAgent("agent-stopped");
    assert.equal((ctx.manager as any).serverFeaturesNoticeBase.has("agent-stopped"), false);
    assert.equal((ctx.manager as any).startConfigFeaturesGeneration.has("agent-stopped"), false);
  });
});

// A start that took its config before an answer (queued, being prepared,
// rebound) must not run on the older values until its next natural restart.
test("an answer that lands while a start is queued: the start spawns on the new values, with the notice", async () => {
  await withManager(async (ctx) => {
    const first = ctx.manager.startAgent("agent-a", makeConfig({ sessionId: "session-a", enabledApps: [] }));
    const queued = ctx.manager.startAgent("agent-b", makeConfig({ sessionId: "session-b", enabledApps: [], taskConversations: true }));
    assert.equal((ctx.manager as any).agentStarts.hasQueued("agent-b"), true, "precondition: agent-b's start is queued");
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await Promise.all([first, queued]);

    const spawnB = ctx.driver.spawnCalls.find((call) => call.config.sessionId === "session-b");
    assert.ok(spawnB, "agent-b spawned");
    assert.deepEqual(spawnB.config.enabledApps, ["artifacts"]);
    assert.equal(spawnB.config.taskConversations, undefined);
    assert.match(spawnB.prompt, /^Raft notice: this server's features changed: Artifacts turned on \(`raft artifact`\); Task conversations turned off for new tasks /);
    const apB = (ctx.manager as any).agents.get("agent-b");
    assert.deepEqual(apB.config.enabledApps, ["artifacts"]);
    assert.deepEqual(apB.sessionServerFeatures, { enabledApps: ["artifacts"] }, "it spawned on them: no drift");
    (ctx.manager as any).commitApmIdleState("agent-b", apB, true);
    await (ctx.manager as any).sweepColdIdleRuntimes();
    assert.equal(featuresStops(ctx).some((stop) => stop.agentId === "agent-b"), false, "no restart");
    assert.equal((ctx.manager as any).serverFeaturesNoticeBase.has("agent-b"), false, "told once");
  }, new FakeClaudeDriver(), { runtimeStartScheduler: { maxConcurrentStarts: 1, minStartIntervalMs: 0 } });
});

test("an answer that lands while a spawn is being prepared reaches the process once it is registered", async () => {
  await withManager(async (ctx) => {
    const buildSpawnConfig = (ctx.manager as any).buildSpawnConfig.bind(ctx.manager);
    let answered = false;
    (ctx.manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => {
      // After the start compared its config, before its process is registered.
      if (!answered) { answered = true; ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] }); }
      return buildSpawnConfig(agentId, config);
    };
    await ctx.manager.startAgent("agent-late", makeConfig({ sessionId: "session-late", enabledApps: [] }));
    assert.deepEqual(ctx.driver.spawnCalls[0]!.config.enabledApps, [], "precondition: it spawned on the old values");
    const ap = (ctx.manager as any).agents.get("agent-late");
    assert.deepEqual(ap.config.enabledApps, ["artifacts"], "the process's config caught up");
    assert.deepEqual((ctx.manager as any).serverFeaturesNoticeBase.get("agent-late"), { enabledApps: [] }, "the next notice starts from what it spawned with");
    assert.equal(ctx.driver.processes[0]!.killed, false, "not before it is idle");
    emitTurnEnd(ctx, "agent-late");
    assert.equal(ctx.driver.processes[0]!.kills, 1, "restarted at its first idle moment");
  });
});

test("a rebound start brings a running session to its values on a server that answers features, and only there", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-rebound", { enabledApps: [] });
    ctx.manager.setServerFeaturesCapable(true);
    await ctx.manager.startAgent("agent-rebound", makeConfig({ sessionId: "session-agent-rebound", enabledApps: ["artifacts"] }));
    await waitFor(() => ctx.driver.processes[0]!.killed, "the stop for the rebound values");
    assert.equal(ctx.driver.processes.length, 1, "a rebind, not a second process");
    assert.deepEqual((ctx.manager as any).serverFeaturesNoticeBase.get("agent-rebound"), { enabledApps: [] });
  });
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-rebound-old", { enabledApps: [] });
    // An older server (no server:features-v1): the rebind replaces the config as before.
    await ctx.manager.startAgent("agent-rebound-old", makeConfig({ sessionId: "session-agent-rebound-old", enabledApps: ["artifacts"] }));
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.equal((ctx.manager as any).serverFeaturesNoticeBase.has("agent-rebound-old"), false);
  });
});

test("a plain disconnect keeps the last answer; a server that does not answer features forgets it", async () => {
  await withManager(async (ctx) => {
    const queued = ctx.manager.startAgent("agent-x", makeConfig({ sessionId: "session-x", enabledApps: [] }));
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    // core on a dropped connection: the answer stays (a start after the reconnect is newer anyway).
    ctx.manager.setServerFeaturesCapable(false);
    await queued;
    assert.deepEqual(ctx.driver.spawnCalls[0]!.config.enabledApps, ["artifacts"], "brought to the answer it predates");
  });
  await withManager(async (ctx) => {
    const queued = ctx.manager.startAgent("agent-y", makeConfig({ sessionId: "session-y", enabledApps: [] }));
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    // core on a context without the capability (or for another server).
    ctx.manager.forgetServerFeatures();
    await queued;
    assert.deepEqual(ctx.driver.spawnCalls[0]!.config.enabledApps, [], "no answer to bring it to");
    assert.equal((ctx.manager as any).lastAppliedServerFeatures, null);
  });
});

test("a rebind while the process is still being started marks no restart when it spawns on those values", async () => {
  await withManager(async (ctx) => {
    await writeTranscript(ctx, "session-spawning");
    // A notice base from an earlier change: the session last ran without Artifacts.
    (ctx.manager as any).lifecycleRecords.setRestartSnapshot("agent-spawning", {
      config: makeConfig({ sessionId: "session-spawning", agentCredentialKey: null, enabledApps: [] }),
      sessionId: "session-spawning",
      launchId: null,
    });
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    ctx.manager.setServerFeaturesCapable(true);
    const config = { ...restartSnapshot(ctx.manager, "agent-spawning")!.config, agentCredentialKey: "sk_agent_test" };
    let rebound = false;
    ctx.driver.onSpawn = () => {
      // The server's start for the same agent lands now: the process is registered, not yet committed.
      void ctx.manager.startAgent("agent-spawning", makeConfig({ sessionId: "session-spawning", enabledApps: ["artifacts"] }));
      rebound = true;
    };
    await ctx.manager.startAgent("agent-spawning", config);
    assert.equal(rebound, true, "precondition: the rebind happened during the spawn");
    assert.equal(ctx.driver.processes.length, 1, "a rebind, not a second process");
    assert.deepEqual(ctx.driver.spawnCalls[0]!.config.enabledApps, ["artifacts"]);

    const ap = (ctx.manager as any).agents.get("agent-spawning");
    ap.sessionId = "session-spawning";
    (ctx.manager as any).commitApmIdleState("agent-spawning", ap, true);
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await sleep(30);
    assert.equal(ctx.driver.processes[0]!.killed, false, "no needless restart once idle");
  });
});

test("View Context: the start config and server answers gate an agent; its availability goes to the Server and a request to one result POST", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "slock-context-view-home-"));
  const posts: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    posts.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  const availability = (ctx: Ctx) => ctx.sent.filter((msg) => msg.type === "agent:context_view_availability");
  try {
    await withManager(async (ctx) => {
      // A Claude Code session that records its model requests.
      await writeTranscript(ctx, "session-agent-cv", `${JSON.stringify({ type: "api-request", id: "r1" })}\n`);
      await startIdle(ctx, "agent-cv", { agentContextView: true, runtimeContext: { serverId: "srv_cv" } }, false);
      await waitFor(() => availability(ctx).length === 1, "availability at start");
      assert.deepEqual(availability(ctx)[0], {
        type: "agent:context_view_availability",
        agentId: "agent-cv",
        runtime: "claude",
        supported: true,
        retainedSince: null,
        retentionDays: 30,
      });

      ctx.manager.applyServerFeatures({});
      await ctx.manager.handleAgentContextViewRequest({
        type: "agent:context_view_request",
        requestId: "ctxv_0123456789abcdef0123",
        agentId: "agent-cv",
        messageId: "m-1",
        maxBytes: 1_000_000,
      });
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.url, "https://daemon.example.com/internal/computer/agent-context/ctxv_0123456789abcdef0123");
      assert.equal((posts[0]!.init?.headers as Record<string, string>).Authorization, "Bearer sk_machine_test");
      const { gunzipSync } = await import("node:zlib");
      assert.deepEqual(JSON.parse(gunzipSync(posts[0]!.init!.body as Uint8Array).toString("utf8")), { ok: false, reason: "not_found" });

      ctx.manager.applyServerFeatures({ agentContextView: true });
      await waitFor(() => availability(ctx).length === 2, "availability when a server answer turns the gate on");

      // A send the Server accepted is indexed under the agent's own server.
      (ctx.manager as any).contextView.onMessageCommitted("agent-cv", "m-2", "send");
      const index = path.join(slockHome, "agent-context", "srv_cv", "agent-cv", "index.jsonl");
      await waitFor(() => existsSync(index), "index line under the agent's server");
      assert.deepEqual(readdirSync(path.join(slockHome, "agent-context")), ["srv_cv"]);
    }, undefined, { slockHome, fetchImpl, connectedServerId: () => "srv_cv" });
  } finally {
    await rm(slockHome, { recursive: true, force: true });
  }
});

test("View Context reads an agent on another host, while it runs and after its session ended", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "slock-apm-hosted-context-view-"));
  const posts: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    posts.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  const availability = (ctx: Ctx) => ctx.sent.filter((msg) => msg.type === "agent:context_view_availability");
  try {
    await withManager(async (ctx) => {
      const session = {
        config: { ...makeConfig({ runtime: "codex", agentContextView: true, runtimeContext: { serverId: "srv_cv" } }), runtimeHost: "oar" as const },
        sessionId: "thread-hosted",
        launchId: "launch-hosted",
        processInstanceId: "pi-hosted",
      };
      const sessions = path.join(ctx.homeDir, ".codex", "sessions");
      await mkdir(sessions, { recursive: true });
      const line = (type: string, payload: unknown) => `${JSON.stringify({ timestamp: "2026-11-06T00:00:00.000Z", type, payload })}\n`;
      await writeFile(path.join(sessions, "rollout-2026-11-06T00-00-00-thread-hosted.jsonl"), line("session_meta", { cli_version: "0.167.0" })
        + line("response_item", { type: "additional_tools", tools: [{ type: "function", name: "exec_command", parameters: {} }] })
        + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }));
      const running = new Map([["agent-hosted", session]]);
      ctx.manager.setHostedSessions({ get: (agentId) => running.get(agentId) ?? null, agentIds: () => [...running.keys()] });
      ctx.manager.noteHostedContextViewSession("agent-hosted", session, true);
      await waitFor(() => availability(ctx).length === 1, "availability at the session's start");
      assert.deepEqual(
        [(availability(ctx)[0] as { runtime?: string }).runtime, (availability(ctx)[0] as { supported?: boolean }).supported],
        ["codex", true],
      );

      // A send is indexed under the agent's own server.
      ctx.manager.noteHostedMessageCommitted("agent-hosted", { messageId: "m-hosted", route: "send" });
      const index = path.join(slockHome, "agent-context", "srv_cv", "agent-hosted", "index.jsonl");
      await waitFor(() => existsSync(index), "index line under the agent's server");

      // A new connection reports it again, as a running agent.
      ctx.manager.reportAgentContextViewAvailability("ready");
      await waitFor(() => availability(ctx).length === 2, "availability after a ready");

      // Its session ended: its message can still be viewed.
      running.clear();
      await ctx.manager.handleAgentContextViewRequest({
        type: "agent:context_view_request",
        requestId: "ctxv_0123456789abcdef0123",
        agentId: "agent-hosted",
        messageId: "m-hosted",
        maxBytes: 1_000_000,
      });
      assert.equal(posts.length, 1);
      // It found the index line and the rollout: the restore child (no binary under test) is as far as this goes.
      const handled = ctx.events.filter((event) => event.name === "daemon.agent_context_view.request").at(-1)?.attrs;
      assert.deepEqual([handled?.runtime, handled?.source, handled?.restore_child], ["codex", "index", true]);

      // Back on this host and stopped: nothing of the session on the other host is read.
      await ctx.manager.startAgent("agent-hosted", makeConfig({ sessionId: "session-legacy", enabledApps: [] }));
      await ctx.manager.stopAgent("agent-hosted", { wait: true });
      assert.equal((ctx.manager as any).contextViewAgentFacts("agent-hosted").sessionId, null);
    }, undefined, { slockHome, fetchImpl, connectedServerId: () => "srv_cv" });
  } finally {
    await rm(slockHome, { recursive: true, force: true });
  }
});

// Reconciler step 6, the coordinator's review: input written into a running
// turn may be run by the runtime as a turn of its own right after turn_end
// (Claude Code queues it), and that turn's own events already counted it
// consumed. A stop at that turn end would kill the queued turn. The idle
// fact `queuedInputPending` (agentIdle.ts) holds it, only when such a write
// landed. RED proof: drop `queuedInputPending` from the legacy idle facts and
// the first test's process is stopped at the turn end.
test("input written into the running turn: not stopped at its turn end; the runtime runs it as a turn of its own; stopped at that turn's end", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startBusyWithNoticeWrittenMidTurn(ctx, "agent-queued-input");
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    emitTurnEnd(ctx, "agent-queued-input");
    assert.equal(ap.gatedSteering.isIdle, true, "precondition: the daemon reads the turn as over");
    assert.equal(child.killed, false, "the runtime may run what it was told as its next turn");
    assert.equal((ctx.manager as any).agentNotIdle("agent-queued-input", ap), "delivery_in_flight");

    // Claude takes the queued notice up as a turn of its own.
    emitText(ctx, "agent-queued-input");
    await sleep(120);
    await (ctx.manager as any).sweepColdIdleRuntimes();
    assert.equal(child.killed, false, "not under the turn it runs, past the window and through a sweep");

    emitTurnEnd(ctx, "agent-queued-input");
    assert.equal(child.kills, 1);
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["turn_end"]);
  }, new FakeClaudeDriver(), { queuedInputSettleMs: 60 });
});

test("input written into the running turn that starts no turn within the window: stopped then, traced as such", async () => {
  await withManager(async (ctx) => {
    const { child } = await startBusyWithNoticeWrittenMidTurn(ctx, "agent-queued-settled");
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    emitTurnEnd(ctx, "agent-queued-settled");
    assert.equal(child.killed, false);
    await waitFor(() => child.killed, "the stop once the window passed");
    assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["queued_input_settled"]);
  }, new FakeClaudeDriver(), { queuedInputSettleMs: 60 });
});

test("the window's timer firing before the wall clock has moved the window still stops the agent", async () => {
  // A Node timer may fire up to a millisecond before `Date.now()` has moved
  // its full delay; the window has then not passed by the clock the decision
  // reads, and nothing else decided again (staging CI: the stop never came).
  // Here the wall clock lags the timers by 20 ms after the turn end: the
  // first firing is early by it. RED proof: deciding only once when the
  // timer fires fails this test.
  const realNow = Date.now;
  try {
    await withManager(async (ctx) => {
      const { child } = await startBusyWithNoticeWrittenMidTurn(ctx, "agent-queued-early-timer");
      ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
      emitTurnEnd(ctx, "agent-queued-early-timer");
      Date.now = () => realNow.call(Date) - 20;
      assert.equal(child.killed, false);
      await waitFor(() => child.killed, "the stop once the window passed");
      assert.deepEqual(featuresStops(ctx).map((stop) => stop.trigger), ["queued_input_settled"]);
    }, new FakeClaudeDriver(), { queuedInputSettleMs: 60 });
  } finally {
    Date.now = realNow;
  }
});
