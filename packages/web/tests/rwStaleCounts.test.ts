/**
 * Task #164: while the unread / Activity reads are stale or unavailable the
 * stores keep (or, at boot and on a server switch, seed from the saved copy)
 * their last values, say so (store/rwFreshness) and read again with backoff
 * (store/rwStaleCounts).
 */
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
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const { default: api } = await import("../src/api/client");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useThreadStore } = await import("../src/store/threadStore");
const { useInboxStore } = await import("../src/store/inboxStore");
const { clearAllLastCounts, flushLastCounts, readLastCounts, saveLastCounts } = await import("../src/store/lastCounts");
const { markRwFresh, markRwStale, markRwUnavailable, resetRwFreshness, useRwFreshnessStore } = await import("../src/store/rwFreshness");
const { __resetRwStaleCountsForTests, rwRecoveryDelayMs, startRwRecovery } = await import("../src/store/rwStaleCounts");

const originalGet = api.get;
const originalLoadUnreadCounts = useMessageStore.getState().loadUnreadCounts;

type GetHandler = (url: string, config?: { params?: Record<string, unknown> }) => Promise<{ data: unknown; headers?: Record<string, string> }>;

/** Every GET the switch fires (members, settings, sidebar order ...) waits forever unless `handler` answers it. */
function stubGet(handler: GetHandler | null = null) {
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    const answer = handler ? await handler(url, config) : undefined;
    if (answer) return { status: 200, statusText: "OK", headers: {}, config: {}, ...answer };
    return new Promise(() => {});
  }) as typeof api.get;
}

function overloaded(): Error {
  return Object.assign(new Error("HTTP 503"), {
    response: { status: 503, data: { code: "rw_overloaded", retryable: true }, headers: { "retry-after": "0" } },
  });
}

const surface = (name: "summary" | "unread" | "inbox" | "followed") => useRwFreshnessStore.getState().surfaces[name];

function server(id: string) {
  return { id, slug: id, name: id, role: "owner" } as never;
}

function inboxRow(label: string): InboxItem {
  return {
    kind: "channel",
    channelId: `channel-${label}`,
    channelName: label,
    channelType: "channel",
    lastMessageId: `message-${label}`,
    latestActivitySeq: "5",
    doneFrontierSeq: "5",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-10-24T00:00:00.000Z",
    lastMessagePreview: `${label} preview`,
    lastMessageSenderType: "user",
    lastMessageSenderId: "sender",
    lastMessageSenderName: "Sender",
    unreadCount: 2,
    hasMention: false,
  };
}

function followed(label: string): FollowedThread {
  return {
    threadChannelId: `thread-${label}`,
    parentMessageId: `parent-${label}`,
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "sender",
    latestActivitySeq: "3",
    replyCount: 1,
    lastReplyAt: "2026-10-24T00:00:00.000Z",
    unreadCount: 1,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
  } as FollowedThread;
}

const activity = (items: InboxItem[]) => ({ items, groups: [], totalCount: items.length, totalUnreadCount: 2 * items.length, activeUnreadCount: 2 * items.length, hasMore: false });

beforeEach(() => {
  stubGet();
  useMessageStore.getState().setCurrentUserId("user-a");
});

afterEach(() => {
  api.get = originalGet;
  useMessageStore.setState({ loadUnreadCounts: originalLoadUnreadCounts });
  __resetRwStaleCountsForTests();
  useServerStore.getState().clearCurrent();
  useMessageStore.getState().setCurrentUserId(null);
  useServerStore.setState({ serverUnreadCounts: {} });
  clearAllLastCounts();
  storage.clear();
  resetRwFreshness();
  vi.useRealTimers();
});

test("a server switch shows that server's saved counts before any answer, never another server's", () => {
  saveLastCounts("user-a", "server-1", {
    unread: { unreadCounts: { "c-1": 4 }, mentionFlags: { "c-1": true }, newFlags: {} },
    followed: [followed("one")],
    activity: activity([inboxRow("one"), inboxRow("two")]),
  });
  saveLastCounts("user-a", "server-2", { unread: { unreadCounts: { "c-9": 9 }, mentionFlags: {}, newFlags: {} } });
  saveLastCounts("user-b", "server-3", { unread: { unreadCounts: { "c-7": 7 }, mentionFlags: {}, newFlags: {} } });

  useServerStore.getState().setCurrent(server("server-1"));
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "c-1": 4 });
  assert.deepEqual(useMessageStore.getState().mentionFlags, { "c-1": true });
  assert.deepEqual(useThreadStore.getState().followedThreads.map((thread) => thread.threadChannelId), ["thread-one"]);
  const inbox = useInboxStore.getState();
  assert.deepEqual(inbox.items.map((item) => item.kind === "channel" ? item.channelId : ""), ["channel-one", "channel-two"]);
  assert.equal(inbox.savedWindow, true);
  assert.equal(inbox.loaded, false, "opening Activity still loads it");
  assert.equal(surface("unread").freshness, "stale");
  assert.equal(surface("unread").confirmed, false, "no notice before the server says so");

  useServerStore.getState().setCurrent(server("server-2"));
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "c-9": 9 });
  assert.deepEqual(useThreadStore.getState().followedThreads, [], "server-1's followed threads are not carried over");
  assert.deepEqual(useInboxStore.getState().items, [], "server-1's Activity is not carried over");

  // user-b's entry for server-3 is not user-a's.
  useServerStore.getState().setCurrent(server("server-3"));
  assert.deepEqual(useMessageStore.getState().unreadCounts, {});
  assert.equal(surface("unread").freshness, "fresh");
});

