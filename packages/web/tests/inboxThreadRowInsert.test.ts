/**
 * #244 (inbox_row_position_v1): a `thread:updated` for a followed thread the
 * loaded Activity list does not show inserts the row the frame and the
 * followed-thread entry carry, placed by time as the position rule places a
 * kept row, with no list read; the next list answer judges it
 * (`inbox.inplace.reread=inserted`). Anything it cannot decide re-reads the
 * list as before (`X-Raft-Fetch-Refused: not_listed`); flag off, unchanged.
 */
import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import type { Message } from "../src/store/messageStore";
import type { FollowedThread } from "../src/store/threadStore";

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
const { ROW_REREAD_DELAY_MS, resetInboxRowPositionForTests } = await import("../src/store/inboxRowPosition");
const { buildInsertedThreadRow, insertedRowIndex } = await import("../src/store/inboxInsertedThreadRow");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { setScopeMarkedUnread } = await import("../src/store/markedUnreadStore");
const { consumeReadStateUpdate } = await import("../src/store/readStateSync");
const { liveActivityUnread } = await import("../src/store/inboxInPlaceUnread");
const { setCurrentPrincipalId } = await import("../src/store/principalRuntime");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useThreadStore } = await import("../src/store/threadStore");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { INBOX_ROW_POSITION_FLAG_KEY, resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } = await import("../src/store/serverFeatureFlags");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { default: api } = await import("../src/api/client");

const SERVER = "server-244";
const ME = "user-me";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;
type ThreadItem = Extract<InboxItem, { kind: "thread" }>;

function otherRow(overrides: Partial<ChannelItem> = {}): ChannelItem {
  return {
    kind: "channel", channelId: "channel-older", channelName: "random", channelType: "channel",
    lastMessageId: "message-0", latestActivitySeq: "40", doneFrontierSeq: "40", readStateLatestActivitySeq: "40",
    firstUnreadMessageId: null, firstMentionMessageId: null, lastMessageAt: "2026-11-11T09:00:00.000Z",
    lastMessagePreview: "older", lastMessageSenderType: "user", lastMessageSenderId: "user-2", lastMessageSenderName: "alice",
    senderAvatarUrl: null, unreadCount: 0, hasMention: false, ...overrides,
  } as ChannelItem;
}

const GROUPS = [
  { channelId: "channel-older", channelName: "random", channelType: "channel" as const, count: 1, lastActivityAt: "2026-11-11T09:00:00.000Z" },
];

function followedEntry(overrides: Partial<FollowedThread> = {}): FollowedThread {
  return {
    threadChannelId: "thread-244", parentMessageId: "parent-1", parentChannelId: "channel-244", parentChannelName: "general",
    parentChannelType: "channel", parentMessagePreview: "parent", parentMessageSenderType: "user", parentMessageSenderId: "user-2",
    parentInHistory: true, repliesInHistory: true, latestActivitySeq: "50", replyCount: 1, lastReplyAt: "2026-11-11T08:00:00.000Z",
    unreadCount: 1, hasMention: false, firstUnreadMessageId: "reply-1", taskNumber: null, taskStatus: null, taskClaimedByName: null,
    ...overrides,
  };
}

function reply(overrides: Partial<Message> = {}): Message {
  return {
    id: "reply-2", channelId: "thread-244", seq: 51, content: "another reply", senderType: "user", senderId: "user-3", senderName: "bob",
    createdAt: "2026-11-11T10:00:05.000Z",
    conversationContext: { channelType: "thread", parentMessageId: "parent-1", parentChannelId: "channel-244", parentChannelType: "channel" },
    ...overrides,
  } as Message;
}

/** The thread row as the server serves it once it has reply-2 (unread: reply-1 and reply-2). */
function servedThread(overrides: Partial<ThreadItem> = {}): ThreadItem {
  return {
    kind: "thread", threadChannelId: "thread-244", parentMessageId: "parent-1", parentChannelId: "channel-244",
    parentChannelName: "general", parentChannelType: "channel", parentMessagePreview: "parent", parentMessageSenderType: "user",
    parentMessageSenderId: "user-2", latestActivityPreview: "another reply", latestActivitySenderType: "user",
    latestActivitySenderId: "user-3", latestActivitySenderName: "bob", latestActivityMessageId: "reply-2",
    latestActivitySeq: "51", doneFrontierSeq: "51", readStateLatestActivitySeq: "51", replyCount: 2,
    lastActivityAt: "2026-11-11T10:00:05.000Z", lastReplyAt: "2026-11-11T10:00:05.000Z", unreadCount: 2, hasMention: false,
    firstUnreadMessageId: "reply-1", firstMentionMessageId: null, taskNumber: null, taskStatus: null, taskClaimedByName: null,
    isFollowing: true, ...overrides,
  } as unknown as ThreadItem;
}

