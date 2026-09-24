import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLaunchPlan,
  allowedReasoningEffortsForModel,
  hydrateRuntimeConfig,
  hydrateRuntimeConfigWithTrace,
  parseRuntimeConfig,
  runtimeConfigToLaunchFields,
  stripControlledRuntimeEnvVars,
  type ReasoningEffort,
} from "./index.js";

test("hydrates legacy Claude env vars into structured provider config", () => {
  const config = hydrateRuntimeConfig({
    runtime: "claude",
    model: "internal-gateway/claude-opus",
    envVars: {
      ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "old-generated-value",
      TEAM_FLAG: "enabled",
    },
  });

  assert.deepEqual(config, {
    version: 1 as const,
    runtime: "claude",
    provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
    model: { kind: "custom", name: "internal-gateway/claude-opus" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: { TEAM_FLAG: "enabled" },
  });
  assert.deepEqual(runtimeConfigToLaunchFields(config), {
    runtime: "claude",
    model: "internal-gateway/claude-opus",
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: {
      TEAM_FLAG: "enabled",
      ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "internal-gateway/claude-opus",
    },
  });
});

test("keeps Cursor as model-only config without provider axis", () => {
  const config = hydrateRuntimeConfig({
    runtime: "cursor",
    model: "custom-composer",
    envVars: { CURSOR_EXPERIMENT: "1" },
  });

  assert.equal(config.provider, undefined);
  assert.deepEqual(config.model, { kind: "custom", name: "custom-composer" });
  assert.deepEqual(runtimeConfigToLaunchFields(config), {
    runtime: "cursor",
    model: "custom-composer",
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: { CURSOR_EXPERIMENT: "1" },
  });
});

test("structured hydration preserves host-discovered preset models absent from the static fallback catalog", () => {
  const config = hydrateRuntimeConfig({
    runtime: "codex",
    model: "gpt-5.5",
    runtimeConfig: {
      version: 1,
      runtime: "codex",
      model: { kind: "preset", id: "gpt-5.6-sol" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.deepEqual(config.model, { kind: "preset", id: "gpt-5.6-sol" });
  assert.equal(runtimeConfigToLaunchFields(config).model, "gpt-5.6-sol");
});

test("structured Claude config emits legacy launch mirrors for downlevel daemon consumption", () => {
  const launch = runtimeConfigToLaunchFields({
    version: 1,
    runtime: "claude",
    provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
    model: { kind: "custom", name: "claude-opus-4-6" },
    mode: { kind: "fast" },
    reasoningEffort: "high",
    command: "claude-p",
    envVars: { TEAM_FLAG: "enabled" },
  });

  assert.deepEqual(launch, {
    runtime: "claude",
    model: "claude-opus-4-6",
    mode: { kind: "fast" },
    reasoningEffort: "high",
    command: "claude-p",
    envVars: {
      TEAM_FLAG: "enabled",
      ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-4-6",
    },
  });
});

test("preserves legacy custom-provider launch mirrors when provider API key is stripped from stored config", () => {
  const config = hydrateRuntimeConfig({
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "", apiKey: "" },
      model: { kind: "preset", id: "deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    envVars: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "sk-deepseek-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "deepseek-v4-pro",
    },
  });

  assert.deepEqual(config.provider, {
    kind: "custom",
    apiUrl: "https://api.deepseek.com/anthropic",
    apiKey: "sk-deepseek-test",
  });
  assert.deepEqual(config.model, { kind: "custom", name: "deepseek-v4-pro" });
  assert.deepEqual(runtimeConfigToLaunchFields(config), {
    runtime: "claude",
    model: "deepseek-v4-pro",
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "sk-deepseek-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "deepseek-v4-pro",
    },
  });
});

test("keeps stored custom-provider config as the canonical launch source when present", () => {
  const config = hydrateRuntimeConfig({
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: {
        kind: "custom",
        apiUrl: "https://api.deepseek.com/anthropic",
        apiKey: "sk-deepseek-test",
      },
      model: { kind: "custom", name: "deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    envVars: {
      ANTHROPIC_BASE_URL: "https://stale.example.test/anthropic",
      ANTHROPIC_API_KEY: "sk-stale",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "stale-model",
    },
  });
  const launch = runtimeConfigToLaunchFields(config);

  assert.deepEqual(launch, {
    runtime: "claude",
    model: "deepseek-v4-pro",
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "sk-deepseek-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "deepseek-v4-pro",
    },
  });
});

test("rejects provider config on runtimes without a provider launch contract", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "cursor",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: "sk-ant-test" },
      model: { kind: "custom", name: "custom-composer" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.provider is not supported for runtime: cursor");
  assert.equal(result.trace.reason, "cross_runtime_provider");
});

test("rejects custom command on runtimes without a command launch contract", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "cursor",
      command: "cursor-agent-alt",
      model: { kind: "preset", id: "composer-2" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.command is not supported for runtime: cursor");
  assert.equal(result.trace.reason, "unsupported_command");
});

test("rejects custom command with null bytes", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      command: "claude\u0000-p",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.command must not contain null bytes");
  assert.equal(result.trace.reason, "invalid_command");
});

