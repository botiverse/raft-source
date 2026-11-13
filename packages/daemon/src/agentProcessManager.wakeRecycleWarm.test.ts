// Warm wake recycle on the legacy host (#proj-runtime:#54, RFC 070 §6.5;
// the rule is wakeRecycleWarm.ts). With the Server's `wake_recycle_warm` on, a
// Claude session whose last request carried more than 250k (on a window of at
// least 400k) is marked at a clean turn end with nothing running, held or
// queued; stopped through the cold-idle stop after two quiet minutes (at once
// past 500k); and the next start gives it a fresh session with the notice,
// whatever the gap. Off, nothing changes.
// RED proofs: drop `maybeMarkWarmRecycle` from the idle edge and nothing is
// marked; drop `cancelWarmRecycle` from `deliverMessage` and a delivery inside
// the window no longer keeps the session; drop `warmStop` from the start's
// `planWakeSessionRecycle` and the next start resumes (cache possibly warm);
// drop the `decline` after a resumed warm stop and the resumed session is
// stopped again at its next turn end; drop `takeYield` and a cancelled mark
// starves turn-end compaction; drop `dropPending` from the close or the stop
// and the quiet timer fires a `not_idle` cancel for a process already gone.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { onTestFinished, test, vi } from "vitest";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { buildWarmRecycleNotice } from "./wakeSessionRecycle";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  killed = false;
  kill(): boolean {
    this.killed = true;
    // SIGTERM, as the daemon sends: node reports code 143 with the signal.
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
    return true;
  }
}

/** Claude's shape (agentProcessManager.turnEndCompaction.test.ts). */
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
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  readonly encodedCalls: string[] = [];
  currentSessionId: string | null = null;
  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const proc = new FakeChildProcess();
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }
  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }
  encodeStdinMessage(text?: string): string | null {
    if (!text) return null;
    this.encodedCalls.push(text);
    return JSON.stringify({ text });
  }
  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

const AGENT = "agent-1";
const SESSION = "session-warm-1";
const MIN_MS = 60_000;

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "claude-agent",
  displayName: "Claude Agent",
  description: "test agent",
  model: "opus",
  runtime: "claude",
  reasoningEffort: null,
  envVars: null,
  sessionId: SESSION,
  serverUrl: "http://localhost:3001",
  authToken: "sk_machine_test",
  agentCredentialKey: "sk_agent_test",
  agentCredentialId: null,
  wakeRecycleWarm: true,
  ...overrides,
});

const message = (content: string, overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  channel_id: "channel-1",
  channel_name: "general",
  channel_type: "channel",
  sender_id: "user-1",
  sender_name: "richard",
  sender_type: "human",
  content,
  timestamp: new Date().toISOString(),
  ...overrides,
});

const usage = (lastRequestContextTokens: number, modelUsageMaxContextWindow: number): ParsedEvent => ({
  kind: "telemetry",
  name: "token_usage",
  source: "claude_result_usage",
  usageKind: "per_turn",
  attrs: { inputTokens: 10, outputTokens: 5, lastRequestContextTokens, modelUsageMaxContextWindow },
});

/** The session's transcript as the next start reads it: last activity just now, so no cold rule can recycle it. */
async function writeWarmTranscript(homeDir: string, sessionId: string, contextTokens: number): Promise<void> {
  const projectDir = path.join(homeDir, ".claude", "projects", "-workspace-agent");
  await mkdir(projectDir, { recursive: true });
  const record = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { usage: { input_tokens: 12, cache_read_input_tokens: contextTokens - 12, cache_creation_input_tokens: 0 } },
  };
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify(record) + "\n");
}

type Ctx = {
  driver: FakeClaudeDriver;
  manager: AgentProcessManager;
  dataDir: string;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  /** Run pending work; `ms` moves the (fake) clock. */
  tick: (ms?: number) => Promise<void>;
  emit: (process: number, ...lines: string[]) => Promise<void>;
};