let served: InboxItem[] = [];
/** A list answer's totals and paging, over the ones computed from `served`. */
let servedList: Record<string, unknown> = {};
let reads: Array<{ ids: string | null; reason: unknown; trigger: unknown; refused: unknown }> = [];
type Trace = { event: string; outcome: string; detail: string; attrs: Record<string, unknown> };
let traces: Trace[] = [];

function serve() {
  api.get = (async (url: string, config?: { params?: { ids?: string }; headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    const ids = config?.params?.ids ?? null;
    reads.push({ ids, reason: config?.headers?.["X-Raft-Fetch-Reason"], trigger: config?.headers?.["X-Raft-Fetch-Trigger"], refused: config?.headers?.["X-Raft-Fetch-Refused"] });
    const wanted = ids ? new Set(ids.split(",")) : null;
    const items = served.filter((item) => !wanted || wanted.has(item.kind === "thread" ? item.threadChannelId : (item as ChannelItem).channelId));
    return {
      headers: {},
      data: {
        items: items.map((item) => ({
          ...item,
          readState: {
            kind: "present", readStateVersion: 1, maxReadSeq: "0",
            latestActivity: { messageId: item.kind === "thread" ? item.latestActivityMessageId : (item as ChannelItem).lastMessageId, seq: (item as ChannelItem).readStateLatestActivitySeq },
          },
        })),
        ...(ids ? {} : {
          totalCount: items.length,
          totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
          activeUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
          hasMore: false,
          ...servedList,
        }),
      },
    };
  }) as typeof api.get;
}

function reset(opts: { flagOn?: boolean; followed?: FollowedThread[]; inbox?: Record<string, unknown>; channels?: unknown[] } = {}) {
  cancelInboxBackgroundRefresh();
  triggerServerReset();
  resetInPlaceDriftForTests();
  resetInboxRowPositionForTests();
  resetServerFeatureFlagsForTests();
  useServerStore.setState({ current: { id: SERVER, slug: "s" } as never, serverEpoch: 1 } as never);
  setServerFeatureFlagForTests(SERVER, INBOX_ROW_POSITION_FLAG_KEY, opts.flagOn ?? true);
  // Another channel is open, so a live reply counts unread.
  useMessageStore.setState({ currentUserId: ME, currentChannelId: "channel-open", unreadCounts: {} });
  useChannelStore.setState({ channels: (opts.channels ?? [{ id: "channel-244", name: "general", type: "channel", description: null, createdAt: "2026-01-01T00:00:00.000Z" }]) as never, dmChannels: [] });
  useThreadStore.setState({ followedThreads: opts.followed ?? [followedEntry()], followOverrides: {}, summaries: {} } as never);
  useInboxStore.setState({
    items: [otherRow()], groups: GROUPS, filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: 1, allCount: 1,
    totalUnreadCount: 0, activeUnreadCount: 0, hasAcceptedWindow: true, savedWindow: false,
    ...opts.inbox,
  });
  served = [];
  servedList = {};
  reads = [];
  traces = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name !== "slock.state.transition") return;
    const a = attrs as { key: { event: string; outcome: string }; meta: { outcomeDetail: string } } & Record<string, unknown>;
    traces.push({ event: a.key.event, outcome: a.key.outcome, detail: a.meta.outcomeDetail, attrs: a });
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
  resetInboxRowPositionForTests();
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

function threadUpdated(latestReply: Message, overrides: Record<string, unknown> = {}) {
  socketHandler("thread:updated")({
    parentMessageId: "parent-1", threadChannelId: "thread-244", replyCount: 2, lastReplyAt: latestReply.createdAt,
    participantIds: ["user-2", "user-3"], latestReply, ...overrides,
  });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(Math.max(INBOX_BACKGROUND_REFRESH_INTERVAL_MS, ROW_REREAD_DELAY_MS) * 2);
}

const threadRows = () => useInboxStore.getState().items.filter((item): item is ThreadItem => item.kind === "thread");
const listReads = () => reads.filter((read) => read.ids === null);
const checks = () => traces.filter((trace) => trace.event === "activity:inplace_check");
const notListed = [{ ids: null, reason: "realtime_fallback", trigger: "thread_reply", refused: "not_listed" }];

test("flag on: a followed thread's reply inserts its row at the top, with no inbox read, noted for the check", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    assert.deepEqual(reads, [], "no list read, no row read");
    const state = useInboxStore.getState();
    assert.equal(state.items.length, 2);
    const row = state.items[0] as ThreadItem;
    assert.equal(row.kind, "thread", "placed above the older row");
    assert.equal(row.threadChannelId, "thread-244");
    assert.equal(row.parentChannelName, "general");
    assert.equal(row.parentMessagePreview, "parent");
    assert.equal(row.latestActivityPreview, "another reply");
    assert.equal(row.latestActivitySenderName, "bob");
    assert.equal(row.latestActivitySeq, "51");
    assert.equal(row.replyCount, 2);
    assert.equal(row.unreadCount, 2, "the entry's unread and this reply");
    assert.equal(row.firstUnreadMessageId, "reply-1");
    assert.equal(row.hasMention, false);
    assert.equal(state.totalCount, 2, "new to the whole list");
    assert.equal(state.allCount, 2);
    assert.equal(state.totalUnreadCount, 2);
    assert.deepEqual(state.groups.map((group) => [group.channelId, group.count]), [["channel-244", 1], ["channel-older", 1]]);
    const inserted = traces.filter((trace) => trace.event === "activity:live_row_inserted");
    assert.equal(inserted.length, 1, "counted once");
    assert.equal(inserted[0]!.attrs["inbox.inplace.reread"], "inserted");
    // The later list answer judges it, as a patched row.
    served = [servedThread(), otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await settle();
    const check = checks().find((trace) => trace.attrs["inbox.inplace.reread"] === "inserted");
    assert.ok(check, "an in-place check of the inserted row");
    assert.equal(check.attrs["inbox.inplace.result"], "match");
    assert.equal(check.attrs["inbox.inplace.row_existed"], "false");
    assert.equal(check.attrs["inbox.inplace.trigger"], "thread_reply");
  } finally { restore(); }
});