test("hydrates fast mode as a structured launch variant", () => {
  const config = hydrateRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "codex",
      model: { kind: "preset", id: "gpt-5.5" },
      mode: { kind: "fast" },
      reasoningEffort: "low",
    },
  });

  assert.deepEqual(config.mode, { kind: "fast" });
  assert.deepEqual(runtimeConfigToLaunchFields(config), {
    runtime: "codex",
    model: "gpt-5.5",
    mode: { kind: "fast" },
    reasoningEffort: "low",
    envVars: null,
  });
});

test("rejects fast mode on runtimes without a launch contract", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "cursor",
      model: { kind: "preset", id: "composer-2" },
      mode: { kind: "fast" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.mode is not supported for runtime: cursor");
  assert.equal(result.trace.reason, "unsupported_fast_mode");
});

test("rejects reasoning effort on runtimes without a launch contract", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "cursor",
      model: { kind: "preset", id: "composer-2" },
      mode: { kind: "default" },
      reasoningEffort: "high",
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.reasoningEffort is not supported for runtime: cursor");
  assert.equal(result.trace.reason, "unsupported_reasoning_effort");
});

test("accepts Pi reasoning effort and custom model without provider or fast mode", () => {
  const config = hydrateRuntimeConfig({
    runtime: "pi",
    model: "provider/model-alpha",
    reasoningEffort: "xhigh",
    envVars: { PI_EXPERIMENT: "1" },
  });

  assert.equal(config.provider, undefined);
  assert.deepEqual(config.model, { kind: "custom", name: "provider/model-alpha" });
  assert.deepEqual(runtimeConfigToLaunchFields(config), {
    runtime: "pi",
    model: "provider/model-alpha",
    mode: { kind: "default" },
    reasoningEffort: "xhigh",
    envVars: { PI_EXPERIMENT: "1" },
  });
});

test("rejects credential-bearing provider URLs", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://user:pass@gateway.example.test", apiKey: "sk-ant-test" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.provider.apiUrl must not contain credentials");
  assert.equal(result.trace.reason, "invalid_provider");
});

test("rejects custom Claude provider without an API key", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: "" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.provider.apiKey is required");
  assert.equal(result.trace.reason, "invalid_provider");
});

test("strips runtime-owned env keys from user env vars", () => {
  assert.deepEqual(stripControlledRuntimeEnvVars("claude", {
    ANTHROPIC_BASE_URL: "https://gateway.example.test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "opus",
    SAFE_FLAG: "1",
  }), { SAFE_FLAG: "1" });
});

