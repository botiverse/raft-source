import assert from "node:assert/strict";
import {
  isTranslationProviderConfigured,
  resolveProviderFromEnv,
} from "./messageTranslationService";

const TRANSLATION_ENV_KEYS = [
  "TRANSLATION_PROVIDER",
  "TRANSLATION_SSM_ENVIRONMENT",
  "TRANSLATION_AZURE_ENDPOINT",
  "TRANSLATION_AZURE_API_KEY",
  "TRANSLATION_GOOGLE_PROJECT_ID",
  "TRANSLATION_GOOGLE_ACCESS_TOKEN",
  "TRANSLATION_GOOGLE_SERVICE_ACCOUNT_JSON",
  "TRANSLATION_GOOGLE_CLIENT_EMAIL",
  "TRANSLATION_GOOGLE_PRIVATE_KEY",
] as const;

async function withTranslationEnv(
  overrides: Partial<Record<(typeof TRANSLATION_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map(TRANSLATION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TRANSLATION_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    await fn();
  } finally {
    for (const key of TRANSLATION_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Google translation remains configured and resolves to the Google provider", async () => {
  await withTranslationEnv({
    TRANSLATION_PROVIDER: "google",
    TRANSLATION_GOOGLE_PROJECT_ID: "test-project",
    TRANSLATION_GOOGLE_ACCESS_TOKEN: "synthetic-token",
  }, async () => {
    assert.equal(isTranslationProviderConfigured(), true);
    const resolved = resolveProviderFromEnv();
    assert.deepEqual(resolved.provider.providerVersion, {
      provider: "google-cloud-translate",
      apiVersion: "v3",
      policyVersion: "google-cloud-translate-v1",
    });
    assert.equal(resolved.placeholderPolicyVersion, "brace-placeholder-v1");
  });
});

test("removed and unknown providers cannot silently fall back to configured Azure", async () => {
  for (const provider of ["openai-compatible", "unknown"]) await withTranslationEnv({
    TRANSLATION_PROVIDER: provider,
    TRANSLATION_AZURE_ENDPOINT: "https://example.invalid",
    TRANSLATION_AZURE_API_KEY: "synthetic-key",
  }, async () => {
    assert.equal(isTranslationProviderConfigured(), false);
    assert.throws(() => resolveProviderFromEnv(), /Unsupported translation provider/);
  });
});

test("legacy SSM configuration cannot silently switch to Google", async () => {
  await withTranslationEnv({
    TRANSLATION_PROVIDER: "google",
    TRANSLATION_GOOGLE_PROJECT_ID: "test-project",
    TRANSLATION_GOOGLE_ACCESS_TOKEN: "synthetic-token",
    TRANSLATION_SSM_ENVIRONMENT: "staging",
  }, async () => {
    assert.equal(isTranslationProviderConfigured(), false);
    assert.throws(() => resolveProviderFromEnv(), /Translation SSM configuration is no longer supported/);
  });
});

test("Azure remains the default when no provider is explicitly selected", async () => {
  await withTranslationEnv({
    TRANSLATION_AZURE_ENDPOINT: "https://example.invalid",
    TRANSLATION_AZURE_API_KEY: "synthetic-key",
  }, async () => {
    assert.equal(isTranslationProviderConfigured(), true);
    assert.equal(resolveProviderFromEnv().provider.providerVersion.provider, "azure-translator");
  });
});
