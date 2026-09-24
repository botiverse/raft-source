import assert from "node:assert/strict";
import { test } from "vitest";
import { AzureTranslationProvider } from "./azure.js";
import { TranslationPlaceholderValidationError, TranslationProviderError } from "../errors.js";
import { createRegexPlaceholderPolicy } from "../placeholderPolicy.js";

const placeholderPolicy = createRegexPlaceholderPolicy({
  name: "brace-placeholder-v1",
  pattern: /\{[A-Z0-9_:-]+\}/g,
});

test("AzureTranslationProvider maps batch items and emits structured provider version", async () => {
  const provider = new AzureTranslationProvider({
    endpoint: "https://translator.example.com/",
    apiKey: "test-key",
    region: "eastasia",
    fetchImpl: async (_input, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Ocp-Apim-Subscription-Key"], "test-key");
      assert.equal(init.headers["Ocp-Apim-Subscription-Region"], "eastasia");
      const url = new URL(String(_input));
      assert.equal(url.searchParams.get("to"), "zh-Hans");
      assert.equal(url.searchParams.get("from"), "en");
      assert.deepEqual(JSON.parse(init.body), [
        { text: "Hello {USER}" },
        { text: "Goodbye" },
      ]);
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            {
              detectedLanguage: { language: "en" },
              translations: [{ text: "你好 {USER}", to: "zh-Hans" }],
            },
            {
              translations: [{ text: "再见", to: "zh-Hans" }],
            },
          ];
        },
        async text() {
          return "";
        },
      };
    },
    placeholderPolicy,
  });

  const result = await provider.translateBatch([
    { key: "a", sourceText: "Hello {USER}", sourceLanguage: "en" },
    { key: "b", sourceText: "Goodbye", sourceLanguage: "en" },
  ], "zh-cn");

  assert.deepEqual(result.providerVersion, {
    provider: "azure-translator",
    apiVersion: "3.0",
    policyVersion: "azure-translator-v2",
  });
  assert.deepEqual(result.items, [
    {
      key: "a",
      sourceText: "Hello {USER}",
      translatedText: "你好 {USER}",
      sourceLanguage: "en",
      detectedSourceLanguage: "en",
      targetLanguage: "zh-cn",
    },
    {
      key: "b",
      sourceText: "Goodbye",
      translatedText: "再见",
      sourceLanguage: "en",
      targetLanguage: "zh-cn",
    },
  ]);
});

test("AzureTranslationProvider normalizes app language aliases for Azure", async () => {
  const seenUrls: string[] = [];
  const provider = new AzureTranslationProvider({
    endpoint: "https://translator.example.com",
    apiKey: "test-key",
    fetchImpl: async (input) => {
      seenUrls.push(String(input));
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ translations: [{ text: "Hello", to: "en" }] }];
        },
        async text() {
          return "";
        },
      };
    },
  });

  await provider.translateBatch([{ key: "a", sourceText: "你好", sourceLanguage: "zh" }], "en");
  assert.equal(new URL(seenUrls[0]).searchParams.get("to"), "en");
  assert.equal(new URL(seenUrls[0]).searchParams.has("from"), false);

  await provider.translateBatch([{ key: "b", sourceText: "Hello", sourceLanguage: "en" }], "zh-tw");
  assert.equal(new URL(seenUrls[1]).searchParams.get("to"), "zh-Hant");
  assert.equal(new URL(seenUrls[1]).searchParams.get("from"), "en");
});

test("AzureTranslationProvider rejects placeholder drift", async () => {
  const provider = new AzureTranslationProvider({
    endpoint: "https://translator.example.com",
    apiKey: "test-key",
    placeholderPolicy,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return [
          {
            translations: [{ text: "你好", to: "zh-Hans" }],
          },
        ];
      },
      async text() {
        return "";
      },
    }),
  });

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello {USER}" }], "zh-Hans"),
    (error: unknown) => error instanceof TranslationPlaceholderValidationError
      && error.disposition === "content_driven"
      && error.missingPlaceholders.includes("{USER}"),
  );
});

test("AzureTranslationProvider rejects mixed source languages in one batch", async () => {
  const provider = new AzureTranslationProvider({
    endpoint: "https://translator.example.com",
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("should not reach fetch");
    },
  });

  await assert.rejects(
    provider.translateBatch([
      { key: "a", sourceText: "Hello", sourceLanguage: "en" },
      { key: "b", sourceText: "Bonjour", sourceLanguage: "fr" },
    ], "zh-Hans"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.disposition === "content_driven"
      && error.code === "mixed_source_language_batch",
  );
});

test("AzureTranslationProvider classifies 429 as transient reserve release", async () => {
  const provider = new AzureTranslationProvider({
    endpoint: "https://translator.example.com",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async json() {
        return {};
      },
      async text() {
        return "rate limited";
      },
    }),
  });

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-Hans"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "azure_http_error"
      && error.disposition === "transient",
  );
});

test("AzureTranslationProvider classifies 400 as content-driven reserve retain", async () => {
  const provider = new AzureTranslationProvider({
    endpoint: "https://translator.example.com",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async json() {
        return {};
      },
      async text() {
        return "bad request";
      },
    }),
  });

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-Hans"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "azure_http_error"
      && error.disposition === "content_driven",
  );
});
