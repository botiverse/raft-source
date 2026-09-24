/**
 * task #58 — the visible "Unfollowed" state chip on Activity rows.
 *
 * PR #6562 deliberately removed the chip together with the legacy unfollowed
 * data leg; artin's product ruling in task #58 (2026-08-31, confirmed by
 * Aiden as superseding the frozen choice) restores the chip on the MINIMAL
 * surface: rendering only, keyed off the server-owned `isFollowing === false`
 * that rows already carry — no second data leg, no `unfollowedAt`.
 *
 * These teeth lock all three ruled acceptance axes at once so the chip can
 * never again be "fixed" by changing unfollow semantics:
 *   1. the unfollowed row STAYS in All,
 *   2. the chip is visible on it (and only on unfollowed rows),
 *   3. ordinary attention stays cleared — unfollowing shows a label, it does
 *      not resurrect unread/mention state.
 */
import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { resetActivityRuntimeForTests, setActivityGateForTests } from "../src/store/activityPanel/runtime";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem, ThreadInboxItem } from "../src/store/inboxStore";
import { useSavedStore } from "../src/store/savedStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useServerStore } from "../src/store/serverStore";
import { useMessageStore } from "../src/store/messageStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;
const originalPost = api.post;
const originalLoadInbox = useInboxStore.getState().loadInbox;
let serverSequence = 0;

function setDesktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? 0) <= 1280,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
}

function threadRow(label: string, overrides: Partial<ThreadInboxItem> = {}): ThreadInboxItem {
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
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    lastReplyAt: "2026-08-01T00:00:00.000Z",
    replyCount: 2,
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function seedStores(items: InboxItem[], totals: { totalUnreadCount: number; activeUnreadCount: number }) {
  serverSequence += 1;
  const serverId = `server-chip-${serverSequence}`;
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
    current: { id: serverId, name: "S2", slug: `s2-chip-${serverSequence}`, role: "owner" } as never,
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
    items,
    acceptedWindowGeneration: `window-chip-${serverSequence}`,
    unfollowedWindowGeneration: `window-chip-${serverSequence}`,
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: true,
    groups: [],
    filter: "all",
    channelFilterId: null,
    sortDirection: "desc",
    searchQuery: "",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: items.length,
    totalUnreadCount: totals.totalUnreadCount,
    activeUnreadCount: totals.activeUnreadCount,
    focusedItemKey: null,
    pendingFocusKind: null,
    loadInbox: originalLoadInbox,
  });
  return { serverId };
}

function renderInbox() {
  const slug = useServerStore.getState().current?.slug ?? "s2";
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    if (url === "/channels/saved/check") return { data: { savedIds: [] } };
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={[`/s/${slug}/activity`]}>
        <ThreadsInbox />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  resetActivityRuntimeForTests();
  useMessageStore.setState({ messages: {} });
});

test("an unfollowed thread row stays in All and shows the Unfollowed chip; followed rows never do", async () => {
  setDesktopViewport();
  setActivityGateForTests("off");
  seedStores(
    [
      threadRow("kept", { isFollowing: false }),
      threadRow("followed", { isFollowing: true }),
    ],
    { totalUnreadCount: 0, activeUnreadCount: 0 },
  );

  renderInbox();

  // Axis 1: the unfollowed row is retained in All.
  const keptPreview = await screen.findByText("kept thread parent");
  assert.ok(keptPreview);
  // Axis 2: the chip renders on the unfollowed row — and only there.
  const badges = await screen.findAllByTestId("conversation-card-unfollowed-badge");
  assert.equal(badges.length, 1, "exactly the unfollowed row carries the chip");
  assert.match(badges[0].textContent ?? "", /Unfollowed/);
  // Bind the chip to the unfollowed row: the badge's own inbox-row ancestor
  // must contain the unfollowed row's preview and not the followed row's.
  const chipRow = badges[0].closest("[data-testid='inbox-row']");
  assert.ok(chipRow, "the chip renders inside an inbox row");
  assert.ok(
    within(chipRow as HTMLElement).queryByText("kept thread parent"),
    "the chip sits on the unfollowed row",
  );
  assert.equal(
    within(chipRow as HTMLElement).queryByText("followed thread parent"),
    null,
    "the chip's row is not the followed row",
  );
});

test("markThreadUnfollowed keeps the row, surfaces the chip, and does not resurrect ordinary attention", async () => {
  setDesktopViewport();
  setActivityGateForTests("off");
  const followed = threadRow("live", {
    isFollowing: true,
    unreadCount: 3,
    firstUnreadMessageId: "message-live",
    hasMention: true,
  });
  seedStores([followed], { totalUnreadCount: 3, activeUnreadCount: 3 });

  renderInbox();
  assert.equal(screen.queryByTestId("conversation-card-unfollowed-badge"), null, "no chip while following");

  act(() => {
    useInboxStore.getState().markThreadUnfollowed(followed);
  });

  // Axis 1: still in All.
  assert.ok(await screen.findByText("live thread parent"));
  // Axis 2: chip visible now.
  const badge = await screen.findByTestId("conversation-card-unfollowed-badge");
  assert.match(badge.textContent ?? "", /Unfollowed/);
  // Axis 3: ordinary attention cleared, not restored by the chip.
  const state = useInboxStore.getState();
  const row = state.items.find(
    (item): item is ThreadInboxItem => item.kind === "thread" && item.threadChannelId === followed.threadChannelId,
  );
  assert.ok(row);
  assert.equal(row.isFollowing, false);
  assert.equal(row.unreadCount, 0);
  assert.equal(row.hasMention, false);
  assert.equal(row.firstUnreadMessageId, null);
  assert.equal(state.totalUnreadCount, 0);
  assert.equal(state.activeUnreadCount, 0);
});
