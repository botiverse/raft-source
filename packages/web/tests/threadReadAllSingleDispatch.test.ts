import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";

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

const { useInboxStore } = await import("../src/store/inboxStore.js");
const { useThreadStore } = await import("../src/store/threadStore.js");
const { useProfileStore } = await import("../src/store/profileStore.js");
const { useAgentStore } = await import("../src/store/agentStore.js");
const { useAuthStore } = await import("../src/store/authStore.js");
const { useChannelStore } = await import("../src/store/channelStore.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { postReadAllCoalesced } = await import(
  "../src/store/transport/inboxTransport.js"
);
const { default: api } = await import("../src/api/client.js");
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

type ThreadItem = Extract<
  import("../src/store/inboxStore.js").InboxItem,
  { kind: "thread" }
>;

function threadItem(overrides: Partial<ThreadItem> = {}): ThreadItem {
  return {
    kind: "thread",
    threadChannelId: "thread-scope-1",
    parentMessageId: "parent-1",
    parentChannelId: "channel-parent",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "root message",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "latest reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "msg-latest",
    firstUnreadMessageId: "msg-latest",
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-07-29T00:00:00.000Z",
    lastReplyAt: "2026-07-29T00:00:00.000Z",
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function mockPost(record: Array<{ url: string; body: unknown }>, latencyMs = 0) {
  api.post = (async (url: string, body?: unknown) => {
    record.push({ url, body });
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    return { data: { ok: true, seq: 5, readStateVersion: 2 } };
  }) as typeof api.post;
}

const READ_ALL = "/channels/scope-A/read-all";
const identityA = { serverId: "server-1", serverEpoch: 7, principalId: "human-A" };
const countPosts = (posts: Array<{ url: string }>, url: string) =>
  posts.filter((post) => post.url === url).length;

function setDesktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function seedActivityStores(item: ThreadItem) {
  useAuthStore.setState({ user: { id: "human-A", name: "human-a", displayName: "Human A" } } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "acme",
      ownerId: "human-A",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    members: [
      {
        userId: "user-1",
        email: null,
        gravatarHash: "",
        name: "alice",
        displayName: "Alice",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-07-29T00:00:00.000Z",
      },
      {
        userId: "user-2",
        email: null,
        gravatarHash: "",
        name: "bob",
        displayName: "Bob",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-07-29T00:00:00.000Z",
      },
    ],
  } as never);
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
  } as never);
  useThreadStore.setState({
    followedThreads: [
      {
        threadChannelId: item.threadChannelId,
        parentMessageId: item.parentMessageId,
        parentChannelId: item.parentChannelId,
        parentChannelName: item.parentChannelName,
        unreadCount: item.unreadCount,
      },
    ],
  } as never);
  useInboxStore.setState({
    items: [item],
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: false,
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: item.unreadCount,
    activeUnreadCount: item.unreadCount,
    scrollTop: 0,
    focusedItemKey: null,
    pendingFocusKind: null,
  } as never);
}

function renderActivityInbox(item: ThreadItem) {
  setDesktopViewport();
  seedActivityStores(item);
  return render(
    createElement(
      TestIntlProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ["/s/acme/activity"] },
        createElement(ThreadsInbox),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useInboxStore.setState({ items: [], loaded: false } as never);
  useThreadStore.setState({ followedThreads: [] } as never);
  useProfileStore.getState().closeProfile();
});

test("same write identity + scope coalesces concurrent posts into one request", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts, 5);

  const [a, b] = await Promise.all([
    postReadAllCoalesced("scope-A", identityA),
    postReadAllCoalesced("scope-A", { ...identityA }),
  ]);

  assert.equal(countPosts(posts, READ_ALL), 1);
  assert.equal(a, b, "concurrent same-identity callers share one response");
});

test("different authenticated principal on the same channel does NOT coalesce", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts, 5);

  await Promise.all([
    postReadAllCoalesced("scope-A", { ...identityA, principalId: "human-A" }),
    postReadAllCoalesced("scope-A", { ...identityA, principalId: "human-B" }),
  ]);

  // An account switch must not ride the previous principal's in-flight write.
  assert.equal(countPosts(posts, READ_ALL), 2);
});

test("different server on the same channel does NOT coalesce", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts, 5);

  await Promise.all([
    postReadAllCoalesced("scope-A", { ...identityA, serverId: "server-1" }),
    postReadAllCoalesced("scope-A", { ...identityA, serverId: "server-2" }),
  ]);

  assert.equal(countPosts(posts, READ_ALL), 2);
});

