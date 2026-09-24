import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useSelectionStore } from "../src/store/selectionStore";

// task #489 (artin): right-clicking an EXTERNAL markdown link in a message must
// surface the browser's native context menu (Open in new tab / Copy link
// address), not our custom message menu. Internal ref chips (@mention /
// #channel / task / thread / permalink) keep the message menu — the guard is
// scoped to external links via `a[target="_blank"]`.

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
    role: "member",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

// Message body carries an external markdown link + plain trailing text so we can
// right-click both the anchor and a non-link region in the same row.
function makeMessage(): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "see [example](https://example.com) for details",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

async function renderMessageItem() {
  installBrowserStubs();
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useServerStore } = await import("../src/store/serverStore");

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
  useAgentStore.setState({
    agents: [] as Agent[],
    agentActivities: {},
  });
  useChannelStore.setState({
    dmChannels: [] as Channel[],
  });

  const view = render(
    <MemoryRouter>
      <MessageItem
        message={makeMessage()}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions
      />
    </MemoryRouter>,
  );
  const body = view.container.querySelector<HTMLElement>("[data-message-id='message-1']");
  assert.ok(body);
  return { ...view, body };
}

afterEach(() => {
  act(() => {
    useSelectionStore.getState().exit();
  });
  cleanup();
});

test("MessageItem defers to the native menu when right-clicking an external link", async () => {
  const prevGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => null,
  });

  try {
    const { body } = await renderMessageItem();
    const link = body.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    assert.ok(link, "external markdown link should render as a[target=_blank]");

    fireEvent.contextMenu(link, { clientX: 64, clientY: 64 });

    // Custom menu suppressed → browser native menu is free to appear.
    assert.equal(screen.queryByText("Copy Markdown") === null, true);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});

test("MessageItem still opens its menu when right-clicking non-link message text", async () => {
  const prevGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => null,
  });

  try {
    const { body } = await renderMessageItem();

    // Right-click the row body (not inside the anchor) → custom menu opens.
    fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

    assert.equal(screen.queryByText("Copy Markdown") !== null, true);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});
