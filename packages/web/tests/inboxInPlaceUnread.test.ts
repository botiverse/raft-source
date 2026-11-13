/**
 * #244 step 2: a live message patches its existing Activity row's unread and
 * mention in place; the re-read still runs, and each first-window answer is
 * checked against the patched rows (`activity:inplace_check`: noop when the
 * answer agrees, conflict when not, with the trigger and whether the row was
 * listed when the event came).
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

const { useInboxStore } = await import("../src/store/inboxStore");
const { liveActivityUnread, resetInPlaceDriftForTests } = await import("../src/store/inboxInPlaceUnread");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);
const ME = "user-me";

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

function makeChannelItem(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel",
    channelId: "channel-244",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-1",
    latestActivitySeq: "100",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-11-09T10:00:00.000Z",
    lastMessagePreview: "first",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "alice",
    senderAvatarUrl: null,
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
  return { ...base, doneFrontierSeq: base.latestActivitySeq, readStateLatestActivitySeq: base.latestActivitySeq } as ChannelItem;
}

function liveMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-2",
    channelId: "channel-244",
    seq: 101,
    content: "second",
    senderType: "user",
    senderId: "user-2",
    senderName: "alice",
    createdAt: "2026-11-09T10:00:05.000Z",
    ...overrides,
  } as Message;
}

let served: ChannelItem[] = [];
type Trace = { outcome: string; detail: string; attrs: Record<string, unknown> };
let traces: Trace[] = [];

function serve() {
  api.get = (async (url: string) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    return {
      headers: {},
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

function reset(items: InboxItem[] = []) {
  triggerServerReset();
  resetInPlaceDriftForTests();
  useServerStore.setState({ current: { id: "server-244" } as never, serverEpoch: 1 } as never);
  useMessageStore.setState({ currentUserId: ME });
  useInboxStore.setState({
    items, groups: [], filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: items.length,
    totalUnreadCount: 0, activeUnreadCount: 0,
  });
  served = [];
  traces = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name !== "slock.state.transition") return;
    const a = attrs as { key: { event: string; outcome: string }; meta: { outcomeDetail: string } } & Record<string, unknown>;
    if (a.key.event === "activity:inplace_check") traces.push({ outcome: a.key.outcome, detail: a.meta.outcomeDetail, attrs: a });
  });
}

function restore() {
  api.get = originalGet;
  __setStateTransitionEmitterForTest(null);
  reset();
}

function row(channelId = "channel-244"): ChannelItem {
  const found = useInboxStore.getState().items.find(
    (item): item is ChannelItem => (item.kind === "channel" || item.kind === "dm") && item.channelId === channelId,
  );
  assert.ok(found, `row ${channelId} is listed`);
  return found;
}

/** The socket bridge's message:new path (applyLiveMessageActivity), minus the bridge. */
function deliver(message: Message) {
  const live = liveActivityUnread(message, "message_new");
  useInboxStore.getState().receiveThreadReply(message, live);
  useInboxStore.getState().receiveChannelMessage(message, live);
}

async function reread() {
  await useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "realtime_fallback" });
}

test("a live message from someone else adds one unread and its mention in place", () => {
  reset([makeChannelItem()]);
  try {
    deliver(liveMessage({ mentions: [{ type: "user", id: ME }] as Message["mentions"] }));
    assert.equal(row().unreadCount, 1);
    assert.equal(row().hasMention, true);
    assert.equal(row().firstUnreadMessageId, "message-2");
    assert.equal(row().firstMentionMessageId, "message-2");
    // A repeat delivery of the same message does not count twice.
    deliver(liveMessage({ mentions: [{ type: "user", id: ME }] as Message["mentions"] }));
    assert.equal(row().unreadCount, 1);
  } finally { restore(); }
});

test("my own message moves the row but leaves its unread", () => {
  reset([makeChannelItem({ unreadCount: 2 })]);
  try {
    deliver(liveMessage({ senderId: ME }));
    assert.equal(row().lastMessageId, "message-2");
    assert.equal(row().unreadCount, 2);
  } finally { restore(); }
});

test("a row the list does not show is not created", () => {
  reset([makeChannelItem()]);
  try {
    deliver(liveMessage({ channelId: "channel-unlisted" }));
    assert.equal(useInboxStore.getState().items.length, 1);
  } finally { restore(); }
});

function makeThreadItem(overrides: Record<string, unknown> = {}): InboxItem {
  return {
    kind: "thread",
    threadChannelId: "thread-244",
    parentMessageId: "parent-1",
    parentChannelId: "channel-244",
    latestActivityMessageId: "reply-1",
    latestActivitySeq: "50",
    replyCount: 1,
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: "2026-11-09T10:00:00.000Z",
    lastReplyAt: "2026-11-09T10:00:00.000Z",
    ...overrides,
  } as unknown as InboxItem;
}

test("a thread reply adds one unread on its thread row; a lifecycle line does not", () => {
  const thread = {
    kind: "thread",
    threadChannelId: "thread-244",
    parentMessageId: "parent-1",
    parentChannelId: "channel-244",
    latestActivityMessageId: "reply-1",
    latestActivitySeq: "50",
    replyCount: 1,
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: "2026-11-09T10:00:00.000Z",
    lastReplyAt: "2026-11-09T10:00:00.000Z",
  } as unknown as InboxItem;
  reset([thread]);
  try {
    const reply = liveMessage({ id: "reply-2", channelId: "thread-244", seq: 51 });
    useInboxStore.getState().receiveThreadReply(reply, liveActivityUnread(reply, "thread_reply"));
    const lifecycle = liveMessage({ id: "reply-3", channelId: "thread-244", seq: 52, messageType: "system" } as Partial<Message>);
    useInboxStore.getState().receiveThreadReply(lifecycle, liveActivityUnread(lifecycle, "thread_reply"));
    const threadRow = useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>;
    assert.equal(threadRow.latestActivityMessageId, "reply-3");
    assert.equal(threadRow.unreadCount, 1);
  } finally { restore(); }
});

