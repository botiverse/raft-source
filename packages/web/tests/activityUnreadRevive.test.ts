/**
 * Activity, Unread filter: a row read here leaves the store and the list keeps
 * its last copy, read, in place (activityUnreadSnapshot). A later live message
 * that makes it unread again found no listed row to patch, so the stale read
 * copy stayed in place until a re-read (sometimes for the whole visit, when
 * that re-read came before the view had the message). It now comes back like
 * the All list's row: unread, on top, with the new preview, once.
 */
import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import type { InboxLiveUnread } from "../src/store/inboxInPlaceUnread";
import type { Message } from "../src/store/messageStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const { useInboxStore, requestInboxBackgroundRefresh, getInboxItemKey } = await import("../src/store/inboxStore");
const { currentActivityUnreadSnapshot, recordActivityUnreadSnapshot, showActivityUnreadSnapshot } = await import("../src/store/activityUnreadSnapshot");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;
type ThreadItem = Extract<InboxItem, { kind: "thread" }>;

const LIST = "unread-list";
const VISIT = 1;

function channelRow(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel", channelId: "channel-r", channelName: "general", channelType: "channel",
    lastMessageId: "message-1", latestActivitySeq: "100", firstUnreadMessageId: "message-1", firstMentionMessageId: null,
    lastMessageAt: "2026-11-19T09:00:00.000Z", lastMessagePreview: "first", lastMessageSenderType: "user",
    lastMessageSenderId: "user-2", lastMessageSenderName: "alice", senderAvatarUrl: null, unreadCount: 1, hasMention: false,
    ...overrides,
  };
  return { ...base, doneFrontierSeq: base.latestActivitySeq, readStateLatestActivitySeq: base.latestActivitySeq } as ChannelItem;
}

const otherRow = () => channelRow({
  channelId: "channel-other", channelName: "random", lastMessageId: "message-o", latestActivitySeq: "90",
  firstUnreadMessageId: "message-o", lastMessageAt: "2026-11-19T08:00:00.000Z", lastMessagePreview: "other",
});

function threadRow(overrides: Partial<ThreadItem> = {}): ThreadItem {
  return {
    kind: "thread", threadChannelId: "thread-r", parentMessageId: "parent-1", parentChannelId: "channel-p",
    parentChannelName: "general", parentChannelType: "channel", parentMessagePreview: "parent", parentMessageSenderType: "user",
    parentMessageSenderId: "user-2", latestActivityPreview: "first reply", latestActivitySenderType: "user",
    latestActivitySenderId: "user-2", latestActivitySenderName: "alice", latestActivityMessageId: "reply-1",
    latestActivitySeq: "95", doneFrontierSeq: "95", readStateLatestActivitySeq: "95", replyCount: 1,
    lastActivityAt: "2026-11-19T08:30:00.000Z", lastReplyAt: "2026-11-19T08:30:00.000Z", unreadCount: 1, hasMention: false,
    firstUnreadMessageId: "reply-1", firstMentionMessageId: null, taskNumber: null, taskStatus: null, taskClaimedByName: null,
    isFollowing: true, ...overrides,
  } as unknown as ThreadItem;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-2", channelId: "channel-r", seq: 101, content: "second", senderType: "agent", senderId: "agent-7",
    senderName: "bot", createdAt: "2026-11-19T09:00:05.000Z", ...overrides,
  } as Message;
}

function reply(overrides: Partial<Message> = {}): Message {
  return message({
    id: "reply-2", channelId: "thread-r", seq: 102, content: "second reply",
    conversationContext: { channelType: "thread", parentMessageId: "parent-1", parentChannelId: "channel-p", parentChannelType: "channel" },
    ...overrides,
  } as Partial<Message>);
}

function live(trigger: InboxLiveUnread["trigger"], counts = true, mention = false): InboxLiveUnread {
  return { trigger, counts, mention, loaded: false, event: trigger === "thread_reply" ? "thread:updated" : "message:new", open: false };
}

const READ = { unreadCount: 0, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null, complete: true, throughSeq: 200, readSeq: 200 };

function resetUnread(items: InboxItem[], list: { filter?: string; sortDirection?: string; searchQuery?: string } = {}) {
  triggerServerReset();
  useServerStore.setState({ current: { id: "server-1" } as never, serverEpoch: 1 } as never);
  const unread = items.reduce((sum, item) => sum + item.unreadCount, 0);
  useInboxStore.setState({
    items, groups: [], filter: "unread", channelFilterId: null, scope: null, searchQuery: "", sortDirection: "desc",
    ...list, loading: false, loadingMore: false, hasMore: false, loaded: true,
    totalCount: items.length, totalUnreadCount: unread, activeUnreadCount: unread, scrollTop: 0, focusedItemKey: null,
  } as never);
}

/**
 * The list shown (ThreadsInbox): the store's rows, then, after `rowKey` is
 * read, the store's rows with its read copy kept where it was.
 */
