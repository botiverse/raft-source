import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { releasedRuntimeFormDefinition } from "./index";
import { parseRuntimeFormV2, toRuntimeFormV2 } from "./v2";
import {
  applyRuntimeFormV2Change,
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  runtimeFormV2AdvancedStartsOpen,
  runtimeFormV2Choices,
  runtimeFormV2SourceStatus,
  runtimeFormV2Submission,
  validateRuntimeFormV2,
  type RuntimeFormV2Sources,
} from "./v2State";

const pi = parseRuntimeFormV2(toRuntimeFormV2(releasedRuntimeFormDefinition("builtin-pi.create.v3")!))!;
const kimi = parseRuntimeFormV2(toRuntimeFormV2(releasedRuntimeFormDefinition("kimi-sdk.create.v1")!))!;
const field = (form: typeof pi, key: string) => form.fields.find((candidate) => candidate.key === key)!;

const piSources: RuntimeFormV2Sources = {
  provider: {
    sourceId: "provider", kind: "select", pointer: "/providerId",
    options: [
      { value: "deepseek", label: "DeepSeek", providerKind: "preset" },
      { value: "openai-compatible", label: "OpenAI compatible", providerKind: "gateway" },
    ],
    defaultValue: "deepseek",
  },
  model: {
    sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
    optionsByValue: { deepseek: [{ value: "deepseek/v4", label: "V4" }, { value: "deepseek/flash", label: "Flash" }], "openai-compatible": [] },
    defaultValueByValue: { deepseek: "deepseek/v4" },
    customValueAllowedByValue: { deepseek: false, "openai-compatible": true },
  },
};
const kimiSources: RuntimeFormV2Sources = {
  model: {
    sourceId: "model", kind: "select", pointer: "/model",
    options: [
      { value: "k2", label: "K2", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
      { value: "k1", label: "K1" },
    ],
    defaultValue: "k2",
  },
};

test("initial values follow sources: parents first, then dependents and derived choices", () => {
  const values = initialRuntimeFormV2Values(pi, piSources);
  assert.equal(values.providerId, "deepseek");
  assert.equal(values.model, "deepseek/v4");
  assert.equal(values.loadLocalPlugins, false);
  assert.deepEqual(values.envVars, {});
  const kimiValues = initialRuntimeFormV2Values(kimi, kimiSources);
  assert.equal(kimiValues.reasoningEffort, "high");
});

test("changing a parent resets what depends on it, and visibility follows", () => {
  let values = initialRuntimeFormV2Values(pi, piSources);
  assert.equal(isRuntimeFormV2FieldVisible(field(pi, "baseUrl"), values), false);
  values = applyRuntimeFormV2Change(pi, piSources, values, "providerId", "openai-compatible");
  assert.equal(values.model, "", "a gateway starts with an empty custom model");
  assert.equal(isRuntimeFormV2FieldVisible(field(pi, "baseUrl"), values), true);
  assert.deepEqual(runtimeFormV2Choices(field(pi, "model"), piSources, values), { kind: "free_text" });

  let kimiValues = initialRuntimeFormV2Values(kimi, kimiSources);
  kimiValues = applyRuntimeFormV2Change(kimi, kimiSources, kimiValues, "model", "k1");
  assert.equal(kimiValues.reasoningEffort, "", "a model without an effort menu falls back to the default");
  assert.deepEqual(runtimeFormV2Choices(field(kimi, "reasoningEffort"), kimiSources, kimiValues), { kind: "select", options: [], allowEmpty: true, allowCustom: false });
});

test("validation covers required, URL and choice membership on visible fields only", () => {
  let values = initialRuntimeFormV2Values(pi, piSources);
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { apiKey: "required" });
  values = { ...values, apiKey: "k", model: "not-offered" };
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { model: "not_a_choice" });
  values = applyRuntimeFormV2Change(pi, piSources, { ...values, model: "deepseek/v4" }, "providerId", "openai-compatible");
  values = { ...values, model: "any/model", baseUrl: "ftp://x" };
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { baseUrl: "invalid_url" });
});

