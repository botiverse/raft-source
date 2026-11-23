/**
 * #244 step 3b (inbox_message_inplace_v1, default off): a live message
 * (message_new, thread_reply) on a row Activity already lists, patched in
 * place in full on a settled plain All list, sends no re-read; its row is
 * still judged by the next first-window read (`inbox.inplace.reread`).
 * An unlisted row, a patch that leaves a field for the re-read, an unsettled
 * or filtered list re-read as before, and with the flag off every live
 * message re-reads. Persisted reads stay step 3a's.
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

const { useInboxStore, requestInboxBackgroundRefresh, cancelInboxBackgroundRefresh, INBOX_BACKGROUND_REFRESH_INTERVAL_MS } = await import("../src/store/inboxStore");
const { resetInPlaceDriftForTests } = await import("../src/store/inboxInPlaceUnread");
const { notifyChannelReadLocally, notifyChannelReadPersistedLocally } = await import("../src/store/readStateSync");
const { getCurrentPrincipalId } = await import("../src/store/principalRuntime");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const {
  INBOX_MESSAGE_INPLACE_FLAG_KEY,
  INBOX_READ_INPLACE_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} = await import("../src/store/serverFeatureFlags");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { default: api } = await import("../src/api/client");

const SERVER = "server-244";
const ME = "user-me";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;
type ThreadItem = Extract<InboxItem, { kind: "thread" }>;

function channelRow(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel",
    channelId: "channel-244",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-1",
    latestActivitySeq: "100",
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    lastMessageAt: "2026-11-11T10:00:00.000Z",
    lastMessagePreview: "first",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "alice",
    senderAvatarUrl: null,
    unreadCount: 2,
    hasMention: false,
    ...overrides,
  };
  return { doneFrontierSeq: base.latestActivitySeq, readStateLatestActivitySeq: base.latestActivitySeq, ...base } as ChannelItem;
}

function otherRow(): ChannelItem {
  return channelRow({
    channelId: "channel-older", channelName: "random", lastMessageId: "message-0", latestActivitySeq: "50",
    lastMessageAt: "2026-11-11T09:00:00.000Z", unreadCount: 0, firstUnreadMessageId: null,
  });
}

function threadRow(overrides: Partial<ThreadItem> = {}): ThreadItem {
  const base = {
    kind: "thread",
    threadChannelId: "thread-244",
    parentMessageId: "parent-1",
    parentChannelId: "channel-244",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-2",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivitySenderName: "alice",
    latestActivityMessageId: "reply-1",
    latestActivitySeq: "50",
    replyCount: 1,
    lastActivityAt: "2026-11-11T10:00:00.000Z",
    lastReplyAt: "2026-11-11T10:00:00.000Z",
    unreadCount: 1,
    hasMention: false,
    firstUnreadMessageId: "reply-1",
    firstMentionMessageId: null,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    isFollowing: true,
    ...overrides,
  };
  return { doneFrontierSeq: base.latestActivitySeq, readStateLatestActivitySeq: base.latestActivitySeq, ...base } as unknown as ThreadItem;
}

// The channel facet, listing every row's channel (a re-read would add a missing one).
const GROUPS = [
  { channelId: "channel-244", channelName: "general", channelType: "channel" as const, count: 1, lastActivityAt: "2026-11-11T10:00:00.000Z" },
  { channelId: "channel-older", channelName: "random", channelType: "channel" as const, count: 1, lastActivityAt: "2026-11-11T09:00:00.000Z" },
];

let served: InboxItem[] = [];
let reads: Array<{ reason: unknown; trigger: unknown }> = [];
/** X-Raft-Fetch-Refused of each read, in order (#244). */
let refusals: unknown[] = [];
let hold: Promise<void> | null = null;
type Trace = { outcome: string; detail: string; attrs: Record<string, unknown> };
let traces: Trace[] = [];

