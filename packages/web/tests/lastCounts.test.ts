/** Task #164: the saved last counts (store/lastCounts.ts). */
import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";
import type { InboxItem } from "../src/store/inboxStore";
import type { FollowedThread } from "../src/store/threadStore";

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const {
  __resetLastCountsSweepForTests,
  LAST_COUNTS_MAX_AGE_MS,
  LAST_COUNTS_MAX_BYTES,
  LAST_COUNTS_WRITE_THROTTLE_MS,
  clearAllLastCounts,
  flushLastCounts,
  lastCountsKey,
  readLastCounts,
  saveLastCounts,
} = await import("../src/store/lastCounts");

const unread = (count: number) => ({ unreadCounts: { general: count }, mentionFlags: { general: true }, newFlags: {} });

function row(index: number, previewLength = 40): InboxItem {
  return {
    kind: "channel",
    channelId: `channel-${index}`,
    // A long kept field (previews are not stored) makes an entry large.
    channelName: `channel ${index} ${"n".repeat(previewLength)}`,
    channelType: "channel",
    lastMessageId: `message-${index}`,
    latestActivitySeq: String(index + 1),
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-10-24T00:00:00.000Z",
    lastMessagePreview: `preview ${index}`,
    lastMessageSenderType: "user",
    lastMessageSenderId: "sender",
    lastMessageSenderName: "Sender",
    unreadCount: 1,
    hasMention: false,
  };
}

beforeEach(() => {
  clearAllLastCounts();
  storage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

test("round trip: what a clean answer saved is read back for the same user and server only", () => {
  saveLastCounts("user-a", "server-1", { unread: unread(4), activity: { items: [row(1)], groups: [], totalCount: 1, totalUnreadCount: 1, activeUnreadCount: 1, hasMore: false } });
  const saved = readLastCounts("user-a", "server-1");
  assert.deepEqual(saved?.unread, unread(4));
  assert.equal(saved?.activity?.items.length, 1);
  assert.equal(readLastCounts("user-a", "server-2"), null, "another server's counts are never read");
  assert.equal(readLastCounts("user-b", "server-1"), null, "another user's counts are never read");
  assert.equal(readLastCounts(null, "server-1"), null);
});

test("parts merge into one entry per user and server", () => {
  vi.useFakeTimers();
  saveLastCounts("user-a", "server-1", { unread: unread(1) });
  saveLastCounts("user-a", "server-1", { followed: [] });
  flushLastCounts();
  const saved = readLastCounts("user-a", "server-1");
  assert.deepEqual(saved?.unread, unread(1));
  assert.deepEqual(saved?.followed, []);
});

test("writes are throttled: the first at once, later ones merged into one write at the window's end", () => {
  vi.useFakeTimers();
  const key = lastCountsKey("user-a", "server-1");
  const setItem = vi.spyOn(storage, "setItem");
  saveLastCounts("user-a", "server-1", { unread: unread(1) });
  assert.equal(setItem.mock.calls.length, 1);
  saveLastCounts("user-a", "server-1", { unread: unread(2) });
  saveLastCounts("user-a", "server-1", { unread: unread(3) });
  assert.equal(setItem.mock.calls.length, 1, "no write inside the window");
  vi.advanceTimersByTime(LAST_COUNTS_WRITE_THROTTLE_MS);
  assert.equal(setItem.mock.calls.length, 2);
  assert.deepEqual(JSON.parse(storage.getItem(key) ?? "null").unread, unread(3), "the latest values win");
});

test("an entry stays under 64 KB: the Activity rows are cut first, the counts kept", () => {
  const items = Array.from({ length: 30 }, (_, index) => row(index, 4_000));
  saveLastCounts("user-a", "server-1", { unread: unread(9), activity: { items, groups: [], totalCount: 30, totalUnreadCount: 30, activeUnreadCount: 30, hasMore: false } });
  const raw = storage.getItem(lastCountsKey("user-a", "server-1"));
  assert.ok(raw !== null);
  assert.ok(raw.length <= LAST_COUNTS_MAX_BYTES, `entry is ${raw.length} bytes`);
  const saved = readLastCounts("user-a", "server-1");
  assert.deepEqual(saved?.unread, unread(9));
  const kept = saved?.activity?.items.length ?? 0;
  assert.ok(kept > 0 && kept < 30, `kept ${kept} rows`);
  assert.equal(saved?.activity?.hasMore, true, "a cut page says there is more");
});

test("at most 5 servers per user: the least recently saved goes; other users' entries are left alone", () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-24T00:00:00Z"));
  saveLastCounts("user-b", "server-x", { unread: unread(1) });
  for (let index = 1; index <= 6; index += 1) {
    vi.setSystemTime(Date.parse("2026-10-24T00:00:00Z") + index * 60_000);
    saveLastCounts("user-a", `server-${index}`, { unread: unread(index) });
  }
  const userAKeys = [...storage.map.keys()].filter((key) => key.startsWith("raft.lastCounts.v1:user-a:"));
  assert.equal(userAKeys.length, 5);
  assert.equal(readLastCounts("user-a", "server-1"), null, "the oldest is evicted");
  assert.ok(readLastCounts("user-a", "server-6"));
  assert.ok(readLastCounts("user-b", "server-x"), "another user's entry is not evicted");
});

test("an entry older than 7 days, of another schema or corrupt is dropped, not shown", () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-01T00:00:00Z");
  vi.setSystemTime(start);
  saveLastCounts("user-a", "server-1", { unread: unread(1) });
  vi.setSystemTime(start + LAST_COUNTS_MAX_AGE_MS + 1);
  assert.equal(readLastCounts("user-a", "server-1"), null);
  assert.equal(storage.getItem(lastCountsKey("user-a", "server-1")), null, "the expired entry is removed");

  storage.setItem(lastCountsKey("user-a", "server-2"), JSON.stringify({ schema: 99, savedAt: Date.now(), unread: unread(1) }));
  assert.equal(readLastCounts("user-a", "server-2"), null);
  assert.equal(storage.getItem(lastCountsKey("user-a", "server-2")), null);

  storage.setItem(lastCountsKey("user-a", "server-3"), "{not json");
  assert.equal(readLastCounts("user-a", "server-3"), null);
});

