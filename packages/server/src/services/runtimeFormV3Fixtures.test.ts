/**
 * Shared v3 wire fixtures (`*.v3.json` in packages/runtime-form/fixtures):
 * exactly what the server sends to a client that advertises
 * `runtime_form.v3`, for the runtimes whose forms change in v3 (Built-in:
 * rules, saved connections, unavailable connections; Codex, Grok, Claude,
 * Copilot, Kimi Code, Pi, Antigravity: the reasoning effort as a dependent_select). The v2
 * fixtures stay byte-identical (runtimeFormV2Fixtures.test.ts). Regenerate
 * with UPDATE_RUNTIME_FORM_FIXTURES=1 and review the diff as a client-visible
 * change.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeFormV2Definition } from "@botiverse/raft-runtime-form";

import {
  buildRuntimeFormV2,
  buildRuntimeFormV2EditBody,
  runtimeFormV2Entry,
  withSavedConnectionForm,
  type RuntimeFormOptionSourceContext,
  type RuntimeFormV2OptionSourceBody,
} from "./runtimeFormV2Registry";
import {
  resolveRuntimeFormV3OptionSource,
  runtimeFormV3Revision,
  toRuntimeFormV3,
  toRuntimeFormV3OptionSource,
  type RuntimeFormV3Connection,
} from "./runtimeFormV3";

const FIXTURES_DIR = fileURLToPath(new URL("../../../runtime-form/fixtures/", import.meta.url));
const UPDATE = process.env.UPDATE_RUNTIME_FORM_FIXTURES === "1";
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** What web advertises once it renders v3. */
const V3_CAPABILITIES = ["dependent_select.custom_value_with_options", "runtime_form.v3"];
const CONNECTIONS: RuntimeFormV3Connection[] = [
  { value: "connection:conn-deepseek", underlyingProviderId: "deepseek" },
  { value: "connection:conn-gateway", underlyingProviderId: "openai-compatible" },
  { value: "connection:conn-off", underlyingProviderId: "deepseek" },
];

/** A served v2 form (create or edit body) as the v3 routes send it. */
function v3(runtimeId: string, form: RuntimeFormV2Definition, connections: RuntimeFormV3Connection[] = []): RuntimeFormV2Definition {
  return toRuntimeFormV3(form, { connections, revision: runtimeFormV3Revision(runtimeId, form, V3_CAPABILITIES, connections) });
}

const edit = (runtimeId: string, runtimeConfig: Record<string, unknown>) =>
  buildRuntimeFormV2EditBody(runtimeId, { runtime: runtimeId, ...runtimeConfig })!;

const builtinEntry = runtimeFormV2Entry("builtin")!;
const savedConnectionBuild = (form: RuntimeFormV2Definition) => withSavedConnectionForm(builtinEntry, form, V3_CAPABILITIES);

/** An option source as the v3 route resolves it, with a model probe answering `outcome`. */
async function v3Source(runtimeId: string, sourceId: string, outcome: unknown = { kind: "missing_config" }): Promise<unknown> {
  const context = {
    sourceId,
    machineId: "fixture-machine",
    machine: {},
    sourceStatus: true,
    clientCapabilities: V3_CAPABILITIES,
    agentOrchestrator: { detectMachineRuntimeModels: async () => outcome },
    routeToComputer: async () => "confirmed_local",
  } as unknown as RuntimeFormOptionSourceContext;
  const resolution = await resolveRuntimeFormV3OptionSource(buildRuntimeFormV2(runtimeId), context);
  assert.equal(resolution.kind, "source");
  const source = (resolution as { source: unknown }).source;
  assert.ok(source, `${runtimeId}/${sourceId}`);
  return source;
}

const CODEX_LIVE = {
  kind: "live",
  value: {
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-7-preview", label: "GPT-7 Preview", supportedReasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "high" },
    ],
    default: "gpt-5.6-sol",
  },
};

/** Built-in's provider select with saved connections (one disabled), as withSavedConnectionOptions builds it. */
async function builtinProviderWithConnections(): Promise<RuntimeFormV2OptionSourceBody> {
  const context = {
    sourceId: "provider",
    machineId: "fixture-machine",
    machine: {},
    sourceStatus: true,
    clientCapabilities: V3_CAPABILITIES,
    agentOrchestrator: { detectMachineRuntimeModels: async () => { throw new Error("offline"); } },
    routeToComputer: async () => "not_routed",
  } as unknown as RuntimeFormOptionSourceContext;
  const resolution = await builtinEntry.resolveOptionSource(context);
  const source = (resolution as { source: RuntimeFormV2OptionSourceBody }).source;
  assert.equal(source.kind, "select");
  return {
    ...source,
    options: [
      { value: "connection:conn-deepseek", label: "DeepSeek · Team", providerKind: "preset", connectionId: "conn-deepseek", underlyingProviderId: "deepseek", group: "saved" },
      { value: "connection:conn-gateway", label: "OpenAI Compatible · Team gateway", providerKind: "gateway", connectionId: "conn-gateway", underlyingProviderId: "openai-compatible", group: "saved" },
      { value: "connection:conn-off", label: "DeepSeek · Old", providerKind: "preset", connectionId: "conn-off", underlyingProviderId: "deepseek", group: "saved", unavailable: true, unavailableReason: "disabled" },
      ...(source.kind === "select" ? source.options.map((option) => ({ ...option, group: "direct" })) : []),
    ],
  } as RuntimeFormV2OptionSourceBody;
}

