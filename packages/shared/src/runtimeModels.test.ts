import assert from "node:assert/strict";
import {
  allowedReasoningEffortsForModel,
  BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_BLOCKED_HOST_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDERS,
  BUILTIN_RUNTIME_CONTROLLED_ENV_KEYS,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_CONNECTION_PROBES,
  PI_BUILTIN_PROVIDER_MODELS,
  PROVIDER_CONNECTION_PROVIDER_IDS,
  getDefaultModel,
  getStaticRuntimeModelSourceSet,
  hasStaticRuntimeModelSource,
  hydrateRuntimeConfig,
  parseRuntimeConfig,
  RUNTIME_MODELS,
  runtimeChoiceModel,
  STATIC_RUNTIME_MODEL_SOURCE_IDS,
  STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION,
  runtimeConfigToLaunchFields,
  sanitizeRuntimeModelUnavailable,
} from "./index";

test("only declared closed catalogs are static model sources", () => {
  assert.deepEqual(STATIC_RUNTIME_MODEL_SOURCE_IDS, ["claude", "copilot", "gemini"]);
  for (const runtime of STATIC_RUNTIME_MODEL_SOURCE_IDS) {
    assert.equal(hasStaticRuntimeModelSource(runtime), true);
  }
  for (const runtime of ["codex", "cursor", "kimi", "kimi-sdk", "opencode", "pi", "antigravity"]) {
    assert.equal(hasStaticRuntimeModelSource(runtime), false, `${runtime} must not gain a static fallback`);
  }
});

test("declared static model sources carry their daemon verification contract", () => {
  for (const runtime of STATIC_RUNTIME_MODEL_SOURCE_IDS) {
    const source = getStaticRuntimeModelSourceSet(runtime);
    assert.ok(source, runtime);
    assert.equal(source.models.length, RUNTIME_MODELS[runtime].length, runtime);
    for (const model of source.models) {
      const declared = RUNTIME_MODELS[runtime].find((candidate) => candidate.id === model.id);
      assert.equal(
        model.verified,
        declared?.verified ?? STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION[runtime],
        `${runtime}:${model.id}`,
      );
    }
  }

  assert.equal(
    RUNTIME_MODELS.gemini.find((model) => model.id === "gemini-3.1-pro-preview")?.verified,
    undefined,
    "regression tooth must cover a Gemini catalog entry without inline verification",
  );
  assert.equal(
    getStaticRuntimeModelSourceSet("gemini")?.models.find((model) => model.id === "gemini-3.1-pro-preview")?.verified,
    "suggestion_only",
  );
  assert.equal(getStaticRuntimeModelSourceSet("opencode"), undefined);
});