async function withManager(fn: (ctx: Ctx) => Promise<void>, opts: { detectedRuntimeCliVersion?: () => string | undefined } = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-wake-recycle-warm-"));
  const driver = new FakeClaudeDriver();
  const manager = new AgentProcessManager(() => undefined, "sk_machine_test", {
    dataDir,
    serverUrl: "https://daemon.example.com",
    driverResolver: () => driver,
    runtimeSessionHomeDir: dataDir,
    // Past the cold-idle version floor: the event stream shows every background task.
    detectedRuntimeCliVersion: () => "2.1.304 (Claude Code)",
    ...opts,
  });
  const events: Ctx["events"] = [];
  const internal = manager as any;
  const record = internal.recordDaemonEvent.bind(internal);
  internal.recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return record(name, attrs, ...rest);
  };
  const tick = async (ms = 0) => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  };
  const emit = async (process: number, ...lines: string[]) => {
    for (const line of lines) {
      driver.processes[process]!.stdout.emit("data", Buffer.from(`${line}\n`));
      await tick();
    }
  };
  onTestFinished(() => { vi.useRealTimers(); });
  try {
    await fn({ driver, manager, dataDir, events, tick, emit });
  } finally {
    vi.useRealTimers();
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });

/**
 * Start the agent and end a turn that reports `context` tokens on a
 * `window`-token model, on a fake clock from the turn end on. `before` runs
 * with the turn still open.
 */
async function turnEndingWith(ctx: Ctx, context: number, window: number, overrides: Partial<AgentConfig> = {}, before?: (ap: any) => void, turnEnd: ParsedEvent = { kind: "turn_end", sessionId: SESSION }): Promise<any> {
  const { driver, manager, emit } = ctx;
  await manager.startAgent(AGENT, config(overrides));
  const process = driver.processes.length - 1;
  const internal = manager as any;
  const ap = internal.agents.get(AGENT);
  internal.commitApmIdleState(AGENT, ap, false);
  before?.(ap);
  driver.parsedLines.set("usage", [usage(context, window)]);
  driver.parsedLines.set("turn-end", [turnEnd]);
  fakeClock();
  await emit(process, "usage", "turn-end");
  return ap;
}

const named = (ctx: Ctx, name: string) => ctx.events.filter((event) => event.name === name).map((event) => event.attrs);
const marks = (ctx: Ctx) => named(ctx, "daemon.agent.wake_recycle.warm_marked");
const stops = (ctx: Ctx) => named(ctx, "daemon.agent.wake_recycle.warm_stopped");
const cancels = (ctx: Ctx) => named(ctx, "daemon.agent.wake_recycle.warm_cancelled");
const compactions = (ctx: Ctx) => named(ctx, "daemon.agent.turn_end_compaction");

test("§6.5: past 250k on a 1M window the session is marked, stopped after two quiet minutes the cold-idle way, and the next start recycles it with the notice", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, dataDir, tick } = ctx;
    const ap = await turnEndingWith(ctx, 300_000, 1_000_000);
    assert.deepEqual(marks(ctx), [{
      agentId: AGENT,
      launchId: undefined,
      runtime: "claude",
      host: "legacy",
      session_id: SESSION,
      context_tokens: 300_000,
      window_tokens: 1_000_000,
      band: "quiet",
      threshold_tokens: 250_000,
      ceiling_tokens: 500_000,
      quiet_ms: 2 * MIN_MS,
    }]);

    await tick(2 * MIN_MS - 1_000);
    assert.equal(driver.processes[0]!.killed, false, "inside the quiet period: still running");
    assert.deepEqual(stops(ctx), []);

    await tick(1_000);
    assert.equal(driver.processes[0]!.killed, true, "two minutes with no delivery: stopped");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle", "the cold-idle stop, not a second mechanism");
    assert.deepEqual(stops(ctx), [{
      agentId: AGENT,
      launchId: undefined,
      runtime: "claude",
      host: "legacy",
      session_id: SESSION,
      context_tokens: 300_000,
      window_tokens: 1_000_000,
      band: "quiet",
      waited_ms: 2 * MIN_MS,
    }]);
    assert.deepEqual(cancels(ctx), []);
    await tick();
    assert.equal((manager as any).agents.has(AGENT), false, "the process is gone");

    // The next start, seconds later: nowhere near the cold gap, recycled all the same.
    vi.useRealTimers();
    await writeWarmTranscript(dataDir, SESSION, 300_000);
    await manager.startAgent(AGENT, config(), message("next reminder"));
    assert.equal(driver.spawnCalls.length, 2);
    const spawn = driver.spawnCalls[1]!;
    assert.equal(spawn.config.sessionId, null, "a fresh session, not a resume");
    assert.ok(String(spawn.prompt).startsWith(String(buildWarmRecycleNotice())), "the first input opens with the warm notice");
    assert.match(String(spawn.prompt), /next reminder/, "the wake message still delivers");
    const recycle = named(ctx, "daemon.agent.wake_recycle");
    assert.equal(recycle.length, 1);
    assert.equal(recycle[0]!.reason, "warm_recycle");
    assert.equal(recycle[0]!.recycle_kind, "warm");
    assert.equal(recycle[0]!.band, "quiet");
    assert.equal(recycle[0]!.trigger_kind, "message");
    assert.equal(typeof recycle[0]!.gap_since_stop_ms, "number");
    assert.equal(recycle[0]!.prior_session_id, SESSION);
    assert.equal(recycle[0]!.prior_context_tokens, 300_000);
  });
});

