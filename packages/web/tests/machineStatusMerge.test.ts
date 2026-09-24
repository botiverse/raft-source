import assert from "node:assert/strict";
import test from "node:test";
import { mergeMachineStatus } from "../src/utils/machineStatusMerge.js";
import type { Machine } from "../src/store/machineStore.js";

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine-1",
    name: "Machine 1",
    description: null,
    status: "online",
    statusVersion: 3,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: null,
    os: null,
    daemonVersion: null,
    lastHeartbeat: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("machine status merge ignores stale websocket updates that would roll the version backward", () => {
  const machine = makeMachine({ status: "online", statusVersion: 5 });

  assert.deepEqual(
    mergeMachineStatus(machine, "offline", 4),
    machine,
  );
});

test("machine status merge accepts newer websocket updates", () => {
  const machine = makeMachine({ status: "online", statusVersion: 5 });

  assert.deepEqual(
    mergeMachineStatus(machine, "offline", 6),
    {
      ...machine,
      status: "offline",
      statusVersion: 6,
    },
  );
});

test("machine status merge preserves the current version for legacy unversioned updates", () => {
  const machine = makeMachine({ status: "online", statusVersion: 5 });

  assert.deepEqual(
    mergeMachineStatus(machine, "offline"),
    {
      ...machine,
      status: "offline",
      statusVersion: 5,
    },
  );
});
