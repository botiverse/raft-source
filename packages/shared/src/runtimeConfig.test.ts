import assert from "node:assert/strict";
import {
  buildLaunchPlan,
  allowedReasoningEffortsForModel,
  hydrateRuntimeConfig,
  hydrateRuntimeConfigWithTrace,
  parseRuntimeConfig,
  runtimeConfigToLaunchFields,
  runtimeModelSupportsFastMode,
  stripControlledRuntimeEnvVars,
  isControlledRuntimeEnvKey,
  type ReasoningEffort,
} from "./index";

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

test("a saved fast mode on Claude Opus 4.8 launches at the standard speed", () => {
  // Claude Code removes Opus 4.8 fast mode on 2026-11-30: a fast request for it fails.
  const config = hydrateRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      model: { kind: "preset", id: "claude-opus-4-8" },
      mode: { kind: "fast" },
      reasoningEffort: null,
    },
  });

  assert.deepEqual(config.mode, { kind: "fast" });
  assert.deepEqual(runtimeConfigToLaunchFields(config).mode, { kind: "default" });
  assert.equal(runtimeModelSupportsFastMode("claude", "claude-opus-4-8"), false);
  assert.equal(runtimeModelSupportsFastMode("claude", "claude-opus-4-8[1m]"), false);
  assert.equal(runtimeModelSupportsFastMode("claude", "claude-opus-5-5"), true);
  assert.equal(runtimeModelSupportsFastMode("claude", "opus"), true);
  assert.equal(runtimeModelSupportsFastMode("cursor", "composer-2"), false);
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

test("runtime-owned env keys are stripped in any case (Windows reads env names case-insensitively)", () => {
  assert.deepEqual(stripControlledRuntimeEnvVars("claude", {
    Anthropic_Base_Url: "https://gateway.example.test",
    anthropic_api_key: "sk-ant-test",
    Safe_Flag: "1",
  }), { Safe_Flag: "1" });
  assert.equal(isControlledRuntimeEnvKey("claude", "Anthropic_Base_Url"), true);
  assert.equal(isControlledRuntimeEnvKey("claude", "ANTHROPIC_AUTH_TOKEN"), false);
});

