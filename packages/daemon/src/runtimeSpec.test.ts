// Reconciler step 7: the runtime spec a session is compared on (runtimeSpec.ts).
//
// RED proof: hash a component without sorting its keys (canonicalize) and the
// key-order case drifts on `env`; hash the whole config instead of the
// whitelisted components and every non-whitelisted change drifts; drop the
// Codex rule in sessionDropReason and the Codex model case keeps its session.
// Step 11: hash an absent optional component like any other and a push that
// names a managed MCP fingerprint drifts against a session from an older
// server; compare only `runtime` in specChangeNeedsServerStart and a host
// switch is restarted locally.

import assert from "node:assert/strict";
import { RUNTIME_CONFIG_VERSION, type AgentConfig } from "@botiverse/raft-shared";
import { runtimeSpecDrift, runtimeSpecOf, sessionDropReason, SessionSpecMemory, specChangeNeedsServerStart } from "./runtimeSpec";

function config(overrides: Partial<AgentConfig> & Record<string, unknown> = {}): AgentConfig {
  return {
    name: "agent",
    displayName: "Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: { ALPHA: "1", BETA: "2" },
    sessionId: "session-1",
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    ...overrides,
  } as AgentConfig;
}

const drift = (left: AgentConfig, right: AgentConfig) => runtimeSpecDrift(runtimeSpecOf(left), runtimeSpecOf(right));

test("the same spec in another key order, with explicit defaults and its structured twin, is no drift", () => {
  const flat = config();
  const structured = config({
    envVars: { BETA: "2", ALPHA: "1" },
    executionMode: "byoc",
    providerConnection: null,
    runtimeConfig: {
      provider: { kind: "default" },
      envVars: { BETA: "2", ALPHA: "1" },
      reasoningEffort: null,
      mode: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      runtime: "claude",
      version: RUNTIME_CONFIG_VERSION,
    },
  });
  assert.deepEqual(drift(flat, structured), []);
  assert.deepEqual(drift(config({ envVars: null }), config({ envVars: {} })), [], "no env vars, null or empty");
  assert.deepEqual(drift(config({ executionMode: undefined }), config({ executionMode: null })), []);
});

test("only whitelisted fields count: prompt inputs, context, credentials, the session and unknown fields never drift", () => {
  const base = config();
  const changed = config({
    name: "renamed",
    displayName: "Renamed",
    description: "another role",
    sessionId: "session-2",
    serverUrl: "https://elsewhere.example.com",
    authToken: "sk_machine_other",
    agentCredentialKey: "sk_agent_other",
    agentCredentialId: "cred-2",
    runtimeContext: { agentId: "agent", workspacePath: "/elsewhere", daemonVersion: "9.9.9" },
    runtimeProfileControl: { kind: "daemon_release_notice", key: "k", message: "m" },
    constructedWakeContext: true,
    agentContextView: true,
    providerConnection: { providerId: "openai", endpointUrl: null, supportsImageInput: true },
    someFieldAddedLater: { anything: true },
  } as Partial<AgentConfig> & Record<string, unknown>);
  assert.deepEqual(drift(base, changed), []);
});

test("each whitelisted change names its kind", () => {
  const base = config();
  assert.deepEqual(drift(base, config({ model: "opus" })), ["model"]);
  assert.deepEqual(drift(base, config({ reasoningEffort: "high" })), ["runtime_config"]);
  assert.deepEqual(drift(base, config({ envVars: { ALPHA: "1", BETA: "3" } })), ["env"]);
  assert.deepEqual(drift(base, config({ executionMode: "cloud" })), ["execution_mode"]);
  assert.deepEqual(drift(base, config({
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "claude",
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      envVars: { ALPHA: "1", BETA: "2" },
      provider: { kind: "custom", apiUrl: "https://proxy.example.com", apiKey: "sk-secret" },
    },
  })), ["provider"]);
  assert.ok(drift(base, config({ runtime: "codex", model: "gpt-5.5" })).includes("runtime"));
});

test("the snapshot holds hashes, not values", () => {
  const snapshot = runtimeSpecOf(config({ envVars: { SECRET_NAME: "secret-value" } }));
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes("SECRET_NAME"), false);
  assert.equal(text.includes("secret-value"), false);
});

