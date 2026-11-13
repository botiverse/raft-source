/**
 * #244 drift on thread rows (AndyLok's 11-11 read of `activity:inplace_check`):
 * a thread bumped in place stays on top through a lagging re-read (until the
 * stale-list bound), a lagging neighbour does not count as an order drift,
 * a system line counts on a thread row as the server counts it, the check's
 * detail says what the event was, and a read made elsewhere clears the row.
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
const { applyReadStateUpdate } = await import("../src/store/applyReadStateUpdate");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { selectChannelWindowMeta, useMessageStore } = await import("../src/store/messageStore");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { default: api } = await import("../src/api/client");
const { cancelInboxBackgroundRefresh } = await import("../src/store/inboxStore");
const { COUNTED_IDS_PER_ROW, inboxCountedIdsSizeForTests } = await import("../src/store/inboxCountedIds");

const originalGet = api.get.bind(api);
const originalNow = Date.now;
const ME = "user-me";
const SERVER = "server-244";

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;
type ThreadItem = Extract<InboxItem, { kind: "thread" }>;

function channel(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel", channelId: "channel-a", channelName: "general", channelType: "channel",
    lastMessageId: "a-1", latestActivitySeq: "100", firstUnreadMessageId: null, firstMentionMessageId: null,
    lastMessageAt: "2026-11-09T10:00:00.000Z", lastMessagePreview: "first", lastMessageSenderType: "user",
    lastMessageSenderId: "user-2", lastMessageSenderName: "alice", senderAvatarUrl: null, unreadCount: 0, hasMention: false,
    ...overrides,
  };
  return { ...base, doneFrontierSeq: base.latestActivitySeq, readStateLatestActivitySeq: base.latestActivitySeq } as ChannelItem;
}

function thread(overrides: Partial<ThreadItem> = {}): ThreadItem {
  const base = {
    kind: "thread", threadChannelId: "thread-t", parentMessageId: "parent-1", parentChannelId: "channel-a",
    latestActivityMessageId: "t-1", latestActivitySeq: "50", replyCount: 1, unreadCount: 0, hasMention: false,
    firstUnreadMessageId: null, firstMentionMessageId: null,
    lastActivityAt: "2026-11-09T09:00:00.000Z", lastReplyAt: "2026-11-09T09:00:00.000Z",
    ...overrides,
  };
  return { readStateLatestActivitySeq: base.latestActivitySeq, ...base } as unknown as ThreadItem;
}

function message(overrides: Partial<Message> & Record<string, unknown> = {}): Message {
  return {
    id: "t-2", channelId: "thread-t", seq: 51, content: "reply", senderType: "user", senderId: "user-2",
    senderName: "alice", createdAt: "2026-11-09T10:05:00.000Z",
    ...overrides,
  } as Message;
}

let served: InboxItem[] = [];
let triggers: unknown[] = [];
type Trace = { outcome: string; detail: string; result: unknown };
let traces: Trace[] = [];

function serve() {
  api.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    triggers.push(config?.headers?.["X-Raft-Fetch-Trigger"]);
    return {
      headers: {},
      data: {
        items: served.map((item) => {
          const row = item as ChannelItem & ThreadItem;
          const messageId = item.kind === "thread" ? row.latestActivityMessageId : row.lastMessageId;
          return {
            ...item,
            readState: { kind: "present", readStateVersion: 1, maxReadSeq: "0", latestActivity: { messageId, seq: row.latestActivitySeq } },
          };
        }),
        totalCount: served.length,
        totalUnreadCount: 0,
        activeUnreadCount: 0,
        hasMore: false,
      },
    };
  }) as typeof api.get;
}

function reset(items: InboxItem[]) {
  triggerServerReset();
  resetInPlaceDriftForTests();
  useServerStore.setState({ current: { id: SERVER } as never, serverEpoch: 1 } as never);
  useMessageStore.setState({ currentUserId: ME });
  useInboxStore.setState({
    items, groups: [], filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: items.length,
    totalUnreadCount: 0, activeUnreadCount: 0,
  });
  served = [];
  traces = [];
  triggers = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name !== "slock.state.transition") return;
    const a = attrs as { key: { event: string; outcome: string }; meta: { outcomeDetail: string } } & Record<string, unknown>;
    if (a.key.event === "activity:inplace_check") traces.push({ outcome: a.key.outcome, detail: a.meta.outcomeDetail, result: a["inbox.inplace.result"] });
  });
}

function restore() {
  api.get = originalGet;
  Date.now = originalNow;
  __setStateTransitionEmitterForTest(null);
  reset([]);
}

const keys = () => useInboxStore.getState().items.map((item) => (item.kind === "thread" ? item.threadChannelId : (item as ChannelItem).channelId));
const threadRow = () => useInboxStore.getState().items.find((item): item is ThreadItem => item.kind === "thread")!;

function reply(msg: Message) {
  useInboxStore.getState().receiveThreadReply(msg, liveActivityUnread(msg, "thread_reply"));
}

/** The socket bridge's message:new path (applyLiveMessageActivity), minus the bridge. */
function deliver(msg: Message) {
  const live = liveActivityUnread(msg, "message_new");
  useInboxStore.getState().receiveThreadReply(msg, live);
  useInboxStore.getState().receiveChannelMessage(msg, live);
}

