import assert from "node:assert/strict";
import type { BuiltInRuntimeProviderId, RuntimeConfig } from "@botiverse/raft-shared";
import {
  BuiltInModelCatalogError,
  assertBuiltInPresetSupportedByCatalog,
  builtInCatalogSelection,
  builtInPresetSelectionChanged,
  filterBuiltInPiFormOptionSourceForCatalog,
} from "./builtinModelCatalogCompatibility";
import { buildBuiltInPiFormOptionSource } from "./runtimeFormDefinitionService";

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
        null,
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
    null,
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
        null,
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
    }, null),
    false,
    "reasoning-only edit preserves the already persisted selection",
  );
  assert.equal(
    builtInPresetSelectionChanged(current, {
      ...current,
      provider: { ...current.provider, apiKey: "rotated-secret" },
    } as RuntimeConfig, null),
    false,
    "credential-only edit does not change catalog identity",
  );
  assert.equal(builtInPresetSelectionChanged(current, preset("model-b"), null), true);
  assert.equal(
    builtInPresetSelectionChanged(current, preset("model-a", "deepseek"), null),
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
        }, null),
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
      null,
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

test("a typed id through a saved preset connection is checked like a direct one, against what the Computer runs through a connection", () => {
  const throughConnection = (model: RuntimeConfig["model"], connectionId = "conn-1"): RuntimeConfig => ({
    version: 1,
    runtime: "builtin",
    provider: { kind: "connection", connectionId },
    model,
    mode: { kind: "default" },
    hostUserState: "forbidden",
  } as RuntimeConfig);
  const typed = throughConnection({ kind: "custom", name: "deepseek-v5-preview", contextWindow: 128_000 });
  const target = { machineId: "m", daemonVersion: "1.25.0", computerVersion: "1.25.0" };
  const catalog = (extra: Record<string, unknown>) => ({
    kind: "live" as const,
    value: {
      models: [{ id: "deepseek/deepseek-v4-pro", label: "V4 Pro" }],
      catalog: { protocolVersion: 1 as const, runtime: "builtin" as const, runtimeVersion: "0.84.3", ...extra },
    },
  });

  // Not checked here: an unresolved connection, a gateway connection, a listed model through a connection.
  assert.equal(builtInCatalogSelection(typed, null), null);
  assert.equal(builtInCatalogSelection(typed, "openai-compatible"), null);
  assert.equal(builtInCatalogSelection(throughConnection({ kind: "preset", id: "deepseek/deepseek-v4-pro" }), "deepseek"), null);
  assert.deepEqual(builtInCatalogSelection(typed, "deepseek")?.providerId, "deepseek");

  // A Computer that runs a typed DeepSeek id only directly cannot run it through a connection.
  assert.throws(
    () => assertBuiltInPresetSupportedByCatalog(typed, catalog({ customModelProviderIds: ["deepseek"] }), target, "deepseek"),
    (error: unknown) => error instanceof BuiltInModelCatalogError && error.code === "builtin_custom_model_upgrade_required",
  );
  const validation = assertBuiltInPresetSupportedByCatalog(
    typed,
    catalog({ customModelProviderIds: ["deepseek"], customModelConnectionProviderIds: ["deepseek"] }),
    target,
    "deepseek",
  );
  assert.equal(validation?.requestedModel, "deepseek-v5-preview");

  // A new typed id or another connection is a new selection; a limit-only edit is not.
  assert.equal(builtInPresetSelectionChanged(typed, throughConnection({ kind: "custom", name: "deepseek-v5-preview" }), "deepseek"), false);
  assert.equal(builtInPresetSelectionChanged(typed, throughConnection({ kind: "custom", name: "deepseek-v6" }), "deepseek"), true);
  assert.equal(builtInPresetSelectionChanged(typed, throughConnection({ kind: "custom", name: "deepseek-v5-preview" }, "conn-2"), "deepseek"), true);
});
