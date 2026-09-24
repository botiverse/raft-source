import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { InboxItem } from "../src/store/inboxStore.js";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";

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

const { useInboxStore, getInboxItemKey, decrementInboxGroupCounts, sortInboxGroupsByRecentActivity } = await import("../src/store/inboxStore.js");
const { useMessageStore } = await import("../src/store/messageStore.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { useThreadStore } = await import("../src/store/threadStore.js");
const { useAuthStore } = await import("../src/store/authStore.js");
const { useChannelStore } = await import("../src/store/channelStore.js");
const { useAgentStore } = await import("../src/store/agentStore.js");
const { triggerServerReset } = await import("../src/store/serverResetRegistry.js");
const { default: api } = await import("../src/api/client.js");

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

const S1 = "100";
const S2 = "200";

/**
 * #632 C1 fixtures. The store item and the wire row are DIFFERENT shapes and
 * are built explicitly, never defaulted:
 *   - store item carries `readStateLatestActivitySeq` — its internal form after
 *     loadInbox has already accepted a response;
 *   - wire row carries the `readState` union the server actually sends, whose
 *     `latestActivity` is a same-source pair (`messageId` = the row's own last
 *     message, `seq` = the caller's explicit S1/S2/null).
 *
 * Callers pass the seq explicitly so a test's intent (same marker vs new
 * activity vs no authority) is readable at the call site rather than hidden in
 * a shared default.
 */
function storeItemWithFrontier<T extends object>(item: T, seq: string | null) {
  return {
    ...item,
    latestActivitySeq: seq,
    doneFrontierSeq: seq,
    readStateLatestActivitySeq: seq,
  };
}

function wireRowWithFrontier<T extends { lastMessageId?: string }>(item: T, seq: string | null) {
  return {
    ...item,
    latestActivitySeq: seq,
    doneFrontierSeq: seq,
    readState: seq === null
      ? { kind: "present", readStateVersion: 1, maxReadSeq: "0", latestActivity: null }
      : {
        kind: "present",
        readStateVersion: 1,
        maxReadSeq: "0",
        latestActivity: { messageId: item.lastMessageId ?? "m", seq },
      },
  };
}

function makeChannelItem(overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {}): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-2",
    latestActivitySeq: S1,
    doneFrontierSeq: S1,
    firstUnreadMessageId: "message-1",
    firstMentionMessageId: null,
    lastMessageAt: "2026-05-10T00:00:00.000Z",
    lastMessagePreview: "hello @me",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "alice",
    unreadCount: 2,
    hasMention: true,
    ...overrides,
  };
}

function makeThreadItem(overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {}): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
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
    latestActivitySeq: S1,
    firstUnreadMessageId: "reply-1",
    replyCount: 1,
    lastActivityAt: "2026-05-10T00:00:00.000Z",
    lastReplyAt: "2026-05-10T00:00:00.000Z",
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function makeMentionActionItem(overrides: Partial<Extract<InboxItem, { kind: "mention_action" }>> = {}): Extract<InboxItem, { kind: "mention_action" }> {
  return {
    kind: "mention_action",
    id: "mention-action-1",
    channelId: "channel-mention-action",
    channelName: "general",
    channelType: "channel",
    messageId: "message-mention-action",
    messagePreview: "approve adding @bob",
    createdAt: "2026-05-10T00:00:00.000Z",
    pendingMentionActions: [],
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

function resetInbox(items: InboxItem[] = []) {
  triggerServerReset();
  // loadInbox is server-scoped and #632 C1 folds the union under THAT identity;
  // without a current server the adapter correctly reports "no identity".
  useServerStore.setState({ current: { id: "server-1" } as never, serverEpoch: 1 } as never);
  useInboxStore.setState({
    items,
    groups: [],
    filter: "all",
    channelFilterId: null,
    loading: false,
    loadingMore: false,
    hasMore: true,
    totalCount: items.length,
    totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    activeUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    scrollTop: 0,
    focusedItemKey: null,
  });
}

function restoreApi() {
  api.post = originalPost;
  api.get = originalGet;
}

afterEach(() => {
  cleanup();
  useMessageStore.setState({ drafts: {} });
  resetInbox();
  restoreApi();
});

function setDesktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function renderInbox() {
  setDesktopViewport();
  useServerStore.setState({ current: { slug: "acme" }, members: [] } as never);
  useAuthStore.setState({ user: { id: "me" } } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} } as never);
  useAgentStore.setState({ agents: [] } as never);
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: useInboxStore.getState().items, hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    return { data: {} };
  }) as typeof api.get;
  return render(
    <MemoryRouter initialEntries={["/s/acme/activity"]}>
      <TestIntlProvider>
        <ThreadsInbox />
      </TestIntlProvider>
    </MemoryRouter>,
  );
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

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("ordinary unread row shows the mention-you badge only when hasMention is true", () => {
  resetInbox([makeChannelItem({ unreadCount: 2, hasMention: true, firstMentionMessageId: "message-1" })]);
  renderInbox();
  const badge = screen.getByTestId("inbox-mention-badge");
  assert.equal(badge.getAttribute("title"), "Unread messages mention you");
  assert.match(badge.textContent ?? "", /you/);
  cleanup();

  resetInbox([makeChannelItem({ channelId: "channel-plain", unreadCount: 2, hasMention: false, firstMentionMessageId: null })]);
  renderInbox();
  assert.equal(screen.queryByTestId("inbox-mention-badge"), null);
});

test("mentions filter hides the redundant mention-you badge", () => {
  resetInbox([makeChannelItem({ unreadCount: 2, hasMention: true, firstMentionMessageId: "message-1" })]);
  useInboxStore.setState({ filter: "mentions" });
  renderInbox();
  assert.equal(screen.queryByTestId("inbox-mention-badge"), null);
});

// Independent of raft-ui Badge recipes in product source. Brutal
// outline+muted currently renders these tokens; shrinking or swapping the
// production pairing must still fail this expected set.
const EXPECTED_DRAFT_BADGE_TOKENS = ["bg-transparent", "text-secondary-900"] as const;

test("thread inbox row surfaces a local thread draft as a muted outline badge", () => {
  const threadItem = makeThreadItem({ unreadCount: 0, hasMention: false });
  resetInbox([threadItem]);
  useMessageStore.setState({ drafts: { [threadItem.threadChannelId]: "unsent reply" } });
  renderInbox();
  const draft = screen.getByTestId("inbox-thread-draft-badge");
  assert.equal(draft.getAttribute("aria-label"), "Thread has an unsent draft");
  assert.equal(draft.getAttribute("title"), "Thread has an unsent draft");
  for (const token of EXPECTED_DRAFT_BADGE_TOKENS) {
    assert.match(
      draft.className,
      new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
      `draft badge must keep outline/muted token ${token}`,
    );
  }
  const pencil = draft.querySelector("svg.lucide-pencil");
  assert.ok(pencil, "draft badge must render the Pencil icon");
  assert.equal(pencil.getAttribute("width"), "12", "draft Pencil must be 12×12");
  assert.equal(pencil.getAttribute("height"), "12", "draft Pencil must be 12×12");
  cleanup();

  useMessageStore.setState({ drafts: {} });
  resetInbox([threadItem]);
  renderInbox();
  assert.equal(screen.queryByTestId("inbox-thread-draft-badge"), null);
});

test("inbox store starts in the default all-activity state", () => {
  const state = useInboxStore.getState();
  assert.deepEqual(state.items, []);
  assert.equal(state.filter, "all");
  assert.equal(state.loading, false);
  assert.equal(state.loadingMore, false);
  assert.equal(state.hasMore, true);
});

test("Activity group decrements map threads to parents and ignore mention actions", () => {
  const channelItem = makeChannelItem({ channelId: "channel-direct" });
  const threadItem = makeThreadItem({
    threadChannelId: "thread-child",
    parentChannelId: "channel-parent",
  });
  const mentionAction = makeMentionActionItem({ channelId: "channel-mention-action" });
  const groups = [
    { channelId: "channel-parent", channelName: "parent", channelType: "channel" as const, count: 3 },
    { channelId: "thread-child", channelName: "thread", channelType: "channel" as const, count: 4 },
    { channelId: "channel-direct", channelName: "direct", channelType: "channel" as const, count: 1 },
    { channelId: "channel-mention-action", channelName: "actions", channelType: "channel" as const, count: 2 },
    { channelId: "channel-unaffected", channelName: "unaffected", channelType: "channel" as const, count: 5 },
  ];

  assert.equal(decrementInboxGroupCounts(groups, []), groups);
  assert.equal(decrementInboxGroupCounts(groups, [mentionAction]), groups);
  assert.deepEqual(decrementInboxGroupCounts(groups, [threadItem, channelItem, mentionAction]), [
    { channelId: "channel-parent", channelName: "parent", channelType: "channel", count: 2 },
    { channelId: "thread-child", channelName: "thread", channelType: "channel", count: 4 },
    { channelId: "channel-mention-action", channelName: "actions", channelType: "channel", count: 2 },
    { channelId: "channel-unaffected", channelName: "unaffected", channelType: "channel", count: 5 },
  ]);
});

test("Activity groups keep DM and Channel sections while ordering each by recent activity", () => {
  const groups = [
    { channelId: "channel-new", channelName: "zeta", channelType: "channel" as const, count: 1, lastActivityAt: "2026-07-29T10:00:00.000Z" },
    { channelId: "dm-old", channelName: "alpha", channelType: "dm" as const, count: 1, lastActivityAt: "2026-07-29T08:00:00.000Z" },
    { channelId: "channel-old", channelName: "alpha", channelType: "channel" as const, count: 1, lastActivityAt: "2026-07-29T07:00:00.000Z" },
    { channelId: "dm-new", channelName: "zeta", channelType: "dm" as const, count: 1, lastActivityAt: "2026-07-29T11:00:00.000Z" },
  ];

  assert.deepEqual(
    sortInboxGroupsByRecentActivity(groups).map((group) => group.channelId),
    ["dm-new", "dm-old", "channel-new", "channel-old"],
  );
  assert.deepEqual(
    groups.map((group) => group.channelId),
    ["channel-new", "dm-old", "channel-old", "dm-new"],
    "sorting does not mutate the response array",
  );
});

