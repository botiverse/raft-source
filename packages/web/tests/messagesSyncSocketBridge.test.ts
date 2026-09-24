import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
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
Object.defineProperty(globalThis, "location", {
  value: locationShim,
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: storage,
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
const { SYNC_CORE_MESSAGES_FLAG_KEY, resetMessagesSyncCoreForTests } = await import("../src/store/messageSyncDomain.js");
const {
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  messageRef,
  messageRepliesDiscussion,
  syncScopeWindow,
} = await import("@botiverse/raft-shared");
const {
  REGISTERED_SERVER_FEATURE_FLAG_KEYS,
} = await import("../src/store/serverFeatureFlags.js");
const { refreshSyncCoreMessagesFlagForCurrentServer, resetSyncCoreMessagesFlagForTests } = await import("../src/store/messageSyncFeatureFlag.js");
const { refreshNormalizedMessageV2FlagForCurrentServer } = await import("../src/store/normalizedMessageV2FeatureFlag.js");
const { reactionReadModelStore } = await import("../src/store/reactionReadModels.js");
const { useChannelStore } = await import("../src/store/channelStore.js");
const { useMessageStore } = await import("../src/store/messageStore.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { triggerServerReset } = await import("../src/store/serverResetRegistry.js");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
const { useInboxStore } = await import("../src/store/inboxStore.js");
const { useThreadStore } = await import("../src/store/threadStore.js");
const {
  hydrateThreadRepliesSnapshotWithSyncCore,
  readThreadRepliesSyncCoreScopeForTests,
  requestThreadRepliesRebaselineSnapshot,
  resetThreadRepliesSyncCoreForTests,
} = await import("../src/store/threadRepliesSyncDomain.js");
const { triggerMessagesSyncCoreReset } = await import("../src/store/messageSyncCoreReset.js");
const { invalidateReceiverPrivateIngressContexts } = await import("../src/store/receiverPrivateIngress.js");

const channelId = "channel-sync-bridge";
const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

function message(seq: number, content: string) {
  return {
    id: "message-sync-bridge-1",
    seq,
    channelId,
    senderType: "user" as const,
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat" as const,
    content,
    createdAt: "2026-07-10T07:00:00.000Z",
    reactions: [],
    actionMetadata: null,
  };
}

function resetMessageStore() {
  useMessageStore.setState({
    channelMessages: {},
    channelWindowMeta: {},
    messages: [],
    highlightedMessageId: null,
    transientFocusRequest: null,
    lastSeq: 0,
    currentChannelId: channelId,
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
    currentUserId: null,
    historyLimited: false,
    isNearBottom: true,
  });
}

function resetServerStore() {
  setCurrentServer("server-sync-bridge");
}

function setCurrentServer(id: string) {
  useServerStore.setState({
    current: {
      id,
      name: "Sync Bridge",
      slug: "sync-bridge",
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  });
}

function resetChannelStore() {
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });
}

function resetThreadStore() {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    openedAt: 0,
    summaries: {},
    replyScopes: {},
    followedThreads: [],
    taskUpdatesByMessageId: {},
    focusedThreadChannelId: null,
  });
}

function resetInboxStore() {
  useInboxStore.setState({
    items: [],
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: false,
    hasMore: true,
    totalCount: 0,
    totalUnreadCount: 0,
    scrollTop: 0,
    focusedItemKey: null,
    pendingFocusKind: null,
  });
}

function stubSyncCoreFlagEvaluation(enabled: boolean) {
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-sync-bridge",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return {
      data: {
        evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled }],
      },
    };
  }) as typeof api.post;
}

function stubMessageFlagEvaluation(enabled: boolean) {
  api.post = (async () => ({
    data: {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled }],
    },
  })) as typeof api.post;
}

function stubThreadReplyFlagEvaluation(input: { syncCore: boolean }) {
  api.post = (async (_url: string, body?: { keys?: string[] }) => ({
    data: {
      evaluations: (body?.keys ?? REGISTERED_SERVER_FEATURE_FLAG_KEYS).map((key) => ({
        key,
        enabled: key === SYNC_CORE_MESSAGES_FLAG_KEY ? input.syncCore : false,
      })),
    },
  })) as typeof api.post;
}

afterEach(() => {
  api.post = originalPost as typeof api.post;
  api.get = originalGet as typeof api.get;
  resetSyncCoreMessagesFlagForTests();
  resetMessagesSyncCoreForTests();
  resetThreadRepliesSyncCoreForTests();
  reactionReadModelStore.getState().reset();
  resetInboxStore();
  storage.clear();
});

function socketHandler(event: string, scheduleInboxRefresh = () => {}) {
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
    scheduleInboxRefresh,
    async () => {},
    () => {},
    () => {},
  );
  const binding = bindings.find((item) => item.event === event);
  assert.ok(binding);
  return binding.handler;
}

function messageNewHandler(scheduleInboxRefresh = () => {}) {
  return socketHandler("message:new", scheduleInboxRefresh);
}

function messageUpdatedHandler(scheduleInboxRefresh = () => {}) {
  return socketHandler("message:updated", scheduleInboxRefresh);
}

function threadUpdatedHandler(scheduleInboxRefresh = () => {}) {
  return socketHandler("thread:updated", scheduleInboxRefresh);
}

function threadUpdate(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    parentMessageId: "parent-thread-1",
    threadChannelId: "thread-channel-1",
    replyCount: seq,
    lastReplyAt: "2026-07-10T07:00:00.000Z",
    participantIds: ["user-2"],
    latestReply: {
      id: `thread-reply-${seq}`,
      seq,
      channelId: "thread-channel-1",
      senderType: "user" as const,
      senderId: "user-2",
      senderName: "Ben",
      messageType: "chat" as const,
      content: `reply ${seq}`,
      createdAt: "2026-07-10T07:00:00.000Z",
      reactions: [],
      actionMetadata: null,
    },
    ...overrides,
  };
}

