import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMachineEvent,
} from "../src/store/events/machineEvents.js";
import type {
  MachineDomainState,
} from "../src/store/events/machineEvents.js";
import type { Machine } from "../src/store/machineStore.js";

function seedMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine-1",
    name: "dev-machine",
    description: null,
    status: "online",
    statusVersion: 5,
    apiKeyPrefix: null,
    runtimes: ["node"],
    hostname: null,
    os: null,
    daemonVersion: null,
    lastHeartbeat: null,
    createdAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}

function seedState(
  overrides: Partial<MachineDomainState> = {},
): MachineDomainState {
  return {
    machines: [seedMachine()],
    latestDaemonVersion: null,
    latestComputerVersion: null,
    computerOperationProgress: {},
    ...overrides,
  };
}

test("machine offline accepts newer versions and requests authoritative reload instead of local agent cascade", () => {
  const result = applyMachineEvent(seedState(), {
    kind: "status",
    machineId: "machine-1",
    status: "offline",
    statusVersion: 6,
  });

  assert.equal(result.transition.event, "status");
  assert.equal(result.transition.touched, 1);
  assert.equal(result.transition.accepted, true);
  assert.equal(result.transition.recoveryAction, "reload-machines-and-agents");
  assert.equal(result.state.machines[0].status, "offline");
  assert.equal(result.state.machines[0].statusVersion, 6);
});

test("machine status rejects stale versions without replacing state references", () => {
  const state = seedState({ machines: [seedMachine({ statusVersion: 9 })] });
  const result = applyMachineEvent(state, {
    kind: "status",
    machineId: "machine-1",
    status: "offline",
    statusVersion: 6,
  });

  assert.equal(result.transition.touched, 0);
  assert.equal(result.transition.accepted, false);
  assert.equal(result.transition.recoveryAction, null);
  assert.equal(result.state, state);
  assert.equal(result.state.machines, state.machines);
  assert.equal(result.state.machines[0].status, "online");
  assert.equal(result.state.machines[0].statusVersion, 9);
});

test("online status requests authoritative machine and agent reload even when the status is already current", () => {
  const state = seedState({
    machines: [seedMachine({ status: "online", statusVersion: 7 })],
  });

  const result = applyMachineEvent(state, {
    kind: "status",
    machineId: "machine-1",
    status: "online",
    statusVersion: 7,
  });

  assert.equal(result.transition.touched, 1);
  assert.equal(result.transition.accepted, true);
  assert.equal(result.transition.recoveryAction, "reload-machines-and-agents");

  const staleOnline = applyMachineEvent(result.state, {
    kind: "status",
    machineId: "machine-1",
    status: "online",
    statusVersion: 6,
  });
  assert.equal(staleOnline.transition.touched, 0);
  assert.equal(staleOnline.transition.accepted, false);
  assert.equal(
    staleOnline.transition.recoveryAction,
    "reload-machines-and-agents",
  );
});

test("machine-updated reconcile is a pure transition that asks wiring to reload machines only", () => {
  const state = seedState();
  const result = applyMachineEvent(state, {
    kind: "reconcile",
    reason: "machine-updated",
  });

  assert.equal(result.state, state);
  assert.equal(result.transition.event, "reconcile");
  assert.equal(result.transition.touched, 0);
  assert.equal(result.transition.accepted, true);
  assert.equal(result.transition.recoveryAction, "reload-machines");
});

test("scheduled reconcile is a pure transition that asks wiring to reload machine and agent truth", () => {
  const state = seedState();
  const result = applyMachineEvent(state, {
    kind: "reconcile",
    reason: "scheduled",
  });

  assert.equal(result.state, state);
  assert.equal(result.transition.event, "reconcile");
  assert.equal(result.transition.touched, 0);
  assert.equal(result.transition.accepted, true);
  assert.equal(result.transition.recoveryAction, "reload-machines-and-agents");
});

