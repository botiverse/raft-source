import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useNavigate } from "react-router-dom";
import { ToastProvider, toast } from "raft-ui";
import api from "../src/api/client";
import { getSocket } from "../src/api/socket";
import ChatPanel from "../src/components/message/ChatPanel";
import { ForwardToastProvider } from "../src/components/message/ForwardToastProvider";
import { forwardToastManager } from "../src/components/message/forwardToast";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useImageLightboxStore } from "../src/store/imageLightboxStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSelectionStore } from "../src/store/selectionStore";
import type { ServerMember } from "../src/store/serverStore";
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

function useMobileViewport() {
  Object.defineProperty(globalThis, "Event", { configurable: true, value: window.Event });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });
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
}

function getToastText(viewportSelector: string): string {
  return [...document.querySelectorAll(`${viewportSelector} [data-slot="toast"]`)]
    .map((element) => element.textContent ?? "")
    .join("\n");
}

function getForwardToastText(): string {
  return getToastText(".forward-toast-viewport");
}

function assertTitleOnlyToast(viewportSelector: string) {
  const viewport = document.querySelector(viewportSelector);
  assert.ok(viewport);
  assert.equal(viewport.querySelector('[data-slot="toast-icon"]'), null);
  assert.equal(viewport.querySelector('[data-slot="toast-close"]'), null);
}

function assertForwardToastActionTextOnlyHover() {
  const action = document.querySelector(".forward-toast-viewport [data-slot=\"toast-action\"]");
  assert.ok(action);
  assert.match(action.className, /\bhover:text-black\b/);
  assert.match(action.className, /\bhover:border-transparent\b/);
  assert.match(action.className, /\bhover:bg-transparent\b/);
  assert.match(action.className, /\bhover:no-underline\b/);
  assert.match(action.className, /\bhover:shadow-none\b/);
  assert.match(action.className, /\bhover:translate-x-0\b/);
  assert.match(action.className, /\bhover:translate-y-0\b/);
  assert.doesNotMatch(action.className, /\bhover:underline\b/);
}

function getForwardSendButton(): HTMLButtonElement {
  const button = screen.getByTestId("forward-composer-dialog").querySelector('button[aria-label="Send forward"]');
  assert.ok(button instanceof HTMLButtonElement);
  return button;
}

function changeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, {
    target: {
      value,
      selectionStart: value.length,
      selectionEnd: value.length,
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

function makeServerMember(overrides: Partial<ServerMember> = {}): ServerMember {
  return {
    userId: "user-peer",
    serverId: "server-forward",
    serverName: "Forward Server",
    serverSlug: "forward-server",
    email: "peer@example.com",
    gravatarHash: "",
    name: "peer",
    displayName: "Peer Human",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-helper",
    serverId: "server-forward",
    serverName: "Forward Server",
    serverSlug: "forward-server",
    name: "HelperBot",
    displayName: "Helper Bot",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt",
    runtime: "codex",
    serverRole: "member",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: null,
    creatorType: "user",
    creatorId: "user-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-06-30T00:00:00.000Z",
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
    serverMembers?: ServerMember[];
    agents?: Agent[];
    channelMembers?: Record<string, { humans?: unknown[]; agents?: unknown[] }>;
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
    if (url.endsWith("/members")) {
      const channelId = url.match(/^\/channels\/([^/]+)\/members$/)?.[1];
      return { data: channelId ? options.channelMembers?.[channelId] ?? { humans: [], agents: [] } : { humans: [], agents: [] } };
    }
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
    members: options.serverMembers ?? [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels,
    dmChannels,
    channelActivity: Object.fromEntries([...channels, ...dmChannels].map((target) => [target.id, null])),
  });
  useAgentStore.setState({
    agents: options.agents ?? [],
  } as never);
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

function OpenThreadRouteButton({ parentMessageId }: { parentMessageId: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="open-thread-route"
      onClick={() => navigate(`?msg=stale-channel-message&thread=thread-channel:${parentMessageId}`)}
    >
      Open thread route
    </button>
  );
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
  useImageLightboxStore.getState().close();
});

test("selected rows block actions when some ids cannot be resolved", async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writes.push(value);
      },
    },
  });

  const source = makeChannel();
  const resolved = makeMessage({ id: "resolved-message", content: "visible" });
  renderForwardPanel(source, [resolved], {
    selectedIds: [resolved.id, "missing-message"],
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  assert.equal(hasTestId("forward-composer-dialog"), false);
  await screen.findByText("1 selected message is no longer available.");

  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });
  assert.deepEqual(writes, []);
  assert.equal(screen.getAllByText("1 selected message is no longer available.").length, 2);
});








test("forward flag defaults hidden until the server enables it", async () => {
  const source = makeChannel();
  renderForwardPanel(source, [makeMessage({ id: "message-server-on" })], {
    serverMessageForwardingEnabled: true,
  });

  assert.equal(hasTestId("select-mode-forward"), false);
  await screen.findByTestId("select-mode-forward");
});


test("mixed unsupported chat selections block before an origin-only selection sends to a DM", async () => {
  const source = makeChannel();
  const forwardable = makeMessage({ id: "message-1", content: "Ship this note", seq: 1 });
  const secondForwardable = makeMessage({ id: "message-2", content: "And this follow-up", seq: 2 });
  const system = makeMessage({ id: "message-system", messageType: "system", content: "System event", seq: 3 });
  const action = makeMessage({
    id: "message-action",
    content: "Action card",
    actionMetadata: { kind: "unsupported-test" },
    seq: 4,
  });
  const forwarded = makeMessage({ id: "forwarded-message", channelId: "dm-target", content: "Forwarded payload" });

  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/messages/forward");
    assert.deepEqual((body as { destinationChannelIds?: string[] }).destinationChannelIds, ["dm-target"]);
    assert.equal(typeof (body as { requestId?: unknown }).requestId, "string");
    assert.deepEqual((body as { sourceMessageIds?: string[] }).sourceMessageIds, ["message-1", "message-2"]);
    assert.equal((body as { note?: string }).note, "");
    return { data: { results: [{ destinationChannelId: "dm-target", status: "success", message: forwarded }] } };
  }) as typeof api.post;

  renderForwardPanel(source, [forwardable, secondForwardable, system, action]);

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  assert.equal(hasTestId("forward-composer-dialog"), false);
  await waitFor(() => assert.match(
    getForwardToastText(),
    /Some selected items can't be forwarded\. Keep only regular messages selected and try again\./,
  ));

  useSelectionStore.getState().enter(source.id, [forwardable.id, secondForwardable.id]);
  fireEvent.click(screen.getByTestId("select-mode-forward"));
  const dialog = await screen.findByTestId("forward-composer-dialog");
  assert.match(dialog.textContent ?? "", /2 selected from #source/);
  assert.doesNotMatch(dialog.textContent ?? "", /unsupported selected messages were skipped/);
  assert.match(dialog.textContent ?? "", /Ship this note/);
  assert.match(dialog.textContent ?? "", /And this follow-up/);
  assert.doesNotMatch(dialog.textContent ?? "", /send as one|Sends as one forwarded card/i);
  assert.doesNotMatch(dialog.textContent ?? "", /System event/);
  assert.doesNotMatch(dialog.textContent ?? "", /Action card/);

  fireEvent.click(screen.getAllByTestId("forward-target-dm-target")[0]);
  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });

  assert.equal(hasTestId("forward-composer-dialog"), false);
  assert.equal(useSelectionStore.getState().isActive, false);
  assert.ok(useMessageStore.getState().channelMessages["dm-target"]?.some((message) => message.id === "forwarded-message"));
  await waitFor(() => assert.match(getForwardToastText(), /Forwarded to DM\./));
  assertTitleOnlyToast(".forward-toast-viewport");
  assertForwardToastActionTextOnlyHover();
});

