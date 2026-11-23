/**
 * #244 (inbox_row_position_v1): a `thread:updated` for a thread this person
 * does not follow, that the loaded Activity list does not show and that the
 * reply cannot list (inboxUnfollowedThreadReply.ts), sends no list re-read;
 * the summary and followed-list updates still happen. Each case where the
 * server could list it, an unknown follow state, a followed thread (#15286)
 * and flag off re-read as before (`X-Raft-Fetch-Refused: not_listed`).
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
const { threadReplyMayListUnfollowed, resetUnfollowedThreadReplyForTests } = await import("../src/store/inboxUnfollowedThreadReply");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useThreadStore } = await import("../src/store/threadStore");
const { buildMainLayoutSocketBindings, __cancelFollowedThreadsRefreshForTests } = await import("../src/store/socketBridge");
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
let followedServed: FollowedThread[] = [];
let followedReads = 0;
let reads: Array<{ ids: string | null; reason: unknown; trigger: unknown; refused: unknown }> = [];
type Trace = { event: string; outcome: string; detail: string; attrs: Record<string, unknown> };
let traces: Trace[] = [];

function serve() {
  api.get = (async (url: string, config?: { params?: { ids?: string }; headers?: Record<string, string> }) => {
    if (url === "/channels/threads/followed") { followedReads += 1; return { data: { threads: followedServed }, headers: {} }; }
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
        }),
      },
    };
  }) as typeof api.get;
}

/** The parent message, loaded in its channel, by user-2 unless said. */
function parentMessage(overrides: Partial<Message> = {}): Message {
  return { id: "parent-1", channelId: "channel-244", seq: 10, content: "parent", senderType: "user", senderId: "user-2", senderName: "alice", createdAt: "2026-11-11T07:00:00.000Z", ...overrides } as Message;
}

/** The thread's summary as the channel load served it: not followed. */
function summary(followed: boolean | null = false) {
  return { "parent-1": { threadChannelId: "thread-244", replyCount: 1, lastReplyAt: "2026-11-11T08:00:00.000Z", participantIds: ["user-2"], unreadCount: 0, firstUnreadMessageId: null, ...(followed === null ? {} : { followed }) } };
}

function reset(opts: { flagOn?: boolean; followed?: FollowedThread[]; inbox?: Record<string, unknown>; channels?: unknown[]; summaries?: Record<string, unknown>; parent?: Message | null } = {}) {
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
  resetUnfollowedThreadReplyForTests();
  __cancelFollowedThreadsRefreshForTests();
  useThreadStore.setState({ followedThreads: opts.followed ?? [], followOverrides: {}, summaries: opts.summaries ?? summary() } as never);
  const parent = opts.parent === undefined ? parentMessage() : opts.parent;
  useMessageStore.setState({ channelMessages: parent ? { "channel-244": [parent] } : {} } as never);
  useInboxStore.setState({
    items: [otherRow()], groups: GROUPS, filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: 1, allCount: 1,
    totalUnreadCount: 0, activeUnreadCount: 0, hasAcceptedWindow: true, savedWindow: false,
    ...opts.inbox,
  });
  served = [];
  followedServed = [];
  followedReads = 0;
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
  resetUnfollowedThreadReplyForTests();
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
const skips = () => traces.filter((trace) => trace.event === "activity:unfollowed_reread_skipped");

test("an unfollowed thread's reply the list cannot show: no inbox read, the other updates still applied", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    assert.deepEqual(reads, [], "no list read, no row read");
    assert.equal(threadRows().length, 0, "nothing inserted");
    const updated = useThreadStore.getState().summaries["parent-1"]!;
    assert.equal(updated.replyCount, 2, "the summary is updated");
    assert.equal(updated.lastReplyAt, reply().createdAt);
    assert.equal(updated.followed, false, "its follow state kept");
    assert.equal(followedReads, 1, "the followed-thread list still reloads");
    assert.equal(skips().length, 1, "the skip is counted");
    assert.match(skips()[0]!.detail, /trigger=thread_reply;follow=not_followed;filter=all;complete=1/);
    assert.equal(skips()[0]!.attrs["inbox.inplace.reread"], "unfollowed");
  } finally { restore(); }
});

test("Unread filter with more pages: no overlay there, still skipped", async () => {
  reset({ inbox: { filter: "unread", hasMore: true } });
  try {
    threadUpdated(reply());
    await settle();
    assert.deepEqual(listReads(), []);
    assert.equal(skips().length, 1);
  } finally { restore(); }
});

const keeps: Array<[string, () => void, Partial<Message>?]> = [
  ["my own reply (replied follow)", () => reset(), { senderId: ME }],
  ["a reply that mentions me (mention follow)", () => reset(), { mentions: [{ type: "user", id: ME, name: "me" }] as Message["mentions"] }],
  ["I authored the parent (authored follow)", () => reset({ parent: parentMessage({ senderId: ME }) })],
  ["the parent not loaded here", () => reset({ parent: null })],
  ["a system line", () => reset(), { messageType: "system", senderId: "system" }],
  ["a joint parent", () => reset(), { conversationContext: { channelType: "thread", parentMessageId: "parent-1", parentChannelId: "channel-244", parentChannelType: "joint" } }],
  ["All with more pages (an unfollowed-overlay row may be past the window)", () => reset({ inbox: { hasMore: true } })],
  ["unfollowed in this session (an overlay row)", () => { reset(); useThreadStore.setState({ followOverrides: { "parent-1": false } }); }],
  ["follow state unknown (no served followed)", () => reset({ summaries: summary(null) })],
  ["follow state unknown (no summary)", () => reset({ summaries: {} })],
  ["the list not settled (a read in flight)", () => reset({ inbox: { loading: true } })],
  ["the saved page", () => reset({ inbox: { savedWindow: true } })],
  ["flag off", () => reset({ flagOn: false })],
  ["the flag on for another server only", () => { reset({ flagOn: false }); setServerFeatureFlagForTests("server-other", INBOX_ROW_POSITION_FLAG_KEY, true); }],
];

