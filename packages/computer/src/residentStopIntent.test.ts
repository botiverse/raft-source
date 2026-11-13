import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { SHUTDOWN_CHILD_WAIT_TIMEOUT_MS, shutdownService } from "./lib/serviceShutdown";
import type { RunnerRecord } from "./lib/runnerStateMachine";
import { takeResidentStopIntent, writeResidentStopIntent } from "./residentStopIntent";
import { readCrashHistory } from "./health";
import {
  COMPUTER_MACHINE_UNLINKED_EXIT_CODE,
  EX_CONFIG_EXIT_CODE,
  EXTERNAL_STOP_EXIT_CODE,
  classifyRunnerExit,
  handleRunnerExitForSupervisor,
} from "./service";

test("a stop intent is read once and only by the runner it names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "computer-stop-intent-"));
  const intentPath = join(dir, "runner.stop-intent");
  try {
    assert.equal(takeResidentStopIntent(intentPath, 4242), null, "no intent reads as an external signal");

    writeResidentStopIntent(intentPath, { pid: 4242, source: "service_unmanaged" });
    assert.equal(takeResidentStopIntent(intentPath, 4242), "service_unmanaged");
    assert.equal(existsSync(intentPath), false, "the intent is consumed");
    assert.equal(takeResidentStopIntent(intentPath, 4242), null);

    // An intent left for a previous runner does not explain this one's signal.
    writeResidentStopIntent(intentPath, { pid: 1111, source: "service_shutdown" });
    assert.equal(takeResidentStopIntent(intentPath, 4242), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service shutdown records its intent before signalling each runner", async () => {
  const order: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: (signal: NodeJS.Signals) => {
      order.push(`kill:${signal}`);
      rec.child = undefined;
      return true;
    },
  }) as unknown as ChildProcess;
  const rec: RunnerRecord = { serverId: "server-1", lifecycle: "running", stopping: false, child };
  await shutdownService({
    runners: new Map([["server-1", rec]]),
    beforeSignal: (r, pid) => order.push(`intent:${r.serverId}:${pid}`),
    closeIpc: () => undefined,
    isProcessAlive: () => false,
    clearServicePidfile: async () => {},
    restartRequested: false,
    sleep: async () => {},
    exit: () => {},
  });
  assert.deepEqual(order, ["intent:server-1:4242", "kill:SIGTERM"]);
});

/** A runner stand-in that exits `exitAfterMs` after SIGTERM (never, if null), on a fake clock. */
async function shutdownWithRunnerExitingAfter(exitAfterMs: number | null): Promise<{ signals: string[]; doneAtMs: number }> {
  let nowMs = 0;
  const signals: string[] = [];
  let termAtMs: number | null = null;
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      if (signal === "SIGTERM") termAtMs = nowMs;
      if (signal === "SIGKILL") rec.child = undefined;
      return true;
    },
  }) as unknown as ChildProcess;
  const rec: RunnerRecord = { serverId: "server-1", lifecycle: "running", stopping: false, child };
  await shutdownService({
    runners: new Map([["server-1", rec]]),
    closeIpc: () => undefined,
    isProcessAlive: () => false,
    clearServicePidfile: async () => {},
    restartRequested: false,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
      if (exitAfterMs !== null && termAtMs !== null && nowMs - termAtMs >= exitAfterMs) rec.child = undefined;
    },
    exit: () => {},
  });
  return { signals, doneAtMs: nowMs };
}

test("service shutdown lets a runner finish a 15 s agent tree stop before any SIGKILL", async () => {
  // 15 s = the daemon's agent stop: 10 s SIGTERM grace + 5 s kill confirm.
  const { signals, doneAtMs } = await shutdownWithRunnerExitingAfter(15_000);
  assert.deepEqual(signals, ["SIGTERM"], "the runner is not SIGKILLed while its agents stop");
  assert.ok(doneAtMs >= 15_000 && doneAtMs < SHUTDOWN_CHILD_WAIT_TIMEOUT_MS);
});

test("service shutdown still SIGKILLs a runner that never exits, at the wait deadline", async () => {
  const { signals, doneAtMs } = await shutdownWithRunnerExitingAfter(null);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(doneAtMs >= SHUTDOWN_CHILD_WAIT_TIMEOUT_MS && doneAtMs < SHUTDOWN_CHILD_WAIT_TIMEOUT_MS + 2_000);
  assert.ok(SHUTDOWN_CHILD_WAIT_TIMEOUT_MS < 20_000, "under launchd's default 20 s ExitTimeOut");
});

// No stop intent means the service did not send the SIGTERM. The runner says
// so with EXTERNAL_STOP_EXIT_CODE, and the supervisor charges it to the crash
// budget so an external killer parks the runner instead of an endless respawn.
test("classifyRunnerExit: an external SIGTERM is external-stop, intent-backed exit 0 stays graceful", () => {
  assert.equal(EXTERNAL_STOP_EXIT_CODE, 79);
  assert.notEqual(EXTERNAL_STOP_EXIT_CODE, COMPUTER_MACHINE_UNLINKED_EXIT_CODE);
  assert.notEqual(EXTERNAL_STOP_EXIT_CODE, EX_CONFIG_EXIT_CODE);
  assert.equal(classifyRunnerExit(EXTERNAL_STOP_EXIT_CODE, null), "external-stop");
  // Killed by SIGTERM before the runner installed its handler.
  assert.equal(classifyRunnerExit(null, "SIGTERM"), "external-stop");
  assert.equal(classifyRunnerExit(0, null), "graceful");
  assert.equal(classifyRunnerExit(null, "SIGINT"), "graceful");
  assert.equal(classifyRunnerExit(1, null), "crash");
});