async function reread() {
  await useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "realtime_fallback" });
}

test("a thread bumped in place stays on top through a re-read that has not seen the reply", async () => {
  serve();
  const before = [channel(), thread()];
  reset(before);
  try {
    reply(message());
    assert.deepEqual(keys(), ["thread-t", "channel-a"]);
    served = before;
    await reread();
    assert.deepEqual(keys(), ["thread-t", "channel-a"], "the lagging answer does not drop the row back");
    assert.equal(threadRow().latestActivityMessageId, "t-2");
    assert.equal(threadRow().unreadCount, 1);
  } finally { restore(); }
});

test("a kept thread row sits among kept channel rows by time", async () => {
  serve();
  const before = [channel(), channel({ channelId: "channel-b", lastMessageId: "b-1", latestActivitySeq: "70" }), thread()];
  reset(before);
  try {
    reply(message({ createdAt: "2026-11-09T10:05:00.000Z" }));
    deliver(message({ id: "b-2", channelId: "channel-b", seq: 71, createdAt: "2026-11-09T10:06:00.000Z" }));
    assert.deepEqual(keys(), ["channel-b", "thread-t", "channel-a"]);
    served = before;
    await reread();
    assert.deepEqual(keys(), ["channel-b", "thread-t", "channel-a"]);
  } finally { restore(); }
});

test("a kept thread row stays below a newer row the answer has caught up on", async () => {
  serve();
  const b = channel({ channelId: "channel-b", lastMessageId: "b-1", latestActivitySeq: "70", lastMessageAt: "2026-11-09T09:30:00.000Z" });
  reset([channel(), b, thread()]);
  try {
    reply(message({ createdAt: "2026-11-09T10:05:00.000Z" }));
    deliver(message({ id: "b-2", channelId: "channel-b", seq: 71, createdAt: "2026-11-09T10:06:00.000Z" }));
    assert.deepEqual(keys(), ["channel-b", "thread-t", "channel-a"]);
    served = [
      channel({ channelId: "channel-b", lastMessageId: "b-2", latestActivitySeq: "71", lastMessageAt: "2026-11-09T10:06:00.000Z", unreadCount: 1 }),
      channel(),
      thread(),
    ];
    await reread();
    assert.deepEqual(keys(), ["channel-b", "thread-t", "channel-a"], "not above the newer caught-up row");
  } finally { restore(); }
});

test("past the stale-list bound the answer's row is shown as served", async () => {
  serve();
  const before = [channel(), thread()];
  reset(before);
  try {
    reply(message());
    const later = originalNow() + 91_000;
    Date.now = () => later;
    served = before;
    await reread();
    assert.deepEqual(keys(), ["channel-a", "thread-t"]);
    assert.equal(threadRow().latestActivityMessageId, "t-1");
  } finally { restore(); }
});