test("forward composer preview and request order selected messages by visible source time", async () => {
  const source = makeChannel();
  const target = makeChannel({ id: "visible-time-target", name: "visible-time-target" });
  const firstSelected = makeMessage({
    id: "source-july-17-0108",
    content: "July 17 attachment row",
    createdAt: "2026-07-17T01:08:00.000Z",
    seq: 1,
  });
  const secondSelected = makeMessage({
    id: "source-july-17-0109",
    content: "July 17 long filename row",
    createdAt: "2026-07-17T01:09:00.000Z",
    seq: 2,
  });
  const backdated = makeMessage({
    id: "source-july-16-2358",
    content: "July 16 search index row",
    createdAt: "2026-07-16T23:58:00.000Z",
    seq: 3,
  });

  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/messages/forward");
    assert.deepEqual((body as { sourceMessageIds?: string[] }).sourceMessageIds, [
      backdated.id,
      firstSelected.id,
      secondSelected.id,
    ]);
    return {
      data: {
        results: [{
          destinationChannelId: target.id,
          status: "success",
          message: makeMessage({ id: "visible-time-forwarded", channelId: target.id }),
        }],
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [firstSelected, secondSelected, backdated], {
    channels: [source, target],
    dmChannels: [],
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  const previewItems = [...screen.getByTestId("forward-composer-dialog").querySelectorAll('[data-testid="forwarded-bundle-item"]')];
  assert.deepEqual(previewItems.map((item) => item.textContent?.match(/July \d+[^·]*/)?.[0]?.trim()), [
    "July 16 search index row",
    "July 17 attachment row",
    "July 17 long filename row",
  ]);

  fireEvent.click(screen.getByTestId("forward-target-visible-time-target"));
  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });
});

test("channel row context-menu selection can forward plain and thread-parent messages", async () => {
  const source = makeChannel();
  const copiedLinks: string[] = [];
  const plainMessage = makeMessage({ id: "plain-channel-message", content: "Plain channel body", seq: 1 });
  const threadParent = makeMessage({
    id: "thread-parent-message",
    content: "Thread parent body",
    threadId: "thread-channel",
    seq: 2,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedLinks.push(value);
      },
    },
  });

  renderForwardPanel(source, [plainMessage, threadParent], { startSelection: false });

  const plainRow = document.getElementById("message-plain-channel-message");
  assert.ok(plainRow);
  fireEvent.contextMenu(plainRow, { clientX: 96, clientY: 96 });
  fireEvent.click(await screen.findByText("Select Message"));
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  let dialog = await screen.findByTestId("forward-composer-dialog");
  assert.match(dialog.textContent ?? "", /1 selected from #source/);
  assert.match(dialog.textContent ?? "", /Plain channel body/);
  assert.doesNotMatch(dialog.textContent ?? "", /Thread parent body/);
  fireEvent.click(screen.getByRole("button", { name: "Close forward composer" }));
  await waitFor(() => assert.equal(hasTestId("forward-composer-dialog"), false));
  await act(async () => {
    fireEvent.click(screen.getByTestId("select-mode-copy-link"));
  });
  assert.equal(copiedLinks.length, 1);
  assert.match(copiedLinks[0], /\/s\/forward-server\/channel\/source-channel\?msg=plain-channel-message/);

  await act(async () => {
    useSelectionStore.getState().exit();
  });
  await waitFor(() => assert.equal(hasTestId("select-mode-forward"), false));

  const parentRow = document.getElementById("message-thread-parent-message");
  assert.ok(parentRow);
  fireEvent.contextMenu(parentRow, { clientX: 96, clientY: 128 });
  fireEvent.click(await screen.findByText("Select Message"));
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  dialog = await screen.findByTestId("forward-composer-dialog");
  assert.match(dialog.textContent ?? "", /1 selected from #source/);
  assert.match(dialog.textContent ?? "", /Thread parent body/);
});

test("opening a thread cancels a queued permalink focus before it can move the parent channel", async () => {
  const originalGlobalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalGlobalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
  const originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const focusedMessageIds: string[] = [];
  let nextFrameId = 1;

  const requestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    pendingFrames.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  const cancelFrame = ((id: number) => {
    pendingFrames.delete(id);
  }) as typeof cancelAnimationFrame;

  globalThis.requestAnimationFrame = requestFrame;
  globalThis.cancelAnimationFrame = cancelFrame;
  window.requestAnimationFrame = requestFrame;
  window.cancelAnimationFrame = cancelFrame;
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    const messageId = this.getAttribute("data-timeline-message-id");
    if (messageId) focusedMessageIds.push(messageId);
  };

  try {
    const source = makeChannel();
    const staleMessage = makeMessage({
      id: "stale-channel-message",
      content: "Stale permalink focus body",
      seq: 1,
    });
    const threadParent = makeMessage({
      id: "current-thread-parent",
      content: "Current thread parent body",
      threadId: "thread-channel",
      seq: 2,
    });

    renderForwardPanel(source, [staleMessage, threadParent], {
      highlightedMessageId: staleMessage.id,
      initialEntries: [`/s/server-forward/channel/${source.id}?msg=${staleMessage.id}`],
      startSelection: false,
      extraUi: <OpenThreadRouteButton parentMessageId={threadParent.id} />,
    });

    await screen.findByText(staleMessage.content);
    focusedMessageIds.length = 0;

    fireEvent.click(screen.getByTestId("open-thread-route"));
    await waitFor(() => assert.equal(useMessageStore.getState().highlightedMessageId, null));

    await act(async () => {
      const queued = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of queued) callback(performance.now());
    });

    assert.deepEqual(
      focusedMessageIds,
      [],
      "a permalink focus frame queued before thread navigation must not scroll the parent channel afterward",
    );
  } finally {
    globalThis.requestAnimationFrame = originalGlobalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalGlobalCancelAnimationFrame;
    window.requestAnimationFrame = originalWindowRequestAnimationFrame;
    window.cancelAnimationFrame = originalWindowCancelAnimationFrame;
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("desktop Forward note matches the mobile input and action controls", async () => {
  const source = makeChannel();
  const target = makeChannel({ id: "target-channel", name: "target" });
  const message = makeMessage({ id: "message-desktop-note" });
  const forwarded = makeMessage({ id: "forwarded-desktop-note", channelId: target.id, content: "Forwarded payload" });
  let postedBody: unknown = null;

  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/messages/forward");
    postedBody = body;
    return { data: { results: [{ destinationChannelId: target.id, status: "success", message: forwarded }] } };
  }) as typeof api.post;

  renderForwardPanel(source, [message], { channels: [source, target], dmChannels: [] });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  const dialog = await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getAllByTestId("forward-target-target-channel")[0]);

  const noteActions = screen.getByTestId("forward-desktop-note-actions");
  const textarea = screen.getByLabelText("Optional note") as HTMLTextAreaElement;
  const send = noteActions.querySelector<HTMLButtonElement>('button[aria-label="Send forward"]');
  assert.ok(send);
  assert.ok(dialog.contains(noteActions));
  assert.ok(noteActions.contains(textarea));
  assert.equal(textarea.getAttribute("placeholder"), "Add a note");
  assert.equal(textarea.getAttribute("maxLength"), "4000");
  assert.match(textarea.className, /\btext-base\b/);
  assert.match(textarea.className, /\bmd:text-sm\b/);
  assert.match(send.className, /size-7/);
  assert.match(send.className, /bg-brutal-pink/);
  assert.equal(send.getAttribute("aria-label"), "Send forward");
  assert.equal(send.querySelector("svg")?.getAttribute("width"), "14");
  assert.equal(noteActions.querySelector('button[title="Attach image"]'), null);
  assert.equal(noteActions.querySelector('button[title="Attach file"]'), null);

  changeTextareaValue(textarea, "Please ask @HelperBot and see #release-notes");
  assert.equal(screen.queryByTestId("mention-autocomplete-popover"), null);
  assert.equal(screen.queryByTestId("channel-autocomplete-popover"), null);

  await act(async () => {
    fireEvent.click(send);
  });

  assert.deepEqual(postedBody, {
    destinationChannelIds: ["target-channel"],
    requestId: (postedBody as { requestId: string }).requestId,
    sourceMessageIds: ["message-desktop-note"],
    note: "Please ask @HelperBot and see #release-notes",
  });
  assert.equal(typeof (postedBody as { requestId?: unknown }).requestId, "string");
  assert.equal(hasTestId("forward-composer-dialog"), false);
});

