import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "../helpers/domSetup";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "../helpers/intl";
import api from "../../src/api/client";
import ChatPanel from "../../src/components/message/ChatPanel";
import { useAuthStore } from "../../src/store/authStore";
import type { User } from "../../src/store/authStore";
import { useChannelStore } from "../../src/store/channelStore";
import type { Channel } from "../../src/store/channelStore";
import { useMessageStore } from "../../src/store/messageStore";
import type { Message } from "../../src/store/messageStore";
import { useServerStore } from "../../src/store/serverStore";
import { useTaskStore } from "../../src/store/taskStore";
import { useThreadStore } from "../../src/store/threadStore";

const SERIAL = { concurrency: false };
const CHANNEL_ID = "t4a-j1-send-echo-dom";
const originalGet = api.get.bind(api);

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

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useServerStore.setState({ current: null, members: [] });
  useTaskStore.setState({ tasks: [], currentChannelId: null });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

function makeUser(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    gravatarHash: "",
    name: "owner",
    displayName: "Owner",
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
  };
}

function makeChannel(): Channel {
  return {
    id: CHANNEL_ID,
    serverId: "server-1",
    name: "general",
    description: null,
    type: "channel",
    joined: true,
    activityMuteSupported: false,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function persistedMessage(seq: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `server-${seq}`,
    seq,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "user-1",
    senderName: "Owner",
    messageType: "chat",
    content: `message ${seq}`,
    createdAt: new Date(Date.UTC(2026, 6, 10, 6, 0, seq)).toISOString(),
    ...overrides,
  };
}

function optimisticMessage(): Message {
  return {
    id: "optimistic-msg-1001",
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "user-1",
    senderName: "Owner",
    messageType: "chat",
    content: "draft body",
    createdAt: "2026-07-10T06:00:30.000Z",
    randomId: "msg-1001",
  };
}

function setChatState(channel: Channel, rows: Message[]) {
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    initialized: true,
    loading: false,
  });
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    members: [],
    billing: null,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
    },
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [channel],
    dmChannels: [],
    channelActivity: { [CHANNEL_ID]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: CHANNEL_ID,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    channelMessages: { [CHANNEL_ID]: rows },
    channelWindowMeta: {
      [CHANNEL_ID]: {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: false,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
      },
    },
    messages: rows,
    currentChannelId: CHANNEL_ID,
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
}

function visibleRowIds() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-index][data-message-id]"))
    .map((row) => row.dataset.messageId);
}

test("T4a-J1 DOM baseline: ChatPanel row list absorbs same-randomId echo without a duplicate row", SERIAL, async () => {
  const channel = makeChannel();
  setChatState(channel, [persistedMessage(1), persistedMessage(2)]);

  await act(async () => {
    render(
      <MemoryRouter>
        <ChatPanel channel={channel} readOnly />
      </MemoryRouter>,
      { wrapper: TestIntlProvider },
    );
  });

  assert.deepEqual(visibleRowIds(), ["server-1", "server-2"]);

  await act(async () => {
    useMessageStore.getState().addOptimisticMessage(optimisticMessage());
  });

  assert.deepEqual(visibleRowIds(), ["server-1", "server-2", "optimistic-msg-1001"]);
  assert.ok(screen.getByText("draft body"));

  await act(async () => {
    useMessageStore.getState().addMessage(persistedMessage(3, {
      id: "server-1001",
      content: "draft body",
      randomId: "msg-1001",
    }));
  });

  assert.deepEqual(visibleRowIds(), ["server-1", "server-2", "server-1001"]);
  assert.equal(document.querySelector('[data-message-id="optimistic-msg-1001"]'), null);
  assert.equal(document.querySelectorAll('[data-index][data-message-id="server-1001"]').length, 1);
});