test("Codex drops OPENAI_BASE_URL from user env vars: Raft sets no Codex endpoint", () => {
  assert.deepEqual(stripControlledRuntimeEnvVars("codex", {
    OPENAI_BASE_URL: "https://proxy.example.test/v1",
    openai_base_url: "https://proxy.example.test/v1",
    CODEX_HOME: "/Users/me/.codex-work",
  }), { CODEX_HOME: "/Users/me/.codex-work" });
  const config = hydrateRuntimeConfig({
    runtime: "codex",
    model: "default",
    runtimeConfig: {
      version: 1 as const,
      runtime: "codex",
      model: { kind: "preset", id: "default" },
      mode: { kind: "default" },
      envVars: { OPENAI_BASE_URL: "https://proxy.example.test/v1" },
    },
  });
  assert.equal(config.envVars, null);
  assert.equal(runtimeConfigToLaunchFields(config).envVars, null);
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

test("runtime-owned env keys are stripped in any case (Windows reads env names case-insensitively)", () => {
  assert.deepEqual(stripControlledRuntimeEnvVars("claude", {
    Anthropic_Base_Url: "https://gateway.example.test",
    anthropic_api_key: "sk-ant-test",
    Safe_Flag: "1",
  }), { Safe_Flag: "1" });
  assert.equal(isControlledRuntimeEnvKey("claude", "Anthropic_Base_Url"), true);
  assert.equal(isControlledRuntimeEnvKey("claude", "ANTHROPIC_AUTH_TOKEN"), false);
});

test("Codex drops OPENAI_BASE_URL from user env vars: Raft sets no Codex endpoint", () => {
  assert.deepEqual(stripControlledRuntimeEnvVars("codex", {
    OPENAI_BASE_URL: "https://proxy.example.test/v1",
    openai_base_url: "https://proxy.example.test/v1",
    CODEX_HOME: "/Users/me/.codex-work",
  }), { CODEX_HOME: "/Users/me/.codex-work" });
  const config = hydrateRuntimeConfig({
    runtime: "codex",
    model: "default",
    runtimeConfig: {
      version: 1 as const,
      runtime: "codex",
      model: { kind: "preset", id: "default" },
      mode: { kind: "default" },
      envVars: { OPENAI_BASE_URL: "https://proxy.example.test/v1" },
    },
  });
  assert.equal(config.envVars, null);
  assert.equal(runtimeConfigToLaunchFields(config).envVars, null);
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

test("Pi's off and minimal are refused on every other runtime, preset or custom model (#9775)", () => {
  const parse = (runtime: string, model: unknown, reasoningEffort: string, provider?: unknown) => parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime,
      ...(provider ? { provider } : {}),
      model,
      mode: { kind: "default" },
      reasoningEffort,
      envVars: null,
    },
  } as never);
  for (const effort of ["off", "minimal"]) {
    const refused = (result: ReturnType<typeof parse>) => !result.ok && /reasoning effort/i.test(result.error);
    assert.ok(refused(parse("claude", { kind: "custom", name: "my-claude" }, effort, { kind: "default" })), `claude custom + ${effort} is refused, as before #9775`);
    assert.ok(refused(parse("codex", { kind: "custom", name: "my-codex" }, effort)), `codex custom + ${effort} is refused`);
    assert.ok(refused(parse("claude", { kind: "preset", id: "sonnet" }, effort, { kind: "default" })), `claude preset + ${effort} is refused, not silently dropped`);
  }
  // Kimi Code owns its effort strings, its own "off" among them.
  for (const effort of ["off", "minimal", "on"]) {
    const kimi = parse("kimi-sdk", { kind: "preset", id: "kimi-for-coding" }, effort);
    assert.ok(kimi.ok && kimi.config.reasoningEffort === effort, `kimi-sdk keeps ${effort}`);
  }
  const piCustom = parse("pi", { kind: "custom", name: "some/model" }, "off");
  assert.ok(piCustom.ok && piCustom.config.reasoningEffort === "off", "Pi keeps it for any model");
});

test("write validation gates reasoning effort per preset model — ultra can't leak to Claude, max only where declared (task #496)", () => {
  // parseRuntimeConfig is the strict WRITE validator (create/update). The real form
  // sends a structured `{ kind: "preset", id }` model. Claude models declare
  // low..max (Claude Code's `--effort`), never ultra; Haiku 4.5 declares nothing and
  // keeps the BASE set. An undeclared effort must fail-closed to null rather than
  // persist, even though the raw enum accepts it.
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
  // Pi's off/minimal are kept on Pi runtimes (rejected elsewhere; see the next test).
  assert.equal(parsePreset("pi", "default", "off"), "off");
  assert.equal(parsePreset("pi", "default", "minimal"), "minimal");
  assert.equal(parsePreset("claude", "sonnet", "ultra", { kind: "default" }), null);
  assert.equal(parsePreset("claude", "sonnet", "max", { kind: "default" }), "max");
  assert.equal(parsePreset("claude", "claude-opus-5-5", "max", { kind: "default" }), "max");
  assert.equal(parsePreset("claude", "claude-haiku-4-5", "max", { kind: "default" }), null);
  // A base-level effort on Claude is preserved.
  assert.equal(parsePreset("claude", "sonnet", "high", { kind: "default" }), "high");
  // Codex Astra and GPT-5.6 sol DECLARE ultra via supportedReasoningEfforts → it is kept;
  // luna does NOT declare ultra → dropped.
  assert.equal(parsePreset("codex", "gpt-6-astra", "ultra"), "ultra");
  assert.equal(parsePreset("codex", "gpt-5.6-sol", "ultra"), "ultra");
  assert.equal(parsePreset("codex", "gpt-5.6-luna", "ultra"), null);
  // GPT-6.1 Sol and GPT-6 Sol declare max/ultra; GPT-6 Luna stops at max.
  assert.equal(parsePreset("codex", "gpt-6.1-sol", "ultra"), "ultra");
  assert.equal(parsePreset("codex", "gpt-6.1-sol", "max"), "max");
  assert.equal(parsePreset("codex", "gpt-6-sol", "ultra"), "ultra");
  assert.equal(parsePreset("codex", "gpt-6-luna", "max"), "max");
  assert.equal(parsePreset("codex", "gpt-6-luna", "ultra"), null);
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

test("Built-in local plugins opt-in survives writes and launch hydration without changing provider configuration", () => {
  const base = {
    version: 1,
    runtime: "builtin",
    provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "http://localhost:9876/v1", apiKey: "test-key" },
    model: { kind: "custom", name: "test-model" },
    mode: { kind: "default" },
  };
  for (const enabled of [undefined, false, true]) {
    const runtimeConfig = { ...base, ...(enabled !== undefined ? { loadLocalPlugins: enabled } : {}) };
    const parsed = parseRuntimeConfig({ runtimeConfig });
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.config.runtime !== "builtin") throw new Error("Expected Built-in config");
    assert.equal(parsed.config.loadLocalPlugins, enabled);
    const hydrated = hydrateRuntimeConfig({ runtimeConfig: parsed.config });
    assert.equal(hydrated.runtime, "builtin");
    assert.ok(hydrated.runtime === "builtin");
    assert.equal(hydrated.loadLocalPlugins, enabled);
    assert.deepEqual(hydrated.provider, parsed.config.provider);
    assert.equal(hydrated.hostUserState, "forbidden");
  }
  assert.equal(parseRuntimeConfig({ runtimeConfig: { ...base, loadLocalPlugins: "true" } }).ok, false);
  assert.equal(parseRuntimeConfig({ runtimeConfig: { ...base, runtime: "pi", loadLocalPlugins: true } }).ok, false);
});

// artin 2026-09-27: every installed mobile client failed to save a model (PATCH
// 400 "runtimeConfig.loadLocalPlugins must be a boolean"). The mobile PATCH
// encoder (kotlinx.serialization, encodeDefaults + explicit nulls) sends every
// optional field, unset ones as null. These are the exact wire shapes.
const MOBILE_NULLS = { reasoningEffort: null, envVars: null, command: null, loadLocalPlugins: null, hostUserState: null };

test("mobile-serialized runtime configs with null optional fields are accepted", () => {
  const claude = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      ...MOBILE_NULLS,
    },
  });
  assert.equal(claude.ok, true, JSON.stringify(claude));

  const builtin = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "http://localhost:9876/v1", apiKey: "k", supportsImageInput: false },
      model: { kind: "custom", name: "test-model" },
      mode: { kind: "default" },
      ...MOBILE_NULLS,
    },
  });
  assert.equal(builtin.ok, true, JSON.stringify(builtin));
  if (!builtin.ok || builtin.config.runtime !== "builtin") throw new Error("Expected Built-in config");
  // A null never turns local extensions on.
  assert.equal(builtin.config.loadLocalPlugins, undefined);
  assert.equal(builtin.config.hostUserState, "forbidden");
});

