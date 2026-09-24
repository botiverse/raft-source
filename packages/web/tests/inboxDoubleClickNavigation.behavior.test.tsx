import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useThreadStore } from "../src/store/threadStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";

// node:test runs files concurrently by default; these tests share global
// zustand stores + window.matchMedia, so serialize them.
type TestFn = (t: unknown) => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn as never);

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);
const originalScrollTo = HTMLElement.prototype.scrollTo;

// Wide desktop viewport: handleOpen's single-click master/detail branch starts
// at 1024px, while 768-1023px keeps the Activity rail but opens the target
// route directly so the list does not get crushed.
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
  window.matchMedia = ((query: string) => ({
    matches: Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? 0) <= 900,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function setMobileViewport() {
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*767px/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// Records the current router location on every render so we can read the
// resulting URL after a nav.* call. This exercises the real useAppNavigate ->
// react-router path (no hook mocking), so the asserted URL proves both the
// routing method AND the message-id targeting simultaneously.
let currentLocation = "";
function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
}

function makeChannelItem(
  overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {},
): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "last-msg",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-06-22T00:00:00.000Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "alice",
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

function makeThreadItem(
  overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {},
): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-1",
    parentChannelId: "parent-channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent message",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "latest-reply",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 2,
    lastActivityAt: "2026-06-22T00:00:00.000Z",
    lastReplyAt: "2026-06-22T00:00:00.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function makeMentionActionItem(
  overrides: Partial<Extract<InboxItem, { kind: "mention_action" }>> = {},
): Extract<InboxItem, { kind: "mention_action" }> {
  return {
    kind: "mention_action",
    id: "mention-action-1",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    messageId: "mention-action-message",
    messagePreview: "please review this mention",
    createdAt: "2026-06-22T00:00:00.000Z",
    pendingMentionActions: [],
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

function seedInbox(items: InboxItem[], overrides: Partial<ReturnType<typeof useInboxStore.getState>> = {}) {
  useInboxStore.setState({
    items,
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: items.length,
    totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
    scrollTop: 0,
    focusedItemKey: null,
    pendingFocusKind: null,
    ...overrides,
  });
}

function renderInbox() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "acme",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-06-30T00:00:00.000Z",
    },
  });
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/activity"]}>
        <LocationProbe />
        <ThreadsInbox />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function inboxRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="inbox-row"]')) as HTMLElement[];
}

function mockDisabledActivityV2Post(onMutation?: (url: string) => void) {
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    onMutation?.(url);
    return { data: {} };
  }) as typeof api.post;
}

afterEach(() => {
  cleanup();
  currentLocation = "";
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  resetServerFeatureFlagsForTests();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  useInboxStore.setState({ items: [], loaded: false });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    focusedMessageId: null,
  });
});

test("unread empty state does not auto-refetch after the last unread row is read", async () => {
  setDesktopViewport();
  const channel = makeChannelItem({
    channelId: "channel-1",
    firstUnreadMessageId: "unread-msg",
    lastMessageId: "last-msg",
    unreadCount: 1,
  });
  const getCalls: string[] = [];
  const postCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
  }) as typeof api.get;
  mockDisabledActivityV2Post((url) => postCalls.push(url));

  seedInbox([channel], { filter: "unread", totalCount: 1, totalUnreadCount: 1 });
  renderInbox();

  await act(async () => {
    await useInboxStore.getState().markRead(channel);
  });

  assert.equal(useInboxStore.getState().loading, false);
  assert.equal(useInboxStore.getState().items.length, 0);
  assert.equal(document.body.textContent?.includes("No unread chats"), true);
  assert.deepEqual(postCalls, ["/channels/channel-1/read-all"]);
  assert.deepEqual(getCalls, [], "empty-state rendering must not load the compatibility unfollowed history");
});