test("a later list answer reconciles the inserted row: one row, as served", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    served = [servedThread({ unreadCount: 3, latestActivitySenderName: "Bob B." }), otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await settle();
    const rows = threadRows();
    assert.equal(rows.length, 1, "no duplicate");
    assert.equal(rows[0]!.unreadCount, 3, "the answer at the row's position wins");
    assert.equal(rows[0]!.latestActivitySenderName, "Bob B.");
    const check = checks().find((trace) => trace.attrs["inbox.inplace.reread"] === "inserted");
    assert.equal(check?.attrs["inbox.inplace.result"], "unread", "the drift is reported");
  } finally { restore(); }
});

test("a lagging answer (the thread at its earlier reply) keeps the inserted reply, counted once", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    served = [servedThread({ latestActivityMessageId: "reply-1", latestActivitySeq: "50", doneFrontierSeq: "50", readStateLatestActivitySeq: "50", unreadCount: 1, replyCount: 1, latestActivityPreview: "first", lastActivityAt: "2026-11-11T08:00:00.000Z", lastReplyAt: "2026-11-11T08:00:00.000Z" }), otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await settle();
    const rows = threadRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.latestActivitySeq, "51");
    assert.equal(rows[0]!.unreadCount, 2);
    assert.equal(useInboxStore.getState().items[0]!.kind, "thread", "still at its place by time");
  } finally { restore(); }
});

test("the same reply on message:new after the insert is a repeat: no read", async () => {
  reset();
  try {
    threadUpdated(reply());
    socketHandler("message:new")(reply());
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(threadRows().length, 1);
    assert.equal(threadRows()[0]!.unreadCount, 2, "counted once");
  } finally { restore(); }
});