function canonicalThreadUpdate(seq: number, epoch: string, overrides: Record<string, unknown> = {}) {
  return threadUpdate(seq, {
    latestReply: {
      ...threadUpdate(seq).latestReply,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-thread-1",
        parentChannelId: channelId,
        parentChannelType: "channel",
      },
    },
    syncCoreReplyWindow: {
      producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
      discussion: messageRepliesDiscussion(
        messageRef("server-sync-bridge", "parent-thread-1"),
        { serverId: "server-sync-bridge", scopeKind: "channel", scopeId: channelId },
      ),
      window: syncScopeWindow({ epoch }),
    },
    ...overrides,
  });
}

function invalidCanonicalThreadUpdates() {
  const discussion = messageRepliesDiscussion(
    messageRef("server-sync-bridge", "parent-thread-1"),
    { serverId: "server-sync-bridge", scopeKind: "channel", scopeId: channelId },
  );
  const window = syncScopeWindow({ epoch: "epoch-a" });
  const envelope = (discussionOverride: unknown, windowOverride: unknown = window) => ({
    producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
    discussion: discussionOverride,
    window: windowOverride,
  });
  return [
    ["wrong root server", canonicalThreadUpdate(11, "epoch-a", {
      syncCoreReplyWindow: envelope({
        ...discussion,
        root: { ...discussion.root, serverId: "server-other" },
      }),
    })],
    ["wrong root parent", canonicalThreadUpdate(12, "epoch-a", {
      syncCoreReplyWindow: envelope({
        ...discussion,
        root: { ...discussion.root, id: "parent-other" },
      }),
    })],
    ["wrong parent scope server", canonicalThreadUpdate(13, "epoch-a", {
      syncCoreReplyWindow: envelope({
        ...discussion,
        parentScopeKey: { ...discussion.parentScopeKey, serverId: "server-other" },
      }),
    })],
    ["wrong parent scope id", canonicalThreadUpdate(14, "epoch-a", {
      syncCoreReplyWindow: envelope({
        ...discussion,
        parentScopeKey: { ...discussion.parentScopeKey, scopeId: "channel-other" },
      }),
    })],
    ["wrong parent scope kind", canonicalThreadUpdate(15, "epoch-a", {
      syncCoreReplyWindow: envelope({
        ...discussion,
        parentScopeKey: { ...discussion.parentScopeKey, scopeKind: "unsupported" },
      }),
    })],
    ["malformed window", canonicalThreadUpdate(16, "epoch-a", {
      syncCoreReplyWindow: envelope(discussion, { ...window, kind: "wrong-window" }),
    })],
  ] as const;
}

function sharedShapeThreadUpdateWithoutProducer(seq: number, epoch: string, overrides: Record<string, unknown> = {}) {
  return threadUpdate(seq, {
    syncCoreReplyWindow: {
      discussion: messageRepliesDiscussion(
        messageRef("server-sync-bridge", "parent-thread-1"),
        { serverId: "server-sync-bridge", scopeKind: "channel", scopeId: channelId },
      ),
      window: syncScopeWindow({ epoch }),
    },
    ...overrides,
  });
}

function canonicalThreadUpdateForServer(input: {
  serverId: string;
  parentChannelId: string;
  parentMessageId: string;
  threadChannelId: string;
  seq: number;
  epoch: string;
  replyCount?: number;
}) {
  return threadUpdate(input.seq, {
    parentMessageId: input.parentMessageId,
    threadChannelId: input.threadChannelId,
    replyCount: input.replyCount ?? input.seq,
    syncCoreReplyWindow: {
      producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
      discussion: messageRepliesDiscussion(
        messageRef(input.serverId, input.parentMessageId),
        { serverId: input.serverId, scopeKind: "channel", scopeId: input.parentChannelId },
      ),
      window: syncScopeWindow({ epoch: input.epoch }),
    },
    latestReply: {
      ...threadUpdate(input.seq).latestReply,
      id: `thread-reply-${input.serverId}-${input.seq}`,
      channelId: input.threadChannelId,
      content: `reply ${input.seq} from ${input.serverId}`,
      conversationContext: {
        channelType: "thread",
        parentMessageId: input.parentMessageId,
        parentChannelId: input.parentChannelId,
        parentChannelType: "channel",
      },
    },
  });
}

test("message sync exposes one product flag and no V2 rollout key", () => {
  assert.equal(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(SYNC_CORE_MESSAGES_FLAG_KEY), true);
  assert.equal(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes("sync_core_messages_v2_normalized_v0" as never), false);
  assert.equal(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.filter((key) => key.startsWith("sync_core_messages")).length,
    1,
  );
});

test("socket bridge: sync_core_messages_v0 gates message:new through server flag evaluation before store consumption", async () => {
  storage.clear();
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  resetMessagesSyncCoreForTests();
  resetSyncCoreMessagesFlagForTests();
  stubSyncCoreFlagEvaluation(true);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  const handleMessageNew = messageNewHandler();
  handleMessageNew(message(1, "first"));
  const channelActivityAfterFirst = useChannelStore.getState().channelActivity;
  handleMessageNew(message(1, "duplicate mutated content"));

  const bucket = useMessageStore.getState().channelMessages[channelId] ?? [];
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0]?.content, "first", "duplicate same-seq frame must not re-enter the store path");
  assert.equal(
    useChannelStore.getState().channelActivity,
    channelActivityAfterFirst,
    "duplicate same-seq frame must not churn channel activity side effects",
  );
});

