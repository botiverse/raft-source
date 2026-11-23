import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import type { ListModelsOptions, ListModelsResult, ModelEntry, ModelLister } from "@botiverse/oar";

import { AntigravityDriver } from "./antigravity";
import { detectAntigravityModelSource, withAntigravityEffortLevels, withoutEmbeddedEffortLevels } from "./antigravityModels";

/**
 * What OAR's (>= 0.111) agy lister returns for agy's `session/new` model
 * picker: the current model is the default and carries the thought levels; a
 * model whose menu it could not read says why; one agy lists bare has none.
 * (Turning agy's raw answer into these entries is OAR's to test, not Raft's.)
 */
const MODELS: ModelEntry[] = [
  { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", default: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gemini-3.8-pro", displayName: "Gemini 3.8 Pro", effortUnavailableReason: "Native catalog did not expose this model's effort menu." },
  { id: "claude-sonnet-5" },
];

function recordingLister(result: ListModelsResult): ModelLister & { options: ListModelsOptions[] } {
  const options: ListModelsOptions[] = [];
  const fn = Object.assign(async (_installation: unknown, opts?: ListModelsOptions) => {
    options.push(opts ?? {});
    // The private listing directory exists while the lister runs.
    assert.ok(opts?.cwd && existsSync(opts.cwd));
    return result;
  }, { options });
  return fn as ModelLister & { options: ListModelsOptions[] };
}

const withCommand = { resolveCommand: async () => "/usr/local/bin/agy" };

test("agy's model picker becomes the live list; the current model carries its thought levels and is the default", async () => {
  const listModels = recordingLister({ kind: "ok", models: MODELS });
  const outcome = await detectAntigravityModelSource({ ...withCommand, listModels });
  assert.deepEqual(outcome, {
    kind: "live",
    value: {
      models: [
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", verified: "launchable" },
        // Could not read: the reason, and no effort list (not reported).
        { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", reasoningEffortUnavailableReason: "Native catalog did not expose this model's effort menu.", verified: "launchable" },
        // No menu and no reason: the model takes no effort, an explicit [].
        { id: "claude-sonnet-5", label: "claude-sonnet-5", supportedReasoningEfforts: [], verified: "launchable" },
      ],
      default: "gemini-3.8-flash",
    },
  });
  // The listing reads the sign-in a launch uses: SSH_* removed, as the launch does.
  const [options] = listModels.options;
  assert.deepEqual(options?.env, { NO_COLOR: "1", SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null });
  assert.equal(existsSync(options!.cwd!), false, "the private directory is removed afterwards");
});

test("a model id that already names its thought level offers no separate effort", () => {
  const entries = withoutEmbeddedEffortLevels([
    { id: "gemini-4-carbon-medium", default: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gemini-4-carbon-high" },
    { id: "gemini-3.8-flash", effortLevels: ["low", "high"], defaultEffort: "low" },
  ]);
  assert.deepEqual(entries, [
    { id: "gemini-4-carbon-medium", default: true },
    { id: "gemini-4-carbon-high" },
    { id: "gemini-3.8-flash", effortLevels: ["low", "high"], defaultEffort: "low" },
  ]);
});

test("an id that names its level stays without a menu; only an unexplained missing menu becomes none", () => {
  assert.deepEqual(withAntigravityEffortLevels([
    { id: "gemini-4-carbon-medium", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gemini-3.8-pro", effortUnavailableReason: "Could not read." },
    { id: "claude-sonnet-5" },
  ]), [
    { id: "gemini-4-carbon-medium" },
    { id: "gemini-3.8-pro", effortUnavailableReason: "Could not read." },
    { id: "claude-sonnet-5", effortLevels: [] },
  ]);
});

test("no agy on PATH, no login, or an agy without a model option", async () => {
  assert.deepEqual(
    await detectAntigravityModelSource({ resolveCommand: async () => null, listModels: recordingLister({ kind: "ok", models: [] }) }),
    { kind: "error", retryable: true, code: "runtime_not_found" },
  );
  assert.deepEqual(
    await detectAntigravityModelSource({ ...withCommand, listModels: recordingLister({ kind: "unauthenticated" }) }),
    { kind: "error", retryable: true, code: "runtime_not_authenticated" },
  );
  assert.deepEqual(
    await detectAntigravityModelSource({ ...withCommand, listModels: recordingLister({ kind: "unsupported", reason: "no model config option" }) }),
    { kind: "unsupported" },
  );
});

test("the Antigravity driver detects models and reports them launchable", () => {
  const driver = new AntigravityDriver();
  assert.equal(typeof driver.detectModels, "function");
  assert.equal(driver.model.detectedModelsVerifiedAs, "launchable");
});
