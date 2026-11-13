import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import type { Message } from "../src/store/messageStore";
import type { FollowedThread, ThreadSummary } from "../src/store/threadStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

const storage = new MemoryStorage();
const locationShim = { pathname: "/", hash: "" };

Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: storage,
  configurable: true,
});
Object.defineProperty(globalThis, "location", {
  value: locationShim,
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: storage,
    sessionStorage: storage,
    location: locationShim,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  },
  configurable: true,
});

const api = (await import("../src/api/client")).default;
const { useInboxStore, getInboxItemKey } = await import("../src/store/inboxStore");
const { useMessageStore } = await import("../src/store/messageStore");
const {
  consumeReadStateUpdate,
  getReadStateLedgerGeneration,
  hasAcceptedReadStateChangedAfter,
  normalizeReadStateUpdated,
  normalizeReadStateUpdatedBulk,
  resetReadStateSyncForTests,
} = await import("../src/store/readStateSync");
const {
  acceptActivityReadAllAck,
  hasActivityReadHold,
  resetActivityReadStateForTests,
} = await import("../src/store/activityReadState");
const { useServerStore } = await import("../src/store/serverStore");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { useThreadStore } = await import("../src/store/threadStore");

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

function makeChannelItem(
  overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {},
): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: "channel-read-state",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-2",
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: "message-1",
    lastMessageAt: "2026-07-12T00:00:00.000Z",
    lastMessagePreview: "hello @me",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "alice",
    unreadCount: 2,
    hasMention: true,
    ...overrides,
  };
}

function makeThreadItem(
  overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {},
): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "thread-read-state",
    parentMessageId: "parent-1",
    parentChannelId: "channel-parent",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent message",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "thread reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-1",
    firstUnreadMessageId: "reply-1",
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-07-12T00:00:00.000Z",
    lastReplyAt: "2026-07-12T00:00:00.000Z",
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function makeFollowedThread(overrides: Partial<FollowedThread> = {}): FollowedThread {
  return {
    threadChannelId: "thread-read-state",
    parentMessageId: "parent-1",
    parentChannelId: "channel-parent",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent message",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    replyCount: 1,
    lastReplyAt: "2026-07-12T00:00:00.000Z",
    unreadCount: 1,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function makeThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadChannelId: "thread-read-state",
    replyCount: 1,
    lastReplyAt: "2026-07-12T00:00:00.000Z",
    participantIds: ["user-2"],
    unreadCount: 1,
    firstUnreadMessageId: "reply-1",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    seq: 1,
    channelId: "channel-read-state",
    senderType: "user",
    senderId: "sender-1",
    senderName: "sender",
    content: "hello",
    createdAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function resetServerStore() {
  useServerStore.setState({
    current: {
      id: "server-read-state",
      name: "Read State",
      slug: "read-state",
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    serverEpoch: 1,
  });
}

function resetMessageStore() {
  useMessageStore.setState({
    channelMessages: {},
    channelWindowMeta: {},
    messages: [],
    highlightedMessageId: null,
    transientFocusRequest: null,
    lastSeq: 0,
    currentChannelId: null,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    loadingGap: false,
    hasMore: true,
    hasNewer: false,
    hasGap: false,
    contextLoadError: null,
    unreadCounts: {},
    mentionFlags: {},
    currentUserId: "viewer-1",
    drafts: {},
    historyLimited: false,
    isNearBottom: true,
  });
}

function resetInbox(items: InboxItem[] = []) {
  useInboxStore.setState({
    items,
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: true,
    totalCount: items.length,
    totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    scrollTop: 0,
    focusedItemKey: null,
    pendingFocusKind: null,
  });
}

function resetThreadStore(threads: FollowedThread[] = []) {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    openedAt: 0,
    summaries: {},
    followedThreads: threads,
    followOverrides: {},
    taskUpdatesByMessageId: {},
  });
}

function resetAll() {
  storage.clear();
  resetReadStateSyncForTests();
  resetActivityReadStateForTests();
  resetServerStore();
  resetMessageStore();
  resetInbox();
  resetThreadStore();
}

function socketHandler(event: string) {
  const bindings = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit() {},
      on() {},
      off() {},
      onAny() {},
      offAny() {},
      disconnect() {},
      connect() {},
    },
    () => {},
    async () => {},
    () => {},
    () => {},
  );
  const binding = bindings.find((item) => item.event === event);
  assert.ok(binding);
  return binding.handler;
}

function readStateHandler(event: "read_state:updated" | "read_state:updated_bulk") {
  return socketHandler(event);
}

function messageNewHandler() {
  return socketHandler("message:new");
}

function threadUpdatedHandler() {
  return socketHandler("thread:updated");
}

function setUnreadActivity(item: InboxItem) {
  resetInbox([item]);
  const scopeId = item.kind === "thread" ? item.threadChannelId : item.channelId;
  useMessageStore.setState({
    unreadCounts: { [scopeId]: item.unreadCount },
    mentionFlags: item.hasMention ? { [scopeId]: true } : {},
  });
}

afterEach(() => {
  api.post = originalPost as typeof api.post;
  api.get = originalGet as typeof api.get;
  resetAll();
});

test("read_state:updated clears current-user channel unread state and Activity row", () => {
  resetAll();
  const item = makeChannelItem();
  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
  });

  readStateHandler("read_state:updated")({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 42,
    readStateVersion: 1,
  });

  assert.deepEqual(useMessageStore.getState().unreadCounts, {});
  assert.deepEqual(useMessageStore.getState().mentionFlags, {});

  const updated = useInboxStore.getState().items.find((entry) => getInboxItemKey(entry) === getInboxItemKey(item));
  assert.ok(updated);
  assert.equal(updated.unreadCount, 0);
  assert.equal(updated.firstUnreadMessageId, null);
  assert.equal(updated.hasMention, false);
  assert.equal(useInboxStore.getState().totalUnreadCount, 0);
});

test("message:new releases the accepted Activity hold only beyond its read frontier", () => {
  resetAll();
  acceptActivityReadAllAck(
    { serverId: "server-read-state", principalId: "viewer-1", serverEpoch: 1, generation: 0 },
    "channel-read-state",
    { seq: 12, readStateVersion: 4 },
  );
  const handler = messageNewHandler();

  handler(makeMessage({ id: "message-at-frontier", seq: 12 }));
  assert.equal(
    hasActivityReadHold(
      { serverId: "server-read-state", principalId: "viewer-1" },
      "channel-read-state",
    ),
    true,
  );

  handler(makeMessage({ id: "message-beyond-frontier", seq: 13 }));
  assert.equal(
    hasActivityReadHold(
      { serverId: "server-read-state", principalId: "viewer-1" },
      "channel-read-state",
    ),
    false,
  );
});

