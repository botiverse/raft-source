/**
 * Task #33 — a Done item reappears for ~3s under load, and busy activity
 * refetches the whole Activity list on every realtime event.
 *
 * HAR (artin): POST /channels/inbox/done -> {"ok":true} at 21.9; refreshes at
 * 22.3, 22.3 and 23.0 still return the row (unread 1); gone from 24.8. The list
 * is served from a RisingWave view that lags the Postgres write, and under RW
 * slowness from a Redis copy up to 60s old.
 *
 *  - A confirmed Done / read stays applied locally until the served row carries
 *    a newer marker or INBOX_LOCAL_MUTATION_HOLD_MS lapses.
 *  - Realtime-triggered reloads are throttled leading+trailing; user loads are not.
 */
import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const {
  useInboxStore,
  getInboxItemKey,
  requestInboxBackgroundRefresh,
  INBOX_BACKGROUND_REFRESH_INTERVAL_MS,
  INBOX_LOCAL_MUTATION_HOLD_MS,
} = await import("../src/store/inboxStore");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { default: api } = await import("../src/api/client");

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

const S1 = "100";
const S2 = "101";

function makeChannelItem(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel",
    channelId: "channel-33",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-1",
    latestActivitySeq: S1,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-10-20T03:57:00.000Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "alice",
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
  return {
    ...base,
    doneFrontierSeq: base.latestActivitySeq,
    readStateLatestActivitySeq: base.latestActivitySeq,
  } as ChannelItem;
}

function wireRow(item: ChannelItem) {
  return {
    ...item,
    readState: {
      kind: "present",
      readStateVersion: 1,
      maxReadSeq: "0",
      latestActivity: { messageId: item.lastMessageId, seq: item.readStateLatestActivitySeq },
    },
  };
}

/** The served Activity list; tests swap it to model the view catching up. */
let served: ChannelItem[] = [];
let inboxGets = 0;

function serveFromVariable() {
  api.get = (async (url: string) => {
    if (url !== "/channels/inbox") return { data: {} };
    inboxGets += 1;
    return {
      data: {
        items: served.map(wireRow),
        totalCount: served.length,
        totalUnreadCount: served.reduce((sum, item) => sum + item.unreadCount, 0),
        activeUnreadCount: served.reduce((sum, item) => sum + item.unreadCount, 0),
        hasMore: false,
      },
    };
  }) as typeof api.get;
}

function resetInbox(items: InboxItem[] = []) {
  triggerServerReset();
  useServerStore.setState({ current: { id: "server-1" } as never, serverEpoch: 1 } as never);
  const unread = items.reduce((sum, i) => sum + i.unreadCount, 0);
  useInboxStore.setState({
    items,
    groups: [],
    filter: "all",
    channelFilterId: null,
    loading: false,
    loadingMore: false,
    hasMore: false,
    loaded: true,
    totalCount: items.length,
    totalUnreadCount: unread,
    activeUnreadCount: unread,
    scrollTop: 0,
    focusedItemKey: null,
  });
  inboxGets = 0;
}

function restore() {
  api.post = originalPost;
  api.get = originalGet;
  vi.useRealTimers();
  served = [];
  resetInbox();
}

function visibleKeys(): string[] {
  return useInboxStore.getState().items.map((item) => getInboxItemKey(item));
}

