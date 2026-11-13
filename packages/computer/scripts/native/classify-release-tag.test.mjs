import assert from "node:assert/strict";
import { classifyComputerReleaseTag } from "./classify-release-tag.mjs";

test("stable and rc tags classify as before", () => {
  assert.deepEqual(classifyComputerReleaseTag("computer-v1.0.33", "1.0.33"), {
    channel: "stable", version: "1.0.33", packageVersion: "1.0.33",
  });
  assert.deepEqual(classifyComputerReleaseTag("computer-v1.0.33-rc.2", "1.0.33"), {
    channel: "rc", version: "1.0.33", tagVersion: "1.0.33-rc.2", packageVersion: "1.0.33",
  });
});

// task #816 — a feature-branch channel tag carries its own channel slug and
// sequence; the binary version keeps the full suffix.
test("feature channel tags classify with the slug, sequence and full stamped version", () => {
  assert.deepEqual(classifyComputerReleaseTag("computer-v1.0.33-constructed-wake-context.1", "1.0.33"), {
    channel: "feature",
    version: "1.0.33-constructed-wake-context.1",
    baseVersion: "1.0.33",
    featureChannel: "constructed-wake-context",
    sequence: 1,
    packageVersion: "1.0.33",
  });
});

test("feature channel tags refuse reserved cohort words, bad slugs and a package mismatch", () => {
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-rc.1", "1.0.32"), /RC base version/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-stable.1", "1.0.33"), /reserved cohort word/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-main.1", "1.0.33"), /reserved cohort word/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-candidate.1", "1.0.33"), /reserved cohort word/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-Constructed.1", "1.0.33"), /Tag must match/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-constructed-wake-context.0", "1.0.33"), /Tag must match/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.33-constructed-wake-context", "1.0.33"), /Tag must match/);
  assert.throws(() => classifyComputerReleaseTag("computer-v1.0.34-constructed-wake-context.1", "1.0.33"), /Feature base version/);
});
