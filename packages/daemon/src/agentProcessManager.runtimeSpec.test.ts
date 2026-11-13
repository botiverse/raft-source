// Reconciler step 7 in the agent manager: a rebound start's config is the
// runtime spec a running process should run with. A process whose session
// started on another spec (runtimeSpec.ts) is stopped once it is idle, the
// cold-idle way, by the one entry (reconcileSpec); busy, at the fact that
// makes it idle. Its next start runs on the new config and resumes the
// session, unless the runtime (or a Codex model) changed: then the restart
// snapshot names no session, and a later start that names it again drops it
// (SessionSpecMemory). The runtime profile reports what is running.
//
// RED proof: drop the reconcileSpec call in rebindRunningStart and the idle
// cases never stop; drop the idle check and the busy case stops mid-turn;
// drop sessionIdAfterExit and the Codex snapshot keeps the session; drop
// withoutSessionStartedOnOtherSpec and the server's later start resumes it;
// report running.config and runtime_profile shows the rebound model.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.serverFeatures.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, RUNTIME_CONFIG_VERSION, type AgentConfig, type AgentMessage, type AxSurfaceText } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { installDaemonFetchMockForTests } from "./daemonFetch";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

class FakeChildProcess extends EventEmitter {
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

class FakeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle: RuntimeDriver["lifecycle"];
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly terminateProcessOnTurnEnd: boolean;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();

  constructor(options: { perTurn?: boolean } = {}) {
    this.terminateProcessOnTurnEnd = options.perTurn === true;
    this.lifecycle = options.perTurn
      ? { kind: "per_turn", start: "immediate", exit: "terminate_on_turn_end", inFlightWake: "spawn_new" }
      : { kind: "persistent", stdin: "direct", inFlightWake: "steer" };
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
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
    return asAxSurfaceText("standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent",
    displayName: "Agent",
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

type Ctx = { driver: FakeDriver; manager: AgentProcessManager; events: Array<{ name: string; attrs: Record<string, unknown> }> };

async function withManager(fn: (ctx: Ctx) => Promise<void>, driver = new FakeDriver()): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-spec-test-"));
  const manager = new AgentProcessManager(
    () => {},
    "sk_machine_test",
    { dataDir, serverUrl: "https://daemon.example.com", driverResolver: () => driver, runtimeSessionHomeDir: dataDir },
  );
  const events: Ctx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, events });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A running process, idle after its first turn, on `session-<agentId>`. */
async function startIdle(ctx: Ctx, agentId: string, config: Partial<AgentConfig> = {}) {
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId: `session-${agentId}`, ...config }));
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = `session-${agentId}`;
  (ctx.manager as any).commitApmIdleState(agentId, ap, true);
  return ap;
}

/** The server's start for an agent already running: a rebind. */
async function rebind(ctx: Ctx, agentId: string, config: Partial<AgentConfig>): Promise<void> {
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId: `session-${agentId}`, ...config }));
}

function restartSnapshot(manager: AgentProcessManager, agentId: string) {
  return (manager as any).lifecycleRecords.getRestartSnapshot(agentId) as { config: AgentConfig; sessionId: string | null } | undefined;
}