function serve() {
  api.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    reads.push({ reason: config?.headers?.["X-Raft-Fetch-Reason"], trigger: config?.headers?.["X-Raft-Fetch-Trigger"] });
    refusals.push(config?.headers?.["X-Raft-Fetch-Refused"]);
    if (hold) await hold;
    return {
      headers: {},
      data: {
        items: served.map((item) => ({
          ...item,
          readState: {
            kind: "present",
            readStateVersion: 1,
            maxReadSeq: "0",
            latestActivity: {
              messageId: item.kind === "thread" ? item.latestActivityMessageId : (item as ChannelItem).lastMessageId,
              seq: (item as ChannelItem).readStateLatestActivitySeq,
            },
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

function reset(items: InboxItem[], flagOn: boolean) {
  cancelInboxBackgroundRefresh();
  triggerServerReset();
  resetInPlaceDriftForTests();
  resetServerFeatureFlagsForTests();
  useServerStore.setState({ current: { id: SERVER, slug: "s" } as never, serverEpoch: 1 } as never);
  setServerFeatureFlagForTests(SERVER, INBOX_MESSAGE_INPLACE_FLAG_KEY, flagOn);
  setServerFeatureFlagForTests(SERVER, INBOX_READ_INPLACE_FLAG_KEY, false);
  // Another channel is open, so a live message counts unread.
  useMessageStore.setState({ currentUserId: ME, currentChannelId: "channel-open", unreadCounts: {} });
  useInboxStore.setState({
    items, groups: GROUPS, filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: items.length,
    totalUnreadCount: 2, activeUnreadCount: 2, hasAcceptedWindow: true, savedWindow: false,
  });
  served = [];
  reads = [];
  refusals = [];
  hold = null;
  traces = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name !== "slock.state.transition") return;
    const a = attrs as { key: { event: string; outcome: string }; meta: { outcomeDetail: string } } & Record<string, unknown>;
    if (a.key.event === "activity:inplace_check") traces.push({ outcome: a.key.outcome, detail: a.meta.outcomeDetail, attrs: a });
  });
  api.post = (async () => ({ data: {}, headers: {} })) as typeof api.post;
  serve();
  vi.useFakeTimers();
}

function restore() {
  api.get = originalGet;
  api.post = originalPost;
  vi.useRealTimers();
  __setStateTransitionEmitterForTest(null);
  cancelInboxBackgroundRefresh();
  resetServerFeatureFlagsForTests();
}

function socketHandler(event: string) {
  const bindings = buildMainLayoutSocketBindings(
    { connected: true, emit() {}, on() {}, off() {}, onAny() {}, offAny() {}, disconnect() {}, connect() {} } as never,
    requestInboxBackgroundRefresh, async () => {}, () => {}, () => {},
  );
  const binding = bindings.find((item) => item.event === event);
  assert.ok(binding, event);
  return binding.handler as (payload: unknown) => void;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-2", channelId: "channel-244", seq: 101, content: "second", senderType: "user",
    senderId: "user-3", senderName: "bob", createdAt: "2026-11-11T10:00:05.000Z", ...overrides,
  } as Message;
}

function reply(overrides: Partial<Message> = {}): Message {
  return message({
    id: "reply-2", channelId: "thread-244", seq: 51, content: "another reply", senderId: "user-2", senderName: "alice",
    conversationContext: { channelType: "thread" } as Message["conversationContext"], ...overrides,
  });
}

function threadUpdated(latestReply: Message) {
  socketHandler("thread:updated")({
    parentMessageId: "parent-1",
    threadChannelId: "thread-244",
    replyCount: 2,
    lastReplyAt: latestReply.createdAt,
    participantIds: ["user-2"],
    latestReply,
  });
}

/** The channel row as the server serves it once it has message-2. */
function servedAfterMessage(): ChannelItem {
  return channelRow({
    lastMessageId: "message-2", latestActivitySeq: "101", lastMessageAt: "2026-11-11T10:00:05.000Z",
    lastMessagePreview: "second", lastMessageSenderId: "user-3", lastMessageSenderName: "bob", unreadCount: 3,
  });
}

/** The thread row as the server serves it once it has reply-2. */
function servedAfterReply(): ThreadItem {
  return threadRow({
    latestActivityMessageId: "reply-2", latestActivitySeq: "51", latestActivityPreview: "another reply",
    replyCount: 2, unreadCount: 2, lastActivityAt: "2026-11-11T10:00:05.000Z", lastReplyAt: "2026-11-11T10:00:05.000Z",
  });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 2);
}

test("flag off: a live message on a listed row re-reads, and is measured as eligible_sent", async () => {
  reset([otherRow(), channelRow()], false);
  try {
    served = [servedAfterMessage(), otherRow()];
    socketHandler("message:new")(message());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }]);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "message_new");
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "eligible_sent");
    assert.match(traces[0].detail, /;reread=eligible_sent(;|$)/);
  } finally { restore(); }
});

