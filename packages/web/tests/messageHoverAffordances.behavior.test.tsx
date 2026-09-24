import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import type { TimeFormatPreference } from "../src/utils/timeFormatting";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import type { OpenThreadRequest } from "../src/store/threadStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server",
    slug: "server",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

function makeMessage(createdAt = "2026-06-30T00:00:00.000Z"): Message {
  return {
    id: "message-1",
    seq: 10,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "thread origin body\n\nwith markdown content",
    createdAt,
  };
}

async function renderMessage({
  saved,
  readReceipts = false,
  followed = false,
  hideThreadActions = false,
  groupState,
  messageCreatedAt,
  timeFormat = "24h",
  onOpenThread,
}: {
  saved: boolean;
  readReceipts?: boolean;
  followed?: boolean;
  hideThreadActions?: boolean;
  groupState?: {
    isFirstInGroup: boolean;
    previousMessageId: string | null;
    showAvatar: boolean;
    showName: boolean;
    dayKey: string;
    showDayDivider: boolean;
  };
  messageCreatedAt?: string;
  timeFormat?: TimeFormatPreference;
  onOpenThread?: (request: OpenThreadRequest) => void;
}) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useReadReceiptStore } = await import("../src/store/readReceiptStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useThreadStore } = await import("../src/store/threadStore");
  const { useTranslationStore } = await import("../src/store/translationStore");
  const {
    READ_RECEIPTS_FEATURE_FLAG_KEY,
    prefetchServerFeatureFlags,
  } = await import("../src/store/serverFeatureFlags");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: makeServer(),
    members: [] as ServerMember[],
  });
  useTranslationStore.setState((state) => ({
    settings: {
      ...state.settings,
      preferredTimezone: "UTC",
      effectiveTimezone: "UTC",
      preferredTimeFormat: timeFormat,
      effectiveTimeFormat: timeFormat,
    },
  }));
  resetServerFeatureFlagsForTests();
  if (readReceipts) {
    api.post = (async () => ({
      data: { evaluations: [{ key: READ_RECEIPTS_FEATURE_FLAG_KEY, enabled: true }] },
    })) as typeof api.post;
    await prefetchServerFeatureFlags("server-1");
  }
  useAgentStore.setState({
    agents: [] as Agent[],
    agentActivities: {},
  });
  useChannelStore.setState({
    dmChannels: [] as Channel[],
  });
  useSavedStore.setState({
    saved: [],
    savedIds: saved ? new Set(["message-1"]) : new Set(),
    loading: false,
    hasMore: false,
  });
  useReadReceiptStore.setState({ scopes: {} });
  useThreadStore.setState({
    followedThreads: followed
      ? [{
        threadChannelId: "thread-message-1",
        parentMessageId: "message-1",
        parentChannelId: "channel-1",
        parentChannelName: "general",
        parentChannelType: "channel",
        parentMessagePreview: "thread origin body",
        parentMessageSenderType: "user",
        parentMessageSenderId: "user-1",
        replyCount: 2,
        lastReplyAt: "2026-06-30T00:01:00.000Z",
        unreadCount: 0,
        taskNumber: null,
        taskStatus: null,
        taskClaimedByName: null,
      }]
      : [],
  });

  const view = render(
    <MemoryRouter>
      <MessageItem
        message={makeMessage(messageCreatedAt)}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions={hideThreadActions}
        onOpenThread={onOpenThread}
        groupState={groupState}
        threadSummary={{
          threadChannelId: "thread-message-1",
          replyCount: 2,
          participantIds: ["user-1"],
          unreadCount: 0,
          firstUnreadMessageId: null,
          lastReplyAt: "2026-06-30T00:01:00.000Z",
        }}
      />
    </MemoryRouter>,
  );
  const row = view.container.querySelector<HTMLElement>("#message-message-1");
  assert.ok(row);
  const body = view.container.querySelector<HTMLElement>("[data-message-id='message-1']");
  assert.ok(body);
  const saveButton = row.querySelector<HTMLButtonElement>(
    `[data-message-affordance='toolbar'] [aria-label='${saved ? "Remove from Saved" : "Save Message"}']`,
  );
  assert.ok(saveButton);
  return { ...view, body, row, saveButton };
}

const originalDelete = api.delete.bind(api);
const originalPost = api.post.bind(api);