test("thread:updated releases the accepted Activity hold through its real latest reply", () => {
  resetAll();
  resetThreadStore([makeFollowedThread({ threadChannelId: "thread-read-state", unreadCount: 0 })]);
  acceptActivityReadAllAck(
    { serverId: "server-read-state", principalId: "viewer-1", serverEpoch: 1, generation: 0 },
    "thread-read-state",
    { seq: 12, readStateVersion: 4 },
  );

  threadUpdatedHandler()({
    parentMessageId: "parent-1",
    threadChannelId: "thread-read-state",
    replyCount: 2,
    lastReplyAt: "2026-07-12T00:02:00.000Z",
    participantIds: ["sender-1"],
    latestReply: makeMessage({
      id: "thread-message-beyond-frontier",
      seq: 13,
      channelId: "thread-read-state",
    }),
  });

  assert.equal(
    hasActivityReadHold(
      { serverId: "server-read-state", principalId: "viewer-1" },
      "thread-read-state",
    ),
    false,
  );
});

test("read_state:updated_bulk clears channel and followed thread state without echoing a read write", () => {
  resetAll();
  const postCalls: string[] = [];
  api.post = (async (url: string) => {
    postCalls.push(url);
    return { data: {} };
  }) as typeof api.post;

  const channelItem = makeChannelItem({ channelId: "channel-read-state", unreadCount: 2 });
  const threadItem = makeThreadItem({ threadChannelId: "thread-read-state", unreadCount: 1 });
  resetInbox([channelItem, threadItem]);
  resetThreadStore([makeFollowedThread({ threadChannelId: "thread-read-state", unreadCount: 1 })]);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "channel-message-1", seq: 1, channelId: "channel-read-state" }),
      ],
      "thread-read-state": [
        makeMessage({ id: "thread-message-1", seq: 1, channelId: "thread-read-state" }),
      ],
    },
    unreadCounts: {
      "channel-read-state": 2,
      "thread-read-state": 1,
    },
    mentionFlags: {
      "channel-read-state": true,
    },
  });

  readStateHandler("read_state:updated_bulk")({
    serverId: "server-read-state",
    scopes: [
      { scopeId: "channel-read-state", maxReadSeq: 42, readStateVersion: 1 },
      { scopeId: "thread-read-state", maxReadSeq: 17, readStateVersion: 1 },
    ],
  });

  assert.deepEqual(useMessageStore.getState().unreadCounts, {});
  assert.deepEqual(useMessageStore.getState().mentionFlags, {});
  assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  assert.equal(useThreadStore.getState().followedThreads[0]?.unreadCount, 0);
  assert.deepEqual(postCalls, [], "remote read-state pushes must not POST read-all back to the server");
});

test("read_state:updated rejects stale versions after a newer read state was accepted", () => {
  resetAll();
  const item = makeChannelItem();
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
  });
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 20,
    readStateVersion: 2,
  });
  assert.equal(useInboxStore.getState().totalUnreadCount, 0);

  setUnreadActivity(item);
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 30,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
});

test("read_state:updated partially projects unread when maxReadSeq stops before newer messages", () => {
  resetAll();
  const item = makeChannelItem({
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
  });
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 1);
  assert.equal(updated?.kind === "channel" ? updated.firstUnreadMessageId : null, "message-2");
});

test("read_state:updated preserves unread summary when cache cannot prove projection", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  const unchanged = useInboxStore.getState().items[0];
  assert.equal(unchanged?.kind === "channel" ? unchanged.unreadCount : 0, 2);
  assert.equal(unchanged?.kind === "channel" ? unchanged.firstUnreadMessageId : null, "message-1");
});

test("read-state projection reports incomplete shape when cache cannot prove projection", () => {
  resetAll();

  assert.equal(
    consumeReadStateUpdate({
      serverId: "server-read-state",
      scopeId: "channel-read-state",
      maxReadSeq: 1,
      readStateVersion: 1,
    }),
    "accepted",
  );

  const projection = useMessageStore.getState().applyReadStateProjection("channel-read-state");
  assert.deepEqual(projection, {
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    complete: false,
  });
});

test("read-state fact projects later message hydration without reverting Activity", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.equal(useInboxStore.getState().totalUnreadCount, 2, "unknown cache must preserve the server snapshot");

  useMessageStore.getState().batchAddMessages([
    makeMessage({ id: "message-1", seq: 1 }),
    makeMessage({ id: "message-2", seq: 2 }),
  ]);

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 1);
  assert.equal(updated?.kind === "channel" ? updated.firstUnreadMessageId : null, "message-2");
});

test("read_state:updated preserves unread summary when loaded tail starts after the cursor gap", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-2",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-5", seq: 5 }),
      ],
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
});

test("read_state:updated preserves unread summary while newer history is missing", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
    channelWindowMeta: {
      "channel-read-state": {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: true,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
      },
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
});

test("read_state:updated preserves unread summary across a known sequence gap", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-2",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-3", seq: 3 }),
      ],
    },
    channelWindowMeta: {
      "channel-read-state": {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: false,
        hasGap: true,
        historyLimited: false,
        contextLoadError: null,
      },
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  const unchanged = useInboxStore.getState().items[0];
  assert.equal(unchanged?.kind === "channel" ? unchanged.firstUnreadMessageId : null, "message-2");
});

test("read_state:updated reprojects accepted fact after known sequence gap heals", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-2",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-3", seq: 3 }),
      ],
    },
    channelWindowMeta: {
      "channel-read-state": {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: false,
        hasGap: true,
        historyLimited: false,
        contextLoadError: null,
      },
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.equal(useInboxStore.getState().totalUnreadCount, 2, "known gap preserves server snapshot");

  useMessageStore.setState((state) => ({
    channelMessages: {
      ...state.channelMessages,
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
        makeMessage({ id: "message-3", seq: 3 }),
      ],
    },
    channelWindowMeta: {
      ...state.channelWindowMeta,
      "channel-read-state": {
        ...state.channelWindowMeta["channel-read-state"],
        loadingGap: false,
        hasGap: false,
      },
    },
  }));
  const projection = useMessageStore.getState().applyReadStateProjection("channel-read-state");

  assert.equal(projection.complete, true);
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 2);
  assert.equal(updated?.kind === "channel" ? updated.firstUnreadMessageId : null, "message-2");
});

