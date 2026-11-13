/**
 * Shared v2 wire fixtures for every client that renders runtime forms (web,
 * mobile). They are exactly what the server sends today:
 *
 * - `<runtime>.form.json`: GET /api/servers/:id/machines/:machineId/runtime-forms/v2/:runtimeId
 * - `<runtime>.edit.json`: GET /api/agents/:id/runtime-form for a representative
 *   stored config (writeOnly fields such as apiKey are never included)
 * - `<runtime>.option-source.fallback.json`: GET .../runtime-forms/v2/:runtimeId/option-sources/model
 *   when the Computer's model probe is not live (the bundled RUNTIME_MODELS list);
 *   `gemini.option-source.json` is Gemini's static list
 * - batch 3a (Codex, Grok; forms with requiredClientCapabilities):
 *   `codex.option-source.{live,fallback,unavailable}.json` carry
 *   `option_source.status`. live: a probe answered with a fixed model list;
 *   fallback: the probe said missing_config and the bundled list is served;
 *   unavailable: the body the server builds when a probe fails and there is no
 *   bundled list to fall back on (Codex always has one today, so this is the
 *   shape clients must handle rather than a response Codex sends now).
 * - batch 3b (Claude, Cursor, Copilot): `claude.edit.json` is a Custom provider
 *   (its stored API key is never in `values`), `claude.option-source.provider.json`
 *   the static provider select, `claude.option-source.auth-type.json` the static
 *   Custom authentication select, `claude.option-source.fallback.json` Claude's
 *   bundled list while the Computer is offline, `claude.option-source.live.json` Claude
 *   Code's own list with `unavailableOptions` (a disabled model with its reason, then
 *   bundled models it did not list), `cursor.option-source.fallback.json` Cursor's
 *   bundled list when its probe is not live, and `copilot.option-source.live.json`
 *   Copilot's declared static catalog as the Computer reports it. Copilot CLI is
 *   deprecated (edit-only, like the batch 2 deprecated runtimes), so it has
 *   `copilot.edit.json` (a stored custom model) and no `.form.json`.
 * - batch 4 (Pi): `pi.form.json`; `pi.edit.json` is a built-in provider
 *   (DeepSeek; its stored API key is never in `values`) and
 *   `pi.edit.configured.json` the Configured provider with a typed custom
 *   model; `pi.option-source.provider.json` the static provider select,
 *   `pi.option-source.provider-model.json` the built-in providers' model lists
 *   (a dependent_select), and `pi.option-source.fallback.json` the Configured
 *   model list when the Pi probe says missing_config.
 * - Antigravity (revived on the OAR host): `antigravity.edit.json` and
 *   `antigravity.option-source.live.json`, the Computer's agy models after the
 *   configured default, with efforts only for a model agy lists levels for.
 *
 * Clients test against these files instead of converting v1 samples themselves,
 * so all of them follow one source. A red here means the server's v2 output
 * changed: regenerate with UPDATE_RUNTIME_FORM_FIXTURES=1 and review the diff as
 * a client-visible change.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getStaticRuntimeModelSourceSet } from "@botiverse/raft-shared";

import {
  buildRuntimeFormV2,
  buildRuntimeFormV2EditBody,
  reasoningModelOptionSource,
  runtimeFormV2Entry,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";

const FIXTURES_DIR = fileURLToPath(new URL("../../../runtime-form/fixtures/", import.meta.url));
const UPDATE = process.env.UPDATE_RUNTIME_FORM_FIXTURES === "1";

// JSON round trip: compare what res.json would send.
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const builtinForm = buildRuntimeFormV2("builtin");
const kimiForm = buildRuntimeFormV2("kimi-sdk");

/** The option source the server answers when the model probe reports missing_config (or `outcome`). */
async function nonLiveOptionSource(runtimeId: string, outcome: unknown = { kind: "missing_config" }): Promise<unknown> {
  const context = {
    sourceId: "model",
    machineId: "fixture-machine",
    machine: {},
    agentOrchestrator: { detectMachineRuntimeModels: async () => outcome },
    routeToComputer: async () => "confirmed_local",
  } as unknown as RuntimeFormOptionSourceContext;
  const resolution = await runtimeFormV2Entry(runtimeId)!.resolveOptionSource(context);
  assert.equal(resolution.kind, "source");
  return (resolution as { source: unknown }).source;
}