test("socket bridge: sync_core duplicate_dropped exits before inbox refresh side effects", async () => {
  storage.clear();
  resetServerStore();
  resetMessageStore();
  resetChannelStore();
  resetMessagesSyncCoreForTests();
  resetSyncCoreMessagesFlagForTests();
  stubSyncCoreFlagEvaluation(true);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  let inboxRefreshCount = 0;
  const handleMessageNew = messageNewHandler(() => {
    inboxRefreshCount += 1;
  });

  handleMessageNew(message(1, "first"));
  const channelActivityAfterFirst = useChannelStore.getState().channelActivity;
  handleMessageNew(message(1, "duplicate"));

  assert.equal(inboxRefreshCount, 1, "duplicate_dropped must not schedule an inbox refresh");
  assert.equal(
    useChannelStore.getState().channelActivity,
    channelActivityAfterFirst,
    "duplicate_dropped must preserve channelActivity identity",
  );
});

test("socket bridge: current message producers keep legacy writers under sync-core flag", async () => {
  storage.clear();
  resetServerStore();
  resetMessageStore();
  resetChannelStore();
  resetMessagesSyncCoreForTests();
  resetSyncCoreMessagesFlagForTests();
  stubSyncCoreFlagEvaluation(true);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  const originalAddMessage = useMessageStore.getState().addMessage;
  const originalUpdateMessage = useMessageStore.getState().updateMessage;
  let addCalls = 0;
  let updateCalls = 0;
  useMessageStore.setState({
    addMessage: (...args) => {
      addCalls += 1;
      return originalAddMessage(...args);
    },
    updateMessage: (...args) => {
      updateCalls += 1;
      return originalUpdateMessage(...args);
    },
  });
  try {
    const commentRef = {
      attachmentId: "attachment-1",
      filename: "trace.log",
      hostMessageId: "host-1",
      hostSource: {
        type: "channel" as const,
        routeKind: "channel" as const,
        channelId,
      },
      anchorLabel: "re: trace.log",
      anchorQuote: "root",
    };
    messageNewHandler()({
      ...message(7, "comment"),
      commentRef,
    });
    messageUpdatedHandler()({
      ...message(7, "comment edited"),
      commentRef: null,
    });

    assert.equal(addCalls, 1, "current message:new producers must keep the legacy addMessage invariants");
    assert.equal(updateCalls, 1, "current message:updated producers must not borrow message seq as a mutation version");
    const stored = useMessageStore.getState().channelMessages[channelId]?.[0];
    assert.equal(stored?.content, "comment edited");
    assert.deepEqual(stored?.commentRef, commentRef, "legacy/shared-null-preserve keeps scoped commentRef");
  } finally {
    useMessageStore.setState({
      addMessage: originalAddMessage,
      updateMessage: originalUpdateMessage,
    });
  }
});

test("socket bridge: server flag-off message:new keeps the legacy direct store path", async () => {
  storage.clear();
  resetServerStore();
  resetMessageStore();
  resetChannelStore();
  resetMessagesSyncCoreForTests();
  resetSyncCoreMessagesFlagForTests();
  stubSyncCoreFlagEvaluation(false);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), false);

  const handleMessageNew = messageNewHandler();
  const first = message(1, "first");
  handleMessageNew(first);
  assert.equal(
    useMessageStore.getState().channelMessages[channelId]?.[0],
    first,
    "flag-off must preserve the exact legacy message object",
  );
  handleMessageNew(message(1, "legacy merge"));

  const bucket = useMessageStore.getState().channelMessages[channelId] ?? [];
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0]?.content, "legacy merge");
});

test("thread replies bridge: raw V1 and shared-shaped envelopes fail open without producer eligibility", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();
  useThreadStore.setState({
    followedThreads: [{
      threadChannelId: "thread-channel-1",
      parentMessageId: "parent-thread-1",
      parentChannelId: channelId,
      parentChannelName: "general",
      parentChannelType: "channel",
      parentMessagePreview: "parent",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-1",
      replyCount: 0,
      lastReplyAt: null,
      unreadCount: 0,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    }],
  });
  stubThreadReplyFlagEvaluation({ syncCore: true });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  const originalApplyReplyFrame = useThreadStore.getState().applyReplyFrame;
  let legacyReplyFrameCalls = 0;
  useThreadStore.setState({
    applyReplyFrame: (...args) => {
      legacyReplyFrameCalls += 1;
      return originalApplyReplyFrame(...args);
    },
  });
  try {
    threadUpdatedHandler()(threadUpdate(7));
    assert.equal(legacyReplyFrameCalls, 1, "raw V1 must shadow and fail open to the legacy reply writer");
    assert.equal(useThreadStore.getState().replyScopes["parent-thread-1"]?.replyCount, 7);

    threadUpdatedHandler()(sharedShapeThreadUpdateWithoutProducer(8, "epoch-a"));
    assert.equal(legacyReplyFrameCalls, 2, "Web cannot self-enable strict replies without producer eligibility");
    assert.deepEqual(
      useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((reply) => reply.seq),
      [7, 8],
    );
  } finally {
    useThreadStore.setState({ applyReplyFrame: originalApplyReplyFrame });
  }
});