test("Pi runtime accepts the pi-builtin provider and maps DeepSeek to DEEPSEEK_API_KEY", () => {
  const config = hydrateRuntimeConfig({
    runtime: "pi",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig: {
      version: 1 as const,
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });

  assert.deepEqual(config.provider, { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" });

  // The web-supplied API key flows out as DEEPSEEK_API_KEY in launch env vars
  // — that's the env var the Pi SDK's getEnvApiKey path reads for `deepseek`,
  // so the spawned agent picks it up without auth.json mutation.
  assert.deepEqual(runtimeConfigToLaunchFields(config).envVars, {
    DEEPSEEK_API_KEY: "sk-ds-test",
  });
});

test("Built-in runtime accepts only the preset provider and forbids host user state", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: "high",
      envVars: {
        DEEPSEEK_API_KEY: "sk-user-controlled",
        TEAM_FLAG: "enabled",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config, {
    version: 1 as const,
    runtime: "builtin",
    provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds-test" },
    hostUserState: "forbidden",
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { TEAM_FLAG: "enabled" },
  });

  const plan = buildLaunchPlan(result.config);
  assert.equal(plan.configSource, "agent_config");
  assert.equal(plan.trace.config_source, "agent_config");
  assert.equal(plan.trace.provider_id, "deepseek");
  assert.equal(plan.trace.model_kind, "preset");
  assert.equal(plan.trace.model_id, "deepseek/deepseek-v4-pro");
  assert.equal(plan.trace.provider_key_present, true);
  assert.equal(plan.trace.provider_key_source, "runtime_config_plaintext");
  assert.deepEqual(runtimeConfigToLaunchFields(result.config).envVars, {
    TEAM_FLAG: "enabled",
    DEEPSEEK_API_KEY: "sk-ds-test",
  });
  assert.equal(runtimeConfigToLaunchFields(result.config).reasoningEffort, "high");
});

test("Built-in managed connection persists only a reference and emits no provider credential env", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      envVars: {
        DEEPSEEK_API_KEY: "must-be-scrubbed",
        TEAM_FLAG: "enabled",
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config.provider, {
    kind: "connection",
    connectionId: "11111111-1111-4111-8111-111111111111",
  });
  const plan = buildLaunchPlan(result.config);
  assert.equal(plan.trace.provider_kind, "connection");
  assert.equal(plan.trace.provider_key_present, false);
  assert.equal(plan.trace.provider_key_source, undefined);
  assert.deepEqual(plan.envVars, { TEAM_FLAG: "enabled" });

  const poisoned = parseRuntimeConfig({
    runtimeConfig: {
      ...result.config,
      provider: { ...result.config.provider, apiKey: "must-not-be-accepted" },
    },
  });
  assert.equal(poisoned.ok, false);
  if (!poisoned.ok) assert.equal(poisoned.trace.reason, "unknown_field");
});

test("Built-in runtime maps official providers and strips provider-owned env keys", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openai", apiKey: "sk-openai-test" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "openai/gpt-5.4" },
      mode: { kind: "default" },
      envVars: {
        OPENAI_API_KEY: "sk-user-controlled",
        DEEPSEEK_API_KEY: "sk-ds-user-controlled",
        ANTHROPIC_OAUTH_TOKEN: "sk-ant-oauth-user-controlled",
        MOONSHOT_API_KEY: "sk-moonshot-user-controlled",
        XIAOMI_API_KEY: "sk-xiaomi-user-controlled",
        SAFE_FLAG: "enabled",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.trace.provider_id, "openai");
  assert.equal(result.trace.model_kind, "preset");
  assert.equal(result.trace.model_id, "openai/gpt-5.4");
  assert.deepEqual(result.config.envVars, { SAFE_FLAG: "enabled" });
  const plan = buildLaunchPlan(result.config);
  assert.equal(plan.trace.provider_id, "openai");
  assert.equal(plan.trace.model_kind, "preset");
  assert.equal(plan.trace.model_id, "openai/gpt-5.4");
  assert.deepEqual(runtimeConfigToLaunchFields(result.config).envVars, {
    SAFE_FLAG: "enabled",
    OPENAI_API_KEY: "sk-openai-test",
  });
});

test("Built-in runtime maps gateway-compatible providers with base URL trace evidence", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "openai-compatible",
        baseUrl: " https://gateway.example.test/v1 ",
        apiKey: " sk-openai-test ",
      },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "openai/gpt-custom" },
      mode: { kind: "default" },
      reasoningEffort: "medium",
      envVars: {
        OPENAI_API_KEY: "sk-user-controlled",
        OPENAI_BASE_URL: "https://user-controlled.example.test/v1",
        SAFE_FLAG: "enabled",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.trace.provider_kind, "gateway");
  assert.equal(result.trace.provider_id, "openai-compatible");
  assert.equal(result.trace.model_kind, "custom");
  assert.equal(result.trace.model_id, undefined);
  assert.equal(result.trace.base_url_present, true);
  assert.equal(result.trace.base_url_host_class, "public");
  assert.deepEqual(result.config, {
    version: 1 as const,
    runtime: "builtin",
    provider: {
      kind: "gateway",
      providerId: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "sk-openai-test",
    },
    hostUserState: "forbidden",
    model: { kind: "custom", name: "openai/gpt-custom" },
    mode: { kind: "default" },
    reasoningEffort: "medium",
    envVars: { SAFE_FLAG: "enabled" },
  });

  const plan = buildLaunchPlan(result.config);
  assert.equal(plan.trace.provider_kind, "gateway");
  assert.equal(plan.trace.provider_id, "openai-compatible");
  assert.equal(plan.trace.model_kind, "custom");
  assert.equal(plan.trace.base_url_present, true);
  assert.equal(plan.trace.base_url_host_class, "public");
  assert.equal(plan.trace.provider_key_present, true);
  assert.equal(plan.trace.provider_key_source, "runtime_config_plaintext");
  assert.deepEqual(runtimeConfigToLaunchFields(result.config).envVars, {
    SAFE_FLAG: "enabled",
    OPENAI_API_KEY: "sk-openai-test",
    OPENAI_BASE_URL: "https://gateway.example.test/v1",
  });
  assert.equal(runtimeConfigToLaunchFields(result.config).reasoningEffort, "medium");
});

