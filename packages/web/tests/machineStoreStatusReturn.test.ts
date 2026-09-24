import assert from "node:assert/strict";
import test from "node:test";
import { useMachineStore } from "../src/store/machineStore.js";
import type { Machine } from "../src/store/machineStore.js";

function seedMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine-1",
    name: "dev-machine",
    description: null,
    status: "online",
    statusVersion: 5,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: null,
    os: null,
    daemonVersion: null,
    lastHeartbeat: null,
    createdAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}

function resetStore(machines: Machine[]) {
  useMachineStore.setState({ machines });
}

// Pins the reference-equality -> boolean mapping directly (mergeMachineStatus
// returns the same reference when it rejects a stale event, a new object when
// it accepts). The recovery handler's offline guard depends on this contract.
test("updateMachineStatus returns true when the event is accepted (newer version)", () => {
  resetStore([seedMachine({ statusVersion: 5 })]);
  const accepted = useMachineStore.getState().updateMachineStatus("machine-1", "offline", 6);
  assert.equal(accepted, true);
  assert.equal(useMachineStore.getState().machines[0].status, "offline");
  assert.equal(useMachineStore.getState().machines[0].statusVersion, 6);
});

test("updateMachineStatus returns false when the event is stale (older version)", () => {
  resetStore([seedMachine({ status: "online", statusVersion: 9 })]);
  const accepted = useMachineStore.getState().updateMachineStatus("machine-1", "offline", 6);
  assert.equal(accepted, false);
  // Machine stays online: the stale offline is rejected by the version gate.
  assert.equal(useMachineStore.getState().machines[0].status, "online");
  assert.equal(useMachineStore.getState().machines[0].statusVersion, 9);
});

test("updateMachineStatus returns true on equal version (idempotent last-write-wins)", () => {
  resetStore([seedMachine({ status: "online", statusVersion: 7 })]);
  const accepted = useMachineStore.getState().updateMachineStatus("machine-1", "offline", 7);
  assert.equal(accepted, true);
  assert.equal(useMachineStore.getState().machines[0].status, "offline");
});

test("updateMachineStatus returns false for an unknown machine", () => {
  resetStore([seedMachine({ id: "machine-1" })]);
  const accepted = useMachineStore.getState().updateMachineStatus("machine-unknown", "offline", 99);
  assert.equal(accepted, false);
});
