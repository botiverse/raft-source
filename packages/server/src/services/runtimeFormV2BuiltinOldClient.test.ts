// task #10 (Huaihuai's review of #13950): a shipped v2 client that does NOT
// advertise dependent_select.custom_value_with_options, simulated with the
// runtime-form state logic exactly as it shipped before this PR
// (testdata/runtimeFormV2StatePreTask10.ts), against what the server now
// serves that client. Evidence for:
//   (a) create keeps OpenRouter's default model;
//   (b) edit reads back a saved preset, a saved typed id and a saved listed
//       model with limits;
//   (c) a save that leaves the model alone keeps the stored model and limits;
// plus the refusals when such a client changes the model or provider of an
// agent a newer client saved.
import assert from "node:assert/strict";
import { vi } from "vitest";
import { parseRuntimeFormV2, type RuntimeFormV2Sources, type RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import { parseRuntimeConfig, type RuntimeConfig } from "@botiverse/raft-shared";
import {
  applyRuntimeFormV2Change,
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  runtimeFormV2Choices,
  runtimeFormV2Submission,
  validateRuntimeFormV2,
} from "./testdata/runtimeFormV2StatePreTask10";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  guardBuiltInEditFromClient,
  runtimeFormValuesFromRuntimeConfig,
  withBuiltInEditVisibility,
  withBuiltInModelLimitVisibility,
} from "./runtimeFormV2Registry";
import { buildBuiltInPiFormOptionSource, builtInPiListOnlyOptionSource } from "./runtimeFormDefinitionService";

vi.mock("./providerConnectionFeature", () => ({ isProviderConnectionsEnabled: vi.fn(async () => false) }));
vi.mock("./providerConnectionService", () => ({ listProviderConnections: vi.fn(async () => []) }));

// A listed OpenRouter model a reader saved: still in the catalog, just no longer the default.
const KIMI = "openrouter/moonshotai/kimi-k2.6";
/** OpenRouter's current default model, which an old client keeps when it carries the capability. */
const OPENROUTER_DEFAULT = "openrouter/moonshotai/kimi-k2.7-code";
const OTHER_LISTED = "openrouter/openrouter/auto";
const NO_CAPS: string[] = [];

/** The option sources the server sends a client without the capability (resolveOptionSource's list-only projection). */
const oldClientSources = {
  provider: buildBuiltInPiFormOptionSource("provider"),
  model: builtInPiListOnlyOptionSource(buildBuiltInPiFormOptionSource("model")!),
} as unknown as RuntimeFormV2Sources;
/** What the same client would get if the server ignored the capability (the bug the gate prevents). */
const ungatedSources = {
  provider: buildBuiltInPiFormOptionSource("provider"),
  model: buildBuiltInPiFormOptionSource("model"),
} as unknown as RuntimeFormV2Sources;

function stored(model: Record<string, unknown>, envVars: Record<string, string> | null = null): RuntimeConfig {
  const parsed = parseRuntimeConfig({
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-or-stored" },
      model,
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars,
    },
  });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.config;
}

/** The edit form the server serves this client for this agent (old client, Computer that runs typed ids). */
function oldClientEditForm(config: RuntimeConfig) {
  const definition = withBuiltInEditVisibility(buildRuntimeFormV2("builtin"), [], NO_CAPS, config);
  return parseRuntimeFormV2({ ...definition, values: runtimeFormValuesFromRuntimeConfig(config as unknown as Record<string, unknown>) })!;
}

/** The server side of an old client's edit save: the guard, the mapping, the parser. */
function oldClientSave(config: RuntimeConfig, form: ReturnType<typeof oldClientEditForm>, values: RuntimeFormV2Values) {
  const submission = runtimeFormV2Submission(form, values, oldClientSources);
  const guarded = guardBuiltInEditFromClient(submission, config, NO_CAPS);
  if (!guarded.ok) return guarded;
  const built = buildRuntimeConfigFromFormValues("builtin", guarded.values, { editing: true, existing: config });
  assert.ok(built.ok, JSON.stringify(built));
  // The key is write-only: the route keeps the stored one on an edit that does not change the provider.
  const parsed = parseRuntimeConfig({ runtimeConfig: built.ok ? { ...built.runtimeConfig, provider: config.provider } : null });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return { ok: true as const, config: parsed.config };
}

