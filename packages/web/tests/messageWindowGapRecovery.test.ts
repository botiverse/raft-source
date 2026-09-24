import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageWindowHarness,
  flushAsyncWork,
} from "./messageWindowHarness.js";
import { buildOptimisticMessageId } from "../src/components/message/optimisticMessageDraft.js";
import {
  compareMessagesForDisplay,
  isMatchingOptimisticMessage,
  selectChannelMessageBucket,
  selectChannelWindowMeta,
  useMessageStore,
} from "../src/store/messageStore.js";
import type {
  Message,
  MessageAttachment,
} from "../src/store/messageStore.js";
import { useThreadStore } from "../src/store/threadStore.js";
import type { ThreadSummary } from "../src/store/threadStore.js";
import type { ThreadReplyPreview } from "../src/store/threadRepliesReadModel.js";
import {
  hydrateThreadRepliesSnapshotWithSyncCore,
  resetThreadRepliesSyncCoreForTests,
} from "../src/store/threadRepliesSyncDomain.js";
import { useServerStore } from "../src/store/serverStore.js";

const CHANNEL_ID = "channel-1";
const SERIAL = { concurrency: false };

function message(seq: number): Message {
  return {
    id: `m-${seq}`,
    seq,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "u-1",
    senderName: "ray",
    messageType: "chat",
    content: `message ${seq}`,
    createdAt: new Date(2026, 3, 5, 0, 0, seq).toISOString(),
  };
}

function messageInChannel(channelId: string, seq: number): Message {
  return {
    ...message(seq),
    channelId,
  };
}

function setCurrentServer(serverId: string | null) {
  useServerStore.setState({
    current: serverId
      ? {
          id: serverId,
          name: "Server",
          slug: serverId,
          ownerId: "owner-1",
          onboardingAgentId: null,
          hideHumansFromMembers: false,
          plan: "free",
          planDowngradedAt: null,
          role: "member",
          createdAt: "2026-07-26T00:00:00.000Z",
        }
      : null,
  });
}

function configureRepliesSyncScope(
  harness: ReturnType<typeof createMessageWindowHarness>,
  serverId: string,
  principalId: string,
) {
  setCurrentServer(serverId);
  harness.setCurrentUser(principalId);
}

function resetSyncCoreMessagesTestState() {
  useMessageStore.getState().setCurrentUserId(null);
  setCurrentServer(null);
  resetThreadRepliesSyncCoreForTests();
}

function messageWithoutSeq(id: string, createdAt: string): Message {
  return {
    id,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "u-1",
    senderName: "ray",
    messageType: "chat",
    content: id,
    createdAt,
  };
}

function attachmentShape(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: "attachment-1",
    filename: "proof.png",
    mimeType: "image/png",
    sizeBytes: 12345,
    ...overrides,
  };
}

function optimisticSend(overrides: Partial<Message> = {}): Message {
  return {
    ...message(11),
    id: "optimistic-local-send",
    senderId: "stale-user-id",
    senderName: "Playwright Owner",
    content: "same body",
    createdAt: "2026-06-17T03:15:00.000Z",
    ...overrides,
  };
}

function persistedSend(overrides: Partial<Message> = {}): Message {
  return {
    ...message(11),
    id: "server-message-11",
    senderId: "u-1",
    senderName: "Playwright Owner",
    content: "same body",
    createdAt: "2026-06-17T03:15:01.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

test("isMatchingOptimisticMessage rejects non-optimistic or different message identity fields", SERIAL, () => {
  const optimistic = optimisticSend();
  const persisted = persistedSend();

  assert.equal(isMatchingOptimisticMessage(optimistic, persisted), true);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, id: "local-send" }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, channelId: "other-channel" }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, senderType: "agent" }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, content: "different body" }, persisted), false);
});

test("isMatchingOptimisticMessage prefers exact randomId over content heuristics", SERIAL, () => {
  const optimistic = optimisticSend({ randomId: "msg-1", content: "local edited placeholder" });
  const persisted = persistedSend({ randomId: "msg-1", content: "server canonical body" });

  assert.equal(isMatchingOptimisticMessage(optimistic, persisted), true);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, randomId: "msg-2", content: persisted.content }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, randomId: undefined, content: persisted.content }, persisted), true);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, content: persisted.content }, { ...persisted, randomId: undefined }), true);
});

test("randomId optimistic reconcile is independent of REST and socket arrival order", SERIAL, async () => {
  const optimistic = optimisticSend({
    id: "optimistic-random-order",
    randomId: "msg-order-1",
    content: "local draft body",
  });
  const persisted = persistedSend({
    id: "server-random-order",
    randomId: "msg-order-1",
    content: "server canonical body",
    seq: 12,
  });

  async function run(order: "rest-first" | "socket-first") {
    const harness = createMessageWindowHarness();
    try {
      harness.primeWindow(CHANNEL_ID, []);
      harness.optimisticMessage(optimistic);

      if (order === "socket-first") {
        harness.socketMessage(persisted);
        harness.enqueuePostResponses(persisted);
        await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id, optimistic.randomId ?? undefined);
      } else {
        harness.enqueuePostResponses(persisted);
        await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id, optimistic.randomId ?? undefined);
        harness.socketMessage(persisted);
      }

      await flushAsyncWork();
      return harness.messages(CHANNEL_ID);
    } finally {
      harness.restore();
    }
  }

  const restFirst = await run("rest-first");
  const socketFirst = await run("socket-first");

  assert.deepEqual(socketFirst, restFirst);
  assert.deepEqual(restFirst.map((message) => message.id), ["server-random-order"]);
  assert.equal(restFirst[0]?.content, "server canonical body");
  assert.equal(restFirst[0]?.randomId, "msg-order-1");
});

test("randomId duplicate canonical echoes are idempotent no-ops", SERIAL, () => {
  const persisted = persistedSend({
    id: "server-random-idempotent",
    randomId: "msg-idempotent-1",
    content: "server canonical body",
    seq: 12,
  });
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [persisted]);
    const before = harness.rawMessages(CHANNEL_ID);
    const beforeStore = useMessageStore.getState();

    harness.socketMessage(persisted);
    const afterOnce = harness.rawMessages(CHANNEL_ID);
    harness.socketMessage(persisted);
    const afterTwice = harness.rawMessages(CHANNEL_ID);

    assert.equal(afterOnce, before);
    assert.equal(afterTwice, before);
    assert.equal(useMessageStore.getState(), beforeStore);
    assert.deepEqual(harness.messages(CHANNEL_ID), [persisted]);
  } finally {
    harness.restore();
  }
});

test("explicit channel loadOlder updates that channel bucket without switching the visible mirror", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelA = [message(10)];
  const channelBLatest = { ...message(20), id: "channel-b-latest", channelId: "channel-b" };
  const channelBOlder = { ...message(19), id: "channel-b-older", channelId: "channel-b" };
  try {
    harness.primeWindow(CHANNEL_ID, channelA);
    useMessageStore.setState((state) => ({
      channelMessages: {
        ...state.channelMessages,
        "channel-b": [channelBLatest],
      },
      channelWindowMeta: {
        ...state.channelWindowMeta,
        "channel-b": {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          loadingGap: false,
          hasMore: true,
          hasNewer: false,
          hasGap: false,
          historyLimited: false,
          contextLoadError: null,
        },
      },
    }));
    harness.enqueueChannelPages([channelBOlder]);

    await harness.loadOlderMessages("channel-b");

    assert.deepEqual(harness.messages(CHANNEL_ID).map((item) => item.id), ["m-10"]);
    assert.deepEqual(harness.messages("channel-b").map((item) => item.id), ["channel-b-older", "channel-b-latest"]);
    assert.deepEqual(useMessageStore.getState().messages.map((item) => item.id), ["m-10"]);
    assert.deepEqual(harness.getCalls(), ["/messages/channel/channel-b?limit=50&before=20"]);
  } finally {
    harness.restore();
  }
});

test("empty channel selectors return a safe empty window and default metadata", SERIAL, () => {
  const harness = createMessageWindowHarness();
  try {
    const state = useMessageStore.getState();

    assert.deepEqual(selectChannelMessageBucket(state, null), []);
    assert.deepEqual(selectChannelMessageBucket(state, "missing-channel"), []);
    assert.deepEqual(selectChannelWindowMeta(state, null), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
  }
});

test("current-channel window selector mirrors legacy top-level metadata when no per-channel record exists", SERIAL, () => {
  const harness = createMessageWindowHarness();
  const channelId = "selector-current-channel";
  try {
    useMessageStore.setState({
      currentChannelId: channelId,
      loading: true,
      loadingOlder: true,
      loadingNewer: true,
      loadingGap: true,
      hasMore: false,
      hasNewer: true,
      hasGap: true,
      historyLimited: true,
      contextLoadError: "missing",
      channelWindowMeta: {},
    });

    assert.deepEqual(selectChannelWindowMeta(useMessageStore.getState(), channelId), {
      loading: true,
      loadingOlder: true,
      loadingNewer: true,
      loadingGap: true,
      hasMore: false,
      hasNewer: true,
      hasGap: true,
      historyLimited: true,
      contextLoadError: "missing",
    });
  } finally {
    harness.restore();
  }
});

test("loadMessages exposes per-channel loading state and then stores the loaded tail metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "load-tail-channel";
  const page = Array.from({ length: 50 }, (_, index) => messageInChannel(channelId, index + 1));
  const response = deferred<{ messages: Message[]; historyLimited: boolean }>();
  try {
    harness.enqueueChannelPages(response.promise);

    const pending = useMessageStore.getState().loadMessages(channelId);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: true,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
    assert.equal(harness.snapshot(channelId).loading, true);

    response.resolve({ messages: page, historyLimited: true });
    await pending;

    assert.equal(harness.snapshot(channelId).messageIds.length, 50);
    assert.equal(harness.snapshot(channelId).lastSeq, 50);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: true,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
  }
});

