import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { getSocket } from "../src/api/socket";
import ChatPanel from "../src/components/message/ChatPanel";
import ThreadPanel, {
  getThreadPanelSelectedSearchText,
  scrollThreadTimelineToTop,
} from "../src/components/message/ThreadPanel";
import {
  WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT,
  requestWorkspaceGridThreadScrollToTopFromTarget,
  subscribeWorkspaceGridThreadScrollToTop,
} from "../src/components/workspace/workspaceGridOpenEvents";
import type {
  WorkspaceGridScrollThreadToTopEventDetail,
} from "../src/components/workspace/workspaceGridOpenEvents";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";
import type { FollowedThread } from "../src/store/threadStore";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalUpdateTaskStatus = useTaskStore.getState().updateTaskStatus;

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
    id: "parent-channel",
    serverId: "server-thread-search",
    name: "parent",
    description: null,
    type: "channel",
    createdAt: "2026-07-03T00:00:00.000Z",
    joined: true,
    activityMuteSupported: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    channelId: "parent-channel",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat",
    content: "message body",
    createdAt: "2026-07-03T00:00:00.000Z",
    seq: 1,
    ...overrides,
  };
}

function setSelectionText(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  assert.ok(selection);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderThreadSearchPanel(opts: {
  parentChannel?: Partial<Channel>;
  parentTask?: Task | null;
  followedThreads?: FollowedThread[];
  openParentChannelId?: string | null;
  presentation?: "side" | "modal" | "mobile-modal";
  hasReplies?: boolean;
  scrollToTopRequest?: number;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  hydrateMentionMember?: boolean;
  parentMessage?: Partial<Message>;
  replyMessage?: Partial<Message>;
  updateTaskStatus?: typeof originalUpdateTaskStatus;
  absentThread?: boolean;
  taskMetadata?: {
    messageId: string;
    taskNumber: number;
    status: Task["status"];
    claimedByName: string | null;
  };
  boundedSearchRequests?: string[];
} = {}) {
  const parentChannel = makeChannel(opts.parentChannel);
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  const parent = makeMessage({
    id: "parent-message",
    channelId: parentChannel.id,
    content: "parent context",
    threadId: opts.absentThread ? null : threadChannel.id,
    ...opts.parentMessage,
  });
  const reply = makeMessage({
    id: "reply-message",
    channelId: threadChannel.id,
    content: "selected\nthread text",
    createdAt: "2026-07-03T00:00:01.000Z",
    seq: 2,
    ...opts.replyMessage,
  });
  const replies = opts.hasReplies === false
    ? []
    : opts.boundedSearchRequests
      ? Array.from({ length: 50 }, (_, index) => makeMessage({
          id: `visible-reply-${index + 1}`,
          channelId: threadChannel.id,
          content: `visible reply ${index + 1}`,
          createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, index + 1)).toISOString(),
          seq: 101 + index,
        }))
      : [reply];
  const boundedSearchTarget = makeMessage({
    id: "bounded-search-target",
    channelId: threadChannel.id,
    content: "hidden bounded needle",
    createdAt: "2026-07-03T00:00:00.050Z",
    seq: 50,
  });
  const boundedContextMessages = [
    makeMessage({
      id: "bounded-context-older",
      channelId: threadChannel.id,
      content: "bounded context older",
      createdAt: "2026-07-03T00:00:00.049Z",
      seq: 49,
    }),
    boundedSearchTarget,
    makeMessage({
      id: "bounded-context-newer",
      channelId: threadChannel.id,
      content: "bounded context newer",
      createdAt: "2026-07-03T00:00:00.051Z",
      seq: 51,
    }),
  ];

  useAuthStore.setState({ user: makeUser(), initialized: true });
  useServerStore.setState({
    current: {
      id: "server-thread-search",
      name: "Thread Search Server",
      avatarUrl: null,
      slug: "thread-search",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-03T00:00:00.000Z",
    },
    billing: null,
    members: opts.hydrateMentionMember
      ? [{
          userId: "user-1",
          email: "ada@example.com",
          gravatarHash: "",
          name: "ada",
          displayName: "Ada",
          description: null,
          avatarUrl: null,
          role: "member",
        }]
      : [],
    sidebarOrder: null,
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: opts.absentThread
      ? [parentChannel]
      : parentChannel.type === "dm" ? [threadChannel] : [parentChannel, threadChannel],
    dmChannels: parentChannel.type === "dm" ? [parentChannel] : [],
    channelActivity: { [parentChannel.id]: null, [threadChannel.id]: null },
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: {
      [parentChannel.id]: [parent],
      [threadChannel.id]: replies,
    },
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
    loadMessages: async () => {},
    loadMessageContext: async () => {},
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });
  useThreadStore.setState({
    openParentMessageId: parent.id,
    openParentChannelId: opts.openParentChannelId === undefined ? parentChannel.id : opts.openParentChannelId,
    openThreadChannelId: opts.absentThread ? null : threadChannel.id,
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    summaries: opts.absentThread ? {} : {
      [parent.id]: {
        threadChannelId: threadChannel.id,
        replyCount: replies.length,
        lastReplyAt: reply.createdAt,
        participantIds: [],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
    followedThreads: opts.followedThreads ?? [],
    taskUpdatesByMessageId: {},
  });
  useTaskStore.setState({
    tasks: [],
    serverTasks: [],
    currentChannelId: threadChannel.id,
    tasksByChannelId: {},
    taskMetadataByMessageId: opts.taskMetadata
      ? { [opts.taskMetadata.messageId]: opts.taskMetadata }
      : {},
    taskMessageIdByTaskId: {},
    updateTaskStatus: opts.updateTaskStatus ?? originalUpdateTaskStatus,
  });

  api.get = (async (url: string) => {
    if (opts.boundedSearchRequests) opts.boundedSearchRequests.push(url);
    if (url === `/messages/context/${parent.id}`) {
      return { data: { messages: [parent] } };
    }
    if (opts.boundedSearchRequests && url === `/messages/context/${boundedSearchTarget.id}`) {
      return {
        data: {
          messages: boundedContextMessages,
          hasOlder: true,
          hasNewer: true,
        },
      };
    }
    if (url === `/tasks/channel/${parentChannel.id}`) {
      return { data: { tasks: opts.parentTask ? [opts.parentTask] : [] } };
    }
    if (url.startsWith(`/messages/channel/${threadChannel.id}`)) {
      if (opts.boundedSearchRequests && url.includes("limit=100") && url.includes("before=")) {
        return { data: { messages: [boundedSearchTarget] } };
      }
      if (opts.boundedSearchRequests && (url.includes("before=") || url.includes("after="))) {
        return { data: { messages: [] } };
      }
      return { data: { messages: replies, hasOlder: false, hasNewer: false } };
    }
    return { data: {} };
  }) as typeof api.get;

  return render(
    <MemoryRouter>
      <ThreadPanel
        presentation={opts.presentation}
        scrollToTopRequest={opts.scrollToTopRequest}
        onOpenProfile={opts.onOpenProfile}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  getSocket().close();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  localStorage.clear();
  sessionStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useThreadStore.setState({
    openParentMessageId: null,
    openParentChannelId: null,
    openThreadChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    summaries: {},
    followedThreads: [],
    taskUpdatesByMessageId: {},
  });
});

test("thread parent menu follows the existing thread while reply-thread actions stay hidden", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  renderThreadSearchPanel();
  const panelGet = api.get;
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: {} } as never;
  }) as typeof api.post;
  api.get = (async (url: string, config?: unknown) => {
    if (url === "/channels/threads/followed") {
      return {
        data: {
          threads: [{
            threadChannelId: "thread-channel",
            parentMessageId: "parent-message",
            parentChannelId: "parent-channel",
            parentChannelName: "parent",
            parentChannelType: "channel",
            parentMessagePreview: "parent context",
            parentMessageSenderType: "user",
            parentMessageSenderId: "user-1",
            latestActivitySeq: null,
            replyCount: 1,
            lastReplyAt: "2026-07-03T00:00:01.000Z",
            unreadCount: 0,
            taskNumber: null,
            taskStatus: null,
            taskClaimedByName: null,
          }],
        },
      } as never;
    }
    return panelGet(url, config as never);
  }) as typeof api.get;

  const parent = await screen.findByTestId("thread-panel-parent");
  const parentMessage = parent.querySelector('[data-message-id="parent-message"]');
  assert.ok(parentMessage);
  fireEvent.contextMenu(parentMessage, { clientX: 24, clientY: 24 });

  assert.ok(await screen.findByText("Follow Thread"));
  assert.equal(screen.queryByText("Open Thread"), null);
  assert.equal(screen.queryByText("Reply in thread"), null);

  fireEvent.click(screen.getByText("Follow Thread"));
  await waitFor(() => {
    assert.deepEqual(posts, [{
      url: "/channels/threads/follow",
      body: { parentMessageId: "parent-message" },
    }]);
    assert.equal(useThreadStore.getState().followedThreads[0]?.threadChannelId, "thread-channel");
  });

  fireEvent.contextMenu(parentMessage, { clientX: 24, clientY: 24 });
  assert.ok(await screen.findByText("Unfollow Thread"));
  assert.equal(screen.queryByText("Open Thread"), null);
});

