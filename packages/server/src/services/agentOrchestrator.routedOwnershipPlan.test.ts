import { test } from "vitest";
import assert from "node:assert/strict";

import { planRoutedOwnershipAction } from "./agentOrchestrator.js";

test("planRoutedOwnershipAction handles locally when the machine is local", () => {
  assert.equal(
    planRoutedOwnershipAction({
      machineIsLocal: true,
      canReroute: true,
    }),
    "handle-locally",
  );
});

test("planRoutedOwnershipAction reroutes then falls back for remote ownership when reroute is available", () => {
  assert.equal(
    planRoutedOwnershipAction({
      machineIsLocal: false,
      canReroute: true,
    }),
    "reroute-then-fallback",
  );
});

test("planRoutedOwnershipAction falls back directly when reroute is unavailable", () => {
  assert.equal(
    planRoutedOwnershipAction({
      machineIsLocal: false,
      canReroute: false,
    }),
    "fallback",
  );
});
