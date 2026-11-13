import assert from "node:assert/strict";
import { formatMachinePlatformLine, sameMachinePeers } from "../src/utils/machinePlatformLine";
import { applyMachineEvent } from "../src/store/events/machineEvents";
import type { Machine } from "../src/store/machineStore";

// The OS · provider line agreed for Computer cards and the detail page:
// show whichever part exists, never a dangling "·", nothing when both are
// missing, and the provider only through HOST_PROVIDER_LABELS.

test("OS release and a known provider join with a middle dot", () => {
  assert.equal(formatMachinePlatformLine({ osRelease: "Ubuntu 26.04", hostProvider: "hetzner" }), "Ubuntu 26.04 · Hetzner Cloud");
});

test("only the OS release when the provider is missing", () => {
  assert.equal(formatMachinePlatformLine({ osRelease: "Ubuntu 26.04", hostProvider: null }), "Ubuntu 26.04");
  assert.equal(formatMachinePlatformLine({ osRelease: "Ubuntu 26.04" }), "Ubuntu 26.04");
});

test("only the provider name when the OS release is missing", () => {
  assert.equal(formatMachinePlatformLine({ osRelease: null, hostProvider: "aws" }), "AWS");
  assert.equal(formatMachinePlatformLine({ osRelease: "  ", hostProvider: "exe_dev" }), "exe.dev");
});

test("nothing when both are missing (null values, absent fields)", () => {
  assert.equal(formatMachinePlatformLine({ osRelease: null, hostProvider: null }), null);
  assert.equal(formatMachinePlatformLine({}), null);
});

test("an unknown provider id shows no provider and never the raw id", () => {
  assert.equal(formatMachinePlatformLine({ osRelease: "Debian 13", hostProvider: "future_cloud" }), "Debian 13");
  assert.equal(formatMachinePlatformLine({ osRelease: null, hostProvider: "future_cloud" }), null);
  // Prototype keys are not providers.
  assert.equal(formatMachinePlatformLine({ osRelease: null, hostProvider: "toString" }), null);
});

test("same-machine peers share the label; alone or flag off means none", () => {
  const machines = [
    { id: "a", name: "A", sameMachineGroup: "machine-1" },
    { id: "b", name: "B", sameMachineGroup: "machine-1" },
    { id: "c", name: "C", sameMachineGroup: null },
    { id: "d", name: "D" },
    { id: "e", name: "E", sameMachineGroup: "machine-1" },
  ];
  assert.deepEqual(sameMachinePeers(machines[0], machines).map((m) => m.name), ["B", "E"]);
  assert.deepEqual(sameMachinePeers(machines[2], machines), []);
  assert.deepEqual(sameMachinePeers(machines[3], machines), []);
});

test("a capabilities push updates host facts; a push without them keeps the old ones", () => {
  const machine: Machine = {
    id: "m1", name: "Box", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null,
    runtimes: [], hostname: "box", os: "linux", daemonVersion: null, lastHeartbeat: null, createdAt: "2026-10-19T00:00:00.000Z",
    hostProvider: null, osRelease: null,
  };
  const state = { machines: [machine], latestComputerVersion: null, computerOperationProgress: {} };
  const updated = applyMachineEvent(state, { kind: "capabilities", machineId: "m1", hostProvider: "hetzner", osRelease: "Ubuntu 26.04" }).state;
  assert.equal(updated.machines[0].hostProvider, "hetzner");
  assert.equal(updated.machines[0].osRelease, "Ubuntu 26.04");
  const kept = applyMachineEvent(updated, { kind: "capabilities", machineId: "m1", runtimeDetection: { status: "pending" } }).state;
  assert.equal(kept.machines[0].osRelease, "Ubuntu 26.04");
  assert.equal(kept.machines[0].hostProvider, "hetzner");
});

test("a Mac or Windows Computer without a release names its OS, as the rack row does", () => {
  assert.equal(formatMachinePlatformLine({ os: "darwin arm64", osRelease: null, hostProvider: null }), "macOS");
  assert.equal(formatMachinePlatformLine({ os: "win32 x64", osRelease: null, hostProvider: "hetzner" }), "Windows · Hetzner Cloud");
});