function showListThenRead(rowKey: string, readScope: string) {
  const first = { list: LIST, visit: VISIT, rows: useInboxStore.getState().items, kept: [] as string[] };
  recordActivityUnreadSnapshot(first);
  useInboxStore.getState().applyReadStateProjection(readScope, READ);
  assert.equal(useInboxStore.getState().items.some((item) => getInboxItemKey(item) === rowKey), false, "read under Unread: the row leaves the store");
  const shown = showActivityUnreadSnapshot(useInboxStore.getState().items, { ...first, read: new Set([rowKey]) });
  assert.deepEqual(shown.kept, [rowKey], "the list keeps it, read");
  recordActivityUnreadSnapshot({ list: LIST, visit: VISIT, ...shown });
  return shown;
}

function shownNow(rows: readonly InboxItem[], kept: readonly string[], read: string[]) {
  return showActivityUnreadSnapshot(useInboxStore.getState().items, { list: LIST, visit: VISIT, rows, kept, read: new Set(read) }).rows;
}

/** The list as ThreadsInbox shows it now (the store's rows and the snapshot), recorded as it does. */
function listNow(): InboxItem[] {
  const shown = showActivityUnreadSnapshot(useInboxStore.getState().items, currentActivityUnreadSnapshot());
  recordActivityUnreadSnapshot({ list: LIST, visit: VISIT, ...shown });
  return shown.rows;
}

function restore() {
  api.get = originalGet;
  vi.useRealTimers();
  recordActivityUnreadSnapshot(null);
  resetUnread([]);
}

test("Unread: a live message on a row kept read brings it back unread, on top, once", () => {
  try {
    resetUnread([otherRow(), channelRow()]);
    const shown = showListThenRead("channel:channel-r", "channel-r");
    const before = useInboxStore.getState();

    useInboxStore.getState().receiveChannelMessage(message(), live("message_new"));

    const state = useInboxStore.getState();
    const back = state.items[0] as ChannelItem;
    assert.equal(getInboxItemKey(back), "channel:channel-r", "back in the store, on top");
    assert.equal(back.unreadCount, 1);
    assert.equal(back.firstUnreadMessageId, "message-2");
    assert.equal(back.lastMessagePreview, "second");
    assert.equal(back.lastMessageSenderId, "agent-7");
    assert.equal(back.latestActivitySeq, "101");
    assert.equal(state.items.filter((item) => getInboxItemKey(item) === "channel:channel-r").length, 1);
    assert.equal(state.totalCount, before.totalCount + 1);
    assert.equal(state.totalUnreadCount, before.totalUnreadCount + 1);
    const rows = shownNow(shown.rows, shown.kept, ["channel:channel-r"]);
    assert.deepEqual(rows.map(getInboxItemKey), ["channel:channel-r", "channel:channel-other"], "the list shows it once, the store's copy");
    assert.equal(rows[0], back);
  } finally { restore(); }
});

test("Unread: a live reply on a thread row kept read brings it back unread, on top, once", () => {
  try {
    resetUnread([otherRow(), threadRow()]);
    showListThenRead("thread:thread-r", "thread-r");

    useInboxStore.getState().receiveThreadReply(reply(), live("thread_reply"));

    const state = useInboxStore.getState();
    const back = state.items[0] as ThreadItem;
    assert.equal(getInboxItemKey(back), "thread:thread-r");
    assert.equal(back.unreadCount, 1);
    assert.equal(back.latestActivityPreview, "second reply");
    assert.equal(back.latestActivitySeq, "102");
    assert.equal(back.replyCount, 2);
    assert.equal(state.items.filter((item) => getInboxItemKey(item) === "thread:thread-r").length, 1);
  } finally { restore(); }
});

test("Unread: a message that does not count (my own) leaves the kept row out of the store", () => {
  try {
    resetUnread([otherRow(), channelRow()]);
    showListThenRead("channel:channel-r", "channel-r");

    const receipt = useInboxStore.getState().receiveChannelMessage(message({ senderType: "user", senderId: "me" }), live("message_new", false));

    assert.equal(receipt.refused, "not_listed");
    assert.deepEqual(useInboxStore.getState().items.map(getInboxItemKey), ["channel:channel-other"]);
  } finally { restore(); }
});

