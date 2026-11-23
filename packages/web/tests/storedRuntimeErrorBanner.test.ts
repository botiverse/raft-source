import assert from "node:assert/strict";
import { storedRuntimeErrorBannerShown } from "../src/utils/activity";

// A failed start stored as the agent's runtime error (spawnFailureReason) has
// one presentation: the status badge's typed start-failure copy. The panel's
// runtime error banner adds only the start's own text, for its managers.
const frameCopy = "Runtime failed to start. Check the Computer logs for details and retry.";

test("a member gets no runtime error banner for a stored failed start", () => {
  // The server sends a member the generic sentence in place of the text.
  const memberView = { message: "Agent encountered an error", spawnFailureReason: "runtime_spawn_failed" as const };
  assert.equal(storedRuntimeErrorBannerShown({ lastRuntimeError: memberView, activityDetail: frameCopy, canViewDetails: false }), false);
});

test("a manager gets the start's own text once, and no banner when the record only repeats the badge's copy", () => {
  const own = { message: "spawn codex ENOENT", spawnFailureReason: "runtime_not_found" as const };
  assert.equal(storedRuntimeErrorBannerShown({ lastRuntimeError: own, activityDetail: frameCopy, canViewDetails: true }), true);
  // An older daemon: the record's text is the frame's copy the badge already shows.
  const older = { message: frameCopy, spawnFailureReason: "runtime_spawn_failed" as const };
  assert.equal(storedRuntimeErrorBannerShown({ lastRuntimeError: older, activityDetail: frameCopy, canViewDetails: true }), false);
  assert.equal(storedRuntimeErrorBannerShown({ lastRuntimeError: { ...own, message: "  " }, activityDetail: frameCopy, canViewDetails: true }), false);
});

test("any other stored runtime error keeps its banner for every viewer", () => {
  for (const canViewDetails of [true, false]) {
    assert.equal(storedRuntimeErrorBannerShown({ lastRuntimeError: { message: "Codex exited unexpectedly" }, activityDetail: "", canViewDetails }), true);
  }
  assert.equal(storedRuntimeErrorBannerShown({ lastRuntimeError: null, activityDetail: "", canViewDetails: true }), false);
});
