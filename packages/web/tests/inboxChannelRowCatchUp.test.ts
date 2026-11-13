/**
 * Task #86: with Activity open, a new channel message left its row one message
 * behind. The read that `message:new` triggers is served from a RisingWave view
 * that lags the write by ~1-2 s, so it still has the previous message.
 *
 *  - The live message patches its existing row's preview, sender and time
 *    (never counts, never a new row), and a stale answer does not undo it.
 *  - One catch-up re-reads while the answer is behind the newest live message:
 *    at most twice, through the background throttle; a stale answer ends it.
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
  INBOX_BACKGROUND_REFRESH_INTERVAL_MS,
} = await import("../src/store/inboxStore");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);

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
/** X-Raft-Fetch-Trigger of each inbox read (#triage:#229). */
let inboxTriggers: unknown[] = [];

function serveFromVariable() {
  api.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {} };
    inboxGets += 1;
    inboxTriggers.push(config?.headers?.["X-Raft-Fetch-Trigger"]);
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
  inboxTriggers = [];
}

function restore() {
  api.get = originalGet;
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

test("#86: event arrives, the first re-read is stale, the row still shows the new message", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    const before = makeChannelItem();
    resetInbox([makeChannelItem({ channelId: "channel-other", lastMessageId: "message-o" }), before]);
    // The view has not seen message-2 yet; its count moved on its own (2).
    // The view also still orders it below the other row.
    served = [makeChannelItem({ channelId: "channel-other", lastMessageId: "message-o" }), { ...before, unreadCount: 2 }];

    deliver(liveMessage());
    assert.equal(row().lastMessagePreview, "second", "patched from the event before any read");
    assert.equal(useInboxStore.getState().items[0].kind !== "mention_action"
      && useInboxStore.getState().items[0].kind !== "thread"
      && useInboxStore.getState().items[0].channelId, "channel-86", "moved to the top");

    await vi.advanceTimersByTimeAsync(0);
    assert.equal(inboxGets, 1, "the immediate read ran");
    const afterStale = row();
    assert.equal(afterStale.lastMessagePreview, "second");
    assert.equal(afterStale.lastMessageId, "message-2");
    assert.equal(afterStale.latestActivitySeq, "101");
    assert.equal(afterStale.lastMessageSenderId, "agent-7");
    assert.equal(afterStale.lastMessageSenderName, "bot");
    assert.equal(afterStale.lastMessageAt, "2026-10-25T17:00:05.000Z");
    assert.equal(afterStale.senderAvatarUrl, null, "a new sender does not inherit the previous avatar");
    assert.equal(afterStale.unreadCount, 2, "counts come from the server answer");
    assert.equal(useInboxStore.getState().items[0], afterStale, "still on top, not back in the view's order");

    // The view catches up before the catch-up re-read.
    served = [makeChannelItem({
      lastMessageId: "message-2",
      latestActivitySeq: "101",
      lastMessagePreview: "second (server)",
      lastMessageSenderType: "agent",
      lastMessageSenderId: "agent-7",
      lastMessageSenderName: "bot",
      senderAvatarUrl: "https://example.test/bot.png",
      unreadCount: 3,
    })];
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    assert.equal(inboxGets, 2, "one catch-up re-read");
    assert.deepEqual(inboxTriggers, ["message_new", "catch_up_retry"], "the catch-up re-read names itself");
    assert.equal(row().lastMessagePreview, "second (server)", "the caught-up server row wins");
    assert.equal(row().senderAvatarUrl, "https://example.test/bot.png");
    assert.equal(row().unreadCount, 3);

    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(inboxGets, 2, "nothing more once the answer is current");
  } finally { restore(); }
});

test("#86: a view that never catches up gets two catch-up re-reads, then none", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    const before = makeChannelItem();
    resetInbox([before]);
    served = [before];
    deliver(liveMessage());
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(inboxGets, 3, "the immediate read plus two re-reads");
    assert.equal(row().lastMessagePreview, "second", "the live message stays shown");
  } finally { restore(); }
});