test("thread selected-text reader only accepts selection ranges inside the panel", () => {
  const root = document.createElement("section");
  const inside = document.createElement("span");
  inside.textContent = " selected\n thread\ttext ";
  const outside = document.createElement("span");
  outside.textContent = "outside text";
  root.append(inside);
  document.body.append(root, outside);

  setSelectionText(inside);
  assert.equal(getThreadPanelSelectedSearchText(root), "selected thread text");
  assert.equal(getThreadPanelSelectedSearchText(null), "");

  setSelectionText(outside);
  assert.equal(getThreadPanelSelectedSearchText(root), "");

  const originalGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", { configurable: true, value: undefined });
  assert.equal(getThreadPanelSelectedSearchText(root), "");
  Object.defineProperty(window, "getSelection", { configurable: true, value: () => null });
  assert.equal(getThreadPanelSelectedSearchText(root), "");
  Object.defineProperty(window, "getSelection", { configurable: true, value: originalGetSelection });

  window.getSelection()?.removeAllRanges();
  assert.equal(getThreadPanelSelectedSearchText(root), "");

  root.remove();
  outside.remove();
});

test("thread scroll-to-top intent tolerates a missing timeline", () => {
  assert.doesNotThrow(() => scrollThreadTimelineToTop(null));

  let callCount = 0;
  scrollThreadTimelineToTop({ scrollToTop: () => { callCount += 1; } });
  assert.equal(callCount, 1);
});

