import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeAgentCapabilities } from "./agentCredentialService.js";

test("normalizeAgentCapabilities accepts, dedupes, and sorts valid scopes", () => {
  assert.deepEqual(normalizeAgentCapabilities(["read", "send", "read"]), ["read", "send"]);
  assert.deepEqual(normalizeAgentCapabilities([]), []);
  // result is sorted regardless of input order
  assert.deepEqual(normalizeAgentCapabilities(["tasks", "send"]), ["send", "tasks"]);
});

test("normalizeAgentCapabilities rejects unsupported scope (fail-closed)", () => {
  assert.throws(
    () => normalizeAgentCapabilities(["read", "bogus"]),
    /unsupported agent capability: bogus/,
  );
  // non-member empty string is rejected too (guard requires membership, not just string)
  assert.throws(() => normalizeAgentCapabilities([""]), /unsupported agent capability:/);
});