test("a lagging neighbour does not make a caught-up row's order drift", async () => {
  serve();
  // A row listed above channel-a; both get a live message, the answer has only channel-a's.
  const x = channel({ channelId: "channel-x", lastMessageId: "x-1", latestActivitySeq: "300", lastMessageAt: "2026-11-09T10:01:00.000Z" });
  reset([x, channel()]);
  try {
    deliver(message({ id: "a-2", channelId: "channel-a", seq: 101, createdAt: "2026-11-09T10:05:00.000Z" }));
    deliver(message({ id: "x-2", channelId: "channel-x", seq: 301, createdAt: "2026-11-09T10:06:00.000Z" }));
    assert.deepEqual(keys(), ["channel-x", "channel-a"]);
    served = [
      channel({ lastMessageId: "a-2", latestActivitySeq: "101", lastMessageAt: "2026-11-09T10:05:00.000Z", unreadCount: 1 }),
      x,
    ];
    await reread();
    assert.equal(traces.length, 1, "channel-x, still behind, is not judged");
    assert.equal(traces[0].result, "match", traces[0].detail);
  } finally { restore(); }
});

test("a system line counts on a thread row as the server counts it", () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["caused by someone else", { systemSubtype: "task.status_changed", causalActorType: "user", causalActorId: "user-2" }, 1],
    ["no subtype, no actor", { systemSubtype: null, causalActorType: null, causalActorId: null }, 1],
    ["caused by an agent with my id", { systemSubtype: "x", causalActorType: "agent", causalActorId: ME }, 1],
    ["caused by me", { systemSubtype: "task.status_changed", causalActorType: "user", causalActorId: ME }, 0],
    ["an agent's self-unfollow", { systemSubtype: "channel.self_unfollow_thread", causalActorType: null, causalActorId: null }, 0],
    ["a deleted task's summary", { systemSubtype: "task.deleted_summary", causalActorType: null, causalActorId: null }, 0],
    ["without its provenance", {}, 0],
    ["on a task conversation's row", { systemSubtype: "task.status_changed", causalActorType: "agent", causalActorId: "agent-1", task: true }, 0],
  ];
  for (const [name, { task, ...provenance }, unread] of cases) {
    reset([thread(task ? { conversationKind: "task", parentMessageId: "" } as Partial<ThreadItem> : {})]);
    try {
      reply(message({ messageType: "system", senderId: "system", ...provenance }));
      assert.equal(threadRow().latestActivityMessageId, "t-2", name);
      assert.equal(threadRow().unreadCount, unread, name);
      assert.equal(useInboxStore.getState().totalUnreadCount, unread, name);
    } finally { restore(); }
  }
});

test("a counted system line agrees with the server's count in the check", async () => {
  serve();
  reset([channel(), thread()]);
  try {
    deliver(message({ messageType: "system", senderId: "system", systemSubtype: "task.status_changed", causalActorType: "user", causalActorId: "user-2" }));
    served = [thread({ latestActivityMessageId: "t-2", latestActivitySeq: "51", lastActivityAt: "2026-11-09T10:05:00.000Z", unreadCount: 1 }), channel()];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].result, "match", traces[0].detail);
  } finally { restore(); }
});

test("the check's detail says what the event was and whether a read came since", async () => {
  serve();
  reset([channel(), thread({ isFollowing: true } as Partial<ThreadItem>)]);
  try {
    deliver(message());
    applyReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 50, readStateVersion: 10 });
    assert.equal(threadRow().unreadCount, 1, "a read before the reply leaves it unread");
    served = [thread({ latestActivityMessageId: "t-2", latestActivitySeq: "51", lastActivityAt: "2026-11-09T10:05:00.000Z", unreadCount: 2 }), channel()];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "conflict");
    assert.match(traces[0].detail, /;ahead=0;own=0;sender_type=user;message_type=chat;following=1;age_ms=\d+;read_state=1;loaded=0;counts=1;late=0;via=live$/);

    deliver(message({ id: "a-2", channelId: "channel-a", seq: 101, senderId: ME, createdAt: "2026-11-09T10:06:00.000Z" }));
    served = [channel({ lastMessageId: "a-2", latestActivitySeq: "101", lastMessageAt: "2026-11-09T10:06:00.000Z", unreadCount: 3 }), served[0]];
    await reread();
    assert.equal(traces.length, 2);
    assert.match(traces[1].detail, /;own=1;sender_type=user;message_type=chat;age_ms=\d+;read_state=0;loaded=0;counts=0;late=0;via=live$/, "no following on a channel row");
  } finally { restore(); }
});

