/**
 * #244 step 3a (inbox_read_inplace_v1, default off): a persisted read of a row
 * Activity already lists, still showing the read, sends no re-read; its row is
 * still judged by the next first-window read (`inbox.inplace.reread`).
 * A read of an unlisted row, live messages and thread replies re-read as
 * before, and with the flag off every persisted read re-reads.
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
const { applyMessageChannelActivity } = await import("../src/store/channelRealtimeSync");
const { notifyChannelReadLocally, notifyChannelReadPersistedLocally } = await import("../src/store/readStateSync");
const { getCurrentPrincipalId } = await import("../src/store/principalRuntime");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { INBOX_READ_INPLACE_FLAG_KEY, resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } = await import("../src/store/serverFeatureFlags");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { useThreadStore } = await import("../src/store/threadStore");
const { default: api } = await import("../src/api/client");

const SERVER = "server-244";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

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
  return { ...base, doneFrontierSeq: base.latestActivitySeq, readStateLatestActivitySeq: base.latestActivitySeq } as ChannelItem;
}

let served: ChannelItem[] = [];
let reads: Array<{ reason: unknown; trigger: unknown }> = [];
let hold: Promise<void> | null = null;
type Trace = { outcome: string; detail: string; attrs: Record<string, unknown> };
let traces: Trace[] = [];

function serve() {
  api.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    reads.push({ reason: config?.headers?.["X-Raft-Fetch-Reason"], trigger: config?.headers?.["X-Raft-Fetch-Trigger"] });
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

function reset(items: InboxItem[], flagOn: boolean) {
  cancelInboxBackgroundRefresh();
  triggerServerReset();
  resetInPlaceDriftForTests();
  resetServerFeatureFlagsForTests();
  useServerStore.setState({ current: { id: SERVER } as never, serverEpoch: 1 } as never);
  setServerFeatureFlagForTests(SERVER, INBOX_READ_INPLACE_FLAG_KEY, flagOn);
  useInboxStore.setState({
    items, groups: [], filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: items.length,
    totalUnreadCount: 2, activeUnreadCount: 2, hasAcceptedWindow: true, savedWindow: false,
  });
  served = [];
  reads = [];
  hold = null;
  traces = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name !== "slock.state.transition") return;
    const a = attrs as { key: { event: string; outcome: string }; meta: { outcomeDetail: string } } & Record<string, unknown>;
    if (a.key.event === "activity:inplace_check") traces.push({ outcome: a.key.outcome, detail: a.meta.outcomeDetail, attrs: a });
  });
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

/** The two notifications a thread read sends (threadStore clearThreadUnread): cleared here, then persisted. */
function readAndPersist(channelId = "channel-244") {
  notifyChannelReadLocally(channelId);
  notifyChannelReadPersistedLocally({ channelId, serverId: SERVER, serverEpoch: 1, principalId: getCurrentPrincipalId() });
}

function liveMessage(): Message {
  return {
    id: "message-9", channelId: "channel-other", seq: 9, content: "hi", senderType: "user",
    senderId: "user-2", senderName: "alice", createdAt: "2026-11-11T10:00:05.000Z",
  } as Message;
}

test("flag off: a persisted read of a listed row re-reads, as before", async () => {
  reset([channelRow()], false);
  try {
    served = [channelRow({ unreadCount: 0, firstUnreadMessageId: null })];
    readAndPersist();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 0, "the read cleared the row here");
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "read_persisted" }]);
    // The same kind of read the flag would skip, judged by its own re-read: the baseline.
    assert.equal(traces.length, 1);
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "eligible_sent");
    assert.match(traces[0].detail, /;reread=eligible_sent(;|$)/);
  } finally { restore(); }
});

test("flag on: a persisted read of a listed row sends no re-read; the next read judges it as skipped", async () => {
  reset([channelRow()], true);
  try {
    readAndPersist();
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 2);
    assert.deepEqual(reads, [], "no GET /channels/inbox for the read");
    const row = useInboxStore.getState().items[0];
    assert.equal(row.unreadCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0, "the in-place read is the result");

    // A later event's re-read judges the row the read left (one noop in 20 is sent: the first).
    served = [channelRow({ unreadCount: 0, firstUnreadMessageId: null })];
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "message_new" }]);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "read_persisted");
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "skipped");
    assert.match(traces[0].detail, /^trigger=read_persisted;existed=1;result=match;.*;reread=skipped(;|$)/);
  } finally { restore(); }
});

