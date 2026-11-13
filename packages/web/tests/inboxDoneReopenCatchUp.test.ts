/**
 * Task #92: Done hides an Activity row; a new message on that channel then
 * reopens it on the server. The row is not listed, so the live message patches
 * nothing, and the read it triggers is usually served before the RisingWave
 * view has the message (the row is still absent there). Without a catch-up the
 * row stayed hidden until some unrelated event re-read the list.
 *
 *  - A message newer than a held Done chases the view: a missing row counts as
 *    behind, re-read at 1.5 s, 3 s and once more at 10 s, then stop.
 *  - A missing row with no Done hold is still "not behind" (no retries).
 */
import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import type { Message } from "../src/store/messageStore";

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
  requestInboxBackgroundRefresh,
} = await import("../src/store/inboxStore");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

function makeChannelItem(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel",
    channelId: "channel-86",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-1",
    latestActivitySeq: "100",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-10-25T17:00:00.000Z",
    lastMessagePreview: "first",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "alice",
    senderAvatarUrl: "https://example.test/alice.png",
    unreadCount: 1,
    hasMention: false,
    ...overrides,
  };
  return {
    ...base,
    doneFrontierSeq: base.latestActivitySeq,
    readStateLatestActivitySeq: base.latestActivitySeq,
  } as ChannelItem;
}

function liveMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-2",
    channelId: "channel-86",
    seq: 101,
    content: "second",
    senderType: "agent",
    senderId: "agent-7",
    senderName: "bot",
    createdAt: "2026-10-25T17:00:05.000Z",
    ...overrides,
  } as Message;
}

let served: ChannelItem[] = [];
let staleHeader = false;
let inboxGets = 0;

function serveFromVariable() {
  api.get = (async (url: string) => {
    if (url !== "/channels/inbox") return { data: {} };
    inboxGets += 1;
    return {
      headers: staleHeader ? { "x-raft-stale": "rw_slow" } : {},
      data: {
        items: served.map((item) => ({
          ...item,
          readState: {
            kind: "present",
            readStateVersion: 1,
            maxReadSeq: "0",
            latestActivity: { messageId: item.lastMessageId, seq: item.readStateLatestActivitySeq },
          },
        })),
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
  api.get = originalGet;
  api.post = originalPost;
  vi.useRealTimers();
  served = [];
  staleHeader = false;
  resetInbox();
}

function row(channelId = "channel-86"): ChannelItem {
  const found = useInboxStore.getState().items.find(
    (item): item is ChannelItem => item.kind !== "thread" && item.kind !== "mention_action" && item.channelId === channelId,
  );
  assert.ok(found, `row ${channelId} is listed`);
  return found;
}

/** What the socket bridge does for an accepted `message:new`. */
function deliver(message: Message) {
  useInboxStore.getState().receiveChannelMessage(message);
  requestInboxBackgroundRefresh("message_new");
}


function listed(channelId = "channel-86"): boolean {
  return useInboxStore.getState().items.some(
    (item) => (item.kind === "channel" || item.kind === "dm") && item.channelId === channelId,
  );
}

const other = () => makeChannelItem({
  channelId: "channel-other",
  lastMessageId: "message-o",
  latestActivitySeq: "90",
  unreadCount: 0,
});
const reopenedRow = () => makeChannelItem({
  lastMessageId: "message-2",
  latestActivitySeq: "101",
  lastMessagePreview: "second",
});

/** Done on channel-86 (seq 100), confirmed, and the view has applied it. */
async function doneAndSettle() {
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  const before = makeChannelItem();
  resetInbox([before, other()]);
  served = [before, other()];
  await useInboxStore.getState().markDone(before);
  served = [other()];
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(listed(), false, "Done hid the row");
}

test("#92: a message after Done, first read before the view has it -> the row comes back by itself", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    await doneAndSettle();
    const start = inboxGets;
    deliver(liveMessage());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(inboxGets, start + 1, "the event's read ran, before the view has the message");
    assert.equal(listed(), false);

    // The view catches up ~1 s later; nothing else happens on the server.
    // The 1.5 s re-read waits for the 2.5 s background throttle window.
    served = [reopenedRow(), other()];
    await vi.advanceTimersByTimeAsync(2_500);
    assert.equal(inboxGets, start + 2, "the catch-up re-read");
    assert.equal(row().lastMessagePreview, "second", "the reopened row is back");

    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(inboxGets, start + 2, "nothing more once the row is served");
  } finally { restore(); }
});

test("#92: a view that lags ~8 s is caught by the one later (10 s) read, then reads stop", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    await doneAndSettle();
    const start = inboxGets;
    deliver(liveMessage());
    // Reads at 0, 2.5 s (1.5 s delay, throttled), 5.5 s (+3 s), 15.5 s (+10 s).
    await vi.advanceTimersByTimeAsync(5_500);
    assert.equal(inboxGets, start + 3, "the read plus the 1.5 s and 3 s re-reads");
    assert.equal(listed(), false, "the view has not caught up yet");

    await vi.advanceTimersByTimeAsync(2_500); // ~8 s after the message
    served = [reopenedRow(), other()];
    assert.equal(inboxGets, start + 3);
    await vi.advanceTimersByTimeAsync(7_500);
    assert.equal(inboxGets, start + 4, "the later read at 10 s");
    assert.equal(row().lastMessagePreview, "second");

    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(inboxGets, start + 4, "no 4th re-read");
  } finally { restore(); }
});

test("#92: a view that never catches up gets three re-reads, then none", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    await doneAndSettle();
    const start = inboxGets;
    deliver(liveMessage());
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(inboxGets, start + 4, "the read plus 1.5 s, 3 s and 10 s re-reads");
    assert.equal(listed(), false);
  } finally { restore(); }
});

test("#92: a message no newer than the Done does not chase", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    await doneAndSettle();
    const start = inboxGets;
    deliver(liveMessage({ seq: 100 }));
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(inboxGets, start + 1, "only the event's own read");
  } finally { restore(); }
});

test("#92: a missing row without a Done hold is still not behind", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    resetInbox([other()]);
    served = [other()];
    deliver(liveMessage());
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(inboxGets, 1, "only the event's own read, no retries");
    assert.equal(listed(), false);
  } finally { restore(); }
});