test("my own reply inserts a read row (the send reads the thread)", async () => {
  reset();
  try {
    threadUpdated(reply({ senderId: ME, senderName: "me" }));
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(threadRows()[0]!.unreadCount, 0);
    assert.equal(threadRows()[0]!.firstUnreadMessageId, null);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally { restore(); }
});

test("a reply that mentions me in a read thread inserts it with its @", async () => {
  reset({ followed: [followedEntry({ unreadCount: 0, firstUnreadMessageId: null })] });
  try {
    threadUpdated(reply({ mentions: [{ type: "user", id: ME }] as Message["mentions"] }));
    await settle();
    assert.deepEqual(reads, []);
    const row = threadRows()[0]!;
    assert.equal(row.unreadCount, 1);
    assert.equal(row.hasMention, true);
    assert.equal(row.firstUnreadMessageId, "reply-2");
    assert.equal(row.firstMentionMessageId, "reply-2");
  } finally { restore(); }
});

test("more rows follow and its group is listed: the totals already count the thread past the window", async () => {
  reset({ inbox: { hasMore: true, totalCount: 40, allCount: 40, totalUnreadCount: 5, activeUnreadCount: 5, groups: [...GROUPS, { channelId: "channel-244", channelName: "general", channelType: "channel", count: 3, lastActivityAt: "2026-11-11T08:00:00.000Z" }] } });
  try {
    threadUpdated(reply());
    await settle();
    assert.deepEqual(reads, []);
    const state = useInboxStore.getState();
    assert.equal(state.totalCount, 40);
    assert.equal(state.totalUnreadCount, 6, "one more: this reply");
    assert.equal(state.groups.find((group) => group.channelId === "channel-244")?.count, 3);
  } finally { restore(); }
});

const fallbacks: Array<[string, () => void, (() => void)?]> = [
  ["not followed here (no entry)", () => reset({ followed: [] })],
  ["unfollowed in this session", () => reset(), () => useThreadStore.setState({ followOverrides: { "parent-1": false } })],
  ["the parent channel not known locally", () => reset({ channels: [] })],
  ["the parent channel archived", () => reset({ channels: [{ id: "channel-244", name: "general", type: "channel", archivedAt: "2026-11-01T00:00:00.000Z" }] })],
  ["the parent behind the history window", () => reset({ followed: [followedEntry({ parentInHistory: false })] })],
  ["no position on the entry", () => reset({ followed: [followedEntry({ latestActivitySeq: null })] })],
  ["an earlier unread mention (its message unknown)", () => reset({ followed: [followedEntry({ hasMention: true })] })],
  ["the Unread filter", () => reset({ inbox: { filter: "unread" } })],
  ["a channel facet", () => reset({ inbox: { channelFilterId: "channel-older" } })],
  ["oldest first", () => reset({ inbox: { sortDirection: "asc" } })],
  ["a read in flight", () => reset({ inbox: { loading: true } })],
  ["the saved page", () => reset({ inbox: { savedWindow: true } })],
  ["the flag on for another server only", () => { reset({ flagOn: false }); setServerFeatureFlagForTests("server-other", INBOX_ROW_POSITION_FLAG_KEY, true); }],
  ["a row past the loaded window", () => reset({ inbox: { hasMore: true, items: [otherRow({ lastMessageAt: "2026-11-11T11:00:00.000Z" })] } })],
  ["a list read already asked for", () => reset(), () => { requestInboxBackgroundRefresh("resume_gap"); reads = []; }],
];

for (const [name, setUp, before] of fallbacks) {
  test(`falls back to the list re-read (not_listed): ${name}`, async () => {
    setUp();
    try {
      before?.();
      threadUpdated(reply());
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(threadRows().length, 0, "no row inserted");
      assert.equal(traces.filter((trace) => trace.event === "activity:live_row_inserted").length, 0);
      if (name !== "a list read already asked for" && name !== "a read in flight") assert.deepEqual(listReads().slice(0, 1), notListed);
    } finally { restore(); }
  });
}

const replyFallbacks: Array<[string, Partial<Message>]> = [
  ["a joint parent", { conversationContext: { channelType: "thread", parentMessageId: "parent-1", parentChannelId: "channel-244", parentChannelType: "joint" } }],
  ["no parent channel in the reply", { conversationContext: { channelType: "thread" } }],
  ["a task conversation", { conversationContext: { channelType: "task", parentChannelId: "channel-244", parentChannelType: "channel" } }],
  ["a system line", { messageType: "system", senderId: "system" }],
  ["my own reply with mentions", { senderId: ME, mentions: [{ type: "user", id: "user-2" }] as Message["mentions"] }],
  ["a reply not newer than the entry", { seq: 50 }],
];

for (const [name, overrides] of replyFallbacks) {
  test(`falls back to the list re-read (not_listed): ${name}`, async () => {
    reset();
    try {
      threadUpdated(reply(overrides));
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(threadRows().length, 0, "no row inserted");
      assert.deepEqual(listReads(), notListed);
    } finally { restore(); }
  });
}

test("a reply gap (the frame's count past the entry's plus one) re-reads, inserting nothing", async () => {
  reset();
  try {
    threadUpdated(reply(), { replyCount: 5 });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(threadRows().length, 0);
    assert.deepEqual(listReads(), notListed);
  } finally { restore(); }
});

test("flag off: unchanged, the list re-reads with not_listed and no row is inserted", async () => {
  reset({ flagOn: false });
  try {
    threadUpdated(reply());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(threadRows().length, 0);
    assert.deepEqual(listReads(), notListed);
    assert.equal(traces.filter((trace) => trace.event === "activity:live_row_inserted").length, 0);
  } finally { restore(); }
});

test("buildInsertedThreadRow / insertedRowIndex (pure)", () => {
  const live = { trigger: "thread_reply" as const, counts: true, mention: false, loaded: false, event: "thread:updated" as const, open: false };
  const parent = { id: "channel-244", name: "general", type: "channel" };
  const frame = { parentMessageId: "parent-1", threadChannelId: "thread-244", replyCount: 2, latestReply: reply() };
  const built = buildInsertedThreadRow({ frame, live, followed: followedEntry(), parent, viewerId: ME });
  assert.ok(!("refused" in built));
  assert.deepEqual(built.state, { unreadCount: 2, hasMention: false, mentionOnly: false, position: "50", applied: [{ seq: "51", counts: true, mention: false }], inversionObserved: false });
  assert.deepEqual(buildInsertedThreadRow({ frame: { ...frame, latestReply: reply({ seq: undefined }) }, live, followed: followedEntry(), parent, viewerId: ME }), { refused: "no_seq" });
  assert.deepEqual(buildInsertedThreadRow({ frame, live: { ...live, loaded: true }, followed: followedEntry(), parent, viewerId: ME }), { refused: "loaded" });
  assert.deepEqual(buildInsertedThreadRow({ frame, live: { ...live, counts: false }, followed: followedEntry(), parent, viewerId: ME }), { refused: "unread_unknown" }, "read on arrival over unread replies");
  assert.deepEqual(buildInsertedThreadRow({ frame, live, followed: followedEntry({ unreadCount: 2, firstUnreadMessageId: null }), parent, viewerId: ME }), { refused: "unread_unknown" });
  const older = otherRow();
  assert.equal(insertedRowIndex([older], built.row, true), 0);
  assert.equal(insertedRowIndex([otherRow({ lastMessageAt: "2026-11-12T00:00:00.000Z" })], built.row, false), 1);
  assert.equal(insertedRowIndex([otherRow({ lastMessageAt: "2026-11-12T00:00:00.000Z" })], built.row, true), null);
});

test("a row re-read of the inserted row judges it as inserted (scope=row)", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    // An older reply this client never applied: the rule re-reads that one row.
    served = [servedThread(), otherRow()];
    socketHandler("message:new")(reply({ id: "reply-x", seq: 50 }));
    await settle();
    assert.deepEqual(reads.map((read) => [read.ids, read.reason]), [["thread-244", "position_reread"]], "the row, never the list");
    const check = checks().find((trace) => trace.attrs["inbox.inplace.scope"] === "row");
    assert.equal(check?.attrs["inbox.inplace.reread"], "inserted");
    assert.equal(check?.attrs["inbox.inplace.result"], "match");
  } finally { restore(); }
});