test("only null is read as unset: wrong types for the two optional fields are still refused", () => {
  const base = {
    version: 1,
    runtime: "builtin",
    provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "http://localhost:9876/v1", apiKey: "k" },
    model: { kind: "custom", name: "test-model" },
    mode: { kind: "default" },
  };
  for (const bad of ["true", 1, 0, {}]) {
    assert.equal(parseRuntimeConfig({ runtimeConfig: { ...base, loadLocalPlugins: bad } }).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseRuntimeConfig({ runtimeConfig: { ...base, hostUserState: "allowed" } }).ok, false);
  assert.equal(parseRuntimeConfig({ runtimeConfig: { ...base, runtime: "claude", provider: { kind: "default" }, model: { kind: "preset", id: "sonnet" }, loadLocalPlugins: false } }).ok, false);
});

test("a Built-in custom model takes optional declared limits: bounded positive integers, only on builtin, and hydration keeps them (#proj-runtime:#50)", () => {
  const builtin = (model: Record<string, unknown>) => ({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "sk-test" },
      model: { kind: "custom", name: "devin/swe-2-flash", ...model },
      mode: { kind: "default" },
    },
  });
  const ok = parseRuntimeConfig(builtin({ contextWindow: 128_000, maxOutputTokens: 32_000 }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.config.model : null, { kind: "custom", name: "devin/swe-2-flash", contextWindow: 128_000, maxOutputTokens: 32_000 });
  assert.deepEqual(parseRuntimeConfig(builtin({ contextWindow: null })).ok && true, true, "null means not set");

  for (const bad of [{ contextWindow: 0 }, { contextWindow: 1.5 }, { contextWindow: "128000" }, { contextWindow: 20_000_000 }, { maxOutputTokens: -1 }, { contextWindow: 8000, maxOutputTokens: 9000 }]) {
    const result = parseRuntimeConfig(builtin(bad));
    assert.equal(result.ok, false, JSON.stringify(bad));
  }

  const onClaude = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://proxy.example.test", apiKey: "sk-test" },
      model: { kind: "custom", name: "my-model", contextWindow: 128_000 },
      mode: { kind: "default" },
    },
  });
  assert.equal(onClaude.ok, false, "only the builtin runtime takes them");

  const hydrated = hydrateRuntimeConfig({
    runtime: "builtin",
    model: "devin/swe-2-flash",
    runtimeConfig: builtin({ contextWindow: 128_000, maxOutputTokens: "lots" }).runtimeConfig,
  } as never);
  assert.deepEqual(hydrated.model, { kind: "custom", name: "devin/swe-2-flash", contextWindow: 128_000 }, "a valid stored limit is kept, an invalid one dropped");
});

