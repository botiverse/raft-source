/**
 * `writeOnlyKeepRequiresUnchanged` on the v2 edit form: the fields a stored
 * write-only secret is bound to, so a client can ask for a new secret before
 * submit instead of learning from the server's 400 api_key_required.
 *
 * The declared fields must be exactly what the secret's keepsIdentity checks:
 * changing a declared field alone makes keepsIdentity false, and changing any
 * other field (or a declared field only by whitespace / a trailing slash, the
 * contract's comparison) keeps it true. A new field or a keepsIdentity change
 * that is not reflected in the declaration turns this red.
 */
import assert from "node:assert/strict";

import {
  buildRuntimeFormV2EditBody,
  runtimeFormV2Entry,
  runtimeFormV2WriteOnlyKeepRequiresUnchanged,
} from "./runtimeFormV2Registry";

type Mutations = Record<string, unknown>;

type Case = {
  runtimeId: string;
  /** Field values of the stored agent, with the secret filled so it builds. */
  base: Record<string, unknown>;
  /** One alternative value per declared field. */
  declared: Mutations;
  /** One alternative value per every other non-secret field. */
  undeclared: Mutations;
  /** Values the contract's comparison treats as unchanged. */
  equivalent: Mutations[];
};

const CASES: Case[] = [
  {
    runtimeId: "claude",
    base: {
      provider: "custom", apiUrl: "https://gw.example.test", apiKey: "sk-stored", model: "sonnet",
      reasoningEffort: "high", fastMode: true, command: "/usr/local/bin/claude", envVars: { A: "1" },
    },
    declared: { provider: "default", apiUrl: "https://other.example.test" },
    undeclared: { authType: "auth_token", model: "opus", reasoningEffort: "low", fastMode: false, command: "claude", envVars: { B: "2" } },
    equivalent: [{ apiUrl: "https://gw.example.test/" }, { apiUrl: "  https://gw.example.test//  " }],
  },
  {
    runtimeId: "pi",
    base: {
      provider: "deepseek", apiKey: "sk-stored", providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "high",
      model: "default", reasoningEffort: "", envVars: { A: "1" },
    },
    declared: { provider: "configured" },
    undeclared: {
      providerModel: "deepseek/deepseek-flash", providerReasoningEffort: "low", model: "other", reasoningEffort: "low", envVars: { B: "2" },
    },
    equivalent: [{ provider: " deepseek " }],
  },
  {
    runtimeId: "builtin",
    base: {
      providerId: "openai-compatible", baseUrl: "https://gw.example.test/v1", apiKey: "sk-stored", supportsImageInput: false,
      loadLocalPlugins: false, model: "example-model", envVars: { A: "1" },
    },
    declared: { providerId: "anthropic-compatible", baseUrl: "https://other.example.test/v1" },
    undeclared: { reasoningEffort: "xhigh", supportsImageInput: true, loadLocalPlugins: true, model: "other-model", envVars: { B: "2" }, contextWindow: "64000", maxOutputTokens: "16000" },
    equivalent: [{ baseUrl: "https://gw.example.test/v1/" }, { baseUrl: " https://gw.example.test/v1 " }],
  },
];

function configFrom(runtimeId: string, values: Record<string, unknown>): Record<string, unknown> {
  const entry = runtimeFormV2Entry(runtimeId)!;
  const envVars = (values.envVars ?? null) as Record<string, string> | null;
  const built = entry.runtimeConfigFromValues(values, envVars, {});
  assert.ok(built.ok, `${runtimeId} ${JSON.stringify(values)}: ${JSON.stringify(!built.ok && built.issue)}`);
  return built.runtimeConfig;
}

/** keepsIdentity for an update that omits the secret, with `change` applied to the stored values. */
function keeps(testCase: Case, change: Mutations): boolean {
  const entry = runtimeFormV2Entry(testCase.runtimeId)!;
  const [secret] = entry.writeOnlySecrets!;
  const existing = configFrom(testCase.runtimeId, testCase.base);
  const incoming = configFrom(testCase.runtimeId, { ...testCase.base, ...change, apiKey: "sk-only-to-build" });
  const provider = { ...(incoming.provider as Record<string, unknown>) };
  delete provider.apiKey;
  return secret!.keepsIdentity({ ...incoming, provider }, existing);
}

for (const testCase of CASES) {
  test(`${testCase.runtimeId}: the declared bound fields are exactly what keepsIdentity checks`, () => {
    const declared = runtimeFormV2WriteOnlyKeepRequiresUnchanged(testCase.runtimeId);
    const bound = declared?.["/apiKey"]?.map((pointer) => pointer.slice(1)) ?? [];
    assert.deepEqual([...bound].sort(), Object.keys(testCase.declared).sort(), "declaration vs the test's table");
    // The table covers every field of the form, so a new field must be classified.
    const fields = Object.keys(runtimeFormV2Entry(testCase.runtimeId)!.buildForm().dataSchema.properties);
    assert.deepEqual(
      [...fields].sort(),
      ["apiKey", ...Object.keys(testCase.declared), ...Object.keys(testCase.undeclared)].sort(),
      "every form field is either the secret, declared or undeclared",
    );

    assert.equal(keeps(testCase, {}), true, "unchanged");
    for (const [key, value] of Object.entries(testCase.declared)) {
      assert.equal(keeps(testCase, { [key]: value }), false, `declared ${key} changed alone`);
    }
    for (const [key, value] of Object.entries(testCase.undeclared)) {
      assert.equal(keeps(testCase, { [key]: value }), true, `undeclared ${key} changed alone`);
    }
    for (const change of testCase.equivalent) {
      assert.equal(keeps(testCase, change), true, `equivalent ${JSON.stringify(change)}`);
    }
  });
}

test("the edit body carries writeOnlyKeepRequiresUnchanged only for runtimes with a bound secret; values never carry the secret", () => {
  const claude = buildRuntimeFormV2EditBody("claude", {
    runtime: "claude", provider: { kind: "custom", apiUrl: "https://gw.example.test", apiKey: "sk-secret" },
    model: { kind: "preset", id: "sonnet" }, envVars: {},
  });
  assert.ok(claude);
  assert.deepEqual(claude.writeOnlyKeepRequiresUnchanged, { "/apiKey": ["/provider", "/apiUrl"] });
  assert.equal(JSON.stringify(claude).includes("sk-secret"), false);
  assert.deepEqual(runtimeFormV2WriteOnlyKeepRequiresUnchanged("pi"), { "/apiKey": ["/provider"] });
  assert.deepEqual(runtimeFormV2WriteOnlyKeepRequiresUnchanged("builtin"), { "/apiKey": ["/providerId", "/baseUrl"] });
  for (const runtimeId of ["codex", "cursor", "opencode", "kimi-sdk"]) {
    assert.equal(runtimeFormV2WriteOnlyKeepRequiresUnchanged(runtimeId), undefined, runtimeId);
  }
  const codex = buildRuntimeFormV2EditBody("codex", { runtime: "codex", model: { kind: "preset", id: "gpt-5.5" }, envVars: {} });
  assert.ok(codex);
  assert.equal("writeOnlyKeepRequiresUnchanged" in codex, false);
  // Create forms never carry it.
  assert.equal("writeOnlyKeepRequiresUnchanged" in runtimeFormV2Entry("claude")!.buildForm(), false);
  // Not editable here (no v2 form, or a managed connection): null, the route's 404.
  assert.equal(buildRuntimeFormV2EditBody("nope", { runtime: "nope" }), null);
});
