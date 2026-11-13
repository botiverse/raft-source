// A runtime switch on the legacy host (Kimi Code -> Built-in, 1.0.69): the
// running process took the new config (`agent:config`, or a rebound start)
// and waited to be idle before its spec stop. From that moment the runtime
// binding fence refused its input and its output as `runtime_mismatch`
// (runtimeProcessBindingFence.ts), its own turn end included, so it was never
// seen idle, never stopped, and every delivery (a due reminder's app inbox
// notice, its idle retry) was refused again every few seconds for 26 hours.
//
// RED proof: drop the `runtimeChanged` branch in reconcileSpec and the busy
// process is never stopped (its turn end is refused); drop
// stopProcessForStartOfAnotherRuntime from startAgent and the start is
// rebound onto the old runtime's process; drop it from rebindRunningStart and
// a start that arrives while the old runtime's process registers is rebound
// onto it, its wake refused.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, RUNTIME_CONFIG_VERSION, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true };
  kills = 0;
  constructor(private readonly closeOnKill: boolean) {
    super();
  }
  get killed(): boolean {
    return this.kills > 0;
  }
  kill(): boolean {
    this.kills += 1;
    if (this.closeOnKill) this.close();
    return true;
  }
  close(): void {
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
  }
}

type Spawned = { runtime: string; ctx: SpawnContext; child: FakeChildProcess };

/** One driver per runtime id, so the binding records the runtime it spawned. */
class FakeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly terminateProcessOnTurnEnd = false;
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  constructor(readonly id: string, private readonly spawned: Spawned[], private readonly closeOnKill: boolean) {}
  spawn(ctx: SpawnContext): SpawnResult {
    const child = new FakeChildProcess(this.closeOnKill);
    this.spawned.push({ runtime: this.id, ctx, child });
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

function kimiConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent",
    displayName: "Agent",
    description: "test agent",
    model: "kimi-for-coding",
    runtime: "kimi-sdk",
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

/** A Built-in config this Computer can read (its provider is required). */
function builtinConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return kimiConfig({
    runtime: "builtin",
    model: "fake-model",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: "http://127.0.0.1:1/anthropic", apiKey: "fake" },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "fake-model" },
      mode: { kind: "default" },
    },
    ...overrides,
  } as Partial<AgentConfig>);
}

type Ctx = {
  manager: AgentProcessManager;
  spawned: Spawned[];
  driver: (runtime: string) => FakeDriver;
  store: AgentAppInboxStore;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  frames: MachineToServerMessage[];
};

async function withManager(fn: (ctx: Ctx) => Promise<void>, options: { closeOnKill?: boolean } = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "runtime-mismatch-test-"));
  const spawned: Spawned[] = [];
  const drivers = new Map<string, FakeDriver>();
  const driver = (runtime: string) => {
    let found = drivers.get(runtime);
    if (!found) {
      found = new FakeDriver(runtime, spawned, options.closeOnKill !== false);
      drivers.set(runtime, found);
    }
    return found;
  };
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const frames: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager((frame) => { frames.push(frame); }, "sk_machine_test", {
    dataDir,
    serverUrl: "https://daemon.example.com",
    driverResolver: driver,
    runtimeSessionHomeDir: dataDir,
    appInboxForAgent: () => store,
    // A start waiting for a stop's exit runs as soon as it can.
    runtimeStartScheduler: { minStartIntervalMs: 0 },
  });
  const events: Ctx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  // The restart's runner credential, without the network.
  const buildSpawnConfig = (manager as any).buildSpawnConfig.bind(manager);
  (manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => buildSpawnConfig(agentId, { ...config, agentCredentialKey: config.agentCredentialKey ?? "sk_agent_test" });
  try {
    await fn({ manager, spawned, driver, store, events, frames });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function dueReminder(store: AgentAppInboxStore, revision = "1") {
  const minted = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: "11111111-1111-4111-8111-111111111111", revision },
  });
  assert.ok(minted.ok);
  return minted.item;
}

function emit(ctx: Ctx, child: FakeChildProcess, runtime: string, event: ParsedEvent): void {
  const line = `${event.kind}-${ctx.driver(runtime).parsedLines.size}`;
  ctx.driver(runtime).parsedLines.set(line, [event]);
  child.stdout.emit("data", Buffer.from(`${line}\n`));
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
    content: `hello-${seq}`,
    timestamp: new Date().toISOString(),
  } as AgentMessage;
}

const rejections = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.runtime_binding.rejected").map((event) => `${event.attrs.direction}:${event.attrs.source}:${event.attrs.reason}`);
const specStops = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);