test("thread replies bridge: producer-bound canonical envelope sole-applies through sync-core while the broader flag is off", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();
  stubThreadReplyFlagEvaluation({ syncCore: false });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), false);

  const originalApplyReplyFrame = useThreadStore.getState().applyReplyFrame;
  let legacyReplyFrameCalls = 0;
  useThreadStore.setState({
    applyReplyFrame: (...args) => {
      legacyReplyFrameCalls += 1;
      return originalApplyReplyFrame(...args);
    },
  });
  try {
    threadUpdatedHandler()(canonicalThreadUpdate(7, "epoch-a"));

    assert.equal(legacyReplyFrameCalls, 0, "trusted producer envelopes must not also enter the legacy reply writer");
    const scope = useThreadStore.getState().replyScopes["parent-thread-1"];
    assert.deepEqual(scope?.replies.map((reply) => reply.seq), [7]);
    assert.equal(scope?.replyCount, 7);
    assert.equal(useThreadStore.getState().summaries["parent-thread-1"]?.replyCount, 7);
  } finally {
    useThreadStore.setState({ applyReplyFrame: originalApplyReplyFrame });
  }
});

test("thread replies bridge: known producer invalid envelopes never call the legacy writer", () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();

  const originalApplyReplyFrame = useThreadStore.getState().applyReplyFrame;
  let legacyReplyFrameCalls = 0;
  useThreadStore.setState({
    applyReplyFrame: (...args) => {
      legacyReplyFrameCalls += 1;
      return originalApplyReplyFrame(...args);
    },
  });
  try {
    const handler = threadUpdatedHandler();
    for (const [name, payload] of invalidCanonicalThreadUpdates()) {
      handler(payload);
      assert.equal(legacyReplyFrameCalls, 0, `${name} must fail closed before the legacy writer`);
    }
    assert.deepEqual(useThreadStore.getState().replyScopes, {});
    assert.deepEqual(useThreadStore.getState().summaries, {});
  } finally {
    useThreadStore.setState({ applyReplyFrame: originalApplyReplyFrame });
  }
});

test("thread replies bridge: shared-shaped envelope does not replace raw replyCount without producer eligibility", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();
  useThreadStore.setState({
    followedThreads: [{
      threadChannelId: "thread-channel-1",
      parentMessageId: "parent-thread-1",
      parentChannelId: channelId,
      parentChannelName: "general",
      parentChannelType: "channel",
      parentMessagePreview: "parent",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-1",
      replyCount: 0,
      lastReplyAt: null,
      unreadCount: 0,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    }],
  });
  stubThreadReplyFlagEvaluation({ syncCore: true });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-sync-bridge",
    principalId: "user-current",
    parentMessageId: "parent-thread-1",
    threadChannelId: "thread-channel-1",
    replies: [],
    replyCount: 10,
    historyLimited: false,
    watermark: 0,
    epoch: "epoch-a",
  });

  threadUpdatedHandler()(sharedShapeThreadUpdateWithoutProducer(1, "epoch-a", { replyCount: 4 }));

  assert.equal(
    useThreadStore.getState().summaries["parent-thread-1"]?.replyCount,
    4,
    "current bridge must fail open to raw V1 until producer eligibility exists",
  );
});

