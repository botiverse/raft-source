// Reconciler step 5 (#proj-raft-computer:#48, invariant 3): every stop of a
// legacy-host runtime is SIGTERM, then after the one stop grace a SIGKILL of
// the whole process tree, and the agent is released only once the exit is
// confirmed (or given up as unconfirmed after the SIGKILL).
//
// Real processes: a runtime that ignores SIGTERM and has a grandchild
// `sleep` in its process group (Claude's background bash). Each stop path is
// triggered as the manager triggers it; the grace is shortened.
//
// RED proof (reverse-verified): drop the escalation from
// stopProcess/RuntimeSession.stop and every path's runtime survives; kill
// only the pid (forceKill without the group) and the grandchild survives;
// delete the agent before the exit (stopAgent without trackExitingRuntime)
// and "released before its exit" fails; drop the start's wait for the
// exiting runtime and the restart test spawns a second process mid-grace;
// drop the stopping-process delivery guard and the old process is written to.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./drivers/index";
import { spawnRuntimeChild } from "./drivers/runtimeChild";
import { RuntimeProcessLedger, RUNTIME_PROCESS_LEDGER_FILE } from "./drivers/runtimeProcessLedger";
import { spawn } from "node:child_process";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

const GRACE_MS = 300;
const CONFIRM_MS = 2_000;

/** A runtime that ignores SIGTERM and keeps a grandchild in its process group. */
function runtimeScript(pidFile: string): string {
  return [
    `process.on("SIGTERM", () => {});`,
    `const c = require("child_process").spawn("sleep", ["60"], { stdio: "ignore" });`,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    `process.stdin.resume();`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
}

class RealRuntimeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode: "direct" | "none";
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly terminateProcessOnTurnEnd: boolean;
  readonly spawnCalls: SpawnContext[] = [];
  readonly children: ChildProcess[] = [];
  readonly stdinWrites: string[][] = [];
  readonly pidFiles: string[] = [];

  constructor(private readonly dir: string, options: { stdin?: boolean; terminateProcessOnTurnEnd?: boolean } = {}) {
    this.supportsStdinNotification = options.stdin ?? true;
    this.busyDeliveryMode = this.supportsStdinNotification ? "direct" : "none";
    this.terminateProcessOnTurnEnd = options.terminateProcessOnTurnEnd === true;
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const pidFile = path.join(this.dir, `grandchild-${this.children.length}.pid`);
    this.pidFiles.push(pidFile);
    const child = spawnRuntimeChild(process.execPath, ["-e", runtimeScript(pidFile)], { stdio: ["pipe", "pipe", "pipe"] });
    const writes: string[] = [];
    this.stdinWrites.push(writes);
    const write = child.stdin!.write.bind(child.stdin!);
    (child.stdin as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      writes.push(chunk);
      return write(chunk);
    };
    this.children.push(child);
    return { process: child };
  }

  parseLine(): ParsedEvent[] {
    return [];
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
    sessionId: "session-1",
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    // No credential id: a stop would revoke it over the network.
    agentCredentialId: null,
    ...overrides,
  };
}

function message(seq: number): AgentMessage {
  return {
    seq,
    message_id: `msg-${seq}`,
    channel_name: "general",
    channel_type: "channel",
    sender_name: "someone",
    sender_type: "human",
    content: `hello ${seq}`,
    timestamp: new Date().toISOString(),
  } as AgentMessage;
}

type Ctx = {
  driver: RealRuntimeDriver;
  manager: AgentProcessManager;
  internals: any;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  sent: MachineToServerMessage[];
};