afterEach(() => {
  cleanup();
  api.delete = originalDelete;
  api.post = originalPost;
  resetServerFeatureFlagsForTests();
});

test("continuation-row hover timestamp follows the UI 12h/24h setting", async () => {
  const continuationGroupState = {
    isFirstInGroup: false,
    previousMessageId: "message-0",
    showAvatar: false,
    showName: false,
    dayKey: "2026-06-30",
    showDayDivider: false,
  };
  const createdAt = "2026-06-30T13:05:00.000Z";

  const findGutter = (row: HTMLElement, text: string, title: string) => {
    const gutter = Array.from(row.querySelectorAll("span"))
      .find((candidate) => candidate.textContent === text && candidate.getAttribute("title") === title);
    assert.ok(gutter, `expected continuation gutter timestamp ${text} with title ${title}`);
    assert.match(gutter.className, /group-hover\/message:text-black\/40/);
  };

  let view = await renderMessage({
    saved: false,
    hideThreadActions: true,
    groupState: continuationGroupState,
    messageCreatedAt: createdAt,
    timeFormat: "12h",
  });
  findGutter(view.row, "01:05 PM", "Jun 30, 2026, 1:05 PM");

  cleanup();

  view = await renderMessage({
    saved: false,
    hideThreadActions: true,
    groupState: continuationGroupState,
    messageCreatedAt: createdAt,
    timeFormat: "24h",
  });
  findGutter(view.row, "13:05", "Jun 30, 2026, 13:05");
});

test("thread origin hover affordances stay anchored to the message row", async () => {
  const { body, row, saveButton } = await renderMessage({ saved: false });
  const reaction = row.querySelector<HTMLElement>("[data-message-affordance='reaction']");
  const thread = row.querySelector<HTMLElement>("[data-message-affordance='thread']");
  assert.ok(reaction);
  assert.ok(thread);

  assert.equal(body.closest("#message-message-1"), row);
  assert.equal(saveButton.closest("#message-message-1"), row);
  assert.equal(reaction.closest("#message-message-1"), row);
  assert.equal(thread.closest("#message-message-1"), row);

  assert.match(row.className, /(?:^| )group\/message(?: |$)/);
  // Reaction, thread + save now live in one bordered toolbar that reveals on
  // row hover (Slack-style, riding the message border).
  const toolbar = row.querySelector<HTMLElement>("[data-message-affordance='toolbar']");
  assert.ok(toolbar);
  assert.equal(toolbar.closest("#message-message-1"), row);
  assert.match(toolbar.className, /(?:^| )flex(?: |$)/);
  assert.equal(
    toolbar.classList.contains("pointer-events-none"),
    false,
    "the transparent toolbar remains a hit target so moving above the row cannot collapse its own hover",
  );
  assert.match(toolbar.className, /(?:^| )opacity-0(?: |$)/);
  assert.match(toolbar.className, /(?:^| )group-hover\/message:opacity-100(?: |$)/);
  assert.match(toolbar.className, /(?:^| )group-focus-within\/message:opacity-100(?: |$)/);
  assert.equal(toolbar.classList.contains("hidden"), false);
  assert.equal(reaction.closest("[data-message-affordance='toolbar']"), toolbar);
  assert.equal(thread.closest("[data-message-affordance='toolbar']"), toolbar);
  assert.equal(saveButton.closest("[data-message-affordance='toolbar']"), toolbar);
});

test("thread context menu gives Follow Thread a distinct message-plus icon", async () => {
  const { body } = await renderMessage({ saved: false });

  fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

  const openThreadItem = screen.getByRole("menuitem", { name: "Open Thread" });
  const followThreadItem = screen.getByRole("menuitem", { name: "Follow Thread" });
  const openThreadIconClass = openThreadItem.querySelector("svg")?.getAttribute("class") ?? "";
  const followThreadIconClass = followThreadItem.querySelector("svg")?.getAttribute("class") ?? "";

  assert.match(openThreadIconClass, /lucide-message-square/);
  assert.match(followThreadIconClass, /lucide-message-circle-plus/);
});

