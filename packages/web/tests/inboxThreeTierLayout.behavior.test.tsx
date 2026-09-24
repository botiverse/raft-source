import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useThreadAgentFollowerStore } from "../src/store/threadAgentFollowerStore";

type TestFn = (t: unknown) => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn as never);

const originalGet = api.get.bind(api);

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

function makeChannelItem(overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {}): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: "channel-1",
    channelName: "design",
    channelType: "channel",
    lastMessageId: "channel-message-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-12T00:00:00.000Z",
    lastMessagePreview: "latest channel note",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "Alice",
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

function makeThreadItem(overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {}): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-message-1",
    parentChannelId: "channel-1",
    parentChannelName: "design",
    parentChannelType: "channel",
    parentMessagePreview: "thread parent topic",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "latest thread reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "thread-reply-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 2,
    lastActivityAt: "2026-07-12T00:01:00.000Z",
    lastReplyAt: "2026-07-12T00:01:00.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function seedStores(items: InboxItem[]) {
  useAuthStore.setState({ user: { id: "owner", name: "owner", displayName: "Owner" } } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "acme",
      ownerId: "owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    members: [
      {
        userId: "user-1",
        email: null,
        gravatarHash: "",
        name: "alice",
        displayName: "Alice",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-07-12T00:00:00.000Z",
      },
      {
        userId: "user-2",
        email: null,
        gravatarHash: "",
        name: "bob",
        displayName: "Bob",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-07-12T00:00:00.000Z",
      },
    ],
  } as never);
  useChannelStore.setState({
    channels: [],
    dmChannels: [
      {
        id: "dm-1",
        name: "stdrc",
        type: "dm",
        peerId: "agent-1",
        peerType: "agent",
        peerName: "stdrc",
        peerDisplayName: "@stdrc",
        peerAvatarUrl: null,
        lastMessageAt: null,
        unreadCount: 0,
      },
    ],
    channelActivity: {},
  } as never);
  useInboxStore.setState({
    items,
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: false,
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: items.length,
    totalUnreadCount: 0,
    scrollTop: 0,
    focusedItemKey: null,
    pendingFocusKind: null,
  });
  api.get = (async () => ({ data: { items: [], hasMore: false, totalCount: items.length, totalUnreadCount: 0 } })) as typeof api.get;
}

function renderInbox(items: InboxItem[], options: { get?: typeof api.get } = {}) {
  setDesktopViewport();
  seedStores(items);
  const defaultGet = (async () => ({ data: { items: [], hasMore: false, totalCount: items.length, totalUnreadCount: 0 } })) as typeof api.get;
  api.get = options.get ?? defaultGet;
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/activity"]}>
        <ThreadsInbox />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  resetServerFeatureFlagsForTests();
  useInboxStore.setState({ items: [], loaded: false });
  useMessageStore.setState({ drafts: {} });
  useSearchContentStore.setState({ slot: null });
  useThreadAgentFollowerStore.getState().reset();
});

test("Activity Done checks stay hidden until their row is hovered or focused, while the active row keeps its check visible", () => {
  useSearchContentStore.setState({ slot: { kind: "thread", id: "thread-1" } });
  renderInbox([
    makeChannelItem(),
    makeThreadItem(),
  ]);

  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="inbox-row"]'));
  assert.equal(rows.length, 2);
  assert.match(rows[0].className, /(?:^|\s)group(?:\s|$)/);
  assert.match(rows[1].className, /(?:^|\s)group(?:\s|$)/);

  const inactiveDone = within(rows[0]).getByTestId("inbox-row-done");
  assert.equal(inactiveDone.getAttribute("aria-label"), "Mark as Done");
  assert.match(inactiveDone.className, /(?:^|\s)opacity-0(?:\s|$)/);
  assert.match(inactiveDone.className, /(?:^|\s)group-hover:opacity-100(?:\s|$)/);
  assert.match(inactiveDone.className, /(?:^|\s)group-focus-visible:opacity-100(?:\s|$)/);
  assert.match(inactiveDone.className, /(?:^|\s)\[@media\(hover:none\)\]:opacity-100(?:\s|$)/);

  const activeDone = within(rows[1]).getByTestId("inbox-row-done");
  assert.equal(rows[1].getAttribute("data-active"), "true");
  assert.match(activeDone.className, /(?:^|\s)pointer-events-auto(?:\s|$)/);
  assert.match(activeDone.className, /(?:^|\s)opacity-100(?:\s|$)/);
  assert.doesNotMatch(activeDone.className, /(?:^|\s)opacity-0(?:\s|$)/);
});

