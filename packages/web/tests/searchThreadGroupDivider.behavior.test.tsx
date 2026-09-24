import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import type { Locale } from "../src/i18n/locale";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Server, ServerMember } from "../src/store/serverStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

function installBrowserStubs() {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
}

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
    role: "owner",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

type PanelSource = { title?: string; subtitle?: string };

async function renderSearchPage(
  locale?: Locale,
  onDragPanelRef?: (event: unknown, ref: unknown, source?: PanelSource) => void,
  query = "visual",
) {
  installBrowserStubs();
  localStorage.setItem("slock_access_token", "token");
  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useThreadStore } = await import("../src/store/threadStore");

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
  useChannelStore.setState({
    channels: [] as Channel[],
    dmChannels: [] as Channel[],
  });
  useAgentStore.setState({
    agents: [] as Agent[],
    agentActivities: {},
  });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
  });

  const tree = createElement(
    MemoryRouter,
    { initialEntries: [`/s/server/search?q=${query}`] },
    createElement(MessageSearchPage, { onDragPanelRef: onDragPanelRef as never }),
  );
  return locale
    ? rtlRender(createElement(TestIntlProvider, { locale }, tree))
    : render(tree);
}

afterEach(() => {
  cleanup();
});

test("thread search result groups render only one divider between the pink header and first hit", async () => {
  const originalGet = api.get;
  api.get = async (url: string) => {
    assert.equal(url, "/messages/search");
    return {
      data: {
        hasMore: false,
        results: [
          {
            id: "message-1",
            channelId: "thread-1",
            threadId: "thread-root-1",
            parentMessageId: "parent-1",
            parentMessageContent: "Parent thread title for visual testing",
            parentChannelId: "channel-1",
            parentChannelName: "visual-testing",
            parentChannelType: "channel",
            parentChannelArchivedAt: null,
            senderId: "user-1",
            senderType: "user",
            senderName: "Current User",
            channelName: "thread",
            channelType: "thread",
            channelArchivedAt: null,
            content: "visual testing first hit",
            snippet: "visual testing first hit",
            createdAt: "2026-07-01T04:00:00.000Z",
          },
          {
            id: "message-2",
            channelId: "thread-1",
            threadId: "thread-root-1",
            parentMessageId: "parent-1",
            parentMessageContent: "Parent thread title for visual testing",
            parentChannelId: "channel-1",
            parentChannelName: "visual-testing",
            parentChannelType: "channel",
            parentChannelArchivedAt: null,
            senderId: "user-1",
            senderType: "user",
            senderName: "Current User",
            channelName: "thread",
            channelType: "thread",
            channelArchivedAt: null,
            content: "visual testing second hit",
            snippet: "visual testing second hit",
            createdAt: "2026-07-01T04:01:00.000Z",
          },
        ],
      },
    };
  };

  try {
    await renderSearchPage();

    await waitFor(() => {
      assert.ok(screen.getByText("2 hits"));
    });

    const title = screen.getByText("Parent thread title for visual testing");
    const header = title.parentElement;
    assert.ok(header instanceof HTMLElement);
    assert.ok(
      header.classList.contains("border-b-2"),
      "The rendered pink thread header keeps the strong header divider.",
    );

    const hitsWrapper = header.nextElementSibling;
    assert.ok(hitsWrapper instanceof HTMLElement);
    assert.equal(
      hitsWrapper.classList.contains("[&>*:first-child]:border-t-0"),
      true,
      "The rendered hit list suppresses only the first hit's top border so it does not stack with the header divider.",
    );

    const buttons = Array.from(document.querySelectorAll("button"));
    const firstHit = buttons.find((button) => button.textContent?.includes("visual testing first hit"));
    const secondHit = buttons.find((button) => button.textContent?.includes("visual testing second hit"));
    assert.ok(firstHit instanceof HTMLElement);
    assert.ok(secondHit instanceof HTMLElement);
    assert.equal(firstHit.classList.contains("border-t-2"), true);
    assert.equal(secondHit.classList.contains("border-t-2"), true);
  } finally {
    api.get = originalGet;
  }
});

