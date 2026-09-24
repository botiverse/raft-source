import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderWithIntl } from "./helpers/intl";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import { useChannelStore } from "../src/store/channelStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";

// Behavior gate for the `thread.*` react-intl migration (ThreadsInbox — the
// Activity inbox). Rendered under zh-cn, assert representative @AngLee-final
// Chinese chrome reaches the DOM and that none of the pre-migration English
// literals leak (the mixed-language regression class). The always-visible
// header/filter/empty chrome is enough to prove the namespace resolves zh;
// ICU parity for the plural/interpolated keys is pinned by i18nContract.

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

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

test("ThreadsInbox renders zh-cn Activity chrome", () => {
  setDesktopViewport();
  useServerStore.setState({ current: { slug: "acme" } } as never);
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
    pendingFocusKind: null,
  } as never);

  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/activity"]}>
      <ThreadsInbox />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  // Header + filter chrome (always rendered) and the default empty state.
  assert.ok(screen.getByText("动态"), "header title renders zh");
  assert.ok(screen.getAllByText("全部").length > 0, "filter: all renders zh");
  assert.ok(screen.getAllByText("未读").length > 0, "filter: unread renders zh");
  assert.ok(screen.getAllByText("提及").length > 0, "filter: mentions renders zh");
  assert.ok(screen.getByText("动态为空"), "empty default title renders zh");

  // No pre-migration English leaks in the always-visible chrome.
  const body = document.body.textContent ?? "";
  assert.doesNotMatch(body, /\bActivity\b/, "header must not leak English");
  assert.doesNotMatch(body, /\bAll\b|\bUnread\b|\bMentions\b/, "filter labels must not leak English");
  assert.doesNotMatch(body, /Activity is empty/, "empty title must not leak English");
});

// @铁根 blocker: an inbox row's relative timestamp used `Intl.RelativeTimeFormat(
// undefined)`, which follows the browser/Node default locale, NOT the app's
// active locale — so under a zh-cn app it rendered "2 minutes ago" on every row
// (first-screen mixed-language). It now formats through react-intl
// (intl.formatRelativeTime), so it follows IntlProvider. Reverting to the
// `undefined` form makes this tooth reverse-RED.
test("ThreadsInbox row relative time follows the active zh-cn locale", () => {
  setDesktopViewport();
  const FIXED_NOW = Date.parse("2026-07-12T00:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const channelItem = {
      kind: "channel",
      channelId: "channel-1",
      channelName: "design",
      channelType: "channel",
      lastMessageId: "channel-message-1",
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      lastMessageAt: new Date(FIXED_NOW - 2 * 60_000).toISOString(),
      lastMessagePreview: "latest channel note",
      lastMessageSenderType: "user",
      lastMessageSenderId: "user-1",
      lastMessageSenderName: "Alice",
      unreadCount: 0,
      hasMention: false,
    } as InboxItem;

    useServerStore.setState({ current: { slug: "acme" }, members: [] } as never);
    useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} } as never);
    useAgentStore.setState({ agents: [] } as never);
    useAuthStore.setState({ user: { id: "me" } } as never);
    useInboxStore.setState({
      items: [channelItem],
      filter: "all",
      loading: false,
      loadingMore: false,
      loaded: true,
      hasMore: false,
      totalCount: 1,
      totalUnreadCount: 0,
      scrollTop: 0,
      focusedItemKey: null,
      pendingFocusKind: null,
    } as never);

    renderWithIntl(
      <MemoryRouter initialEntries={["/s/acme/activity"]}>
        <ThreadsInbox />
      </MemoryRouter>,
      { locale: "zh-cn" },
    );

    const body = document.body.textContent ?? "";
    assert.match(body, /2\s*分钟前/, "row relative time renders zh (follows the app's active locale)");
    assert.doesNotMatch(body, /minutes?\s+ago/i, "row relative time must not leak the browser-locale English");
  } finally {
    Date.now = realNow;
  }
});

// @铁根 blocker: a real server system broadcast reaches the inbox — per
// messageService `createMessage(…, "user", "system", …, "system")` projected by
// inboxTransport — as `lastMessageSenderType: "user"`, `lastMessageSenderId:
// "system"`, `lastMessageSenderName: "System"` (NOT senderType "system"). The
// sender label resolved `senderName` (that raw "System") BEFORE the
// `thread.row.systemSender` catalog key, so zh rows showed "System: …", bypassing
// the new key. The label now localizes by system identity (senderType "system"
// OR senderId "system"). This item uses the REAL transport shape so a
// senderType-only check would be a false green; reverting to name-first makes
// this tooth reverse-RED.
test("ThreadsInbox system row localizes the sender label by type (not the server name)", () => {
  setDesktopViewport();
  const systemItem = {
    kind: "channel",
    channelId: "channel-sys",
    channelName: "announcements",
    channelType: "channel",
    lastMessageId: "sys-message-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-12T00:00:00.000Z",
    lastMessagePreview: "服务已升级",
    lastMessageSenderType: "user",
    lastMessageSenderId: "system",
    lastMessageSenderName: "System",
    unreadCount: 0,
    hasMention: false,
  } as InboxItem;

  useServerStore.setState({ current: { slug: "acme" }, members: [] } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} } as never);
  useAgentStore.setState({ agents: [] } as never);
  useAuthStore.setState({ user: { id: "me" } } as never);
  useInboxStore.setState({
    items: [systemItem],
    filter: "all",
    loading: false,
    loadingMore: false,
    loaded: true,
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 0,
    scrollTop: 0,
    focusedItemKey: null,
    pendingFocusKind: null,
  } as never);

  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/activity"]}>
      <ThreadsInbox />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  const body = document.body.textContent ?? "";
  assert.match(body, /系统/, "system sender label renders the zh catalog value");
  assert.doesNotMatch(body, /\bSystem\b/, "system row must not leak the English server-side sender name");
});