test("loadMessages hydrates inline replies before publishing their parent rows", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "atomic-inline-replies";
  const parent = {
    ...messageInChannel(channelId, 1),
    id: "parent-with-inline-replies",
    threadId: "thread-1",
  } as Message;
  const latestReply: ThreadReplyPreview = {
    messageId: "reply-2",
    seq: 2,
    preview: "reply already present on first paint",
    senderId: "u-2",
    senderType: "user",
    senderName: "reply-author",
    senderAvatarUrl: null,
    createdAt: "2026-07-26T04:00:00.000Z",
  };
  useThreadStore.setState({ summaries: {}, replyScopes: {} });

  let parentRendered = false;
  let parentRenderedWithoutReplies = false;
  let scrollTop = 640;
  const unsubscribeMessages = useMessageStore.subscribe((state) => {
    if (!state.messages.some((candidate) => candidate.id === parent.id)) return;
    parentRendered = true;
    if (!useThreadStore.getState().replyScopes[parent.id]) {
      parentRenderedWithoutReplies = true;
    }
  });
  const unsubscribeThreads = useThreadStore.subscribe(() => {
    // Model the browser's visible jump: growing an already-mounted parent row
    // would move the middle-of-history anchor by the reply block's height.
    if (parentRendered) scrollTop += 180;
  });

  try {
    harness.enqueueChannelPages({
      messages: [parent],
      historyLimited: false,
      threadSummariesByParentMessageId: {
        [parent.id]: {
          threadChannelId: "thread-1",
          replyCount: 1,
          lastReplyAt: latestReply.createdAt,
          participantIds: [latestReply.senderId],
          unreadCount: 0,
          firstUnreadMessageId: null,
          latestReplies: [latestReply],
        },
      },
    });

    await useMessageStore.getState().loadMessages(channelId);

    assert.equal(parentRendered, true, "the parent row should be published");
    assert.equal(
      parentRenderedWithoutReplies,
      false,
      "no committed frame may contain the parent without its bundled inline replies",
    );
    assert.equal(
      scrollTop,
      640,
      "the bundled response must not cause a post-paint inline-reply height mutation",
    );
    assert.equal(
      useThreadStore.getState().replyScopes[parent.id]?.replies[0]?.messageId,
      latestReply.messageId,
    );
  } finally {
    unsubscribeThreads();
    unsubscribeMessages();
    harness.restore();
    useThreadStore.setState({ summaries: {}, replyScopes: {} });
  }
});

test("loadMessages projects the Sync Core accepted HTTP snapshot without a rollout gate", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const serverId = "sync-http-server";
  const principalId = "sync-http-user";
  const channelId = "sync-http-channel";
  const parent = {
    ...messageInChannel(channelId, 1),
    id: "sync-http-parent",
    threadId: "sync-http-thread",
  } as Message;
  const acceptedReply: ThreadReplyPreview = {
    messageId: "reply-10",
    seq: 10,
    preview: "newer accepted reply",
    senderId: "u-2",
    senderType: "user",
    senderName: "reply-author",
    senderAvatarUrl: null,
    createdAt: "2026-07-26T10:00:00.000Z",
  };
  const staleReply: ThreadReplyPreview = {
    ...acceptedReply,
    messageId: "reply-5",
    seq: 5,
    preview: "stale HTTP reply",
  };
  useThreadStore.setState({ summaries: {}, replyScopes: {} });
  configureRepliesSyncScope(harness, serverId, principalId);
  hydrateThreadRepliesSnapshotWithSyncCore({
    serverId,
    principalId,
    parentMessageId: parent.id,
    threadChannelId: "sync-http-thread",
    replies: [acceptedReply],
    replyCount: 10,
    historyLimited: false,
    watermark: 10,
    epoch: "live-epoch",
  });

  let parentRenderedWithoutAcceptedProjection = false;
  const unsubscribe = useMessageStore.subscribe((state) => {
    if (!state.messages.some((candidate) => candidate.id === parent.id)) return;
    const threadState = useThreadStore.getState();
    if (
      threadState.replyScopes[parent.id]?.replies[0]?.messageId !== acceptedReply.messageId
      || threadState.summaries[parent.id]?.replyCount !== 10
    ) {
      parentRenderedWithoutAcceptedProjection = true;
    }
  });

  try {
    harness.enqueueChannelPages({
      messages: [parent],
      historyLimited: false,
      threadSummariesByParentMessageId: {
        [parent.id]: {
          threadChannelId: "sync-http-thread",
          replyCount: 5,
          lastReplyAt: staleReply.createdAt,
          participantIds: [staleReply.senderId],
          unreadCount: 0,
          firstUnreadMessageId: null,
          latestReplies: [staleReply],
        },
      },
    });

    await useMessageStore.getState().loadMessages(channelId);

    assert.equal(parentRenderedWithoutAcceptedProjection, false);
    assert.equal(useThreadStore.getState().summaries[parent.id]?.replyCount, 10);
    assert.deepEqual(
      useThreadStore.getState().summaries[parent.id]?.latestReplies?.map((item) => item.seq),
      [10],
    );
    assert.deepEqual(
      useThreadStore.getState().replyScopes[parent.id]?.replies.map((item) => item.seq),
      [10],
    );
  } finally {
    unsubscribe();
    harness.restore();
    resetSyncCoreMessagesTestState();
    useThreadStore.setState({ summaries: {}, replyScopes: {} });
  }
});

test("loadMessages ignores a stale owned generation before starting a request", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    await useMessageStore.getState().loadMessages(CHANNEL_ID, Number.NaN);

    assert.deepEqual(harness.getCalls(), []);
    assert.equal(useMessageStore.getState().currentChannelId, null);
  } finally {
    harness.restore();
  }
});

test("concurrent loadMessages calls settle each channel without stale responses clobbering the current projection", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const firstChannelId = "concurrent-load-first";
  const secondChannelId = "concurrent-load-second";
  const firstResponse = deferred<Message[]>();
  const secondResponse = deferred<Message[]>();
  try {
    harness.enqueueChannelPages(firstResponse.promise, secondResponse.promise);

    const firstPending = useMessageStore.getState().loadMessages(firstChannelId);
    const secondPending = useMessageStore.getState().loadMessages(secondChannelId);

    firstResponse.resolve([messageInChannel(firstChannelId, 10)]);
    await firstPending;

    assert.deepEqual(harness.messages(firstChannelId).map((item) => item.id), ["m-10"]);
    assert.equal(harness.windowMeta(firstChannelId).loading, false);
    assert.equal(useMessageStore.getState().currentChannelId, secondChannelId);
    assert.deepEqual(useMessageStore.getState().messages, []);
    assert.equal(useMessageStore.getState().loading, true);

    secondResponse.resolve([messageInChannel(secondChannelId, 20)]);
    await secondPending;

    assert.deepEqual(harness.messages(secondChannelId).map((item) => item.id), ["m-20"]);
    assert.equal(harness.windowMeta(secondChannelId).loading, false);
    assert.deepEqual(useMessageStore.getState().messages.map((item) => item.id), ["m-20"]);
    assert.equal(useMessageStore.getState().loading, false);
  } finally {
    harness.restore();
  }
});

test("a failed stale loadMessages call clears only its own loading metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const failedChannelId = "concurrent-load-failed";
  const currentChannelId = "concurrent-load-current";
  const failedResponse = deferred<Message[]>();
  const currentResponse = deferred<Message[]>();
  try {
    harness.enqueueChannelPages(failedResponse.promise, currentResponse.promise);

    const failedPending = useMessageStore.getState().loadMessages(failedChannelId);
    const currentPending = useMessageStore.getState().loadMessages(currentChannelId);

    failedResponse.reject(new Error("request failed"));
    await failedPending;

    assert.equal(harness.windowMeta(failedChannelId).loading, false);
    assert.equal(useMessageStore.getState().currentChannelId, currentChannelId);
    assert.equal(useMessageStore.getState().loading, true);

    currentResponse.resolve([messageInChannel(currentChannelId, 30)]);
    await currentPending;
    assert.equal(harness.windowMeta(currentChannelId).loading, false);
    assert.equal(useMessageStore.getState().loading, false);
  } finally {
    harness.restore();
  }
});

test("loadMessages reuses cached rows immediately while refreshing the channel tail", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "cache-reuse-channel";
  const response = deferred<Message[]>();
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)], { hasMore: false });
    harness.enqueueChannelPages(response.promise);

    const pending = useMessageStore.getState().loadMessages(channelId);
    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-10"]);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });

    response.resolve([messageInChannel(channelId, 11)]);
    await pending;

    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-11"]);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: false,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
  }
});

test("loadOlder is a no-op when the older window is already loading, exhausted, or empty", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "older-guard-channel";
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)], { hasMore: true });
    harness.setWindowMeta(channelId, { loadingOlder: true });
    await harness.loadOlderMessages(channelId);

    harness.setWindowMeta(channelId, { loadingOlder: false, hasMore: false });
    await harness.loadOlderMessages(channelId);

    harness.primeWindow("empty-channel", [], { hasMore: true });
    await harness.loadOlderMessages("empty-channel");

    assert.deepEqual(harness.getCalls(), []);
  } finally {
    harness.restore();
  }
});