test("addMessage preserves unread when a live gap transition makes the window incomplete", async () => {
  resetAll();
  const handler = readStateHandler("read_state:updated");
  api.get = (async (url: string) => {
    assert.ok(url.startsWith("/messages/sync?"));
    return { data: [] };
  }) as typeof api.get;
  useMessageStore.setState({
    currentChannelId: "channel-read-state",
    messages: [
      makeMessage({ id: "message-1", seq: 1 }),
    ],
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
      ],
    },
    channelWindowMeta: {
      "channel-read-state": {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: false,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
      },
    },
    isNearBottom: false,
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.deepEqual(useMessageStore.getState().unreadCounts, {});

  useMessageStore.getState().addMessage(makeMessage({ id: "message-3", seq: 3 }));

  const stateAfterGap = useMessageStore.getState();
  assert.equal(stateAfterGap.hasGap, true);
  assert.equal(stateAfterGap.channelWindowMeta["channel-read-state"]?.hasGap, true);
  assert.equal(stateAfterGap.unreadCounts["channel-read-state"], 1);

  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("read_state:updated reprojects accepted fact for a later single live message", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);

  useMessageStore.getState().addMessage(makeMessage({ id: "message-2", seq: 2 }));

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 1);
  assert.equal(updated?.kind === "channel" ? updated.firstUnreadMessageId : null, "message-2");
});

test("read_state:updated keeps a late live message read when it is covered by accepted cursor", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 1,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
      ],
    },
  });
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 3,
    readStateVersion: 1,
  });
  assert.deepEqual(useMessageStore.getState().unreadCounts, {});

  useMessageStore.getState().addMessage(makeMessage({ id: "message-2", seq: 2 }));

  assert.deepEqual(useMessageStore.getState().unreadCounts, {});
  assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : -1, 0);
});

test("loadUnreadCounts applies server summary when accepted projection predates the request", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  useMessageStore.getState().addMessage(makeMessage({ id: "message-2", seq: 2 }));
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);

  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return {
      data: {
        channels: {
          "channel-read-state": {
            unreadCount: 4,
            hasMention: true,
          },
        },
      },
    };
  }) as typeof api.get;

  await useMessageStore.getState().loadUnreadCounts();

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 4);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 1);
  assert.equal(updated?.kind === "channel" ? updated.hasMention : true, false);
});

test("loadUnreadCounts applies server summary when no accepted read state exists", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 0,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    hasMention: false,
  });

  setUnreadActivity(item);
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return {
      data: {
        channels: {
          "channel-read-state": {
            unreadCount: 4,
            hasMention: true,
          },
        },
      },
    };
  }) as typeof api.get;

  await useMessageStore.getState().loadUnreadCounts();

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 4);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
});

test("loadUnreadCounts is a no-op without a current server", async () => {
  resetAll();
  let requested = false;
  useServerStore.setState({ current: null });
  api.get = (async () => {
    requested = true;
    return { data: {} };
  }) as typeof api.get;

  await useMessageStore.getState().loadUnreadCounts();

  assert.equal(requested, false);
});

test("loadUnreadCounts applies server summary when accepted read state predates the request", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });

  setUnreadActivity(item);
  assert.equal(
    consumeReadStateUpdate({
      serverId: "server-read-state",
      scopeId: "channel-read-state",
      maxReadSeq: 1,
      readStateVersion: 1,
    }),
    "accepted",
  );
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return {
      data: {
        channels: {
          "channel-read-state": {
            unreadCount: 4,
            hasMention: true,
          },
        },
      },
    };
  }) as typeof api.get;

  await useMessageStore.getState().loadUnreadCounts();

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 4);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
});

test("loadUnreadCounts applies server summary when accepted read state predates the request with complete cache", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
  });
  assert.equal(
    consumeReadStateUpdate({
      serverId: "server-read-state",
      scopeId: "channel-read-state",
      maxReadSeq: 1,
      readStateVersion: 1,
    }),
    "accepted",
  );
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return {
      data: {
        channels: {
          "channel-read-state": {
            unreadCount: 4,
            hasMention: true,
          },
        },
      },
    };
  }) as typeof api.get;

  await useMessageStore.getState().loadUnreadCounts();

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 4);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
});

test("read_state:updated prevents an in-flight unread summary from rolling back a newer accepted fact", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");
  let resolveUnread: ((value: { data: unknown }) => void) | null = null;

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
  });
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return new Promise<{ data: unknown }>((resolve) => {
      resolveUnread = resolve;
    });
  }) as typeof api.get;

  const pendingLoad = useMessageStore.getState().loadUnreadCounts();
  await Promise.resolve();
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);

  assert.ok(resolveUnread);
  resolveUnread({
    data: {
      channels: {
        "channel-read-state": {
          unreadCount: 2,
          hasMention: true,
        },
      },
    },
  });
  await pendingLoad;

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.deepEqual(useMessageStore.getState().mentionFlags, {});
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 1);
  assert.equal(updated?.kind === "channel" ? updated.hasMention : true, false);
});

test("loadUnreadCounts reprojects a complete cache when accepted read state changes during request", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  let resolveUnread: ((value: { data: unknown }) => void) | null = null;

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-2", seq: 2 }),
      ],
    },
  });
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return new Promise<{ data: unknown }>((resolve) => {
      resolveUnread = resolve;
    });
  }) as typeof api.get;

  const pendingLoad = useMessageStore.getState().loadUnreadCounts();
  await Promise.resolve();
  assert.equal(
    consumeReadStateUpdate({
      serverId: "server-read-state",
      scopeId: "channel-read-state",
      maxReadSeq: 1,
      readStateVersion: 1,
    }),
    "accepted",
  );
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);

  assert.ok(resolveUnread);
  resolveUnread({
    data: {
      channels: {
        "channel-read-state": {
          unreadCount: 4,
          hasMention: true,
        },
      },
    },
  });
  await pendingLoad;

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.deepEqual(useMessageStore.getState().mentionFlags, {});
});

test("read_state:updated preserves current unread summary when in-flight summary races an incomplete cache", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");
  let resolveUnread: ((value: { data: unknown }) => void) | null = null;

  setUnreadActivity(item);
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return new Promise<{ data: unknown }>((resolve) => {
      resolveUnread = resolve;
    });
  }) as typeof api.get;

  const pendingLoad = useMessageStore.getState().loadUnreadCounts();
  await Promise.resolve();
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);

  assert.ok(resolveUnread);
  resolveUnread({
    data: {
      channels: {
        "channel-read-state": {
          unreadCount: 4,
          hasMention: true,
        },
      },
    },
  });
  await pendingLoad;

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.deepEqual(useMessageStore.getState().mentionFlags, {});
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 2);
  assert.equal(updated?.kind === "channel" ? updated.hasMention : true, false);
});

test("read_state:updated preserves current mention when in-flight summary races an incomplete cache", async () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 2,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: "message-1",
    hasMention: true,
  });
  const handler = readStateHandler("read_state:updated");
  let resolveUnread: ((value: { data: unknown }) => void) | null = null;

  setUnreadActivity(item);
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/unread");
    return new Promise<{ data: unknown }>((resolve) => {
      resolveUnread = resolve;
    });
  }) as typeof api.get;

  const pendingLoad = useMessageStore.getState().loadUnreadCounts();
  await Promise.resolve();
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);

  assert.ok(resolveUnread);
  resolveUnread({
    data: {
      channels: {
        "channel-read-state": {
          unreadCount: 4,
          hasMention: false,
        },
      },
    },
  });
  await pendingLoad;

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 2);
  assert.equal(updated?.kind === "channel" ? updated.hasMention : false, true);
});

