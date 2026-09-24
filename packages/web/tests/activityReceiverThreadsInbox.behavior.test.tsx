/** task #364 S2 — production ThreadsInbox consumes the receiver bundle. */
import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import {
  observeActivityBootstrap,
  resetActivityRuntimeForTests,
  setActivityGateForTests,
} from "../src/store/activityPanel/runtime";
import { decrementInboxGroupCounts, useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { useSavedStore } from "../src/store/savedStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useServerStore } from "../src/store/serverStore";
import {
  ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
  publishServerFeatureFlagValuesFromLabsReadback,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import type { SavedEntry } from "../src/store/savedStore";
import { triggerServerReset } from "../src/store/serverResetRegistry";
import { useMessageStore } from "../src/store/messageStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;
const originalPost = api.post;
const originalLoadInbox = useInboxStore.getState().loadInbox;
const originalMarkDone = useInboxStore.getState().markDone;
const originalSaveMessage = useSavedStore.getState().saveMessage;
const originalUnsaveMessage = useSavedStore.getState().unsaveMessage;
let serverSequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function channelItem(label: string, overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {}): Extract<InboxItem, { kind: "channel" | "dm" }> {
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
    ...overrides,
  };
}

function threadItem(label: string, overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {}): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: `thread-${label}`,
    parentMessageId: `parent-${label}`,
    parentChannelId: `parent-channel-${label}`,
    parentChannelName: `${label} parent`,
    parentChannelType: "channel",
    parentMessagePreview: `${label} thread parent`,
    parentMessageSenderType: "user",
    parentMessageSenderId: `parent-sender-${label}`,
    latestActivityPreview: `${label} thread reply`,
    latestActivitySenderType: "user",
    latestActivitySenderId: `sender-${label}`,
    latestActivityMessageId: `message-${label}`,
    latestActivitySeq: "41",
    firstUnreadMessageId: `message-${label}`,
    firstMentionMessageId: null,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    lastReplyAt: "2026-08-01T00:00:00.000Z",
    replyCount: 2,
    unreadCount: 3,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function savedThreadEntry(label: string, overrides: Partial<SavedEntry> = {}): SavedEntry {
  return {
    messageId: `message-${label}`,
    channelId: `thread-${label}`,
    channelName: `${label} thread`,
    channelType: "thread",
    content: `${label} saved reply`,
    senderType: "user",
    senderId: `sender-${label}`,
    senderName: `${label} sender`,
    createdAt: "2026-08-02T00:00:00.000Z",
    savedAt: "2026-08-02T00:00:00.000Z",
    parentChannelId: `parent-channel-${label}`,
    parentChannelName: `${label} parent`,
    parentChannelType: "channel",
    parentMessageId: `parent-${label}`,
    parentMessagePreview: `${label} saved parent`,
    parentMessageSenderType: "user",
    parentMessageSenderId: `parent-sender-${label}`,
    replyCount: 4,
    ...overrides,
  };
}

function hasTextContent(text: string) {
  return (_content: string, element: Element | null) => element?.textContent?.includes(text) ?? false;
}

function hasAnyTextContent(text: string) {
  return screen.getAllByText(hasTextContent(text)).length > 0;
}

function coreRow(label: string) {
  return {
    rowId: `row-${label}`,
    rowVersion: "50",
    latestActivitySeq: "9007199254740993",
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    unreadCount: 6,
    hasMention: false,
    firstUnreadMessageId: `first-${label}`,
    firstMentionMessageId: null,
    maxReadSeq: "48",
    readStateVersion: "49",
    type: "channel",
    channelId: `channel-${label}`,
    channelName: `${label} channel`,
    channelKind: "private",
    lastMessageId: `message-${label}`,
    lastMessagePreview: `${label} preview`,
    lastMessageSenderKind: "agent",
    lastMessageSenderId: `sender-${label}`,
    lastMessageSenderName: `${label} sender`,
  };
}

function activitySnapshot(
  requestId: string,
  label: string,
  serverId: string,
  principalId = "user-current",
) {
  return {
    type: "snapshot",
    requestId,
    scope: { serverId, principalId, filter: "all", windowId: "main" },
    epoch: "1",
    watermark: "9007199254740995",
    activityVersion: "77",
    window: {
      rows: [coreRow(label)],
      tombstones: [],
      nextCursor: null,
      hasMore: false,
      complete: true,
      totalCount: 1,
      totalUnreadCount: 6,
    },
  };
}

function setDesktopViewport() {
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

function setNarrowDesktopViewport() {
  window.matchMedia = ((query: string) => {
    const minWidth = Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? 0);
    return {
      matches: minWidth <= 900,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

function seedStores(label: string, options: { receipts?: boolean | "preserve"; legacyHasMore?: boolean } = {}) {
  serverSequence += 1;
  const serverId = `server-${serverSequence}`;
  const legacy = channelItem(label);
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
    current: { id: serverId, name: "S2", slug: `s2-${serverSequence}`, role: "owner" } as never,
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
  const generation = `window-${label}`;
  useInboxStore.setState({
    items: [legacy],
    ...(options.receipts === "preserve" ? {} : {
      acceptedWindowGeneration: options.receipts === false ? "" : generation,
      unfollowedWindowGeneration: options.receipts === false ? null : generation,
    }),
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: true,
    groups: [{
      channelId: legacy.channelId,
      channelName: `Legacy ${label} group`,
      channelType: "joint",
      count: 40,
      lastActivityAt: "2026-07-01T00:00:00.000Z",
    }],
    filter: "all",
    channelFilterId: null,
    sortDirection: "desc",
    searchQuery: "",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: options.legacyHasMore ?? true,
    totalCount: 40,
    totalUnreadCount: 17,
    activeUnreadCount: 17,
    focusedItemKey: null,
    pendingFocusKind: null,
    loadInbox: originalLoadInbox,
  });
  return { serverId, legacy };
}

async function seedCore(
  gate: "on" | "shadow",
  label: string,
  serverId: string,
  principalId = "user-current",
) {
  setActivityGateForTests(gate);
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      return { data: activitySnapshot(config?.params?.requestId ?? "missing", label, serverId, principalId) };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  await observeActivityBootstrap();
}

function renderInbox(options: {
  post?: typeof api.post;
  compactActivitySidebar?: boolean;
  onOpenItem?: (item: InboxItem) => void;
  locale?: "en" | "zh-cn";
} = {}) {
  const slug = useServerStore.getState().current?.slug ?? "s2";
  api.post = (async (...args: Parameters<typeof api.post>) => {
    const [url] = args;
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    if (url === "/channels/saved/check") {
      return { data: { savedIds: [] } };
    }
    if (options.post) return options.post(...args);
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;
  return render(
    <TestIntlProvider locale={options.locale ?? "en"}>
      <MemoryRouter initialEntries={[`/s/${slug}/activity`]}>
        <ThreadsInbox
          compactActivitySidebar={options.compactActivitySidebar}
          onOpenItem={options.onOpenItem}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("Activity sidebar uses the finalized Chinese Saved label", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("saved-zh", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");

  renderInbox({ locale: "zh-cn" });

  const savedNav = await screen.findByTestId("activity-nav-saved");
  assert.equal(savedNav.getAttribute("title"), "已保存");
  assert.ok(within(savedNav).getByText("已保存"));
  assert.equal(within(savedNav).queryByText("已收藏"), null);
});

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

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useInboxStore.setState({ loadInbox: originalLoadInbox, markDone: originalMarkDone });
  useSavedStore.setState({
    saveMessage: originalSaveMessage,
    unsaveMessage: originalUnsaveMessage,
  });
  useMessageStore.getState().setCurrentUserId(null);
  resetServerFeatureFlagsForTests();
  resetActivityRuntimeForTests();
  triggerServerReset();
  window.localStorage.clear();
});

test("ThreadsInbox visibly consumes core rows/count and core pagination from the SAME bundle", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId, legacy } = seedStores("legacy-sentinel", { legacyHasMore: true });
  await seedCore("on", "core-sentinel", serverId);
  let paginationCalls = 0;
  useInboxStore.setState({
    loadInbox: async () => {
      paginationCalls += 1;
    },
  });

  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("core-sentinel preview")));

  assert.equal(screen.queryByText(legacy.lastMessagePreview), null, "legacy row must not splice beside core");
  assert.ok(
    screen.getByText("1 active · 6 unread"),
    "core totals are visible through the legacy Inbox chrome",
  );
  assert.equal(screen.queryByText("40 active · 17 unread"), null, "legacy totals cannot survive a core row switch");

  const scroll = screen.getByTestId("inbox-scroll");
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 100 },
    scrollTop: { configurable: true, value: 90 },
    clientHeight: { configurable: true, value: 10 },
  });
  fireEvent.scroll(scroll);
  assert.equal(
    paginationCalls,
    0,
    "legacy hasMore=true/cursor must not page after the same core bundle supplied hasMore=false/cursor=null",
  );
});

