import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CachedTranslationSsmConfig,
  loadTranslationSsmConfig,
  translationSsmEnvironment,
  translationSsmParameterNames,
  type TranslationSsmReader,
} from "./ssmConfig.js";

function fakeReader(values: Record<string, string>, calls: Array<{ names: string[]; withDecryption: boolean }>): TranslationSsmReader {
  return {
    async getParameters(names, withDecryption) {
      calls.push({ names: [...names], withDecryption });
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
  };
}

test("SSM parameter names are pinned to the selected environment", () => {
  assert.deepEqual(translationSsmParameterNames("staging"), {
    provider: "/slock/staging/translation/provider",
    endpoint: "/slock/staging/translation/endpoint",
    model: "/slock/staging/translation/model",
    apiKey: "/slock/staging/translation/api-key",
  });
  assert.equal(translationSsmEnvironment({ TRANSLATION_SSM_ENVIRONMENT: "PRODUCTION" }), "production");
  assert.throws(() => translationSsmEnvironment({ TRANSLATION_SSM_ENVIRONMENT: "preview" }), /must be staging or production/);
});

test("SSM loads plain settings without decryption and token with decryption", async () => {
  const names = translationSsmParameterNames("staging");
  const calls: Array<{ names: string[]; withDecryption: boolean }> = [];
  const config = await loadTranslationSsmConfig(fakeReader({
    [names.provider]: "openai-compatible",
    [names.endpoint]: "https://router.example/v1",
    [names.model]: "provider/model",
    [names.apiKey]: "secret-value",
  }, calls), { TRANSLATION_SSM_ENVIRONMENT: "staging" });
  assert.deepEqual(config, {
    provider: "openai-compatible",
    endpoint: "https://router.example/v1",
    model: "provider/model",
    apiKey: "secret-value",
  });
  assert.deepEqual(calls, [
    { names: [names.provider, names.endpoint, names.model], withDecryption: false },
    { names: [names.apiKey], withDecryption: true },
  ]);
});

test("missing SSM values fail closed without echoing secret material", async () => {
  const names = translationSsmParameterNames("staging");
  const secret = "do-not-echo-this-token";
  await assert.rejects(
    () => loadTranslationSsmConfig(fakeReader({ [names.apiKey]: secret }, []), { TRANSLATION_SSM_ENVIRONMENT: "staging" }),
    (error: unknown) => error instanceof Error
      && error.message === "translation SSM configuration is incomplete"
      && !error.message.includes(secret),
  );
});

test("cached SSM configuration coalesces reads, expires, and supports explicit rotation", async () => {
  const names = translationSsmParameterNames("staging");
  let now = 1000;
  const calls: Array<{ names: string[]; withDecryption: boolean }> = [];
  const values = {
    [names.provider]: "openai-compatible",
    [names.endpoint]: "https://router.example/v1",
    [names.model]: "provider/model",
    [names.apiKey]: "secret-one",
  };
  const cache = new CachedTranslationSsmConfig(fakeReader(values, calls), { TRANSLATION_SSM_ENVIRONMENT: "staging" }, 100, () => now);
  const first = await Promise.all([cache.get(), cache.get()]);
  assert.equal(first[0].apiKey, "secret-one");
  assert.equal(calls.length, 2);
  assert.equal((await cache.get()).apiKey, "secret-one");
  now += 101;
  assert.equal((await cache.get()).apiKey, "secret-one");
  assert.equal(calls.length, 4);
  values[names.apiKey] = "secret-two";
  cache.invalidate();
  assert.equal((await cache.get()).apiKey, "secret-two");
});