test("desktop Forward note reuses composer autocomplete without attachment controls", async () => {
  const source = makeChannel();
  const target = makeChannel({ id: "target-channel", name: "target" });
  const releaseNotes = makeChannel({ id: "release-notes", name: "release-notes" });
  const helper = makeAgent({ id: "agent-helper", name: "HelperBot", displayName: "Helper Bot" });
  renderForwardPanel(source, [makeMessage({ id: "message-note-autocomplete" })], {
    channels: [source, target, releaseNotes],
    dmChannels: [],
    serverMembers: [makeServerMember({ userId: "user-peer", name: "PeerHuman", displayName: "Peer Human" })],
    agents: [helper],
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getByTestId("forward-target-target-channel"));

  const noteActions = screen.getByTestId("forward-desktop-note-actions");
  const textarea = screen.getByLabelText("Optional note") as HTMLTextAreaElement;
  assert.equal(noteActions.querySelector('button[title="Attach image"]'), null);
  assert.equal(noteActions.querySelector('button[title="Attach file"]'), null);

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@Hel", selectionStart: 4, selectionEnd: 4 } });
  });
  assert.ok(await screen.findByTestId("mention-autocomplete-popover"));
  assert.ok(screen.getByText("Helper Bot"));

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "#rel", selectionStart: 4, selectionEnd: 4 } });
  });
  const channelPopover = await screen.findByTestId("channel-autocomplete-popover");
  assert.ok(within(channelPopover).getByText("release-notes"));
});

test("Forward note mention autocomplete scopes one private destination and de-scopes multi-target drafts", async () => {
  const source = makeChannel();
  const privateTarget = makeChannel({ id: "private-target", name: "private-target", type: "private" });
  const publicTarget = makeChannel({ id: "public-target", name: "public-target" });
  const privateHuman = {
    id: "private-user",
    serverId: "server-forward",
    serverName: "Forward Server",
    serverSlug: "forward-server",
    name: "PrivateHuman",
    displayName: "Private Human",
    description: null,
    avatarUrl: null,
    gravatarHash: "",
    role: "member",
    serverRole: "member",
    channelRole: "member",
    effectiveChannelRole: "member",
    channelAdminBasis: null,
    canChangeChannelRole: false,
  };
  renderForwardPanel(source, [makeMessage({ id: "message-private-note-autocomplete" })], {
    channels: [source, privateTarget, publicTarget],
    dmChannels: [],
    serverMembers: [makeServerMember({ userId: "server-user", name: "ServerHuman", displayName: "Server Human" })],
    agents: [makeAgent({ id: "agent-server", name: "ServerBot", displayName: "Server Bot" })],
    channelMembers: {
      "private-target": { humans: [privateHuman], agents: [] },
    },
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  const textarea = screen.getByLabelText("Optional note") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@S", selectionStart: 2, selectionEnd: 2 } });
  });
  assert.ok(await screen.findByText("Server Human"));
  assert.ok(screen.getByText("Server Bot"));
  assert.equal(screen.queryByText("Private Human"), null);

  fireEvent.click(screen.getByTestId("forward-target-private-target"));
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
  });
  assert.ok(await screen.findByText("Private Human"));
  assert.equal(screen.queryByText("Server Human"), null);
  assert.equal(screen.queryByText("Server Bot"), null);

  fireEvent.click(screen.getByTestId("forward-target-public-target"));
  await waitFor(() => assert.equal(screen.queryByText("Private Human"), null));
  assert.ok(screen.getByText("Server Human"));
  assert.ok(screen.getByText("Server Bot"));

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@S", selectionStart: 2, selectionEnd: 2 } });
  });
  assert.ok(await screen.findByText("Server Human"));
  assert.ok(screen.getByText("Server Bot"));
  assert.equal(screen.queryByText("Private Human"), null);
});