test("the legacy surface visibly consumes BOTH core totals from the same receiver bundle", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("legacy-totals", { legacyHasMore: true });
  await seedCore("on", "core-totals", serverId);

  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("core-totals preview")));
  assert.ok(
    screen.getByText("1 active · 6 unread"),
    "totalCount and totalUnreadCount must both come from the same Core bundle",
  );
  assert.equal(screen.queryByText("40 active · 17 unread"), null);
});

test("Activity sidebar consumes receiver groups and drives current inbox filters", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("legacy-sidebar", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  await seedCore("on", "current-sidebar", serverId);
  let reloads = 0;
  useInboxStore.setState({
    loadInbox: async () => {
      reloads += 1;
    },
  });

  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("current-sidebar preview")));

  assert.ok(screen.getByTestId("activity-current-sidebar"));
  assert.equal(screen.queryByTestId("activity-v2"), null, "retired v2 surface must not be revived");
  assert.ok(screen.getByTestId("activity-group-channel-current-sidebar"));
  assert.equal(
    screen.queryByText("Legacy legacy-sidebar group"),
    null,
    "sidebar groups must come from the same receiver bundle as the visible rows",
  );

  const reloadsBeforeGroupClick = reloads;
  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-group-channel-current-sidebar"));
  });
  assert.equal(useInboxStore.getState().filter, "all");
  assert.equal(useInboxStore.getState().channelFilterId, "channel-current-sidebar");
  await waitFor(() => assert.ok(reloads > reloadsBeforeGroupClick));

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-nav-mentions"));
  });
  assert.equal(useInboxStore.getState().filter, "mentions");
  assert.equal(
    useInboxStore.getState().channelFilterId,
    "channel-current-sidebar",
    "top Activity views must preserve the lower channel facet until it is explicitly cleared",
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-nav-unread"));
  });
  assert.equal(useInboxStore.getState().filter, "unread");
});