test("workspace tab double-click commands are scoped to thread tab hitboxes", () => {
  const tabButton = document.createElement("div");
  tabButton.className = "flexlayout__tab_button";
  const paddingTarget = document.createElement("span");
  const marker = document.createElement("span");
  marker.dataset.workspaceThreadTab = "true";
  marker.dataset.workspaceThreadChannelId = "channel-a";
  marker.dataset.workspaceThreadRootId = "root-a";
  marker.dataset.workspaceThreadChannelIdResolved = "thread-a";
  tabButton.append(paddingTarget, marker);
  document.body.append(tabButton);

  const requests: WorkspaceGridScrollThreadToTopEventDetail[] = [];
  const onRequest = (event: Event) => {
    requests.push((event as CustomEvent<WorkspaceGridScrollThreadToTopEventDetail>).detail);
  };
  window.addEventListener(WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT, onRequest);
  let matchingRequests = 0;
  let otherRequests = 0;
  const unsubscribeMatching = subscribeWorkspaceGridThreadScrollToTop(
    { kind: "thread", channelId: "channel-a", threadRootId: "root-a", threadChannelId: "thread-a" },
    () => { matchingRequests += 1; },
  );
  const unsubscribeOther = subscribeWorkspaceGridThreadScrollToTop(
    { kind: "thread", channelId: "channel-b", threadRootId: "root-b" },
    () => { otherRequests += 1; },
  );

  try {
    assert.equal(requestWorkspaceGridThreadScrollToTopFromTarget(paddingTarget), true);
    assert.deepEqual(requests, [{
      ref: {
        kind: "thread",
        channelId: "channel-a",
        threadRootId: "root-a",
        threadChannelId: "thread-a",
      },
    }]);
    assert.equal(matchingRequests, 1);
    assert.equal(otherRequests, 0);

    marker.remove();
    assert.equal(requestWorkspaceGridThreadScrollToTopFromTarget(paddingTarget), false);
    assert.equal(requestWorkspaceGridThreadScrollToTopFromTarget(document.body), false);
    assert.equal(requests.length, 1, "channel, DM, and panel content targets emit no thread command");
  } finally {
    unsubscribeMatching();
    unsubscribeOther();
    window.removeEventListener(WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT, onRequest);
    tabButton.remove();
  }
});

