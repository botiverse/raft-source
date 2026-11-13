import assert from "node:assert/strict";

import { createAgentAppInboxStore } from "./agentAppInbox";
import { appInboxItemNoticed, appInboxNoticeText, inboxItemsLaunchAtMs } from "./agentAppInboxNotice";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { exampleStdinDriver } from "./axExampleFixtures";

// RFC 081 D9: a reminder fired before inbox items launched is not a Server
// item, so the notice never gives it a `reminder:` row (its read would be
// NOT_FOUND): it is in the daemon section, as `raft inbox check` shows it.
// The daemon not knowing the launch time reads as every reminder being so.

const LAUNCH_MS = Date.parse("2026-11-01T00:00:00.000Z");
const REMINDER_ID = "1598ee1a-81c7-4aba-a76b-c75aab407097";

function noticeForReminderFiredAt(firedAtMs: number, launchAtMs: number | null): string {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY, nowMs: () => firedAtMs });
  const minted = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "1" },
    title: "查看「今日待办」页面有没有新评论",
  });
  assert.equal(minted.ok, true);
  const items = store.list();
  return appInboxNoticeText({
    items,
    undelivered: items,
    pendingMessages: 0,
    driver: exampleStdinDriver,
    options: { inboxItems: true },
    inboxItemsLaunchAtMs: launchAtMs,
    nowMs: firedAtMs + 1_000,
  });
}

const DAEMON_SECTION_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "",
  "App items: 1",
  "",
  `app=system.reminder · class=due · item=reminder · retention=until_explicit_ack · sourceRef=reminder:${REMINDER_ID}:1 · action=raft reminder ack --id 1598ee1a --revision 1 · title=查看「今日待办」页面有没有新评论`,
  "]",
].join("\n");

test("RFC 081 D9: a reminder fired since inbox items launched is its reminder: row", () => {
  assert.equal(noticeForReminderFiredAt(LAUNCH_MS + 60_000, LAUNCH_MS), [
    "[Raft inbox notice:",
    "Inbox update: 1 message pending your read across all conversations; 1 changed target",
    "reminder:1598ee1a · 1 fired, not acked · latest just now",
    "  \"查看「今日待办」页面有没有新评论\" (preview)",
    "  read: raft inbox read --target \"reminder:1598ee1a\"",
    `  ack: raft reminder ack --id ${REMINDER_ID} --revision 1`,
    "]",
  ].join("\n"));
});

test("RFC 081 D9: a reminder fired before inbox items launched is in the daemon section, as inbox check shows it", () => {
  assert.equal(noticeForReminderFiredAt(LAUNCH_MS - 60_000, LAUNCH_MS), DAEMON_SECTION_NOTICE);
});

test("RFC 081 D9: with no launch time known every reminder is in the daemon section, never a row", () => {
  assert.equal(noticeForReminderFiredAt(LAUNCH_MS + 60_000, null), DAEMON_SECTION_NOTICE);
});

test("RFC 081 D9: the launch time is the Server's inboxItemsLaunchAt beside inboxItems: true, else unknown", () => {
  assert.equal(inboxItemsLaunchAtMs({ inboxItems: true, inboxItemsLaunchAt: "2026-11-01T00:00:00.000Z" }), LAUNCH_MS);
  assert.equal(inboxItemsLaunchAtMs({ inboxItems: true }), null);
  assert.equal(inboxItemsLaunchAtMs({ inboxItems: true, inboxItemsLaunchAt: "not a time" }), null);
  assert.equal(inboxItemsLaunchAtMs({ inboxItems: true, inboxItemsLaunchAt: 1_730_419_200_000 as unknown as string }), null);
  assert.equal(inboxItemsLaunchAtMs({ inboxItemsLaunchAt: "2026-11-01T00:00:00.000Z" }), null);
  assert.equal(inboxItemsLaunchAtMs({ inboxItems: false, inboxItemsLaunchAt: "2026-11-01T00:00:00.000Z" }), null);
  assert.equal(inboxItemsLaunchAtMs(null), null);
  assert.equal(inboxItemsLaunchAtMs(undefined), null);
});

test("an item is noticed only as the one the agent was told of: the same id minted at another time is not", () => {
  let now = 1_000;
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY, nowMs: () => now });
  const mint = () => {
    const minted = store.mint({ appId: "system.reminder", notificationClass: "due", sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "1" } });
    if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
    return minted.item;
  };
  const noticed = new Map<string, number | undefined>();
  const first = mint();
  assert.equal(appInboxItemNoticed(noticed, first), false);
  noticed.set(first.itemId, first.createdAtMs);
  assert.equal(appInboxItemNoticed(noticed, first), true);

  // Minted again while the store holds it: the same item, updated.
  now += 60_000;
  assert.equal(appInboxItemNoticed(noticed, mint()), true);

  // Removed and minted again: the id is the same, the item is another.
  assert.equal(store.retire(first.itemId), true);
  now += 60_000;
  const again = mint();
  assert.equal(again.itemId, first.itemId);
  assert.equal(appInboxItemNoticed(noticed, again), false);
});
