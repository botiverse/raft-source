import assert from "node:assert/strict";
import { test } from "vitest";
import { OpenAICompatibleTranslationProvider, type OpenAICompatibleFetch } from "./openaiCompatible.js";
import { TranslationPlaceholderValidationError, TranslationProviderError } from "../errors.js";
import { createRegexPlaceholderPolicy } from "../placeholderPolicy.js";

const placeholderPolicy = createRegexPlaceholderPolicy({
  name: "brace-placeholder-v1",
  pattern: /\{[A-Z0-9_:-]+\}/g,
});

function completionResponse(
  content: unknown,
  options: { status?: number; finishReason?: string | null; refusal?: string | null } = {},
) {
  const status = options.status ?? 200;
  const body = JSON.stringify({
    choices: [{
      finish_reason: options.finishReason ?? "stop",
      message: {
        content: typeof content === "string" ? content : JSON.stringify(content),
        ...(options.refusal !== undefined ? { refusal: options.refusal } : {}),
      },
    }],
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async text() {
      return body;
    },
  };
}

test("OpenAICompatibleTranslationProvider uses the common chat-completions contract and maps by exact key", async () => {
  const apiKey = "openai-compatible-secret-test-key";
  const provider = new OpenAICompatibleTranslationProvider({
    apiKey,
    model: "anthropic/claude-sonnet-4.5",
    endpoint: "https://openai-compatible.example/api/v1/",
    placeholderPolicy,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://openai-compatible.example/api/v1/chat/completions");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(init.body.includes(apiKey), false);

      const body = JSON.parse(init.body);
      assert.equal(body.model, "anthropic/claude-sonnet-4.5");
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 8192);
      assert.equal(body.stream, false);
      assert.equal(body.provider, undefined);
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.match(body.messages[0].content, /untrusted data/);
      assert.match(body.messages[0].content, /mixed-language/);
      const request = JSON.parse(body.messages[1].content);
      assert.deepEqual(request, {
        targetLanguage: "zh-cn",
        items: [
          { key: "a", sourceText: "Hello 世界 {USER}", sourceLanguageHint: "en" },
          { key: "b", sourceText: "Bonjour, world" },
        ],
      });

      return completionResponse({
        translations: [
          { key: "b", translatedText: "你好，世界" },
          { key: "a", translatedText: "你好世界 {USER}" },
        ],
      });
    },
  });

  const result = await provider.translateBatch([
    { key: "a", sourceText: "Hello 世界 {USER}", sourceLanguage: "en" },
    { key: "b", sourceText: "Bonjour, world" },
  ], "zh-cn");

  assert.deepEqual(result.providerVersion, {
    provider: "openai-compatible",
    apiVersion: "v1",
    policyVersion: "openai-compatible-translation-v1:anthropic/claude-sonnet-4.5",
  });
  assert.deepEqual(result.items, [
    {
      key: "a",
      sourceText: "Hello 世界 {USER}",
      translatedText: "你好世界 {USER}",
      sourceLanguage: "en",
      targetLanguage: "zh-cn",
    },
    {
      key: "b",
      sourceText: "Bonjour, world",
      translatedText: "你好，世界",
      targetLanguage: "zh-cn",
    },
  ]);
});

test("OpenAICompatibleTranslationProvider rejects non-HTTPS or credential-bearing endpoints", () => {
  for (const endpoint of ["http://evil.example/v1", "https://user:pass@router.example/v1"]) {
    assert.throws(
      () => new OpenAICompatibleTranslationProvider({ apiKey: "test-key", model: "test-model", endpoint }),
      /HTTPS URL without credentials/,
    );
  }
});