test("(a) create: an old client keeps OpenRouter's default model (and would lose it if the server ignored the capability)", () => {
  const form = parseRuntimeFormV2(withBuiltInModelLimitVisibility(buildRuntimeFormV2("builtin"), []))!;
  let values = initialRuntimeFormV2Values(form, oldClientSources);
  values = applyRuntimeFormV2Change(form, oldClientSources, values, "providerId", "openrouter");
  assert.equal(values.model, OPENROUTER_DEFAULT, "the default model");
  const model = form.fields.find((field) => field.key === "model")!;
  assert.equal(runtimeFormV2Choices(model, oldClientSources, values)?.kind, "select");
  const limit = form.fields.find((field) => field.key === "contextWindow")!;
  assert.equal(isRuntimeFormV2FieldVisible(limit, values, oldClientSources), false, "no OpenRouter limit fields");

  let ungated = initialRuntimeFormV2Values(form, ungatedSources);
  ungated = applyRuntimeFormV2Change(form, ungatedSources, ungated, "providerId", "openrouter");
  assert.equal(ungated.model, "", "without the gate the old client starts blank: the default is lost");
});

test("(b)+(c) a saved preset reads back, and a save of another field keeps it; no limit fields", () => {
  const config = stored({ kind: "preset", id: KIMI });
  const form = oldClientEditForm(config);
  const values = initialRuntimeFormV2Values(form, oldClientSources);
  assert.equal(values.model, KIMI);
  assert.equal(isRuntimeFormV2FieldVisible(form.fields.find((field) => field.key === "contextWindow")!, values, oldClientSources), false);
  const edited = applyRuntimeFormV2Change(form, oldClientSources, values, "envVars", { TEAM: "a" });
  assert.deepEqual(validateRuntimeFormV2(form, oldClientSources, edited, { editing: true }), {});
  const saved = oldClientSave(config, form, edited);
  assert.ok(saved.ok);
  if (saved.ok) assert.deepEqual(saved.config.model, config.model);
});

test("(b)+(c) a saved listed model with limits reads back as that model with its limits, and an untouched-model save keeps both", () => {
  const config = stored({ kind: "custom", name: KIMI, contextWindow: 131_072, maxOutputTokens: 16_384 });
  assert.deepEqual(config.model, { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 131_072, maxOutputTokens: 16_384 });
  const form = oldClientEditForm(config);
  const values = initialRuntimeFormV2Values(form, oldClientSources);
  assert.equal(values.model, KIMI, "shown as the listed model");
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    assert.equal(isRuntimeFormV2FieldVisible(form.fields.find((field) => field.key === key)!, values, oldClientSources), true, `${key} stays visible: it holds a stored value`);
  }
  assert.equal(values.contextWindow, "131072");
  const edited = applyRuntimeFormV2Change(form, oldClientSources, values, "envVars", { TEAM: "a" });
  assert.deepEqual(validateRuntimeFormV2(form, oldClientSources, edited, { editing: true }), {});
  const saved = oldClientSave(config, form, edited);
  assert.ok(saved.ok);
  if (saved.ok) assert.deepEqual(saved.config.model, config.model);
});

test("(b)+(c) a saved typed id the old list cannot show: the Model field is hidden, and an untouched-model save keeps the id and its limits", () => {
  const config = stored({ kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 });
  const form = oldClientEditForm(config);
  const values = initialRuntimeFormV2Values(form, oldClientSources);
  const model = form.fields.find((field) => field.key === "model")!;
  assert.equal(values.model, "vendor/unlisted-2099", "the stored value is read back");
  assert.equal(isRuntimeFormV2FieldVisible(model, values, oldClientSources), false, "hidden for OpenRouter: the old list would call it not_a_choice");
  assert.equal(isRuntimeFormV2FieldVisible(form.fields.find((field) => field.key === "contextWindow")!, values, oldClientSources), true);
  const edited = applyRuntimeFormV2Change(form, oldClientSources, values, "envVars", { TEAM: "a" });
  assert.deepEqual(validateRuntimeFormV2(form, oldClientSources, edited, { editing: true }), {}, "the save is not blocked");
  const saved = oldClientSave(config, form, edited);
  assert.ok(saved.ok);
  if (saved.ok) assert.deepEqual(saved.config.model, config.model);
});