test("the submission carries visible fields only, trimmed, and an empty derived choice as null", () => {
  const values = { ...initialRuntimeFormV2Values(pi, piSources), apiKey: " k ", baseUrl: "https://hidden.example" };
  const submitted = runtimeFormV2Submission(pi, values);
  assert.equal(submitted.apiKey, "k");
  assert.equal("baseUrl" in submitted, false, "a hidden field is not submitted");
  const kimiSubmitted = runtimeFormV2Submission(kimi, { ...initialRuntimeFormV2Values(kimi, kimiSources), reasoningEffort: "" });
  assert.equal(kimiSubmitted.reasoningEffort, null);
});

test("edit starts from the agent's stored values, and dependents follow the stored parent", () => {
  const editForm = { ...pi, values: { providerId: "deepseek", model: "deepseek/flash", loadLocalPlugins: true, envVars: { A: "1" }, supportsImageInput: "not-a-boolean" } };
  const values = initialRuntimeFormV2Values(editForm, piSources);
  assert.equal(values.model, "deepseek/flash", "stored choice kept, not reset to the default");
  assert.equal(values.loadLocalPlugins, true);
  assert.deepEqual(values.envVars, { A: "1" });
  assert.equal(values.supportsImageInput, false, "a stored value of the wrong kind falls back to the default");
  assert.equal(values.apiKey, "", "writeOnly fields start blank (blank on edit keeps the stored secret)");
});

test("edit: a stored null or absent derived effort stays Default; the model's default applies on create and after a model change", () => {
  const efforts: RuntimeFormV2Sources = {
    model: {
      sourceId: "model", kind: "select", pointer: "/model",
      options: [
        { value: "k2", label: "K2", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
        { value: "k3", label: "K3", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
      ],
      defaultValue: "k2",
    },
  };
  assert.equal(initialRuntimeFormV2Values(kimi, efforts).reasoningEffort, "medium", "create starts at the model's default");
  for (const stored of [{ reasoningEffort: null }, {}]) {
    const edit = { ...kimi, values: { model: "k2", envVars: {}, ...stored } };
    const values = initialRuntimeFormV2Values(edit, efforts);
    assert.equal(values.reasoningEffort, "", "Default (the runtime's), not the model's default");
    assert.deepEqual(validateRuntimeFormV2(edit, efforts, values, { editing: true }), {});
    assert.equal(runtimeFormV2Submission(edit, values, efforts).reasoningEffort, null, "saved untouched: still Default");
    assert.equal(applyRuntimeFormV2Change(edit, efforts, values, "model", "k3").reasoningEffort, "high", "a model change takes the new model's default");
  }
  const explicit = { ...kimi, values: { model: "k2", reasoningEffort: "low", envVars: {} } };
  assert.equal(initialRuntimeFormV2Values(explicit, efforts).reasoningEffort, "low", "a stored effort is kept");
});

test("on edit a blank secret is valid (it keeps the stored value); on create it is required", () => {
  const values = initialRuntimeFormV2Values(pi, piSources);
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { apiKey: "required" });
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values, { editing: true }), {});
});

// Batch 3a capabilities, against the shared fixtures the server sends
// (fixtures/codex.*, grok.form.json) and the hand-written choices sample.
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as Record<string, unknown>;
const codex = parseRuntimeFormV2(fixture("codex.form.json"))!;
const codexEdit = parseRuntimeFormV2(fixture("codex.edit.json"))!;
const codexSources = (name: string): RuntimeFormV2Sources => ({ model: fixture(name) as RuntimeFormV2Sources[string] });

