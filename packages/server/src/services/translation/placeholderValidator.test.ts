import assert from "node:assert/strict";
import { test } from "vitest";
import { createRegexPlaceholderPolicy } from "./placeholderPolicy.js";
import { validateTranslationPlaceholders } from "./placeholderValidator.js";

const policy = createRegexPlaceholderPolicy({
  name: "test-placeholder-policy",
  pattern: /\{[A-Z0-9_:-]+\}/g,
});

test("placeholder validator accepts preserved placeholders in different order", () => {
  const result = validateTranslationPlaceholders(
    "Hello {USER}, see {DOC}",
    "查看 {DOC}，你好 {USER}",
    policy,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingPlaceholders, []);
  assert.deepEqual(result.unexpectedPlaceholders, []);
});

test("placeholder validator reports missing and unexpected placeholders", () => {
  const result = validateTranslationPlaceholders(
    "Hello {USER}, see {DOC}",
    "你好 {USER}，另见 {OTHER}",
    policy,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingPlaceholders, ["{DOC}"]);
  assert.deepEqual(result.unexpectedPlaceholders, ["{OTHER}"]);
});

test("placeholder validator preserves duplicate counts", () => {
  const result = validateTranslationPlaceholders(
    "{ITEM} then {ITEM}",
    "{ITEM}",
    policy,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingPlaceholders, ["{ITEM}"]);
});