function emitTurnEnd(ctx: Ctx, agentId: string): void {
  const line = `turn-end-${agentId}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{ kind: "turn_end", sessionId: `session-${agentId}` }]);
  ctx.driver.processes.at(-1)!.stdout.emit("data", Buffer.from(`${line}\n`));
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

const specStops = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);
const sessionDrops = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.session_dropped_for_spec").map((event) => event.attrs);

/** Decide every process again (the 10-minute sweep's entry). */
async function sweep(ctx: Ctx): Promise<void> {
  await (ctx.manager as any).sweepColdIdleRuntimes();
  await sleep(20);
}

test("a busy process rebound on another model runs its turn out, is stopped at the turn end, and resumes its session on the new model", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const ap = (ctx.manager as any).agents.get("agent-busy");
    assert.equal(ap.gatedSteering.isIdle, false, "precondition: the first turn is running");

    await rebind(ctx, "agent-busy", { model: "opus" });
    await sweep(ctx);
    const child = ctx.driver.processes[0]!;
    assert.equal(ctx.driver.processes.length, 1, "a rebind, not a second process");
    assert.equal(child.killed, false, "not under a running turn");
    assert.equal(ap.config.model, "opus", "the config already names the new model");
    assert.equal(ctx.manager.getAgentRuntimeProfileReport("agent-busy")?.facts.model, "sonnet", "the runtime profile reports what is running");

    emitTurnEnd(ctx, "agent-busy");
    assert.equal(child.kills, 1, "stopped at the turn end, with an empty inbox");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle", "the cold-idle stop: on purpose");
    assert.deepEqual(specStops(ctx), [{
      agentId: "agent-busy",
      session_id: "session-agent-busy",
      drift: "model",
      new_session: false,
      trigger: "turn_end",
      host: "legacy",
    }]);
    await flush();
    const snapshot = restartSnapshot(ctx.manager, "agent-busy")!;
    assert.equal(snapshot.config.model, "opus");
    assert.equal(snapshot.sessionId, "session-agent-busy", "another Claude model resumes the session");

    // The next wake starts on the new model, resuming; its process has no drift.
    await ctx.manager.startAgent("agent-busy", { ...snapshot.config, agentCredentialKey: "sk_agent_test" });
    assert.equal(ctx.driver.spawnCalls.length, 2);
    assert.equal(ctx.driver.spawnCalls[1]!.config.model, "opus");
    assert.equal(ctx.driver.spawnCalls[1]!.config.sessionId, "session-agent-busy");
    assert.equal(ctx.manager.getAgentRuntimeProfileReport("agent-busy")?.facts.model, "opus");
    const next = (ctx.manager as any).agents.get("agent-busy");
    next.sessionId = "session-agent-busy";
    (ctx.manager as any).commitApmIdleState("agent-busy", next, true);
    await sweep(ctx);
    assert.equal(ctx.driver.processes[1]!.killed, false, "started on the new config: no second stop");
    assert.equal(specStops(ctx).length, 1);
  });
});

test("untold inbox work holds the stop", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-inbox");
    ap.inbox.push(message(1));
    await rebind(ctx, "agent-inbox", { model: "opus" });
    await sweep(ctx);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(specStops(ctx), []);
  });
});

// #triage:#263: switched off an exhausted Claude plan, the deliveries held for
// its usage limit kept the process "not idle", so the switch waited for the
// limit to reset. A drift that drops the session hands them to the next one.
test("untold inbox work does not hold a switch to another runtime: the next session takes it", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-held", { runtime: "claude", model: "opus" });
    ap.inbox.push(message(1));
    // A push (a start of another runtime replaces the process at the start instead).
    ctx.manager.applyConfig("agent-held", makeConfig({ runtime: "codex", model: "gpt-5.5", agentCredentialKey: null }), 2);
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    assert.ok(String(specStops(ctx)[0]!.drift).split(",").includes("runtime"));
  });
});

// #triage:#263, the general rule: a delivery held for the process's provider
// limit cannot reach the session until the limit's wait ends, so it is no work
// that holds an idle-gated step. Here a change that keeps the session.
test("a delivery held for a provider limit does not hold the stop, even when the session is kept", async () => {
  // The stop's close starts the agent again on its held delivery: that start mints a runner credential.
  const restoreFetch = installDaemonFetchMockForTests((async () =>
    new Response(JSON.stringify({ apiKey: "sk_agent_minted", credentialId: "cred-1" }), { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch);
  try { await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-limited", { model: "opus" });
    ap.inbox.push(message(1));
    ap.runtimeErrorDeliveryBackoff = { kind: "backing_off", attempts: 1, untilMs: Date.now() + 60 * 60_000, timer: null, reason: "rate_limited" };
    await rebind(ctx, "agent-limited", { model: "sonnet" });
    assert.equal(ctx.driver.processes[0]!.kills, 1, "stopped for its spec while the delivery waits on the limit");

    // The same inbox with no hold still holds the stop ("untold inbox work holds the stop").
    const free = await startIdle(ctx, "agent-free", { model: "opus" });
    free.inbox.push(message(2));
    await rebind(ctx, "agent-free", { model: "sonnet" });
    assert.equal(ctx.driver.processes.at(-1)!.killed, false);
  }); } finally {
    restoreFetch();
  }
});

test("an env-var-only change stops the idle process as `env`, naming no variable and no value", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-env", { envVars: { PRIVATE_FLAG_NAME: "first-private-value" } });
    await rebind(ctx, "agent-env", { envVars: { PRIVATE_FLAG_NAME: "second-private-value" } });
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    const stops = specStops(ctx);
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.drift, "env");
    assert.equal(stops[0]!.trigger, "signal");
    const traced = JSON.stringify(ctx.events);
    assert.equal(JSON.stringify(stops).includes("PRIVATE_FLAG_NAME"), false);
    assert.equal(traced.includes("first-private-value"), false);
    assert.equal(traced.includes("second-private-value"), false);
  });
});

test("a rebind with the same spec in another key order, with explicit defaults, is no drift", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-same", { envVars: { ALPHA: "1", BETA: "2" } });
    await rebind(ctx, "agent-same", {
      envVars: { BETA: "2", ALPHA: "1" },
      executionMode: "byoc",
      runtimeConfig: {
        provider: { kind: "default" },
        envVars: { BETA: "2", ALPHA: "1" },
        reasoningEffort: null,
        mode: { kind: "default" },
        model: { kind: "preset", id: "sonnet" },
        runtime: "claude",
        version: RUNTIME_CONFIG_VERSION,
      },
    });
    await sweep(ctx);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(specStops(ctx), []);
  });
});

test("a change outside the whitelist (description, workspace path, a field added later) is no drift", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-other");
    await rebind(ctx, "agent-other", {
      description: "another role",
      displayName: "Renamed",
      runtimeContext: { agentId: "agent-other", workspacePath: "/somewhere/else" },
      someFieldAddedLater: "x",
    } as Partial<AgentConfig>);
    await sweep(ctx);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(specStops(ctx), []);
  });
});

test("another Codex model: the next start opens a new session, and a later start naming the old one drops it", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-codex", { runtime: "codex", model: "gpt-5.5" });
    await rebind(ctx, "agent-codex", { runtime: "codex", model: "gpt-5.4" });
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    assert.deepEqual(specStops(ctx).map((stop) => [stop.drift, stop.new_session]), [["model", true]]);
    await flush();
    const snapshot = restartSnapshot(ctx.manager, "agent-codex")!;
    assert.equal(snapshot.sessionId, null, "no Codex thread to resume on another model");
    assert.equal(snapshot.config.sessionId, null);

    // The Server's next start still names the old thread.
    await ctx.manager.startAgent("agent-codex", makeConfig({ runtime: "codex", model: "gpt-5.4", sessionId: "session-agent-codex" }));
    assert.equal(ctx.driver.spawnCalls.length, 2);
    assert.equal(ctx.driver.spawnCalls[1]!.config.sessionId, null, "a new session");
    assert.deepEqual(sessionDrops(ctx), [{ agentId: "agent-codex", launchId: undefined, reason: "codex_model_changed", host: "legacy" }]);
    assert.equal(JSON.stringify(sessionDrops(ctx)).includes("gpt-5"), false, "no model names");
  });
});

test("another runtime: the next start opens a new session on the new runtime, and a later start naming the old one drops it", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-switch", { runtime: "claude", model: "sonnet" });
    ctx.manager.applyConfig("agent-switch", makeConfig({ runtime: "codex", model: "gpt-5.5", agentCredentialKey: null }), 2);
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    assert.ok(String(specStops(ctx)[0]!.drift).split(",").includes("runtime"));
    await flush();
    // Reconciler step 11 (decision 1): no restart snapshot; the server's next start runs it.
    assert.equal(restartSnapshot(ctx.manager, "agent-switch"), undefined);

    await ctx.manager.startAgent("agent-switch", makeConfig({ runtime: "codex", model: "gpt-5.5", sessionId: "session-agent-switch" }));
    assert.equal(ctx.driver.spawnCalls[1]!.config.runtime, "codex");
    assert.equal(ctx.driver.spawnCalls[1]!.config.sessionId, null);
    assert.deepEqual(sessionDrops(ctx).map((drop) => drop.reason), ["runtime_changed"]);
  });
});

test("a per-turn runtime is not stopped for a spec change on its runtime: its next turn's process reads the config; another runtime stops it", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-per-turn");
    await rebind(ctx, "agent-per-turn", { model: "opus" });
    await sweep(ctx);
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.equal(ap.config.model, "opus");
    assert.deepEqual(specStops(ctx), []);

    // The binding fence would refuse the rest of its turn.
    ctx.manager.applyConfig("agent-per-turn", makeConfig({ runtime: "codex", model: "gpt-5.5", agentCredentialKey: null }), 2);
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    assert.deepEqual(specStops(ctx).map((stop) => [stop.drift, stop.hand_to_server]), [["runtime", true]]);
  }, new FakeDriver({ perTurn: true }));
});
