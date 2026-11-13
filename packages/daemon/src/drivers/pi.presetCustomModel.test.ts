// task #10 (#wg-runtime-form): a Built-in agent on OpenRouter may run a typed
// model id that is not in Pi's catalog. The launch registers it under exactly
// the openrouter provider, copying the transport from the catalog, and never
// resolves the name to another provider's model.
import assert from "node:assert/strict";
import { parseRuntimeConfig, RUNTIME_CONFIG_VERSION, type RuntimeConfig } from "@botiverse/raft-shared";
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

test("an OpenRouter id outside the catalog is registered under openrouter with the catalog's transport and Raft's default limits", async () => {
  const registry = await freshRegistry();
  const template = registry.getAll().find((model) => model.provider === "openrouter");
  assert.ok(template, "the Pi catalog has OpenRouter models");
  const name = "raft-test-vendor/unlisted-model-2099";
  const config = presetConfig("openrouter", name);
  assert.equal(resolvePiModelFromRegistry(name, registry, config, null), undefined, "not resolvable before registration");

  const { modelLimits } = configureBuiltInPresetCustomModel(registry, config);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
  const model = resolvePiModelFromRegistry(name, registry, config, null);
  assert.ok(model);
  assert.equal(model.provider, "openrouter");
  assert.equal(model.id, name);
  assert.equal(model.api, template.api);
  assert.equal(model.baseUrl, template.baseUrl);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 8192);
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

test("only OpenRouter takes a typed model; other presets and saved connections are untouched", () => {
  const resolved = resolveBuiltInPresetCustomModel(presetConfig("openrouter", "a/b"));
  assert.equal(resolved?.providerId, "openrouter");
  assert.equal(resolved?.modelId, "a/b");
  assert.equal(resolveBuiltInPresetCustomModel(presetConfig("deepseek", "deepseek-v9")), null);
  assert.equal(resolveBuiltInPresetCustomModel({
    ...presetConfig("openrouter", "a/b"),
    provider: { kind: "connection", connectionId: "c1" },
  } as RuntimeConfig), null);
});

test("the Built-in catalog advertises the preset providers that accept a typed model", async () => {
  const outcome = await new BuiltInDriver().detectModels();
  assert.equal(outcome.kind, "live");
  assert.deepEqual(outcome.kind === "live" ? outcome.value.catalog?.customModelProviderIds : undefined, ["openrouter"]);
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