// --- MI search i18n tooth: thread-group chrome renders zh, and the group
// relative time follows the APP locale (react-intl) — not the browser system
// locale. Pre-migration searchGrouping used Intl.RelativeTimeFormat(undefined)
// so zh UI showed English "… ago"; the descriptor + intl.formatRelativeTime fix
// makes it Chinese. Reverse-RED: reverting to the browser-locale formatter (or
// a search.* zh key) fails these. ---
test("i18n: thread group renders zh chrome and app-locale relative time", async () => {
  const originalGet = api.get;
  api.get = async () => ({
    data: {
      hasMore: false,
      results: [
        {
          id: "message-1",
          channelId: "thread-1",
          threadId: "thread-root-1",
          parentMessageId: "parent-1",
          parentMessageContent: "Parent thread title for visual testing",
          parentChannelId: "channel-1",
          parentChannelName: "visual-testing",
          parentChannelType: "channel",
          parentChannelArchivedAt: null,
          senderId: "user-1",
          senderType: "user",
          senderName: "Current User",
          channelName: "thread",
          channelType: "thread",
          channelArchivedAt: null,
          content: "visual testing first hit",
          snippet: "visual testing first hit",
          createdAt: "2026-07-01T04:00:00.000Z",
        },
        {
          id: "message-2",
          channelId: "thread-1",
          threadId: "thread-root-1",
          parentMessageId: "parent-1",
          parentMessageContent: "Parent thread title for visual testing",
          parentChannelId: "channel-1",
          parentChannelName: "visual-testing",
          parentChannelType: "channel",
          parentChannelArchivedAt: null,
          senderId: "user-1",
          senderType: "user",
          senderName: "Current User",
          channelName: "thread",
          channelType: "thread",
          channelArchivedAt: null,
          content: "visual testing second hit",
          snippet: "visual testing second hit",
          createdAt: "2026-07-01T04:01:00.000Z",
        },
      ],
    },
  });

  try {
    await renderSearchPage("zh-cn");

    // Chrome: hits count (ICU) + thread badge localized.
    await waitFor(() => assert.ok(screen.getByText("2 条匹配")));
    assert.ok(screen.getAllByText("消息列").length > 0);

    // Relative time follows the app locale (zh), not the browser system locale.
    const body = document.body.textContent ?? "";
    assert.match(body, /前|后|分钟|小时|天|现在/, "group relative time renders in Chinese");
    assert.doesNotMatch(body, /\bago\b|\bminutes?\b|\bhours?\b|\bdays?\b/, "no English relative-time leaks under zh");
  } finally {
    api.get = originalGet;
  }
});

// --- 赵梓淇 post-merge audit fast-follow: the message DRAG handoff panel chrome
// must localize like the click path (different indentation had slipped the
// replace_all). Behavioral tooth for the thread title (his exact proof:
// actual "Thread parent-1" -> expected "消息列 parent-1") plus a mounted
// non-thread subtitle tooth. Reverse-RED: reverting either formatter fails the
// corresponding drag assertion. ---
test("i18n: message drag handoff localizes thread and channel panel chrome under zh", async () => {
  const originalGet = api.get;
  api.get = async (url: string) => {
    assert.equal(url, "/messages/search");
    return {
      data: {
        hasMore: false,
        results: [
          {
            id: "message-1",
            channelId: "thread-1",
            threadId: "thread-root-1",
            parentMessageId: "parent-1",
            parentMessageContent: "Parent thread title for visual testing",
            parentChannelId: "channel-1",
            parentChannelName: "visual-testing",
            parentChannelType: "channel",
            parentChannelArchivedAt: null,
            senderId: "user-1",
            senderType: "user",
            senderName: "Current User",
            channelName: "thread",
            channelType: "thread",
            channelArchivedAt: null,
            content: "visual testing first hit",
            snippet: "visual testing first hit",
            createdAt: "2026-07-01T04:00:00.000Z",
          },
          {
            id: "message-2",
            channelId: "channel-1",
            senderId: "user-1",
            senderType: "user",
            senderName: "Current User",
            channelName: "general",
            channelType: "channel",
            channelArchivedAt: null,
            content: "visual testing channel hit",
            snippet: "visual testing channel hit",
            createdAt: "2026-07-01T04:01:00.000Z",
          },
        ],
      },
    };
  };

  const sources: PanelSource[] = [];
  try {
    await renderSearchPage("zh-cn", (_event, _ref, source) => {
      if (source) sources.push(source);
    }, "drag-probe");

    await waitFor(() => {
      assert.ok(Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("visual testing first hit")));
      assert.ok(Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("visual testing channel hit")));
    });
    const buttons = Array.from(document.querySelectorAll("button"));
    const threadHit = buttons.find((button) => button.textContent?.includes("visual testing first hit"))!;
    const channelHit = buttons.find((button) => button.textContent?.includes("visual testing channel hit"))!;
    fireEvent.dragStart(threadHit);
    fireEvent.dragStart(channelHit);

    assert.ok(sources.some((s) => s.title === "消息列 parent-1"), "thread drag panel title is localized (消息列 parent-1)");
    assert.ok(
      sources.some((source) => source.title === "#general" && source.subtitle === "搜索结果"),
      "channel drag panel subtitle is localized (搜索结果)",
    );
  } finally {
    api.get = originalGet;
  }
});
