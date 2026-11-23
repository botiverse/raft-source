import assert from "node:assert/strict";
import { PI_BUILTIN_PROVIDER_MODELS_GENERATED } from "./piBuiltinModels.generated";
import { builtInModelSuccessor } from "./piBuiltinModelSuccessors";

const presetIds = new Set(Object.values(PI_BUILTIN_PROVIDER_MODELS_GENERATED).flatMap((models) => models.map((model) => model.id)));

test("a retired Built-in preset id starts on its recorded successor, which is a current preset", () => {
  // Offered by Raft until the pi SDK 0.86.0 bump (#8026); agents saved with it failed every start.
  assert.equal(builtInModelSuccessor("deepseek/deepseek-v4-flash"), "deepseek/deepseek-flash");
  assert.ok(presetIds.has("deepseek/deepseek-flash"));
  assert.ok(!presetIds.has("deepseek/deepseek-v4-flash"), "still a preset: no successor needed");
});

test("only `replaced-by` removals have a successor", () => {
  assert.equal(builtInModelSuccessor("deepseek/deepseek-v4-pro"), null, "a current preset");
  assert.equal(builtInModelSuccessor("openrouter/deepseek/deepseek-r1"), null, "retired with no drop-in successor");
  assert.equal(builtInModelSuccessor("not/a-model"), null);
});
