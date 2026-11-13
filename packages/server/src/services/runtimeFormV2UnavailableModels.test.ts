/**
 * `OptionSource.unavailableOptions`: models a Computer's runtime listed but
 * disabled, sent beside `options` (never in it: every older web/mobile client
 * offers each entry of `options`). Raft's bundled catalog never adds entries.
 */
import assert from "node:assert/strict";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import {
  runtimeFormV2Entry,
  withoutV2OnlyOptionSourceFields,
  type RuntimeFormOptionSourceContext,
  type RuntimeFormV2OptionSourceBody,
} from "./runtimeFormV2Registry";

async function modelSource(runtimeId: string, outcome: RuntimeModelSourceOutcome): Promise<RuntimeFormV2OptionSourceBody> {
  const context = {
    sourceId: "model",
    machineId: "machine-1",
    machine: {},
    sourceStatus: true,
    agentOrchestrator: { detectMachineRuntimeModels: async () => outcome },
    routeToComputer: async () => "confirmed_local",
  } as unknown as RuntimeFormOptionSourceContext;
  const resolution = await runtimeFormV2Entry(runtimeId)!.resolveOptionSource(context);
  assert.ok(resolution.kind === "source" && resolution.source);
  return resolution.source;
}

const optionValues = (source: RuntimeFormV2OptionSourceBody) =>
  source.kind === "select" ? source.options.map((option) => option.value) : [];

test("Claude's own list: only its disabled models, with the runtime's reason, none in options; no bundled models", async () => {
  const source = await modelSource("claude", {
    kind: "live",
    value: {
      models: [{ id: "opus", label: "Claude Opus" }, { id: "claude-opus-5-5", label: "Claude Opus 5.5" }],
      unavailable: [{ id: "claude-opus-9", label: "Claude Opus 9", reason: `  Update\n Claude Code ${"x".repeat(400)}` }],
    },
  });
  assert.deepEqual(optionValues(source), ["opus", "claude-opus-5-5"]);
  const unavailable = source.unavailableOptions ?? [];
  assert.deepEqual(unavailable.map((option) => option.value), ["claude-opus-9"], "bundled models the list lacks are not added");
  assert.ok(unavailable[0]?.reason?.startsWith("Update Claude Code x"), "re-sanitized on the server");
  assert.ok((unavailable[0]?.reason?.length ?? 0) <= 200);
});

test("no unavailableOptions on the bundled fallback or on a live list with no disabled models", async () => {
  const offline = await modelSource("claude", { kind: "error", retryable: true, code: "computer_offline" });
  assert.equal(offline.status, "fallback");
  assert.ok(!("unavailableOptions" in offline));
  const allUsable = await modelSource("claude", { kind: "live", value: { models: [{ id: "opus", label: "Claude Opus" }] } });
  assert.ok(!("unavailableOptions" in allUsable));
});

test("a runtime without a bundled catalog still reports the models its listing disabled", async () => {
  const qoder = await modelSource("qoder", {
    kind: "live",
    value: { models: [{ id: "q-1", label: "Q 1" }], unavailable: [{ id: "q-pro", label: "Q Pro", reason: "Needs a paid plan" }] },
  });
  assert.deepEqual(qoder.unavailableOptions, [{ value: "q-pro", label: "Q Pro", reason: "Needs a paid plan" }]);
  const opencode = await modelSource("opencode", {
    kind: "live",
    value: { models: [{ id: "a/one", label: "One" }], unavailable: [{ id: "a/two", label: "Two", reason: "" }] },
  });
  assert.deepEqual(optionValues(opencode), ["a/one"]);
  assert.deepEqual(opencode.unavailableOptions, [{ value: "a/two", label: "Two" }]);
});

test("v1 option-source responses never carry the v2 field", () => {
  const body = {
    protocolVersion: 1, runtimeId: "claude", schemaVersion: "s", sourceId: "model", pointer: "/model",
    kind: "select", options: [{ value: "opus", label: "Opus" }], defaultValue: "opus",
    unavailableOptions: [{ value: "x", label: "X" }],
  } as RuntimeFormV2OptionSourceBody;
  assert.ok(!("unavailableOptions" in withoutV2OnlyOptionSourceFields(body)));
  const plain = { ...body, unavailableOptions: undefined };
  delete plain.unavailableOptions;
  assert.equal(withoutV2OnlyOptionSourceFields(plain), plain);
});