test("select.custom_value: a combobox; any non-empty typed value is valid, required still needs one", () => {
  const sources = codexSources("codex.option-source.live.json");
  const values = initialRuntimeFormV2Values(codex, sources);
  assert.equal(values.model, "gpt-5.6-sol", "the source default");
  const choices = runtimeFormV2Choices(field(codex, "model"), sources, values);
  assert.equal(choices?.kind === "select" && choices.allowCustom, true);
  assert.deepEqual(validateRuntimeFormV2(codex, sources, { ...values, model: "my-org/typed" }), {});
  assert.deepEqual(validateRuntimeFormV2(codex, sources, { ...values, model: "  " }), { model: "required" });
  assert.equal(runtimeFormV2Submission(codex, { ...values, model: " my-org/typed " }, sources).model, "my-org/typed");
  // Without the flag the same unlisted value is not a choice.
  const strict = { model: { ...sources.model!, customValueAllowed: undefined } } as RuntimeFormV2Sources;
  assert.deepEqual(validateRuntimeFormV2(codex, strict, { ...values, model: "my-org/typed" }), { model: "not_a_choice" });
});

test("select.custom_value on edit: a stored value that is not listed is kept and submitted as typed", () => {
  for (const name of ["codex.option-source.live.json", "codex.option-source.fallback.json"]) {
    const sources = codexSources(name);
    const values = initialRuntimeFormV2Values(codexEdit, sources);
    assert.equal(values.model, "my-org/codex-custom", name);
    assert.equal(values.fastMode, true, name);
    assert.deepEqual(validateRuntimeFormV2(codexEdit, sources, values, { editing: true }), {}, name);
    const submitted = runtimeFormV2Submission(codexEdit, values, sources);
    assert.equal(submitted.model, "my-org/codex-custom", name);
    assert.equal(submitted.fastMode, true, name);
    // No option describes a typed model, so its effort menu is empty (not shown):
    // the stored effort is not "not a choice" and goes back unchanged.
    const effort = runtimeFormV2Choices(field(codexEdit, "reasoningEffort"), sources, values);
    assert.deepEqual(effort?.kind === "select" && effort.options, [], name);
    assert.equal(submitted.reasoningEffort, "high", name);
  }
});

test("choice.labels: choices label > option label > raw value; description only from choices; unknown keys ignored", () => {
  const form = parseRuntimeFormV2(fixture("choices.form.json"))!;
  const sources: RuntimeFormV2Sources = { tier: fixture("choices.option-source.json") as RuntimeFormV2Sources[string] };
  const values = initialRuntimeFormV2Values(form, sources);
  const tier = runtimeFormV2Choices(field(form, "tier"), sources, values);
  assert.ok(tier?.kind === "select");
  assert.deepEqual(tier.options.map((option) => [option.value, option.label, option.description]), [
    ["fast", "Fast tier", "Lower latency"],
    ["steady", "Steady (no choices key: the option's own label)", undefined],
  ]);
  const bare = runtimeFormV2Choices(field(form, "tier"), { tier: { ...sources.tier!, options: [{ value: "raw", label: "" }] } }, values);
  assert.deepEqual(bare?.kind === "select" && bare.options.map((option) => option.label), ["raw"], "no label anywhere: the raw value");
  const effort = runtimeFormV2Choices(field(form, "effort"), sources, values);
  assert.ok(effort?.kind === "select");
  assert.deepEqual(effort.options.map((option) => [option.value, option.label, option.description]), [
    ["low", "Low", "Fast responses with lighter reasoning"],
    ["high", "High", undefined],
    ["max", "max", undefined],
  ]);
  assert.equal(values.effort, "low", "derived default");
  // The served Codex/Grok effort labels come from choices.
  const codexValues = initialRuntimeFormV2Values(codex, codexSources("codex.option-source.live.json"));
  const codexEffort = runtimeFormV2Choices(field(codex, "reasoningEffort"), codexSources("codex.option-source.live.json"), codexValues);
  assert.deepEqual(codexEffort?.kind === "select" && codexEffort.options.map((option) => option.label), ["Low", "Medium", "High", "Extra high", "Max", "Ultra"]);
  assert.equal(codexValues.reasoningEffort, "medium");
});