test("Activity opens its real context menu at a viewport-clamped position", () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 393 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 852 });

  try {
    renderInbox([makeChannelItem()]);
    const row = document.querySelector<HTMLElement>('[data-testid="inbox-row"]');
    assert.ok(row);

    fireEvent.contextMenu(row, { clientX: 382, clientY: 810 });

    const menu = document.querySelector<HTMLElement>('[data-testid="activity-context-menu"]');
    assert.ok(menu, "the mounted Activity row must open its production context menu");
    assert.equal(menu.style.left, "198px");
    assert.equal(menu.style.top, "714px");
    assert.equal(menu.style.maxWidth, "377px");
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  }
});

test("Activity rows use A-style title, inline icon, optional subtitle, and sender-prefixed body", () => {
  renderInbox([
    makeChannelItem(),
    makeChannelItem({
      kind: "dm",
      channelId: "dm-1",
      channelName: "stdrc",
      channelType: "dm",
      lastMessageId: "dm-message-1",
      lastMessagePreview: "latest dm note",
    }),
    makeThreadItem({
      taskNumber: 2,
      taskStatus: "in_progress",
      taskClaimedByName: "Developer",
      unreadCount: 1,
    }),
  ]);
  const rows = Array.from(document.querySelectorAll('[data-testid="inbox-row"]')) as HTMLElement[];
  assert.equal(rows.length, 3);

  const channelRow = within(rows[0]);
  assert.equal(channelRow.getByTestId("conversation-card-title-icon").getAttribute("data-kind"), "channel");
  assert.equal(channelRow.getByTestId("conversation-card-primary").textContent?.trim(), "design");
  assert.equal(channelRow.queryByTestId("conversation-card-subtitle"), null);
  assert.equal(channelRow.getByTestId("conversation-card-body").textContent?.trim(), "Alice: latest channel note");

  const dmRow = within(rows[1]);
  assert.equal(dmRow.getByTestId("conversation-card-title-icon").getAttribute("data-kind"), "dm");
  assert.equal(dmRow.getByTestId("conversation-card-primary").textContent?.trim(), "stdrc");
  assert.equal(dmRow.queryByTestId("conversation-card-subtitle"), null);
  assert.equal(dmRow.getByTestId("conversation-card-body").textContent?.trim(), "Alice: latest dm note");

  const threadRow = within(rows[2]);
  assert.equal(threadRow.getByTestId("conversation-card-title-icon").getAttribute("data-kind"), "thread");
  assert.equal(threadRow.getByTestId("conversation-card-title-icon").querySelector("svg")?.getAttribute("class")?.includes("brutal-pink"), false);
  assert.equal(threadRow.getByTestId("conversation-card-primary").textContent?.includes("thread parent topic"), true);
  assert.equal(threadRow.getByTestId("conversation-card-subtitle").textContent?.trim(), "#design");
  assert.equal(
    Array.from(rows[2].querySelectorAll('[data-testid="conversation-card-subtitle"], [data-testid="conversation-card-primary"]'))
      .map((node) => node.getAttribute("data-testid"))
      .join(","),
    "conversation-card-subtitle,conversation-card-primary",
  );
  assert.equal(threadRow.getByTestId("conversation-card-body").textContent?.trim(), "Bob: latest thread reply");
  assert.deepEqual(
    Array.from(rows[2].querySelectorAll('[data-testid="conversation-card-task-badge"], [data-testid="conversation-card-reply-count"], [data-testid="conversation-card-new-badge"]'))
      .map((node) => node.getAttribute("data-testid")),
    ["conversation-card-task-badge", "conversation-card-reply-count", "conversation-card-new-badge"],
  );
});

test("Activity title color distinguishes unread emphasis from the muted read state", () => {
  renderInbox([
    makeChannelItem({
      channelId: "read-channel",
      channelName: "read title",
      unreadCount: 0,
    }),
    makeChannelItem({
      channelId: "unread-channel",
      channelName: "unread title",
      unreadCount: 2,
    }),
    makeThreadItem({
      threadChannelId: "read-thread",
      parentMessageId: "read-thread-parent",
      unreadCount: 0,
    }),
  ]);

  const primaryTitles = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="conversation-card-primary"]'),
  );
  assert.equal(primaryTitles.length, 3);

  assert.match(primaryTitles[0].className, /(?:^|\s)font-semibold(?:\s|$)/);
  assert.match(primaryTitles[0].className, /(?:^|\s)text-black\/55(?:\s|$)/);
  assert.doesNotMatch(primaryTitles[0].className, /(?:^|\s)text-black(?:\s|$)/);

  assert.match(primaryTitles[1].className, /(?:^|\s)font-bold(?:\s|$)/);
  assert.match(primaryTitles[1].className, /(?:^|\s)text-black(?:\s|$)/);
  assert.doesNotMatch(primaryTitles[1].className, /(?:^|\s)text-black\/55(?:\s|$)/);

  assert.match(primaryTitles[2].className, /(?:^|\s)text-black\/55(?:\s|$)/);
});

