import assert from "node:assert/strict";
import { REASONING_EFFORT_RUNTIMES } from "@botiverse/raft-shared";
import {
  buildRuntimeConfig,
  hydrateRuntimeConfigForm,
  PI_PROVIDER_CONFIGURED,
  runtimeConfigApiUrl,
  runtimeConfigCustomModelName,
  runtimeConfigFastMode,
  runtimeApiUrlUnsupportedCopy,
  supportsRuntimeFastMode,
  supportsRuntimeApiUrl,
} from "../src/utils/runtimeConfigForm";

test("buildRuntimeConfig maps Claude API URL and custom model into structured config", () => {
  const config = buildRuntimeConfig({
    runtime: "claude",
    model: "sonnet",
    customModelMode: true,
    customModelName: "claude-opus-router",
    providerApiUrl: " https://gateway.example.test/v1 ",
    providerApiKey: " sk-ant-test ",
    reasoningEffort: "high",
    envVars: { TEAM_FLAG: "1" },
  });

  assert.deepEqual(config, {
    version: 1,
    runtime: "claude",
    provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
    model: { kind: "custom", name: "claude-opus-router" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { TEAM_FLAG: "1" },
  });
});

test("hydrateRuntimeConfigForm maps legacy agent rows into editable runtime config state", () => {
  const config = hydrateRuntimeConfigForm({
    runtime: "claude",
    model: "claude-opus-router",
    reasoningEffort: "high",
    envVars: {
      ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "old-generated-value",
      TEAM_FLAG: "1",
    },
  });

  assert.equal(config.runtime, "claude");
  assert.equal(config.provider?.kind, "custom");
  assert.equal(runtimeConfigApiUrl(config), "https://gateway.example.test/v1");
  assert.equal(config.provider?.kind === "custom" ? config.provider.apiKey : "", "sk-ant-test");
  assert.equal(runtimeConfigCustomModelName(config), "claude-opus-router");
  assert.equal(config.reasoningEffort, "high");
  assert.deepEqual(config.envVars, { TEAM_FLAG: "1" });
});

test("buildRuntimeConfig keeps Claude provider default when provider mode is default", () => {
  const config = buildRuntimeConfig({
    runtime: "claude",
    model: "sonnet",
    customModelMode: false,
    providerMode: "default",
    providerApiUrl: "https://stale-hidden-value.example.test",
    providerApiKey: "stale-hidden-key",
    reasoningEffort: "medium",
    envVars: null,
  });

  assert.deepEqual(config, {
    version: 1,
    runtime: "claude",
    provider: { kind: "default" },
    model: { kind: "preset", id: "sonnet" },
    mode: { kind: "default" },
    reasoningEffort: "medium",
    envVars: null,
  });
});

test("buildRuntimeConfig maps Claude custom provider only when provider mode is custom", () => {
  const config = buildRuntimeConfig({
    runtime: "claude",
    model: "opus",
    customModelMode: false,
    providerMode: "custom",
    providerApiUrl: " https://gateway.example.test ",
    providerApiKey: " sk-ant-test ",
    reasoningEffort: null,
    envVars: null,
  });

  assert.deepEqual(config.provider, {
    kind: "custom",
    apiUrl: "https://gateway.example.test",
    apiKey: "sk-ant-test",
  });
});

test("buildRuntimeConfig maps Built-in provider mode into structured config", () => {
  const config = buildRuntimeConfig({
    runtime: "builtin",
    model: "openai/gpt-5.4",
    customModelMode: false,
    builtInProviderMode: "openai",
    builtInProviderApiKey: " sk-openai-test ",
    reasoningEffort: "high",
    envVars: { OPENAI_API_KEY: "stale-user-key", SAFE_FLAG: "1" },
  });

  assert.deepEqual(config, {
    version: 1,
    runtime: "builtin",
    provider: { kind: "preset", providerId: "openai", apiKey: "sk-openai-test" },
    hostUserState: "forbidden",
    model: { kind: "preset", id: "openai/gpt-5.4" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { SAFE_FLAG: "1" },
  });
});

test("buildRuntimeConfig maps Built-in gateway provider mode into structured config", () => {
  const config = buildRuntimeConfig({
    runtime: "builtin",
    model: "openai/gpt-custom",
    customModelMode: true,
    customModelName: "openai/gpt-custom",
    builtInProviderMode: "openai-compatible",
    builtInProviderApiKey: " sk-openai-test ",
    builtInProviderBaseUrl: " https://gateway.example.test/v1 ",
    builtInProviderSupportsImageInput: true,
    reasoningEffort: "medium",
    envVars: {
      OPENAI_API_KEY: "stale-user-key",
      OPENAI_BASE_URL: "https://stale.example.test/v1",
      SAFE_FLAG: "1",
    },
  });

  assert.equal(runtimeConfigCustomModelName(config), "openai/gpt-custom");
  assert.deepEqual(config, {
    version: 1,
    runtime: "builtin",
    provider: {
      kind: "gateway",
      providerId: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "sk-openai-test",
      supportsImageInput: true,
    },
    hostUserState: "forbidden",
    model: { kind: "custom", name: "openai/gpt-custom" },
    mode: { kind: "default" },
    reasoningEffort: "medium",
    envVars: { SAFE_FLAG: "1" },
  });
});

test("Built-in gateway readback preserves image-input state while keeping its secret redacted", () => {
  const config = hydrateRuntimeConfigForm({
    runtime: "builtin",
    model: "acme/vision",
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "anthropic-compatible",
        baseUrl: "https://gateway.example.test/anthropic",
        apiKey: "",
        supportsImageInput: true,
      },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "acme/vision" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal(config.provider?.kind, "gateway");
  assert.equal(config.provider?.kind === "gateway" ? config.provider.apiKey : undefined, "");
  assert.equal(config.provider?.kind === "gateway" ? config.provider.supportsImageInput : undefined, true);
});

test("buildRuntimeConfig maps Pi configured provider model selections into structured config", () => {
  const config = buildRuntimeConfig({
    runtime: "pi",
    model: "openrouter/openai/gpt-5.4",
    customModelMode: false,
    piProviderMode: PI_PROVIDER_CONFIGURED,
    piProviderApiKey: "stale-hidden-key",
    reasoningEffort: "medium",
    envVars: null,
  });

  assert.deepEqual(config, {
    version: 1,
    runtime: "pi",
    provider: { kind: "default" },
    model: { kind: "preset", id: "openrouter/openai/gpt-5.4" },
    mode: { kind: "default" },
    reasoningEffort: "medium",
    envVars: null,
  });
});

test("buildRuntimeConfig maps Pi built-in provider model selections and API key into structured config", () => {
  const config = buildRuntimeConfig({
    runtime: "pi",
    model: "deepseek/deepseek-v4-pro",
    customModelMode: false,
    piProviderMode: "deepseek",
    piProviderApiKey: " sk-ds-test ",
    reasoningEffort: "high",
    envVars: { DEEPSEEK_API_KEY: "stale-user-key", SAFE_FLAG: "1" },
  });

  assert.deepEqual(config, {
    version: 1,
    runtime: "pi",
    provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" },
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { SAFE_FLAG: "1" },
  });
});

test("buildRuntimeConfig rejects a Pi built-in provider without its API key", () => {
  assert.throws(
    () => buildRuntimeConfig({
      runtime: "pi",
      model: "deepseek/deepseek-v4-pro",
      customModelMode: false,
      piProviderMode: "deepseek",
      piProviderApiKey: "",
      reasoningEffort: "high",
      envVars: null,
    }),
    /runtimeConfig\.provider\.apiKey is required/,
  );
});

test("buildRuntimeConfig forces Built-in gateway providers to custom model config", () => {
  const config = buildRuntimeConfig({
    runtime: "builtin",
    model: "host-discovered-preset-that-must-not-be-preset",
    customModelMode: false,
    builtInProviderMode: "anthropic-compatible",
    builtInProviderApiKey: " sk-ant-test ",
    builtInProviderBaseUrl: " https://gateway.example.test/anthropic ",
    reasoningEffort: null,
    envVars: null,
  });

  assert.deepEqual(config.provider, {
    kind: "gateway",
    providerId: "anthropic-compatible",
    baseUrl: "https://gateway.example.test/anthropic",
    apiKey: "sk-ant-test",
  });
  assert.deepEqual(config.model, {
    kind: "custom",
    name: "host-discovered-preset-that-must-not-be-preset",
  });
});

test("Cursor supports custom model name but not per-agent API URL", () => {
  const config = buildRuntimeConfig({
    runtime: "cursor",
    model: "gpt-5.3-codex",
    customModelMode: true,
    customModelName: "my-cursor-model",
    providerApiUrl: "https://ignored.example.test",
    envVars: null,
  });

  assert.equal(supportsRuntimeApiUrl("cursor"), false);
  assert.match(runtimeApiUrlUnsupportedCopy("cursor") ?? "", /does not expose a per-agent API URL/);
  assert.deepEqual(config, {
    version: 1,
    runtime: "cursor",
    model: { kind: "custom", name: "my-cursor-model" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
  });
});

test("Codex supports custom model name and no per-agent API URL", () => {
  const config = buildRuntimeConfig({
    runtime: "codex",
    model: "gpt-5.3-codex",
    customModelMode: true,
    customModelName: "gpt-5.5-codex-preview",
    providerApiUrl: "https://ignored.example.test",
    envVars: null,
  });

  assert.equal(supportsRuntimeApiUrl("codex"), false);
  assert.deepEqual(config, {
    version: 1,
    runtime: "codex",
    model: { kind: "custom", name: "gpt-5.5-codex-preview" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
  });
});

test("runtime config form exposes only supported per-runtime axes", () => {
  const runtimes = ["builtin", "claude", "codex", "grok", "antigravity", "kimi", "copilot", "cursor", "gemini", "opencode", "pi"];

  assert.deepEqual(runtimes.filter(supportsRuntimeApiUrl), ["claude"]);
  assert.deepEqual(runtimes.filter(supportsRuntimeFastMode), ["claude", "codex"]);
  assert.deepEqual(runtimes.filter((runtime) => REASONING_EFFORT_RUNTIMES.has(runtime)), ["builtin", "claude", "codex", "grok", "antigravity", "copilot", "pi"]);
});

test("buildRuntimeConfig maps fast mode only for supported runtimes", () => {
  const codexConfig = buildRuntimeConfig({
    runtime: "codex",
    model: "gpt-5.5",
    customModelMode: false,
    fastMode: true,
    reasoningEffort: "low",
    envVars: null,
  });
  const cursorConfig = buildRuntimeConfig({
    runtime: "cursor",
    model: "composer-2",
    customModelMode: false,
    fastMode: true,
    envVars: null,
  });

  assert.deepEqual(codexConfig.mode, { kind: "fast" });
  assert.deepEqual(cursorConfig.mode, { kind: "default" });
});

test("buildRuntimeConfig drops fast mode for Claude Opus 4.8, which no longer runs fast", () => {
  const opus48 = buildRuntimeConfig({ runtime: "claude", model: "claude-opus-4-8", customModelMode: false, fastMode: true, envVars: null });
  const opus55 = buildRuntimeConfig({ runtime: "claude", model: "claude-opus-5-5", customModelMode: false, fastMode: true, envVars: null });

  assert.deepEqual(opus48.mode, { kind: "default" });
  assert.deepEqual(opus55.mode, { kind: "fast" });
  assert.equal(runtimeConfigFastMode({ ...opus55, model: { kind: "preset", id: "claude-opus-4-8" } }), false);
});

test("Built-in hydration missing provider does not throw (agent detail route)", () => {
  // Member projections / agent:created strip private runtimeConfig; hydrate
  // still yields runtime:"builtin" with no provider. AgentDetailPanel reads
  // the hydrated config on every render — it must fail soft.
  const config = hydrateRuntimeConfigForm({
    runtime: "builtin",
    model: "deepseek-v4-pro",
    reasoningEffort: null,
    envVars: null,
    runtimeConfig: null,
  });

  assert.equal(config.runtime, "builtin");
  assert.equal(config.provider, undefined);
  // Model string still hydrates; only provider is absent.
  assert.equal(typeof runtimeConfigCustomModelName(config), "string");
  assert.equal(runtimeConfigApiUrl(config), "");
});