test("option_source.status: fallback informs; unavailable blocks a required field and hides an optional one", () => {
  const fallback = codexSources("codex.option-source.fallback.json");
  assert.deepEqual(runtimeFormV2SourceStatus(field(codex, "model"), fallback), { status: "fallback", reason: "missing_config", retryable: false });
  assert.deepEqual(validateRuntimeFormV2(codex, fallback, initialRuntimeFormV2Values(codex, fallback)), {}, "a fallback list is usable");
  assert.equal(runtimeFormV2SourceStatus(field(codex, "model"), codexSources("codex.option-source.live.json")), null);

  const unavailable = codexSources("codex.option-source.unavailable.json");
  const values = initialRuntimeFormV2Values(codex, unavailable);
  assert.deepEqual(runtimeFormV2SourceStatus(field(codex, "model"), unavailable), { status: "unavailable", reason: "machine_offline", retryable: true });
  assert.equal(isRuntimeFormV2FieldVisible(field(codex, "model"), values, unavailable), true, "a required field stays to explain");
  assert.deepEqual(validateRuntimeFormV2(codex, unavailable, values), { model: "source_unavailable" });
  // Even a stored/typed value cannot be submitted while the required source is unavailable.
  assert.deepEqual(validateRuntimeFormV2(codexEdit, unavailable, initialRuntimeFormV2Values(codexEdit, unavailable), { editing: true }), { model: "source_unavailable" });

  // The same source behind an optional field: hidden, nothing to validate, the stored value survives an edit.
  const optional = { ...codexEdit, fields: codexEdit.fields.map((candidate) => candidate.key === "model" ? { ...candidate, required: false } : candidate) };
  const optionalValues = initialRuntimeFormV2Values(optional, unavailable);
  assert.equal(isRuntimeFormV2FieldVisible(field(optional, "model"), optionalValues, unavailable), false);
  assert.deepEqual(validateRuntimeFormV2(optional, unavailable, optionalValues), {});
  assert.equal(runtimeFormV2Submission(optional, { ...optionalValues, model: "" }, unavailable).model, "my-org/codex-custom");
  const optionalCreate = { ...optional, values: undefined };
  assert.equal("model" in runtimeFormV2Submission(optionalCreate, initialRuntimeFormV2Values(optionalCreate, unavailable), unavailable), false);

  // An unknown status or reason is tolerated: an unknown status is ignored, an unknown reason is passed on.
  const odd = { model: { ...unavailable.model!, status: "degraded" } } as unknown as RuntimeFormV2Sources;
  assert.equal(runtimeFormV2SourceStatus(field(codex, "model"), odd), null);
  const oddReason = { model: { ...unavailable.model!, reason: "brand_new_reason" } } as unknown as RuntimeFormV2Sources;
  assert.equal(runtimeFormV2SourceStatus(field(codex, "model"), oddReason)?.reason, "brand_new_reason");
});

test("option_source.status: a stale list (state stale) is a usable fallback that names when it was fetched", () => {
  const fallback = codexSources("codex.option-source.fallback.json");
  const stale = {
    model: { ...fallback.model!, reason: "probe_timeout", retryable: true, state: "stale", fetchedAt: "2026-10-21T08:00:00.000Z" },
  } as RuntimeFormV2Sources;
  assert.deepEqual(runtimeFormV2SourceStatus(field(codex, "model"), stale), {
    status: "fallback",
    reason: "probe_timeout",
    retryable: true,
    stale: { fetchedAt: "2026-10-21T08:00:00.000Z" },
  });
  assert.deepEqual(validateRuntimeFormV2(codex, stale, initialRuntimeFormV2Values(codex, stale)), {}, "a stale list is usable");
  // Any other state, an unknown one included, adds nothing.
  for (const state of ["ok", "unavailable", "brand_new_state"]) {
    const other = { model: { ...stale.model!, state } } as RuntimeFormV2Sources;
    assert.equal("stale" in (runtimeFormV2SourceStatus(field(codex, "model"), other) ?? {}), false, state);
  }
});

// Batch 3b: Claude's provider fields, against the shared fixtures the server sends.
const claude = parseRuntimeFormV2(fixture("claude.form.json"))!;
const claudeEdit = parseRuntimeFormV2(fixture("claude.edit.json"))!;
const claudeSources: RuntimeFormV2Sources = {
  provider: fixture("claude.option-source.provider.json") as RuntimeFormV2Sources[string],
  authType: fixture("claude.option-source.auth-type.json") as RuntimeFormV2Sources[string],
  model: fixture("claude.option-source.fallback.json") as RuntimeFormV2Sources[string],
};

