import assert from "node:assert/strict";
import { test } from "vitest";

import { supportsLaunchGuardForDaemonVersion } from "./agentOrchestrator.js";

test("supportsLaunchGuardForDaemonVersion rejects null, malformed, and pre-0.30.1 versions", () => {
  for (const version of [null, "", "main", "0.27.1-alpha.0", "0.28.0", "0.29.1-alpha.0", "0.30.0"]) {
    assert.equal(
      supportsLaunchGuardForDaemonVersion(version),
      false,
      `${String(version)} should not enable launch guard`,
    );
  }
});

test("supportsLaunchGuardForDaemonVersion accepts 0.30.1+ including prereleases and major versions", () => {
  for (const version of ["0.30.1", "0.30.1-alpha.1", "0.31.0", "1.0.0"]) {
    assert.equal(
      supportsLaunchGuardForDaemonVersion(version),
      true,
      `${version} should enable launch guard`,
    );
  }
});