test("flag on: a skipped read the server disagrees with is still recorded as drift", async () => {
  reset([channelRow()], true);
  try {
    readAndPersist();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, []);
    served = [channelRow({ unreadCount: 1 })];
    requestInboxBackgroundRefresh("thread_reply");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "conflict");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "unread");
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "skipped");
  } finally { restore(); }
});

test("flag on: a persisted read of a row the list does not show still re-reads", async () => {
  reset([channelRow()], true);
  try {
    readAndPersist("channel-unlisted");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "read_persisted" }]);
  } finally { restore(); }
});

test("flag on: under the Unread filter the read row leaves the list, so its persisted read re-reads", async () => {
  reset([channelRow()], true);
  useInboxStore.setState({ filter: "unread" });
  try {
    readAndPersist();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(useInboxStore.getState().items.length, 0);
    // A filtered re-read also asks for the unfiltered count: both carry the trigger.
    assert.ok(reads.length > 0);
    assert.ok(reads.every((read) => read.reason === "realtime_fallback" && read.trigger === "read_persisted"));
  } finally { restore(); }
});

test("flag on: a listed row showing unread again (a reply after the read) re-reads", async () => {
  reset([channelRow()], true);
  try {
    // Persisted without the local clear, the row still shows unread.
    notifyChannelReadPersistedLocally({ channelId: "channel-244", serverId: SERVER, serverEpoch: 1, principalId: getCurrentPrincipalId() });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "read_persisted" }]);
  } finally { restore(); }
});

test("flag on: a persisted read while an Activity read is in flight still re-reads after it", async () => {
  reset([channelRow()], true);
  let release: () => void = () => undefined;
  hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const inFlight = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "reconnect" });
    await vi.advanceTimersByTimeAsync(0);
    readAndPersist();
    hold = null;
    release();
    await inFlight;
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    assert.deepEqual(reads, [
      { reason: "reconnect", trigger: undefined },
      { reason: "realtime_fallback", trigger: "read_persisted" },
    ]);
  } finally { restore(); }
});

test("flag on: the saved page from the last session (no window accepted yet) still re-reads", async () => {
  reset([channelRow({ unreadCount: 0, firstUnreadMessageId: null })], true);
  useInboxStore.setState({ hasAcceptedWindow: false, savedWindow: true });
  try {
    notifyChannelReadPersistedLocally({ channelId: "channel-244", serverId: SERVER, serverEpoch: 1, principalId: getCurrentPrincipalId() });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [{ reason: "realtime_fallback", trigger: "read_persisted" }]);
  } finally { restore(); }
});

test("flag on: reading a listed thread (threadStore clearThreadUnread) clears its row with no re-read", async () => {
  const thread = {
    kind: "thread",
    threadChannelId: "thread-244",
    parentMessageId: "parent-1",
    parentChannelId: "channel-244",
    latestActivityMessageId: "reply-1",
    latestActivitySeq: "50",
    replyCount: 1,
    unreadCount: 2,
    hasMention: true,
    firstUnreadMessageId: "reply-1",
    firstMentionMessageId: "reply-1",
    lastActivityAt: "2026-11-11T10:00:00.000Z",
    lastReplyAt: "2026-11-11T10:00:00.000Z",
  } as unknown as InboxItem;
  for (const flagOn of [false, true]) {
    reset([thread], flagOn);
    served = [{ ...thread, unreadCount: 0, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null } as unknown as ChannelItem];
    const posted: string[] = [];
    api.post = (async (url: string) => { posted.push(url); return { data: {}, headers: {} }; }) as typeof api.post;
    try {
      useThreadStore.getState().clearThreadUnread("thread-244");
      await vi.advanceTimersByTimeAsync(0);
      assert.deepEqual(posted, ["/channels/thread-244/read-all"]);
      const row = useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>;
      assert.equal(row.unreadCount, 0);
      assert.equal(row.hasMention, false);
      assert.deepEqual(reads, flagOn ? [] : [{ reason: "realtime_fallback", trigger: "read_persisted" }], `flag ${flagOn ? "on" : "off"}`);
    } finally { restore(); }
  }
});

test("flag on: live messages and thread replies still re-read", async () => {
  reset([channelRow()], true);
  try {
    applyMessageChannelActivity(liveMessage(), requestInboxBackgroundRefresh, "message_new");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    requestInboxBackgroundRefresh("thread_reply");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [
      { reason: "realtime_fallback", trigger: "message_new" },
      { reason: "realtime_fallback", trigger: "thread_reply" },
    ]);
  } finally { restore(); }
});
