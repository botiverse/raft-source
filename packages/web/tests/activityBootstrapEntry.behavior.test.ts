/**
 * Behavior teeth for the activity bootstrap ENTRY (task #393).
 *
 * The entry (store/activityPanel/bootstrap.ts) is the only activity module the
 * initial bundle imports; it consults the leaf gate and dynamically imports
 * the runtime for shadow/on only, at most once. These teeth pin the entry's
 * observable contract; whether the BUNDLE actually keeps the runtime out of
 * the startup graph is pinned by scripts/check-activity-chunk-split.mjs
 * against the real production build (a static import here would not flip
 * these assertions — only that build check catches it).
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  observeActivityBootstrap,
  getActivityRuntimeLoadRequestsForTests,
  resetActivityBootstrapForTests,
} from "../src/store/activityPanel/bootstrap";
import { setActivityGateOverrideForTests } from "../src/store/activityPanel/gate";
import api from "../src/api/client";

const realGet = api.get;

afterEach(async () => {
  resetActivityBootstrapForTests();
  setActivityGateOverrideForTests(null);
  api.get = realGet;
  const runtime = await import("../src/store/activityPanel/runtime");
  runtime.resetActivityRuntimeForTests();
});

test("gate off: the entry never requests the runtime chunk", async () => {
  setActivityGateOverrideForTests("off");
  await observeActivityBootstrap();
  await observeActivityBootstrap();
  assert.equal(getActivityRuntimeLoadRequestsForTests(), 0);
});

test("gate shadow: the runtime loads once across repeated bootstraps and runs", async () => {
  const calls: string[] = [];
  api.get = (async (url: string) => {
    calls.push(url);
    return { data: {} };
  }) as typeof api.get;

  setActivityGateOverrideForTests("shadow");
  await observeActivityBootstrap();
  await observeActivityBootstrap();
  await observeActivityBootstrap();

  // Single chunk-load request even though the bootstrap ran three times.
  assert.equal(getActivityRuntimeLoadRequestsForTests(), 1);
  // The loaded runtime actually executed its bootstrap (issued snapshot GETs);
  // an entry that "loads" but never delegates would be a vacuous pass.
  assert.equal(calls.filter((url) => url === "/channels/activity/snapshot").length, 3);
});

test("gate off after a shadow session: later calls stay no-op without new loads", async () => {
  api.get = (async () => ({ data: {} })) as typeof api.get;
  setActivityGateOverrideForTests("shadow");
  await observeActivityBootstrap();
  assert.equal(getActivityRuntimeLoadRequestsForTests(), 1);

  setActivityGateOverrideForTests("off");
  const before = getActivityRuntimeLoadRequestsForTests();
  await observeActivityBootstrap();
  assert.equal(getActivityRuntimeLoadRequestsForTests(), before);
});
