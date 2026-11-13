import assert from "node:assert/strict";

import {
  hasManualContextCapability,
  hasPlanUpgradeCardCapability,
  hasReminderServerAckCapability,
  INBOX_ITEMS_CAPABILITY,
  MANUAL_CONTEXT_CAPABILITY,
  MANUAL_INDEX_COMMAND,
  PLAN_UPGRADE_CARD_CAPABILITY,
  REMINDER_SERVER_ACK_CAPABILITY,
  validateKnowledgeContext,
} from "./knowledgeContext";

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

test("the plan:upgrade card capability is a versioned comma-delimited token, at its version or later", () => {
  assert.equal(PLAN_UPGRADE_CARD_CAPABILITY, "action-card:plan:upgrade@1");
  assert.equal(hasPlanUpgradeCardCapability(PLAN_UPGRADE_CARD_CAPABILITY), true);
  assert.equal(hasPlanUpgradeCardCapability(`${MANUAL_CONTEXT_CAPABILITY}, ${PLAN_UPGRADE_CARD_CAPABILITY} ,guide-app:artifacts@3`), true);
  assert.equal(hasPlanUpgradeCardCapability("action-card:plan:upgrade@2"), true, "a later version");
  for (const header of [undefined, "", MANUAL_CONTEXT_CAPABILITY, "action-card:plan:upgrade", "action-card:plan:upgrade@0", "action-card:plan:upgrade@01", "action-card:plan:upgrade@1x", "guide-app:plan:upgrade@1"]) {
    assert.equal(hasPlanUpgradeCardCapability(header), false, String(header));
  }
});

test("RFC 081 D17: the reminder server-ack capability is a versioned comma-delimited token, at its version or later", () => {
  assert.equal(REMINDER_SERVER_ACK_CAPABILITY, "reminder-server-ack@1");
  assert.equal(hasReminderServerAckCapability(REMINDER_SERVER_ACK_CAPABILITY), true);
  // As the daemon's proxy forwards it: appended to the CLI's own list.
  assert.equal(hasReminderServerAckCapability(`${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY}, ${REMINDER_SERVER_ACK_CAPABILITY} `), true);
  assert.equal(hasReminderServerAckCapability("reminder-server-ack@2"), true, "a later version");
  for (const header of [undefined, null, 1, "", `${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY}`, "reminder-server-ack", "reminder-server-ack@0", "reminder-server-ack@01", "reminder-server-ack@1x", "x-reminder-server-ack@1", "reminder-server-ack@1;reminder"]) {
    assert.equal(hasReminderServerAckCapability(header), false, String(header));
  }
});
