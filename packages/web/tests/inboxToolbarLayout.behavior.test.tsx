import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import MessageSearchPage from "../src/components/search/MessageSearchPage";
import TasksPanel from "../src/components/task/TasksPanel";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import PanelHeader from "../src/components/ui/PanelHeader";
import { TestIntlProvider } from "./helpers/intl";
import {
  resetActivityRuntimeForTests,
  setActivityGateForTests,
} from "../src/store/activityPanel/runtime";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxGroupCount, InboxItem } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import {
  ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
  publishServerFeatureFlagValuesFromLabsReadback,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import { triggerServerReset } from "../src/store/serverResetRegistry";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

if (typeof window.matchMedia !== "function") {
  stubDesktopViewport();
}

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const originalGet = api.get;
const originalPost = api.post;

function stubDesktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? 0) <= 1280,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function channelItem(label: string): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: `channel-${label}`,
    channelName: `${label} channel`,
    channelType: "channel",
    lastMessageId: `message-${label}`,
    latestActivitySeq: "41",
    firstUnreadMessageId: `message-${label}`,
    firstMentionMessageId: null,
    lastMessageAt: "2026-08-01T00:00:00.000Z",
    lastMessagePreview: `${label} preview`,
    lastMessageSenderType: "user",
    lastMessageSenderId: `sender-${label}`,
    lastMessageSenderName: `${label} sender`,
    unreadCount: 17,
    hasMention: false,
  };
}

function publishActivitySidebarInboxFlag(serverId: string, enabled: boolean) {
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId,
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
      name: "Activity sidebar inbox",
      description: "Activity sidebar inbox.",
      state: "open",
      enrolled: enabled,
      effective: enabled,
    }],
  });
}

function seedActivityStores(label: string, options: { channelFilterId?: string | null } = {}) {
  const serverId = `server-${label}`;
  const item = channelItem(label);
  const dmGroup: InboxGroupCount = {
    channelId: `dm-${label}`,
    channelName: `${label} dm`,
    channelType: "dm",
    count: 3,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
  };
  const channelGroup: InboxGroupCount = {
    channelId: item.channelId,
    channelName: item.channelName,
    channelType: "channel",
    count: 40,
    lastActivityAt: item.lastMessageAt,
  };
  useAuthStore.setState({
    user: {
      id: "user-current",
      name: "current",
      displayName: "Current",
      email: "current@example.com",
    } as never,
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: { id: serverId, name: "Layout", slug: `layout-${label}`, role: "owner" } as never,
    members: [],
  });
  useChannelStore.setState({ channels: [], dmChannels: [] });
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useSearchContentStore.setState({ slot: null });
  useSavedStore.setState({
    saved: [],
    savedIds: new Set(),
    loading: false,
    hasMore: false,
    total: 0,
    resultTotal: 0,
    query: "",
    channelId: null,
    sortDirection: "desc",
  });
  useThreadStore.setState({
    openParentChannelId: null,
    openParentMessageId: null,
    openThreadChannelId: null,
    focusedThreadChannelId: null,
    taskUpdatesByMessageId: {},
  });
  useTaskStore.setState({
    tasks: [],
    serverTasks: [],
    taskMetadataByMessageId: {},
    taskMessageIdByTaskId: {},
  });
  useInboxStore.setState({
    items: [item],
    acceptedWindowGeneration: `window-${label}`,
    unfollowedWindowGeneration: `window-${label}`,
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: true,
    groups: [dmGroup, channelGroup],
    filter: "all",
    channelFilterId: options.channelFilterId ?? null,
    sortDirection: "desc",
    searchQuery: "",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 43,
    totalUnreadCount: 17,
    activeUnreadCount: 17,
    focusedItemKey: null,
    pendingFocusKind: null,
  });
  return { serverId, item, dmGroup, channelGroup };
}

