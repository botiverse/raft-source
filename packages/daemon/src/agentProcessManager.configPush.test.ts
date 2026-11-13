// Reconciler step 11a in the agent manager (legacy host): `agent:config`
// pushes the agent's current config to its running process without waking it.
// The process takes it as a rebound start does (one helper,
// replaceRunningConfig); a spec that drifted stops it once idle, the next
// start runs on it. A push before the process registered is held and applied
// at registration only if newer than the start. A stop for another runtime is
// not started again from the restart snapshot (decision 1): the next delivery
// finds no process and the server starts the agent. A process whose config
// drops its session never reports that session again (#13295 residual).
//
// RED proof: drop the reconcile call in replaceRunningConfig and the idle and
// turn-end stops never happen; skip applyHeldConfigPush and the registered
// process keeps its start's model; drop the revision compare in
// AgentConfigRevisions.heldPushApplies and the stale held push applies; keep
// the restart snapshot on a runtime spec stop and the next delivery restarts
// locally; stop it the cold-idle way instead of releasing it and a delivery in
// the grace restarts it here; send `agent:session` unguarded and the Codex session is reported
// after the push.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.runtimeSpec.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { AgentHostRouter } from "./agentHost/agentHostRouter";
import { SPEC_HANDBACK_START_DEADLINE_MS } from "./specHandbacks";
import { harness as oarHarness, makeConfig as oarConfig, message as oarMessage, until } from "./testing/oarAgentHostHarness";

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

class FakeDriver implements RuntimeDriver {
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
  readonly terminateProcessOnTurnEnd = false;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();

  /** `closeOnKill: false`: a stop's grace runs until the test closes the process. */
  constructor(private readonly options: { closeOnKill?: boolean } = {}) {}

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const child = new FakeChildProcess(this.options.closeOnKill !== false);
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

/** What the server pushes: its config, never a runner credential. */
const pushed = (overrides: Partial<AgentConfig> = {}): AgentConfig => makeConfig({ agentCredentialKey: null, ...overrides });

type Ctx = {
  driver: FakeDriver;
  manager: AgentProcessManager;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  frames: MachineToServerMessage[];
};

async function withManager(fn: (ctx: Ctx) => Promise<void>, driver = new FakeDriver(), options: { specHandbackDeadlineMs?: number; daemonInstanceId?: string } = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-config-push-test-"));
  const frames: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager(
    (msg) => { frames.push(msg); },
    "sk_machine_test",
    { dataDir, serverUrl: "https://daemon.example.com", driverResolver: () => driver, runtimeSessionHomeDir: dataDir, ...options },
  );
  const events: Ctx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, events, frames });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A running process, idle after its first turn, on `session-<agentId>`. */
async function startIdle(ctx: Ctx, agentId: string, config: Partial<AgentConfig> = {}) {
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId: `session-${agentId}`, ...config }));
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = `session-${agentId}`;
  (ctx.manager as any).commitApmIdleState(agentId, ap, true);
  return ap;
}

