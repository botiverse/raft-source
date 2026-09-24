import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveAttachmentPreviewUnified } from "./attachmentPreviewUnified.js";

// This gate is a kill switch over behaviour the chat body already shipped, so
// the load-bearing case is the one nobody creates a flag row for. The first
// version returned `evaluation.enabled` straight through, which is false with
// reason `missing_flag` on any database without the row — every fresh
// environment, including CI's e2e, silently lost document/HTML/audio/video
// previews. It reached staging because the e2e suites do not run on PRs.
//
// Mutation check: revert the body to `return evaluation.enabled` and the first
// case goes red. That is the whole point of this file.
test("a missing flag row keeps previews on", () => {
  assert.equal(
    resolveAttachmentPreviewUnified({ enabled: false, reason: "missing_flag" }),
    true,
    "an environment that never heard of this flag is exactly the environment that had previews before it existed",
  );
});

test("an existing flag that evaluates disabled turns previews off", () => {
  // The switch has to remain a real rollback, or defaulting on would make it
  // cosmetic. Both explicit disable reasons must win.
  assert.equal(resolveAttachmentPreviewUnified({ enabled: false, reason: "flag_disabled" }), false);
  assert.equal(resolveAttachmentPreviewUnified({ enabled: false, reason: "kill_switch" }), false);
});

test("an enabled flag stays on", () => {
  assert.equal(resolveAttachmentPreviewUnified({ enabled: true, reason: "default" }), true);
});

test("a disabled evaluation with no reason stays off", () => {
  // Only the named `missing_flag` reason defaults on. An unrecognised or absent
  // reason must not be treated as absence, or a future reason string would
  // silently re-enable a gate someone deliberately closed.
  assert.equal(resolveAttachmentPreviewUnified({ enabled: false }), false);
  assert.equal(resolveAttachmentPreviewUnified({ enabled: false, reason: "some_future_reason" }), false);
});
