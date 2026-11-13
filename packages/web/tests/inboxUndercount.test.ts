/**
 * #triage:#244 under-count (LOCAL-LOWER rows), through the socket bridge and
 * the open thread's read: a message the store first got from a catch-up still
 * counts once on its `message:new`; a resume that brings messages for a listed
 * row asks for a re-read; an open thread counts a live reply as read only when
 * that read will be saved (the window in use, the panel at its bottom).
 */
import "./helpers/domSetup";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import type { InboxRefreshTrigger } from "@botiverse/raft-shared";
import type { InboxItem } from "../src/store/inboxStore";
import type { Message } from "../src/store/messageStore";

const { useInboxStore, cancelInboxBackgroundRefresh } = await import("../src/store/inboxStore");
const { liveActivityUnread, resetInPlaceDriftForTests } = await import("../src/store/inboxInPlaceUnread");
const { registerOpenThreadPanel } = await import("../src/store/openThreadReadSaved");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useThreadStore } = await import("../src/store/threadStore");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);
const originalHasFocus = document.hasFocus.bind(document);
const ME = "user-me";
const SERVER = "server-244u";

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
    firstUnreadMessageId: null, firstMentionMessageId: null, isFollowing: true,
    lastActivityAt: "2026-11-09T09:00:00.000Z", lastReplyAt: "2026-11-09T09:00:00.000Z",
    ...overrides,
  };
  return { readStateLatestActivitySeq: base.latestActivitySeq, ...base } as unknown as ThreadItem;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "a-2", channelId: "channel-a", seq: 101, content: "hi", senderType: "agent", senderId: "agent-1",
    senderName: "bot", messageType: "chat", createdAt: "2026-11-09T10:05:00.000Z", reactions: [],
    ...overrides,
  } as Message;
}

let served: InboxItem[] = [];
let details: string[] = [];

function serve() {
  api.get = (async (url: string) => {
    if (url !== "/channels/inbox") return { data: [], headers: {} };
    return {
      headers: {},
      data: {
        items: served.map((item) => {
          const row = item as ChannelItem & ThreadItem;
          const messageId = item.kind === "thread" ? row.latestActivityMessageId : row.lastMessageId;
          return { ...item, readState: { kind: "present", readStateVersion: 1, maxReadSeq: "0", latestActivity: { messageId, seq: row.latestActivitySeq } } };
        }),
        totalCount: served.length, totalUnreadCount: 0, activeUnreadCount: 0, hasMore: false,
      },
    };
  }) as typeof api.get;
}

async function reset(items: InboxItem[]) {
  cancelInboxBackgroundRefresh();
  triggerServerReset();
  resetInPlaceDriftForTests();
  useServerStore.setState({ current: { id: SERVER } as never, serverEpoch: 1 } as never);
  useMessageStore.setState({ currentUserId: ME, channelMessages: {}, channelWindowMeta: {}, currentChannelId: null });
  useThreadStore.setState({ openThreadChannelId: null, openParentMessageId: null, taskModal: null } as never);
  useInboxStore.setState({
    items, groups: [], filter: "all", channelFilterId: null, scope: null, sortDirection: "desc", searchQuery: "",
    loading: false, loadingMore: false, hasMore: false, loaded: true, totalCount: items.length,
    totalUnreadCount: 0, activeUnreadCount: 0,
  });
  details = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name !== "slock.state.transition") return;
    const a = attrs as { key: { event: string }; meta: { outcomeDetail: string } };
    if (a.key.event === "activity:inplace_check") details.push(a.meta.outcomeDetail);
  });
  // The rows as the server served them: the late path knows each row's served seq.
  served = items;
  serve();
  await useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "realtime_fallback" });
}

function restore() {
  cancelInboxBackgroundRefresh();
  api.get = originalGet;
  document.hasFocus = originalHasFocus;
  __setStateTransitionEmitterForTest(null);
  useThreadStore.setState({ openThreadChannelId: null, openParentMessageId: null } as never);
}

function bridge() {
  const asked: InboxRefreshTrigger[] = [];
  const bindings = buildMainLayoutSocketBindings(
    { connected: true, emit() {}, on() {}, off() {}, onAny() {}, offAny() {}, disconnect() {}, connect() {} } as never,
    (trigger) => { asked.push(trigger); },
    async () => {},
    () => {},
    () => {},
  );
  const handler = (event: string) => bindings.find((binding) => binding.event === event)!.handler as (payload: unknown) => void;
  return { asked, handler };
}

const channelRow = () => useInboxStore.getState().items.find((item): item is ChannelItem => item.kind === "channel")!;
const threadRow = () => useInboxStore.getState().items.find((item): item is ThreadItem => item.kind === "thread")!;

test("a message the store first got from a sync:resume counts once when its message:new comes", async () => {
  await reset([channel()]);
  try {
    const { handler } = bridge();
    const msg = message();
    handler("sync:resume:response")({ messages: [msg], currentSeq: 101, hasMore: false });
    assert.equal(useMessageStore.getState().channelMessages["channel-a"]?.length, 1, "stored by the resume");
    assert.equal(channelRow().unreadCount, 0, "the resume patches no row");
    handler("message:new")(msg);
    assert.equal(channelRow().lastMessageId, "a-2");
    assert.equal(channelRow().unreadCount, 1, "its first live patch counts");
    handler("message:new")(msg);
    assert.equal(channelRow().unreadCount, 1, "a repeat delivery does not count again");
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
    served = [channel({ lastMessageId: "a-2", latestActivitySeq: "101", unreadCount: 1 })];
    await useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "realtime_fallback" });
    assert.equal(details.length, 1);
    assert.match(details[0], /;result=match;.*;counts=1;late=0;via=sync$/);
  } finally { restore(); }
});