// The route's own builder (GET /api/agents/:id/runtime-form).
const editFixture = (runtimeId: string, runtimeConfig: Record<string, unknown>) =>
  buildRuntimeFormV2EditBody(runtimeId, { runtime: runtimeId, ...runtimeConfig });

// Batch 2: OpenCode (create and edit) and the deprecated, edit-only Kimi CLI and
// Gemini CLI; Antigravity's edit fixture (now a live-list model form with an
// effort) stays here: a stored "default" model with a Default (null) effort.
const batch2Fixtures = async (): Promise<Record<string, unknown>> => ({
  "opencode.form.json": buildRuntimeFormV2("opencode"),
  "opencode.edit.json": editFixture("opencode", {
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    envVars: { EXAMPLE_FLAG: "1" },
  }),
  "opencode.option-source.fallback.json": await nonLiveOptionSource("opencode"),
  "kimi.edit.json": editFixture("kimi", { model: { kind: "preset", id: "default" }, envVars: {} }),
  "kimi.option-source.fallback.json": await nonLiveOptionSource("kimi"),
  "gemini.edit.json": editFixture("gemini", { model: { kind: "preset", id: "gemini-2.5-pro" }, envVars: { EXAMPLE_FLAG: "1" } }),
  "gemini.option-source.json": await nonLiveOptionSource("gemini"),
  "antigravity.edit.json": editFixture("antigravity", { model: { kind: "preset", id: "default" }, envVars: { EXAMPLE_FLAG: "1" } }),
});