test("read_state:updated excludes self-authored messages from projected unread", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 3,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    hasMention: false,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-1", seq: 1 }),
        makeMessage({ id: "message-self-user", seq: 2, senderType: "user", senderId: "viewer-1" }),
        makeMessage({ id: "message-agent-same-id", seq: 3, senderType: "agent", senderId: "viewer-1" }),
        makeMessage({ id: "message-other-user", seq: 4, senderType: "user", senderId: "other-user" }),
      ],
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.unreadCount : 0, 2);
  assert.equal(updated?.kind === "channel" ? updated.firstUnreadMessageId : null, "message-agent-same-id");
});

test("read_state:updated projects only current-user mentions from unread cached messages", () => {
  resetAll();
  const item = makeChannelItem({
    firstMentionMessageId: "message-old",
    hasMention: true,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({
          id: "message-agent-same-id",
          seq: 2,
          mentions: [{ type: "agent", id: "viewer-1", name: "viewer-agent" }],
        }),
        makeMessage({
          id: "message-user-other-id",
          seq: 3,
          mentions: [{ type: "user", id: "viewer-2", name: "viewer-two" }],
        }),
        makeMessage({
          id: "message-current-user",
          seq: 4,
          mentions: [
            { type: "agent", id: "viewer-2", name: "viewer-two-agent" },
            { type: "user", id: "viewer-1", name: "viewer-one" },
          ],
        }),
      ],
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 3);
  assert.equal(useMessageStore.getState().mentionFlags["channel-read-state"], true);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.hasMention : false, true);
  assert.equal(updated?.kind === "channel" ? updated.firstMentionMessageId : null, "message-current-user");
});

test("read_state:updated clears mention projection when no current user is known", () => {
  resetAll();
  const item = makeChannelItem({
    firstMentionMessageId: "message-old",
    hasMention: true,
  });
  const handler = readStateHandler("read_state:updated");

  setUnreadActivity(item);
  useMessageStore.setState({
    currentUserId: null,
    channelMessages: {
      "channel-read-state": [
        makeMessage({
          id: "message-mention",
          seq: 2,
          mentions: [{ type: "user", id: "viewer-1", name: "viewer-one" }],
        }),
      ],
    },
  });

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 1,
    readStateVersion: 1,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.deepEqual(useMessageStore.getState().mentionFlags, {});
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.hasMention : true, false);
  assert.equal(updated?.kind === "channel" ? updated.firstMentionMessageId : "unexpected", null);
});

test("read_state:updated applies higher-version mark-unread cursor rewind", () => {
  resetAll();
  const item = makeChannelItem({
    unreadCount: 0,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    hasMention: false,
  });
  resetInbox([item]);
  const handler = readStateHandler("read_state:updated");

  useMessageStore.setState({
    channelMessages: {
      "channel-read-state": [
        makeMessage({ id: "message-42", seq: 42 }),
      ],
    },
    unreadCounts: {},
    mentionFlags: {},
  });
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 42,
    readStateVersion: 1,
  });
  assert.equal(useInboxStore.getState().totalUnreadCount, 0);

  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 41,
    readStateVersion: 2,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 1);
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  const updated = useInboxStore.getState().items[0];
  assert.equal(updated?.kind === "channel" ? updated.firstUnreadMessageId : null, "message-42");
});

test("read_state:updated_bulk only updates the targeted followed thread projection", () => {
  resetAll();
  const targetThread = makeThreadItem({
    threadChannelId: "thread-target",
    unreadCount: 2,
    firstUnreadMessageId: "reply-1",
  });
  const otherThread = makeThreadItem({
    threadChannelId: "thread-other",
    unreadCount: 7,
    firstUnreadMessageId: "other-reply",
  });
  resetInbox([targetThread, otherThread]);
  resetThreadStore([
    makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 2 }),
    makeFollowedThread({ threadChannelId: "thread-other", unreadCount: 7 }),
  ]);
  useMessageStore.setState({
    channelMessages: {
      "thread-target": [
        makeMessage({ id: "reply-1", channelId: "thread-target", seq: 1 }),
        makeMessage({ id: "reply-2", channelId: "thread-target", seq: 2 }),
      ],
      "thread-other": [
        makeMessage({ id: "other-reply", channelId: "thread-other", seq: 1 }),
      ],
    },
    unreadCounts: {
      "thread-target": 2,
      "thread-other": 7,
    },
  });

  readStateHandler("read_state:updated_bulk")({
    serverId: "server-read-state",
    scopes: [
      { scopeId: "thread-target", maxReadSeq: 1, readStateVersion: 1 },
    ],
  });

  assert.equal(useMessageStore.getState().unreadCounts["thread-target"], 1);
  assert.equal(useMessageStore.getState().unreadCounts["thread-other"], 7);
  const followedThreads = useThreadStore.getState().followedThreads;
  assert.equal(followedThreads.find((t) => t.threadChannelId === "thread-target")?.unreadCount, 1);
  assert.equal(followedThreads.find((t) => t.threadChannelId === "thread-other")?.unreadCount, 7);
  assert.equal(useInboxStore.getState().items.find((entry) => entry.kind === "thread" && entry.threadChannelId === "thread-target")?.unreadCount, 1);
  assert.equal(useInboxStore.getState().items.find((entry) => entry.kind === "thread" && entry.threadChannelId === "thread-other")?.unreadCount, 7);
});

test("thread local clear only clears the targeted followed thread", () => {
  resetAll();
  resetThreadStore([
    makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 3 }),
    makeFollowedThread({ threadChannelId: "thread-other", unreadCount: 5 }),
  ]);

  useThreadStore.getState().clearThreadUnreadLocally("thread-target");

  const followedThreads = useThreadStore.getState().followedThreads;
  assert.equal(followedThreads.find((t) => t.threadChannelId === "thread-target")?.unreadCount, 0);
  assert.equal(followedThreads.find((t) => t.threadChannelId === "thread-other")?.unreadCount, 5);
});

function serveFollowedThreads(rows: Array<FollowedThread & { maxReadSeq?: number; readStateVersion?: number }>) {
  api.get = (async () => ({ data: { threads: rows } })) as typeof api.get;
}

test("a followed-list reload does not bring back unread the client just read (no newer activity)", async () => {
  resetAll();
  resetThreadStore([makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 3, latestActivitySeq: "9" })]);
  useThreadStore.getState().clearThreadUnreadLocally("thread-target");

  // RisingWave has not ingested the read yet: the served row is the old one.
  serveFollowedThreads([makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 3, latestActivitySeq: "9" })]);
  await useThreadStore.getState().loadFollowedThreads();

  assert.equal(useThreadStore.getState().followedThreads[0]?.unreadCount, 0);
});

