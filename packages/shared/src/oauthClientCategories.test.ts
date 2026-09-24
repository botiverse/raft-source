import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES,
  OAUTH_CLIENT_CATEGORIES,
  canonicalizeOAuthClientCategory,
} from "./oauthClientCategories.js";

test("Connected App categories expose the complete intent-based taxonomy in display order", () => {
  assert.deepEqual(OAUTH_CLIENT_CATEGORIES, [
    "AI & Automation",
    "Communication",
    "Productivity & Collaboration",
    "Developer Tools",
    "Data & Analytics",
    "Business Ops",
    "Infrastructure",
    "Content & Creative",
    "Other",
  ]);
});

test("Connected App categories canonicalize legacy values during mixed-version rollout", () => {
  assert.deepEqual(LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES, {
    Productivity: "Productivity & Collaboration",
    "Dev Tools": "Developer Tools",
    Storage: "Infrastructure",
    Scheduling: "Productivity & Collaboration",
    "Business & Operations": "Business Ops",
    "Infrastructure & Operations": "Infrastructure",
  });
  assert.equal(canonicalizeOAuthClientCategory("AI & Automation"), "AI & Automation");
  assert.equal(canonicalizeOAuthClientCategory("Storage"), "Infrastructure");
  assert.equal(canonicalizeOAuthClientCategory("Business & Operations"), "Business Ops");
  assert.equal(
    canonicalizeOAuthClientCategory("Infrastructure & Operations"),
    "Infrastructure",
  );
  assert.equal(canonicalizeOAuthClientCategory("Scheduling"), "Productivity & Collaboration");
  assert.equal(canonicalizeOAuthClientCategory("Automation"), null);
  assert.equal(canonicalizeOAuthClientCategory(undefined), null);
});