test("an old client that switches the model of an agent saved with limits is refused, not silently carried over or cleared", () => {
  const config = stored({ kind: "custom", name: KIMI, contextWindow: 131_072 });
  const form = oldClientEditForm(config);
  const values = applyRuntimeFormV2Change(form, oldClientSources, initialRuntimeFormV2Values(form, oldClientSources), "model", OTHER_LISTED);
  const saved = oldClientSave(config, form, values);
  assert.equal(saved.ok, false);
  if (!saved.ok) {
    assert.equal(saved.issue.code, "runtime_form_client_upgrade_required");
    assert.equal(saved.issue.pointer, "/formValues/model");
  }
});

test("an old client that switches the provider of an agent saved with a typed id + limits is refused", () => {
  for (const model of [
    { kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 },
    { kind: "custom", name: KIMI, contextWindow: 131_072 },
  ]) {
    const config = stored(model);
    const form = oldClientEditForm(config);
    const values = applyRuntimeFormV2Change(form, oldClientSources, initialRuntimeFormV2Values(form, oldClientSources), "providerId", "deepseek");
    assert.equal(isRuntimeFormV2FieldVisible(form.fields.find((field) => field.key === "model")!, values, oldClientSources), true, "another provider shows the Model field again");
    const saved = oldClientSave(config, form, { ...values, apiKey: "sk-ds" });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.issue.pointer, "/formValues/providerId");
  }
});

test("a client WITH the capability is never guarded, and an agent without stored limits on an old Computer has the fields hidden", () => {
  const config = stored({ kind: "custom", name: KIMI, contextWindow: 131_072 });
  const guarded = guardBuiltInEditFromClient({ providerId: "deepseek", model: "deepseek/deepseek-v4-pro" }, config, ["dependent_select.custom_value_with_options"]);
  assert.equal(guarded.ok, true);
  const preset = stored({ kind: "preset", id: KIMI });
  const capable = parseRuntimeFormV2({
    ...withBuiltInEditVisibility(buildRuntimeFormV2("builtin"), [], ["dependent_select.custom_value_with_options"], preset),
    values: runtimeFormValuesFromRuntimeConfig(preset as unknown as Record<string, unknown>),
  })!;
  const limit = capable.fields.find((field) => field.key === "contextWindow")!;
  assert.equal(isRuntimeFormV2FieldVisible(limit, { providerId: "openrouter" }, oldClientSources), false, "old Computer, nothing stored: hidden");
});

test("the stored model is filled back in only where its field was hidden; a visible Model sent blank is model_required", () => {
  const listed = stored({ kind: "custom", name: KIMI, contextWindow: 131_072 });
  const blank = guardBuiltInEditFromClient({ providerId: "openrouter", model: "", contextWindow: "131072" }, listed, NO_CAPS);
  assert.ok(blank.ok);
  if (!blank.ok) return;
  assert.equal((blank.values as { model: string }).model, "", "not filled: the field was visible");
  const built = buildRuntimeConfigFromFormValues("builtin", blank.values, { editing: true, existing: listed });
  assert.equal(built.ok, false);
  if (!built.ok) assert.equal(built.issue.code, "model_required");

  const typed = stored({ kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 });
  const hidden = guardBuiltInEditFromClient({ providerId: "openrouter", contextWindow: "4096" }, typed, NO_CAPS);
  assert.ok(hidden.ok);
  if (hidden.ok) assert.equal((hidden.values as { model: string }).model, "vendor/unlisted-2099", "filled: the field was hidden");
});