test("§6.5: a delivery inside the quiet period keeps the session; the next clean turn end decides again", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, tick } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    assert.equal(marks(ctx).length, 1);

    await tick(MIN_MS);
    assert.equal(await manager.deliverMessage(AGENT, message("are you there?", { sender_type: "agent" })), true);
    assert.deepEqual(cancels(ctx).map((attrs) => [attrs.reason, attrs.sender_kind, attrs.waited_ms, attrs.band, attrs.host]), [["delivery", "agent", MIN_MS, "quiet", "legacy"]]);
    assert.ok(!("session_id" in cancels(ctx)[0]!), "counts only: no ids");

    await tick(5 * MIN_MS);
    assert.equal(driver.processes[0]!.killed, false, "the delivery landed in the same session");
    assert.deepEqual(stops(ctx), []);
    assert.equal(cancels(ctx).length, 1, "cancelled once");
  });
});

test("§6.5: past the 500k ceiling the session is stopped at the first clean turn end, with no wait", async () => {
  await withManager(async (ctx) => {
    const { driver } = ctx;
    const ap = await turnEndingWith(ctx, 600_000, 1_000_000);
    assert.deepEqual(marks(ctx).map((attrs) => attrs.band), ["ceiling"]);
    assert.equal(driver.processes[0]!.killed, true);
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle");
    assert.deepEqual(stops(ctx).map((attrs) => [attrs.band, attrs.waited_ms, attrs.context_tokens]), [["ceiling", 0, 600_000]]);
  });
});

test("§6.5: a running background task, a delivery not yet told, an interrupted turn, a small window or an old Claude Code: no mark", async () => {
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 600_000, 1_000_000, {}, (ap) => { ap.backgroundTasks.set("task-1", { taskId: "task-1" }); });
    await ctx.tick(5 * MIN_MS);
    assert.deepEqual(marks(ctx), [], "a sub-agent or background task holds it");
    assert.equal(ctx.driver.processes[0]!.killed, false);
  });
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 600_000, 1_000_000, {}, (ap) => { ap.inbox.push(message("not told yet", { message_id: "m-untold", seq: 7 } as Partial<AgentMessage>)); });
    assert.deepEqual(marks(ctx), [], "a held delivery holds it");
    assert.deepEqual(stops(ctx), []);
  });
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 600_000, 1_000_000, {}, undefined, { kind: "turn_end", sessionId: SESSION, interrupted: true });
    await ctx.tick(5 * MIN_MS);
    assert.deepEqual(marks(ctx), [], "an interrupted turn is not a clean turn end");
    assert.equal(ctx.driver.processes[0]!.killed, false);
  });
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 180_000, 200_000);
    await ctx.tick(5 * MIN_MS);
    assert.deepEqual(marks(ctx), [], "a 200k window keeps the runtime's own compaction");
  });
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 600_000, 1_000_000);
    await ctx.tick(5 * MIN_MS);
    assert.deepEqual(marks(ctx), [], "below the cold-idle version floor background tasks are not all visible");
    assert.equal(ctx.driver.processes[0]!.killed, false);
  }, { detectedRuntimeCliVersion: () => "2.1.219 (Claude Code)" });
});

test("§6.5: the flag off, or the local RAFT_WAKE_RECYCLE=0, is today's behaviour: no mark, no stop", async () => {
  for (const overrides of [{ wakeRecycleWarm: undefined }, { wakeRecycleWarm: false }, { envVars: { RAFT_WAKE_RECYCLE: "0" } }] as Partial<AgentConfig>[]) {
    await withManager(async (ctx) => {
      await turnEndingWith(ctx, 600_000, 1_000_000, overrides);
      await ctx.tick(5 * MIN_MS);
      assert.deepEqual(marks(ctx), []);
      assert.deepEqual(stops(ctx), []);
      assert.equal(ctx.driver.processes[0]!.killed, false);
    });
  }
});

