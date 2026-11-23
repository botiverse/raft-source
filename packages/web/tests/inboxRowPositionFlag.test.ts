/**
 * #244 step 2 (inbox_row_position_v1, default off): each listed Activity row
 * follows the per-row position rule (shared reduceActivityRow /
 * activityLiveUnread, store/inboxRowPosition.ts). A live message in order
 * re-reads nothing; one at or below the row's delivered position that this
 * client had not applied re-reads that one row (`?ids=`, trigger
 * ambiguous_seq), never the list; at most one row read is in flight per row,
 * rows waiting go in one read; an answer older than the row leaves it; the
 * drift check carries the answer's X-Raft-Inbox-Backend unchanged. Flag off:
 * the list re-reads as before.
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
const { AUDIT_FOLLOWUP_DELAY_MS, POSITION_AUDIT_EVERY, ROW_REREAD_DELAY_MS, resetInboxRowPositionForTests } = await import("../src/store/inboxRowPosition");
const { consumeReadStateSnapshot, consumeReadStateUpdate, notifyChannelReadLocally, notifyChannelReadPersistedLocally } = await import("../src/store/readStateSync");
const { applyReadStateUpdate } = await import("../src/store/applyReadStateUpdate");
const { getCurrentPrincipalId, setCurrentPrincipalId } = await import("../src/store/principalRuntime");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { acceptActivityReadAllAck } = await import("../src/store/activityReadState");
const { useMessageStore } = await import("../src/store/messageStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { INBOX_ROW_POSITION_FLAG_KEY, resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } = await import("../src/store/serverFeatureFlags");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { default: api } = await import("../src/api/client");

const SERVER = "server-244";
const ME = "user-me";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

function channelRow(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel",
    channelId: "channel-a",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-100",
    latestActivitySeq: "100",
    firstUnreadMessageId: "message-99",
    firstMentionMessageId: null,
    lastMessageAt: "2026-11-14T10:00:00.000Z",
    lastMessagePreview: "m100",
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

const rowB = (overrides: Partial<ChannelItem> = {}) => channelRow({
  channelId: "channel-b", channelName: "random", lastMessageId: "message-b50", latestActivitySeq: "50",
  lastMessageAt: "2026-11-14T09:00:00.000Z", unreadCount: 1, ...overrides,
});

/** Channel A as served once it has message `seq` (the newest) and `unread` unread. */
function servedA(seq: number, unread: number): ChannelItem {
  return channelRow({
    lastMessageId: `message-${seq}`, latestActivitySeq: String(seq), lastMessageAt: `2026-11-14T10:00:${String(seq - 90).padStart(2, "0")}.000Z`,
    lastMessagePreview: `m${seq}`, unreadCount: unread,
  });
}

type Read = { ids: string | null; reason: unknown; trigger: unknown; coalesced: unknown };
let served: InboxItem[] = [];
let reads: Read[] = [];
let hold: Promise<void> | null = null;
let traces: Array<{ outcome: string; detail: string; attrs: Record<string, unknown> }> = [];

/** The read state every served row carries (a test sets it to answer at the ledger's read). */
let servedRead: { readStateVersion: number; maxReadSeq: string } | null = { readStateVersion: 1, maxReadSeq: "0" };

function wire(item: InboxItem) {
  const row = item as ChannelItem;
  if (!servedRead) return row;
  return {
    ...row,
    readState: {
      kind: "present", ...servedRead,
      latestActivity: { messageId: row.lastMessageId, seq: row.readStateLatestActivitySeq },
    },
  };
}

