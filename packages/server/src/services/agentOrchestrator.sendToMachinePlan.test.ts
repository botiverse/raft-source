import { test } from "vitest";
import assert from "node:assert/strict";

import { planSendToMachineAction } from "./agentOrchestrator.js";

test("planSendToMachineAction sends locally when a ready local connection exists", () => {
  assert.equal(
    planSendToMachineAction({
      hasReadyLocalConnection: true,
      canReroute: true,
    }),
    "send-locally",
  );
});

test("planSendToMachineAction reroutes then warns when no ready local connection exists but reroute is available", () => {
  assert.equal(
    planSendToMachineAction({
      hasReadyLocalConnection: false,
      canReroute: true,
    }),
    "reroute-then-warn",
  );
});

test("planSendToMachineAction warns offline when neither local delivery nor reroute is available", () => {
  assert.equal(
    planSendToMachineAction({
      hasReadyLocalConnection: false,
      canReroute: false,
    }),
    "warn-offline",
  );
});
