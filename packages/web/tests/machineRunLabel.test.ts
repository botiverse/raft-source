import assert from "node:assert/strict";
import test from "node:test";
import { agentProfileMachineRunLabel } from "../src/utils/agentProfileMachineRunLabel.js";
import { machineRunLabel } from "../src/utils/machineRunLabel.js";

test("computer online + version → 'computer v<version>'", () => {
  assert.deepEqual(
    machineRunLabel({ isComputer: true, status: "online", computerVersion: "0.0.61", daemonVersion: null }),
    { text: "computer v0.0.61", isOffline: false },
  );
});

test("REGRESSION (#wg-raft-computer:de94165c): computer online + null version → 'computer online' (NOT 'computer offline')", () => {
  // Reproduces the Maria 2026-06-20 bug: cross-replica REST returns
  // status=online + computerVersion=null because the read landed on a
  // non-owner replica whose `agentOrchestrator.machineConnections` doesn't
  // hold this machine. The label must follow `status`, not version presence.
  assert.deepEqual(
    machineRunLabel({ isComputer: true, status: "online", computerVersion: null, daemonVersion: null }),
    { text: "computer online", isOffline: false },
  );
});

test("REGRESSION (#wg-raft-computer:db5de12a): computer without computerVersion does not fall back to daemonVersion", () => {
  assert.deepEqual(
    machineRunLabel({ isComputer: true, status: "online", computerVersion: null, daemonVersion: "0.0.0-dev" }),
    { text: "computer online", isOffline: false },
  );
});

test("REGRESSION (#wg-raft-computer:db5de12a): agent profile Computer row uses canonical machineRunLabel", () => {
  // The descriptor (id + values) is what the row renders via formatMessage —
  // the old `.text` variant bypassed the catalog and showed English in zh UI
  // (DOM sweep 2026-08-04). Pin the descriptor shape.
  assert.deepEqual(
    agentProfileMachineRunLabel({
      isComputer: true,
      status: "online",
      computerVersion: null,
      daemonVersion: "0.0.0-dev",
    }),
    { id: "machine.runLabel.computerOnline", isOffline: false },
  );

  // Component connection is pinned by rendered behavior coverage instead
  // (tests/machineRunLabelRender.behavior.test.ts) — no source-regex asserts,
  // per the standing rule for this class.
});

test("computer offline → 'computer offline' regardless of version", () => {
  assert.deepEqual(
    machineRunLabel({ isComputer: true, status: "offline", computerVersion: "0.0.61", daemonVersion: null }),
    { text: "computer offline", isOffline: true },
  );
  assert.deepEqual(
    machineRunLabel({ isComputer: true, status: "offline", computerVersion: null, daemonVersion: null }),
    { text: "computer offline", isOffline: true },
  );
});

test("raw daemon online + version → 'daemon v<version>'", () => {
  assert.deepEqual(
    machineRunLabel({ isComputer: false, status: "online", computerVersion: null, daemonVersion: "0.55.5" }),
    { text: "daemon v0.55.5", isOffline: false },
  );
});

test("raw daemon online + null version → 'daemon online'", () => {
  assert.deepEqual(
    machineRunLabel({ isComputer: false, status: "online", computerVersion: null, daemonVersion: null }),
    { text: "daemon online", isOffline: false },
  );
});

test("raw daemon offline → 'daemon offline'", () => {
  assert.deepEqual(
    machineRunLabel({ isComputer: false, status: "offline", computerVersion: null, daemonVersion: "0.55.5" }),
    { text: "daemon offline", isOffline: true },
  );
});