for (const [name, setUp, overrides] of keeps) {
  test(`keeps the list re-read (not_listed): ${name}`, async () => {
    setUp();
    try {
      threadUpdated(reply(overrides));
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(skips().length, 0, "not skipped");
      if (name !== "the list not settled (a read in flight)") assert.deepEqual(listReads(), notListed);
    } finally { restore(); }
  });
}

test("a followed thread: unchanged, #15286 inserts its row with no read", async () => {
  reset({ followed: [followedEntry()], summaries: summary(true) });
  try {
    threadUpdated(reply());
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(threadRows().length, 1, "inserted");
    assert.equal(skips().length, 0);
  } finally { restore(); }
});

test("a followed thread #15286 cannot insert: unchanged, it re-reads", async () => {
  reset({ followed: [followedEntry({ latestActivitySeq: null })], summaries: summary(true) });
  try {
    threadUpdated(reply());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(listReads(), notListed);
    assert.equal(skips().length, 0);
  } finally { restore(); }
});

test("a skipped thread the followed-thread list then names (a follow this client missed) re-reads then", async () => {
  reset();
  followedServed = [followedEntry()];
  try {
    threadUpdated(reply());
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(listReads(), [], "skipped at first");
    await settle();
    assert.equal(followedReads, 1);
    assert.deepEqual(listReads(), notListed, "the followed list said followed: re-read");
    assert.equal(traces.filter((trace) => trace.event === "activity:unfollowed_reread_recovered").length, 1);
  } finally { restore(); }
});

test("a later list answer that shows a skipped thread is a conflict (reread=unfollowed, appeared)", async () => {
  reset();
  try {
    threadUpdated(reply());
    await settle();
    served = [servedThread({ isFollowing: false, unreadCount: 0 } as Partial<ThreadItem>), otherRow()];
    requestInboxBackgroundRefresh("resume_gap");
    await settle();
    const check = checks().find((trace) => trace.attrs["inbox.inplace.reread"] === "unfollowed");
    assert.equal(check?.outcome, "conflict");
    assert.equal(check?.attrs["inbox.inplace.result"], "appeared");
  } finally { restore(); }
});

test("threadReplyMayListUnfollowed (pure)", () => {
  const base = {
    viewerId: ME, reply: reply(), follow: "not_followed" as const, parent: parentMessage(), filter: "all" as const, listComplete: true,
  };
  assert.equal(threadReplyMayListUnfollowed(base), null);
  assert.equal(threadReplyMayListUnfollowed({ ...base, viewerId: null }), "follow_unknown");
  assert.equal(threadReplyMayListUnfollowed({ ...base, follow: "unknown" }), "follow_unknown");
  assert.equal(threadReplyMayListUnfollowed({ ...base, follow: "followed" }), "followed");
  assert.equal(threadReplyMayListUnfollowed({ ...base, reply: reply({ conversationContext: { channelType: "thread", parentChannelType: "joint" } } as Partial<Message>) }), "joint");
  assert.equal(threadReplyMayListUnfollowed({ ...base, reply: reply({ messageType: "system" }) }), "system");
  assert.equal(threadReplyMayListUnfollowed({ ...base, reply: reply({ senderId: ME }) }), "own_reply");
  assert.equal(threadReplyMayListUnfollowed({ ...base, reply: reply({ mentions: [{ type: "user", id: ME, name: "me" }] }) }), "mentioned");
  assert.equal(threadReplyMayListUnfollowed({ ...base, reply: reply({ mentions: [{ type: "user", id: "user-9", name: "x" }] }) }), null, "another's mention");
  assert.equal(threadReplyMayListUnfollowed({ ...base, parent: undefined }), "parent_unknown");
  assert.equal(threadReplyMayListUnfollowed({ ...base, parent: parentMessage({ senderId: ME }) }), "authored");
  assert.equal(threadReplyMayListUnfollowed({ ...base, parent: parentMessage({ senderId: ME, messageType: "system" }) }), null, "a system parent has no author follow");
  assert.equal(threadReplyMayListUnfollowed({ ...base, listComplete: false }), "overlay");
  assert.equal(threadReplyMayListUnfollowed({ ...base, follow: "unfollowed_here" }), "overlay");
  assert.equal(threadReplyMayListUnfollowed({ ...base, follow: "unfollowed_here", filter: "unread" }), null, "no overlay off All");
  assert.equal(threadReplyMayListUnfollowed({ ...base, listComplete: false, filter: "mentions" }), null);
  for (const parentChannelType of ["private", "dm"]) {
    assert.equal(threadReplyMayListUnfollowed({ ...base, reply: reply({ conversationContext: { channelType: "thread", parentMessageId: "parent-1", parentChannelId: "channel-244", parentChannelType } } as Partial<Message>) }), null, parentChannelType);
  }
});
