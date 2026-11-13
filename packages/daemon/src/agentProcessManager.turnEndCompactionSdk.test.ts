// #proj-runtime:#54 phase 3, in-process runtimes (Pi, Built-in, Kimi SDK): the
// turn-end compaction goes through the runtime session's own
// `compactAtTurnEnd()`, with the same decision and preconditions as Claude's
// `/compact`. A fake child-process driver stands in, its runtime session given
// the two hooks the SDK sessions implement (drivers/pi.ts, drivers/kimi-sdk.ts).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { createChildProcessRuntimeSession, type ParsedEvent, type RuntimeDriver, type RuntimeSession, type SpawnContext, type SpawnResult } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import type { TurnEndCompactionDriverOutcome, TurnEndContextFacts } from "./turnEndCompaction";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  kill(): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

class FakeSdkDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
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
  readonly encoded: string[] = [];
  currentSessionId: string | null = null;
  facts: TurnEndContextFacts = { contextTokens: 300_000, windowTokens: 1_000_000 };
  outcomes: TurnEndCompactionDriverOutcome[] = [];
  compactCalls = 0;
  /** Lines the runtime reports while it compacts (its own compaction events). */
  duringCompact: string[] = [];
  /** When set, the compaction call stays open until it resolves. */
  gate: Promise<void> | null = null;
  /** The order things happened in: "cancel" when the manager cancels, "write:<text>" for each delivery written. */
  readonly order: string[] = [];
  /** When set, the session offers cancelTurnEndCompaction (and records it in `order`). */
  cancellable = false;
  emit: ((line: string) => Promise<void>) | null = null;
  constructor(readonly id: string) {}
  spawn(_ctx: SpawnContext): SpawnResult {
    const proc = new FakeChildProcess();
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }
  createSession(ctx: SpawnContext): RuntimeSession {
    const runtime = createChildProcessRuntimeSession(this, ctx);
    return Object.assign(runtime, {
      turnEndContextFacts: async () => this.facts,
      compactAtTurnEnd: async (): Promise<TurnEndCompactionDriverOutcome> => {
        this.compactCalls += 1;
        for (const line of this.duringCompact) await this.emit?.(line);
        if (this.gate) await this.gate;
        return this.outcomes.shift() ?? { kind: "completed" };
      },
      ...(this.cancellable ? { cancelTurnEndCompaction: async () => { this.order.push("cancel"); } } : {}),
    });
  }
  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }
  encodeStdinMessage(text?: string): string | null {
    if (!text) return null;
    this.encoded.push(text);
    this.order.push(`write`);
    return JSON.stringify({ text });
  }
  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("sdk standing prompt");
  }
}