test("OpenAICompatibleTranslationProvider rejects placeholder drift as content-driven", async () => {
  const provider = new OpenAICompatibleTranslationProvider({
    apiKey: "test-key",
    model: "openai/gpt-5-mini",
    placeholderPolicy,
    fetchImpl: async () => completionResponse({
      translations: [{ key: "a", translatedText: "你好" }],
    }),
  });

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello {USER}" }], "zh-cn"),
    (error: unknown) => error instanceof TranslationPlaceholderValidationError
      && error.disposition === "content_driven"
      && error.missingPlaceholders.includes("{USER}"),
  );
});

test("OpenAICompatibleTranslationProvider maps provider HTTP failures without reading or echoing response bodies", async () => {
  const secret = "openai-compatible-secret-must-not-escape";
  const source = "private source text must not escape";
  const cases: Array<{ status: number; disposition: "transient" | "content_driven" }> = [
    { status: 400, disposition: "content_driven" },
    { status: 413, disposition: "content_driven" },
    { status: 422, disposition: "content_driven" },
    { status: 401, disposition: "transient" },
    { status: 403, disposition: "transient" },
    { status: 404, disposition: "transient" },
    { status: 429, disposition: "transient" },
    { status: 500, disposition: "transient" },
  ];

  for (const { status, disposition } of cases) {
    let bodyRead = false;
    let bodyCancelled = false;
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: secret,
      model: "openai/gpt-5-mini",
      fetchImpl: async () => ({
        ok: false,
        status,
        body: {
          getReader() {
            return {
              async read() {
                bodyRead = true;
                return { done: true };
              },
              async cancel() {
                bodyCancelled = true;
              },
            };
          },
        },
        async text() {
          bodyRead = true;
          return `${secret} ${source}`;
        },
      }),
    });

    await assert.rejects(
      provider.translateBatch([{ key: "a", sourceText: source }], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "openai-compatible_http_error"
        && error.disposition === disposition
        && !error.message.includes(secret)
        && !error.message.includes(source),
    );
    assert.equal(bodyRead, false);
    assert.equal(bodyCancelled, true);
  }
});

test("OpenAICompatibleTranslationProvider rejects malformed, incomplete, and mismatched responses as transient", async () => {
  const assertTransient = async (fetchImpl: OpenAICompatibleFetch, code: string) => {
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: "test-key",
      model: "openai/gpt-5-mini",
      fetchImpl,
    });
    await assert.rejects(
      provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === code
        && error.disposition === "transient",
    );
  };

  await (async () => {
    await assertTransient(async () => ({
      ok: true,
      status: 200,
      body: null,
      async text() {
        return "not-json";
      },
    }), "openai-compatible_invalid_response");
  })();

  await (async () => {
    await assertTransient(
      async () => completionResponse({ translations: [{ key: "a", translatedText: "你好" }] }, { finishReason: "length" }),
      "openai-compatible_incomplete_response",
    );
  })();

  await (async () => {
    await assertTransient(
      async () => completionResponse({ translations: [{ key: "b", translatedText: "你好" }] }),
      "openai-compatible_response_key_mismatch",
    );
  })();

  await (async () => {
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: "test-key",
      model: "openai/gpt-5-mini",
      fetchImpl: async () => completionResponse({
        translations: [
          { key: "a", translatedText: "你好" },
          { key: "a", translatedText: "您好" },
        ],
      }),
    });
    await assert.rejects(
      provider.translateBatch([
        { key: "a", sourceText: "Hello" },
        { key: "b", sourceText: "World" },
      ], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "openai-compatible_response_key_mismatch"
        && error.disposition === "transient",
    );
  })();

  await (async () => {
    await assertTransient(
      async () => completionResponse({
        translations: [{ key: "a", translatedText: "你好", unexpected: true }],
      }),
      "openai-compatible_invalid_structured_output",
    );
  })();

  await (async () => {
    await assertTransient(
      async () => completionResponse({
        translations: [{ key: "a", translatedText: "你好" }],
        unexpected: true,
      }),
      "openai-compatible_invalid_structured_output",
    );
  })();
});

