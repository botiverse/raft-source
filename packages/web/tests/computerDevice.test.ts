import assert from "node:assert/strict";
import { DEVICE_CLASSES, HOST_PROVIDER_LABELS } from "@botiverse/raft-shared";
import { applyMachineEvent } from "../src/store/events/machineEvents";
import type { Machine } from "../src/store/machineStore";
import { computerDeviceShape, computerOsName } from "../src/utils/computerDevice";

// A Computer is drawn as one of four shapes: laptop, monitor, server, cloud.

test("every device class maps to its shape; the rest are the monitor", () => {
  const shapes = Object.fromEntries(DEVICE_CLASSES.map((deviceClass) => [deviceClass, computerDeviceShape({ deviceClass })]));
  assert.deepEqual(shapes, {
    laptop: "laptop",
    mini: "monitor",
    studio: "monitor",
    imac: "monitor",
    desktop: "monitor",
    server: "server",
    vm: "monitor",
    container: "monitor",
  });
});

test("unknown, missing or a newer server's class is the monitor", () => {
  assert.equal(computerDeviceShape({}), "monitor");
  assert.equal(computerDeviceShape({ deviceClass: null, hostProvider: null }), "monitor");
  assert.equal(computerDeviceShape({ deviceClass: "toaster" }), "monitor");
});

test("a recognised cloud provider is the cloud, whatever the class", () => {
  for (const hostProvider of Object.keys(HOST_PROVIDER_LABELS)) {
    assert.equal(computerDeviceShape({ hostProvider, deviceClass: "vm" }), "cloud", hostProvider);
  }
  assert.equal(computerDeviceShape({ hostProvider: "hetzner", deviceClass: "server" }), "cloud");
  // An id this bundle does not know is not a cloud.
  assert.equal(computerDeviceShape({ hostProvider: "acme-cloud", deviceClass: "server" }), "server");
});

test("OS name: the reported release, else macOS / Windows from the platform, else none", () => {
  assert.equal(computerOsName({ os: "linux x64", osRelease: "Ubuntu 26.04" }), "Ubuntu 26.04");
  assert.equal(computerOsName({ os: "darwin arm64", osRelease: null }), "macOS");
  assert.equal(computerOsName({ os: "win32 x64" }), "Windows");
  assert.equal(computerOsName({ os: "linux x64", osRelease: "  " }), null);
  assert.equal(computerOsName({ os: null }), null);
});

test("a capabilities push updates the device class; a push without it keeps the old one", () => {
  const machine: Machine = {
    id: "m1", name: "Box", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null,
    runtimes: [], hostname: "box", os: "linux", daemonVersion: null, lastHeartbeat: null, createdAt: "2026-10-19T00:00:00.000Z",
    deviceClass: null,
  };
  const state = { machines: [machine], latestComputerVersion: null, computerOperationProgress: {} };
  const updated = applyMachineEvent(state, { kind: "capabilities", machineId: "m1", deviceClass: "laptop" }).state;
  assert.equal(updated.machines[0].deviceClass, "laptop");
  const kept = applyMachineEvent(updated, { kind: "capabilities", machineId: "m1", runtimeDetection: { status: "pending" } }).state;
  assert.equal(kept.machines[0].deviceClass, "laptop");
});
