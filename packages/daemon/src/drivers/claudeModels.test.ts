import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { projectClaudeModels, type ListModelsResult, type ModelLister } from "@botiverse/oar";
import { getStaticRuntimeModelSourceSet } from "@botiverse/raft-shared";

import { ClaudeDriver } from "./claude";
import { detectClaudeModelSource } from "./claudeModels";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** A `list_models` control response in the shape Claude Code 2.1 answers (trimmed). */
const CONTROL_RESPONSE = {
  models: [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportedEffortLevels: EFFORTS, supportsFastMode: true },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: EFFORTS, supportsFastMode: true },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", supportedEffortLevels: EFFORTS },
    { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
    { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", supportedEffortLevels: EFFORTS, supportsFastMode: true },
    { value: "claude-opus-9", resolvedModel: "claude-opus-9", displayName: "Opus 9", disabled: true, description: "Upgrade Claude Code" },
  ],
};

function lister(result: ListModelsResult | (() => Promise<ListModelsResult>)): ModelLister & { calls: number } {
  const fn = Object.assign(async () => {
    fn.calls += 1;
    return typeof result === "function" ? result() : result;
  }, { calls: 0 });
  return fn;
}

const withCommand = { resolveCommand: async () => "/usr/local/bin/claude" };
const bundled = { kind: "live", value: getStaticRuntimeModelSourceSet("claude") };

test("Claude's own model list becomes the live catalog: aliases say what they run, today's concrete IDs stay pinnable", async () => {
  const outcome = await detectClaudeModelSource({
    ...withCommand,
    listModels: lister({ kind: "ok", models: projectClaudeModels(CONTROL_RESPONSE) }),
  });
  assert.deepEqual(outcome, {
    kind: "live",
    value: {
      models: [
        { id: "opus", label: "Claude Opus (Opus 5.5)", supportedReasoningEfforts: EFFORTS, serviceTiers: ["fast"], verified: "launchable" },
        { id: "haiku", label: "Claude Haiku (Haiku 5.5)", supportedReasoningEfforts: EFFORTS, verified: "launchable" },
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", supportedReasoningEfforts: EFFORTS, serviceTiers: ["fast"], verified: "launchable" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", supportedReasoningEfforts: EFFORTS, verified: "launchable" },
        // Haiku 4.5 takes no effort, and Claude says so.
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", verified: "launchable" },
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportedReasoningEfforts: EFFORTS, serviceTiers: ["fast"], verified: "launchable" },
        // `default` is the form's inherit option, and a disabled model would fail at launch.
      ],
      // The disabled model is reported apart, with Claude's reason, never in `models`.
      unavailable: [{ id: "claude-opus-9", label: "Claude Opus 9", reason: "Upgrade Claude Code" }],
    },
  });
});

test("an alias whose resolved ID Claude already lists is not pinned twice", async () => {
  const outcome = await detectClaudeModelSource({
    ...withCommand,
    listModels: lister({
      kind: "ok",
      models: projectClaudeModels({
        models: [
          { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
          { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
        ],
      }),
    }),
  });
  assert.equal(outcome.kind, "live");
  assert.deepEqual(outcome.kind === "live" && outcome.value.models.map((model) => model.id), ["opus", "claude-opus-4-8"]);
});

test("an effort the bundled list offered for a model stays offered, so an agent saved with it can still be saved", async () => {
  // Claude 2.1.292 reports Opus 4.6 without `xhigh`; the bundled list offered it (Claude runs it as `high`).
  const outcome = await detectClaudeModelSource({
    ...withCommand,
    listModels: lister({
      kind: "ok",
      models: projectClaudeModels({
        models: [
          { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", supportedEffortLevels: ["low", "medium", "high", "max"] },
          { value: "claude-opus-4-1", resolvedModel: "claude-opus-4-1", displayName: "Opus 4.1", supportedEffortLevels: ["low", "high"] },
        ],
      }),
    }),
  });
  assert.equal(outcome.kind, "live");
  const efforts = outcome.kind === "live" ? outcome.value.models.map((model) => [model.id, model.supportedReasoningEfforts]) : [];
  assert.deepEqual(efforts, [
    ["claude-opus-4-6", EFFORTS],
    // Not in the bundled list: Claude's own levels only.
    ["claude-opus-4-1", ["low", "high"]],
  ]);
});

test("each listing runs in its own fresh private directory, not the daemon's cwd or a shared fixed path, and removes it", async () => {
  const seen: Array<{ cwd: string; entries: string[]; mode: number }> = [];
  const listModels: ModelLister = async (_installation, options) => {
    const cwd = options!.cwd!;
    seen.push({ cwd, entries: readdirSync(cwd), mode: statSync(cwd).mode & 0o777 });
    return { kind: "ok", models: [] };
  };
  await detectClaudeModelSource({ ...withCommand, listModels });
  await detectClaudeModelSource({ ...withCommand, listModels });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.cwd, seen[1]!.cwd, "a new directory per listing");
  for (const { cwd, entries, mode } of seen) {
    assert.ok(path.isAbsolute(cwd) && path.resolve(cwd) !== process.cwd());
    assert.deepEqual(entries, []);
    assert.equal(mode, 0o700, "only the daemon's user can write it");
    assert.equal(existsSync(cwd), false, "removed after the listing");
  }
});

test("without a live list Claude answers with its bundled catalog, as before detection existed", async () => {
  assert.ok(bundled.value && bundled.value.models.length > 0);
  const cases: Array<[string, ModelLister]> = [
    ["not logged in", lister({ kind: "unauthenticated" })],
    ["listing throws (older claude without list_models)", lister(async () => { throw new Error("claude exited before answering list_models"); })],
    ["empty list", lister({ kind: "ok", models: [] })],
    ["deadline", lister(() => new Promise<ListModelsResult>(() => {}))],
  ];
  for (const [name, listModels] of cases) {
    assert.deepEqual(await detectClaudeModelSource({ ...withCommand, listModels, deadlineMs: 20 }), bundled, name);
  }
});

test("no claude on this computer answers with the bundled catalog without listing", async () => {
  const listModels = lister({ kind: "ok", models: projectClaudeModels(CONTROL_RESPONSE) });
  assert.deepEqual(await detectClaudeModelSource({ resolveCommand: async () => null, listModels }), bundled);
  assert.equal(listModels.calls, 0);
});

test("the Claude driver detects its models, so the daemon no longer answers Claude from the static catalog", () => {
  assert.equal(typeof new ClaudeDriver().detectModels, "function");
});