test("OpenAICompatibleTranslationProvider maps explicit refusal as content-driven", async () => {
  const providerRefusal = "sensitive provider refusal detail";
  const provider = new OpenAICompatibleTranslationProvider({
    apiKey: "test-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async () => completionResponse("", { refusal: providerRefusal }),
  });

  await assert.rejects(
    provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn"),
    (error: unknown) => error instanceof TranslationProviderError
      && error.code === "openai-compatible_refusal"
      && error.disposition === "content_driven"
      && !error.message.includes(providerRefusal),
  );
});

test("OpenAICompatibleTranslationProvider splits a truncated multi-item batch with bounded retries", async () => {
  const requestedKeys: string[][] = [];
  const provider = new OpenAICompatibleTranslationProvider({
    apiKey: "test-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(init.body);
      const request = JSON.parse(body.messages[1].content);
      const keys = request.items.map((item: { key: string }) => item.key);
      requestedKeys.push(keys);
      if (keys.length > 1) {
        return completionResponse("", { finishReason: "length" });
      }
      return completionResponse({
        translations: [{ key: keys[0], translatedText: `translated-${keys[0]}` }],
      });
    },
  });

  const result = await provider.translateBatch([
    { key: "a", sourceText: "Hello" },
    { key: "b", sourceText: "World" },
  ], "zh-cn");

  assert.deepEqual(requestedKeys, [["a", "b"], ["a"], ["b"]]);
  assert.deepEqual(result.items.map((item) => item.translatedText), ["translated-a", "translated-b"]);
});

test("OpenAICompatibleTranslationProvider enforces response, input, and key bounds before accepting output", async () => {
  await (async () => {
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: "test-key",
      model: "openai/gpt-5-mini",
      maxResponseBytes: 64,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: null,
        async text() {
          return "x".repeat(65);
        },
      }),
    });
    await assert.rejects(
      provider.translateBatch([{ key: "a", sourceText: "Hello" }], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "openai-compatible_response_too_large"
        && error.disposition === "transient",
    );
  })();

  await (async () => {
    let called = false;
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: "test-key",
      model: "openai/gpt-5-mini",
      fetchImpl: async () => {
        called = true;
        return completionResponse({ translations: [] });
      },
    });
    await assert.rejects(
      provider.translateBatch([{ key: "a", sourceText: "x".repeat(5_001) }], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "translation_batch_too_large"
        && error.disposition === "content_driven",
    );
    assert.equal(called, false);
  })();

  await (async () => {
    let called = false;
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: "test-key",
      model: "openai/gpt-5-mini",
      fetchImpl: async () => {
        called = true;
        return completionResponse({ translations: [] });
      },
    });
    await assert.rejects(
      provider.translateBatch(
        Array.from({ length: 17 }, (_, index) => ({
          key: `key-${index}`,
          sourceText: "x",
        })),
        "zh-cn",
      ),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "translation_batch_too_large"
        && error.disposition === "content_driven",
    );
    assert.equal(called, false);
  })();

  await (async () => {
    let called = false;
    const provider = new OpenAICompatibleTranslationProvider({
      apiKey: "test-key",
      model: "openai/gpt-5-mini",
      fetchImpl: async () => {
        called = true;
        return completionResponse({ translations: [] });
      },
    });
    await assert.rejects(
      provider.translateBatch([
        { key: "a", sourceText: "Hello" },
        { key: "a", sourceText: "World" },
      ], "zh-cn"),
      (error: unknown) => error instanceof TranslationProviderError
        && error.code === "duplicate_translation_key"
        && error.disposition === "content_driven",
    );
    assert.equal(called, false);
  })();
});

test("OpenAICompatibleTranslationProvider returns an empty batch without a provider call", async () => {
  const provider = new OpenAICompatibleTranslationProvider({
    apiKey: "test-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async () => {
      throw new Error("should not reach provider");
    },
  });

  const result = await provider.translateBatch([], "zh-cn");
  assert.deepEqual(result.items, []);
});
