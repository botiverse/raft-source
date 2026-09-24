import assert from "node:assert/strict";
import { test } from "vitest";

import { planStopAction } from "./agentOrchestrator.js";

test("planStopAction persists stopped for a manual stop", () => {
  assert.equal(planStopAction({ reason: "manual" }), "persist-stopped");
});

test("planStopAction persists inactive for an internal stop", () => {
  assert.equal(planStopAction({ reason: "internal" }), "persist-inactive");
});