test("thread search header button opens with an empty query when no text is selected", async () => {
  renderThreadSearchPanel();

  fireEvent.click(await screen.findByTestId("thread-search-open"));

  const input = await screen.findByTestId("thread-search-input") as HTMLInputElement;
  await waitFor(() => {
    assert.equal(input.value, "");
  });
});

test("a bounded thread-search context blocks both history sentinels until a new user gesture", async () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const originalCss = globalThis.CSS;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  let intersectionCallback: IntersectionObserverCallback | null = null;
  const observedTargets: Element[] = [];
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) {
      intersectionCallback = callback;
    }
    observe(target: Element) { observedTargets.push(target); }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = "0px";
    thresholds = [0];
  } as typeof IntersectionObserver;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute("data-testid") === "thread-message-scroller") {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
    }
    return { top: 5000, bottom: 5001, left: 0, right: 500, width: 500, height: 1, x: 0, y: 5000, toJSON() {} };
  };
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { ...originalCss, escape: (value: string) => value },
  });
  HTMLElement.prototype.scrollIntoView = () => {};
  const requests: string[] = [];

  try {
    renderThreadSearchPanel({ boundedSearchRequests: requests });
    fireEvent.click(await screen.findByTestId("thread-search-open"));
    fireEvent.change(await screen.findByTestId("thread-search-input"), {
      target: { value: "hidden bounded needle" },
    });

    await waitFor(() => {
      assert.ok(
        requests.includes("/messages/context/bounded-search-target"),
        `the hidden search match must load its bounded context; requests=${requests.join(",")}`,
      );
      assert.ok(
        document.getElementById("message-bounded-search-target"),
        "the bounded target must be committed into the mounted timeline",
      );
      assert.equal(observedTargets.length, 2, "the mounted timeline observes both history sentinels");
      assert.ok(intersectionCallback);
    });

    requests.length = 0;
    await act(async () => {
      intersectionCallback?.(
        observedTargets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
      await Promise.resolve();
    });

    assert.deepEqual(
      requests.filter((url) => url.includes("/messages/channel/thread-channel") && (url.includes("before=") || url.includes("after="))),
      [],
      "a search-context commit must not immediately escape through either visible sentinel",
    );
  } finally {
    globalThis.IntersectionObserver = originalIntersectionObserver;
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: originalCss });
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("appending a thread reply does not reapply the active search-match scroll", async () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  const originalCss = globalThis.CSS;
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { ...originalCss, escape: (value: string) => value },
  });
  const searchScrolls: string[] = [];
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    const messageId = this.getAttribute("data-message-id");
    if (messageId) searchScrolls.push(messageId);
  };
  HTMLElement.prototype.scrollTo = function scrollTo() {};

  try {
    renderThreadSearchPanel();

    fireEvent.click(await screen.findByTestId("thread-search-open"));
    fireEvent.change(await screen.findByTestId("thread-search-input"), {
      target: { value: "selected" },
    });

    await waitFor(() => {
      assert.ok(searchScrolls.includes("reply-message"));
    });
    const searchScrollCountBeforeAppend = searchScrolls.length;

    act(() => {
      useMessageStore.setState((state) => ({
        channelMessages: {
          ...state.channelMessages,
          "thread-channel": [
            ...(state.channelMessages["thread-channel"] ?? []),
            makeMessage({
              id: "new-reply-message",
              channelId: "thread-channel",
              content: "new reply after search",
              createdAt: "2026-07-03T00:00:02.000Z",
              seq: 3,
            }),
          ],
        },
      }));
    });

    await screen.findByText("new reply after search");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    assert.equal(
      searchScrolls.length,
      searchScrollCountBeforeAppend,
      "a message append must not replay the previous search-hit jump over follow-latest",
    );
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    HTMLElement.prototype.scrollTo = originalScrollTo;
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: originalCss });
  }
});

