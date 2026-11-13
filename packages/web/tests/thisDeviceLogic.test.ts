import assert from "node:assert/strict";
import type { DesktopComputerHostState, DesktopComputerStatus } from "@botiverse/raft-shared";
import { belowMinimumVersion, deriveThisDeviceState, missingFeatures, isThisDeviceMachine, startsWithMessageId } from "../src/components/machine/localComputer/thisDeviceLogic";
import type { ThisDeviceInput } from "../src/components/machine/localComputer/thisDeviceLogic";
import { thisDevicePresence } from "../src/components/machine/localComputer/thisDeviceCopy";
import { addComputerOnDesktop, applyEnableProgress, ENABLE_PROGRESS_START, failEnableProgress } from "../src/components/machine/localComputer/addThisDeviceChoice";

// The This device state machine (design §4.5): one primary state, most
// urgent first, plus orthogonal flags. Raft Desktop drives the one official
// Raft Computer install; its host state and status decide the state.

const HOST: DesktopComputerHostState = {
  installed: true, version: "1.0.60", capabilities: ["attach-token-stdin", "approval-request", "active-turns", "doctor-json", "upgrade-yes"], installSupported: true,
  startsWith: "login-item", stoppedByUser: false, updating: false, migration: { state: "none" },
};
const STATUS: DesktopComputerStatus = { servers: [], service: { running: true } };

function input(patch: Partial<ThisDeviceInput> = {}): ThisDeviceInput {
  return { ready: true, host: HOST, status: STATUS, enabling: false, running: true, attachedHere: true, ...patch };
}
const kind = (patch: Partial<ThisDeviceInput>) => deriveThisDeviceState(input(patch)).kind;

test("checking until the bridge answered", () => assert.equal(kind({ ready: false }), "checking"));
test("not installed: nothing at the official install location", () => {
  assert.equal(kind({ host: { ...HOST, installed: false, version: null }, status: null, running: false }), "not-installed");
});
test("setting up while an Add This Mac runs", () => assert.equal(kind({ enabling: true }), "setting-up"));
test("migrating: an older Desktop's embedded Computer is being moved", () => {
  const state = deriveThisDeviceState(input({ host: { ...HOST, migration: { state: "running", step: "stop" } } }));
  assert.equal(state.kind, "migrating");
  assert.equal(state.controllable, false);
  assert.equal(state.problem, false);
});
test("migration failed: a problem, not controllable", () => {
  const state = deriveThisDeviceState(input({ host: { ...HOST, migration: { state: "failed", step: "start", code: "computer_migration_not_running", message: "did not start" } } }));
  assert.equal(state.kind, "migration-failed");
  assert.equal(state.controllable, false);
  assert.equal(state.problem, true);
});
test("update required: older than this Raft Desktop's minimum", () => {
  const state = deriveThisDeviceState(input({ host: { ...HOST, version: "1.0.40", capabilities: [] } }));
  assert.equal(state.kind, "update-required");
  assert.equal(state.problem, true);
  assert.equal(state.controllable, true, "it still runs: Start / Stop / Restart stay");
  assert.equal(state.flags.serviceRunning, true);
  // By what the Computer reports it can do, never by its version.
  assert.equal(belowMinimumVersion({ installed: true, capabilities: ["attach-token-stdin", "approval-request", "active-turns", "doctor-json"] }), false);
  assert.deepEqual(missingFeatures({ installed: true, capabilities: ["attach-token-stdin", "approval-request"] }), ["diagnostics", "stopWhenIdle"]);
  assert.deepEqual(missingFeatures({ installed: true, capabilities: [] }), ["addThisMac", "diagnostics", "stopWhenIdle"]);
  assert.deepEqual(missingFeatures({ installed: false, capabilities: null }), [], "nothing installed: nothing to update");
});
test("updating, even below the minimum (the update is the fix)", () => {
  assert.equal(kind({ host: { ...HOST, updating: true } }), "updating");
  assert.equal(kind({ host: { ...HOST, updating: true, version: "1.0.40", capabilities: [] } }), "updating");
});
test("running and stopped follow the service", () => {
  assert.equal(kind({}), "running");
  assert.equal(kind({ running: false, host: { ...HOST, stoppedByUser: true } }), "stopped");
  for (const k of ["running", "stopped", "updating"] as const) {
    const state = deriveThisDeviceState(input(k === "stopped" ? { running: false } : k === "updating" ? { host: { ...HOST, updating: true } } : {}));
    assert.equal(state.kind, k);
    assert.equal(state.controllable, true, k);
    assert.equal(state.problem, false, k);
  }
});
test("unreadable: installed, but its status can't be read", () => {
  const state = deriveThisDeviceState(input({ status: null, running: false }));
  assert.equal(state.kind, "unreadable");
  assert.equal(state.problem, true);
});
test("another service holds the key (an operation said so)", () => assert.equal(kind({ lastErrorCode: "duplicate_key", running: false }), "duplicate-key"));
test("a shell without the host state: what its status says", () => {
  assert.equal(kind({ host: null }), "running");
  assert.equal(kind({ host: null, running: false }), "stopped");
  assert.equal(kind({ host: null, status: null, running: false }), "not-installed");
});

