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

function makeMessage(): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "selected height cleanup",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

function firstTextNode(root: Node): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  assert.ok(node instanceof Text);
  return node;
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

test("MessageItem opens the normal context menu when no message text is selected", async () => {
  const prevGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => null,
  });

  try {
    const { body } = await renderMessageItem();
    fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

    assert.equal(screen.queryByText("Copy Markdown") !== null, true);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});

test("MessageItem opens the normal context menu when message text is selected", async () => {
  const prevGetSelection = window.getSelection;

  try {
    const { body } = await renderMessageItem();
    const textNode = firstTextNode(body);
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode,
      focusNode: textNode,
      toString: () => "height",
      getRangeAt: () => document.createRange(),
    } as unknown as Selection;
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => selection,
    });

    fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

    assert.equal(screen.queryByText("Copy Markdown") !== null, true);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});

test("MessageItem suppresses its context menu after entering select mode post-render", async () => {
  const prevGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => null,
  });

  try {
    const { body } = await renderMessageItem();
    await act(async () => {
      useSelectionStore.getState().enter("channel-1", ["message-1"]);
    });

    await screen.findByTestId("message-select-circle-message-1");

    fireEvent.contextMenu(body, { clientX: 64, clientY: 64 });

    assert.equal(screen.queryByText("Copy Markdown") === null, true);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});
