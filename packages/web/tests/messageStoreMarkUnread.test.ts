import assert from "node:assert/strict";
import test from "node:test";
import type { LocalReadSuppression } from "../src/store/messageStore.js";

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

if (typeof document !== "undefined") {
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  Object.defineProperty(document, "hasFocus", {
    value: () => true,
    configurable: true,
  });
}

const {
  filterMentionFlagsByLocalReadSuppressions,
  filterUnreadCountsByLocalReadSuppressions,
  markCurrentBrowserTabActiveForAutoRead,
  useMessageStore,
} = await import("../src/store/messageStore.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { default: api } = await import("../src/api/client.js");

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetStores() {
  markCurrentBrowserTabActiveForAutoRead();
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Test Server",
      avatarUrl: null,
      slug: "test",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: new Date(0).toISOString(),
    },
    serverEpoch: 1,
  });
  useMessageStore.setState({
    channelMessages: {},
    messages: [],
    currentChannelId: null,
    unreadCounts: {},
    mentionFlags: {},
    hasNewer: false,
    isNearBottom: true,
  });
}

function restoreApi() {
  api.post = originalPost;
  api.get = originalGet;
}

test("markUnread shows the sidebar unread badge before the network round trip settles", async () => {
  const postResponse = deferred<{ data: { unreadCount: number } }>();
  const unreadSnapshotResponse = deferred<{ data: { "channel-1": number } }>();
  const postCalls: string[] = [];
  const getCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    return postResponse.promise;
  }) as typeof api.post;
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/channels/unread") return unreadSnapshotResponse.promise;
    return { data: {} };
  }) as typeof api.get;

  try {
    resetStores();

    const markUnreadPromise = useMessageStore.getState().markUnread("channel-1");

    assert.equal(useMessageStore.getState().unreadCounts["channel-1"], 1);
    await Promise.resolve();
    assert.deepEqual(postCalls, ["/channels/channel-1/unread"]);

    postResponse.resolve({ data: { unreadCount: 1 } });
    const markUnreadResult = await Promise.race([
      markUnreadPromise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    assert.equal(markUnreadResult, "resolved");
    assert.equal(useMessageStore.getState().unreadCounts["channel-1"], 1);
    await Promise.resolve();
    assert.deepEqual(getCalls, ["/channels/unread"]);
    unreadSnapshotResponse.resolve({ data: { "channel-1": 1 } });
    await Promise.resolve();
  } finally {
    restoreApi();
    resetStores();
  }
});

test("markUnread waits for an in-flight read cursor sync before rewinding the cursor", async () => {
  const readResponse = deferred<{ data: Record<string, never> }>();
  const postCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    if (url === "/channels/channel-1/read") return readResponse.promise;
    if (url === "/channels/channel-1/unread") return Promise.resolve({ data: { unreadCount: 1 } });
    return Promise.resolve({ data: {} });
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/unread") return { data: { "channel-1": 1 } };
    return { data: {} };
  }) as typeof api.get;

  try {
    resetStores();
    useMessageStore.setState({
      currentChannelId: "channel-1",
      messages: [
        {
          id: "message-10",
          seq: 10,
          channelId: "channel-1",
          senderType: "user",
          senderId: "user-2",
          content: "latest",
          createdAt: new Date(0).toISOString(),
        },
      ],
    });

    useMessageStore.getState().markCurrentChannelRead();
    assert.deepEqual(postCalls, ["/channels/channel-1/read"]);

    const markUnreadPromise = useMessageStore.getState().markUnread("channel-1");
    assert.equal(useMessageStore.getState().unreadCounts["channel-1"], 1);
    await Promise.resolve();
    assert.deepEqual(postCalls, ["/channels/channel-1/read"]);

    readResponse.resolve({ data: {} });
    await markUnreadPromise;

    assert.deepEqual(postCalls, ["/channels/channel-1/read", "/channels/channel-1/unread"]);
    assert.equal(useMessageStore.getState().unreadCounts["channel-1"], 1);
  } finally {
    restoreApi();
    resetStores();
  }
});