const fixtures = async (): Promise<Record<string, unknown>> => ({
  // Built-in: rules instead of visibility; with saved connections the owned
  // fields hide by rule and the gateway connection keeps the limit fields.
  "builtin.form.v3.json": v3("builtin", buildRuntimeFormV2("builtin")),
  "builtin.form.saved-connections.v3.json": v3("builtin", savedConnectionBuild(buildRuntimeFormV2("builtin")), CONNECTIONS),
  "builtin.edit.connection-unavailable.v3.json": v3("builtin", savedConnectionBuild(edit("builtin", {
    provider: { kind: "connection", connectionId: "conn-off" },
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    loadLocalPlugins: false,
    envVars: {},
  })), CONNECTIONS),
  "builtin.option-source.provider.saved-connections.v3.json": toRuntimeFormV3OptionSource(await builtinProviderWithConnections()),
  // Reasoning effort as a dependent_select keyed by model.
  "codex.form.v3.json": v3("codex", buildRuntimeFormV2("codex")),
  "codex.edit.v3.json": v3("codex", edit("codex", {
    model: { kind: "custom", name: "my-org/codex-custom" },
    mode: { kind: "fast" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  })),
  "codex.option-source.reasoning-effort.v3.json": await v3Source("codex", "reasoningEffort", CODEX_LIVE),
  "grok.form.v3.json": v3("grok", buildRuntimeFormV2("grok")),
  "claude.form.v3.json": v3("claude", buildRuntimeFormV2("claude")),
  "claude.edit.v3.json": v3("claude", edit("claude", {
    provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: "fixture-secret-must-not-appear" },
    model: { kind: "preset", id: "sonnet" },
    mode: { kind: "fast" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
    command: "/usr/local/bin/claude",
  })),
  "claude.option-source.reasoning-effort.v3.json": await v3Source("claude", "reasoningEffort", { kind: "error", retryable: true, code: "computer_offline" }),
  "copilot.edit.v3.json": v3("copilot", edit("copilot", {
    model: { kind: "custom", name: "vendor/copilot-custom" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  })),
  "kimi-sdk.form.v3.json": v3("kimi-sdk", buildRuntimeFormV2("kimi-sdk")),
  "kimi-sdk.edit.v3.json": v3("kimi-sdk", edit("kimi-sdk", { model: { kind: "preset", id: "kimi-k2" }, reasoningEffort: "high", envVars: {} })),
  "kimi-sdk.option-source.reasoning-effort.v3.json": await v3Source("kimi-sdk", "reasoningEffort"),
  "pi.form.v3.json": v3("pi", buildRuntimeFormV2("pi")),
  "pi.edit.v3.json": v3("pi", edit("pi", {
    provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "fixture-secret-must-not-appear" },
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  })),
  "pi.option-source.reasoning-effort.v3.json": await v3Source("pi", "reasoningEffort"),
  "pi.option-source.provider-reasoning-effort.v3.json": await v3Source("pi", "providerReasoningEffort"),
  // Only a model whose thought levels agy listed has an effort; "default" (agy's choice) has none.
  "antigravity.edit.v3.json": v3("antigravity", edit("antigravity", { model: { kind: "preset", id: "default" }, envVars: {} })),
  "antigravity.option-source.reasoning-effort.v3.json": await v3Source("antigravity", "reasoningEffort", {
    kind: "live",
    value: {
      models: [
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
        { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" },
      ],
      default: "gemini-3.8-flash",
    },
  }),
});

test("shared v3 runtime form fixtures match what the server sends", async () => {
  for (const [name, value] of Object.entries(await fixtures())) {
    const path = `${FIXTURES_DIR}${name}`;
    const expected = `${JSON.stringify(wire(value), null, 2)}\n`;
    if (UPDATE) writeFileSync(path, expected);
    assert.equal(readFileSync(path, "utf8"), expected, `${name} is stale; regenerate with UPDATE_RUNTIME_FORM_FIXTURES=1`);
    assert.doesNotMatch(expected, /fixture-secret-must-not-appear/, name);
  }
});