test("claude: API URL and key show only for a Custom provider and are not submitted under Default", () => {
  const values = initialRuntimeFormV2Values(claude, claudeSources);
  assert.equal(values.provider, "default");
  assert.equal(values.model, "opus");
  for (const key of ["apiUrl", "authType", "apiKey"]) assert.equal(isRuntimeFormV2FieldVisible(field(claude, key), values, claudeSources), false, key);
  assert.deepEqual(validateRuntimeFormV2(claude, claudeSources, values), {});
  const submitted = runtimeFormV2Submission(claude, { ...values, apiUrl: "https://stale.example.test", apiKey: "stale" }, claudeSources);
  assert.equal("apiUrl" in submitted || "apiKey" in submitted, false);

  const custom = applyRuntimeFormV2Change(claude, claudeSources, values, "provider", "custom");
  for (const key of ["apiUrl", "authType", "apiKey"]) assert.equal(isRuntimeFormV2FieldVisible(field(claude, key), custom, claudeSources), true, key);
  assert.equal(custom.authType, "api_key", "API key is the default");
  assert.equal(field(claude, "apiKey").kind, "secret");
  assert.deepEqual(validateRuntimeFormV2(claude, claudeSources, { ...custom, apiUrl: "gw.example.test" }), { apiUrl: "invalid_url" });
});

test("claude edit: the stored key is never in the values; a blank key is valid and submitted blank (the server keeps the stored one)", () => {
  assert.equal(claudeEdit.values && "apiKey" in claudeEdit.values, false);
  const values = initialRuntimeFormV2Values(claudeEdit, claudeSources);
  assert.equal(values.provider, "custom");
  assert.equal(values.apiUrl, "https://gateway.example.test");
  assert.equal(values.apiKey, "");
  assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, values, { editing: true }), {});
  const submitted = runtimeFormV2Submission(claudeEdit, values, claudeSources);
  assert.equal(submitted.apiKey, "");
  assert.equal(submitted.command, "/usr/local/bin/claude");
  assert.equal(submitted.fastMode, true);
  assert.equal(submitted.reasoningEffort, "high");
});

test("writeOnlyKeepRequiresUnchanged: the fixtures declare which fields each stored secret is bound to", () => {
  assert.deepEqual(claudeEdit.writeOnlyKeepRequiresUnchanged, { apiKey: ["provider", "apiUrl"] });
  assert.deepEqual(parseRuntimeFormV2(fixture("pi.edit.json"))!.writeOnlyKeepRequiresUnchanged, { apiKey: ["provider"] });
  assert.deepEqual(parseRuntimeFormV2(fixture("builtin.edit.json"))!.writeOnlyKeepRequiresUnchanged, { apiKey: ["providerId", "baseUrl"] });
  // Create forms never carry it.
  for (const name of ["claude.form.json", "pi.form.json", "builtin.form.json"]) {
    assert.equal(fixture(name).writeOnlyKeepRequiresUnchanged, undefined, name);
  }
});

test("claude edit: a changed API URL with a blank key needs a new key; restoring it (or a trailing slash) or typing a key clears that", () => {
  const values = initialRuntimeFormV2Values(claudeEdit, claudeSources);
  const changed = { ...values, apiUrl: "https://other.example.test" };
  assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, changed, { editing: true }), { apiKey: "secret_reentry_required" });
  assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, { ...changed, apiKey: "sk-new" }, { editing: true }), {});
  for (const same of ["https://gateway.example.test/", "  https://gateway.example.test//  "]) {
    assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, { ...values, apiUrl: same }, { editing: true }), {}, same);
  }
  // Create has no stored key to keep: a blank key is plainly optional/required per the schema, never this code.
  assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, changed), {});
  // Default provider: the key field is hidden, nothing to ask for.
  assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, { ...values, provider: "default" }, { editing: true }), {});
});