test("Activity group recent ordering puts missing timestamps last and uses deterministic name and id ties", () => {
  const groups = [
    { channelId: "channel-same-time-alpha", channelName: "alpha", channelType: "channel" as const, count: 1, lastActivityAt: "2026-07-29T10:00:00.000Z" },
    { channelId: "dm-missing-z", channelName: "zeta", channelType: "dm" as const, count: 1 },
    { channelId: "channel-missing-z", channelName: "zeta", channelType: "channel" as const, count: 1 },
    { channelId: "dm-valid", channelName: "valid", channelType: "dm" as const, count: 1, lastActivityAt: "2026-07-29T09:00:00.000Z" },
    { channelId: "channel-same-name-a", channelName: "same", channelType: "channel" as const, count: 1, lastActivityAt: "2026-07-29T10:00:00.000Z" },
    { channelId: "channel-same-name-b", channelName: "same", channelType: "channel" as const, count: 1, lastActivityAt: "2026-07-29T10:00:00.000Z" },
    { channelId: "dm-invalid-a", channelName: "alpha", channelType: "dm" as const, count: 1, lastActivityAt: "not-a-date" },
    { channelId: "channel-valid-new", channelName: "new", channelType: "private" as const, count: 1, lastActivityAt: "2026-07-29T11:00:00.000Z" },
    { channelId: "channel-invalid-a", channelName: "alpha", channelType: "joint" as const, count: 1, lastActivityAt: "not-a-date" },
  ];

  assert.deepEqual(
    sortInboxGroupsByRecentActivity(groups).map((group) => group.channelId),
    [
      "dm-valid",
      "dm-invalid-a",
      "dm-missing-z",
      "channel-valid-new",
      "channel-same-time-alpha",
      "channel-same-name-a",
      "channel-same-name-b",
      "channel-invalid-a",
      "channel-missing-z",
    ],
  );
  assert.deepEqual(
    sortInboxGroupsByRecentActivity([
      { channelId: "same-name-b", channelName: "same", channelType: "channel", count: 1, lastActivityAt: "2026-07-29T10:00:00.000Z" },
      { channelId: "same-name-a", channelName: "same", channelType: "channel", count: 1, lastActivityAt: "2026-07-29T10:00:00.000Z" },
    ]).map((group) => group.channelId),
    ["same-name-a", "same-name-b"],
  );
});

test("removeItem decrements the matching Activity group only", () => {
  const item = makeChannelItem({ channelId: "channel-remove" });
  const otherItem = makeChannelItem({ channelId: "channel-keep" });

  try {
    resetInbox([item, otherItem]);
    useInboxStore.setState({
      groups: [
        { channelId: "channel-remove", channelName: "remove", channelType: "channel", count: 1 },
        { channelId: "channel-keep", channelName: "keep", channelType: "channel", count: 2 },
      ],
    });

    useInboxStore.getState().removeItem(item);

    assert.deepEqual(useInboxStore.getState().groups, [
      { channelId: "channel-keep", channelName: "keep", channelType: "channel", count: 2 },
    ]);
  } finally {
    resetInbox();
  }
});