test("a read made elsewhere clears a thread row it covers, not one with a newer reply", async () => {
  serve();
  const before = thread({ unreadCount: 2, hasMention: true });
  reset([before]);
  useInboxStore.setState({ totalUnreadCount: 2, activeUnreadCount: 2 });
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 49, readStateVersion: 10 });
    assert.equal(threadRow().unreadCount, 2, "the read stops before the row's latest reply");
    reply(message({ id: "t-2", seq: 51 }));
    assert.equal(threadRow().unreadCount, 3);
    applyReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 50, readStateVersion: 11 });
    assert.equal(threadRow().unreadCount, 3, "a live reply past the read keeps the row unread");
    applyReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 51, readStateVersion: 12, unreadCount: 0 });
    assert.equal(threadRow().unreadCount, 0);
    assert.equal(threadRow().hasMention, false);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    served = [{ ...before, unreadCount: 3 }];
    await reread();
    assert.equal(threadRow().unreadCount, 0, "an answer from before the read does not bring the count back");
  } finally { restore(); }
});

test("a zero-reply thread row whose display seq is its parent's is not cleared on it", () => {
  reset([thread({ unreadCount: 1, latestActivitySeq: "900", readStateLatestActivitySeq: null } as Partial<ThreadItem>)]);
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 950, readStateVersion: 10 });
    assert.equal(threadRow().unreadCount, 1, "no read-state frontier: left to the re-read");
  } finally { restore(); }
});

// #triage:#244 double count: message:new runs addMessage first; with an accepted
// read state and the scope's messages loaded completely, its projection (which
// counts the new message) sets the row's unread, so the in-place patch adds nothing.
function loadScope(scopeId: string, messages: Message[], maxReadSeq: number) {
  useMessageStore.setState((state) => ({ channelMessages: { ...state.channelMessages, [scopeId]: messages } }));
  applyReadStateUpdate({ serverId: SERVER, scopeId, maxReadSeq, readStateVersion: 10 });
}

/** The socket bridge's message:new order: the message store first, then the row in place. */
function messageNew(msg: Message) {
  useMessageStore.getState().addMessage(msg, "channel-room");
  deliver(msg);
}

const loadedThread = () => [
  message({ id: "t-1", seq: 50, createdAt: "2026-11-09T09:00:00.000Z" }),
  message({ id: "t-x", seq: 51, createdAt: "2026-11-09T09:30:00.000Z" }),
];
const threadAt51 = () => thread({ latestActivityMessageId: "t-x", latestActivitySeq: "51", unreadCount: 1, isFollowing: true } as Partial<ThreadItem>);
const nextReply = () => message({ id: "t-2", seq: 52 });

test("a reply in a loaded thread with a complete projection is counted once", async () => {
  serve();
  reset([threadAt51()]);
  useInboxStore.setState({ totalUnreadCount: 1, activeUnreadCount: 1 });
  try {
    loadScope("thread-t", loadedThread(), 50);
    assert.equal(threadRow().unreadCount, 1, "the projection agrees with the row");
    messageNew(nextReply());
    assert.equal(threadRow().latestActivityMessageId, "t-2");
    assert.equal(threadRow().latestActivitySeq, "52");
    assert.equal(threadRow().unreadCount, 2, "the projected count, not one more");
    assert.equal(threadRow().firstUnreadMessageId, "t-x");
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
    served = [thread({ latestActivityMessageId: "t-2", latestActivitySeq: "52", lastActivityAt: "2026-11-09T10:05:00.000Z", unreadCount: 2, isFollowing: true } as Partial<ThreadItem>)];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].result, "match", traces[0].detail);
    assert.match(traces[0].detail, /;read_state=0;loaded=1;counts=1;late=0;via=live$/);
  } finally {
    useMessageStore.setState({ channelMessages: {} });
    restore();
  }
});

test("a reply in a thread whose messages are not loaded still counts in place", async () => {
  serve();
  reset([threadAt51()]);
  try {
    messageNew(nextReply());
    assert.equal(threadRow().unreadCount, 2);
    served = [thread({ latestActivityMessageId: "t-2", latestActivitySeq: "52", lastActivityAt: "2026-11-09T10:05:00.000Z", unreadCount: 2, isFollowing: true } as Partial<ThreadItem>)];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].result, "match", traces[0].detail);
    assert.match(traces[0].detail, /;read_state=0;loaded=0;counts=1;late=0;via=live$/);
  } finally {
    useMessageStore.setState({ channelMessages: {} });
    restore();
  }
});

