import assert from "node:assert/strict";
import test from "node:test";

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
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const { useThreadStore } = await import("../src/store/threadStore.js");
const { useInboxStore } = await import("../src/store/inboxStore.js");
const { default: api } = await import("../src/api/client.js");

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

test("markThreadUnfollowed keeps the exact Activity row and clears its attention state", () => {
  const item = {
    kind: "thread" as const,
    threadChannelId: "thread-unfollow",
    parentMessageId: "parent-1",
    parentChannelId: "channel-parent",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-1",
    firstUnreadMessageId: "reply-1",
    lastActivityAt: "2026-07-30T00:00:00.000Z",
    lastReplyAt: "2026-07-30T00:00:00.000Z",
    replyCount: 1,
    unreadCount: 1,
    hasMention: true,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
  };

  useInboxStore.setState({
    items: [item],
    unfollowedItems: [],
    unfollowedLoading: true,
    unfollowedLoaded: false,
    totalUnreadCount: 1,
    activeUnreadCount: 1,
  });
  useInboxStore.getState().markThreadUnfollowed(item);

  const state = useInboxStore.getState();
  assert.equal(state.items.length, 1, "successful unfollow must retain the Activity row");
  assert.equal(state.unfollowedItems.length, 0, "active rows must not populate the compatibility history overlay");
  const retained = state.items[0];
  assert.equal(retained.kind, "thread");
  assert.equal(retained.kind === "thread" ? retained.threadChannelId : null, item.threadChannelId);
  assert.equal(retained.kind === "thread" ? retained.isFollowing : null, false);
  assert.equal(retained.unreadCount, 0);
  assert.equal(retained.hasMention, false);
  assert.equal(state.totalUnreadCount, 0);
  assert.equal(state.activeUnreadCount, 0);
  assert.equal(state.unfollowedLoading, true);
  assert.equal(state.unfollowedLoaded, false);

  useInboxStore.setState({
    items: [],
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: false,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
  });
});

test("markThreadUnfollowed preserves live reply progress that arrives while the RPC is pending", () => {
  const snapshot = {
    kind: "thread" as const,
    threadChannelId: "thread-unfollow-live",
    parentMessageId: "parent-live",
    parentChannelId: "channel-parent",
    parentChannelName: "general",
    parentChannelType: "channel" as const,
    parentMessagePreview: "parent",
    parentMessageSenderType: "user" as const,
    parentMessageSenderId: "user-1",
    latestActivityPreview: "old reply",
    latestActivitySenderType: "user" as const,
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-old",
    firstUnreadMessageId: "reply-old",
    lastActivityAt: "2026-07-30T00:00:00.000Z",
    lastReplyAt: "2026-07-30T00:00:00.000Z",
    replyCount: 1,
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
  };
  const live = {
    ...snapshot,
    latestActivityPreview: "new reply during RPC",
    latestActivityMessageId: "reply-new",
    firstUnreadMessageId: "reply-new",
    lastActivityAt: "2026-07-30T00:01:00.000Z",
    lastReplyAt: "2026-07-30T00:01:00.000Z",
    replyCount: 2,
    unreadCount: 2,
    hasMention: true,
  };
  useInboxStore.setState({
    items: [live],
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: true,
    totalUnreadCount: 2,
    activeUnreadCount: 2,
  });

  useInboxStore.getState().markThreadUnfollowed(snapshot);

  const state = useInboxStore.getState();
  const retained = state.items[0];
  assert.equal(retained?.kind, "thread");
  assert.equal(retained?.kind === "thread" ? retained.latestActivityMessageId : null, "reply-new");
  assert.equal(retained?.kind === "thread" ? retained.latestActivityPreview : null, "new reply during RPC");
  assert.equal(retained?.kind === "thread" ? retained.replyCount : null, 2);
  assert.equal(retained?.unreadCount, 0);
  assert.equal(retained?.hasMention, false);
  assert.equal(state.totalUnreadCount, 0);
  assert.equal(state.activeUnreadCount, 0);
  assert.deepEqual(state.unfollowedItems, []);
});