test("double-click on a channel row navigates to the channel chat permalink (firstUnread ?? last)", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  // Unread channel: firstUnreadMessageId must win over lastMessageId (kills the
  // `firstUnreadMessageId ?? lastMessageId` targeting mutant).
  const channel = makeChannelItem({
    channelId: "channel-1",
    firstUnreadMessageId: "unread-msg",
    lastMessageId: "last-msg",
    unreadCount: 3,
  });
  seedInbox([channel]);
  renderInbox();

  const row = inboxRows()[0];
  act(() => {
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
  });

  assert.equal(currentLocation, "/s/acme/channel/channel-1?msg=unread-msg");
});

test("double-click on a read channel row falls back to lastMessageId", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  const channel = makeChannelItem({
    channelId: "channel-1",
    firstUnreadMessageId: null,
    lastMessageId: "last-msg",
    unreadCount: 0,
  });
  seedInbox([channel]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 2 });
  });

  assert.equal(currentLocation, "/s/acme/channel/channel-1?msg=last-msg");
});

test("double-click on a dm row navigates to the DM chat permalink", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  const dm = makeChannelItem({
    kind: "dm",
    channelId: "dm-1",
    channelType: "dm",
    firstUnreadMessageId: "dm-unread",
    lastMessageId: "dm-last",
    unreadCount: 2,
  });
  seedInbox([dm]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 2 });
  });

  // DM route (not channel route) + firstUnread targeting.
  assert.equal(currentLocation, "/s/acme/dm/dm-1?msg=dm-unread");
});

test("mobile Activity opens channel and DM rows at the first mention before the first unread", () => {
  setMobileViewport();
  mockDisabledActivityV2Post();

  const channel = makeChannelItem({
    channelId: "channel-mention",
    firstMentionMessageId: "channel-mention-message",
    firstUnreadMessageId: "channel-unread-message",
    lastMessageId: "channel-last-message",
    unreadCount: 3,
    hasMention: true,
  });
  const dm = makeChannelItem({
    kind: "dm",
    channelId: "dm-mention",
    channelType: "dm",
    firstMentionMessageId: "dm-mention-message",
    firstUnreadMessageId: "dm-unread-message",
    lastMessageId: "dm-last-message",
    unreadCount: 2,
    hasMention: true,
  });

  seedInbox([channel]);
  const channelRender = renderInbox();
  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });
  assert.equal(currentLocation, "/s/acme/channel/channel-mention?msg=channel-mention-message");
  channelRender.unmount();

  currentLocation = "";
  seedInbox([dm]);
  renderInbox();
  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });
  assert.equal(currentLocation, "/s/acme/dm/dm-mention?msg=dm-mention-message");
});

test("double-click on a thread row routes with parent-thread context without pre-opening the store", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  const openThreadCalls: unknown[] = [];
  useThreadStore.setState({
    openThread: async (request: unknown) => {
      openThreadCalls.push(request);
    },
  } as Partial<ReturnType<typeof useThreadStore.getState>>);

  const thread = makeThreadItem({
    threadChannelId: "thread-1",
    parentChannelId: "parent-channel-1",
    parentMessageId: "parent-1",
    parentChannelType: "channel",
    firstUnreadMessageId: "unread-reply",
    latestActivityMessageId: "latest-reply",
    unreadCount: 1,
  });
  seedInbox([thread]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 2 });
  });

  // toThreadMessage(parentChannelId, parentMessageId, targetMsgId, "channel"):
  // route base is the parent channel, msg is the unread reply, and the parent
  // thread anchor is carried in ?thread=<parentChannelId>:<parentMessageId>.
  assert.equal(
    currentLocation,
    "/s/acme/channel/parent-channel-1?msg=unread-reply&thread=parent-channel-1%3Aparent-1",
  );

  // The canonical route already carries the complete thread identity. Let the
  // URL→store projection seed threadStore after navigation so one user gesture
  // creates exactly one history entry instead of openThread() pushing
  // /activity?thread= before the route push.
  assert.equal(openThreadCalls.length, 0);
});

test("double-click on a thread mention row focuses the mention before its earlier unread reply", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  const thread = makeThreadItem({
    threadChannelId: "thread-mention",
    parentChannelId: "parent-channel-mention",
    parentMessageId: "parent-mention",
    firstMentionMessageId: "mention-reply",
    firstUnreadMessageId: "earlier-unread-reply",
    latestActivityMessageId: "latest-reply",
    unreadCount: 3,
    hasMention: true,
  });
  seedInbox([thread]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 2 });
  });

  assert.equal(
    currentLocation,
    "/s/acme/channel/parent-channel-mention?msg=mention-reply&thread=parent-channel-mention%3Aparent-mention",
  );
});

