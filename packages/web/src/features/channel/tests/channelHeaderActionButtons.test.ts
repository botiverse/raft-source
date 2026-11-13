import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { createElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../../../api/client";
import { ChatPanel } from "../ChatPanel";
import type { Channel } from "../../../store/channelStore";
import { useChannelStore } from "../../../store/channelStore";
import { buildSearchPath } from "../../../hooks/useAppNavigate";
import { useMessageStore } from "../../../store/messageStore";
import { useServerStore } from "../../../store/serverStore";
import { useTaskStore } from "../../../store/taskStore";

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
    serverId: "server-search",
    name: "source",
    description: null,
    type: "channel",
    createdAt: "2026-07-02T00:00:00.000Z",
    joined: true,
    activityMuteSupported: false,
    ...overrides,
  };
}

function LocationProbe({ onChange }: { onChange: (path: string) => void }) {
  const location = useLocation();
  onChange(`${location.pathname}${location.search}`);
  return null;
}

function renderSearchHeaderPanel(channel: Channel, onPathChange: (path: string) => void) {
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;

  useServerStore.setState({
    current: {
      id: "server-search",
      name: "Search Server",
      avatarUrl: null,
      slug: "dev",
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-02T00:00:00.000Z",
    },
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [channel],
    dmChannels: [],
    channelActivity: { [channel.id]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: { [channel.id]: [] },
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

  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/dev/channel/${channel.id}`] },
      createElement(LocationProbe, { onChange: onPathChange }),
      createElement(ChatPanel, { channel }),
    ),
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  localStorage.clear();
});

test("search navigation preserves query and channel filter params", () => {
  assert.equal(buildSearchPath("/s/dev"), "/s/dev/search");
  assert.equal(
    buildSearchPath("/s/dev", undefined, { channelId: "channel-123" }),
    "/s/dev/search?channelId=channel-123",
  );
  assert.equal(
    buildSearchPath("/s/dev", "hello world", { channelId: "channel 123" }),
    "/s/dev/search?q=hello+world&channelId=channel+123",
  );
});

test("clicking regular channel header search navigates with the current channel filter", () => {
  const channel = makeChannel({ id: "channel-search-123" });
  let currentPath = "";
  renderSearchHeaderPanel(channel, (path) => {
    currentPath = path;
  });

  fireEvent.click(screen.getByLabelText("Search this channel"));

  assert.equal(
    currentPath,
    "/s/dev/search?channelId=channel-search-123&defer=1",
  );
});

