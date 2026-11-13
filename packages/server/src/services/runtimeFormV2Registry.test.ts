import assert from "node:assert/strict";
import { isRuntimeDeprecated, RUNTIME_CONFIG_VERSION, RUNTIMES, type RuntimeConfig } from "@botiverse/raft-shared";

import {
  buildRuntimeConfigFromFormValues,
  redactWriteOnlyRuntimeConfig,
  registerRuntimeFormV2EntryForTests,
  retainOmittedWriteOnlySecrets,
  runtimeFormV2RuntimeIds,
  buildRuntimeFormV2,
  validateRuntimeFormV2SubmitRef,
  type RuntimeFormV2Entry,
} from "./runtimeFormV2Registry";

test("the v2 registry holds exactly the runtimes that have a v2 form today", () => {
  assert.deepEqual(runtimeFormV2RuntimeIds().sort(), ["antigravity", "builtin", "claude", "codebuddy", "codex", "copilot", "cursor", "gemini", "grok", "kimi", "kimi-sdk", "opencode", "pi", "qoder", "qwen"]);
});

test("since batch 4 every runtime in the catalog has a v2 form", () => {
  assert.deepEqual(RUNTIMES.map((runtime) => runtime.id).filter((id) => !runtimeFormV2RuntimeIds().includes(id)), []);
});

test("deprecated runtimes keep a v2 form, labelled edit-only; the rest are create forms", () => {
  const deprecated = RUNTIMES.filter((runtime) => runtime.deprecated).map((runtime) => runtime.id);
  assert.deepEqual(deprecated, ["antigravity", "kimi", "copilot", "gemini"]);
  for (const runtimeId of ["antigravity", "kimi", "copilot", "gemini"]) {
    assert.equal(isRuntimeDeprecated(runtimeId), true, runtimeId);
    assert.equal(buildRuntimeFormV2(runtimeId).schemaVersion, `${runtimeId}.edit.v1`, runtimeId);
  }
  for (const runtimeId of ["opencode", "codex", "grok", "claude", "cursor", "pi"]) {
    assert.equal(buildRuntimeFormV2(runtimeId).schemaVersion, `${runtimeId}.create.v1`, runtimeId);
  }
});