test("machine capabilities updates only changed fields and preserves no-op references", () => {
  const state = seedState({
    machines: [seedMachine({ runtimes: ["node"], runtimeVersions: { node: "22.1.0" }, hostname: "host-a" })],
  });

  const noChange = applyMachineEvent(state, {
    kind: "capabilities",
    machineId: "machine-1",
    runtimes: ["node"],
    runtimeVersions: { node: "22.1.0" },
    hostname: "host-a",
  });
  assert.equal(noChange.transition.touched, 0);
  assert.equal(noChange.state, state);

  const changed = applyMachineEvent(state, {
    kind: "capabilities",
    machineId: "machine-1",
    runtimes: ["node", "python"],
    runtimeVersions: { node: "22.1.0", python: "3.13.1" },
    hostname: "host-b",
    daemonVersion: "0.33.0",
    computerVersion: "0.0.7",
  });
  assert.equal(changed.transition.touched, 1);
  assert.deepEqual(changed.state.machines[0].runtimes, ["node", "python"]);
  assert.deepEqual(changed.state.machines[0].runtimeVersions, { node: "22.1.0", python: "3.13.1" });
  assert.equal(changed.state.machines[0].hostname, "host-b");
  assert.equal(changed.state.machines[0].daemonVersion, "0.33.0");
  assert.equal(changed.state.machines[0].computerVersion, "0.0.7");

  const equivalentMap = applyMachineEvent(changed.state, {
    kind: "capabilities",
    machineId: "machine-1",
    runtimes: ["node", "python"],
    runtimeVersions: { node: "22.1.0", python: "3.13.1" },
    hostname: "host-b",
    daemonVersion: "0.33.0",
    computerVersion: "0.0.7",
  });
  assert.equal(equivalentMap.transition.touched, 0, "an equivalent version map preserves store references");
  assert.equal(equivalentMap.state, changed.state);

  const cleared = applyMachineEvent(changed.state, {
    kind: "capabilities",
    machineId: "machine-1",
    runtimes: ["node", "python"],
    runtimeVersions: {},
    hostname: "host-b",
    daemonVersion: "0.33.0",
    computerVersion: "0.0.7",
  });
  assert.equal(cleared.transition.touched, 1);
  assert.deepEqual(cleared.state.machines[0].runtimeVersions, {});
});

test("upgrade progress scales download percent and rejects stale request frames", () => {
  const first = applyMachineEvent(seedState(), {
    kind: "upgrade-progress",
    machineId: "machine-1",
    requestId: "req-1",
    phase: "downloading",
    percent: 50,
    message: "Downloading",
  });

  assert.equal(first.transition.touched, 1);
  assert.equal(
    first.state.computerOperationProgress["machine-1"]?.progressValue,
    43,
  );
  assert.equal(
    first.state.computerOperationProgress["machine-1"]?.requestId,
    "req-1",
  );

  const stale = applyMachineEvent(first.state, {
    kind: "upgrade-progress",
    machineId: "machine-1",
    requestId: "req-old",
    phase: "applying",
  });

  assert.equal(stale.transition.touched, 0);
  assert.equal(stale.state, first.state);
  assert.equal(
    stale.state.computerOperationProgress["machine-1"]?.phase,
    "downloading",
  );
});

test("upgrade done completes the matching request and ignores stale completions", () => {
  const progress = applyMachineEvent(seedState(), {
    kind: "upgrade-progress",
    machineId: "machine-1",
    requestId: "req-1",
    phase: "applying",
  }).state;

  const done = applyMachineEvent(progress, {
    kind: "upgrade-done",
    machineId: "machine-1",
    requestId: "req-1",
    ok: true,
    newVersion: "0.0.8",
  });

  assert.equal(done.transition.touched, 1);
  assert.equal(done.state.computerOperationProgress["machine-1"]?.done, true);
  assert.equal(
    done.state.computerOperationProgress["machine-1"]?.progressValue,
    100,
  );
  assert.equal(
    done.state.computerOperationProgress["machine-1"]?.newVersion,
    "0.0.8",
  );

  const stale = applyMachineEvent(done.state, {
    kind: "upgrade-done",
    machineId: "machine-1",
    requestId: "req-old",
    ok: false,
    error: "stale",
  });

  assert.equal(stale.transition.touched, 0);
  assert.equal(stale.state, done.state);
  assert.equal(
    stale.state.computerOperationProgress["machine-1"]?.error,
    undefined,
  );
});

test("restart done completes only the matching request receipt", () => {
  const progress = applyMachineEvent(seedState(), {
    kind: "operation-set",
    machineId: "machine-1",
    progress: { operation: "restart", requestId: "restart-1" },
  }).state;

  const stale = applyMachineEvent(progress, {
    kind: "restart-done",
    machineId: "machine-1",
    requestId: "restart-old",
    ok: true,
  });
  assert.equal(stale.transition.touched, 0);
  assert.equal(stale.state, progress);

  const done = applyMachineEvent(progress, {
    kind: "restart-done",
    machineId: "machine-1",
    requestId: "restart-1",
    ok: true,
  });
  assert.equal(done.transition.touched, 1);
  assert.equal(done.state.computerOperationProgress["machine-1"]?.done, true);
  assert.equal(done.state.computerOperationProgress["machine-1"]?.error, undefined);
});

test("operation set distinguishes equal-length progress objects with different keys", () => {
  const optimistic = applyMachineEvent(seedState(), {
    kind: "operation-set",
    machineId: "machine-1",
    progress: { operation: "restart", phase: undefined },
  }).state;

  const correlated = applyMachineEvent(optimistic, {
    kind: "operation-set",
    machineId: "machine-1",
    progress: { operation: "restart", requestId: "restart-1" },
  });

  assert.equal(correlated.transition.touched, 1);
  assert.deepEqual(correlated.state.computerOperationProgress["machine-1"], {
    operation: "restart",
    requestId: "restart-1",
  });
});