// Review of #15286 (1): a first-window answer that does not have the inserted row yet (the read model lags).
test("a first-window answer without the inserted row keeps it once, with its unread, and re-reads the row", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    served = [otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(threadRows().length, 1, "kept");
    assert.equal(useInboxStore.getState().items[0]!.kind, "thread", "at its place by time");
    assert.equal(useInboxStore.getState().totalUnreadCount, 2, "the answer's 0 plus the kept row's 2");
    // The view has caught up by the row read.
    served = [servedThread(), otherRow()];
    await settle();
    assert.deepEqual(reads.map((read) => [read.ids, read.reason, read.trigger]), [
      [null, "realtime_fallback", "resume_gap"],
      ["thread-244", "position_reread", "catch_up_retry"],
    ]);
    assert.equal(threadRows().length, 1, "no duplicate");
    assert.equal(threadRows()[0]!.unreadCount, 2);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally { restore(); }
});

test("an inserted row the server never lists: its row read re-reads the list, and that answer wins", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    served = [otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await settle();
    await settle();
    assert.deepEqual(reads.map((read) => [read.ids, read.trigger]), [[null, "resume_gap"], ["thread-244", "catch_up_retry"], [null, "row_missing"]], "bounded: one row read, one list read");
    assert.equal(threadRows().length, 0, "gone once a second answer leaves it out");
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally { restore(); }
});