function serve() {
  api.get = (async (url: string, config?: { params?: { ids?: string }; headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    const ids = config?.params?.ids ?? null;
    reads.push({ ids, reason: config?.headers?.["X-Raft-Fetch-Reason"], trigger: config?.headers?.["X-Raft-Fetch-Trigger"], coalesced: config?.headers?.["X-Raft-Fetch-Coalesced"] });
    if (hold) await hold;
    const headers = { "x-raft-inbox-backend": "risingwave" };
    if (ids) {
      const wanted = new Set(ids.split(","));
      return { headers, data: { items: served.filter((item) => wanted.has((item as ChannelItem).channelId)).map(wire) } };
    }
    return {
      headers,
      data: {
        items: served.map(wire),
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
  resetInboxRowPositionForTests();
  resetServerFeatureFlagsForTests();
  useServerStore.setState({ current: { id: SERVER, slug: "s" } as never, serverEpoch: 1 } as never);
  setServerFeatureFlagForTests(SERVER, INBOX_ROW_POSITION_FLAG_KEY, flagOn);
  // Another channel is open, so a live message counts unread.
  useMessageStore.setState({ currentUserId: ME, currentChannelId: "channel-open", unreadCounts: {} });
  useInboxStore.setState({
    items, groups: [], filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: items.length,
    totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    activeUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    hasAcceptedWindow: true, savedWindow: false,
  });
  served = [];
  servedRead = { readStateVersion: 1, maxReadSeq: "0" };
  reads = [];
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

function message(seq: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `message-${seq}`, channelId: "channel-a", seq, content: `m${seq}`, senderType: "user",
    senderId: "user-3", senderName: "bob", createdAt: `2026-11-14T10:00:${String(seq - 90).padStart(2, "0")}.000Z`, ...overrides,
  } as Message;
}

function rowA(): ChannelItem {
  return useInboxStore.getState().items.find((item) => (item as ChannelItem).channelId === "channel-a") as ChannelItem;
}

/** Past the list throttle and the row re-read delay. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(Math.max(INBOX_BACKGROUND_REFRESH_INTERVAL_MS, ROW_REREAD_DELAY_MS) * 2);
}

const listRead = (trigger: string) => ({ ids: null, reason: "realtime_fallback", trigger, coalesced: "1" });

test("flag off: a live message on a listed row re-reads the list, as before", async () => {
  reset([channelRow(), rowB()], false);
  try {
    served = [servedA(101, 3), rowB()];
    socketHandler("message:new")(message(101));
    await settle();
    assert.deepEqual(reads, [listRead("message_new")]);
  } finally { restore(); }
});

test("flag on: live messages in order re-read nothing, and the answer after them is taken with nothing re-read (in_order_live_before_answer)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    socketHandler("message:new")(message(101));
    socketHandler("message:new")(message(102));
    await settle();
    assert.deepEqual(reads, [], "no list read, no row read");
    const row = rowA();
    assert.equal(row.unreadCount, 4);
    assert.equal(row.latestActivitySeq, "102");
    assert.equal(row.lastMessagePreview, "m102");
    assert.equal(useInboxStore.getState().items[0], row, "moved to the top");
    assert.equal(useInboxStore.getState().totalUnreadCount, 5);

    // The same message again (a repeat delivery) counts once.
    socketHandler("message:new")(message(102));
    await settle();
    assert.equal(rowA().unreadCount, 4);
    assert.deepEqual(reads, []);

    served = [servedA(102, 4), rowB()];
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.deepEqual(reads, [listRead("activity_changed")]);
    assert.equal(rowA().unreadCount, 4, "nothing counted twice");
    assert.equal(rowA().latestActivitySeq, "102");
  } finally { restore(); }
});

test("flag on: a message at or below the delivered position, not applied here, re-reads that row only, once (reverse_commit_live_after_answer)", async () => {
  // The row as an answer at 101 delivered it: 101 committed before 100, and the answer missed 100.
  reset([servedA(101, 1), rowB()], true);
  try {
    socketHandler("message:new")(message(100));
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reads, [], "the row read waits for the view to catch up");
    assert.equal(rowA().unreadCount, 1, "not counted here: the re-read says");
    served = [servedA(101, 2), rowB()];
    await settle();
    assert.deepEqual(reads, [{ ids: "channel-a", reason: "position_reread", trigger: "ambiguous_seq", coalesced: "1" }]);
    assert.equal(rowA().unreadCount, 2);
    assert.equal(rowA().latestActivitySeq, "101");
    assert.equal(useInboxStore.getState().totalUnreadCount, 3);
  } finally { restore(); }
});

test("flag on: at most one row read in flight per row; rows waiting go in one read", async () => {
  reset([servedA(101, 1), rowB({ latestActivitySeq: "60" })], true);
  try {
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    served = [servedA(101, 2), rowB({ latestActivitySeq: "60", unreadCount: 2 })];
    socketHandler("message:new")(message(100));
    socketHandler("message:new")(message(55, { id: "message-b55", channelId: "channel-b" }));
    await settle();
    assert.deepEqual(reads.map((read) => [read.ids, read.trigger, read.coalesced]), [["channel-a,channel-b", "ambiguous_seq", "2"]], "one read for both rows");

    // Another ambiguous message for A while its read is in flight: no second read for A yet.
    socketHandler("message:new")(message(99, { id: "message-99b" }));
    await settle();
    assert.equal(reads.length, 1, "A's read is still in flight");

    release();
    hold = null;
    await settle();
    assert.deepEqual(reads.map((read) => read.ids), ["channel-a,channel-b", "channel-a"], "then A once more, alone");
    assert.equal(rowA().unreadCount, 2);
    const b = useInboxStore.getState().items.find((item) => (item as ChannelItem).channelId === "channel-b") as ChannelItem;
    assert.equal(b.unreadCount, 2);
  } finally { restore(); }
});

test("flag on: an answer older than the row's delivered position leaves the row; one at it keeps the newer message on top (older_answer_kept, answer_reapplies_above)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    socketHandler("message:new")(message(101));
    await settle();
    assert.equal(rowA().unreadCount, 3);

    // The view a step behind the row's own last answer (100): the row stays as it is.
    served = [rowB(), servedA(99, 1)];
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 3);
    assert.equal(rowA().latestActivitySeq, "101");
    assert.equal(rowA().lastMessagePreview, "m101");

    // At the delivered position: taken, and 101 (above it) counts again; the row still shows 101.
    served = [servedA(100, 2), rowB()];
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 3);
    assert.equal(rowA().latestActivitySeq, "101");
    assert.equal(useInboxStore.getState().items[0], rowA(), "the newer row stays first");
    assert.equal(reads.filter((read) => read.ids !== null).length, 0, "no row read");
  } finally { restore(); }
});

test("flag on: the drift check carries the answer's X-Raft-Inbox-Backend unchanged, with reread=position", async () => {
  reset([channelRow(), rowB()], true);
  try {
    socketHandler("message:new")(message(101));
    await settle();
    served = [servedA(101, 3), rowB()];
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.backend"], "risingwave");
    assert.equal(traces[0].attrs["inbox.inplace.reread"], "position");
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "message_new");
    assert.equal(traces[0].attrs["inbox.inplace.scope"], "list");
  } finally { restore(); }
});

test("flag on: a row re-read's answer that agrees with the row is a noop row check, with its trigger and backend", async () => {
  reset([servedA(101, 1), rowB()], true);
  try {
    socketHandler("message:new")(message(100));
    // The view has nothing new for the row: the answer agrees with what is shown.
    served = [servedA(101, 1), rowB()];
    await settle();
    assert.deepEqual(reads.map((read) => read.ids), ["channel-a"]);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.scope"], "row");
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "ambiguous_seq");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "match");
    assert.equal(traces[0].attrs["inbox.inplace.backend"], "risingwave");
    assert.equal(traces[0].attrs["inbox.inplace.sample_rate"], "20");
  } finally { restore(); }
});

test("flag on: a row re-read's answer that disagrees is a conflict row check (unread, mention, position), with its trigger", async () => {
  reset([servedA(101, 1), rowB()], true);
  try {
    socketHandler("message:new")(message(100));
    served = [{ ...servedA(102, 3), hasMention: true }, rowB()];
    await settle();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "conflict");
    assert.equal(traces[0].attrs["inbox.inplace.scope"], "row");
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "ambiguous_seq");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "unread+mention+position");
    assert.equal(traces[0].attrs["inbox.inplace.sample_rate"], "1");
    assert.equal(traces[0].attrs["inbox.inplace.backend"], "risingwave");
    assert.match(traces[0].detail, /^trigger=ambiguous_seq;existed=1;result=unread\+mention\+position;unread=1\/3;mention=0\/1;position=101\/102;reread=position/);
  } finally { restore(); }
});

test("flag on: a persisted read of a listed row read here re-reads nothing", async () => {
  reset([channelRow(), rowB()], true);
  try {
    notifyChannelReadLocally("channel-a");
    notifyChannelReadPersistedLocally({ channelId: "channel-a", serverId: SERVER, serverEpoch: 1, principalId: getCurrentPrincipalId() });
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(rowA().unreadCount, 0);
  } finally { restore(); }
});

test("flag on: my own send's echo (the store had it) re-reads nothing", async () => {
  reset([channelRow({ unreadCount: 0, firstUnreadMessageId: null }), rowB()], true);
  try {
    const own = message(101, { senderId: ME, senderName: "me" });
    useMessageStore.getState().addMessage(own, "channel-room");
    socketHandler("message:new")(own);
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(rowA().latestActivitySeq, "101");
    assert.equal(rowA().unreadCount, 0);
  } finally { restore(); }
});

/** Channel A muted for Activity from seq 101 on. */
function muteA() {
  useChannelStore.setState({ channels: [{ id: "channel-a", activityMuted: true, muteFromSeq: 101 }], dmChannels: [] } as never);
}

test("flag on: past a mute, a message without a mention of me leaves the row as it is and re-reads nothing (muted_message_leaves_row)", async () => {
  reset([channelRow(), rowB()], true);
  muteA();
  try {
    socketHandler("message:new")(message(101));
    await settle();
    assert.deepEqual(reads, [], "no list read, no row read");
    const row = rowA();
    assert.equal(row.unreadCount, 2);
    assert.equal(row.hasMention, false);
    assert.equal(row.latestActivitySeq, "100", "the row stays at its last message before the mute");
    assert.equal(row.lastMessagePreview, channelRow().lastMessagePreview);
  } finally { restore(); useChannelStore.setState({ channels: [], dmChannels: [] } as never); }
});

test("flag on: past a mute, a mention of me lights the row's @ without counting or moving it, re-reading nothing (muted_mention_lights_without_moving)", async () => {
  reset([channelRow(), rowB()], true);
  muteA();
  try {
    socketHandler("message:new")(message(101, { mentions: [{ type: "user", id: ME }] } as Partial<Message>));
    await settle();
    assert.deepEqual(reads, [], "no list read, no row read");
    const row = rowA();
    assert.equal(row.unreadCount, 2, "a muted mention does not count");
    assert.equal(row.hasMention, true);
    assert.equal(row.latestActivitySeq, "100", "the row stays at its last message before the mute");
    assert.equal(row.lastMessagePreview, "m100");

    // An answer at the row's position sent before the mention reached the server keeps the @.
    served = [channelRow(), rowB()];
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().hasMention, true);
    assert.equal(rowA().latestActivitySeq, "100");
  } finally { restore(); useChannelStore.setState({ channels: [], dmChannels: [] } as never); }
});

test("flag off: past a mute, a mention of me re-reads the list, as before", async () => {
  reset([channelRow(), rowB()], false);
  muteA();
  try {
    served = [channelRow({ hasMention: true }), rowB()];
    socketHandler("message:new")(message(101, { mentions: [{ type: "user", id: ME }] } as Partial<Message>));
    await settle();
    assert.deepEqual(reads, [listRead("message_new")]);
  } finally { restore(); useChannelStore.setState({ channels: [], dmChannels: [] } as never); }
});

test("flag on: a row the row re-read does not return (no longer listed for the viewer) re-reads the list (row_missing)", async () => {
  reset([servedA(101, 1), rowB()], true);
  try {
    socketHandler("message:new")(message(100));
    // The route leaves out a row that no longer qualifies (access lost, archived, Done elsewhere).
    served = [rowB()];
    await settle();
    assert.deepEqual(reads.map((read) => [read.ids, read.reason, read.trigger]), [
      ["channel-a", "position_reread", "ambiguous_seq"],
      [null, "realtime_fallback", "row_missing"],
    ]);
    assert.equal(rowA(), undefined, "the list read took the stale row away");
  } finally { restore(); }
});

/** `count` live messages in order on channel A, from seq 101. */
function liveInOrder(count: number, from = 101) {
  for (let seq = from; seq < from + count; seq += 1) socketHandler("message:new")(message(seq));
}

test("flag on: one live message in 20 applied in place is audited: its row read once (position_audit)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    liveInOrder(POSITION_AUDIT_EVERY - 1);
    await settle();
    assert.deepEqual(reads, [], "19 applied: no read");
    served = [servedA(120, 22), rowB()];
    liveInOrder(1, 120);
    await settle();
    assert.deepEqual(reads, [{ ids: "channel-a", reason: "position_audit", trigger: "position_audit", coalesced: "1" }]);
    liveInOrder(POSITION_AUDIT_EVERY - 1, 121);
    await settle();
    assert.equal(reads.length, 1, "the next audit is the 40th");
  } finally { restore(); }
});

test("flag on: an audit that agrees is a noop row check; one that disagrees a conflict; both with trigger position_audit", async () => {
  reset([channelRow(), rowB()], true);
  try {
    served = [servedA(120, 22), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    await settle();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "match");
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "position_audit");
    assert.equal(traces[0].attrs["inbox.inplace.scope"], "row");

    served = [servedA(140, 41), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY, 121);
    await settle();
    assert.equal(traces.length, 2);
    assert.equal(traces[1].outcome, "conflict");
    assert.equal(traces[1].attrs["inbox.inplace.result"], "unread");
    assert.equal(traces[1].attrs["inbox.inplace.trigger"], "position_audit");
    assert.equal(traces[1].attrs["inbox.inplace.scope"], "row");
  } finally { restore(); }
});

test("flag on: an audited row that moved again before the answer is recorded not judged", async () => {
  reset([channelRow(), rowB()], true);
  try {
    served = [servedA(120, 22), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    // A newer live message before the audit's read.
    liveInOrder(1, 121);
    await settle();
    assert.deepEqual(reads.map((read) => read.reason), ["position_audit"]);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "not_judged");
    assert.equal(traces[0].attrs["inbox.inplace.not_judged_cause"], "moved");
    assert.equal(traces[0].attrs["inbox.inplace.sample_rate"], "1");
    assert.equal(rowA().unreadCount, 23, "the answer behind the row does not undo the newer message");
  } finally { restore(); }
});

// #triage:#244 run 4: 6 of 7 set-aside audits were thread rows whose object a
// metadata refresh rebuilt (thread:updated's reply count and last activity
// for the reply already counted) with the same position, unread and @.
test("flag on: an audited row rebuilt with the same position, unread and @ before the answer is still judged (match)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    served = [servedA(120, 22), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    // A metadata refresh: a new row object, nothing the audit judges changed.
    useInboxStore.setState((state) => ({ items: state.items.map((item) => (item === rowA() ? { ...item, lastMessageAt: "2026-11-14T10:00:59.000Z" } as InboxItem : item)) }));
    await settle();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].attrs["inbox.inplace.result"], "match");
    assert.equal(traces[0].attrs["inbox.inplace.trigger"], "position_audit");
  } finally { restore(); }
});


