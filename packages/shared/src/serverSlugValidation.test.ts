import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_SLUG_MIN_LENGTH,
  validateServerSlug,
  validateServerSlugReason,
} from "./serverSlugValidation.js";

test("server slug validation preserves the product create-server contract", () => {
  assert.equal(SERVER_SLUG_MIN_LENGTH, 5);
  assert.deepEqual(validateServerSlugReason(""), { code: "required" });
  assert.deepEqual(validateServerSlugReason("abcd"), { code: "too_short", minLength: 5 });
  assert.deepEqual(validateServerSlugReason("1team"), { code: "pattern" });
  assert.deepEqual(validateServerSlugReason("Team-one"), { code: "pattern" });
  assert.deepEqual(validateServerSlugReason("team_one"), { code: "pattern" });
  assert.equal(validateServerSlugReason("team-1"), null);
});

test("server slug validation keeps API-compatible error copy", () => {
  assert.equal(validateServerSlug(""), "Slug is required");
  assert.equal(validateServerSlug("abcd"), "Slug must be at least 5 characters");
  assert.equal(
    validateServerSlug("Team-one"),
    "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens",
  );
  assert.equal(validateServerSlug("team-one"), null);
});
