// task #10 (#wg-runtime-form): on Built-in Pi, a preset provider (OpenRouter,
// Qwen Token Plan, ...) also takes a typed model id, and a Computer that
// cannot run one for that provider never gets one.
import assert from "node:assert/strict";
import { parseRuntimeConfig, PI_BUILTIN_PROVIDER_MODELS, type RuntimeConfig } from "@botiverse/raft-shared";
import { buildRuntimeConfigFromFormValues, runtimeFormValuesFromRuntimeConfig } from "./runtimeFormV2Registry";
import {
  BuiltInModelCatalogError,
  assertBuiltInPresetSupportedByCatalog,
  builtInPresetSelectionChanged,
  filterBuiltInPiFormOptionSourceForCatalog,
  isBuiltInCatalogCheckedSelection,
} from "./builtinModelCatalogCompatibility";
import { buildBuiltInPiFormOptionSource, validateBuiltInPiDefinitionProjection } from "./runtimeFormDefinitionService";
import { isBuiltInGatewayCustomModelConfig } from "./agentModelLimitsService";

const listedOpenRouter = PI_BUILTIN_PROVIDER_MODELS.openrouter![0]!.id;
const openrouter = (model: string, extra: Record<string, string> = {}) => ({ providerId: "openrouter", apiKey: "sk-or-test", model, ...extra });

const target = { machineId: "machine-a", daemonVersion: "1.0.70", computerVersion: "1.0.70" };
const live = (customModelProviderIds?: string[]) => ({
  kind: "live" as const,
  value: {
    models: [{ id: listedOpenRouter, label: "listed" }],
    catalog: {
      protocolVersion: 1 as const,
      runtime: "builtin" as const,
      runtimeVersion: "1.5.0",
      ...(customModelProviderIds ? { customModelProviderIds } : {}),
    },
  },
});

function customOpenRouter(name = "vendor/unlisted-2099"): RuntimeConfig {
  const built = buildRuntimeConfigFromFormValues("builtin", openrouter(name));
  assert.ok(built.ok);
  const parsed = parseRuntimeConfig({ runtimeConfig: built.ok ? built.runtimeConfig : null });
  assert.ok(parsed.ok);
  return parsed.config;
}

test("a typed OpenRouter id is saved as a custom model with its limits, and edits round-trip", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", openrouter("vendor/unlisted-2099", { contextWindow: "131072", maxOutputTokens: "16384" }));
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.deepEqual(built.runtimeConfig.provider, { kind: "preset", providerId: "openrouter", apiKey: "sk-or-test" });
  assert.deepEqual(built.runtimeConfig.model, { kind: "custom", name: "vendor/unlisted-2099", contextWindow: 131_072, maxOutputTokens: 16_384 });
  assert.equal(parseRuntimeConfig({ runtimeConfig: built.runtimeConfig }).ok, true, "the shared parser accepts what the form builds");
  const values = runtimeFormValuesFromRuntimeConfig(built.runtimeConfig)!;
  assert.equal(values.model, "vendor/unlisted-2099");
  assert.equal(values.contextWindow, "131072");
  assert.equal(values.maxOutputTokens, "16384");
});

test("a listed OpenRouter model without a limit stays a preset", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", openrouter(listedOpenRouter));
  assert.ok(built.ok);
  if (built.ok) assert.deepEqual(built.runtimeConfig.model, { kind: "preset", id: listedOpenRouter });
});

test("Qwen Token Plan takes a typed id, stored as its own API id in either typed form", () => {
  const source = buildBuiltInPiFormOptionSource("model");
  assert.equal(source?.kind, "dependent_select");
  if (source?.kind !== "dependent_select") return;
  assert.equal(source.customValueAllowedByValue.openrouter, true);
  assert.equal(source.customValueAllowedByValue["qwen-token-plan"], true);
  assert.equal(source.customValueAllowedByValue["qwen-token-plan-cn"], true);
  assert.ok((source.optionsByValue["qwen-token-plan"] ?? []).length > 0, "the list stays alongside the typed value");
  assert.deepEqual(validateBuiltInPiDefinitionProjection(), [], "no drift issue for the served definition");
  for (const typed of ["qwen4-preview", "qwen-token-plan/qwen4-preview"]) {
    const built = buildRuntimeConfigFromFormValues("builtin", { providerId: "qwen-token-plan", apiKey: "sk-qwen", model: typed });
    assert.ok(built.ok, typed);
    const parsed = parseRuntimeConfig({ runtimeConfig: built.ok ? built.runtimeConfig : null });
    assert.ok(parsed.ok, typed);
    assert.deepEqual(parsed.ok && parsed.config.model, { kind: "custom", name: "qwen4-preview" }, typed);
  }
});