test("a runtime change pushed to a busy process stops it at once: its turn end would be refused, so it is never idle", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-kimi", kimiConfig({ sessionId: "kimi-session" }));
    const ap = (ctx.manager as any).agents.get("agent-kimi");
    ap.sessionId = "kimi-session";
    assert.equal(ap.gatedSteering.isIdle, false, "precondition: its turn runs");
    const kimi = ctx.spawned[0]!.child;

    ctx.manager.applyConfig("agent-kimi", builtinConfig({ agentCredentialKey: null }), 2);
    assert.equal(kimi.kills, 1, "stopped now, not at an idle moment it would never reach");
    assert.deepEqual(specStops(ctx).map((stop) => [stop.drift, stop.trigger, stop.hand_to_server]), [["runtime,model,provider", "signal", true]]);
    await flush();
    assert.equal(ctx.manager.agentHostState("agent-kimi"), "none", "handed to the server, whose start runs Built-in");

    // The late turn end of the old process and the due reminder.
    emit(ctx, kimi, "kimi-sdk", { kind: "turn_end", sessionId: "kimi-session" } as ParsedEvent);
    await ctx.manager.notifyAgentAppInbox("agent-kimi", dueReminder(ctx.store));
    await flush();
    assert.deepEqual(rejections(ctx).filter((rejection) => rejection.includes("runtime_mismatch")), [], "nothing is written to or read from a process of another runtime");
    assert.equal(ctx.spawned.length, 1, "nothing restarted here");
  });
});

test("a start of another runtime replaces the running process instead of being rebound onto it", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-start", kimiConfig({ sessionId: "kimi-session" }), undefined, undefined, undefined, "launch-kimi");
    const kimi = ctx.spawned[0]!.child;

    const started = ctx.manager.startAgent("agent-start", builtinConfig(), undefined, undefined, undefined, "launch-builtin");
    assert.equal(kimi.kills, 1, "the old runtime's process is stopped");
    for (let i = 0; i < 10 && ctx.spawned.length < 2; i += 1) await flush();
    kimi.close();
    await started;

    assert.deepEqual(ctx.spawned.map((each) => each.runtime), ["kimi-sdk", "builtin"]);
    const ap = (ctx.manager as any).agents.get("agent-start");
    assert.equal(ap.driver.id, "builtin");
    assert.equal(ap.launchId, "launch-builtin");
    assert.equal(ctx.events.some((event) => event.name === "daemon.agent.start.rebound"), false, "never rebound onto Kimi");
    assert.equal(ctx.events.filter((event) => event.name === "daemon.agent.start.replaces_process").length, 1);
    assert.deepEqual(rejections(ctx).filter((rejection) => rejection.includes("runtime_mismatch")), []);
  }, { closeOnKill: false });
});

test("a start of another runtime that arrives while the old runtime's process registers replaces it; its wake reaches the new runtime", async () => {
  await withManager(async (ctx) => {
    // The Built-in start arrives while the Kimi start is being prepared:
    // deferred, then taken after Kimi registered (`already_starting_late`).
    const buildSpawnConfig = (ctx.manager as any).buildSpawnConfig.bind(ctx.manager);
    let late: Promise<void> | undefined;
    (ctx.manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => {
      if (!late) late = ctx.manager.startAgent(agentId, builtinConfig(), message(7), undefined, undefined, "launch-builtin");
      return buildSpawnConfig(agentId, config);
    };
    await ctx.manager.startAgent("agent-late", kimiConfig({ sessionId: "kimi-session" }), undefined, undefined, undefined, "launch-kimi");
    await late;
    assert.equal(ctx.spawned[0]!.runtime, "kimi-sdk");
    assert.equal(ctx.spawned[0]!.child.kills, 1, "the Kimi process is stopped, not carrying the Built-in launch");
    assert.ok(ctx.events.some((event) => event.name === "daemon.agent.start.replaces_process" && event.attrs.launchId === "launch-builtin"));

    // Queued behind the stop's exit; the start queue runs it.
    while ((ctx.manager as any).agents.get("agent-late")?.driver.id !== "builtin") await new Promise((resolve) => setTimeout(resolve, 5));
    const next = ctx.spawned[1]!;
    assert.equal(next.runtime, "builtin");
    assert.match(next.ctx.prompt, /hello-7/, "the wake rides the Built-in start");
    const ap = (ctx.manager as any).agents.get("agent-late");
    assert.equal(ap.driver.id, "builtin");
    assert.equal(ap.launchId, "launch-builtin");
    assert.equal(ctx.events.some((event) => event.name === "daemon.agent.start.rebound"), false, "never rebound onto Kimi");
    assert.deepEqual(rejections(ctx).filter((rejection) => rejection.includes("runtime_mismatch")), []);
  });
});
