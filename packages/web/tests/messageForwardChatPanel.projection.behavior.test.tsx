import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useLocation } from "react-router-dom";
import { ToastProvider, toast } from "raft-ui";
import api from "../src/api/client";
import { getSocket } from "../src/api/socket";
import ChatPanel from "../src/components/message/ChatPanel";
import { ForwardToastProvider } from "../src/components/message/ForwardToastProvider";
import MessageItem from "../src/components/message/MessageItem";
import ThreadPanel from "../src/components/message/ThreadPanel";
import { forwardToastManager } from "../src/components/message/forwardToast";
import { useAgentStore } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSelectionStore } from "../src/store/selectionStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);
const test = ((name: string, fn: Parameters<typeof nodeTest>[1]) =>
  nodeTest(name, { concurrency: false }, fn)) as typeof nodeTest;

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
const defaultMatchMedia = window.matchMedia;
const defaultVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
const defaultGlobalEvent = globalThis.Event;
const defaultGlobalCustomEvent = globalThis.CustomEvent;
const originalOpenDM = useChannelStore.getState().openDM;
const originalOpenUserDM = useChannelStore.getState().openUserDM;
const originalJoinChannel = useChannelStore.getState().joinChannel;

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

globalThis.CSS = globalThis.CSS ?? ({ escape: (value: string) => value } as typeof CSS);

HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView ?? function scrollIntoView() {};
HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo ?? function scrollTo() {};
const defaultScrollIntoView = HTMLElement.prototype.scrollIntoView;

function hasTestId(testId: string): boolean {
  return Boolean(document.querySelector(`[data-testid="${testId}"]`));
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function getToastText(viewportSelector: string): string {
  return [...document.querySelectorAll(`${viewportSelector} [data-slot="toast"]`)]
    .map((element) => element.textContent ?? "")
    .join("\n");
}

function getForwardToastText(): string {
  return getToastText(".forward-toast-viewport");
}

function getDefaultToastText(): string {
  return getToastText('[data-slot="toast-viewport"]:not(.forward-toast-viewport)');
}

function hasToast(): boolean {
  return Boolean(document.querySelector('[data-slot="toast"]'));
}

function assertTitleOnlyToast(viewportSelector: string) {
  const viewport = document.querySelector(viewportSelector);
  assert.ok(viewport);
  assert.equal(viewport.querySelector('[data-slot="toast-icon"]'), null);
  assert.equal(viewport.querySelector('[data-slot="toast-close"]'), null);
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
    pinned: [],
    pinnedChannelIds: [],
    pinnedAgentIds: [],
    pinnedOrder: [],
    hiddenDmIds: [],
    channelPanelTabOrder: [],
    agentPanelTabOrder: [],
    pinnedVersion: 0,
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
    id: "source-channel",
    serverId: "server-forward",
    name: "source",
    description: null,
    type: "channel",
    createdAt: "2026-06-30T00:00:00.000Z",
    joined: true,
    activityMuteSupported: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    channelId: "source-channel",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat",
    content: "forward this",
    createdAt: "2026-06-30T00:00:00.000Z",
    seq: 1,
    ...overrides,
  };
}

