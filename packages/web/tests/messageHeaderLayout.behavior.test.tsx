import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Locale } from "../src/i18n/locale";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

// DOM behavior coverage for the message header layout: the reserved top-right
// action gutter (so floating hover affordances never overlap the header text)
// and the time / name / subtitle truncation priorities. Replaces the
// source-scanning assertions previously in messageBookmarkActionSpacing.test.ts
// (artin 铁律1) which read MessageItem.tsx after the mutation-diff gate
// instrumented it in place.

const channelId = "channel-1";
const messageId = "message-1";

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
    id: messageId,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    senderDescription: "Head of Ops",
    messageType: "chat",
    content: "header layout body",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

function makeDeletedAgent(): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    serverName: "Server",
    serverSlug: "server",
    name: "milo",
    displayName: "Milo",
    avatarUrl: null,
    description: "macmini",
    status: "inactive",
    model: "claude",
    runtime: "codex",
    external: false,
    serverRole: "member",
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: null,
    sessionId: null,
    runtimeProfile: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: "2026-08-14T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeAgentMessage(): Message {
  return {
    ...makeMessage(),
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Milo",
    senderDescription: "macmini",
  };
}

async function renderMessage(options: { agents?: Agent[]; message?: Message; locale?: Locale } = {}) {
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
  useAgentStore.setState({ agents: options.agents ?? [], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const ui = (
    <MemoryRouter>
      <MessageItem message={options.message ?? makeMessage()} mentionMap={new Map()} channels={[]} />
    </MemoryRouter>
  );
  const view = options.locale
    ? rtlRender(<TestIntlProvider locale={options.locale}>{ui}</TestIntlProvider>)
    : render(ui);
  const row = view.container.querySelector<HTMLElement>(`#message-${messageId}`);
  assert.ok(row);
  return { ...view, row };
}

afterEach(cleanup);

function findSenderName(row: HTMLElement) {
  return Array.from(row.querySelectorAll<HTMLElement>("span, button")).find(
    (el) => el.textContent === "Current User",
  );
}

test("header reserves a right-side gutter so floating affordances never overlap text", async () => {
  const { row } = await renderMessage();
  const name = findSenderName(row);
  assert.ok(name, "sender name renders");
  const header = name.parentElement;
  assert.ok(header);
  // The header row reserves a right gutter (pr-24) and clips overflow so the
  // floating hover toolbar sits in reserved space.
  assert.match(header.className, /(?:^| )pr-24(?: |$)/);
  assert.match(header.className, /(?:^| )overflow-hidden(?: |$)/);
});

test("header prioritizes time, name, then subtitle truncation", async () => {
  const { row } = await renderMessage();

  const name = findSenderName(row);
  assert.ok(name);
  // Name shrinks and truncates but never collapses below its content.
  assert.match(name.className, /(?:^| )min-w-0(?: |$)/);
  assert.match(name.className, /(?:^| )shrink-0(?: |$)/);
  assert.match(name.className, /(?:^| )truncate(?: |$)/);

  const subtitle = row.querySelector<HTMLElement>("span[title='Head of Ops']");
  assert.ok(subtitle, "subtitle renders with a title tooltip");
  // Subtitle is the first to truncate: min-w-0 + truncate, but NOT shrink-0.
  assert.match(subtitle.className, /(?:^| )min-w-0(?: |$)/);
  assert.match(subtitle.className, /(?:^| )truncate(?: |$)/);
  assert.doesNotMatch(subtitle.className, /(?:^| )shrink-0(?: |$)/);

  // Time never wraps or truncates — it stays fixed on the right.
  const time = Array.from(row.querySelectorAll<HTMLElement>("span")).find((el) =>
    /(?:^| )whitespace-nowrap(?: |$)/.test(el.className) && /font-mono/.test(el.className),
  );
  assert.ok(time, "timestamp renders as a non-wrapping mono span");
  assert.match(time.className, /(?:^| )shrink-0(?: |$)/);
});

test("deleted sender badge stays on one line in compact localized headers", async () => {
  const { row } = await renderMessage({ agents: [makeDeletedAgent()], message: makeAgentMessage(), locale: "zh-cn" });

  const deletedBadge = Array.from(row.querySelectorAll<HTMLElement>("span")).find((el) => el.textContent === "已删除");
  assert.ok(deletedBadge, "localized deleted sender badge renders");
  assert.match(deletedBadge.className, /(?:^| )shrink-0(?: |$)/);
  assert.match(deletedBadge.className, /(?:^| )whitespace-nowrap(?: |$)/);
});
