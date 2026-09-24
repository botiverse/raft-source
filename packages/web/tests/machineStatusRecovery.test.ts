import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  InMemoryFailpointRegistry,
} from "@botiverse/raft-shared";
import { handleMachineStatusRecoveryEvent } from "../src/utils/machineStatusRecovery.js";

function createHarness(options: { machineVersions?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const updatedStatuses: Array<{ machineId: string; status: "online" | "offline"; statusVersion?: number }> = [];
  // Mirror the store's version-gated merge (mergeMachineStatus rejects
  // statusVersion < current) so the handler observes the real accepted/rejected
  // outcome and can gate offline side effects on it.
  const machineVersions: Record<string, number> = { ...(options.machineVersions ?? {}) };

  return {
    calls,
    updatedStatuses,
    deps: {
      updateMachineStatus: (machineId: string, status: "online" | "offline", statusVersion?: number): boolean => {
        updatedStatuses.push({ machineId, status, statusVersion });
        calls.push(`update:${machineId}:${status}`);
        const current = machineVersions[machineId];
        const accepted = statusVersion === undefined || current === undefined || statusVersion >= current;
        if (accepted && statusVersion !== undefined) {
          machineVersions[machineId] = statusVersion;
        }
        return accepted;
      },
      reloadMachines: () => {
        calls.push("reload:machines");
      },
      reloadAgents: () => {
        calls.push("reload:agents");
      },
    },
  };
}

test("offline machine status reloads authoritative machine + agent truth instead of force-writing agents", async () => {
  const { calls, updatedStatuses, deps } = createHarness();

  await handleMachineStatusRecoveryEvent(
    { machineId: "machine-1", status: "offline", statusVersion: 7 },
    deps,
  );

  assert.deepEqual(updatedStatuses, [{ machineId: "machine-1", status: "offline", statusVersion: 7 }]);
  assert.deepEqual(calls, [
    "update:machine-1:offline",
    "reload:machines",
    "reload:agents",
  ]);
});

test("a stale offline event (superseded by a newer status) does not reload or force the machine's agents offline", async () => {
  // Multi-replica fanout can reorder status events. After a restart, the
  // reconnect's online(vN+1) can arrive before the disconnect's offline(vN).
  // mergeMachineStatus rejects the stale offline(vN) for the machine (it stays
  // online), but the agents under that machine must NOT be force-offlined — the
  // machine is actually online. Without the guard the agents wrongly show
  // offline with no repair until a manual refresh.
  const { calls, deps } = createHarness({ machineVersions: { "machine-1": 9 } });

  await handleMachineStatusRecoveryEvent(
    { machineId: "machine-1", status: "offline", statusVersion: 6 },
    deps,
  );

  // The status update is still attempted (the store version-gates it), but the
  // stale offline must not produce recovery churn or any forceAgentOffline side effect.
  assert.deepEqual(calls, ["update:machine-1:offline"]);
});

test("online machine status triggers authoritative machine + agent reload", async () => {
  const { calls, updatedStatuses, deps } = createHarness();

  await handleMachineStatusRecoveryEvent(
    { machineId: "machine-1", status: "online", statusVersion: 8 },
    deps,
  );

  assert.deepEqual(updatedStatuses, [{ machineId: "machine-1", status: "online", statusVersion: 8 }]);
  assert.deepEqual(calls, [
    "update:machine-1:online",
    "reload:machines",
    "reload:agents",
  ]);
});

test("online recovery path remains injectable through the shared failpoint contract", async () => {
  const registry = new InMemoryFailpointRegistry();
  const { calls, deps } = createHarness();

  registry.configure("web.machineStatusRecovery.onlineAuthoritativeReload", {
    effect: "drop",
    mode: "once",
  });
  __setFailpointsForTests(registry);

  try {
    await handleMachineStatusRecoveryEvent(
      { machineId: "machine-1", status: "online", statusVersion: 9 },
      deps,
    );
  } finally {
    __resetFailpointsForTests();
  }

  assert.deepEqual(calls, ["update:machine-1:online"]);
  assert.deepEqual(registry.getTrace().map((entry) => entry.key), [
    "web.machineStatusRecovery.onlineAuthoritativeReload",
  ]);
});