// An audit answer behind its row (the view a moment behind the live message,
// #triage:#244): judged after the merge, verified only up to the answer, then
// read once more and judged in full.
test("flag on: an audit answer one message behind is match_up_to_answer (answer_behind=1), and its follow-up read is judged in full", async () => {
  reset([channelRow(), rowB()], true);
  try {
    served = [servedA(119, 21), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    await settle();
    assert.equal(reads.length, 1, "the audit's read; the follow-up waits its delay");
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "noop");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "match_up_to_answer");
    assert.match(traces[0].detail, /;unread=22\/21;mention=0\/0;position=120\/119;answer_behind=1;merged=22\/120/);
    // What the merge started from (#triage:#244 diagnostics): the kept state, the one live message above the answer, counted, no read on it.
    assert.match(traces[0].detail, /;merged=22\/120;kept_state=1;row_position=100;applied=20;above=1;above_counts=1\/1;read_through=-/);
    assert.equal(rowA().unreadCount, 22, "the live message above the answer stays counted");
    assert.equal(rowA().latestActivitySeq, "120");

    served = [servedA(120, 22), rowB()];
    await vi.advanceTimersByTimeAsync(AUDIT_FOLLOWUP_DELAY_MS);
    await settle();
    assert.deepEqual(reads.map((read) => [read.ids, read.reason, read.trigger]), [
      ["channel-a", "position_audit", "position_audit"],
      ["channel-a", "position_audit", "position_audit"],
    ]);
    assert.equal(traces.length, 2);
    assert.equal(traces[1].outcome, "noop");
    assert.equal(traces[1].attrs["inbox.inplace.result"], "match");
    assert.match(traces[1].detail, /;followup=1/);
    assert.doesNotMatch(traces[1].detail, /answer_behind/);
    await vi.advanceTimersByTimeAsync(AUDIT_FOLLOWUP_DELAY_MS * 2);
    assert.equal(reads.length, 2, "a follow-up judged in full schedules nothing more");
  } finally { restore(); }
});