function renderForwardPanel(
  channel: Channel,
  messages: Message[],
  options: {
    channels?: Channel[];
    dmChannels?: Channel[];
    selectedIds?: string[];
    startSelection?: boolean;
    channelMessages?: Record<string, Message[]>;
    visibleMessages?: Message[];
    withServer?: boolean;
    serverMessageForwardingEnabled?: boolean | "error";
    highlightedMessageId?: string | null;
    transientFocusRequest?: { channelId: string; messageId: string; nonce: number } | null;
    loadMessages?: (channelId: string) => Promise<void>;
    loadMessageContext?: (channelId: string, messageId: string) => Promise<void>;
    initialEntries?: string[];
    extraUi?: ReactNode;
  } = {},
) {
  const channels = options.channels ?? [channel, makeChannel({ id: "target-channel", name: "target" })];
  const dmChannels = options.dmChannels ?? [makeChannel({
    id: "dm-target",
    name: "dm-target",
    type: "dm",
    peerName: "targetbot",
    peerDisplayName: "Target Bot",
    peerType: "agent",
    peerAvatarUrl: "pixel:targetbot",
  })];

  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") {
      if (options.serverMessageForwardingEnabled === "error") throw new Error("flag endpoint unavailable");
      return { data: { enabled: options.serverMessageForwardingEnabled !== false } };
    }
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;
  const visibleMessages = options.visibleMessages ?? messages;

  useServerStore.setState({
    current: options.withServer === false
      ? null
      : {
          id: "server-forward",
          name: "Forward Server",
          avatarUrl: null,
          slug: "forward-server",
          ownerId: "user-owner",
          onboardingAgentId: null,
          hideHumansFromMembers: false,
          plan: "free",
          planDowngradedAt: null,
          role: "member",
          createdAt: "2026-06-30T00:00:00.000Z",
        },
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels,
    dmChannels,
    channelActivity: Object.fromEntries([...channels, ...dmChannels].map((target) => [target.id, null])),
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    messages,
    channelMessages: options.channelMessages ?? { [channel.id]: visibleMessages },
    currentChannelId: channel.id,
    loading: true,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: options.highlightedMessageId ?? null,
    contextLoadError: null,
    transientFocusRequest: options.transientFocusRequest ?? null,
    unreadCounts: {},
    drafts: {},
    loadMessages: options.loadMessages ?? (async () => {}),
    loadMessageContext: options.loadMessageContext ?? (async () => {}),
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });
  if (options.startSelection !== false) {
    useSelectionStore.getState().enter(channel.id, options.selectedIds ?? messages.map((message) => message.id));
  }

  return render(
    <MemoryRouter initialEntries={options.initialEntries}>
      <ToastProvider>
        {options.extraUi}
        <ForwardToastProvider>
          <ChatPanel channel={channel} />
        </ForwardToastProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function renderThreadForwardPanel(options: {
  parentChannel?: Channel;
  threadChannel?: Channel;
  destination?: Channel | null;
  parent?: Message;
  parentChannelMessages?: Message[];
  replies?: Message[];
  selectedIds?: string[];
  serverMessageForwardingEnabled?: boolean | Promise<boolean> | "error";
  cacheThreadReplies?: boolean;
  withServer?: boolean;
  includeParentChannel?: boolean;
  openParentChannelId?: string | null;
  openThreadChannelId?: string | null;
  selectionThreadChannelId?: string;
} = {}) {
  const parentChannel = options.parentChannel ?? makeChannel({ id: "parent-channel", name: "parent" });
  const threadChannel = options.threadChannel ?? makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  const destination = options.destination === undefined
    ? makeChannel({ id: "destination", name: "destination" })
    : options.destination;
  const parent = options.parent ?? makeMessage({
    id: "parent-message",
    channelId: parentChannel.id,
    content: "parent body",
    threadId: threadChannel.id,
    seq: 1,
  });
  const replies = options.replies ?? [
    makeMessage({ id: "reply-1", channelId: threadChannel.id, content: "reply body", seq: 2 }),
  ];
  const channels = [
    ...(options.includeParentChannel === false ? [] : [parentChannel]),
    threadChannel,
    ...(destination ? [destination] : []),
  ];

  useAuthStore.setState({ user: makeUser(), initialized: true });
  useServerStore.setState({
    current: options.withServer === false
      ? null
      : {
          id: "server-forward",
          name: "Forward Server",
          avatarUrl: null,
          slug: "forward-server",
          ownerId: "user-owner",
          onboardingAgentId: null,
          hideHumansFromMembers: false,
          plan: "free",
          planDowngradedAt: null,
          role: "member",
          createdAt: "2026-06-30T00:00:00.000Z",
        },
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels,
    dmChannels: parentChannel.type === "dm" ? [parentChannel] : [],
    channelActivity: Object.fromEntries(channels.map((channel) => [channel.id, null])),
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: {
      [parentChannel.id]: options.parentChannelMessages ?? [parent],
      [threadChannel.id]: options.cacheThreadReplies === false ? [] : replies,
    },
    currentChannelId: threadChannel.id,
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
    openParentChannelId: options.openParentChannelId === undefined ? parentChannel.id : options.openParentChannelId,
    openThreadChannelId: options.openThreadChannelId === undefined ? threadChannel.id : options.openThreadChannelId,
    summaries: {
      [parent.id]: {
        threadChannelId: threadChannel.id,
        replyCount: replies.length,
        lastReplyAt: replies.at(-1)?.createdAt ?? parent.createdAt,
        participantIds: [],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
  });
  useTaskStore.setState({ tasks: [], currentChannelId: threadChannel.id, loadTasks: async () => {} });
  useSelectionStore.getState().enterThread(
    options.selectionThreadChannelId ?? threadChannel.id,
    parent.id,
    parentChannel.id,
    options.selectedIds ?? [parent.id, ...replies.map((reply) => reply.id)],
  );

  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") {
      if (options.serverMessageForwardingEnabled === "error") throw new Error("flag endpoint unavailable");
      const enabled = options.serverMessageForwardingEnabled instanceof Promise
        ? await options.serverMessageForwardingEnabled
        : options.serverMessageForwardingEnabled !== false;
      return { data: { enabled } };
    }
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    if (url.startsWith(`/messages/channel/${threadChannel.id}`)) {
      return { data: { messages: replies, hasOlder: false, hasNewer: false } };
    }
    return { data: {} };
  }) as typeof api.get;

  render(
    <MemoryRouter>
      <ToastProvider>
        <ForwardToastProvider>
          <ThreadPanel />
        </ForwardToastProvider>
      </ToastProvider>
    </MemoryRouter>,
  );

  return { parentChannel, threadChannel, destination, parent, replies };
}