test("claude edit from a Default provider: switching to Custom needs a key", () => {
  const fromDefault = parseRuntimeFormV2({ ...fixture("claude.edit.json"), values: { provider: "default", model: "sonnet", envVars: {} } })!;
  const values = applyRuntimeFormV2Change(fromDefault, claudeSources, initialRuntimeFormV2Values(fromDefault, claudeSources), "provider", "custom");
  assert.deepEqual(
    validateRuntimeFormV2(fromDefault, claudeSources, { ...values, apiUrl: "https://gateway.example.test" }, { editing: true }),
    { apiKey: "secret_reentry_required" },
  );
});

test("builtin edit: a hidden bound field is not compared (a preset provider has no base URL)", () => {
  const builtinEdit = parseRuntimeFormV2(fixture("builtin.edit.json"))!;
  const values = { ...initialRuntimeFormV2Values(builtinEdit, piSources), apiKey: "" };
  assert.deepEqual(validateRuntimeFormV2(builtinEdit, piSources, values, { editing: true }), {});
  assert.deepEqual(
    validateRuntimeFormV2(builtinEdit, piSources, { ...values, baseUrl: "https://other.example.test/v1" }, { editing: true }),
    { apiKey: "secret_reentry_required" },
  );
  const preset = parseRuntimeFormV2({ ...fixture("builtin.edit.json"), values: { providerId: "deepseek", model: "deepseek/v4", envVars: {} } })!;
  const presetValues = initialRuntimeFormV2Values(preset, piSources);
  assert.deepEqual(validateRuntimeFormV2(preset, piSources, { ...presetValues, baseUrl: "https://typed-then-hidden.example.test" }, { editing: true }), {});
});

test("writeOnlyKeepRequiresUnchanged is tolerant: malformed entries and unknown pointers are ignored", () => {
  for (const bad of [null, 1, "x", [], { "/apiKey": "not-a-list" }, { "/nope": ["/provider"] }, { "/apiKey": [1, "/nope"] }]) {
    const form = parseRuntimeFormV2({ ...fixture("claude.edit.json"), writeOnlyKeepRequiresUnchanged: bad })!;
    const values = { ...initialRuntimeFormV2Values(form, claudeSources), apiUrl: "https://other.example.test" };
    assert.deepEqual(validateRuntimeFormV2(form, claudeSources, values, { editing: true }), {}, JSON.stringify(bad));
  }
});

test("cursor: no effort field; a typed model is kept", () => {
  const cursorForm = parseRuntimeFormV2(fixture("cursor.form.json"))!;
  const sources: RuntimeFormV2Sources = { model: fixture("cursor.option-source.fallback.json") as RuntimeFormV2Sources[string] };
  assert.deepEqual(cursorForm.fields.map((candidate) => candidate.key), ["model", "envVars"]);
  const values = initialRuntimeFormV2Values(cursorForm, sources);
  assert.deepEqual(validateRuntimeFormV2(cursorForm, sources, { ...values, model: "my-org/typed" }), {});
  assert.deepEqual(runtimeFormV2SourceStatus(field(cursorForm, "model"), sources), { status: "fallback", reason: "missing_config", retryable: false });
});

// --- provider.saved_connection: saved provider connections inside a v2 form ---

