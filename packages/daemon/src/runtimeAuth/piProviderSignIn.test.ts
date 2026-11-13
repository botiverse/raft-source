import assert from "node:assert/strict";

import type { LoginProvider } from "@botiverse/oar";

import {
  PI_KEY_PROVIDERS_ASKING_MORE,
  PI_OAUTH_FLOWS,
  piKeyEntry,
  piLoginFailureReason,
  piOAuthFlow,
  piProviderLabel,
  piSignedInProviders,
  piWebProvider,
} from "./piProviderSignIn";

const anthropic: LoginProvider = {
  providerId: "anthropic",
  name: "Anthropic",
  methods: [{ method: "oauth", name: "Anthropic (Claude Pro/Max)", subscription: true }, { method: "api_key", name: "Anthropic API key" }],
};

test("each OAuth flow pi has runs headless from the web; one Raft does not know is the Computer's own", () => {
  assert.equal(piOAuthFlow("anthropic"), "paste_code");
  assert.equal(PI_OAUTH_FLOWS.anthropic?.select, "copy_code");
  assert.equal(piOAuthFlow("openai-codex"), "device_code");
  assert.equal(PI_OAUTH_FLOWS["openai-codex"]?.select, "device_code");
  assert.equal(piOAuthFlow("radius"), "device_code");
  assert.equal(PI_OAUTH_FLOWS.radius?.select, "device-code");
  for (const id of ["openai", "openrouter"]) assert.equal(piOAuthFlow(id), "paste_address", id);
  for (const id of ["github-copilot", "kimi-coding", "xai", "meta"]) assert.equal(piOAuthFlow(id), "device_code", id);
  assert.equal(PI_OAUTH_FLOWS["github-copilot"]?.blankText, true, "Copilot's Enterprise question is answered github.com");
  assert.equal(piOAuthFlow("future-sso"), "computer_only");
  assert.equal(piOAuthFlow("constructor"), "computer_only", "an id never reaches the object's prototype");
});

test("a key is entered from the web only where pi asks for the key and nothing else", () => {
  assert.equal(piKeyEntry(anthropic), "key");
  for (const id of PI_KEY_PROVIDERS_ASKING_MORE) {
    assert.equal(piKeyEntry({ providerId: id, name: id, methods: [{ method: "api_key", name: "Credentials" }] }), "more_fields", id);
  }
  assert.equal(piKeyEntry({ providerId: "env-only", name: "Env", methods: [{ method: "api_key", name: "Key", ambient: true }] }), "outside");
  assert.equal(piKeyEntry({ providerId: "oauth-only", name: "OAuth", methods: [{ method: "oauth", name: "OAuth", subscription: false }] }), null);
});

test("a provider's name is shown without control characters, and as its id when nothing is left", () => {
  assert.equal(piProviderLabel("Local\u0007 LLM\n", "custom"), "Local LLM");
  assert.equal(piProviderLabel("\u0000\u001b\u009b", "custom-blank"), "custom-blank");
  assert.equal(piProviderLabel(undefined, "custom-local"), "custom-local");
  assert.equal(piProviderLabel("x".repeat(200), "long").length, 80);
});

test("the stored sign-ins carry the provider, its name and how it signs in; nothing configured or malformed is listed", () => {
  assert.deepEqual(piSignedInProviders([
    { providerId: "anthropic", configured: true, method: "oauth", subscription: true },
    { providerId: "deepseek", configured: true, method: "api_key", subscription: false },
    { providerId: "openrouter", configured: false },
    { providerId: "../etc", configured: true, method: "api_key" },
  ], [anthropic]), [
    { id: "anthropic", label: "Anthropic", method: "oauth", subscription: true },
    { id: "deepseek", label: "deepseek", method: "api_key" },
  ]);
});

test("a provider of pi's list reaches the web with its sign-in ways, what is stored, and a fixed endpoint", () => {
  assert.deepEqual(piWebProvider(anthropic, { providerId: "anthropic", configured: true, method: "api_key" }), {
    id: "anthropic",
    label: "Anthropic",
    configured: true,
    endpoint: { kind: "fixed" },
    needsModelIds: false,
    signIn: {
      oauth: { label: "Anthropic (Claude Pro/Max)", subscription: true, flow: "paste_code" },
      apiKey: { label: "Anthropic API key", entry: "key" },
      stored: "api_key",
    },
  });
  assert.equal(piWebProvider({ ...anthropic, providerId: "not an id" }, undefined), null);
});

test("a failed pi login is read for its kind only", () => {
  assert.equal(piLoginFailureReason(new Error("Device code expired")), "timed_out");
  assert.equal(piLoginFailureReason(new Error("Login timed out")), "timed_out");
  assert.equal(piLoginFailureReason(new Error("access_denied by the user")), "rejected");
  assert.equal(piLoginFailureReason(new Error("OAuth state mismatch")), "rejected");
  assert.equal(piLoginFailureReason(new Error("fetch failed")), "process_failed");
  assert.equal(piLoginFailureReason("not an error"), "process_failed");
});
