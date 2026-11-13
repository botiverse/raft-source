// Reconciler step 13 (PR 3): a web upgrade with `drain` waits for every
// runner's agents before its installer is spawned (service.ts upgradeStart,
// upgradeDrain.ts). The runner's half is the daemon's computerUpgradeDrain.ts;
// here a test writes its state file.
//
// RED proof: run the drain after the spawn (or not at all) and the first
// test sees the installer spawned before the runner was quiet; drop the
// in-flight claim and the second upgrade launches a second installer.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import * as externalInstaller from "./externalInstaller";
import { readLastRemoteUpgradeReceipt } from "./externalInstaller";
import { serverUpgradeDrainRequestPath, serverUpgradeDrainStatePath } from "./paths";
import { collectRemoteUpgradeSteps } from "./remoteUpgradeTrace";
import { runService, runServiceStartupRecovery, type RunServiceDeps } from "./service";
import { clearUpgradeDrainRequests, waitForUpgradeDrain, type UpgradeDrainRunner } from "./upgradeDrain";
import type { ServiceIpcMutations } from "./serviceIpcSeam";

const SERVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function withServiceHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "raft-upgrade-drain-service-"));
  const oldRaft = process.env.RAFT_HOME;
  const oldSlock = process.env.SLOCK_HOME;
  const oldOptIn = process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  delete process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR;
  mkdirSync(join(home, "computer"), { recursive: true });
  writeFileSync(join(home, "computer", "channel"), "latest");
  try {
    return await fn(home);
  } finally {
    if (oldRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaft;
    if (oldSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlock;
    if (oldOptIn === undefined) delete process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR; else process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR = oldOptIn;
    rmSync(home, { recursive: true, force: true });
  }
}

const remote = (requestId: string, drain?: { deadlineMs: number }) =>
  ({ scope: "remote" as const, requestId, originServerId: SERVER, trigger: "web" as const, targetVersion: "1.0.99", ...(drain ? { drain } : {}) });

/** "The installer": resolved, the service's pre-spawn hook (veto, drain) runs, then it is spawned (or not: `pid` null). */
function fakeLaunch(pid: number | null = 4321) {
  const log: string[] = [];
  const spy = vi.spyOn(externalInstaller, "launchInstallerDetached").mockImplementation(
    async (_home, _args, _id, _env, stats, beforeSpawn) => {
      if (stats) stats.resolved = true;
      await beforeSpawn?.("/fake/raft-computer-installer");
      log.push("spawned");
      return pid;
    });
  return { log, spy };
}

const runnersOnThisMachine: UpgradeDrainRunner[] = [{ serverId: SERVER, pid: process.pid }, { serverId: OTHER, pid: process.pid }];

/** The service with two live runners and a fast drain poll; `pickupGraceMs` 0 so a deadline test ends at the deadline. */
async function withMutations(fn: (mutations: ServiceIpcMutations) => Promise<void>, extra: Partial<RunServiceDeps> = {}): Promise<void> {
  let exercised = false;
  await runService({
    stopAfterMutationsReady: true,
    detectSystemdSupervisorFn: async () => null,
    upgradeDrainRunnersFn: () => runnersOnThisMachine,
    waitForUpgradeDrainFn: (home, options) => waitForUpgradeDrain(home, { ...options, pollMs: 5, pickupGraceMs: 0 }),
    ...extra,
    onMutationsReady: async (mutations) => {
      await fn(mutations);
      exercised = true;
    },
  });
  assert.equal(exercised, true);
}

function writeRunnerState(home: string, serverId: string, requestId: string, finished?: "quiet" | "deadline" | "ended", notQuietAgentIds: string[] = []) {
  writeFileSync(serverUpgradeDrainStatePath(home, serverId), JSON.stringify({
    formatVersion: 1, requestId, pid: process.pid, live: 1, notQuietAgentIds, ...(finished ? { finished } : {}), updatedAtMs: Date.now(),
  }));
}

async function until(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function stepsOf(home: string) {
  return (await collectRemoteUpgradeSteps(home, { serverId: SERVER })).events.map((event) => [event.step, event.outcome, event.phase]);
}

test("step 13: with drain, every runner is asked to drain and the installer is spawned only once all of them are quiet", async () => {
  await withServiceHome(async (home) => {
    const launch = fakeLaunch();
    try {
      await withMutations(async (mutations) => {
        assert.deepEqual(await mutations.upgradeStart(remote("req-d1", { deadlineMs: 60_000 })), { status: "draining", upgradeId: "req-d1", targetVersion: "1.0.99" });
        const request = (serverId: string) => JSON.parse(readFileSync(serverUpgradeDrainRequestPath(home, serverId), "utf8"));
        assert.equal(request(SERVER).requestId, "req-d1");
        assert.equal(request(SERVER).origin, true);
        assert.equal(request(OTHER).origin, false, "every runner drains; only the origin's reports to its Server");
        writeRunnerState(home, SERVER, "req-d1", undefined, ["agent-a"]);
        writeRunnerState(home, OTHER, "req-d1", "quiet");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(launch.log, [], "one runner still has an agent mid-turn: not spawned");
        writeRunnerState(home, SERVER, "req-d1", "quiet");
        await until(() => launch.log.length === 1, "the spawn after quiet");
      });
      const steps = await stepsOf(home);
      assert.deepEqual(steps.slice(0, 4), [
        ["received", "ok", undefined],
        ["download", "ok", undefined],
        ["drain", "ok", "quiet"],
        ["installer_spawned", "ok", undefined],
      ]);
      assert.ok(existsSync(serverUpgradeDrainRequestPath(home, SERVER)), "kept: the installer stops the service next, with the work still held");
    } finally {
      launch.spy.mockRestore();
    }
  });
});

test("step 13: at the deadline the installer is spawned anyway, naming the agents still working", async () => {
  await withServiceHome(async (home) => {
    const launch = fakeLaunch();
    try {
      await withMutations(async (mutations) => {
        assert.equal((await mutations.upgradeStart(remote("req-d2", { deadlineMs: 40 }))).status, "draining");
        writeRunnerState(home, SERVER, "req-d2", undefined, ["agent-a", "agent-b"]);
        writeRunnerState(home, OTHER, "req-d2", "quiet");
        await until(() => launch.log.length === 1, "the spawn at the deadline");
      });
      const drain = (await collectRemoteUpgradeSteps(home, { serverId: SERVER })).events.find((event) => event.step === "drain");
      assert.equal(drain?.phase, "deadline");
      assert.equal(drain?.reason, "2 agent(s) still working");
    } finally {
      launch.spy.mockRestore();
    }
  });
});

test("step 13: a second upgrade during the drain is already-running (a no-op); a server without drain is not drained (old-server compat)", async () => {
  await withServiceHome(async (home) => {
    const launch = fakeLaunch();
    try {
      await withMutations(async (mutations) => {
        assert.equal((await mutations.upgradeStart(remote("req-d3", { deadlineMs: 60_000 }))).status, "draining");
        assert.deepEqual(await mutations.upgradeStart(remote("req-other", { deadlineMs: 60_000 })), { status: "already-running", upgradeId: "req-d3", targetVersion: "1.0.99" });
        assert.deepEqual(await mutations.upgradeStart(remote("req-d3", { deadlineMs: 60_000 })), { status: "already-running", upgradeId: "req-d3", targetVersion: "1.0.99" }, "the same request again: itself");
        assert.equal(launch.spy.mock.calls.length, 1, "one installer");
        writeRunnerState(home, SERVER, "req-d3", "quiet");
        writeRunnerState(home, OTHER, "req-d3", "quiet");
        await until(() => launch.log.length === 1, "spawned");
        await new Promise((resolve) => setTimeout(resolve, 10));
        await clearUpgradeDrainRequests(home);
        // The claim ends at the spawn: the next upgrade (no drain) runs as before.
        assert.deepEqual(await mutations.upgradeStart(remote("req-plain")), { status: "started", upgradeId: "req-plain", targetVersion: "1.0.99" });
        assert.equal(existsSync(serverUpgradeDrainRequestPath(home, SERVER)), false, "no drain without `drain`");
      });
    } finally {
      launch.spy.mockRestore();
    }
  });
});

test("step 13: an external-supervisor refusal never writes a drain request", async () => {
  await withServiceHome(async (home) => {
    const launch = fakeLaunch();
    try {
      await withMutations(async (mutations) => {
        await assert.rejects(() => mutations.upgradeStart(remote("req-d4", { deadlineMs: 60_000 })), /external supervisor/);
        assert.equal(existsSync(serverUpgradeDrainRequestPath(home, SERVER)), false);
        assert.equal(launch.spy.mock.calls.length, 0);
      }, { externalSupervisorOptInFn: () => true });
    } finally {
      launch.spy.mockRestore();
    }
  });
});

test("step 13: a spawn that fails after the drain is the request's failed receipt, and the runners are let go", async () => {
  await withServiceHome(async (home) => {
    const launch = fakeLaunch(null);
    try {
      await withMutations(async (mutations) => {
        assert.equal((await mutations.upgradeStart(remote("req-d5", { deadlineMs: 60_000 }))).status, "draining");
        writeRunnerState(home, SERVER, "req-d5", "quiet");
        writeRunnerState(home, OTHER, "req-d5", "quiet");
        await until(() => !existsSync(serverUpgradeDrainRequestPath(home, SERVER)), "the request removed");
        assert.equal(existsSync(serverUpgradeDrainRequestPath(home, OTHER)), false);
      });
      await until(() => existsSync(join(home, "computer", "installer", "receipts")), "receipt");
      const receipt = await readLastRemoteUpgradeReceipt(home);
      assert.equal(receipt?.outcome, "failed");
      assert.match(receipt?.reason ?? "", /could not be started after the drain: external_installer_launch_failed/);
    } finally {
      launch.spy.mockRestore();
    }
  });
});

test("step 13: startup recovery removes a drain request a gone service left, not a live service's", async () => {
  await withServiceHome(async (home) => {
    for (const [serverId, servicePid] of [[SERVER, 2_147_483_000], [OTHER, process.pid]] as const) {
      mkdirSync(join(home, "computer", "servers", serverId), { recursive: true });
      writeFileSync(serverUpgradeDrainRequestPath(home, serverId), JSON.stringify({ formatVersion: 1, requestId: "req-old", origin: true, deadlineAtMs: Date.now(), servicePid }));
      writeRunnerState(home, serverId, "req-old", "quiet");
    }
    assert.equal(await clearUpgradeDrainRequests(home, { onlyStale: true }), 1);
    assert.equal(existsSync(serverUpgradeDrainRequestPath(home, SERVER)), false);
    assert.equal(existsSync(serverUpgradeDrainStatePath(home, SERVER)), false);
    assert.equal(existsSync(serverUpgradeDrainRequestPath(home, OTHER)), true, "its service is alive");
    // The startup recovery runs the same (stale only).
    writeFileSync(serverUpgradeDrainRequestPath(home, SERVER), JSON.stringify({ formatVersion: 1, requestId: "req-old", origin: true, deadlineAtMs: Date.now(), servicePid: 2_147_483_000 }));
    await runServiceStartupRecovery(home);
    assert.equal(existsSync(serverUpgradeDrainRequestPath(home, SERVER)), false);
  });
});

test("step 13 wait: a runner that is gone is not waited for; a runner without the request (spawned since) is asked", async () => {
  await withServiceHome(async (home) => {
    let runners: UpgradeDrainRunner[] = [{ serverId: SERVER, pid: 2_147_483_000 }];
    const request = { requestId: "req-w", originServerId: SERVER, deadlineAtMs: Date.now() + 60_000, servicePid: process.pid };
    const gone = await waitForUpgradeDrain(home, { request, runners: () => runners, pollMs: 5 });
    assert.deepEqual([gone.finished, gone.runners], ["quiet", 0]);
    runners = [{ serverId: OTHER, pid: process.pid }];
    const waiting = waitForUpgradeDrain(home, { request, runners: () => runners, pollMs: 5 });
    await until(() => existsSync(serverUpgradeDrainRequestPath(home, OTHER)), "asked");
    writeRunnerState(home, OTHER, "req-w", "ended");
    assert.equal((await waiting).finished, "ended");
  });
});