test("loadOlder prepends one contiguous page without duplicating the anchor or dropping newer window metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "older-page-channel";
  const response = deferred<Message[]>();
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10), messageInChannel(channelId, 11), messageInChannel(channelId, 12)], {
      hasMore: true,
      hasNewer: true,
    });
    harness.enqueueChannelPages(response.promise);

    const pending = harness.loadOlderMessages(channelId);
    assert.equal(useMessageStore.getState().loadingOlder, true);
    assert.equal(harness.windowMeta(channelId).loadingOlder, true);
    response.resolve([messageInChannel(channelId, 8), messageInChannel(channelId, 9), messageInChannel(channelId, 10)]);
    await pending;

    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-8", "m-9", "m-10", "m-11", "m-12"]);
    assert.deepEqual(harness.messages(channelId).map((item) => item.seq), [8, 9, 10, 11, 12]);
    assert.deepEqual(harness.getCalls(), [`/messages/channel/${channelId}?limit=50&before=10`]);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: false,
      hasNewer: true,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
    assert.equal(harness.snapshot(channelId).hasMore, false);
    assert.equal(harness.snapshot(channelId).hasNewer, true);
    assert.equal(useMessageStore.getState().loadingOlder, false);
  } finally {
    harness.restore();
  }
});

test("loadOlder for a background channel only toggles that channel window metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const currentChannelId = "older-current-channel";
  const backgroundChannelId = "older-background-channel";
  const response = deferred<Message[]>();
  try {
    harness.primeWindow(currentChannelId, [messageInChannel(currentChannelId, 100)], {
      hasMore: false,
      hasNewer: true,
    });
    useMessageStore.setState((state) => ({
      channelMessages: {
        ...state.channelMessages,
        [backgroundChannelId]: [messageInChannel(backgroundChannelId, 10)],
      },
      channelWindowMeta: {
        ...state.channelWindowMeta,
        [backgroundChannelId]: {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          loadingGap: false,
          hasMore: true,
          hasNewer: true,
          hasGap: false,
          historyLimited: false,
          contextLoadError: null,
        },
      },
    }));
    harness.enqueueChannelPages(response.promise);

    const pending = harness.loadOlderMessages(backgroundChannelId);
    assert.equal(useMessageStore.getState().loadingOlder, false);
    assert.equal(harness.windowMeta(backgroundChannelId).loadingOlder, true);
    assert.deepEqual(harness.snapshot(currentChannelId).messageIds, ["m-100"]);

    response.resolve([messageInChannel(backgroundChannelId, 8), messageInChannel(backgroundChannelId, 9)]);
    await pending;

    assert.deepEqual(harness.messages(backgroundChannelId).map((item) => item.seq), [8, 9, 10]);
    assert.deepEqual(harness.snapshot(currentChannelId).messageIds, ["m-100"]);
    assert.equal(useMessageStore.getState().loadingOlder, false);
    assert.deepEqual(harness.windowMeta(backgroundChannelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: false,
      hasNewer: true,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
  }
});

test("loadOlder clears current loading state and channel metadata after a failed page", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "older-failure-channel";
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)], { hasMore: true });
    harness.enqueueChannelPages(Promise.reject(new Error("older failed")));

    const pending = harness.loadOlderMessages(channelId);
    assert.equal(useMessageStore.getState().loadingOlder, true);
    assert.equal(harness.windowMeta(channelId).loadingOlder, true);
    await pending;

    assert.equal(useMessageStore.getState().loadingOlder, false);
    assert.equal(harness.windowMeta(channelId).loadingOlder, false);
    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-10"]);
  } finally {
    harness.restore();
  }
});

test("loadNewer appends one contiguous page without duplicating the anchor or dropping older window metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "newer-page-channel";
  const response = deferred<Message[]>();
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10), messageInChannel(channelId, 11), messageInChannel(channelId, 12)], {
      hasMore: true,
      hasNewer: true,
    });
    harness.enqueueChannelPages(response.promise);

    const pending = harness.loadNewerMessages(channelId);
    assert.equal(useMessageStore.getState().loadingNewer, true);
    assert.equal(harness.windowMeta(channelId).loadingNewer, true);
    response.resolve([messageInChannel(channelId, 12), messageInChannel(channelId, 13), messageInChannel(channelId, 14)]);
    await pending;

    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-10", "m-11", "m-12", "m-13", "m-14"]);
    assert.deepEqual(harness.messages(channelId).map((item) => item.seq), [10, 11, 12, 13, 14]);
    assert.deepEqual(harness.getCalls(), [`/messages/channel/${channelId}?limit=50&after=12`]);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
    assert.equal(harness.snapshot(channelId).hasMore, true);
    assert.equal(harness.snapshot(channelId).hasNewer, false);
    assert.equal(harness.snapshot(channelId).lastSeq, 14);
    assert.equal(useMessageStore.getState().loadingNewer, false);
  } finally {
    harness.restore();
  }
});

test("loadNewer for a background channel only toggles that channel window metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const currentChannelId = "newer-current-channel";
  const backgroundChannelId = "newer-background-channel";
  const response = deferred<Message[]>();
  try {
    harness.primeWindow(currentChannelId, [messageInChannel(currentChannelId, 100)], {
      hasMore: true,
      hasNewer: false,
    });
    useMessageStore.setState((state) => ({
      channelMessages: {
        ...state.channelMessages,
        [backgroundChannelId]: [messageInChannel(backgroundChannelId, 10)],
      },
      channelWindowMeta: {
        ...state.channelWindowMeta,
        [backgroundChannelId]: {
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          loadingGap: false,
          hasMore: true,
          hasNewer: true,
          hasGap: false,
          historyLimited: false,
          contextLoadError: null,
        },
      },
    }));
    harness.enqueueChannelPages(response.promise);

    const pending = harness.loadNewerMessages(backgroundChannelId);
    assert.equal(useMessageStore.getState().loadingNewer, false);
    assert.equal(harness.windowMeta(backgroundChannelId).loadingNewer, true);
    assert.deepEqual(harness.snapshot(currentChannelId).messageIds, ["m-100"]);

    response.resolve([messageInChannel(backgroundChannelId, 11), messageInChannel(backgroundChannelId, 12)]);
    await pending;

    assert.deepEqual(harness.messages(backgroundChannelId).map((item) => item.seq), [10, 11, 12]);
    assert.deepEqual(harness.snapshot(currentChannelId).messageIds, ["m-100"]);
    assert.equal(useMessageStore.getState().loadingNewer, false);
    assert.deepEqual(harness.windowMeta(backgroundChannelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
  }
});

test("loadNewer clears current loading state and channel metadata after a failed page", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "newer-failure-channel";
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)], { hasNewer: true });
    harness.enqueueChannelPages(Promise.reject(new Error("newer failed")));

    const pending = harness.loadNewerMessages(channelId);
    assert.equal(useMessageStore.getState().loadingNewer, true);
    assert.equal(harness.windowMeta(channelId).loadingNewer, true);
    await pending;

    assert.equal(useMessageStore.getState().loadingNewer, false);
    assert.equal(harness.windowMeta(channelId).loadingNewer, false);
    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-10"]);
  } finally {
    harness.restore();
  }
});

test("loadNewer is a no-op when the newer window is already loading, absent, initial-loading, or empty", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "newer-guard-channel";
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)], { hasNewer: true });
    harness.setWindowMeta(channelId, { loadingNewer: true });
    await harness.loadNewerMessages(channelId);

    harness.setWindowMeta(channelId, { loadingNewer: false, hasNewer: false });
    await harness.loadNewerMessages(channelId);

    harness.setWindowMeta(channelId, { hasNewer: true, loading: true });
    await harness.loadNewerMessages(channelId);

    harness.primeWindow("empty-channel", [], { hasNewer: true });
    await harness.loadNewerMessages("empty-channel");

    assert.deepEqual(harness.getCalls(), []);
  } finally {
    harness.restore();
  }
});

test("canonical duplicate with stripped commentRef preserves scoped ref and bucket identity", SERIAL, () => {
  const scoped = persistedSend({
    id: "server-comment-ref",
    randomId: "msg-comment-ref",
    content: "server canonical body",
    commentRef: {
      type: "attachment_comment",
      fileId: "file-1",
      filename: "proof.png",
      commentId: "comment-1",
      anchorLabel: "line 7",
    },
  });
  const stripped = { ...scoped, commentRef: null };
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [scoped]);
    const beforeBucket = harness.rawMessages(CHANNEL_ID);
    const beforeMessage = beforeBucket?.[0];

    harness.socketMessage(stripped);

    assert.equal(harness.rawMessages(CHANNEL_ID), beforeBucket);
    assert.equal(harness.rawMessages(CHANNEL_ID)?.[0], beforeMessage);
    assert.deepEqual(harness.messages(CHANNEL_ID), [scoped]);
  } finally {
    harness.restore();
  }
});

