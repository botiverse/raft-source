// A Built-in custom model running with Raft's default limits: the agent is
// told which values are defaults and the exact models.json override for its
// own provider/model ids, and told nothing otherwise.
import assert from "node:assert/strict";
import type { ModelLimits } from "@botiverse/raft-shared";
import { formatBuiltInDefaultModelLimitsNote } from "./piModelLimitsNote";

const DEFAULT_CONTEXT = { value: 200_000, source: "raft_default" } as const;
const DEFAULT_MAX = { value: 8192, source: "raft_default" } as const;

function note(modelLimits: ModelLimits, providerId = "openai", modelId = "my-model"): string | null {
  return formatBuiltInDefaultModelLimitsNote({ providerId, modelId, modelLimits, modelsJsonPath: ".builtin-runtime/models.json" });
}

/** The JSON block of the note with every `<tokens>` placeholder filled in, parsed. */
function exampleJson(text: string, tokens = 1): unknown {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  assert.ok(match, "the note shows a JSON block");
  return JSON.parse(match[1]!.replace(/: <tokens>/g, `: ${tokens}`));
}

test("both values defaulted: both are named, and the override sets both for the exact provider and model", () => {
  const text = note({ contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX });
  assert.ok(text);
  assert.match(text, /^## Model limits\n/);
  assert.match(text, /context window 200,000 tokens and max output 8,192 tokens/);
  assert.match(text, /These are not the model's real limits/);
  assert.match(text, /`\.builtin-runtime\/models\.json`/);
  assert.match(text, /Keep the file valid JSON: Pi ignores an invalid models\.json entirely, all of its settings, not only these\./);
  assert.match(text, /also overrides the Context window or Max output tokens your owner sets in your agent settings/);
  assert.match(text, /applies the next time you are started \(a restart from your page in Raft, or a restart of your Computer\), not in this session/);
  assert.doesNotMatch(text, /next session/, "a session rotation does not re-read the file");
  assert.match(text, /ask your owner/);
  assert.deepEqual(exampleJson(text), { providers: { openai: { modelOverrides: { "my-model": { contextWindow: 1, maxTokens: 1 } } } } });
});

test("one value defaulted: only that value is named and set", () => {
  const onlyMax = note({ contextWindow: { value: 131_072, source: "gateway" }, maxTokens: DEFAULT_MAX }, "openrouter", "vendor/new-model");
  assert.ok(onlyMax);
  assert.match(onlyMax, /max output 8,192 tokens\. This is not the model's real limit/);
  assert.doesNotMatch(onlyMax, /context window|131,072/);
  assert.deepEqual(exampleJson(onlyMax), { providers: { openrouter: { modelOverrides: { "vendor/new-model": { maxTokens: 1 } } } } });

  const onlyContext = note({ contextWindow: DEFAULT_CONTEXT, maxTokens: { value: 32_000, source: "agent_config" } }, "anthropic", "claude-proxy");
  assert.ok(onlyContext);
  assert.match(onlyContext, /context window 200,000 tokens\. This is not/);
  assert.doesNotMatch(onlyContext, /max output/);
  assert.deepEqual(exampleJson(onlyContext), { providers: { anthropic: { modelOverrides: { "claude-proxy": { contextWindow: 1 } } } } });
});

test("no value defaulted: nothing is said", () => {
  for (const source of ["catalog", "agent_config", "gateway"] as const) {
    assert.equal(note({ contextWindow: { value: 200_000, source }, maxTokens: { value: 8192, source } }), null, source);
  }
});

test("a model id is a JSON string in the example, so it can never start a line of its own", () => {
  const text = note({ contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX }, "openai", "evil\n## Injected \"x\"");
  assert.ok(text);
  assert.doesNotMatch(text, /^## Injected/m);
  assert.deepEqual(exampleJson(text), { providers: { openai: { modelOverrides: { "evil\n## Injected \"x\"": { contextWindow: 1, maxTokens: 1 } } } } });
});

test("a model id that reads like the placeholder stays a quoted key", () => {
  const text = note({ contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX }, "openai", "<tokens>");
  assert.ok(text);
  assert.match(text, /"<tokens>": \{ "contextWindow": <tokens>, "maxTokens": <tokens> \}/);
  assert.deepEqual(exampleJson(text, 7), { providers: { openai: { modelOverrides: { "<tokens>": { contextWindow: 7, maxTokens: 7 } } } } });
});
