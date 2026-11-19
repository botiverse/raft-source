import assert from "node:assert/strict";
import { runNamedCase } from "./test/runNamedCase";

import { collectMachineFacts, type MachineFacts, type RunnerMachineFacts } from "./machineFacts";
import { machineReadiness, SPAWNED_RUNNER_MIN_ALIVE_MS, type MachineReadinessReasonCode } from "./machineReadiness";
import { serverRunnerPidReadFallback, serverRunnerSpawnedPath } from "./paths";

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const EXPECTED_VERSION = "1.0.13";

function runner(overrides: Partial<RunnerMachineFacts> = {}): RunnerMachineFacts {
  return {
    serverId: SERVER_A,
    pid: 101,
    alive: true,
    versionEvidence: {
      version: EXPECTED_VERSION,
      installRoot: "/opt/raft-computer",
      pid: 101,
      writtenAt: "2026-07-22T00:00:00.000Z",
    },
    connectionEvidence: { pid: 101, connectedAt: 1_753_142_400_000 },
    ...overrides,
  };
}

function facts(
  runnerFacts: RunnerMachineFacts = runner(),
  managedServerIds: readonly string[] = [SERVER_A],
): MachineFacts {
  return { managedServerIds, runners: [runnerFacts] };
}

function reasonCodes(machineFacts: MachineFacts): MachineReadinessReasonCode[] {
  return machineReadiness(machineFacts, {
    targetServerIds: [SERVER_A],
    expectedVersion: EXPECTED_VERSION,
  }).reasons.map((reason) => reason.code);
}

test("machine readiness shared start scenario matrix", async (t) => {
  const cases: Array<{
    name: string;
    machineFacts: MachineFacts;
    ready: boolean;
    reasons: MachineReadinessReasonCode[];
  }> = [
    {
      name: "exact live pid-bound evidence plus connection is ready",
      machineFacts: facts(),
      ready: true,
      reasons: [],
    },
    {
      name: "task #359: live pid with unknown evidence stays runner-unattested",
      machineFacts: facts(runner({ versionEvidence: null, connectionEvidence: null })),
      ready: false,
      reasons: ["runner-unattested"],
    },
    {
      name: "evidence for a different pid is runner-unattested",
      machineFacts: facts(runner({
        versionEvidence: {
          version: EXPECTED_VERSION,
          installRoot: "/opt/raft-computer",
          pid: 999,
          writtenAt: "2026-07-22T00:00:00.000Z",
        },
      })),
      ready: false,
      reasons: ["runner-unattested"],
    },
    {
      name: "attested replacement with predecessor connection evidence is runner-disconnected",
      machineFacts: facts(runner({
        connectionEvidence: { pid: 99, connectedAt: 1_753_142_300_000 },
      })),
      ready: false,
      reasons: ["runner-disconnected"],
    },
    {
      name: "attested old runner is runner-version-mismatch",
      machineFacts: facts(runner({
        versionEvidence: {
          version: "1.0.0",
          installRoot: "/opt/raft-computer",
          pid: 101,
          writtenAt: "2026-07-22T00:00:00.000Z",
        },
      })),
      ready: false,
      reasons: ["runner-version-mismatch"],
    },
    {
      name: "target missing from the current managed set is runner-not-managed",
      machineFacts: facts(runner(), []),
      ready: false,
      reasons: ["runner-not-managed"],
    },
    {
      name: "recorded but dead pid is runner-absent",
      machineFacts: facts(runner({ alive: false })),
      ready: false,
      reasons: ["runner-absent"],
    },
  ];

  for (const item of cases) {
    await runNamedCase(item.name, () => {
      const verdict = machineReadiness(item.machineFacts, {
        targetServerIds: [SERVER_A],
        expectedVersion: EXPECTED_VERSION,
      });
      assert.equal(verdict.ready, item.ready);
      assert.deepEqual(reasonCodes(item.machineFacts), item.reasons);
      assert.deepEqual(
        [...verdict.runnerPids],
        item.ready ? [[SERVER_A, 101]] : [],
      );
    });
  }
});

