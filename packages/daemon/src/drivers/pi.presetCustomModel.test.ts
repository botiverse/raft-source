// task #10 (#wg-runtime-form): a Built-in agent on a preset provider (OpenRouter,
// Qwen Token Plan, ...) may run a typed model id that is not in Pi's catalog.
// The launch registers it under exactly that provider, on the transport its
// catalog shares, with nothing guessed from a sibling model (OpenRouter: the
// same model as before that rule), and
// never resolves the name to another provider's model.
import assert from "node:assert/strict";
import {
  BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS,
  builtInPresetTypedModelReasons,
  parseRuntimeConfig,
  RUNTIME_CONFIG_VERSION,
  type RuntimeConfig,
} from "@botiverse/raft-shared";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  configureBuiltInPresetCustomModel,
  BuiltInDriver,
  resolveBuiltInPresetCustomModel,
  resolvePiModelFromRegistry,
} from "./pi";

async function freshRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  return new ModelRegistry(runtime);
}

function presetConfig(providerId: string, name: string, limits: { contextWindow?: number; maxOutputTokens?: number } = {}): RuntimeConfig {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "preset", providerId, apiKey: "sk-test" },
    hostUserState: "forbidden",
    model: { kind: "custom", name, ...limits },
    mode: { kind: "default" },
  } as RuntimeConfig;
}

test("an OpenRouter id outside the catalog registers exactly as before the shared-transport rule, on every field", async () => {
  const registry = await freshRegistry();
  // What every unlisted OpenRouter id has registered since task #10: agents
  // already running one must keep the same model.
  const template = registry.getAll().find((model) => model.provider === "openrouter");
  assert.ok(template, "the Pi catalog has OpenRouter models");
  assert.equal(template.api, "anthropic-messages", "Pi 1.5.2: OpenRouter's first catalog entry is on its Anthropic endpoint");
  assert.equal(template.baseUrl, "https://openrouter.ai/api");
  const name = "raft-test-vendor/unlisted-model-2099";
  const config = presetConfig("openrouter", name);
  assert.equal(resolvePiModelFromRegistry(name, registry, config, null), undefined, "not resolvable before registration");

  const { modelLimits } = configureBuiltInPresetCustomModel(registry, config);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
  // The model the same registration built before (staging's
  // configureBuiltInPresetCustomModel), registered the same way.
  const before = await freshRegistry();
  before.registerProvider("openrouter", {
    name: "OpenRouter",
    baseUrl: template.baseUrl,
    apiKey: "$OPENROUTER_API_KEY",
    api: template.api,
    ...(template.headers ? { headers: template.headers } : {}),
    models: [{
      id: name,
      name,
      reasoning: true,
      thinkingLevelMap: undefined,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
      ...(template.compat ? { compat: template.compat } : {}),
    }],
  });
  const model = resolvePiModelFromRegistry(name, registry, config, null);
  assert.ok(model);
  assert.deepEqual(model, before.find("openrouter", name));
  assert.equal(model.reasoning, true);
  assert.equal(model.api, "anthropic-messages");
});

test("declared limits win, and an id the catalog lists keeps its catalog metadata", async () => {
  const registry = await freshRegistry();
  const listed = registry.getAll().find((model) => model.provider === "openrouter" && model.id.includes("/"));
  assert.ok(listed);
  const declared = configureBuiltInPresetCustomModel(registry, presetConfig("openrouter", listed.id, { contextWindow: 64_000 }));
  assert.deepEqual(declared.modelLimits?.contextWindow, { value: 64_000, source: "agent_config" });
  assert.deepEqual(declared.modelLimits?.maxTokens, { value: listed.maxTokens, source: "catalog" });
  const model = resolvePiModelFromRegistry(listed.id, registry, presetConfig("openrouter", listed.id), null);
  assert.equal(model?.name, listed.name);
  assert.equal(model?.reasoning, listed.reasoning);
});

test("a typed name never resolves to another provider's model of the same name", async () => {
  const registry = await freshRegistry();
  // An id that exists under a different provider: a "provider/model" split
  // must not pick it up for an OpenRouter agent.
  const other = registry.getAll().find((model) => model.provider !== "openrouter");
  assert.ok(other);
  const name = `${other.provider}/${other.id}`;
  const config = presetConfig("openrouter", name);
  assert.equal(resolvePiModelFromRegistry(name, registry, config, null), undefined);
});