test("double-click on a mention-action row focuses that action's own message", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  seedInbox([{
    ...makeMentionActionItem({
      channelId: "channel-actions",
      messageId: "mention-action-own-message",
    }),
    // Legacy action rows do not own this field, but stale/additive transport
    // data must never override their canonical message identity.
    firstMentionMessageId: "not-the-action-message",
  } as InboxItem]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 2 });
  });

  assert.equal(currentLocation, "/s/acme/channel/channel-actions?msg=mention-action-own-message");
});

test("double-click on a dm-parented thread row uses the dm route kind", () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();
  useThreadStore.setState({
    openThread: async () => {},
  } as Partial<ReturnType<typeof useThreadStore.getState>>);

  const thread = makeThreadItem({
    threadChannelId: "thread-2",
    parentChannelId: "dm-parent",
    parentMessageId: "parent-2",
    parentChannelType: "dm",
    firstUnreadMessageId: null,
    latestActivityMessageId: "latest-reply",
    unreadCount: 0,
  });
  seedInbox([thread]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 2 });
  });

  // parentChannelType === "dm" -> dm route; read thread targets latestActivity.
  assert.equal(
    currentLocation,
    "/s/acme/dm/dm-parent?msg=latest-reply&thread=dm-parent%3Aparent-2",
  );
});

test("single-click does not navigate (takes the col-3 preview path, not chat)", async () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();

  const channel = makeChannelItem({
    channelId: "channel-1",
    firstUnreadMessageId: "unread-msg",
    unreadCount: 1,
  });
  seedInbox([channel]);
  renderInbox();

  const before = currentLocation;
  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });

  // Synchronously after a single click: no navigation (the double-click branch
  // must NOT fire on detail 1).
  assert.equal(currentLocation, before);

  // Let the 220ms deferred single-click timer fire; on desktop it opens the
  // col-3 master/detail slot and still must NOT navigate the router.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
  assert.equal(currentLocation, before);
  assert.deepEqual(useSearchContentStore.getState().slot, {
    kind: "channel",
    id: "channel-1",
    messageId: "unread-msg",
  });
});

test("single-click on a thread row opens the Activity col-3 thread slot at the unread reply", async () => {
  setDesktopViewport();
  mockDisabledActivityV2Post();
  const openThreadCalls: unknown[] = [];
  useThreadStore.setState({
    openThread: async (request: unknown) => {
      openThreadCalls.push(request);
    },
  } as Partial<ReturnType<typeof useThreadStore.getState>>);

  const thread = makeThreadItem({
    threadChannelId: "thread-1",
    parentChannelId: "parent-channel-1",
    parentMessageId: "parent-1",
    parentChannelType: "channel",
    firstUnreadMessageId: "unread-reply",
    latestActivityMessageId: "latest-reply",
    unreadCount: 1,
  });
  seedInbox([thread]);
  renderInbox();

  const before = currentLocation;
  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });

  assert.equal(currentLocation, before);
  assert.deepEqual(useSearchContentStore.getState().slot, {
    kind: "thread",
    id: "thread-1",
    messageId: "unread-reply",
  });
  assert.equal(openThreadCalls.length, 1);
  assert.deepEqual(openThreadCalls[0], {
    parentChannelId: "parent-channel-1",
    parentMessageId: "parent-1",
    focusedMessageId: "unread-reply",
    initialThreadChannelId: "thread-1",
  });
});

test("single-click on a narrow desktop channel row opens the chat route immediately", () => {
  setNarrowDesktopViewport();
  mockDisabledActivityV2Post();

  const channel = makeChannelItem({
    channelId: "channel-1",
    firstUnreadMessageId: "unread-msg",
    lastMessageId: "last-msg",
    unreadCount: 1,
  });
  seedInbox([channel]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });

  assert.equal(currentLocation, "/s/acme/channel/channel-1?msg=unread-msg");
});