test("flag on: an audit answer behind whose count below its position disagrees is a conflict up to the answer", async () => {
  reset([channelRow(), rowB()], true);
  try {
    // The answer says 25 unread by 119; with 120 on top that is 26, not the 22 shown.
    served = [servedA(119, 25), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    await settle();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].outcome, "conflict");
    assert.equal(traces[0].attrs["inbox.inplace.result"], "unread_up_to_answer");
    assert.match(traces[0].detail, /;answer_behind=1;merged=26\/120/);
  } finally { restore(); }
});

test("flag on: a follow-up whose answer is still behind is recorded not judged (answer_behind)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    served = [servedA(119, 21), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    await settle();
    await vi.advanceTimersByTimeAsync(AUDIT_FOLLOWUP_DELAY_MS);
    await settle();
    assert.equal(reads.length, 2);
    assert.equal(traces.length, 2);
    assert.equal(traces[1].attrs["inbox.inplace.result"], "not_judged");
    assert.equal(traces[1].attrs["inbox.inplace.not_judged_cause"], "answer_behind");
    assert.match(traces[1].detail, /;followup=1/);
    await vi.advanceTimersByTimeAsync(AUDIT_FOLLOWUP_DELAY_MS * 2);
    assert.equal(reads.length, 2, "no second follow-up");
  } finally { restore(); }
});

test("flag on: a follow-up still waiting when the server switches is recorded not judged (server_switched)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    served = [servedA(119, 21), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    await settle();
    assert.equal(traces.length, 1);
    triggerServerReset();
    await vi.advanceTimersByTimeAsync(AUDIT_FOLLOWUP_DELAY_MS * 2);
    assert.equal(reads.length, 1, "no follow-up read after the switch");
    assert.equal(traces.length, 2);
    assert.equal(traces[1].attrs["inbox.inplace.not_judged_cause"], "server_switched");
    assert.match(traces[1].detail, /;followup=1/);
  } finally { restore(); }
});

