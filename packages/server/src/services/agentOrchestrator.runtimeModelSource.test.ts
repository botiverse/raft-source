import assert from "node:assert/strict";
import { test } from "vitest";
import {
  RUNTIME_MODELS,
  STATIC_RUNTIME_MODEL_SOURCE_IDS,
  STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION,
} from "@botiverse/raft-shared";
import { projectRuntimeModelSourceResult } from "./agentOrchestrator.js";

test("new typed daemon outcome wins over rollout compatibility fields", () => {
  assert.deepEqual(projectRuntimeModelSourceResult({
    type: "machine:runtime_models:result",
    requestId: "typed",
    outcome: { kind: "missing_config", recovery: "kimi_login" },
    models: [{ id: "legacy-fake", label: "Legacy fake" }],
  }, "kimi-sdk"), { kind: "missing_config", recovery: "kimi_login" });
  assert.deepEqual(
    projectRuntimeModelSourceResult({
      type: "machine:runtime_models:result",
      requestId: "typed-static",
      outcome: { kind: "unsupported" },
      error: "unsupported",
    }, "claude"),
    { kind: "unsupported" },
  );
});

test("new daemon catalog provenance remains additive to old compatibility fields", () => {
  const message = {
    type: "machine:runtime_models:result" as const,
    requestId: "builtin-catalog",
    outcome: {
      kind: "live" as const,
      value: {
        models: [{ id: "openrouter/model-a", label: "Model A" }],
        catalog: {
          protocolVersion: 1 as const,
          runtime: "builtin" as const,
          runtimeVersion: "0.84.3",
        },
      },
    },
    models: [{ id: "openrouter/model-a", label: "Model A" }],
  };
  assert.deepEqual(
    projectRuntimeModelSourceResult(message, "builtin"),
    message.outcome,
  );
  const oldServerView = { models: message.models };
  assert.deepEqual(
    oldServerView,
    {
      models: [{ id: "openrouter/model-a", label: "Model A" }],
    },
    "an old Server can ignore the unknown outcome catalog and keep reading legacy fields",
  );
});

test("old daemon result carriers project into the closed outcome set", () => {
  assert.deepEqual(projectRuntimeModelSourceResult({
    type: "machine:runtime_models:result",
    requestId: "legacy-live",
    models: [{ id: "machine-model", label: "Machine model" }],
    default: "machine-model",
  }, "codex"), {
    kind: "live",
    value: { models: [{ id: "machine-model", label: "Machine model" }], default: "machine-model" },
  });
  assert.deepEqual(projectRuntimeModelSourceResult({
    type: "machine:runtime_models:result",
    requestId: "legacy-empty",
    models: [],
  }, "codex"), { kind: "no_models" });
  assert.deepEqual(projectRuntimeModelSourceResult({
    type: "machine:runtime_models:result",
    requestId: "legacy-unsupported",
    error: "unsupported",
  }, "opencode"), { kind: "unsupported" });
  assert.deepEqual(projectRuntimeModelSourceResult({
    type: "machine:runtime_models:result",
    requestId: "legacy-error",
    error: "free-form read failure",
  }, "opencode"), { kind: "error", retryable: true });
});

test("old daemon unsupported maps to live only for declared closed static sources", () => {
  const legacyUnsupported = {
    type: "machine:runtime_models:result",
    requestId: "legacy-static",
    error: "unsupported",
  } as const;

  for (const runtime of STATIC_RUNTIME_MODEL_SOURCE_IDS) {
    const projected = projectRuntimeModelSourceResult(legacyUnsupported, runtime);
    assert.equal(projected.kind, "live", runtime);
    if (projected.kind !== "live") assert.fail(`${runtime} must use its declared static source`);
    assert.equal(projected.value.models.length, RUNTIME_MODELS[runtime].length, runtime);
    for (const model of projected.value.models) {
      const declared = RUNTIME_MODELS[runtime].find((candidate) => candidate.id === model.id);
      assert.equal(
        model.verified,
        declared?.verified ?? STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION[runtime],
        `${runtime}:${model.id}`,
      );
    }
  }

  const rawGeminiModel = RUNTIME_MODELS.gemini.find((model) => model.id === "gemini-3.1-pro-preview");
  assert.equal(rawGeminiModel?.verified, undefined);
  const projectedGemini = projectRuntimeModelSourceResult(legacyUnsupported, "gemini");
  assert.equal(projectedGemini.kind, "live");
  if (projectedGemini.kind !== "live") assert.fail("Gemini must use its declared static source");
  assert.equal(
    projectedGemini.value.models.find((model) => model.id === rawGeminiModel?.id)?.verified,
    "suggestion_only",
  );

  assert.deepEqual(
    projectRuntimeModelSourceResult(legacyUnsupported, "antigravity"),
    { kind: "unsupported" },
  );
});