test("closing thread search removes the active result and text highlights", async () => {
  const originalCss = globalThis.CSS;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { ...originalCss, escape: (value: string) => value },
  });
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  try {
    renderThreadSearchPanel();

    fireEvent.click(await screen.findByTestId("thread-search-open"));
    fireEvent.change(await screen.findByTestId("thread-search-input"), {
      target: { value: "selected" },
    });

    const matchedMessage = document.getElementById("message-reply-message");
    assert.ok(matchedMessage);
    await waitFor(() => {
      assert.ok(matchedMessage.className.includes("bg-brutal-cyan/25"));
      assert.ok(matchedMessage.querySelector("mark"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Close thread search" }));

    await waitFor(() => {
      assert.equal(screen.queryByTestId("thread-search-bar"), null);
      assert.equal(matchedMessage.className.includes("bg-brutal-cyan/25"), false);
      assert.equal(matchedMessage.querySelector("mark"), null);
    });
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: originalCss });
  }
});

test("thread search highlights a match rendered inside inline code", async () => {
  const originalCss = globalThis.CSS;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { ...originalCss, escape: (value: string) => value },
  });
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  try {
    renderThreadSearchPanel({
      replyMessage: { content: "Flag `read_receipts_v0` is enabled" },
    });

    fireEvent.click(await screen.findByTestId("thread-search-open"));
    fireEvent.change(await screen.findByTestId("thread-search-input"), {
      target: { value: "read_receipts_v0" },
    });

    const matchedMessage = document.getElementById("message-reply-message");
    assert.ok(matchedMessage);
    await waitFor(() => {
      const inlineCode = matchedMessage.querySelector("code");
      assert.ok(inlineCode);
      const highlight = inlineCode.querySelector(
        "[data-testid='thread-search-fragment-highlight']",
      );
      assert.equal(highlight?.textContent, "read_receipts_v0");
      assert.equal(highlight?.classList.contains("bg-soft-signal/70"), true);
    });
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: originalCss });
  }
});

test("thread title area scrolls to the parent message without changing channel surfaces", async () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  let scrolledElement: HTMLElement | null = null;
  let scrollOptions: ScrollToOptions | undefined;
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, _y?: number) {
    scrolledElement = this;
    scrollOptions = typeof options === "object" ? options : undefined;
  };

  try {
    for (const presentation of ["side", "modal", "mobile-modal"] as const) {
      scrolledElement = null;
      scrollOptions = undefined;
      const view = renderThreadSearchPanel({ presentation });
      const parent = await screen.findByTestId("thread-panel-parent");
      assert.equal(parent.getAttribute("data-timeline-message-id"), "parent-message");

      fireEvent.click(screen.getByTestId("thread-scroll-to-top"));

      await waitFor(() => {
        assert.equal(scrolledElement?.getAttribute("data-testid"), "thread-message-scroller");
        assert.deepEqual(scrollOptions, { top: 0, behavior: "smooth" });
      });
      view.unmount();
    }
  } finally {
    HTMLElement.prototype.scrollTo = originalScrollTo;
  }
});

