import assert from "node:assert/strict";
import { barrierIntervalToRestore, DEFAULT_BARRIER_INTERVAL_MS } from "./risingwave-bootstrap-barrier";

test("a bootstrap restores the interval it found, unless it was a leftover from a killed bootstrap", () => {
  assert.equal(barrierIntervalToRestore(1000), 1000);
  assert.equal(barrierIntervalToRestore(250), 250);
  // A killed bootstrap left 100 (or less) behind: the next one restores the default.
  assert.equal(barrierIntervalToRestore(100), DEFAULT_BARRIER_INTERVAL_MS);
  assert.equal(barrierIntervalToRestore(50), DEFAULT_BARRIER_INTERVAL_MS);
  // Unreadable: restore the default rather than leaving the shortened value.
  assert.equal(barrierIntervalToRestore(null), DEFAULT_BARRIER_INTERVAL_MS);
});