test("thread replies bridge: shared-shaped envelope does not request rebaseline without producer eligibility", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();
  useThreadStore.setState({
    followedThreads: [{
      threadChannelId: "thread-channel-1",
      parentMessageId: "parent-thread-1",
      parentChannelId: channelId,
      parentChannelName: "general",
      parentChannelType: "channel",
      parentMessagePreview: "parent",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-1",
      replyCount: 0,
      lastReplyAt: null,
      unreadCount: 0,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    }],
  });
  stubThreadReplyFlagEvaluation({ syncCore: true });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  const snapshotRequests: string[] = [];
  api.get = (async (url: string) => {
    snapshotRequests.push(url);
    if (url === "/messages/channel/thread-channel-1?limit=3") {
      return {
        data: {
          messages: [threadUpdate(2).latestReply],
          historyLimited: false,
        },
      };
    }
    if (url === `/channels/${channelId}/threads/parent-thread-1`) {
      return {
        data: {
          threadChannelId: "thread-channel-1",
          replyCount: 2,
        },
      };
    }
    throw new Error(`unexpected API call ${url}`);
  }) as typeof api.get;

  threadUpdatedHandler()(sharedShapeThreadUpdateWithoutProducer(1, "epoch-a"));
  threadUpdatedHandler()(sharedShapeThreadUpdateWithoutProducer(2, "epoch-b"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(snapshotRequests, []);
  const scope = useThreadStore.getState().replyScopes["parent-thread-1"];
  assert.deepEqual(scope?.replies.map((reply) => reply.seq), [1, 2]);
  assert.equal(scope?.replyCount, 2);
});

test("thread replies bridge: stale A binding drops old raw and canonical events after B reset", async () => {
  setCurrentServer("server-a");
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-a");
  resetThreadStore();
  resetInboxStore();
  stubThreadReplyFlagEvaluation({ syncCore: true });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  const staleAHandler = threadUpdatedHandler();

  setCurrentServer("server-b");
  useMessageStore.getState().setCurrentUserId("user-b");
  triggerServerReset();
  resetThreadStore();
  resetInboxStore();
  stubThreadReplyFlagEvaluation({ syncCore: true });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  staleAHandler(threadUpdate(9, {
    parentMessageId: "parent-a-raw",
    threadChannelId: "thread-a-raw",
    replyCount: 9,
  }));
  staleAHandler(canonicalThreadUpdateForServer({
    serverId: "server-a",
    parentChannelId: "channel-a",
    parentMessageId: "parent-a-canonical",
    threadChannelId: "thread-a-canonical",
    seq: 10,
    epoch: "epoch-a",
    replyCount: 10,
  }));

  assert.deepEqual(useThreadStore.getState().replyScopes, {});
  assert.deepEqual(useThreadStore.getState().summaries, {});
  assert.deepEqual(useThreadStore.getState().followedThreads, []);
  assert.deepEqual(useInboxStore.getState().items, []);
});

test("thread replies bridge: stale A binding drops before reply summary writes", async () => {
  for (const syncCore of [false, true]) {
    resetThreadRepliesSyncCoreForTests();
    setCurrentServer("server-a");
    resetMessageStore();
    useMessageStore.getState().setCurrentUserId("user-a");
    resetThreadStore();
    resetInboxStore();
    stubThreadReplyFlagEvaluation({ syncCore: true });
    assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

    const staleAHandler = threadUpdatedHandler();

    setCurrentServer("server-b");
    useMessageStore.getState().setCurrentUserId("user-b");
    triggerServerReset();
    resetThreadStore();
    resetInboxStore();
    useThreadStore.setState({
      followedThreads: [{
        threadChannelId: "thread-a-raw",
        parentMessageId: "parent-a-raw",
        parentChannelId: "channel-b",
        parentChannelName: "general",
        parentChannelType: "channel",
        parentMessagePreview: "parent",
        parentMessageSenderType: "user",
        parentMessageSenderId: "user-b",
        replyCount: 1,
        lastReplyAt: "2026-07-10T06:00:00.000Z",
        unreadCount: 0,
        taskNumber: null,
        taskStatus: null,
        taskClaimedByName: null,
      }],
    });
    useInboxStore.setState({
      items: [{
        kind: "thread",
        threadChannelId: "thread-a-raw",
        replyCount: 1,
        lastReplyAt: "2026-07-10T06:00:00.000Z",
      } as never],
    });
    const before = {
      replyScopes: useThreadStore.getState().replyScopes,
      summaries: useThreadStore.getState().summaries,
      followedThreads: useThreadStore.getState().followedThreads,
      inboxItems: useInboxStore.getState().items,
    };

    resetSyncCoreMessagesFlagForTests();
    stubThreadReplyFlagEvaluation({ syncCore });
    assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), syncCore);

    staleAHandler(threadUpdate(9, {
      parentMessageId: "parent-a-raw",
      threadChannelId: "thread-a-raw",
      replyCount: 9,
      participantIds: ["user-a"],
    }));
    staleAHandler(canonicalThreadUpdateForServer({
      serverId: "server-a",
      parentChannelId: "channel-a",
      parentMessageId: "parent-a-canonical",
      threadChannelId: "thread-a-canonical",
      seq: 10,
      epoch: "epoch-a",
      replyCount: 10,
    }));

    assert.deepEqual(useThreadStore.getState().replyScopes, before.replyScopes);
    assert.deepEqual(useThreadStore.getState().summaries, before.summaries);
    assert.deepEqual(useThreadStore.getState().followedThreads, before.followedThreads);
    assert.deepEqual(useInboxStore.getState().items, before.inboxItems);

    const freshBHandler = threadUpdatedHandler();
    freshBHandler(threadUpdate(2, {
      parentMessageId: `parent-b-${syncCore ? "sync" : "legacy"}`,
      threadChannelId: `thread-b-${syncCore ? "sync" : "legacy"}`,
      replyCount: 2,
      participantIds: ["user-b"],
    }));

    assert.equal(
      useThreadStore.getState().summaries[`parent-b-${syncCore ? "sync" : "legacy"}`]?.replyCount,
      2,
      "a fresh B binding must still accept B thread updates",
    );
  }
});