test("the user becoming known after the server seeds too (boot order)", () => {
  useMessageStore.getState().setCurrentUserId(null);
  saveLastCounts("user-a", "server-1", { unread: { unreadCounts: { "c-1": 2 }, mentionFlags: {}, newFlags: {} } });
  useServerStore.getState().setCurrent(server("server-1"));
  assert.deepEqual(useMessageStore.getState().unreadCounts, {});
  useMessageStore.getState().setCurrentUserId("user-a");
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "c-1": 2 });
});

test("boot: the saved counts stay while the unread read fails, marked unavailable; a clean answer replaces and saves them", async () => {
  saveLastCounts("user-a", "server-1", { unread: { unreadCounts: { "c-1": 4 }, mentionFlags: {}, newFlags: {} } });
  useServerStore.getState().setCurrent(server("server-1"));
  stubGet(async (url) => {
    if (url === "/channels/unread") throw overloaded();
    return undefined;
  });
  await useMessageStore.getState().loadUnreadCounts();
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "c-1": 4 });
  assert.equal(surface("unread").freshness, "unavailable");
  assert.equal(surface("unread").confirmed, true);

  // A stale answer is shown but never saved.
  stubGet(async (url) => url === "/channels/unread" ? { data: { channels: { "c-1": 6 } }, headers: { "x-raft-stale": "rw_overloaded" } } : undefined);
  await useMessageStore.getState().loadUnreadCounts();
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "c-1": 6 });
  assert.equal(surface("unread").freshness, "stale");
  flushLastCounts();
  assert.deepEqual(readLastCounts("user-a", "server-1")?.unread?.unreadCounts, { "c-1": 4 });

  stubGet(async (url) => url === "/channels/unread" ? { data: { channels: { "c-2": 1 } } } : undefined);
  await useMessageStore.getState().loadUnreadCounts();
  assert.deepEqual(useMessageStore.getState().unreadCounts, { "c-2": 1 });
  assert.equal(surface("unread").freshness, "fresh");
  flushLastCounts();
  assert.deepEqual(readLastCounts("user-a", "server-1")?.unread?.unreadCounts, { "c-2": 1 });
});

test("followed threads use the same helper: stale is recorded and not saved, clean is saved", async () => {
  useServerStore.getState().setCurrent(server("server-1"));
  stubGet(async (url) => url === "/channels/threads/followed"
    ? { data: { threads: [followed("stale")] }, headers: { "x-raft-stale": "rw_overloaded" } }
    : undefined);
  await useThreadStore.getState().loadFollowedThreads();
  assert.equal(surface("followed").freshness, "stale");
  flushLastCounts();
  assert.equal(readLastCounts("user-a", "server-1")?.followed, undefined);

  let followedCalls = 0;
  stubGet(async (url) => {
    if (url !== "/channels/threads/followed") return undefined;
    followedCalls += 1;
    if (followedCalls === 1) throw overloaded();
    return { data: { threads: [followed("fresh")] } };
  });
  await useThreadStore.getState().loadFollowedThreads();
  assert.equal(followedCalls, 2, "an overload 503 is retried once, like the unread counts");
  assert.equal(surface("followed").freshness, "fresh");
  flushLastCounts();
  assert.deepEqual(readLastCounts("user-a", "server-1")?.followed?.map((thread) => thread.threadChannelId), ["thread-fresh"]);
});