test("clearUnread clears marker-only mention flags without waiting for summary refresh", () => {
  try {
    resetStores();
    useMessageStore.setState({
      unreadCounts: { "channel-other": 2 },
      mentionFlags: { "channel-muted-mention": true, "channel-other": true },
    });

    useMessageStore.getState().clearUnread("channel-muted-mention");

    assert.deepEqual(useMessageStore.getState().unreadCounts, { "channel-other": 2 });
    assert.deepEqual(useMessageStore.getState().mentionFlags, { "channel-other": true });
  } finally {
    resetStores();
  }
});

test("markCurrentChannelRead clears muted mention marker with local read state", () => {
  const postCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    return Promise.resolve({ data: {} });
  }) as typeof api.post;

  try {
    resetStores();
    useMessageStore.setState({
      currentChannelId: "channel-muted-mention",
      unreadCounts: { "channel-muted-mention": 1 },
      mentionFlags: { "channel-muted-mention": true },
      messages: [
        {
          id: "message-20",
          seq: 20,
          channelId: "channel-muted-mention",
          senderType: "user",
          senderId: "user-2",
          content: "muted direct mention",
          createdAt: new Date(0).toISOString(),
        },
      ],
      hasNewer: false,
      isNearBottom: true,
    });

    useMessageStore.getState().markCurrentChannelRead();

    assert.deepEqual(useMessageStore.getState().unreadCounts, {});
    assert.deepEqual(useMessageStore.getState().mentionFlags, {});
    assert.deepEqual(postCalls, ["/channels/channel-muted-mention/read"]);
  } finally {
    restoreApi();
    resetStores();
  }
});

test("local read suppression filters only active stale unread and mention entries", () => {
  const now = 1_000;
  const suppressions = new Map<string, LocalReadSuppression>([
    ["active-unread", { seq: 10, expiresAt: now + 1 }],
    ["active-mention", { seq: 11, expiresAt: now + 1 }],
    ["expired-unread", { seq: 12, expiresAt: now }],
    ["expired-mention", { seq: 13, expiresAt: now - 1 }],
  ]);

  assert.deepEqual(
    filterUnreadCountsByLocalReadSuppressions({
      "active-unread": 1,
      "expired-unread": 2,
      "no-suppression-unread": 3,
    }, suppressions, now),
    {
      "expired-unread": 2,
      "no-suppression-unread": 3,
    },
  );
  assert.deepEqual(
    filterMentionFlagsByLocalReadSuppressions({
      "active-mention": true,
      "expired-mention": true,
      "no-suppression-mention": true,
    }, suppressions, now),
    {
      "expired-mention": true,
      "no-suppression-mention": true,
    },
  );
  assert.equal(suppressions.has("active-unread"), true);
  assert.equal(suppressions.has("active-mention"), true);
  assert.equal(suppressions.has("expired-unread"), false);
  assert.equal(suppressions.has("expired-mention"), false);
});

test("loadUnreadCounts keeps locally read mention markers suppressed while summary is stale", async () => {
  const postCalls: string[] = [];
  const getCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    if (url === "/channels/channel-joint/read-all") {
      return Promise.resolve({ data: { seq: 42 } });
    }
    return Promise.resolve({ data: {} });
  }) as typeof api.post;
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/channels/unread") {
      return {
        data: {
          channels: {
            "channel-joint": {
              unreadCount: 1,
              hasMention: true,
              hasAnyMention: true,
            },
          },
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetStores();
    useMessageStore.setState({
      unreadCounts: { "channel-joint": 1 },
      mentionFlags: { "channel-joint": true },
    });

    await useMessageStore.getState().markRead("channel-joint");
    assert.deepEqual(useMessageStore.getState().unreadCounts, {});
    assert.deepEqual(useMessageStore.getState().mentionFlags, {});

    await useMessageStore.getState().loadUnreadCounts();

    assert.deepEqual(postCalls, ["/channels/channel-joint/read-all"]);
    assert.deepEqual(getCalls, ["/channels/unread"]);
    assert.deepEqual(useMessageStore.getState().unreadCounts, {});
    assert.deepEqual(useMessageStore.getState().mentionFlags, {});
  } finally {
    restoreApi();
    resetStores();
  }
});