const connFormJson = (): FormJsonish => {
  const raw = toRuntimeFormV2(releasedRuntimeFormDefinition("builtin-pi.create.v3")!) as unknown as FormJsonish;
  raw.requiredClientCapabilities = ["provider.saved_connection"];
  raw.revision = "rev-1";
  for (const key of ["apiKey", "baseUrl", "supportsImageInput"]) {
    raw.dataSchema.properties[key]!["x-connectionOwned"] = true;
  }
  return raw;
};
type FormJsonish = {
  [key: string]: unknown;
  dataSchema: { required: string[]; properties: Record<string, Record<string, unknown>> };
};
const conn = parseRuntimeFormV2(connFormJson())!;
const connSources: RuntimeFormV2Sources = {
  provider: {
    sourceId: "provider", kind: "select", pointer: "/providerId",
    options: [
      { value: "connection:conn-1", label: "DeepSeek · Team", group: "saved", connectionId: "conn-1", underlyingProviderId: "deepseek", providerKind: "preset" },
      { value: "connection:conn-2", label: "DeepSeek · Old", group: "saved", connectionId: "conn-2", underlyingProviderId: "deepseek", providerKind: "preset", unavailable: true, unavailableReason: "disabled" },
      { value: "deepseek", label: "DeepSeek", group: "direct", providerKind: "preset" },
      { value: "openai-compatible", label: "OpenAI compatible", group: "direct", providerKind: "gateway" },
    ],
    defaultValue: "deepseek",
  },
  model: {
    sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
    optionsByValue: {
      "connection:conn-1": [{ value: "deepseek/v4", label: "V4" }],
      "connection:conn-2": [{ value: "deepseek/v4", label: "V4" }],
      deepseek: [{ value: "deepseek/v4", label: "V4" }],
      "openai-compatible": [],
    },
    defaultValueByValue: { "connection:conn-1": "deepseek/v4", deepseek: "deepseek/v4" },
    customValueAllowedByValue: { "connection:conn-1": false, "connection:conn-2": false, deepseek: false, "openai-compatible": true },
  },
};

test("saved connection: parser keeps revision and x-connectionOwned", () => {
  assert.equal(conn.revision, "rev-1");
  assert.deepEqual(conn.requiredClientCapabilities, ["provider.saved_connection"]);
  const byKey = Object.fromEntries(conn.fields.map((candidate) => [candidate.key, candidate]));
  assert.equal(byKey.apiKey.connectionOwned, true);
  assert.equal(byKey.baseUrl.connectionOwned, true);
  assert.equal(byKey.supportsImageInput.connectionOwned, true);
  assert.equal(byKey.model.connectionOwned, undefined);
  assert.equal(pi.revision, undefined, "a form without the capability carries no revision");
});

test("saved connection: selecting one clears owned fields, lifts their required rule, and submits without them", () => {
  let values = initialRuntimeFormV2Values(conn, connSources);
  values = { ...values, apiKey: "sk-direct" };
  values = applyRuntimeFormV2Change(conn, connSources, values, "providerId", "connection:conn-1");
  assert.equal(values.apiKey, "", "switching to a connection clears the field it owns");
  assert.equal(values.model, "deepseek/v4", "the model follows the connection's own list");
  assert.deepEqual(validateRuntimeFormV2(conn, connSources, values), {}, "connection-owned fields are not the user's to fill");
  const submitted = runtimeFormV2Submission(conn, values, connSources);
  assert.equal("apiKey" in submitted, false, "owned fields never enter formValues, not even as empty strings");
  assert.equal("baseUrl" in submitted, false);
  assert.equal("supportsImageInput" in submitted, false);
  assert.equal(submitted.providerId, "connection:conn-1");
  assert.equal(submitted.model, "deepseek/v4");
});

test("saved connection: an unavailable binding stays visible and blocks the save", () => {
  const values = { ...initialRuntimeFormV2Values(conn, connSources), providerId: "connection:conn-2", model: "deepseek/v4" };
  assert.deepEqual(validateRuntimeFormV2(conn, connSources, values), { providerId: "connection_unavailable" });
});

test("saved connection: switching back to direct restores the schema's own rules", () => {
  let values = applyRuntimeFormV2Change(conn, connSources, initialRuntimeFormV2Values(conn, connSources), "providerId", "connection:conn-1");
  assert.deepEqual(validateRuntimeFormV2(conn, connSources, values), {});
  values = applyRuntimeFormV2Change(conn, connSources, values, "providerId", "openai-compatible");
  assert.deepEqual(validateRuntimeFormV2(conn, connSources, values), { apiKey: "required", model: "required" }, "the direct schema's own required rules are back once no connection is selected");
  const submitted = runtimeFormV2Submission(conn, { ...values, apiKey: "sk-direct", model: "any/model" }, connSources);
  assert.equal(submitted.apiKey, "sk-direct", "direct mode submits its own secret as before");
});