test("thread replies bridge: stale rebaseline response cannot mutate UI or core after B reset", async () => {
  setCurrentServer("server-a");
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-a");
  resetThreadStore();
  resetInboxStore();
  stubThreadReplyFlagEvaluation({ syncCore: true });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  let resolveMessages!: (value: unknown) => void;
  let resolveSummary!: (value: unknown) => void;
  api.get = (async (url: string) => {
    if (url === "/messages/channel/thread-a?limit=3") {
      return new Promise((resolve) => {
        resolveMessages = resolve;
      });
    }
    if (url === "/channels/channel-a/threads/parent-a") {
      return new Promise((resolve) => {
        resolveSummary = resolve;
      });
    }
    throw new Error(`unexpected API call ${url}`);
  }) as typeof api.get;

  const handler = threadUpdatedHandler();
  handler(canonicalThreadUpdateForServer({
    serverId: "server-a",
    parentChannelId: "channel-a",
    parentMessageId: "parent-a",
    threadChannelId: "thread-a",
    seq: 1,
    epoch: "epoch-a",
  }));
  handler(canonicalThreadUpdateForServer({
    serverId: "server-a",
    parentChannelId: "channel-a",
    parentMessageId: "parent-a",
    threadChannelId: "thread-a",
    seq: 2,
    epoch: "epoch-b",
  }));

  setCurrentServer("server-b");
  useMessageStore.getState().setCurrentUserId("user-b");
  triggerServerReset();
  resetThreadStore();
  resetInboxStore();

  resolveMessages({
    data: {
      messages: [canonicalThreadUpdateForServer({
        serverId: "server-a",
        parentChannelId: "channel-a",
        parentMessageId: "parent-a",
        threadChannelId: "thread-a",
        seq: 9,
        epoch: "epoch-b",
      }).latestReply],
      historyLimited: false,
    },
  });
  resolveSummary({
    data: {
      threadChannelId: "thread-a",
      replyCount: 9,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(useThreadStore.getState().replyScopes, {});
  assert.deepEqual(useThreadStore.getState().summaries, {});
  assert.deepEqual(useThreadStore.getState().followedThreads, []);
  assert.deepEqual(useInboxStore.getState().items, []);
  assert.equal(
    readThreadRepliesSyncCoreScopeForTests({
      serverId: "server-a",
      principalId: "user-a",
      parentMessageId: "parent-a",
      threadChannelId: "thread-a",
    }),
    null,
    "stale rebaseline completion must not recreate the old A core lane after reset",
  );
});

test("thread replies bridge: newer epoch response supersedes an older in-flight rebaseline", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();

  const messageResolvers: Array<(value: unknown) => void> = [];
  const summaryResolvers: Array<(value: unknown) => void> = [];
  api.get = (async (url: string) => {
    if (url === "/messages/channel/thread-channel-1?limit=3") {
      return new Promise((resolve) => messageResolvers.push(resolve));
    }
    if (url === `/channels/${channelId}/threads/parent-thread-1`) {
      return new Promise((resolve) => summaryResolvers.push(resolve));
    }
    throw new Error(`unexpected API call ${url}`);
  }) as typeof api.get;

  const handler = threadUpdatedHandler();
  handler(canonicalThreadUpdate(10, "epoch-1"));
  handler(canonicalThreadUpdate(11, "epoch-2"));
  handler(canonicalThreadUpdate(12, "epoch-3"));
  assert.equal(messageResolvers.length, 2);
  assert.equal(summaryResolvers.length, 2);

  messageResolvers[1]?.({
    data: { messages: [threadUpdate(12).latestReply], historyLimited: false },
  });
  summaryResolvers[1]?.({
    data: { threadChannelId: "thread-channel-1", replyCount: 12 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((item) => item.seq),
    [12],
  );

  messageResolvers[0]?.({
    data: { messages: [threadUpdate(11).latestReply], historyLimited: false },
  });
  summaryResolvers[0]?.({
    data: { threadChannelId: "thread-channel-1", replyCount: 11 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((item) => item.seq),
    [12],
    "late epoch-2 response must be rejected before core and UI mutation",
  );

  handler(canonicalThreadUpdate(13, "epoch-3"));
  assert.deepEqual(
    useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((item) => item.seq),
    [12, 13],
  );
});

test("thread replies bridge: duplicate same-epoch mismatch coalesces to one request and publication", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();

  let resolveMessages!: (value: unknown) => void;
  let resolveSummary!: (value: unknown) => void;
  const calls: string[] = [];
  api.get = (async (url: string) => {
    calls.push(url);
    if (url === "/messages/channel/thread-channel-1?limit=3") {
      return new Promise((resolve) => { resolveMessages = resolve; });
    }
    if (url === `/channels/${channelId}/threads/parent-thread-1`) {
      return new Promise((resolve) => { resolveSummary = resolve; });
    }
    throw new Error(`unexpected API call ${url}`);
  }) as typeof api.get;

  let publications = 0;
  const unsubscribe = useThreadStore.subscribe((state, previous) => {
    if (
      state.replyScopes !== previous.replyScopes
      || state.summaries !== previous.summaries
    ) {
      publications += 1;
    }
  });
  try {
    const handler = threadUpdatedHandler();
    handler(canonicalThreadUpdate(10, "epoch-1"));
    publications = 0;
    handler(canonicalThreadUpdate(11, "epoch-2", {
      lastReplyAt: "2026-07-10T07:00:11.000Z",
      participantIds: ["user-11"],
      unreadCount: 3,
      firstUnreadMessageId: "thread-reply-11",
    }));
    handler(canonicalThreadUpdate(12, "epoch-2", {
      lastReplyAt: "2026-07-10T07:00:12.000Z",
      participantIds: ["user-12"],
      unreadCount: 4,
      firstUnreadMessageId: "thread-reply-11",
    }));
    handler(canonicalThreadUpdate(13, "epoch-2", {
      lastReplyAt: "2026-07-10T07:00:13.000Z",
      participantIds: ["user-13"],
      unreadCount: 5,
      firstUnreadMessageId: "thread-reply-13",
    }));
    assert.deepEqual(calls.filter((url) => url !== "/channels/threads/followed"), [
      "/messages/channel/thread-channel-1?limit=3",
      `/channels/${channelId}/threads/parent-thread-1`,
    ]);

    resolveMessages({
      data: { messages: [threadUpdate(10).latestReply], historyLimited: false },
    });
    resolveSummary({
      data: { threadChannelId: "thread-channel-1", replyCount: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(publications, 1);
    assert.deepEqual(
      useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((item) => item.seq),
      [11, 12, 13],
      "all preview-relevant pending frames must fold before the single UI publication",
    );
    assert.deepEqual(useThreadStore.getState().summaries["parent-thread-1"], {
      threadChannelId: "thread-channel-1",
      replyCount: 13,
      lastReplyAt: "2026-07-10T07:00:13.000Z",
      participantIds: ["user-13"],
      unreadCount: 5,
      firstUnreadMessageId: "thread-reply-13",
    });
  } finally {
    unsubscribe();
  }
});

test("thread replies bridge: stale ingress completion releases only its pending rebaseline token", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetThreadStore();

  const messageResolvers: Array<(value: unknown) => void> = [];
  const summaryResolvers: Array<(value: unknown) => void> = [];
  api.get = (async (url: string) => {
    if (url === "/messages/channel/thread-channel-1?limit=3") {
      return new Promise((resolve) => messageResolvers.push(resolve));
    }
    if (url === `/channels/${channelId}/threads/parent-thread-1`) {
      return new Promise((resolve) => summaryResolvers.push(resolve));
    }
    throw new Error(`unexpected API call ${url}`);
  }) as typeof api.get;

  const staleHandler = threadUpdatedHandler();
  staleHandler(canonicalThreadUpdate(10, "epoch-1"));
  staleHandler(canonicalThreadUpdate(11, "epoch-2"));
  assert.equal(messageResolvers.length, 1);

  invalidateReceiverPrivateIngressContexts();
  const freshHandler = threadUpdatedHandler();
  freshHandler(canonicalThreadUpdate(12, "epoch-2"));
  assert.equal(
    messageResolvers.length,
    2,
    "fresh ingress must supersede a stale same-epoch pending request immediately",
  );

  messageResolvers[0]?.({
    data: { messages: [threadUpdate(11).latestReply], historyLimited: false },
  });
  summaryResolvers[0]?.({
    data: { threadChannelId: "thread-channel-1", replyCount: 11 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((item) => item.seq),
    [10],
    "stale completion must not publish its snapshot",
  );

  messageResolvers[1]?.({
    data: { messages: [threadUpdate(12).latestReply], historyLimited: false },
  });
  summaryResolvers[1]?.({
    data: { threadChannelId: "thread-channel-1", replyCount: 12 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    useThreadStore.getState().replyScopes["parent-thread-1"]?.replies.map((item) => item.seq),
    [12],
    "late old completion must not clear the fresh token; E2/12 converges without another socket frame",
  );
});

test("thread replies rebaseline refuses missing parent authority instead of inventing replyCount", async () => {
  const calls: string[] = [];
  api.get = (async (url: string) => {
    calls.push(url);
    if (url === "/messages/channel/thread-channel-1?limit=3") {
      return {
        data: {
          messages: [threadUpdate(1).latestReply],
          historyLimited: false,
          replyCount: 99,
        },
      };
    }
    if (url === `/channels/${channelId}/threads/parent-thread-1`) {
      throw new Error("summary unavailable");
    }
    throw new Error(`unexpected API call ${url}`);
  }) as typeof api.get;

  const failedSummary = await requestThreadRepliesRebaselineSnapshot({
    parentMessageId: "parent-thread-1",
    parentChannelId: channelId,
    threadChannelId: "thread-channel-1",
    epoch: "epoch-a",
  });

  assert.equal(failedSummary, null);
  assert.deepEqual(calls, [
    "/messages/channel/thread-channel-1?limit=3",
    `/channels/${channelId}/threads/parent-thread-1`,
  ]);

  calls.length = 0;
  const missingParentScope = await requestThreadRepliesRebaselineSnapshot({
    parentMessageId: "parent-thread-1",
    parentChannelId: null,
    threadChannelId: "thread-channel-1",
    epoch: "epoch-a",
  });
  assert.equal(missingParentScope, null);
  assert.deepEqual(calls, [], "without parent scope, rebaseline must not fall back to a thread-only count");
});

test("thread replies bridge: server and sync-core resets clear reply scopes", () => {
  resetThreadStore();
  useThreadStore.getState().hydrateReplyScope("parent-thread-1", [{
    messageId: "reply-1",
    seq: 1,
    preview: "reply 1",
    senderId: "user-2",
    senderType: "user",
    senderName: "Ben",
    senderAvatarUrl: null,
    createdAt: "2026-07-10T07:00:00.000Z",
  }], 7);
  assert.equal(useThreadStore.getState().replyScopes["parent-thread-1"]?.replyCount, 7);

  triggerMessagesSyncCoreReset();
  assert.deepEqual(useThreadStore.getState().replyScopes, {});

  useThreadStore.getState().hydrateReplyScope("parent-thread-1", [{
    messageId: "reply-1",
    seq: 1,
    preview: "reply 1",
    senderId: "user-2",
    senderType: "user",
    senderName: "Ben",
    senderAvatarUrl: null,
    createdAt: "2026-07-10T07:00:00.000Z",
  }], 7);
  triggerServerReset();
  assert.deepEqual(useThreadStore.getState().replyScopes, {});
});

test("socket bridge: the single sync-core flag sole-applies only already-eligible canonical facts", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshNormalizedMessageV2FlagForCurrentServer(), true);

  const incoming = {
    ...message(1, "normalized"),
    reactions: [{ emoji: "👍", count: 2, previewK: [] }],
  };
  messageNewHandler()(incoming);

  const stored = useMessageStore.getState().channelMessages[channelId]?.[0];
  assert.deepEqual(stored?.reactions, [{ emoji: "👍", count: 2, previewK: [] }]);
  assert.equal(JSON.stringify(stored).includes("reactorIds"), false);
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay(
      "user-current",
      "server-sync-bridge",
      incoming.id,
      "👍",
    ),
    { status: "unknown" },
  );
});

test("socket bridge: the single sync-core flag shadows raw V1 rosters without promoting them", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);

  const incoming = {
    ...message(1, "legacy shadow"),
    reactions: [{
      emoji: "👍",
      count: 1,
      reactorIds: ["user-2"],
      reactorNames: ["Ben"],
    }],
  };
  messageNewHandler()(incoming);

  const stored = useMessageStore.getState().channelMessages[channelId]?.[0];
  assert.deepEqual(stored?.reactions, incoming.reactions);
  assert.equal("previewK" in (stored?.reactions?.[0] ?? {}), false);
  assert.equal(
    reactionReadModelStore.getState().actorCache.size,
    1,
    "raw V1 may seed the bounded shadow cache but cannot replace the message fact",
  );
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay(
      "user-current",
      "server-sync-bridge",
      incoming.id,
      "👍",
    ),
    { status: "unknown" },
    "a channel-room frame must not be reclassified as receiver-private by the store",
  );
});

test("socket bridge: non-eligible normalized input fails open to the V1 apply lane", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshNormalizedMessageV2FlagForCurrentServer(), true);

  messageNewHandler()({
    ...message(1, "invalid"),
    reactions: [{ emoji: " 👍 ", count: 1, previewK: [] }],
  });
  assert.deepEqual(
    useMessageStore.getState().channelMessages[channelId]?.[0]?.reactions,
    [{ emoji: " 👍 ", count: 1, previewK: [] }],
    "not-eligible normalized input must fail open to the existing V1 apply lane",
  );
  assert.equal(reactionReadModelStore.getState().actorCache.size, 0);
});

test("normalized V2 false-to-true activation rebaselines legacy HTTP state and resets the old sync core", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  stubMessageFlagEvaluation(false);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), false);

  const legacy = {
    ...message(1, "before activation"),
    reactions: [{
      emoji: "👍",
      count: 1,
      reactorIds: ["user-current"],
      reactorNames: ["Current User"],
    }],
  };
  useMessageStore.getState().addMessage(legacy);
  assert.equal(
    useMessageStore.getState().channelMessages[channelId]![0],
    legacy,
    "unresolved V2 must first exercise the exact legacy HTTP/store path",
  );
  // Prime the old module-global sync core with the same raw authority before
  // the flag flips; the activation must reset this state as well as the store.
  messageNewHandler()(legacy);
  assert.equal("reactorIds" in useMessageStore.getState().channelMessages[channelId]![0]!.reactions![0]!, true);

  resetSyncCoreMessagesFlagForTests();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshNormalizedMessageV2FlagForCurrentServer(), true);

  const rebased = useMessageStore.getState().channelMessages[channelId]![0]!;
  assert.deepEqual(rebased.reactions, legacy.reactions, "raw V1 remains the legacy authoritative fact");
  assert.equal(reactionReadModelStore.getState().actorCache.size, 1, "activation may seed shadow reads");

  messageNewHandler()({ ...legacy, content: "after activation" });
  assert.equal(
    useMessageStore.getState().channelMessages[channelId]![0]!.content,
    "after activation",
    "same-seq frame must apply after the V2 activation reset instead of being dropped by the old core",
  );
});

