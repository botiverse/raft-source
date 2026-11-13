// task #10 (#wg-runtime-form, Huaihuai's review of #13950): on Built-in
// OpenRouter the limit fields are explicit overrides for ANY model. One rule
// for display, model switching and submit: shown whenever OpenRouter is the
// provider on a Computer that runs a typed id; a listed model with a limit is
// saved as a custom model named by its OpenRouter (Pi) id; clearing both
// limits gives the preset back. On an older Computer they are hidden and such
// a save is refused.
import assert from "node:assert/strict";
import { vi } from "vitest";
import {
  applyRuntimeFormV2Change,
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  parseRuntimeFormV2,
  runtimeFormV2Submission,
  type RuntimeFormV2Sources,
  type RuntimeFormV2Values,
} from "@botiverse/raft-runtime-form";
import { parseRuntimeConfig, type RuntimeConfig } from "@botiverse/raft-shared";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  runtimeFormValuesFromRuntimeConfig,
  withBuiltInModelLimitVisibility,
} from "./runtimeFormV2Registry";
import { BuiltInModelCatalogError, assertBuiltInPresetSupportedByCatalog } from "./builtinModelCatalogCompatibility";
import { buildBuiltInPiFormOptionSource } from "./runtimeFormDefinitionService";

vi.mock("./providerConnectionFeature", () => ({ isProviderConnectionsEnabled: vi.fn(async () => false) }));
vi.mock("./providerConnectionService", () => ({ listProviderConnections: vi.fn(async () => []) }));

const KIMI = "openrouter/moonshotai/kimi-k2.6";
const AUTO = "openrouter/openrouter/auto";

const form = parseRuntimeFormV2(buildRuntimeFormV2("builtin"))!;
const field = (key: string) => form.fields.find((candidate) => candidate.key === key)!;
const sources = {
  provider: buildBuiltInPiFormOptionSource("provider"),
  model: buildBuiltInPiFormOptionSource("model"),
} as unknown as RuntimeFormV2Sources;

function save(values: RuntimeFormV2Values): RuntimeConfig {
  const built = buildRuntimeConfigFromFormValues("builtin", runtimeFormV2Submission(form, values, sources));
  assert.ok(built.ok, JSON.stringify(built));
  const parsed = parseRuntimeConfig({ runtimeConfig: built.ok ? built.runtimeConfig : null });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.config;
}

function openRouterValues(model: string, limits: Record<string, string> = {}): RuntimeFormV2Values {
  let values = initialRuntimeFormV2Values(form, sources);
  values = applyRuntimeFormV2Change(form, sources, values, "providerId", "openrouter");
  values = applyRuntimeFormV2Change(form, sources, values, "apiKey", "sk-or-test");
  values = applyRuntimeFormV2Change(form, sources, values, "model", model);
  for (const [key, value] of Object.entries(limits)) values = applyRuntimeFormV2Change(form, sources, values, key, value);
  return values;
}

test("Huaihuai's counterexample: a listed model with contextWindow=131072 shows the field AND saves it, as a custom model", () => {
  const values = openRouterValues(KIMI, { contextWindow: "131072" });
  assert.equal(isRuntimeFormV2FieldVisible(field("contextWindow"), values, sources), true);
  assert.equal(isRuntimeFormV2FieldVisible(field("maxOutputTokens"), values, sources), true);
  const config = save(values);
  assert.deepEqual(config.model, { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 131_072 });
  assert.deepEqual(config.provider, { kind: "preset", providerId: "openrouter", apiKey: "sk-or-test" });
});

test("edit round trip: the listed model comes back with its limits, re-saving is identical, clearing both gives the preset", () => {
  const saved = save(openRouterValues(KIMI, { contextWindow: "131072", maxOutputTokens: "16384" }));
  const edit = runtimeFormValuesFromRuntimeConfig(saved as unknown as Record<string, unknown>)!;
  assert.equal(edit.model, KIMI, "shown as the listed model");
  assert.equal(edit.contextWindow, "131072");
  assert.equal(edit.maxOutputTokens, "16384");
  // The key is write-only and never read back; an edit keeps it server-side.
  const resubmit = { ...(edit as RuntimeFormV2Values), apiKey: "sk-or-test" };
  assert.deepEqual(save(resubmit).model, saved.model, "re-saving does not flip the form");
  const cleared = save({ ...resubmit, contextWindow: "", maxOutputTokens: "" });
  assert.deepEqual(cleared.model, { kind: "preset", id: KIMI });
});