test("more rows follow and its group is not listed: new to the list, the full +1", async () => {
  reset({ inbox: { hasMore: true, totalCount: 40, allCount: 40, totalUnreadCount: 5, activeUnreadCount: 5 } });
  try {
    threadUpdated(reply());
    await settle();
    assert.deepEqual(reads, []);
    const state = useInboxStore.getState();
    assert.equal(state.totalCount, 41);
    assert.equal(state.allCount, 41);
    assert.equal(state.totalUnreadCount, 7, "its whole unread");
    assert.equal(state.groups.find((group) => group.channelId === "channel-244")?.count, 1);
  } finally { restore(); }
});

// Review of #15286 (3): the local holds.
const holds: Array<[string, () => Promise<void> | void]> = [
  ["a local Done hold", async () => {
    useInboxStore.setState({ items: [servedThread({ latestActivityMessageId: "reply-1", latestActivitySeq: "50", doneFrontierSeq: "50", readStateLatestActivitySeq: "50", unreadCount: 1, replyCount: 1, lastActivityAt: "2026-11-11T08:00:00.000Z" }), otherRow()] });
    await useInboxStore.getState().markDone(useInboxStore.getState().items[0]!);
  }],
  ["a local read hold", async () => {
    const row = servedThread({ latestActivityMessageId: "reply-1", latestActivitySeq: "50", doneFrontierSeq: "50", readStateLatestActivitySeq: "50", unreadCount: 1, replyCount: 1, lastActivityAt: "2026-11-11T08:00:00.000Z" });
    useInboxStore.setState({ items: [row, otherRow()] });
    await useInboxStore.getState().markRead(row);
    // The row leaves the loaded list (another answer), the read hold stays.
    useInboxStore.setState({ items: [otherRow()] });
  }],
  ["a Mark as Unread", () => setScopeMarkedUnread("thread-244", true)],
];

for (const [name, hold] of holds) {
  test(`falls back to the list re-read (not_listed): ${name}`, async () => {
    reset();
    try {
      await hold();
      served = [otherRow()];
      await settle();
      useThreadStore.setState({ followedThreads: [followedEntry()], followOverrides: {} } as never);
      reads = [];
      threadUpdated(reply());
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(threadRows().length, 0, "no row inserted");
      assert.deepEqual(listReads(), notListed);
    } finally { setScopeMarkedUnread("thread-244", false); restore(); }
  });
}

test("falls back to the list re-read (not_listed): the thread's loaded messages already set its unread (live.loaded)", async () => {
  reset();
  try {
    setCurrentPrincipalId(ME);
    consumeReadStateUpdate({ serverId: SERVER, scopeId: "thread-244", maxReadSeq: 50, readStateVersion: 9 });
    useMessageStore.setState((state) => ({
      channelMessages: { ...state.channelMessages, "thread-244": [reply({ id: "reply-1", seq: 50 }), reply()] },
      channelWindowMeta: { ...state.channelWindowMeta, "thread-244": { hasNewer: false, hasOlder: true, loading: false } as never },
    }));
    assert.equal(liveActivityUnread(reply(), "thread_reply").loaded, true, "the case under test");
    threadUpdated(reply());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(threadRows().length, 0, "no row inserted");
    assert.deepEqual(listReads(), notListed);
  } finally { setCurrentPrincipalId(null); restore(); }
});

