import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { projectAntigravityModels, type ListModelsOptions, type ListModelsResult, type ModelLister } from "@botiverse/oar";

import { AntigravityDriver } from "./antigravity.deprecated";
import { detectAntigravityModelSource, withoutEmbeddedEffortLevels } from "./antigravityModels";

/** A `session/new` answer in the shape agy's ACP server gives (trimmed): the model picker and the current model's thought level. */
const SESSION_NEW = {
  sessionId: "s-1",
  configOptions: [
    {
      id: "model",
      currentValue: "gemini-3.8-flash",
      options: [
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
        { value: "claude-sonnet-5", name: "claude-sonnet-5" },
      ],
    },
    {
      id: "thinking_level",
      category: "thought_level",
      currentValue: "medium",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
  ],
};

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
  const listModels = recordingLister({ kind: "ok", models: projectAntigravityModels(SESSION_NEW)! });
  const outcome = await detectAntigravityModelSource({ ...withCommand, listModels });
  assert.deepEqual(outcome, {
    kind: "live",
    value: {
      models: [
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", verified: "launchable" },
        { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", verified: "launchable" },
        { id: "claude-sonnet-5", label: "claude-sonnet-5", verified: "launchable" },
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