test("a followed-list reload older than the accepted read cursor is adjudicated read", async () => {
  resetAll();
  resetThreadStore([makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 3, latestActivitySeq: "9" })]);
  readStateHandler("read_state:updated")({
    serverId: "server-read-state",
    scopeId: "thread-target",
    maxReadSeq: 9,
    readStateVersion: 2,
  });

  serveFollowedThreads([makeFollowedThread({
    threadChannelId: "thread-target",
    unreadCount: 3,
    latestActivitySeq: "9",
    hasMention: true,
    maxReadSeq: 4,
    readStateVersion: 1,
  })]);
  await useThreadStore.getState().loadFollowedThreads();

  const [thread] = useThreadStore.getState().followedThreads;
  assert.equal(thread?.unreadCount, 0);
  assert.equal(thread?.hasMention, false);
});

test("a followed-list reload keeps unread that arrived after the read", async () => {
  resetAll();
  resetThreadStore([makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 3, latestActivitySeq: "9" })]);
  readStateHandler("read_state:updated")({
    serverId: "server-read-state",
    scopeId: "thread-target",
    maxReadSeq: 9,
    readStateVersion: 2,
  });
  useThreadStore.getState().clearThreadUnreadLocally("thread-target");

  serveFollowedThreads([makeFollowedThread({
    threadChannelId: "thread-target",
    unreadCount: 1,
    latestActivitySeq: "10",
    maxReadSeq: 9,
    readStateVersion: 1,
  })]);
  await useThreadStore.getState().loadFollowedThreads();

  assert.equal(useThreadStore.getState().followedThreads[0]?.unreadCount, 1);
});

test("opening a thread clears its inline summary unread label immediately", () => {
  resetAll();
  api.post = (() => new Promise(() => {})) as typeof api.post;
  useThreadStore.setState({
    summaries: {
      "parent-target": makeThreadSummary({
        threadChannelId: "thread-target",
        unreadCount: 3,
        firstUnreadMessageId: "reply-target",
      }),
      "parent-count-only": makeThreadSummary({
        threadChannelId: "thread-target",
        unreadCount: 2,
        firstUnreadMessageId: null,
      }),
      "parent-anchor-only": makeThreadSummary({
        threadChannelId: "thread-target",
        unreadCount: 0,
        firstUnreadMessageId: "reply-stale-anchor",
      }),
      "parent-other": makeThreadSummary({
        threadChannelId: "thread-other",
        unreadCount: 5,
        firstUnreadMessageId: "reply-other",
      }),
    },
  });
  const before = useThreadStore.getState().summaries;
  const beforeTarget = before["parent-target"];
  const beforeOther = before["parent-other"];

  useThreadStore.getState().clearThreadUnread("thread-target");

  const summaries = useThreadStore.getState().summaries;
  assert.notEqual(summaries, before);
  assert.notEqual(summaries["parent-target"], beforeTarget);
  assert.equal(summaries["parent-other"], beforeOther);
  assert.equal(beforeTarget?.unreadCount, 3, "the optimistic projection must not mutate the prior store snapshot");
  assert.equal(summaries["parent-target"]?.unreadCount, 0);
  assert.equal(summaries["parent-target"]?.firstUnreadMessageId, null);
  assert.equal(summaries["parent-count-only"]?.unreadCount, 0);
  assert.equal(summaries["parent-count-only"]?.firstUnreadMessageId, null);
  assert.equal(summaries["parent-anchor-only"]?.unreadCount, 0);
  assert.equal(summaries["parent-anchor-only"]?.firstUnreadMessageId, null);
  assert.equal(summaries["parent-other"]?.unreadCount, 5);
  assert.equal(summaries["parent-other"]?.firstUnreadMessageId, "reply-other");
});

test("thread local clear is a no-op when the target has no unread state", () => {
  resetAll();
  resetThreadStore([
    makeFollowedThread({ threadChannelId: "thread-target", unreadCount: 0 }),
    makeFollowedThread({ threadChannelId: "thread-other", unreadCount: 5 }),
  ]);
  useThreadStore.setState({
    summaries: {
      "parent-target": makeThreadSummary({
        threadChannelId: "thread-target",
        unreadCount: 0,
        firstUnreadMessageId: null,
      }),
    },
  });
  const stateBefore = useThreadStore.getState();
  const before = useThreadStore.getState().followedThreads;

  useThreadStore.getState().clearThreadUnreadLocally("thread-target");

  assert.equal(useThreadStore.getState(), stateBefore);
  assert.equal(useThreadStore.getState().followedThreads, before);
});

test("read_state:updated ignores other-server and malformed payloads", () => {
  resetAll();
  const item = makeChannelItem();
  setUnreadActivity(item);
  const handler = readStateHandler("read_state:updated");

  handler({
    serverId: "server-other",
    scopeId: "channel-read-state",
    maxReadSeq: 42,
    readStateVersion: 1,
  });
  handler({
    serverId: "server-read-state",
    scopeId: "channel-read-state",
    maxReadSeq: 43,
  });

  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 2);
  assert.equal(useInboxStore.getState().totalUnreadCount, 2);
});

test("read-state normalizers reject malformed single-update payloads", () => {
  resetAll();

  assert.equal(normalizeReadStateUpdated(null), null);
  assert.equal(normalizeReadStateUpdated("bad"), null);
  assert.equal(normalizeReadStateUpdated(Object.assign(() => {}, {
    serverId: "server-1",
    scopeId: "channel-1",
    maxReadSeq: 1,
    readStateVersion: 1,
  })), null);
  assert.equal(normalizeReadStateUpdated({}), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "", scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: 123, scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: "", maxReadSeq: 1, readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: 123, maxReadSeq: 1, readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: -1, readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 1.5, readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: "1", readStateVersion: 1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 1, readStateVersion: -1 }), null);
  assert.equal(normalizeReadStateUpdated({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 1.5 }), null);

  assert.deepEqual(
    normalizeReadStateUpdated({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 0, readStateVersion: 0 }),
    { serverId: "server-1", scopeId: "channel-1", maxReadSeq: 0, readStateVersion: 0 },
  );
});

test("read-state bulk normalizer filters invalid scopes and rejects invalid envelopes", () => {
  resetAll();

  assert.deepEqual(normalizeReadStateUpdatedBulk(null), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk("bad"), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk(Object.assign(() => {}, {
    serverId: "server-1",
    scopes: [{ scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 2 }],
  })), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk({}), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk({
    serverId: "",
    scopes: [{ scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 2 }],
  }), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk({
    serverId: 123,
    scopes: [{ scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 2 }],
  }), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk({ serverId: "server-1" }), []);
  assert.deepEqual(normalizeReadStateUpdatedBulk({ serverId: "server-1", scopes: "bad" }), []);

  assert.deepEqual(
    normalizeReadStateUpdatedBulk({
      serverId: "server-1",
      scopes: [
        { scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 2 },
        null,
        Object.assign(() => {}, { scopeId: "channel-function", maxReadSeq: 1, readStateVersion: 2 }),
        { scopeId: "", maxReadSeq: 1, readStateVersion: 2 },
        { scopeId: "channel-2", maxReadSeq: "1", readStateVersion: 2 },
      ],
    }),
    [{ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 2 }],
  );
});

