import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { InboxItem } from "../src/store/inboxStore.js";
import type { Message } from "../src/store/messageStore.js";
import type { FollowedThread, ThreadSummary } from "../src/store/threadStore.js";

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

const api = (await import("../src/api/client.js")).default;
const { useInboxStore, getInboxItemKey } = await import("../src/store/inboxStore.js");
const { useMessageStore } = await import("../src/store/messageStore.js");
const {
  consumeReadStateUpdate,
  getReadStateLedgerGeneration,
  hasAcceptedReadStateChangedAfter,
  normalizeReadStateUpdated,
  normalizeReadStateUpdatedBulk,
  resetReadStateSyncForTests,
} = await import("../src/store/readStateSync.js");
const {
  acceptActivityReadAllAck,
  hasActivityReadHold,
  resetActivityReadStateForTests,
} = await import("../src/store/activityReadState.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { triggerServerReset } = await import("../src/store/serverResetRegistry.js");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
const { useThreadStore } = await import("../src/store/threadStore.js");

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
    taskUpdatesByMessageId: {},
    focusedThreadChannelId: null,
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