test("a preset provider takes a typed model; a saved connection only with its launch projection", () => {
  const resolved = resolveBuiltInPresetCustomModel(presetConfig("openrouter", "a/b"));
  assert.equal(resolved?.providerId, "openrouter");
  assert.equal(resolved?.modelId, "a/b");
  assert.equal(resolveBuiltInPresetCustomModel(presetConfig("qwen-token-plan", "qwen4-preview"))?.modelId, "qwen4-preview");
  assert.equal(resolveBuiltInPresetCustomModel({
    ...presetConfig("openrouter", "a/b"),
    provider: { kind: "connection", connectionId: "c1" },
  } as RuntimeConfig), null, "without the connection's launch projection");
});

test("the Built-in catalog advertises the preset providers that accept a typed model", async () => {
  const outcome = await new BuiltInDriver().detectModels();
  assert.equal(outcome.kind, "live");
  const reported = outcome.kind === "live" ? outcome.value.catalog?.customModelProviderIds : undefined;
  for (const providerId of ["openrouter", "qwen-token-plan", "qwen-token-plan-cn", "deepseek"]) {
    assert.ok(reported?.includes(providerId), providerId);
  }
  assert.deepEqual(reported, [...BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS]);
  // ...and runs them through a saved connection to those providers too.
  assert.deepEqual(outcome.kind === "live" ? outcome.value.catalog?.customModelConnectionProviderIds : undefined, reported);
});

function qwenConfig(providerId: "qwen-token-plan" | "qwen-token-plan-cn", name: string, limits: { contextWindow?: number; maxOutputTokens?: number } = {}): RuntimeConfig {
  const parsed = parseRuntimeConfig({
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId, apiKey: "sk-qwen-test" },
      model: { kind: "custom", name, ...limits },
      mode: { kind: "default" },
    },
  });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.config;
}

test("a typed Qwen Token Plan id (bare or Raft's form) runs as the bare id on the provider's transport, with nothing guessed from a sibling", async () => {
  for (const [providerId, baseUrl] of [
    ["qwen-token-plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"],
    ["qwen-token-plan-cn", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"],
  ] as const) {
    for (const typed of ["qwen4-preview", `${providerId}/qwen4-preview`]) {
      const config = qwenConfig(providerId, typed);
      assert.deepEqual(config.model, { kind: "custom", name: "qwen4-preview" }, `${typed}: the stored name is the API id`);
      const registry = await freshRegistry();
      const siblings = registry.getAll().filter((model) => model.provider === providerId);
      assert.ok(siblings.length > 1);
      assert.ok(siblings.every((model) => model.api === "openai-completions" && model.baseUrl === baseUrl), "one transport for the whole catalog");
      assert.equal(resolvePiModelFromRegistry("qwen4-preview", registry, config, null), undefined, "not resolvable before registration");

      const { modelLimits } = configureBuiltInPresetCustomModel(registry, config);
      // Raft's defaults (which the default-limits note names), never a sibling's 1M context.
      assert.deepEqual(modelLimits, {
        contextWindow: { value: 200_000, source: "raft_default" },
        maxTokens: { value: 8192, source: "raft_default" },
      });
      const model = resolvePiModelFromRegistry("qwen4-preview", registry, config, null);
      assert.ok(model, `${providerId}: ${typed}`);
      assert.equal(model.provider, providerId);
      assert.equal(model.id, "qwen4-preview", "the provider gets its own id, never Raft's namespace");
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, baseUrl);
      assert.equal(model.reasoning, true, "every Qwen Token Plan catalog model reasons");
      assert.deepEqual(model.input, ["text"], "no image input from a sibling");
      assert.equal(model.thinkingLevelMap, undefined, "no sibling's thinking levels");
      assert.equal(model.contextWindow, 200_000);
      assert.equal(model.maxTokens, 8192);
      // Only what every catalog model on that transport shares: the Qwen
      // thinking format, not one model's reasoning-effort support.
      const compat = model.compat as Record<string, unknown> | undefined;
      assert.equal(compat?.thinkingFormat, "qwen");
      assert.equal(compat?.supportsDeveloperRole, false);
      assert.equal("supportsReasoningEffort" in (compat ?? {}), false);
    }
  }
});