test("an empty thread title click is a safe no-op before a timeline exists", async () => {
  renderThreadSearchPanel({ presentation: "mobile-modal", hasReplies: false });

  await screen.findByText("No replies yet");
  assert.doesNotThrow(() => {
    fireEvent.click(screen.getByTestId("thread-scroll-to-top"));
  });
});

test("a resolved absent thread renders empty and replyable without a durable channel", async () => {
  renderThreadSearchPanel({ absentThread: true, hasReplies: false });

  await screen.findByText("No replies yet");
  assert.equal(screen.queryByText("Loading…"), null);
  assert.ok(screen.getByPlaceholderText("Message thread"));
  assert.equal(useThreadStore.getState().openThreadChannelId, null);
});

test("an external workspace request reuses the thread timeline scroll-to-top behavior", async () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  let scrolledElement: HTMLElement | null = null;
  let scrollOptions: ScrollToOptions | undefined;
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, _y?: number) {
    scrolledElement = this;
    scrollOptions = typeof options === "object" ? options : undefined;
  };

  try {
    const view = renderThreadSearchPanel({ presentation: "side", scrollToTopRequest: 0 });
    await screen.findByTestId("thread-panel-parent");

    view.rerender(
      <MemoryRouter>
        <ThreadPanel presentation="side" scrollToTopRequest={1} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      assert.equal(scrolledElement?.getAttribute("data-testid"), "thread-message-scroller");
    });
    assert.deepEqual(scrollOptions, { top: 0, behavior: "smooth" });
  } finally {
    HTMLElement.prototype.scrollTo = originalScrollTo;
  }
});

test("thread sender avatars delegate profile navigation to their workspace host", async () => {
  const opened: Array<{ kind: "agent" | "human"; id: string }> = [];
  renderThreadSearchPanel({
    onOpenProfile: (kind, id) => opened.push({ kind, id }),
  });
  await screen.findByTestId("thread-panel-parent");

  fireEvent.click(screen.getByTestId("thread-parent-avatar"));
  assert.deepEqual(opened, [{ kind: "human", id: "user-1" }]);
});

test("thread body mentions delegate profile navigation to their workspace host", async () => {
  const opened: Array<{ kind: "agent" | "human"; id: string }> = [];
  renderThreadSearchPanel({
    parentMessage: {
      content: "ask @ada",
      mentions: [{ type: "user", id: "user-1", name: "ada" }],
    },
    hydrateMentionMember: true,
    onOpenProfile: (kind, id) => opened.push({ kind, id }),
  });

  await waitFor(() => {
    const threadMentionLink = screen.getByText("@Ada").closest("a");
    assert.ok(threadMentionLink);
    fireEvent.click(threadMentionLink);
    assert.deepEqual(opened, [{ kind: "human", id: "user-1" }]);
  });
});

test("conversation sender avatars delegate profile navigation to their workspace host", async () => {
  const seeded = renderThreadSearchPanel();
  seeded.unmount();
  const opened: Array<{ kind: "agent" | "human"; id: string }> = [];
  useServerStore.setState({
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });

  render(
    <MemoryRouter>
      <ChatPanel
        channel={makeChannel()}
        readOnly
        onOpenProfile={(kind, id) => opened.push({ kind, id })}
      />
    </MemoryRouter>,
  );
  await screen.findByText("parent context");
  const avatar = document.querySelector<HTMLButtonElement>('[data-avatar-kind="human"]');
  assert.ok(avatar);

  fireEvent.click(avatar);
  assert.deepEqual(opened, [{ kind: "human", id: "user-1" }]);
});

