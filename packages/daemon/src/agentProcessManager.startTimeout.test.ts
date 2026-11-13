// Start timeouts (2026-10, opencode free models queued or rate-limited): a
// runtime that spawns but never produces output was SIGTERMed every 2 minutes
// for hours. The spawn succeeded, so neither the daemon's spawn-fail backoff
// nor the server's failed-start breaker ever saw a failure.
//   - the timeout is reported as a typed `runtime_start_timeout` start failure;
//   - consecutive timeouts escalate the local backoff, which a successful spawn
//     (the spawn-time `active`) does not reset;
//   - the runtime's first output event (startup readiness) resets it and is
//     sent to the server as `agent:runtime:ready`;
//   - the turn span says why the start failed, without recording stderr.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, BasicTracer, type MachineToServerMessage, type Tracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { AgentProcessManager, runtimeStartTimeoutMs } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import type { AgentLifecycleRecords } from "./agentLifecycleRecord";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const START_TIMEOUT_MS = 40;
const AGENT = "agent-timeout";
const MODEL = "opencode/mimo-v2.6-flash-free";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

type BackoffState = { attempts: number; untilMs: number; reason: string | null };
type ManagerInternals = {
  agents: Map<string, unknown>;
  lifecycleRecords: AgentLifecycleRecords<BackoffState>;
  startTimeoutStreaks: Map<string, number>;
};
const internals = (manager: AgentProcessManager) => manager as unknown as ManagerInternals;

type Harness = {
  manager: AgentProcessManager;
  sent: MachineToServerMessage[];
  children: FakeChild[];
  driver: { launchedCliVersion?: string | null };
  events: Map<string, ParsedEvent[]>;
};

async function withManager(run: (h: Harness) => Promise<void>, options: { tracer?: Tracer } = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-start-timeout-test-"));
  const previousTimeout = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = String(START_TIMEOUT_MS);
  const sent: MachineToServerMessage[] = [];
  const children: FakeChild[] = [];
  const events = new Map<string, ParsedEvent[]>();
  const driver: RuntimeDriver & { launchedCliVersion?: string | null } = {
    id: "opencode",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const,
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
    buildSystemPrompt: () => asAxSurfaceText("standing"),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return { process: child as unknown as ChildProcess };
    },
    parseLine: (line) => events.get(line.trim()) ?? [],
    encodeStdinMessage: (text) => text,
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_start_timeout", credentialId: "start-timeout" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const manager = new AgentProcessManager((msg) => sent.push(msg), "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    detectedRuntimeCliVersion: (runtimeId) => (runtimeId === "opencode" ? "1.14.0-detected" : undefined),
    ...(options.tracer ? { tracer: options.tracer } : {}),
  });
  try {
    await run({ manager, sent, children, driver, events });
  } finally {
    await drainAgentManagerForTests(manager);
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      if (previousTimeout === undefined) delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
      else process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = previousTimeout;
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

const config = () => promptConfig({ name: AGENT, displayName: AGENT, runtime: "opencode", model: MODEL });

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A server start (launch `launchId`) whose runtime never produces output: it times out and its process exits. */
async function startAndTimeOut(h: Harness, launchId: string): Promise<void> {
  const m = internals(h.manager);
  const before = m.startTimeoutStreaks.get(AGENT) ?? 0;
  await h.manager.startAgent(AGENT, config(), undefined, undefined, undefined, launchId);
  await waitUntil(() => !m.agents.has(AGENT) && (m.startTimeoutStreaks.get(AGENT) ?? 0) > before, `${launchId} to time out and exit`);
}

const statusFrames = (sent: MachineToServerMessage[], launchId: string) =>
  sent.filter((m): m is Extract<MachineToServerMessage, { type: "agent:status" }> => m.type === "agent:status" && m.launchId === launchId).map((m) => m.status);
const readyFrames = (sent: MachineToServerMessage[]) => sent.filter((m) => m.type === "agent:runtime:ready");

test("runtimes whose first event waits for the model's first token get 10 minutes to start; others keep 2; the env overrides both", () => {
  const previous = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  try {
    delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    assert.equal(runtimeStartTimeoutMs("opencode"), 10 * 60_000);
    assert.equal(runtimeStartTimeoutMs("grok"), 10 * 60_000);
    assert.equal(runtimeStartTimeoutMs("antigravity"), 10 * 60_000);
    assert.equal(runtimeStartTimeoutMs("claude"), 2 * 60_000);
    assert.equal(runtimeStartTimeoutMs("gemini"), 2 * 60_000);
    process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = "45000";
    assert.equal(runtimeStartTimeoutMs("opencode"), 45_000);
    assert.equal(runtimeStartTimeoutMs("claude"), 45_000);
  } finally {
    if (previous === undefined) delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    else process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = previous;
  }
});

test("an OpenCode start arms its start timer with OpenCode's own 10 minutes when the env sets none", async () => {
  await withManager(async (h) => {
    delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await h.manager.startAgent(AGENT, config(), undefined, undefined, undefined, "launch-default");
      const delays = timers.mock.calls.map(([, ms]) => ms);
      assert.ok(delays.includes(10 * 60_000), `start timer armed for 10 minutes; armed: ${delays.filter((ms) => typeof ms === "number" && ms >= 1_000).join(", ")}`);
      assert.ok(!delays.includes(2 * 60_000), "not the 2-minute default");
    } finally {
      timers.mockRestore();
    }
  });
});

