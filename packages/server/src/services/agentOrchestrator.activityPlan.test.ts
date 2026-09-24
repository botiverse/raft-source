import assert from "node:assert/strict";
import { test } from "vitest";

import { buildAgentLifecycleStateSnapshot, planActivitySignalAction } from "./agentOrchestrator.js";

function activityInput(input: Parameters<typeof buildAgentLifecycleStateSnapshot>[0]) {
  return { state: buildAgentLifecycleStateSnapshot(input) };
}

test("planActivitySignalAction broadcasts activity for non-stopped agents when no reset is active", () => {
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "active", resetMode: null })),
    "broadcast-activity",
  );
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "inactive", resetMode: null })),
    "broadcast-activity",
  );
});

test("planActivitySignalAction ignores activity signals for stopped agents", () => {
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "stopped", resetMode: null })),
    "ignore",
  );
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "stopped", resetMode: "restart" })),
    "ignore",
  );
});

test("planActivitySignalAction ignores activity signals during reset for non-stopped agents", () => {
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "active", resetMode: "restart" })),
    "ignore",
  );
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "inactive", resetMode: "session" })),
    "ignore",
  );
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "active", resetMode: "full" })),
    "ignore",
  );
});

test("planActivitySignalAction accepts current guarded launch activity during reset", () => {
  assert.equal(
    planActivitySignalAction(activityInput({ dbStatus: "active", resetMode: "session", launchId: "launch-1" })),
    "broadcast-activity",
  );
});
