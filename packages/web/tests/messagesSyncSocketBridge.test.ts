import assert from "node:assert/strict";

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

const api = (await import("../src/api/client")).default;
const {
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  messageRef,
  messageRepliesDiscussion,
  syncScopeWindow,
} = await import("@botiverse/raft-shared");
const {
  REGISTERED_SERVER_FEATURE_FLAG_KEYS,
} = await import("../src/store/serverFeatureFlags");
const { reactionReadModelStore } = await import("../src/store/reactionReadModels");
const { useChannelStore } = await import("../src/store/channelStore");
const { __resetMessageHistoryRequestsForTests, useMessageStore } = await import("../src/store/messageStore");
const { useServerStore } = await import("../src/store/serverStore");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { BOOT_FETCHES_GLOBAL, __resetBootFetchesForTest } = await import("../src/boot/bootPrefetch");
const { useInboxStore } = await import("../src/store/inboxStore");
const { useThreadStore } = await import("../src/store/threadStore");
const {
  hydrateThreadRepliesSnapshotWithSyncCore,
  readThreadRepliesSyncCoreScopeForTests,
  requestThreadRepliesRebaselineSnapshot,
  resetThreadRepliesSyncCoreForTests,
} = await import("../src/store/threadRepliesSyncDomain");
const { triggerMessagesSyncCoreReset } = await import("../src/store/messageSyncCoreReset");
const { invalidateReceiverPrivateIngressContexts } = await import("../src/store/receiverPrivateIngress");

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
        evaluations: [{ key: "sync_core_messages_v0", enabled }],
      },
    };
  }) as typeof api.post;
}

function stubMessageFlagEvaluation(enabled: boolean) {
  api.post = (async () => ({
    data: {
      evaluations: [{ key: "sync_core_messages_v0", enabled }],
    },
  })) as typeof api.post;
}

function stubThreadReplyFlagEvaluation(input: { syncCore: boolean }) {
  api.post = (async (_url: string, body?: { keys?: string[] }) => ({
    data: {
      evaluations: (body?.keys ?? REGISTERED_SERVER_FEATURE_FLAG_KEYS).map((key) => ({
        key,
        enabled: key === "sync_core_messages_v0" ? input.syncCore : false,
      })),
    },
  })) as typeof api.post;
}

afterEach(() => {
  api.post = originalPost as typeof api.post;
  api.get = originalGet as typeof api.get;
  resetThreadRepliesSyncCoreForTests();
  reactionReadModelStore.getState().reset();
  resetInboxStore();
  storage.clear();
});

function socketHandler(event: string, scheduleInboxRefresh: (trigger: string) => void = () => {}) {
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


function threadUpdatedHandler(scheduleInboxRefresh: (trigger: string) => void = () => {}) {
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

test("retired message sync flags are absent from server evaluation", () => {
  assert.equal(REGISTERED_SERVER_FEATURE_FLAG_KEYS.some(key => key.startsWith("sync_core_messages")), false);
});

test("socket message updates keep the existing store path after message sync removal", () => {
  resetServerStore();
  resetMessageStore();
  resetChannelStore();
  messageNewHandler()(message(1, "original"));
  socketHandler("message:updated")({ ...message(1, "updated"), pinned: true });
  const bucket = useMessageStore.getState().channelMessages[channelId] ?? [];
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0]?.content, "updated");
  assert.equal(bucket[0]?.pinned, true);
});

