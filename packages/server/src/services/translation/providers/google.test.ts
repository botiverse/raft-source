import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";
import { GoogleTranslationProvider, parseGoogleServiceAccountJson } from "./google.js";
import { TranslationPlaceholderValidationError, TranslationProviderError } from "../errors.js";
import { createRegexPlaceholderPolicy } from "../placeholderPolicy.js";

const placeholderPolicy = createRegexPlaceholderPolicy({
  name: "brace-placeholder-v1",
  pattern: /\{[A-Z0-9_:-]+\}/g,
});

test("GoogleTranslationProvider maps batch items and emits structured provider version", async () => {
  const provider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    location: "global",
    accessToken: "access-token",
    fetchImpl: async (input, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer access-token");
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(init.headers["x-goog-user-project"], "slock-prod");
      const url = new URL(String(input));
      assert.equal(url.origin, "https://translate.googleapis.com");
      assert.equal(url.pathname, "/v3/projects/slock-prod/locations/global:translateText");
      assert.deepEqual(JSON.parse(init.body), {
        contents: ["Hello {USER}", "Goodbye"],
        mimeType: "text/plain",
        sourceLanguageCode: "en",
        targetLanguageCode: "zh-CN",
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            translations: [
              { translatedText: "你好 {USER}", detectedLanguageCode: "en" },
              { translatedText: "再见" },
            ],
          };
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
    provider: "google-cloud-translate",
    apiVersion: "v3",
    policyVersion: "google-cloud-translate-v1",
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

test("GoogleTranslationProvider normalizes language aliases and omits broad zh source", async () => {
  const seenBodies: unknown[] = [];
  const provider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    accessToken: "access-token",
    fetchImpl: async (_input, init) => {
      seenBodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return { translations: [{ translatedText: "Hello" }] };
        },
        async text() {
          return "";
        },
      };
    },
  });

  await provider.translateBatch([{ key: "a", sourceText: "你好", sourceLanguage: "zh" }], "en");
  await provider.translateBatch([{ key: "b", sourceText: "Hello", sourceLanguage: "en" }], "zh-tw");
  await provider.translateBatch([{ key: "c", sourceText: "Hello", sourceLanguage: "en" }], "pt-br");

  assert.deepEqual(seenBodies[0], {
    contents: ["你好"],
    mimeType: "text/plain",
    targetLanguageCode: "en",
  });
  assert.deepEqual(seenBodies[1], {
    contents: ["Hello"],
    mimeType: "text/plain",
    sourceLanguageCode: "en",
    targetLanguageCode: "zh-TW",
  });
  assert.deepEqual(seenBodies[2], {
    contents: ["Hello"],
    mimeType: "text/plain",
    sourceLanguageCode: "en",
    targetLanguageCode: "pt-BR",
  });
});

test("GoogleTranslationProvider supports explicit quota project header", async () => {
  const provider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    quotaProjectId: "slock-billing",
    accessToken: "access-token",
    fetchImpl: async (_input, init) => {
      assert.equal(init.headers["x-goog-user-project"], "slock-billing");
      return {
        ok: true,
        status: 200,
        async json() {
          return { translations: [{ translatedText: "你好" }] };
        },
        async text() {
          return "";
        },
      };
    },
  });

  await provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn");
});

test("GoogleTranslationProvider rejects placeholder drift", async () => {
  const provider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    accessToken: "access-token",
    placeholderPolicy,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { translations: [{ translatedText: "你好" }] };
      },
      async text() {
        return "";
      },
    }),
  });

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello {USER}" }], "zh-cn"),
    (error: unknown) => error instanceof TranslationPlaceholderValidationError
      && error.disposition === "content_driven"
      && error.missingPlaceholders.includes("{USER}"),
  );
});

test("GoogleTranslationProvider rejects mixed source languages in one batch", async () => {
  const provider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    accessToken: "access-token",
    fetchImpl: async () => {
      throw new Error("should not reach fetch");
    },
  });

  await assert.rejects(
    provider.translateBatch([
      { key: "a", sourceText: "Hello", sourceLanguage: "en" },
      { key: "b", sourceText: "Bonjour", sourceLanguage: "fr" },
    ], "zh-cn"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "mixed_source_language_batch"
      && error.disposition === "content_driven",
  );
});

test("GoogleTranslationProvider classifies provider failures", async () => {
  for (const status of [401, 403]) {
    const authFailureProvider = new GoogleTranslationProvider({
      projectId: "slock-prod",
      accessToken: "access-token",
      fetchImpl: async () => ({
        ok: false,
        status,
        async json() {
          return {};
        },
        async text() {
          return "auth failed";
        },
      }),
    });

    await assert.rejects(
      authFailureProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "google_http_error"
        && error.disposition === "transient",
    );
  }

  const rateLimitedProvider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    accessToken: "access-token",
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
    rateLimitedProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "google_http_error"
      && error.disposition === "transient",
  );

  const badRequestProvider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    accessToken: "access-token",
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
    badRequestProvider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "google_http_error"
      && error.disposition === "content_driven",
  );
});

test("GoogleTranslationProvider exchanges service account JWT for access token and reuses it", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: string[] = [];
  const provider = new GoogleTranslationProvider({
    projectId: "slock-prod",
    serviceAccount: {
      clientEmail: "translator@slock-prod.iam.gserviceaccount.com",
      privateKey: privateKeyPem,
    },
    now: () => new Date("2026-05-15T06:00:00.000Z"),
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        assert.ok(body.get("assertion"));
        return {
          ok: true,
          status: 200,
          async json() {
            return { access_token: "minted-token", expires_in: 3600 };
          },
          async text() {
            return "";
          },
        };
      }
      assert.equal(init.headers.authorization, "Bearer minted-token");
      return {
        ok: true,
        status: 200,
        async json() {
          return { translations: [{ translatedText: "你好" }] };
        },
        async text() {
          return "";
        },
      };
    },
  });

  await provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn");
  await provider.translateBatch([{ key: "b", sourceText: "Goodbye" }], "zh-cn");

  assert.equal(calls.filter((url) => url === "https://oauth2.googleapis.com/token").length, 1);
  assert.equal(calls.filter((url) => url.includes(":translateText")).length, 2);
});

test("parseGoogleServiceAccountJson accepts raw JSON and base64 JSON", () => {
  const raw = JSON.stringify({
    client_email: "translator@slock-prod.iam.gserviceaccount.com",
    private_key: "private-key",
  });

  assert.deepEqual(parseGoogleServiceAccountJson(raw), {
    clientEmail: "translator@slock-prod.iam.gserviceaccount.com",
    privateKey: "private-key",
  });
  assert.deepEqual(parseGoogleServiceAccountJson(Buffer.from(raw, "utf8").toString("base64")), {
    clientEmail: "translator@slock-prod.iam.gserviceaccount.com",
    privateKey: "private-key",
  });
});