test("markThreadRefollowed preserves the row and clears unfollowed state", () => {
  const item = {
    kind: "thread" as const,
    threadChannelId: "thread-refollow",
    parentMessageId: "parent-refollow",
    parentChannelId: "channel-parent",
    parentChannelName: "general",
    parentChannelType: "channel" as const,
    parentMessagePreview: "parent",
    parentMessageSenderType: "user" as const,
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user" as const,
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: "2026-07-29T00:00:00.000Z",
    lastReplyAt: "2026-07-29T00:00:00.000Z",
    replyCount: 1,
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    isFollowing: false,
    unfollowedAt: "2026-07-29T00:01:00.000Z",
  };
  useInboxStore.setState({
    items: [item],
    unfollowedItems: [item],
    unfollowedLoading: false,
    unfollowedLoaded: true,
  });

  useInboxStore.getState().markThreadRefollowed(item.threadChannelId);

  const state = useInboxStore.getState();
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0]?.kind, "thread");
  assert.equal(state.items[0]?.kind === "thread" ? state.items[0].isFollowing : null, true);
  assert.equal(state.items[0]?.kind === "thread" ? state.items[0].unfollowedAt : "missing", null);
  assert.equal(state.unfollowedItems.length, 0);
  assert.equal(state.unfollowedLoading, false);
  assert.equal(state.unfollowedLoaded, true);
});

test("unfollowThread posts the unfollow endpoint and drops the thread optimistically", async () => {
  const postCalls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    return { data: {} };
  }) as typeof api.post;

  try {
    useThreadStore.setState({
      followedThreads: [
        {
          threadChannelId: "thread-unfollow",
          parentMessageId: "parent-1",
          parentChannelId: "channel-parent",
          parentChannelName: "general",
          parentChannelType: "channel",
          parentMessagePreview: "parent",
          parentMessageSenderType: "user",
          parentMessageSenderId: "user-1",
          replyCount: 2,
          lastReplyAt: "2026-06-29T00:00:00.000Z",
          unreadCount: 1,
          taskNumber: null,
          taskStatus: null,
          taskClaimedByName: null,
        },
        {
          threadChannelId: "thread-keep",
          parentMessageId: "parent-2",
          parentChannelId: "channel-parent",
          parentChannelName: "general",
          parentChannelType: "channel",
          parentMessagePreview: "keep",
          parentMessageSenderType: "user",
          parentMessageSenderId: "user-2",
          replyCount: 0,
          lastReplyAt: null,
          unreadCount: 0,
          taskNumber: null,
          taskStatus: null,
          taskClaimedByName: null,
        },
      ],
    });

    await useThreadStore.getState().unfollowThread("thread-unfollow");

    assert.deepEqual(postCalls, [
      { url: "/channels/threads/unfollow", body: { threadChannelId: "thread-unfollow" } },
    ]);
    assert.deepEqual(
      useThreadStore.getState().followedThreads.map((t) => t.threadChannelId),
      ["thread-keep"],
    );
  } finally {
    api.post = originalPost;
    useThreadStore.setState({ followedThreads: [] });
  }
});

test("unfollowThread rejects persistence failures so Activity does not remove a canonical row", async () => {
  const expected = new Error("unfollow failed");
  api.post = (async () => {
    throw expected;
  }) as typeof api.post;

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      useThreadStore.getState().unfollowThread("thread-unfollow"),
      (error) => error === expected,
    );
  } finally {
    console.error = originalConsoleError;
    api.post = originalPost;
  }
});

test("followThread rejects persistence failures so Activity keeps unfollowed state", async () => {
  const expected = new Error("follow failed");
  api.post = (async () => {
    throw expected;
  }) as typeof api.post;

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      useThreadStore.getState().followThread("parent-refollow"),
      (error) => error === expected,
    );
  } finally {
    console.error = originalConsoleError;
    api.post = originalPost;
  }
});

test("followThread resolves after canonical success when followed-list refresh fails", async () => {
  const postCalls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    return { data: { ok: true } };
  }) as typeof api.post;
  api.get = (async () => {
    throw new Error("followed list refresh failed");
  }) as typeof api.get;

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await useThreadStore.getState().followThread("parent-refollow");
    assert.deepEqual(postCalls, [
      {
        url: "/channels/threads/follow",
        body: { parentMessageId: "parent-refollow" },
      },
    ]);
  } finally {
    console.error = originalConsoleError;
    api.post = originalPost;
    api.get = originalGet;
  }
});