test("decrementing another Activity group preserves an existing zero-count facet identity", () => {
  const retainedGroup = {
    channelId: "channel-retained-zero",
    channelName: "Retained Zero Channel",
    channelType: "channel" as const,
    count: 0,
  };
  const removedItem = channelItem("removed-group");

  assert.deepEqual(
    decrementInboxGroupCounts([
      retainedGroup,
      {
        channelId: removedItem.channelId,
        channelName: removedItem.channelName,
        channelType: removedItem.channelType,
        count: 1,
      },
    ], [removedItem]),
    [retainedGroup],
  );
});

test("decrementing the selected Activity group to zero preserves its clearable identity", () => {
  const selectedItem = channelItem("selected-last-row");

  assert.deepEqual(
    decrementInboxGroupCounts([{
      channelId: selectedItem.channelId,
      channelName: selectedItem.channelName,
      channelType: selectedItem.channelType,
      count: 1,
    }], [selectedItem], selectedItem.channelId),
    [{
      channelId: selectedItem.channelId,
      channelName: selectedItem.channelName,
      channelType: selectedItem.channelType,
      count: 0,
    }],
  );
});

test("an empty top Activity view keeps its selected channel scope visible while another row is locally suppressed", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("empty-selected-scope", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  const selectedChannelId = "channel-selected-empty";
  const selectedItem = channelItem("selected-empty", { channelId: selectedChannelId });
  const suppressedItem = channelItem("locally-read", {
    channelId: "channel-locally-read",
    readStateLatestActivitySeq: "41",
  });
  const suppressedWireItem = {
    ...suppressedItem,
    readState: {
      kind: "present",
      readStateVersion: 1,
      maxReadSeq: "0",
      latestActivity: { messageId: suppressedItem.lastMessageId, seq: "41" },
    },
  };
  useInboxStore.setState({
    items: [selectedItem, suppressedItem],
    groups: [
      {
        channelId: selectedChannelId,
        channelName: "Selected Empty Channel",
        channelType: "channel",
        count: 1,
        lastActivityAt: "2026-08-03T00:00:00.000Z",
      },
      {
        channelId: suppressedItem.channelId,
        channelName: suppressedItem.channelName,
        channelType: suppressedItem.channelType,
        count: 1,
        lastActivityAt: suppressedItem.lastMessageAt,
      },
    ],
    channelFilterId: selectedChannelId,
    totalCount: 2,
    totalUnreadCount: selectedItem.unreadCount + suppressedItem.unreadCount,
  });
  const inboxRequests: Array<Record<string, unknown>> = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url !== "/channels/inbox") throw new Error(`Unexpected GET ${url}`);
    inboxRequests.push(config?.params ?? {});
    return {
      data: {
        items: [suppressedWireItem],
        groups: [{
          channelId: suppressedItem.channelId,
          channelName: suppressedItem.channelName,
          channelType: "channel",
          count: 1,
          lastActivityAt: "2026-08-04T00:00:00.000Z",
        }],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: suppressedItem.unreadCount,
        activeUnreadCount: 3,
      },
    };
  }) as typeof api.get;

  renderInbox({
    compactActivitySidebar: true,
    post: (async () => ({ data: {} })) as typeof api.post,
  });
  assert.ok(within(screen.getByTestId("activity-scope-switcher")).getByText("Selected Empty Channel"));

  await act(async () => {
    await useInboxStore.getState().markRead(suppressedItem);
  });

  fireEvent.click(screen.getByTestId("activity-scope-switcher"));
  fireEvent.click(within(screen.getByTestId("activity-switcher-dialog")).getByTestId("activity-switcher-nav-unread"));

  await waitFor(() => assert.equal(useInboxStore.getState().loaded, true));
  assert.equal(useInboxStore.getState().filter, "unread");
  assert.equal(useInboxStore.getState().channelFilterId, selectedChannelId);
  assert.equal(inboxRequests.at(-1)?.channelId, selectedChannelId);
  assert.ok(
    within(screen.getByTestId("activity-scope-switcher")).getByText("Selected Empty Channel"),
    "the retained channel constraint must not disappear just because this view has zero matching rows",
  );

  fireEvent.click(screen.getByTestId("activity-scope-switcher"));
  const selectedGroup = within(screen.getByTestId("activity-switcher-dialog"))
    .getByTestId(`activity-switcher-group-${selectedChannelId}`);
  assert.equal(selectedGroup.getAttribute("aria-pressed"), "true");
  assert.equal(
    within(screen.getByTestId("activity-switcher-dialog"))
      .getByTestId(`activity-switcher-group-count-${selectedChannelId}`)
      .textContent,
    "0",
    "the previous view's count must not leak into the empty view",
  );
});

test("Activity clears a pre-existing orphaned channel scope instead of hiding it", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("orphaned-scope", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  useInboxStore.setState({
    items: [],
    groups: [{
      channelId: "channel-visible",
      channelName: "Visible Channel",
      channelType: "channel",
      count: 1,
      lastActivityAt: "2026-08-04T00:00:00.000Z",
    }],
    channelFilterId: "channel-orphaned",
    totalCount: 0,
    totalUnreadCount: 0,
  });
  const recovered = channelItem("recovered", { unreadCount: 0 });
  const inboxRequests: Array<Record<string, unknown>> = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url !== "/channels/inbox") throw new Error(`Unexpected GET ${url}`);
    inboxRequests.push(config?.params ?? {});
    return {
      data: {
        items: [recovered],
        groups: [{
          channelId: recovered.channelId,
          channelName: recovered.channelName,
          channelType: recovered.channelType,
          count: 1,
          lastActivityAt: recovered.lastMessageAt,
        }],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 0,
        activeUnreadCount: 0,
      },
    };
  }) as typeof api.get;

  renderInbox({ compactActivitySidebar: true });

  await waitFor(() => assert.equal(useInboxStore.getState().channelFilterId, null));
  await waitFor(() => assert.ok(screen.getByText("recovered preview")));
  assert.equal(inboxRequests.at(-1)?.channelId, undefined);
  assert.equal(
    within(screen.getByTestId("activity-scope-switcher")).queryByText("channel-orphaned"),
    null,
  );
});