test("a message in a loaded channel with a complete projection is counted once", async () => {
  serve();
  reset([channel()]);
  try {
    loadScope("channel-a", [message({ id: "a-1", channelId: "channel-a", seq: 100, createdAt: "2026-11-09T10:00:00.000Z" })], 100);
    messageNew(message({ id: "a-2", channelId: "channel-a", seq: 101, createdAt: "2026-11-09T10:05:00.000Z" }));
    const row = useInboxStore.getState().items[0] as ChannelItem;
    assert.equal(row.lastMessageId, "a-2");
    assert.equal(row.latestActivitySeq, "101");
    assert.equal(row.unreadCount, 1, "the projected count, not one more");
    assert.equal(row.firstUnreadMessageId, "a-2");
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
    assert.equal(useInboxStore.getState().activeUnreadCount, 1);
    served = [channel({ lastMessageId: "a-2", latestActivitySeq: "101", lastMessageAt: "2026-11-09T10:05:00.000Z", unreadCount: 1 })];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].result, "match", traces[0].detail);
    assert.match(traces[0].detail, /^trigger=message_new;/);
    assert.match(traces[0].detail, /;read_state=0;loaded=1;counts=1;late=0;via=live$/);
  } finally {
    useMessageStore.setState({ channelMessages: {} });
    restore();
  }
});

test("a message in a channel whose messages are not loaded still counts in place", () => {
  reset([channel()]);
  try {
    messageNew(message({ id: "a-2", channelId: "channel-a", seq: 101, createdAt: "2026-11-09T10:05:00.000Z" }));
    assert.equal((useInboxStore.getState().items[0] as ChannelItem).unreadCount, 1);
  } finally {
    useMessageStore.setState({ channelMessages: {} });
    restore();
  }
});

test("thread:updated before message:new: a reply not yet in the loaded thread counts in place, and the projection then agrees", async () => {
  serve();
  reset([threadAt51()]);
  try {
    loadScope("thread-t", loadedThread(), 50);
    const msg = nextReply();
    reply(msg);
    assert.equal(threadRow().unreadCount, 2, "not in the loaded messages yet (loaded=0): counted in place");
    messageNew(msg);
    assert.equal(threadRow().unreadCount, 2, "the projection agrees; the patch is past its seq");
    served = [thread({ latestActivityMessageId: "t-2", latestActivitySeq: "52", lastActivityAt: "2026-11-09T10:05:00.000Z", unreadCount: 2, isFollowing: true } as Partial<ThreadItem>)];
    await reread();
    assert.equal(traces.length, 1);
    assert.match(traces[0].detail, /^trigger=thread_reply;.*;loaded=0;counts=1;late=0;via=live$/);
    assert.equal(traces[0].result, "match", traces[0].detail);
  } finally {
    useMessageStore.setState({ channelMessages: {} });
    restore();
  }
});

test("an accepted read state over an incomplete window does not stop the in-place count", async () => {
  const meta = (patch: Record<string, boolean>) => () => useMessageStore.setState((state) => ({
    channelWindowMeta: { ...state.channelWindowMeta, "thread-t": { ...selectChannelWindowMeta(state, "thread-t"), ...patch } },
  }));
  const cases: Array<[string, () => void, Message[], number]> = [
    ["newer messages not loaded", meta({ hasNewer: true }), loadedThread(), 50],
    ["a gap in the window", meta({ hasGap: true }), loadedThread(), 50],
    ["unread messages before the window", () => {}, [message({ id: "t-x", seq: 51, createdAt: "2026-11-09T09:30:00.000Z" })], 49],
  ];
  for (const [name, incomplete, loaded, maxReadSeq] of cases) {
    serve();
    reset([threadAt51()]);
    useInboxStore.setState({ totalUnreadCount: 1, activeUnreadCount: 1 });
    try {
      incomplete();
      loadScope("thread-t", loaded, maxReadSeq);
      assert.equal(threadRow().unreadCount, 1, `${name}: no projection`);
      messageNew(nextReply());
      assert.equal(threadRow().latestActivitySeq, "52", name);
      assert.equal(threadRow().unreadCount, 2, `${name}: counted in place`);
      assert.equal(useInboxStore.getState().totalUnreadCount, 2, name);
      served = [thread({ latestActivityMessageId: "t-2", latestActivitySeq: "52", lastActivityAt: "2026-11-09T10:05:00.000Z", unreadCount: 2, isFollowing: true } as Partial<ThreadItem>)];
      await reread();
      assert.equal(traces.length, 1, name);
      assert.match(traces[0].detail, /;loaded=0;counts=1;late=0;via=live$/, name);
    } finally {
      useMessageStore.setState({ channelMessages: {}, channelWindowMeta: {} });
      restore();
    }
  }
});