test("Forward note mention autocomplete scopes joint destinations and clears stale rosters", async () => {
  const source = makeChannel();
  const jointTarget = makeChannel({ id: "joint-target", name: "joint-target", type: "joint" });
  const publicTarget = makeChannel({ id: "joint-public-target", name: "joint-public-target" });
  const jointHuman = {
    id: "joint-user",
    serverId: "peer-server",
    serverName: "Peer Server",
    serverSlug: "peer-server",
    name: "JointHuman",
    displayName: "Joint Human",
    description: null,
    avatarUrl: null,
    gravatarHash: "",
    role: "member",
    serverRole: "member",
    channelRole: "member",
    effectiveChannelRole: "member",
    channelAdminBasis: null,
    canChangeChannelRole: false,
  };
  renderForwardPanel(source, [makeMessage({ id: "message-joint-note-autocomplete" })], {
    channels: [source, jointTarget, publicTarget],
    dmChannels: [],
    serverMembers: [makeServerMember({ userId: "server-user", name: "ServerHuman", displayName: "Server Human" })],
    agents: [makeAgent({ id: "agent-server", name: "ServerBot", displayName: "Server Bot" })],
    channelMembers: {
      "joint-target": { humans: [jointHuman], agents: [] },
    },
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getByTestId("forward-target-joint-target"));
  const textarea = screen.getByLabelText("Optional note") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
  });
  assert.ok(await screen.findByText("Joint Human"));
  assert.equal(screen.queryByText("Server Human"), null);
  assert.equal(screen.queryByText("Server Bot"), null);

  fireEvent.click(screen.getByTestId("forward-target-joint-public-target"));
  await waitFor(() => assert.equal(screen.queryByText("Joint Human"), null));
  assert.ok(screen.getByText("Server Human"));
  assert.ok(screen.getByText("Server Bot"));
});

test("Forward note clears its synthetic draft when the composer closes", async () => {
  const source = makeChannel();
  const target = makeChannel({ id: "draft-cleanup-target", name: "draft-cleanup-target" });
  const message = makeMessage({ id: "message-draft-cleanup" });
  renderForwardPanel(source, [message], { channels: [source, target], dmChannels: [] });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getByTestId("forward-target-draft-cleanup-target"));
  const textarea = screen.getByLabelText("Optional note") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "abandoned forward note" } });

  const draftKey = `forward-note:${source.id}:${message.id}`;
  await waitFor(() => assert.equal(useMessageStore.getState().drafts[draftKey], "abandoned forward note"));

  fireEvent.click(screen.getByRole("button", { name: "Close forward composer" }));

  await waitFor(() => assert.equal(useMessageStore.getState().drafts[draftKey], undefined));
});