// Independent review: the gateway schema remains visible when managed by a connection.
test("review: saved gateway retains its endpoint and image-capability fields", () => {
  const sources: RuntimeFormV2Sources = structuredClone(connSources);
  sources.provider.options!.unshift({ value: "connection:gw", label: "Gateway", connectionId: "gw", underlyingProviderId: "openai-compatible", providerKind: "gateway", group: "saved" });
  const values = { ...initialRuntimeFormV2Values(conn, sources), providerId: "connection:gw", model: "any/model" };
  for (const key of ["baseUrl", "supportsImageInput"]) {
    assert.equal(isRuntimeFormV2FieldVisible(field(conn, key), { ...values, providerId: "openai-compatible" }, sources), true);
    assert.equal(isRuntimeFormV2FieldVisible(field(conn, key), values, sources), true, `${key} must stay visible as a disabled managed field`);
  }
});

// task #10: a dependent value with listed options that also takes a typed id
// (Built-in OpenRouter) is a combobox with its default, not a bare text box;
// one with no options (a gateway) stays free text.
test("dependent_select: listed options + custom allowed is a combobox keeping its default; no options stays free text", () => {
  const form = parseRuntimeFormV2(fixture("builtin.form.json"))!;
  const model = field(form, "model");
  const sources: RuntimeFormV2Sources = {
    provider: {
      sourceId: "provider",
      kind: "select",
      pointer: "/providerId",
      options: [{ value: "openrouter", label: "OpenRouter" }, { value: "openai-compatible", label: "OpenAI-compatible" }],
      defaultValue: "openrouter",
    },
    model: {
      sourceId: "model",
      kind: "dependent_select",
      pointer: "/model",
      dependsOn: "/providerId",
      optionsByValue: {
        openrouter: [{ value: "openrouter/vendor/listed", label: "Listed" }, { value: "openrouter/vendor/other", label: "Other" }],
        "openai-compatible": [],
      },
      defaultValueByValue: { openrouter: "openrouter/vendor/listed" },
      customValueAllowedByValue: { openrouter: true, "openai-compatible": true },
    },
  };
  const choices = runtimeFormV2Choices(model, sources, { providerId: "openrouter" });
  assert.equal(choices?.kind, "select");
  assert.equal(choices?.kind === "select" && choices.allowCustom, true);
  assert.equal(choices?.kind === "select" && choices.options.length, 2);
  const values = initialRuntimeFormV2Values(form, sources);
  assert.equal(values.providerId, "openrouter");
  assert.equal(values.model, "openrouter/vendor/listed", "the listed default is kept");
  assert.equal(validateRuntimeFormV2(form, sources, { ...values, model: "vendor/typed" }).model, undefined, "a typed id is valid");
  assert.deepEqual(runtimeFormV2Choices(model, sources, { providerId: "openai-compatible" }), { kind: "free_text" });
});

test("Advanced starts open when any visible advanced field has a non-blank value", () => {
  const builtin = parseRuntimeFormV2(fixture("builtin.form.json"))!;
  const builtinEdit = parseRuntimeFormV2(fixture("builtin.edit.json"))!;
  const gateway = { providerId: "openai-compatible", contextWindow: "", maxOutputTokens: "", envVars: {}, loadLocalPlugins: false };
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, gateway), false, "all advanced fields empty");
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, { ...gateway, contextWindow: "  " }), false, "blank is not a value");
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, { ...gateway, contextWindow: "128000" }), true);
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, { ...gateway, envVars: { A: "1" } }), true, "envVars with a value opens it too");
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, { ...gateway, loadLocalPlugins: true }), true);
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, { ...gateway, providerId: "anthropic", maxOutputTokens: "8192" }), false, "hidden field");
  // The edit fixture stores envVars: Advanced opens on edit.
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtinEdit, builtinEdit.values as Record<string, never>), true);
  assert.equal(runtimeFormV2AdvancedStartsOpen(builtin, { ...gateway, model: "m" }), false, "main fields never open it");
});