const config = (runtime: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "sdk-agent",
  displayName: "SDK Agent",
  description: "test agent",
  model: "test-model",
  runtime,
  reasoningEffort: null,
  envVars: null,
  sessionId: "session-1",
  serverUrl: "http://localhost:3001",
  authToken: "sk_machine_test",
  agentCredentialKey: "sk_agent_test",
  agentCredentialId: null,
  turnEndCompaction: true,
  ...overrides,
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

interface Ctx {
  driver: FakeSdkDriver;
  manager: AgentProcessManager;
  events: Array<Record<string, unknown>>;
  idleNotices: string[];
  activity: Array<{ detail?: string; detailKind?: string }>;
  emit: (...lines: string[]) => Promise<void>;
}

async function withManager(runtime: string, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-turn-end-compaction-sdk-"));
  const driver = new FakeSdkDriver(runtime);
  const idleNotices: string[] = [];
  const activity: Array<{ detail?: string; detailKind?: string }> = [];
  const manager = new AgentProcessManager((frame: any) => {
    if (frame?.type === "agent:activity") activity.push({ detail: frame.detail, detailKind: frame.detailKind });
  }, "sk_machine_test", {
    dataDir,
    serverUrl: "https://daemon.example.com",
    driverResolver: () => driver,
    runtimeSessionHomeDir: dataDir,
    onAgentWorkingToIdle: (agentId) => idleNotices.push(agentId),
  });
  const events: Array<Record<string, unknown>> = [];
  const internal = manager as any;
  const record = internal.recordDaemonEvent.bind(internal);
  internal.recordDaemonEvent = (name: string, attrs: Record<string, unknown>, ...rest: unknown[]) => {
    if (name === "daemon.agent.turn_end_compaction") events.push(attrs);
    return record(name, attrs, ...rest);
  };
  const emit = async (...lines: string[]) => {
    for (const line of lines) {
      driver.processes[0]!.stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
    }
  };
  driver.emit = (line) => emit(line);
  try {
    await fn({ driver, manager, events, idleNotices, activity, emit });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A running turn that ends: the turn-end compaction decides at its idle edge. */
async function endTurn(ctx: Ctx, start = true): Promise<void> {
  const { driver, manager, emit } = ctx;
  if (start) await manager.startAgent("agent-1", config(driver.id));
  const internal = manager as any;
  internal.commitApmIdleState("agent-1", internal.agents.get("agent-1"), false);
  driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
  await emit("turn-end");
}

const outcomes = (events: Array<Record<string, unknown>>) => events.map((event) => event.outcome);

const message = (content: string): AgentMessage => ({
  channel_id: "channel-1",
  channel_name: "general",
  channel_type: "channel",
  sender_id: "user-1",
  sender_name: "richard",
  sender_type: "human",
  content,
  timestamp: "2026-03-24T10:00:00.000Z",
});

/** The compaction call, held open until `release()`. */
function openCompaction(driver: FakeSdkDriver): { release: () => void } {
  let release!: () => void;
  driver.gate = new Promise<void>((resolve) => { release = resolve; });
  return { release };
}

for (const runtime of ["pi", "kimi-sdk"]) {
  test(`#54 phase 3 (${runtime}): a delivery right after compactAtTurnEnd() is called, before any runtime event, waits until the call settles, then is written once`, async () => {
    await withManager(runtime, async (ctx) => {
      const { driver, manager, events } = ctx;
      const call = openCompaction(driver);
      await endTurn(ctx);
      await waitFor(() => driver.compactCalls === 1, "compactAtTurnEnd() called");
      const before = driver.encoded.length;
      assert.equal(await manager.deliverMessage("agent-1", message("one more thing")), true);
      await flush();
      assert.equal(driver.encoded.length, before, "held by the daemon's own flag: nothing written into the compacting session");
      // The runtime reports its compaction only now, and finishes before the call settles: still held.
      driver.parsedLines.set("c-start", [{ kind: "compaction_started", cycleId: 9 } as ParsedEvent]);
      driver.parsedLines.set("c-finish", [{ kind: "compaction_finished", cycleId: 9 } as ParsedEvent]);
      await ctx.emit("c-start", "c-finish");
      assert.equal(driver.encoded.length, before, "the runtime's own finish does not release it; the call's settle does");
      call.release();
      await waitFor(() => outcomes(events).includes("completed"), "the call settled");
      await waitFor(() => driver.encoded.length > before, "written after the settle");
      await flush();
      assert.equal(driver.encoded.length, before + 1, "written once");
      const completed = events.find((event) => event.outcome === "completed")!;
      assert.equal(completed.deliveries_held, 1);
      assert.equal(typeof completed.hold_ms, "number");
    });
  });
}

test("#54 phase 3 (pi): a runtime that reports no compaction event at all still holds deliveries for the whole call, and a refused call releases them too", async () => {
  await withManager("pi", async (ctx) => {
    const { driver, manager, events } = ctx;
    driver.outcomes = [{ kind: "refused", reason: "busy" }];
    const call = openCompaction(driver);
    await endTurn(ctx);
    await waitFor(() => driver.compactCalls === 1, "compactAtTurnEnd() called");
    const before = driver.encoded.length;
    assert.equal(await manager.deliverMessage("agent-1", message("first")), true);
    assert.equal(await manager.deliverMessage("agent-1", message("second")), true);
    for (let i = 0; i < 5; i++) await flush();
    // The busy notice's timer (3 s) firing now must find the gate closed too.
    assert.equal((manager as any).sendStdinNotification("agent-1"), false, "the busy-delivery write is held as well");
    assert.equal(driver.encoded.length, before, "no event from the runtime, and still nothing written");
    call.release();
    await waitFor(() => outcomes(events).includes("refused:busy"), "the call settled (refused)");
    await waitFor(() => driver.encoded.length > before, "written after the settle");
    await flush();
    assert.equal(driver.encoded.length, before + 1, "both waited, and go in one write");
  });
});

test("#54 phase 3 (pi): a compaction that never settles is given up at the cap: failed:timeout, the held delivery is written once, and a late answer changes nothing", async () => {
  await withManager("pi", async (ctx) => {
    const { driver, manager, events } = ctx;
    const call = openCompaction(driver);
    await manager.startAgent("agent-1", config("pi", { envVars: { RAFT_TURN_END_COMPACTION_TIMEOUT_MS: "80" } }));
    await endTurn(ctx, false);
    await waitFor(() => driver.compactCalls === 1, "compactAtTurnEnd() called");
    const before = driver.encoded.length;
    assert.equal(await manager.deliverMessage("agent-1", message("still there?")), true);
    await flush();
    assert.equal(driver.encoded.length, before, "held while the call is open");
    await waitFor(() => outcomes(events).includes("failed:timeout"), "given up at the cap");
    await waitFor(() => driver.encoded.length > before, "the waiting delivery wins");
    await flush();
    assert.equal(driver.encoded.length, before + 1, "written once");
    const timedOut = events.find((event) => event.outcome === "failed:timeout")!;
    assert.equal(timedOut.deliveries_held, 1);
    // The runtime answers long after: nothing more is recorded or written.
    call.release();
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(outcomes(events).filter((outcome) => outcome !== "started").length, 1, "one settle only");
    assert.equal(driver.encoded.length, before + 1);
  });
});

test("#54 phase 3 (pi): at the cap the manager cancels the runtime's compaction before it writes the held delivery (Pi refuses a prompt while compacting)", async () => {
  await withManager("pi", async (ctx) => {
    const { driver, manager, events } = ctx;
    driver.cancellable = true;
    openCompaction(driver);
    await manager.startAgent("agent-1", config("pi", { envVars: { RAFT_TURN_END_COMPACTION_TIMEOUT_MS: "80" } }));
    await endTurn(ctx, false);
    await waitFor(() => driver.compactCalls === 1, "compactAtTurnEnd() called");
    const writesBefore = driver.order.length;
    assert.equal(await manager.deliverMessage("agent-1", message("are you there")), true);
    await waitFor(() => outcomes(events).includes("failed:timeout"), "given up at the cap");
    await waitFor(() => driver.order.slice(writesBefore).includes("write"), "the held delivery written");
    const after = driver.order.slice(writesBefore);
    assert.ok(after.indexOf("cancel") !== -1, "the compaction was cancelled");
    assert.ok(after.indexOf("cancel") < after.indexOf("write"), `cancel comes before the write: ${after.join(", ")}`);
  });
});

for (const runtime of ["pi", "builtin", "kimi-sdk"]) {
  test(`#54 phase 3 (${runtime}): past 250k on a 1M window, the idle session compacts through its own API once; no /compact, no second idle hook, compacting shown`, async () => {
    await withManager(runtime, async (ctx) => {
      const { driver, events, idleNotices, activity, emit } = ctx;
      // The runtime's own compaction events, as Pi and Kimi report a compaction while idle.
      driver.parsedLines.set("c-start", [{ kind: "compaction_started", cycleId: 7 } as ParsedEvent]);
      driver.parsedLines.set("c-finish", [{ kind: "compaction_finished", cycleId: 7 } as ParsedEvent]);
      driver.duringCompact = ["c-start", "c-finish"];
      await endTurn(ctx);
      await waitFor(() => outcomes(events).includes("completed"), "the compaction settled");
      assert.equal(driver.compactCalls, 1);
      assert.equal(driver.encoded.includes("/compact"), false, "nothing is written to the runtime");
      const started = events.find((event) => event.outcome === "started")!;
      assert.equal(started.runtime, runtime);
      assert.equal(started.context_tokens, 300_000);
      assert.equal(started.context_window_tokens, 1_000_000);
      assert.equal(started.threshold_tokens, 250_000);
      assert.ok(activity.some((frame) => frame.detailKind === "compacting_context"), "compacting is shown");
      await flush();
      assert.equal(idleNotices.length, 1, "the real turn's idle hooks ran once; the compaction's own idle edge runs none");

      // The next turn ends still past the threshold: not re-armed.
      await endTurn(ctx, false);
      await waitFor(() => outcomes(events).includes("skipped:not_rearmed"), "the next decision");
      assert.equal(driver.compactCalls, 1);
      void emit;
    });
  });
}

test("#54 phase 3 (pi): a refusal keeps the arm and a later turn end compacts; a failure stays disarmed (Pi: it sticks to the session)", async () => {
  await withManager("pi", async (ctx) => {
    const { driver, events } = ctx;
    driver.outcomes = [{ kind: "refused", reason: "busy" }, { kind: "failed", reason: "summary_incomplete" }];
    await endTurn(ctx);
    await waitFor(() => outcomes(events).includes("refused:busy"), "the refusal");
    await endTurn(ctx, false);
    await waitFor(() => outcomes(events).includes("failed:summary_incomplete"), "the failure");
    assert.equal(driver.compactCalls, 2);
    await endTurn(ctx, false);
    await waitFor(() => outcomes(events).includes("skipped:not_rearmed"), "no retry after a failure");
    assert.equal(driver.compactCalls, 2, "a failed compaction is not retried at every turn end");
  });
});

test("#54 phase 3 (pi): a window under 400k or unknown facts never compact", async () => {
  await withManager("pi", async (ctx) => {
    const { driver, events } = ctx;
    driver.facts = { contextTokens: 300_000, windowTokens: 200_000 };
    await endTurn(ctx);
    await waitFor(() => outcomes(events).includes("skipped:window_too_small"), "the window skip");
    driver.facts = { contextTokens: null, windowTokens: null };
    await endTurn(ctx, false);
    await flush();
    assert.equal(driver.compactCalls, 0);
  });
});