async function flushPromises() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("#33: the stale lists after a confirmed Done keep the row hidden, with counts adjusted, until the view drops it", async () => {
  const done = makeChannelItem({ unreadCount: 1 });
  const survivor = makeChannelItem({ channelId: "channel-survivor", lastMessageId: "message-s", unreadCount: 2 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  try {
    resetInbox([done, survivor]);
    // The view still has the row: markDone's own refresh AND the following
    // polls (22.3, 22.3, 23.0 in the HAR) serve it with the click-time marker.
    served = [done, survivor];
    await useInboxStore.getState().markDone(done);
    for (let poll = 0; poll < 3; poll += 1) {
      await useInboxStore.getState().refreshInbox({ background: true });
      assert.deepEqual(visibleKeys(), [getInboxItemKey(survivor)], `stale poll ${poll} must not resurrect the Done row`);
      const state = useInboxStore.getState();
      assert.equal(state.totalCount, 1);
      assert.equal(state.totalUnreadCount, 2);
      assert.equal(state.activeUnreadCount, 2);
    }

    // The view catches up (24.8): same visible result, counts now from the server.
    served = [survivor];
    await useInboxStore.getState().refreshInbox({ background: true });
    assert.deepEqual(visibleKeys(), [getInboxItemKey(survivor)]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally { restore(); }
});

test("#33: a stale cache that serves the row again after the view dropped it is still hidden inside the hold", async () => {
  const done = makeChannelItem({ unreadCount: 1 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    resetInbox([done]);
    served = [];
    await useInboxStore.getState().markDone(done);
    // Server falls back to a Redis copy taken before the Done (up to 60s old).
    now += 60_000;
    served = [done];
    await useInboxStore.getState().refreshInbox({ background: true });
    assert.deepEqual(visibleKeys(), []);
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally { Date.now = realNow; restore(); }
});

test("#33: newer activity on a Done row is visible immediately, even inside the hold", async () => {
  const done = makeChannelItem({ unreadCount: 1 });
  const newer = makeChannelItem({ latestActivitySeq: S2, lastMessageId: "message-2", unreadCount: 1 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  try {
    resetInbox([done]);
    served = [done];
    await useInboxStore.getState().markDone(done);
    assert.deepEqual(visibleKeys(), []);
    served = [newer];
    await useInboxStore.getState().refreshInbox({ background: true });
    assert.deepEqual(visibleKeys(), [getInboxItemKey(newer)]);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally { restore(); }
});

test("#33: a stale copy taken before the row's latest activity (older marker) keeps the Done row hidden", async () => {
  const done = makeChannelItem({ latestActivitySeq: S2, lastMessageId: "message-2", unreadCount: 1 });
  const older = makeChannelItem({ latestActivitySeq: S1, unreadCount: 1 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  try {
    resetInbox([done]);
    served = [done];
    await useInboxStore.getState().markDone(done);
    // The Redis fallback was taken before S2 arrived: same row, OLDER marker.
    served = [older];
    await useInboxStore.getState().refreshInbox({ background: true });
    assert.deepEqual(visibleKeys(), []);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    // ...and the hold survived it: the click-time copy is still hidden next poll.
    served = [done];
    await useInboxStore.getState().refreshInbox({ background: true });
    assert.deepEqual(visibleKeys(), []);
  } finally { restore(); }
});

test("#33: a read row served with an older marker than the one marked read stays read", async () => {
  const read = makeChannelItem({ latestActivitySeq: S2, lastMessageId: "message-2", unreadCount: 2 });
  const older = makeChannelItem({ latestActivitySeq: S1, unreadCount: 1 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  try {
    resetInbox([read]);
    served = [read];
    await useInboxStore.getState().markAllRead();
    served = [older];
    await useInboxStore.getState().refreshInbox({ background: true });
    const state = useInboxStore.getState();
    assert.deepEqual(state.items.map((item) => item.unreadCount), [0]);
    assert.equal(state.totalUnreadCount, 0);
  } finally { restore(); }
});

test("#33: the hold expires — a row the server still serves after the cap is shown again", async () => {
  const done = makeChannelItem({ unreadCount: 1 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  vi.useFakeTimers();
  try {
    resetInbox([done]);
    served = [done];
    await useInboxStore.getState().markDone(done);
    vi.setSystemTime(Date.now() + INBOX_LOCAL_MUTATION_HOLD_MS);
    await useInboxStore.getState().refreshInbox();
    assert.deepEqual(visibleKeys(), [], "still held at the exact cap");
    vi.setSystemTime(Date.now() + 1);
    await useInboxStore.getState().refreshInbox();
    assert.deepEqual(visibleKeys(), [getInboxItemKey(done)]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally { restore(); }
});

test("#33: a failed Done drops the hold at once (the rollback, there is no Undo for Done)", async () => {
  const done = makeChannelItem({ unreadCount: 1 });
  api.post = (async () => { throw new Error("done rejected"); }) as typeof api.post;
  serveFromVariable();
  try {
    resetInbox([done]);
    served = [done];
    await useInboxStore.getState().markDone(done);
    assert.deepEqual(visibleKeys(), [getInboxItemKey(done)]);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally { restore(); }
});

test("#33: Mark all read stays applied through stale lists past the old 3s window", async () => {
  const a = makeChannelItem({ channelId: "channel-a", unreadCount: 2 });
  const b = makeChannelItem({ channelId: "channel-b", lastMessageId: "message-b", unreadCount: 3 });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveFromVariable();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    resetInbox([a, b]);
    served = [a, b];
    await useInboxStore.getState().markAllRead();
    now += 10_000;
    await useInboxStore.getState().refreshInbox({ background: true });
    const state = useInboxStore.getState();
    assert.deepEqual(state.items.map((item) => item.unreadCount), [0, 0]);
    assert.equal(state.totalUnreadCount, 0);
    assert.equal(state.activeUnreadCount, 0);
  } finally { Date.now = realNow; restore(); }
});

test("#33: a burst of realtime refresh requests within 1s issues one leading and one trailing fetch", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    resetInbox([]);
    served = [makeChannelItem()];
    for (let i = 0; i < 20; i += 1) {
      requestInboxBackgroundRefresh("message_new");
      await vi.advanceTimersByTimeAsync(50);
    }
    assert.equal(inboxGets, 1, "only the leading fetch inside the window");
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    assert.equal(inboxGets, 2, "one trailing fetch delivers the latest state");
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 4);
    assert.equal(inboxGets, 2, "no further fetches without new events");
  } finally { restore(); }
});

test("#33: a user-initiated refresh is never delayed by the background throttle", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    resetInbox([]);
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(inboxGets, 1);
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(100);
    await useInboxStore.getState().refreshInbox();
    await flushPromises();
    assert.equal(inboxGets, 2, "the user refresh fetched immediately");
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    assert.equal(inboxGets, 3, "the pending realtime trailing fetch still runs");
  } finally { restore(); }
});
