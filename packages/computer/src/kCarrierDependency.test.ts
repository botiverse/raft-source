// @invariant — Computer's installed K graph must be the exact carrier release
// that exposes the bounded, size-derived artifact-transfer policy. Package
// metadata alone is not proof that the runtime resolver loaded those bytes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "vitest";

import {
  artifactTransferTimeouts,
  DEFAULT_ARTIFACT_TRANSFER_POLICY,
} from "@botiverse/k-carrier";

const EXPECTED_K_CARRIER_VERSION = "0.1.8";

test("Computer resolves the bounded-transfer k-carrier release from its installed graph", async () => {
  const computerPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(
    computerPackage.dependencies?.["@botiverse/k-carrier"],
    EXPECTED_K_CARRIER_VERSION,
    "Computer must pin the reviewed K carrier release exactly",
  );

  const carrierEntry = createRequire(import.meta.url).resolve("@botiverse/k-carrier");
  const carrierPackage = JSON.parse(
    await readFile(resolve(dirname(carrierEntry), "../..", "package.json"), "utf8"),
  ) as { version?: string };
  assert.equal(
    carrierPackage.version,
    EXPECTED_K_CARRIER_VERSION,
    "the installed K graph must resolve to the pinned carrier release",
  );

  assert.deepEqual(
    artifactTransferTimeouts(2 * 1024 * 1024),
    {
      responseTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
      overallTimeoutMs: 62_000,
    },
    "the resolved carrier must derive a bounded total budget from exact artifact size",
  );
  assert.equal(DEFAULT_ARTIFACT_TRANSFER_POLICY.maximumOverallTimeoutMs, 30 * 60_000);
});
