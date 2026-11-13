// The periodic sweep's background task health check (backgroundTaskHealth.ts)
// and the long idle-hold trace (agentIdleHold.ts) in the agent manager. A
// background task whose end event was lost would hold every idle-gated
// rotation and restart forever; the sweep presumes it ended after an hour of
// silence, unless the runtime still runs a process started since the task did.
//
// RED proof: drop the sweep call and the silent task is never removed; drop
// the lastEventAtMs refresh and the task with an event at minute 50 is removed
// at minute 61; drop the descendant verdict and the task with a live build is
// removed; drop the features gate's observation and no idle_hold_long fires.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.serverFeatures.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import type { ProcessTreeEntry } from "./drivers/processTree";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

const MIN = 60_000;
const RUNTIME_PID = 4242;

class FakeChildProcess extends EventEmitter {
  readonly pid = RUNTIME_PID;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true };
  kills = 0;

  get killed(): boolean {
    return this.kills > 0;
  }

  kill(): boolean {
    this.kills += 1;
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
    return true;
  }
}

class FakeClaudeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();

  spawn(_ctx: SpawnContext): SpawnResult {
    const child = new FakeChildProcess();
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

type TreeAnswer = readonly ProcessTreeEntry[] | null | Error;
type Ctx = {
  driver: FakeClaudeDriver;
  manager: AgentProcessManager;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  sent: MachineToServerMessage[];
  /** What the next tree reads answer (an Error throws). */
  tree: { answer: TreeAnswer; reads: number[] };
  /** Move the manager's clock. */
  setNow: (ms: number) => void;
};

async function withManager(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-bg-task-health-test-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeClaudeDriver();
  const tree: Ctx["tree"] = { answer: [], reads: [] };
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
      readRuntimeDescendants: async (pid) => {
        tree.reads.push(pid);
        if (tree.answer instanceof Error) throw tree.answer;
        return tree.answer;
      },
    },
  );
  const events: Ctx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, events, sent, tree, setNow: (ms) => { (manager as any).frozenClockMs = ms; } });
  } finally {
    (manager as any).frozenClockMs = null;
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function startIdle(ctx: Ctx, agentId: string, config: Partial<AgentConfig> = {}) {
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId: `session-${agentId}`, ...config }));
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = `session-${agentId}`;
  (ctx.manager as any).commitApmIdleState(agentId, ap, true);
  return ap;
}