test("a v2 submit names a runtime in the v2 registry, or is rejected with unknown_form_runtime", () => {
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 2, runtimeId: "builtin" }), []);
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 2, runtimeId: "kimi-sdk" }), []);
  for (const runtimeId of ["opencode", "kimi", "gemini", "antigravity", "codex", "grok", "claude", "cursor", "copilot", "pi"]) {
    assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 2, runtimeId }), [], runtimeId);
  }
  for (const runtimeId of ["not-a-runtime", "", 7, undefined]) {
    assert.deepEqual(
      validateRuntimeFormV2SubmitRef({ protocolVersion: 2, runtimeId }),
      [{ code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" }],
      String(runtimeId),
    );
    assert.deepEqual(
      buildRuntimeConfigFromFormValues(runtimeId, { model: "m" }),
      { ok: false, issue: { code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" } },
      String(runtimeId),
    );
  }
  assert.equal(validateRuntimeFormV2SubmitRef({ protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" })[0]?.code, "unsupported_form_protocol");
});

const builtinPreset = (apiKey: string): RuntimeConfig => ({
  version: RUNTIME_CONFIG_VERSION,
  runtime: "builtin",
  provider: { kind: "preset", providerId: "deepseek", apiKey },
  model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
  mode: { kind: "default" },
  reasoningEffort: null,
  envVars: null,
} as RuntimeConfig);

const builtinGateway = (baseUrl: string, apiKey: string): RuntimeConfig => ({
  version: RUNTIME_CONFIG_VERSION,
  runtime: "builtin",
  provider: { kind: "gateway", providerId: "openai-compatible", baseUrl, apiKey },
  model: { kind: "custom", name: "m" },
  mode: { kind: "default" },
  reasoningEffort: null,
  envVars: null,
} as RuntimeConfig);

const withoutApiKey = (config: RuntimeConfig) => {
  const { apiKey: _apiKey, ...provider } = (config as { provider: Record<string, unknown> }).provider;
  return { ...config, provider };
};

test("Built-in's provider secret is write-only through the generic mechanism: blanked on read, kept when omitted", () => {
  const stored = builtinPreset("sk-stored");
  assert.equal((redactWriteOnlyRuntimeConfig(stored) as { provider: { apiKey: string } }).provider.apiKey, "");
  assert.equal((stored as { provider: { apiKey: string } }).provider.apiKey, "sk-stored", "the stored config is not mutated");

  const kept = retainOmittedWriteOnlySecrets(withoutApiKey(builtinPreset("")), stored) as { provider: Record<string, unknown> };
  assert.equal(kept.provider.apiKey, "sk-stored");

  // A different provider, or an explicit value, never inherits the stored secret.
  const switched = { ...withoutApiKey(builtinPreset("")), provider: { kind: "preset", providerId: "openai" } };
  assert.equal("apiKey" in (retainOmittedWriteOnlySecrets(switched, stored) as { provider: object }).provider, false);
  assert.equal(
    (retainOmittedWriteOnlySecrets(builtinPreset(""), stored) as { provider: { apiKey: string } }).provider.apiKey,
    "",
    "an explicit blank reaches the parser and fails there",
  );
  // A gateway secret stays with its endpoint.
  const gateway = builtinGateway("https://a.example.test/v1", "sk-gateway");
  assert.equal(
    (retainOmittedWriteOnlySecrets(withoutApiKey(builtinGateway(" https://a.example.test/v1 ", "")), gateway) as { provider: Record<string, unknown> }).provider.apiKey,
    "sk-gateway",
  );
  assert.equal(
    "apiKey" in (retainOmittedWriteOnlySecrets(withoutApiKey(builtinGateway("https://b.example.test/v1", "")), gateway) as { provider: object }).provider,
    false,
  );
  // Managed connections carry no secret and are left alone.
  const connection = { ...stored, provider: { kind: "connection", connectionId: "c1" } } as RuntimeConfig;
  assert.equal(redactWriteOnlyRuntimeConfig(connection), connection);
  // Pre-registry output for released clients: a Built-in preset/gateway read
  // always carries apiKey "", even when nothing was stored (Argus, #8600).
  const keyless = { ...stored, provider: { ...(stored as unknown as { provider: Record<string, unknown> }).provider } } as unknown as { provider: Record<string, unknown> };
  delete keyless.provider.apiKey;
  assert.equal((redactWriteOnlyRuntimeConfig(keyless as unknown as RuntimeConfig) as unknown as { provider: { apiKey?: string } }).provider.apiKey, "");
});

test("any registered runtime can declare a write-only runtimeConfig path", () => {
  const entry: RuntimeFormV2Entry = {
    runtimeId: "not-a-runtime",
    buildForm: () => { throw new Error("unused"); },
    validateProjection: () => [],
    resolveOptionSource: async () => ({ kind: "source", source: null }),
    runtimeConfigFromValues: () => ({ ok: false, issue: { code: "unused", pointer: "/formValues" } }),
    valuesFromRuntimeConfig: () => null,
    writeOnlySecrets: [{ path: ["provider", "token"], appliesTo: () => true, keepsIdentity: (incoming, existing) =>
      (incoming.provider as { url?: unknown }).url === (existing.provider as { url?: unknown }).url }],
  };
  const stored = { runtime: "not-a-runtime", provider: { url: "https://x.example.test", token: "t-stored" } } as unknown as RuntimeConfig;
  const before = redactWriteOnlyRuntimeConfig(stored);
  assert.equal(before, stored, "undeclared runtimes are returned as stored");
  const unregister = registerRuntimeFormV2EntryForTests(entry);
  try {
    assert.deepEqual(redactWriteOnlyRuntimeConfig(stored), { runtime: "not-a-runtime", provider: { url: "https://x.example.test", token: "" } });
    assert.deepEqual(
      retainOmittedWriteOnlySecrets({ runtime: " not-a-runtime ", provider: { url: "https://x.example.test" } }, stored),
      { runtime: " not-a-runtime ", provider: { url: "https://x.example.test", token: "t-stored" } },
    );
    assert.deepEqual(
      retainOmittedWriteOnlySecrets({ runtime: "not-a-runtime", provider: { url: "https://y.example.test" } }, stored),
      { runtime: "not-a-runtime", provider: { url: "https://y.example.test" } },
    );
  } finally {
    unregister();
  }
  assert.equal(runtimeFormV2RuntimeIds().includes("not-a-runtime"), false, "the seam restores the registry");
});
