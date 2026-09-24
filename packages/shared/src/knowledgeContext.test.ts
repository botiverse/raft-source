import assert from "node:assert/strict";
import test from "node:test";

import {
  hasManualContextCapability,
  MANUAL_CONTEXT_CAPABILITY,
  MANUAL_INDEX_COMMAND,
  validateKnowledgeContext,
} from "./knowledgeContext.js";

test("Manual context requires independent concise natural-language fields", () => {
  assert.deepEqual(validateKnowledgeContext(undefined, "intent"), {
    ok: false,
    value: null,
    error: "intent is required",
  });
  assert.equal(validateKnowledgeContext("Help the user set up a review workflow", "intent").ok, true);
  assert.equal(validateKnowledgeContext("Need the channel delivery rules right now", "reason").ok, true);
});

test("Manual context rejects raw payload, URL, and credential shapes", () => {
  const cases = [
    "[target=#secret msg=abcdef12] @human: raw quoted message",
    "```text\nraw prompt payload\n```",
    "Need details from https://private.example/path",
    "token=super-secret-value",
    "Bearer opaque-session-value",
    "sk_agent_not-a-real-token",
  ];
  for (const value of cases) {
    const result = validateKnowledgeContext(value, "reason");
    assert.equal(result.ok, false, value);
  }
});

test("Manual index recovery is a fixed cross-shell-safe example", () => {
  assert.equal(
    MANUAL_INDEX_COMMAND,
    "raft manual get index --intent \"Learn available Raft workflows\" --reason \"Browse the topic catalog after a missing topic\"",
  );
  assert.doesNotMatch(MANUAL_INDEX_COMMAND, /['$`;]/);
});

test("Manual context capability is an exact comma-delimited rollout marker", () => {
  assert.equal(hasManualContextCapability(MANUAL_CONTEXT_CAPABILITY), true);
  assert.equal(hasManualContextCapability(`read, ${MANUAL_CONTEXT_CAPABILITY}, tasks`), true);
  assert.equal(hasManualContextCapability("manual-context-v10"), false);
  assert.equal(hasManualContextCapability(undefined), false);
});