test("Activity done actions stay quiet until their row is active, focused, or hovered", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("save-action-visibility", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  const inactiveItem = channelItem("save-hidden");
  const activeItem = threadItem("save-active");
  useInboxStore.setState({
    items: [inactiveItem, activeItem],
    groups: [{
      channelId: inactiveItem.channelId,
      channelName: inactiveItem.channelName,
      channelType: inactiveItem.channelType,
      count: 2,
      lastActivityAt: inactiveItem.lastMessageAt,
    }],
    totalCount: 2,
    totalUnreadCount: inactiveItem.unreadCount + activeItem.unreadCount,
  });
  useSearchContentStore.setState({ slot: { kind: "thread", id: activeItem.threadChannelId } });
  const keyboardDoneCalls: string[] = [];
  const rowOpenCalls: string[] = [];
  useInboxStore.setState({
    markDone: async (item) => {
      keyboardDoneCalls.push(item.kind === "thread" ? item.latestActivityMessageId : item.lastMessageId);
    },
  });
  renderInbox({
    compactActivitySidebar: true,
    onOpenItem: (item) => {
      rowOpenCalls.push(item.kind === "thread" ? item.threadChannelId : item.channelId);
    },
  });

  const rows = screen.getAllByTestId("inbox-row");
  const inactiveContent = within(rows[0]).getByTestId("conversation-card-content");
  const inactiveActions = within(rows[0]).getByTestId("conversation-card-actions");
  const inactiveTimestamp = within(rows[0]).getByTestId("conversation-card-timestamp");
  assert.match(inactiveContent.className, /(?:^|\s)w-full(?:\s|$)/);
  assert.match(inactiveActions.className, /(?:^|\s)absolute(?:\s|$)/);
  assert.match(inactiveActions.className, /(?:^|\s)right-3(?:\s|$)/);
  assert.match(inactiveActions.className, /(?:^|\s)top-3(?:\s|$)/);
  assert.doesNotMatch(inactiveActions.className, /(?:^|\s)shrink-0(?:\s|$)/);
  assert.match(inactiveActions.className, /(?:^|\s)bg-transparent(?:\s|$)/);
  assert.match(inactiveActions.className, /(?:^|\s)group-hover:bg-white(?:\s|$)/);
  assert.match(inactiveTimestamp.className, /(?:^|\s)group-hover:opacity-0(?:\s|$)/);
  assert.match(inactiveTimestamp.className, /(?:^|\s)group-focus-within:opacity-0(?:\s|$)/);
  assert.equal(within(rows[0]).queryByTestId("inbox-row-save"), null);

  const inactiveDone = within(rows[0]).getByTestId("inbox-row-done");
  assert.match(inactiveDone.className, /(?:^|\s)pointer-events-none(?:\s|$)/);
  assert.match(inactiveDone.className, /(?:^|\s)group-hover:pointer-events-auto(?:\s|$)/);
  fireEvent.keyDown(inactiveDone, { key: "Enter" });
  fireEvent.keyDown(inactiveDone, { key: " " });
  assert.deepEqual(keyboardDoneCalls, [inactiveItem.lastMessageId, inactiveItem.lastMessageId]);
  assert.deepEqual(rowOpenCalls, []);

  const activeDone = within(rows[1]).getByTestId("inbox-row-done");
  const activeTimestamp = within(rows[1]).getByTestId("conversation-card-timestamp");
  assert.equal(rows[1].getAttribute("data-active"), "true");
  assert.match(activeDone.className, /(?:^|\s)pointer-events-auto(?:\s|$)/);
  assert.match(activeDone.className, /(?:^|\s)opacity-100(?:\s|$)/);
  assert.match(activeTimestamp.className, /(?:^|\s)opacity-0(?:\s|$)/);
  assert.match(within(rows[1]).getByTestId("conversation-card-actions").className, /(?:^|\s)bg-white(?:\s|$)/);
  assert.equal(within(rows[1]).queryByTestId("inbox-row-save"), null);
});

