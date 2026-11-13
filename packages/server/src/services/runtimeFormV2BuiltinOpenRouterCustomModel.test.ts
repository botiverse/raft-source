// task #10 (#wg-runtime-form): on Built-in Pi, the OpenRouter provider also
// takes a typed model id; every other preset provider stays list-only, and a
// Computer that cannot run one never gets one.
import assert from "node:assert/strict";
import { vi } from "vitest";
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

vi.mock("./providerConnectionFeature", () => ({ isProviderConnectionsEnabled: vi.fn(async () => false) }));
vi.mock("./providerConnectionService", () => ({ listProviderConnections: vi.fn(async () => []) }));

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

test("other preset providers still refuse a typed id", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", { providerId: "deepseek", apiKey: "sk-ds", model: "deepseek-v9" });
  assert.equal(built.ok, false);
  if (!built.ok) assert.equal(built.issue.code, "select_valid_provider_model");
  const source = buildBuiltInPiFormOptionSource("model");
  assert.equal(source?.kind, "dependent_select");
  if (source?.kind !== "dependent_select") return;
  assert.equal(source.customValueAllowedByValue.openrouter, true);
  assert.equal(source.customValueAllowedByValue.deepseek, false);
  assert.deepEqual(validateBuiltInPiDefinitionProjection(), [], "no drift issue for the served definition");
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
  assert.equal(isBuiltInGatewayCustomModelConfig(a, null), true);
});