test("stripped commentRef preservation does not ignore other nullable field changes", SERIAL, () => {
  const scoped = persistedSend({
    id: "server-comment-ref-null-field",
    randomId: "msg-comment-ref-null-field",
    content: "server canonical body",
    senderName: "Scoped Sender",
    commentRef: {
      type: "attachment_comment",
      fileId: "file-1",
      filename: "proof.png",
      commentId: "comment-1",
    },
  });
  const incoming = { ...scoped, senderName: null, commentRef: null } as Message;
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [scoped]);
    const beforeBucket = harness.rawMessages(CHANNEL_ID);
    const beforeMessage = beforeBucket?.[0];

    harness.socketMessage(incoming);

    const afterBucket = harness.rawMessages(CHANNEL_ID);
    assert.notEqual(afterBucket, beforeBucket);
    assert.notEqual(afterBucket?.[0], beforeMessage);
    assert.equal(afterBucket?.[0]?.senderName, null);
    assert.deepEqual(afterBucket?.[0]?.commentRef, scoped.commentRef);
  } finally {
    harness.restore();
  }
});

test("incoming scoped commentRef replaces an existing scoped ref", SERIAL, () => {
  const scoped = persistedSend({
    id: "server-comment-ref-replace",
    randomId: "msg-comment-ref-replace",
    content: "server canonical body",
    commentRef: {
      type: "attachment_comment",
      fileId: "file-1",
      filename: "old.png",
      commentId: "comment-old",
    },
  });
  const incoming: Message = {
    ...scoped,
    commentRef: {
      type: "attachment_comment",
      fileId: "file-2",
      filename: "new.png",
      commentId: "comment-new",
      anchorLabel: "line 9",
    },
  };
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [scoped]);

    harness.socketMessage(incoming);

    assert.deepEqual(harness.messages(CHANNEL_ID), [incoming]);
  } finally {
    harness.restore();
  }
});

test("null commentRef is preserved as a no-op only when an existing scoped ref is present", SERIAL, () => {
  const plain = persistedSend({
    id: "server-null-comment-ref",
    randomId: "msg-null-comment-ref",
    content: "server canonical body",
    commentRef: undefined,
  });
  const incoming = { ...plain, commentRef: null };
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [plain]);
    const beforeBucket = harness.rawMessages(CHANNEL_ID);
    const beforeMessage = beforeBucket?.[0];

    harness.socketMessage(incoming);

    const afterBucket = harness.rawMessages(CHANNEL_ID);
    assert.notEqual(afterBucket, beforeBucket);
    assert.notEqual(afterBucket?.[0], beforeMessage);
    assert.equal(afterBucket?.[0]?.commentRef, null);
  } finally {
    harness.restore();
  }
});

test("duplicate canonical socket echo can advance lastSeq without replacing buckets", SERIAL, () => {
  const persisted = persistedSend({
    id: "server-last-seq-advance",
    randomId: "msg-last-seq-advance",
    seq: 17,
  });
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [persisted], { lastSeq: 5 });
    const beforeBucket = harness.rawMessages(CHANNEL_ID);

    harness.socketMessage(persisted);

    assert.equal(harness.rawMessages(CHANNEL_ID), beforeBucket);
    assert.equal(harness.snapshot(CHANNEL_ID).lastSeq, 17);
  } finally {
    harness.restore();
  }
});

test("canonical socket update replaces only the matching existing message", SERIAL, () => {
  const first = persistedSend({
    id: "server-existing-first",
    randomId: "msg-existing-first",
    content: "old first",
    seq: 17,
  });
  const second = persistedSend({
    id: "server-existing-second",
    randomId: "msg-existing-second",
    content: "second unchanged",
    seq: 18,
  });
  const updatedFirst = { ...first, content: "updated first" };
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [first, second]);

    harness.socketMessage(updatedFirst);

    const messages = harness.messages(CHANNEL_ID);
    assert.deepEqual(messages.map((message) => message.id), [first.id, second.id]);
    assert.deepEqual(messages.map((message) => message.content), ["updated first", "second unchanged"]);
    assert.equal(messages[1], second);
  } finally {
    harness.restore();
  }
});

test("sendMessage canonical REST no-op preserves bucket and store identity after socket cleanup", SERIAL, async () => {
  const persisted = persistedSend({
    id: "server-rest-noop",
    randomId: "msg-rest-noop",
    content: "server canonical body",
    seq: 19,
  });
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [persisted]);
    const beforeBucket = harness.rawMessages(CHANNEL_ID);
    const beforeStore = useMessageStore.getState();
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, persisted.content, "optimistic-already-cleaned", persisted.randomId ?? undefined);
    await flushAsyncWork();

    assert.equal(harness.rawMessages(CHANNEL_ID), beforeBucket);
    assert.equal(useMessageStore.getState(), beforeStore);
    assert.deepEqual(harness.messages(CHANNEL_ID), [persisted]);
  } finally {
    harness.restore();
  }
});

test("sendMessage removes exact optimistic row when REST races after socket canonical echo", SERIAL, async () => {
  const optimistic = optimisticSend({
    id: "optimistic-rest-cleanup",
    randomId: "msg-rest-cleanup",
    content: "local draft body",
  });
  const persisted = persistedSend({
    id: "server-rest-cleanup",
    randomId: "msg-rest-cleanup",
    content: "server canonical body",
    seq: 20,
  });
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [persisted, optimistic]);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id, optimistic.randomId ?? undefined);
    await flushAsyncWork();

    assert.deepEqual(harness.messages(CHANNEL_ID).map((message) => message.id), [persisted.id]);
    assert.deepEqual(useMessageStore.getState().messages.map((message) => message.id), [persisted.id]);
    assert.equal(harness.snapshot(CHANNEL_ID).lastSeq, 20);
  } finally {
    harness.restore();
  }
});

test("isMatchingOptimisticMessage accepts stale sender fallback only inside the narrow safety envelope", SERIAL, () => {
  const optimistic = optimisticSend({
    attachments: [attachmentShape({ id: "optimistic-att-1" })],
  });
  const persisted = persistedSend({
    attachments: [attachmentShape({ id: "real-att-1" })],
  });

  assert.equal(isMatchingOptimisticMessage(optimistic, persisted), true);
  assert.equal(
    isMatchingOptimisticMessage(
      {
        ...optimistic,
        senderId: persisted.senderId,
        senderName: "Wrong Local Name",
        attachments: [],
        createdAt: "2026-06-17T03:00:00.000Z",
      },
      persisted,
    ),
    true,
  );
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, senderName: undefined }, persisted), false);
  assert.equal(isMatchingOptimisticMessage(optimistic, { ...persisted, senderName: undefined }), false);
  assert.equal(
    isMatchingOptimisticMessage(
      { ...optimistic, senderName: undefined },
      { ...persisted, senderName: undefined },
    ),
    false,
  );
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, senderName: "Other Owner" }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, attachments: [] }, persisted), false);
  assert.equal(
    isMatchingOptimisticMessage(
      { ...optimistic, attachments: [attachmentShape({ filename: "other.png" })] },
      persisted,
    ),
    false,
  );
  assert.equal(
    isMatchingOptimisticMessage(
      { ...optimistic, attachments: [attachmentShape({ mimeType: "image/jpeg" })] },
      persisted,
    ),
    false,
  );
  assert.equal(
    isMatchingOptimisticMessage(
      { ...optimistic, attachments: [attachmentShape({ sizeBytes: 999 })] },
      persisted,
    ),
    false,
  );
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, createdAt: "not-a-date" }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, createdAt: "2026-06-17T03:09:59.000Z" }, persisted), false);
  assert.equal(isMatchingOptimisticMessage({ ...optimistic, createdAt: "2026-06-17T03:10:01.000Z" }, persisted), true);
});

test("keeps contiguous socket messages on the normal append path", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [message(10)]);

    harness.socketMessage(message(11));

    const snapshot = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(snapshot.messageIds, ["m-10", "m-11"]);
    assert.equal(snapshot.hasGap, false);
    assert.equal(snapshot.unreadCount, 1);
    assert.deepEqual(harness.getCalls(), []);
  } finally {
    harness.restore();
  }
});

test("does not count a socket echo of the current user's message as unread after switching channels", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.setCurrentUser("u-1");
    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.switchCurrentChannel("channel-2");

    harness.socketMessage(message(11));

    assert.equal(harness.snapshot(CHANNEL_ID).unreadCount, 0);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), ["m-10", "m-11"]);
  } finally {
    harness.restore();
  }
});

test("counts other senders as unread after switching channels", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.setCurrentUser("u-1");
    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.switchCurrentChannel("channel-2");

    harness.socketMessage({ ...message(11), senderId: "u-2" });

    assert.equal(harness.snapshot(CHANNEL_ID).unreadCount, 1);
  } finally {
    harness.restore();
  }
});

test("does not count current-user messages as unread during sync resume", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.setCurrentUser("u-1");
    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.switchCurrentChannel("channel-2");

    harness.batchMessages([
      message(11),
      { ...message(12), senderId: "u-2" },
    ]);

    assert.equal(harness.snapshot(CHANNEL_ID).unreadCount, 1);
  } finally {
    harness.restore();
  }
});