test("Activity thread task badges consume canonical task-domain metadata instead of the retired cache", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("task-domain-badge", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  const item = threadItem("task-domain-badge", {
    taskNumber: 34,
    taskStatus: "todo",
    taskClaimedByName: null,
  });
  useInboxStore.setState({
    items: [item],
    groups: [{
      channelId: item.parentChannelId,
      channelName: item.parentChannelName,
      channelType: item.parentChannelType,
      count: 1,
      lastActivityAt: item.lastActivityAt,
    }],
    totalCount: 1,
    totalUnreadCount: item.unreadCount,
  });
  useTaskStore.setState({
    taskMetadataByMessageId: {
      [item.parentMessageId]: {
        messageId: item.parentMessageId,
        taskNumber: 55,
        status: "done",
        claimedByName: "Cody",
      },
    },
  });
  assert.deepEqual(useThreadStore.getState().taskUpdatesByMessageId, {});

  renderInbox({ compactActivitySidebar: true });

  const badge = await screen.findByTestId("conversation-card-task-badge");
  assert.match(badge.textContent ?? "", /#55/);
  assert.match(badge.textContent ?? "", /@Cody/);
});

test("Activity sidebar exposes protocol Saved and Done views", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("protocol-sidebar", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  const activeThread = threadItem("save-source", {
    parentMessagePreview: "save-source protocol thread parent",
    latestActivityPreview: "protocol source reply",
  });
  const savedEntry = savedThreadEntry("saved-protocol");
  const doneThread = threadItem("done-protocol", { unreadCount: 0 });
  useInboxStore.setState({
    items: [activeThread],
    groups: [{
      channelId: "parent-channel-saved-protocol",
      channelName: "Saved Protocol",
      channelType: "channel",
      count: 2,
      lastActivityAt: "2026-08-02T00:00:00.000Z",
    }, {
      channelId: "channel-active-only",
      channelName: "Active Only",
      channelType: "channel",
      count: 1,
      lastActivityAt: "2026-08-01T00:00:00.000Z",
    }],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 3,
    searchQuery: "protocol",
    sortDirection: "asc",
  });
  useSavedStore.setState({
    saved: [savedEntry],
    savedIds: new Set([savedEntry.messageId]),
    loading: false,
    hasMore: false,
    total: 1,
    resultTotal: 1,
    query: "",
    channelId: null,
    sortDirection: "desc",
  });
  let savedRequestParams: Record<string, unknown> | undefined;
  let doneRequestParams: Record<string, unknown> | undefined;
  let inboxRefreshCalls = 0;
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === "/channels/saved") {
      savedRequestParams = config?.params;
      return {
        data: {
          saved: [savedEntry],
          hasMore: false,
          total: 1,
          globalTotal: 1,
        },
      };
    }
    if (url === "/channels/inbox/done") {
      doneRequestParams = config?.params;
      return {
        data: {
          items: [doneThread],
          hasMore: false,
          totalCount: 1,
          totalUnreadCount: 0,
          nextCursor: null,
        },
      };
    }
    if (url === "/channels/inbox") {
      inboxRefreshCalls += 1;
      return {
        data: {
          items: [activeThread],
          groups: [{
            channelId: "parent-channel-saved-protocol",
            channelName: "Saved Protocol",
            channelType: "channel",
            count: 2,
            lastActivityAt: "2026-08-02T00:00:00.000Z",
          }, {
            channelId: "channel-active-only",
            channelName: "Active Only",
            channelType: "channel",
            count: 1,
            lastActivityAt: "2026-08-01T00:00:00.000Z",
          }],
          hasMore: false,
          totalCount: 1,
          totalUnreadCount: 3,
          activeUnreadCount: 3,
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  let restoredPayload: unknown = null;

  renderInbox({
    post: (async (url: string, body?: unknown) => {
      if (url === "/channels/threads/undone") {
        restoredPayload = body;
        return { data: { ok: true } };
      }
      throw new Error(`Unexpected POST ${url}`);
    }) as typeof api.post,
  });
  await waitFor(() => assert.ok(hasAnyTextContent("save-source protocol thread parent")));

  assert.ok(screen.getByTestId("activity-nav-saved"));
  assert.ok(screen.getByTestId("activity-nav-done"));
  assert.ok(screen.getByTestId("inbox-mark-all-read"));
  const searchInput = screen.getByTestId("activity-search-input") as HTMLInputElement;
  assert.equal(useInboxStore.getState().searchQuery, "protocol");
  assert.equal(searchInput.value, "protocol");
  assert.ok(screen.getAllByText("protocol", { exact: false }).length > 0);
  assert.ok(
    Array.from(document.querySelectorAll("mark")).some((mark) => mark.textContent?.toLowerCase() === "protocol"),
    "matching Activity row text should be highlighted while search is active",
  );

  assert.notEqual(screen.getByTestId("activity-sort-select").tagName, "SELECT");
  assert.equal(useInboxStore.getState().sortDirection, "asc");
  assert.ok(screen.getByTestId("activity-group-count-parent-channel-saved-protocol"));

  assert.equal(screen.queryByLabelText("Save thread"), null);

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-nav-saved"));
  });
  await waitFor(() => assert.ok(hasAnyTextContent("saved-protocol saved parent")));
  await waitFor(() => assert.equal(savedRequestParams?.q, "protocol"));
  assert.equal(savedRequestParams?.sort, "asc");
  assert.equal(screen.queryByTestId("inbox-mark-all-read"), null);
  assert.ok(
    screen.getByTestId("activity-group-channel-active-only"),
    "Saved must preserve the mixed Activity source list instead of shrinking navigation to saved results",
  );
  assert.equal(
    screen.queryByTestId("activity-group-count-parent-channel-saved-protocol"),
    null,
    "Saved facets must not show the unrelated active Activity count",
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-group-parent-channel-saved-protocol"));
  });
  assert.equal(useInboxStore.getState().channelFilterId, "parent-channel-saved-protocol");
  assert.ok(hasAnyTextContent("saved-protocol saved parent"), "lower channel facet must preserve the selected Saved top view");
  await waitFor(() => assert.equal(savedRequestParams?.channelId, "parent-channel-saved-protocol"));

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-nav-done"));
  });
  await waitFor(() => assert.ok(hasAnyTextContent("done-protocol thread parent")));
  await waitFor(() => assert.equal(doneRequestParams?.q, "protocol"));
  assert.equal(doneRequestParams?.sort, "asc");
  assert.equal(doneRequestParams?.channelId, "parent-channel-saved-protocol");
  assert.equal(screen.queryByTestId("inbox-mark-all-read"), null);
  assert.ok(
    screen.getByTestId("activity-group-channel-active-only"),
    "Done must preserve the mixed Activity source list instead of replacing it with only sources that have Done results",
  );

  const inboxRefreshCallsBeforeRestore = inboxRefreshCalls;
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Restore to Activity"));
  });
  await waitFor(() => assert.deepEqual(restoredPayload, { threadChannelId: "thread-done-protocol" }));
  await waitFor(() => assert.ok(inboxRefreshCalls > inboxRefreshCallsBeforeRestore));
});

