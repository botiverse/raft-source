import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isTranslationProviderConfigured,
  resolveProviderFromEnv,
} from "./messageTranslationService.js";

const OPENAI_COMPATIBLE_ENV_KEYS = [
  "TRANSLATION_PROVIDER",
  "TRANSLATION_OPENAI_COMPATIBLE_API_KEY",
  "TRANSLATION_OPENAI_COMPATIBLE_MODEL",
  "TRANSLATION_OPENAI_COMPATIBLE_ENDPOINT",
  "TRANSLATION_SSM_ENVIRONMENT",
] as const;

async function withOpenAICompatibleEnv(
  overrides: Partial<Record<(typeof OPENAI_COMPATIBLE_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map(OPENAI_COMPATIBLE_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of OPENAI_COMPATIBLE_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    await fn();
  } finally {
    for (const key of OPENAI_COMPATIBLE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolveProviderFromEnv binds OpenAICompatible key and model to the server-side provider identity", async () => {
  await withOpenAICompatibleEnv({
    TRANSLATION_PROVIDER: "openai-compatible",
    TRANSLATION_OPENAI_COMPATIBLE_API_KEY: "test-openai-compatible-server-only-key",
    TRANSLATION_OPENAI_COMPATIBLE_MODEL: "openai/gpt-5-mini",
  }, async () => {
    assert.equal(isTranslationProviderConfigured(), true);
    const resolved = resolveProviderFromEnv();
    assert.deepEqual(resolved.provider.providerVersion, {
      provider: "openai-compatible",
      apiVersion: "v1",
      policyVersion: "openai-compatible-translation-v1:openai/gpt-5-mini",
    });
    assert.equal(resolved.placeholderPolicyVersion, "brace-placeholder-v1");
  });
});

test("OpenAICompatible configuration fails closed when either secret-injected value is absent", async () => {
  await withOpenAICompatibleEnv({
    TRANSLATION_PROVIDER: "openai-compatible",
    TRANSLATION_OPENAI_COMPATIBLE_API_KEY: "test-openai-compatible-server-only-key",
  }, async () => {
    assert.equal(isTranslationProviderConfigured(), false);
    assert.throws(
      () => resolveProviderFromEnv(),
      (error: unknown) => error instanceof Error
        && error.message.includes("TRANSLATION_OPENAI_COMPATIBLE_MODEL")
        && !error.message.includes("test-openai-compatible-server-only-key"),
    );
  });
});