test("socket bridge: message:new keeps the direct store path after message sync removal", async () => {
  storage.clear();
  resetServerStore();
  resetMessageStore();
  resetChannelStore();
  stubSyncCoreFlagEvaluation(false);

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

  const staleAHandler = threadUpdatedHandler();

  setCurrentServer("server-b");
  useMessageStore.getState().setCurrentUserId("user-b");
  triggerServerReset();
  resetThreadStore();
  resetInboxStore();
  stubThreadReplyFlagEvaluation({ syncCore: true });

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
    stubThreadReplyFlagEvaluation({ syncCore });

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
    const triggers: string[] = [];
    const handler = threadUpdatedHandler((trigger) => { triggers.push(trigger); });
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
    assert.ok(!triggers.includes("thread_reply_rebaseline"), "no rebaseline refresh before the snapshot lands");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(publications, 1);
    assert.equal(triggers.at(-1), "thread_reply_rebaseline", "#triage:#229: the post-rebaseline refresh names itself");
    assert.equal(triggers.filter((trigger) => trigger === "thread_reply_rebaseline").length, 1);
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

test("receiver-private HTTP response for A cannot mutate or reactivate after auth switches to B", async () => {
  resetServerStore();
  resetMessageStore();
  useMessageStore.getState().setCurrentUserId("user-a");
  resetChannelStore();
  stubMessageFlagEvaluation(true);

  let resolveRequest!: (value: unknown) => void;
  const readFor: (string | null)[] = [];
  api.get = (async () => {
    readFor.push(useMessageStore.getState().currentUserId);
    // B's own read of the window, once A's is dropped: nothing for B.
    if (readFor.length > 1) return { data: { messages: [] } };
    return new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    });
  }) as typeof api.get;
  const pending = useMessageStore.getState().loadMessages(channelId);

  useMessageStore.getState().setCurrentUserId("user-b");
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

  assert.deepEqual(readFor, ["user-a", "user-b"], "the window is read again for B");
  assert.deepEqual(useMessageStore.getState().channelMessages[channelId], [], "A's rows are not B's window");
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

  const valid = {
    ...message(1, "valid"),
    reactions: [{ emoji: "👍", count: 1, previewK: [] }],
  };
  const malformed = {
    ...message(2, "malformed"),
    id: "message-sync-bridge-2",
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
  assert.equal(viewerGetCalls, 0, "resume must not request the retired normalized viewer state");
  assert.equal(reactionReadModelStore.getState().viewerVersions.size, 0);
});

function recordingBindings(syncVisibleScopes: () => Promise<void> = async () => {}) {
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const bindings = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit(event: string, ...args: unknown[]) { emitted.push({ event, args }); },
      on() {},
      off() {},
      onAny() {},
      offAny() {},
      disconnect() {},
      connect() {},
    },
    () => {},
    syncVisibleScopes,
    () => {},
    () => {},
  );
  const handler = (event: string) => {
    const binding = bindings.find((item) => item.event === event);
    assert.ok(binding);
    return binding.handler;
  };
  return { emitted, handler };
}

test("connect asks for a starting sync horizon once and keeps the answer", () => {
  useMessageStore.setState({ syncHorizon: null });
  __resetMessageHistoryRequestsForTests();
  api.get = (async () => ({ data: [] })) as typeof api.get;
  const { emitted, handler } = recordingBindings();

  handler("connect")();
  const request = emitted.find((entry) => entry.event === "sync:horizon");
  assert.ok(request, "connect requests sync:horizon");
  (request.args[0] as (response: { horizon: string }) => void)({ horizon: "1200" });
  assert.equal(useMessageStore.getState().syncHorizon, "1200");

  handler("connect")();
  assert.equal(emitted.filter((entry) => entry.event === "sync:horizon").length, 1, "a known horizon is not re-requested");
});

