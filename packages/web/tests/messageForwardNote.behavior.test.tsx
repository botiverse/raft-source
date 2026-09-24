import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

// Node's focused TSX loader compiles imported component source with the classic
// JSX runtime, so expose React for this server-render-only harness.
(globalThis as typeof globalThis & {
  React: { createElement: typeof createElement; Fragment: typeof Fragment };
}).React = { createElement, Fragment };

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

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const { default: MessageItem } = await import("../src/components/message/MessageItem");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useServerStore } = await import("../src/store/serverStore");

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
    createdAt: "2026-05-20T00:00:00.000Z",
  };
}

function resetStores() {
  const authState = {
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  };
  const serverState: Pick<ReturnType<typeof useServerStore.getState>, "current" | "members"> = {
    current: makeServer(),
    members: [] as ServerMember[],
  };
  const agentState: Pick<ReturnType<typeof useAgentStore.getState>, "agents" | "agentActivities"> = {
    agents: [] as Agent[],
    agentActivities: {},
  };
  const channelState: Pick<ReturnType<typeof useChannelStore.getState>, "dmChannels"> = {
    dmChannels: [] as Channel[],
  };

  useAuthStore.setState(authState);
  useServerStore.setState(serverState);
  useAgentStore.setState(agentState);
  useChannelStore.setState(channelState);

  Object.assign(useAuthStore.getInitialState(), authState);
  Object.assign(useServerStore.getInitialState(), serverState);
  Object.assign(useAgentStore.getInitialState(), agentState);
  Object.assign(useChannelStore.getInitialState(), channelState);
}

function makeForwardedItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceMessageId: `source-message-${index + 1}`,
    sourceAuthorSnapshot: {
      type: "user",
      id: `source-user-${index + 1}`,
      name: `Source User ${index + 1}`,
    },
    sourceCreatedAt: "2026-05-20T00:00:00.000Z",
    sourceTargetSnapshot: {
      id: "source-channel-1",
      type: "channel",
      label: "#source",
      labelVisibility: "public",
    },
    contentSnapshot: `Forwarded body ${index + 1}`,
    attachmentSnapshots: [],
  }));
}

function makeForwardedMessage(content: string, itemCount: number): Message {
  return {
    id: `message-${itemCount}-${content.length}`,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content,
    createdAt: "2026-05-20T00:00:00.000Z",
    actionMetadata: {
      kind: "forwarded-bundle",
      version: 1,
      forwardedItems: makeForwardedItems(itemCount),
    },
  };
}