// Every audit scheduled ends in exactly one check (judged, or not_judged with its cause), so the denominator is known.

/** The 20th live message: an audit of channel A waits for its read; the view agrees with the row. */
function scheduleAudit() {
  served = [servedA(120, 22), rowB()];
  liveInOrder(POSITION_AUDIT_EVERY);
}

function auditChecks() {
  return traces.filter((trace) => trace.attrs["inbox.inplace.trigger"] === "position_audit");
}

function assertOneNotJudged(cause: string, backend: string | null = null) {
  const audits = auditChecks();
  assert.equal(audits.length, 1, "exactly one check for the audit");
  assert.equal(audits[0].outcome, "noop");
  assert.equal(audits[0].attrs["inbox.inplace.result"], "not_judged");
  assert.equal(audits[0].attrs["inbox.inplace.not_judged_cause"], cause);
  assert.equal(audits[0].attrs["inbox.inplace.scope"], "row");
  assert.equal(audits[0].attrs["inbox.inplace.sample_rate"], "1");
  assert.equal(audits[0].attrs["inbox.inplace.backend"], backend ?? undefined);
  assert.match(audits[0].detail, new RegExp(`;cause=${cause}`));
}

/** Holds the next read until the returned release is called. */
function holdReads(): () => void {
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  return () => { hold = null; release(); };
}

test("flag on: audits that agree are each sent (sample_rate 1), not sampled like other agreements", async () => {
  reset([channelRow(), rowB()], true);
  try {
    scheduleAudit();
    await settle();
    served = [servedA(140, 42), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY, 121);
    await settle();
    const audits = auditChecks();
    assert.deepEqual(audits.map((trace) => [trace.attrs["inbox.inplace.result"], trace.attrs["inbox.inplace.sample_rate"]]), [["match", "1"], ["match", "1"]]);
  } finally { restore(); }
});

test("flag on: an audit a re-read of its row supersedes is recorded not judged (superseded_by_reread)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    scheduleAudit();
    // At the row's delivered position, not applied here: the row is re-read, in the audit's place.
    socketHandler("message:new")(message(100));
    await settle();
    assert.deepEqual(reads.map((read) => [read.reason, read.trigger]), [["position_reread", "ambiguous_seq"]]);
    assertOneNotJudged("superseded_by_reread");
  } finally { restore(); }
});

test("flag on: an audit due while the page is hidden is recorded not judged (page_hidden)", async () => {
  reset([channelRow(), rowB()], true);
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "hidden" }, configurable: true });
  try {
    scheduleAudit();
    await settle();
    assert.deepEqual(reads, [], "a hidden page reads nothing");
    assertOneNotJudged("page_hidden");
  } finally {
    Reflect.deleteProperty(globalThis, "document");
    restore();
  }
});

test("flag on: an audit whose answer a read change overtook is recorded not judged (read_changed)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    const release = holdReads();
    scheduleAudit();
    await settle();
    assert.equal(reads.length, 1);
    acceptActivityReadAllAck({ serverId: SERVER, principalId: ME, serverEpoch: 1, generation: 0 }, "channel-b", { maxReadSeq: 50, readStateVersion: 9 });
    release();
    await settle();
    assert.equal(reads.length, 1, "an audit is not asked again");
    assertOneNotJudged("read_changed", "risingwave");
  } finally { restore(); }
});

test("flag on: an audit whose read fails is recorded not judged (request_failed)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    api.get = (async () => { throw new Error("offline"); }) as typeof api.get;
    scheduleAudit();
    await settle();
    assertOneNotJudged("request_failed");
  } finally { restore(); }
});

test("flag on: an audit whose answer leaves the row out is recorded not judged (row_missing)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    scheduleAudit();
    served = [rowB()];
    await settle();
    assertOneNotJudged("row_missing", "risingwave");
  } finally { restore(); }
});

test("flag on: an audit whose row is no longer listed when the answer comes is recorded not judged (row_unlisted)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    const release = holdReads();
    scheduleAudit();
    await settle();
    useInboxStore.setState({ items: [rowB()] });
    release();
    await settle();
    assertOneNotJudged("row_unlisted", "risingwave");
  } finally { restore(); }
});

test("flag on: an audit still waiting when the server switches is recorded not judged (server_switched)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    scheduleAudit();
    triggerServerReset();
    await settle();
    assert.deepEqual(reads, []);
    assertOneNotJudged("server_switched");
  } finally { restore(); }
});

test("flag on: an audit in flight when the server switches is recorded not judged on its answer (server_switched)", async () => {
  reset([channelRow(), rowB()], true);
  try {
    const release = holdReads();
    scheduleAudit();
    await settle();
    assert.equal(reads.length, 1);
    useServerStore.setState({ serverEpoch: 2 } as never);
    release();
    await settle();
    assertOneNotJudged("server_switched", "risingwave");
  } finally { restore(); }
});


// #triage:#244: opening a row clears it here at once; a read sent before the
// open whose answer comes after must not bring the old count back, and a
// message after the open must still count.
const staleRow = () => channelRow({ unreadCount: 15, hasMention: true, firstMentionMessageId: "message-90" });

async function openWhileListReadInFlight(flagOn: boolean, servedAfterOpen: () => InboxItem[]) {
  reset([staleRow(), rowB()], flagOn);
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  served = [staleRow(), rowB()];
  requestInboxBackgroundRefresh("resume_gap");
  await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 2);
  assert.deepEqual(reads.map((read) => read.trigger), ["resume_gap"], "the list read is in flight");
  notifyChannelReadLocally("channel-a");
  assert.equal(rowA().unreadCount, 0, "opening clears the row at once");
  return () => {
    served = servedAfterOpen();
    release();
    hold = null;
  };
}