function renderInbox(options: { compactActivitySidebar?: boolean } = {}) {
  const slug = useServerStore.getState().current?.slug ?? "layout";
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      const state = useInboxStore.getState();
      return {
        data: {
          items: state.items,
          groups: state.groups,
          hasMore: false,
          totalCount: state.totalCount,
          totalUnreadCount: state.totalUnreadCount,
          activeUnreadCount: state.activeUnreadCount,
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    if (url === "/channels/saved/check") {
      return { data: { savedIds: [] } };
    }
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={[`/s/${slug}/activity`]}>
        <ThreadsInbox compactActivitySidebar={options.compactActivitySidebar} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function closestWithClass(element: Element, className: string): HTMLElement {
  const match = element.closest(`.${className}`);
  assert.ok(match instanceof HTMLElement, `expected an ancestor carrying .${className}`);
  return match;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useMessageStore.getState().setCurrentUserId(null);
  resetServerFeatureFlagsForTests();
  resetActivityRuntimeForTests();
  triggerServerReset();
  window.localStorage.clear();
});

test("compact Activity master/detail splits controls into two toolbar rows", () => {
  stubDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedActivityStores("compact-rows");
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");

  renderInbox({ compactActivitySidebar: true });

  const toolbar = screen.getByTestId("inbox-toolbar");
  assert.ok(toolbar.classList.contains("px-4"));
  assert.ok(toolbar.classList.contains("min-h-[88px]"));
  assert.ok(toolbar.classList.contains("flex-col"));
  assert.ok(!toolbar.classList.contains("h-[54px]"));

  const primary = screen.getByTestId("activity-master-primary-controls");
  assert.equal(primary.parentElement, toolbar);
  assert.equal(
    screen.queryByTestId("activity-master-view-controls"),
    null,
    "compact Activity must not render a separate horizontal selected-view rail",
  );
  const switcher = within(primary).getByTestId("activity-scope-switcher");
  assert.ok(switcher.classList.contains("w-full"));

  const scopeControls = screen.getByTestId("activity-master-scope-controls");
  assert.equal(scopeControls.parentElement, toolbar);
  const sortSelect = within(scopeControls).getByTestId("activity-sort-select");
  assert.ok(sortSelect.parentElement?.classList.contains("w-[116px]"));
  const markAllRead = within(scopeControls).getByTestId("inbox-mark-all-read");
  assert.ok(markAllRead.classList.contains("btn-brutal-sm"));
});

test("compact Activity menu shows the trailing scope label only after a DM/channel is selected", async () => {
  stubDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId, channelGroup } = seedActivityStores("scope-label");
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");

  renderInbox({ compactActivitySidebar: true });

  const switcher = screen.getByTestId("activity-scope-switcher");
  assert.ok(within(switcher).getByText("All"));
  assert.equal(switcher.getAttribute("title"), "All");
  assert.equal(within(switcher).queryByText(channelGroup.channelName), null);

  await act(async () => {
    useInboxStore.setState({ channelFilterId: channelGroup.channelId });
  });

  assert.ok(within(switcher).getByText(channelGroup.channelName));
  assert.equal(switcher.getAttribute("title"), channelGroup.channelName);
});

test("Activity switcher dialog keeps DMs and channels in one pinnable source list without action-like icons", () => {
  stubDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId, dmGroup, channelGroup } = seedActivityStores("switcher-dialog");
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");

  renderInbox({ compactActivitySidebar: true });

  fireEvent.click(screen.getByTestId("activity-scope-switcher"));
  const dialog = screen.getByTestId("activity-switcher-dialog");

  const groups = within(dialog).getByTestId("activity-switcher-groups");
  assert.equal(within(groups).getByTestId("activity-switcher-group-section-label").textContent, "DM and Channels");
  const sourceList = within(groups).getByTestId("activity-switcher-group-list");
  assert.ok(within(sourceList).getByTestId(`activity-switcher-group-${dmGroup.channelId}`));
  assert.ok(within(sourceList).getByTestId(`activity-switcher-group-${channelGroup.channelId}`));

  assert.equal(
    within(dialog).queryByTestId("activity-switcher-clear-channel-filter"),
    null,
    "filter rows must not carry a clear icon that reads as a read/Done action",
  );
  assert.equal(
    dialog.querySelectorAll("svg.lucide-check").length,
    0,
    "filter rows express selection through the row background, not a Done-like check icon",
  );
});