test("sign-out deletes every saved entry and drops pending writes", () => {
  vi.useFakeTimers();
  saveLastCounts("user-a", "server-1", { unread: unread(1) });
  saveLastCounts("user-b", "server-2", { unread: unread(2) });
  saveLastCounts("user-a", "server-1", { unread: unread(3) });
  storage.setItem("unrelated", "kept");
  clearAllLastCounts();
  vi.advanceTimersByTime(LAST_COUNTS_WRITE_THROTTLE_MS);
  assert.deepEqual([...storage.map.keys()], ["unrelated"]);
});

// Tenny (#164 review): no message text ever reaches localStorage.
const SECRETS = {
  channelPreview: "ZEBRA-BODY-7741 the launch codes",
  parentPreview: "PARENT-SECRET-1 quarterly numbers",
  replyPreview: "REPLY-SECRET-2 salary sheet",
  taskTitle: "TASK-SECRET-3 fire the vendor",
  mentionPreview: "MENTION-SECRET-4 call me",
  mentionReason: "MENTION-SECRET-8 reason",
  followedPreview: "FOLLOW-SECRET-5 private plan",
  followedTaskTitle: "FOLLOW-SECRET-6 task title",
};

function threadRow(): InboxItem {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-1",
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: SECRETS.parentPreview,
    parentMessageSenderType: "user",
    parentMessageSenderId: "sender",
    latestActivityPreview: SECRETS.replyPreview,
    latestActivitySenderType: "agent",
    latestActivitySenderId: "agent-1",
    latestActivitySenderName: "Atlas",
    latestActivityMessageId: "reply-1",
    latestActivitySeq: "9",
    firstUnreadMessageId: "reply-1",
    firstMentionMessageId: null,
    replyCount: 3,
    lastActivityAt: "2026-10-24T00:00:00.000Z",
    lastReplyAt: "2026-10-24T00:00:00.000Z",
    unreadCount: 2,
    hasMention: true,
    taskNumber: 7,
    taskStatus: "in_progress",
    taskClaimedByName: "Atlas",
    taskTitle: SECRETS.taskTitle,
    conversationKind: "task",
    taskId: "task-7",
  };
}