test("receiver-private HTTP response for A cannot mutate or reactivate after auth switches to B", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-a");
  resetChannelStore();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshNormalizedMessageV2FlagForCurrentServer(), true);

  let resolveRequest!: (value: unknown) => void;
  api.get = (async () => new Promise<unknown>((resolve) => {
    resolveRequest = resolve;
  })) as typeof api.get;
  const pending = useMessageStore.getState().loadMessages(channelId);

  useMessageStore.getState().setCurrentUserId("user-b");
  const storeBefore = useMessageStore.getState().channelMessages;
  const readModelBefore = reactionReadModelStore.getState();
  resolveRequest({
    data: {
      messages: [{
        ...message(1, "late A response"),
        reactions: [{
          emoji: "👍",
          count: 1,
          reactorIds: ["user-a"],
          reactorNames: ["User A"],
        }],
      }],
    },
  });
  await pending;

  assert.equal(useMessageStore.getState().channelMessages, storeBefore);
  const readModelAfter = reactionReadModelStore.getState();
  assert.equal(readModelAfter.activePrincipalId, "user-b");
  assert.equal(readModelAfter.viewerOverlay, readModelBefore.viewerOverlay);
  assert.equal(readModelAfter.actorCache, readModelBefore.actorCache);
  assert.equal(readModelAfter.parentIndex, readModelBefore.parentIndex);
});

