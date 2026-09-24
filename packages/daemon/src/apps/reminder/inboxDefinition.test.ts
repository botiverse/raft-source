import assert from "node:assert/strict";
import { test } from "vitest";

import { createAgentAppInboxStore } from "../../agentAppInbox.js";
import { projectReminderInboxTitle, REMINDER_AGENT_INBOX_REGISTRY } from "./inboxDefinition.js";

const REMINDER_ID = "12345678-1234-4123-8123-123456789abc";

test("Reminder due item has exact OS-minted identity/action and no message identity", () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const result = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "7" },
    title: "Follow up",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.item.itemId, `reminder:${REMINDER_ID}:7`);
  assert.equal(result.item.retention, "until_explicit_ack");
  assert.equal(result.item.actionCli, "raft reminder ack --id 12345678 --revision 7");
  assert.deepEqual(result.item.primaryAction, {
    kind: "run_command",
    commandId: "reminder.ack",
  });
  for (const field of ["msgId", "seq", "sender", "latestMsgId", "latestSenderName"]) {
    assert.equal(field in result.item, false, field);
  }
});

test("Reminder source identity rejects extra fields and app-supplied action", () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const extra = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: {
      kind: "reminder",
      id: REMINDER_ID,
      revision: "7",
      command: "rm -rf /",
    },
  });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.equal(extra.code, "invalid_source_ref");

  const action = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "7" },
    requestedPrimaryAction: { kind: "run_command", commandId: "shell" },
  });
  assert.equal(action.ok, false);
  if (!action.ok) assert.equal(action.code, "invalid_primary_action");
});

test("Reminder source identity rejects malformed UUID and revision shapes", () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  for (const sourceRef of [
    { kind: "reminder", id: "12345678-1234-4123-8123-123456789ab-", revision: "7" },
    { kind: "reminder", id: REMINDER_ID, revision: "0" },
    { kind: "reminder", id: REMINDER_ID, revision: "01" },
  ]) {
    const result = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_source_ref");
  }
});

test("Reminder projects every legal title into one bounded Inbox preview line", () => {
  const long = "x".repeat(500);
  assert.equal(projectReminderInboxTitle(long), "x".repeat(120));
  assert.equal(projectReminderInboxTitle("first\nsecond\r\nthird"), "first second third");

  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  for (const [revision, title] of [["8", long], ["9", "first\nsecond"]] as const) {
    const result = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: REMINDER_ID, revision },
      title: projectReminderInboxTitle(title),
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.ok((result.item.title?.length ?? 0) <= 120);
    assert.doesNotMatch(result.item.title ?? "", /[\r\n\u0000-\u001f\u007f]/);
  }
  assert.equal(store.list().length, 2, "both legal Reminder titles mint exactly one item");
});