test("Activity search stays hidden until the local find shortcut opens it", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("search-shortcut", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  useInboxStore.setState({
    items: [threadItem("search-shortcut", { parentMessagePreview: "shortcut searchable parent" })],
    groups: [],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 1,
  });

  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("shortcut searchable parent")));
  assert.equal(screen.queryByTestId("activity-search-input"), null);

  await act(async () => {
    fireEvent.keyDown(window, { key: "f", metaKey: true });
  });
  const searchInput = await screen.findByTestId("activity-search-input") as HTMLInputElement;
  await waitFor(() => assert.ok(
    document.activeElement === searchInput,
    "Activity find shortcut should focus the local search input",
  ));
});

test("Activity sidebar keeps a compact rail at narrow desktop widths", async () => {
  setNarrowDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("narrow-sidebar", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  useInboxStore.setState({
    items: [threadItem("narrow-sidebar", { unreadCount: 0, firstUnreadMessageId: null })],
    groups: [{
      channelId: "parent-channel-narrow-sidebar",
      channelName: "Narrow Sidebar Channel",
      channelType: "channel",
      count: 2,
      lastActivityAt: "2026-08-02T00:00:00.000Z",
    }],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 1,
  });

  renderInbox();
  await waitFor(() => assert.ok(screen.getByTestId("activity-current-sidebar")));

  const sidebar = screen.getByTestId("activity-current-sidebar");
  assert.ok(sidebar.className.includes("w-16"), "narrow desktop Activity rail should not keep the full sidebar width");
  assert.ok(sidebar.className.includes("lg:w-56"), "full Activity sidebar labels should return only at wider desktop widths");

  const allNav = screen.getByTestId("activity-nav-all");
  const allNavLabel = within(allNav).getByText("All");
  assert.equal(allNav.getAttribute("title"), "All");
  assert.ok(allNavLabel.className.includes("sr-only"));
  assert.ok(allNavLabel.className.includes("lg:not-sr-only"));

  const channelGroup = screen.getByTestId("activity-group-parent-channel-narrow-sidebar");
  assert.equal(channelGroup.getAttribute("title"), "Narrow Sidebar Channel");
  const channelGroupLabel = within(channelGroup).getByText("Narrow Sidebar Channel");
  assert.ok(channelGroupLabel.className.includes("sr-only"));
  assert.ok(channelGroupLabel.className.includes("lg:not-sr-only"));

  await act(async () => {
    fireEvent.click(screen.getByTestId("inbox-row"));
  });
  assert.equal(
    useThreadStore.getState().openThreadChannelId,
    null,
    "narrow desktop should not open the embedded thread pane and crush the Activity list",
  );
});

test("Activity master-detail uses a top switcher that opens the complete Activity sidebar modal", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("compact-master", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  useInboxStore.setState({
    items: [channelItem("compact-master", { unreadCount: 0, firstUnreadMessageId: null })],
    groups: [{
      channelId: "channel-compact-master",
      channelName: "Compact Master Channel",
      channelType: "channel",
      count: 2,
      lastActivityAt: "2026-08-02T00:00:00.000Z",
    }],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 0,
  });
  api.get = (async (url: string) => {
    if (url === "/channels/saved") {
      return { data: { saved: [], hasMore: false, total: 0, globalTotal: 0 } };
    }
    if (url === "/channels/inbox") {
      return {
        data: {
          items: [channelItem("compact-master", { unreadCount: 0, firstUnreadMessageId: null })],
          groups: [{
            channelId: "channel-compact-master",
            channelName: "Compact Master Channel",
            channelType: "channel",
            count: 2,
            lastActivityAt: "2026-08-02T00:00:00.000Z",
          }],
          hasMore: false,
          totalCount: 1,
          totalUnreadCount: 0,
          activeUnreadCount: 0,
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  renderInbox({ compactActivitySidebar: true });
  await waitFor(() => assert.ok(screen.getByTestId("activity-scope-switcher")));

  const toolbar = screen.getByTestId("inbox-toolbar");
  assert.ok(toolbar.className.includes("flex-col"), "compact Activity toolbar must keep view and action controls on separate rows");
  assert.ok(toolbar.className.includes("min-h-[88px]"), "compact Activity toolbar must reserve two-row height");
  assert.equal(screen.queryByTestId("activity-master-view-controls"), null, "compact Activity toolbar should not render a duplicate horizontal selected-view rail");
  assert.equal(screen.queryByTestId("activity-current-sidebar"), null);
  assert.equal(screen.queryByTestId("activity-scope-select"), null);
  const primaryControls = screen.getByTestId("activity-master-primary-controls");
  const switcher = within(primaryControls).getByTestId("activity-scope-switcher");
  assert.ok(within(switcher).getByText("All"), "full-width filter menu should keep the leading view label visible");
  assert.equal(
    within(switcher).queryByText("DM and Channels"),
    null,
    "full-width filter menu should not show the DM/channel scope label until a group is selected",
  );
  assert.ok(screen.queryByTestId("activity-switcher-dialog") === null);

  await act(async () => {
    fireEvent.click(switcher);
  });
  const savedDialog = screen.getByTestId("activity-switcher-dialog");
  assert.ok(within(savedDialog).getByTestId("activity-switcher-nav-all"));
  assert.ok(within(savedDialog).getByTestId("activity-switcher-nav-saved"));
  assert.equal(within(savedDialog).getByTestId("activity-switcher-group-section-label").textContent, "DM and Channels");
  assert.equal(within(savedDialog).queryByTestId("activity-switcher-clear-channel-filter"), null);
  assert.ok(within(savedDialog).getByTestId("activity-switcher-group-list"));

  await act(async () => {
    fireEvent.click(within(savedDialog).getByTestId("activity-switcher-nav-saved"));
  });
  assert.equal(screen.queryByTestId("activity-switcher-dialog"), null);
  assert.ok(within(screen.getByTestId("activity-scope-switcher")).getByText("Saved"));

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-scope-switcher"));
  });
  const savedEmptyDialog = screen.getByTestId("activity-switcher-dialog");
  assert.ok(
    within(savedEmptyDialog).getByTestId("activity-switcher-group-channel-compact-master"),
    "Saved must preserve the mixed source navigation even when that source has no saved result",
  );

  await act(async () => {
    fireEvent.click(within(savedEmptyDialog).getByTestId("activity-switcher-nav-all"));
  });
  assert.equal(screen.queryByTestId("activity-switcher-dialog"), null);
  assert.ok(within(screen.getByTestId("activity-scope-switcher")).getByText("All"));

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-scope-switcher"));
  });
  const dialog = screen.getByTestId("activity-switcher-dialog");

  await act(async () => {
    fireEvent.click(within(dialog).getByTestId("activity-switcher-group-channel-compact-master"));
  });
  assert.equal(screen.queryByTestId("activity-switcher-dialog"), null);
  assert.ok(within(screen.getByTestId("activity-scope-switcher")).getByText("All"));
  assert.ok(within(screen.getByTestId("activity-scope-switcher")).getByText("Compact Master Channel"));
  assert.equal(useInboxStore.getState().channelFilterId, "channel-compact-master");

  await act(async () => {
    fireEvent.click(screen.getByTestId("activity-scope-switcher"));
  });
  const selectedDialog = screen.getByTestId("activity-switcher-dialog");
  const selectedChannelRow = within(selectedDialog).getByTestId("activity-switcher-group-row-channel-compact-master");
  assert.equal(
    within(selectedChannelRow).getByTestId("activity-switcher-group-channel-compact-master").getAttribute("aria-pressed"),
    "true",
    "selected DM/channel row should expose the active state on the row control",
  );
  assert.equal(
    within(selectedChannelRow).queryByTestId("activity-switcher-clear-channel-filter"),
    null,
    "selected DM/channel row should not add a clear icon that resembles an Activity action",
  );

  await act(async () => {
    fireEvent.click(within(selectedChannelRow).getByTestId("activity-switcher-group-channel-compact-master"));
  });
  assert.equal(screen.queryByTestId("activity-switcher-dialog"), null);
  assert.equal(useInboxStore.getState().channelFilterId, null);
  assert.equal(
    within(screen.getByTestId("activity-scope-switcher")).queryByText("Compact Master Channel"),
    null,
    "full-width filter menu should hide the DM/channel label after toggling off the selected row",
  );
});

test("Activity sidebar keeps DMs and channels in one pinnable source list with compact counts", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("dm-groups", { legacyHasMore: false });
  publishActivitySidebarInboxFlag(serverId, true);
  setActivityGateForTests("off");
  const dmItem = channelItem("current-dm", {
    kind: "dm",
    channelId: "dm-current-sidebar",
    channelName: "@Current DM",
    channelType: "dm",
    lastMessagePreview: "direct activity preview",
  });
  useInboxStore.setState({
    items: [dmItem],
    groups: [
      {
        channelId: "channel-current-sidebar",
        channelName: "#Current channel",
        channelType: "channel",
        count: 104,
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  useChannelStore.setState({
    dmChannels: [{
      id: "dm-current-sidebar",
      serverId,
      name: "@Current DM",
      description: null,
      type: "dm",
      createdAt: "2026-08-01T00:00:00.000Z",
      peerType: "user",
      peerId: "user-current-dm",
      peerName: "current-dm",
      peerDisplayName: "Current DM",
      peerDescription: null,
      peerAvatarUrl: "/avatars/current-dm.png",
      peerGravatarHash: null,
    }],
  });

  renderInbox();
  await waitFor(() => assert.ok(screen.getByTestId("activity-current-sidebar")));

  assert.equal(screen.getByTestId("activity-current-group-section-label").textContent, "DM and Channels");

  const sourceList = screen.getByTestId("activity-current-group-list");
  const dmGroup = within(sourceList).getByTestId("activity-group-dm-current-sidebar");
  assert.ok(within(dmGroup).getByTestId("activity-group-dm-avatar-dm-current-sidebar"));
  assert.equal(within(dmGroup).queryByTestId("activity-group-dm-fallback-dm-current-sidebar"), null);

  const channelGroup = within(sourceList).getByTestId("activity-group-channel-current-sidebar");
  assert.ok(within(channelGroup).getByTestId("activity-group-channel-icon-channel-current-sidebar"));
  const channelCount = within(channelGroup).getByTestId("activity-group-count-channel-current-sidebar");
  assert.equal(channelCount.textContent, "99+");
  assert.equal(channelCount.getAttribute("aria-label"), "104");
});

test("Activity sidebar chrome stays behind its server flag and ignores hidden channel filters", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const { serverId } = seedStores("flag-off", { legacyHasMore: false });
  useInboxStore.setState({ channelFilterId: "channel-hidden-filter" });
  await seedCore("on", "flag-off-core", serverId);

  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("flag-off-core preview")));

  assert.equal(screen.queryByTestId("activity-current-sidebar"), null);
  assert.equal(screen.queryByTestId("activity-current-groups"), null);
  assert.ok(
    screen.getByTestId("inbox-filter-all"),
    "default-off Activity must keep the existing segmented toolbar",
  );
  assert.equal(
    screen.queryByTestId("activity-selected-channel-filter"),
    null,
    "hidden sidebar channel filters must not leak into the default Activity chrome",
  );
});

for (const gate of ["off", "shadow"] as const) {
  test(`ThreadsInbox gate ${gate.toUpperCase()} stays wholly legacy-visible even with a core-shaped sentinel`, async () => {
    setDesktopViewport();
    resetServerFeatureFlagsForTests();
    const { serverId, legacy } = seedStores(`${gate}-legacy`, { legacyHasMore: false });
    if (gate === "shadow") await seedCore("shadow", `${gate}-core`, serverId);
    else setActivityGateForTests("off");

    renderInbox();
    await waitFor(() => assert.ok(screen.getByText(legacy.lastMessagePreview)));
    assert.equal(screen.queryByText(`${gate}-core preview`), null);
    assert.ok(screen.getByText("40 active · 17 unread"));
  });
}

test("a real server reset clears old receipts before a NEW scope's core sentinel can be visible", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  const first = seedStores("old-scope");
  await seedCore("on", "old-core", first.serverId);
  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("old-core preview")));

  let second!: ReturnType<typeof seedStores>;
  await act(async () => {
    triggerServerReset();
    // Preserve whatever receipt state the REAL reset left behind. If its
    // invalidation is deleted, the old equal pair survives and wrongly
    // authorises the new scope's otherwise healthy Core window.
    second = seedStores("new-scope", { receipts: "preserve", legacyHasMore: false });
    await seedCore("on", "new-core", second.serverId);
  });

  await waitFor(() => assert.ok(screen.getByText(second.legacy.lastMessagePreview)));
  assert.equal(
    screen.queryByText("new-core preview"),
    null,
    "new Core authority cannot pair with receipts that belonged to the old server",
  );
  assert.equal(useInboxStore.getState().acceptedWindowGeneration, "");
  assert.equal(useInboxStore.getState().unfollowedWindowGeneration, null);
});