afterEach(() => {
  toast.dismiss();
  forwardToastManager.close();
  cleanup();
  getSocket().close();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  window.matchMedia = defaultMatchMedia;
  HTMLElement.prototype.scrollIntoView = defaultScrollIntoView;
  if (defaultVisualViewport) {
    Object.defineProperty(window, "visualViewport", defaultVisualViewport);
  } else {
    Reflect.deleteProperty(window, "visualViewport");
  }
  Object.defineProperty(globalThis, "Event", { configurable: true, value: defaultGlobalEvent });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: defaultGlobalCustomEvent });
  useChannelStore.setState({
    openDM: originalOpenDM,
    openUserDM: originalOpenUserDM,
    joinChannel: originalJoinChannel,
  });
  localStorage.clear();
  useSelectionStore.getState().exit();
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    summaries: {},
    followedThreads: [],
  });
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useAgentStore.setState({ agents: [] });
});




























test("destination search distinguishes a failed request from no matches and can retry", async () => {
  const source = makeChannel();
  let searchCalls = 0;

  renderForwardPanel(source, [makeMessage({ id: "message-search-retry" })]);
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");

  const baseGet = api.get;
  api.get = (async (url: string, config?: unknown) => {
    if (url === "/messages/forward/targets/search") {
      searchCalls += 1;
      if (searchCalls === 1) throw new Error("search unavailable");
      return { data: { targets: [] } };
    }
    return baseGet(url, config as never);
  }) as typeof api.get;

  fireEvent.change(screen.getByPlaceholderText("Search targets"), { target: { value: "missing target" } });
  await screen.findByText("Couldn't search destinations.");
  assert.equal(screen.queryByText("No destinations match your search."), null);

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("No destinations match your search.");
  assert.equal(searchCalls, 2);
});


test("mixed nested-forward selections block before target selection instead of dropping forwarded cards", async () => {
  const source = makeChannel();
  const original = makeMessage({ id: "original-message", content: "Original body" });
  const forwarded = makeMessage({
    id: "already-forwarded-message",
    content: "",
    seq: 2,
    actionMetadata: {
      kind: "forwarded-bundle",
      forwardedItems: [{
        sourceMessageId: "source-message",
        sourceTargetId: source.id,
        sourceTargetSnapshot: { id: source.id, type: "channel", label: "#source", labelVisibility: "public" },
        contentSnapshot: "already forwarded body",
      }],
    },
  });

  renderForwardPanel(source, [original, forwarded]);

  fireEvent.click(await screen.findByTestId("select-mode-forward"));

  assert.equal(hasTestId("forward-composer-dialog"), false);
  await waitFor(() => assert.match(
    getForwardToastText(),
    /Deselect forwarded messages, or select their original messages instead\./,
  ));
  assertTitleOnlyToast(".forward-toast-viewport");
});

