import assert from "node:assert/strict";
import { test } from "vitest";
import { buildRuntimeModelSourceResultMessage } from "./runtimeModelSourceProjection.js";

test("runtime model wire carries typed live truth and legacy catalog together", () => {
  const message = buildRuntimeModelSourceResultMessage("req-live", {
    kind: "live",
    value: { models: [{ id: "live-model", label: "Live model" }], default: "live-model" },
  }, "launchable");

  assert.deepEqual(message.outcome, {
    kind: "live",
    value: {
      models: [{ id: "live-model", label: "Live model", verified: "launchable" }],
      default: "live-model",
    },
  });
  assert.deepEqual(message.models, [{ id: "live-model", label: "Live model", verified: "launchable" }]);
  assert.equal(message.default, "live-model");
  assert.equal(message.error, undefined);
});

test("runtime model wire preserves additive Built-in catalog provenance for new servers", () => {
  const catalog = {
    protocolVersion: 1 as const,
    runtime: "builtin" as const,
    runtimeVersion: "0.84.3",
  };
  const message = buildRuntimeModelSourceResultMessage(
    "req-catalog",
    {
      kind: "live",
      value: { models: [{ id: "live-model", label: "Live model" }], catalog },
    },
    "launchable",
  );

  assert.deepEqual(message.outcome, {
    kind: "live",
    value: {
      models: [
        { id: "live-model", label: "Live model", verified: "launchable" },
      ],
      default: undefined,
      catalog,
    },
  });
  // Rolling-upgrade compatibility remains the old fields; an old Server can
  // ignore the additive typed metadata and still consume this catalog.
  assert.deepEqual(message.models, [
    { id: "live-model", label: "Live model", verified: "launchable" },
  ]);
});

test("runtime model wire keeps every non-live outcome typed and legacy-safe", () => {
  const cases = [
    [{ kind: "missing_config", recovery: "kimi_login" }, { error: "missing_config" }],
    [{ kind: "no_models" }, { models: [] }],
    [{ kind: "unsupported" }, { error: "unsupported" }],
    [{ kind: "error", retryable: true }, { error: "error" }],
  ] as const;

  for (const [outcome, legacy] of cases) {
    const message = buildRuntimeModelSourceResultMessage("req-non-live", outcome, "launchable");
    assert.deepEqual(message.outcome, outcome);
    assert.deepEqual(
      "models" in legacy ? { models: message.models } : { error: message.error },
      legacy,
    );
  }
});

test("empty live catalog normalizes to no_models before crossing the wire", () => {
  const message = buildRuntimeModelSourceResultMessage(
    "req-empty",
    { kind: "live", value: { models: [] } },
    "launchable",
  );
  assert.deepEqual(message.outcome, { kind: "no_models" });
  assert.deepEqual(message.models, []);
});