test("non-compact inbox toolbar keeps the fixed-height rail shared with the scroll body", () => {
  stubDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedActivityStores("non-compact-rail");
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");

  renderInbox();

  const toolbar = screen.getByTestId("inbox-toolbar");
  assert.ok(toolbar.classList.contains("px-4"));
  assert.ok(toolbar.classList.contains("h-[54px]"));
  assert.ok(!toolbar.classList.contains("min-h-[88px]"));
  assert.equal(screen.queryByTestId("activity-master-primary-controls"), null);

  const scroll = screen.getByTestId("inbox-scroll");
  assert.ok(scroll.classList.contains("p-4"));
  // scrollbar-quiet is half of the visible-affordance contract: overlay keeps
  // the gutter from being reserved, quiet keeps the thumb subtle-but-visible.
  // The retired source regex pinned both; dropping either must stay RED.
  assert.ok(scroll.classList.contains("scrollbar-quiet"));
  assert.ok(scroll.classList.contains("overflow-y-overlay"));
  assert.ok(!scroll.classList.contains("scrollbar-none"));

  const header = screen.getByTestId("inbox-header");
  assert.ok(header.classList.contains("h-panel-header"));
  assert.ok(header.classList.contains("gap-3"));
  assert.ok(header.classList.contains("px-5"));
});

test("PanelHeader renders the canonical main-panel horizontal padding", () => {
  render(
    <TestIntlProvider locale="en">
      <PanelHeader title="Computers" containerProps={{ "data-testid": "panel-header" }} />
    </TestIntlProvider>,
  );

  const header = screen.getByTestId("panel-header");
  for (const className of ["flex", "h-panel-header", "items-center", "gap-3", "border-b-2", "border-black", "bg-white", "px-5"]) {
    assert.ok(header.classList.contains(className), `PanelHeader header row must carry ${className}`);
  }
  for (const className of header.classList) {
    assert.ok(
      !className.startsWith("sm:"),
      `PanelHeader header row must not shrink at narrow breakpoints; found ${className}`,
    );
  }
});

test("MessageSearchPage filter toolbar shares the horizontal rail with its results", async () => {
  stubDesktopViewport();
  useAuthStore.setState({
    user: { id: "user-current", name: "current", displayName: "Current", email: "current@example.com" } as never,
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: { id: "server-search", name: "Search", slug: "search-layout", role: "owner" } as never,
    members: [],
  });
  useChannelStore.setState({ channels: [], dmChannels: [] });
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({
    openParentChannelId: null,
    openParentMessageId: null,
    openThreadChannelId: null,
  });
  window.localStorage.setItem("slock_access_token", "token");
  api.get = (async (url: string) => {
    if (url === "/messages/search") {
      return {
        data: {
          hasMore: false,
          results: [{
            id: "message-rail",
            channelId: "channel-rail",
            channelName: "rail",
            channelType: "channel",
            channelArchivedAt: null,
            senderId: "user-current",
            senderType: "user",
            senderName: "Current",
            content: "rail alignment hit",
            snippet: "rail alignment hit",
            createdAt: "2026-08-01T00:00:00.000Z",
          }],
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/s/search-layout/search?q=rail"]}>
        <MessageSearchPage />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const toolbar = closestWithClass(screen.getByRole("button", { name: "From" }), "border-b-2");
  assert.ok(toolbar.classList.contains("px-4"));
  assert.ok(toolbar.classList.contains("py-3"));
  assert.ok(!toolbar.classList.contains("px-5"));

  let result: HTMLElement | undefined;
  await waitFor(() => {
    result = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("rail alignment hit"));
    assert.ok(result, "the search hit must render inside the results rail");
  });
  const rail = result?.closest("div.p-4");
  assert.ok(rail instanceof HTMLElement, "search results must live inside the 16px content rail");
  assert.equal(rail.parentElement, toolbar.nextElementSibling);
});

test("TasksPanel filter toolbar shares the horizontal rail below the legacy px-5 header", () => {
  stubDesktopViewport();
  useTaskStore.setState({
    tasks: [],
    serverTasks: [],
    serverLoading: false,
    loadServerTasks: async () => undefined,
    registerServerTasksConsumer: () => undefined,
    unregisterServerTasksConsumer: () => undefined,
  } as never);

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <TasksPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const toolbar = closestWithClass(screen.getByRole("button", { name: /Channel/ }), "border-b-2");
  assert.ok(toolbar.classList.contains("px-4"));
  assert.ok(toolbar.classList.contains("py-3"));
  assert.ok(!toolbar.classList.contains("px-5"));

  const headerRow = closestWithClass(screen.getByRole("heading", { name: "Tasks" }), "h-panel-header");
  assert.ok(headerRow.classList.contains("px-5"));
});
