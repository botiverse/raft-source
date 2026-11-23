// Wake-recycle start-failure fallback on the legacy host (#wg-ax:#3):
// when a wake-recycled replacement session fails before reaching startup
// readiness (startup timeout, early crash, or spawn error), the prior session
// stays intact (never overwritten on the server or in retry snapshots) and the
// next wake skips recycling (`prior_recycle_start_failed`) and resumes the
// prior session instead of looping. Once a recycled replacement reaches
// startup readiness, its new session id is reported and the prior session is
// retired.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { onTestFinished, test, vi } from "vitest";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

type RuntimeStartupReadiness = NonNullable<RuntimeDriver["startupReadiness"]>;

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  killed = false;
  deferExitOnKill = false;
  kill(): boolean {
    this.killed = true;
    if (!this.deferExitOnKill) {
      this.emit("exit", 143, "SIGTERM");
      this.emit("close", 143, "SIGTERM");
    }
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
  readonly startupReadiness: RuntimeStartupReadiness;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  failNextSpawn: Error | null = null;
  currentSessionId: string | null = null;

  constructor(startupReadiness: RuntimeStartupReadiness = "first_event") {
    this.startupReadiness = startupReadiness;
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    if (this.failNextSpawn) {
      const err = this.failNextSpawn;
      this.failNextSpawn = null;
      throw err;
    }
    const proc = new FakeChildProcess();
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }

  encodeStdinMessage(text?: string): string | null {
    return text ? JSON.stringify({ text }) : null;
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

const AGENT = "agent-1";
const OLD_SESSION = "session-cold-prior";
const NEW_SESSION = "session-recycled-new";

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "claude-agent",
  displayName: "Claude Agent",
  description: "test agent",
  model: "opus",
  runtime: "claude",
  reasoningEffort: null,
  envVars: null,
  sessionId: OLD_SESSION,
  serverUrl: "http://localhost:3001",
  authToken: "sk_machine_test",
  agentCredentialKey: "sk_agent_test",
  agentCredentialId: null,
  ...overrides,
});

const wake = (content: string): AgentMessage => ({
  channel_id: "channel-1",
  channel_name: "general",
  channel_type: "channel",
  sender_id: "user-1",
  sender_name: "richard",
  sender_type: "human",
  content,
  timestamp: new Date().toISOString(),
});

async function writeColdTranscript(homeDir: string, sessionId: string, contextTokens = 250_000): Promise<void> {
  const projectDir = path.join(homeDir, ".claude", "projects", "-workspace-agent");
  await mkdir(projectDir, { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const record = {
    type: "assistant",
    timestamp: twoHoursAgo,
    message: {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: contextTokens - 12,
        cache_creation_input_tokens: 0,
      },
    },
  };
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify(record) + "\n");
}

async function withManager(
  fn: (ctx: {
    driver: FakeClaudeDriver;
    manager: AgentProcessManager;
    dataDir: string;
    sent: MachineToServerMessage[];
    events: Array<{ name: string; attrs: Record<string, unknown> }>;
    emit: (processIndex: number, ...lines: string[]) => Promise<void>;
  }) => Promise<void>,
  options: { startupReadiness?: RuntimeStartupReadiness } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-wake-recycle-fallback-"));
  const driver = new FakeClaudeDriver(options.startupReadiness ?? "first_event");
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager((msg) => { sent.push(msg); }, "sk_machine_test", {
    dataDir,
    serverUrl: "https://daemon.example.com",
    driverResolver: () => driver,
    runtimeSessionHomeDir: dataDir,
    detectedRuntimeCliVersion: () => "2.1.304 (Claude Code)",
  });
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const internal = manager as any;
  const origRecord = internal.recordDaemonEvent.bind(internal);
  internal.recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return origRecord(name, attrs, ...rest);
  };
  const emit = async (processIndex: number, ...lines: string[]) => {
    for (const line of lines) {
      driver.processes[processIndex]!.stdout.emit("data", Buffer.from(`${line}\n`));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  onTestFinished(() => { vi.useRealTimers(); });
  try {
    await fn({ driver, manager, dataDir, sent, events, emit });
  } finally {
    vi.useRealTimers();
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("#wg-ax:#3: startup timeout on a recycled start preserves prior session and next wake resumes it without re-recycling", async () => {
  await withManager(async ({ driver, manager, dataDir, sent, events }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);

    await manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1");
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]!.config.sessionId, null, "first wake recycles into a fresh session");
    assert.equal(events.some((e) => e.name === "daemon.agent.wake_recycle"), true);

    // Simulate the 2-minute startup timeout before any runtime event arrives.
    const internal = manager as any;
    const ap = internal.agents.get(AGENT);
    assert.ok(ap);
    internal.handleRuntimeStartupTimeout(AGENT, ap, 120_000);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Prior session was never overwritten on the server and is preserved in the retry snapshot.
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), []);
    const retrySnapshot = internal.lifecycleRecords.getRestartSnapshot(AGENT);
    assert.equal(retrySnapshot?.sessionId, OLD_SESSION, "startup-timeout retry snapshot keeps prior session");
    assert.equal(events.some((e) => e.name === "daemon.agent.wake_recycle.start_failed" && e.attrs.reason === "runtime_start_timeout"), true);

    // Next wake arrives with the same prior session: must skip recycle and resume OLD_SESSION.
    await manager.startAgent(AGENT, config(), wake("wake-2"), undefined, undefined, "launch-2");
    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[1]!.config.sessionId, OLD_SESSION, "next wake resumes prior session");
    assert.equal(
      events.some((e) => e.name === "daemon.agent.wake_recycle_skipped" && e.attrs.reason === "prior_recycle_start_failed"),
      true,
      "emits prior_recycle_start_failed skip reason",
    );
  });
});

