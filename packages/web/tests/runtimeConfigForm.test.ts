import assert from "node:assert/strict";
import test from "node:test";
import { REASONING_EFFORT_RUNTIMES } from "@botiverse/raft-shared";
import {
  buildRuntimeConfig,
  buildManagedConnectionRuntimeConfig,
  builtInProviderDefaultModel,
  hydrateRuntimeConfigForm,
  PI_PROVIDER_CONFIGURED,
  piBuiltinProviderDefaultModel,
  runtimeConfigApiKey,
  runtimeConfigApiUrl,
  runtimeConfigBuiltInProviderMode,
  runtimeConfigBuiltInProviderApiKey,
  runtimeConfigBuiltInProviderBaseUrl,
  runtimeConfigBuiltInProviderSupportsImageInput,
  runtimeConfigCustomModelName,
  runtimeConfigPiProviderApiKey,
  runtimeConfigPiProviderMode,
  runtimeConfigProviderMode,
  runtimeConfigProviderConnectionId,
  runtimeIgnoresModel,
  runtimeApiUrlUnsupportedCopy,
  supportsRuntimeFastMode,
  supportsRuntimeApiUrl,
  supportsRuntimeCustomModelName,
  isBuiltInProviderApiKeyInvalid,
  isRuntimeConfigSaveDisabled,
} from "../src/utils/runtimeConfigForm.js";

test("managed connection builder persists only a compatible connection reference", () => {
  const deepseek = buildManagedConnectionRuntimeConfig({
    connectionId: "11111111-1111-4111-8111-111111111111",
    providerId: "deepseek",
    model: "deepseek/deepseek-v4-pro",
    envVars: { TEAM_FLAG: "1", DEEPSEEK_API_KEY: "must-be-scrubbed" },
  });
  assert.equal(runtimeConfigProviderConnectionId(deepseek), "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(deepseek.provider, {
    kind: "connection",
    connectionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(deepseek.envVars, { TEAM_FLAG: "1" });
  assert.equal(JSON.stringify(deepseek).includes("must-be-scrubbed"), false);

  assert.throws(() => buildManagedConnectionRuntimeConfig({
    connectionId: "11111111-1111-4111-8111-111111111111",
    providerId: "deepseek",
    model: "custom-model",
    envVars: null,
  }), /valid provider model/);
  assert.deepEqual(buildManagedConnectionRuntimeConfig({
    connectionId: "22222222-2222-4222-8222-222222222222",
    providerId: "openai-compatible",
    model: "gateway-model",
    envVars: null,
  }).model, { kind: "custom", name: "gateway-model" });
});

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
  assert.equal(runtimeConfigProviderMode(config), "custom");
  assert.equal(runtimeConfigApiUrl(config), "https://gateway.example.test/v1");
  assert.equal(runtimeConfigApiKey(config), "sk-ant-test");
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

  assert.equal(runtimeConfigBuiltInProviderMode(config), "openai");
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

  assert.equal(runtimeConfigBuiltInProviderMode(config), "openai-compatible");
  assert.equal(runtimeConfigBuiltInProviderApiKey(config), "sk-openai-test");
  assert.equal(runtimeConfigBuiltInProviderBaseUrl(config), "https://gateway.example.test/v1");
  assert.equal(runtimeConfigBuiltInProviderSupportsImageInput(config), true);
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

  assert.equal(runtimeConfigBuiltInProviderApiKey(config), "");
  assert.equal(runtimeConfigBuiltInProviderSupportsImageInput(config), true);
});