test("read-state consumer reports exact monotonic outcomes", () => {
  resetAll();

  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 10, readStateVersion: 1 }),
    "accepted",
  );
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 10, readStateVersion: 1 }),
    "stale",
  );
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 9, readStateVersion: 2 }),
    "accepted",
    "a higher-version mark-unread cursor rewind is the newest read-state fact",
  );
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 10, readStateVersion: 3 }),
    "accepted",
    "equal maxReadSeq with newer version still acknowledges a valid same-cursor read state",
  );
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 11, readStateVersion: 4 }),
    "accepted",
  );
});

test("read-state generation predicate reports only scopes changed after the captured ledger", () => {
  resetAll();
  const before = getReadStateLedgerGeneration();

  assert.equal(hasAcceptedReadStateChangedAfter(null, "channel-1", before), false);
  assert.equal(hasAcceptedReadStateChangedAfter("server-1", "missing", before), false);
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 10, readStateVersion: 1 }),
    "accepted",
  );
  assert.equal(hasAcceptedReadStateChangedAfter("server-1", "channel-1", before), true);

  const afterFirst = getReadStateLedgerGeneration();
  assert.equal(hasAcceptedReadStateChangedAfter("server-1", "channel-1", afterFirst), false);
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 11, readStateVersion: 1 }),
    "stale",
  );
  assert.equal(hasAcceptedReadStateChangedAfter("server-1", "channel-1", afterFirst), false);
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 9, readStateVersion: 2 }),
    "accepted",
  );
  assert.equal(hasAcceptedReadStateChangedAfter("server-1", "channel-1", afterFirst), true);
});

test("server reset clears accepted read-state watermarks", () => {
  resetAll();

  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 10, readStateVersion: 2 }),
    "accepted",
  );
  triggerServerReset();
  assert.equal(
    consumeReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 1, readStateVersion: 1 }),
    "accepted",
  );
});

// ── Channel thread badges from the server's unread count (task #9) ──

function seedThreadBadge(threadChannelId: string, unreadCount = 3) {
  useThreadStore.setState({
    summaries: {
      [`parent-${threadChannelId}`]: {
        threadChannelId,
        replyCount: 3,
        lastReplyAt: "2026-07-12T00:00:03.000Z",
        participantIds: [],
        unreadCount,
        firstUnreadMessageId: `${threadChannelId}-reply-1`,
      },
    },
    followedThreads: [makeFollowedThread({ threadChannelId, unreadCount })],
  });
}

function badge(threadChannelId: string) {
  return useThreadStore.getState().summaries[`parent-${threadChannelId}`];
}

test("a thread read elsewhere clears the channel badge from the server count without fetching", () => {
  resetAll();
  seedThreadBadge("thread-elsewhere");
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    return { data: {} };
  }) as typeof api.get;

  readStateHandler("read_state:updated")({
    serverId: "server-read-state",
    scopeId: "thread-elsewhere",
    maxReadSeq: 9,
    readStateVersion: 1,
    unreadCount: 0,
  });

  assert.equal(badge("thread-elsewhere")?.unreadCount, 0);
  assert.equal(badge("thread-elsewhere")?.firstUnreadMessageId, null);
  assert.equal(useThreadStore.getState().followedThreads[0]?.unreadCount, 0);
  assert.deepEqual(getCalls, []);
});

test("mark all read clears every unloaded thread badge from the bulk counts", () => {
  resetAll();
  useThreadStore.setState({
    summaries: Object.fromEntries(["t1", "t2", "t3"].map((id) => [`parent-${id}`, {
      threadChannelId: id,
      replyCount: 2,
      lastReplyAt: null,
      participantIds: [],
      unreadCount: 2,
      firstUnreadMessageId: `${id}-reply-1`,
    }])),
  });

  readStateHandler("read_state:updated_bulk")({
    serverId: "server-read-state",
    scopes: ["t1", "t2", "t3"].map((scopeId) => ({ scopeId, maxReadSeq: 9, readStateVersion: 1, unreadCount: 0 })),
  });

  for (const id of ["t1", "t2", "t3"]) assert.equal(badge(id)?.unreadCount, 0, id);
});

test("a partial read elsewhere shows the remaining count and keeps the jump target", () => {
  resetAll();
  seedThreadBadge("thread-partial", 5);

  readStateHandler("read_state:updated")({
    serverId: "server-read-state",
    scopeId: "thread-partial",
    maxReadSeq: 4,
    readStateVersion: 1,
    unreadCount: 2,
  });

  assert.equal(badge("thread-partial")?.unreadCount, 2);
  assert.equal(badge("thread-partial")?.firstUnreadMessageId, "thread-partial-reply-1");
});

test("an older read-state count never overwrites a newer one", () => {
  resetAll();
  seedThreadBadge("thread-order");
  const handler = readStateHandler("read_state:updated");

  handler({ serverId: "server-read-state", scopeId: "thread-order", maxReadSeq: 9, readStateVersion: 2, unreadCount: 0 });
  handler({ serverId: "server-read-state", scopeId: "thread-order", maxReadSeq: 4, readStateVersion: 1, unreadCount: 2 });

  assert.equal(badge("thread-order")?.unreadCount, 0);
});

test("a read-state event without a count (older server) leaves an unprojectable badge as it was", () => {
  resetAll();
  seedThreadBadge("thread-legacy");

  readStateHandler("read_state:updated")({
    serverId: "server-read-state",
    scopeId: "thread-legacy",
    maxReadSeq: 9,
    readStateVersion: 1,
  });

  assert.equal(badge("thread-legacy")?.unreadCount, 3);
});

test("a malformed unread count is dropped without rejecting the read fact", () => {
  resetAll();
  const update = normalizeReadStateUpdated({
    serverId: "server-read-state",
    scopeId: "thread-malformed",
    maxReadSeq: 9,
    readStateVersion: 1,
    unreadCount: -1,
  });
  assert.deepEqual(update, { serverId: "server-read-state", scopeId: "thread-malformed", maxReadSeq: 9, readStateVersion: 1 });
  assert.deepEqual(
    normalizeReadStateUpdatedBulk({
      serverId: "server-read-state",
      scopes: [{ scopeId: "t", maxReadSeq: 9, readStateVersion: 1, unreadCount: 0 }],
    }),
    [{ serverId: "server-read-state", scopeId: "t", maxReadSeq: 9, readStateVersion: 1, unreadCount: 0 }],
  );
});