test("an answer still behind the patched row keeps the in-place count and judges nothing", async () => {
  serve();
  const before = makeChannelItem();
  reset([before]);
  try {
    deliver(liveMessage());
    served = [before];
    await reread();
    assert.equal(row().unreadCount, 1, "the lagging answer does not undo the in-place count");
    assert.deepEqual(traces, [], "a lagging answer is not drift");
  } finally { restore(); }
});

test("an answer that agrees records a match; one that does not records the drift", async () => {
  serve();
  reset([makeChannelItem()]);
  try {
    deliver(liveMessage());
    served = [makeChannelItem({ lastMessageId: "message-2", latestActivitySeq: "101", unreadCount: 1 })];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.match(traces[0].detail, /^trigger=message_new;existed=1;result=match;unread=1\/1/);
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "message_new");
    assert.equal(traces[0].attrs["inbox.inplace.row_existed"], "true");

    deliver(liveMessage({ id: "message-3", seq: 102 }));
    served = [makeChannelItem({ lastMessageId: "message-3", latestActivitySeq: "102", unreadCount: 5, hasMention: true })];
    await reread();
    assert.equal(traces.length, 2);
    assert.equal(traces[1].outcome, "conflict");
    assert.equal(traces[1].attrs["inbox.inplace.result"], "unread+mention");
    assert.equal(row().unreadCount, 5, "the re-read still wins");
  } finally { restore(); }
});

test("an event for an unlisted row is noted as not listed, and the answer that brings it records it", async () => {
  serve();
  reset([makeChannelItem()]);
  try {
    deliver(liveMessage({ channelId: "channel-new", seq: 7 }));
    served = [makeChannelItem({ channelId: "channel-new", latestActivitySeq: "7", unreadCount: 1 }), makeChannelItem()];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.row_existed"], "false");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "appeared");
  } finally { restore(); }
});

test("the totals move with the in-place count, so a read on the row takes back only what it added", () => {
  const other = makeChannelItem({ channelId: "channel-other", unreadCount: 1, latestActivitySeq: "90" });
  reset([makeChannelItem(), other]);
  useInboxStore.setState({ totalUnreadCount: 1, activeUnreadCount: 1 });
  try {
    deliver(liveMessage());
    assert.equal(row().unreadCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
    assert.equal(useInboxStore.getState().activeUnreadCount, 2);
    useInboxStore.getState().clearReadForChannel("channel-244");
    assert.equal(useInboxStore.getState().totalUnreadCount, 1, "the other row is still unread");
    assert.equal(useInboxStore.getState().activeUnreadCount, 1);
  } finally { restore(); }
});

test("an answer behind the patched row keeps the row's count in the totals too", async () => {
  serve();
  const before = makeChannelItem();
  reset([before]);
  try {
    deliver(liveMessage());
    served = [before];
    await reread();
    assert.equal(row().unreadCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1, "total = row sum after the lagging answer");
    assert.equal(useInboxStore.getState().activeUnreadCount, 1);
  } finally { restore(); }
});

test("under the Unread filter a read row that gets a live message joins its group", () => {
  reset([makeChannelItem()]);
  useInboxStore.setState({ filter: "unread", groups: [] });
  try {
    deliver(liveMessage());
    assert.deepEqual(useInboxStore.getState().groups.map((group) => [group.channelId, group.count]), [["channel-244", 1]]);
  } finally { restore(); }
});

test("an unfollowed thread row, or one without a seq, is not counted in place", () => {
  for (const overrides of [{ isFollowing: false }, { latestActivitySeq: null }]) {
    reset([makeThreadItem(overrides)]);
    try {
      const reply = liveMessage({ id: "reply-2", channelId: "thread-244", seq: 51 });
      useInboxStore.getState().receiveThreadReply(reply, liveActivityUnread(reply, "thread_reply"));
      const threadRow = useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>;
      assert.equal(threadRow.latestActivityMessageId, "reply-2", "the row still moves");
      assert.equal(threadRow.unreadCount, 0, JSON.stringify(overrides));
      assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    } finally { restore(); }
  }
});

test("agreements are sampled one in 20 (with the rate); every conflict is sent", async () => {
  serve();
  reset([makeChannelItem()]);
  try {
    for (let i = 0; i < 21; i += 1) {
      const seq = 101 + i;
      deliver(liveMessage({ id: `message-${seq}`, seq }));
      served = [makeChannelItem({ lastMessageId: `message-${seq}`, latestActivitySeq: String(seq), unreadCount: row().unreadCount })];
      await reread();
    }
    assert.deepEqual(traces.map((trace) => trace.attrs["inbox.inplace.sample_rate"]), ["20", "20"], "the 1st and 21st agreement");
    deliver(liveMessage({ id: "message-200", seq: 200 }));
    served = [makeChannelItem({ lastMessageId: "message-200", latestActivitySeq: "200", unreadCount: 99 })];
    await reread();
    assert.equal(traces.length, 3);
    assert.equal(traces[2].outcome, "conflict");
    assert.equal(traces[2].attrs["inbox.inplace.sample_rate"], "1");
  } finally { restore(); }
});