test("Built-in OpenRouter accepts a typed model id with optional limits; other presets still refuse one (task #10)", () => {
  const openrouter = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-or-test" },
      model: { kind: "custom", name: "  vendor/new-model-2027  ", contextWindow: 262_144, maxOutputTokens: 32_768 },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });
  assert.equal(openrouter.ok, true);
  assert.deepEqual(openrouter.ok && openrouter.config.model, {
    kind: "custom",
    name: "vendor/new-model-2027",
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
  });
  assert.equal(openrouter.ok && runtimeConfigToLaunchFields(openrouter.config).model, "vendor/new-model-2027");

  const deepseek = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds-test" },
      model: { kind: "custom", name: "deepseek-v9" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });
  assert.equal(deepseek.ok, false);
  assert.match(deepseek.ok ? "" : deepseek.error, /custom is not supported for runtime: builtin/);

  // A preset model on OpenRouter is still checked against the catalog.
  const unlistedPreset = parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-or-test" },
      model: { kind: "preset", id: "openrouter/vendor/new-model-2027" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });
  assert.equal(unlistedPreset.ok, false);
});

test("an OpenRouter custom name in Raft's catalog form is normalized at the parser (task #10)", () => {
  const parse = (model: Record<string, unknown>) => parseRuntimeConfig({
    runtimeConfig: {
      version: 1 as const,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-or-test" },
      model,
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });
  // A listed catalog id sent as custom (v1/mobile/API/CLI) is that preset.
  const listed = parse({ kind: "custom", name: "openrouter/moonshotai/kimi-k2.6" });
  assert.deepEqual(listed.ok && listed.config.model, { kind: "preset", id: "openrouter/moonshotai/kimi-k2.6" });
  // With a limit (an explicit override) it is a custom model named by its
  // OpenRouter (Pi) id: Raft's openrouter/ namespace never reaches the provider.
  const listedWithLimits = parse({ kind: "custom", name: "openrouter/moonshotai/kimi-k2.6", contextWindow: 1000 });
  assert.deepEqual(listedWithLimits.ok && listedWithLimits.config.model, { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 1000 });
  // ... which parses to itself again, and gives the preset back once both limits are gone.
  const reparsed = parse({ kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 1000 });
  assert.deepEqual(reparsed.ok && reparsed.config.model, { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 1000 });
  const cleared = parse({ kind: "custom", name: "moonshotai/kimi-k2.6" });
  assert.deepEqual(cleared.ok && cleared.config.model, { kind: "preset", id: "openrouter/moonshotai/kimi-k2.6" });
  // Only one Raft prefix comes off: openrouter/openrouter/auto is OpenRouter's openrouter/auto.
  const router = parse({ kind: "custom", name: "openrouter/openrouter/auto", maxOutputTokens: 2048 });
  assert.deepEqual(router.ok && router.config.model, { kind: "custom", name: "openrouter/auto", maxOutputTokens: 2048 });
  const routerAgain = parse({ kind: "custom", name: "openrouter/auto", maxOutputTokens: 2048 });
  assert.deepEqual(routerAgain.ok && routerAgain.config.model, { kind: "custom", name: "openrouter/auto", maxOutputTokens: 2048 }, "a stored Pi id is never stripped again");
  // A bare openrouter/auto without a limit is the same model (API id
  // openrouter/auto), as its preset: never Pi's `auto`.
  const typedAuto = parse({ kind: "custom", name: "openrouter/auto" });
  assert.deepEqual(typedAuto.ok && typedAuto.config.model, { kind: "preset", id: "openrouter/openrouter/auto" });
  // An unlisted name is kept as typed, prefix and all: it is the API id given.
  const prefixed = parse({ kind: "custom", name: "openrouter/vendor/unlisted-2099", contextWindow: 4096 });
  assert.deepEqual(prefixed.ok && prefixed.config.model, { kind: "custom", name: "openrouter/vendor/unlisted-2099", contextWindow: 4096 });
  // OpenRouter's own router ids (one segment after the prefix) stay as typed.
  const unlistedRouter = parse({ kind: "custom", name: "openrouter/some-new-router" });
  assert.deepEqual(unlistedRouter.ok && unlistedRouter.config.model, { kind: "custom", name: "openrouter/some-new-router" });
});

// Huaihuai's review of 630ce01456: the model a name resolves to must not
// depend on its limits. Resolve custom.name to an OpenRouter API id first,
// ignoring limits; then the limits only decide preset vs custom.
test("an OpenRouter custom name keeps its model identity with and without limits (task #10)", () => {
  const parse = (model: Record<string, unknown>) => {
    const parsed = parseRuntimeConfig({
      runtimeConfig: {
        version: 1 as const,
        runtime: "builtin",
        provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-or-test" },
        model,
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: null,
      },
    });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.config.model;
  };
  /** The OpenRouter API id a parsed model runs: a custom name, or a preset catalog id minus Raft's one prefix. */
  const apiId = (model: ReturnType<typeof parse>) => model.kind === "custom" ? model.name : model.id.slice("openrouter/".length);

  // The counterexample, verbatim: openrouter/auto with a limit, then without.
  const limited = parse({ kind: "custom", name: "openrouter/auto", maxOutputTokens: 2048 });
  assert.equal(apiId(limited), "openrouter/auto");
  const unlimited = parse({ kind: "custom", name: "openrouter/auto" });
  assert.equal(apiId(unlimited), "openrouter/auto", "removing the limit must not switch to Pi's `auto`");
  assert.deepEqual(unlimited, { kind: "preset", id: "openrouter/openrouter/auto" });

  for (const [name, expected] of [
    ["openrouter/auto", "openrouter/auto"],
    ["openrouter/openrouter/auto", "openrouter/auto"],
    ["openrouter/moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
    ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.6"],
    ["auto", "auto"],
  ] as const) {
    const withLimit = parse({ kind: "custom", name, contextWindow: 8192 });
    const without = parse({ kind: "custom", name });
    assert.deepEqual(withLimit, { kind: "custom", name: expected, contextWindow: 8192 }, `${name} + limit`);
    assert.deepEqual(without, { kind: "preset", id: `openrouter/${expected}` }, `${name}, no limit`);
    // Saved and read again: the same config.
    assert.deepEqual(parse(withLimit as Record<string, unknown>), withLimit, `${name}: parse(parse(x)) == parse(x)`);
    // Clearing the limit of the saved config: the preset of the same model.
    const cleared = parse({ kind: "custom", name: (withLimit as { name: string }).name });
    assert.equal(apiId(cleared), expected, `${name}: clearing keeps the model`);
  }
  // Unlisted names are kept as typed (the name IS the API id), prefix and all.
  assert.deepEqual(parse({ kind: "custom", name: "openrouter/vendor/unlisted-2099" }), { kind: "custom", name: "openrouter/vendor/unlisted-2099" });
  assert.deepEqual(parse({ kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 }), { kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 });
});

test("runtimeSessionHomeEnvVars keeps only the env vars a runtime's session directory depends on", async () => {
  const { RUNTIME_SESSION_HOME_ENV_KEYS, runtimeSessionHomeEnvVars } = await import("./index");
  const envVars = { CODEX_HOME: "/srv/codex", GROK_HOME: "/srv/grok", KIMI_CODE_HOME: "/srv/kimi", ANTHROPIC_API_KEY: "sk-ant", HOME: "/home/agent" };
  assert.deepEqual(runtimeSessionHomeEnvVars("codex", envVars), { CODEX_HOME: "/srv/codex" });
  assert.deepEqual(runtimeSessionHomeEnvVars("grok", envVars), { GROK_HOME: "/srv/grok" });
  assert.deepEqual(runtimeSessionHomeEnvVars("kimi-sdk", envVars), { KIMI_CODE_HOME: "/srv/kimi" });
  // A runtime whose sessions do not move with its env vars sends none.
  assert.equal(runtimeSessionHomeEnvVars("claude", envVars), null);
  assert.equal(runtimeSessionHomeEnvVars("codex", { ANTHROPIC_API_KEY: "sk-ant" }), null);
  assert.equal(runtimeSessionHomeEnvVars("codex", null), null);
  assert.equal(runtimeSessionHomeEnvVars("codex", { CODEX_HOME: 7 }), null, "not a string: dropped");
  assert.deepEqual(Object.keys(RUNTIME_SESSION_HOME_ENV_KEYS).sort(), ["codex", "grok", "kimi-sdk"]);
});