test("flags: awaiting the server's listing only once the bridge has answered", () => {
  assert.equal(deriveThisDeviceState(input({ awaitingListing: true })).flags.awaitingListing, true);
  assert.equal(deriveThisDeviceState(input({ ready: false, awaitingListing: true })).flags.awaitingListing, false);
});

test("flags: not attached here, update available, diagnostics failed (a problem)", () => {
  const state = deriveThisDeviceState(input({ attachedHere: false, updateAvailable: true, diagnosticsFailed: true }));
  assert.deepEqual(state.flags, { notAttachedHere: true, updateAvailable: true, diagnosticsFailed: true, awaitingListing: false, serviceRunning: true });
  assert.equal(state.problem, true);
});

test("a problem is orange; running green; moving or setting up pending; the rest offline", () => {
  assert.equal(thisDevicePresence("migration-failed", true), "error");
  assert.equal(thisDevicePresence("running", false), "online");
  assert.equal(thisDevicePresence("migrating", false), "busy");
  assert.equal(thisDevicePresence("updating", false), "busy");
  assert.equal(thisDevicePresence("stopped", false), "offline");
  assert.equal(thisDevicePresence("running", false, true), "busy", "waiting to be listed is not green yet");
});

test("the status line says how it comes back: at login, or when Raft Desktop opens", () => {
  assert.equal(startsWithMessageId("login-item"), "computerHost.thisDevice.startsWithLoginItem");
  assert.equal(startsWithMessageId("app-open"), "computerHost.thisDevice.startsWithAppOpen");
});

test("This device needs the bridge's answer and the same machine id", () => {
  assert.equal(isThisDeviceMachine(null, "m1"), false);
  assert.equal(isThisDeviceMachine({ ready: false, self: { machineId: "m1" } }, "m1"), false);
  assert.equal(isThisDeviceMachine({ ready: true, self: { machineId: "m1" } }, "m1"), true);
  assert.equal(isThisDeviceMachine({ ready: true, self: { machineId: "m1" } }, "m2"), false);
});

test("Add Computer connects this computer unless it is here, or something is in the way", () => {
  assert.deepEqual(addComputerOnDesktop({ kind: "not-installed", attachedHere: false, canAttach: true }), { kind: "connect" });
  assert.deepEqual(addComputerOnDesktop({ kind: "update-required", attachedHere: false, canAttach: true }), { kind: "connect" }, "Add This Mac installs the update first");
  assert.deepEqual(addComputerOnDesktop({ kind: "running", attachedHere: true, canAttach: true }), { kind: "open-this-device", reason: "attached" });
  for (const blocked of ["migrating", "migration-failed", "unreadable", "duplicate-key", "setting-up"] as const) {
    assert.deepEqual(addComputerOnDesktop({ kind: blocked, attachedHere: false, canAttach: true }), { kind: "open-this-device", reason: "blocked" }, blocked);
  }
  assert.deepEqual(addComputerOnDesktop({ kind: "not-installed", attachedHere: false, canAttach: false }), { kind: "open-this-device", reason: "blocked" }, "installing isn't supported here");
});

test("Add This Mac's steps: install skipped shows done with its version; an active step finishes the ones before it", () => {
  let progress = applyEnableProgress(ENABLE_PROGRESS_START, { step: "install", state: "skipped", version: "1.0.60" });
  assert.deepEqual(progress.install, { state: "done", skipped: true, version: "1.0.60" });
  progress = applyEnableProgress(progress, { step: "start", state: "active" });
  assert.equal(progress.attach.state, "done");
  assert.equal(progress.start.state, "active");
  assert.equal(progress.online.state, "wait");
  assert.equal(failEnableProgress(progress).start.state, "failed");
});