test("thread and joint source surfaces can forward ordinary messages", async () => {
  const thread = makeChannel({ id: "thread-source", type: "thread", name: "thread" });
  renderForwardPanel(thread, [makeMessage({ id: "thread-message", channelId: thread.id })], {
    channels: [thread, makeChannel({ id: "target-channel", name: "target" })],
    dmChannels: [],
  });

  const threadForward = await screen.findByTestId("select-mode-forward") as HTMLButtonElement;
  assert.equal(threadForward.disabled, false);
  assert.equal(threadForward.getAttribute("title"), "Forward");
  fireEvent.click(threadForward);
  await screen.findByTestId("forward-composer-dialog");
  assert.match(screen.getByTestId("forward-composer-dialog").textContent ?? "", /1 selected from #thread/);

  cleanup();
  useSelectionStore.getState().exit();

  const joint = makeChannel({ id: "joint-source", type: "joint", name: "joint" });
  renderForwardPanel(joint, [makeMessage({ id: "joint-message", channelId: joint.id })]);

  const jointForward = await screen.findByTestId("select-mode-forward") as HTMLButtonElement;
  assert.equal(jointForward.disabled, false);
  assert.equal(hasTestId("select-mode-copy-link"), true);
  fireEvent.click(jointForward);
  await screen.findByTestId("forward-composer-dialog");
  assert.match(screen.getByTestId("forward-composer-dialog").textContent ?? "", /1 selected from #joint/);
});

test("copy link uses channel and DM permalink routes for the selected rows", async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writes.push(value);
      },
    },
  });

  const channel = makeChannel();
  renderForwardPanel(channel, [makeMessage({ id: "channel-message" })]);

  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /\/s\/forward-server\/channel\/source-channel\?msg=channel-message/);
  await waitFor(() => assert.match(getDefaultToastText(), /Link copied\./));
  assertTitleOnlyToast('[data-slot="toast-viewport"]:not(.forward-toast-viewport)');

  cleanup();
  useSelectionStore.getState().exit();

  const dm = makeChannel({ id: "dm-source", name: "dm-source", type: "dm", peerName: "targetbot", peerDisplayName: "Target Bot" });
  renderForwardPanel(dm, [makeMessage({ id: "dm-message", channelId: dm.id })], { channels: [], dmChannels: [dm] });

  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });
  assert.equal(writes.length, 2);
  assert.match(writes[1], /\/s\/forward-server\/dm\/dm-source\?msg=dm-message/);
});



test("forwarded public source label opens the first source position only on sent cards", async () => {
  const parentChannel = makeChannel({ id: "parent-channel", name: "parent" });
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  const opened: Array<Record<string, unknown>> = [];
  const contextCalls: Array<{ url: string; params: unknown }> = [];

  useAuthStore.setState({ user: makeUser(), initialized: true });
  useServerStore.setState({
    current: {
      id: "server-forward",
      name: "Forward Server",
      avatarUrl: null,
      slug: "forward-server",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-06-30T00:00:00.000Z",
    },
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannel.id]: null, [threadChannel.id]: null },
  });
  useThreadStore.setState({
    openThread: async (request) => {
      opened.push(request);
    },
  });
  api.get = (async (url: string, config?: { params?: unknown }) => {
    contextCalls.push({ url, params: config?.params });
    return {
      data: {
        canonicalTarget: {
          kind: "thread",
          messageId: "original-reply",
          threadParentMessageId: "parent-message",
          threadChannelId: threadChannel.id,
        },
      },
    };
  }) as typeof api.get;

  render(
    <MemoryRouter>
      <MessageItem
        message={makeMessage({
          id: "forwarded-thread-card",
          channelId: "target-channel",
          content: "",
          actionMetadata: {
            kind: "forwarded-bundle",
            forwardedItems: [{
              sourceMessageId: "original-reply",
              sourceThreadId: threadChannel.id,
              parentChannelId: parentChannel.id,
              sourceTargetId: null,
              sourceAuthorSnapshot: { type: "user", id: "user-2", name: "Babbage", uniqueName: "babbage" },
              sourceCreatedAt: "2026-06-30T00:00:00.000Z",
              sourceTargetSnapshot: {
                id: threadChannel.id,
                type: "thread",
                label: "#parent",
                labelVisibility: "public",
              },
              contentSnapshot: "original reply body",
              provenanceState: "available",
            }],
          },
        })}
        mentionMap={new Map()}
        channels={[parentChannel, threadChannel]}
      />
    </MemoryRouter>,
  );

  assert.match(screen.getByTestId("forwarded-bundle-source-label").textContent ?? "", /from #parent · thread/);
  assert.equal(screen.getByTestId("forwarded-bundle-source-label").tagName, "BUTTON");
  assert.equal(hasTestId("forwarded-bundle-view-original"), false);
  await act(async () => {
    fireEvent.click(screen.getByTestId("forwarded-bundle-source-label"));
  });

  assert.deepEqual(contextCalls, [{
    url: "/messages/context/original-reply",
    params: { channelId: parentChannel.id },
  }]);
  assert.deepEqual(opened, [{
    parentChannelId: parentChannel.id,
    parentMessageId: "parent-message",
    focusedMessageId: "original-reply",
    initialThreadChannelId: threadChannel.id,
  }]);
});



