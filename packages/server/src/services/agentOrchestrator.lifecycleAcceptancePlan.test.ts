import assert from "node:assert/strict";
import { test } from "vitest";

import { planLifecycleEventAcceptance } from "./agentOrchestrator.js";

test("planLifecycleEventAcceptance accepts events in legacy mode", () => {
  assert.equal(
    planLifecycleEventAcceptance({
      launchGuardMode: "legacy",
      expectedLaunchId: null,
      launchId: undefined,
    }),
    "accept",
  );
  assert.equal(
    planLifecycleEventAcceptance({
      launchGuardMode: "legacy",
      expectedLaunchId: "launch-1",
      launchId: "other",
    }),
    "accept",
  );
});

test("planLifecycleEventAcceptance accepts events in guarded mode when launchId matches", () => {
  assert.equal(
    planLifecycleEventAcceptance({
      launchGuardMode: "guarded",
      expectedLaunchId: "launch-1",
      launchId: "launch-1",
    }),
    "accept",
  );
});

test("planLifecycleEventAcceptance rejects legacy events for guarded agents", () => {
  assert.equal(
    planLifecycleEventAcceptance({
      launchGuardMode: "guarded",
      expectedLaunchId: "launch-1",
      launchId: undefined,
    }),
    "ignore-legacy-for-guarded",
  );
});

test("planLifecycleEventAcceptance rejects stale launchIds for guarded agents", () => {
  assert.equal(
    planLifecycleEventAcceptance({
      launchGuardMode: "guarded",
      expectedLaunchId: "launch-1",
      launchId: "launch-2",
    }),
    "ignore-stale-launch",
  );
});

test("planLifecycleEventAcceptance fails open if guarded mode has no expected launchId", () => {
  assert.equal(
    planLifecycleEventAcceptance({
      launchGuardMode: "guarded",
      expectedLaunchId: null,
      launchId: undefined,
    }),
    "accept",
  );
});
