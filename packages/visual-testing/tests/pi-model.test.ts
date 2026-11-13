import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PI_MODEL, resolvePiModel, resolveAnalysisModel } from "../src/pi-model.mjs";

test("old catalogs resolve the preview with its actual wire id without mutating M3", () => {
  for (const provider of ["minimax", "minimax-cn"]) {
    const base = { id: "MiniMax-M3", provider, api: "anthropic-messages", baseUrl: `https://${provider}.example/anthropic`, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000, reasoning: true, cost: { input: 1 }, compat: { supportsTemperature: false } };
    const models = { getModel: (p, id) => p === provider && id === "MiniMax-M3" ? base : undefined };
    const model = resolvePiModel(models, provider, DEFAULT_PI_MODEL);
    assert.equal(model.id, "MiniMax-M3.1-Flash-Preview");
    assert.equal(model.provider, provider);
    assert.equal(model.baseUrl, base.baseUrl);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.compat.forceAdaptiveThinking, true);
    assert.equal(model.compat.supportsTemperature, false);
    assert.equal(model.thinkingLevelMap.off, null);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(base.id, "MiniMax-M3");
    assert.equal(base.compat.forceAdaptiveThinking, undefined);
    assert.equal(base.cost.input, 1);
  }
});

test("catalog entries and explicit other-model overrides are preserved", () => {
  const model = { id: "custom" };
  assert.equal(resolvePiModel({ getModel: () => model }, "custom", "custom"), model);
  assert.equal(resolvePiModel({ getModel: () => model }, "minimax", DEFAULT_PI_MODEL), model);
});

test("missing templates, unknown names and other providers fail explicitly", () => {
  const empty = { getModel: () => undefined };
  for (const [provider, name] of [["minimax", DEFAULT_PI_MODEL], ["other", DEFAULT_PI_MODEL], ["minimax", "typo"]]) {
    assert.throws(() => resolvePiModel(empty, provider, name), /Unknown pi-ai model/);
  }
});

// Run against each workflow-pinned SDK using an absolute providers/all.js path.
// onPayload throws before any request is sent; no service credential is needed.
test("pinned SDK constructs preview requests without disabling thinking", { skip: !process.env.PI_MODEL_SDK_MODULE }, async () => {
  const { builtinModels } = await import(process.env.PI_MODEL_SDK_MODULE);
  const models = builtinModels();
  const model = resolvePiModel(models, "minimax", DEFAULT_PI_MODEL);
  let payload;
  const result = await models.complete(model, {
    messages: [{ role: "user", content: [{ type: "text", text: "local payload check" }], timestamp: 0 }],
  }, {
    apiKey: "local-test-placeholder", maxTokens: 2048,
    onPayload(value) { payload = value; throw new Error("LOCAL_PAYLOAD_CAPTURE_STOP"); },
  });
  assert.equal(payload.model, DEFAULT_PI_MODEL);
  assert.equal(payload.max_tokens, 2048);
  assert.notEqual(payload.thinking?.type, "disabled");
  assert.match(result.errorMessage, /LOCAL_PAYLOAD_CAPTURE_STOP/);
});

test("analysis flag beats environment; environment beats preview default", () => {
  const calls = [];
  const models = { getModel(provider, id) { calls.push([provider, id]); return { provider, id }; } };
  assert.equal(resolveAnalysisModel(models, {}, {}).id, DEFAULT_PI_MODEL);
  assert.equal(resolveAnalysisModel(models, {}, { PI_MODEL: "env-model", PI_PROVIDER: "custom" }).id, "env-model");
  assert.equal(resolveAnalysisModel(models, { model: "flag-model" }, { PI_MODEL: "env-model", PI_PROVIDER: "custom" }).id, "flag-model");
  assert.deepEqual(calls, [["minimax", DEFAULT_PI_MODEL], ["custom", "env-model"], ["custom", "flag-model"]]);
});