test("keeps no-seq cached messages ordered by createdAt while sending a new tail message", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const recentPrevious = messageWithoutSeq("recent-previous", "2026-06-17T03:13:00.000Z");
    const stalePrevious = messageWithoutSeq("stale-previous", "2026-06-02T08:24:00.000Z");
    const optimistic: Message = {
      ...messageWithoutSeq("optimistic-local-send", "2026-06-17T03:15:00.000Z"),
      content: "fresh send",
    };
    const persisted: Message = {
      ...optimistic,
      id: "server-message-15",
      seq: 15,
    };

    // Mirrors a stale client cache where two legacy/no-seq messages are in
    // the wrong relative order until a full channel reload normalizes them.
    harness.primeWindow(CHANNEL_ID, [recentPrevious, stalePrevious], { lastSeq: 14 });

    harness.optimisticMessage(optimistic);
    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, [
      "stale-previous",
      "recent-previous",
      "optimistic-local-send",
    ]);

    harness.socketMessage(persisted);
    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, [
      "stale-previous",
      "recent-previous",
      "server-message-15",
    ]);
  } finally {
    harness.restore();
  }
});

test("replaces optimistic self messages even when sender profile was not loaded yet", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "",
      senderName: "You",
      content: "sent while auth profile loads",
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Ray",
      content: optimistic.content,
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["m-10", "server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("replaces optimistic self messages from socket when sender profile is stale", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "stale-user-id",
      senderName: "Playwright Owner",
      content: "sent while auth profile is stale",
      createdAt: "2026-06-17T03:15:00.000Z",
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Playwright Owner",
      content: optimistic.content,
      createdAt: "2026-06-17T03:15:01.000Z",
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["m-10", "server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("replaces the closest matching optimistic row and keeps other pending sends", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const firstOptimistic = optimisticSend({
      id: "optimistic-a-first",
      content: "same text twice",
      createdAt: "2026-06-17T03:15:00.000Z",
    });
    const nonMatchingNearEcho = optimisticSend({
      id: "optimistic-near-other-content",
      content: "different text",
      createdAt: "2026-06-17T03:15:09.000Z",
    });
    const secondOptimistic = optimisticSend({
      id: "optimistic-z-second",
      content: "same text twice",
      createdAt: "2026-06-17T03:15:10.000Z",
    });
    const persistedSecond = persistedSend({
      id: "server-message-12",
      seq: 12,
      content: "same text twice",
      createdAt: "2026-06-17T03:15:09.000Z",
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(firstOptimistic);
    harness.optimisticMessage(nonMatchingNearEcho);
    harness.optimisticMessage(secondOptimistic);
    harness.socketMessage(persistedSecond);

    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), [
      "m-10",
      "optimistic-a-first",
      "optimistic-near-other-content",
      "server-message-12",
    ]);
  } finally {
    harness.restore();
  }
});

test("[#481] rapid same-millisecond optimistic ids preserve send order before random suffix", SERIAL, () => {
  const nowMs = Date.parse("2026-06-17T03:15:00.000Z");
  const first = buildOptimisticMessageId(nowMs, 1, "z-random");
  const second = buildOptimisticMessageId(nowMs, 2, "a-random");

  assert.ok(
    first < second,
    "same-ms optimistic ids must sort by send sequence before random token so rapid sends do not reorder arbitrarily",
  );
});

test("[#481] display ordering treats optimistic display seq as a server-adjacent coordinate", SERIAL, () => {
  const invalidTime = "not-a-date";
  const persisted = persistedSend({ id: "server-message-11", seq: 11, createdAt: invalidTime });
  const earlierOptimistic = optimisticSend({
    id: "optimistic-display-10",
    seq: undefined,
    optimisticDisplaySeq: 10,
    createdAt: invalidTime,
  });
  const laterOptimistic = optimisticSend({
    id: "optimistic-display-12",
    seq: undefined,
    optimisticDisplaySeq: 12,
    createdAt: invalidTime,
  });
  const tiedEarlierId = optimisticSend({
    id: "optimistic-a",
    seq: undefined,
    optimisticDisplaySeq: 12,
    createdAt: invalidTime,
  });
  const tiedLaterId = optimisticSend({
    id: "optimistic-b",
    seq: undefined,
    optimisticDisplaySeq: 12,
    createdAt: invalidTime,
  });
  const legacyNoSeq = messageWithoutSeq("legacy-no-seq", invalidTime);
  const lowIdDisplaySeq = optimisticSend({
    id: "a-display-seq",
    seq: undefined,
    optimisticDisplaySeq: 12,
    createdAt: invalidTime,
  });
  const highIdLegacyNoSeq = messageWithoutSeq("z-legacy-no-seq", invalidTime);
  const lowIdLegacyNoSeq = messageWithoutSeq("a-legacy-no-seq", invalidTime);

  assert.ok(compareMessagesForDisplay(earlierOptimistic, persisted) < 0);
  assert.ok(compareMessagesForDisplay(persisted, earlierOptimistic) > 0);
  assert.ok(compareMessagesForDisplay(persisted, laterOptimistic) < 0);
  assert.ok(compareMessagesForDisplay(laterOptimistic, persisted) > 0);
  assert.ok(compareMessagesForDisplay(tiedEarlierId, tiedLaterId) < 0);
  assert.ok(compareMessagesForDisplay(laterOptimistic, legacyNoSeq) > 0);
  assert.ok(compareMessagesForDisplay(legacyNoSeq, laterOptimistic) < 0);
  assert.ok(compareMessagesForDisplay(lowIdDisplaySeq, highIdLegacyNoSeq) > 0);
  assert.ok(compareMessagesForDisplay(highIdLegacyNoSeq, lowIdDisplaySeq) < 0);
  assert.ok(compareMessagesForDisplay(highIdLegacyNoSeq, lowIdLegacyNoSeq) > 0);
});

test("[#481] optimistic display seq assignment ignores legacy no-seq rows and preserves explicit coordinates", SERIAL, () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [
      messageWithoutSeq("legacy-no-seq", "not-a-date"),
      optimisticSend({
        id: "optimistic-existing",
        seq: undefined,
        optimisticDisplaySeq: 15,
        createdAt: "not-a-date",
      }),
    ]);

    harness.optimisticMessage(
      optimisticSend({
        id: "optimistic-next",
        seq: undefined,
        optimisticDisplaySeq: undefined,
        createdAt: "not-a-date",
      }),
    );
    assert.equal(
      harness.messages(CHANNEL_ID).find((msg) => msg.id === "optimistic-next")?.optimisticDisplaySeq,
      16,
    );

    harness.optimisticMessage(
      optimisticSend({
        id: "optimistic-preset",
        seq: undefined,
        optimisticDisplaySeq: 99,
        createdAt: "not-a-date",
      }),
    );
    assert.equal(
      harness.messages(CHANNEL_ID).find((msg) => msg.id === "optimistic-preset")?.optimisticDisplaySeq,
      99,
    );

    harness.optimisticMessage(
      optimisticSend({
        id: "optimistic-real-seq",
        seq: 50,
        optimisticDisplaySeq: undefined,
        createdAt: "not-a-date",
      }),
    );
    assert.equal(
      harness.messages(CHANNEL_ID).find((msg) => msg.id === "optimistic-real-seq")?.optimisticDisplaySeq,
      undefined,
    );
  } finally {
    harness.restore();
  }
});

test("[#481] rapid same-content same-ms optimistic rows reconcile in send order", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const createdAt = "2026-06-17T03:15:00.000Z";
    const nowMs = Date.parse(createdAt);
    const firstOptimistic = optimisticSend({
      id: buildOptimisticMessageId(nowMs, 1, "z-random"),
      seq: undefined,
      content: "same body rapid-send",
      createdAt,
    });
    const secondOptimistic = optimisticSend({
      id: buildOptimisticMessageId(nowMs, 2, "a-random"),
      seq: undefined,
      content: firstOptimistic.content,
      createdAt,
    });
    const firstPersisted = persistedSend({
      id: "server-message-11",
      seq: 11,
      content: firstOptimistic.content,
      createdAt,
    });
    const secondPersisted = persistedSend({
      id: "server-message-12",
      seq: 12,
      content: firstOptimistic.content,
      createdAt,
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(firstOptimistic);
    harness.optimisticMessage(secondOptimistic);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), [
      "m-10",
      firstOptimistic.id,
      secondOptimistic.id,
    ]);

    harness.socketMessage(firstPersisted);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), [
      "m-10",
      "server-message-11",
      secondOptimistic.id,
    ]);

    harness.socketMessage(secondPersisted);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), [
      "m-10",
      "server-message-11",
      "server-message-12",
    ]);
  } finally {
    harness.restore();
  }
});

test("uses id tiebreak when two matching optimistic rows are equally close to the real echo", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const laterId = optimisticSend({
      id: "optimistic-z",
      content: "same text twice",
      createdAt: "2026-06-17T03:14:59.000Z",
    });
    const earlierId = optimisticSend({
      id: "optimistic-a",
      content: "same text twice",
      createdAt: "2026-06-17T03:15:01.000Z",
    });
    const persisted = persistedSend({
      id: "server-message-12",
      seq: 12,
      content: "same text twice",
      createdAt: "2026-06-17T03:15:00.000Z",
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(laterId);
    harness.optimisticMessage(earlierId);
    harness.socketMessage(persisted);

    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), [
      "m-10",
      "optimistic-z",
      "server-message-12",
    ]);
  } finally {
    harness.restore();
  }
});