test("collectMachineFacts keeps raw evidence and prefers a live fallback pid", async () => {
  const [currentPidPath, fallbackPidPath] = serverRunnerPidReadFallback("/test", SERVER_A);
  assert.ok(currentPidPath);
  assert.ok(fallbackPidPath);
  const collected = await collectMachineFacts("/test", {
    runnerServerIds: [SERVER_A],
    listManaged: async () => [SERVER_A],
    readPidfile: async (path) => path === currentPidPath ? 101
      : path === fallbackPidPath ? 202 : null,
    isAlive: (pid) => pid === 202,
    readVersionEvidence: async () => ({
      version: EXPECTED_VERSION,
      installRoot: "/opt/raft-computer",
      pid: 202,
      writtenAt: "2026-07-22T00:00:00.000Z",
    }),
    readConnectionEvidence: () => ({ pid: 202, connectedAt: 1_753_142_400_000 }),
    readLockConflict: () => null,
    readSpawnRecord: () => null,
  });

  assert.deepEqual(collected.managedServerIds, [SERVER_A]);
  assert.deepEqual(collected.runners, [{
    serverId: SERVER_A,
    pid: 202,
    alive: true,
    versionEvidence: {
      version: EXPECTED_VERSION,
      installRoot: "/opt/raft-computer",
      pid: 202,
      writtenAt: "2026-07-22T00:00:00.000Z",
    },
    connectionEvidence: { pid: 202, connectedAt: 1_753_142_400_000 },
    lockConflict: null,
    spawned: null,
  }]);
});

test("collectMachineFacts reads the service's spawn record with its liveness beside an absent runner.pid", async () => {
  const collected = await collectMachineFacts("/test", {
    runnerServerIds: [SERVER_A],
    listManaged: async () => [SERVER_A],
    readPidfile: async () => null,
    isAlive: (pid) => pid === 303,
    readVersionEvidence: async () => null,
    readConnectionEvidence: () => null,
    readLockConflict: () => null,
    readSpawnRecord: (path) => {
      assert.equal(path, serverRunnerSpawnedPath("/test", SERVER_A));
      return { pid: 303, servicePid: 900, spawnedAt: Date.UTC(2026, 10, 14, 12, 0, 0) };
    },
  });
  assert.equal(collected.runners[0]?.pid, null);
  assert.deepEqual(collected.runners[0]?.spawned, { pid: 303, servicePid: 900, spawnedAt: Date.UTC(2026, 10, 14, 12, 0, 0), alive: true });
});

// The service writes runner.pid only once a runner has connected. A runner it
// spawned that is alive at this version but cannot reach its server must read
// as runner-disconnected, not runner-absent, or an installer's partial-ready
// start rolls back a working upgrade (targets=3 ready=1 runner-absent:2).
test("a spawned runner without runner.pid: disconnected only when alive, attested by its own evidence, and from this service", () => {
  const SPAWNED = 303;
  const SERVICE = 900;
  const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
  const OLD_ENOUGH = NOW - SPAWNED_RUNNER_MIN_ALIVE_MS;
  const evidence = (pid: number, version: string | null = EXPECTED_VERSION) =>
    ({ version, installRoot: "/opt/raft-computer", pid, writtenAt: "2026-11-14T00:00:00.000Z" });
  const spawnedRunner = (overrides: Partial<RunnerMachineFacts> = {}) => runner({
    pid: null,
    alive: false,
    versionEvidence: evidence(SPAWNED),
    connectionEvidence: null,
    spawned: { pid: SPAWNED, servicePid: SERVICE, spawnedAt: OLD_ENOUGH, alive: true },
    ...overrides,
  });
  const verdict = (runnerFacts: RunnerMachineFacts, servicePid: number | undefined = SERVICE) =>
    machineReadiness(facts(runnerFacts), {
      targetServerIds: [SERVER_A],
      expectedVersion: EXPECTED_VERSION,
      nowMs: NOW,
      ...(servicePid !== undefined ? { servicePid } : {}),
    });

  assert.deepEqual(verdict(spawnedRunner()).reasons, [{ code: "runner-disconnected", serverId: SERVER_A, pid: SPAWNED }]);
  // A stale pidfile naming a dead pid does not hide it.
  assert.deepEqual(verdict(spawnedRunner({ pid: 101 })).reasons.map((r) => r.code), ["runner-disconnected"]);
  // Read without a service (restart readback): still bound by the runner's own evidence.
  assert.deepEqual(verdict(spawnedRunner(), undefined).reasons.map((r) => r.code), ["runner-disconnected"]);
  // Never ready from a spawn record, even with its connected marker: runner.pid says that.
  const connected = verdict(spawnedRunner({ connectionEvidence: { pid: SPAWNED, connectedAt: 2 } }));
  assert.equal(connected.ready, false);
  assert.deepEqual(connected.reasons.map((r) => r.code), ["runner-disconnected"]);
  assert.deepEqual([...connected.runnerPids], []);

  const absent: Array<[string, RunnerMachineFacts, number | undefined]> = [
    ["the spawned pid is dead", spawnedRunner({ spawned: { pid: SPAWNED, servicePid: SERVICE, spawnedAt: OLD_ENOUGH, alive: false } }), SERVICE],
    // Attested a moment ago: a crash loop's latest spawn looks like this.
    ["spawned less than the minimum ago", spawnedRunner({ spawned: { pid: SPAWNED, servicePid: SERVICE, spawnedAt: OLD_ENOUGH + 1, alive: true } }), SERVICE],
    ["at another version but spawned less than the minimum ago", spawnedRunner({
      versionEvidence: evidence(SPAWNED, "1.0.0"),
      spawned: { pid: SPAWNED, servicePid: SERVICE, spawnedAt: NOW - 1_000, alive: true },
    }), SERVICE],
    ["no version evidence yet (before the machine lock)", spawnedRunner({ versionEvidence: null }), SERVICE],
    ["evidence names another pid (lost the lock, or a reused pid)", spawnedRunner({ versionEvidence: evidence(404) }), SERVICE],
    ["evidence without a version", spawnedRunner({ versionEvidence: evidence(SPAWNED, null) }), SERVICE],
    ["spawned by another service", spawnedRunner(), 901],
    ["no spawn record", spawnedRunner({ spawned: null }), SERVICE],
  ];
  for (const [name, runnerFacts, servicePid] of absent) {
    assert.deepEqual(verdict(runnerFacts, servicePid).reasons.map((r) => r.code), ["runner-absent"], name);
  }

  assert.deepEqual(verdict(spawnedRunner({ versionEvidence: evidence(SPAWNED, "1.0.0") })).reasons, [{
    code: "runner-version-mismatch",
    serverId: SERVER_A,
    pid: SPAWNED,
    expectedVersion: EXPECTED_VERSION,
    actualVersion: "1.0.0",
  }]);

  // A live runner.pid still decides; the spawn record only fills its absence.
  assert.equal(verdict(runner({ spawned: { pid: SPAWNED, servicePid: SERVICE, spawnedAt: NOW, alive: true } })).ready, true);
  // A parked lock conflict stays a lock conflict.
  const parked = { servicePid: SERVICE, ownerPid: null, lockPath: null, recordedAt: 1 };
  assert.deepEqual(verdict(spawnedRunner({ lockConflict: parked })).reasons.map((r) => r.code), ["runner-lock-conflict"]);
});