for (const flagOn of [true, false]) {
  test(`flag ${flagOn ? "on" : "off"}: a list answer sent before a row was opened does not bring back its unread or @`, async () => {
    try {
      const answer = await openWhileListReadInFlight(flagOn, () => [staleRow(), rowB()]);
      answer();
      await vi.advanceTimersByTimeAsync(10);
      assert.equal(rowA().unreadCount, 0);
      assert.equal(rowA().hasMention, false);
      assert.equal(traces.filter((trace) => trace.outcome === "conflict").length, 0, "the drift check judges the row as read");
    } finally { restore(); }
  });
}

test("flag on: a message that arrives after the open still counts, against a list answer sent before the open", async () => {
  try {
    const answer = await openWhileListReadInFlight(true, () => [staleRow(), rowB()]);
    socketHandler("message:new")(message(101));
    assert.equal(rowA().unreadCount, 1, "the new message counts");
    answer();
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(rowA().unreadCount, 1, "the older answer neither clears it nor brings back the 15");
  } finally { restore(); }
});

test("flag on: an answer that has a message newer than the open is taken as served (the suppression ends)", async () => {
  try {
    const answer = await openWhileListReadInFlight(true, () => [servedA(101, 16), rowB()]);
    answer();
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(rowA().latestActivitySeq, "101");
    assert.ok(rowA().unreadCount > 0, "a newer message is never hidden by the read");
  } finally { restore(); }
});

test("flag on: a row read sent before the open does not bring back its unread", async () => {
  reset([staleRow(), rowB()], true);
  try {
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    served = [staleRow(), rowB()];
    // At the row's delivered position, not applied here: the row is re-read.
    socketHandler("message:new")(message(100, { id: "message-100b" }));
    await settle();
    assert.deepEqual(reads.map((read) => read.ids), ["channel-a"], "the row read is in flight");
    notifyChannelReadLocally("channel-a");
    release();
    hold = null;
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(rowA().unreadCount, 0);
    assert.equal(rowA().hasMention, false);
  } finally { restore(); }
});


// #triage:#244 (one short, 4 of 4 lagging answers on staging): a row whose
// conversation's messages are loaded here gets its unread from their
// read-state projection, and its live patch adds nothing; the row's record
// must still say the message counts, or an answer behind it drops it.
test("flag on: on a loaded conversation, a live message counts once, and an answer behind it keeps it", async () => {
  reset([channelRow(), rowB()], true);
  try {
    // Channel A was opened here earlier: its messages are loaded, read through 98.
    consumeReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 98, readStateVersion: 2 });
    useMessageStore.setState((state) => ({
      channelMessages: { ...state.channelMessages, "channel-a": [message(99), message(100)] },
      channelWindowMeta: { ...state.channelWindowMeta, "channel-a": { hasNewer: false, hasOlder: true, loading: false } as never },
    }));
    served = [servedA(119, 21), rowB()];
    liveInOrder(POSITION_AUDIT_EVERY);
    assert.equal(rowA().unreadCount, 22, "each live message counted once (by the projection)");
    await settle();
    assert.equal(traces[0].attrs["inbox.inplace.result"], "match_up_to_answer");
    assert.match(traces[0].detail, /;merged=22\/120;kept_state=1;row_position=100;applied=20;above=1;above_counts=1\/1;/);
    assert.equal(rowA().unreadCount, 22, "the answer one behind keeps the live message above it");
  } finally { restore(); }
});

// #triage:#244 (6 vs 7 after deploy 3): the read-state projection of a
// conversation's loaded messages is remembered by read-state version. A
// message that reached the server while the socket was down is not loaded
// here, so that projection does not cover it; a list answer that has it, at
// the same read state, must not be lowered back to the projection's count.
for (const flagOn of [true, false]) {
  test(`flag ${flagOn ? "on" : "off"}: an answer with a message newer than the loaded projection keeps its served count`, async () => {
    reset([channelRow(), rowB()], flagOn);
    try {
      consumeReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 98, readStateVersion: 2 });
      servedRead = { readStateVersion: 2, maxReadSeq: "98" }; // every answer is at this same read
      useMessageStore.setState((state) => ({
        channelMessages: { ...state.channelMessages, "channel-a": [message(99), message(100)] },
        channelWindowMeta: { ...state.channelWindowMeta, "channel-a": { hasNewer: false, hasOlder: true, loading: false } as never },
      }));
      assert.equal(useMessageStore.getState().applyReadStateProjection("channel-a").unreadCount, 2, "the loaded messages project 2");
      // Answer A: through 100, 2 unread (the projection agrees).
      served = [servedA(100, 2), rowB()];
      requestInboxBackgroundRefresh("reconnect");
      await settle();
      assert.equal(rowA().unreadCount, 2);
      // Message 101 reaches the server but never arrives here. Answer B has it, same read state.
      served = [servedA(101, 3), rowB()];
      requestInboxBackgroundRefresh("resume_gap");
      await settle();
      assert.equal(rowA().latestActivitySeq, "101");
      assert.equal(rowA().unreadCount, 3, "the served count stands: the projection does not cover 101");
      // Projecting the same loaded messages again (a sync, a page load) does not lower it either.
      useMessageStore.getState().applyReadStateProjection("channel-a");
      assert.equal(rowA().unreadCount, 3, "a re-projection does not cover 101 either");
    } finally { restore(); }
  });
}

