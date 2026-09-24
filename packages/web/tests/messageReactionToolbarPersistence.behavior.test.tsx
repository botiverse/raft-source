import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import "./helpers/domSetup";
import { MessageHoverToolbar } from "../src/components/message/MessageHoverToolbar";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

const originalMatchMedia = window.matchMedia;

function installMatchMedia(coarsePointer: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(pointer: coarse)" ? coarsePointer : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

beforeEach(() => installMatchMedia(false));

afterEach(() => {
  cleanup();
  if (typeof originalMatchMedia === "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  } else {
    installMatchMedia(false);
  }
});

function ToolbarHarness({ canReact = true }: { canReact?: boolean }) {
  const [reactionActive, setReactionActive] = useState(false);

  return (
    <div className="group/message">
      <MessageHoverToolbar
        isSaved={false}
        reactionActive={reactionActive}
        canReact={canReact}
        onReplyInThread={() => {}}
        onReactionClick={() => setReactionActive((active) => !active)}
        onToggleSave={() => {}}
      />
    </div>
  );
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
    content: "reaction target body",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

async function renderMessage({ canReact = true }: { canReact?: boolean } = {}) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: makeServer(), members: [] as ServerMember[] });
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const message = makeMessage();
  const view = render(
    <MemoryRouter>
      <MessageItem message={message} mentionMap={new Map()} channels={[]} canReact={canReact} />
    </MemoryRouter>,
  );
  const row = view.container.querySelector<HTMLElement>("#message-message-1");
  assert.ok(row);
  return { ...view, row };
}

test("opening the reaction picker pins the message toolbar visible outside row hover", () => {
  const { container } = render(<ToolbarHarness />);
  const toolbar = container.querySelector<HTMLElement>("[data-message-affordance='toolbar']");
  const reactionButton = container.querySelector<HTMLButtonElement>("[data-message-affordance='reaction']");
  assert.ok(toolbar);
  assert.ok(reactionButton);
  assert.equal(toolbar.classList.contains("hidden"), false, "resting toolbar stays mounted for stable hover clicks");
  assert.equal(toolbar.classList.contains("pointer-events-none"), false);
  assert.equal(toolbar.classList.contains("opacity-0"), true);

  fireEvent.click(reactionButton);

  assert.equal(reactionButton.getAttribute("aria-expanded"), "true");
  assert.equal(toolbar.classList.contains("opacity-100"), true);
  assert.equal(toolbar.classList.contains("flex"), true);
});

test("read-only messages omit the reaction action while keeping non-mutating toolbar actions", () => {
  const { container } = render(<ToolbarHarness canReact={false} />);
  assert.equal(container.querySelector("[data-message-affordance='reaction']"), null);
  assert.ok(container.querySelector("[data-message-affordance='thread']"));
  assert.ok(container.querySelector("[data-message-affordance='bookmark']"));
});

test("read-only messages omit the reaction quick row from the context menu", async () => {
  const { row } = await renderMessage({ canReact: false });

  fireEvent.contextMenu(row);

  assert.ok(document.querySelector("[role='menu']"), "the non-mutating context menu remains available");
  const reactionQuickRow = document.querySelector("[data-message-affordance='reaction-quick-row']");
  cleanup();
  assert.equal(reactionQuickRow, null);
});

test("coarse pointers do not render the desktop hover toolbar", () => {
  installMatchMedia(true);

  const { container } = render(<ToolbarHarness />);

  assert.equal(
    container.querySelector("[data-message-affordance='toolbar']"),
    null,
    "touch devices use the long-press menu and must not expose sticky-hover actions",
  );
});

test("opening the reaction picker keeps the message row's outer frame active", async () => {
  const { row } = await renderMessage();
  const reactionButton = row.querySelector<HTMLButtonElement>("[data-message-affordance='reaction']");
  assert.ok(reactionButton);
  assert.equal(row.classList.contains("border-transparent"), true, "resting row keeps its transparent border");

  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  try {
    fireEvent.click(reactionButton);
  } finally {
    globalThis.CustomEvent = originalCustomEvent;
  }

  assert.ok(document.querySelector("[data-message-affordance='reaction-picker']"));
  assert.equal(
    row.classList.contains("border-black"),
    true,
    "the message frame must stay active while the pointer can move through the portaled picker",
  );
  assert.equal(row.classList.contains("border-transparent"), false);
  assert.equal(row.classList.contains("bg-white"), true);
});
