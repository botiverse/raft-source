import assert from "node:assert/strict";
import {
  clampComputerUpgradeDrain,
  COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS,
  parseComputerUpgradeDrainRequestFile,
  parseComputerUpgradeDrainStateFile,
} from "./computerUpgradeDrain";

test("a drain is clamped to 10 minutes; nonsense is no drain", () => {
  assert.equal(COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS, 600_000);
  assert.deepEqual(clampComputerUpgradeDrain({ deadlineMs: 3_600_000 }), { deadlineMs: 600_000 });
  assert.deepEqual(clampComputerUpgradeDrain({ deadlineMs: 30_000.7 }), { deadlineMs: 30_000 });
  for (const bad of [undefined, null, 5, {}, { deadlineMs: 0 }, { deadlineMs: -1 }, { deadlineMs: Number.NaN }, { deadlineMs: "60000" }, { deadlineMs: Number.POSITIVE_INFINITY }]) {
    assert.equal(clampComputerUpgradeDrain(bad), null, JSON.stringify(bad));
  }
});

test("drain files: only the version-1 shape is read; unknown keys are ignored", () => {
  const request = { formatVersion: 1, requestId: "r", origin: true, deadlineAtMs: 5, servicePid: 7 };
  assert.deepEqual(parseComputerUpgradeDrainRequestFile({ ...request, extra: 1 }), request);
  assert.equal(parseComputerUpgradeDrainRequestFile({ ...request, formatVersion: 2 }), null);
  assert.equal(parseComputerUpgradeDrainRequestFile({ ...request, servicePid: 0 }), null);
  assert.equal(parseComputerUpgradeDrainRequestFile({ ...request, origin: "yes" }), null);
  const state = { formatVersion: 1, requestId: "r", pid: 9, live: 2, notQuietAgentIds: ["a"], updatedAtMs: 1 };
  assert.deepEqual(parseComputerUpgradeDrainStateFile(state), state);
  assert.deepEqual(parseComputerUpgradeDrainStateFile({ ...state, finished: "quiet" }), { ...state, finished: "quiet" });
  assert.equal(parseComputerUpgradeDrainStateFile({ ...state, finished: "done" }), null);
  assert.equal(parseComputerUpgradeDrainStateFile({ ...state, notQuietAgentIds: [1] }), null);
});
