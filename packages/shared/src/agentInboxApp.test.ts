import assert from "node:assert/strict";

import {
  agentInboxAppItemDismissTarget,
  formatAgentInboxAppItemLines,
  formatAgentInboxAppItems,
  type AgentInboxAppItem,
} from "./agentInboxApp";

// The daemon section of `raft inbox check` and of the daemon's inbox notice:
// a Computer-local app item the agent may dismiss prints its command.

const cleanerItem: AgentInboxAppItem = {
  source: "app",
  itemId: "714fbfc6-2d3e-5a1b-a9c4-0f6e8d7c5b3a",
  appId: "system.cleaner",
  notificationClass: "disk_space_hint",
  sourceRef: { kind: "backup_ignore_hint", id: "agent-1" },
  primaryAction: { kind: "run_command", commandId: "cleaner.disk_guidance" },
  actionCli: "raft manual get agent",
  retention: "transient",
  title: "Review .raftbackupignore",
};

const reminderItem: AgentInboxAppItem = {
  source: "app",
  itemId: "reminder:76d9397d-1111-4222-8333-444455556666:1",
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: "76d9397d-1111-4222-8333-444455556666", revision: "1" },
  primaryAction: { kind: "run_command", commandId: "reminder.ack" },
  actionCli: "raft reminder ack --id 76d9397d --revision 1",
  retention: "until_explicit_ack",
};

test("a dismissable item's row is followed by its dismiss command: the app and the item id as the row prints it", () => {
  assert.equal(agentInboxAppItemDismissTarget(cleanerItem), "app:system.cleaner/714fbfc6");
  assert.deepEqual(formatAgentInboxAppItemLines(cleanerItem), [
    "app=system.cleaner · class=disk_space_hint · item=714fbfc6 · retention=transient · sourceRef=backup_ignore_hint:agent-1 · action=raft manual get agent · title=Review .raftbackupignore",
    '  dismiss: raft inbox dismiss --target "app:system.cleaner/714fbfc6"',
  ]);
});

test("an item that asks for an explicit ack is never dismissed: its row stands alone", () => {
  assert.equal(agentInboxAppItemDismissTarget(reminderItem), null);
  assert.deepEqual(formatAgentInboxAppItemLines(reminderItem), [
    "app=system.reminder · class=due · item=reminder · retention=until_explicit_ack · sourceRef=reminder:76d9397d-1111-4222-8333-444455556666:1 · action=raft reminder ack --id 76d9397d --revision 1",
  ]);
});

test("a sealed item, or one whose ids cannot stand in a target, prints no dismiss command", () => {
  assert.equal(agentInboxAppItemDismissTarget({ ...cleanerItem, seal: { owner: "@Stone", until: "release", sealedAtMs: 1 } }), null);
  for (const itemId of ['a"b', "a b-0001", "ab\ncd", "-abc", ""]) {
    assert.equal(agentInboxAppItemDismissTarget({ ...cleanerItem, itemId }), null, JSON.stringify(itemId));
  }
  assert.equal(agentInboxAppItemDismissTarget({ ...cleanerItem, appId: "bad app" }), null);
});

test("the section: a count, then each item's lines with a blank line between items", () => {
  assert.equal(formatAgentInboxAppItems([]), "");
  assert.equal(formatAgentInboxAppItems([cleanerItem, reminderItem]), [
    "App items: 2",
    "",
    ...formatAgentInboxAppItemLines(cleanerItem),
    "",
    ...formatAgentInboxAppItemLines(reminderItem),
  ].join("\n"));
});