test("mobile View all uses a route-backed dedicated page and Back preserves other query state", async () => {
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  const forwardedItems = Array.from({ length: 4 }, (_, index) => ({
    sourceMessageId: `mobile-source-${index}`,
    sourceTargetId: "source-channel",
    sourceAuthorSnapshot: { type: "user", id: "user-2", name: "Babbage", uniqueName: "babbage" },
    sourceCreatedAt: "2026-06-30T00:00:00.000Z",
    sourceTargetSnapshot: { id: "source-channel", type: "channel", label: "#source", labelVisibility: "public" },
    contentSnapshot: `mobile forwarded body ${index}`,
    provenanceState: "available" as const,
  }));

  render(
    <MemoryRouter initialEntries={["/s/forward-server/channel/target-channel?thread=parent%3Amessage&profile=user-2"]}>
      <LocationProbe />
      <MessageItem
        message={makeMessage({
          id: "mobile-forwarded-card",
          channelId: "target-channel",
          content: "",
          actionMetadata: { kind: "forwarded-bundle", forwardedItems },
        })}
        mentionMap={new Map()}
        channels={[]}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByTestId("forwarded-bundle-toggle"));
  const detailPage = await screen.findByTestId("forwarded-bundle-detail-page");
  const detailHeading = detailPage.querySelector("h1");
  assert.equal(detailHeading?.textContent, "Forwarded messages");
  assert.equal(detailHeading?.classList.contains("uppercase"), false);
  assert.equal(detailPage.querySelectorAll('[data-testid="forwarded-bundle-item"]').length, 4);
  assert.match(screen.getByTestId("location-probe").textContent ?? "", /thread=parent%3Amessage/);
  assert.match(screen.getByTestId("location-probe").textContent ?? "", /profile=user-2/);
  assert.match(screen.getByTestId("location-probe").textContent ?? "", /forward=mobile-forwarded-card/);

  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  await waitFor(() => assert.equal(hasTestId("forwarded-bundle-detail-page"), false));
  assert.equal(
    screen.getByTestId("location-probe").textContent,
    "/s/forward-server/channel/target-channel?thread=parent%3Amessage&profile=user-2",
  );
});

test("forwarded channel bundles render legacy array order by visible source time without rewriting metadata", () => {
  const sourceTargetSnapshot = {
    id: "source-channel",
    type: "channel",
    label: "#general",
    labelVisibility: "public" as const,
  };
  const forwardedItems = [{
    index: 0,
    sourceMessageId: "attachment-row",
    sourceMessageSeq: 1,
    sourceAuthorSnapshot: { type: "user", id: "developer", name: "Developer", uniqueName: "Developer" },
    sourceCreatedAt: "2026-07-17T01:08:00.000Z",
    sourceTargetSnapshot,
    contentSnapshot: "PNG, JPEG, and text files are attached for review.",
    attachmentSnapshots: [{ filename: "seed-pixel.png", mimeType: "image/png" }],
    provenanceState: "available" as const,
  }, {
    index: 1,
    sourceMessageId: "long-filename-row",
    sourceMessageSeq: 2,
    sourceAuthorSnapshot: { type: "user", id: "developer", name: "Developer", uniqueName: "Developer" },
    sourceCreatedAt: "2026-07-17T01:09:00.000Z",
    sourceTargetSnapshot,
    contentSnapshot: "Please review the attached Markdown document with the long filename.",
    attachmentSnapshots: [{ filename: "seed-this-is-an-extremely-long-markdown-filename.md", mimeType: "text/markdown" }],
    provenanceState: "available" as const,
  }, {
    index: 2,
    sourceMessageId: "backdated-text-row",
    sourceMessageSeq: 3,
    sourceAuthorSnapshot: { type: "agent", id: "assistant", name: "Assistant", uniqueName: "assistant" },
    sourceCreatedAt: "2026-07-16T23:58:00.000Z",
    sourceTargetSnapshot,
    contentSnapshot: "The search indexer is lagging behind by ~10 seconds during peak hours.",
    provenanceState: "available" as const,
  }];

  render(
    <MemoryRouter>
      <MessageItem
        message={makeMessage({
          id: "legacy-visible-time-bundle",
          channelId: "target-channel",
          content: "",
          actionMetadata: { kind: "forwarded-bundle", forwardedItems },
        })}
        mentionMap={new Map()}
        channels={[]}
      />
    </MemoryRouter>,
  );

  const card = screen.getByTestId("forwarded-bundle-card");
  const rendered = [...card.querySelectorAll('[data-testid="forwarded-bundle-item"]')];
  const forwardedLabel = screen.getByText("Forwarded", { selector: "span", exact: true });
  assert.equal(forwardedLabel.classList.contains("uppercase"), false);
  assert.deepEqual(rendered.map((item) => item.textContent?.includes("search indexer")
    ? "backdated"
    : item.textContent?.includes("PNG, JPEG") ? "attachment" : "long-filename"), [
    "backdated",
    "attachment",
    "long-filename",
  ]);
  assert.deepEqual(forwardedItems.map((item) => item.sourceMessageId), [
    "attachment-row",
    "long-filename-row",
    "backdated-text-row",
  ]);
});



