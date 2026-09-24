import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "../helpers/domSetup";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "../helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useLocation } from "react-router-dom";
import { ToastProvider } from "raft-ui";
import api from "../../src/api/client";
import { getSocket } from "../../src/api/socket";
import { ActivityThreadContentRoute } from "../../src/components/layout/MainLayout";
import { syncRightPanelStoresFromSearch } from "../../src/components/layout/rightPanelUrlSync";
import {
  getThreadParentMessageIdFromParam,
  resolveChatPanelQueryFocusMessageId,
} from "../../src/components/message/ChatPanel";
import ThreadPanel from "../../src/components/message/ThreadPanel";
import { useAppNavigate } from "../../src/hooks/useAppNavigate";
import { useAgentStore } from "../../src/store/agentStore";
import { useAuthStore } from "../../src/store/authStore";
import type { User } from "../../src/store/authStore";
import { useChannelStore } from "../../src/store/channelStore";
import type { Channel } from "../../src/store/channelStore";
import { useInboxStore } from "../../src/store/inboxStore";
import type { InboxItem } from "../../src/store/inboxStore";
import {
  formatSearchOpenParam,
  parseSearchOpenParam,
  useSearchContentStore,
} from "../../src/store/searchContentStore";
import type {
  SearchContentSlot,
} from "../../src/store/searchContentStore";
import { useServerStore } from "../../src/store/serverStore";
import { buildMainLayoutSocketBindings } from "../../src/store/socketBridge";
import type { Message } from "../../src/store/messageStore";
import { useMessageStore } from "../../src/store/messageStore";
import { useTaskStore } from "../../src/store/taskStore";
import { useThreadStore } from "../../src/store/threadStore";
import {
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../../src/store/serverFeatureFlags";
import { createMessageWindowHarness } from "../messageWindowHarness";

type TestFn = (t: unknown) => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn as never);

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalLoadInbox = useInboxStore.getState().loadInbox;

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView ?? function scrollIntoView() {};
HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo ?? function scrollTo() {};
globalThis.CSS = globalThis.CSS ?? {
  escape: (value: string) => String(value).replace(/["\\]/g, "\\$&"),
} as typeof CSS;

interface ChannelFocusTarget {
  kind: "channel" | "dm";
  channelId: string;
  messageId: string;
}

interface ThreadFocusTarget {
  kind: "thread";
  parentChannelId: string;
  parentMessageId: string;
  threadChannelId: string;
  messageId: string;
}

type FocusTarget = ChannelFocusTarget | ThreadFocusTarget;

function seedServer() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "acme",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  });
}

function makeSidebarOrder() {
  return {
    channelOrder: [],
    agentOrder: [],
    dmOrder: [],
    channelSortMode: "manual" as const,
    jointChannelSortMode: "manual" as const,
    dmSortMode: "manual" as const,
    pinnedSortMode: "manual" as const,
    pinnedChannelIds: [],
    pinnedAgentIds: [],
    pinnedOrder: [],
    hiddenDmIds: [],
    channelPanelTabOrder: [],
    agentPanelTabOrder: [],
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "ada@example.com",
    gravatarHash: "",
    name: "ada",
    displayName: "Ada",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: "UTC",
    autoTranslationEnabled: false,
    preferredTranslationDisplay: "original",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "release",
    description: null,
    type: "channel",
    createdAt: "2026-07-10T00:00:00.000Z",
    joined: true,
    activityMuteSupported: false,
    ...overrides,
  };
}

let currentLocation = "";

function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
}

function NavButton({
  run,
}: {
  run: (nav: ReturnType<typeof useAppNavigate>) => void;
}) {
  const nav = useAppNavigate();
  return (
    <button type="button" onClick={() => run(nav)}>
      go
    </button>
  );
}

function captureNavPath(run: (nav: ReturnType<typeof useAppNavigate>) => void) {
  seedServer();
  const view = render(
    <MemoryRouter initialEntries={["/s/acme"]}>
      <LocationProbe />
      <NavButton run={run} />
    </MemoryRouter>,
  );

  act(() => {
    fireEvent.click(view.getByText("go"));
  });

  const path = currentLocation;
  view.unmount();
  return path;
}

function resolveChatRoute(path: string): FocusTarget {
  const url = new URL(path, "https://app.test");
  const match = url.pathname.match(/^\/s\/acme\/(channel|dm)\/([^/]+)$/);
  assert.ok(match, `expected chat route, got ${path}`);
  const routeKind = match[1] as "channel" | "dm";
  const channelId = match[2];
  const messageId = url.searchParams.get("msg");
  assert.ok(messageId, `expected msg= focus anchor in ${path}`);
  const thread = url.searchParams.get("thread");
  if (thread) {
    const [parentChannelId, parentMessageId] = thread.split(":");
    assert.equal(parentChannelId, channelId);
    assert.ok(parentMessageId, `expected thread parent in ${path}`);
    return {
      kind: "thread",
      parentChannelId,
      parentMessageId,
      threadChannelId: "thread-1",
      messageId,
    };
  }
  return { kind: routeKind, channelId, messageId };
}

function resolveContentRoute(path: string): FocusTarget {
  const url = new URL(path, "https://app.test");
  assert.match(url.pathname, /^\/s\/acme\/(activity|search)$/);
  const slot = parseSearchOpenParam(url.searchParams.get("open"));
  assert.ok(slot, `expected open= content slot in ${path}`);
  const messageId = url.searchParams.get("msg");
  assert.ok(messageId, `expected msg= focus anchor in ${path}`);
  if (slot.kind === "channel" || slot.kind === "dm") {
    return { kind: slot.kind, channelId: slot.id, messageId };
  }
  assert.equal(slot.kind, "thread");
  const thread = url.searchParams.get("thread");
  assert.ok(thread, `thread content slots must preserve parent thread= in ${path}`);
  const [parentChannelId, parentMessageId] = thread.split(":");
  assert.ok(parentChannelId);
  assert.ok(parentMessageId);
  return {
    kind: "thread",
    parentChannelId,
    parentMessageId,
    threadChannelId: slot.id,
    messageId,
  };
}