function emitTask(ctx: Ctx, phase: "started" | "progress", taskId: string): void {
  const line = `${taskId}-${phase}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{
    kind: "subagent_progress",
    source: "claude_task_lifecycle",
    phase,
    taskId,
    parentToolUseId: `toolu_${taskId}`,
    subagentType: "general-purpose",
    taskKind: "agent",
    payloadBytes: 64,
  } as ParsedEvent]);
  ctx.driver.processes[0]!.stdout.emit("data", Buffer.from(`${line}\n`));
}

const sweep = (ctx: Ctx) => (ctx.manager as any).sweepColdIdleRuntimes() as Promise<void>;
const presumed = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.runtime.background_task.presumed_ended").map((event) => event.attrs);
const lastActivityDetail = (ctx: Ctx) => (ctx.sent.filter((msg) => msg.type === "agent:activity").at(-1) as { detail?: string } | undefined)?.detail;

test("a started task with no further event is presumed ended after an hour of silence, traced, and the quiet status says Idle", async () => {
  await withManager(async (ctx) => {
    const t0 = Date.now();
    ctx.setNow(t0);
    const ap = await startIdle(ctx, "agent-1");
    emitTask(ctx, "started", "task_a");
    // The real order: the Agent tool returns at once, then the main turn ends.
    ctx.driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-agent-1" }]);
    ctx.driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 1);
    assert.equal(lastActivityDetail(ctx), "Waiting for 1 background task");

    ctx.setNow(t0 + 59 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 1, "not silent long enough");
    assert.deepEqual(ctx.tree.reads, [], "no tree read without a silent candidate");

    // Only a descendant from before the task (an MCP server) is alive.
    ctx.tree.answer = [{ pid: 7, pgid: 7, startedAtMs: t0 - 30 * MIN }];
    ctx.setNow(t0 + 61 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 0);
    assert.deepEqual(ctx.tree.reads, [RUNTIME_PID]);
    assert.deepEqual(presumed(ctx), [{
      agentId: "agent-1",
      launchId: ap.launchId || undefined,
      runtime: "claude",
      task_kind: "agent",
      subagent_type: "general-purpose",
      age_ms: 61 * MIN,
      silent_ms: 61 * MIN,
      removed: true,
      descendants_alive: 0,
      background_tasks_outstanding: 0,
    }]);
    assert.equal(lastActivityDetail(ctx), "Idle");
    assert.equal(ap.subagentResultUnread ?? false, false, "no result to read");
    assert.equal(ctx.events.some((event) => event.name === "daemon.runtime.subagent.finished_wake"), false, "no wake");
  });
});

test("an event at minute 50 keeps the task alive past minute 60", async () => {
  await withManager(async (ctx) => {
    const t0 = Date.now();
    ctx.setNow(t0);
    const ap = await startIdle(ctx, "agent-1");
    emitTask(ctx, "started", "task_a");
    await flush();
    ctx.setNow(t0 + 50 * MIN);
    emitTask(ctx, "progress", "task_a");
    await flush();

    ctx.setNow(t0 + 61 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 1);
    assert.deepEqual(presumed(ctx), []);

    ctx.setNow(t0 + 111 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 0, "silent for an hour since its last event");
    assert.equal(presumed(ctx)[0]?.silent_ms, 61 * MIN);
    assert.equal(presumed(ctx)[0]?.age_ms, 111 * MIN);
  });
});

test("a busy sub-agent's own rows keep its task alive without any task-progress event; a row of another call does not", async () => {
  await withManager(async (ctx) => {
    const t0 = Date.now();
    ctx.setNow(t0);
    const ap = await startIdle(ctx, "agent-1");
    emitTask(ctx, "started", "task_a");
    emitTask(ctx, "started", "task_b");
    await flush();
    const row = (parentToolUseId: string, n: number) => {
      const line = `row-${parentToolUseId}-${n}`;
      ctx.driver.parsedLines.set(line, [{ kind: "tool_call", name: "Grep", input: {}, subagent: { parentToolUseId, subagentType: "general-purpose", phase: "active" } } as ParsedEvent]);
      ctx.driver.processes[0]!.stdout.emit("data", Buffer.from(`${line}\n`));
    };
    // task_a's sub-agent works every 10 minutes; nothing names task_b.
    for (let minute = 10; minute <= 70; minute += 10) {
      ctx.setNow(t0 + minute * MIN);
      row("toolu_task_a", minute);
      row("toolu_unknown", minute);
      await flush();
    }
    ctx.setNow(t0 + 75 * MIN);
    await sweep(ctx);
    assert.deepEqual([...ap.backgroundTasks.keys()], ["task_a"]);
    assert.deepEqual(presumed(ctx).map((attrs) => [attrs.removed, attrs.silent_ms]), [[true, 75 * MIN]], "task_b only");
  });
});

test("a live process started after the task, or an unreadable tree, keeps it; a kept candidate is re-traced at most hourly", async () => {
  await withManager(async (ctx) => {
    const t0 = Date.now();
    ctx.setNow(t0);
    const ap = await startIdle(ctx, "agent-1");
    emitTask(ctx, "started", "task_a");
    await flush();

    ctx.tree.answer = [{ pid: 8, pgid: 8, startedAtMs: t0 + 2 * MIN }]; // the task's long build
    ctx.setNow(t0 + 61 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 1);
    assert.deepEqual(presumed(ctx).map((attrs) => [attrs.removed, attrs.descendants_alive, attrs.tree_unreadable, attrs.background_tasks_outstanding]), [[false, 1, undefined, 1]]);
    assert.notEqual(lastActivityDetail(ctx), "Idle", "a kept task re-states nothing");

    ctx.tree.answer = new Error("ps failed");
    ctx.setNow(t0 + 71 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 1, "an unreadable tree holds it");
    assert.equal(presumed(ctx).length, 1, "not re-traced within the hour");

    ctx.tree.answer = null;
    ctx.setNow(t0 + 122 * MIN);
    await sweep(ctx);
    assert.equal(ap.backgroundTasks.size, 1);
    assert.deepEqual(presumed(ctx).at(-1), {
      agentId: "agent-1",
      launchId: ap.launchId || undefined,
      runtime: "claude",
      task_kind: "agent",
      subagent_type: "general-purpose",
      age_ms: 122 * MIN,
      silent_ms: 122 * MIN,
      removed: false,
      tree_unreadable: true,
      background_tasks_outstanding: 1,
    });
  });
});

test("a features restart held by the same reason for 30 minutes is traced once, from the sweep", async () => {
  await withManager(async (ctx) => {
    const t0 = Date.now();
    ctx.setNow(t0);
    const ap = await startIdle(ctx, "agent-1", { enabledApps: [] });
    emitTask(ctx, "started", "task_a");
    await flush();
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.equal(ctx.driver.processes[0]!.killed, false, "held by the background task");
    const holds = () => ctx.events.filter((event) => event.name === "daemon.agent.idle_hold_long").map((event) => event.attrs);

    ctx.tree.answer = [{ pid: 8, pgid: 8, startedAtMs: t0 + MIN }];
    ctx.setNow(t0 + 29 * MIN);
    await sweep(ctx);
    assert.deepEqual(holds(), []);

    ctx.setNow(t0 + 30 * MIN);
    await sweep(ctx);
    assert.deepEqual(holds(), [{
      agentId: "agent-1",
      launchId: ap.launchId || undefined,
      runtime: "claude",
      gate: "spec_restart",
      reason: "background_tasks",
      held_ms: 30 * MIN,
    }]);

    ctx.setNow(t0 + 50 * MIN);
    await sweep(ctx);
    assert.equal(holds().length, 1, "once per hold episode");
    assert.equal(ctx.driver.processes[0]!.killed, false);
  });
});