test("a lock conflict recorded by the live service is runner-lock-conflict; another service's, or an attested runner, is not", () => {
  const conflict = { servicePid: 900, ownerPid: 10424, lockPath: "/home/me/.slock/machines/m/daemon.lock", recordedAt: 1 };
  const adopted = runner({ pid: 10424, versionEvidence: null, connectionEvidence: null, lockConflict: conflict });
  const verdict = (machineFacts: MachineFacts, servicePid?: number) =>
    machineReadiness(machineFacts, { targetServerIds: [SERVER_A], expectedVersion: EXPECTED_VERSION, ...(servicePid !== undefined ? { servicePid } : {}) });

  assert.deepEqual(verdict(facts(adopted), 900).reasons, [
    { code: "runner-lock-conflict", serverId: SERVER_A, ownerPid: 10424, lockPath: conflict.lockPath },
  ]);
  // Written by an earlier service, or read without a service: the plain reason.
  assert.deepEqual(verdict(facts(adopted), 901).reasons.map((reason) => reason.code), ["runner-unattested"]);
  assert.deepEqual(verdict(facts(adopted)).reasons.map((reason) => reason.code), ["runner-unattested"]);
  // The pid is no longer the owner the service deferred to.
  assert.deepEqual(
    verdict(facts(runner({ pid: 555, versionEvidence: null, connectionEvidence: null, lockConflict: conflict })), 900).reasons.map((reason) => reason.code),
    ["runner-unattested"],
  );
  // The adopted owner turns out to be this server's attested runner: judged as one.
  assert.equal(verdict(facts(runner({ lockConflict: { ...conflict, ownerPid: 101 } })), 900).ready, true);
  // No live owner could be named and the runner is parked.
  assert.deepEqual(
    verdict(facts(runner({ pid: null, alive: false, lockConflict: { ...conflict, ownerPid: null } })), 900).reasons,
    [{ code: "runner-lock-conflict", serverId: SERVER_A, ownerPid: null, lockPath: conflict.lockPath }],
  );
  assert.deepEqual(
    verdict(facts(runner({ pid: null, alive: false, lockConflict: conflict })), 900).reasons.map((reason) => reason.code),
    ["runner-absent"],
  );
});