test("conversation body mentions delegate profile navigation to their workspace host", async () => {
  const seeded = renderThreadSearchPanel({
    parentMessage: {
      content: "ask @ada",
      mentions: [{ type: "user", id: "user-1", name: "ada" }],
    },
    hydrateMentionMember: true,
  });
  seeded.unmount();
  const opened: Array<{ kind: "agent" | "human"; id: string }> = [];
  useServerStore.setState({
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });

  render(
    <MemoryRouter>
      <ChatPanel
        channel={makeChannel()}
        readOnly
        onOpenProfile={(kind, id) => opened.push({ kind, id })}
      />
    </MemoryRouter>,
  );

  await waitFor(() => {
    const conversationMentionLink = screen.getByText("@Ada").closest("a");
    assert.ok(conversationMentionLink);
    fireEvent.click(conversationMentionLink);
    assert.deepEqual(opened, [{ kind: "human", id: "user-1" }]);
  });
});

test("thread panel joins the parent DM socket room for realtime parent task updates", async () => {
  const socket = getSocket();
  const originalEmit = socket.emit;
  const originalOn = socket.on;
  const originalOff = socket.off;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const onCalls: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  const offCalls: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  socket.emit = ((event: string, payload: unknown) => {
    emitted.push({ event, payload });
    return socket;
  }) as typeof socket.emit;
  socket.on = ((event: string, handler: (...args: any[]) => void) => {
    onCalls.push({ event, handler });
    return socket;
  }) as typeof socket.on;
  socket.off = ((event: string, handler: (...args: any[]) => void) => {
    offCalls.push({ event, handler });
    return socket;
  }) as typeof socket.off;

  try {
    const view = renderThreadSearchPanel({
      parentChannel: {
        id: "dm-parent-channel",
        name: "Ada DM",
        type: "dm",
      },
    });

    await waitFor(() => {
      assert.ok(
        emitted.some((entry) => entry.event === "join:channel" && entry.payload === "dm-parent-channel"),
        "opening a DM thread must subscribe to the parent DM room so parent-task task:updated events are delivered",
      );
    });
    emitted.length = 0;
    let parentReconnectHandler: ((...args: any[]) => void) | null = null;
    for (const entry of onCalls.filter((call) => call.event === "connect")) {
      entry.handler();
      if (emitted.some((emit) => emit.event === "join:channel" && emit.payload === "dm-parent-channel")) {
        parentReconnectHandler = entry.handler;
        break;
      }
    }
    assert.ok(parentReconnectHandler, "parent room join should also be registered after socket reconnect");

    const nextDm = makeChannel({
      id: "dm-parent-channel-2",
      name: "Ada DM 2",
      type: "dm",
    });
    await act(async () => {
      useChannelStore.setState({ dmChannels: [nextDm] });
      useThreadStore.setState({ openParentChannelId: nextDm.id });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      assert.ok(
        emitted.some((entry) => entry.event === "join:channel" && entry.payload === "dm-parent-channel-2"),
        "parent channel changes should subscribe to the new parent room",
      );
    });

    act(() => {
      view.unmount();
    });
    assert.ok(
      offCalls.some((entry) => entry.event === "connect" && entry.handler === parentReconnectHandler),
      "parent reconnect listener should be removed on cleanup",
    );
  } finally {
    socket.emit = originalEmit;
    socket.on = originalOn;
    socket.off = originalOff;
  }
});

test("thread panel does not join a parent socket room before the parent channel is known", async () => {
  const socket = getSocket();
  const originalEmit = socket.emit;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  socket.emit = ((event: string, payload: unknown) => {
    emitted.push({ event, payload });
    return socket;
  }) as typeof socket.emit;

  try {
    renderThreadSearchPanel({ openParentChannelId: null });
    await Promise.resolve();

    assert.equal(
      emitted.some((entry) => entry.event === "join:channel" && (entry.payload === null || entry.payload === undefined)),
      false,
      "thread panel should wait for a concrete parent channel before joining the parent socket room",
    );
  } finally {
    socket.emit = originalEmit;
  }
});

