import assert from "node:assert/strict";
import { RUNTIME_MODELS } from "@botiverse/raft-shared";
import {
  parseRuntimeModelSourcePayload,
  projectBundledRuntimeModelSuggestions,
  projectRuntimeModelLabelPresentation,
  projectRuntimeModelSourcePresentation,
} from "../src/hooks/useRuntimeModels";
import type {
  RuntimeModelSourceState,
} from "../src/hooks/useRuntimeModels";

const NON_LIVE: RuntimeModelSourceState[] = [
  { kind: "idle" },
  { kind: "loading" },
  { kind: "missing_config", recovery: "kimi_login" },
  { kind: "no_models" },
  { kind: "unsupported" },
  { kind: "error", retryable: true },
];

test("failed Grok detection preserves its reason and offers only unverified known models", () => {
  const source = parseRuntimeModelSourcePayload({ kind: "error", retryable: true, code: "runtime_not_authenticated" });
  assert.deepEqual(source, { kind: "error", retryable: true, code: "runtime_not_authenticated" });
  const presentation = projectRuntimeModelSourcePresentation("grok", source);
  assert.equal(presentation.source.kind, "error");
  assert.equal(presentation.fromMachine, false);
  assert.ok(presentation.models.some((m) => m.id === "grok-4.6"));
  assert.ok(presentation.models.every((m) => m.verified === "suggestion_only"));
  assert.deepEqual(parseRuntimeModelSourcePayload({ kind: "error", retryable: true, code: "secret arbitrary text" }), { kind: "error", retryable: true });
});

test("only terminal non-live states offer unverified fallback; pending requests never show stale catalogs", () => {
  for (const source of NON_LIVE) {
    const presentation = projectRuntimeModelSourcePresentation("kimi-sdk", source);
    if (source.kind === "idle" || source.kind === "loading") assert.deepEqual(presentation.models, [], source.kind);
    else {
      assert.ok(presentation.models.length > 0);
      assert.ok(presentation.models.every((m) => m.verified === "suggestion_only"));
    }
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

test("task #735: the runtime_not_found lookup reason survives parsing; absent or unknown drops to unresolved", () => {
  for (const reason of ["not_installed", "probe_timeout", "probe_failed", "permission_denied"] as const) {
    assert.deepEqual(
      parseRuntimeModelSourcePayload({ kind: "error", retryable: true, code: "runtime_not_found", reason }),
      { kind: "error", retryable: true, code: "runtime_not_found", reason },
      reason,
    );
  }
  // Old daemon: code present, no reason field.
  assert.deepEqual(
    parseRuntimeModelSourcePayload({ kind: "error", retryable: true, code: "runtime_not_found" }),
    { kind: "error", retryable: true, code: "runtime_not_found" },
  );
  // An unknown or malformed reason never reaches the display layer.
  assert.deepEqual(
    parseRuntimeModelSourcePayload({ kind: "error", retryable: true, code: "runtime_not_found", reason: "definitely_installed" }),
    { kind: "error", retryable: true, code: "runtime_not_found" },
  );
  assert.deepEqual(
    parseRuntimeModelSourcePayload({ kind: "error", retryable: true, code: "runtime_not_found", reason: 42 }),
    { kind: "error", retryable: true, code: "runtime_not_found" },
  );
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
  const catalogOf = (source: RuntimeModelSourceState) => source.kind === "live" ? source.value.catalog : undefined;
  assert.deepEqual(catalogOf(parsed), { protocolVersion: 1, runtime: "builtin", runtimeVersion: "0.84.3" });
  assert.equal(
    catalogOf(
      parseRuntimeModelSourcePayload({
        models: [{ id: "openrouter/model-a", label: "Model A" }],
      }),
    ),
    undefined,
    "new Web must not upgrade an old daemon list into a capability",
  );
  assert.equal(
    catalogOf(
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
    undefined,
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
  assert.ok(projectRuntimeModelSourcePresentation("kimi-sdk", { kind: "missing_config", recovery: "kimi_login" })
    .models.every((model) => model.verified === "suggestion_only"));

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
  assert.equal(presentation.source.kind, "loading", "loading presentation must not impersonate a confirmed live source");
});

test("Cursor fallback stays suggestion-only", () => {
  for (const source of [
    { kind: "no_models" } as const,
    { kind: "error", retryable: true } as const,
  ]) {
    assert.ok(projectRuntimeModelSourcePresentation("cursor", source).models.every((m) => m.verified === "suggestion_only"));
    assert.equal(
      projectBundledRuntimeModelSuggestions("cursor")
        .find((model) => model.id === "auto")?.verified,
      "suggestion_only",
    );
  }
});

test("a live Claude list keeps its disabled models out of the selectable list and adds no bundled models", () => {
  const source = parseRuntimeModelSourcePayload({
    kind: "live",
    value: {
      models: [
        { id: "opus", label: "Claude Opus (Opus 5.5)" },
        { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ],
      unavailable: [
        { id: "claude-opus-9", label: "Claude Opus 9", reason: `  Upgrade\n Claude Code ${"x".repeat(400)}` },
        { id: "claude-opus-9", label: "dup", reason: "dup" },
        { id: 42, label: "bad" },
      ],
    },
    // Older clients read only these legacy fields: usable models only.
    models: [{ id: "opus", label: "Claude Opus (Opus 5.5)" }],
  });
  assert.equal(source.kind, "live");
  const presentation = projectRuntimeModelSourcePresentation("claude", source);
  assert.deepEqual(presentation.models.map((m) => m.id), ["opus", "claude-opus-5-5", "claude-haiku-4-5-20251001"]);
  assert.deepEqual(presentation.unavailable.map((m) => m.id), ["claude-opus-9"], "bundled models the list lacks are not added");
  const [disabled] = presentation.unavailable;
  assert.ok(disabled?.runtimeReason?.startsWith("Upgrade Claude Code x"));
  assert.ok((disabled?.runtimeReason?.length ?? 0) <= 200);
});

test("the bundled catalog, a live list without disabled models, and non-live states show no unavailable models", () => {
  const bundled = parseRuntimeModelSourcePayload({ kind: "live", value: { models: RUNTIME_MODELS.claude } });
  assert.deepEqual(projectRuntimeModelSourcePresentation("claude", bundled).unavailable, []);
  // A live list with no disabled models: nothing greyed, whatever the bundled catalog holds.
  const oldDaemon = parseRuntimeModelSourcePayload({ kind: "live", value: { models: [{ id: "opus", label: "Claude Opus" }] } });
  assert.deepEqual(projectRuntimeModelSourcePresentation("claude", oldDaemon).unavailable, []);
  for (const source of NON_LIVE) {
    assert.deepEqual(projectRuntimeModelSourcePresentation("claude", source).unavailable, [], source.kind);
  }
});