test("Built-in gateway image-input capability is an optional strict boolean", () => {
  const checked = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "openai-compatible",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "sk-openai-test",
        supportsImageInput: true,
      },
      model: { kind: "custom", name: "openai/gpt-custom" },
      mode: { kind: "default" },
    },
  });
  assert.equal(checked.ok, true);
  assert.equal(
    checked.ok && checked.config.runtime === "builtin" && checked.config.provider.kind === "gateway"
      ? checked.config.provider.supportsImageInput
      : undefined,
    true,
  );

  const invalid = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "anthropic-compatible",
        baseUrl: "https://gateway.example.test/anthropic",
        apiKey: "sk-anthropic-test",
        supportsImageInput: "yes",
      },
      model: { kind: "custom", name: "claude-compatible" },
      mode: { kind: "default" },
    },
  });
  assert.equal(invalid.ok, false);

  const preset = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: {
        kind: "preset",
        providerId: "openai",
        apiKey: "sk-openai-test",
        supportsImageInput: true,
      },
      model: { kind: "preset", id: "openai/gpt-5.4" },
      mode: { kind: "default" },
    },
  });
  assert.equal(preset.ok, false);
});

test("Built-in gateway provider rejects illegal URL and preset model combinations", () => {
  const withCredentials = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://user:pass@gateway.example.test/v1", apiKey: "sk-openai-test" },
      model: { kind: "custom", name: "openai/gpt-custom" },
      mode: { kind: "default" },
    },
  });
  assert.equal(withCredentials.ok, false);
  assert.equal(withCredentials.ok ? null : withCredentials.error, "runtimeConfig.provider.baseUrl must not contain credentials");
  assert.equal(withCredentials.trace.reason, "invalid_provider");

  const preset = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: "http://127.0.0.1:8787/anthropic", apiKey: "sk-ant-test" },
      model: { kind: "preset", id: "anthropic/claude-sonnet-4.6" },
      mode: { kind: "default" },
    },
  });
  assert.equal(preset.ok, false);
  assert.equal(preset.ok ? null : preset.error, "runtimeConfig.model.kind preset is not supported for Built-in gateway providers");
  assert.equal(preset.trace.reason, "invalid_model");
  assert.equal(preset.trace.provider_id, "anthropic-compatible");
  assert.equal(preset.trace.base_url_present, true);
  assert.equal(preset.trace.base_url_host_class, "localhost");
});

test("Built-in runtime rejects model/provider mismatches and custom direct-provider models", () => {
  const mismatch = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openai", apiKey: "sk-openai-test" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.trace.reason, "invalid_model");
  assert.equal(mismatch.trace.provider_id, "openai");
  assert.equal(mismatch.trace.model_kind, "preset");
  assert.equal(mismatch.trace.model_id, "deepseek/deepseek-v4-pro");
  assert.equal(mismatch.ok ? null : mismatch.error, "runtimeConfig.model.id is not supported for Built-in provider openai");

  const custom = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openai", apiKey: "sk-openai-test" },
      model: { kind: "custom", name: "gpt-custom" },
      mode: { kind: "default" },
    },
  });
  assert.equal(custom.ok, false);
  assert.equal(custom.trace.reason, "invalid_model");
  assert.equal(custom.trace.provider_id, "openai");
  assert.equal(custom.trace.model_kind, "custom");
  assert.equal(custom.trace.model_id, undefined);
});

test("Built-in runtime rejects local Pi/default provider shapes before launch materialization", () => {
  const missing = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? null : missing.error, "runtimeConfig.provider is required for runtime: builtin");
  assert.equal(missing.trace.reason, "invalid_provider");

  const defaultProvider = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "default" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });
  assert.equal(defaultProvider.ok, false);
  assert.equal(defaultProvider.trace.reason, "cross_runtime_provider");

  const piProvider = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });
  assert.equal(piProvider.ok, false);
  assert.equal(piProvider.trace.provider_kind, "pi-builtin");
  assert.equal(piProvider.trace.reason, "cross_runtime_provider");
});