test("markRead decrements a followed thread from its parent Activity group", async () => {
  const threadItem = makeThreadItem({
    threadChannelId: "thread-read",
    parentChannelId: "channel-parent-read",
    unreadCount: 1,
  });
  api.post = (async () => ({ data: {} })) as typeof api.post;

  try {
    resetInbox([threadItem]);
    useInboxStore.setState({
      filter: "unread",
      groups: [
        { channelId: "channel-parent-read", channelName: "parent", channelType: "channel", count: 2 },
        { channelId: "channel-other", channelName: "other", channelType: "channel", count: 1 },
      ],
    });

    await useInboxStore.getState().markRead(threadItem);

    assert.deepEqual(useInboxStore.getState().items, []);
    assert.deepEqual(useInboxStore.getState().groups, [
      { channelId: "channel-parent-read", channelName: "parent", channelType: "channel", count: 1 },
      { channelId: "channel-other", channelName: "other", channelType: "channel", count: 1 },
    ]);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markAllRead clears Activity groups immediately in unread mode", async () => {
  const item = makeChannelItem({ channelId: "channel-mark-all-groups", unreadCount: 1 });
  const postResponse = deferred<{ data: Record<string, never> }>();
  api.post = (() => postResponse.promise) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/threads/followed") return { data: { threads: [] } };
    if (url === "/channels/inbox") return { data: { items: [], groups: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([item]);
    useInboxStore.setState({
      filter: "unread",
      groups: [{ channelId: item.channelId, channelName: item.channelName, channelType: item.channelType, count: 1 }],
    });

    const markAll = useInboxStore.getState().markAllRead();

    assert.deepEqual(useInboxStore.getState().items, []);
    assert.deepEqual(useInboxStore.getState().groups, []);
    assert.equal(useInboxStore.getState().totalCount, 0);
    postResponse.resolve({ data: {} });
    await markAll;
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("loadInbox treats a legacy response without groups as an empty facet list", async () => {
  const item = makeChannelItem({ channelId: "channel-legacy-groups" });
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [item], hasMore: false, totalCount: 1, totalUnreadCount: item.unreadCount } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox();
    useInboxStore.setState({
      groups: [{ channelId: "stale-group", channelName: "stale", channelType: "channel", count: 2 }],
    });

    await useInboxStore.getState().loadInbox({ reset: true });

    assert.deepEqual(useInboxStore.getState().groups, []);
    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-legacy-groups"]);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("accepted thread reply updates Activity preview and count before server refresh", () => {
  const parentOnly = makeThreadItem({
    latestActivityPreview: "parent text",
    latestActivityMessageId: "parent-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 0,
    lastReplyAt: null,
    unreadCount: 0,
  });

  try {
    resetInbox([parentOnly]);
    useMessageStore.setState({ currentUserId: "viewer" });
    useThreadStore.setState({ openThreadChannelId: null });

    const reply = {
      id: "reply-live-1",
      channelId: "thread-1",
      seq: 101,
      conversationContext: {
        channelType: "thread" as const,
        parentMessageId: "parent-1",
        parentChannelId: "channel-parent",
        parentChannelType: "channel" as const,
      },
      senderType: "user" as const,
      senderId: "author",
      content: "the concrete reply text",
      createdAt: "2026-07-11T03:00:00.000Z",
    };
    useInboxStore.getState().receiveThreadReply(reply);

    const updated = useInboxStore.getState().items[0];
    assert.ok(updated?.kind === "thread");
    assert.equal(updated.latestActivityPreview, "the concrete reply text");
    assert.equal(updated.latestActivityMessageId, "reply-live-1");
    assert.equal(updated.replyCount, 1);
    assert.equal(updated.unreadCount, 0, "socket preview patch must leave unread policy server-owned");
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);

    useInboxStore.getState().receiveThreadReply(reply);
    assert.equal((useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).replyCount, 1, "duplicate socket delivery must not double-increment");

    useInboxStore.getState().receiveThreadReply({
      ...reply,
      id: "channel-message",
      channelId: "channel-parent",
      conversationContext: { channelType: "channel" },
    });
    useInboxStore.getState().receiveThreadReply({
      ...reply,
      id: "unknown-thread-reply",
      channelId: "thread-unknown",
    });
    assert.equal((useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).replyCount, 1, "non-thread and unknown-thread messages must not patch Activity");

    useInboxStore.getState().updateThreadActivityMeta("thread-1", 0, "2026-07-11T04:00:00.000Z");
    assert.equal((useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).replyCount, 1, "older thread metadata must not regress the local count");

    useInboxStore.getState().updateThreadActivityMeta("thread-1", 1, "2026-07-11T04:00:00.000Z");
    assert.equal((useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).lastReplyAt, reply.createdAt, "equal-count metadata must not replace the local reply marker");

    useInboxStore.getState().updateThreadActivityMeta("thread-1", 4, reply.createdAt);
    assert.equal((useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).replyCount, 4, "thread:updated authoritative count should correct a stale base");
  } finally {
    resetInbox();
  }
});

test("thread activity no-ops preserve inbox store identity and skip subscriber fanout", () => {
  const existing = makeThreadItem({
    latestActivityMessageId: "reply-live-1",
    replyCount: 1,
    lastReplyAt: "2026-07-11T03:00:00.000Z",
  });

  let unsubscribe: (() => void) | undefined;
  try {
    resetInbox([existing]);
    const initialState = useInboxStore.getState();
    let notifications = 0;
    unsubscribe = useInboxStore.subscribe(() => {
      notifications += 1;
    });

    initialState.receiveThreadReply({
      id: "ordinary-channel-message",
      channelId: "channel-parent",
      senderType: "user",
      senderId: "author",
      content: "ordinary channel message",
      createdAt: "2026-07-11T03:01:00.000Z",
    });
    initialState.receiveThreadReply({
      id: "reply-live-1",
      channelId: "thread-1",
      senderType: "user",
      senderId: "author",
      content: "duplicate thread reply",
      createdAt: "2026-07-11T03:01:00.000Z",
    });
    initialState.updateThreadActivityMeta("thread-unknown", 1, "2026-07-11T03:01:00.000Z");
    initialState.updateThreadActivityMeta("thread-1", 0, "2026-07-11T03:01:00.000Z");
    initialState.updateThreadActivityMeta("thread-1", 1, "2026-07-11T03:00:00.000Z");

    assert.equal(useInboxStore.getState(), initialState, "no-op updates must preserve the Zustand root identity");
    assert.equal(notifications, 0, "no-op updates must not notify inbox subscribers");

    initialState.receiveThreadReply({
      id: "reply-live-2",
      channelId: "thread-1",
      seq: 101,
      senderType: "user",
      senderId: "author",
      content: "new thread reply",
      createdAt: "2026-07-11T03:02:00.000Z",
    });
    assert.notEqual(useInboxStore.getState(), initialState, "a real reply must still replace the store root");
    assert.equal(notifications, 1, "a real reply must notify subscribers exactly once");
  } finally {
    unsubscribe?.();
    resetInbox();
  }
});

test("lagging inbox refresh cannot overwrite newer socket thread activity", async () => {
  const parentOnly = makeThreadItem({
    latestActivityPreview: "parent text",
    latestActivityMessageId: "parent-1",
    latestActivitySeq: "1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 0,
    lastReplyAt: null,
    unreadCount: 0,
  });
  const firstReplyOnly = makeThreadItem({
    latestActivityPreview: "first reply only",
    latestActivityMessageId: "reply-live-1",
    latestActivitySeq: "2",
    firstUnreadMessageId: "reply-live-1",
    replyCount: 1,
    lastActivityAt: "2026-07-11T03:00:00.000Z",
    lastReplyAt: "2026-07-11T03:00:00.000Z",
    unreadCount: 1,
  });
  const caughtUp = makeThreadItem({
    latestActivityPreview: "server caught up",
    latestActivityMessageId: "reply-live-2",
    latestActivitySeq: "3",
    firstUnreadMessageId: "reply-live-2",
    replyCount: 2,
    lastActivityAt: "2026-07-11T03:01:00.000Z",
    lastReplyAt: "2026-07-11T03:01:00.000Z",
    unreadCount: 1,
    taskNumber: 558,
  });
  const sameCountDifferentMessage = makeThreadItem({
    latestActivityPreview: "same count but not the local marker",
    latestActivityMessageId: "reply-other-2",
    latestActivitySeq: "3",
    replyCount: 2,
    lastActivityAt: "2026-07-11T03:00:30.000Z",
    lastReplyAt: "2026-07-11T03:00:30.000Z",
    unreadCount: 1,
  });
  const sameMessageLowerCount = makeThreadItem({
    latestActivityPreview: "latest marker with a stale count",
    latestActivityMessageId: "reply-live-2",
    latestActivitySeq: "2",
    replyCount: 1,
    lastActivityAt: "2026-07-11T03:01:00.000Z",
    lastReplyAt: "2026-07-11T03:01:00.000Z",
    unreadCount: 1,
  });
  const responses = [
    { items: [parentOnly], totalCount: 1, totalUnreadCount: 0 },
    { items: [firstReplyOnly], totalCount: 1, totalUnreadCount: 1 },
    { items: [sameMessageLowerCount], totalCount: 1, totalUnreadCount: 1 },
    { items: [sameCountDifferentMessage], totalCount: 1, totalUnreadCount: 1 },
    { items: [caughtUp], totalCount: 1, totalUnreadCount: 1 },
    { items: [], totalCount: 0, totalUnreadCount: 0 },
  ];
  api.get = (async (url: string) => {
    if (url !== "/channels/inbox") return { data: {} };
    const response = responses.shift()!;
    return { data: { ...response, hasMore: false } };
  }) as typeof api.get;

  try {
    resetInbox([parentOnly]);
    useMessageStore.setState({ currentUserId: "viewer" });
    useThreadStore.setState({ openThreadChannelId: null });
    useInboxStore.getState().receiveThreadReply({
      id: "reply-live-1",
      channelId: "thread-1",
      seq: 2,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-1",
        parentChannelId: "channel-parent",
        parentChannelType: "channel",
      },
      senderType: "user",
      senderId: "author",
      content: "socket reply survives",
      createdAt: "2026-07-11T03:00:00.000Z",
    });
    useInboxStore.getState().receiveThreadReply({
      id: "reply-live-2",
      channelId: "thread-1",
      seq: 3,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-1",
        parentChannelId: "channel-parent",
        parentChannelType: "channel",
      },
      senderType: "agent",
      senderId: "agent-author",
      content: "newest socket reply survives",
      createdAt: "2026-07-11T03:01:00.000Z",
    });

    await useInboxStore.getState().refreshInbox();
    const afterStaleRefresh = useInboxStore.getState().items[0];
    assert.ok(afterStaleRefresh?.kind === "thread");
    assert.equal(afterStaleRefresh.latestActivityPreview, "newest socket reply survives");
    assert.equal(afterStaleRefresh.replyCount, 2);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);

    await useInboxStore.getState().refreshInbox();
    const afterPartiallyCaughtUpRefresh = useInboxStore.getState().items[0];
    assert.ok(afterPartiallyCaughtUpRefresh?.kind === "thread");
    assert.equal(afterPartiallyCaughtUpRefresh.latestActivityPreview, "newest socket reply survives");
    assert.equal(afterPartiallyCaughtUpRefresh.replyCount, 2, "an older local version must not acknowledge the newest reply");
    assert.equal(useInboxStore.getState().totalUnreadCount, 0, "preserving the local row must also preserve its unread total");

    await useInboxStore.getState().refreshInbox();
    const afterInconsistentMarkerRefresh = useInboxStore.getState().items[0];
    assert.ok(afterInconsistentMarkerRefresh?.kind === "thread");
    assert.equal(afterInconsistentMarkerRefresh.replyCount, 2, "the latest marker with a lower count is still an inconsistent stale snapshot");

    await useInboxStore.getState().refreshInbox();
    const afterConflictingSameCountRefresh = useInboxStore.getState().items[0];
    assert.ok(afterConflictingSameCountRefresh?.kind === "thread");
    assert.equal(afterConflictingSameCountRefresh.latestActivityMessageId, "reply-live-2", "equal count without the high-water marker is not an acknowledgement");

    await useInboxStore.getState().refreshInbox();
    const afterConvergence = useInboxStore.getState().items[0];
    assert.ok(afterConvergence?.kind === "thread");
    assert.equal(afterConvergence.latestActivityPreview, "server caught up");
    assert.equal(afterConvergence.taskNumber, 558, "equal-freshness server row should resume canonical enrichment ownership");

    await useInboxStore.getState().refreshInbox();
    assert.deepEqual(useInboxStore.getState().items, [], "a later canonical removal must not be pinned after the server catches up");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a server row with a higher reply count acknowledges the local thread version", async () => {
  const parentOnly = makeThreadItem({
    latestActivityPreview: "parent text",
    latestActivityMessageId: "parent-1",
    latestActivitySeq: "1",
    replyCount: 0,
    lastReplyAt: null,
    unreadCount: 0,
  });
  const serverNewer = makeThreadItem({
    latestActivityPreview: "server has a still newer reply",
    latestActivityMessageId: "reply-server-2",
    latestActivitySeq: "3",
    replyCount: 2,
    lastReplyAt: "2026-07-11T03:02:00.000Z",
  });
  api.get = (async () => ({
    data: { items: [serverNewer], hasMore: false, totalCount: 1, totalUnreadCount: 1 },
  })) as typeof api.get;

  try {
    resetInbox([parentOnly]);
    useInboxStore.getState().receiveThreadReply({
      id: "reply-local-1",
      channelId: "thread-1",
      seq: 2,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-1",
        parentChannelId: "channel-parent",
      },
      senderType: "user",
      senderId: "author",
      content: "local reply",
      createdAt: "2026-07-11T03:01:00.000Z",
    });

    await useInboxStore.getState().refreshInbox();
    const updated = useInboxStore.getState().items[0];
    assert.ok(updated?.kind === "thread");
    assert.equal(updated.latestActivityMessageId, "reply-server-2");
    assert.equal(updated.replyCount, 2);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("server reset clears the thread activity high-water ledger", async () => {
  const localReply = makeThreadItem({
    latestActivityPreview: "old server local reply",
    latestActivityMessageId: "reply-local-1",
    replyCount: 1,
  });
  const newServerParent = makeThreadItem({
    latestActivityPreview: "new server parent",
    latestActivityMessageId: "parent-new-server",
    replyCount: 0,
    lastReplyAt: null,
  });
  api.get = (async () => ({
    data: { items: [newServerParent], hasMore: false, totalCount: 1, totalUnreadCount: 0 },
  })) as typeof api.get;

  try {
    resetInbox([makeThreadItem({ latestActivityMessageId: "parent-old-server", replyCount: 0 })]);
    useInboxStore.getState().receiveThreadReply({
      id: "reply-local-1",
      channelId: "thread-1",
      seq: 101,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-old-server",
        parentChannelId: "channel-parent",
      },
      senderType: "user",
      senderId: "author",
      content: "old server local reply",
      createdAt: "2026-07-11T03:01:00.000Z",
    });
    assert.equal((useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).latestActivityMessageId, localReply.latestActivityMessageId);

    resetInbox([localReply]);
    await useInboxStore.getState().refreshInbox();
    const refreshed = useInboxStore.getState().items[0];
    assert.ok(refreshed?.kind === "thread");
    assert.equal(refreshed.latestActivityMessageId, "parent-new-server");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a removed thread row drops its stale high-water entry before reappearing", async () => {
  const parentOnly = makeThreadItem({
    latestActivityPreview: "server row reappeared",
    latestActivityMessageId: "parent-reappeared",
    replyCount: 0,
    lastReplyAt: null,
    unreadCount: 0,
  });
  api.get = (async () => ({
    data: { items: [parentOnly], hasMore: false, totalCount: 1, totalUnreadCount: 0 },
  })) as typeof api.get;

  try {
    resetInbox([makeThreadItem({ latestActivityMessageId: "parent-old", replyCount: 0 })]);
    useInboxStore.getState().receiveThreadReply({
      id: "reply-before-removal",
      channelId: "thread-1",
      seq: 101,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-old",
        parentChannelId: "channel-parent",
      },
      senderType: "user",
      senderId: "author",
      content: "reply before canonical removal",
      createdAt: "2026-07-11T03:01:00.000Z",
    });
    useInboxStore.setState({ items: [], totalCount: 0, totalUnreadCount: 0 });

    await useInboxStore.getState().refreshInbox();
    const refreshed = useInboxStore.getState().items[0];
    assert.ok(refreshed?.kind === "thread");
    assert.equal(refreshed.latestActivityMessageId, "parent-reappeared");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead clears the unread-range mention bit optimistically", async () => {
  const item = makeChannelItem();
  const postCalls: string[] = [];
  api.post = (async (url: string) => {
    postCalls.push(url);
    return { data: {} };
  }) as typeof api.post;

  try {
    resetInbox([item]);

    await useInboxStore.getState().markRead(item);

    const updated = useInboxStore.getState().items.find((entry) => getInboxItemKey(entry) === getInboxItemKey(item));
    assert.ok(updated);
    assert.equal(updated.unreadCount, 0);
    assert.equal(updated.firstUnreadMessageId, null);
    assert.equal(updated.hasMention, false);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    assert.equal(useInboxStore.getState().activeUnreadCount, 0);
    assert.deepEqual(postCalls, ["/channels/channel-1/read-all"]);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("message read state clears retained activity unread tags", () => {
  const item = makeChannelItem({ channelId: "channel-sync", unreadCount: 2, hasMention: true });

  try {
    resetInbox([item]);
    useMessageStore.setState({ unreadCounts: { "channel-sync": 2 } });

    useMessageStore.getState().clearUnread("channel-sync");

    const updated = useInboxStore.getState().items.find((entry) => getInboxItemKey(entry) === getInboxItemKey(item));
    assert.ok(updated);
    assert.equal(updated.unreadCount, 0);
    assert.equal(updated.firstUnreadMessageId, null);
    assert.equal(updated.hasMention, false);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    assert.equal(useInboxStore.getState().activeUnreadCount, 0);
  } finally {
    useMessageStore.setState({ unreadCounts: {} });
    resetInbox();
  }
});

test("thread read state clears retained activity unread tags", () => {
  const threadItem: InboxItem = {
    kind: "thread",
    threadChannelId: "thread-sync",
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
    lastActivityAt: "2026-05-10T00:00:00.000Z",
    lastReplyAt: "2026-05-10T00:00:00.000Z",
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
  };
  const originalPostThread = api.post;
  api.post = (async () => ({ data: {} })) as typeof api.post;

  try {
    resetInbox([threadItem]);
    useThreadStore.setState({
      followedThreads: [
        {
          threadChannelId: "thread-sync",
          parentMessageId: "parent-1",
          parentChannelId: "channel-parent",
          parentChannelName: "general",
          parentChannelType: "channel",
          parentMessagePreview: "parent message",
          parentMessageSenderType: "user",
          parentMessageSenderId: "user-1",
          replyCount: 1,
          lastReplyAt: "2026-05-10T00:00:00.000Z",
          unreadCount: 1,
          taskNumber: null,
          taskStatus: null,
          taskClaimedByName: null,
        },
      ],
    });

    useThreadStore.getState().clearThreadUnread("thread-sync");

    const updated = useInboxStore.getState().items.find((entry) => getInboxItemKey(entry) === getInboxItemKey(threadItem));
    assert.ok(updated);
    assert.equal(updated.unreadCount, 0);
    assert.equal(updated.firstUnreadMessageId, null);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    const followed = useThreadStore.getState().followedThreads.find((t) => t.threadChannelId === "thread-sync");
    assert.ok(followed);
    assert.equal(followed.unreadCount, 0);
  } finally {
    api.post = originalPostThread;
    useThreadStore.setState({ followedThreads: [] });
    resetInbox();
  }
});

test("thread read completion canonically clears an Activity row hydrated after the optimistic notification", async () => {
  const staleThreadItem = makeThreadItem({ threadChannelId: "thread-hydration-race" });
  const persisted = deferred<{ data: { ok: boolean } }>();
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (async () => ({
    data: {
      items: [{ ...staleThreadItem, unreadCount: 0, firstUnreadMessageId: null }],
      totalCount: 1,
      totalUnreadCount: 0,
      hasMore: false,
    },
  })) as typeof api.get;

  try {
    resetInbox();
    useThreadStore.getState().clearThreadUnread("thread-hydration-race");

    useInboxStore.setState({
      items: [staleThreadItem],
      loaded: true,
      totalCount: 1,
      totalUnreadCount: 1,
    });
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 1);

    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    const updated = useInboxStore.getState().items.find(
      (entry) => getInboxItemKey(entry) === getInboxItemKey(staleThreadItem),
    );
    assert.ok(updated);
    assert.equal(updated.unreadCount, 0);
    assert.equal(updated.firstUnreadMessageId, null);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("thread read completion preserves a newer unread reply through canonical reconcile", async () => {
  const newerThreadItem = makeThreadItem({
    threadChannelId: "thread-newer-reply",
    latestActivityMessageId: "reply-2",
    firstUnreadMessageId: "reply-2",
    replyCount: 2,
    unreadCount: 1,
  });
  const persisted = deferred<{ data: { ok: boolean } }>();
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (async () => ({
    data: {
      items: [newerThreadItem],
      totalCount: 1,
      totalUnreadCount: 1,
      hasMore: false,
    },
  })) as typeof api.get;

  try {
    resetInbox();
    useThreadStore.getState().clearThreadUnread("thread-newer-reply");
    useInboxStore.setState({
      items: [newerThreadItem],
      loaded: true,
      totalCount: 1,
      totalUnreadCount: 1,
    });

    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    const updated = useInboxStore.getState().items.find(
      (entry) => getInboxItemKey(entry) === getInboxItemKey(newerThreadItem),
    );
    assert.ok(updated);
    assert.equal(updated.latestActivityMessageId, "reply-2");
    assert.equal(updated.unreadCount, 1);
    assert.equal(updated.firstUnreadMessageId, "reply-2");
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("failed thread read persistence does not trigger Activity reconcile", async () => {
  const threadItem = makeThreadItem({ threadChannelId: "thread-read-failed" });
  let inboxLoads = 0;
  api.post = (async () => {
    throw new Error("persist failed");
  }) as typeof api.post;
  api.get = (async () => {
    inboxLoads += 1;
    return { data: { items: [] } };
  }) as typeof api.get;

  try {
    resetInbox();
    useThreadStore.getState().clearThreadUnread("thread-read-failed");
    useInboxStore.setState({
      items: [threadItem],
      loaded: true,
      totalCount: 1,
      totalUnreadCount: 1,
    });
    await flushPromises();

    assert.equal(inboxLoads, 0);
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("thread read completion from an old principal cannot reconcile the current Activity", async () => {
  const threadItem = makeThreadItem({ threadChannelId: "thread-old-principal" });
  const persisted = deferred<{ data: { ok: boolean } }>();
  let inboxLoads = 0;
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (async () => {
    inboxLoads += 1;
    return { data: { items: [] } };
  }) as typeof api.get;

  try {
    resetInbox();
    useMessageStore.getState().setCurrentUserId("principal-a");
    useThreadStore.getState().clearThreadUnread("thread-old-principal");
    useMessageStore.getState().setCurrentUserId("principal-b");
    useInboxStore.setState({
      items: [threadItem],
      loaded: true,
      totalCount: 1,
      totalUnreadCount: 1,
    });

    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    assert.equal(inboxLoads, 0);
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 1);
  } finally {
    useMessageStore.getState().setCurrentUserId(null);
    restoreApi();
    resetInbox();
  }
});

test("thread read canonical reconcile cannot publish a parked server A response into server B", async () => {
  const serverAThread = makeThreadItem({ threadChannelId: "thread-server-a" });
  const serverBItem = makeChannelItem({ channelId: "channel-server-b", unreadCount: 1 });
  const persisted = deferred<{ data: { ok: boolean } }>();
  const inboxResponse = deferred<{
    data: {
      items: InboxItem[];
      totalCount: number;
      totalUnreadCount: number;
      hasMore: boolean;
    };
  }>();
  let inboxLoads = 0;
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (() => {
    inboxLoads += 1;
    return inboxResponse.promise;
  }) as typeof api.get;

  try {
    useServerStore.setState({ current: { id: "server-a" } as never, serverEpoch: 100 });
    useMessageStore.getState().setCurrentUserId("principal-a");
    resetInbox();
    useThreadStore.getState().clearThreadUnread("thread-server-a");
    useInboxStore.setState({
      items: [serverAThread],
      loaded: true,
      totalCount: 1,
      totalUnreadCount: 1,
    });

    persisted.resolve({ data: { ok: true } });
    await flushPromises();
    assert.equal(inboxLoads, 1);

    useServerStore.setState({ current: { id: "server-b" } as never, serverEpoch: 101 });
    useMessageStore.getState().setCurrentUserId("principal-b");
    triggerServerReset();
    useInboxStore.setState({
      items: [serverBItem],
      loaded: true,
      totalCount: 1,
      totalUnreadCount: 1,
    });
    const serverBItems = useInboxStore.getState().items;

    inboxResponse.resolve({
      data: {
        items: [{ ...serverAThread, unreadCount: 0, firstUnreadMessageId: null }],
        totalCount: 1,
        totalUnreadCount: 0,
        hasMore: false,
      },
    });
    await flushPromises();

    assert.equal(useInboxStore.getState().items, serverBItems);
    assert.equal(useInboxStore.getState().items[0]?.kind, "channel");
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    useMessageStore.getState().setCurrentUserId(null);
    useServerStore.setState({ current: null, serverEpoch: 102 });
    restoreApi();
    resetInbox();
  }
});

test("clearThreadUnread preserves followedThreads reference when nothing matches", () => {
  const originalPostNoop = api.post;
  api.post = (async () => ({ data: {} })) as typeof api.post;

  try {
    const initialFollowed = [
      {
        threadChannelId: "other-thread",
        parentMessageId: "parent-2",
        parentChannelId: "channel-parent",
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
      },
    ];
    useThreadStore.setState({ followedThreads: initialFollowed });

    useThreadStore.getState().clearThreadUnread("nonexistent-thread");

    assert.equal(useThreadStore.getState().followedThreads, initialFollowed);
  } finally {
    api.post = originalPostNoop;
    useThreadStore.setState({ followedThreads: [] });
  }
});

test("message read state removes matching rows from unread activity filter", () => {
  const unreadItem = makeChannelItem({ channelId: "channel-unread-filter", unreadCount: 1 });
  const otherItem = makeChannelItem({ channelId: "channel-other", unreadCount: 1 });

  try {
    resetInbox([unreadItem, otherItem]);
    useInboxStore.setState({ filter: "unread" });
    useMessageStore.setState({ unreadCounts: { "channel-unread-filter": 1, "channel-other": 1 } });

    useMessageStore.getState().clearUnread("channel-unread-filter");

    assert.deepEqual(useInboxStore.getState().items.map((entry) => entry.kind !== "mention_action" ? entry.channelId : entry.id), ["channel-other"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    useMessageStore.setState({ unreadCounts: {} });
    resetInbox();
  }
});

test("markAllRead clears mention badges on retained inbox rows", async () => {
  const channelItem = makeChannelItem({ channelId: "channel-1", unreadCount: 2, hasMention: true });
  const dmItem = makeChannelItem({
    kind: "dm",
    channelId: "dm-1",
    channelName: "dm-alice",
    channelType: "dm",
    unreadCount: 1,
    hasMention: true,
  });
  let resolvePost: (() => void) | null = null;
  api.post = (() => new Promise((resolve) => {
    resolvePost = () => resolve({ data: {} });
  })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/unread") return { data: {} };
    if (url === "/channels/threads/followed") return { data: { threads: [] } };
    if (url === "/channels/inbox") return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([channelItem, dmItem]);

    const markAllPromise = useInboxStore.getState().markAllRead();

    const state = useInboxStore.getState();
    assert.equal(state.totalUnreadCount, 0);
    assert.equal(state.activeUnreadCount, 0);
    assert.deepEqual(
      state.items.map((item) => ({ key: getInboxItemKey(item), unreadCount: item.unreadCount, hasMention: item.hasMention })),
      [
        { key: "channel:channel-1", unreadCount: 0, hasMention: false },
        { key: "dm:dm-1", unreadCount: 0, hasMention: false },
      ],
    );
    assert.ok(resolvePost);
    resolvePost();
    await markAllPromise;
  } finally {
    restoreApi();
    resetInbox();
  }
});



test("background inbox refresh does not enter the visible loading state", async () => {
  const response = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    return response.promise;
  }) as typeof api.get;

  try {
    resetInbox();
    useInboxStore.setState({ filter: "unread", loaded: true, hasMore: false });

    const refresh = useInboxStore.getState().loadInbox({ reset: true, background: true });

    assert.equal(useInboxStore.getState().loading, false);
    response.resolve({ data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } });
    await refresh;

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loaded, true);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a socket background reset cannot discard a ready foreground first window", async () => {
  const readyItem = wireRowWithFrontier(makeChannelItem({
    channelId: "channel-ready-before-background",
    lastMessagePreview: "ready API row",
  }), S1);
  const freshItem = wireRowWithFrontier(makeChannelItem({
    channelId: "channel-from-trailing-background",
    lastMessagePreview: "fresh trailing API row",
  }), S2);
  const foreground = deferred<{
    data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number };
  }>();
  const trailing = deferred<{
    data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number };
  }>();
  let inboxRequests = 0;
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    inboxRequests += 1;
    return inboxRequests === 1 ? foreground.promise : trailing.promise;
  }) as typeof api.get;

  try {
    resetInbox();
    useInboxStore.setState({ loaded: false });

    const firstWindow = useInboxStore.getState().loadInbox({ reset: true });
    const socketReconcile = useInboxStore.getState().loadInbox({ reset: true, background: true });
    let socketReconcileSettled = false;
    void socketReconcile.then(() => {
      socketReconcileSettled = true;
    });

    foreground.resolve({
      data: {
        items: [readyItem],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: readyItem.unreadCount,
      },
    });
    await firstWindow;
    const visibleAfterReadyResponse = useInboxStore.getState().items.map(getInboxItemKey);

    assert.equal(inboxRequests, 2, "the coalesced socket reconcile must start after first-window acceptance");
    assert.equal(
      socketReconcileSettled,
      false,
      "the coalesced caller must remain pending until its trailing network request and store commit complete",
    );

    trailing.resolve({
      data: {
        items: [freshItem],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: freshItem.unreadCount,
      },
    });
    await socketReconcile;

    assert.deepEqual(
      visibleAfterReadyResponse,
      ["channel:channel-ready-before-background"],
      "once the foreground API response is ready, a later background reconcile must not leave the Activity projection at 0 rows",
    );
    assert.equal(socketReconcileSettled, true);
    assert.deepEqual(
      useInboxStore.getState().items.map(getInboxItemKey),
      ["channel:channel-from-trailing-background"],
      "awaiting the coalesced caller must observe the accepted fresh trailing response",
    );
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("server reset releases every coalesced background caller without starting stale trailing work", async () => {
  const foreground = deferred<{
    data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number };
  }>();
  let inboxRequests = 0;
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    inboxRequests += 1;
    return foreground.promise;
  }) as typeof api.get;

  try {
    resetInbox();

    const foregroundLoad = useInboxStore.getState().loadInbox({ reset: true });
    const firstCoalesced = useInboxStore.getState().loadInbox({ reset: true, background: true });
    const secondCoalesced = useInboxStore.getState().refreshInbox({ background: true });
    let firstSettled = false;
    let secondSettled = false;
    void firstCoalesced.then(() => {
      firstSettled = true;
    });
    void secondCoalesced.then(() => {
      secondSettled = true;
    });

    assert.equal(inboxRequests, 1);
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false);

    triggerServerReset();
    await flushPromises();

    assert.equal(firstSettled, true);
    assert.equal(secondSettled, true);
    assert.equal(inboxRequests, 1, "server reset must not start trailing work for the invalidated context");
    await Promise.all([firstCoalesced, secondCoalesced]);

    foreground.resolve({ data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } });
    await foregroundLoad;
    assert.equal(inboxRequests, 1);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a background reconcile preserves the loaded pagination window", async () => {
  const loadedItems = Array.from({ length: 60 }, (_, index) => makeChannelItem({
    channelId: `loaded-channel-${index}`,
    lastMessageId: `loaded-message-${index}`,
    lastMessagePreview: `loaded row ${index}`,
  }));
  let requestedLimit: number | undefined;
  api.get = ((url: string, config?: { params?: { limit?: number } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    requestedLimit = config?.params?.limit;
    return Promise.resolve({
      data: {
        items: loadedItems,
        hasMore: true,
        totalCount: 97,
        totalUnreadCount: loadedItems.reduce((sum, item) => sum + item.unreadCount, 0),
      },
    });
  }) as typeof api.get;

  try {
    resetInbox(loadedItems);

    await useInboxStore.getState().loadInbox({ reset: true, background: true });

    assert.equal(requestedLimit, 60, "a single socket reconciliation request must preserve the loaded window up to the API cap");
    assert.equal(useInboxStore.getState().items.length, 60);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a loaded foreground reset refreshes the first window without collapsing pagination tail", async () => {
  const loadedItems = Array.from({ length: 90 }, (_, index) => makeChannelItem({
    channelId: `loaded-foreground-channel-${index}`,
    channelName: `loaded foreground ${index}`,
    lastMessageId: `loaded-foreground-message-${index}`,
    lastMessagePreview: `loaded foreground row ${index}`,
  }));
  const refreshedFirstPage = loadedItems.slice(0, 30).map((item, index) => ({
    ...item,
    lastMessagePreview: `refreshed foreground row ${index}`,
  }));
  const response = deferred<{
    data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number };
  }>();
  let requestedLimit: number | undefined;
  let requestedOffset: number | undefined;
  api.get = ((url: string, config?: { params?: { limit?: number; offset?: number } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    requestedLimit = config?.params?.limit;
    requestedOffset = config?.params?.offset;
    return response.promise;
  }) as typeof api.get;

  try {
    resetInbox(loadedItems);
    useInboxStore.setState({ loaded: true });

    const reset = useInboxStore.getState().loadInbox({ reset: true });

    assert.equal(requestedLimit, 90, "loaded-window reset should ask for the already rendered width");
    assert.equal(requestedOffset, 0);
    assert.equal(useInboxStore.getState().loading, false, "loaded-window reset must not show the first-window loading state");
    response.resolve({
      data: {
        items: refreshedFirstPage,
        hasMore: true,
        totalCount: 1192,
        totalUnreadCount: loadedItems.reduce((sum, item) => sum + item.unreadCount, 0),
      },
    });
    await reset;

    const keys = useInboxStore.getState().items.map(getInboxItemKey);
    assert.equal(keys.length, 90);
    assert.deepEqual(
      keys.slice(30),
      loadedItems.slice(30).map(getInboxItemKey),
      "a first-page reset response must preserve the already loaded tail",
    );
    assert.equal(
      useInboxStore.getState().items[0]?.lastMessagePreview,
      "refreshed foreground row 0",
      "the visible first window should still refresh from the reset response",
    );
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a shifted loaded reset keeps displaced boundary rows in the pagination tail", async () => {
  const loadedItems = Array.from({ length: 90 }, (_, index) => makeChannelItem({
    channelId: `shifted-loaded-channel-${index}`,
    channelName: `shifted loaded ${index}`,
    lastMessageId: `shifted-loaded-message-${index}`,
    lastMessagePreview: `shifted loaded row ${index}`,
  }));
  const insertedItem = makeChannelItem({
    channelId: "shifted-loaded-inserted",
    channelName: "shifted inserted",
    lastMessageId: "shifted-loaded-inserted-message",
    lastMessagePreview: "shifted inserted row",
  });
  const refreshedItems = [
    insertedItem,
    ...loadedItems.slice(0, 29).map((item, index) => ({
      ...item,
      lastMessagePreview: `shifted refreshed row ${index}`,
    })),
  ];
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    return Promise.resolve({
      data: {
        items: refreshedItems,
        hasMore: true,
        totalCount: 1193,
        totalUnreadCount: loadedItems.reduce((sum, item) => sum + item.unreadCount, insertedItem.unreadCount),
      },
    });
  }) as typeof api.get;

  try {
    resetInbox(loadedItems);
    useInboxStore.setState({ loaded: true });

    await useInboxStore.getState().loadInbox({ reset: true });

    const keys = useInboxStore.getState().items.map(getInboxItemKey);
    assert.equal(keys.length, 91);
    assert.deepEqual(
      keys.slice(0, 30),
      refreshedItems.map(getInboxItemKey),
      "the refreshed first window should keep server order after an insertion",
    );
    assert.deepEqual(
      keys.slice(30),
      loadedItems.slice(29).map(getInboxItemKey),
      "a row displaced out of the refreshed first window must stay in the loaded tail",
    );
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("an unread loaded reset does not preserve rows removed from the filtered view", async () => {
  const loadedItems = Array.from({ length: 90 }, (_, index) => makeChannelItem({
    channelId: `unread-loaded-channel-${index}`,
    channelName: `unread loaded ${index}`,
    lastMessageId: `unread-loaded-message-${index}`,
    lastMessagePreview: `unread loaded row ${index}`,
    unreadCount: 1,
  }));
  const refreshedItems = loadedItems.slice(0, 30).map((item, index) => ({
    ...item,
    lastMessagePreview: `unread refreshed row ${index}`,
  }));
  let requestedFilter: string | undefined;
  let requestedLimit: number | undefined;
  api.get = ((url: string, config?: { params?: { filter?: string; limit?: number } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    requestedFilter = config?.params?.filter;
    requestedLimit = config?.params?.limit;
    return Promise.resolve({
      data: {
        items: refreshedItems,
        hasMore: true,
        totalCount: 30,
        totalUnreadCount: refreshedItems.reduce((sum, item) => sum + item.unreadCount, 0),
      },
    });
  }) as typeof api.get;

  try {
    resetInbox(loadedItems);
    useInboxStore.setState({ filter: "unread", loaded: true, totalCount: 90, totalUnreadCount: 90 });

    await useInboxStore.getState().loadInbox({ reset: true });

    const keys = useInboxStore.getState().items.map(getInboxItemKey);
    assert.equal(requestedFilter, "unread");
    assert.equal(requestedLimit, 90, "same-view filtered reset may refresh the loaded window width");
    assert.deepEqual(
      keys,
      refreshedItems.map(getInboxItemKey),
      "rows omitted by the server's unread filter must not be restored from the stale loaded tail",
    );
    assert.equal(useInboxStore.getState().totalCount, 30);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a searched loaded reset does not preserve rows removed from the query result", async () => {
  const loadedItems = Array.from({ length: 90 }, (_, index) => makeChannelItem({
    channelId: `search-loaded-channel-${index}`,
    channelName: `search loaded ${index}`,
    lastMessageId: `search-loaded-message-${index}`,
    lastMessagePreview: `search loaded row ${index}`,
  }));
  const refreshedItems = loadedItems.slice(0, 30).map((item, index) => ({
    ...item,
    lastMessagePreview: `search refreshed row ${index}`,
  }));
  let requestedQuery: string | undefined;
  let requestedLimit: number | undefined;
  api.get = ((url: string, config?: { params?: { q?: string; limit?: number } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    requestedQuery = config?.params?.q;
    requestedLimit = config?.params?.limit;
    return Promise.resolve({
      data: {
        items: refreshedItems,
        hasMore: true,
        totalCount: 30,
        totalUnreadCount: refreshedItems.reduce((sum, item) => sum + item.unreadCount, 0),
      },
    });
  }) as typeof api.get;

  try {
    resetInbox(loadedItems);
    useInboxStore.setState({ searchQuery: "loaded", loaded: true, totalCount: 90 });

    await useInboxStore.getState().loadInbox({ reset: true });

    const keys = useInboxStore.getState().items.map(getInboxItemKey);
    assert.equal(requestedQuery, "loaded");
    assert.equal(requestedLimit, 90, "same-query reset may refresh the loaded window width");
    assert.deepEqual(
      keys,
      refreshedItems.map(getInboxItemKey),
      "rows omitted by the server's search query must not be restored from the stale loaded tail",
    );
    assert.equal(useInboxStore.getState().totalCount, 30);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("a capped background reconcile preserves loaded tail beyond the API window", async () => {
  const loadedItems = Array.from({ length: 150 }, (_, index) => makeChannelItem({
    channelId: `loaded-background-channel-${index}`,
    channelName: `loaded background ${index}`,
    lastMessageId: `loaded-background-message-${index}`,
    lastMessagePreview: `loaded background row ${index}`,
  }));
  const refreshedItems = loadedItems.slice(0, 100).map((item, index) => ({
    ...item,
    lastMessagePreview: `refreshed background row ${index}`,
  }));
  let requestedLimit: number | undefined;
  api.get = ((url: string, config?: { params?: { limit?: number } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    requestedLimit = config?.params?.limit;
    return Promise.resolve({
      data: {
        items: refreshedItems,
        hasMore: true,
        totalCount: 1192,
        totalUnreadCount: loadedItems.reduce((sum, item) => sum + item.unreadCount, 0),
      },
    });
  }) as typeof api.get;

  try {
    resetInbox(loadedItems);
    useInboxStore.setState({ loaded: true });

    await useInboxStore.getState().loadInbox({ reset: true, background: true });

    const keys = useInboxStore.getState().items.map(getInboxItemKey);
    assert.equal(requestedLimit, 100, "background reconcile remains capped at the API window");
    assert.equal(keys.length, 150);
    assert.deepEqual(
      keys.slice(100),
      loadedItems.slice(100).map(getInboxItemKey),
      "tail rows past the reconcile cap should remain available for scroll pagination",
    );
    assert.equal(useInboxStore.getState().items[0]?.lastMessagePreview, "refreshed background row 0");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("foreground inbox reset enters the visible loading state until the response lands", async () => {
  const response = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    return response.promise;
  }) as typeof api.get;

  try {
    resetInbox();

    const refresh = useInboxStore.getState().loadInbox({ reset: true });

    assert.equal(useInboxStore.getState().loading, true);
    assert.equal(useInboxStore.getState().loadingMore, false);
    response.resolve({ data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } });
    await refresh;

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loaded, true);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead is a no-op for already-read activity rows", async () => {
  const item = makeChannelItem({
    channelId: "channel-read-noop",
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
  });
  const postCalls: string[] = [];
  api.post = (async (url: string) => {
    postCalls.push(url);
    return { data: {} };
  }) as typeof api.post;

  try {
    resetInbox([item]);

    await useInboxStore.getState().markRead(item);

    assert.deepEqual(postCalls, []);
    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-read-noop"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead coalesces repeated clicks for the same Activity scope while the ACK is in flight", async () => {
  const item = makeChannelItem({
    channelId: "channel-read-in-flight",
    unreadCount: 1,
    firstUnreadMessageId: "message-before-read",
  });
  const response = deferred<{ data: { seq: number; readStateVersion: number } }>();
  const postCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    return response.promise;
  }) as typeof api.post;

  try {
    resetInbox([item]);

    const first = useInboxStore.getState().markRead(item);
    const repeated = useInboxStore.getState().markRead(item);

    assert.deepEqual(postCalls, ["/channels/channel-read-in-flight/read-all"]);
    response.resolve({ data: { seq: 9, readStateVersion: 2 } });
    await Promise.all([first, repeated]);

    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead success keeps stale background refresh rows read in all activity", async () => {
  const item = storeItemWithFrontier(makeChannelItem({ channelId: "channel-stale-read", unreadCount: 2, hasMention: true }), S1);
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [wireRowWithFrontier(item, S1)], hasMore: false, totalCount: 1, totalUnreadCount: 2 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([item]);

    await useInboxStore.getState().markRead(item);
    await useInboxStore.getState().refreshInbox({ background: true });

    const updated = useInboxStore.getState().items.find((entry) => getInboxItemKey(entry) === getInboxItemKey(item));
    assert.ok(updated);
    assert.equal(updated.unreadCount, 0);
    assert.equal(updated.firstUnreadMessageId, null);
    assert.equal(updated.hasMention, false);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead success keeps stale background refresh rows out of unread activity", async () => {
  const item = storeItemWithFrontier(makeChannelItem({ channelId: "channel-stale-unread", unreadCount: 1 }), S1);
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return {
        data: {
          items: [wireRowWithFrontier(item, S1)],
          groups: [{ channelId: item.channelId, channelName: item.channelName, channelType: item.channelType, count: 1 }],
          hasMore: false,
          totalCount: 1,
          totalUnreadCount: 1,
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([item]);
    useInboxStore.setState({
      filter: "unread",
      groups: [{ channelId: item.channelId, channelName: item.channelName, channelType: item.channelType, count: 1 }],
      totalCount: 1,
      totalUnreadCount: 1,
    });

    await useInboxStore.getState().markRead(item);
    await useInboxStore.getState().refreshInbox({ background: true });

    assert.deepEqual(useInboxStore.getState().items, []);
    assert.deepEqual(useInboxStore.getState().groups, []);
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead success keeps mention-action refresh rows visible while stale unread rows are suppressed", async () => {
  const item = storeItemWithFrontier(makeChannelItem({ channelId: "channel-read-with-action", unreadCount: 1 }), S1);
  const mentionAction = makeMentionActionItem({ id: "mention-action-after-read" });
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      // same frontier the user just read -> suppressed; the mention_action row
      // is not an ActivityPersistedItem and has no marker of its own.
      return { data: { items: [wireRowWithFrontier(item, S1), mentionAction], hasMore: false, totalCount: 2, totalUnreadCount: 1 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([item]);
    useInboxStore.setState({ filter: "unread", totalCount: 1, totalUnreadCount: 1 });

    await useInboxStore.getState().markRead(item);
    await useInboxStore.getState().refreshInbox({ background: true });

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["mention_action:mention-action-after-read"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead stale suppression expires after the local grace window", async () => {
  const originalDateNow = Date.now;
  let nowMs = 1_000;
  const item = storeItemWithFrontier(makeChannelItem({
    channelId: "channel-expiring-read",
    unreadCount: 1,
    lastMessageId: "message-before-read",
  }), S1);
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [wireRowWithFrontier(item, S1)], hasMore: false, totalCount: 1, totalUnreadCount: 1 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    Date.now = () => nowMs;
    resetInbox([item]);
    useInboxStore.setState({ filter: "unread", totalCount: 1, totalUnreadCount: 1 });

    await useInboxStore.getState().markRead(item);
    nowMs = 4_000;
    await useInboxStore.getState().refreshInbox({ background: true });

    assert.deepEqual(useInboxStore.getState().items, [], "read suppression remains active through the exact expiry boundary");
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);

    nowMs = 4_001;
    await useInboxStore.getState().refreshInbox({ background: true });

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-expiring-read"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    Date.now = originalDateNow;
    restoreApi();
    resetInbox();
  }
});

test("server reset clears local read suppression for the next server context", async () => {
  const item = makeChannelItem({
    channelId: "channel-reset-read",
    unreadCount: 1,
    lastMessageId: "message-before-read",
  });
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [item], hasMore: false, totalCount: 1, totalUnreadCount: 1 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([item]);
    useInboxStore.setState({ filter: "unread", totalCount: 1, totalUnreadCount: 1 });

    await useInboxStore.getState().markRead(item);
    triggerServerReset();
    await useInboxStore.getState().refreshInbox({ background: true });

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-reset-read"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markRead failure reconciles in the background without flashing loading", async () => {
  const item = makeChannelItem({ channelId: "channel-read-fail", unreadCount: 1 });
  const inboxResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.post = (async () => {
    throw new Error("read failed");
  }) as typeof api.post;
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    return inboxResponse.promise;
  }) as typeof api.get;
  const originalConsoleError = console.error;

  try {
    console.error = () => {};
    resetInbox([item]);

    const markRead = useInboxStore.getState().markRead(item);
    await flushPromises();

    assert.equal(useInboxStore.getState().loading, false);
    inboxResponse.resolve({ data: { items: [item], hasMore: false, totalCount: 1, totalUnreadCount: 1 } });
    await markRead;

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loaded, true);
    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), [getInboxItemKey(item)]);
    assert.equal(useInboxStore.getState().totalUnreadCount, 1);
  } finally {
    console.error = originalConsoleError;
    restoreApi();
    resetInbox();
  }
});

test("markAllRead is a no-op when there is no unread activity", async () => {
  const item = makeChannelItem({
    channelId: "channel-all-read-noop",
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
  });
  const postCalls: string[] = [];
  api.post = (async (url: string) => {
    postCalls.push(url);
    return { data: {} };
  }) as typeof api.post;

  try {
    resetInbox([item]);

    await useInboxStore.getState().markAllRead();

    assert.deepEqual(postCalls, []);
    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-all-read-noop"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markAllRead success reconciles in the background after optimistic clear", async () => {
  const item = makeChannelItem({ channelId: "channel-mark-all-bg", unreadCount: 2 });
  const inboxResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = ((url: string) => {
    if (url === "/channels/unread") return Promise.resolve({ data: {} });
    if (url === "/channels/threads/followed") return Promise.resolve({ data: { threads: [] } });
    if (url === "/channels/inbox") return inboxResponse.promise;
    return Promise.resolve({ data: {} });
  }) as typeof api.get;

  try {
    resetInbox([item]);

    const markAll = useInboxStore.getState().markAllRead();
    await flushPromises();

    assert.equal(useInboxStore.getState().loading, false);
    inboxResponse.resolve({ data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } });
    await markAll;

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loaded, true);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markAllRead success suppresses stale unread refresh rows for visible items", async () => {
  const item = storeItemWithFrontier(makeChannelItem({ channelId: "channel-mark-all-stale", unreadCount: 2 }), S1);
  const inboxResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = ((url: string) => {
    if (url === "/channels/unread") return Promise.resolve({ data: {} });
    if (url === "/channels/threads/followed") return Promise.resolve({ data: { threads: [] } });
    if (url === "/channels/inbox") return inboxResponse.promise;
    return Promise.resolve({ data: {} });
  }) as typeof api.get;

  try {
    resetInbox([item]);
    useInboxStore.setState({ filter: "unread", totalCount: 1, totalUnreadCount: 2 });

    const markAll = useInboxStore.getState().markAllRead();
    await flushPromises();

    inboxResponse.resolve({ data: { items: [wireRowWithFrontier(item, S1)], hasMore: false, totalCount: 1, totalUnreadCount: 2 } });
    await markAll;

    assert.deepEqual(useInboxStore.getState().items, []);
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markAllRead success does not suppress zero-unread rows from stale refreshes", async () => {
  const item = storeItemWithFrontier(makeChannelItem({ channelId: "channel-mark-all-stale-unread", unreadCount: 2 }), S1);
  const readItem = storeItemWithFrontier(makeChannelItem({
    channelId: "channel-mark-all-stale-read",
    unreadCount: 0,
    hasMention: false,
    firstUnreadMessageId: null,
    lastMessageId: "message-already-read",
  }), S1);
  const inboxResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = ((url: string) => {
    if (url === "/channels/unread") return Promise.resolve({ data: {} });
    if (url === "/channels/threads/followed") return Promise.resolve({ data: { threads: [] } });
    if (url === "/channels/inbox") return inboxResponse.promise;
    return Promise.resolve({ data: {} });
  }) as typeof api.get;

  try {
    resetInbox([item, readItem]);
    useInboxStore.setState({ filter: "unread", totalCount: 2, totalUnreadCount: 2 });

    const markAll = useInboxStore.getState().markAllRead();
    await flushPromises();

    // both rows carry the same frontier they were acted on with: the unread one
    // is stale-suppressed, the already-read one must NOT be.
    inboxResponse.resolve({
      data: {
        items: [wireRowWithFrontier(item, S1), wireRowWithFrontier(readItem, S1)] as unknown as InboxItem[],
        hasMore: false,
        totalCount: 2,
        totalUnreadCount: 2,
      },
    });
    await markAll;

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-mark-all-stale-read"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markAllRead failure reconciles in the background before reloading unread counts", async () => {
  const item = makeChannelItem({ channelId: "channel-mark-all-fail", unreadCount: 2 });
  const inboxResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.post = (async () => {
    throw new Error("mark all failed");
  }) as typeof api.post;
  api.get = ((url: string) => {
    if (url === "/channels/unread") return Promise.resolve({ data: {} });
    if (url === "/channels/inbox") return inboxResponse.promise;
    return Promise.resolve({ data: {} });
  }) as typeof api.get;
  const originalConsoleError = console.error;

  try {
    console.error = () => {};
    resetInbox([item]);

    const markAll = useInboxStore.getState().markAllRead();
    await flushPromises();

    assert.equal(useInboxStore.getState().loading, false);
    inboxResponse.resolve({ data: { items: [item], hasMore: false, totalCount: 1, totalUnreadCount: 2 } });
    await markAll;

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loaded, true);
    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-mark-all-fail"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally {
    console.error = originalConsoleError;
    restoreApi();
    resetInbox();
  }
});

test("server reset clears loaded and pagination loading state", () => {
  useInboxStore.setState({
    loaded: true,
    loadingMore: true,
    groups: [{ channelId: "channel-before-reset", channelName: "before-reset", channelType: "channel", count: 1 }],
  });

  triggerServerReset();

  assert.equal(useInboxStore.getState().loaded, false);
  assert.equal(useInboxStore.getState().loadingMore, false);
  assert.deepEqual(useInboxStore.getState().groups, []);
});

test("loadInbox next page enters loadingMore until the response lands", async () => {
  const existingItem = makeChannelItem({
    channelId: "channel-loading-more",
    lastMessageId: "message-loading-more",
  });
  const response = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    return response.promise;
  }) as typeof api.get;

  try {
    resetInbox([existingItem]);

    const loadMore = useInboxStore.getState().loadInbox();

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loadingMore, true);
    response.resolve({ data: { items: [], hasMore: false, totalCount: 1, totalUnreadCount: 2 } });
    await loadMore;

    assert.equal(useInboxStore.getState().loadingMore, false);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("active inbox load errors cannot clear loading after the filter changes", async () => {
  const originalConsoleError = console.error;
  const response = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    return response.promise;
  }) as typeof api.get;

  try {
    console.error = () => {};
    resetInbox();
    useInboxStore.setState({ filter: "unread" });

    const load = useInboxStore.getState().loadInbox({ reset: true });
    assert.equal(useInboxStore.getState().loading, true);

    useInboxStore.setState({ filter: "all" });
    response.reject(new Error("filter changed before load failed"));
    await load.catch(() => undefined);

    assert.equal(useInboxStore.getState().filter, "all");
    assert.equal(useInboxStore.getState().loading, true, "active failed request must not clear a different filter view");
  } finally {
    console.error = originalConsoleError;
    restoreApi();
    resetInbox();
  }
});

test("markDone removes the activity row before the server responds", async () => {
  const item = makeChannelItem({ channelId: "channel-done", unreadCount: 3 });
  const postResponse = deferred<{ data: Record<string, never> }>();
  const postCalls: string[] = [];
  api.post = ((url: string) => {
    postCalls.push(url);
    return postResponse.promise;
  }) as typeof api.post;

  try {
    resetInbox([item]);

    const markDonePromise = useInboxStore.getState().markDone(item);

    assert.deepEqual(useInboxStore.getState().items, []);
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    assert.deepEqual(postCalls, ["/channels/inbox/done"]);

    postResponse.resolve({ data: {} });
    await markDonePromise;
  } finally {
    restoreApi();
    resetInbox();
  }
});

/**
 * @赵梓淇 frozen final 1 — proven inside the PENDING window on purpose.
 *
 * The previous version of this tooth served the "newer" round with the SAME
 * frontier and let the POST succeed first, so the row reappeared because
 * suppression had been retired on confirmation — not because a newer frontier
 * was compared. It was green for the wrong reason. Holding the POST keeps the
 * suppression alive, so the ONLY thing that can reveal the row is S2 > S1.
 */
for (const kind of ["channel", "dm"] as const) {
  test(`markDone (${kind}): same frontier stays hidden, a NEWER frontier reveals — inside the pending window`, async () => {
    const base = makeChannelItem({
      kind,
      channelId: `${kind}-done-frontier`,
      unreadCount: 2,
      lastMessageId: "message-before-done",
    } as never);
    const staleItem = storeItemWithFrontier(base, S1);
    const newerItem = storeItemWithFrontier(makeChannelItem({
      kind,
      channelId: `${kind}-done-frontier`,
      unreadCount: 1,
      lastMessageId: "message-after-done",
      firstUnreadMessageId: "message-after-done",
      lastMessagePreview: "newer activity",
    } as never), S2);

    // Hold the POST: suppression stays in its pending window for the whole test.
    const persisted = deferred<{ data: unknown }>();
    api.post = (() => persisted.promise) as typeof api.post;

    const inboxResponses = [
      // round 1: SAME frontier -> must remain suppressed
      { items: [wireRowWithFrontier(staleItem, S1)], totalCount: 1, totalUnreadCount: 2 },
      // round 2: NEWER frontier, same pending intent -> must reveal
      { items: [wireRowWithFrontier(newerItem, S2)], totalCount: 1, totalUnreadCount: 1 },
    ];
    api.get = (async (url: string) => {
      if (url === "/channels/inbox") {
        const response = inboxResponses.shift();
        return {
          data: {
            items: response?.items ?? [],
            hasMore: false,
            totalCount: response?.totalCount ?? 0,
            totalUnreadCount: response?.totalUnreadCount ?? 0,
          },
        };
      }
      return { data: {} };
    }) as typeof api.get;

    try {
      resetInbox([staleItem]);

      void useInboxStore.getState().markDone(staleItem);
      await flushPromises();

      await useInboxStore.getState().refreshInbox();
      assert.deepEqual(
        useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)),
        [],
        "same authority frontier must stay suppressed while the Done is still pending",
      );

      await useInboxStore.getState().refreshInbox();
      assert.deepEqual(
        useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)),
        [`${kind}:${kind}-done-frontier`],
        "a NEWER authority frontier must reveal the row even though the Done is still pending",
      );
    } finally {
      persisted.resolve({ data: {} });
      restoreApi();
      resetInbox();
    }
  });
}

test("markDone suppresses only the done row and recomputes fallback totals when counts are omitted", async () => {
  const staleItem = storeItemWithFrontier(makeChannelItem({
    channelId: "channel-done-fallback",
    unreadCount: 2,
    lastMessageId: "message-before-done",
  }), S1);
  const otherItem = storeItemWithFrontier(makeChannelItem({
    channelId: "channel-other-visible",
    unreadCount: 4,
    lastMessageId: "message-other",
    firstUnreadMessageId: "message-other",
    lastMessagePreview: "other activity",
  }), S1);
  // #5690: assert inside the PENDING window. After the server confirms Done the
  // suppression is retired by design, so a server that keeps serving the row
  // must show it again (see the T7 boundary tooth) — the "only the done row is
  // suppressed" property belongs to the window before confirmation.
  const persisted = deferred<{ data: unknown }>();
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      // both carry their own frontier: only the DONE row is suppressed, the
      // untouched row stays visible and keeps contributing to fallback totals.
      return { data: { items: [wireRowWithFrontier(staleItem, S1), wireRowWithFrontier(otherItem, S1)], hasMore: false } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([staleItem]);

    void useInboxStore.getState().markDone(staleItem);
    await flushPromises();
    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-other-visible"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 4);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markDone keeps mention-action refresh rows visible while stale activity rows are suppressed", async () => {
  const staleItem = storeItemWithFrontier(makeChannelItem({
    channelId: "channel-done-with-action",
    unreadCount: 2,
    lastMessageId: "message-before-done",
  }), S1);
  const mentionAction = makeMentionActionItem({ id: "mention-action-visible" });
  // #5690: assert inside the PENDING window — see the fallback-totals test above.
  const persisted = deferred<{ data: unknown }>();
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      // same frontier as the Done click -> suppressed; mention_action stays.
      return { data: { items: [wireRowWithFrontier(staleItem, S1), mentionAction], hasMore: false, totalCount: 2, totalUnreadCount: 2 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([staleItem]);

    void useInboxStore.getState().markDone(staleItem);
    await flushPromises();
    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["mention_action:mention-action-visible"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markDone uses thread latest-activity markers for stale refresh suppression", async () => {
  // Intent: the SAME authority frontier (S1) must stay suppressed after Done;
  // genuinely newer activity (S2) must legitimately reappear.
  const staleThread = storeItemWithFrontier(makeThreadItem({
    threadChannelId: "thread-done-stale",
    latestActivityMessageId: "reply-before-done",
    unreadCount: 2,
  }), S1);
  const newerThread = makeThreadItem({
    threadChannelId: "thread-done-stale",
    latestActivityMessageId: "reply-after-done",
    firstUnreadMessageId: "reply-after-done",
    latestActivityPreview: "newer reply",
    unreadCount: 1,
  });
  const inboxResponses = [
    // wire #1 carries the same frontier the user acted on -> still suppressed
    { items: [wireRowWithFrontier(staleThread, S1)], totalCount: 1, totalUnreadCount: 2 },
    // wire #2 carries a NEWER frontier -> the row legitimately returns
    { items: [wireRowWithFrontier(newerThread, S2)], totalCount: 1, totalUnreadCount: 1 },
  ];
  const postCalls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    return { data: {} };
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      const response = inboxResponses.shift();
      return {
        data: {
          items: response?.items ?? [],
          hasMore: false,
          totalCount: response?.totalCount ?? 0,
          totalUnreadCount: response?.totalUnreadCount ?? 0,
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([staleThread]);

    // #5690: the built-in authoritative refresh on success consumes the first
    // queued response; the stale same-marker thread must be suppressed by it.
    await useInboxStore.getState().markDone(staleThread);
    assert.deepEqual(postCalls[0], {
      url: "/channels/threads/done",
      body: {
        threadChannelId: "thread-done-stale",
        throughActivitySeq: S1,
        frontierSpace: "storage",
      },
    });

    assert.deepEqual(useInboxStore.getState().items, [], "same latest-activity marker must not reappear after local Done");

    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["thread:thread-done-stale"]);
    const updated = useInboxStore.getState().items[0];
    assert.ok(updated);
    if (updated.kind !== "thread") throw new Error("expected newer thread activity row");
    assert.equal(updated.latestActivityMessageId, "reply-after-done");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markDone stale suppression expires after the local grace window", async () => {
  const originalDateNow = Date.now;
  let nowMs = 1_000;
  const item = storeItemWithFrontier(makeChannelItem({
    channelId: "channel-expiring-done",
    unreadCount: 2,
    lastMessageId: "message-before-done",
  }), S1);
  // #5690: the 30s grace window is now the PENDING window only — it ends at
  // server confirmation, not at TTL expiry. Hold the POST so the boundary is
  // still observable; once the server confirms, retirement is by design and a
  // server that keeps serving the row must show it (T7).
  const persisted = deferred<{ data: unknown }>();
  api.post = (() => persisted.promise) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      // same frontier throughout: the boundary under test is the pending
      // window, not a change of activity.
      return { data: { items: [wireRowWithFrontier(item, S1)], hasMore: false, totalCount: 1, totalUnreadCount: 2 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    Date.now = () => nowMs;
    resetInbox([item]);

    void useInboxStore.getState().markDone(item);
    await flushPromises();
    nowMs = 31_000;
    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(useInboxStore.getState().items, [], "suppression remains active through the exact expiry boundary");

    nowMs = 31_001;
    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-expiring-done"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally {
    Date.now = originalDateNow;
    restoreApi();
    resetInbox();
  }
});

test("server reset clears local done suppression for the next server context", async () => {
  const item = makeChannelItem({
    channelId: "channel-reset-done",
    unreadCount: 2,
    lastMessageId: "message-before-done",
  });
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [item], hasMore: false, totalCount: 1, totalUnreadCount: 2 } };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([item]);

    await useInboxStore.getState().markDone(item);
    triggerServerReset();
    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-reset-done"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markDone keeps mention-action completion local-only", async () => {
  const item = makeMentionActionItem();
  const postCalls: string[] = [];
  api.post = (async (url: string) => {
    postCalls.push(url);
    return { data: {} };
  }) as typeof api.post;

  try {
    resetInbox([item]);

    await useInboxStore.getState().markDone(item);

    assert.deepEqual(useInboxStore.getState().items, []);
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    assert.deepEqual(postCalls, []);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("markDone refreshes activity if the optimistic done request fails", async () => {
  const item = makeChannelItem({ channelId: "channel-fail", unreadCount: 2 });
  const getCalls: string[] = [];
  const originalConsoleError = console.error;
  api.post = (async () => {
    throw new Error("done failed");
  }) as typeof api.post;
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/channels/inbox") {
      return { data: { items: [item], hasMore: false, totalCount: 1, totalUnreadCount: 2 } };
    }
    if (url === "/channels/unread") return { data: { "channel-fail": 2 } };
    return { data: {} };
  }) as typeof api.get;

  try {
    console.error = () => {};
    resetInbox([item]);

    await useInboxStore.getState().markDone(item);

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), ["channel:channel-fail"]);
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
    assert.ok(getCalls.includes("/channels/inbox"));

    await useInboxStore.getState().refreshInbox();

    assert.deepEqual(
      useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)),
      ["channel:channel-fail"],
      "failed Done must clear same-marker suppression so later refreshes can restore the row",
    );
    assert.equal(useInboxStore.getState().totalCount, 1);
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally {
    console.error = originalConsoleError;
    restoreApi();
    resetInbox();
  }
});

test("loadInbox appends next pages, removes duplicate keys, and preserves server totals", async () => {
  const existingItem = makeChannelItem({
    channelId: "channel-existing",
    unreadCount: 1,
    lastMessageId: "message-existing",
  });
  const duplicateExisting = makeChannelItem({
    channelId: "channel-existing",
    unreadCount: 1,
    lastMessageId: "message-existing",
  });
  const nextItem = makeChannelItem({
    channelId: "channel-next",
    unreadCount: 3,
    lastMessageId: "message-next",
    firstUnreadMessageId: "message-next",
  });
  api.get = (async (url: string, config?: { params?: { offset?: number } }) => {
    if (url === "/channels/inbox") {
      assert.equal(config?.params?.offset, 1);
      return {
        data: {
          items: [duplicateExisting, nextItem],
          hasMore: false,
          totalCount: 5,
          totalUnreadCount: 9,
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    resetInbox([existingItem]);

    await useInboxStore.getState().loadInbox();

    assert.deepEqual(useInboxStore.getState().items.map((entry) => getInboxItemKey(entry)), [
      "channel:channel-existing",
      "channel:channel-next",
    ]);
    assert.equal(useInboxStore.getState().totalCount, 5);
    assert.equal(useInboxStore.getState().totalUnreadCount, 9);
    assert.equal(useInboxStore.getState().loadingMore, false);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("active inbox load errors clear loading state and log the failure", async () => {
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      throw new Error("load failed");
    }
    return { data: {} };
  }) as typeof api.get;

  try {
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    resetInbox();

    await useInboxStore.getState().loadInbox({ reset: true });

    assert.equal(useInboxStore.getState().loading, false);
    assert.equal(useInboxStore.getState().loadingMore, false);
    assert.equal(useInboxStore.getState().loaded, true);
    assert.equal(errors[0]?.[0], "Failed to load inbox:");
  } finally {
    console.error = originalConsoleError;
    restoreApi();
    resetInbox();
  }
});

test("stale inbox load errors cannot clear the current request loading state", async () => {
  const originalConsoleError = console.error;
  const firstResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  const secondResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  let requestCount = 0;
  api.get = ((url: string) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    requestCount += 1;
    return requestCount === 1 ? firstResponse.promise : secondResponse.promise;
  }) as typeof api.get;

  try {
    console.error = () => {};
    resetInbox();

    const firstLoad = useInboxStore.getState().loadInbox({ reset: true });
    const secondLoad = useInboxStore.getState().loadInbox({ reset: true });

    firstResponse.reject(new Error("stale load failed"));
    await flushPromises();

    assert.equal(useInboxStore.getState().loading, true, "stale failed request must not clear the active request");

    secondResponse.resolve({ data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } });
    await Promise.all([firstLoad.catch(() => undefined), secondLoad]);

    assert.equal(useInboxStore.getState().loading, false);
  } finally {
    console.error = originalConsoleError;
    restoreApi();
    resetInbox();
  }
});

test("stale inbox filter response cannot overwrite the current filter view", async () => {
  const unreadItem = makeChannelItem({
    channelId: "unread-channel",
    channelName: "unread",
    lastMessagePreview: "unread-only row",
    unreadCount: 1,
  });
  const allItem = makeChannelItem({
    channelId: "all-channel",
    channelName: "all",
    lastMessagePreview: "all row",
    unreadCount: 0,
    hasMention: false,
  });
  const unreadResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  const allResponse = deferred<{ data: { items: InboxItem[]; hasMore: boolean; totalCount: number; totalUnreadCount: number } }>();
  const requestedFilters: string[] = [];

  api.get = ((url: string, config?: { params?: { filter?: string } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    const filter = config?.params?.filter ?? "all";
    requestedFilters.push(filter);
    if (filter === "unread") return unreadResponse.promise;
    if (filter === "all") return allResponse.promise;
    return Promise.resolve({ data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } });
  }) as typeof api.get;

  try {
    resetInbox();

    useInboxStore.getState().setFilter("unread");
    useInboxStore.getState().setFilter("all");

    assert.deepEqual(requestedFilters, ["unread", "all"]);

    unreadResponse.resolve({
      data: { items: [unreadItem], hasMore: false, totalCount: 1, totalUnreadCount: 1 },
    });
    await flushPromises();

    assert.equal(useInboxStore.getState().filter, "all");
    assert.deepEqual(useInboxStore.getState().items, [], "stale unread response must not populate the all view");
    assert.equal(useInboxStore.getState().loading, true, "current all request should remain authoritative");

    allResponse.resolve({
      data: { items: [allItem], hasMore: false, totalCount: 1, totalUnreadCount: 0 },
    });
    await flushPromises();

    assert.equal(useInboxStore.getState().filter, "all");
    assert.deepEqual(useInboxStore.getState().items.map((item) => item.channelId), ["all-channel"]);
    assert.equal(useInboxStore.getState().loading, false);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("stale inbox channel response cannot overwrite the current channel facet", async () => {
  const selectedItem = makeChannelItem({ channelId: "selected-channel", channelName: "selected" });
  const allItem = makeChannelItem({ channelId: "all-channel", channelName: "all", unreadCount: 0, hasMention: false });
  type GroupResponse = {
    data: {
      items: InboxItem[];
      groups: Array<{ channelId: string; channelName: string; channelType: "channel"; count: number }>;
      hasMore: boolean;
      totalCount: number;
      totalUnreadCount: number;
    };
  };
  const selectedResponse = deferred<GroupResponse>();
  const allResponse = deferred<GroupResponse>();
  const requestedChannelIds: Array<string | undefined> = [];

  api.get = ((url: string, config?: { params?: { channelId?: string } }) => {
    if (url !== "/channels/inbox") return Promise.resolve({ data: {} });
    const channelId = config?.params?.channelId;
    requestedChannelIds.push(channelId);
    return channelId === "selected-channel" ? selectedResponse.promise : allResponse.promise;
  }) as typeof api.get;

  try {
    resetInbox();
    useInboxStore.getState().setChannelFilterId("selected-channel");
    useInboxStore.getState().setChannelFilterId(null);
    assert.deepEqual(requestedChannelIds, ["selected-channel", undefined]);

    selectedResponse.resolve({
      data: {
        items: [selectedItem],
        groups: [{ channelId: "selected-channel", channelName: "selected", channelType: "channel", count: 1 }],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 2,
      },
    });
    await flushPromises();
    assert.equal(useInboxStore.getState().channelFilterId, null);
    assert.deepEqual(useInboxStore.getState().items, []);
    assert.deepEqual(useInboxStore.getState().groups, []);
    assert.equal(useInboxStore.getState().loading, true);

    allResponse.resolve({
      data: {
        items: [allItem],
        groups: [{ channelId: "all-channel", channelName: "all", channelType: "channel", count: 1 }],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 0,
      },
    });
    await flushPromises();
    assert.deepEqual(useInboxStore.getState().items.map((item) => item.channelId), ["all-channel"]);
    assert.deepEqual(useInboxStore.getState().groups.map((group) => group.channelId), ["all-channel"]);
    assert.equal(useInboxStore.getState().loading, false);
  } finally {
    restoreApi();
    resetInbox();
  }
});