test("#wg-ax:#3: initial_turn runtime holds agent:session until readiness; timeout before readiness keeps prior session, readiness reports new session", async () => {
  await withManager(async ({ driver, manager, dataDir, sent, events, emit }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);
    driver.parsedLines.set("init", [{ kind: "session_init", sessionId: NEW_SESSION }]);
    driver.parsedLines.set("text", [{ kind: "text", text: "ready now" }]);

    // First recycled start: emits session_init (NEW_SESSION), then times out before model output.
    await manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1");
    await emit(0, "init");
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), [], "unready recycled session is not reported to server");

    const internal = manager as any;
    const ap = internal.agents.get(AGENT);
    internal.handleRuntimeStartupTimeout(AGENT, ap, 120_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), [], "server still holds prior session after timeout");
    assert.equal(internal.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId, OLD_SESSION);

    // Next wake resumes OLD_SESSION; explicit Retry (stopAgent) keeps the failure memory,
    // while resetWorkspace clears it so a fresh recycle can run again.
    await manager.startAgent(AGENT, config(), wake("wake-2"), undefined, undefined, "launch-2");
    assert.equal(driver.spawnCalls[1]!.config.sessionId, OLD_SESSION);
    await manager.stopAgent(AGENT);
    assert.equal(manager.wakeRecycleFailures.hasFailed(AGENT, OLD_SESSION), true, "explicit stop/Retry keeps failed-recycle memory");
    await manager.resetWorkspace(AGENT);
    assert.equal(manager.wakeRecycleFailures.hasFailed(AGENT, OLD_SESSION), false, "reset clears failed-recycle memory");

    // Now a recycled start that DOES reach readiness reports NEW_SESSION once ready.
    await manager.startAgent(AGENT, config(), wake("wake-3"), undefined, undefined, "launch-3");
    assert.equal(driver.spawnCalls[2]!.config.sessionId, null, "recycles again after reset cleared failure");
    await emit(2, "init");
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), [], "still held before first output");
    await emit(2, "text");
    const reported = sent.filter((m) => m.type === "agent:session");
    assert.equal(reported.length, 1, "reports new session once ready");
    assert.equal(reported[0]!.sessionId, NEW_SESSION);
    assert.equal(events.some((e) => e.name === "daemon.agent.wake_recycle.start_failed"), true);
  }, { startupReadiness: "initial_turn" });
});

test("#wg-ax:#3: spawn failure on a recycled start records failure so next wake resumes prior session", async () => {
  await withManager(async ({ driver, manager, dataDir, events }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);
    driver.failNextSpawn = new Error("spawn ENOENT");

    await assert.rejects(() => manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1"));
    assert.equal(driver.spawnCalls[0]!.config.sessionId, null);
    assert.equal(events.some((e) => e.name === "daemon.agent.wake_recycle.start_failed" && e.attrs.reason === "spawn_failed"), true);

    await manager.startAgent(AGENT, config(), wake("wake-2"), undefined, undefined, "launch-2");
    assert.equal(driver.spawnCalls[1]!.config.sessionId, OLD_SESSION, "next wake resumes prior session after spawn failure");
  });
});