test("single tap on mobile channel row opens the chat route immediately", () => {
  setMobileViewport();
  mockDisabledActivityV2Post();

  const channel = makeChannelItem({
    channelId: "channel-1",
    firstUnreadMessageId: "unread-msg",
    lastMessageId: "last-msg",
    unreadCount: 1,
  });
  seedInbox([channel]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });

  assert.equal(currentLocation, "/s/acme/channel/channel-1?msg=unread-msg");
});

test("single tap on mobile thread row opens one canonical parent chat thread route", () => {
  setMobileViewport();
  mockDisabledActivityV2Post();
  const openThreadCalls: unknown[] = [];
  useThreadStore.setState({
    openThread: async (request: unknown) => {
      openThreadCalls.push(request);
    },
  } as Partial<ReturnType<typeof useThreadStore.getState>>);

  const thread = makeThreadItem({
    threadChannelId: "thread-1",
    parentChannelId: "parent-channel-1",
    parentMessageId: "parent-1",
    parentChannelType: "channel",
    firstUnreadMessageId: "unread-reply",
    latestActivityMessageId: "latest-reply",
    unreadCount: 1,
  });
  seedInbox([thread]);
  renderInbox();

  act(() => {
    fireEvent.click(inboxRows()[0], { detail: 1 });
  });

  assert.equal(
    currentLocation,
    "/s/acme/channel/parent-channel-1?msg=unread-reply&thread=parent-channel-1%3Aparent-1",
  );
  assert.equal(openThreadCalls.length, 0);
});

test("focused Activity row auto-scrolls once while socket and refresh snapshots update the list", async () => {
  setDesktopViewport();
  const a = makeChannelItem({
    channelId: "channel-a",
    channelName: "A channel",
    lastMessageId: "a-1",
  });
  const b = makeThreadItem({
    threadChannelId: "thread-b",
    latestActivityMessageId: "b-1",
    latestActivityPreview: "B old reply",
  });
  const c = makeChannelItem({
    channelId: "channel-c",
    channelName: "C channel",
    lastMessageId: "c-1",
  });
  seedInbox([a, b, c], { focusedItemKey: "thread:thread-b" });

  const scrollCalls: ScrollToOptions[] = [];
  HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    if (typeof options === "object") scrollCalls.push(options);
  };
  renderInbox();

  await waitFor(() => assert.ok(scrollCalls.some((call) => call.behavior === "smooth")));
  const focusScrollCount = scrollCalls.filter((call) => call.behavior === "smooth").length;

  act(() => {
    useInboxStore.getState().receiveThreadReply({
      id: "b-2",
      channelId: "thread-b",
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-1",
        parentChannelId: "parent-channel-1",
        parentChannelType: "channel",
      },
      senderType: "user",
      senderId: "user-2",
      content: "socket reply",
      createdAt: "2026-07-15T00:04:00.000Z",
    });
  });
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  assert.equal(scrollCalls.filter((call) => call.behavior === "smooth").length, focusScrollCount);

  api.get = (async () => ({
    data: {
      items: [
        makeThreadItem({
          threadChannelId: "thread-b",
          latestActivityMessageId: "b-2",
          latestActivityPreview: "socket reply",
          replyCount: 3,
          lastActivityAt: "2026-07-15T00:04:00.000Z",
          lastReplyAt: "2026-07-15T00:04:00.000Z",
        }),
        a,
        c,
      ],
      hasMore: false,
      totalCount: 3,
      totalUnreadCount: 0,
    },
  })) as typeof api.get;
  await act(async () => {
    await useInboxStore.getState().loadInbox({ reset: true, background: true });
  });

  assert.equal(scrollCalls.filter((call) => call.behavior === "smooth").length, focusScrollCount);
  assert.deepEqual(
    scrollCalls.find((call) => call.behavior === "smooth"),
    { top: -8, behavior: "smooth" },
  );
});