test("a reasoning effort for a typed id is taken where the provider's catalog all reasons, refused where not", () => {
  // Qwen Token Plan: every catalog model reasons, so a typed id runs with reasoning and keeps its effort.
  const qwen = buildRuntimeConfigFromFormValues("builtin", { providerId: "qwen-token-plan", apiKey: "sk-qwen", model: "qwen4-preview", reasoningEffort: "high" });
  assert.ok(qwen.ok);
  if (qwen.ok) assert.equal(qwen.runtimeConfig.reasoningEffort, "high");
  // OpenRouter keeps taking one, as before.
  const or = buildRuntimeConfigFromFormValues("builtin", openrouter("vendor/unlisted-2099", { reasoningEffort: "high" }));
  assert.ok(or.ok);
  // OpenAI lists models without reasoning: a typed id runs without, so an effort is refused on its field...
  const typed = buildRuntimeConfigFromFormValues("builtin", { providerId: "openai", apiKey: "sk-oa", model: "gpt-raft-test-2099", reasoningEffort: "high" });
  assert.equal(typed.ok, false);
  if (!typed.ok) assert.deepEqual(typed.issue, { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" });
  // ... while the default effort, and any effort on a listed OpenAI model, are fine.
  assert.equal(buildRuntimeConfigFromFormValues("builtin", { providerId: "openai", apiKey: "sk-oa", model: "gpt-raft-test-2099", reasoningEffort: "" }).ok, true);
  const listedOpenAi = PI_BUILTIN_PROVIDER_MODELS.openai![0]!.id;
  assert.equal(buildRuntimeConfigFromFormValues("builtin", { providerId: "openai", apiKey: "sk-oa", model: listedOpenAi, reasoningEffort: "high" }).ok, true);
});

test("a typed Qwen Token Plan id needs a Computer that reports the provider; an older one refuses it", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", { providerId: "qwen-token-plan", apiKey: "sk-qwen", model: "qwen4-preview" });
  assert.ok(built.ok);
  const parsed = parseRuntimeConfig({ runtimeConfig: built.ok ? built.runtimeConfig : null });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const config = parsed.config;
  assert.equal(isBuiltInCatalogCheckedSelection(config), true, "the write paths ask the Computer first");
  // No customModelProviderIds at all, and a Computer that only knows OpenRouter (before this change).
  for (const older of [live(), live(["openrouter"])]) {
    assert.throws(
      () => assertBuiltInPresetSupportedByCatalog(config, older, target),
      (error: unknown) => error instanceof BuiltInModelCatalogError
        && error.code === "builtin_custom_model_upgrade_required"
        && error.requestedModel === "qwen4-preview",
    );
  }
  assert.equal(assertBuiltInPresetSupportedByCatalog(config, live(["openrouter", "qwen-token-plan"]), target)?.requestedModel, "qwen4-preview");

  // The Model field there stays list-only for Qwen Token Plan.
  const source = buildBuiltInPiFormOptionSource("model")!;
  const listedQwen = PI_BUILTIN_PROVIDER_MODELS["qwen-token-plan"]![0]!.id;
  const old = filterBuiltInPiFormOptionSourceForCatalog(source, new Set([listedOpenRouter, listedQwen]), new Set(["openrouter"]));
  const current = filterBuiltInPiFormOptionSourceForCatalog(source, new Set([listedOpenRouter, listedQwen]), new Set(["openrouter", "qwen-token-plan"]));
  assert.equal(old.kind === "dependent_select" && old.customValueAllowedByValue["qwen-token-plan"], false);
  assert.equal(current.kind === "dependent_select" && current.customValueAllowedByValue["qwen-token-plan"], true);
});

test("a Computer whose catalog does not list OpenRouter keeps it list-only and refuses a typed id", () => {
  const source = buildBuiltInPiFormOptionSource("model")!;
  const old = filterBuiltInPiFormOptionSourceForCatalog(source, new Set([listedOpenRouter]));
  const current = filterBuiltInPiFormOptionSourceForCatalog(source, new Set([listedOpenRouter]), new Set(["openrouter"]));
  assert.equal(old.kind === "dependent_select" && old.customValueAllowedByValue.openrouter, false);
  assert.equal(current.kind === "dependent_select" && current.customValueAllowedByValue.openrouter, true);

  const config = customOpenRouter();
  assert.equal(isBuiltInCatalogCheckedSelection(config), true, "the write paths ask the Computer first");
  assert.throws(
    () => assertBuiltInPresetSupportedByCatalog(config, live(), target),
    (error: unknown) => error instanceof BuiltInModelCatalogError
      && error.code === "builtin_custom_model_upgrade_required"
      && error.requestedModel === "vendor/unlisted-2099",
  );
  const ticket = assertBuiltInPresetSupportedByCatalog(config, live(["openrouter"]), target);
  assert.equal(ticket?.requestedModel, "vendor/unlisted-2099");
});

test("changing the typed id is a new selection; the model-limits signal covers it", () => {
  const a = customOpenRouter("vendor/a");
  const b = customOpenRouter("vendor/b");
  assert.equal(builtInPresetSelectionChanged(a, b), true);
  assert.equal(builtInPresetSelectionChanged(a, customOpenRouter("vendor/a")), false);
  assert.equal(isBuiltInGatewayCustomModelConfig(a), true);
});
