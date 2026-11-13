import assert from "node:assert/strict";

import { normalizeToolStuckActivityDiagnostic } from "./toolStuckActivityDiagnostic";

const valid = {
  toolName: "bash",
  toolDetailKind: "running_command",
  startedAtMs: 1_000,
  quietSinceMs: 2_000,
  thresholdMs: 600_000,
  queuedMessages: 3,
};

test("a well-formed carrier passes through with only its known fields", () => {
  assert.deepEqual(normalizeToolStuckActivityDiagnostic({ ...valid, command: "pnpm dev", output: "secret" }), valid);
});

test("malformed carriers are dropped, not echoed", () => {
  for (const bad of [
    null,
    [],
    "bash",
    { ...valid, toolName: "" },
    { ...valid, toolName: "x".repeat(129) },
    { ...valid, toolDetailKind: "not_a_kind" },
    { ...valid, startedAtMs: -1 },
    { ...valid, quietSinceMs: Number.NaN },
    { ...valid, quietSinceMs: 500 },
    { ...valid, thresholdMs: "600000" },
    { ...valid, queuedMessages: 1.5 },
    { ...valid, queuedMessages: 2_000_000 },
  ]) {
    assert.equal(normalizeToolStuckActivityDiagnostic(bad as never), null, JSON.stringify(bad));
  }
});