test("reasoning for a typed id: on where every catalog model reasons (with their shared reasoning compat), off where not", async () => {
  // DeepSeek: every model reasons and requires reasoning content on assistant messages.
  const deepseekRegistry = await freshRegistry();
  assert.ok(deepseekRegistry.getAll().filter((model) => model.provider === "deepseek").every((model) => model.reasoning));
  const deepseek = presetConfig("deepseek", "deepseek-v9");
  configureBuiltInPresetCustomModel(deepseekRegistry, deepseek);
  const deepseekModel = resolvePiModelFromRegistry("deepseek-v9", deepseekRegistry, deepseek, null);
  assert.equal(deepseekModel?.reasoning, true);
  const deepseekCompat = deepseekModel?.compat as Record<string, unknown> | undefined;
  assert.equal(deepseekCompat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(deepseekCompat?.thinkingFormat, "deepseek");
  assert.equal(deepseekModel?.thinkingLevelMap, undefined);

  // OpenAI: its catalog has models without reasoning, so a typed id has none.
  const openaiRegistry = await freshRegistry();
  assert.ok(openaiRegistry.getAll().some((model) => model.provider === "openai" && !model.reasoning));
  assert.equal(builtInPresetTypedModelReasons("openai"), false);
  const openai = presetConfig("openai", "gpt-raft-test-2099");
  const { modelLimits } = configureBuiltInPresetCustomModel(openaiRegistry, openai);
  const openaiModel = resolvePiModelFromRegistry("gpt-raft-test-2099", openaiRegistry, openai, null);
  assert.equal(openaiModel?.reasoning, false);
  assert.deepEqual(openaiModel?.input, ["text"]);
  assert.equal(openaiModel?.thinkingLevelMap, undefined);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
});

test("the generated provider sets match the installed Pi catalog", async () => {
  const registry = await freshRegistry();
  for (const providerId of BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS) {
    const catalog = registry.getAll().filter((model) => model.provider === providerId);
    assert.ok(catalog.length > 0, providerId);
    if (providerId !== "openrouter") {
      const transports = new Set(catalog.map((model) => JSON.stringify([model.api, model.baseUrl, model.headers ?? {}])));
      assert.equal(transports.size, 1, `${providerId}: one transport (regenerate piBuiltinModels.generated.ts after a Pi bump)`);
      assert.equal(builtInPresetTypedModelReasons(providerId), catalog.every((model) => model.reasoning), `${providerId}: reasoning`);
    }
  }
});

test("a typed Qwen Token Plan id takes the agent's declared limits; a listed one keeps its catalog entry", async () => {
  const registry = await freshRegistry();
  const declared = configureBuiltInPresetCustomModel(registry, qwenConfig("qwen-token-plan", "qwen4-preview", { contextWindow: 256_000, maxOutputTokens: 32_000 }));
  assert.deepEqual(declared.modelLimits, {
    contextWindow: { value: 256_000, source: "agent_config" },
    maxTokens: { value: 32_000, source: "agent_config" },
  });

  const listedRegistry = await freshRegistry();
  const listed = listedRegistry.find("qwen-token-plan", "qwen3.8-max");
  assert.ok(listed);
  const config = qwenConfig("qwen-token-plan", "qwen-token-plan/qwen3.8-max", { maxOutputTokens: 4096 });
  assert.deepEqual(config.model, { kind: "custom", name: "qwen3.8-max", maxOutputTokens: 4096 });
  const { modelLimits } = configureBuiltInPresetCustomModel(listedRegistry, config);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: listed.contextWindow, source: "catalog" },
    maxTokens: { value: 4096, source: "agent_config" },
  });
  const model = resolvePiModelFromRegistry("qwen3.8-max", listedRegistry, config, null);
  assert.equal(model?.reasoning, listed.reasoning);
  assert.deepEqual(model?.thinkingLevelMap, listed.thinkingLevelMap);
  assert.deepEqual(model?.input, listed.input);
  assert.deepEqual(model?.compat, listed.compat);
});