test("Activity preserves its saved return position when items refresh before the restore frame", async () => {
  setDesktopViewport();
  const channel = makeChannelItem({
    channelId: "scroll-restore-channel",
    lastMessagePreview: "before refresh",
  });
  seedInbox([channel], { scrollTop: 120 });

  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let nextFrameId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    nextFrameId += 1;
    callbacks.set(nextFrameId, callback);
    return nextFrameId;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((frameId: number) => {
    callbacks.delete(frameId);
  }) as typeof globalThis.cancelAnimationFrame;

  try {
    renderInbox();
    await act(async () => {
      useInboxStore.setState({
        items: [{ ...channel, lastMessagePreview: "after refresh" }],
      });
    });

    for (const callback of callbacks.values()) callback(0);

    assert.equal(useInboxStore.getState().scrollTop, 120);
    assert.equal(
      (document.querySelector('[data-testid="inbox-scroll"]') as HTMLDivElement).scrollTop,
      120,
    );
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("Activity Unfollow retains a terminal thread without repainting a stale refresh snapshot", async () => {
  setDesktopViewport();
  const thread = makeThreadItem({
    threadChannelId: "thread-unfollow",
    latestActivityMessageId: "reply-before-unfollow",
  });
  seedInbox([thread]);

  const postCalls: Array<{ url: string; body: unknown }> = [];
  let inboxRefreshCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    // Feature-flag evaluation is infra noise, not the unfollow assertion target;
    // answer it without recording it so postCalls only captures the unfollow POST.
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    postCalls.push({ url, body });
    return { data: { ok: true } };
  }) as typeof api.post;
  api.get = (async () => {
    inboxRefreshCalls += 1;
    return {
      data: {
        items: [thread],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 0,
      },
    };
  }) as typeof api.get;

  renderInbox();
  fireEvent.contextMenu(inboxRows()[0], { clientX: 40, clientY: 40 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Unfollow" }));

  await waitFor(() => {
    const retained = useInboxStore.getState().items[0];
    assert.equal(useInboxStore.getState().items.length, 1);
    assert.equal(retained?.kind, "thread");
    assert.equal(retained?.kind === "thread" ? retained.isFollowing : null, false);
    assert.equal(retained?.unreadCount, 0);
    assert.equal(retained?.hasMention, false);
    assert.equal(retained?.latestActivityMessageId, "reply-before-unfollow");
  });
  assert.deepEqual(postCalls, [
    { url: "/channels/threads/unfollow", body: { threadChannelId: "thread-unfollow" } },
  ]);
  assert.equal(
    inboxRefreshCalls,
    0,
    "a successful unfollow must not immediately rehydrate the stale pre-unfollow Activity row",
  );
});

test("Activity Follow posts the follow endpoint and keeps the same unfollowed row as active", async () => {
  setDesktopViewport();
  const thread = makeThreadItem({
    threadChannelId: "thread-refollow",
    parentMessageId: "parent-refollow",
    isFollowing: false,
    unfollowedAt: "2026-07-30T00:01:00.000Z",
  });
  seedInbox([thread]);

  const postCalls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    postCalls.push({ url, body });
    return { data: { ok: true } };
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/threads/followed") {
      throw new Error("followed-list refresh must not be required for the row to stay");
    }
    return { data: { items: [thread], hasMore: false, totalCount: 1, totalUnreadCount: 0 } };
  }) as typeof api.get;

  renderInbox();
  fireEvent.contextMenu(inboxRows()[0], { clientX: 40, clientY: 40 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Follow" }));

  await waitFor(() => {
    const retained = useInboxStore.getState().items[0];
    assert.equal(useInboxStore.getState().items.length, 1);
    assert.equal(retained?.kind, "thread");
    assert.equal(retained?.kind === "thread" ? retained.threadChannelId : null, "thread-refollow");
    assert.equal(retained?.kind === "thread" ? retained.isFollowing : null, true);
    assert.equal(retained?.kind === "thread" ? retained.unfollowedAt : "missing", null);
  });
  assert.deepEqual(postCalls, [
    { url: "/channels/threads/follow", body: { parentMessageId: "parent-refollow" } },
  ]);
  assert.equal(screen.queryByRole("menuitem", { name: "Follow" }), null);
});
