import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import ThreadWindowRoute from "../src/components/window/ThreadWindowRoute";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";

const originalGet = api.get.bind(api);
const originalClose = window.close;
const originalClosedDescriptor = Object.getOwnPropertyDescriptor(window, "closed");
window.matchMedia = window.matchMedia ?? ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
}) as MediaQueryList);
globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
} as typeof IntersectionObserver;
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {} unobserve() {} disconnect() {}
} as typeof ResizeObserver;
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo ?? function scrollTo(options?: ScrollToOptions | number) {
  this.scrollTop = typeof options === "number" ? options : options?.top ?? 0;
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="route-location">{location.pathname}{location.search}</output>;
}

function seedRoute() {
  const parentChannel: Channel = {
    id: "parent-channel", serverId: "route-server", name: "parent", description: null,
    type: "channel", createdAt: "2026-07-03T00:00:00.000Z", joined: true,
    activityMuteSupported: false,
  };
  const threadChannel: Channel = {
    ...parentChannel, id: "thread-channel", type: "thread", name: "thread",
  };
  const parent: Message = {
    id: "parent-message", channelId: parentChannel.id, senderType: "user", senderId: "user-1",
    senderName: "Ada", messageType: "chat", content: "parent context",
    createdAt: "2026-07-03T00:00:00.000Z", seq: 1, threadId: threadChannel.id,
  };
  const reply: Message = {
    ...parent, id: "reply-1", channelId: threadChannel.id, content: "a reply", seq: 2,
  };

  useAuthStore.setState({
    user: {
      id: "user-1", email: "ada@example.com", gravatarHash: "", name: "ada", displayName: "Ada",
      description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null,
      preferredTimezone: "UTC", autoTranslationEnabled: false, preferredTranslationDisplay: "original",
      preferredTimeFormat: null, preferredMessageBodyFontSize: null, referralSource: null,
      referralSourceOther: null, referralSourceSkippedAt: null,
    },
    initialized: true,
  });
  useServerStore.setState({
    current: {
      id: "route-server", name: "Route Server", avatarUrl: null, slug: "acme", ownerId: "user-owner",
      onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null,
      role: "member", createdAt: "2026-07-03T00:00:00.000Z",
    },
    members: [],
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel], dmChannels: [],
    channelActivity: { [parentChannel.id]: null, [threadChannel.id]: null },
    ensureChannel: async (channelId) => [parentChannel, threadChannel].find((channel) => channel.id === channelId) ?? null,
  });
  useMessageStore.setState({
    messages: [], channelMessages: { [parentChannel.id]: [parent], [threadChannel.id]: [reply] },
    loading: false, loadingOlder: false, loadingNewer: false, loadingGap: false,
    hasMore: false, hasNewer: false, hasGap: false, contextLoadError: null,
    highlightedMessageId: null, transientFocusRequest: null, unreadCounts: {}, mentionFlags: {},
    currentUserId: "user-1", drafts: {}, historyLimited: false, isNearBottom: true,
  });
  useThreadStore.setState({
    openParentMessageId: null, openParentChannelId: null, openThreadChannelId: null,
    openThreadError: null, openThreadLoading: false, openIntent: null, focusedMessageId: null,
    summaries: {
      [parent.id]: {
        threadChannelId: threadChannel.id, replyCount: 1, lastReplyAt: reply.createdAt,
        participantIds: [], unreadCount: 0, firstUnreadMessageId: null,
      },
    },
    openThread: async ({ serverSlug, parentChannelId, parentMessageId, focusedMessageId, intent = "thread" }) => {
      useThreadStore.setState({
        openParentMessageId: parentMessageId, openParentChannelId: parentChannelId,
        openThreadChannelId: "thread-channel", openServerSlug: serverSlug ?? "acme",
        focusedMessageId: focusedMessageId ?? null, openIntent: intent,
        openThreadError: null, openThreadLoading: false,
      });
    },
  });
  useTaskStore.setState({
    tasks: [], serverTasks: [], tasksByChannelId: {}, currentChannelId: null,
    loadTasks: async () => {}, loadServerTasks: async () => {},
  });
  api.get = (async (url: string) => {
    if (url.includes("/messages/forward/enabled")) return { data: { enabled: false } };
    if (url.includes("/messages/context/")) return { data: { messages: [parent] } };
    if (url.includes("/messages/channel/thread-channel")) return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    return { data: {} };
  }) as typeof api.get;
}

function renderRoute() {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/thread-window?thread=parent-channel:parent-message"]}>
        <Routes>
          <Route path="/s/:serverSlug/thread-window" element={<ThreadWindowRoute />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function renderTaskRoute() {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/thread-window?thread=parent-channel:parent-message&task=1"]}>
        <Routes>
          <Route path="/s/:serverSlug/thread-window" element={<ThreadWindowRoute />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function installClosedSignal(closedAfterClose: boolean) {
  let closed = false;
  Object.defineProperty(window, "closed", {
    configurable: true,
    get: () => closed,
  });
  window.close = (() => {
    closed = closedAfterClose;
  }) as typeof window.close;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  window.close = originalClose;
  if (originalClosedDescriptor) Object.defineProperty(window, "closed", originalClosedDescriptor);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});

test("mounted thread route closes a script-opened tab without navigation", async () => {
  seedRoute();
  installClosedSignal(true);
  renderRoute();
  await waitFor(() => assert.ok(screen.getByTestId("thread-close")));
  const before = screen.getByTestId("route-location").textContent;
  await act(async () => { fireEvent.click(screen.getByTestId("thread-close")); });
  assert.equal(screen.getByTestId("route-location").textContent, before);
  assert.equal(window.closed, true);
});

test("mounted thread route executes direct-tab close callback and returns to server", async () => {
  seedRoute();
  installClosedSignal(false);
  renderRoute();
  await waitFor(() => assert.ok(screen.getByTestId("thread-close")));
  await act(async () => { fireEvent.keyDown(screen.getByTestId("thread-close"), { key: "Escape" }); });
  await waitFor(() => assert.equal(screen.getByTestId("route-location").textContent, "/s/acme"));
});

test("task route exposes icon-only view-in-channel and close actions", async () => {
  seedRoute();
  const task = {
    id: "task-1", messageId: "parent-message", channelId: "parent-channel", channelName: "parent",
    taskNumber: 1, title: "Task", status: "todo" as const, createdById: "user-1", createdByType: "user" as const,
    createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z", isLegacy: false,
  };
  useTaskStore.setState({ tasks: [task], tasksByChannelId: { "parent-channel": [task] } });
  renderTaskRoute();
  await waitFor(() => assert.ok(screen.getByTestId("task-view-in-channel")));
  assert.ok(screen.getByTestId("task-close").querySelector("svg"));
  await act(async () => { fireEvent.click(screen.getByTestId("task-view-in-channel")); });
  await waitFor(() => assert.equal(screen.getByTestId("route-location").textContent, "/s/acme/channel/parent-channel?msg=parent-message"));
});