test("forward composer sends canonical multi-target batches without an Open action", async () => {
  const source = makeChannel();
  const targetA = makeChannel({ id: "target-a", name: "alpha" });
  const targetB = makeChannel({ id: "target-b", name: "beta" });
  const postedBodies: Array<{ destinationChannelIds: string[]; requestId: string }> = [];

  api.post = (async (url: string, body?: unknown) => {
    if (url !== "/messages/forward") return { data: {} };
    postedBodies.push(body as { destinationChannelIds: string[]; requestId: string });
    return {
      data: {
        results: [targetA, targetB].map((target, index) => ({
          destinationChannelId: target.id,
          status: "success",
          message: makeMessage({ id: `forwarded-${index}`, channelId: target.id }),
        })),
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [makeMessage({ id: "message-multi-target" })], {
    channels: [source, targetA, targetB],
    dmChannels: [],
  });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  const composerHeading = screen.getByTestId("forward-composer-dialog").querySelector("h2");
  assert.equal(composerHeading?.textContent, "Forward");
  assert.equal(composerHeading?.classList.contains("uppercase"), false);
  const targetSearch = screen.getByPlaceholderText("Search targets");
  assert.match(targetSearch.parentElement?.className ?? "", /\bshadow-brutal-sm\b/);
  assert.match(targetSearch.parentElement?.className ?? "", /\bfocus-within:shadow-brutal\b/);
  assert.match(screen.getByTestId("forward-desktop-note-actions").className, /\bp-3\b/);
  fireEvent.click(screen.getByTestId("forward-target-target-a"));
  fireEvent.click(screen.getByTestId("forward-target-target-b"));
  await waitFor(() => assert.ok(screen.getByTestId("forward-desktop-note-actions").querySelector('button[aria-label="Send forward"]')));
  assert.match(screen.getByTestId("forward-composer-dialog").textContent ?? "", /2 selected/);

  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });

  assert.deepEqual(postedBodies.map((body) => body.destinationChannelIds), [["target-a", "target-b"]]);
  assert.equal(typeof postedBodies[0]?.requestId, "string");
  await waitFor(() => assert.match(getForwardToastText(), /Forwarded to 2 destinations/));
  const forwardViewport = document.querySelector(".forward-toast-viewport");
  const forwardRoot = forwardViewport?.querySelector('[data-slot="toast"]');
  assert.match(forwardViewport?.className ?? "", /\btop-4\b/);
  assert.match(forwardViewport?.className ?? "", /\bflex\b/);
  assert.match(forwardViewport?.className ?? "", /w-\[min\(24rem,calc\(100vw-1rem\)\)\]/);
  assert.match(forwardViewport?.className ?? "", /h-\[var\(--toast-frontmost-height\)\]/);
  assert.match(forwardViewport?.className ?? "", /max-w-\[calc\(100vw-1rem\)\]/);
  assert.match(forwardRoot?.className ?? "", /\babsolute\b/);
  assert.match(forwardRoot?.className ?? "", /\bw-full\b/);
  assert.match(forwardRoot?.className ?? "", /\btop-0\b/);
  assert.match(forwardRoot?.className ?? "", /\bbottom-auto\b/);
  assert.match(forwardRoot?.className ?? "", /\borigin-top\b/);
  assert.match(
    forwardRoot?.className ?? "",
    /--toast-y:calc\(var\(--toast-offset-y\)\+\(var\(--toast-index\)\*var\(--toast-gap\)\)\+var\(--toast-swipe-movement-y\)\)/,
  );
  assert.match(
    forwardRoot?.className ?? "",
    /var\(--toast-index\)\*var\(--toast-peek\)/,
  );
  assert.match(forwardRoot?.className ?? "", /data-\[starting-style\].*translateY\(-120%\)/);
  const forwardTitle = forwardRoot?.querySelector('[data-slot="toast-title"]');
  assert.match(forwardTitle?.className ?? "", /\bwhitespace-normal\b/);
  assert.match(forwardTitle?.className ?? "", /\bbreak-words\b/);
  assert.doesNotMatch(forwardRoot?.className ?? "", /\brelative\b/);
  assert.match(
    document.querySelector('[data-slot="toast-viewport"]:not(.forward-toast-viewport)')?.className ?? "",
    /\bbottom-4\b/,
  );
  assert.equal(document.querySelector(".forward-toast-viewport [data-slot=\"toast-action\"]"), null);
  assert.equal(hasTestId("forward-composer-dialog"), false);
  assert.ok(useMessageStore.getState().channelMessages[targetA.id]?.some((item) => item.id === "forwarded-0"));
  assert.ok(useMessageStore.getState().channelMessages[targetB.id]?.some((item) => item.id === "forwarded-1"));
});

test("mobile Forward opens a full-page note and send step without a drawer", async () => {
  useMobileViewport();
  const source = makeChannel();
  const target = makeChannel({ id: "mobile-target", name: "mobile-target" });
  const messages = Array.from({ length: 4 }, (_, index) => makeMessage({
    id: `mobile-source-${index}`,
    content: `Mobile source ${index}`,
    seq: index + 1,
  }));

  renderForwardPanel(source, messages, { channels: [source, target], dmChannels: [] });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  const targetPage = await screen.findByTestId("forward-mobile-target-page");
  assert.equal(hasTestId("forward-composer-dialog"), false);
  assert.match(targetPage.textContent ?? "", /Select destinations/);
  assert.ok(screen.getByRole("button", { name: "Select multiple" }));

  const searchInput = screen.getByPlaceholderText("Search targets");
  assert.equal(searchInput.getAttribute("data-slot"), "input", "mobile destination search should reuse Raft UI Input");
  assert.doesNotMatch(searchInput.className, /\btext-(?:sm|base)\b/, "Forward should not override canonical input typography");
  searchInput.focus();
  assert.equal(document.activeElement, searchInput);
  fireEvent.click(screen.getByTestId("forward-target-mobile-target"));
  const notePage = await screen.findByTestId("forward-mobile-note-page");
  assert.equal(hasTestId("forward-mobile-target-page"), false);
  assert.equal(hasTestId("forward-mobile-preview-sheet"), false);
  assert.equal(document.querySelector('[data-slot="bottom-sheet-content"]'), null);
  assert.equal(document.querySelector('[data-slot="bottom-sheet-overlay"]'), null);
  assert.match(notePage.className, /\bfixed\b/);
  assert.match(notePage.className, /\btop-0\b/);
  assert.match(notePage.className, /\bbottom-0\b/);
  assert.match(notePage.textContent ?? "", /Add a note/);
  assert.match(notePage.textContent ?? "", /Send to #mobile-target/);
  assert.notEqual(document.activeElement, searchInput);
  assert.equal(notePage.querySelectorAll('[data-testid="forwarded-bundle-item"]').length, 4);
  assert.match(notePage.textContent ?? "", /Forwarded\s*4 messages/);
  const viewAll = screen.getByRole("button", { name: "View all 4 messages" });
  assert.ok(viewAll.querySelector("svg"), "View all should include its navigation icon");
  assert.doesNotMatch(notePage.textContent ?? "", /3 of 4 messages shown/);
  assert.ok(screen.getByTestId("forwarded-bundle-fade"));
  assert.equal(viewAll, notePage.querySelector('[data-testid="forwarded-bundle-toggle"]'));
  const scrollFlow = screen.getByTestId("forward-mobile-note-scroll");
  const noteLayout = screen.getByTestId("forward-mobile-note-layout");
  const previewContent = screen.getByTestId("forward-mobile-preview-content");
  const actions = screen.getByTestId("forward-mobile-preview-actions");
  assert.match(scrollFlow.className, /overflow-y-auto/);
  assert.match(scrollFlow.className, /overscroll-contain/);
  assert.match(noteLayout.className, /overflow-hidden/);
  assert.match(noteLayout.className, /flex-col/);
  assert.ok(scrollFlow.contains(previewContent));
  assert.equal(scrollFlow.contains(actions), false);
  assert.ok(noteLayout.contains(actions));
  assert.equal(
    scrollFlow.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.match(actions.className, /shrink-0/);
  assert.match(actions.className, /border-t-2/);
  assert.match(actions.className, /bg-white/);
  assert.match(actions.className, /pb-\[max\(12px,env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(actions.className, /fixed|sticky|mt-4/);
  const mobileSend = screen.getByRole("button", { name: "Send forward" });
  assert.match(mobileSend.className, /size-7/);
  assert.match(mobileSend.className, /bg-brutal-pink/);
  assert.equal(mobileSend.getAttribute("aria-label"), "Send forward");
  assert.equal(mobileSend.querySelector("svg")?.getAttribute("width"), "14");
  assert.ok(actions.contains(screen.getByLabelText("Optional note")));
  assert.equal(actions.querySelector('button[title="Attach image"]'), null);
  assert.equal(actions.querySelector('button[title="Attach file"]'), null);

  const note = screen.getByLabelText("Optional note");
  assert.match(note.className, /\btext-base\b/, "editable text must remain 16px to prevent iOS focus zoom");
  assert.equal(note.getAttribute("maxLength"), "4000");
  fireEvent.click(viewAll);
  const detail = await screen.findByTestId("forward-mobile-detail-page");
  assert.notEqual(document.activeElement, note);
  assert.equal(detail.querySelectorAll('[data-testid="forwarded-bundle-item"]').length, 4);
  assert.match(detail.textContent ?? "", /Forwarded messages/);

  fireEvent.click(screen.getByRole("button", { name: "Back to forward preview" }));
  await screen.findByTestId("forward-mobile-note-page");
  assert.equal(hasTestId("forward-mobile-detail-page"), false);
  assert.equal(hasTestId("forward-mobile-preview-sheet"), false);
  assert.equal(document.querySelector('[data-slot="bottom-sheet-overlay"]'), null);
  fireEvent.click(screen.getByRole("button", { name: "Back to destinations" }));
  await screen.findByTestId("forward-mobile-target-page");
  assert.equal(hasTestId("forward-mobile-note-page"), false);
});

test("mobile Forward pins the complete note actions to the iOS visual viewport", async () => {
  useMobileViewport();
  const viewport = Object.assign(new window.EventTarget(), {
    width: 390,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    onresize: null,
    onscroll: null,
    onscrollend: null,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport as unknown as VisualViewport,
  });

  const source = makeChannel();
  const target = makeChannel({ id: "mobile-keyboard-target", name: "mobile-keyboard-target" });
  const messages = Array.from({ length: 4 }, (_, index) => makeMessage({
    id: `mobile-keyboard-source-${index}`,
    content: `Mobile keyboard source ${index}`,
    seq: index + 1,
  }));
  renderForwardPanel(source, messages, { channels: [source, target], dmChannels: [] });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  fireEvent.click(await screen.findByTestId("forward-target-mobile-keyboard-target"));
  const notePage = await screen.findByTestId("forward-mobile-note-page");
  const scroll = await screen.findByTestId("forward-mobile-note-scroll");
  const actions = screen.getByTestId("forward-mobile-preview-actions");
  const note = screen.getByLabelText("Optional note");
  await waitFor(() => assert.equal(document.activeElement, note));

  assert.equal(notePage.style.height, "", "without a keyboard the full layout viewport remains authoritative");
  assert.equal(scroll.contains(actions), false, "the preview scroll area must never own or hide the action footer");
  assert.ok(notePage.contains(actions));
  assert.match(actions.className, /shrink-0/);

  viewport.height = window.innerHeight - 300;
  viewport.offsetTop = 24;
  await act(async () => {
    viewport.dispatchEvent(new Event("resize"));
  });
  assert.equal(notePage.style.top, "24px");
  assert.equal(notePage.style.bottom, "auto");
  assert.equal(notePage.style.height, `${window.innerHeight - 300}px`);
  assert.ok(notePage.contains(actions), "the footer stays inside the keyboard-clamped visual viewport");

  viewport.height = window.innerHeight;
  viewport.offsetTop = 0;
  await act(async () => {
    viewport.dispatchEvent(new Event("resize"));
  });
  assert.equal(notePage.style.top, "", "keyboard dismissal must restore the layout viewport without a stale offset");
  assert.equal(notePage.style.bottom, "");
  assert.equal(notePage.style.height, "");
});

test("mobile Forward preview opens source-authorized images and file attachments", async () => {
  useMobileViewport();
  const source = makeChannel();
  const target = makeChannel({ id: "mobile-attachment-target", name: "mobile-attachment-target" });
  const imageId = "mobile-preview-image";
  const fileId = "mobile-preview-file";
  const requestedUrls: string[] = [];
  const message = makeMessage({
    id: "mobile-attachment-source",
    attachments: [
      {
        id: imageId,
        filename: "fixture.png",
        mimeType: "image/png",
        sizeBytes: 123,
        width: 640,
        height: 480,
      },
      {
        id: fileId,
        filename: "fixture.pdf",
        mimeType: "application/pdf",
        sizeBytes: 456,
      },
    ],
  });
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  let downloadedFilename = "";
  HTMLAnchorElement.prototype.click = function click() {
    downloadedFilename = this.download;
  };
  try {
    renderForwardPanel(source, [message], { channels: [source, target], dmChannels: [] });
    const defaultPanelGet = api.get;
    api.get = (async (url: string, config?: unknown) => {
      if (url.startsWith("/attachments/")) {
        requestedUrls.push(url);
        return { data: { url: `https://attachments.example/${encodeURIComponent(url)}` } };
      }
      return defaultPanelGet(url, config);
    }) as typeof api.get;
    fireEvent.click(await screen.findByTestId("select-mode-forward"));
    fireEvent.click(await screen.findByTestId("forward-target-mobile-attachment-target"));

    fireEvent.click(await screen.findByRole("button", { name: "Open fixture.png" }));
    const lightbox = useImageLightboxStore.getState();
    assert.equal(lightbox.isOpen, true);
    assert.equal(lightbox.images[0]?.id, imageId);

    fireEvent.click(screen.getByRole("button", { name: "Open fixture.pdf" }));
    await waitFor(() => assert.ok(requestedUrls.includes(`/attachments/${fileId}/url?disposition=attachment`)));
    assert.equal(downloadedFilename, "fixture.pdf");
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
});

test("mobile Forward multi-select requires Done and sends only from the note page", async () => {
  useMobileViewport();
  const source = makeChannel();
  const targetA = makeChannel({ id: "mobile-target-a", name: "alpha" });
  const targetB = makeChannel({ id: "mobile-target-b", name: "beta" });
  const message = makeMessage({ id: "mobile-multi-source", content: "Send this from mobile" });
  let postedBody: { destinationChannelIds: string[]; note: string } | null = null;

  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/messages/forward");
    postedBody = body as { destinationChannelIds: string[]; note: string };
    return {
      data: {
        results: [targetA, targetB].map((target, index) => ({
          destinationChannelId: target.id,
          status: "success",
          message: makeMessage({ id: `mobile-forwarded-${index}`, channelId: target.id }),
        })),
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [message], { channels: [source, targetA, targetB], dmChannels: [] });

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-mobile-target-page");
  fireEvent.click(screen.getByRole("button", { name: "Select multiple" }));
  const firstMultiTargetPage = screen.getByTestId("forward-mobile-target-page");
  const firstMultiHeader = firstMultiTargetPage.querySelector("header");
  const firstMultiCancel = firstMultiTargetPage.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
  const firstMultiDone = firstMultiTargetPage.querySelector<HTMLButtonElement>('button[aria-label="Done"]');
  assert.ok(firstMultiHeader);
  assert.ok(firstMultiCancel);
  assert.ok(firstMultiDone);
  assert.ok(firstMultiHeader.contains(firstMultiCancel));
  assert.ok(firstMultiHeader.contains(firstMultiDone));
  assert.equal(firstMultiTargetPage.querySelector("footer"), null);
  assert.equal(screen.queryByRole("button", { name: "Close forward target selection" }), null);

  fireEvent.click(firstMultiCancel);
  assert.ok(screen.getByRole("button", { name: "Close forward target selection" }));
  assert.ok(screen.getByRole("button", { name: "Select multiple" }));
  assert.equal(screen.queryByRole("button", { name: "Done" }), null);

  fireEvent.click(screen.getByRole("button", { name: "Select multiple" }));
  fireEvent.click(screen.getByTestId("forward-target-mobile-target-a"));
  fireEvent.click(screen.getByTestId("forward-target-mobile-target-b"));
  assert.match(screen.getByTestId("forward-mobile-target-page").textContent ?? "", /2 selected/);
  assert.equal(hasTestId("forward-mobile-note-page"), false);

  const mobileTargetPage = screen.getByTestId("forward-mobile-target-page");
  const multiCancel = mobileTargetPage.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
  const multiDone = mobileTargetPage.querySelector<HTMLButtonElement>('button[aria-label="Done"]');
  assert.ok(multiCancel);
  assert.ok(multiDone);
  const multiHeader = mobileTargetPage.querySelector("header");
  assert.ok(multiHeader);
  assert.ok(multiHeader.contains(multiCancel));
  assert.ok(multiHeader.contains(multiDone));
  assert.equal(mobileTargetPage.querySelector("footer"), null);
  assert.match(multiCancel.className, /size-7/);
  assert.match(multiDone.className, /size-7/);
  assert.match(multiDone.className, /bg-brutal-pink/);
  assert.equal(multiCancel.getAttribute("aria-label"), "Cancel");
  assert.equal(multiDone.getAttribute("aria-label"), "Done");
  assert.equal(multiCancel.querySelector("svg")?.getAttribute("width"), "14");
  assert.equal(multiDone.querySelector("svg")?.getAttribute("width"), "14");

  fireEvent.click(multiDone);
  await screen.findByTestId("forward-mobile-note-page");
  fireEvent.change(screen.getByLabelText("Optional note"), { target: { value: "Mobile note" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send forward" }));
  });

  assert.deepEqual(postedBody?.destinationChannelIds, ["mobile-target-a", "mobile-target-b"]);
  assert.equal(postedBody?.note, "Mobile note");
  await waitFor(() => assert.equal(hasTestId("forward-mobile-target-page"), false));
  assert.equal(hasTestId("forward-mobile-note-page"), false);
});

test("forward request errors use server-code copy and keep destinations selected", async () => {
  const source = makeChannel();
  const target = makeChannel({ id: "error-target", name: "error-target" });
  api.post = (async (url: string) => {
    if (url !== "/messages/forward") return { data: {} };
    throw {
      response: {
        data: {
          code: "cross_source_bundle",
          error: "Forwarded bundles must come from a single source",
        },
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [makeMessage({ id: "message-coded-error" })], {
    channels: [source, target],
    dmChannels: [],
  });
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getByTestId("forward-target-error-target"));

  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });

  assert.equal(hasTestId("forward-composer-dialog"), true);
  assert.equal(screen.getByTestId("forward-selected-count").textContent, "1 selected");
  await waitFor(() => assert.match(getForwardToastText(), /Select messages from one conversation or thread\./));
  assert.doesNotMatch(getForwardToastText(), /No resolved destination was retried/);
});

test("partial retry keeps only failed canonical targets and reuses resolution plus request identity", async () => {
  const source = makeChannel();
  const localTarget = makeChannel({
    id: "local-target",
    name: "settled-helper",
    type: "dm",
    peerName: "settled-helper",
    peerDisplayName: "Settled Helper",
    peerType: "agent",
  });
  const resolvedDm = makeChannel({
    id: "resolved-dm",
    name: "new-helper",
    type: "dm",
    peerName: "new-helper",
    peerDisplayName: "New Helper",
    peerType: "agent",
  });
  const postedBodies: Array<{ destinationChannelIds: string[]; requestId: string }> = [];
  let openDmCalls = 0;

  useChannelStore.setState({
    openDM: async (agentId: string) => {
      openDmCalls += 1;
      if (agentId === "settled-helper-agent") return localTarget;
      return resolvedDm;
    },
  });
  api.post = (async (url: string, body?: unknown) => {
    if (url !== "/messages/forward") return { data: {} };
    const posted = body as { destinationChannelIds: string[]; requestId: string };
    postedBodies.push(posted);
    if (postedBodies.length === 1) {
      return {
        data: {
          results: [
            {
              destinationChannelId: localTarget.id,
              status: "success",
              message: makeMessage({ id: "forwarded-local", channelId: localTarget.id }),
            },
            {
              destinationChannelId: resolvedDm.id,
              status: "failed",
              code: "forward_failed",
              error: "Could not forward to this target",
            },
          ],
        },
      };
    }
    if (postedBodies.length === 2) throw new Error("response lost");
    return {
      data: {
        results: [{
          destinationChannelId: resolvedDm.id,
          status: "success",
          message: makeMessage({ id: "forwarded-remote", channelId: resolvedDm.id }),
        }],
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [makeMessage({ id: "message-partial-retry" })], {
    channels: [source],
    dmChannels: [localTarget],
  });
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getByTestId("forward-target-local-target"));

  const baseGet = api.get;
  api.get = (async (url: string, config?: { params?: { q?: string } }) => {
    if (url === "/messages/forward/targets/search") {
      const settledAlias = config?.params?.q === "settled helper";
      return {
        data: {
          targets: [{
            type: "agent",
            channelType: null,
            id: settledAlias ? "settled-helper-agent" : "new-helper-agent",
            title: settledAlias ? "@Settled Helper" : "@New Helper",
            subtitle: "agent",
            avatarUrl: null,
            channelId: null,
            joined: null,
            dmExists: false,
            canForwardNow: false,
            requiredAction: "create_dm",
          }],
        },
      };
    }
    return baseGet(url, config);
  }) as typeof api.get;
  fireEvent.change(screen.getByPlaceholderText("Search targets"), { target: { value: "new helper" } });
  fireEvent.click(await screen.findByTestId("forward-search-target-agent-new-helper-agent"));

  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });
  await waitFor(() => assert.equal(screen.getByTestId("forward-selected-count").textContent, "1 selected"));
  assert.equal(openDmCalls, 1);
  assert.deepEqual(postedBodies[0]?.destinationChannelIds, [localTarget.id, resolvedDm.id]);
  assert.match(getForwardToastText(), /Forwarded to 1 destination\. 1 still needs attention\. Try the remaining destinations\./);
  assert.ok(useMessageStore.getState().channelMessages[localTarget.id]?.some((item) => item.id === "forwarded-local"));

  fireEvent.change(screen.getByPlaceholderText("Search targets"), { target: { value: "settled helper" } });
  fireEvent.click(await screen.findByTestId("forward-search-target-agent-settled-helper-agent"));
  assert.equal(screen.getByTestId("forward-selected-count").textContent, "2 selected");

  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });
  await waitFor(() => assert.equal(screen.getByTestId("forward-selected-count").textContent, "1 selected"));
  assert.equal(openDmCalls, 2, "retry must reuse the failed resolution and resolve the reselected alias once");
  assert.deepEqual(postedBodies.map((body) => body.destinationChannelIds), [
    [localTarget.id, resolvedDm.id],
    [resolvedDm.id],
  ]);
  assert.equal(postedBodies[0]?.requestId, postedBodies[1]?.requestId);

  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });
  assert.deepEqual(postedBodies.map((body) => body.destinationChannelIds), [
    [localTarget.id, resolvedDm.id],
    [resolvedDm.id],
    [resolvedDm.id],
  ]);
  assert.equal(postedBodies[0]?.requestId, postedBodies[2]?.requestId);
  assert.ok(useMessageStore.getState().channelMessages[resolvedDm.id]?.some((item) => item.id === "forwarded-remote"));
  assert.equal(hasTestId("forward-composer-dialog"), false);
});

test("existing DM and unresolved peer alias converge to one canonical delivery", async () => {
  const source = makeChannel();
  const existingDm = makeChannel({
    id: "existing-dm",
    name: "same-person",
    type: "dm",
    peerName: "same-person",
    peerDisplayName: "Same Person",
    peerType: "human",
  });
  const postedBodies: Array<{ destinationChannelIds: string[]; requestId: string }> = [];
  let openUserDmCalls = 0;

  useChannelStore.setState({
    openUserDM: async () => {
      openUserDmCalls += 1;
      return existingDm;
    },
  });
  api.post = (async (url: string, body?: unknown) => {
    if (url !== "/messages/forward") return { data: {} };
    postedBodies.push(body as { destinationChannelIds: string[]; requestId: string });
    return {
      data: {
        results: [{
          destinationChannelId: existingDm.id,
          status: "success",
          message: makeMessage({ id: "forwarded-existing-dm", channelId: existingDm.id }),
        }],
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [makeMessage({ id: "message-alias-convergence" })], {
    channels: [source],
    dmChannels: [existingDm],
  });
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  fireEvent.click(screen.getByTestId("forward-target-existing-dm"));

  const baseGet = api.get;
  api.get = (async (url: string, config?: unknown) => {
    if (url === "/messages/forward/targets/search") {
      return {
        data: {
          targets: [{
            type: "human",
            channelType: null,
            id: "same-person-user",
            title: "@Same Person",
            subtitle: "human",
            avatarUrl: null,
            channelId: null,
            joined: null,
            dmExists: false,
            canForwardNow: false,
            requiredAction: "create_dm",
          }],
        },
      };
    }
    return baseGet(url, config as never);
  }) as typeof api.get;
  fireEvent.change(screen.getByPlaceholderText("Search targets"), { target: { value: "same person" } });
  fireEvent.click(await screen.findByTestId("forward-search-target-human-same-person-user"));

  await act(async () => {
    fireEvent.click(getForwardSendButton());
  });

  assert.equal(openUserDmCalls, 1);
  assert.deepEqual(postedBodies.map((body) => body.destinationChannelIds), [[existingDm.id]]);
  assert.equal(
    useMessageStore.getState().channelMessages[existingDm.id]?.filter((message) => message.id === "forwarded-existing-dm").length,
    1,
  );
  assert.equal(hasTestId("forward-composer-dialog"), false);
});

test("public Join action reports progress, blocks duplicate submission, and resolves before send", async () => {
  const source = makeChannel();
  const joinableLabel = "#joinable-channel-with-a-name-that-must-not-push-the-action-out-of-the-alert";
  const joinedTarget = makeChannel({ id: "joinable-target", name: joinableLabel.slice(1) });
  let joinCalls = 0;
  let postCalls = 0;
  let resolveJoin!: (joined: boolean) => void;

  useChannelStore.setState({
    joinChannel: () => {
      joinCalls += 1;
      return new Promise<boolean>((resolve) => {
        resolveJoin = (joined) => {
          if (joined) {
            useChannelStore.setState((state) => {
              const { [joinedTarget.id]: _reconciled, ...channelLocalMembership } = state.channelLocalMembership;
              void _reconciled;
              return {
                channels: [...state.channels, { ...joinedTarget, joined: true }],
                channelLocalMembership,
              };
            });
          }
          resolve(joined);
        };
      });
    },
  });
  api.post = (async (url: string) => {
    if (url !== "/messages/forward") return { data: {} };
    postCalls += 1;
    return {
      data: {
        results: [{
          destinationChannelId: joinedTarget.id,
          status: "success",
          message: makeMessage({ id: "forwarded-joined", channelId: joinedTarget.id }),
        }],
      },
    };
  }) as typeof api.post;

  renderForwardPanel(source, [makeMessage({ id: "message-join-confirm" })], {
    channels: [source],
    dmChannels: [],
  });
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  const initialDialog = await screen.findByTestId("forward-composer-dialog");
  assert.ok(initialDialog.className.includes("md:w-[min(clamp(48rem,60vw,60rem),calc(100vw-2rem))]"));
  assert.ok(initialDialog.className.includes("md:h-[min(clamp(30rem,72dvh,46rem),calc(100dvh-2rem))]"));
  const baseGet = api.get;
  api.get = (async (url: string, config?: unknown) => {
    if (url === "/messages/forward/targets/search") {
      return {
        data: {
          targets: [{
            type: "channel",
            channelType: "channel",
            id: joinedTarget.id,
            title: joinableLabel,
            subtitle: "",
            avatarUrl: null,
            channelId: joinedTarget.id,
            joined: false,
            dmExists: null,
            canForwardNow: false,
            requiredAction: "join_channel",
          }],
        },
      };
    }
    return baseGet(url, config as never);
  }) as typeof api.get;

  async function selectJoinTarget() {
    fireEvent.change(screen.getByPlaceholderText("Search targets"), { target: { value: "joinable" } });
    fireEvent.click(await screen.findByTestId("forward-search-target-channel-joinable-target"));
  }

  await selectJoinTarget();
  assert.equal(screen.getByRole("button", { name: "Join selected channels first" }).hasAttribute("disabled"), true);
  assert.equal(screen.queryByRole("checkbox", { name: "Confirm joining selected public channels" }), null);
  const dialogClose = screen.getByRole("button", { name: "Close forward composer" });
  assert.ok(dialogClose.querySelector("svg"), "desktop close should include its icon");
  assert.equal(dialogClose.querySelector("svg")?.getAttribute("width"), "16");
  fireEvent.click(dialogClose);
  assert.equal(joinCalls, 0);
  assert.equal(postCalls, 0);

  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  await selectJoinTarget();
  const joinBanner = screen.getByTestId("forward-join-banner");
  const joinButton = screen.getByRole("button", { name: "Join selected public channels" });
  assert.match(joinBanner.className, /items-center/);
  assert.ok(joinBanner.contains(joinButton));
  assert.ok(joinButton.querySelector("svg"));
  const joinCopy = joinBanner.querySelector("[title]");
  assert.ok(joinCopy);
  assert.match(joinCopy.className, /truncate/);
  assert.equal(joinCopy.getAttribute("title"), `Join ${joinableLabel} before forwarding.`);

  fireEvent.click(joinButton);
  fireEvent.click(joinButton);
  assert.equal(joinCalls, 1);
  const joiningButton = screen.getByRole("button", { name: "Join selected public channels" });
  assert.equal(joiningButton.hasAttribute("disabled"), true);
  assert.ok(joiningButton.querySelector('[role="status"]'));
  assert.match(joinBanner.textContent ?? "", /Join #joinable-channel-with-a-name/);

  await act(async () => {
    resolveJoin(true);
  });
  await waitFor(() => {
    assert.equal(screen.queryByTestId("forward-join-banner"), null);
  });
  const joinedSearchRow = screen.getByTestId("forward-search-target-channel-joinable-target");
  assert.doesNotMatch(joinedSearchRow.textContent ?? "", /Not joined/);
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Send forward" }).hasAttribute("disabled"), false));

  fireEvent.click(joinedSearchRow);
  assert.equal(screen.getByTestId("forward-selected-count").textContent, "0 selected");
  fireEvent.click(joinedSearchRow);
  assert.equal(screen.getByTestId("forward-selected-count").textContent, "1 selected");
  assert.equal(screen.queryByTestId("forward-join-banner"), null);
  assert.doesNotMatch(joinedSearchRow.textContent ?? "", /Not joined/);
  assert.equal(joinCalls, 1);

  fireEvent.click(screen.getByRole("button", { name: "Close forward composer" }));
  fireEvent.click(await screen.findByTestId("select-mode-forward"));
  await screen.findByTestId("forward-composer-dialog");
  await selectJoinTarget();
  const reopenedJoinedRow = screen.getByTestId("forward-search-target-channel-joinable-target");
  assert.doesNotMatch(reopenedJoinedRow.textContent ?? "", /Not joined/);
  assert.equal(screen.queryByTestId("forward-join-banner"), null);
  assert.equal(screen.getByRole("button", { name: "Send forward" }).hasAttribute("disabled"), false);
  assert.equal(joinCalls, 1);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send forward" }));
  });
  assert.equal(joinCalls, 1);
  assert.equal(postCalls, 1);
});