// The inverse: a projection that covers the answer's newest message (a read
// made here that the answer is from before) still lowers the row.
for (const flagOn of [true, false]) {
  test(`flag ${flagOn ? "on" : "off"}: a projection that covers the answer's newest message still lowers its count`, async () => {
    reset([channelRow(), rowB()], flagOn);
    try {
      consumeReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 99, readStateVersion: 2 });
      useMessageStore.setState((state) => ({
        channelMessages: { ...state.channelMessages, "channel-a": [message(99), message(100), message(101)] },
        channelWindowMeta: { ...state.channelWindowMeta, "channel-a": { hasNewer: false, hasOlder: true, loading: false } as never },
      }));
      assert.equal(useMessageStore.getState().applyReadStateProjection("channel-a").unreadCount, 2, "read through 99 here: 100 and 101 unread");
      // The answer is through 101 but from before that read: it still says 3.
      served = [servedA(101, 3), rowB()];
      requestInboxBackgroundRefresh("resume_gap");
      await settle();
      assert.equal(rowA().latestActivitySeq, "101");
      assert.equal(rowA().unreadCount, 2, "the projection covers 101, so it stands");
    } finally { restore(); }
  });
}

// #triage:#244 case 2 (09:25, m244-c): the read here (read-all ack, through
// 100) holds the row read until a live message past it arrives. Messages the
// socket never delivered don't release it; an answer that has them must not
// be shown read.
for (const flagOn of [true, false]) {
  test(`flag ${flagOn ? "on" : "off"}: a read hold does not hide an answer with activity past the read`, async () => {
    reset([servedA(100, 0), rowB()], flagOn);
    try {
      setCurrentPrincipalId(ME);
      acceptActivityReadAllAck({ serverId: SERVER, principalId: ME, serverEpoch: 1, generation: 0 }, "channel-a", { maxReadSeq: 100, readStateVersion: 9 });
      servedRead = { readStateVersion: 9, maxReadSeq: "100" }; // the answer is at that read
      // 101 and 102 reach the server; this tab never gets them.
      served = [servedA(102, 2), rowB()];
      requestInboxBackgroundRefresh("resume_gap");
      await settle();
      assert.equal(rowA().latestActivitySeq, "102");
      assert.equal(rowA().unreadCount, 2, "activity past the read is unread");
    } finally { setCurrentPrincipalId(null); restore(); }
  });
}

// The inverse: an answer with nothing past the read (from before the read reached the server) is still held read.
for (const flagOn of [true, false]) {
  test(`flag ${flagOn ? "on" : "off"}: a read hold still hides an answer with no activity past the read`, async () => {
    reset([servedA(100, 0), rowB()], flagOn);
    try {
      setCurrentPrincipalId(ME);
      acceptActivityReadAllAck({ serverId: SERVER, principalId: ME, serverEpoch: 1, generation: 0 }, "channel-a", { maxReadSeq: 100, readStateVersion: 9 });
      served = [servedA(100, 2), rowB()];
      requestInboxBackgroundRefresh("resume_gap");
      await settle();
      assert.equal(rowA().unreadCount, 0, "the read covers 100");
    } finally { setCurrentPrincipalId(null); restore(); }
  });
}

// #triage:#244 moment 1 (177d9577 at 10:29): after an open here (read-all ack,
// a read hold), the first live message past the read lifts the hold and counts.
{
  test("flag on: the live message that lifts a read hold counts", async () => {
    reset([servedA(100, 0), rowB()], true);
    try {
      setCurrentPrincipalId(ME);
      acceptActivityReadAllAck({ serverId: SERVER, principalId: ME, serverEpoch: 1, generation: 0 }, "channel-a", { maxReadSeq: 100, readStateVersion: 9 });
      socketHandler("message:new")(message(101));
      await settle();
      assert.equal(rowA().unreadCount, 1, "the first message after the read counts");
      socketHandler("message:new")(message(102));
      await settle();
      assert.equal(rowA().unreadCount, 2);
    } finally { setCurrentPrincipalId(null); restore(); }
  });
}

type ThreadRow = Extract<InboxItem, { kind: "thread" }>;
function threadRow(seq: number, unread: number): ThreadRow {
  return {
    kind: "thread", threadChannelId: "thread-t", parentMessageId: "parent-1", parentChannelId: "channel-a",
    latestActivityMessageId: `t-${seq}`, latestActivitySeq: String(seq), readStateLatestActivitySeq: String(seq), doneFrontierSeq: String(seq),
    replyCount: 3, unreadCount: unread, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null, isFollowing: true,
    lastActivityAt: "2026-11-14T10:00:00.000Z", lastReplyAt: "2026-11-14T10:00:00.000Z",
  } as unknown as ThreadRow;
}
const reply = (seq: number) => message(seq, { id: `t-${seq}`, channelId: "thread-t" });
const threadA = () => useInboxStore.getState().items.find((item) => item.kind === "thread") as ThreadRow;

for (const loaded of [false, true]) {
  test(`flag on: after an open, the reply that lifts a thread's read hold counts (thread messages ${loaded ? "loaded" : "not loaded"})`, async () => {
    reset([threadRow(200, 0), rowB()], true);
    try {
      setCurrentPrincipalId(ME);
      acceptActivityReadAllAck({ serverId: SERVER, principalId: ME, serverEpoch: 1, generation: 0 }, "thread-t", { maxReadSeq: 200, readStateVersion: 9 });
      if (loaded) {
        consumeReadStateUpdate({ serverId: SERVER, scopeId: "thread-t", maxReadSeq: 200, readStateVersion: 9 });
        useMessageStore.setState((state) => ({
          channelMessages: { ...state.channelMessages, "thread-t": [reply(199), reply(200)] },
          channelWindowMeta: { ...state.channelWindowMeta, "thread-t": { hasNewer: false, hasOlder: true, loading: false } as never },
        }));
      }
      socketHandler("message:new")(reply(201));
      await settle();
      assert.equal(threadA().unreadCount, 1, "the first reply after the read counts");
      socketHandler("message:new")(reply(202));
      await settle();
      assert.equal(threadA().unreadCount, 2);
    } finally { setCurrentPrincipalId(null); restore(); }
  });
}