test("sync:resume carries the horizon and takes the next one from the response", async () => {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  stubMessageFlagEvaluation(false);
  useMessageStore.setState({ lastSeq: 40, syncHorizon: "1200" });
  const { emitted, handler } = recordingBindings();

  handler("rooms:joined")();
  const resume = emitted.find((entry) => entry.event === "sync:resume");
  assert.deepEqual(resume?.args[0], { lastSeq: 40, sinceHorizon: "1200" });

  handler("sync:resume:response")({ messages: [], currentSeq: 40, hasMore: false, horizon: "1350" });
  assert.equal(useMessageStore.getState().syncHorizon, "1350");

  handler("sync:resume:response")({ messages: [], currentSeq: 40, hasMore: false });
  assert.equal(useMessageStore.getState().syncHorizon, "1350", "an old server's response keeps the horizon");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("sync:resume without a horizon yet is sent exactly as before", async () => {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  stubMessageFlagEvaluation(false);
  useMessageStore.setState({ lastSeq: 40, syncHorizon: null });
  const { emitted, handler } = recordingBindings();

  handler("rooms:joined")();
  assert.deepEqual(emitted.find((entry) => entry.event === "sync:resume")?.args[0], { lastSeq: 40 });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a horizon reset re-reads the visible scopes", async () => {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  useMessageStore.setState({ lastSeq: 40, syncHorizon: "1200" });
  let visibleScopeSyncs = 0;
  const { handler } = recordingBindings(async () => { visibleScopeSyncs += 1; });

  handler("sync:resume:response")({ messages: [], currentSeq: 41, hasMore: false, horizon: "1400", horizonReset: true });

  assert.equal(visibleScopeSyncs, 1);
  assert.equal(useMessageStore.getState().syncHorizon, "1400");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a starting horizon whose reply arrives after a history request is not used", async () => {
  // Socket and HTTP are separate connections: once history has gone out, the
  // server may have taken the horizon after the history query, so a message in
  // flight during that query could fall below it.
  useMessageStore.setState({ syncHorizon: null });
  __resetMessageHistoryRequestsForTests();
  api.get = (async () => ({ data: [] })) as typeof api.get;
  const { emitted, handler } = recordingBindings();

  handler("connect")();
  const request = emitted.find((entry) => entry.event === "sync:horizon");
  assert.ok(request);
  await useMessageStore.getState().syncGap("channel-horizon-race", { sinceSeq: 5 });
  (request.args[0] as (response: { horizon: string }) => void)({ horizon: "1200" });

  assert.equal(useMessageStore.getState().syncHorizon, null, "the late starting horizon is dropped");
});

async function startingHorizonAfter(sendFirst: () => Promise<unknown>) {
  useMessageStore.setState({ syncHorizon: null });
  __resetMessageHistoryRequestsForTests();
  const { emitted, handler } = recordingBindings();
  handler("connect")();
  const request = emitted.find((entry) => entry.event === "sync:horizon");
  assert.ok(request);
  await sendFirst();
  (request.args[0] as (response: { horizon: string }) => void)({ horizon: "1300" });
  return useMessageStore.getState().syncHorizon;
}

test("loading newer messages before the starting horizon's reply drops that horizon", async () => {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  useMessageStore.setState({
    currentChannelId: channelId,
    loading: false,
    loadingNewer: false,
    hasNewer: true,
    channelWindowMeta: {},
    channelMessages: { [channelId]: [message(7, "loaded") as never] },
  });

  assert.equal(await startingHorizonAfter(() => useMessageStore.getState().loadNewerMessages(channelId)), null);
});

test("sending a message before the starting horizon's reply drops that horizon", async () => {
  api.post = (async () => ({ data: { ...message(8, "sent"), id: "message-sync-bridge-sent" } })) as typeof api.post;

  assert.equal(await startingHorizonAfter(
    () => useMessageStore.getState().sendMessage(channelId, "sent").catch(() => undefined),
  ), null);
});

test("a page of history the boot script read before the socket existed drops the socket's starting horizon", async () => {
  // Its read may predate the socket's horizon: the page's own horizon starts the rounds instead.
  (globalThis as Record<string, unknown>)[BOOT_FETCHES_GLOBAL] = [{
    u: "https://app.raft.build/api/messages/channel/c1?limit=50",
    h: {},
    t: Date.now(),
    p: new Promise(() => {}),
  }];
  try {
    assert.equal(await startingHorizonAfter(async () => {}), null);
  } finally {
    __resetBootFetchesForTest();
  }
  assert.equal(await startingHorizonAfter(async () => {}), "1300", "without one the socket's horizon is taken");
});
