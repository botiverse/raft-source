import assert from "node:assert/strict";
import { test } from "vitest";
import { assistantWithoutRuntimeForPreview } from "./assistantService";

// A raftdev preview's seeded assistant shows without a hosted runtime (#proj-assistant:#24); a deployment never.
test("only a raftdev preview's switch, never in a deployment", () => {
  assert.equal(assistantWithoutRuntimeForPreview({ RAFTDEV_ASSISTANT_WITHOUT_RUNTIME: "1" }), true);
  // The server raftdev starts runs with DEPLOYMENT_ENV=slockdev (scripts/dev/raftdev.ts).
  assert.equal(assistantWithoutRuntimeForPreview({ RAFTDEV_ASSISTANT_WITHOUT_RUNTIME: "1", DEPLOYMENT_ENV: "slockdev" }), true);
  assert.equal(assistantWithoutRuntimeForPreview({ DEPLOYMENT_ENV: "slockdev" }), false, "opt-in only");
  assert.equal(assistantWithoutRuntimeForPreview({}), false);
  assert.equal(assistantWithoutRuntimeForPreview({ RAFTDEV_ASSISTANT_WITHOUT_RUNTIME: "true" }), false, "only the exact value");
  for (const deploymentEnv of ["staging", "production", "anything"]) {
    assert.equal(assistantWithoutRuntimeForPreview({ RAFTDEV_ASSISTANT_WITHOUT_RUNTIME: "1", DEPLOYMENT_ENV: deploymentEnv }), false, deploymentEnv);
  }
});
