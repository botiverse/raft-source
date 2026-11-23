/**
 * Shared v3 wire fixtures (`*.v3.json` in packages/runtime-form/fixtures):
 * exactly what the server sends to a client that advertises
 * `runtime_form.v3`, for the runtimes whose forms change in v3 (Built-in:
 * rules; Codex, Grok, Claude,
 * Copilot, Kimi Code, Pi, Antigravity: the reasoning effort as a dependent_select). The v2
 * fixtures stay byte-identical (runtimeFormV2Fixtures.test.ts). Regenerate
 * with UPDATE_RUNTIME_FORM_FIXTURES=1 and review the diff as a client-visible
 * change. The saved-connection fixtures (`builtin.*saved-connections*`,
 * `builtin.edit.connection-unavailable`) stay for the client conformance
 * tests in packages/runtime-form; the server no longer sends such forms.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeFormV2Definition } from "@botiverse/raft-runtime-form";

import {
  buildRuntimeFormV2,
  buildRuntimeFormV2EditBody,
  withCodexSpeedVisibility,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";
import {
  resolveRuntimeFormV3OptionSource,
  runtimeFormV3Revision,
  toRuntimeFormV3,
} from "./runtimeFormV3";

const FIXTURES_DIR = fileURLToPath(new URL("../../../runtime-form/fixtures/", import.meta.url));
const UPDATE = process.env.UPDATE_RUNTIME_FORM_FIXTURES === "1";
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** What web advertises once it renders v3. */
const V3_CAPABILITIES = ["dependent_select.custom_value_with_options", "runtime_form.v3"];

/**
 * A served v2 form (create or edit body) as the v3 routes send it, for a
 * current Computer: the built form shows the limit fields for every preset
 * provider that takes a typed id.
 */
function v3(runtimeId: string, form: RuntimeFormV2Definition): RuntimeFormV2Definition {
  return toRuntimeFormV3(form, {
    revision: runtimeFormV3Revision(runtimeId, form, V3_CAPABILITIES),
  });
}

const edit = (runtimeId: string, runtimeConfig: Record<string, unknown>) =>
  buildRuntimeFormV2EditBody(runtimeId, { runtime: runtimeId, ...runtimeConfig })!;

/**
 * An option source as the v3 route resolves it, with a model probe answering
 * `outcome`; `routing: "not_routed"` resolves it for a Computer that is not
 * connected (Built-in answers from its bundled catalog then).
 */
async function v3Source(
  runtimeId: string,
  sourceId: string,
  outcome: unknown = { kind: "missing_config" },
  routing: "confirmed_local" | "not_routed" = "confirmed_local",
): Promise<unknown> {
  const context = {
    sourceId,
    machineId: "fixture-machine",
    machine: {},
    clientCapabilities: V3_CAPABILITIES,
    agentOrchestrator: { detectMachineRuntimeModels: async () => outcome },
    routeToComputer: async () => routing,
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

const CODEX_TIERED_LIVE = {
  kind: "live",
  value: {
    models: [
      { id: "gpt-6.2-sol", label: "GPT-6.2-Sol", serviceTierChoices: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }] },
      {
        id: "gpt-6.2-astra",
        label: "GPT-6.2-Astra",
        serviceTierChoices: [
          { id: "priority", name: "Fast", description: "2x speed, increased usage" },
          { id: "ultrafast", name: "Ultrafast", description: "Up to 4.5x speed, uses more of your plan" },
        ],
      },
      { id: "gpt-5-mini", label: "GPT-5 Mini", serviceTierChoices: [] },
    ],
    default: "gpt-6.2-sol",
  },
};

/**
 * Codex's model list for the visual case: both lists above, so the model
 * source names every model the effort (CODEX_LIVE) and speed
 * (CODEX_TIERED_LIVE) sources are keyed by.
 */
const CODEX_ALL_LIVE = {
  kind: "live",
  value: { models: [...CODEX_LIVE.value.models, ...CODEX_TIERED_LIVE.value.models], default: CODEX_LIVE.value.default },
};

const CLAUDE_OFFLINE = { kind: "error", retryable: true, code: "computer_offline" };

const fixtures = async (): Promise<Record<string, unknown>> => ({
  // Built-in: rules instead of visibility.
  "builtin.form.v3.json": v3("builtin", buildRuntimeFormV2("builtin")),
  // Reasoning effort and mutually-exclusive speed controls for a tiered Codex probe.
  "codex.form.v3.json": v3("codex", withCodexSpeedVisibility(buildRuntimeFormV2("codex"), CODEX_TIERED_LIVE.value.models)),
  "codex.edit.v3.json": v3("codex", withCodexSpeedVisibility(edit("codex", {
    model: { kind: "custom", name: "my-org/codex-custom" },
    mode: { kind: "fast" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  }), CODEX_TIERED_LIVE.value.models)),
  "codex.option-source.reasoning-effort.v3.json": await v3Source("codex", "reasoningEffort", CODEX_LIVE),
  // #wg-runtime-form:#27: a key only for a model with two or more named fast tiers.
  "codex.option-source.speed.v3.json": await v3Source("codex", "speed", CODEX_TIERED_LIVE),
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
  "claude.option-source.reasoning-effort.v3.json": await v3Source("claude", "reasoningEffort", CLAUDE_OFFLINE),
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
  // Every option source of every create form above, so a client (the visual
  // cases in packages/runtime-form/fixtures/visual-cases.v3.json) can render
  // each real create form from server output alone. One probe outcome per
  // runtime, the same one its reasoning effort source above was built from, so
  // a model list and its effort list agree.
  "builtin.option-source.provider.v3.json": await v3Source("builtin", "provider", undefined, "not_routed"),
  "builtin.option-source.model.v3.json": await v3Source("builtin", "model", undefined, "not_routed"),
  "builtin.option-source.reasoning-effort.v3.json": await v3Source("builtin", "reasoningEffort", undefined, "not_routed"),
  "claude.option-source.provider.v3.json": await v3Source("claude", "provider", CLAUDE_OFFLINE),
  "claude.option-source.auth-type.v3.json": await v3Source("claude", "authType", CLAUDE_OFFLINE),
  "claude.option-source.model.v3.json": await v3Source("claude", "model", CLAUDE_OFFLINE),
  "codex.option-source.model.v3.json": await v3Source("codex", "model", CODEX_ALL_LIVE),
  "grok.option-source.model.v3.json": await v3Source("grok", "model"),
  "grok.option-source.reasoning-effort.v3.json": await v3Source("grok", "reasoningEffort"),
  "kimi-sdk.option-source.model.v3.json": await v3Source("kimi-sdk", "model"),
  "pi.option-source.provider.v3.json": await v3Source("pi", "provider"),
  "pi.option-source.model.v3.json": await v3Source("pi", "model"),
  "pi.option-source.provider-model.v3.json": await v3Source("pi", "providerModel"),
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