test("flag on: a live message on a listed row is patched in place with no re-read; the next read judges it as skipped", async () => {
  reset([otherRow(), channelRow()], true);
  useInboxStore.setState({
    groups: [
      { channelId: "channel-older", channelName: "random", channelType: "channel", count: 1, lastActivityAt: "2026-11-11T09:00:00.000Z" },
      { channelId: "channel-244", channelName: "general", channelType: "channel", count: 1, lastActivityAt: "2026-11-11T08:00:00.000Z" },
    ],
  });
  try {
    socketHandler("message:new")(message());
    await settle();
    assert.deepEqual(reads, [], "no GET /channels/inbox for the message");
    const state = useInboxStore.getState();
    const row = state.items[0] as ChannelItem;
    assert.equal(row.channelId, "channel-244", "moved to the top");
    assert.equal(row.lastMessageId, "message-2");
    assert.equal(row.lastMessagePreview, "second");
    assert.equal(row.unreadCount, 3);
    assert.equal(row.latestActivitySeq, "101");
    assert.equal(row.readStateLatestActivitySeq, "101", "the read-state frontier moves with it");
    assert.equal(row.doneFrontierSeq, "101", "a Done covers the new message");
    assert.equal(state.totalUnreadCount, 3);
    assert.equal(state.groups[0].channelId, "channel-244", "the channel facet's activity moves too");

    // A later read judges the row the message left (one noop in 20 is sent: the first).
    served = [servedAfterMessage(), otherRow()];
    requestInboxBackgroundRefresh("activity_changed");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "activity_changed" }]);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "skipped");
    assert.match(traces[0].detail, /^trigger=message_new;existed=1;result=match;.*;reread=skipped(;|$)/);
  } finally { restore(); }
});

test("flag on: a skipped message the server disagrees with is still recorded as drift", async () => {
  reset([otherRow(), channelRow()], true);
  try {
    socketHandler("message:new")(message());
    await settle();
    assert.deepEqual(reads, []);
    served = [{ ...servedAfterMessage(), unreadCount: 2 }, otherRow()];
    requestInboxBackgroundRefresh("activity_changed");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "conflict");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "unread");
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "skipped");
  } finally { restore(); }
});

test("flag on: a live message for a row the list does not show still re-reads", async () => {
  reset([channelRow()], true);
  try {
    socketHandler("message:new")(message({ channelId: "channel-unlisted" }));
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }]);
  } finally { restore(); }
});

test("flag on: the saved page, a read in flight, or a filtered list still re-reads", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["saved page", { hasAcceptedWindow: false, savedWindow: true }],
    ["Unread filter", { filter: "unread" }],
    ["channel facet", { channelFilterId: "channel-244" }],
    ["search", { searchQuery: "sec" }],
    ["oldest first", { sortDirection: "asc" }],
  ];
  for (const [name, state] of cases) {
    reset([channelRow()], true);
    useInboxStore.setState(state);
    try {
      socketHandler("message:new")(message());
      await vi.advanceTimersByTimeAsync(0);
      assert.ok(reads.length > 0, name);
      assert.ok(reads.every((read) => read.trigger === "message_new"), name);
    } finally { restore(); }
  }

  reset([channelRow()], true);
  let release: () => void = () => undefined;
  hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const inFlight = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "reconnect" });
    await vi.advanceTimersByTimeAsync(0);
    served = [servedAfterMessage()];
    socketHandler("message:new")(message());
    hold = null;
    release();
    await inFlight;
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    assert.deepEqual(reads, [
      { reason: "reconnect", trigger: undefined },
      { reason: "realtime_fallback", trigger: "message_new" },
    ]);
  } finally { restore(); }
});

test("flag on: a patch that leaves a field for the re-read still re-reads", async () => {
  const cases: Array<[string, InboxItem, Message]> = [
    ["joint channel", channelRow({ channelType: "joint" }), message()],
    ["read-state frontier off the display seq", channelRow({ readStateLatestActivitySeq: "90" }), message()],
    ["own message with a mention", channelRow({ unreadCount: 0, firstUnreadMessageId: null }), message({ senderId: ME, mentions: [{ type: "user", id: "user-2" }] as Message["mentions"] })],
    // The send reads the row on the server; no read state comes to clear it here.
    ["own message on a row showing unread", channelRow(), message({ senderId: ME })],
    // The server does not count a system line the person caused; the live rule counts it.
    ["system line on a channel row", channelRow(), message({ senderId: "system", messageType: "system" } as Partial<Message>)],
  ];
  for (const [name, row, msg] of cases) {
    reset([row], true);
    try {
      socketHandler("message:new")(msg);
      await vi.advanceTimersByTimeAsync(0);
      assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }], name);
    } finally { restore(); }
  }
});

test("flag on: a row whose channel the facet does not list still re-reads", async () => {
  reset([channelRow()], true);
  useInboxStore.setState({ groups: [GROUPS[1]] });
  try {
    socketHandler("message:new")(message());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }]);
  } finally { restore(); }
});

test("flag on: an own message on a read row skips its re-read (the control for the unread case)", async () => {
  reset([channelRow({ unreadCount: 0, firstUnreadMessageId: null })], true);
  try {
    socketHandler("message:new")(message({ senderId: ME }));
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 0);
  } finally { restore(); }
});

