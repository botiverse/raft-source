import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRuntimeProviderModelLabel,
  getRuntimeProviderDisplayName,
  RUNTIME_MODELS,
  RUNTIME_PROVIDER_DISPLAY_NAMES,
} from "./index.js";

test("provider display names come from the generated shared table", () => {
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES.openrouter, "OpenRouter");
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES.opencode, "OpenCode Zen");
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES["opencode-go"], "OpenCode Go");
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES["kimi-coding"], "Kimi For Coding");
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES.moonshotai, "Moonshot AI");
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES["zai-coding-cn"], "Z.AI Coding CN");
  assert.equal(RUNTIME_PROVIDER_DISPLAY_NAMES.xiaomi, "Xiaomi");
  assert.equal(getRuntimeProviderDisplayName("deepseek"), "DeepSeek");
  assert.equal(getRuntimeProviderDisplayName("unknown-provider"), "Unknown Provider");
});

test("provider-routed model labels use shared provider display names", () => {
  assert.equal(formatRuntimeProviderModelLabel("opencode/gpt-5-nano"), "GPT 5 Nano · OpenCode Zen");
  assert.equal(
    formatRuntimeProviderModelLabel("opencode-go/deepseek-v4-pro"),
    "DeepSeek V4 Pro · OpenCode Go",
  );
  assert.equal(formatRuntimeProviderModelLabel("openai/gpt-5.5"), "GPT 5.5 · OpenAI");
  assert.equal(
    formatRuntimeProviderModelLabel("openrouter/anthropic/claude-opus-4.5"),
    "Claude Opus 4.5 · Anthropic via OpenRouter",
  );
  assert.equal(formatRuntimeProviderModelLabel("fusecode/opus[1m]"), "Opus 1M · FuseCode");
  assert.equal(formatRuntimeProviderModelLabel("unknown-provider/glm-5-air"), "GLM 5 Air · Unknown Provider");
});

test("static OpenCode fallback catalog uses the shared formatter", () => {
  assert.deepEqual(
    RUNTIME_MODELS.opencode.map((model) => model.label),
    [
      "Configured Default / Auto",
      "DeepSeek V4 Pro · DeepSeek",
      "Claude Opus 4.5 · Anthropic via OpenRouter",
      "Opus 1M · FuseCode",
    ],
  );
});