test("§6.5: the thresholds follow the agent's env", async () => {
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 120_000, 300_000, { envVars: {
      RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: "100000",
      RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS: "250000",
      RAFT_WAKE_RECYCLE_WARM_QUIET_MS: "30000",
      RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: "200000",
    } });
    assert.deepEqual(marks(ctx).map((attrs) => [attrs.band, attrs.threshold_tokens, attrs.ceiling_tokens, attrs.quiet_ms]), [["quiet", 100_000, 200_000, 30_000]]);
    await ctx.tick(30_000);
    assert.deepEqual(stops(ctx).map((attrs) => attrs.waited_ms), [30_000]);
  });
});

test("§6.5: with turn_end_compaction also on, warm recycle goes first; where its gate does not pass, compaction acts as before", async () => {
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 300_000, 1_000_000, { turnEndCompaction: true });
    assert.equal(marks(ctx).length, 1);
    assert.deepEqual(ctx.driver.encodedCalls.filter((text) => text === "/compact"), [], "no /compact for a session about to be replaced");
    assert.deepEqual(compactions(ctx), [], "the compaction gate was not even asked");
  });
  await withManager(async (ctx) => {
    // Below the cold-idle version floor the warm gate does not pass: /compact, as with the flag off.
    await turnEndingWith(ctx, 300_000, 1_000_000, { turnEndCompaction: true });
    assert.deepEqual(marks(ctx), []);
    assert.deepEqual(ctx.driver.encodedCalls.filter((text) => text === "/compact"), ["/compact"]);
    assert.ok(compactions(ctx).some((attrs) => attrs.outcome === "started"));
  }, { detectedRuntimeCliVersion: () => undefined });
});

test("§6.5: a recycled session starts small and is not marked again; the stop is forgotten once a start has read it", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, dataDir, emit, tick } = ctx;
    await turnEndingWith(ctx, 600_000, 1_000_000);
    assert.equal(stops(ctx).length, 1);
    await tick();
    vi.useRealTimers();
    await writeWarmTranscript(dataDir, SESSION, 600_000);
    await manager.startAgent(AGENT, config(), message("go on"));
    assert.equal(driver.spawnCalls[1]!.config.sessionId, null, "recycled");

    // The fresh session's first turn: a small context.
    const internal = manager as any;
    const ap = internal.agents.get(AGENT);
    driver.parsedLines.set("init", [{ kind: "session_init", sessionId: "session-fresh" }]);
    driver.parsedLines.set("usage", [usage(30_000, 1_000_000)]);
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-fresh" }]);
    fakeClock();
    await emit(1, "init", "usage", "turn-end");
    await tick(5 * MIN_MS);
    assert.equal(marks(ctx).length, 1, "only the first session's mark");
    assert.equal(stops(ctx).length, 1);
    assert.equal(driver.processes[1]!.killed, false, "no loop");
    assert.equal(internal.agents.get(AGENT), ap);
    assert.equal(internal.warmRecycle.takeStopped(AGENT), null, "nothing remembered after the recycle");
  });
});

test("§6.5: a start that resumes for another reason (a caller's resume prompt) forgets the stop, and that session is never marked again", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, dataDir, emit, tick } = ctx;
    await turnEndingWith(ctx, 600_000, 1_000_000);
    assert.equal(stops(ctx).length, 1);
    await tick();
    vi.useRealTimers();
    await writeWarmTranscript(dataDir, SESSION, 600_000);
    await manager.startAgent(AGENT, config(), undefined, undefined, "continue where you were");
    assert.equal(driver.spawnCalls[1]!.config.sessionId, SESSION, "resumed: the caller's resume prompt excludes a recycle");
    assert.deepEqual(named(ctx, "daemon.agent.wake_recycle"), []);
    const skipped = named(ctx, "daemon.agent.wake_recycle_skipped");
    assert.deepEqual(skipped.map((attrs) => attrs.reason), ["session_facts_unavailable", "explicit_resume_prompt"]);
    assert.ok(!("warm_stop_dropped" in skipped[0]!), "no warm stop was remembered for the first start");
    assert.equal(skipped[1]!.warm_stop_dropped, true, "the dropped warm stop is visible");
    assert.equal(skipped[1]!.band, "ceiling");
    assert.equal((manager as any).warmRecycle.takeStopped(AGENT), null, "the mark is gone");

    // The resumed session ends a clean turn, still past the ceiling: not marked, not stopped (no loop).
    const internal = manager as any;
    const ap = internal.agents.get(AGENT);
    internal.commitApmIdleState(AGENT, ap, false);
    driver.parsedLines.set("usage", [usage(600_000, 1_000_000)]);
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: SESSION }]);
    fakeClock();
    await emit(1, "usage", "turn-end");
    await tick(5 * MIN_MS);
    assert.equal(marks(ctx).length, 1, "only the first process's mark");
    assert.equal(stops(ctx).length, 1);
    assert.equal(driver.processes[1]!.killed, false, "the resumed session keeps running");
    assert.equal(internal.agents.get(AGENT), ap);
  });
});