test("sync resume keeps an invalid batch on V1 and skips normalized side effects", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshNormalizedMessageV2FlagForCurrentServer(), true);

  const valid = {
    ...message(1, "valid"),
    reactions: [{ emoji: "👍", count: 1, previewK: [] }],
  };
  const malformed = {
    ...message(2, "malformed"),
    reactions: [{ emoji: " 👍 ", count: 1, previewK: [] }],
  };
  socketHandler("sync:resume:response")({
    messages: [valid, malformed],
    currentSeq: 2,
    hasMore: false,
  });

  assert.equal(reactionReadModelStore.getState().actorCache.size, 0);
  assert.equal(useMessageStore.getState().channelMessages[channelId]?.length, 2);
  assert.equal(useMessageStore.getState().lastSeq, 2);

  let viewerGetCalls = 0;
  api.get = (async (url: string) => {
    viewerGetCalls += 1;
    assert.equal(url, `/messages/${valid.id}/reactions/viewer`);
    return {
      data: {
        serverId: "server-sync-bridge",
        messageId: valid.id,
        viewerVersion: 7,
        reactedEmojis: ["👍"],
      },
    };
  }) as typeof api.get;
  socketHandler("sync:resume:response")({
    messages: [valid],
    currentSeq: 1,
    hasMore: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay(
      "user-current",
      "server-sync-bridge",
      valid.id,
      "👍",
    ),
    { status: "loaded", reactedByMe: true },
  );
  assert.equal(viewerGetCalls, 1, "valid receiver-private resume must cold-recover viewer truth");
  assert.deepEqual(
    [...reactionReadModelStore.getState().viewerVersions.values()],
    [7],
    "resume recovery must enter the same versioned projector as GET, ACK, and user-room events",
  );
});

test("reaction viewer events share the versioned complete-snapshot projector", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-current");
  resetChannelStore();
  stubMessageFlagEvaluation(true);
  assert.equal(await refreshNormalizedMessageV2FlagForCurrentServer(), true);

  const handleViewer = socketHandler("reaction_viewer:updated");
  handleViewer({
    serverId: "server-sync-bridge",
    messageId: "message-1",
    viewerVersion: 2,
    reactedEmojis: ["👍"],
  });
  handleViewer({
    serverId: "server-sync-bridge",
    messageId: "message-1",
    viewerVersion: 1,
    reactedEmojis: [],
  });
  handleViewer({
    serverId: "server-sync-bridge",
    messageId: "message-1",
    viewerVersion: 2,
    reactedEmojis: [],
  });

  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay(
      "user-current",
      "server-sync-bridge",
      "message-1",
      "👍",
    ),
    { status: "loaded", reactedByMe: true },
  );
  assert.equal(reactionReadModelStore.getState().viewerSnapshotConflicts.length, 1);
});
