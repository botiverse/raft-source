import assert from "node:assert/strict";
import type { Message } from "../src/store/messageStore";
import type { FollowedThread, ThreadSummary } from "../src/store/threadStore";

// #triage:#157 (stdrc): "if I can see it, it's read; if I click it, something
// happens". The store side of it: what a live reply does to unread on every
// surface (one rule, store/visibleConversations), the next click or key press
// reading what landed in view without being read (store/seenReadCatchUp), a
// focus never reading what the person scrolled away from, and picking the
// task the modal already shows reading it.

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();
const locationShim = { pathname: "/", hash: "" };
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "location", { value: locationShim, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: storage, sessionStorage: storage, location: locationShim,
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  },
  configurable: true,
});

const api = (await import("../src/api/client")).default;
const { useMessageStore } = await import("../src/store/messageStore");
const { useServerStore } = await import("../src/store/serverStore");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { useThreadStore } = await import("../src/store/threadStore");
const { holdAutoRead, releaseAutoRead } = await import("../src/store/autoReadHold");
const { runSeenReadCatchUp } = await import("../src/store/seenReadCatchUp");

const originalPost = api.post.bind(api);
const VIEWER = "viewer-1";
const THREAD = "thread-1";
const PARENT = "parent-1";
const CHANNEL = "channel-1";

let posts: string[] = [];

beforeEach(() => {
  storage.clear();
  releaseAutoRead({ read: false });
  posts = [];
  api.post = (async (url: string) => { posts.push(url); return { data: {} }; }) as typeof api.post;
  useServerStore.setState({
    current: { id: "server-1", name: "S", slug: "s", ownerId: VIEWER, onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "member", createdAt: "2026-07-12T00:00:00.000Z" },
    serverEpoch: 1,
  } as never);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useMessageStore.setState({ currentUserId: VIEWER });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useThreadStore.setState({ followedThreads: [followed()], summaries: { [PARENT]: summary() } });
});

afterEach(() => {
  api.post = originalPost;
});

function followed(overrides: Partial<FollowedThread> = {}): FollowedThread {
  return {
    threadChannelId: THREAD, parentMessageId: PARENT, parentChannelId: CHANNEL, parentChannelName: "general",
    parentChannelType: "channel", parentMessagePreview: "parent", parentMessageSenderType: "user",
    parentMessageSenderId: "user-2", replyCount: 1, lastReplyAt: "2026-07-12T00:00:00.000Z", unreadCount: 0,
    taskNumber: null, taskStatus: null, taskClaimedByName: null,
    ...overrides,
  } as FollowedThread;
}

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadChannelId: THREAD, replyCount: 1, lastReplyAt: "2026-07-12T00:00:00.000Z",
    participantIds: ["user-2"], unreadCount: 0, firstUnreadMessageId: null,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "reply-2", seq: 2, channelId: THREAD, senderType: "user", senderId: "user-2", senderName: "Lin",
    content: "hello", createdAt: "2026-07-12T00:01:00.000Z",
    ...overrides,
  };
}

function socketHandler(event: string) {
  const bindings = buildMainLayoutSocketBindings(
    { connected: true, emit() {}, on() {}, off() {}, onAny() {}, offAny() {}, disconnect() {}, connect() {} },
    () => {}, async () => {}, () => {}, () => {},
  );
  const binding = bindings.find((item) => item.event === event);
  assert.ok(binding);
  return binding.handler;
}

function threadUpdated(reply: Message) {
  socketHandler("thread:updated")({
    parentMessageId: PARENT, threadChannelId: THREAD, replyCount: 2,
    lastReplyAt: reply.createdAt, participantIds: [reply.senderId], latestReply: reply,
  });
}

const followedUnread = () => useThreadStore.getState().followedThreads[0]?.unreadCount;
const summaryUnread = () => useThreadStore.getState().summaries[PARENT]?.unreadCount;

function openTaskModalOnThread() {
  useThreadStore.setState({
    taskModal: { parentMessageId: PARENT, parentChannelId: CHANNEL, threadChannelId: THREAD, serverSlug: "s", focusedMessageId: null, focusNonce: 1, loading: false, error: null },
  } as never);
}

test("someone else's reply in a followed thread nobody has open is one more unread", () => {
  threadUpdated(message());
  assert.equal(followedUnread(), 1);
});

test("the person's own reply (from another device or window) is never unread", () => {
  threadUpdated(message({ senderId: VIEWER }));
  assert.equal(followedUnread(), 0);
  assert.equal(summaryUnread(), 0);
});

test("a reply in the thread the task modal shows is read, as in the side panel", () => {
  openTaskModalOnThread();
  threadUpdated(message());
  assert.equal(followedUnread(), 0);
  assert.equal(summaryUnread(), 0);
});

test("a thread held unread counts its replies while shown, so every surface agrees", () => {
  useThreadStore.setState({ openParentMessageId: PARENT, openThreadChannelId: THREAD, openParentChannelId: CHANNEL });
  holdAutoRead(THREAD, { read: () => {} });
  threadUpdated(message());
  assert.equal(followedUnread(), 1);
  assert.equal(summaryUnread(), 1);
});