// Batch 3a: Codex (create and edit) and Grok (create).
const batch3aFixtures = async (): Promise<Record<string, unknown>> => ({
  "codex.form.json": buildRuntimeFormV2("codex"),
  "codex.edit.json": editFixture("codex", {
    model: { kind: "custom", name: "my-org/codex-custom" },
    mode: { kind: "fast" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  }),
  "grok.form.json": buildRuntimeFormV2("grok"),
  "codex.option-source.live.json": await nonLiveOptionSource("codex", {
    kind: "live",
    value: {
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-7-preview", label: "GPT-7 Preview", supportedReasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "high" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ],
      default: "gpt-5.6-sol",
    },
  }),
  "codex.option-source.fallback.json": await nonLiveOptionSource("codex"),
  "codex.option-source.unavailable.json": reasoningModelOptionSource("codex", [], undefined, "machine_offline", { customModel: true }),
});

/** Antigravity's agy models as the Computer reports them: levels only for the current model. */
const AGY_LIVE = {
  kind: "live",
  value: {
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
      { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" },
    ],
    default: "gemini-3.8-flash",
  },
};

/** The option source the server answers for `sourceId` with a probe that must not run. */
async function staticOptionSource(runtimeId: string, sourceId: string): Promise<unknown> {
  const context = {
    sourceId,
    machineId: "fixture-machine",
    machine: {},
    agentOrchestrator: { detectMachineRuntimeModels: async () => { throw new Error("a static source never probes"); } },
    routeToComputer: async () => { throw new Error("a static source never routes"); },
  } as unknown as RuntimeFormOptionSourceContext;
  const resolution = await runtimeFormV2Entry(runtimeId)!.resolveOptionSource(context);
  assert.equal(resolution.kind, "source");
  return (resolution as { source: unknown }).source;
}

// Batch 3b: Claude (create and edit), Cursor (create and edit) and the deprecated,
// edit-only Copilot CLI.
const batch3bFixtures = async (): Promise<Record<string, unknown>> => ({
  "claude.form.json": buildRuntimeFormV2("claude"),
  "claude.edit.json": editFixture("claude", {
    provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: "fixture-secret-must-not-appear" },
    model: { kind: "preset", id: "sonnet" },
    mode: { kind: "fast" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
    command: "/usr/local/bin/claude",
  }),
  "claude.option-source.provider.json": await staticOptionSource("claude", "provider"),
  "claude.option-source.auth-type.json": await staticOptionSource("claude", "authType"),
  "claude.option-source.fallback.json": await nonLiveOptionSource("claude", { kind: "error", retryable: true, code: "computer_offline" }),
  // Claude Code's own list on this Computer: a disabled model with its reason
  // in `unavailableOptions` (never `options`).
  "claude.option-source.live.json": await nonLiveOptionSource("claude", {
    kind: "live",
    value: {
      models: [
        { id: "opus", label: "Claude Opus (Opus 5.5)", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      ],
      unavailable: [{ id: "claude-opus-9", label: "Claude Opus 9", reason: "Update Claude Code to use this model" }],
    },
  }),
  "cursor.form.json": buildRuntimeFormV2("cursor"),
  "cursor.edit.json": editFixture("cursor", {
    model: { kind: "custom", name: "my-org/cursor-custom" },
    envVars: { EXAMPLE_FLAG: "1" },
  }),
  "cursor.option-source.fallback.json": await nonLiveOptionSource("cursor"),
  "copilot.edit.json": editFixture("copilot", {
    model: { kind: "custom", name: "vendor/copilot-custom" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  }),
  "antigravity.option-source.live.json": await nonLiveOptionSource("antigravity", AGY_LIVE),
  "copilot.option-source.live.json": await nonLiveOptionSource("copilot", {
    kind: "live",
    value: getStaticRuntimeModelSourceSet("copilot"),
  }),
});

// Batch 4: Pi (create and edit).
const batch4Fixtures = async (): Promise<Record<string, unknown>> => ({
  "pi.form.json": buildRuntimeFormV2("pi"),
  "pi.edit.json": editFixture("pi", {
    provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "fixture-secret-must-not-appear" },
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { EXAMPLE_FLAG: "1" },
  }),
  "pi.edit.configured.json": editFixture("pi", {
    provider: { kind: "default" },
    model: { kind: "custom", name: "my-org/pi-custom" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: {},
  }),
  "pi.option-source.provider.json": await staticOptionSource("pi", "provider"),
  "pi.option-source.provider-model.json": await staticOptionSource("pi", "providerModel"),
  "pi.option-source.fallback.json": await nonLiveOptionSource("pi"),
});

const fixtures: Record<string, unknown> = {
  "builtin.form.json": builtinForm,
  "builtin.option-source.reasoning-effort.json": await staticOptionSource("builtin", "reasoningEffort"),
  "kimi-sdk.form.json": kimiForm,
  "builtin.edit.json": editFixture("builtin", {
    provider: {
      kind: "gateway",
      providerId: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "fixture-secret-must-not-appear",
      supportsImageInput: true,
    },
    model: { kind: "custom", name: "example-model" },
    loadLocalPlugins: false,
    envVars: { EXAMPLE_FLAG: "1" },
  }),
  "kimi-sdk.edit.json": editFixture("kimi-sdk", {
    model: { kind: "preset", id: "kimi-k2" },
    reasoningEffort: "high",
    envVars: {},
  }),
};

test("shared v2 runtime form fixtures match what the server sends", async () => {
  if (UPDATE) mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, value] of Object.entries({ ...fixtures, ...await batch2Fixtures(), ...await batch3aFixtures(), ...await batch3bFixtures(), ...await batch4Fixtures() })) {
    const path = `${FIXTURES_DIR}${name}`;
    const expected = `${JSON.stringify(wire(value), null, 2)}\n`;
    if (UPDATE) writeFileSync(path, expected);
    assert.equal(readFileSync(path, "utf8"), expected, `${name} is stale; regenerate with UPDATE_RUNTIME_FORM_FIXTURES=1`);
  }
});

test("edit fixtures never carry a writeOnly value", () => {
  for (const name of ["builtin.edit.json", "kimi-sdk.edit.json", "opencode.edit.json", "kimi.edit.json", "gemini.edit.json", "antigravity.edit.json", "codex.edit.json", "claude.edit.json", "cursor.edit.json", "copilot.edit.json", "pi.edit.json", "pi.edit.configured.json"]) {
    const text = readFileSync(`${FIXTURES_DIR}${name}`, "utf8");
    assert.doesNotMatch(text, /fixture-secret-must-not-appear/, name);
    const parsed = JSON.parse(text) as { values?: Record<string, unknown> | null };
    assert.ok(parsed.values && typeof parsed.values === "object", `${name} has values`);
  }
});

test("v2-only copy stays off the v1 definition: the frozen v1 sample has no model hint, the v2 form does", async () => {
  const { releasedRuntimeFormDefinition } = await import("@botiverse/raft-runtime-form");
  const v1 = releasedRuntimeFormDefinition("builtin-pi.create.v3");
  assert.equal(v1?.uiSchema?.localization?.model?.hint, undefined, "v1 clients never see it");
  assert.equal(buildRuntimeFormV2("builtin").uiSchema?.localization?.model?.hint, "Use a model ID the selected provider supports.");
  assert.equal(buildRuntimeFormV2("builtin").schemaVersion, "builtin-pi.create.v3", "no version bump");
});