test("thread panel forwards and copies only selected thread replies", async () => {
  const parentChannel = makeChannel({ id: "parent-channel", name: "parent" });
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  const destination = makeChannel({ id: "destination", name: "destination" });
  const parent = makeMessage({ id: "parent-message", channelId: parentChannel.id, content: "parent body", threadId: threadChannel.id });
  const reply = makeMessage({ id: "reply-1", channelId: threadChannel.id, content: "reply body", seq: 1 });
  const systemReply = makeMessage({ id: "reply-system", channelId: threadChannel.id, content: "system", messageType: "system", seq: 2 });
  const copied: string[] = [];

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  useAuthStore.setState({ user: makeUser(), initialized: true });
  useServerStore.setState({
    current: {
      id: "server-forward",
      name: "Forward Server",
      avatarUrl: null,
      slug: "forward-server",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-06-30T00:00:00.000Z",
    },
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel, destination],
    dmChannels: [],
    channelActivity: { [parentChannel.id]: null, [threadChannel.id]: null, [destination.id]: null },
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: {
      [parentChannel.id]: [parent],
      [threadChannel.id]: [reply, systemReply],
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
    openParentChannelId: parentChannel.id,
    openThreadChannelId: threadChannel.id,
    summaries: {
      [parent.id]: {
        threadChannelId: threadChannel.id,
        replyCount: 2,
        lastReplyAt: reply.createdAt,
        participantIds: [],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
  });
  useTaskStore.setState({ tasks: [], currentChannelId: threadChannel.id, loadTasks: async () => {} });
  useSelectionStore.getState().enterThread(threadChannel.id, parent.id, parentChannel.id, [parent.id, reply.id, systemReply.id]);

  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: true } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    if (url.startsWith(`/messages/channel/${threadChannel.id}`)) {
      return { data: { messages: [reply, systemReply], hasOlder: false, hasNewer: false } };
    }
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/messages/forward");
    assert.deepEqual((body as { destinationChannelIds?: string[] }).destinationChannelIds, [destination.id]);
    assert.deepEqual(
      [...((body as { sourceMessageIds?: string[] }).sourceMessageIds ?? [])].sort(),
      [parent.id, reply.id].sort(),
    );
    assert.equal((body as { note?: string }).note, "");
    return {
      data: {
        results: [{
          destinationChannelId: destination.id,
          status: "success",
          message: makeMessage({ id: "forwarded-thread", channelId: destination.id, content: "forwarded" }),
        }],
      },
    };
  }) as typeof api.post;

  render(
    <MemoryRouter>
      <ToastProvider>
        <ForwardToastProvider>
          <ThreadPanel />
        </ForwardToastProvider>
      </ToastProvider>
    </MemoryRouter>,
  );

  await screen.findByTestId("select-mode-toolbar");
  assert.equal(hasToast(), false);

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  assert.equal(hasTestId("forward-composer-dialog"), false);
  await waitFor(() => assert.match(
    getForwardToastText(),
    /Deselect system updates before forwarding\. They must stay with their original conversation\./,
  ));

  useSelectionStore.getState().enterThread(threadChannel.id, parent.id, parentChannel.id, [parent.id, reply.id]);
  fireEvent.click(screen.getByTestId("select-mode-forward"));
  const dialog = await screen.findByTestId("forward-composer-dialog");
  assert.match(dialog.textContent ?? "", /2 selected from #parent · thread/);
  assert.doesNotMatch(dialog.textContent ?? "", /unsupported selected message was skipped/);
  assert.match(dialog.textContent ?? "", /from #parent · thread/);
  assert.doesNotMatch(dialog.textContent ?? "", /Forwarded bundles must come from a single source/);
  assert.match(dialog.textContent ?? "", /parent body/);
  assert.match(dialog.textContent ?? "", /reply body/);
  fireEvent.click(screen.getByRole("button", { name: "Close forward composer" }));
  assert.equal(hasTestId("forward-composer-dialog"), false);

  useSelectionStore.getState().enterThread(threadChannel.id, parent.id, parentChannel.id, [reply.id]);
  await screen.findByTestId("select-mode-toolbar");
  fireEvent.click(screen.getByTestId("select-mode-forward"));
  const replyOnlyDialog = await screen.findByTestId("forward-composer-dialog");
  assert.match(replyOnlyDialog.textContent ?? "", /1 selected from #parent · thread/);
  assert.match(replyOnlyDialog.textContent ?? "", /from #parent · thread/);
  assert.doesNotMatch(replyOnlyDialog.textContent ?? "", /parent body/);
  assert.match(replyOnlyDialog.textContent ?? "", /reply body/);
  fireEvent.click(screen.getByRole("button", { name: "Close forward composer" }));
  assert.equal(hasTestId("forward-composer-dialog"), false);

  useSelectionStore.getState().enterThread(threadChannel.id, parent.id, parentChannel.id, [reply.id]);
  await screen.findByTestId("select-mode-toolbar");
  fireEvent.click(screen.getByTestId("select-mode-select-all"));
  assert.match(screen.getByTestId("select-mode-count").textContent ?? "", /2 selected/);
  fireEvent.click(screen.getByTestId("select-mode-forward"));
  const selectAllDialog = await screen.findByTestId("forward-composer-dialog");
  assert.doesNotMatch(selectAllDialog.textContent ?? "", /unsupported selected/);
  assert.match(selectAllDialog.textContent ?? "", /from #parent · thread/);
  assert.doesNotMatch(selectAllDialog.textContent ?? "", /thread · thread/);
  assert.doesNotMatch(selectAllDialog.textContent ?? "", /Forwarded bundles must come from a single source/);
  fireEvent.click(screen.getAllByTestId("forward-target-destination")[0]);
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Send forward" }).hasAttribute("disabled"), false));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send forward" }));
  });
  assert.equal(useSelectionStore.getState().isActive, false);
  assert.ok(useMessageStore.getState().channelMessages[destination.id]?.some((message) => message.id === "forwarded-thread"));
  await waitFor(() => assert.match(getForwardToastText(), /Forwarded to #destination\./));

  useSelectionStore.getState().enterThread(threadChannel.id, parent.id, parentChannel.id, [parent.id, reply.id]);
  await screen.findByTestId("select-mode-toolbar");
  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });
  assert.deepEqual([...(copied.at(-1)?.split("\n") ?? [])].sort(), [
    "http://localhost:3000/s/forward-server/channel/parent-channel?msg=parent-message",
    "http://localhost:3000/s/forward-server/channel/parent-channel?msg=reply-1&thread=parent-channel%3Aparent-message",
  ].sort());
  await waitFor(() => assert.match(getDefaultToastText(), /2 links copied\./));
});

