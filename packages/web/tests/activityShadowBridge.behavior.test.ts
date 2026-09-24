/**
 * Current-base P1 compatibility prerequisite — behavior teeth for the thin
 * Activity external-store bridge.
 *
 * These are deliberately separate from Projection P2. The bridge carries one
 * already-derived primitive watermark from runtime to React; it never sees or
 * derives Activity rows, groups, pagination, or authority.
 *
 * VERIFIED REVERSE CUT:
 *  - delete the bridge's production `registerServerReset(...)` registration
 *    -> the real-server-reset stale-publisher tooth is RED (the old value stays
 *       readable and the held publisher is still accepted).
 */
import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";

import {
  captureActivityShadowGeneration,
  getActivityShadowVersion,
  invalidateActivityShadowGeneration,
  publishActivityShadowVersion,
  resetActivityShadowBridgeForTests,
} from "../src/store/activityShadowBridge";
import {
  getActivityRuntimeLoadRequestsForTests,
  observeActivityBootstrap,
  resetActivityBootstrapForTests,
} from "../src/store/activityPanel/bootstrap";
import { setActivityGateOverrideForTests } from "../src/store/activityPanel/gate";
import {
  resetActivityRuntimeForTests,
  setActivityGateForTests,
} from "../src/store/activityPanel/runtime";
import { triggerServerReset } from "../src/store/serverResetRegistry";

type TestFn = (t: unknown) => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn as never);

afterEach(() => {
  resetActivityBootstrapForTests();
  resetActivityRuntimeForTests();
  setActivityGateOverrideForTests(null);
  resetActivityShadowBridgeForTests();
});

test("a generation reset clears the primitive and permanently fences a held publisher", () => {
  const heldGeneration = captureActivityShadowGeneration();

  assert.equal(publishActivityShadowVersion(heldGeneration, "9007199254740993"), true);
  assert.equal(
    getActivityShadowVersion(),
    "9007199254740993",
    "the runtime publication must stay byte-exact above 2^53",
  );

  invalidateActivityShadowGeneration();
  assert.equal(getActivityShadowVersion(), null, "a generation boundary clears the old snapshot");
  assert.equal(
    publishActivityShadowVersion(heldGeneration, "9007199254740995"),
    false,
    "a publisher captured before reset must never repopulate the bridge",
  );
  assert.equal(getActivityShadowVersion(), null);

  const freshGeneration = captureActivityShadowGeneration();
  assert.notEqual(freshGeneration, heldGeneration);
  assert.equal(publishActivityShadowVersion(freshGeneration, "9007199254740997"), true);
  assert.equal(
    getActivityShadowVersion(),
    "9007199254740997",
    "a publisher from the new generation remains live after the reset",
  );
});

test("a REAL server reset clears the snapshot and makes the pre-reset publisher stale", () => {
  const heldGeneration = captureActivityShadowGeneration();
  assert.equal(publishActivityShadowVersion(heldGeneration, "41"), true);
  assert.equal(getActivityShadowVersion(), "41");

  // Production path, not a direct helper call. Deleting the bridge's
  // registerServerReset registration must leave "41" readable and make the
  // two assertions below fail.
  triggerServerReset();

  assert.equal(getActivityShadowVersion(), null);
  assert.equal(publishActivityShadowVersion(heldGeneration, "42"), false);
  assert.equal(getActivityShadowVersion(), null);

  const freshGeneration = captureActivityShadowGeneration();
  assert.equal(publishActivityShadowVersion(freshGeneration, "43"), true);
  assert.equal(getActivityShadowVersion(), "43");
});

test("turning the runtime gate off clears the snapshot and invalidates the old generation", () => {
  setActivityGateForTests("shadow");
  const heldGeneration = captureActivityShadowGeneration();
  assert.equal(publishActivityShadowVersion(heldGeneration, "51"), true);

  setActivityGateForTests("off");

  assert.equal(getActivityShadowVersion(), null);
  assert.equal(publishActivityShadowVersion(heldGeneration, "52"), false);
});

test("the gate-off bootstrap clears a prior snapshot without loading the heavy runtime", async () => {
  setActivityGateOverrideForTests("shadow");
  const heldGeneration = captureActivityShadowGeneration();
  assert.equal(publishActivityShadowVersion(heldGeneration, "61"), true);

  setActivityGateOverrideForTests("off");
  await observeActivityBootstrap();

  assert.equal(getActivityRuntimeLoadRequestsForTests(), 0);
  assert.equal(getActivityShadowVersion(), null);
  assert.equal(publishActivityShadowVersion(heldGeneration, "62"), false);
});
