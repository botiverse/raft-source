import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_MODELS } from "@botiverse/raft-shared";
import {
  builtInCatalogCapabilityIsLive,
  parseRuntimeModelSourcePayload,
  projectBuiltInPresetModelOptions,
  projectBundledRuntimeModelSuggestions,
  projectRuntimeModelLabelPresentation,
  projectRuntimeModelSourcePresentation,
  runtimeModelSelectionIsRunnable,
} from "../src/hooks/useRuntimeModels.js";
import type {
  RuntimeModelSourceState,
} from "../src/hooks/useRuntimeModels.js";

const NON_LIVE: RuntimeModelSourceState[] = [
  { kind: "idle" },
  { kind: "loading" },
  { kind: "missing_config", recovery: "kimi_login" },
  { kind: "no_models" },
  { kind: "unsupported" },
  { kind: "error", retryable: true },
];

test("every non-live state projects models=[]; bundled metadata cannot re-enter options", () => {
  for (const source of NON_LIVE) {
    const presentation = projectRuntimeModelSourcePresentation("kimi-sdk", source);
    assert.deepEqual(presentation.models, [], source.kind);
    assert.equal(runtimeModelSelectionIsRunnable({
      source,
      model: "kimi-code/kimi-for-coding",
      customMode: false,
      customAllowed: false,
    }), false, source.kind);
  }
});

test("one model-label projection owns pending, live, and terminal fallback copy", () => {
  const base = {
    models: [],
  };
  assert.deepEqual(
    projectRuntimeModelLabelPresentation("kimi-sdk", "kimi-code/k3-256k", { ...base, source: { kind: "loading" } }),
    { kind: "pending" },
  );

  assert.deepEqual(projectRuntimeModelLabelPresentation("kimi-sdk", "kimi-code/k3-256k", {
    ...base,
    source: {
      kind: "live",
      value: { models: [{ id: "kimi-code/k3-256k", label: "K3-256k" }] },
    },
    models: [{ id: "kimi-code/k3-256k", label: "K3-256k" }],
  }), { kind: "resolved", label: "K3-256k" });

  for (const source of [
    { kind: "missing_config" } as const,
    { kind: "no_models" } as const,
    { kind: "unsupported" } as const,
    { kind: "error", retryable: true } as const,
  ]) {
    assert.deepEqual(
      projectRuntimeModelLabelPresentation("kimi-sdk", "kimi-code/k3-256k", { ...base, source }),
      { kind: "resolved", label: "kimi-code/k3-256k" },
      source.kind,
    );
  }

  assert.deepEqual(projectRuntimeModelLabelPresentation("kimi-sdk", "kimi-code/k3-256k", {
    models: [],
    source: { kind: "idle" },
  }), { kind: "resolved", label: "kimi-code/k3-256k" }, "a stripped/non-requested projection keeps public fallback copy");

  assert.deepEqual(projectRuntimeModelLabelPresentation("claude", "opus", {
    models: [{ id: "opus", label: "Claude Opus" }],
    source: { kind: "loading", previous: { models: [{ id: "opus", label: "Claude Opus" }] } },
  }), { kind: "resolved", label: "Claude Opus" }, "declared static catalogs never regress to a loading label");
});

test("typed and legacy payloads preserve live, empty, and error truth", () => {
  const live = { kind: "live", value: { models: [{ id: "k2.7", label: "K2.7" }], default: "k2.7" } } as const;
  assert.deepEqual(parseRuntimeModelSourcePayload(live), live);
  assert.deepEqual(parseRuntimeModelSourcePayload({
    ...live,
    models: [{ id: "legacy/fake", label: "Legacy fake" }],
    default: "legacy/fake",
  }), live, "typed live truth must win over additive compatibility fields");
  assert.deepEqual(parseRuntimeModelSourcePayload({ models: [] }), { kind: "no_models" });
  assert.deepEqual(parseRuntimeModelSourcePayload({ models: [{ id: "oc/live", label: "OC live" }] }), {
    kind: "live",
    value: { models: [{ id: "oc/live", label: "OC live" }] },
  });
  assert.deepEqual(parseRuntimeModelSourcePayload({ kind: "error", retryable: false }), {
    kind: "error",
    retryable: false,
  },
  );
});

test("Built-in catalog provenance survives parsing while malformed and legacy payloads stay unproven", () => {
  const parsed = parseRuntimeModelSourcePayload({
    kind: "live",
    value: {
      models: [{ id: "openrouter/model-a", label: "Model A" }],
      catalog: {
        protocolVersion: 1,
        runtime: "builtin",
        runtimeVersion: "0.84.3",
      },
    },
  });
  assert.equal(builtInCatalogCapabilityIsLive(parsed), true);
  assert.equal(
    builtInCatalogCapabilityIsLive(
      parseRuntimeModelSourcePayload({
        models: [{ id: "openrouter/model-a", label: "Model A" }],
      }),
    ),
    false,
    "new Web must not upgrade an old daemon list into a capability",
  );
  assert.equal(
    builtInCatalogCapabilityIsLive(
      parseRuntimeModelSourcePayload({
        kind: "live",
        value: {
          models: [{ id: "openrouter/model-a", label: "Model A" }],
          catalog: {
            protocolVersion: 1,
            runtime: "builtin",
            runtimeVersion: "",
          },
        },
      }),
    ),
    false,
  );
});

