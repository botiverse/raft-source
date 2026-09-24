import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message, MessageAttachment, MessageReaction } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

// DOM behavior coverage for the data-* attributes the share-screenshot pipeline
// (src/utils/selectScreenshot.ts) reads off MessageItem's rendered DOM. Replaces
// the source-scanning assertions previously in selectScreenshotContract.test.ts
// (artin 铁律1) that also crashed the mutation-diff gate's Stryker dry-run by
// reading MessageItem.tsx after it was instrumented in place.

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

function makeImageAttachment(): MessageAttachment {
  return {
    id: "att-1",
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    width: 640,
    height: 480,
    thumbnailUrl: "/attachments/att-1?disposition=inline",
    rasterPreviewUrl: null,
    localPreviewUrl: null,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: messageId,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "screenshot target body",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

async function renderMessage(message: Message) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useMessageStore } = await import("../src/store/messageStore");
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
  useMessageStore.setState({ channelMessages: { [channelId]: [message] }, messages: [message] });

  const view = render(
    <MemoryRouter>
      <MessageItem message={message} mentionMap={new Map()} channels={[]} />
    </MemoryRouter>,
  );
  const row = view.container.querySelector<HTMLElement>(`#message-${messageId}`);
  assert.ok(row);
  return { ...view, row };
}

afterEach(cleanup);

test("image attachments expose select-screenshot dataset attributes for protected byte fetches", async () => {
  const { row } = await renderMessage(makeMessage({ attachments: [makeImageAttachment()] }));

  const img = row.querySelector<HTMLImageElement>("[data-select-screenshot-attachment-id]");
  assert.ok(img, "rendered attachment image carries the select-screenshot attachment id dataset");
  assert.equal(img.dataset.selectScreenshotAttachmentId, "att-1");
  assert.equal(img.dataset.selectScreenshotAttachmentWidth, "640");
  assert.equal(img.dataset.selectScreenshotAttachmentHeight, "480");
});

test("reaction chips carry a data-message-affordance-free box the screenshot keeps", async () => {
  // The share screenshot strips [data-message-affordance] hover controls but must
  // preserve the persisted reaction chips. Guard that the chip button itself is
  // NOT tagged with a data-message-affordance (so it survives stripping), while
  // the mobile add button IS (so it gets stripped).
  const reactions: MessageReaction[] = [
    { emoji: "👍", count: 1, reactorIds: ["user-2"], reactorNames: ["Bob"] },
  ];
  const { row } = await renderMessage(makeMessage({ reactions }));

  const chip = Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
    (b) => b.getAttribute("aria-label") === "👍 reaction from Bob",
  );
  assert.ok(chip, "persisted reaction chip renders");
  assert.equal(
    chip.closest("[data-message-affordance]"),
    null,
    "reaction chip has no data-message-affordance ancestor, so the screenshot keeps it",
  );

  const mobileAdd = row.querySelector("[data-message-affordance='mobile-reaction-add']");
  assert.ok(mobileAdd, "mobile add-reaction control is data-message-affordance tagged (stripped from screenshots)");
});
