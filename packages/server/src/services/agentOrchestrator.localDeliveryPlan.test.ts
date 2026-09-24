import { test } from "vitest";
import assert from "node:assert/strict";

import { planLocalDeliveryGateAction } from "./agentOrchestrator.js";

test("planLocalDeliveryGateAction drops when the agent is missing", () => {
  assert.equal(
    planLocalDeliveryGateAction({
      hasAgent: false,
      status: null,
      machineMatches: false,
    }),
    "drop-delivery",
  );
});

test("planLocalDeliveryGateAction delivers when the agent is active on the expected machine", () => {
  assert.equal(
    planLocalDeliveryGateAction({
      hasAgent: true,
      status: "active",
      machineMatches: true,
    }),
    "deliver-locally",
  );
});

test("planLocalDeliveryGateAction drops when the agent is inactive", () => {
  assert.equal(
    planLocalDeliveryGateAction({
      hasAgent: true,
      status: "inactive",
      machineMatches: true,
    }),
    "drop-delivery",
  );
});

test("planLocalDeliveryGateAction drops when the machine no longer matches", () => {
  assert.equal(
    planLocalDeliveryGateAction({
      hasAgent: true,
      status: "active",
      machineMatches: false,
    }),
    "drop-delivery",
  );
});