test("thread forward entrypoint stays hidden until the server flag enables it", async () => {
  let enableForward!: (enabled: boolean) => void;
  const flagPromise = new Promise<boolean>((resolve) => {
    enableForward = resolve;
  });

  renderThreadForwardPanel({
    selectedIds: ["reply-1"],
    serverMessageForwardingEnabled: flagPromise,
    cacheThreadReplies: false,
  });

  await screen.findByTestId("select-mode-toolbar");
  assert.equal(hasTestId("select-mode-forward"), false);

  await act(async () => {
    enableForward(true);
    await flagPromise;
  });
  await screen.findByTestId("select-mode-forward");
});



test("thread copy markdown resolves parent and local replies through the share hook", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });

  renderThreadForwardPanel({
    selectedIds: ["parent-message", "reply-1"],
    cacheThreadReplies: false,
  });

  await screen.findByTestId("select-mode-toolbar");
  fireEvent.click(screen.getByTestId("select-mode-more"));
  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-md"));
  });

  assert.equal(copied.length, 1);
  assert.match(copied[0], /\*\*Ada\*\*: parent body/);
  assert.match(copied[0], /↳ \*\*Ada\*\*: reply body/);
});

test("thread forward excludes selected parent-channel siblings", async () => {
  const parent = makeMessage({
    id: "parent-message",
    channelId: "parent-channel",
    content: "parent body",
    threadId: "thread-channel",
    seq: 1,
  });
  const sibling = makeMessage({
    id: "sibling-parent-channel-message",
    channelId: "parent-channel",
    content: "sibling parent-channel body",
    seq: 2,
  });

  renderThreadForwardPanel({
    parent,
    parentChannelMessages: [parent, sibling],
    selectedIds: [sibling.id, "reply-1"],
    cacheThreadReplies: false,
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  const dialog = await screen.findByTestId("forward-composer-dialog");
  assert.match(dialog.textContent ?? "", /1 selected from #parent · thread/);
  assert.match(dialog.textContent ?? "", /reply body/);
  assert.doesNotMatch(dialog.textContent ?? "", /sibling parent-channel body/);
});

test("thread forward explains nested forwarded replies are unsupported", async () => {
  const parentChannel = makeChannel({ id: "parent-channel", name: "parent" });
  const forwardedReply = makeMessage({
    id: "forwarded-thread-reply",
    channelId: "thread-channel",
    content: "",
    seq: 2,
    actionMetadata: {
      kind: "forwarded-bundle",
      forwardedItems: [{
        sourceMessageId: "original-thread-reply",
        sourceTargetId: parentChannel.id,
        sourceTargetSnapshot: { id: parentChannel.id, type: "channel", label: "#parent", labelVisibility: "public" },
        contentSnapshot: "already forwarded reply body",
      }],
    },
  });

  renderThreadForwardPanel({
    parentChannel,
    replies: [forwardedReply],
    selectedIds: [forwardedReply.id],
    cacheThreadReplies: false,
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));

  assert.equal(hasTestId("forward-composer-dialog"), false);
  await waitFor(() => assert.match(
    getForwardToastText(),
    /Forwarded messages can't be forwarded again\. Select the original messages instead\./,
  ));
  assertTitleOnlyToast(".forward-toast-viewport");
});




test("thread copy link uses DM permalink route for selected replies under DM parents", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  const dmParent = makeChannel({
    id: "dm-parent",
    name: "dm-parent",
    type: "dm",
    peerName: "targetbot",
    peerDisplayName: "Target Bot",
  });
  const threadChannel = makeChannel({ id: "dm-thread", type: "thread", name: "dm-thread" });
  const parent = makeMessage({
    id: "dm-parent-message",
    channelId: dmParent.id,
    content: "dm parent body",
    threadId: threadChannel.id,
    seq: 1,
  });
  const reply = makeMessage({ id: "dm-thread-reply", channelId: threadChannel.id, content: "dm reply body", seq: 2 });

  renderThreadForwardPanel({
    parentChannel: dmParent,
    threadChannel,
    parent,
    replies: [reply],
    selectedIds: [reply.id],
    cacheThreadReplies: false,
  });

  await screen.findByTestId("select-mode-toolbar");
  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });

  assert.deepEqual(copied, [
    "http://localhost:3000/s/forward-server/dm/dm-parent?msg=dm-thread-reply&thread=dm-parent%3Adm-parent-message",
  ]);
  await waitFor(() => assert.match(getDefaultToastText(), /Link copied\./));
});




test("thread selections block forward and copy link when a selected reply is unresolved", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });

  renderThreadForwardPanel({
    selectedIds: ["reply-1", "missing-reply"],
    cacheThreadReplies: false,
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  assert.equal(hasTestId("forward-composer-dialog"), false);
  await screen.findByText("1 selected message is no longer available.");

  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });
  assert.deepEqual(copied, []);
  assert.equal(screen.getAllByText("1 selected message is no longer available.").length, 2);
});