// Review of #15049 (probe E): a read that reaches past the loaded messages
// (another device, or Read from Activity through the server's latest) clears
// a row the answer kept above the projection.
for (const flagOn of [true, false]) {
  test(`flag ${flagOn ? "on" : "off"}: a read past the loaded messages still clears a kept row`, async () => {
    reset([channelRow(), rowB()], flagOn);
    try {
      consumeReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 98, readStateVersion: 2 });
      servedRead = { readStateVersion: 2, maxReadSeq: "98" };
      useMessageStore.setState((state) => ({
        channelMessages: { ...state.channelMessages, "channel-a": [message(99), message(100)] },
        channelWindowMeta: { ...state.channelWindowMeta, "channel-a": { hasNewer: false, hasOlder: true, loading: false } as never },
      }));
      useMessageStore.getState().applyReadStateProjection("channel-a");
      served = [servedA(101, 3), rowB()];
      requestInboxBackgroundRefresh("resume_gap");
      await settle();
      assert.equal(rowA().unreadCount, 3, "kept: 101 is not loaded");
      // Read through 101 elsewhere: the projection covers its own read cursor.
      applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 101, readStateVersion: 3 });
      assert.equal(rowA().unreadCount, 0, "the read covers 101");
    } finally { restore(); }
  });
}

// #15301 (answer_before_read_lands_no_live, mark_unread_then_late_read_ack): the row
// keeps the reducer's read seq across events. No store correction covers these
// answers: the read came from another device (no read hold here), and the answer's
// read state is as new as the ledger's (no ledger adjudication, not read-behind).
test("flag on: an answer at or below a read that landed does not bring the unread back (the row's read seq)", async () => {
  reset([servedA(100, 2), rowB()], true);
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 100, readStateVersion: 9 });
    assert.equal(rowA().unreadCount, 0, "the read clears the row");
    // Its counts computed before the read reached them: 99 and 100 still counted.
    served = [servedA(100, 2), rowB()];
    servedRead = { readStateVersion: 9, maxReadSeq: "100" };
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 0, "the answer at the read counted read messages only");
    // A message past the read still counts, and an answer with it is taken.
    served = [servedA(101, 1), rowB()];
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 1);
  } finally { restore(); }
});

test("flag on: Mark as Unread, then a late ack of the read before it, then an answer: the unread stays", async () => {
  reset([servedA(100, 0), rowB()], true);
  try {
    setCurrentPrincipalId(ME);
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 100, readStateVersion: 9 });
    let answerUnread!: () => void;
    const unreadAnswered = new Promise<void>((resolve) => { answerUnread = resolve; });
    api.post = (async (url: string) => {
      if (url !== "/channels/channel-a/unread") return { data: {}, headers: {} };
      await unreadAnswered;
      return { data: { unreadCount: 1, readStateVersion: 10, maxReadSeq: 99 }, headers: {} };
    }) as typeof api.post;
    const marked = useInboxStore.getState().markUnread(rowA());
    assert.equal(rowA().unreadCount, 1, "unread at once");
    // The read from before the mark, its persisted notice late (the ledger still at it).
    notifyChannelReadPersistedLocally({ channelId: "channel-a", serverId: SERVER, serverEpoch: 1, principalId: ME });
    // An answer with no read state (an exit that does not carry it): only the mark here tells.
    served = [servedA(100, 1), rowB()];
    servedRead = null;
    answerUnread();
    await marked;
    await settle();
    assert.equal(rowA().unreadCount, 1, "the late ack did not raise the read seq past the mark");
  } finally { setCurrentPrincipalId(null); restore(); }
});

test("flag on: a Mark as Unread made on another device, carried only by an answer's read state, keeps the answer's unread", async () => {
  reset([servedA(100, 2), rowB()], true);
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 100, readStateVersion: 9 });
    assert.equal(rowA().unreadCount, 0, "read through 100");
    // Marked unread elsewhere (the cursor rewound to 99 at v10, no flag: something counts); no socket event here.
    served = [servedA(100, 1), rowB()];
    servedRead = { readStateVersion: 10, maxReadSeq: "99" };
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 1, "the rewound cursor is a Mark as Unread: the read seq no longer holds");
  } finally { restore(); }
});

test("flag on: a Mark as Unread elsewhere below a read seq my send raised (its version never folded here) keeps the answer's unread", async () => {
  reset([servedA(100, 0), rowB()], true);
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 100, readStateVersion: 9 });
    socketHandler("message:new")(message(101));
    socketHandler("message:new")(message(102, { senderId: ME }));
    await settle();
    assert.equal(rowA().unreadCount, 0, "my send read the conversation through 102");
    // Marked unread on the phone: the cursor back to 101 (above the folded 100), no flag.
    served = [servedA(102, 1), rowB()];
    servedRead = { readStateVersion: 11, maxReadSeq: "101" };
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 1, "below the read seq: a Mark as Unread");
  } finally { restore(); }
});

test("flag on: a Mark as Unread elsewhere delivered by its read-state event keeps the answer's unread", async () => {
  reset([servedA(100, 2), rowB()], true);
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 100, readStateVersion: 9 });
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 99, readStateVersion: 10 });
    served = [servedA(100, 1), rowB()];
    servedRead = { readStateVersion: 10, maxReadSeq: "99" };
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 1);
  } finally { restore(); }
});

test("flag on: a cursor begun again (its row deleted, a new version 1) drops the read seq rather than being ignored", async () => {
  reset([servedA(100, 2), rowB()], true);
  try {
    applyReadStateUpdate({ serverId: SERVER, scopeId: "channel-a", maxReadSeq: 100, readStateVersion: 9 });
    consumeReadStateSnapshot(SERVER, "channel-a", { kind: "absent" } as never);
    served = [servedA(100, 1), rowB()];
    servedRead = { readStateVersion: 1, maxReadSeq: "0" };
    requestInboxBackgroundRefresh("activity_changed");
    await settle();
    assert.equal(rowA().unreadCount, 1);
  } finally { restore(); }
});