function contentRoute(
  surface: "activity" | "search",
  slot: SearchContentSlot,
  messageId: string,
  thread?: { parentChannelId: string; parentMessageId: string },
) {
  const params = new URLSearchParams({
    open: formatSearchOpenParam(slot),
    msg: messageId,
  });
  if (thread) params.set("thread", `${thread.parentChannelId}:${thread.parentMessageId}`);
  return `/s/acme/${surface}?${params.toString()}`;
}

function makeMessage(id: string, seq: number, channelId = "channel-1"): Message {
  return {
    id,
    seq,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat",
    content: id,
    createdAt: new Date(2026, 6, 10, 8, 0, seq).toISOString(),
  };
}

function emitThreadPanelSocketMessage(message: Message) {
  const listeners = getSocket().listeners("message:new");
  assert.ok(listeners.length > 0, "the mounted thread panel must subscribe to message:new");
  for (const listener of listeners) listener(message);
}

function emitThreadPanelSocketUpdate(message: Message) {
  const listeners = getSocket().listeners("message:updated");
  assert.ok(listeners.length > 0, "the mounted thread panel must subscribe to message:updated");
  for (const listener of listeners) listener(message);
}

function emitMainLayoutThreadUpdate(payload: {
  parentMessageId: string;
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string;
  participantIds: string[];
  latestReply: Message;
}) {
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
  const binding = bindings.find((candidate) => candidate.event === "thread:updated");
  assert.ok(binding, "the main socket bridge must expose thread:updated");
  binding.handler(payload);
}

async function hydrateChannelWindow(target: ChannelFocusTarget, messages: Message[]) {
  const harness = createMessageWindowHarness();
  try {
    harness.enqueueContextPages({
      messages,
      hasOlder: true,
      hasNewer: true,
      targetMessageId: target.messageId,
    });
    await harness.loadMessageContext(target.channelId, target.messageId);
    return harness.snapshot(target.channelId);
  } finally {
    harness.restore();
  }
}

afterEach(() => {
  cleanup();
  currentLocation = "";
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  getSocket().close();
  resetServerFeatureFlagsForTests();
  localStorage.clear();
  useAgentStore.setState({ agents: [] });
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useMessageStore.setState({
    messages: [],
    channelMessages: {},
    currentChannelId: null,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });
  useInboxStore.setState({ items: [], loading: false, loaded: false, loadInbox: originalLoadInbox });
  useSearchContentStore.setState({ slot: null });
  useTaskStore.setState({ tasks: [], serverTasks: [], currentChannelId: null });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    summaries: {},
    followedThreads: [],
  });
});

function makeThreadInboxItem(
  overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {},
): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-1",
    parentChannelId: "channel-1",
    parentChannelName: "release",
    parentChannelType: "channel",
    parentMessagePreview: "parent body",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply body",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-1",
    latestActivityMessageId: "reply-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-07-10T00:00:01.000Z",
    lastReplyAt: "2026-07-10T00:00:01.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

test("sidebar, Activity, inbox, search, and thread entries resolve to the same channel focus window", async () => {
  const firstUnreadAfterServerRead = "m-3";
  const expectedTarget: ChannelFocusTarget = {
    kind: "channel",
    channelId: "channel-1",
    messageId: firstUnreadAfterServerRead,
  };

  const entries = [
    {
      name: "sidebar",
      target: resolveChatRoute(
        captureNavPath((nav) => nav.toMessage("channel-1", firstUnreadAfterServerRead)),
      ),
    },
    {
      name: "Activity",
      target: resolveContentRoute(
        contentRoute(
          "activity",
          { kind: "channel", id: "channel-1", messageId: firstUnreadAfterServerRead },
          firstUnreadAfterServerRead,
        ),
      ),
    },
    {
      name: "inbox",
      target: resolveChatRoute(`/s/acme/channel/channel-1?msg=${firstUnreadAfterServerRead}`),
    },
    {
      name: "search",
      target: resolveContentRoute(
        contentRoute(
          "search",
          { kind: "channel", id: "channel-1", messageId: firstUnreadAfterServerRead },
          firstUnreadAfterServerRead,
        ),
      ),
    },
    {
      name: "thread view-in-channel",
      target: resolveChatRoute(
        captureNavPath((nav) => nav.toMessage("channel-1", firstUnreadAfterServerRead)),
      ),
    },
  ];

  for (const entry of entries) {
    assert.deepEqual(entry.target, expectedTarget, `${entry.name} must preserve the server first-unread focus anchor`);
  }

  const serverWindow = [
    makeMessage("m-1", 1),
    makeMessage("m-2", 2),
    makeMessage(firstUnreadAfterServerRead, 3),
    makeMessage("m-4", 4),
  ];
  const snapshots = [];
  for (const entry of entries) {
    snapshots.push(await hydrateChannelWindow(entry.target as ChannelFocusTarget, serverWindow));
  }

  for (const snapshot of snapshots) {
    assert.deepEqual(snapshot.messageIds, ["m-1", "m-2", firstUnreadAfterServerRead, "m-4"]);
    assert.equal(snapshot.highlightedMessageId, firstUnreadAfterServerRead);
    assert.equal(snapshot.hasMore, true);
    assert.equal(snapshot.hasNewer, true);
  }
});