test("Built-in runtime rejects mutable hostUserState and unsupported launch knobs", () => {
  const hostState = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds-test" },
      hostUserState: "allowed",
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });
  assert.equal(hostState.ok, false);
  assert.equal(hostState.trace.reason, "unknown_field");

  const fast = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "fast" },
    },
  });
  assert.equal(fast.ok, false);
  assert.equal(fast.trace.reason, "unsupported_fast_mode");

  const invalidReasoning = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: "turbo",
    },
  });
  assert.equal(invalidReasoning.ok, false);
  assert.equal(invalidReasoning.trace.reason, "invalid_reasoning_effort");
});

test("Pi runtime rejects an unknown provider id", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "no-such-provider", apiKey: "sk-x" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "runtimeConfig.provider.providerId no-such-provider is not a known Pi builtin provider");
  assert.equal(result.trace.reason, "invalid_provider");
});

test("Pi runtime defaults to no provider when pi-builtin is missing required fields", () => {
  // A pi-builtin shape with no apiKey falls back to { kind: "default" } during
  // hydration — the SDK's auth.json / OAuth path remains untouched.
  const config = hydrateRuntimeConfig({
    runtime: "pi",
    runtimeConfig: {
      version: 1 as const,
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
  });

  assert.deepEqual(config.provider, { kind: "default" });
  assert.equal(runtimeConfigToLaunchFields(config).envVars, null);
});

test("strips Pi-owned env keys from user env vars", () => {
  assert.deepEqual(stripControlledRuntimeEnvVars("pi", {
    DEEPSEEK_API_KEY: "sk-ds-leaked",
    SAFE_FLAG: "1",
  }), { SAFE_FLAG: "1" });
});

test("strict parser rejects unknown top-level fields before launch materialization", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      envVars: null,
      injectedSecret: "must-not-survive",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.trace.outcome, "rejected");
  assert.equal(result.trace.reason, "unknown_field");
});

test("strict parser rejects cross-runtime provider arms with closed trace attrs", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      envVars: null,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.trace.outcome, "rejected");
  assert.equal(result.trace.runtime, "claude");
  assert.equal(result.trace.provider_kind, "pi-builtin");
  assert.equal(result.trace.reason, "cross_runtime_provider");
});

test("strict parser rejects malformed nested runtimeConfig env vars", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      envVars: { GOOD: "1", BAD: 1 },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.trace.outcome, "rejected");
  assert.equal(result.trace.runtime, "claude");
  assert.equal(result.trace.provider_kind, "default");
  assert.equal(result.trace.reason, "invalid_env_vars");
});

test("strict parser validates nested runtimeConfig env vars before stripping controlled keys", () => {
  const result = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      envVars: {
        ANTHROPIC_API_KEY: "sk-ant-controlled",
        TEAM_FLAG: "enabled",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config.envVars, { TEAM_FLAG: "enabled" });
});

test("legacy hydration sanitizes unknown fields and launch plan only uses canonical config", () => {
  const { config, trace } = hydrateRuntimeConfigWithTrace({
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
      model: { kind: "custom", name: "claude-opus-4-6" },
      mode: { kind: "default" },
      envVars: { TEAM_FLAG: "enabled" },
      unknownEndpointUrl: "https://should-not-survive.example.test",
    },
  });

  assert.equal(trace.outcome, "legacy_sanitized");
  assert.equal(trace.unknown_fields_dropped_count, 1);
  assert.equal("unknownEndpointUrl" in config, false);

  const launch = runtimeConfigToLaunchFields(config);
  assert.deepEqual(launch.envVars, {
    TEAM_FLAG: "enabled",
    ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-4-6",
  });
  assert.equal(JSON.stringify(launch).includes("should-not-survive"), false);
});