test("Activity row metadata uses square raft-ui Badge primitives for every information item", () => {
  useMessageStore.setState({ drafts: { "thread-1": "unfinished reply" } });
  renderInbox([
    makeThreadItem({
      taskNumber: 7,
      taskStatus: "in_progress",
      taskClaimedByName: "Developer",
      unreadCount: 2,
      hasMention: true,
    }),
  ]);

  const metadata = document.querySelector<HTMLElement>('[data-testid="conversation-card-metadata"]');
  assert.ok(metadata);
  const badges = Array.from(metadata.children) as HTMLElement[];
  assert.deepEqual(
    badges.map((badge) => badge.getAttribute("data-testid")),
    [
      "conversation-card-task-badge",
      "conversation-card-reply-count",
      "inbox-mention-badge",
      "conversation-card-new-badge",
      "inbox-thread-draft-badge",
    ],
  );
  for (const badge of badges) {
    assert.equal(badge.getAttribute("data-slot"), "badge");
    assert.doesNotMatch(badge.className, /(?:^|\s)rounded(?:-|\s|$)/);
  }
});

test("Activity thread rows omit agent follower counts and row-level roster requests", async () => {
  setServerFeatureFlagForTests("server-1", THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY, true);
  const getCalls: string[] = [];
  renderInbox([
    makeThreadItem({
      replyCount: 802,
      unreadCount: 55,
    }),
  ], {
    get: (async (url: string) => {
      getCalls.push(url);
      if (url === "/channels/inbox") {
        return { data: { items: [], hasMore: false, totalCount: 1, totalUnreadCount: 55 } };
      }
      if (url === "/channels/threads/followers") {
        return {
          data: {
            threads: [{
              threadChannelId: "thread-1",
              canManage: true,
              agents: [{
                id: "agent-1",
                name: "agent-one",
                displayName: "Agent One",
                status: "online",
                avatarUrl: null,
              }],
            }],
          },
        };
      }
      return { data: {} };
    }) as typeof api.get,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(screen.queryByTestId("thread-followers-card-trigger") === null, true);
  assert.equal(
    getCalls.includes("/channels/threads/followers"),
    false,
    "Activity rows must not request rosters just to paint row metadata",
  );
  const metadata = document.querySelector<HTMLElement>('[data-testid="conversation-card-metadata"]');
  assert.ok(metadata);
  assert.deepEqual(
    Array.from(metadata.children).map((node) => node.getAttribute("data-testid")),
    ["conversation-card-reply-count", "conversation-card-new-badge"],
  );
});

test("Activity in-review task badge uses the canonical lavender status color", () => {
  renderInbox([
    makeThreadItem({
      taskNumber: 79,
      taskStatus: "in_review",
      taskClaimedByName: "Jackie",
    }),
  ]);

  const taskBadge = document.querySelector<HTMLElement>(
    '[data-testid="conversation-card-task-badge"]',
  );
  assert.ok(taskBadge);
  assert.equal(taskBadge.getAttribute("data-slot"), "badge");
  assert.equal(taskBadge.getAttribute("data-status"), "in_review");
  assert.match(taskBadge.className, /(?:^|\s)bg-brutal-lavender(?:\s|$)/);
  assert.doesNotMatch(taskBadge.className, /(?:^|\s)bg-accent-400(?:\s|$)/);
  assert.equal(taskBadge.style.backgroundColor, "var(--color-brutal-lavender)");
});

test("Activity todo task badge pins the same canonical orange used by Chat", () => {
  renderInbox([
    makeThreadItem({
      taskNumber: 515,
      taskStatus: "todo",
      taskClaimedByName: null,
    }),
  ]);

  const taskBadge = document.querySelector<HTMLElement>(
    '[data-testid="conversation-card-task-badge"]',
  );
  assert.ok(taskBadge);
  assert.equal(taskBadge.getAttribute("data-status"), "todo");
  assert.match(taskBadge.className, /(?:^|\s)bg-brutal-orange(?:\s|$)/);
  assert.equal(taskBadge.style.backgroundColor, "var(--color-brutal-orange)");
});