test("a start timeout is reported as a typed runtime_start_timeout start failure, naming the model", async () => {
  await withManager(async (h) => {
    await startAndTimeOut(h, "launch-1");
    assert.deepEqual(statusFrames(h.sent, "launch-1"), ["active", "inactive"]);
    const failure = h.sent.find((m): m is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      m.type === "agent:activity" && m.detailKind === "runtime_unavailable" && m.launchId === "launch-1");
    assert.ok(failure, "a typed start-failure activity");
    assert.deepEqual(failure.spawnFailure, { reason: "runtime_start_timeout", model: MODEL });
    assert.equal(
      failure.detail,
      `OpenCode did not finish starting within 1 second. The selected model (${MODEL}, free tier) may be slow to respond, queued or rate-limited by its provider. Try again later, or switch to another model.`,
    );
    assert.equal(readyFrames(h.sent).length, 0, "no output, no readiness");
  });
});

test("consecutive start timeouts escalate the local backoff; the spawn-time active does not reset the count", async () => {
  await withManager(async (h) => {
    const m = internals(h.manager);
    const delays: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      await startAndTimeOut(h, `launch-${n}`);
      assert.equal(m.startTimeoutStreaks.get(AGENT), n);
      const backoff = m.lifecycleRecords.getSpawnFailBackoff(AGENT);
      assert.ok(backoff, `timeout ${n} enters the spawn-fail backoff`);
      assert.equal(backoff.attempts, n);
      assert.equal(backoff.reason, "runtime_start_timeout");
      delays.push(backoff.untilMs - Date.now());
      // The next server start spawns during the cooldown: its `active` is not
      // progress, so the count survives it.
    }
    assert.ok(delays[0] <= 1_000 && delays[1] > 1_000 && delays[1] <= 2_000 && delays[2] > 2_000 && delays[2] <= 4_000, `delays doubled: ${delays.join(", ")}`);
    assert.deepEqual(statusFrames(h.sent, "launch-3"), ["active", "inactive"], "each start did report active");
    assert.equal(readyFrames(h.sent).length, 0);
  });
}, 15_000);

test("after five start timeouts in a row the daemon stops restarting locally and leaves it to the server", async () => {
  await withManager(async (h) => {
    const m = internals(h.manager);
    for (let n = 1; n <= 5; n += 1) await startAndTimeOut(h, `launch-${n}`);
    assert.equal(m.startTimeoutStreaks.get(AGENT), 5);
    assert.equal(m.lifecycleRecords.getRestartSnapshot(AGENT), undefined, "no local restart config: the next start is the server's");
    assert.equal(m.lifecycleRecords.getSpawnFailBackoff(AGENT), undefined);
  });
}, 15_000);