function emitTurnEnd(ctx: Ctx, agentId: string): void {
  const line = `turn-end-${agentId}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{ kind: "turn_end", sessionId: `session-${agentId}` }]);
  ctx.driver.processes.at(-1)!.stdout.emit("data", Buffer.from(`${line}\n`));
}

function emitSessionInit(ctx: Ctx, agentId: string, sessionId: string): void {
  const line = `session-init-${agentId}-${ctx.driver.parsedLines.size}`;
  ctx.driver.parsedLines.set(line, [{ kind: "session_init", sessionId }]);
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
    content: `hello-unique-${seq}`,
    timestamp: new Date().toISOString(),
  } as AgentMessage;
}

const specStops = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);
const pushEvents = (ctx: Ctx) => ctx.events.filter((event) => event.name === "daemon.agent.config_push").map((event) => event.attrs);
const sessionFrames = (ctx: Ctx) => ctx.frames.filter((frame) => frame.type === "agent:session");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

test("a push while busy stops nothing; the turn end with an empty inbox stops it for the spec, never a wake", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-busy", makeConfig({ sessionId: "session-agent-busy" }));
    const ap = (ctx.manager as any).agents.get("agent-busy");
    assert.equal(ap.gatedSteering.isIdle, false, "precondition: the first turn is running");

    ctx.manager.applyConfig("agent-busy", pushed({ model: "opus", sessionId: "server-session" }), 7);
    await flush();
    assert.equal(ctx.driver.processes[0]!.killed, false, "not under a running turn");
    assert.equal(ctx.driver.spawnCalls.length, 1, "a push never starts a process");
    assert.equal(ap.config.model, "opus");
    assert.equal(ap.config.sessionId, "session-agent-busy", "the process keeps its session");
    assert.equal(ap.config.agentCredentialKey, "sk_agent_test", "and its runner credential");
    assert.deepEqual(pushEvents(ctx), [{ agentId: "agent-busy", revision: 7, outcome: "applied", stage: "running", launchId: undefined, drift: "model" }]);
    assert.deepEqual(ctx.frames.filter((frame) => frame.type === "agent:start:ack" || frame.type === "agent:session"), [], "no launch, no session report");

    emitTurnEnd(ctx, "agent-busy");
    assert.equal(ctx.driver.processes[0]!.kills, 1, "stopped at the turn end");
    assert.deepEqual(specStops(ctx).map((stop) => [stop.drift, stop.trigger, stop.host]), [["model", "turn_end", "legacy"]]);
    await flush();
    const snapshot = (ctx.manager as any).lifecycleRecords.getRestartSnapshot("agent-busy");
    assert.equal(snapshot.config.model, "opus", "the next wake starts on the pushed config");
    assert.equal(snapshot.sessionId, "session-agent-busy", "resuming the session (another Claude model)");
    assert.equal(ctx.driver.spawnCalls.length, 1, "nothing restarted it");
  });
});

test("a push with the same spec changes nothing: no stop, no spawn", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdle(ctx, "agent-same");
    ctx.manager.applyConfig("agent-same", pushed({ description: "another role" }), 2);
    await flush();
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.equal(ctx.driver.spawnCalls.length, 1);
    assert.deepEqual(specStops(ctx), []);
    assert.equal(ap.config.description, "another role");
  });
});

test("managed MCP and provider connection revisions drift only when both sides carry them", async () => {
  await withManager(async (ctx) => {
    // Started without (an older server): a push that names them is no drift.
    await startIdle(ctx, "agent-old");
    ctx.manager.applyConfig("agent-old", pushed({ managedMcpFingerprint: "mcp-1", providerConnectionRevision: 3 }), 1);
    assert.equal(ctx.driver.processes[0]!.killed, false);

    // Started with them: a change of either stops the idle process.
    await startIdle(ctx, "agent-mcp", { managedMcpFingerprint: "mcp-1", providerConnectionRevision: 3 });
    ctx.manager.applyConfig("agent-mcp", pushed({ managedMcpFingerprint: "mcp-1" }), 1);
    assert.equal(ctx.driver.processes[1]!.killed, false, "absent in the push: no drift");
    ctx.manager.applyConfig("agent-mcp", pushed({ managedMcpFingerprint: "mcp-2", providerConnectionRevision: 4 }), 2);
    assert.equal(ctx.driver.processes[1]!.kills, 1);
    assert.deepEqual(specStops(ctx).map((stop) => stop.drift), ["managed_mcp,provider_connection"]);
  });
});

test("a push before the process registered is applied at registration when newer than its start, and dropped when not", async () => {
  await withManager(async (ctx) => {
    ctx.manager.configRevisions.noteStart("agent-new", 4);
    const started = ctx.manager.startAgent("agent-new", makeConfig({ sessionId: "session-agent-new" }));
    assert.equal((ctx.manager as any).agents.has("agent-new"), false, "precondition: not registered yet");
    ctx.manager.applyConfig("agent-new", pushed({ model: "opus" }), 5);
    await started;
    const ap = (ctx.manager as any).agents.get("agent-new");
    assert.equal(ap.config.model, "opus", "the registered process takes the held push");
    assert.equal(ctx.driver.spawnCalls[0]!.config.model, "sonnet", "it spawned on its start's config");
    assert.deepEqual(pushEvents(ctx).map((event) => [event.outcome, event.stage ?? null]), [["held_until_registered", null], ["applied", "registered"]]);

    ctx.manager.configRevisions.noteStart("agent-stale", 6);
    const stale = ctx.manager.startAgent("agent-stale", makeConfig());
    ctx.manager.applyConfig("agent-stale", pushed({ model: "opus" }), 5);
    await stale;
    assert.equal((ctx.manager as any).agents.get("agent-stale").config.model, "sonnet", "not newer than the start: dropped");

    ctx.manager.configRevisions.noteStart("agent-unknown", undefined);
    const unknown = ctx.manager.startAgent("agent-unknown", makeConfig());
    ctx.manager.applyConfig("agent-unknown", pushed({ model: "opus" }), 9);
    await unknown;
    assert.equal((ctx.manager as any).agents.get("agent-unknown").config.model, "sonnet", "a start with no revision: dropped");
    assert.deepEqual(pushEvents(ctx).filter((event) => event.outcome === "held_dropped_stale").map((event) => event.agentId), ["agent-stale", "agent-unknown"]);
  });
});

test("a runtime change stops the idle process and hands the next start to the server: no local restart", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-switch");
    ctx.manager.applyConfig("agent-switch", pushed({ runtime: "codex", model: "gpt-5.5" }), 3);
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    assert.equal(specStops(ctx)[0]!.hand_to_server, true);
    await flush();
    assert.equal((ctx.manager as any).lifecycleRecords.getRestartSnapshot("agent-switch"), undefined, "no restart state kept");
    assert.equal(ctx.manager.agentHostState("agent-switch"), "none");

    let rejected = 0;
    const accepted = await ctx.manager.deliverMessage("agent-switch", message(1), { onRejectedNoProcess: () => { rejected += 1; } });
    assert.equal(accepted, false);
    assert.equal(rejected, 1, "the server converts it into its start");
    assert.equal(ctx.driver.spawnCalls.length, 1, "nothing started here");
  });
});

test("a delivery and a tracked mention during a runtime-change stop's grace go to the server; nothing restarts here, the server's start waits for the exit", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-grace");
    const ap = (ctx.manager as any).agents.get("agent-grace");
    ap.launchId = "launch-1";
    ctx.manager.applyConfig("agent-grace", pushed({ runtime: "codex", model: "gpt-5.5" }), 3);
    const old = ctx.driver.processes[0]!;
    assert.equal(old.kills, 1, "the idle stop began; its grace runs until the test closes it");
    assert.equal(ctx.manager.agentHostState("agent-grace"), "none", "released at once: the router places the next start");

    // What the server sees for a plain delivery: agent:delivery:rejected (no_process), converted into its start.
    let rejected = 0;
    assert.equal(await ctx.manager.deliverMessage("agent-grace", message(1), { deliveryId: "delivery-1", onRejectedNoProcess: () => { rejected += 1; } }), false);
    assert.equal(rejected, 1);
    // A tracked mention: a terminal error, on which the server redelivers it untracked (then refused as above).
    const terminal: string[] = [];
    let mentionRejected = 0;
    const mention = message(2);
    assert.equal(await ctx.manager.deliverMessage("agent-grace", mention, {
      deliveryId: "occ-1",
      mentionDelivery: { occurrenceId: "occ-1", messageId: mention.message_id!, machineId: "machine-1", launchId: "launch-1", sessionId: "session-agent-grace" },
      onMentionTerminalError: (code) => { terminal.push(code); },
      onRejectedNoProcess: () => { mentionRejected += 1; },
    }), false);
    assert.deepEqual(terminal, ["IDENTITY_UNKNOWN"]);
    assert.equal(mentionRejected, 0, "ended by its terminal error, not left pending");
    assert.equal((ctx.manager as any).trackedMentionDeliveries.size, 0, "nothing held for it here");

    // The server's converted start (here, as the router would run it on this host) waits for the exit.
    const buildSpawnConfig = (ctx.manager as any).buildSpawnConfig.bind(ctx.manager);
    (ctx.manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => buildSpawnConfig(agentId, { ...config, agentCredentialKey: config.agentCredentialKey ?? "sk_agent_test" });
    const started = ctx.manager.startAgent("agent-grace", makeConfig({ runtime: "codex", model: "gpt-5.5" }), message(1));
    for (let i = 0; i < 10; i += 1) await flush();
    assert.equal(ctx.driver.spawnCalls.length, 1, "no process while the old one is still exiting");
    old.close();
    await started;
    assert.equal(ctx.driver.spawnCalls.length, 2);
    assert.equal(ctx.driver.spawnCalls[1]!.config.runtime, "codex");
    assert.equal(occurrences(ctx.driver.spawnCalls[1]!.prompt, "hello-unique-1"), 1, "the refused delivery arrives once, as the start's wake");
    assert.deepEqual(ctx.events.filter((event) => event.name === "daemon.agent.spec_restart_handed_to_server").map((event) => event.attrs.stage), ["stop"]);
  }, new FakeDriver({ closeOnKill: false }));
});

/** The activity a refused delivery reported for the agent (the last one sent). */
const refusalActivity = (ctx: Ctx, agentId: string) => {
  const frame = ctx.frames.filter((each): each is Extract<MachineToServerMessage, { type: "agent:activity" }> => each.type === "agent:activity" && each.agentId === agentId).at(-1);
  return frame ? { detailKind: frame.detailKind, detail: frame.detail } : null;
};

test("step 11c: a delivery refused after a runtime-change handback reports a start, not an unavailable runtime; real unavailability still asks for a restart", async () => {
  await withManager(async (ctx) => {
    // The spec stop of a running process.
    await startIdle(ctx, "agent-switch");
    ctx.manager.applyConfig("agent-switch", pushed({ runtime: "codex", model: "gpt-5.5" }), 3);
    await flush();
    assert.equal(await ctx.manager.deliverMessage("agent-switch", message(1)), false);
    assert.deepEqual(refusalActivity(ctx, "agent-switch"), { detailKind: "starting", detail: "Starting with the new runtime config\u2026" });
    // Every refusal until the server's start lands says the same.
    assert.equal(await ctx.manager.deliverMessage("agent-switch", message(2)), false);
    assert.equal(refusalActivity(ctx, "agent-switch")?.detailKind, "starting");
    // A start on either host ends it (the router calls this for an OAR start too).
    ctx.manager.forgetSpecHandback("agent-switch");
    assert.equal(await ctx.manager.deliverMessage("agent-switch", message(3)), false);
    assert.deepEqual(refusalActivity(ctx, "agent-switch"), { detailKind: "runtime_unavailable", detail: "Process unavailable; restart required" });

    // An idle agent whose restart snapshot a runtime push dropped.
    await startIdle(ctx, "agent-idle");
    ctx.manager.applyConfig("agent-idle", pushed({ envVars: { A: "1" } }), 1);
    await flush();
    ctx.manager.applyConfig("agent-idle", pushed({ runtime: "codex", model: "gpt-5.5" }), 2);
    assert.equal(await ctx.manager.deliverMessage("agent-idle", message(4)), false);
    assert.equal(refusalActivity(ctx, "agent-idle")?.detailKind, "starting");
    // An explicit stop ends it too.
    await ctx.manager.stopAgent("agent-idle");
    assert.equal(await ctx.manager.deliverMessage("agent-idle", message(5)), false);
    assert.equal(refusalActivity(ctx, "agent-idle")?.detailKind, "runtime_unavailable");

    // An agent with no process and no handback: unavailable, as before.
    assert.equal(await ctx.manager.deliverMessage("agent-never", message(6)), false);
    assert.deepEqual(refusalActivity(ctx, "agent-never"), { detailKind: "runtime_unavailable", detail: "Process unavailable; restart required" });
  });
});

// Step 11d. RED proof: read `specHandbacks.has` again in the refusal path (no
// deadline) and the refusal at 60 s still reports a start.
test("step 11d: a handback reports a start only for its deadline; a refusal after it asks for a restart and ends the handback", async () => {
  await withManager(async (ctx) => {
    let now = 1_000_000;
    (ctx.manager as any).readWallClock = () => now;
    await startIdle(ctx, "agent-switch");
    ctx.manager.applyConfig("agent-switch", pushed({ runtime: "codex", model: "gpt-5.5" }), 3);
    await flush();
    assert.equal(ctx.manager.specHandbacks.has("agent-switch"), true, "precondition: handed back at the spec stop");
    const handedBackAt = now;

    now = handedBackAt + SPEC_HANDBACK_START_DEADLINE_MS - 1;
    assert.equal(await ctx.manager.deliverMessage("agent-switch", message(1)), false);
    assert.deepEqual(refusalActivity(ctx, "agent-switch"), { detailKind: "starting", detail: "Starting with the new runtime config…" });

    // The server's start never came.
    now = handedBackAt + SPEC_HANDBACK_START_DEADLINE_MS;
    assert.equal(await ctx.manager.deliverMessage("agent-switch", message(2)), false);
    assert.deepEqual(refusalActivity(ctx, "agent-switch"), { detailKind: "runtime_unavailable", detail: "Process unavailable; restart required" });
    assert.equal(ctx.manager.specHandbacks.has("agent-switch"), false, "the deadline ends the handback");
    // Also if the clock steps back: it stays ended.
    now = handedBackAt;
    assert.equal(await ctx.manager.deliverMessage("agent-switch", message(3)), false);
    assert.equal(refusalActivity(ctx, "agent-switch")?.detailKind, "runtime_unavailable");
  });
});

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const unavailableReports = (ctx: Ctx, agentId: string) => ctx.frames.filter((frame) => frame.type === "agent:activity" && frame.agentId === agentId && frame.detailKind === "runtime_unavailable").length;
const SHORT_DEADLINE_MS = 80;

/** A runtime-change handback whose first refusal reported the start. */
async function handBackAndRefuse(ctx: Ctx, agentId: string): Promise<void> {
  await startIdle(ctx, agentId);
  ctx.manager.applyConfig(agentId, pushed({ runtime: "codex", model: "gpt-5.5" }), 3);
  await flush();
  assert.equal(await ctx.manager.deliverMessage(agentId, message(1)), false);
  assert.equal(refusalActivity(ctx, agentId)?.detailKind, "starting");
}

// Step 11d. RED proof: drop the `armDeadline` call in the refusal path and the
// agent shows "starting" for ever.
test("step 11d: with no start and no further delivery, a handback that reported a start turns to runtime_unavailable at its deadline", async () => {
  await withManager(async (ctx) => {
    await handBackAndRefuse(ctx, "agent-switch");
    await waitFor(() => refusalActivity(ctx, "agent-switch")?.detailKind === "runtime_unavailable", "runtime_unavailable at the deadline");
    assert.deepEqual(refusalActivity(ctx, "agent-switch"), { detailKind: "runtime_unavailable", detail: "Process unavailable; restart required" });
    assert.equal(ctx.manager.specHandbacks.has("agent-switch"), false, "the deadline ends the handback");
    const lastStatus = ctx.frames.filter((frame): frame is Extract<MachineToServerMessage, { type: "agent:status" }> => frame.type === "agent:status" && frame.agentId === "agent-switch").at(-1);
    assert.equal(lastStatus?.status, "inactive");
    await new Promise((resolve) => setTimeout(resolve, SHORT_DEADLINE_MS * 2));
    assert.equal(unavailableReports(ctx, "agent-switch"), 1, "reported once");
  }, new FakeDriver(), { specHandbackDeadlineMs: SHORT_DEADLINE_MS });
});

// #13385: a Node timer may fire before Date.now() has moved its full delay.
// Here the wall clock lags the timers by 20 ms from the refusal on, so the
// first firing is early. RED proof: decide once when the timer fires (no
// re-arm) and the status never turns.
test("step 11d: a deadline timer that fires before the clock reached the deadline re-arms and still reports", async () => {
  const realNow = Date.now;
  try {
    await withManager(async (ctx) => {
      await handBackAndRefuse(ctx, "agent-switch");
      Date.now = () => realNow.call(Date) - 20;
      await waitFor(() => refusalActivity(ctx, "agent-switch")?.detailKind === "runtime_unavailable", "runtime_unavailable after the early firing");
      assert.equal(ctx.manager.specHandbacks.has("agent-switch"), false);
    }, new FakeDriver(), { specHandbackDeadlineMs: SHORT_DEADLINE_MS });
  } finally {
    Date.now = realNow;
  }
});

// RED proof: leave the timer armed in `SpecHandbacks.forget` and
// runtime_unavailable is broadcast for the stopped agent (the started one
// is also covered by the process check in reportSpecHandbackDeadline).
test("step 11d: a start or an explicit stop before the deadline cancels it: no runtime_unavailable", async () => {
  await withManager(async (ctx) => {
    await handBackAndRefuse(ctx, "agent-started");
    // The server's start (on this host: it ends the handback itself, as the router does for either host).
    await ctx.manager.startAgent("agent-started", makeConfig({ runtime: "codex", model: "gpt-5.5" }));
    assert.equal(ctx.manager.specHandbacks.has("agent-started"), false);
    await handBackAndRefuse(ctx, "agent-stopped");
    await ctx.manager.stopAgent("agent-stopped");
    await new Promise((resolve) => setTimeout(resolve, SHORT_DEADLINE_MS * 3));
    assert.equal(unavailableReports(ctx, "agent-started"), 0);
    assert.equal(unavailableReports(ctx, "agent-stopped"), 0);
    assert.equal(ctx.events.some((event) => event.name === "daemon.agent.spec_handback_deadline"), false);
  }, new FakeDriver(), { specHandbackDeadlineMs: SHORT_DEADLINE_MS });
});

test("an idle agent with only a restart snapshot: the snapshot takes the push; a runtime change drops it for the server", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-idle");
    ctx.manager.applyConfig("agent-idle", pushed({ envVars: { A: "1" } }), 1);
    await flush();
    assert.equal(ctx.driver.processes[0]!.kills, 1);
    ctx.manager.applyConfig("agent-idle", pushed({ envVars: { A: "1" }, model: "opus" }), 2);
    const snapshot = (ctx.manager as any).lifecycleRecords.getRestartSnapshot("agent-idle");
    assert.equal(snapshot.config.model, "opus");
    assert.equal(snapshot.sessionId, "session-agent-idle");
    assert.equal(snapshot.config.agentCredentialKey ?? null, null, "credential-free");

    ctx.manager.applyConfig("agent-idle", pushed({ runtime: "codex", model: "gpt-5.5" }), 3);
    assert.equal((ctx.manager as any).lifecycleRecords.getRestartSnapshot("agent-idle"), undefined);
    assert.equal(ctx.driver.spawnCalls.length, 1);
  });
});

test("Codex model change: the old session is never reported after the push (session init, rebind, turn end, getAgentSessionId)", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-codex", makeConfig({ runtime: "codex", model: "gpt-5.5", sessionId: null }));
    emitSessionInit(ctx, "agent-codex", "thread-1");
    assert.equal(sessionFrames(ctx).length, 1, "precondition: the session is reported before the push");
    assert.equal(ctx.manager.getAgentSessionId("agent-codex"), "thread-1");

    ctx.manager.applyConfig("agent-codex", pushed({ runtime: "codex", model: "gpt-5.4" }), 2);
    assert.equal(ctx.manager.getAgentSessionId("agent-codex"), null, "the reconnect replay reads this");
    emitSessionInit(ctx, "agent-codex", "thread-1");
    await ctx.manager.startAgent("agent-codex", makeConfig({ runtime: "codex", model: "gpt-5.4", sessionId: null }));
    emitTurnEnd(ctx, "agent-codex");
    assert.equal(sessionFrames(ctx).length, 1, "nothing reported after the push");
    assert.equal(ctx.driver.processes[0]!.kills, 1, "stopped at the turn end");
    await flush();
    assert.equal((ctx.manager as any).lifecycleRecords.getRestartSnapshot("agent-codex")?.sessionId ?? null, null);
  });
});

test("a delivery right after the idle stop reaches the next process exactly once", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-race");
    // The restart's credential, without the network.
    const buildSpawnConfig = (ctx.manager as any).buildSpawnConfig.bind(ctx.manager);
    (ctx.manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => buildSpawnConfig(agentId, { ...config, agentCredentialKey: config.agentCredentialKey ?? "sk_agent_test" });
    ctx.manager.applyConfig("agent-race", pushed({ model: "opus" }), 1);
    const old = ctx.driver.processes[0]!;
    assert.equal(old.kills, 1, "the idle stop began");

    // Within the stop's grace: queued for the process's close.
    assert.equal(await ctx.manager.deliverMessage("agent-race", message(42)), true);
    assert.equal(ctx.driver.spawnCalls.length, 1);
    old.close();
    // The start queue paces starts: wait for the pump.
    for (const deadline = Date.now() + 3_000; ctx.driver.spawnCalls.length < 2 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ctx.driver.spawnCalls.length, 2, "started again for it");
    const next = ctx.driver.spawnCalls[1]!;
    assert.equal(next.config.model, "opus", "on the pushed config");
    assert.equal(occurrences(next.prompt, "hello-unique-42"), 1, "the message once");
    const inbox = (ctx.manager as any).agents.get("agent-race").inbox as AgentMessage[];
    assert.equal(inbox.filter((queued) => queued.message_id === "msg-42").length, 1, "tracked once, as the startup input it was");
    assert.equal(ctx.driver.spawnCalls.length, 2, "one restart");
  }, new FakeDriver({ closeOnKill: false }));
});

// Reconciler step 11 (review of #13355): a start older than the applied
// config rebinds its launch, session and wake, but the config stays. RED
// proof: replace with start.config regardless (isStaleStart ignored) and the
// running config goes back to r5.
test("a start older than the applied push rebinds launch, session and wake, but keeps the pushed config; an equal one replaces it", async () => {
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-order", makeConfig({ sessionId: "session-agent-order" }));
    const ap = (ctx.manager as any).agents.get("agent-order");
    ap.sessionId = "session-agent-order";
    assert.equal(ap.gatedSteering.isIdle, false, "precondition: busy, so the push stops nothing");

    // r6 arrives first (the core accepts it), then the r5 start built before it.
    assert.equal(ctx.manager.configRevisions.acceptPush("agent-order", 6), true);
    ctx.manager.applyConfig("agent-order", pushed({ model: "opus" }), 6);
    const r5 = makeConfig({ model: "sonnet", sessionId: "session-agent-order" });
    ctx.manager.configRevisions.noteStart("agent-order", 5, r5);
    await ctx.manager.startAgent("agent-order", r5, message(9), undefined, undefined, "launch-5");

    assert.equal(ap.config.model, "opus", "the newer config stays");
    assert.equal((ctx.manager as any).lifecycleRecords.getRestartSnapshot("agent-order").config.model, "opus");
    assert.equal(ap.launchId, "launch-5", "the launch rebinds");
    assert.deepEqual(sessionFrames(ctx).at(-1), { type: "agent:session", agentId: "agent-order", sessionId: "session-agent-order", launchId: "launch-5" });
    const routed = ctx.events.filter((event) => event.name === "daemon.agent.delivery.routed" && event.attrs.messageId === "msg-9");
    assert.equal(routed.length, 1, "the wake is delivered");
    assert.equal(routed[0]!.attrs.accepted, true);
    assert.equal(ctx.driver.spawnCalls.length, 1, "a rebind, not a new process");
    assert.ok(pushEvents(ctx).some((event) => event.outcome === "stale_start_config_kept"));

    // Equal revision: the start's config is the server's (the same one), so it is taken.
    const r6 = makeConfig({ model: "haiku", sessionId: "session-agent-order" });
    ctx.manager.configRevisions.noteStart("agent-order", 6, r6);
    await ctx.manager.startAgent("agent-order", r6, undefined, undefined, undefined, "launch-6");
    assert.equal(ap.config.model, "haiku");
  });
});

test("a stale start that registers a new process: the push it is older than applies at registration", async () => {
  await withManager(async (ctx) => {
    ctx.manager.configRevisions.noteStart("agent-fresh", 4, undefined);
    await startIdle(ctx, "agent-fresh");
    assert.equal(ctx.manager.configRevisions.acceptPush("agent-fresh", 6), true);
    ctx.manager.applyConfig("agent-fresh", pushed({ model: "opus" }), 6);
    assert.equal(ctx.driver.processes[0]!.kills, 1, "idle: stopped for the push");
    await flush();
    // The server's r5 start, built before the push, arrives after the process is gone.
    (ctx.manager as any).lifecycleRecords.deleteRestartSnapshot("agent-fresh");
    const r5 = makeConfig({ model: "sonnet" });
    ctx.manager.configRevisions.noteStart("agent-fresh", 5, r5);
    await ctx.manager.startAgent("agent-fresh", r5);
    assert.equal(ctx.driver.spawnCalls[1]!.config.model, "sonnet", "it spawned on its start's config");
    assert.equal((ctx.manager as any).agents.get("agent-fresh").config.model, "opus", "the newer push applies at registration");
  });
});

test("step 11c: after an OAR runtime-change handback the legacy host's refusal reports a start; the next start and an explicit stop end it", async () => {
  // The daemon's wiring: the legacy host's handback store is the OAR host's (core.ts).
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "oar-handback-test-"));
  const legacyFrames: MachineToServerMessage[] = [];
  const legacy = new AgentProcessManager((frame) => { legacyFrames.push(frame); }, "sk_machine_test", { dataDir, serverUrl: "https://daemon.example.com", runtimeSessionHomeDir: dataDir });
  const h = await oarHarness({ deps: { specHandbacks: legacy.specHandbacks } });
  const router = new AgentHostRouter(legacy, h.host, { recordEvent: () => {}, settleNotSpawned: h.settleNotSpawned, releaseUnusedCredential: () => {} });
  const refusal = () => {
    const frame = legacyFrames.filter((each): each is Extract<MachineToServerMessage, { type: "agent:activity" }> => each.type === "agent:activity" && each.agentId === "agent-1").at(-1);
    return frame ? { detailKind: frame.detailKind, detail: frame.detail } : null;
  };
  const handBack = async (revision: number) => {
    await until(() => h.sessions.at(-1)?.status().value.kind === "idle", "idle");
    router.applyConfig("agent-1", oarConfig({ runtime: "codex", model: "gpt-5.5" }), revision);
    assert.equal(h.host.owns("agent-1"), false, "handed to the server");
    await h.host.unwound("agent-1");
  };
  try {
    await router.startAgent("agent-1", oarConfig(), undefined, undefined, undefined, "launch-1");
    await handBack(2);
    let rejected = 0;
    assert.equal(await router.deliverMessage("agent-1", oarMessage("m-1"), { onRejectedNoProcess: () => { rejected += 1; } }), false);
    assert.equal(rejected, 1, "refused to the server, which starts the agent");
    assert.deepEqual(refusal(), { detailKind: "starting", detail: "Starting with the new runtime config\u2026" });

    // The server's start (here on the OAR host again) ends it.
    await router.startAgent("agent-1", oarConfig({ model: "grok-other" }), undefined, undefined, undefined, "launch-2");
    assert.equal(legacy.specHandbacks.has("agent-1"), false, "a start on the OAR host ends the handback");

    // Handed back again, then stopped on purpose: unavailable, as before.
    await handBack(3);
    await router.stopAgent("agent-1");
    assert.equal(await router.deliverMessage("agent-1", oarMessage("m-2")), false);
    assert.deepEqual(refusal(), { detailKind: "runtime_unavailable", detail: "Process unavailable; restart required" });
  } finally {
    await h.cleanup();
    await releaseAgentManagerForTests(legacy);
    await rm(dataDir, { recursive: true, force: true });
  }
});

// task #1357 item 1: a Pi session reports the revision of the config it was
// built from. A push the running session takes without a rebuild leaves its
// report on the old revision; the session rebuilt on the pushed config
// reports the new one. The core stamps `configRevision` on every config it
// hands over (withConfigRevision); these configs carry it as that would.
// RED proof: a restart config that drops `configRevision`
// (buildRestartSafeConfig) leaves the rebuilt session unreported; drop the
// null-revision check and the older-server case sends a frame.
const LIMITS = {
  contextWindow: { value: 200_000, source: "raft_default" },
  maxTokens: { value: 8192, source: "raft_default" },
} as const;

function emitModelLimits(ctx: Ctx, agentId: string): void {
  const line = `model-limits-${agentId}-${ctx.driver.parsedLines.size}`;
  const revision = ctx.driver.spawnCalls.at(-1)!.config.configRevision;
  ctx.driver.parsedLines.set(line, [{ kind: "model_limits", sessionId: `session-${agentId}`, configRevision: typeof revision === "number" ? revision : null, modelLimits: LIMITS }]);
  ctx.driver.processes.at(-1)!.stdout.emit("data", Buffer.from(`${line}\n`));
}

const limitsFrames = (ctx: Ctx) => ctx.frames.filter((frame): frame is Extract<MachineToServerMessage, { type: "agent:model_limits" }> => frame.type === "agent:model_limits");

test("task #1357: a push without a rebuild keeps the session's report on its build revision; the rebuilt session reports the pushed one", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-limits", { configRevision: 3 });
    const buildSpawnConfig = (ctx.manager as any).buildSpawnConfig.bind(ctx.manager);
    (ctx.manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => buildSpawnConfig(agentId, { ...config, agentCredentialKey: config.agentCredentialKey ?? "sk_agent_test" });
    emitModelLimits(ctx, "agent-limits");
    assert.deepEqual(limitsFrames(ctx).map((frame) => [frame.configRevision, frame.seq]), [[3, 1]]);

    ctx.manager.applyConfig("agent-limits", pushed({ description: "renamed", configRevision: 4 }), 4);
    await flush();
    assert.equal(ctx.driver.spawnCalls.length, 1, "same spec: the session keeps running");
    assert.deepEqual(ctx.manager.getModelLimitsReports().map((frame) => frame.configRevision), [3], "the running session was built from 3");
    assert.equal(limitsFrames(ctx).length, 1);

    ctx.manager.applyConfig("agent-limits", pushed({ model: "opus", configRevision: 5 }), 5);
    const old = ctx.driver.processes[0]!;
    assert.equal(old.kills, 1, "the idle stop for the spec began");
    assert.equal(await ctx.manager.deliverMessage("agent-limits", message(77)), true);
    old.close();
    for (const deadline = Date.now() + 3_000; ctx.driver.spawnCalls.length < 2 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ctx.driver.spawnCalls.length, 2, "rebuilt on the pushed config");
    assert.equal(ctx.driver.spawnCalls[1]!.config.configRevision, 5);
    emitModelLimits(ctx, "agent-limits");
    assert.deepEqual(limitsFrames(ctx).map((frame) => [frame.configRevision, frame.seq]), [[3, 1], [5, 2]]);
    assert.deepEqual(ctx.manager.getModelLimitsReports().map((frame) => frame.configRevision), [5]);
    assert.ok(limitsFrames(ctx).every((frame) => frame.daemonInstanceId === "daemon-instance-1"), "each frame names its daemon instance");
  }, new FakeDriver({ closeOnKill: false }), { daemonInstanceId: "daemon-instance-1" });
});

test("task #1357: a session whose config names no revision (an older server) is not reported", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-norev");
    emitModelLimits(ctx, "agent-norev");
    assert.deepEqual(limitsFrames(ctx), []);
    assert.deepEqual(ctx.manager.getModelLimitsReports(), []);
  }, new FakeDriver(), { daemonInstanceId: "daemon-instance-1" });
});

test("task #1357: a manager without a daemon instance id reports nothing (the server orders by it)", async () => {
  await withManager(async (ctx) => {
    await startIdle(ctx, "agent-noinst", { configRevision: 2 });
    emitModelLimits(ctx, "agent-noinst");
    assert.deepEqual(limitsFrames(ctx), []);
  });
});