test("#wg-ax:#3: immediate runtime error event before model output does not retire prior session or report unready recycled session", async () => {
  await withManager(async ({ driver, manager, dataDir, sent, emit }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);
    driver.parsedLines.set("init", [{ kind: "session_init", sessionId: NEW_SESSION }]);
    driver.parsedLines.set("err", [{ kind: "error", message: "provider 500" }]);

    await manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1");
    await emit(0, "init", "err");
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), [], "error event must not retire prior session or report NEW_SESSION");

    // Process exits after the error: failure memory records OLD_SESSION and retry snapshot keeps OLD_SESSION.
    driver.processes[0]!.emit("exit", 1, null);
    driver.processes[0]!.emit("close", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await manager.startAgent(AGENT, config(), wake("wake-2"), undefined, undefined, "launch-2");
    assert.equal(driver.spawnCalls[1]!.config.sessionId, OLD_SESSION, "next wake resumes prior session");
  }, { startupReadiness: "initial_turn" });
});

test("#wg-ax:#3: real Claude first_event path retires prior session and reports new session once on initial session_init", async () => {
  await withManager(async ({ driver, manager, dataDir, sent, emit }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);
    driver.parsedLines.set("init", [{ kind: "session_init", sessionId: NEW_SESSION }]);

    await manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1");
    assert.equal(driver.spawnCalls[0]!.config.sessionId, null, "recycled into fresh session");
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), [], "not reported before session_init");

    await emit(0, "init");
    const reported = sent.filter((m) => m.type === "agent:session");
    assert.equal(reported.length, 1, "reported exactly once on Claude session_init");
    assert.equal(reported[0]!.sessionId, NEW_SESSION);
    const ap = (manager as any).agents.get(AGENT);
    assert.equal(ap.recycledFromSessionId, null, "prior session retired once ready");
  }, { startupReadiness: "first_event" });
});

test("#wg-ax:#3: late Claude session_init arriving after startup timeout while SIGTERM is in flight does not undo fallback", async () => {
  await withManager(async ({ driver, manager, dataDir, sent, emit }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);
    driver.parsedLines.set("init", [{ kind: "session_init", sessionId: NEW_SESSION }]);

    await manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1");
    const proc = driver.processes[0]!;
    proc.deferExitOnKill = true;

    // Timeout fires and begins terminating the slow child, which hasn't exited yet.
    const internal = manager as any;
    const ap = internal.agents.get(AGENT);
    internal.handleRuntimeStartupTimeout(AGENT, ap, 120_000);
    assert.equal(manager.wakeRecycleFailures.hasFailed(AGENT, OLD_SESSION), true);

    // Late `session_init` arrives from the still-exiting Claude process!
    await emit(0, "init");
    assert.deepEqual(sent.filter((m) => m.type === "agent:session"), [], "late session_init must NOT overwrite prior session on server");
    assert.equal(manager.wakeRecycleFailures.hasFailed(AGENT, OLD_SESSION), true, "failed-recycle memory must stay set");

    // Process finishes exiting; retry snapshot and next wake still resume OLD_SESSION.
    proc.emit("exit", 143, "SIGTERM");
    proc.emit("close", 143, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(internal.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId, OLD_SESSION);

    await manager.startAgent(AGENT, config(), wake("wake-2"), undefined, undefined, "launch-2");
    assert.equal(driver.spawnCalls[1]!.config.sessionId, OLD_SESSION, "next wake resumes prior session");
  }, { startupReadiness: "first_event" });
});

test("#wg-ax:#3: pre-spawn failure (e.g. credential mint before createSession) does not record failed recycle", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    await writeColdTranscript(dataDir, OLD_SESSION);
    const internal = manager as any;
    const origBuildSpawnConfig = internal.buildSpawnConfig.bind(internal);
    let failOnce = true;
    internal.buildSpawnConfig = async (...args: unknown[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("runner credential mint failed");
      }
      return origBuildSpawnConfig(...args);
    };

    await assert.rejects(() => manager.startAgent(AGENT, config(), wake("wake-1"), undefined, undefined, "launch-1"));
    assert.equal(driver.spawnCalls.length, 0, "never reached driver.spawn");
    assert.equal(manager.wakeRecycleFailures.hasFailed(AGENT, OLD_SESSION), false, "pre-spawn credential failure is not blamed on recycled session");
  });
});