test("a new session for another runtime or a Codex model; any other model change resumes", () => {
  const claude = runtimeSpecOf(config());
  assert.equal(sessionDropReason(claude, runtimeSpecOf(config({ model: "opus" }))), null);
  assert.equal(sessionDropReason(claude, runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.5" }))), "runtime_changed");
  const codex = runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.5" }));
  assert.equal(sessionDropReason(codex, runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.4" }))), "codex_model_changed");
  assert.equal(sessionDropReason(codex, runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.5", reasoningEffort: "high" }))), null);

  const memory = new SessionSpecMemory();
  memory.remember("agent", "thread-1", codex);
  assert.equal(memory.sessionToDrop("agent", "thread-1", runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.4" }))), "codex_model_changed");
  assert.equal(memory.sessionToDrop("agent", "thread-2", runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.4" }))), null, "only that session");
  assert.equal(memory.sessionToDrop("other", "thread-1", runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.4" }))), null, "only that agent");
});

test("a config this Computer cannot read is never drift and never drops a session", () => {
  // A provider kind from a newer Server: hydration keeps it, the strict parse refuses it.
  const unreadable = config({
    model: "sonnet-next",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "claude",
      model: { kind: "preset", id: "sonnet-next" },
      mode: { kind: "default" },
      provider: { kind: "provider-from-the-future" },
    },
  } as unknown as Partial<AgentConfig>);
  assert.equal(runtimeSpecOf(unreadable).readable, false);
  assert.equal(runtimeSpecOf(config()).readable, true);
  assert.deepEqual(drift(config(), unreadable), []);
  assert.deepEqual(drift(unreadable, config()), []);
  const codex = config({ runtime: "codex", model: "gpt-5.5" });
  const codexUnreadable = config({ runtime: "codex", model: "gpt-5.6", runtimeConfig: { version: RUNTIME_CONFIG_VERSION, runtime: "codex", model: { kind: "preset", id: "gpt-5.6" }, mode: { kind: "default" }, provider: { kind: "provider-from-the-future" } } } as unknown as Partial<AgentConfig>);
  assert.equal(runtimeSpecOf(codexUnreadable).readable, false);
  assert.equal(sessionDropReason(runtimeSpecOf(codex), runtimeSpecOf(codexUnreadable)), null);
});

test("managed MCP and provider connection revisions drift only when both sides carry them", () => {
  const without = config();
  const withBoth = config({ managedMcpFingerprint: "mcp-1", providerConnectionRevision: 3 });
  assert.deepEqual(drift(without, withBoth), [], "an older server's session: no drift");
  assert.deepEqual(drift(withBoth, without), [], "an older server's push: no drift");
  assert.deepEqual(drift(withBoth, config({ managedMcpFingerprint: "mcp-1", providerConnectionRevision: 3 })), []);
  assert.deepEqual(drift(withBoth, config({ managedMcpFingerprint: "mcp-2", providerConnectionRevision: 3 })), ["managed_mcp"]);
  assert.deepEqual(drift(withBoth, config({ managedMcpFingerprint: "mcp-1", providerConnectionRevision: "4" })), ["provider_connection"]);
  assert.deepEqual(drift(withBoth, config({ managedMcpFingerprint: null, providerConnectionRevision: 4 })), ["provider_connection"], "null is absent");
});

test("a spec stop is left to the server's start for another runtime or host, not for another model", () => {
  const legacy = runtimeSpecOf(config());
  assert.equal(specChangeNeedsServerStart(legacy, runtimeSpecOf(config({ model: "opus", envVars: null }))), false);
  assert.equal(specChangeNeedsServerStart(legacy, runtimeSpecOf(config({ runtime: "codex", model: "gpt-5.5" }))), true);
  assert.equal(specChangeNeedsServerStart(legacy, runtimeSpecOf(config({ runtimeHost: "oar" }))), true);
  assert.equal(specChangeNeedsServerStart(runtimeSpecOf(config({ runtimeHost: "oar" })), runtimeSpecOf(config({ runtimeHost: "oar", model: "opus" }))), false);
});

test("a Built-in custom model's declared limits are runtime config: a change drifts, an agent without them keeps its hash (#proj-runtime:#50)", () => {
  const builtin = (model: Record<string, unknown>) => config({
    runtime: "builtin",
    model: "my-model",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "k" },
      model: { kind: "custom", name: "my-model", ...model },
      mode: { kind: "default" },
      hostUserState: "forbidden",
      envVars: { ALPHA: "1", BETA: "2" },
    } as AgentConfig["runtimeConfig"],
  });
  const plain = builtin({});
  assert.deepEqual(drift(plain, builtin({ contextWindow: 128_000 })), ["runtime_config"]);
  assert.deepEqual(drift(builtin({ contextWindow: 128_000 }), builtin({ contextWindow: 128_000, maxOutputTokens: 16_000 })), ["runtime_config"]);
  assert.deepEqual(drift(builtin({ contextWindow: 128_000 }), builtin({ contextWindow: 128_000 })), []);
  // No limits set: nothing is added to the hashed component (empty objects canonicalize away).
  assert.equal(runtimeSpecOf(plain).hashes.runtime_config, runtimeSpecOf(builtin({ contextWindow: undefined, maxOutputTokens: undefined })).hashes.runtime_config);
});