async function withManager(
  fn: (ctx: Ctx) => Promise<void>,
  driverOptions: { stdin?: boolean; terminateProcessOnTurnEnd?: boolean } = {},
  stopKill: { graceMs?: number; confirmMs?: number } = { graceMs: GRACE_MS, confirmMs: CONFIRM_MS },
  makeDriver?: (dir: string) => RuntimeDriver,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-stop-escalation-test-"));
  const driver = new RealRuntimeDriver(dataDir, driverOptions);
  const sent: MachineToServerMessage[] = [];
  const resolvedDriver = makeDriver?.(dataDir) ?? driver;
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    { dataDir, serverUrl: "https://daemon.example.com", driverResolver: () => resolvedDriver, runtimeSessionHomeDir: dataDir, stopKill, daemonInstanceId: "daemon-step5" },
  );
  const internals = manager as any;
  const events: Ctx["events"] = [];
  const recordDaemonEvent = internals.recordDaemonEvent.bind(manager);
  internals.recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, internals, events, sent });
  } finally {
    await manager.stopAll();
    for (const child of driver.children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const pidFile of driver.pidFiles) {
      const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
      if (pid > 0 && pidAlive(pid)) process.kill(pid, "SIGKILL");
    }
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function grandchildPid(driver: RealRuntimeDriver, index: number): Promise<number> {
  let pid = 0;
  await waitFor(async () => {
    pid = Number((await readFile(driver.pidFiles[index]!, "utf8").catch(() => "")).trim()) || 0;
    return pid > 0;
  }, "the runtime's grandchild");
  return pid;
}

/** Still held by the manager: in the live map, or tracked as a stopped runtime not yet seen to exit. */
function tracked(ctx: Ctx, agentId: string, runtime: unknown): boolean {
  return ctx.internals.agents.get(agentId)?.runtime === runtime || ctx.manager.hasExitingRuntime(agentId);
}

async function startRunning(ctx: Ctx, agentId: string) {
  await ctx.manager.startAgent(agentId, makeConfig());
  const ap = ctx.internals.agents.get(agentId);
  assert.ok(ap, "precondition: the runtime is running");
  const grandchild = await grandchildPid(ctx.driver, ctx.driver.children.length - 1);
  // Restarts after a close are recorded, not run (they would mint a runner credential).
  ctx.internals.startAgent = async () => {};
  return { ap, child: ctx.driver.children.at(-1)!, grandchild };
}

type StopCase = {
  path: string;
  driver?: { stdin?: boolean; terminateProcessOnTurnEnd?: boolean };
  /** turn_interrupt: the turn's own selection, never the whole tree (task #25 step 2). */
  grandchildKilled?: false;
  trigger: (ctx: Ctx, agentId: string, ap: any) => void;
};

const STOP_CASES: StopCase[] = [
  { path: "explicit_stop", trigger: (ctx, agentId) => void ctx.manager.stopAgent(agentId) },
  { path: "silent_stop", trigger: (ctx) => void ctx.manager.stopAll() },
  { path: "cold_idle_recycle", trigger: (ctx, agentId, ap) => ctx.internals.beginColdIdleRecycleStop(agentId, ap, "Cold idle", "cold_idle_recycle") },
  { path: "spec_restart", trigger: (ctx, agentId, ap) => ctx.internals.stopForSpecDrift(agentId, ap, ["model"], "signal") },
  {
    path: "terminal_runtime_error",
    trigger: (ctx, agentId, ap) => ctx.internals.releaseFailedProcess(agentId, ap, "boom", { failureKind: "fingerprint_fence", fingerprint: "fp", errorClass: "unknown" }),
  },
  { path: "startup_timeout", trigger: (ctx, agentId, ap) => ctx.internals.handleRuntimeStartupTimeout(agentId, ap, 1) },
  {
    path: "startup_request_error",
    trigger: (_ctx, _agentId, ap) => ap.runtime.events.emit("runtime_event", { kind: "error", message: "session/new failed", startupRequestMethod: "session/new" }),
  },
  {
    path: "stalled_recovery",
    driver: { stdin: false },
    trigger: (ctx, agentId, ap) => {
      ap.runtimeProgress.markStale();
      ap.inbox.push(message(7));
      ctx.internals.reconcile(agentId, ap, "stall_deadline");
      assert.equal(ap.gatedSteering.expectedTerminationReason, "stalled_recovery", "precondition: the stall recovery terminates");
    },
  },
  {
    path: "turn_end",
    driver: { terminateProcessOnTurnEnd: true },
    trigger: (_ctx, _agentId, ap) => ap.runtime.events.emit("runtime_event", { kind: "turn_end", sessionId: "session-1" }),
  },
  { path: "turn_interrupt", grandchildKilled: false, trigger: (ctx, agentId) => void ctx.manager.interruptTurn(agentId) },
];

describe.skipIf(process.platform === "win32")("reconciler step 5: every stop path escalates to a SIGKILL of the process tree", () => {
  test.each(STOP_CASES)("$path: SIGTERM ignored → SIGKILL of the tree after the grace; released only after the exit", async (stopCase) => {
    await withManager(async (ctx) => {
      const agentId = `agent-${stopCase.path}`;
      const { ap, child, grandchild } = await startRunning(ctx, agentId);
      const runtime = ap.runtime;
      let trackedAtExit: boolean | null = null;
      runtime.on("exit", () => { trackedAtExit = tracked(ctx, agentId, runtime); });
      const startedAt = Date.now();

      stopCase.trigger(ctx, agentId, ap);
      await sleep(GRACE_MS / 2);
      assert.equal(child.exitCode === null && child.signalCode === null, true, "the runtime ignores SIGTERM: alive during the grace");
      assert.equal(tracked(ctx, agentId, runtime), true, "not released during the grace");

      await waitFor(() => child.signalCode !== null || child.exitCode !== null, "the runtime's exit");
      assert.equal(child.signalCode, "SIGKILL");
      assert.ok(Date.now() - startedAt >= GRACE_MS - 20, "not before the grace");
      assert.equal(trackedAtExit, true, "still held when its exit was observed: never released before it");
      const escalated = ctx.events.find((event) => event.name === "daemon.agent.stop.escalated" && event.attrs.agentId === agentId);
      assert.ok(escalated, `daemon.agent.stop.escalated: ${ctx.events.map((event) => event.name).filter((name) => name.includes("stop")).join(",")}`);
      assert.equal(escalated.attrs.path, stopCase.path);
      assert.equal(escalated.attrs.grace_ms, GRACE_MS);
      if (stopCase.grandchildKilled === false) {
        assert.equal(escalated.attrs.tree_killed_count, 1, "a turn stop SIGKILLs the runtime alone");
      } else {
        assert.ok(Number(escalated.attrs.tree_killed_count) >= 2, `the tree, not only the pid: ${escalated.attrs.tree_killed_count}`);
        await waitFor(() => !pidAlive(grandchild), "the grandchild's death", 2_000);
      }
      await waitFor(() => !tracked(ctx, agentId, runtime), "the release after the exit");
      assert.equal(ctx.events.some((event) => event.name === "daemon.agent.stop.kill_unconfirmed"), false);
    }, stopCase.driver);
  });
});

describe.skipIf(process.platform === "win32")("reconciler step 5: a stop and the next start", () => {
  test("a restart's start waits for the old process's exit; a message mid-grace goes to the next process, never to the old one", async () => {
    await withManager(async (ctx) => {
      await ctx.manager.startAgent("agent-1", makeConfig());
      const old = ctx.driver.children[0]!;
      const oldGrandchild = await grandchildPid(ctx.driver, 0);
      const oldWritesBeforeStop = ctx.driver.stdinWrites[0]!.length;

      const stopped = ctx.manager.stopAgent("agent-1");
      const restarted = ctx.manager.startAgent("agent-1", makeConfig());
      await sleep(GRACE_MS / 3);
      assert.equal(ctx.manager.deliverMessage("agent-1", message(42)), true, "the mid-grace delivery is accepted");
      await sleep(GRACE_MS / 3);
      assert.equal(ctx.driver.spawnCalls.length, 1, "no second process while the old one is still exiting");
      assert.ok(ctx.events.some((event) => event.name === "daemon.agent.start.waiting_for_exit"));

      await Promise.all([stopped, restarted]);
      assert.equal(old.signalCode, "SIGKILL");
      await waitFor(() => !pidAlive(oldGrandchild), "the old grandchild's death", 2_000);
      assert.equal(ctx.driver.spawnCalls.length, 2, "the next process starts after the exit");
      assert.equal(ctx.driver.stdinWrites[0]!.slice(oldWritesBeforeStop).some((chunk) => chunk.includes("hello 42")), false, "never written to the stopping process");
      const routed = ctx.events.find((event) => event.name === "daemon.agent.delivery.routed" && event.attrs.messageId === "msg-42");
      assert.equal(routed?.attrs.outcome, "queued_during_start", "kept for the start waiting on the exit");
      const next = ctx.internals.agents.get("agent-1");
      assert.equal(next.runtime.pid, ctx.driver.children[1]!.pid, "the registry holds the next process");
      assert.equal(
        next.inbox.some((queued: AgentMessage) => queued.seq === 42) || ctx.driver.spawnCalls[1]!.prompt.includes("hello 42"),
        true,
        "the next process has it",
      );
    });
  });

  test("a message mid-grace of an idle recycle stays in the inbox and wakes the next process", async () => {
    await withManager(async (ctx) => {
      const { ap, child } = await startRunning(ctx, "agent-1");
      const wakes: unknown[] = [];
      ctx.internals.startAgent = async (...args: unknown[]) => { wakes.push(args[2]); };
      ap.sessionId = "session-1";
      ctx.internals.commitApmIdleState("agent-1", ap, true);
      const writesBefore = ctx.driver.stdinWrites[0]!.length;

      ctx.internals.beginColdIdleRecycleStop("agent-1", ap, "Cold idle", "cold_idle_recycle");
      await sleep(GRACE_MS / 3);
      assert.equal(await ctx.manager.deliverMessage("agent-1", message(43)), true);
      assert.equal(ctx.driver.stdinWrites[0]!.length, writesBefore, "never written to the stopping process");
      assert.equal(ap.inbox.some((queued: AgentMessage) => queued.seq === 43), true, "kept in the inbox");

      await waitFor(() => child.signalCode !== null, "the SIGKILL");
      await waitFor(() => wakes.length > 0, "the wake at the close");
      assert.equal((wakes[0] as AgentMessage).seq, 43, "the next process is woken with it");
    });
  });
});

class UnkillableChild extends EventEmitter {
  readonly pid = 2_147_480_001; // never a process of this test host's
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | undefined> = [];

  // A process in uninterruptible sleep: no signal ends it, no exit arrives.
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

class UnkillableDriver extends RealRuntimeDriver {
  readonly fakes: UnkillableChild[] = [];

  override spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const child = new UnkillableChild();
    this.fakes.push(child);
    return { process: child as unknown as ChildProcess };
  }
}

// Reconciler step 10a, row D13: a stop that lands while the agent is starting
// ends the child the start created with the one stop (SIGTERM, the stop
// grace, the tree SIGKILL); the old 2 s cancelled-start grace is gone.
// RED proof: a shorter grace for this path and "not before the grace" fails.
test.skipIf(process.platform === "win32")("reconciler step 10a (D13): stopped while starting: the start's child gets the one stop and its full grace", async () => {
  await withManager(async (ctx) => {
    const fence = ctx.internals.runtimeProcessBindingFence;
    const start = fence.start.bind(fence);
    let stopped: Promise<unknown> | null = null;
    let stopAt = 0;
    // The driver has created the child; the start has not committed yet.
    fence.start = async (...args: unknown[]) => {
      const result = await start(...args);
      await grandchildPid(ctx.driver, 0); // the runtime ignores SIGTERM from here on
      stopAt = Date.now();
      stopped = ctx.manager.stopAgent("agent-1");
      return result;
    };
    await ctx.manager.startAgent("agent-1", makeConfig());
    assert.ok(stopped, "the stop landed during the start");
    await stopped;
    const child = ctx.driver.children[0]!;
    await waitFor(() => child.signalCode !== null || child.exitCode !== null, "the child's exit");
    assert.equal(child.signalCode, "SIGKILL", "it ignored SIGTERM: killed after the grace");
    assert.ok(Date.now() - stopAt >= GRACE_MS - 20, "not before the grace");
    const escalations = ctx.events.filter((event) => event.name === "daemon.agent.stop.escalated" && event.attrs.agentId === "agent-1");
    assert.ok(escalations.length > 0, "escalated");
    for (const escalated of escalations) {
      // The stop ends the registered process (explicit_stop); a child it did not reach is the cancelled start's.
      assert.ok(["explicit_stop", "cancelled_start"].includes(String(escalated.attrs.path)), String(escalated.attrs.path));
      assert.equal(escalated.attrs.grace_ms, GRACE_MS, "the one stop grace");
    }
    await waitFor(() => !ctx.manager.hasExitingRuntime("agent-1"), "the release after the exit");
  });
});

test("reconciler step 5: no exit 5 s after the SIGKILL: kill_unconfirmed with the pid, the agent is released anyway and a later start proceeds", async () => {
  let unkillable!: UnkillableDriver;
  await withManager(async (ctx) => {
    await ctx.manager.startAgent("agent-1", makeConfig({}), undefined, undefined, undefined, "launch-1");
    const child = unkillable.fakes[0]!;

    const stopped = ctx.manager.stopAgent("agent-1");
    await sleep(30 + 20);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(ctx.manager.hasExitingRuntime("agent-1"), true, "held while the exit is awaited");
    await stopped;

    const unconfirmed = ctx.events.find((event) => event.name === "daemon.agent.stop.kill_unconfirmed");
    assert.ok(unconfirmed);
    assert.equal(unconfirmed.attrs.pid, child.pid);
    assert.equal(unconfirmed.attrs.path, "explicit_stop");
    assert.equal(ctx.manager.hasExitingRuntime("agent-1"), false, "released after the confirmation window");
    assert.equal(ctx.sent.some((msg) => msg.type === "agent:process_exited"), false, "an unconfirmed kill is never reported as an exit");

    await ctx.manager.startAgent("agent-1", makeConfig({}), undefined, undefined, undefined, "launch-2");
    assert.equal(unkillable.spawnCalls.length, 2, "a later start proceeds");
  }, {}, { graceMs: 30, confirmMs: 60 }, (dir) => (unkillable = new UnkillableDriver(dir)));
});

/** What a crashed daemon leaves: a runtime in its own group, ignoring SIGTERM, with a grandchild, reparented. */
async function leaveOrphan(dir: string): Promise<{ runtimePid: number; grandchildPid: number }> {
  const runtimePidFile = path.join(dir, "orphan.pid");
  const grandchildPidFile = path.join(dir, "orphan-grandchild.pid");
  const daemonScript = [
    `const r = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(runtimeScript(grandchildPidFile))}], { detached: true, stdio: "ignore" });`,
    `require("fs").writeFileSync(${JSON.stringify(runtimePidFile)}, String(r.pid));`,
    `r.unref();`,
  ].join("\n");
  const crashed = spawn(process.execPath, ["-e", daemonScript], { stdio: "ignore" });
  await new Promise((resolve) => crashed.on("exit", resolve));
  let runtimePid = 0;
  let grandchildPid = 0;
  await waitFor(async () => {
    runtimePid = Number((await readFile(runtimePidFile, "utf8").catch(() => "")).trim()) || 0;
    grandchildPid = Number((await readFile(grandchildPidFile, "utf8").catch(() => "")).trim()) || 0;
    return runtimePid > 0 && grandchildPid > 0;
  }, "the orphan and its grandchild");
  onTestFinished(() => {
    for (const pid of [runtimePid, grandchildPid]) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
  });
  return { runtimePid, grandchildPid };
}

test.skipIf(process.platform === "win32")("reconciler step 5: at start the runner reaps the runtime a crashed daemon left; the agent's next start waits for it; new runtimes are recorded until their exit", async () => {
  await withManager(async (ctx) => {
    const machineDir = path.join(ctx.internals.dataDir, "..", `machine-${path.basename(ctx.internals.dataDir)}`);
    await mkdir(machineDir, { recursive: true });
    onTestFinished(() => rm(machineDir, { recursive: true, force: true }));
    const orphan = await leaveOrphan(machineDir);
    // The crashed daemon had recorded it.
    await new RuntimeProcessLedger(path.join(machineDir, RUNTIME_PROCESS_LEDGER_FILE)).record(orphan.runtimePid, { agentId: "agent-1", launchId: "launch-old", host: "legacy" });
    const aliveAtSpawn: boolean[] = [];
    const spawnRuntime = ctx.driver.spawn.bind(ctx.driver);
    ctx.driver.spawn = (spawnCtx) => {
      aliveAtSpawn.push(pidAlive(orphan.runtimePid) || pidAlive(orphan.grandchildPid));
      return spawnRuntime(spawnCtx);
    };

    // The daemon starts: the machine dir is known before any start.
    ctx.manager.startRuntimeProcessLedger(machineDir);
    const started = ctx.manager.startAgent("agent-1", makeConfig());
    await sleep(GRACE_MS / 2);
    assert.equal(ctx.driver.spawnCalls.length, 0, "the agent's start waits for the reap");
    assert.equal(pidAlive(orphan.runtimePid), true, "precondition: the orphan ignores SIGTERM");
    await started;

    assert.deepEqual(aliveAtSpawn, [false], "the orphan and its grandchild were gone before the new runtime started");
    const reaped = ctx.events.find((event) => event.name === "daemon.agent.orphan.reaped");
    assert.ok(reaped);
    assert.equal(reaped.attrs.reaped_count, 1);
    assert.equal(reaped.attrs.escalated_count, 1);
    assert.equal(reaped.attrs.pids, String(orphan.runtimePid));
    assert.ok(ctx.events.some((event) => event.name === "daemon.agent.start.waiting_for_orphan_reap"));

    // The new runtime is recorded until its exit is confirmed.
    const ledgerFile = path.join(machineDir, RUNTIME_PROCESS_LEDGER_FILE);
    const newPid = ctx.driver.children[0]!.pid!;
    await waitFor(async () => (await readFile(ledgerFile, "utf8")).includes(`"pid":${newPid}`), "the new runtime's record");
    assert.equal((await readFile(ledgerFile, "utf8")).includes(`"pid":${orphan.runtimePid}`), false, "the reaped orphan's record is gone");
    await grandchildPid(ctx.driver, 0);
    await ctx.manager.stopAgent("agent-1");
    assert.deepEqual(JSON.parse(await readFile(ledgerFile, "utf8")).processes, [], "removed once its exit is confirmed");
  });
});
