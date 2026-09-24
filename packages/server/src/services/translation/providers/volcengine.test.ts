import assert from "node:assert/strict";
import { test } from "vitest";
import { VolcengineTranslationProvider } from "./volcengine.js";
import { TranslationPlaceholderValidationError, TranslationProviderError } from "../errors.js";
import { createRegexPlaceholderPolicy } from "../placeholderPolicy.js";

const placeholderPolicy = createRegexPlaceholderPolicy({
  name: "brace-placeholder-v1",
  pattern: /\{[A-Z0-9_:-]+\}/g,
});

function buildProvider(fetchImpl: ConstructorParameters<typeof VolcengineTranslationProvider>[0]["fetchImpl"]) {
  return new VolcengineTranslationProvider({
    accessKeyId: "ak-test",
    secretAccessKey: "sk-test",
    fetchImpl,
    now: () => new Date("2026-05-13T06:00:00.000Z"),
    placeholderPolicy,
  });
}

test("VolcengineTranslationProvider signs TranslateText requests and maps batch results", async () => {
  const provider = buildProvider(async (input, init) => {
    assert.equal(init.method, "POST");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://translate.volcengineapi.com");
    assert.equal(url.searchParams.get("Action"), "TranslateText");
    assert.equal(url.searchParams.get("Version"), "2020-06-01");
    assert.equal(init.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(init.headers.host, "translate.volcengineapi.com");
    assert.equal(init.headers["x-date"], "20260513T060000Z");
    assert.match(init.headers["x-content-sha256"], /^[0-9a-f]{64}$/);
    assert.match(
      init.headers.authorization,
      /^HMAC-SHA256 Credential=ak-test\/20260513\/cn-north-1\/translate\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/,
    );
    assert.deepEqual(JSON.parse(init.body), {
      SourceLanguage: "en",
      TargetLanguage: "zh",
      TextList: ["Hello {USER}", "Goodbye"],
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ResponseMetadata: { Error: null },
          TranslationList: [
            { Translation: "你好 {USER}", DetectedSourceLanguage: "en" },
            { Translation: "再见", DetectedSourceLanguage: "en" },
          ],
        };
      },
      async text() {
        return "";
      },
    };
  });

  const result = await provider.translateBatch([
    { key: "a", sourceText: "Hello {USER}", sourceLanguage: "en" },
    { key: "b", sourceText: "Goodbye", sourceLanguage: "en" },
  ], "zh-cn");

  assert.deepEqual(result.providerVersion, {
    provider: "volcengine-translate",
    apiVersion: "2020-06-01",
    policyVersion: "volcengine-translate-v1",
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
      detectedSourceLanguage: "en",
      targetLanguage: "zh-cn",
    },
  ]);
});

test("VolcengineTranslationProvider normalizes Chinese aliases and omits source language when absent", async () => {
  const seenBodies: unknown[] = [];
  const provider = buildProvider(async (_input, init) => {
    seenBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return { TranslationList: [{ Translation: "Hello" }] };
      },
      async text() {
        return "";
      },
    };
  });

  await provider.translateBatch([{ key: "a", sourceText: "你好" }], "en");
  await provider.translateBatch([{ key: "b", sourceText: "Hello", sourceLanguage: "en" }], "zh-tw");

  assert.deepEqual(seenBodies[0], {
    TargetLanguage: "en",
    TextList: ["你好"],
  });
  assert.deepEqual(seenBodies[1], {
    SourceLanguage: "en",
    TargetLanguage: "zh-Hant",
    TextList: ["Hello"],
  });
});

test("VolcengineTranslationProvider rejects placeholder drift", async () => {
  const provider = buildProvider(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { TranslationList: [{ Translation: "你好" }] };
    },
    async text() {
      return "";
    },
  }));

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello {USER}" }], "zh"),
    (error: unknown) => error instanceof TranslationPlaceholderValidationError
      && error.disposition === "content_driven"
      && error.missingPlaceholders.includes("{USER}"),
  );
});

test("VolcengineTranslationProvider rejects mixed source languages in one batch", async () => {
  const provider = buildProvider(async () => {
    throw new Error("should not reach fetch");
  });

  await assert.rejects(
    provider.translateBatch([
      { key: "a", sourceText: "Hello", sourceLanguage: "en" },
      { key: "b", sourceText: "Bonjour", sourceLanguage: "fr" },
    ], "zh"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "mixed_source_language_batch"
      && error.disposition === "content_driven",
  );
});

test("VolcengineTranslationProvider enforces provider batch limits before request", async () => {
  const provider = buildProvider(async () => {
    throw new Error("should not reach fetch");
  });

  await assert.rejects(
    provider.translateBatch(
      Array.from({ length: 17 }, (_, index) => ({ key: `k${index}`, sourceText: "hello" })),
      "zh",
    ),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "volcengine_batch_too_large"
      && error.disposition === "content_driven",
  );

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "x".repeat(5_001) }], "zh"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "volcengine_batch_too_large"
      && error.disposition === "content_driven",
  );
});

test("VolcengineTranslationProvider classifies provider failures", async () => {
  const rateLimitedProvider = buildProvider(async () => ({
    ok: false,
    status: 429,
    async json() {
      return {};
    },
    async text() {
      return "rate limited";
    },
  }));

  await assert.rejects(
    rateLimitedProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "volcengine_http_error"
      && error.disposition === "transient",
  );

  const badRequestProvider = buildProvider(async () => ({
    ok: false,
    status: 400,
    async json() {
      return {};
    },
    async text() {
      return "bad request";
    },
  }));

  await assert.rejects(
    badRequestProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "volcengine_http_error"
      && error.disposition === "content_driven",
  );
});

test("VolcengineTranslationProvider classifies response metadata errors", async () => {
  const throttledProvider = buildProvider(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ResponseMetadata: {
          Error: {
            Code: "LimitExceeded.ResourceQuota-429",
            Message: "too many requests",
          },
        },
      };
    },
    async text() {
      return "";
    },
  }));

  await assert.rejects(
    throttledProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "volcengine_LimitExceeded.ResourceQuota-429"
      && error.disposition === "transient",
  );

  const invalidProvider = buildProvider(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ResponseMetadata: {
          Error: {
            Code: "InvalidParameter.TargetLanguage",
            Message: "bad language",
          },
        },
      };
    },
    async text() {
      return "";
    },
  }));

  await assert.rejects(
    invalidProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "not-a-language"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "volcengine_InvalidParameter.TargetLanguage"
      && error.disposition === "content_driven",
  );
});
