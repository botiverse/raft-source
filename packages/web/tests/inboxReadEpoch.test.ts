import assert from "node:assert/strict";
import test from "node:test";
import type { InboxItem } from "../src/store/inboxStore.js";

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

const { default: api } = await import("../src/api/client.js");
const { triggerServerReset } = await import("../src/store/serverResetRegistry.js");
const { useInboxStore } = await import("../src/store/inboxStore.js");
const { useMessageStore } = await import("../src/store/messageStore.js");
const { useServerStore } = await import("../src/store/serverStore.js");

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

function makeChannelItem(
  overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {},
): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: "accepted-read",
    channelName: "alpha",
    channelType: "channel",
    lastMessageId: "message-a-1",
    firstUnreadMessageId: "message-a-1",
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-15T00:00:00.000Z",
    lastMessagePreview: "alpha",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-a",
    lastMessageSenderName: "alice",
    unreadCount: 2,
    hasMention: false,
    ...overrides,
  };
}

function resetInbox(items: InboxItem[] = []) {
  triggerServerReset();
  useInboxStore.setState({
    items,
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: items.length,
    totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    activeUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    scrollTop: 0,
    focusedItemKey: null,
  } as Partial<ReturnType<typeof useInboxStore.getState>>);
  useMessageStore.setState({ currentUserId: "viewer" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("stale Activity read failure cannot roll back or refresh a newer A-to-B-to-A read", async () => {
  const unread = makeChannelItem();
  const first = deferred<{ data: { seq: number; readStateVersion: number } }>();
  const second = deferred<{ data: { seq: number; readStateVersion: number } }>();
  let postCall = 0;
  let refreshCalls = 0;
  api.post = (() => (++postCall === 1 ? first.promise : second.promise)) as typeof api.post;
  api.get = (async () => {
    refreshCalls += 1;
    return {
      data: {
        items: [unread],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 2,
      },
    };
  }) as typeof api.get;

  try {
    resetInbox([unread]);
    useServerStore.setState({ current: { id: "server-a" } as never, serverEpoch: 11 });
    const staleA = useInboxStore.getState().markRead(unread);

    useServerStore.setState({ current: { id: "server-b" } as never, serverEpoch: 12 });
    useServerStore.setState({ current: { id: "server-a" } as never, serverEpoch: 13 });
    useInboxStore.setState({
      items: [unread],
      totalUnreadCount: 2,
      activeUnreadCount: 2,
      loaded: true,
    } as Partial<ReturnType<typeof useInboxStore.getState>>);
    const currentA = useInboxStore.getState().markRead(unread);

    first.reject(new Error("stale A failure"));
    await staleA;
    assert.equal(refreshCalls, 0);
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 0);

    second.resolve({ data: { seq: 9, readStateVersion: 2 } });
    await currentA;
    assert.equal(refreshCalls, 0);
  } finally {
    api.get = originalGet as typeof api.get;
    api.post = originalPost as typeof api.post;
    resetInbox();
  }
});