test("ignores invalid optimistic createdAt when choosing the closest matching row", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const invalidTimeOptimistic = optimisticSend({
      id: "optimistic-invalid-time",
      senderId: "u-1",
      content: "same text twice",
      createdAt: "not-a-date",
    });
    const validTimeOptimistic = optimisticSend({
      id: "optimistic-valid-time",
      senderId: "u-1",
      content: "same text twice",
      createdAt: "2026-06-17T03:15:01.000Z",
    });
    const persisted = persistedSend({
      id: "server-message-12",
      seq: 12,
      senderId: "u-1",
      content: "same text twice",
      createdAt: "2026-06-17T03:15:00.000Z",
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(invalidTimeOptimistic);
    harness.optimisticMessage(validTimeOptimistic);
    harness.socketMessage(persisted);

    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), [
      "m-10",
      "optimistic-invalid-time",
      "server-message-12",
    ]);
  } finally {
    harness.restore();
  }
});

test("removes the exact optimistic row when the HTTP response resolves after a sender mismatch", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "stale-user-id",
      senderName: "Playwright Owner",
      content: "sent while auth profile is stale",
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Playwright Owner",
      content: optimistic.content,
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["m-10", "server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("sendMessage creates a clean channel bucket when the channel was not loaded", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const persisted = persistedSend({
      content: "send into unloaded channel",
    });

    harness.primeWindow("channel-2", [messageWithoutSeq("visible-message", "2026-06-17T03:00:00.000Z")]);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, persisted.content);

    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), ["server-message-11"]);
    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["visible-message"]);
  } finally {
    harness.restore();
  }
});

test("removes a matching optimistic row during HTTP cleanup even without the exact optimistic id", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic = optimisticSend({
      content: "cleanup by fallback match",
    });
    const persisted = persistedSend({
      content: optimistic.content,
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["m-10", "server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("HTTP cleanup tolerates a real message with no attachment array", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic = optimisticSend({
      content: "[1 attachment]",
      attachments: [{
        ...attachmentShape({ id: "optimistic-att-0" }),
        localPreviewUrl: "blob:http://localhost/proof",
      }],
    });
    const persisted = persistedSend({
      content: optimistic.content,
      attachments: undefined,
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["m-10", "server-message-11"]);
    assert.equal(harness.messages(CHANNEL_ID)[1].attachments, undefined);
  } finally {
    harness.restore();
  }
});

test("updates an existing socket row at index zero during exact HTTP cleanup", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic = optimisticSend({
      content: "[1 attachment]",
      senderName: "Local Owner",
      attachments: [{
        ...attachmentShape({ id: "optimistic-att-0" }),
        width: 1600,
        height: 900,
        localPreviewUrl: "blob:http://localhost/proof",
        thumbnailUrl: null,
      }],
    });
    const persisted = persistedSend({
      content: optimistic.content,
      senderName: "Server Owner",
      attachments: [{
        ...attachmentShape({ id: "real-att-0" }),
        width: null,
        height: null,
        thumbnailUrl: "/api/attachments/real-att-0/thumbnail",
      }],
    });

    harness.primeWindow(CHANNEL_ID, []);
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    const messages = harness.messages(CHANNEL_ID);
    assert.deepEqual(messages.map((msg) => msg.id), ["server-message-11"]);
    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["server-message-11"]);
    assert.equal(messages[0].attachments?.[0]?.localPreviewUrl, "blob:http://localhost/proof");
    assert.equal(messages[0].attachments?.[0]?.width, 1600);
    assert.equal(messages[0].attachments?.[0]?.height, 900);
  } finally {
    harness.restore();
  }
});

test("HTTP cleanup for a non-current channel does not replace the visible channel messages", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic = optimisticSend({
      content: "background channel send",
      senderName: "Local Owner",
    });
    const persisted = persistedSend({
      content: optimistic.content,
      senderName: "Server Owner",
    });

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.switchCurrentChannel("channel-2");
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, []);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((msg) => msg.id), ["m-10", "server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("existing persisted HTTP cleanup advances lastSeq when socket state was stale", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const persisted = persistedSend({
      id: "server-message-11",
      seq: 11,
      content: "already inserted",
    });

    harness.primeWindow(CHANNEL_ID, [persisted], { lastSeq: 3 });
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, persisted.content);

    assert.equal(harness.snapshot(CHANNEL_ID).lastSeq, 11);
    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("updates an existing socket row with local previews during exact HTTP cleanup", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "stale-user-id",
      senderName: "Local Owner",
      content: "[1 attachment]",
      attachments: [{
        id: "optimistic-att-0",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        width: 1600,
        height: 900,
        localPreviewUrl: "blob:http://localhost/proof",
        thumbnailUrl: null,
      }],
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Server Owner",
      content: optimistic.content,
      attachments: [{
        id: "real-att-0",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        width: null,
        height: null,
        thumbnailUrl: "/api/attachments/real-att-0/thumbnail",
      }],
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    const messages = harness.messages(CHANNEL_ID);
    assert.deepEqual(messages.map((msg) => msg.id), ["m-10", "server-message-11"]);
    assert.equal(messages[1].attachments?.[0]?.localPreviewUrl, "blob:http://localhost/proof");
    assert.equal(messages[1].attachments?.[0]?.width, 1600);
    assert.equal(messages[1].attachments?.[0]?.height, 900);
  } finally {
    harness.restore();
  }
});

test("removes the exact optimistic row even if the socket echo already inserted the real message", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "stale-user-id",
      senderName: "Playwright Owner",
      content: "socket wins before ack cleanup",
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Playwright Owner",
      content: optimistic.content,
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    assert.deepEqual(harness.snapshot(CHANNEL_ID).messageIds, ["m-10", "server-message-11"]);
  } finally {
    harness.restore();
  }
});

test("keeps local image preview through socket optimistic replacement", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "",
      senderName: "You",
      content: "[1 attachment]",
      attachments: [{
        id: "optimistic-att-0",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        width: 1600,
        height: 900,
        localPreviewUrl: "blob:http://localhost/proof",
        thumbnailUrl: null,
      }],
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Ray",
      content: optimistic.content,
      attachments: [{
        id: "real-att-0",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        width: null,
        height: null,
        thumbnailUrl: "/api/attachments/real-att-0/thumbnail",
      }],
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.socketMessage(persisted);

    const messages = harness.messages(CHANNEL_ID);
    assert.deepEqual(messages.map((msg) => msg.id), ["m-10", "server-message-11"]);
    assert.equal(messages[1].attachments?.[0]?.localPreviewUrl, "blob:http://localhost/proof");
    assert.equal(messages[1].attachments?.[0]?.width, 1600);
    assert.equal(messages[1].attachments?.[0]?.height, 900);
  } finally {
    harness.restore();
  }
});

test("keeps local image preview through HTTP ack optimistic replacement", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const optimistic: Message = {
      ...message(11),
      id: "optimistic-local-send",
      senderId: "stale-user-id",
      senderName: "Playwright Owner",
      content: "[1 attachment]",
      attachments: [{
        id: "optimistic-att-0",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        width: 1600,
        height: 900,
        localPreviewUrl: "blob:http://localhost/proof",
        thumbnailUrl: null,
      }],
    };
    const persisted: Message = {
      ...message(11),
      id: "server-message-11",
      senderId: "u-1",
      senderName: "Playwright Owner",
      content: optimistic.content,
      attachments: [{
        id: "real-att-0",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        width: null,
        height: null,
        thumbnailUrl: "/api/attachments/real-att-0/thumbnail",
      }],
    };

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.optimisticMessage(optimistic);
    harness.enqueuePostResponses(persisted);

    await harness.sendMessage(CHANNEL_ID, optimistic.content, optimistic.id);

    const messages = harness.messages(CHANNEL_ID);
    assert.deepEqual(messages.map((msg) => msg.id), ["m-10", "server-message-11"]);
    assert.equal(messages[1].attachments?.[0]?.localPreviewUrl, "blob:http://localhost/proof");
    assert.equal(messages[1].attachments?.[0]?.width, 1600);
    assert.equal(messages[1].attachments?.[0]?.height, 900);
  } finally {
    harness.restore();
  }
});

test("reuses a loaded channel window for focused message context navigation", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [message(10), message(11), message(12)]);

    await harness.loadMessageContext(CHANNEL_ID, "m-11");

    const snapshot = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(snapshot.messageIds, ["m-10", "m-11", "m-12"]);
    assert.equal(snapshot.highlightedMessageId, "m-11");
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.hasGap, false);
    assert.deepEqual(harness.getCalls(), []);
  } finally {
    harness.restore();
  }
});

test("canonical reply context opens the owning thread before restoring the parent timeline", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const originalOpenThread = useThreadStore.getState().openThread;
  const openRequests: Array<{
    parentChannelId: string;
    parentMessageId: string;
    focusedMessageId?: string | null;
  }> = [];
  let canonicalReplyLeakedIntoParentTimeline = false;
  const unsubscribe = useMessageStore.subscribe((state) => {
    if (state.messages.some((candidate) => candidate.id === "canonical-reply")) {
      canonicalReplyLeakedIntoParentTimeline = true;
    }
  });
  try {
    useThreadStore.setState({
      openThread: async (request) => {
        assert.deepEqual(
          harness.getCalls(),
          ["/messages/context/clicked-reply-alias"],
          "the canonical thread opens before the parent timeline reload starts",
        );
        openRequests.push(request);
      },
    });
    harness.enqueueContextPages({
      messages: [{
        ...messageInChannel("canonical-thread-channel", 99),
        id: "canonical-reply",
      }],
      canonicalTarget: {
        kind: "thread",
        channelId: "canonical-parent-channel",
        messageId: "canonical-reply",
        threadParentMessageId: "canonical-parent-message",
        threadChannelId: "canonical-thread-channel",
      },
    });
    harness.enqueueChannelPages([
      messageInChannel("requested-parent-channel", 40),
      messageInChannel("requested-parent-channel", 41),
    ]);

    await harness.loadMessageContext("requested-parent-channel", "clicked-reply-alias");

    assert.deepEqual(openRequests, [{
      parentChannelId: "canonical-parent-channel",
      parentMessageId: "canonical-parent-message",
      focusedMessageId: "canonical-reply",
    }]);
    assert.deepEqual(
      harness.getCalls(),
      [
        "/messages/context/clicked-reply-alias",
        "/messages/channel/requested-parent-channel?limit=50",
      ],
      "after routing the canonical reply into its thread, the requested parent timeline is restored",
    );
    assert.equal(
      canonicalReplyLeakedIntoParentTimeline,
      false,
      "the reply context payload must never flash as the parent-channel timeline",
    );
  } finally {
    unsubscribe();
    useThreadStore.setState({ openThread: originalOpenThread });
    harness.restore();
  }
});