test("a server count never raises a badge: an unfollowed thread at 0 stays 0", () => {
  resetAll();
  seedThreadBadge("thread-unfollowed", 0);
  seedThreadBadgeAlso("thread-own-replies", 1);

  const handler = readStateHandler("read_state:updated");
  handler({ serverId: "server-read-state", scopeId: "thread-unfollowed", maxReadSeq: 4, readStateVersion: 1, unreadCount: 3 });
  handler({ serverId: "server-read-state", scopeId: "thread-own-replies", maxReadSeq: 4, readStateVersion: 1, unreadCount: 2 });

  assert.equal(badge("thread-unfollowed")?.unreadCount, 0);
  assert.equal(badge("thread-own-replies")?.unreadCount, 1, "a different count algorithm must not bounce the badge up");
  assert.equal(
    useThreadStore.getState().followedThreads.find((t) => t.threadChannelId === "thread-unfollowed")?.unreadCount,
    0,
  );
});

function seedThreadBadgeAlso(threadChannelId: string, unreadCount: number) {
  const { summaries, followedThreads } = useThreadStore.getState();
  useThreadStore.setState({
    summaries: {
      ...summaries,
      [`parent-${threadChannelId}`]: {
        threadChannelId,
        replyCount: 3,
        lastReplyAt: null,
        participantIds: [],
        unreadCount,
        firstUnreadMessageId: null,
      },
    },
    followedThreads: [...followedThreads, makeFollowedThread({ threadChannelId, unreadCount })],
  });
}

test("replies into threads missing from the followed list share one coalesced list reload", async () => {
  const { vi } = await import("vitest");
  const { __cancelFollowedThreadsRefreshForTests } = await import("../src/store/socketBridge");
  resetAll();
  __cancelFollowedThreadsRefreshForTests();
  const followedLoads: string[] = [];
  const realLoadFollowedThreads = useThreadStore.getState().loadFollowedThreads;
  useThreadStore.setState({
    loadFollowedThreads: async () => { followedLoads.push("load"); },
  });
  vi.useFakeTimers();
  try {
    for (let i = 0; i < 5; i += 1) {
      threadUpdatedHandler()({
        parentMessageId: `parent-burst-${i}`,
        threadChannelId: `thread-burst-${i}`,
        replyCount: 1,
        lastReplyAt: "2026-10-16T06:00:00.000Z",
        participantIds: ["sender-1"],
        latestReply: makeMessage({ id: `burst-reply-${i}`, seq: 20 + i, channelId: `thread-burst-${i}` }),
      });
    }
    assert.equal(followedLoads.length, 0, "no reload per reply");
    await vi.advanceTimersByTimeAsync(1500);
    assert.equal(followedLoads.length, 1, "one reload for the burst");
  } finally {
    vi.useRealTimers();
    __cancelFollowedThreadsRefreshForTests();
    useThreadStore.setState({ loadFollowedThreads: realLoadFollowedThreads });
  }
});

test("the followed-thread list loads only the threads with unread replies", async () => {
  resetAll();
  const calls: Array<{ url: string; params?: unknown }> = [];
  api.get = (async (url: string, config?: { params?: unknown }) => {
    calls.push({ url, params: config?.params });
    return { data: { threads: [makeFollowedThread({ threadChannelId: "thread-unread", unreadCount: 2 })] } };
  }) as typeof api.get;

  await useThreadStore.getState().loadFollowedThreads();

  assert.deepEqual(calls, [{ url: "/channels/threads/followed", params: { unreadOnly: 1 } }]);
  assert.deepEqual(useThreadStore.getState().followedThreads.map((t) => t.threadChannelId), ["thread-unread"]);
});

test("reading a thread lowers its channel's thread badge right away, before the next list load", async () => {
  const { summarizeParentThreadUnread } = await import("../src/utils/threadUnreadByParent");
  resetAll();
  resetThreadStore([
    makeFollowedThread({ threadChannelId: "thread-a", parentMessageId: "parent-a", parentChannelId: "general", unreadCount: 2 }),
    makeFollowedThread({ threadChannelId: "thread-b", parentMessageId: "parent-b", parentChannelId: "general", unreadCount: 1 }),
  ]);
  assert.equal(summarizeParentThreadUnread(useThreadStore.getState().followedThreads, "general").count, 2);

  useThreadStore.getState().clearThreadUnreadLocally("thread-a");

  assert.equal(summarizeParentThreadUnread(useThreadStore.getState().followedThreads, "general").count, 1);
});

test("follow state: a session follow/unfollow wins, then the summary, then the unread list", async () => {
  const { isThreadFollowed } = await import("../src/store/threadStore");
  resetAll();
  resetThreadStore([makeFollowedThread({ threadChannelId: "thread-listed", parentMessageId: "parent-listed" })]);
  useThreadStore.setState({
    summaries: {
      "parent-read-followed": makeThreadSummary({ threadChannelId: "thread-read-followed", unreadCount: 0, followed: true }),
      "parent-not-followed": makeThreadSummary({ threadChannelId: "thread-not-followed", followed: false }),
    },
  });
  const state = () => useThreadStore.getState();

  // A read followed thread is not in the unread-only list; the summary says it is followed.
  assert.equal(isThreadFollowed(state(), "parent-read-followed"), true);
  assert.equal(isThreadFollowed(state(), "parent-not-followed"), false);
  // No summary (older server): fall back to the list.
  assert.equal(isThreadFollowed(state(), "parent-listed"), true);
  assert.equal(isThreadFollowed(state(), "parent-unknown"), false);

  useThreadStore.setState({ followOverrides: { "parent-read-followed": false, "parent-not-followed": true } });
  assert.equal(isThreadFollowed(state(), "parent-read-followed"), false);
  assert.equal(isThreadFollowed(state(), "parent-not-followed"), true);
});

test("a live summary without `followed` keeps the follow state already known", () => {
  resetAll();
  useThreadStore.setState({
    summaries: { "parent-1": makeThreadSummary({ unreadCount: 0, followed: true }) },
  });

  // thread:updated frames carry no `followed`.
  useThreadStore.getState().updateSummary("parent-1", makeThreadSummary({ replyCount: 2, unreadCount: 1 }));
  assert.equal(useThreadStore.getState().summaries["parent-1"]?.followed, true);
  assert.equal(useThreadStore.getState().summaries["parent-1"]?.replyCount, 2);

  useThreadStore.getState().hydrateSummaries({ "parent-1": makeThreadSummary({ replyCount: 3 }) });
  assert.equal(useThreadStore.getState().summaries["parent-1"]?.followed, true);

  // A summary that does say it is no longer followed is taken.
  useThreadStore.getState().hydrateSummaries({ "parent-1": makeThreadSummary({ followed: false }) });
  assert.equal(useThreadStore.getState().summaries["parent-1"]?.followed, false);
});

