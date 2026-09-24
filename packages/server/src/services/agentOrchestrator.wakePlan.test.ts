import assert from "node:assert/strict";
import { test } from "vitest";

import { buildAgentLifecycleStateSnapshot, planWakeAction } from "./agentOrchestrator.js";

function wakeInput(input: Parameters<typeof buildAgentLifecycleStateSnapshot>[0]) {
  return { state: buildAgentLifecycleStateSnapshot(input) };
}

test("planWakeAction attempts wake for inactive agents when no reset is active", () => {
  assert.equal(planWakeAction(wakeInput({ dbStatus: "inactive", resetMode: null })), "attempt-wake");
});

test("planWakeAction suppresses wake while a runtime profile control gate is active", () => {
  assert.equal(
    planWakeAction(wakeInput({ controlGate: "runtime_profile_migration", dbStatus: "active", resetMode: null })),
    "suppress-control-gate",
  );
  assert.equal(
    planWakeAction(wakeInput({ controlGate: "runtime_profile_migration", dbStatus: "inactive", resetMode: null })),
    "suppress-control-gate",
  );
});

test("planWakeAction suppresses wake while zen migrating is active", () => {
  assert.equal(
    planWakeAction(wakeInput({ controlGate: "zen_migrating", dbStatus: "active", resetMode: null })),
    "suppress-control-gate",
  );
  assert.equal(
    planWakeAction(wakeInput({ controlGate: "zen_migrating", dbStatus: "inactive", resetMode: null })),
    "suppress-control-gate",
  );
});

test("planWakeAction suppresses wake for inactive agents during reset", () => {
  assert.equal(planWakeAction(wakeInput({ dbStatus: "inactive", resetMode: "restart" })), "suppress-reset");
  assert.equal(planWakeAction(wakeInput({ dbStatus: "inactive", resetMode: "session" })), "suppress-reset");
  assert.equal(planWakeAction(wakeInput({ dbStatus: "inactive", resetMode: "full" })), "suppress-reset");
});

test("planWakeAction suppresses wake for stopped agents", () => {
  assert.equal(planWakeAction(wakeInput({ dbStatus: "stopped", resetMode: null })), "suppress-stopped");
  assert.equal(planWakeAction(wakeInput({ dbStatus: "stopped", resetMode: "restart" })), "suppress-stopped");
});

test("planWakeAction delivers directly for active agents", () => {
  assert.equal(planWakeAction(wakeInput({ dbStatus: "active", resetMode: null })), "deliver-directly");
});

test("planWakeAction attempts wake for active agents with no runtime process", () => {
  assert.equal(
    planWakeAction(wakeInput({ dbStatus: "active", resetMode: null, runtimeState: "not_running" })),
    "attempt-wake",
  );
});