test("legacy hydration sanitizes nested unknown variant fields with the parser field set", () => {
  const { config, trace } = hydrateRuntimeConfigWithTrace({
    runtime: "pi",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig: {
      version: 1,
      runtime: "pi",
      provider: {
        kind: "pi-builtin",
        providerId: "deepseek",
        apiKey: "sk-ds-test",
        rawEndpointUrl: "https://should-not-survive.example.test",
      },
      model: {
        kind: "preset",
        id: "deepseek/deepseek-v4-pro",
        rawModelSource: "should-not-survive",
      },
      mode: {
        kind: "default",
        rawModeSource: "should-not-survive",
      },
    },
  });

  assert.equal(trace.outcome, "legacy_sanitized");
  assert.equal(trace.unknown_fields_dropped_count, 3);
  assert.equal(JSON.stringify(config).includes("should-not-survive"), false);

  const launch = runtimeConfigToLaunchFields(config);
  assert.deepEqual(launch.envVars, { DEEPSEEK_API_KEY: "sk-ds-test" });
  assert.equal(JSON.stringify(launch).includes("should-not-survive"), false);
});

test("write validation gates reasoning effort per preset model — max/ultra can't leak to Claude (task #496)", () => {
  // parseRuntimeConfig is the strict WRITE validator (create/update). The real form
  // sends a structured `{ kind: "preset", id }` model. Claude declares no
  // supportedReasoningEfforts → BASE set, so a max/ultra effort (Codex-GPT-5.6-only)
  // must fail-closed to null rather than persist, even though the raw enum accepts it.
  const parsePreset = (runtime: string, modelId: string, reasoningEffort: ReasoningEffort, provider?: unknown) => {
    const r = parseRuntimeConfig({
      runtimeConfig: {
        version: 1,
        runtime,
        ...(provider ? { provider } : {}),
        model: { kind: "preset", id: modelId },
        mode: { kind: "default" },
        reasoningEffort,
        envVars: null,
      },
    } as never);
    assert.ok(r.ok, `parse should succeed for ${runtime}/${modelId}/${reasoningEffort}`);
    return r.config.reasoningEffort;
  };
  assert.equal(parsePreset("claude", "sonnet", "ultra", { kind: "default" }), null);
  assert.equal(parsePreset("claude", "sonnet", "max", { kind: "default" }), null);
  // A base-level effort on Claude is preserved.
  assert.equal(parsePreset("claude", "sonnet", "high", { kind: "default" }), "high");
  // Codex Astra and GPT-5.6 sol DECLARE ultra via supportedReasoningEfforts → it is kept;
  // luna does NOT declare ultra → dropped.
  assert.equal(parsePreset("codex", "gpt-6-astra", "ultra"), "ultra");
  assert.equal(parsePreset("codex", "gpt-5.6-sol", "ultra"), "ultra");
  assert.equal(parsePreset("codex", "gpt-5.6-luna", "ultra"), null);
});

test("Kimi keeps live-declared open effort values without inheriting another model's defaults", () => {
  const parsed = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "balanced-plus",
      envVars: null,
    },
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.config.reasoningEffort, "balanced-plus");
  assert.equal(buildLaunchPlan(parsed.config).reasoningEffort, "balanced-plus");
  assert.deepEqual(allowedReasoningEffortsForModel("kimi-sdk", "kimi-code/k3"), []);
  assert.deepEqual(allowedReasoningEffortsForModel("kimi-sdk", "missing-metadata"), []);
});

// P0 (#proj-frontend task #298): a Built-in agent whose private `runtimeConfig`
// was stripped by a member/non-admin projection or the `agent:created` broadcast
// reaches the read path as `runtime:"builtin"` with no provider. The declared
// type says `BuiltInRuntimeConfig.provider` is always present; the wire does not
// keep that promise. Deriving trace attributes must not be what crashes a render.
test("Built-in hydration without a provider degrades instead of throwing", () => {
  const { config, trace } = hydrateRuntimeConfigWithTrace({
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig: null,
  });

  assert.equal(config.runtime, "builtin");
  // Report the absence honestly rather than inventing a provider.
  assert.equal(trace.provider_kind, "none");
  // A fabricated provider_id would make an unusable config look launchable and
  // would poison provider-attributed telemetry.
  assert.equal("provider_id" in trace, false);
  // The public model column still projects, so the UI has something to show.
  assert.equal(trace.model_kind, "preset");
});

test("malformed Built-in runtimeConfig hydrates without inventing a provider", () => {
  const { config, trace } = hydrateRuntimeConfigWithTrace({
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    // `provider` present but structurally junk — the strict create/update parser
    // rejects this shape; the tolerant read path must survive it.
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    } as unknown as Record<string, unknown>,
  });

  assert.equal(config.runtime, "builtin");
  assert.equal("provider_id" in trace, false);
});