test("different receiver scope (human-self vs agent) does NOT coalesce", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts, 5);

  await Promise.all([
    postReadAllCoalesced("scope-A", { ...identityA }),
    postReadAllCoalesced("scope-A", {
      ...identityA,
      receiver: { kind: "agent", id: "agent-1" },
    }),
  ]);

  // Gate A: a human-self write and an agent-receiver write are distinct writes.
  assert.equal(countPosts(posts, READ_ALL), 2);
  assert.deepEqual(posts, [
    { url: READ_ALL, body: undefined },
    { url: READ_ALL, body: { receiver: { kind: "agent", id: "agent-1" } } },
  ]);
});

test("the in-flight slot clears on settle so a later same-identity intent re-posts", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts);

  await postReadAllCoalesced("scope-A", identityA);
  await postReadAllCoalesced("scope-A", { ...identityA });

  assert.equal(countPosts(posts, READ_ALL), 2);
});

test("distinct channels under the same identity stay separate", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts);

  await Promise.all([
    postReadAllCoalesced("scope-X", identityA),
    postReadAllCoalesced("scope-Y", identityA),
  ]);

  assert.equal(countPosts(posts, "/channels/scope-X/read-all"), 1);
  assert.equal(countPosts(posts, "/channels/scope-Y/read-all"), 1);
});

test("a human Activity row stays human-self with an agent profile overlay and persists once", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  mockPost(posts, 5);
  useProfileStore.getState().openProfile("agent", "agent-overlay-1");

  const item = threadItem();
  useInboxStore.setState({
    items: [item],
    totalCount: 1,
    totalUnreadCount: 1,
    activeUnreadCount: 1,
  });
  useThreadStore.setState({
    followedThreads: [
      {
        threadChannelId: "thread-scope-1",
        parentMessageId: "parent-1",
        parentChannelId: "channel-parent",
        parentChannelName: "general",
        unreadCount: 1,
      },
    ],
  });

  try {
    await useInboxStore.getState().markRead(item);
  } finally {
    useProfileStore.getState().closeProfile();
  }

  const readAllPosts = posts.filter((post) => post.url === "/channels/thread-scope-1/read-all");
  assert.equal(
    readAllPosts.length,
    1,
    `markRead(thread) must fire exactly one read-all POST; got ${readAllPosts.length}`,
  );
  assert.equal(
    readAllPosts[0]?.body,
    undefined,
    "the human Inbox row must not inherit the right-panel agent profile as receiver",
  );
});

test("profile open/close changes during an Activity read flight cannot retarget its principal", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    await pending;
    return { data: { ok: true, seq: 5, readStateVersion: 2 } };
  }) as typeof api.post;

  const item = threadItem();
  useInboxStore.setState({
    items: [item],
    totalCount: 1,
    totalUnreadCount: 1,
    activeUnreadCount: 1,
  });
  useProfileStore.getState().openProfile("agent", "agent-overlay-1");

  const readPromise = useInboxStore.getState().markRead(item);
  useProfileStore.getState().closeProfile();
  useProfileStore.getState().openProfile("agent", "agent-overlay-2");
  release();
  try {
    await readPromise;
  } finally {
    useProfileStore.getState().closeProfile();
  }

  const readAllPosts = posts.filter((post) => post.url === "/channels/thread-scope-1/read-all");
  assert.deepEqual(readAllPosts, [{
    url: "/channels/thread-scope-1/read-all",
    body: undefined,
  }]);
});

test("Activity context-menu mark-read delegates to the same store authority as row click", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true, seq: 5, readStateVersion: 2 } };
  }) as typeof api.post;
  api.get = (async () => ({
    data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 },
  })) as typeof api.get;

  renderActivityInbox(threadItem({ unreadCount: 2, firstUnreadMessageId: "msg-latest" }));
  const row = screen.getByTestId("inbox-row");
  fireEvent.contextMenu(row, { clientX: 240, clientY: 200 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark as Read" }));

  await waitFor(() => {
    assert.equal(countPosts(posts, "/channels/thread-scope-1/read-all"), 1);
  });
  assert.deepEqual(posts.filter((post) => post.url === "/channels/thread-scope-1/read-all"), [{
    url: "/channels/thread-scope-1/read-all",
    body: undefined,
  }]);
  assert.equal(countPosts(posts, "/channels/thread-scope-1/unread"), 0);
});
