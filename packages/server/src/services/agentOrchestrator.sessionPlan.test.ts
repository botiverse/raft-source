import assert from "node:assert/strict";
import { test } from "vitest";

import { buildAgentLifecycleStateSnapshot, planSessionSignalAction } from "./agentOrchestrator.js";

function sessionInput(input: Parameters<typeof buildAgentLifecycleStateSnapshot>[0]) {
  return { state: buildAgentLifecycleStateSnapshot(input) };
}

test("planSessionSignalAction persists active session for non-stopped agents when no reset is active", () => {
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "active", resetMode: null })),
    "persist-active-session",
  );
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "inactive", resetMode: null })),
    "persist-active-session",
  );
});

test("planSessionSignalAction ignores and releases wake lock for stopped agents", () => {
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "stopped", resetMode: null })),
    "ignore-and-release-wake-lock",
  );
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "stopped", resetMode: "restart" })),
    "ignore-and-release-wake-lock",
  );
});

test("planSessionSignalAction ignores session signals during reset for non-stopped agents", () => {
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "active", resetMode: "restart" })),
    "ignore",
  );
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "inactive", resetMode: "session" })),
    "ignore",
  );
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "active", resetMode: "full" })),
    "ignore",
  );
});

test("planSessionSignalAction accepts current guarded launch session signals during reset", () => {
  assert.equal(
    planSessionSignalAction(sessionInput({ dbStatus: "active", resetMode: "session", launchId: "launch-1" })),
    "persist-active-session",
  );
});
