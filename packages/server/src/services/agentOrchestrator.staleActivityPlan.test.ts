import { test } from "vitest";
import assert from "node:assert/strict";

import { planStaleActivitySweepAction } from "./agentOrchestrator.js";

test("planStaleActivitySweepAction sweeps transient activity once it exceeds the stale threshold", () => {
  assert.equal(
    planStaleActivitySweepAction({
      isTransient: true,
      ageSec: 91,
      staleAfterSec: 90,
    }),
    "sweep-online",
  );
});

test("planStaleActivitySweepAction keeps transient activity before the stale threshold", () => {
  assert.equal(
    planStaleActivitySweepAction({
      isTransient: true,
      ageSec: 30,
      staleAfterSec: 90,
    }),
    "keep-current",
  );
});

test("planStaleActivitySweepAction keeps non-transient activity even if old", () => {
  assert.equal(
    planStaleActivitySweepAction({
      isTransient: false,
      ageSec: 999,
      staleAfterSec: 90,
    }),
    "keep-current",
  );
});