test("a server summary bundled with a page keeps the thread the person is reading read", () => {
  useThreadStore.setState({ openParentMessageId: PARENT, openThreadChannelId: THREAD, openParentChannelId: CHANNEL });
  useThreadStore.getState().hydrateSummaries({
    [PARENT]: summary({ unreadCount: 2, firstUnreadMessageId: "reply-2" }),
    "parent-other": summary({ threadChannelId: "thread-other", unreadCount: 3 }),
  });
  assert.equal(summaryUnread(), 0);
  assert.equal(useThreadStore.getState().summaries["parent-other"]?.unreadCount, 3, "a thread not on screen takes the server's count");
});

test("picking the task the modal already shows reads it when it is unread again", async () => {
  useThreadStore.setState({ followedThreads: [followed({ unreadCount: 2 })] });
  openTaskModalOnThread();
  await useThreadStore.getState().openTaskModal({ parentChannelId: CHANNEL, parentMessageId: PARENT, threadChannelId: THREAD });
  assert.equal(followedUnread(), 0);
  assert.ok(posts.includes(`/channels/${THREAD}/read-all`));
});

test("picking a Task v2 conversation the modal already shows reads it when it is unread again", () => {
  useThreadStore.setState({
    followedThreads: [followed({ unreadCount: 1 })],
    taskModal: { parentMessageId: null, taskId: "task-1", parentChannelId: CHANNEL, threadChannelId: THREAD, serverSlug: "s", focusedMessageId: null, focusNonce: 1, loading: false, error: null },
  } as never);
  useThreadStore.getState().openTaskConversation({ serverSlug: "s", taskId: "task-1", parentChannelId: CHANNEL });
  assert.equal(followedUnread(), 0);
  assert.ok(posts.includes(`/channels/${THREAD}/read-all`));
});

test("a held task stays unread when picked again", async () => {
  useThreadStore.setState({ followedThreads: [followed({ unreadCount: 2 })] });
  openTaskModalOnThread();
  holdAutoRead(THREAD, { read: () => {} });
  await useThreadStore.getState().openTaskModal({ parentChannelId: CHANNEL, parentMessageId: PARENT, threadChannelId: THREAD });
  assert.equal(followedUnread(), 2);
  assert.deepEqual(posts, []);
});

function openChannelAtBottom() {
  const first = message({ id: "m1", seq: 1, channelId: CHANNEL });
  useMessageStore.setState({
    currentChannelId: CHANNEL, messages: [first], channelMessages: { [CHANNEL]: [first] },
    lastSeq: 1, isNearBottom: true, hasNewer: false, unreadCounts: {},
  });
}

test("a channel message that lands in view without a recent click or key press is read by the next one", () => {
  openChannelAtBottom();
  useMessageStore.getState().addMessage(message({ id: "m2", seq: 2, channelId: CHANNEL }), "channel-room");
  assert.equal(useMessageStore.getState().unreadCounts[CHANNEL], 1, "the gate refused the live read");

  runSeenReadCatchUp();
  assert.equal(useMessageStore.getState().unreadCounts[CHANNEL] ?? 0, 0, "the next activity reads it");

  runSeenReadCatchUp();
  assert.equal(posts.filter((url) => url.startsWith(`/channels/${CHANNEL}/read`)).length <= 1, true, "once");
});

test("the catch-up waits while the person reads older history, and drops a channel they left", () => {
  openChannelAtBottom();
  useMessageStore.getState().addMessage(message({ id: "m2", seq: 2, channelId: CHANNEL }), "channel-room");
  useMessageStore.setState({ isNearBottom: false });
  runSeenReadCatchUp();
  assert.equal(useMessageStore.getState().unreadCounts[CHANNEL], 1, "scrolled up: not read");

  useMessageStore.setState({ currentChannelId: "channel-2", isNearBottom: true });
  runSeenReadCatchUp();
  assert.equal(useMessageStore.getState().unreadCounts[CHANNEL], 1, "left: not read");
});

test("a window focus never reads a channel the person is reading older history in", () => {
  openChannelAtBottom();
  useMessageStore.setState({ isNearBottom: false, unreadCounts: { [CHANNEL]: 3 } });
  useMessageStore.getState().markCurrentChannelRead();
  assert.equal(useMessageStore.getState().unreadCounts[CHANNEL], 3);
  useMessageStore.setState({ isNearBottom: true });
  useMessageStore.getState().markCurrentChannelRead();
  assert.equal(useMessageStore.getState().unreadCounts[CHANNEL] ?? 0, 0);
});

test("a read the server saved refreshes the title and app badge count once, not at the next sweep", async () => {
  const originalLoad = useServerStore.getState().loadServerUnreadSummary;
  let loads = 0;
  useServerStore.setState({ loadServerUnreadSummary: async () => { loads += 1; } });
  try {
    const readSaved = socketHandler("read_state:updated");
    readSaved({ serverId: "server-1", scopeId: CHANNEL, maxReadSeq: 4, readStateVersion: 1 });
    readSaved({ serverId: "server-1", scopeId: THREAD, maxReadSeq: 2, readStateVersion: 1 });
    assert.equal(loads, 0, "after the burst");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(loads, 1);
  } finally {
    useServerStore.setState({ loadServerUnreadSummary: originalLoad });
  }
});
