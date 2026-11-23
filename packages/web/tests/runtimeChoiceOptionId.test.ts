import assert from "node:assert/strict";
import { test } from "vitest";
import { isTypedCustomValue, shownOptionId } from "../src/components/agent/runtimeChoiceOptionId";

test("a runtime choice shows a real model id under its name, never an internal value", () => {
  assert.equal(shownOptionId("qwen-token-plan/qwen3.8-max", "Qwen3.8 Max"), "qwen-token-plan/qwen3.8-max");
  assert.equal(shownOptionId("__runtime_form_v2_default__", "Default"), null, "the Default row's placeholder");
  assert.equal(shownOptionId("claude", "claude"), null, "an id that only repeats the label");
});

test("a typed model id is custom only where the field takes one and it is not listed", () => {
  const options = [{ value: "qwen-token-plan-cn/qwen3.8-max" }];
  assert.equal(isTypedCustomValue(true, "qwen4-max-preview", options), true);
  assert.equal(isTypedCustomValue(true, "qwen-token-plan-cn/qwen3.8-max", options), false, "a listed model");
  assert.equal(isTypedCustomValue(true, "", options), false);
  assert.equal(isTypedCustomValue(false, "qwen4-max-preview", options), false, "a list-only field: a saved value the list lost");
});
