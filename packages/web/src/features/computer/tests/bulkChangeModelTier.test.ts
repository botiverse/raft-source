import assert from "node:assert/strict";
import type { RuntimeConfig } from "@botiverse/raft-shared";

import { buildBulkAgentUpdate } from "../../../components/machine/bulkChangeModelPlan";

// #wg-runtime-form:#27: a Codex speed tier is per model.
const agent = (mode: RuntimeConfig["mode"]) => ({
  id: "agent-1",
  runtime: "codex",
  model: "gpt-6.2-astra",
  reasoningEffort: "medium" as const,
  running: false,
  runtimeConfig: {
    version: 1,
    runtime: "codex",
    model: { kind: "preset", id: "gpt-6.2-astra" },
    mode,
    reasoningEffort: "medium",
    envVars: null,
  } as RuntimeConfig,
});

test("an effort-only bulk change keeps the saved Codex speed tier", () => {
  const update = buildBulkAgentUpdate(agent({ kind: "fast", serviceTier: "ultrafast" }), { runtime: "codex", model: "gpt-6.2-astra", reasoningEffort: "high" });
  assert.deepEqual(update.runtimeConfig.mode, { kind: "fast", serviceTier: "ultrafast" });
});

test("a bulk change to another model keeps fast mode but not the tier", () => {
  const update = buildBulkAgentUpdate(agent({ kind: "fast", serviceTier: "ultrafast" }), { runtime: "codex", model: "gpt-6.2-sol", reasoningEffort: null });
  assert.deepEqual(update.runtimeConfig.mode, { kind: "fast" });
});
