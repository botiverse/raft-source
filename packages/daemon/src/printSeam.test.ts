import assert from "node:assert/strict";
import { join } from "node:path";

import * as runtimeInput from "./agentRuntimeInput";
import type { RuntimeDriver } from "./drivers/types";

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