test("follow and unfollow record the session follow state for the parent message", async () => {
  const { isThreadFollowed } = await import("../src/store/threadStore");
  resetAll();
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async () => ({ data: { threads: [] } })) as typeof api.get;
  useThreadStore.setState({
    summaries: { "parent-quiet": makeThreadSummary({ threadChannelId: "thread-quiet", unreadCount: 0, followed: false }) },
  });

  await useThreadStore.getState().followThread("parent-quiet");
  // The thread has no unread replies, so the reloaded unread-only list does not have it.
  assert.equal(useThreadStore.getState().followedThreads.length, 0);
  assert.equal(isThreadFollowed(useThreadStore.getState(), "parent-quiet"), true);

  await useThreadStore.getState().unfollowThread("thread-quiet");
  assert.equal(isThreadFollowed(useThreadStore.getState(), "parent-quiet"), false);
});

test("sidebar conversation HTTP receipts share read ingress and preserve arrivals beyond the captured frontier", async () => {
  resetAll();
  const originalLoadUnread = useMessageStore.getState().loadUnreadCounts;
  const originalLoadThreads = useThreadStore.getState().loadFollowedThreads;
  const refreshed: string[] = [];
  useMessageStore.setState({ loadUnreadCounts: async () => { refreshed.push("channels"); } });
  useThreadStore.setState({ loadFollowedThreads: async () => { refreshed.push("threads"); } });
  const parent = "channel-read-state";
  const thread = "thread-read-state";
  const other = "other-thread";
  resetInbox([makeChannelItem(), makeThreadItem()]);
  resetThreadStore([makeFollowedThread(), makeFollowedThread({ threadChannelId: other, unreadCount: 4 })]);
  useMessageStore.setState({
    channelMessages: {
      [parent]: [makeMessage({ id: "p1", channelId: parent, seq: 1 })],
      [thread]: [
        makeMessage({ id: "t1", channelId: thread, seq: 1 }),
        makeMessage({ id: "t2", channelId: thread, seq: 2 }),
        makeMessage({ id: "t3-after-snapshot", channelId: thread, seq: 3 }),
      ],
    },
    unreadCounts: { [parent]: 1, [thread]: 3, [other]: 4 },
  });
  api.post = (async (url: string) => {
    assert.equal(url, `/channels/${parent}/conversation-read-all`);
    return { data: { serverId: "server-read-state", scopes: [
      { scopeId: parent, maxReadSeq: 1, readStateVersion: 1 },
      { scopeId: thread, maxReadSeq: 2, readStateVersion: 1 },
    ] } };
  }) as typeof api.post;
  try {
    await useMessageStore.getState().markConversationRead(parent);
    assert.equal(useMessageStore.getState().unreadCounts[parent], undefined);
    assert.equal(useMessageStore.getState().unreadCounts[thread], 1);
    assert.equal(useThreadStore.getState().followedThreads.find((row) => row.threadChannelId === thread)?.unreadCount, 1);
    assert.equal(useThreadStore.getState().followedThreads.find((row) => row.threadChannelId === other)?.unreadCount, 4);
    assert.deepEqual(refreshed.sort(), ["channels", "threads"]);
  } finally {
    useMessageStore.setState({ loadUnreadCounts: originalLoadUnread });
    useThreadStore.setState({ loadFollowedThreads: originalLoadThreads });
  }
});

test("sidebar conversation read response after switching server cannot touch the new server or trigger refresh", async () => {
  resetAll();
  let resolveResponse!: (value: { data: unknown }) => void;
  api.post = (() => new Promise((resolve) => { resolveResponse = resolve; })) as typeof api.post;
  const operation = useMessageStore.getState().markConversationRead("channel-read-state");
  useServerStore.setState({ current: { ...useServerStore.getState().current!, id: "new-server" }, serverEpoch: 2 });
  useMessageStore.setState({ unreadCounts: { "channel-read-state": 7 } });
  resolveResponse({ data: { serverId: "server-read-state", scopes: [
    { scopeId: "channel-read-state", maxReadSeq: 99, readStateVersion: 1 },
  ] } });
  await operation;
  assert.equal(useMessageStore.getState().unreadCounts["channel-read-state"], 7);
});


test("late read-all zero cannot erase a newer known reply in an unloaded followed thread", () => {
  resetAll();
  resetThreadStore([makeFollowedThread({ unreadCount: 2, latestActivitySeq: "3" })]);
  readStateHandler("read_state:updated_bulk")({
    serverId: "server-read-state",
    scopes: [{ scopeId: "thread-read-state", maxReadSeq: 2, readStateVersion: 1, unreadCount: 0 }],
  });
  assert.equal(useThreadStore.getState().followedThreads[0].unreadCount, 2);
});

test("conversation All Read clears an unopened root despite a lagging positive summary", async () => {
  resetAll();
  const root = "unopened-all-read-root";
  const originalGet = api.get;
  const originalLoadThreads = useThreadStore.getState().loadFollowedThreads;
  useThreadStore.setState({ loadFollowedThreads: async () => {} });
  useMessageStore.setState({ channelMessages: {}, unreadCounts: { [root]: 1 } });
  api.post = (async () => ({ data: { serverId: "server-read-state", scopes: [
    { scopeId: root, maxReadSeq: 10, readStateVersion: 2 },
  ] } })) as typeof api.post;
  api.get = (async () => ({ data: { channels: { [root]: {
    unreadCount: 1, readState: { kind: "present", maxReadSeq: "9", readStateVersion: 1, latestActivity: null },
  } } } })) as typeof api.get;
  try {
    await useMessageStore.getState().markConversationRead(root);
    assert.equal(useMessageStore.getState().unreadCounts[root], undefined);
    await useMessageStore.getState().loadUnreadCounts();
    assert.equal(useMessageStore.getState().unreadCounts[root], undefined);
    useMessageStore.getState().addMessage(makeMessage({ id: "new-after-all-read", channelId: root, seq: 11 }));
    assert.equal(useMessageStore.getState().unreadCounts[root], 1, "a new live message remains unread");
    await useMessageStore.getState().loadUnreadCounts();
    assert.equal(useMessageStore.getState().unreadCounts[root], 1, "a stale summary after that arrival cannot erase it");
  } finally {
    api.get = originalGet;
    useThreadStore.setState({ loadFollowedThreads: originalLoadThreads });
  }
});

test("a catch-up batch that carries the same message twice stores and counts it once", () => {
  resetAll();
  const channelId = "channel-batch-duplicates";

  useMessageStore.getState().batchAddMessages([
    makeMessage({ id: "dup-1", seq: 11, channelId }),
    makeMessage({ id: "dup-1", seq: 11, channelId }),
    makeMessage({ id: "dup-2", seq: 12, channelId }),
  ]);

  assert.deepEqual(useMessageStore.getState().channelMessages[channelId]?.map((m) => m.id), ["dup-1", "dup-2"]);
  assert.equal(useMessageStore.getState().unreadCounts[channelId], 2);
});
