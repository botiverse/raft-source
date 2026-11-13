// #proj-runtime:#54 phase 3: native compaction at a turn end past the size
// threshold, on the legacy host (Claude: `/compact` as a turn of its own).
// The facts come from Claude's result usage (claudeEventNormalizer.ts):
// `lastRequestContextTokens` and `modelUsageMaxContextWindow`.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

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

/** Claude's shape (agentProcessManager.claude.test.ts): direct stdin, notifications, a reported compaction. */
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
  readonly encodedCalls: Array<{ text: string; mode: "idle" | "busy" }> = [];
  currentSessionId: string | null = null;
  spawn(_ctx: SpawnContext): SpawnResult {
    const proc = new FakeChildProcess();
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }
  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }
  encodeStdinMessage(text?: string, _sessionId?: string | null, opts?: { mode?: "idle" | "busy" }): string | null {
    if (!text) return null;
    this.encodedCalls.push({ text, mode: opts?.mode || "busy" });
    return JSON.stringify({ text });
  }
  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "claude-agent",
  displayName: "Claude Agent",
  description: "test agent",
  model: "opus",
  runtime: "claude",
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

const usage = (lastRequestContextTokens: number, modelUsageMaxContextWindow: number): ParsedEvent => ({
  kind: "telemetry",
  name: "token_usage",
  source: "claude_result_usage",
  usageKind: "per_turn",
  attrs: { inputTokens: 10, outputTokens: 5, lastRequestContextTokens, modelUsageMaxContextWindow },
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

async function withManager(fn: (ctx: {
  driver: FakeClaudeDriver;
  manager: AgentProcessManager;
  dataDir: string;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (...lines: string[]) => Promise<void>;
  idleNotices: string[];
  activity: Array<{ detail?: string; detailKind?: string }>;
}) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-turn-end-compaction-"));
  const driver = new FakeClaudeDriver();
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
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const internal = manager as any;
  const record = internal.recordDaemonEvent.bind(internal);
  internal.recordDaemonEvent = (name: string, attrs: Record<string, unknown>, ...rest: unknown[]) => {
    if (name === "daemon.agent.turn_end_compaction") events.push({ name, attrs });
    return record(name, attrs, ...rest);
  };
  const emit = async (...lines: string[]) => {
    for (const line of lines) {
      driver.processes[0]!.stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
    }
  };
  try {
    await fn({ driver, manager, dataDir, events, emit, idleNotices, activity });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * A running turn that ends reporting `context` tokens on a `window`-token model.
 * The turn is marked running directly: a delivered message would stay unread
 * here (nothing reads it), and the inbox would write it again at every turn end.
 */
async function turnEndingWith(ctx: Parameters<Parameters<typeof withManager>[0]>[0], context: number, window: number, overrides: Partial<AgentConfig> = {}): Promise<void> {
  const { driver, manager, emit } = ctx;
  await manager.startAgent("agent-1", config(overrides));
  const internal = manager as any;
  internal.commitApmIdleState("agent-1", internal.agents.get("agent-1"), false);
  driver.parsedLines.set("usage", [usage(context, window)]);
  driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
  await emit("usage", "turn-end");
}

const compacts = (driver: FakeClaudeDriver) => driver.encodedCalls.filter((call) => call.text === "/compact");
const outcomes = (events: Array<{ attrs: Record<string, unknown> }>) => events.map((event) => event.attrs.outcome);

test("#54 phase 3: past 250k on a 1M window, the idle Claude session gets /compact as a turn; it settles at that turn's end and doesn't fire again", async () => {
  await withManager(async (ctx) => {
    const { driver, events, emit } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    await waitFor(() => compacts(driver).length === 1, "/compact written");
    assert.deepEqual(compacts(driver), [{ text: "/compact", mode: "idle" }]);
    const started = events.find((event) => event.attrs.outcome === "started")!.attrs;
    assert.equal(started.host, "legacy");
    assert.equal(started.context_tokens, 300_000);
    assert.equal(started.context_window_tokens, 1_000_000);
    assert.equal(started.threshold_tokens, 250_000);

    // Claude compacts, then ends the /compact turn (its own result: the compaction request read the whole context).
    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);
    driver.parsedLines.set("compact-usage", [usage(300_000, 1_000_000)]);
    await emit("compact-start", "compact-finish", "compact-usage", "turn-end");
    await waitFor(() => outcomes(events).includes("completed"), "the compaction settled");
    const done = events.find((event) => event.attrs.outcome === "completed")!.attrs;
    assert.equal(done.deliveries_held, 0);
    assert.equal(typeof done.duration_ms, "number");
    await flush();
    assert.equal(compacts(driver).length, 1, "not again: the context hasn't dropped to the threshold since");
    assert.ok(outcomes(events).includes("skipped:not_rearmed"));
  });
});

test("#54 phase 3: a /compact turn that ends without Claude's compaction is a failure", async () => {
  await withManager(async (ctx) => {
    const { driver, events, emit } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    await waitFor(() => compacts(driver).length === 1, "/compact written");
    await emit("turn-end");
    await waitFor(() => outcomes(events).includes("failed:not_compacted"), "settled as not compacted");
  });
});

test("#54 phase 3: a 200k window, the flag off, or a project command named compact: no /compact", async () => {
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 300_000, 200_000);
    await flush();
    assert.equal(compacts(ctx.driver).length, 0);
    assert.deepEqual(outcomes(ctx.events), ["skipped:window_too_small"]);
  });
  await withManager(async (ctx) => {
    await turnEndingWith(ctx, 300_000, 1_000_000, { turnEndCompaction: undefined });
    await flush();
    assert.equal(compacts(ctx.driver).length, 0);
    assert.deepEqual(ctx.events, []);
  });
  await withManager(async (ctx) => {
    await mkdir(path.join(ctx.dataDir, "agent-1", ".claude", "commands"), { recursive: true });
    await writeFile(path.join(ctx.dataDir, "agent-1", ".claude", "commands", "compact.md"), "not the built-in");
    await turnEndingWith(ctx, 300_000, 1_000_000);
    await flush();
    assert.equal(compacts(ctx.driver).length, 0);
    assert.ok(outcomes(ctx.events).includes("skipped:compact_command_overridden"));
  });
});