test("§6.5: with both flags on, a mark a delivery cancelled leaves the next turn end to compaction (no starvation)", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, emit, tick } = ctx;
    const ap = await turnEndingWith(ctx, 300_000, 1_000_000, { turnEndCompaction: true });
    assert.equal(marks(ctx).length, 1);
    assert.deepEqual(compactions(ctx), [], "the marked turn end skipped compaction");

    // A message's turn opens inside the quiet period. Driven at the turn
    // trace's start (where every turn, a delivered message's included,
    // cancels the mark; deliverMessage's own cancel is the delivery test
    // above), not through deliverMessage: in this harness nothing reads the
    // message (no `raft inbox check`), so the inbox writes it again at the
    // turn end and the idle edge this test needs never comes
    // (agentProcessManager.turnEndCompaction.test.ts drives its turns
    // directly for the same reason).
    const internal = manager as any;
    internal.startRuntimeTrace(AGENT, ap, "stdin-idle-delivery", [message("one more thing")]);
    assert.deepEqual(cancels(ctx).map((attrs) => [attrs.reason, attrs.sender_kind]), [["delivery", "human"]]);
    internal.commitApmIdleState(AGENT, ap, false);
    await emit(0, "usage", "turn-end");
    assert.equal(marks(ctx).length, 1, "this turn end is not marked again");
    assert.ok(compactions(ctx).length > 0, "the compaction gate is asked, as with the warm flag off");
    assert.ok(compactions(ctx).some((attrs) => attrs.outcome === "started"));
    assert.deepEqual(driver.encodedCalls.filter((text) => text === "/compact"), ["/compact"]);
    await tick(5 * MIN_MS);
    assert.deepEqual(stops(ctx), []);
    assert.equal(driver.processes[0]!.killed, false);
  });
});

test("§6.5: the warm flag off leaves turn-end compaction as it was: /compact at the same turn end, no warm event", async () => {
  for (const overrides of [{ wakeRecycleWarm: undefined }, { wakeRecycleWarm: false }] as Partial<AgentConfig>[]) {
    await withManager(async (ctx) => {
      await turnEndingWith(ctx, 600_000, 1_000_000, { ...overrides, turnEndCompaction: true });
      assert.deepEqual(ctx.driver.encodedCalls.filter((text) => text === "/compact"), ["/compact"]);
      assert.ok(compactions(ctx).some((attrs) => attrs.outcome === "started"));
      await ctx.tick(5 * MIN_MS);
      assert.deepEqual(ctx.events.filter((event) => event.name.startsWith("daemon.agent.wake_recycle.warm_")), []);
      assert.equal(ctx.driver.processes[0]!.killed, false, "even past the warm ceiling");
    });
  }
});

test("§6.5: a crash or an explicit stop inside the quiet period ends the mark and its timer, with no warm_cancelled", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, tick } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    assert.equal(marks(ctx).length, 1);
    driver.processes[0]!.kill();
    await tick();
    assert.equal((manager as any).warmRecycle.pending(AGENT), null, "gone with the process");
    await tick(5 * MIN_MS);
    assert.deepEqual(cancels(ctx), [], "no not_idle cancel from a timer that outlived the process");
    assert.deepEqual(stops(ctx), []);
    assert.equal((manager as any).warmRecycle.takeStopped(AGENT), null, "nothing remembered for the next start");
  });
  await withManager(async (ctx) => {
    const { manager, tick } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    assert.equal(marks(ctx).length, 1);
    await manager.stopAgent(AGENT);
    await tick();
    assert.equal((manager as any).warmRecycle.pending(AGENT), null);
    await tick(5 * MIN_MS);
    assert.deepEqual(cancels(ctx), []);
    assert.deepEqual(stops(ctx), []);
  });
});