test("typed -> listed -> typed keeps the entered limits visible and applied", () => {
  let values = openRouterValues("vendor/unlisted-2099", { contextWindow: "4096" });
  assert.deepEqual(save(values).model, { kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 });
  values = applyRuntimeFormV2Change(form, sources, values, "model", KIMI);
  assert.equal(values.contextWindow, "4096", "not cleared by the model switch");
  assert.equal(isRuntimeFormV2FieldVisible(field("contextWindow"), values, sources), true);
  assert.deepEqual(save(values).model, { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 4096 });
  values = applyRuntimeFormV2Change(form, sources, values, "model", "vendor/unlisted-2099");
  assert.equal(values.contextWindow, "4096");
  assert.deepEqual(save(values).model, { kind: "custom", name: "vendor/unlisted-2099", contextWindow: 4096 });
});

test("only Raft's one added namespace is stripped: openrouter/openrouter/auto + limit is openrouter/auto, and reads back as itself", () => {
  const saved = save(openRouterValues(AUTO, { maxOutputTokens: "2048" }));
  assert.deepEqual(saved.model, { kind: "custom", name: "openrouter/auto", maxOutputTokens: 2048 });
  assert.equal(runtimeFormValuesFromRuntimeConfig(saved as unknown as Record<string, unknown>)!.model, AUTO);
  assert.deepEqual(save(openRouterValues(AUTO)).model, { kind: "preset", id: AUTO });
  // The catalog also lists openrouter/auto itself (Pi id `auto`).
  assert.deepEqual(save(openRouterValues("openrouter/auto")).model, { kind: "preset", id: "openrouter/auto" });
  assert.deepEqual(save(openRouterValues("openrouter/auto", { contextWindow: "8192" })).model, { kind: "custom", name: "auto", contextWindow: 8192 });
});

test("an older Computer: the limit fields are hidden for OpenRouter, and a listed model with a limit is refused", () => {
  const old = parseRuntimeFormV2(withBuiltInModelLimitVisibility(buildRuntimeFormV2("builtin"), []))!;
  const oldField = old.fields.find((candidate) => candidate.key === "contextWindow")!;
  assert.equal(isRuntimeFormV2FieldVisible(oldField, { providerId: "openrouter" }, sources), false);
  assert.equal(isRuntimeFormV2FieldVisible(oldField, { providerId: "openai-compatible" }, sources), true, "gateways keep them");
  const current = parseRuntimeFormV2(withBuiltInModelLimitVisibility(buildRuntimeFormV2("builtin"), ["openrouter"]))!;
  assert.equal(isRuntimeFormV2FieldVisible(current.fields.find((candidate) => candidate.key === "contextWindow")!, { providerId: "openrouter" }, sources), true);

  // A client that sends the limit anyway: the catalog check refuses it.
  const config = save(openRouterValues(KIMI, { contextWindow: "131072" }));
  assert.throws(
    () => assertBuiltInPresetSupportedByCatalog(config, {
      kind: "live",
      value: { models: [{ id: KIMI, label: "Kimi" }], catalog: { protocolVersion: 1, runtime: "builtin", runtimeVersion: "1.5.0" } },
    }, { machineId: "m", daemonVersion: "1.0.67", computerVersion: "1.0.67" }),
    (error: unknown) => error instanceof BuiltInModelCatalogError && error.code === "builtin_custom_model_upgrade_required",
  );
});

test("the listed openrouter/openrouter/auto keeps API id openrouter/auto through save, read-back, re-save and clearing (task #10)", () => {
  const limited = save(openRouterValues(AUTO, { maxOutputTokens: "2048" }));
  assert.deepEqual(limited.model, { kind: "custom", name: "openrouter/auto", maxOutputTokens: 2048 });
  const edit: RuntimeFormV2Values = { ...(runtimeFormValuesFromRuntimeConfig(limited as unknown as Record<string, unknown>) as RuntimeFormV2Values), apiKey: "sk-or-test" };
  assert.equal(edit.model, AUTO, "read back as the listed entry it is, not as Pi's `auto` (openrouter/auto)");
  assert.deepEqual(save(edit).model, limited.model, "re-saving is identical");
  assert.deepEqual(save({ ...edit, maxOutputTokens: "" }).model, { kind: "preset", id: AUTO }, "clearing gives the same model's preset");
  assert.deepEqual(save(openRouterValues(AUTO)).model, { kind: "preset", id: AUTO });
});