test("#54 phase 3: a delivery that arrives during the /compact turn waits until the compaction ends, then reaches Claude", async () => {
  await withManager(async (ctx) => {
    const { driver, manager, events, emit } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    await waitFor(() => compacts(driver).length === 1, "/compact written");
    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    await emit("compact-start");
    assert.equal(await manager.deliverMessage("agent-1", message("one more thing")), true);
    await flush();
    const reached = () => driver.encodedCalls.filter((call) => call.text.includes("one more thing")).length;
    assert.equal(reached(), 0, "held while Claude compacts (the compaction gate)");
    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);
    await emit("compact-finish", "turn-end");
    await waitFor(() => outcomes(events).includes("completed"), "the compaction settled");
    await waitFor(() => reached() > 0, "written once the compaction is over");
    assert.equal(compacts(driver).length, 1, "one /compact");
  });
});

test("#54 phase 3: the /compact turn shows as compacting, and its end runs no idle hooks a second time", async () => {
  await withManager(async (ctx) => {
    const { driver, events, emit, idleNotices, activity } = ctx;
    await turnEndingWith(ctx, 300_000, 1_000_000);
    await waitFor(() => compacts(driver).length === 1, "/compact written");
    assert.equal(idleNotices.length, 1, "the real turn's end ran the idle hooks once");
    const compacting = activity.filter((frame) => frame.detailKind === "compacting_context");
    assert.ok(compacting.length > 0, "the agent shows as compacting from the moment /compact is written");
    assert.equal(compacting[0]!.detail, "Compacting context");

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);
    await emit("compact-start", "compact-finish", "turn-end");
    await waitFor(() => outcomes(events).includes("completed"), "the compaction settled");
    await flush();
    assert.equal(idleNotices.length, 1, "the /compact turn's end is no end of the agent's work: no second Cleaner hint or idle task reminder");

    // The next real turn runs them again.
    const internal = ctx.manager as any;
    internal.commitApmIdleState("agent-1", internal.agents.get("agent-1"), false);
    internal.sendRuntimeInput("agent-1", internal.agents.get("agent-1"), { mode: "idle", text: "next task" }, "test");
    driver.parsedLines.set("small-usage", [usage(40_000, 1_000_000)]);
    await emit("small-usage", "turn-end");
    await waitFor(() => idleNotices.length === 2, "the next real turn's idle hooks");
  });
});