test("built-in provider default model follows Pi SDK default, not display order", () => {
  assert.equal(piBuiltinProviderDefaultModel("moonshotai"), "moonshotai/kimi-k2.6");
  assert.equal(builtInProviderDefaultModel("moonshotai"), "moonshotai/kimi-k2.6");
  assert.equal(piBuiltinProviderDefaultModel("unknown-provider"), null);
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

  assert.equal(runtimeConfigPiProviderMode(config), PI_PROVIDER_CONFIGURED);
  assert.equal(runtimeConfigPiProviderApiKey(config), "");
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

  assert.equal(runtimeConfigPiProviderMode(config), "deepseek");
  assert.equal(runtimeConfigPiProviderApiKey(config), "sk-ds-test");
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

  assert.equal(supportsRuntimeCustomModelName("cursor"), true);
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

  assert.equal(supportsRuntimeCustomModelName("codex"), true);
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
  assert.deepEqual(runtimes.filter(supportsRuntimeCustomModelName), ["builtin", "claude", "codex", "copilot", "cursor", "pi"]);
  assert.deepEqual(runtimes.filter(runtimeIgnoresModel), ["antigravity"]);
  assert.deepEqual(runtimes.filter((runtime) => REASONING_EFFORT_RUNTIMES.has(runtime)), ["builtin", "claude", "codex", "grok", "copilot", "pi"]);
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

test("Built-in hydration missing provider does not throw on form read helpers (agent detail route)", () => {
  // Member projections / agent:created strip private runtimeConfig; hydrate
  // still yields runtime:"builtin" with no provider. AgentDetailPanel calls
  // these helpers on every render — they must fail soft.
  const config = hydrateRuntimeConfigForm({
    runtime: "builtin",
    model: "deepseek-v4-pro",
    reasoningEffort: null,
    envVars: null,
    runtimeConfig: null,
  });

  assert.equal(config.runtime, "builtin");
  assert.equal(config.provider, undefined);
  assert.equal(runtimeConfigBuiltInProviderMode(config), "deepseek");
  assert.equal(runtimeConfigBuiltInProviderApiKey(config), "");
  assert.equal(runtimeConfigBuiltInProviderBaseUrl(config), "");
  assert.equal(runtimeConfigBuiltInProviderSupportsImageInput(config), false);
  // Model string still hydrates; only provider is absent.
  assert.equal(typeof runtimeConfigCustomModelName(config), "string");
  assert.equal(runtimeConfigProviderMode(config), "default");
});

// task #22, acceptance item 2. The save button collapses eleven independent causes
// into a single boolean, so reading `button.disabled` cannot show WHICH cause fired
// — a regression in the credential term hides behind "nothing changed yet". These
// pin the two predicates the button is built from.

test("a saved connection supplies the credential, so an empty agent-local key is not invalid", () => {
  assert.equal(isBuiltInProviderApiKeyInvalid({
    builtInProviderSupported: true, managedConnectionActive: true,
    apiKey: "", retainsExistingKey: false,
  }), false);
});

test("without a connection an empty agent-local key is invalid", () => {
  assert.equal(isBuiltInProviderApiKeyInvalid({
    builtInProviderSupported: true, managedConnectionActive: false,
    apiKey: "", retainsExistingKey: false,
  }), true);
});

test("an existing stored key is retained, so leaving it blank is not invalid", () => {
  assert.equal(isBuiltInProviderApiKeyInvalid({
    builtInProviderSupported: true, managedConnectionActive: false,
    apiKey: "", retainsExistingKey: true,
  }), false);
});

// Every other term is pinned false so the credential term is the only thing moving:
// otherwise a red result could come from `changed: false` and would prove nothing.
const SAVEABLE = {
  saving: false, changed: true, runtimeCanSelect: true,
  providerConnectionInvalid: false, providerApiUrlInvalid: false,
  providerApiKeyInvalid: false, builtInProviderApiKeyInvalid: false,
  piProviderApiKeyInvalid: false, builtInProviderBaseUrlInvalid: false,
  customModelInvalid: false, modelSourceInvalid: false,
};

test("save is enabled when the draft changed and nothing is invalid", () => {
  assert.equal(isRuntimeConfigSaveDisabled(SAVEABLE), false);
});

test("the credential term alone disables save", () => {
  assert.equal(isRuntimeConfigSaveDisabled({ ...SAVEABLE, builtInProviderApiKeyInvalid: true }), true);
});

test("an unchanged draft disables save even when nothing is invalid", () => {
  // Named explicitly so a future red here is not misread as the credential term.
  assert.equal(isRuntimeConfigSaveDisabled({ ...SAVEABLE, changed: false }), true);
});