const EXIT_SERVER = "22222222-2222-4222-8222-222222222222";

async function exitOnce(
  home: string,
  rec: RunnerRecord,
  code: number | null,
  atMs: number,
  opts: { signal?: NodeJS.Signals | null; shuttingDown?: boolean } = {},
): Promise<{ transitions: string[]; reconciles: number[]; stderr: string }> {
  const transitions: string[] = [];
  const reconciles: number[] = [];
  let stderr = "";
  await handleRunnerExitForSupervisor({
    slockHome: home,
    serverId: EXIT_SERVER,
    rec,
    code,
    signal: opts.signal ?? null,
    ...(opts.shuttingDown !== undefined ? { shuttingDown: opts.shuttingDown } : {}),
    emitTransition: (_id, from, to, trigger) => transitions.push(`${from}->${to}:${trigger}`),
    scheduleReconcile: (ms) => reconciles.push(ms),
    writeStderr: (text) => { stderr += text; },
    nowMs: () => atMs,
  });
  return { transitions, reconciles, stderr };
}

test("handleRunnerExitForSupervisor: external stop under budget backs off and reconciles", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-external-stop-"));
  try {
    const rec: RunnerRecord = { serverId: EXIT_SERVER, lifecycle: "running", stopping: false };
    const out = await exitOnce(home, rec, EXTERNAL_STOP_EXIT_CODE, 1_000_000);
    assert.deepEqual(out.transitions, ["running->stopped:exit-external-stop"]);
    assert.equal(rec.lifecycle, "stopped");
    assert.equal(out.reconciles.length, 1);
    assert.equal(rec.backoffUntil, 1_000_000 + out.reconciles[0]!);
    assert.equal(out.stderr, "");
    const history = await readCrashHistory(home, EXIT_SERVER, 1_000_000);
    assert.deepEqual(
      history.map((c) => [c.exitCode, c.reason]),
      [[EXTERNAL_STOP_EXIT_CODE, "external_signal"]],
      "recorded toward the budget, labelled as an external SIGTERM",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("handleRunnerExitForSupervisor: 3 external stops in 60 s degrade with an actionable message", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-external-stop-"));
  try {
    const rec: RunnerRecord = { serverId: EXIT_SERVER, lifecycle: "running", stopping: false };
    await exitOnce(home, rec, EXTERNAL_STOP_EXIT_CODE, 1_000_000);
    rec.lifecycle = "running";
    await exitOnce(home, rec, EXTERNAL_STOP_EXIT_CODE, 1_003_000);
    rec.lifecycle = "running";
    const out = await exitOnce(home, rec, EXTERNAL_STOP_EXIT_CODE, 1_006_000);
    assert.deepEqual(out.transitions, ["running->degraded:exit-external-stop-degraded"]);
    assert.equal(rec.lifecycle, "degraded");
    assert.deepEqual(out.reconciles, [], "no auto-restart once degraded");
    assert.match(out.stderr, /repeatedly stopped by a SIGTERM that this Computer did not send/);
    assert.match(out.stderr, /another Computer service running on the same data directory/);
    assert.match(out.stderr, /another tool that kills processes/);
    assert.match(out.stderr, new RegExp(`raft-computer restart ${EXIT_SERVER}`));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("handleRunnerExitForSupervisor: a plain exit 0 stays graceful and never charges the budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-external-stop-"));
  try {
    const rec: RunnerRecord = { serverId: EXIT_SERVER, lifecycle: "running", stopping: false };
    for (const atMs of [1_000_000, 1_003_000, 1_006_000]) {
      rec.lifecycle = "running";
      const out = await exitOnce(home, rec, 0, atMs);
      assert.deepEqual(out.transitions, ["running->stopped:exit-graceful"]);
      assert.equal(out.reconciles.length, 1);
    }
    assert.deepEqual(await readCrashHistory(home, EXIT_SERVER, 1_006_000), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("handleRunnerExitForSupervisor: a stop the service sent is never charged, whatever the exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-external-stop-"));
  try {
    const cases: Array<{ code: number | null; signal: NodeJS.Signals | null; shuttingDown: boolean; stopping: boolean; trigger: string }> = [
      { code: EXTERNAL_STOP_EXIT_CODE, signal: null, shuttingDown: false, stopping: true, trigger: "operator-stop" },
      { code: null, signal: "SIGTERM", shuttingDown: false, stopping: true, trigger: "operator-stop" },
      { code: EXTERNAL_STOP_EXIT_CODE, signal: null, shuttingDown: true, stopping: true, trigger: "shutdown-stop" },
      // Group-wide SIGTERM reached the runner before shutdownService marked it stopping.
      { code: EXTERNAL_STOP_EXIT_CODE, signal: null, shuttingDown: true, stopping: false, trigger: "shutdown-stop" },
    ];
    let atMs = 1_000_000;
    for (const c of cases) {
      const rec: RunnerRecord = { serverId: EXIT_SERVER, lifecycle: "running", stopping: c.stopping };
      const out = await exitOnce(home, rec, c.code, atMs, { signal: c.signal, shuttingDown: c.shuttingDown });
      assert.equal(rec.lifecycle, "stopped");
      assert.deepEqual(out.transitions, [`running->stopped:${c.trigger}`]);
      assert.deepEqual(out.reconciles, [], "no respawn for a stop the service asked for");
      atMs += 1_000;
    }
    assert.deepEqual(await readCrashHistory(home, EXIT_SERVER, atMs), [], "nothing charged to the budget");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
