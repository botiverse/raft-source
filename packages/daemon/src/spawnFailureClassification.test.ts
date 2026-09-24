import assert from "node:assert/strict";
import { test } from "vitest";
import { classifySpawnFailure } from "./spawnFailureClassification.js";
import { RuntimeVersionTooOldError } from "./runtimeLaunchVersion.js";

test("classifySpawnFailure identifies a known-incompatible runtime CLI version", () => {
  const error = new RuntimeVersionTooOldError({
    runtimeId: "claude",
    displayName: "Claude Code",
    actualVersion: "2.1.59",
    testedGoodVersion: "2.1.220",
  });
  const result = classifySpawnFailure(error);
  assert.equal(result.reason, "runtime_version_too_old");
  assert.equal(result.userMessage, error.message);
});