test("thread_reply: a system line on a task conversation's row (status, claimer not patched) still re-reads", async () => {
  reset([threadRow({ taskNumber: 7, taskStatus: "in_progress" } as Partial<ThreadItem>)], true);
  try {
    threadUpdated(reply({
      messageType: "system", systemSubtype: "task.lifecycle_thread", causalActorType: "user", causalActorId: "user-2",
    } as Partial<Message>));
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "thread_reply" }]);
  } finally { restore(); }
});

test("thread_reply: a listed thread row's reply skips its re-read with the flag on, and re-reads with it off", async () => {
  for (const flagOn of [false, true]) {
    reset([threadRow()], flagOn);
    served = [servedAfterReply()];
    try {
      threadUpdated(reply());
      await settle();
      const row = useInboxStore.getState().items[0] as ThreadItem;
      assert.equal(row.latestActivityMessageId, "reply-2", `flag ${flagOn ? "on" : "off"}`);
      assert.equal(row.unreadCount, 2);
      assert.equal(row.replyCount, 2);
      assert.deepEqual(reads, flagOn ? [] : [{ reason: "realtime_fallback", trigger: "thread_reply" }], `flag ${flagOn ? "on" : "off"}`);
      if (flagOn) assert.equal(row.readStateLatestActivitySeq, "51");
    } finally { restore(); }
  }
});

test("thread_reply: a reply from another sender (the row's sender name is not patched) still re-reads", async () => {
  reset([threadRow()], true);
  try {
    threadUpdated(reply({ senderId: "user-3", senderName: "bob" }));
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "thread_reply" }]);
  } finally { restore(); }
});

test("thread_reply: an unfollowed thread row still re-reads", async () => {
  reset([threadRow({ isFollowing: false, unreadCount: 0, firstUnreadMessageId: null } as Partial<ThreadItem>)], true);
  try {
    threadUpdated(reply());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "thread_reply" }]);
  } finally { restore(); }
});

test("a reply that comes as message_new and then thread_reply skips both only when the first skipped", async () => {
  for (const flagOn of [false, true]) {
    reset([threadRow()], flagOn);
    served = [servedAfterReply()];
    try {
      socketHandler("message:new")(reply());
      threadUpdated(reply());
      await settle();
      assert.equal((useInboxStore.getState().items[0] as ThreadItem).unreadCount, 2, "counted once");
      assert.ok(flagOn ? reads.length === 0 : reads.length > 0, `flag ${flagOn ? "on" : "off"}`);
    } finally { restore(); }
  }
});

test("read_persisted is unchanged: with only the message flag on, a persisted read re-reads", async () => {
  reset([channelRow()], true);
  try {
    notifyChannelReadLocally("channel-244");
    notifyChannelReadPersistedLocally({ channelId: "channel-244", serverId: SERVER, serverEpoch: 1, principalId: getCurrentPrincipalId() });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "read_persisted" }]);
  } finally { restore(); }
});

test("#244: a thread reply whose row is not listed re-reads with X-Raft-Fetch-Refused: not_listed", async () => {
  reset([otherRow(), channelRow()], true);
  try {
    threadUpdated(reply());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "thread_reply" }]);
    assert.deepEqual(refusals, ["not_listed"]);
  } finally { restore(); }
});

test("#244: a thread reply on a listed row of a list not settled re-reads with not_settled", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Unread filter", { filter: "unread" }],
    ["a read in flight", { loading: true }],
    ["its facet group not loaded", { groups: [GROUPS[1]] }],
  ];
  for (const [name, state] of cases) {
    reset([threadRow(), otherRow()], true);
    useInboxStore.setState(state as never);
    try {
      threadUpdated(reply());
      await vi.advanceTimersByTimeAsync(0);
      if (name === "a read in flight") useInboxStore.setState({ loading: false });
      await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
      // Its answer may bring more reads (a catch-up): the first is the reply's.
      assert.equal(reads[0]?.trigger, "thread_reply", name);
      assert.equal(refusals[0], "not_settled", name);
    } finally { restore(); }
  }
});

test("#244: a complete patch with the flag off re-reads with flag_off; a message with no seq with no_seq", async () => {
  reset([otherRow(), channelRow()], false);
  try {
    socketHandler("message:new")(message());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }]);
    assert.deepEqual(refusals, ["flag_off"]);
  } finally { restore(); }
  reset([otherRow(), channelRow()], true);
  try {
    socketHandler("message:new")(message({ seq: undefined }));
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }]);
    assert.deepEqual(refusals, ["no_seq"]);
  } finally { restore(); }
});
