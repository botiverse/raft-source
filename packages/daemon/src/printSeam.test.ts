import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { test } from "vitest";

import * as runtimeInput from "./agentRuntimeInput.js";
import type { RuntimeDriver } from "./drivers/types.js";

// Structural seam checks. Runtime-input copy snapshots live in agentRuntimeInput.snapshot.test.ts.

const stdinDriver = {
  supportsStdinNotification: true,
  busyDeliveryMode: "direct",
} as unknown as RuntimeDriver;
test("composeAxSurfaces concatenates parts without separators", () => {
  const parts = [
    runtimeInput.formatResumeEmptyPrompt(stdinDriver),
    runtimeInput.formatOtherUnreadChannelsSuffix({ "#general": 2 }),
  ];
  assert.equal(runtimeInput.composeAxSurfaces(...parts), parts.join(""));
  assert.equal(runtimeInput.composeAxSurfaces(), "");
});

test("adoptAxSurfaceText escape hatch has exactly one call site in agentProcessManager", () => {
  // The branded seam is only as strong as this pin: adoptAxSurfaceText lets a
  // raw string into a runtime turn, and its single legitimate use is the
  // persisted resume prompt re-entering a turn (the standing prompt is branded
  // end-to-end since print-seam S3). A second call site means an unregistered
  // surface is being injected — register a formatter instead of widening this
  // count.
  const apmSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "agentProcessManager.ts"),
    "utf8",
  );
  const callSites = apmSource.match(/adoptAxSurfaceText\(/g) ?? [];
  assert.equal(callSites.length, 1, `expected exactly 1 adoptAxSurfaceText call site, found ${callSites.length}`);
});