test("falls back to the channel timeline when focused message context is missing", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.enqueueChannelPages([message(20), message(21), message(22)]);

    await harness.loadMessageContext(CHANNEL_ID, "missing-message");

    const snapshot = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(snapshot.messageIds, ["m-20", "m-21", "m-22"]);
    assert.equal(snapshot.highlightedMessageId, null);
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.contextLoadError, "message.chatPanel.messageNotFound");
    assert.equal(harness.windowMeta(CHANNEL_ID).loading, false);
    assert.equal(harness.windowMeta(CHANNEL_ID).contextLoadError, "message.chatPanel.messageNotFound");
    assert.deepEqual(harness.getCalls(), [
      "/messages/context/missing-message",
      "/messages/channel/channel-1?limit=50",
    ]);
  } finally {
    harness.restore();
  }
});

test("stale focused-context failure cannot publish after leaving and re-entering the channel", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const staleContext = deferred<{
    messages: Message[];
    hasOlder: boolean;
    hasNewer: boolean;
    targetMessageId: string;
  }>();
  const otherChannelId = "channel-2";
  try {
    harness.enqueueContextPages(staleContext.promise);
    const pendingContext = useMessageStore.getState().loadMessageContext(CHANNEL_ID, "stale-message");

    harness.enqueueChannelPages(
      [messageInChannel(otherChannelId, 30)],
      [messageInChannel(CHANNEL_ID, 40), messageInChannel(CHANNEL_ID, 41)],
    );
    await useMessageStore.getState().loadMessages(otherChannelId);
    await useMessageStore.getState().loadMessages(CHANNEL_ID);

    staleContext.reject(new Error("stale context failed"));
    await pendingContext;

    const snapshot = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(snapshot.messageIds, ["m-40", "m-41"]);
    assert.equal(snapshot.highlightedMessageId, null);
    assert.equal(snapshot.contextLoadError, null);
    assert.equal(harness.windowMeta(CHANNEL_ID).contextLoadError, null);
    assert.deepEqual(harness.getCalls(), [
      "/messages/context/stale-message",
      "/messages/channel/channel-2?limit=50",
      "/messages/channel/channel-1?limit=50",
    ]);
  } finally {
    harness.restore();
  }
});

test("stale focused-context success cannot replace a newer channel visit", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const staleContext = deferred<{
    messages: Message[];
    hasOlder: boolean;
    hasNewer: boolean;
    targetMessageId: string;
  }>();
  const otherChannelId = "channel-2";
  try {
    harness.enqueueContextPages(staleContext.promise);
    const pendingContext = useMessageStore.getState().loadMessageContext(CHANNEL_ID, "stale-message");

    harness.enqueueChannelPages(
      [messageInChannel(otherChannelId, 30)],
      [messageInChannel(CHANNEL_ID, 40), messageInChannel(CHANNEL_ID, 41)],
    );
    await useMessageStore.getState().loadMessages(otherChannelId);
    await useMessageStore.getState().loadMessages(CHANNEL_ID);

    staleContext.resolve({
      messages: [messageInChannel(CHANNEL_ID, 900)],
      hasOlder: true,
      hasNewer: true,
      targetMessageId: "stale-message",
    });
    await pendingContext;

    const snapshot = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(snapshot.messageIds, ["m-40", "m-41"]);
    assert.equal(snapshot.highlightedMessageId, null);
    assert.equal(snapshot.hasNewer, false);
    assert.equal(snapshot.contextLoadError, null);
  } finally {
    harness.restore();
  }
});

test("focused-context success stays bound to its channel when navigation changes without another request", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const staleContext = deferred<{
    messages: Message[];
    hasOlder: boolean;
    hasNewer: boolean;
    targetMessageId: string;
  }>();
  const otherChannelId = "channel-2";
  try {
    harness.enqueueContextPages(staleContext.promise);
    const pendingContext = useMessageStore.getState().loadMessageContext(CHANNEL_ID, "stale-message");

    harness.primeWindow(otherChannelId, [messageInChannel(otherChannelId, 30)]);
    useMessageStore.setState({ highlightedMessageId: null });
    staleContext.resolve({
      messages: [messageInChannel(CHANNEL_ID, 900)],
      hasOlder: true,
      hasNewer: true,
      targetMessageId: "stale-message",
    });
    await pendingContext;

    const snapshot = harness.snapshot(otherChannelId);
    assert.deepEqual(snapshot.messageIds, ["m-30"]);
    assert.equal(snapshot.highlightedMessageId, null);
    assert.equal(useMessageStore.getState().currentChannelId, otherChannelId);
    assert.deepEqual(harness.messages(CHANNEL_ID), []);
  } finally {
    harness.restore();
  }
});

test("loadMessageContext publishes focused context-window metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "context-window-channel";
  const response = deferred<{
    messages: Message[];
    hasOlder: boolean;
    hasNewer: boolean;
    targetMessageId: string;
  }>();
  try {
    harness.enqueueContextPages(response.promise);

    const pending = harness.loadMessageContext(channelId, "m-21");
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: true,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });

    response.resolve({
      messages: [messageInChannel(channelId, 20), messageInChannel(channelId, 21), messageInChannel(channelId, 22)],
      hasOlder: true,
      hasNewer: true,
      targetMessageId: "m-21",
    });
    await pending;

    const snapshot = harness.snapshot(channelId);
    assert.deepEqual(snapshot.messageIds, ["m-20", "m-21", "m-22"]);
    assert.equal(snapshot.highlightedMessageId, "m-21");
    assert.equal(snapshot.lastSeq, 22);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: true,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
  }
});

test("loadMessageContext hydrates inline replies before publishing the context parent", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "context-inline-replies";
  const parent = {
    ...messageInChannel(channelId, 21),
    id: "context-parent-with-replies",
    threadId: "context-thread-1",
  } as Message;
  const latestReply: ThreadReplyPreview = {
    messageId: "context-reply-1",
    seq: 1,
    preview: "context reply present on first paint",
    senderId: "u-2",
    senderType: "user",
    senderName: "reply-author",
    senderAvatarUrl: null,
    createdAt: "2026-07-26T08:00:00.000Z",
  };
  useThreadStore.setState({ summaries: {}, replyScopes: {} });
  configureRepliesSyncScope(harness, "context-sync-server", "context-sync-user");

  let parentRendered = false;
  let parentRenderedWithoutReplies = false;
  const unsubscribe = useMessageStore.subscribe((state) => {
    if (!state.messages.some((candidate) => candidate.id === parent.id)) return;
    parentRendered = true;
    if (!useThreadStore.getState().replyScopes[parent.id]) {
      parentRenderedWithoutReplies = true;
    }
  });

  try {
    harness.enqueueContextPages({
      messages: [parent],
      hasOlder: true,
      hasNewer: true,
      targetMessageId: parent.id,
      threadSummariesByParentMessageId: {
        [parent.id]: {
          threadChannelId: "context-thread-1",
          replyCount: 1,
          lastReplyAt: latestReply.createdAt,
          participantIds: [latestReply.senderId],
          unreadCount: 0,
          firstUnreadMessageId: null,
          latestReplies: [latestReply],
        },
      },
    });

    await harness.loadMessageContext(channelId, parent.id);

    assert.equal(parentRendered, true);
    assert.equal(
      parentRenderedWithoutReplies,
      false,
      "a focused context parent must not commit before its bundled inline replies",
    );
    assert.equal(
      useThreadStore.getState().replyScopes[parent.id]?.replies[0]?.messageId,
      latestReply.messageId,
    );
  } finally {
    unsubscribe();
    harness.restore();
    resetSyncCoreMessagesTestState();
    useThreadStore.setState({ summaries: {}, replyScopes: {} });
  }
});

