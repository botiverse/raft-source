import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

const originalGet = api.get;

afterEach(() => {
  api.get = originalGet;
  cleanup();
  localStorage.clear();
  useInboxStore.setState({
    items: [],
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 0,
    totalUnreadCount: 0,
    scrollTop: 0,
    focusedItemKey: null,
  } as never);
  useMessageStore.setState({ unreadCounts: {}, drafts: {}, mentionFlags: {} });
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: true });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: true });
  useMachineStore.setState({ machines: [], loading: true });
  useServerStore.setState({ current: null, servers: [], members: [] });
  useAuthStore.setState({ user: null, loading: false, initialized: true });
});

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

function seedOwner() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      name: "owner",
      displayName: "Owner",
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      role: "owner",
    },
    servers: [],
    members: [],
    loading: false,
    sidebarOrder: { ...DEFAULT_SIDEBAR_ORDER },
  } as never);
}

test("activity panel header uses the Activity icon", () => {
  setDesktopViewport();
  seedOwner();
  useInboxStore.setState({
    items: [],
    filter: "all",
    loading: false,
    loaded: true,
    hasMore: false,
    totalCount: 0,
    totalUnreadCount: 0,
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/server/activity"]}>
      <TestIntlProvider>
        <ThreadsInbox />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const header = screen.getByTestId("inbox-header");
  const headerIcon = header.querySelector("svg.lucide-activity");
  assert.ok(headerIcon, "Activity panel header must use the Activity icon");
  assert.equal(header.querySelector("svg.lucide-message-square-text"), null);
  // Test-owned footprint. Do not import the production `size={18}` literal.
  assert.equal(headerIcon.getAttribute("width"), "18", "Activity header icon must be 18×18");
  assert.equal(headerIcon.getAttribute("height"), "18", "Activity header icon must be 18×18");
});

test("mobile sidebar Activity entry uses the Activity icon", () => {
  setDesktopViewport();
  seedOwner();

  render(
    <MemoryRouter initialEntries={["/s/server/activity"]}>
      <TestIntlProvider>
        <Sidebar mobileInline />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const sidebarEntry = screen.getByRole("button", { name: /^Activity/ });
  const sidebarIcon = sidebarEntry.querySelector("svg.lucide-activity");
  assert.ok(sidebarIcon, "sidebar Activity entry must use the Activity icon");
  assert.equal(sidebarEntry.querySelector("svg.lucide-message-square-text"), null);
  // Test-owned footprint. Do not import the production `size={14}` literal.
  assert.equal(sidebarIcon.getAttribute("width"), "14", "sidebar Activity icon must be 14×14");
  assert.equal(sidebarIcon.getAttribute("height"), "14", "sidebar Activity icon must be 14×14");
});

test("activity panel loading state renders the skeleton, not loading copy", () => {
  setDesktopViewport();
  seedOwner();
  useInboxStore.setState({
    items: [],
    filter: "all",
    loading: true,
    loaded: false,
    hasMore: true,
    totalCount: 0,
    totalUnreadCount: 0,
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/server/activity"]}>
      <TestIntlProvider>
        <ThreadsInbox />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const busy = document.querySelector('[aria-busy="true"]');
  assert.ok(busy, "loading Activity must announce busy on the skeleton container");
  assert.ok(busy.querySelector(".animate-pulse"), "loading Activity must use the shared conversation-card skeleton");
  assert.equal(screen.queryByText("Loading activity…"), null);
  assert.equal(screen.queryByText("Loading activity"), null);
});
