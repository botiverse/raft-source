import assert from "node:assert/strict";
import { runNamedCase } from "./test/runNamedCase";

import { collectMachineFacts, type MachineFacts, type RunnerMachineFacts } from "./machineFacts";
import { machineReadiness, type MachineReadinessReasonCode } from "./machineReadiness";
import { serverRunnerPidReadFallback } from "./paths";

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
  }]);
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