test("a mention in a loaded thread takes its mention fields and count from the projection", () => {
  reset([threadAt51()]);
  useInboxStore.setState({ totalUnreadCount: 1, activeUnreadCount: 1 });
  try {
    loadScope("thread-t", loadedThread(), 50);
    assert.equal(threadRow().hasMention, false);
    const msg = message({ id: "t-2", seq: 52, mentions: [{ type: "user", id: ME }] } as Partial<Message>);
    messageNew(msg);
    assert.equal(threadRow().unreadCount, 2, "the projected count, not one more");
    assert.equal(threadRow().hasMention, true);
    assert.equal(threadRow().firstMentionMessageId, "t-2");
    assert.equal(threadRow().firstUnreadMessageId, "t-x");
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally {
    useMessageStore.setState({ channelMessages: {} });
    restore();
  }
});

// #triage:#244 under-count: a live message at or below its row's seq (it came
// after a newer one) used to be dropped whole; it counts once, unread only.
const t52 = () => message({ id: "t-3", seq: 52, content: "newest", createdAt: "2026-11-09T10:06:00.000Z" });
const t51 = () => message({ id: "t-2", seq: 51, content: "older", createdAt: "2026-11-09T10:05:00.000Z" });
const servedThreadAt52 = (unreadCount: number) => thread({ latestActivityMessageId: "t-3", latestActivitySeq: "52", lastActivityAt: "2026-11-09T10:06:00.000Z", unreadCount });

async function listServed(items: InboxItem[]) {
  served = items;
  await reread();
  traces = [];
}

test("a late older reply after a newer one counts once; the row's preview, seq and order stay", async () => {
  serve();
  reset([channel({ lastMessageAt: "2026-11-09T11:00:00.000Z" }), thread()]);
  try {
    await listServed([channel({ lastMessageAt: "2026-11-09T11:00:00.000Z" }), thread()]);
    reply(t52());
    assert.equal(threadRow().unreadCount, 1);
    const order = keys();
    reply(t51());
    assert.equal(threadRow().unreadCount, 2, "the late reply counts");
    assert.equal(threadRow().latestActivityMessageId, "t-3");
    assert.equal(threadRow().latestActivitySeq, "52");
    assert.equal(threadRow().latestActivityPreview, "newest");
    assert.equal(threadRow().replyCount, 2, "one more reply for the newer one only");
    assert.deepEqual(keys(), order);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
    served = [servedThreadAt52(2), channel({ lastMessageAt: "2026-11-09T11:00:00.000Z" })];
    await reread();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].result, "match", traces[0].detail);
    assert.match(traces[0].detail, /;loaded=0;counts=1;late=1;via=live$/);
  } finally { restore(); }
});

