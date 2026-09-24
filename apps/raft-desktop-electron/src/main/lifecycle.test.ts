import assert from "node:assert/strict";
import { test } from "node:test";
import { INITIAL_LIFECYCLE_STATE, reduceLifecycle } from "./lifecycle.js";

test("darwin: closing the last window keeps the app resident", () => {
  const { decision } = reduceLifecycle(
    INITIAL_LIFECYCLE_STATE,
    { type: "window-all-closed" },
    "darwin",
  );
  assert.equal(decision, "none");
});

test("darwin: explicit quit lets window-all-closed quit", () => {
  const afterQuit = reduceLifecycle(INITIAL_LIFECYCLE_STATE, { type: "before-quit" }, "darwin");
  assert.equal(afterQuit.decision, "none");
  const { decision } = reduceLifecycle(afterQuit.state, { type: "window-all-closed" }, "darwin");
  assert.equal(decision, "quit");
});

test("non-darwin: last window closing quits", () => {
  const { decision } = reduceLifecycle(
    INITIAL_LIFECYCLE_STATE,
    { type: "window-all-closed" },
    "win32",
  );
  assert.equal(decision, "quit");
});

test("activate with no windows reboots; with windows does nothing", () => {
  const none = reduceLifecycle(
    INITIAL_LIFECYCLE_STATE,
    { type: "activate", hasServerWindows: true },
    "darwin",
  );
  assert.equal(none.decision, "none");
  const reboot = reduceLifecycle(
    INITIAL_LIFECYCLE_STATE,
    { type: "activate", hasServerWindows: false },
    "darwin",
  );
  assert.equal(reboot.decision, "reboot");
});

test("activate while quitting does not reboot", () => {
  const quitting = reduceLifecycle(INITIAL_LIFECYCLE_STATE, { type: "before-quit" }, "darwin").state;
  const { decision } = reduceLifecycle(
    quitting,
    { type: "activate", hasServerWindows: false },
    "darwin",
  );
  assert.equal(decision, "none");
});