function renderMessage(message: Message) {
  resetStores();
  return renderToStaticMarkup(
    <MemoryRouter>
      <TestIntlProvider>
        <MessageItem
          message={message}
          mentionMap={new Map()}
          channels={[]}
          hideThreadActions
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("forwarded bundle keeps a user-entered forwarding note above the bundle card", () => {
  const html = renderMessage(makeForwardedMessage("Please **read** this before the forwarded messages.", 2));

  assert.match(html, /Please <strong>read<\/strong> this before the forwarded messages\./);
  assert.match(html, /data-testid="forwarded-bundle-card"/);
  assert.ok(
    html.indexOf("Please <strong>read</strong> this before the forwarded messages.") < html.indexOf("data-testid=\"forwarded-bundle-card\""),
    "forwarder note should render before the forwarded bundle card",
  );
  assert.match(html, /Forwarded body 1/);
});

test("forwarded bundle suppresses generated plural fallback content as a note", () => {
  const html = renderMessage(makeForwardedMessage("  Forwarded 2 messages  ", 2));

  assert.doesNotMatch(html, /data-testid="forwarded-bundle-note"/);
  assert.doesNotMatch(html, /Stryker was here!/);
  assert.doesNotMatch(html, />\s*Forwarded 2 messages\s*</);
  assert.match(html, /data-testid="forwarded-bundle-card"/);
  assert.match(html, /Forwarded body 1/);
});

test("forwarded bundle suppresses generated singular fallback content as a note", () => {
  const html = renderMessage(makeForwardedMessage("Forwarded 1 message", 1));

  assert.doesNotMatch(html, /data-testid="forwarded-bundle-note"/);
  assert.doesNotMatch(html, /Stryker was here!/);
  assert.doesNotMatch(html, />\s*Forwarded 1 message\s*</);
  assert.match(html, /data-testid="forwarded-bundle-card"/);
  assert.match(html, /Forwarded body 1/);
});

test("forwarded bundle suppresses whitespace-only content as a note", () => {
  const html = renderMessage(makeForwardedMessage("   ", 2));

  assert.doesNotMatch(html, /data-testid="forwarded-bundle-note"/);
  assert.match(html, /data-testid="forwarded-bundle-card"/);
});

test("destination attachment projections are clickable while legacy excluded snapshots stay inert", () => {
  const projected = makeForwardedMessage("Forwarded 1 message", 1);
  projected.attachments = [{
    id: "00000000-0000-4000-8000-000000000001",
    filename: "projected.pdf",
    mimeType: "application/pdf",
    sizeBytes: 42,
    width: null,
    height: null,
    thumbnailUrl: null,
  }];
  const projectedMetadata = projected.actionMetadata as { forwardedItems: Array<Record<string, unknown>> };
  projectedMetadata.forwardedItems[0] = {
    ...projectedMetadata.forwardedItems[0],
    attachmentPolicy: "projected",
    attachmentSnapshots: [{
      id: "00000000-0000-4000-8000-000000000001",
      filename: "projected.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    }],
  };
  const projectedHtml = renderMessage(projected);
  assert.match(projectedHtml, /data-testid="forwarded-bundle-attachment"/);
  assert.match(projectedHtml, /aria-label="Open projected\.pdf"/);
  assert.doesNotMatch(
    projectedHtml,
    /data-message-affordance="attachment-meta"/,
    "Forward projections should render only inside the bundle card, not a duplicate ordinary attachment block",
  );

  const excluded = makeForwardedMessage("Forwarded 1 message", 1);
  const excludedMetadata = excluded.actionMetadata as { forwardedItems: Array<Record<string, unknown>> };
  excludedMetadata.forwardedItems[0] = {
    ...excludedMetadata.forwardedItems[0],
    attachmentPolicy: "excluded",
    attachmentSnapshots: [{ filename: "legacy.pdf", mimeType: "application/pdf" }],
  };
  const excludedHtml = renderMessage(excluded);
  assert.doesNotMatch(excludedHtml, /data-testid="forwarded-bundle-attachment"/);
  assert.match(excludedHtml, /legacy\.pdf/);
});
test("projected Forward images use a three-column scrolling gallery while files stay chips", () => {
  const projected = makeForwardedMessage("Forwarded 1 message", 1);
  const projectedMetadata = projected.actionMetadata as { forwardedItems: Array<Record<string, unknown>> };
  projectedMetadata.forwardedItems[0] = {
    ...projectedMetadata.forwardedItems[0],
    attachmentPolicy: "projected",
    attachmentSnapshots: [
      { id: "00000000-0000-4000-8000-000000000011", filename: "one.jpg", mimeType: "image/jpeg" },
      { id: "00000000-0000-4000-8000-000000000012", filename: "two.png", mimeType: "image/png" },
      { id: "00000000-0000-4000-8000-000000000013", filename: "three.webp", mimeType: "image/webp" },
      { id: "00000000-0000-4000-8000-000000000014", filename: "four.gif", mimeType: "image/gif" },
      { id: "00000000-0000-4000-8000-000000000015", filename: "notes.txt", mimeType: "text/plain" },
    ],
  };

  const html = renderMessage(projected);
  assert.match(html, /data-testid="forwarded-bundle-image-strip"/);
  assert.match(html, /data-testid="forwarded-bundle-image-scroller"/);
  assert.equal((html.match(/data-testid="forwarded-bundle-image"/g) ?? []).length, 4);
  assert.match(html, /data-testid="forwarded-bundle-image-shadow-right"/);
  assert.doesNotMatch(html, /data-testid="forwarded-bundle-image-shadow-left"/);
  assert.doesNotMatch(html, /bg-gradient-to-[rl] from-white\/80 to-transparent/);
  assert.match(html, /data-testid="forwarded-bundle-file-chips"/);
  assert.match(html, /notes\.txt/);
  assert.equal((html.match(/data-testid="forwarded-bundle-attachment"/g) ?? []).length, 5);
});
