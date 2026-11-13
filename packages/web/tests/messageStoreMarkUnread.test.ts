import assert from "node:assert/strict";
import type { LocalReadSuppression } from "../src/store/messageStore";

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
} = await import("../src/store/messageStore");
const { useServerStore } = await import("../src/store/serverStore");
const { default: api } = await import("../src/api/client");
const { applyReadStateUpdate } = await import("../src/store/applyReadStateUpdate");
const { isScopeMarkedUnread, useMarkedUnreadStore } = await import("../src/store/markedUnreadStore");
const { resetReadStateSyncForTests } = await import("../src/store/readStateSync");

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

test("markUnread waits for the server before showing a sidebar unread badge", async () => {
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

    assert.equal(useMessageStore.getState().unreadCounts["channel-1"], undefined);
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

test("a Mark as Unread answer (marked, version 3) that lands after a read at version 4 does not bring the dot back", async () => {
  const unreadResponse = deferred<{ data: Record<string, unknown> }>();
  api.post = ((url: string) => (
    url === "/channels/channel-1/unread" ? unreadResponse.promise : Promise.resolve({ data: {} })
  )) as typeof api.post;
  api.get = (async () => ({ data: {} })) as typeof api.get;
  try {
    resetStores();
    resetReadStateSyncForTests();
    useMarkedUnreadStore.setState({ marked: {} });
    const marking = useMessageStore.getState().markUnread("channel-1");
    await Promise.resolve();
    // The mark's own event and then a read (another device) reach the ledger first.
    applyReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 5, readStateVersion: 3, markedUnread: true });
    assert.equal(isScopeMarkedUnread("channel-1"), true);
    applyReadStateUpdate({ serverId: "server-1", scopeId: "channel-1", maxReadSeq: 5, readStateVersion: 4 });
    assert.equal(isScopeMarkedUnread("channel-1"), false);

    unreadResponse.resolve({ data: { ok: true, unreadCount: 0, markedUnread: true, maxReadSeq: 5, readStateVersion: 3 } });
    await marking;
    assert.equal(isScopeMarkedUnread("channel-1"), false, "the late answer is older than the read: no dot");
  } finally {
    restoreApi();
    resetStores();
    resetReadStateSyncForTests();
    useMarkedUnreadStore.setState({ marked: {} });
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
    assert.equal(useMessageStore.getState().unreadCounts["channel-1"], undefined);
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


test("manual unread receipt survives lagging RW summaries until its cursor version arrives", async () => {
  resetStores();
  api.post = (async () => ({ data: { unreadCount: 1, maxReadSeq: 20, readStateVersion: 7 } })) as typeof api.post;
  let snapshot: unknown = { channels: {} };
  api.get = (async () => ({ data: snapshot })) as typeof api.get;
  try {
    await useMessageStore.getState().markUnread("lagging-channel");
    await useMessageStore.getState().loadUnreadCounts();
    assert.equal(useMessageStore.getState().unreadCounts["lagging-channel"], 1, "omitted stale row cannot undo canonical receipt");
    snapshot = { channels: { "lagging-channel": { unreadCount: 0, readState: { kind: "present", maxReadSeq: "30", readStateVersion: 6, latestActivity: null } } } };
    await useMessageStore.getState().loadUnreadCounts();
    assert.equal(useMessageStore.getState().unreadCounts["lagging-channel"], 1, "older summary version cannot clear badge");
    snapshot = { channels: { "lagging-channel": { unreadCount: 1, readState: { kind: "present", maxReadSeq: "20", readStateVersion: 7, latestActivity: null } } } };
    await useMessageStore.getState().loadUnreadCounts();
    assert.equal(useMessageStore.getState().unreadCounts["lagging-channel"], 1);
    snapshot = { channels: { "lagging-channel": { unreadCount: 0, readState: { kind: "present", maxReadSeq: "30", readStateVersion: 8, latestActivity: null } } } };
    await useMessageStore.getState().loadUnreadCounts();
    assert.equal(useMessageStore.getState().unreadCounts["lagging-channel"], undefined, "newer read can clear badge after catch-up");
  } finally { restoreApi(); resetStores(); }
});

test("manual unread with no eligible message never invents a badge", async () => {
  resetStores();
  const response = deferred<{ data: { unreadCount: number } }>();
  api.post = (() => response.promise) as typeof api.post;
  api.get = (async () => ({ data: {} })) as typeof api.get;
  try {
    const pending = useMessageStore.getState().markUnread("own-only");
    assert.equal(useMessageStore.getState().unreadCounts["own-only"], undefined);
    response.resolve({ data: { unreadCount: 0 } });
    await pending;
    assert.equal(useMessageStore.getState().unreadCounts["own-only"], undefined);
  } finally { restoreApi(); resetStores(); }
});

test("a delayed manual unread response cannot write into another server", async () => {
  resetStores();
  const response = deferred<{ data: { unreadCount: number; readStateVersion: number; maxReadSeq: number } }>();
  api.post = (() => response.promise) as typeof api.post;
  let refreshed = false;
  api.get = (async () => { refreshed = true; return { data: {} }; }) as typeof api.get;
  try {
    const pending = useMessageStore.getState().markUnread("old-server-channel");
    useServerStore.setState({ current: { ...useServerStore.getState().current!, id: "other-server" }, serverEpoch: 2 });
    useMessageStore.setState({ unreadCounts: { "old-server-channel": 4 } });
    response.resolve({ data: { unreadCount: 1, maxReadSeq: 20, readStateVersion: 7 } });
    await pending;
    assert.equal(useMessageStore.getState().unreadCounts["old-server-channel"], 4);
    assert.equal(refreshed, false);
  } finally { restoreApi(); resetStores(); }
});