test("message context menu opens the real thread action before Save Message", async () => {
  const opened: Array<{ parentChannelId: string; parentMessageId: string }> = [];
  const { body } = await renderMessage({
    saved: false,
    onOpenThread: (request) => opened.push(request),
  });

  fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

  const openThreadItem = screen.getByRole("menuitem", { name: "Open Thread" });
  const saveMessageItem = screen.getByRole("menuitem", { name: "Save Message" });
  assert.ok(
    openThreadItem.compareDocumentPosition(saveMessageItem) & Node.DOCUMENT_POSITION_FOLLOWING,
    "Open Thread must precede Save Message in the rendered menu",
  );

  fireEvent.click(openThreadItem);
  assert.deepEqual(opened, [{
    parentChannelId: "channel-1",
    parentMessageId: "message-1",
    initialThreadChannelId: "thread-message-1",
  }]);
});

test("thread-panel message context menu omits Open Thread", async () => {
  const { body } = await renderMessage({ saved: false, hideThreadActions: true });

  fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

  assert.equal(screen.queryAllByRole("menuitem", { name: "Open Thread" }).length, 0);
  assert.ok(screen.getByRole("menuitem", { name: "Save Message" }));
});

test("mobile long-press keeps an iOS phantom-click shield below the usable menu", async () => {
  const opened: OpenThreadRequest[] = [];
  const { body } = await renderMessage({ saved: false, onOpenThread: (request) => opened.push(request) });
  const bodySurface = body.parentElement;
  assert.ok(bodySurface, "the real message body has a mounted gesture surface");

  fireEvent.touchStart(bodySurface, {
    touches: [{ clientX: 24, clientY: 36 }],
  });
  await waitFor(
    () => assert.ok(screen.getByRole("menu", { name: "Message context menu" })),
    { timeout: 1_000 },
  );
  fireEvent.touchEnd(bodySurface, {
    changedTouches: [{ clientX: 24, clientY: 36 }],
  });

  const menu = screen.getByRole("menu", { name: "Message context menu" });
  const backdrops = Array.from(document.body.querySelectorAll<HTMLElement>(".fixed.inset-0.touch-none"));
  const shield = backdrops.find((candidate) => candidate.style.zIndex === "55");
  assert.ok(shield, "long-press mounts the short-lived phantom-click shield at z=55");
  assert.equal(menu.style.zIndex, "", "menu z-index stays class-owned rather than inline");
  assert.match(menu.className, /(?:^| )z-\[60\](?: |$)/);

  fireEvent.click(shield);
  assert.ok(screen.getByRole("menu", { name: "Message context menu" }), "phantom outside click is absorbed");
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Thread" }));
  assert.equal(opened.length, 1, "the menu row remains actionable above the shield");
  assert.equal(screen.queryByRole("menu", { name: "Message context menu" }), null, "menu rows remain clickable above the shield");

  fireEvent.touchStart(bodySurface, {
    touches: [{ clientX: 24, clientY: 36 }],
  });
  await waitFor(
    () => assert.ok(screen.getByRole("menu", { name: "Message context menu" })),
    { timeout: 1_000 },
  );
  fireEvent.touchEnd(bodySurface, {
    changedTouches: [{ clientX: 24, clientY: 36 }],
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
  assert.equal(
    Array.from(document.body.querySelectorAll<HTMLElement>(".fixed.inset-0.touch-none"))
      .some((candidate) => candidate.style.zIndex === "55"),
    false,
    "the phantom-click shield retires after its bounded window",
  );
  assert.ok(screen.getByRole("menu", { name: "Message context menu" }), "retiring the shield does not close the menu");
  const defaultBackdrop = Array.from(document.body.querySelectorAll<HTMLElement>(".fixed.inset-0.touch-none"))
    .find((candidate) => candidate.style.zIndex === "50");
  assert.ok(defaultBackdrop, "the ordinary z=50 dismiss backdrop remains after the shield retires");
  fireEvent.click(defaultBackdrop);
  assert.equal(
    screen.queryByRole("menu", { name: "Message context menu" }),
    null,
    "an outside click closes the menu after the phantom-click window",
  );
});

test("thread context menu gives Unfollow Thread an inverse message icon", async () => {
  const { body } = await renderMessage({ saved: false, followed: true });

  fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

  const unfollowThreadItem = screen.getByRole("menuitem", { name: "Unfollow Thread" });
  const unfollowThreadIconClass = unfollowThreadItem.querySelector("svg")?.getAttribute("class") ?? "";

  assert.match(unfollowThreadIconClass, /lucide-message-circle-off/);
});

test("saved thread origin bookmark renders as the active save action", async () => {
  const { saveButton } = await renderMessage({ saved: true });
  const row = saveButton.closest("#message-message-1");

  assert.match(saveButton.className, /(?:^| )text-brutal-orange(?: |$)/);
  assert.ok(row);
  assert.equal(
    row.querySelector("[data-message-affordance='saved-indicator']"),
    null,
    "saved messages do not render a resting overlay indicator",
  );
  const savedBadge = row.querySelector<HTMLButtonElement>("[data-message-affordance='saved-badge']");
  assert.ok(savedBadge, "saved messages show a footer/meta saved badge");
  assert.equal(savedBadge.tagName, "BUTTON");
  assert.equal(savedBadge.textContent, "Saved");
  assert.equal(savedBadge.getAttribute("aria-label"), "Remove from Saved");
  assert.equal(savedBadge.closest("#message-message-1"), row);
});

test("clicking the saved footer badge removes the message from Saved", async () => {
  api.delete = (() => new Promise(() => {})) as typeof api.delete;
  const { row } = await renderMessage({ saved: true });
  const { useSavedStore } = await import("../src/store/savedStore");
  const savedBadge = row.querySelector<HTMLButtonElement>("[data-message-affordance='saved-badge']");
  assert.ok(savedBadge);

  fireEvent.click(savedBadge);

  assert.equal(useSavedStore.getState().savedIds.has("message-1"), false);
  assert.equal(row.querySelector("[data-message-affordance='saved-badge']"), null);
});

// #693: the aggregate footer "Read" chip is gone. It collapsed all peers into
// one boolean, so it appeared on messages with no @agent at all as soon as any
// un-mentioned agent had read the channel, and on summary scopes — both
// contradicting "read state is shown per @mentioned agent". These pin its
// removal; without it they go green again on the old aggregate behavior.
test("#693 an un-mentioned agent's read produces NO footer receipt on a message with no @agent", async () => {
  const { row } = await renderMessage({ saved: false, readReceipts: true });
  const { useReadReceiptStore } = await import("../src/store/readReceiptStore");
  act(() => {
    useReadReceiptStore.setState({
      scopes: {
        "channel-1": {
          kind: "peers",
          // Agent read the channel, but is not @mentioned in this message body.
          peers: [{ peerKind: "agent", peerId: "agent-9", maxReadSeq: 10 }],
        },
      },
    });
  });
  assert.equal(row.querySelector("[data-message-affordance='read-receipt']"), null);
});

test("#693 a summary-only scope produces NO footer receipt", async () => {
  const { row } = await renderMessage({ saved: false, readReceipts: true });
  const { useReadReceiptStore } = await import("../src/store/readReceiptStore");
  act(() => {
    useReadReceiptStore.setState({
      scopes: {
        "channel-1": {
          kind: "summary",
          summary: { peerCount: 60, readCountAtSeq: [{ seq: 1, count: 42 }] },
        },
      },
    });
  });
  assert.equal(row.querySelector("[data-message-affordance='read-receipt']"), null);
});

test("#693 a legacy/mixed server human peer row produces NO human-read UI", async () => {
  const { row } = await renderMessage({ saved: false, readReceipts: true });
  const { useReadReceiptStore } = await import("../src/store/readReceiptStore");
  act(() => {
    useReadReceiptStore.setState({
      scopes: {
        "channel-1": {
          kind: "peers",
          // An older server (or a mixed rollout) may still send human rows —
          // the client must never render human read state regardless.
          peers: [
            { peerKind: "human", peerId: "user-2", maxReadSeq: 10 },
            { peerKind: "agent", peerId: "agent-9", maxReadSeq: 10 },
          ],
        },
      },
    });
  });
  assert.equal(row.querySelector("[data-message-affordance='read-receipt']"), null);
  assert.equal(row.textContent?.includes("Read"), false, "no human read state may reach the DOM");
});

test("flag-off keeps receipt UI absent even if stale scope state exists", async () => {
  const { row } = await renderMessage({ saved: false });
  const { useReadReceiptStore } = await import("../src/store/readReceiptStore");
  act(() => {
    useReadReceiptStore.setState({
      scopes: {
        "channel-1": {
          kind: "peers",
          peers: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 10 }],
        },
      },
    });
  });
  assert.equal(row.querySelector("[data-message-affordance='read-receipt']"), null);
});