test("Activity: the saved page is replaced whole by the first answer, and a clean All page is saved", async () => {
  saveLastCounts("user-a", "server-1", { activity: activity([inboxRow("old-1"), inboxRow("old-2"), inboxRow("old-3")]) });
  useServerStore.getState().setCurrent(server("server-1"));
  assert.equal(useInboxStore.getState().items.length, 3);
  stubGet(async (url) => url === "/channels/inbox"
    ? { data: { items: [inboxRow("new")], hasMore: true, totalCount: 40, totalUnreadCount: 2, activeUnreadCount: 2, groups: [] } }
    : undefined);
  await useInboxStore.getState().loadInbox({ reset: true });
  const inbox = useInboxStore.getState();
  assert.deepEqual(inbox.items.map((item) => item.kind === "channel" ? item.channelId : ""), ["channel-new"], "no saved row is kept as a tail");
  assert.equal(inbox.savedWindow, false);
  assert.equal(inbox.loadFailed, false);
  assert.equal(surface("inbox").freshness, "fresh");
  flushLastCounts();
  const saved = readLastCounts("user-a", "server-1")?.activity;
  assert.deepEqual(saved?.items.map((item) => item.kind === "channel" ? item.channelId : ""), ["channel-new"]);
  assert.equal(saved?.totalCount, 40);
});

test("Activity: a failed first load with nothing saved is a failure, not an empty list", async () => {
  useServerStore.getState().setCurrent(server("server-1"));
  stubGet(async (url) => {
    if (url === "/channels/inbox") throw overloaded();
    return undefined;
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  await useInboxStore.getState().loadInbox({ reset: true });
  consoleError.mockRestore();
  const inbox = useInboxStore.getState();
  assert.equal(inbox.loadFailed, true);
  assert.equal(inbox.items.length, 0);
  assert.equal(surface("inbox").freshness, "unavailable");
});

test("recovery delays: Retry-After first (5 s without one), then 5, 10, 20, 40 s, never past 60 s", () => {
  assert.equal(rwRecoveryDelayMs(0, 2_000), 2_000);
  assert.equal(rwRecoveryDelayMs(0, 600_000), 60_000);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((attempt) => rwRecoveryDelayMs(attempt, null)), [5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
});

test("recovery: re-reads with backoff while out of date and visible, at once when the page comes back, stops on a clean answer", async () => {
  vi.useFakeTimers();
  // No jitter: the waits are exactly Retry-After, then 5 s, 10 s ...
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", new EventTarget());
  let reads = 0;
  let answerFresh = false;
  useMessageStore.setState({
    loadUnreadCounts: async () => {
      reads += 1;
      if (answerFresh) markRwFresh("unread");
      else markRwUnavailable("unread", null);
    },
  });
  const stop = startRwRecovery();
  try {
    markRwStale("unread", 1_000);
    await vi.advanceTimersByTimeAsync(1_250);
    assert.equal(reads, 1, "the first re-read waits for Retry-After");

    // Next: 5 s later.
    await vi.advanceTimersByTimeAsync(3_900);
    assert.equal(reads, 1);
    await vi.advanceTimersByTimeAsync(2_200);
    assert.equal(reads, 2);

    // Hidden: the timer passes without a read; coming back reads at once.
    documentTarget.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(13_000);
    assert.equal(reads, 2);
    documentTarget.visibilityState = "visible";
    answerFresh = true;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(reads, 3);
    assert.equal(surface("unread").freshness, "fresh");

    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(reads, 3, "no more reads once fresh");
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

test("a socket reconnect re-reads what is out of date after a random 0-5 s, not at once", async () => {
  vi.useFakeTimers();
  // 0.6 of the 5 s spread: the reconnect read waits 3 s. The backoff timer (Retry-After 60 s) stays out of the way.
  vi.spyOn(Math, "random").mockReturnValue(0.6);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }));
  const windowTarget = new EventTarget();
  vi.stubGlobal("window", windowTarget);
  let reads = 0;
  useThreadStore.setState({
    loadFollowedThreads: async () => {
      reads += 1;
    },
  });
  const stop = startRwRecovery();
  try {
    markRwStale("followed", 60_000);
    windowTarget.dispatchEvent(new Event("slock:rooms-joined"));
    windowTarget.dispatchEvent(new Event("slock:rooms-joined"));
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(reads, 0, "not in the same second as every other client");
    await vi.advanceTimersByTimeAsync(2_900);
    assert.equal(reads, 0);
    await vi.advanceTimersByTimeAsync(200);
    assert.equal(reads, 1, "once, about 3 s later, however many reconnects came in");
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

test("Activity: a saved empty page is still a saved copy: a failed load keeps it (empty state + notice), not the failed state", async () => {
  saveLastCounts("user-a", "server-1", { activity: activity([]) });
  useServerStore.getState().setCurrent(server("server-1"));
  assert.equal(useInboxStore.getState().savedWindow, true);
  stubGet(async (url) => {
    if (url === "/channels/inbox") throw overloaded();
    return undefined;
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  await useInboxStore.getState().loadInbox({ reset: true });
  consoleError.mockRestore();
  assert.equal(useInboxStore.getState().loadFailed, false);
  assert.equal(surface("inbox").freshness, "unavailable");
});