test("the runtime's first output event resets the count and tells the server the launch is ready", async () => {
  await withManager(async (h) => {
    const m = internals(h.manager);
    await startAndTimeOut(h, "launch-1");
    await startAndTimeOut(h, "launch-2");
    assert.equal(m.startTimeoutStreaks.get(AGENT), 2);

    h.events.set("hello", [{ kind: "text", text: "hello" }]);
    await h.manager.startAgent(AGENT, config(), undefined, undefined, undefined, "launch-3");
    assert.equal(m.startTimeoutStreaks.get(AGENT), 2, "spawned and active, but no output yet");
    h.children.at(-1)!.stdout.emit("data", Buffer.from("hello\n"));
    await waitUntil(() => readyFrames(h.sent).length > 0, "agent:runtime:ready");
    assert.deepEqual(readyFrames(h.sent), [{ type: "agent:runtime:ready", agentId: AGENT, launchId: "launch-3" }]);
    assert.equal(m.startTimeoutStreaks.has(AGENT), false, "readiness ends the streak");
    // Still running past the timeout: readiness cleared it.
    await new Promise((resolve) => setTimeout(resolve, START_TIMEOUT_MS * 3));
    assert.ok(m.agents.has(AGENT));

    await h.manager.stopAgent(AGENT, { wait: true });
    await startAndTimeOut(h, "launch-4");
    assert.equal(m.startTimeoutStreaks.get(AGENT), 1, "counting starts over");
    assert.equal(m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.attempts, 1);
  });
}, 15_000);

test("the turn span of a timed-out start carries the CLI version and why it failed, and the local sink keeps them", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "raft-start-timeout-trace-"));
  const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 4 * 1024 * 1024, maxFiles: 4 });
  try {
    await withManager(async (h) => {
      // Runtime output the classifier recognises; the stderr text itself is never recorded.
      h.driver.launchedCliVersion = "1.14.2";
      await h.manager.startAgent(AGENT, config(), undefined, undefined, undefined, "launch-rl");
      h.children.at(-1)!.stderr.emit("data", Buffer.from("Error: 429 Too Many Requests: rate limit exceeded for model\n"));
      await waitUntil(() => internals(h.manager).startTimeoutStreaks.get(AGENT) === 1, "the rate-limited start to time out");
      // No output at all: the timeout's own value, and the daemon's detected version.
      h.driver.launchedCliVersion = undefined;
      await startAndTimeOut(h, "launch-quiet");
    }, { tracer: new BasicTracer({ sink }) });

    const turns: Array<Record<string, unknown>> = [];
    const dir = path.join(machineDir, "traces");
    for (const name of readdirSync(dir)) {
      for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
        if (record.name === "daemon.runtime.turn" && record.attrs?.outcome === "runtime-start-failed") turns.push(record.attrs);
      }
    }
    const byLaunch = (launchId: string) => turns.find((attrs) => attrs.launch_id === launchId);
    const rateLimited = byLaunch("launch-rl");
    const quiet = byLaunch("launch-quiet");
    assert.ok(rateLimited && quiet, `both turn spans on disk (${turns.length})`);
    assert.equal(rateLimited.runtime_cli_version, "1.14.2");
    assert.equal(rateLimited.runtime_exit_reason, "RateLimitError");
    assert.equal(rateLimited.stderr_present, true);
    assert.equal(rateLimited.stderr_lines_count, 1);
    assert.equal(quiet.runtime_cli_version, "1.14.0-detected");
    assert.equal(quiet.runtime_exit_reason, "runtime_start_timeout");
    assert.equal(quiet.stderr_present, false);
    assert.equal(quiet.stderr_lines_count, 0);
    assert.ok(!JSON.stringify(turns).includes("Too Many Requests"), "stderr text never reaches the trace");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
}, 15_000);