test("loadMessageWindowSilent publishes context-window metadata without highlight", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "silent-context-channel";
  const response = deferred<{
    messages: Message[];
    threadSummariesByParentMessageId: Record<string, ThreadSummary>;
    hasOlder: boolean;
    hasNewer: boolean;
  }>();
  useThreadStore.setState({ summaries: {}, replyScopes: {} });
  configureRepliesSyncScope(harness, "silent-sync-server", "silent-sync-user");
  try {
    harness.enqueueContextPages(response.promise);

    const pending = harness.loadMessageWindowSilent(channelId, "m-21");
    assert.equal(harness.windowMeta(channelId).loading, true);
    response.resolve({
      messages: [messageInChannel(channelId, 20), messageInChannel(channelId, 21), messageInChannel(channelId, 22)],
      threadSummariesByParentMessageId: {
        "m-21": {
          threadChannelId: "silent-thread-1",
          replyCount: 1,
          lastReplyAt: "2026-07-26T08:01:00.000Z",
          participantIds: ["u-2"],
          unreadCount: 0,
          firstUnreadMessageId: null,
          latestReplies: [{
            messageId: "silent-reply-1",
            seq: 1,
            preview: "silent context reply",
            senderId: "u-2",
            senderType: "user",
            senderName: "reply-author",
            senderAvatarUrl: null,
            createdAt: "2026-07-26T08:01:00.000Z",
          }],
        },
      },
      hasOlder: false,
      hasNewer: true,
    });
    await pending;

    const snapshot = harness.snapshot(channelId);
    assert.deepEqual(snapshot.messageIds, ["m-20", "m-21", "m-22"]);
    assert.equal(snapshot.highlightedMessageId, null);
    assert.equal(useThreadStore.getState().replyScopes["m-21"]?.replies[0]?.messageId, "silent-reply-1");
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: false,
      hasNewer: true,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
  } finally {
    harness.restore();
    resetSyncCoreMessagesTestState();
    useThreadStore.setState({ summaries: {}, replyScopes: {} });
  }
});

test("exitContextWindow clears context flags in both visible mirror and channel metadata", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "exit-context-channel";
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 21)], {
      hasMore: true,
      hasNewer: true,
      hasGap: true,
      loadingGap: true,
      contextLoadError: "Message not found",
    });
    useMessageStore.setState({
      highlightedMessageId: "m-21",
      contextLoadError: "Message not found",
    });

    useMessageStore.getState().exitContextWindow(channelId);

    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: false,
      hasMore: true,
      hasNewer: false,
      hasGap: false,
      historyLimited: false,
      contextLoadError: null,
    });
    assert.equal(useMessageStore.getState().loadingNewer, false);
    assert.equal(useMessageStore.getState().loadingGap, false);
    assert.equal(useMessageStore.getState().hasNewer, false);
    assert.equal(useMessageStore.getState().hasGap, false);
    assert.equal(useMessageStore.getState().highlightedMessageId, null);
    assert.equal(useMessageStore.getState().contextLoadError, null);
  } finally {
    harness.restore();
  }
});

test("loadMessageWindowSilent clears metadata loading after a failed context page", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "silent-context-failure";
  try {
    harness.enqueueContextPages(Promise.reject(new Error("context failed")));

    const pending = harness.loadMessageWindowSilent(channelId, "m-21");
    assert.equal(harness.windowMeta(channelId).loading, true);
    await pending;

    assert.equal(useMessageStore.getState().loading, false);
    assert.equal(harness.windowMeta(channelId).loading, false);
  } finally {
    harness.restore();
  }
});

test("defers non-contiguous socket messages until gap recovery fills the missing seqs", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.enqueueSyncPages([message(11), message(12), message(13)]);

    harness.socketMessage(message(13));

    const beforeRecovery = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(beforeRecovery.messageIds, ["m-10"]);
    assert.equal(beforeRecovery.hasGap, true);
    assert.equal(beforeRecovery.unreadCount, 1);

    await flushAsyncWork();

    const afterRecovery = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(afterRecovery.messageIds, ["m-10", "m-11", "m-12", "m-13"]);
    assert.equal(afterRecovery.hasGap, false);
    assert.equal(afterRecovery.loadingGap, false);
    assert.equal(afterRecovery.unreadCount, 1);
    assert.deepEqual(harness.getCalls(), ["/messages/sync?since_seq=10&limit=200&channel_id=channel-1"]);
  } finally {
    harness.restore();
  }
});

test("re-stitches a deferred socket message even if sync returns only the missing range", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.enqueueSyncPages([message(11), message(12)]);

    harness.socketMessage(message(13));

    const beforeRecovery = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(beforeRecovery.messageIds, ["m-10"]);
    assert.equal(beforeRecovery.hasGap, true);

    await flushAsyncWork();

    const afterRecovery = harness.snapshot(CHANNEL_ID);
    assert.deepEqual(afterRecovery.messageIds, ["m-10", "m-11", "m-12", "m-13"]);
    assert.equal(afterRecovery.hasGap, false);
    assert.equal(afterRecovery.loadingGap, false);
    assert.deepEqual(harness.getCalls(), ["/messages/sync?since_seq=10&limit=200&channel_id=channel-1"]);
  } finally {
    harness.restore();
  }
});

test("channel-scoped gap sync starts from the loaded window tail, not the global lastSeq", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [message(10)], { lastSeq: 100 });
    harness.enqueueSyncPages([[]]);

    await harness.syncGap(CHANNEL_ID);

    assert.deepEqual(harness.getCalls(), ["/messages/sync?since_seq=10&limit=200&channel_id=channel-1"]);
  } finally {
    harness.restore();
  }
});

test("channel-scoped gap sync publishes loading-gap metadata and clears it after stitching", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "gap-meta-channel";
  const response = deferred<Message[]>();
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)]);
    harness.enqueueSyncPages(response.promise);

    const pending = harness.syncGap(channelId);
    assert.equal(harness.snapshot(channelId).hasGap, true);
    assert.deepEqual(harness.windowMeta(channelId), {
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      loadingGap: true,
      hasMore: true,
      hasNewer: false,
      hasGap: true,
      historyLimited: false,
      contextLoadError: null,
    });

    response.resolve([messageInChannel(channelId, 11), messageInChannel(channelId, 12)]);
    await pending;

    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-10", "m-11", "m-12"]);
    assert.equal(harness.snapshot(channelId).hasGap, false);
    assert.equal(harness.snapshot(channelId).loadingGap, false);
    assert.equal(harness.windowMeta(channelId).hasGap, false);
    assert.equal(harness.windowMeta(channelId).loadingGap, false);
  } finally {
    harness.restore();
  }
});

test("channel-scoped gap sync clears loading-gap metadata after a failed sync", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const channelId = "gap-failure-channel";
  try {
    harness.primeWindow(channelId, [messageInChannel(channelId, 10)]);
    harness.enqueueSyncPages(Promise.reject(new Error("sync failed")));

    const pending = harness.syncGap(channelId);
    assert.equal(useMessageStore.getState().loadingGap, true);
    assert.equal(harness.windowMeta(channelId).loadingGap, true);
    await pending;

    assert.equal(useMessageStore.getState().loadingGap, false);
    assert.equal(harness.windowMeta(channelId).loadingGap, false);
    assert.deepEqual(harness.snapshot(channelId).messageIds, ["m-10"]);
  } finally {
    harness.restore();
  }
});

test("gap recovery paginates until the missing range is fully stitched back together", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  try {
    const firstPage = Array.from({ length: 200 }, (_, index) => message(11 + index));
    const secondPage = [message(211), message(212), message(213)];

    harness.primeWindow(CHANNEL_ID, [message(10)]);
    harness.enqueueSyncPages(firstPage, secondPage);

    harness.socketMessage(message(213));
    await flushAsyncWork();

    const snapshot = harness.snapshot(CHANNEL_ID);
    assert.equal(snapshot.messageIds.length, 204);
    assert.equal(snapshot.messageIds[0], "m-10");
    assert.equal(snapshot.messageIds.at(-1), "m-213");
    assert.deepEqual(harness.getCalls(), [
      "/messages/sync?since_seq=10&limit=200&channel_id=channel-1",
      "/messages/sync?since_seq=210&limit=200&channel_id=channel-1",
    ]);
  } finally {
    harness.restore();
  }
});

// #3774 regression (artin, 2026-07-06): "first open a thread + send → message
// flashes to the TOP then jumps back". On first open the thread bucket is still
// empty (history not loaded), so getMaxDisplaySeq([]) = 0 → the optimistic got
// optimisticDisplaySeq=1; once the history loaded with real server seqs the row
// sorted to the top. Fix floors the display coordinate at the global lastSeq.
test("[#3774] optimistic sent on first thread open (empty bucket) gets a server-scale display seq from lastSeq, stays at the bottom", SERIAL, () => {
  const harness = createMessageWindowHarness();
  try {
    // Empty bucket (thread history not loaded yet) but the client has already
    // seen server seqs elsewhere — lastSeq is high.
    harness.primeWindow(CHANNEL_ID, [], { lastSeq: 8531120 });
    harness.optimisticMessage(
      optimisticSend({ id: "optimistic-x", seq: undefined, optimisticDisplaySeq: undefined, createdAt: "not-a-date" }),
    );

    const assigned = harness.messages(CHANNEL_ID).find((m) => m.id === "optimistic-x")?.optimisticDisplaySeq;
    // Was getMaxDisplaySeq([]) + 1 = 1 before the fix; now floored at lastSeq.
    assert.ok(
      assigned !== undefined && assigned > 8531120,
      `optimistic display seq must be server-scale (> lastSeq); got ${assigned}`,
    );

    // Thread history then loads with a real (older) server seq — the optimistic
    // must stay at the BOTTOM, not sort to the top.
    harness.socketMessage(persistedSend({ id: "reply-1", seq: 8531100, createdAt: "not-a-date" }));
    const ids = harness.snapshot(CHANNEL_ID).messageIds;
    assert.equal(
      ids.at(-1),
      "optimistic-x",
      `optimistic must be last (bottom), not top; got ${JSON.stringify(ids)}`,
    );
  } finally {
    harness.restore();
  }
});