test("thread parent task badge consumes only canonical task-domain metadata", async () => {
  renderThreadSearchPanel({
    followedThreads: [{
      threadChannelId: "thread-channel",
      parentMessageId: "parent-message",
      parentChannelId: "parent-channel",
      parentChannelName: "parent",
      parentChannelType: "channel",
      parentMessagePreview: "parent context",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-1",
      replyCount: 1,
      lastReplyAt: "2026-07-03T00:00:01.000Z",
      unreadCount: 0,
      taskId: "task-34",
      taskNumber: 34,
      taskStatus: "todo",
      taskClaimedByType: null,
      taskClaimedById: null,
      taskClaimedByName: null,
    }],
    taskMetadata: {
      messageId: "parent-message",
      taskNumber: 34,
      status: "done",
      claimedByName: "Cody",
    },
  });
  assert.deepEqual(useThreadStore.getState().taskUpdatesByMessageId, {});

  await waitFor(() => {
    const badge = screen.getByTestId("message-task-badge");
    assert.equal(badge.getAttribute("data-task-status"), "done");
    assert.match(badge.textContent ?? "", /#34/);
    assert.match(badge.textContent ?? "", /@Cody/);
  });
});

test("thread fallback task badge opens the canonical task from followed-thread metadata", async () => {
  // Was: "…task status uses the canonical task id…" — the badge used to be an
  // InlineBadgeEditor, so this asserted that an inline status write carried
  // `legacy-task-34` rather than the message id. The badge is now a reference:
  // it identifies the task and opens it, and status is edited in the task
  // itself. Status editing here is gone on purpose (@stdrc msg=602eb16e).
  //
  // What this now pins: the badge renders the task identity carried by
  // followed-thread metadata (#34 / in_review) and opening it declares the task
  // intent against the right parent.
  //
  // What is NOT pinned any more, stated so nobody reads more into this than it
  // proves: the old test asserted that the status write carried the canonical
  // `legacy-task-34` rather than the host message id. There is no write on this
  // surface to carry it, so that assertion has no home here. If a task-id-vs-
  // message-id confusion is to be guarded again, it needs a test where a task
  // id is actually consumed.
  renderThreadSearchPanel({
    followedThreads: [{
      threadChannelId: "thread-channel",
      parentMessageId: "parent-message",
      parentChannelId: "parent-channel",
      parentChannelName: "parent",
      parentChannelType: "channel",
      parentMessagePreview: "parent context",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-1",
      replyCount: 1,
      lastReplyAt: "2026-07-03T00:00:01.000Z",
      unreadCount: 0,
      taskId: "legacy-task-34",
      taskNumber: 34,
      taskStatus: "in_review",
      taskClaimedByType: "user",
      taskClaimedById: "user-2",
      taskClaimedByName: null,
    }],
  });

  const badge = await screen.findByTestId("message-task-badge");
  assert.equal(badge.getAttribute("data-task-status"), "in_review");
  assert.match(badge.textContent ?? "", /#34/);

  // The badge itself is the label; the affordance is the button wrapping it.
  const opener = badge.closest("[data-message-affordance='open-linked-task']");
  assert.ok(opener, "the task badge is wrapped in an open-linked-task control");

  fireEvent.click(opener as Element);

  await waitFor(() => {
    const thread = useThreadStore.getState();
    assert.equal(thread.openIntent, "task", "the badge declares the task intent");
    assert.equal(thread.openParentMessageId, "parent-message");
    assert.equal(thread.openParentChannelId, "parent-channel");
  });
});

test("thread Cmd/Ctrl+F opens search with selected text from the rendered thread", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform")
    ?? Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });

  renderThreadSearchPanel();

  const replyText = await screen.findByText(/selected\s+thread text/);
  setSelectionText(replyText);

  fireEvent.keyDown(replyText, { key: "f", ctrlKey: true });

  const input = await screen.findByTestId("thread-search-input") as HTMLInputElement;
  await waitFor(() => {
    assert.equal(input.value, "selected thread text");
  });

  if (originalPlatform) {
    Object.defineProperty(navigator, "platform", originalPlatform);
  }
});