test("#86: a stale (X-Raft-Stale) answer ends the catch-up; recovery owns the pace", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    const before = makeChannelItem();
    resetInbox([before]);
    served = [before];
    staleHeader = true;
    deliver(liveMessage());
    await vi.advanceTimersByTimeAsync(3_500);
    assert.equal(inboxGets, 1, "no catch-up re-read after a stale answer");
    assert.equal(row().lastMessagePreview, "second");
  } finally { restore(); }
});

test("#86: only a strictly newer message on an existing row patches it", async () => {
  const before = makeChannelItem();
  resetInbox([before]);
  try {
    useInboxStore.getState().receiveChannelMessage(liveMessage({ seq: 100, content: "duplicate" }));
    useInboxStore.getState().receiveChannelMessage(liveMessage({ seq: 99, content: "older" }));
    useInboxStore.getState().receiveChannelMessage(liveMessage({ seq: undefined, content: "no seq" }));
    useInboxStore.getState().receiveChannelMessage(liveMessage({ channelId: "channel-unlisted", content: "elsewhere" }));
    useInboxStore.getState().receiveChannelMessage(liveMessage({
      content: "thread reply",
      conversationContext: { channelType: "thread" } as Message["conversationContext"],
    }));
    assert.deepEqual(useInboxStore.getState().items, [before], "no row changed and none was created");

    useInboxStore.getState().receiveChannelMessage(liveMessage({ senderId: "user-2", senderType: "user" }));
    assert.equal(row().lastMessagePreview, "second");
    assert.equal(row().unreadCount, 1, "the count is untouched");
    assert.equal(row().senderAvatarUrl, "https://example.test/alice.png", "same sender keeps the avatar");
  } finally { restore(); }
});

test("#86: a later message on a channel the list doesn't show keeps the catch-up on the row that is behind", async () => {
  serveFromVariable();
  vi.useFakeTimers();
  try {
    const before = makeChannelItem();
    resetInbox([before]);
    served = [before];
    deliver(liveMessage());
    deliver(liveMessage({ id: "message-elsewhere", channelId: "channel-unlisted", seq: 102 }));
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(inboxGets, 3, "the immediate read plus two re-reads for the lagging row");
  } finally { restore(); }
});

test("#198: the first load replaces the saved list, but not a live message it hasn't seen yet", async () => {
  serveFromVariable();
  const serve = api.get;
  let answer = () => {};
  const asked = new Promise<void>((resolve) => { answer = resolve; });
  api.get = (async (...args: Parameters<typeof api.get>) => {
    await asked;
    const response = await serve(...args);
    return { ...response, data: { ...response.data, hasMore: true } };
  }) as typeof api.get;
  vi.useFakeTimers();
  try {
    const before = makeChannelItem();
    const other = makeChannelItem({ channelId: "channel-other", lastMessageId: "message-o" });
    resetInbox([other, before, makeChannelItem({ channelId: "channel-gone", lastMessageId: "message-g" })]);
    useInboxStore.setState({ savedWindow: true, loaded: false });
    served = [{ ...other, lastMessagePreview: "other (server)" }, { ...before, unreadCount: 2 }];

    const load = useInboxStore.getState().loadInbox({ reset: true, reason: "initial" });
    useInboxStore.getState().receiveChannelMessage(liveMessage());
    answer();
    await vi.advanceTimersByTimeAsync(0);
    await load;

    const state = useInboxStore.getState();
    assert.equal(state.savedWindow, false);
    assert.equal(row().lastMessagePreview, "second", "the answer is behind the live message");
    assert.equal(row().unreadCount, 2, "counts come from the server answer");
    assert.equal(state.items[0], row(), "still on top");
    assert.equal(row("channel-other").lastMessagePreview, "other (server)", "the other rows are the server's");
    assert.equal(state.items.length, 2, "a saved row the server no longer lists doesn't stay");
  } finally { restore(); }
});