test("a thread reply the store first got from a catch-up counts once on its thread row", async () => {
  await reset([thread()]);
  try {
    const { handler } = bridge();
    const msg = message({ id: "t-2", channelId: "thread-t", seq: 51 });
    useMessageStore.getState().batchAddMessages([msg]);
    handler("message:new")(msg);
    assert.equal(threadRow().latestActivityMessageId, "t-2");
    assert.equal(threadRow().unreadCount, 1);
    handler("message:new")(msg);
    assert.equal(threadRow().unreadCount, 1);
  } finally { restore(); }
});

test("sync:resume with messages for a listed row asks for a re-read; for another scope it does not", async () => {
  await reset([channel()]);
  try {
    const { asked, handler } = bridge();
    handler("sync:resume:response")({ messages: [message({ id: "x-1", channelId: "channel-x", seq: 5 })], currentSeq: 101, hasMore: false });
    assert.deepEqual(asked, []);
    handler("sync:resume:response")({ messages: [message()], currentSeq: 101, hasMore: false });
    assert.deepEqual(asked, ["resume_gap"]);
  } finally { restore(); }
});

test("thread:updated with a replyCount more than one past the row's asks for a re-read named for it", async () => {
  await reset([thread()]);
  try {
    const { asked, handler } = bridge();
    const update = (replyCount: number, seq: number) => handler("thread:updated")({
      parentMessageId: "parent-1", threadChannelId: "thread-t", replyCount, lastReplyAt: "2026-11-09T10:05:00.000Z", participantIds: [],
      latestReply: message({ id: `t-${seq}`, channelId: "thread-t", seq }),
    });
    update(2, 51);
    assert.equal(asked.at(-1), "thread_reply");
    update(5, 60);
    assert.equal(asked.at(-1), "reply_gap");
  } finally { restore(); }
});

// The open thread's live reply: read on screen only when that read will be saved.
function openThread(atBottom: boolean) {
  useThreadStore.setState({ openThreadChannelId: "thread-t", openParentMessageId: "parent-1" } as never);
  return registerOpenThreadPanel("thread-t", () => atBottom);
}

function inUse(visibility: "visible" | "hidden") {
  document.hasFocus = () => true;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  fireEvent.pointerDown(document.body);
  Object.defineProperty(document, "visibilityState", { value: visibility, configurable: true });
}

function replyLive(msg: Message) {
  useInboxStore.getState().receiveThreadReply(msg, liveActivityUnread(msg, "thread_reply"));
}

for (const [name, atBottom, visibility] of [
  ["the tab is hidden", true, "hidden"],
  ["the panel is not at its bottom", false, "visible"],
] as const) {
  test(`an open thread whose read will not be saved (${name}) counts the reply; the read then clears it`, async () => {
    await reset([thread()]);
    const unregister = openThread(atBottom);
    try {
      inUse(visibility);
      replyLive(message({ id: "t-2", channelId: "thread-t", seq: 51 }));
      assert.equal(threadRow().unreadCount, 1);
      assert.equal(useInboxStore.getState().totalUnreadCount, 1);
      useInboxStore.getState().clearReadForChannel("thread-t");
      assert.equal(threadRow().unreadCount, 0, "the persisted read clears it");
      assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    } finally {
      unregister();
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      restore();
    }
  });
}

test("an open thread at its bottom, in a visible focused window in use, reads the reply: no count", async () => {
  await reset([thread()]);
  const unregister = openThread(true);
  try {
    inUse("visible");
    replyLive(message({ id: "t-2", channelId: "thread-t", seq: 51 }));
    assert.equal(threadRow().latestActivityMessageId, "t-2");
    assert.equal(threadRow().unreadCount, 0);
  } finally {
    unregister();
    restore();
  }
});

test("several panels on one thread: the read is saved when any is at its bottom; each unregisters only itself", async () => {
  await reset([thread()]);
  const { isOpenThreadReadSaved } = await import("../src/store/openThreadReadSaved");
  try {
    inUse("visible");
    const modalAtBottom = registerOpenThreadPanel("thread-t", () => true);
    const sideScrolledUp = registerOpenThreadPanel("thread-t", () => false);
    assert.equal(isOpenThreadReadSaved("thread-t"), true, "the task modal at its bottom saves it, whatever the side panel says");
    sideScrolledUp();
    assert.equal(isOpenThreadReadSaved("thread-t"), true, "unregistering the side panel leaves the modal");
    const sideAgain = registerOpenThreadPanel("thread-t", () => false);
    modalAtBottom();
    assert.equal(isOpenThreadReadSaved("thread-t"), false, "only the scrolled-up side panel is left");
    sideAgain();
    assert.equal(isOpenThreadReadSaved("thread-t"), false, "no panel");
  } finally { restore(); }
});