test("a listed OpenRouter model saved with a limit: parse -> store -> parse -> register runs its bare OpenRouter id on the catalog transport", async () => {
  const parse = (runtimeConfig: unknown) => {
    const parsed = parseRuntimeConfig({ runtimeConfig });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.config;
  };
  for (const [catalogId, piId] of [
    ["openrouter/moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
    ["openrouter/openrouter/auto", "openrouter/auto"],
  ] as const) {
    const saved = parse({
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-test" },
      model: { kind: "custom", name: catalogId, contextWindow: 131_072 },
      mode: { kind: "default" },
    });
    // Stored as JSON and read back: the same config, never re-stripped.
    const stored = parse(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(stored.model, { kind: "custom", name: piId, contextWindow: 131_072 });

    const registry = await freshRegistry();
    const catalogEntry = registry.find("openrouter", piId);
    assert.ok(catalogEntry, `${piId} is in Pi's catalog`);
    const { api, baseUrl, compat, reasoning, maxTokens } = catalogEntry;
    const { modelLimits } = configureBuiltInPresetCustomModel(registry, stored);
    assert.deepEqual(modelLimits?.contextWindow, { value: 131_072, source: "agent_config" }, "the agent's limit wins");
    assert.deepEqual(modelLimits?.maxTokens, { value: maxTokens, source: "catalog" });
    const model = resolvePiModelFromRegistry(piId, registry, stored, null);
    assert.ok(model);
    assert.equal(model.id, piId, "the request model id is OpenRouter's own id, without Raft's namespace");
    assert.equal(model.provider, "openrouter");
    assert.equal(model.api, api);
    assert.equal(model.baseUrl, baseUrl);
    assert.deepEqual(model.compat, compat);
    assert.equal(model.reasoning, reasoning);
    assert.equal(model.contextWindow, 131_072);
  }
});

test("the request model id is the same OpenRouter API id with and without limits (task #10)", async () => {
  const parse = (model: Record<string, unknown>) => {
    const parsed = parseRuntimeConfig({
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "builtin",
        provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-test" },
        model,
        mode: { kind: "default" },
      },
    });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.config;
  };
  for (const [name, apiId] of [
    ["openrouter/auto", "openrouter/auto"],
    ["openrouter/openrouter/auto", "openrouter/auto"],
    ["openrouter/moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
    ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
    ["auto", "auto"],
  ] as const) {
    for (const limits of [{ maxOutputTokens: 2048 }, {}]) {
      const config = parse({ kind: "custom", name, ...limits });
      const registry = await freshRegistry();
      configureBuiltInPresetCustomModel(registry, config);
      const modelId = config.model.kind === "custom" ? config.model.name : config.model.id;
      const model = resolvePiModelFromRegistry(modelId, registry, config, null);
      assert.ok(model, `${name} ${JSON.stringify(limits)}`);
      assert.equal(model.provider, "openrouter");
      assert.equal(model.id, apiId, `${name} ${JSON.stringify(limits)}: the provider gets ${apiId}`);
    }
  }
});

test("a modelOverrides entry in models.json sets a typed OpenRouter model's limits, reported as catalog", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-openrouter-override-"));
  try {
    const name = "raft-test-vendor/unlisted-model-2099";
    const modelsPath = path.join(root, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { openrouter: { modelOverrides: { [name]: { contextWindow: 1_000_000 } } } } }));
    const registry = new ModelRegistry(await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, allowModelNetwork: false }));
    const config = presetConfig("openrouter", name);
    const { modelLimits } = configureBuiltInPresetCustomModel(registry, config);
    assert.deepEqual(modelLimits, {
      contextWindow: { value: 1_000_000, source: "catalog" },
      maxTokens: { value: 8192, source: "raft_default" },
    });
    assert.equal(resolvePiModelFromRegistry(name, registry, config, null)?.contextWindow, 1_000_000, "the report is what the session runs with");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a typed id through a saved connection resolves to the connection's preset provider only", () => {
  const throughConnection = { ...presetConfig("deepseek", "deepseek-v9"), provider: { kind: "connection", connectionId: "conn-1" } } as RuntimeConfig;
  const projection = (providerId: string, endpointUrl: string | null = null) => ({ providerId, endpointUrl, supportsImageInput: false }) as Parameters<typeof resolveBuiltInPresetCustomModel>[1];
  assert.equal(resolveBuiltInPresetCustomModel(throughConnection), null, "no launch projection: nothing to run it on");
  assert.equal(resolveBuiltInPresetCustomModel(throughConnection, projection("openai-compatible", "https://gw.example.test/v1")), null, "a gateway connection registers as a gateway");
  assert.deepEqual(resolveBuiltInPresetCustomModel(throughConnection, projection("deepseek")), {
    providerId: "deepseek",
    modelId: "deepseek-v9",
    model: { kind: "custom", name: "deepseek-v9" },
  });
  const listed = { ...throughConnection, model: { kind: "preset", id: "deepseek/deepseek-v4-pro" } } as RuntimeConfig;
  assert.equal(resolveBuiltInPresetCustomModel(listed, projection("deepseek")), null, "a listed model resolves from the catalog as before");
});