const mentionRow: InboxItem = {
  kind: "mention_action",
  id: "mention-1",
  channelId: "channel-1",
  channelName: "general",
  channelType: "channel",
  messageId: "message-9",
  messagePreview: SECRETS.mentionPreview,
  createdAt: "2026-10-24T00:00:00.000Z",
  pendingMentionActions: [{ resolutionId: "r", messageId: "message-9", targetType: "user", targetHandle: "bob", reason: SECRETS.mentionReason, availableActions: ["notify"] }],
  unreadCount: 0,
  hasMention: false,
};

const followedThread = {
  threadChannelId: "thread-1",
  parentMessageId: "parent-1",
  parentChannelId: "channel-1",
  parentChannelName: "general",
  parentChannelType: "channel",
  parentMessagePreview: SECRETS.followedPreview,
  parentMessageSenderType: "user",
  parentMessageSenderId: "sender",
  latestActivitySeq: "9",
  replyCount: 3,
  lastReplyAt: "2026-10-24T00:00:00.000Z",
  unreadCount: 2,
  taskNumber: 7,
  taskStatus: "in_progress",
  taskClaimedByName: "Atlas",
  taskTitle: SECRETS.followedTaskTitle,
} as FollowedThread;

test("no message text is written: previews, parent messages, task titles and mention rows are left out", () => {
  const channel = { ...row(1), lastMessagePreview: SECRETS.channelPreview };
  saveLastCounts("user-a", "server-1", {
    activity: { items: [channel, threadRow(), mentionRow], groups: [], totalCount: 3, totalUnreadCount: 3, activeUnreadCount: 3, hasMore: false },
    followed: [followedThread],
  });
  const raw = storage.getItem(lastCountsKey("user-a", "server-1")) ?? "";
  assert.ok(raw.length > 0);
  for (const [field, secret] of Object.entries(SECRETS)) {
    assert.equal(raw.includes(secret.split(" ")[0]!), false, `${field} must not be stored`);
  }
  assert.equal(raw.includes("Preview\":"), false, "no preview field is stored at all");

  // What is kept renders the rows: ids, names, counts, times, kinds.
  const saved = readLastCounts("user-a", "server-1");
  const [savedChannel, savedThread, ...rest] = saved?.activity?.items ?? [];
  assert.equal(rest.length, 0, "the mention row is not kept");
  assert.equal(savedChannel?.kind === "channel" && savedChannel.channelId, "channel-1");
  assert.equal(savedChannel?.kind === "channel" && savedChannel.lastMessagePreview, "");
  assert.equal(savedChannel?.kind === "channel" && savedChannel.lastMessageSenderName, "Sender");
  assert.equal(savedThread?.kind === "thread" && savedThread.parentMessagePreview, "");
  assert.equal(savedThread?.kind === "thread" && savedThread.latestActivityPreview, "");
  assert.equal(savedThread?.kind === "thread" && savedThread.taskTitle, null);
  assert.equal(savedThread?.kind === "thread" && savedThread.unreadCount, 2);
  assert.equal(savedThread?.kind === "thread" && savedThread.parentChannelName, "general");
  assert.equal(saved?.followed?.[0]?.parentMessagePreview, "");
  assert.equal(saved?.followed?.[0]?.taskTitle, null);
  assert.equal(saved?.followed?.[0]?.unreadCount, 2);
});

test("entries of the previous schema (with previews) are deleted on first use, any user's", () => {
  storage.setItem(lastCountsKey("user-a", "server-1"), JSON.stringify({ schema: 1, savedAt: Date.now(), activity: { items: [{ ...row(1), lastMessagePreview: SECRETS.channelPreview }], groups: [], totalCount: 1, totalUnreadCount: 1 } }));
  storage.setItem(lastCountsKey("user-b", "server-2"), JSON.stringify({ schema: 1, savedAt: Date.now(), unread: unread(1) }));
  storage.setItem("raft.lastCounts.v1:corrupt", "{oops");
  storage.setItem("unrelated", "kept");
  __resetLastCountsSweepForTests();
  assert.equal(readLastCounts("user-c", "server-9"), null);
  assert.deepEqual([...storage.map.keys()], ["unrelated"]);
});