// Re-review of #15286 (1): with more rows to follow, the loaded tail carries the row the answer left out.
for (const groupListed of [true, false]) {
  test(`more rows, tail preserved (group ${groupListed ? "listed" : "not listed"}): the lagging answer keeps the inserted row at the top, its unread in the badge, and re-reads it`, async () => {
    const group = { channelId: "channel-244", channelName: "general", channelType: "channel" as const, count: 3, lastActivityAt: "2026-11-11T08:00:00.000Z" };
    reset({ inbox: { hasMore: true, totalCount: 40, allCount: 40, totalUnreadCount: 5, activeUnreadCount: 5, groups: groupListed ? [...GROUPS, group] : GROUPS } });
    try {
      threadUpdated(reply());
      await settle();
      const badge = useInboxStore.getState().totalUnreadCount;
      assert.equal(badge, groupListed ? 6 : 7);
      // The view does not have the reply yet: the server's totals are as before the insert.
      served = [otherRow()];
      servedList = { hasMore: true, totalCount: 40, totalUnreadCount: 5, activeUnreadCount: 5 };
      requestInboxBackgroundRefresh("resume_gap");
      await vi.advanceTimersByTimeAsync(0);
      const state = useInboxStore.getState();
      assert.equal(state.items[0]!.kind, "thread", "at its place by time, not at the tail");
      assert.equal(threadRows().length, 1);
      assert.equal(state.totalUnreadCount, badge, "its unread stays in the badge");
      served = [servedThread(), otherRow()];
      await settle();
      assert.ok(reads.some((read) => read.ids === "thread-244" && read.trigger === "catch_up_retry"), "the row is re-read");
    } finally { restore(); }
  });
}

// Re-review of #15286 (4): a load-more page never has the inserted row; it keeps nothing and spends no keep.
test("a load-more page without the inserted row leaves the badge at the server's total, re-reads nothing, and a later lagging first window still keeps the row", async () => {
  reset({ inbox: { hasMore: true, totalCount: 40, allCount: 40, totalUnreadCount: 5, activeUnreadCount: 5 } });
  try {
    threadUpdated(reply());
    await settle();
    assert.equal(threadRows().length, 1);
    // Page 2: the read model has caught up, its totals count the reply.
    served = [otherRow({ channelId: "channel-page-2", lastMessageAt: "2026-11-11T07:00:00.000Z" })];
    servedList = { hasMore: false, totalCount: 41, totalUnreadCount: 7, activeUnreadCount: 7 };
    await useInboxStore.getState().loadInbox();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 7, "the server's total, no keep delta on top");
    assert.equal(threadRows().length, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    assert.ok(!reads.some((read) => read.trigger === "catch_up_retry"), "no row re-read");
    // A lagging first window afterwards still keeps the row once.
    served = [otherRow()];
    servedList = { hasMore: true, totalCount: 40, totalUnreadCount: 5, activeUnreadCount: 5 };
    requestInboxBackgroundRefresh("resume_gap");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(threadRows().length, 1, "kept by the first window");
    assert.equal(useInboxStore.getState().items[0]!.kind, "thread");
  } finally { restore(); }
});

// Re-review of #15286 (2): a later reply moved the inserted row on before the lagging answer.
test("a row a second reply moved on is still kept through a lagging answer", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    threadUpdated(reply({ id: "reply-3", seq: 52, content: "third", createdAt: "2026-11-11T10:00:09.000Z" }), { replyCount: 3 });
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(threadRows()[0]!.latestActivitySeq, "52");
    assert.equal(threadRows()[0]!.unreadCount, 3);
    served = [otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(threadRows().length, 1, "kept");
    assert.equal(threadRows()[0]!.latestActivitySeq, "52");
    assert.equal(useInboxStore.getState().totalUnreadCount, 3);
  } finally { restore(); }
});

// Re-review of #15286 (3): past the 90 s stale-list bound, an answer without the row wins.
test("past 90 s, an answer without the inserted row drops it and re-reads nothing", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    vi.setSystemTime(Date.now() + 91_000);
    served = [otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await settle();
    assert.equal(threadRows().length, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    assert.ok(!reads.some((read) => read.trigger === "catch_up_retry"), "no row read");
  } finally { restore(); }
});