test("Activity/search/thread permalink entries agree on thread parent and focused reply", () => {
  const expected: ThreadFocusTarget = {
    kind: "thread",
    parentChannelId: "parent-channel-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    messageId: "reply-unread",
  };
  const thread = { parentChannelId: expected.parentChannelId, parentMessageId: expected.parentMessageId };
  const entries = [
    {
      name: "chat permalink",
      target: resolveChatRoute(captureNavPath((nav) =>
        nav.toThreadMessage(expected.parentChannelId, expected.parentMessageId, expected.messageId),
      )),
    },
    {
      name: "Activity thread slot",
      target: resolveContentRoute(
        contentRoute(
          "activity",
          { kind: "thread", id: expected.threadChannelId, messageId: expected.messageId },
          expected.messageId,
          thread,
        ),
      ),
    },
    {
      name: "search thread slot",
      target: resolveContentRoute(
        contentRoute(
          "search",
          { kind: "thread", id: expected.threadChannelId, messageId: expected.messageId },
          expected.messageId,
          thread,
        ),
      ),
    },
  ];

  for (const entry of entries) {
    assert.deepEqual(entry.target, expected, `${entry.name} must preserve the same thread parent + focused reply`);
  }
});

test("Activity cold thread slot renders from the matching Activity row without a parent thread query", async () => {
  seedServer();
  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  const parentChannelId = "channel-1";
  const threadChannelId = "thread-1";
  const parentMessageId = "parent-1";
  const replyMessageId = "reply-1";
  const parentChannel = makeChannel({ id: parentChannelId, name: "release" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  parent.content = "activity parent body";
  const reply = makeMessage(replyMessageId, 1, threadChannelId);
  reply.content = "activity cold slot reply";

  useServerStore.setState({
    sidebarOrder: makeSidebarOrder(),
    members: [],
  });
  useChannelStore.setState({
    channels: [parentChannel, makeChannel({ id: threadChannelId, name: "thread", type: "thread" })],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  const activityItem = makeThreadInboxItem({
    threadChannelId,
    parentChannelId,
    parentMessageId,
    latestActivityMessageId: replyMessageId,
  });
  const seedActivityThreadItem = () => useInboxStore.setState({
    items: [
      activityItem,
    ],
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 0,
  });
  seedActivityThreadItem();
  useInboxStore.setState({ loadInbox: async () => undefined });
  useMessageStore.setState({
    channelMessages: {
      [parentChannelId]: [parent],
      [threadChannelId]: [],
    },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });

  const getCalls: string[] = [];
  const postCalls: string[] = [];
  api.post = (async (url: string) => {
    postCalls.push(url);
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/context/${replyMessageId}`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  render(
    <MemoryRouter initialEntries={[`/s/acme/activity?open=thread%3A${threadChannelId}&msg=${replyMessageId}`]}>
      <ToastProvider>
        <ActivityThreadContentRoute
          slot={{ kind: "thread", id: threadChannelId, messageId: replyMessageId }}
          closeSlot={() => {}}
        />
      </ToastProvider>
    </MemoryRouter>,
  );

  await act(async () => {
    seedActivityThreadItem();
  });
  await screen.findByText("activity cold slot reply");
  assert.ok(
    getCalls.includes(`/messages/context/${replyMessageId}`),
    "Activity thread slots must load the focused reply after deriving identity from the Activity row",
  );
  assert.deepEqual(
    postCalls.filter((url) => url !== "/feature-flags/evaluate"),
    [`/channels/${threadChannelId}/read-all`],
    "cold Activity thread slots already know the thread channel and must not POST create-or-get on the parent",
  );
});

test("Activity thread send retires the external message focus before the reply append", async () => {
  seedServer();
  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  const parentChannelId = "channel-send";
  const threadChannelId = "thread-send";
  const parentMessageId = "parent-send";
  const replyMessageId = "reply-old";
  const parentChannel = makeChannel({ id: parentChannelId, name: "release-send" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  const reply = makeMessage(replyMessageId, 2, threadChannelId);
  reply.content = "old Activity-focused reply";
  const sentReply = makeMessage("reply-new", 3, threadChannelId);
  sentReply.content = "reply sent from Activity";

  useServerStore.setState({ sidebarOrder: makeSidebarOrder(), members: [] });
  useChannelStore.setState({
    channels: [parentChannel, makeChannel({ id: threadChannelId, name: "thread", type: "thread" })],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  useInboxStore.setState({
    items: [makeThreadInboxItem({
      threadChannelId,
      parentChannelId,
      parentMessageId,
      latestActivityMessageId: replyMessageId,
    })],
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 0,
    loadInbox: async () => undefined,
  });
  useSearchContentStore.setState({
    slot: { kind: "thread", id: threadChannelId, messageId: replyMessageId },
  });
  useMessageStore.setState({
    channelMessages: { [parentChannelId]: [parent], [threadChannelId]: [] },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });

  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/context/${replyMessageId}`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    if (url === "/v2/messages") return { data: sentReply };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  let focusReplayCount = 0;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    if (this.dataset.messageId === replyMessageId) focusReplayCount += 1;
  };

  function ActivityThreadHarness() {
    const slot = useSearchContentStore((state) => state.slot);
    assert.ok(slot?.kind === "thread");
    return <ActivityThreadContentRoute slot={slot} closeSlot={() => {}} />;
  }

  try {
    render(
      <MemoryRouter initialEntries={[`/s/acme/activity?open=thread%3A${threadChannelId}&msg=${replyMessageId}`]}>
        <ToastProvider><ActivityThreadHarness /></ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText("old Activity-focused reply");
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    focusReplayCount = 0;

    const composer = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.change(composer, { target: { value: "reply sent from Activity" } });
      fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });

    await screen.findByText("reply sent from Activity");
    await waitFor(() => assert.equal(useSearchContentStore.getState().slot?.messageId, undefined));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    assert.equal(focusReplayCount, 0, "the sent reply append must not replay the stale Activity focus");
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("Activity thread detail stays mounted after an opened unread row leaves the current filter window", async () => {
  seedServer();
  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  const parentChannelId = "channel-unread";
  const threadChannelId = "thread-unread";
  const parentMessageId = "parent-unread";
  const replyMessageId = "reply-unread";
  const parentChannel = makeChannel({ id: parentChannelId, name: "release-unread" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  parent.content = "unread activity parent body";
  const reply = makeMessage(replyMessageId, 1, threadChannelId);
  reply.content = "unread activity reply stays visible";
  const activityItem = makeThreadInboxItem({
    threadChannelId,
    parentChannelId,
    parentMessageId,
    parentChannelName: "release-unread",
    latestActivityMessageId: replyMessageId,
    firstUnreadMessageId: replyMessageId,
    unreadCount: 1,
  });

  useServerStore.setState({
    sidebarOrder: makeSidebarOrder(),
    members: [],
  });
  useChannelStore.setState({
    channels: [parentChannel, makeChannel({ id: threadChannelId, name: "thread", type: "thread" })],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  useInboxStore.setState({
    items: [activityItem],
    filter: "unread",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 1,
    loadInbox: async () => undefined,
  });
  useThreadStore.setState({
    openParentChannelId: parentChannelId,
    openParentMessageId: parentMessageId,
    openThreadChannelId: threadChannelId,
    focusedMessageId: replyMessageId,
  });
  useMessageStore.setState({
    channelMessages: {
      [parentChannelId]: [parent],
      [threadChannelId]: [],
    },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });

  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/context/${replyMessageId}`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  render(
    <MemoryRouter initialEntries={[`/s/acme/activity?thread=${parentChannelId}:${parentMessageId}&open=thread%3A${threadChannelId}&msg=${replyMessageId}`]}>
      <ToastProvider>
        <ActivityThreadContentRoute
          slot={{ kind: "thread", id: threadChannelId, messageId: replyMessageId }}
          closeSlot={() => {}}
        />
      </ToastProvider>
    </MemoryRouter>,
  );

  await screen.findByText("unread activity reply stays visible");

  await act(async () => {
    useInboxStore.setState({
      items: [],
      totalCount: 0,
      totalUnreadCount: 0,
    });
    await Promise.resolve();
  });

  assert.equal(screen.queryByText("Thread is no longer in Activity"), null);
  assert.ok(screen.getByText("unread activity reply stays visible"));
});

test("Activity thread detail does not rerender its timeline for an unrelated Activity thread reply", async () => {
  seedServer();
  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  const parentChannelId = "channel-a";
  const threadChannelId = "thread-a";
  const parentMessageId = "parent-a";
  const focusedReplyId = "reply-a-24";
  const unrelatedParentChannelId = "channel-b";
  const unrelatedThreadChannelId = "thread-b";
  const unrelatedParentMessageId = "parent-b";
  const parentChannel = makeChannel({ id: parentChannelId, name: "release-a" });
  const threadChannel = makeChannel({ id: threadChannelId, name: "thread-a", type: "thread" });
  const unrelatedParentChannel = makeChannel({ id: unrelatedParentChannelId, name: "release-b" });
  const unrelatedThreadChannel = makeChannel({ id: unrelatedThreadChannelId, name: "thread-b", type: "thread" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  parent.content = "activity thread A parent";
  const replies = Array.from({ length: 24 }, (_, index) => {
    const reply = makeMessage(`reply-a-${index + 1}`, index + 1, threadChannelId);
    reply.content = `activity thread A reply ${index + 1}`;
    return reply;
  });
  const unrelatedReply = makeMessage("reply-b-new", 25, unrelatedThreadChannelId);
  unrelatedReply.content = "activity thread B new reply";

  useServerStore.setState({
    sidebarOrder: makeSidebarOrder(),
    members: [],
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel, unrelatedParentChannel, unrelatedThreadChannel],
    dmChannels: [],
    channelActivity: {
      [parentChannelId]: null,
      [threadChannelId]: null,
      [unrelatedParentChannelId]: null,
      [unrelatedThreadChannelId]: null,
    },
  });
  useInboxStore.setState({
    items: [
      makeThreadInboxItem({
        threadChannelId,
        parentChannelId,
        parentMessageId,
        latestActivityMessageId: focusedReplyId,
        replyCount: replies.length,
      }),
      makeThreadInboxItem({
        threadChannelId: unrelatedThreadChannelId,
        parentChannelId: unrelatedParentChannelId,
        parentMessageId: unrelatedParentMessageId,
        latestActivityMessageId: "reply-b-1",
      }),
    ],
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 2,
    totalUnreadCount: 0,
    loadInbox: async () => undefined,
  });
  useMessageStore.setState({
    channelMessages: {
      [parentChannelId]: [parent],
      [threadChannelId]: [],
      [unrelatedParentChannelId]: [makeMessage(unrelatedParentMessageId, 1, unrelatedParentChannelId)],
      [unrelatedThreadChannelId]: [],
    },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });

  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/context/${focusedReplyId}`) {
      return { data: { messages: [replies[23]], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: replies, hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  let activityThreadSubtreeCommits = 0;
  render(
    <MemoryRouter initialEntries={[`/s/acme/activity?open=thread%3A${threadChannelId}&msg=${focusedReplyId}`]}>
      <ToastProvider>
        <Profiler
          id="activity-thread-detail"
          onRender={() => {
            activityThreadSubtreeCommits += 1;
          }}
        >
          <ActivityThreadContentRoute
            slot={{ kind: "thread", id: threadChannelId, messageId: focusedReplyId }}
            closeSlot={() => {}}
          />
        </Profiler>
      </ToastProvider>
    </MemoryRouter>,
  );

  await screen.findByText("activity thread A reply 24");
  await waitFor(async () => {
    const commitsBeforeFrame = activityThreadSubtreeCommits;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    assert.equal(
      activityThreadSubtreeCommits,
      commitsBeforeFrame,
      "the initial Activity thread route must settle before measuring unrelated updates",
    );
  });
  activityThreadSubtreeCommits = 0;

  await act(async () => {
    useInboxStore.getState().receiveThreadReply(unrelatedReply);
    await Promise.resolve();
  });

  assert.equal(
    activityThreadSubtreeCommits,
    0,
    "updating Activity thread B must not commit the mounted route/timeline subtree for Activity thread A",
  );
  assert.ok(screen.getByText("activity thread A reply 24"));
});

test("thread parent URL refresh keeps the left channel anchored on the parent message", async () => {
  const parentChannelId = "channel-1";
  const parentMessageId = "parent-1";
  const parentRefreshPath = `/s/acme/channel/${parentChannelId}?thread=${parentChannelId}:${parentMessageId}&msg=${parentMessageId}`;
  const target = resolveChatRoute(parentRefreshPath);

  assert.deepEqual(target, {
    kind: "thread",
    parentChannelId,
    parentMessageId,
    threadChannelId: "thread-1",
    messageId: parentMessageId,
  });
  assert.equal(
    resolveChatPanelQueryFocusMessageId(new URL(parentRefreshPath, "https://app.test").searchParams),
    parentMessageId,
    "parent-thread reload must still feed ChatPanel the parent msg= anchor",
  );
  assert.equal(
    resolveChatPanelQueryFocusMessageId(new URL("/s/acme/channel/channel-1?msg=plain-1", "https://app.test").searchParams),
    "plain-1",
    "plain channel reloads keep the normal msg= focus anchor",
  );
  assert.equal(getThreadParentMessageIdFromParam(null), null);
  assert.equal(getThreadParentMessageIdFromParam("channel-1:parent-1"), parentMessageId);
  assert.equal(getThreadParentMessageIdFromParam(":parent-1"), null);
  assert.equal(getThreadParentMessageIdFromParam("channel-1"), null);

  const replyRefreshPath = `/s/acme/channel/${parentChannelId}?thread=${parentChannelId}:${parentMessageId}&msg=reply-1`;
  assert.equal(
    resolveChatPanelQueryFocusMessageId(new URL(replyRefreshPath, "https://app.test").searchParams),
    null,
    "reply-thread reload must not make ChatPanel focus a reply id inside the parent channel list",
  );

  const serverWindow = [
    makeMessage("previous-root", 1, parentChannelId),
    makeMessage(parentMessageId, 2, parentChannelId),
    makeMessage("next-root", 3, parentChannelId),
  ];
  const snapshot = await hydrateChannelWindow({
    kind: "channel",
    channelId: parentChannelId,
    messageId: parentMessageId,
  }, serverWindow);

  assert.deepEqual(snapshot.messageIds, ["previous-root", parentMessageId, "next-root"]);
  assert.equal(snapshot.highlightedMessageId, parentMessageId);
});

test("thread parent URL refresh renders replies instead of the No replies empty state", async () => {
  const parentChannelId = "channel-1";
  const threadChannelId = "thread-1";
  const parentMessageId = "parent-1";
  const parentChannel = makeChannel({ id: parentChannelId, name: "proj-release" });
  const threadChannel = makeChannel({ id: threadChannelId, name: "thread", type: "thread" });
  const parent = makeMessage(parentMessageId, 2, parentChannelId);
  const reply = makeMessage("reply-1", 1, threadChannelId);
  reply.content = "visible reply body";

  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  seedServer();
  useServerStore.setState({
    sidebarOrder: makeSidebarOrder(),
    members: [],
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: {
      [parentChannelId]: [makeMessage("previous-root", 1, parentChannelId), parent, makeMessage("next-root", 3, parentChannelId)],
      [threadChannelId]: [],
    },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });
  useTaskStore.setState({ tasks: [], serverTasks: [], currentChannelId: threadChannelId });
  const getCalls: string[] = [];

  api.post = (async (url: string) => {
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === `/channels/${parentChannelId}/threads/${parentMessageId}`) {
      return {
        data: {
          threadChannelId,
          replyCount: 1,
          lastReplyAt: reply.createdAt,
          participantIds: ["user-1"],
          unreadCount: 0,
          firstUnreadMessageId: null,
        },
      };
    }
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  syncRightPanelStoresFromSearch(`?thread=${parentChannelId}:${parentMessageId}&msg=${parentMessageId}`);
  await waitFor(() => {
    assert.equal(useThreadStore.getState().openThreadChannelId, threadChannelId);
  });
  assert.equal(
    useThreadStore.getState().focusedMessageId,
    null,
    "parent msg= must not be treated as a focused thread reply",
  );

  render(
    <MemoryRouter initialEntries={[`/s/acme/channel/${parentChannelId}?thread=${parentChannelId}:${parentMessageId}&msg=${parentMessageId}`]}>
      <ToastProvider>
        <ThreadPanel />
      </ToastProvider>
    </MemoryRouter>,
  );

  await screen.findByText("visible reply body");
  assert.equal(screen.queryByText("No replies yet"), null);
  assert.ok(
    getCalls.includes(`/messages/channel/${threadChannelId}?limit=50`),
    "ThreadPanel must load the concrete thread channel replies instead of using parent msg= as reply context",
  );
});

test("an existing empty thread stays live and merges another actor's socket reply without creating again", async () => {
  const parentChannelId = "channel-existing";
  const threadChannelId = "thread-existing";
  const parentMessageId = "parent-existing";
  const parentChannel = makeChannel({ id: parentChannelId, name: "proj-chat" });
  const threadChannel = makeChannel({ id: threadChannelId, name: "thread", type: "thread" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  const postCalls: string[] = [];

  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  seedServer();
  useServerStore.setState({ sidebarOrder: makeSidebarOrder(), members: [] });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  useMessageStore.setState({
    channelMessages: { [parentChannelId]: [parent], [threadChannelId]: [] },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
  });
  useThreadStore.setState({
    openParentMessageId: parentMessageId,
    openThreadChannelId: threadChannelId,
    openParentChannelId: parentChannelId,
    openServerSlug: "acme",
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    summaries: {
      [parentMessageId]: {
        threadChannelId,
        replyCount: 0,
        lastReplyAt: null,
        participantIds: [],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
  });

  api.post = (async (url: string) => {
    postCalls.push(url);
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: [], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  render(
    <MemoryRouter initialEntries={[`/s/acme/channel/${parentChannelId}`]}>
      <ToastProvider>
        <ThreadPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByText("No replies yet");

  const remoteReply = {
    ...makeMessage("remote-existing-reply", 1, threadChannelId),
    senderId: "user-2",
    senderName: "Ben",
    content: "remote reply in existing empty thread",
  };
  await act(async () => {
    emitThreadPanelSocketMessage(remoteReply);
  });
  await screen.findByText("remote reply in existing empty thread");

  await act(async () => {
    emitThreadPanelSocketMessage(remoteReply);
  });
  assert.equal(screen.getAllByText("remote reply in existing empty thread").length, 1);
  assert.equal(
    postCalls.includes(`/channels/${parentChannelId}/threads`),
    false,
    "realtime use of an existing empty thread must not create a second channel",
  );
});

test("mounted ThreadPanel patches a sparse attachment-comment update without erasing or appending rows", async () => {
  const parentChannelId = "channel-comment-update";
  const threadChannelId = "thread-comment-update";
  const parentMessageId = "parent-comment-update";
  const parentChannel = makeChannel({ id: parentChannelId, name: "proj-message" });
  const threadChannel = makeChannel({ id: threadChannelId, name: "thread", type: "thread" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  const firstReply = {
    ...makeMessage("reply-before-comment", 1, threadChannelId),
    content: "reply before anchored comment",
  };
  const anchoredComment = {
    ...makeMessage("attachment-comment-loaded", 2, threadChannelId),
    content: "anchored review comment",
    // Deliberately conflicts with seq order: if the sparse update erases seq,
    // createdAt fallback moves this row after reply-after-comment.
    createdAt: "2026-07-10T08:00:59.000Z",
    commentRef: {
      attachmentId: "attachment-1",
      filename: "review.md",
      hostMessageId: parentMessageId,
      hostSource: null,
      anchorLabel: "L3",
    },
  };
  const lastReply = {
    ...makeMessage("reply-after-comment", 3, threadChannelId),
    content: "reply after anchored comment",
  };
  const replies = [firstReply, anchoredComment, lastReply];

  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  seedServer();
  setServerFeatureFlagForTests("server-1", ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY, true);
  useServerStore.setState({ sidebarOrder: makeSidebarOrder(), members: [] });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  useMessageStore.setState({
    channelMessages: { [parentChannelId]: [parent], [threadChannelId]: replies },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
  });
  useThreadStore.setState({
    openParentMessageId: parentMessageId,
    openThreadChannelId: threadChannelId,
    openParentChannelId: parentChannelId,
    openServerSlug: "acme",
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    summaries: {
      [parentMessageId]: {
        threadChannelId,
        replyCount: replies.length,
        lastReplyAt: lastReply.createdAt,
        participantIds: ["user-1"],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
  });

  api.post = (async (url: string) => {
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: replies, hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  render(
    <MemoryRouter initialEntries={[`/s/acme/channel/${parentChannelId}`]}>
      <ToastProvider>
        <ThreadPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByText("anchored review comment");
  await screen.findByText(/review\.md/);

  await act(async () => {
    emitThreadPanelSocketUpdate({
      id: anchoredComment.id,
      channelId: threadChannelId,
      commentRef: null,
    } as Message);
    emitThreadPanelSocketUpdate({
      id: "unknown-sparse-comment",
      channelId: threadChannelId,
      commentRef: null,
    } as Message);
  });

  assert.equal(screen.getAllByText("anchored review comment").length, 1);
  assert.equal(screen.getAllByText(/review\.md/).length, 1);
  assert.equal(document.getElementById("message-unknown-sparse-comment"), null);
  const firstRow = document.getElementById(`message-${firstReply.id}`);
  const commentRow = document.getElementById(`message-${anchoredComment.id}`);
  const lastRow = document.getElementById(`message-${lastReply.id}`);
  assert.ok(firstRow && commentRow && lastRow);
  assert.ok(firstRow.compareDocumentPosition(commentRow) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(commentRow.compareDocumentPosition(lastRow) & Node.DOCUMENT_POSITION_FOLLOWING);
});

test("an absent thread adopts the first remote thread update, then merges fetch, socket, and duplicate frames", async () => {
  // Production sends receiver-private thread:updated before the browser has
  // joined the newly-created thread room; the adoption-triggered HTTP load
  // closes that first-reply race, then normal room message:new owns the tail.
  const parentChannelId = "channel-absent";
  const threadChannelId = "thread-created-remotely";
  const parentMessageId = "parent-absent";
  const parentChannel = makeChannel({ id: parentChannelId, name: "proj-chat" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  const firstReply = {
    ...makeMessage("remote-first-reply", 1, threadChannelId),
    senderId: "user-2",
    senderName: "Ben",
    content: "remote first reply creates the thread",
  };
  const secondReply = {
    ...makeMessage("remote-second-reply", 2, threadChannelId),
    senderId: "user-3",
    senderName: "Cal",
    content: "remote second reply stays realtime",
  };
  let persistedReplies: Message[] = [];
  const postCalls: string[] = [];

  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  seedServer();
  useServerStore.setState({ sidebarOrder: makeSidebarOrder(), members: [] });
  useChannelStore.setState({
    channels: [parentChannel],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null },
  });
  useMessageStore.setState({
    channelMessages: { [parentChannelId]: [parent] },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    currentUserId: "user-1",
  });
  useThreadStore.setState({
    summaries: {},
    replyScopes: {},
    followedThreads: [],
    openThreadError: null,
    openThreadLoading: false,
  });

  api.post = (async (url: string) => {
    postCalls.push(url);
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === `/channels/${parentChannelId}/threads/${parentMessageId}`) {
      throw Object.assign(new Error("thread not found"), { response: { status: 404 } });
    }
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      return { data: { messages: persistedReplies, hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    if (url === "/channels/threads/followed") return { data: { threads: [] } };
    return { data: {} };
  }) as typeof api.get;

  await useThreadStore.getState().openThread({
    serverSlug: "acme",
    parentChannelId,
    parentMessageId,
  });
  assert.equal(useThreadStore.getState().openThreadChannelId, null);

  render(
    <MemoryRouter initialEntries={[`/s/acme/channel/${parentChannelId}`]}>
      <ToastProvider>
        <ThreadPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByText("No replies yet");

  persistedReplies = [firstReply];
  await act(async () => {
    emitMainLayoutThreadUpdate({
      parentMessageId,
      threadChannelId,
      replyCount: 1,
      lastReplyAt: firstReply.createdAt,
      participantIds: ["user-2"],
      latestReply: firstReply,
    });
  });
  await screen.findByText("remote first reply creates the thread");
  assert.equal(useThreadStore.getState().openThreadChannelId, threadChannelId);

  persistedReplies = [firstReply, secondReply];
  await act(async () => {
    emitMainLayoutThreadUpdate({
      parentMessageId,
      threadChannelId,
      replyCount: 2,
      lastReplyAt: secondReply.createdAt,
      participantIds: ["user-2", "user-3"],
      latestReply: secondReply,
    });
    emitThreadPanelSocketMessage(secondReply);
    emitMainLayoutThreadUpdate({
      parentMessageId,
      threadChannelId,
      replyCount: 2,
      lastReplyAt: secondReply.createdAt,
      participantIds: ["user-2", "user-3"],
      latestReply: secondReply,
    });
    emitThreadPanelSocketMessage(secondReply);
  });
  await screen.findByText("remote second reply stays realtime");

  assert.equal(screen.getAllByText("remote first reply creates the thread").length, 1);
  assert.equal(screen.getAllByText("remote second reply stays realtime").length, 1);
  assert.equal(useThreadStore.getState().summaries[parentMessageId]?.replyCount, 2);
  assert.equal(
    postCalls.includes(`/channels/${parentChannelId}/threads`),
    false,
    "a remote first reply must be adopted from thread:updated without a competing local create",
  );
});

type ThreadFallbackFixtureOptions = {
  focusMessageId?: string | null;
  loadFocusedContext?: () => Promise<{ data: unknown }>;
  loadLatestThread?: () => Promise<{ data: unknown }>;
  loadOtherRequest?: (url: string) => Promise<{ data: unknown }> | null;
};

async function renderThreadFallbackFixture(options: ThreadFallbackFixtureOptions = {}) {
  const parentChannelId = "channel-1";
  const threadChannelId = "thread-1";
  const parentMessageId = "parent-1";
  const unrelatedMessageId = "unrelated-parent-message";
  const focusMessageId = options.focusMessageId === undefined
    ? unrelatedMessageId
    : options.focusMessageId;
  const parentChannel = makeChannel({ id: parentChannelId, name: "proj-release" });
  const threadChannel = makeChannel({ id: threadChannelId, name: "thread", type: "thread" });
  const parent = makeMessage(parentMessageId, 1, parentChannelId);
  const unrelated = makeMessage(unrelatedMessageId, 2, parentChannelId);
  unrelated.content = "unrelated parent channel body";
  const reply = makeMessage("reply-1", 1, threadChannelId);
  reply.content = "visible scoped thread reply";

  useAuthStore.setState({ user: makeUser(), initialized: true, loading: false });
  seedServer();
  useServerStore.setState({
    sidebarOrder: makeSidebarOrder(),
    members: [],
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannelId]: null, [threadChannelId]: null },
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: {
      [parentChannelId]: [parent, unrelated],
      [threadChannelId]: [],
    },
    currentChannelId: parentChannelId,
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
  });
  useTaskStore.setState({ tasks: [], serverTasks: [], currentChannelId: threadChannelId });
  const getCalls: string[] = [];
  let rejectedContextScope: string | undefined;

  api.post = (async (url: string) => {
    if (url === `/channels/${threadChannelId}/read-all`) return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  api.get = (async (url: string, config?: { params?: { channelId?: string } }) => {
    getCalls.push(url);
    const customResponse = options.loadOtherRequest?.(url);
    if (customResponse) return customResponse;
    if (url === `/channels/${parentChannelId}/threads/${parentMessageId}`) {
      return {
        data: {
          threadChannelId,
          replyCount: 1,
          lastReplyAt: reply.createdAt,
          participantIds: ["user-1"],
          unreadCount: 0,
          firstUnreadMessageId: null,
        },
      };
    }
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === `/messages/context/${unrelatedMessageId}`) {
      rejectedContextScope = config?.params?.channelId;
      if (options.loadFocusedContext) return options.loadFocusedContext();
      throw Object.assign(new Error("scoped context not found"), { response: { status: 404 } });
    }
    if (url === `/messages/channel/${threadChannelId}?limit=50`) {
      if (options.loadLatestThread) return options.loadLatestThread();
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url === `/messages/context/${parentMessageId}`) {
      return { data: { messages: [parent], hasOlder: false, hasNewer: false } };
    }
    if (url === `/tasks/channel/${parentChannelId}`) return { data: { tasks: [] } };
    if (url === `/channels/${parentChannelId}/members`) return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  const params = new URLSearchParams({ thread: `${parentChannelId}:${parentMessageId}` });
  if (focusMessageId) params.set("msg", focusMessageId);
  syncRightPanelStoresFromSearch(`?${params.toString()}`);
  await waitFor(() => {
    assert.equal(useThreadStore.getState().openThreadChannelId, threadChannelId);
  });
  assert.equal(useThreadStore.getState().focusedMessageId, focusMessageId);

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <MemoryRouter initialEntries={[
        `/s/acme/channel/${parentChannelId}?${params.toString()}`,
      ]}>
        <ToastProvider>
          <ThreadPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    getCalls,
    parentChannelId,
    rejectedContextScope: () => rejectedContextScope,
    threadChannelId,
    unrelatedMessageId,
    view,
  };
}

test("thread focus outside the scoped thread falls back to replies without merging parent-channel messages", async () => {
  const fixture = await renderThreadFallbackFixture();

  await screen.findByText("visible scoped thread reply");
  assert.equal(fixture.rejectedContextScope(), fixture.threadChannelId);
  assert.ok(fixture.getCalls.includes(`/messages/channel/${fixture.threadChannelId}?limit=50`));
  assert.equal(screen.queryByText("unrelated parent channel body"), null);
  assert.equal(screen.queryByText("No replies yet"), null);
});

test("thread focus fallback failure leaves an empty state instead of a permanent spinner", async () => {
  await renderThreadFallbackFixture({
    loadLatestThread: async () => {
      throw new Error("latest thread unavailable");
    },
  });

  await screen.findByText("No replies yet");
  assert.equal(screen.queryByText("Loading…"), null);
});

test("thread load without a focus does not retry the same channel request after rejection", async () => {
  const fixture = await renderThreadFallbackFixture({
    focusMessageId: null,
    loadLatestThread: async () => {
      throw new Error("thread unavailable");
    },
  });

  await screen.findByText("No replies yet");
  assert.equal(
    fixture.getCalls.filter((url) => url === `/messages/channel/${fixture.threadChannelId}?limit=50`).length,
    1,
  );
});

test("late focused-context rejection after unmount does not start a fallback request", async () => {
  let rejectFocusedContext!: (error: Error) => void;
  const focusedContext = new Promise<{ data: unknown }>((_resolve, reject) => {
    rejectFocusedContext = reject;
  });
  const fixture = await renderThreadFallbackFixture({
    loadFocusedContext: () => focusedContext,
  });

  await waitFor(() => {
    assert.equal(
      fixture.getCalls.filter((url) => url === `/messages/context/${fixture.unrelatedMessageId}`).length,
      1,
    );
  });
  fixture.view.unmount();
  await act(async () => {
    rejectFocusedContext(new Error("late scoped context failure"));
    await Promise.resolve();
  });

  assert.equal(
    fixture.getCalls.filter((url) => url === `/messages/channel/${fixture.threadChannelId}?limit=50`).length,
    0,
  );
});

test("late fallback failure from the previous thread does not clear the next thread loading state", async () => {
  let rejectOldFallback!: (error: Error) => void;
  let resolveNextThread!: (value: { data: unknown }) => void;
  const oldFallback = new Promise<{ data: unknown }>((_resolve, reject) => {
    rejectOldFallback = reject;
  });
  const nextThreadLoad = new Promise<{ data: unknown }>((resolve) => {
    resolveNextThread = resolve;
  });
  const nextThreadChannelId = "thread-2";
  const fixture = await renderThreadFallbackFixture({
    loadLatestThread: () => oldFallback,
    loadOtherRequest: (url) => (
      url === `/messages/channel/${nextThreadChannelId}?limit=50`
        ? nextThreadLoad
        : null
    ),
  });

  await waitFor(() => {
    assert.equal(
      fixture.getCalls.filter((url) => url === `/messages/channel/${fixture.threadChannelId}?limit=50`).length,
      1,
    );
  });
  act(() => {
    useChannelStore.setState((state) => ({
      channels: [...state.channels, makeChannel({ id: nextThreadChannelId, name: "next-thread", type: "thread" })],
    }));
    useThreadStore.setState({
      openParentChannelId: fixture.parentChannelId,
      openParentMessageId: "parent-2",
      openThreadChannelId: nextThreadChannelId,
      focusedMessageId: null,
    });
  });
  await waitFor(() => {
    assert.equal(
      fixture.getCalls.filter((url) => url === `/messages/channel/${nextThreadChannelId}?limit=50`).length,
      1,
    );
  });
  assert.ok(screen.getByText("Loading…"));

  await act(async () => {
    rejectOldFallback(new Error("old thread fallback failed late"));
    await Promise.resolve();
  });
  assert.ok(screen.getByText("Loading…"));

  await act(async () => {
    resolveNextThread({ data: { messages: [], hasOlder: false, hasNewer: false } });
    await nextThreadLoad;
  });
});