test("principal switch cannot re-authorize the old Core scope while new receipts beat the new bootstrap", async () => {
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  useMessageStore.getState().setCurrentUserId("principal-a");
  const first = seedStores("principal-a-legacy");
  await seedCore("on", "principal-a-core", first.serverId, "principal-a");
  renderInbox();
  await waitFor(() => assert.ok(screen.getByText("principal-a-core preview")));

  // Issue one more A bootstrap and hold its response across the principal
  // transition. No newer bootstrap exists yet, so generation/principal
  // invalidation — not issuance ordering — must reject this late response.
  const lateA = deferred<{ data: ReturnType<typeof activitySnapshot> }>();
  const lateAStarted = deferred<string>();
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url !== "/channels/activity/snapshot") throw new Error(`Unexpected GET ${url}`);
    lateAStarted.resolve(config?.params?.requestId ?? "missing");
    return lateA.promise;
  }) as typeof api.get;
  const lateABootstrap = observeActivityBootstrap();
  const lateARequestId = await lateAStarted.promise;

  const principalBLegacy = channelItem("principal-b-legacy");
  await act(async () => {
    useMessageStore.getState().setCurrentUserId("principal-b");
    useAuthStore.setState((state) => ({
      user: state.user ? { ...state.user, id: "principal-b" } : state.user,
    }));
    // Model B's main and loaded-empty unfollowed responses settling before B's
    // Core snapshot. The equal receipts are healthy for B, but must never pair
    // with A's still-bound Core scope.
    useInboxStore.setState({
      items: [principalBLegacy],
      acceptedWindowGeneration: "principal-b-window",
      unfollowedItems: [],
      unfollowedLoading: false,
      unfollowedLoaded: true,
      unfollowedWindowGeneration: "principal-b-window",
      groups: [{
        channelId: principalBLegacy.channelId,
        channelName: "Principal B legacy group",
        channelType: "joint",
        count: 40,
        lastActivityAt: "2026-07-01T00:00:00.000Z",
      }],
      hasMore: false,
      totalCount: 40,
      totalUnreadCount: 17,
      activeUnreadCount: 17,
      loaded: true,
      loading: false,
      loadingMore: false,
    });
  });

  await waitFor(() => assert.ok(screen.getByText(principalBLegacy.lastMessagePreview)));
  assert.equal(
    screen.queryByText("principal-a-core preview"),
    null,
    "B receipts must not re-authorize A's previously bound Core scope",
  );

  await act(async () => {
    lateA.resolve({
      data: activitySnapshot(lateARequestId, "principal-a-late", first.serverId, "principal-a"),
    });
    await lateABootstrap;
  });
  assert.ok(screen.getByText(principalBLegacy.lastMessagePreview));
  assert.equal(
    screen.queryByText("principal-a-late preview"),
    null,
    "an A bootstrap accepted after the switch must remain impossible",
  );

  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      return {
        data: activitySnapshot(
          config?.params?.requestId ?? "missing",
          "principal-b-core",
          first.serverId,
          "principal-b",
        ),
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  await act(async () => {
    await observeActivityBootstrap();
  });

  await waitFor(() => assert.ok(screen.getByText("principal-b-core preview")));
  assert.equal(screen.queryByText(principalBLegacy.lastMessagePreview), null);
});