test("Codex bundled fallback tracks upstream picker order and default (GPT-6.1 Sol first)", () => {
  // Upstream codex-rs/models-manager/models.json (rust-v0.162.0) priorities:
  // gpt-6.1-sol 1, gpt-6-astra 2, gpt-6-sol 3, gpt-6-luna 4, gpt-5.6-sol 5, ...
  assert.equal(getDefaultModel("codex"), "gpt-6.1-sol");
  assert.deepEqual(RUNTIME_MODELS.codex.slice(0, 7).map((model) => model.id), [
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  const byId = (id: string) => RUNTIME_MODELS.codex.find((model) => model.id === id);
  assert.deepEqual(byId("gpt-6.1-sol"), {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "low",
    verified: "launchable",
  });
  assert.deepEqual(byId("gpt-6-astra"), {
    id: "gpt-6-astra",
    label: "GPT-6-Astra",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "low",
    verified: "launchable",
  });
  assert.deepEqual(byId("gpt-6-sol")?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(byId("gpt-6-sol")?.defaultReasoningEffort, "medium");
  assert.deepEqual(byId("gpt-6-luna")?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(byId("gpt-6-luna")?.defaultReasoningEffort, "medium");
});

test("Claude model catalog includes latest aliases and selected pinned versions", () => {
  const claudeModelIds = RUNTIME_MODELS.claude.map((model) => model.id);

  assert.deepEqual(
    RUNTIME_MODELS.claude.map((model) => model.label),
    [
      "Claude Opus",
      "Claude Fable",
      "Claude Sonnet",
      "Claude Haiku",
      "Claude Opus 5.5",
      "Claude Opus 5",
      "Claude Opus 4.8",
      "Claude Opus 4.7",
      "Claude Opus 4.6",
      "Claude Fable 5.2",
      "Claude Fable 5.1",
      "Claude Fable 5",
      "Claude Sonnet 5.5",
      "Claude Sonnet 5",
      "Claude Sonnet 4.6",
      "Claude Haiku 5.5",
      "Claude Haiku 4.5",
    ],
  );
  assert.equal(getDefaultModel("claude"), "opus");

  for (const id of [
    "opus",
    "fable",
    "sonnet",
    "haiku",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-haiku-4-5",
  ]) {
    assert.ok(claudeModelIds.includes(id), `expected Claude model catalog to include ${id}`);
  }
});

test("Claude pinned model IDs are presets while unknown model names remain custom", () => {
  const pinned = runtimeConfigToLaunchFields(hydrateRuntimeConfig({
    runtime: "claude",
    model: "claude-opus-4-8",
  }));
  assert.equal(pinned.model, "claude-opus-4-8");
  assert.equal(pinned.envVars, null);

  const custom = runtimeConfigToLaunchFields(hydrateRuntimeConfig({
    runtime: "claude",
    model: "internal-gateway/claude-opus",
  }));
  assert.equal(custom.model, "internal-gateway/claude-opus");
  assert.deepEqual(custom.envVars, {
    ANTHROPIC_CUSTOM_MODEL_OPTION: "internal-gateway/claude-opus",
  });
});

test("Grok bundled catalog offers 4.6 without changing the existing default or claiming availability", () => {
  assert.deepEqual(RUNTIME_MODELS.grok, [
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      verified: "launchable",
      supportedReasoningEfforts: ["high", "medium", "low"],
      defaultReasoningEffort: "high",
    },
    { id: "grok-4.6", label: "Grok 4.6", verified: "suggestion_only" },
    {
      id: "grok-composer-2.5-fast",
      label: "Composer 2.5",
      verified: "launchable",
    },
  ]);
  assert.equal(getDefaultModel("grok"), "grok-4.5");

  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig({
    runtime: "grok",
    model: "grok-4.5",
    reasoningEffort: "low",
  }));
  assert.equal(launchFields.model, "grok-4.5");
  assert.equal(launchFields.reasoningEffort, "low");
});

test("Built-in Kimi provider defaults mirror Pi internal defaults independent of display order", () => {
  // pi 1.5.1 moved the Moonshot defaults to K2.7 Code on both sites and openrouter.
  assert.equal(PI_BUILTIN_PROVIDER_DEFAULT_MODELS.moonshotai, "moonshotai/kimi-k2.7-code");
  assert.equal(PI_BUILTIN_PROVIDER_DEFAULT_MODELS["moonshotai-cn"], "moonshotai-cn/kimi-k2.7-code");
  assert.equal(PI_BUILTIN_PROVIDER_DEFAULT_MODELS.openrouter, "openrouter/moonshotai/kimi-k2.7-code");

  // pi 1.5.0 added Kimi K3.1 Pro at the head of both Moonshot providers; the default stays K2.6.
  assert.equal(PI_BUILTIN_PROVIDER_MODELS.moonshotai[0]?.id, "moonshotai/kimi-k3.1-pro");
  assert.equal(PI_BUILTIN_PROVIDER_MODELS["moonshotai-cn"][0]?.id, "moonshotai-cn/kimi-k3.1-pro");
  assert.notEqual(PI_BUILTIN_PROVIDER_MODELS.moonshotai[0]?.id, PI_BUILTIN_PROVIDER_DEFAULT_MODELS.moonshotai);
});

test("Built-in Xiaomi MiMo provider is generated from the Pi model catalog", () => {
  const xiaomiModels = PI_BUILTIN_PROVIDER_MODELS.xiaomi;

  // pi 1.4.0 made MiMo-V2.6-Pro the provider default when the V2.5 ids left the catalog
  // (1.3.0 and earlier listed V2.6 first but kept V2.5-Pro as the default).
  assert.equal(PI_BUILTIN_PROVIDER_DEFAULT_MODELS.xiaomi, "xiaomi/mimo-v2.6-pro");
  assert.equal(xiaomiModels[0]?.id, "xiaomi/mimo-v2.6-pro");
  assert.equal(xiaomiModels[0]?.label, "MiMo-V2.6-Pro");
  assert.ok(xiaomiModels.some((model) => model.id === PI_BUILTIN_PROVIDER_DEFAULT_MODELS.xiaomi));
  assert.ok(xiaomiModels.some((model) => model.id === "xiaomi/mimo-v2.6-pro-ultraspeed"));
});

test("Built-in provider env keys are generated for every surfaced Pi provider", () => {
  const providerIds = BUILTIN_RUNTIME_PROVIDERS.map((provider) => provider.id).sort();
  assert.deepEqual(providerIds, Object.keys(PI_BUILTIN_PROVIDER_MODELS).sort());
  assert.deepEqual(providerIds, Object.keys(PI_BUILTIN_PROVIDER_DEFAULT_MODELS).sort());
  assert.deepEqual(providerIds, Object.keys(PI_BUILTIN_PROVIDER_CONNECTION_PROBES).sort());
  assert.deepEqual(Object.keys(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS).sort(), providerIds);

  for (const providerId of providerIds) {
    const envKey = BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerId];
    assert.match(envKey, /^[A-Z0-9_]+_API_KEY$/);
    assert.ok(BUILTIN_RUNTIME_CONTROLLED_ENV_KEYS.includes(envKey), `${envKey} must be controlled`);
    assert.ok(BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS.includes(envKey), `${envKey} must be scrubbed from host env`);
  }

  assert.ok(BUILTIN_RUNTIME_PROVIDER_BLOCKED_HOST_ENV_KEYS.includes("ANTHROPIC_OAUTH_TOKEN"));
});

test("Provider Connections accepts exactly the builtin Pi schema provider catalog", () => {
  assert.deepEqual(
    [...PROVIDER_CONNECTION_PROVIDER_IDS].sort(),
    [
      ...Object.keys(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS),
      ...Object.keys(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS),
    ].sort(),
  );
  for (const [providerId, probe] of Object.entries(PI_BUILTIN_PROVIDER_CONNECTION_PROBES)) {
    assert.ok(
      ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"].includes(probe.api),
      `${providerId} must use a connection-test protocol implemented by Provider Connections`,
    );
    assert.match(probe.baseUrl, /^https:\/\//u);
  }
});

test("runtime-reported unavailable models are validated, de-duplicated and length-capped", () => {
  assert.equal(sanitizeRuntimeModelUnavailable(undefined), undefined);
  assert.equal(sanitizeRuntimeModelUnavailable([{ id: "" }, null, "x"]), undefined);
  const entries = sanitizeRuntimeModelUnavailable([
    { id: "m", label: "  Model\n M ", reason: ` why ${"x".repeat(500)}` },
    { id: "m", label: "dup", reason: "dup" },
    { id: "n", reason: 7 },
  ])!;
  assert.deepEqual(entries.map((entry) => [entry.id, entry.label]), [["m", "Model M"], ["n", "n"]]);
  assert.ok(entries[0]!.reason.startsWith("why x") && entries[0]!.reason.length <= 200);
  assert.equal(entries[1]!.reason, "");
  assert.equal(sanitizeRuntimeModelUnavailable(Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, label: "", reason: "" })))!.length, 50);
});

test("Antigravity's configured default allows no effort; a model only the Computer lists is left to its live list", () => {
  assert.deepEqual(allowedReasoningEffortsForModel("antigravity", "default"), []);
  assert.ok(allowedReasoningEffortsForModel("antigravity", "gemini-3.8-flash").includes("high"));
  assert.ok(allowedReasoningEffortsForModel("claude", "claude-unlisted").includes("high"), "other runtimes keep the base set");
  assert.equal(runtimeChoiceModel("antigravity")?.id, "default");
  assert.equal(runtimeChoiceModel("claude"), undefined);
  const parsed = parseRuntimeConfig({
    runtimeConfig: { version: 1, runtime: "antigravity", model: { kind: "preset", id: "default" }, mode: { kind: "default" }, reasoningEffort: "high", envVars: null },
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.config.reasoningEffort, null, "an effort sent with agy's default is dropped");
});