test("a duplicate of the late reply does not count again, from either event", async () => {
  serve();
  reset([thread()]);
  try {
    await listServed([thread()]);
    reply(t52());
    reply(t51());
    reply(t51());
    deliver(t51());
    deliver(t52());
    assert.equal(threadRow().unreadCount, 2);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally { restore(); }
});

test("a late message on a channel row counts once and the lagging answer keeps it", async () => {
  serve();
  reset([channel()]);
  try {
    await listServed([channel()]);
    // My own newest message moves the row without counting; the late one from someone else counts.
    deliver(message({ id: "a-3", channelId: "channel-a", seq: 102, content: "newest", senderId: ME, createdAt: "2026-11-09T10:06:00.000Z" }));
    deliver(message({ id: "a-2", channelId: "channel-a", seq: 101, content: "older", createdAt: "2026-11-09T10:05:00.000Z" }));
    deliver(message({ id: "a-2", channelId: "channel-a", seq: 101, content: "older", createdAt: "2026-11-09T10:05:00.000Z" }));
    const row = () => useInboxStore.getState().items[0] as ChannelItem;
    assert.equal(row().unreadCount, 1);
    assert.equal(row().firstUnreadMessageId, "a-2");
    assert.equal(row().lastMessageId, "a-3");
    assert.equal(row().lastMessagePreview, "newest");
    await listServed([channel()]);
    assert.equal(row().unreadCount, 1, "an answer behind both keeps the in-place count");
  } finally { restore(); }
});

test("an older message the last served answer already had does not count", async () => {
  serve();
  reset([thread()]);
  try {
    await listServed([servedThreadAt52(1)]);
    reply(t51());
    assert.equal(threadRow().unreadCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally { restore(); }
});

test("a served answer clears the row's counted set; past the cap a re-read is asked for", async () => {
  serve();
  reset([channel()]);
  try {
    await listServed([channel()]);
    deliver(message({ id: "a-2", channelId: "channel-a", seq: 101, createdAt: "2026-11-09T10:05:00.000Z" }));
    assert.equal(inboxCountedIdsSizeForTests("channel-a"), 1);
    await listServed([channel({ lastMessageId: "a-2", latestActivitySeq: "101", unreadCount: 1 })]);
    assert.equal(inboxCountedIdsSizeForTests("channel-a"), 0, "the answer covers it");

    cancelInboxBackgroundRefresh();
    triggers = [];
    for (let i = 0; i < COUNTED_IDS_PER_ROW + 1; i += 1) {
      deliver(message({ id: `c-${i}`, channelId: "channel-a", seq: 200 + i, createdAt: "2026-11-09T10:10:00.000Z" }));
    }
    assert.equal(inboxCountedIdsSizeForTests("channel-a"), COUNTED_IDS_PER_ROW, "bounded");
    assert.deepEqual(triggers, ["counted_cap"]);
    deliver(message({ id: "late", channelId: "channel-a", seq: 150, createdAt: "2026-11-09T10:09:00.000Z" }));
    assert.equal((useInboxStore.getState().items[0] as ChannelItem).unreadCount, 1 + COUNTED_IDS_PER_ROW + 1, "a full row counts no late message");
  } finally {
    cancelInboxBackgroundRefresh();
    restore();
  }
});

test("an answer still behind a late message leaves it counted: a repeat does not count again", async () => {
  serve();
  reset([thread()]);
  try {
    await listServed([thread()]);
    reply(t52());
    reply(t51());
    assert.equal(threadRow().unreadCount, 2);
    await listServed([thread()]);
    assert.equal(threadRow().unreadCount, 2, "the lagging answer keeps the in-place count");
    reply(t51());
    deliver(t51());
    assert.equal(threadRow().unreadCount, 2, "counted once");
    assert.equal(inboxCountedIdsSizeForTests("thread-t"), 2, "the answer covered neither");
  } finally { restore(); }
});

test("the served seq never moves back: an older answer does not reopen a message a newer one had", async () => {
  serve();
  reset([thread()]);
  try {
    await listServed([servedThreadAt52(1)]);
    reply(message({ id: "t-4", seq: 53, createdAt: "2026-11-09T10:07:00.000Z" }));
    assert.equal(threadRow().unreadCount, 2);
    await listServed([thread()]);
    assert.equal(threadRow().latestActivitySeq, "53", "the local row is kept over the lagging answer");
    reply(t51());
    assert.equal(threadRow().unreadCount, 2, "seq 51 was in an earlier answer: not counted");
  } finally { restore(); }
});

test("a late message at or below the accepted read cursor is read: not counted", async () => {
  serve();
  reset([thread()]);
  try {
    await listServed([thread()]);
    reply(t52());
    // Read on another device up to 51, before 51's own delivery here.
    applyReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 51, readStateVersion: 10 });
    const before = threadRow().unreadCount;
    reply(t51());
    assert.equal(threadRow().unreadCount, before);
  } finally { restore(); }
});
