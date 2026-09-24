import assert from "node:assert/strict";
import { test } from "vitest";
import type { BuiltInRuntimeProviderId, RuntimeConfig } from "@botiverse/raft-shared";
import {
  BuiltInModelCatalogError,
  assertBuiltInPresetSupportedByCatalog,
  builtInPresetSelectionChanged,
  filterBuiltInPiFormOptionSourceForCatalog,
} from "./builtinModelCatalogCompatibility.js";
import { buildBuiltInPiFormOptionSource } from "./runtimeFormDefinitionService.js";

const preset = (
  model: string,
  providerId: BuiltInRuntimeProviderId = "openrouter",
): RuntimeConfig => ({
  version: 1,
  runtime: "builtin",
  provider: { kind: "preset", providerId, apiKey: "secret" },
  model: { kind: "preset", id: model },
  mode: { kind: "default" },
  hostUserState: "forbidden",
});

const live = (models: string[], metadata = true) => ({
  kind: "live" as const,
  value: {
    models: models.map((id) => ({ id, label: id })),
    ...(metadata
      ? {
          catalog: {
            protocolVersion: 1 as const,
            runtime: "builtin" as const,
            runtimeVersion: "0.84.3",
          },
        }
      : {}),
  },
});

test("new Server rejects a legacy Built-in live list without provenance", () => {
  assert.throws(
    () =>
      assertBuiltInPresetSupportedByCatalog(
        preset("model-a"),
        live(["model-a"], false),
        {
          machineId: "machine-a",
          daemonVersion: "1.0.17",
          computerVersion: "1.0.17",
        },
      ),
    (error: unknown) =>
      error instanceof BuiltInModelCatalogError &&
      error.code === "builtin_catalog_capability_required" &&
      error.recovery === "upgrade_required",
  );
});

test("new Server allows only a model present in the target Built-in catalog", () => {
  const ticket = assertBuiltInPresetSupportedByCatalog(
    preset("model-a"),
    live(["model-a"]),
    {
      machineId: "machine-a",
      daemonVersion: "1.0.23",
      computerVersion: "1.0.23",
    },
  );
  assert.ok(ticket);
  assert.equal(ticket.requestedModel, "model-a");
  assert.equal(ticket.catalogRuntimeVersion, "0.84.3");

  assert.throws(
    () =>
      assertBuiltInPresetSupportedByCatalog(
        preset("deleted-model"),
        live(["model-a"]),
        {
          machineId: "machine-a",
          daemonVersion: "1.0.23",
          computerVersion: "1.0.23",
        },
      ),
    (error: unknown) =>
      error instanceof BuiltInModelCatalogError &&
      error.code === "builtin_model_unsupported_by_target" &&
      error.requestedModel === "deleted-model" &&
      error.recovery === "upgrade_or_reselect",
  );
});

test("only a Built-in preset identity change needs a new catalog authorization", () => {
  const current = preset("model-a");
  assert.equal(
    builtInPresetSelectionChanged(current, {
      ...current,
      reasoningEffort: "high",
    }),
    false,
    "reasoning-only edit preserves the already persisted selection",
  );
  assert.equal(
    builtInPresetSelectionChanged(current, {
      ...current,
      provider: { ...current.provider, apiKey: "rotated-secret" },
    } as RuntimeConfig),
    false,
    "credential-only edit does not change catalog identity",
  );
  assert.equal(builtInPresetSelectionChanged(current, preset("model-b")), true);
  assert.equal(
    builtInPresetSelectionChanged(current, preset("model-a", "deepseek")),
    true,
  );
});

test("offline and timeout outcomes remain typed and never become empty catalogs", () => {
  for (const outcome of [
    { kind: "unsupported" as const },
    { kind: "error" as const, retryable: true },
  ]) {
    assert.throws(
      () =>
        assertBuiltInPresetSupportedByCatalog(preset("model-a"), outcome, {
          machineId: "machine-a",
          daemonVersion: "1.0.23",
          computerVersion: "1.0.23",
        }),
      (error: unknown) =>
        error instanceof BuiltInModelCatalogError &&
        error.code === "builtin_catalog_unavailable",
    );
  }
});

test("gateway and connection configs stay outside the closed preset catalog", () => {
  const gateway: RuntimeConfig = {
    version: 1,
    runtime: "builtin",
    provider: {
      kind: "gateway",
      providerId: "openai-compatible",
      apiKey: "secret",
      baseUrl: "https://example.test",
      supportsImageInput: false,
    },
    model: { kind: "custom", name: "private-model" },
    mode: { kind: "default" },
    hostUserState: "forbidden",
  };
  assert.equal(
    assertBuiltInPresetSupportedByCatalog(
      gateway,
      { kind: "unsupported" },
      {
        machineId: "machine-a",
        daemonVersion: "1.0.17",
        computerVersion: "1.0.17",
      },
    ),
    null,
  );
});

test("machine-scoped form sources retain provider shape and filter preset models", () => {
  const provider = buildBuiltInPiFormOptionSource("provider");
  const models = buildBuiltInPiFormOptionSource("model");
  assert.ok(provider && models);
  const supported = new Set(["openrouter/deepseek/deepseek-v4-flash-0731"]);
  const filteredProvider = filterBuiltInPiFormOptionSourceForCatalog(
    provider,
    supported,
  );
  const filteredModels = filterBuiltInPiFormOptionSourceForCatalog(
    models,
    supported,
  );
  assert.equal(filteredProvider.kind, "select");
  if (filteredProvider.kind !== "select")
    assert.fail("expected provider source");
  assert.deepEqual(
    filteredProvider.options.map((option) => option.value),
    ["openrouter", "openai-compatible", "anthropic-compatible"],
  );
  assert.equal(filteredProvider.defaultValue, "openrouter");
  assert.equal(filteredModels.kind, "dependent_select");
  if (filteredModels.kind !== "dependent_select")
    assert.fail("expected dependent source");
  assert.deepEqual(
    Object.values(filteredModels.optionsByValue)
      .flat()
      .map((option) => option.value),
    ["openrouter/deepseek/deepseek-v4-flash-0731"],
  );
  assert.deepEqual(Object.keys(filteredModels.optionsByValue), [
    "openrouter",
    "openai-compatible",
    "anthropic-compatible",
  ]);
});