test("Built-in options are target-catalog intersections and preserve unavailable stored identity disabled", () => {
  const providerModels = [
    { id: "openrouter/model-a", label: "Model A" },
    { id: "openrouter/model-b", label: "Model B" },
  ];
  const live: RuntimeModelSourceState = {
    kind: "live",
    value: {
      models: [{ id: "openrouter/model-a", label: "Machine A" }],
      catalog: {
        protocolVersion: 1,
        runtime: "builtin",
        runtimeVersion: "0.84.3",
      },
    },
  };
  assert.deepEqual(
    projectBuiltInPresetModelOptions({
      source: live,
      providerModels,
      persistedModel: "openrouter/model-b",
    }),
    [
      { id: "openrouter/model-a", label: "Model A" },
      { id: "openrouter/model-b", label: "Model B", disabled: true },
    ],
  );
  assert.deepEqual(
    projectBuiltInPresetModelOptions({
      source: { kind: "error", retryable: true },
      providerModels,
      persistedModel: "openrouter/model-b",
    }),
    [{ id: "openrouter/model-b", label: "Model B", disabled: true }],
  );
});

test("dynamic bundled metadata is suggestion-only even when the legacy catalog claimed launchable", () => {
  const raw = RUNTIME_MODELS["kimi-sdk"]?.find((model) => model.id === "kimi-code/kimi-for-coding");
  assert.equal(raw?.verified, "launchable");

  const suggestions = projectBundledRuntimeModelSuggestions("kimi-sdk");
  assert.equal(
    suggestions.find((model) => model.id === raw?.id)?.verified,
    "suggestion_only",
  );
  assert.deepEqual(
    projectRuntimeModelSourcePresentation("kimi-sdk", { kind: "missing_config", recovery: "kimi_login" }).models,
    [],
  );

  assert.equal(
    projectBundledRuntimeModelSuggestions("claude").every((model) => model.verified === "launchable"),
    true,
    "declared static sources retain their canonical verification contract",
  );
});

test("declared static sources remain labeled during confirmation without becoming live authority", () => {
  const staticClaude = {
    models: [{ id: "opus", label: "Claude Opus", verified: "launchable" as const }],
  };
  const presentation = projectRuntimeModelSourcePresentation("claude", {
    kind: "loading",
    previous: staticClaude,
  });

  assert.deepEqual(presentation.models, staticClaude.models);
  assert.equal(presentation.loading, true);
  assert.equal(presentation.source.kind, "loading");
  assert.equal(runtimeModelSelectionIsRunnable({
    source: presentation.source,
    model: "opus",
    customMode: false,
    customAllowed: true,
  }), false, "loading presentation must not impersonate a confirmed live source");
});

test("only live membership, explicit provider catalogs, or allowed custom overrides are runnable", () => {
  const live: RuntimeModelSourceState = {
    kind: "live",
    value: { models: [{ id: "machine/live", label: "Machine live" }] },
  };
  assert.equal(runtimeModelSelectionIsRunnable({ source: live, model: "machine/live", customMode: false, customAllowed: false }), true);
  assert.equal(runtimeModelSelectionIsRunnable({ source: live, model: "bundled/fake", customMode: false, customAllowed: false }), false);
  assert.equal(runtimeModelSelectionIsRunnable({ source: { kind: "error", retryable: true }, model: "custom/safe", customMode: true, customAllowed: true }), true);
  assert.equal(runtimeModelSelectionIsRunnable({ source: { kind: "error", retryable: true }, model: "custom/forbidden", customMode: true, customAllowed: false }), false);
  assert.equal(runtimeModelSelectionIsRunnable({ source: { kind: "no_models" }, model: "provider/model", customMode: false, customAllowed: false, providerCatalog: true }), true,
  );
  assert.equal(
    runtimeModelSelectionIsRunnable({
      source: live,
      model: "machine/live",
      customMode: false,
      customAllowed: false,
      requireBuiltInCatalog: true,
    }),
    false,
    "a legacy live list is not a Built-in capability",
  );
  assert.equal(
    runtimeModelSelectionIsRunnable({
      source: {
        ...live,
        value: {
          ...live.value,
          catalog: {
            protocolVersion: 1,
            runtime: "builtin",
            runtimeVersion: "0.84.3",
          },
        },
      },
      model: "machine/live",
      customMode: false,
      customAllowed: false,
      requireBuiltInCatalog: true,
    }),
    true,
  );
  assert.equal(
    runtimeModelSelectionIsRunnable({
      source: { kind: "error", retryable: true },
      model: "persisted/legacy",
      customMode: false,
      customAllowed: false,
      persistedModel: "persisted/legacy",
      requireBuiltInCatalog: true,
    }),
    true,
    "an unchanged stored selection stays editable without becoming a new catalog write",
  );
  assert.equal(runtimeModelSelectionIsRunnable({ source: { kind: "unsupported" }, model: "default", modelIgnored: true, customMode: false, customAllowed: false }), true);
});

test("Cursor bundled Auto cannot become create or edit authority while its probe is non-live", () => {
  for (const source of [
    { kind: "no_models" } as const,
    { kind: "error", retryable: true } as const,
  ]) {
    assert.deepEqual(projectRuntimeModelSourcePresentation("cursor", source).models, []);
    assert.equal(
      projectBundledRuntimeModelSuggestions("cursor")
        .find((model) => model.id === "auto")?.verified,
      "suggestion_only",
    );
    assert.equal(runtimeModelSelectionIsRunnable({
      source,
      model: "auto",
      customMode: false,
      customAllowed: true,
    }), false, `${source.kind}: create`);
    assert.equal(runtimeModelSelectionIsRunnable({
      source,
      model: "auto",
      customMode: false,
      customAllowed: true,
      persistedModel: "auto",
    }), false, `${source.kind}: edit`);
  }

  assert.equal(runtimeModelSelectionIsRunnable({
    source: {
      kind: "live",
      value: { models: [{ id: "auto", label: "Auto" }], default: "auto" },
    },
    model: "auto",
    customMode: false,
    customAllowed: true,
    persistedModel: "auto",
  }), true);
});