for (const kind of ["channel", "thread"] as const) test(`Unread: an early re-read without the revived ${kind} row re-reads again instead of dropping it`, async () => {
  const key = kind === "channel" ? "channel:channel-r" : "thread:thread-r";
  let served: InboxItem[] = [otherRow()];
  let gets = 0;
  api.get = (async (url: string, config?: { params?: { filter?: string } }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    // The Unread list's reads; the All count (`filter: all`, one row) goes along with each.
    if (config?.params?.filter === "unread") gets += 1;
    return {
      headers: {},
      data: {
        items: served.map((item) => ({
          ...item,
          readState: {
            kind: "present", readStateVersion: 1, maxReadSeq: "0",
            latestActivity: { messageId: item.kind === "thread" ? item.latestActivityMessageId : item.lastMessageId, seq: item.readStateLatestActivitySeq },
          },
        })),
        totalCount: served.length,
        totalUnreadCount: served.reduce((sum, item) => sum + item.unreadCount, 0),
        activeUnreadCount: served.reduce((sum, item) => sum + item.unreadCount, 0),
        hasMore: false,
      },
    };
  }) as typeof api.get;
  vi.useFakeTimers();
  try {
    resetUnread([otherRow(), kind === "channel" ? channelRow() : threadRow()]);
    showListThenRead(key, kind === "channel" ? "channel-r" : "thread-r");
    await vi.advanceTimersByTimeAsync(10_000); // whatever the read itself re-reads, settled
    const start = gets;

    if (kind === "channel") useInboxStore.getState().receiveChannelMessage(message(), live("message_new"));
    else useInboxStore.getState().receiveThreadReply(reply(), live("thread_reply"));
    requestInboxBackgroundRefresh(kind === "channel" ? "message_new" : "thread_reply");
    assert.equal(listNow()[0] && getInboxItemKey(listNow()[0]), key, "the list shows the revived row, on top");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(gets, start + 1, "the event's read, before the view has the message");
    assert.equal(useInboxStore.getState().items.some((item) => getInboxItemKey(item) === key), false, "that answer leaves it out of the store");
    const meanwhile = listNow().find((item) => getInboxItemKey(item) === key);
    assert.ok(meanwhile, "the list still shows it until the catch-up brings it");
    assert.equal(meanwhile.unreadCount, 0, "read, as the copy it kept");

    // The view has it ~1 s later; the catch-up re-read (1.5 s, throttled to 2.5 s) brings it.
    served = [
      kind === "channel"
        ? channelRow({ lastMessageId: "message-2", latestActivitySeq: "101", readStateLatestActivitySeq: "101", lastMessagePreview: "second", firstUnreadMessageId: "message-2" })
        : threadRow({ latestActivityMessageId: "reply-2", latestActivitySeq: "102", readStateLatestActivitySeq: "102", latestActivityPreview: "second reply", firstUnreadMessageId: "reply-2", replyCount: 2 }),
      otherRow(),
    ];
    await vi.advanceTimersByTimeAsync(2_500);
    assert.equal(gets, start + 2, "the catch-up re-read");
    const back = useInboxStore.getState().items.find((item) => getInboxItemKey(item) === key);
    assert.ok(back, "the row is back");
    assert.equal(back.unreadCount, 1);
    assert.equal(back.kind === "thread" ? back.latestActivityPreview : (back as ChannelItem).lastMessagePreview, kind === "channel" ? "second" : "second reply");

    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(gets, start + 2, "nothing more once the row is served");
  } finally { restore(); }
});

test("Unread mentions: only a message that mentions the viewer brings a kept row back", () => {
  for (const mention of [false, true]) try {
    resetUnread([otherRow(), channelRow()], { filter: "unread_mentions" });
    showListThenRead("channel:channel-r", "channel-r");

    const receipt = useInboxStore.getState().receiveChannelMessage(message(), live("message_new", true, mention));

    const back = useInboxStore.getState().items.find((item) => getInboxItemKey(item) === "channel:channel-r");
    if (mention) {
      assert.ok(back, "a mention brings it back");
      assert.equal(back.hasMention, true);
      assert.equal(back.unreadCount, 1);
    } else {
      assert.equal(back, undefined, "a message without a mention leaves it out");
      assert.equal(receipt.refused, "not_listed");
    }
  } finally { restore(); }
});

for (const [name, list] of [
  ["oldest first", { sortDirection: "asc" }],
  ["a search", { searchQuery: "gen" }],
] as const) test(`Unread with ${name}: a live message leaves the kept row out of the store (the re-read decides)`, () => {
  try {
    resetUnread([otherRow(), channelRow()], list);
    showListThenRead("channel:channel-r", "channel-r");

    const receipt = useInboxStore.getState().receiveChannelMessage(message(), live("message_new"));

    assert.equal(receipt.refused, "not_listed");
    assert.deepEqual(useInboxStore.getState().items.map(getInboxItemKey), ["channel:channel-other"]);
  } finally { restore(); }
});

for (const seq of [100, 99]) test(`Unread: a live message at seq ${seq}, not newer than the kept row's 100, leaves it out`, () => {
  try {
    resetUnread([otherRow(), channelRow()]);
    showListThenRead("channel:channel-r", "channel-r");

    const receipt = useInboxStore.getState().receiveChannelMessage(message({ seq }), live("message_new"));

    assert.equal(receipt.refused, "not_listed");
    assert.deepEqual(useInboxStore.getState().items.map(getInboxItemKey), ["channel:channel-other"]);
  } finally { restore(); }
});

test("Unread: a live message on a DM row kept read brings it back unread, on top", () => {
  try {
    resetUnread([otherRow(), channelRow({ kind: "dm", channelType: "dm", channelName: "alice" } as Partial<ChannelItem>)]);
    showListThenRead("dm:channel-r", "channel-r");

    useInboxStore.getState().receiveChannelMessage(message(), live("message_new"));

    const back = useInboxStore.getState().items[0] as ChannelItem;
    assert.equal(getInboxItemKey(back), "dm:channel-r");
    assert.equal(back.unreadCount, 1);
    assert.equal(back.lastMessagePreview, "second");
  } finally { restore(); }
});
