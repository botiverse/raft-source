import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SyncScopeKey } from "@botiverse/raft-shared";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message, MessageReaction } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { reactionReadModelStore } from "../src/store/reactionReadModels";
import {
  prefetchServerFeatureFlags,
  resetServerFeatureFlagsForTests,
  SYNC_CORE_MESSAGES_FLAG_KEY,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

// DOM behavior coverage for the reaction chips / mobile add / floating picker /
// optimistic toggle that MessageItem renders. Replaces the source-scanning
// assertions previously in messageReactionsContract.test.ts (artin 铁律1: test
// behavior, not component source) — those also crashed the mutation-diff gate's
// Stryker dry-run because it instruments MessageItem.tsx in place.

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

function makeMessage(reactions?: MessageReaction[]): Message {
  return {
    id: messageId,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "reaction target body",
    createdAt: "2026-06-30T00:00:00.000Z",
    reactions,
  };
}

async function renderMessage(
  message: Message,
  reactionParentScopeKey?: SyncScopeKey,
  canReact = true,
) {
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
  useSavedStore.setState({
    saved: [],
    savedIds: new Set(),
    loading: false,
    hasMore: false,
  });
  useMessageStore.setState({
    channelMessages: { [channelId]: [message] },
    messages: [message],
    currentUserId: "user-1",
  });

  const view = render(
    <MemoryRouter>
      <MessageItem
        message={message}
        mentionMap={new Map()}
        channels={[]}
        reactionParentScopeKey={reactionParentScopeKey}
        canReact={canReact}
      />
    </MemoryRouter>,
  );
  const row = view.container.querySelector<HTMLElement>(`#message-${messageId}`);
  assert.ok(row);
  const rerenderMessage = (nextMessage: Message) => view.rerender(
    <MemoryRouter>
      <MessageItem
        message={nextMessage}
        mentionMap={new Map()}
        channels={[]}
        reactionParentScopeKey={reactionParentScopeKey}
        canReact={canReact}
      />
    </MemoryRouter>,
  );
  return { ...view, row, useMessageStore, rerenderMessage };
}

afterEach(() => {
  cleanup();
  reactionReadModelStore.getState().reset();
  resetServerFeatureFlagsForTests();
});

test("visible reactions render as chips with glyph, count, and reactor summary", async () => {
  const { row, rerenderMessage } = await renderMessage(
    makeMessage([
      { emoji: "👍", count: 2, reactorIds: ["user-1", "user-2"], reactorNames: ["Current User", "Bob"] },
      { emoji: "🎉", count: 0, reactorIds: [], reactorNames: [] },
    ]),
  );

  // count > 0 chip renders; count === 0 reaction is filtered out.
  const chip = Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
    (b) => b.getAttribute("aria-label") === "👍 reaction from Current User, Bob",
  );
  assert.ok(chip, "reaction chip renders with an aria-label summarizing the reactors");
  // Sprite-backed glyph + numeric count both appear inside the chip.
  assert.ok(chip.querySelector("[data-reaction-glyph='thumbs_up']"), "chip renders the reaction glyph");
  assert.match(chip.textContent ?? "", /2/);
  // The zero-count reaction never produces a chip.
  assert.equal(row.querySelector("[data-reaction-glyph='party_popper']"), null);

  rerenderMessage(makeMessage([
    { emoji: "👍", count: 3, reactorIds: ["user-1", "user-2", "user-3"], reactorNames: ["Current User", "Bob", "Eve"] },
  ]));
  await waitFor(() => assert.ok(row.querySelector(".reaction-count-bump"), "a changed visible count mounts the shared bump-animation hook"));
});

test("read-only reaction summaries stay visible but expose no mutation affordance", async () => {
  const { row } = await renderMessage(
    makeMessage([
      { emoji: "👍", count: 2, reactorIds: ["user-1", "user-2"], reactorNames: ["Current User", "Bob"] },
    ]),
    undefined,
    false,
  );

  const summary = Array.from(row.querySelectorAll<HTMLElement>("[aria-label]")).find(
    (entry) => entry.getAttribute("aria-label") === "👍 reaction from Current User, Bob",
  );
  assert.ok(summary, "the existing reaction summary remains visible");
  assert.equal(summary.tagName, "SPAN", "read-only summaries are inert instead of clickable buttons");
  assert.equal(
    summary.closest("[data-message-affordance]"),
    null,
    "the screenshot pipeline keeps the static reaction summary",
  );
  assert.equal(row.querySelector("[data-message-affordance='mobile-reaction-add']"), null);
});

test("normalized reactions render shared count with viewer overlay and detail cache", async (t) => {
  useServerStore.setState({ current: makeServer() });
  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, "/feature-flags/evaluate");
    return {
      data: {
        evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
      },
    };
  });
  await prefetchServerFeatureFlags("server-1");
  reactionReadModelStore.getState().activatePrincipal("user-1");

  const sharedFact = reactionReadModelStore.getState().applyLegacyIngress({
    principalId: "user-1",
    serverId: "server-1",
    parentScopeKey: { serverId: "server-1", scopeKind: "channel", scopeId: channelId },
    messageId,
    source: "receiver-private",
    viewerUserId: "user-1",
    reactions: [{
      emoji: "👍",
      count: 2,
      reactorIds: ["user-1", "user-2"],
      reactorNames: ["Current User", "Bob"],
    }],
  });
  const { row } = await renderMessage(makeMessage([...sharedFact]));

  const chip = Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
    (button) => button.getAttribute("aria-label") === "👍 reaction from Current User, Bob",
  );
  assert.ok(chip);
  assert.match(chip.className, /bg-brutal-pink\/20/);
  assert.equal(JSON.stringify(sharedFact).includes("reactorIds"), false);
});

test("an unselected normalized reaction uses the shared neutral fill and hover", async (t) => {
  useServerStore.setState({ current: makeServer() });
  t.mock.method(api, "post", async () => ({
    data: {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
    },
  }));
  await prefetchServerFeatureFlags("server-1");
  reactionReadModelStore.getState().activatePrincipal("user-1");

  const sharedFact = reactionReadModelStore.getState().applyLegacyIngress({
    principalId: "user-1",
    serverId: "server-1",
    parentScopeKey: { serverId: "server-1", scopeKind: "channel", scopeId: channelId },
    messageId,
    source: "receiver-private",
    viewerUserId: "user-1",
    reactions: [{
      emoji: "👍",
      count: 1,
      reactorIds: ["user-2"],
      reactorNames: ["Bob"],
    }],
  });
  const { row } = await renderMessage(makeMessage([...sharedFact]));

  const chip = Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
    (button) => button.getAttribute("aria-label") === "👍 reaction from Bob",
  );
  assert.ok(chip);
  assert.match(chip.className, /bg-black\/\[0\.03\]/, "an unselected reaction shares the neutral 3% fill");
  assert.match(chip.className, /hover:bg-black\/\[0\.08\]/, "an unselected reaction shares the neutral 8% hover");
});

test("normalized thread reactions read detail from the explicit local parent scope", async (t) => {
  useServerStore.setState({ current: makeServer() });
  t.mock.method(api, "post", async () => ({
    data: {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
    },
  }));
  await prefetchServerFeatureFlags("server-1");
  reactionReadModelStore.getState().activatePrincipal("user-1");

  const threadScope: SyncScopeKey = {
    serverId: "server-1",
    scopeKind: "thread",
    scopeId: channelId,
  };
  const sharedFact = reactionReadModelStore.getState().applyLegacyIngress({
    principalId: "user-1",
    serverId: "server-1",
    parentScopeKey: threadScope,
    messageId,
    source: "receiver-private",
    viewerUserId: "user-1",
    reactions: [{
      emoji: "👍",
      count: 1,
      reactorIds: ["user-2"],
      reactorNames: ["Thread Actor"],
    }],
  });
  const { row } = await renderMessage(
    makeMessage([...sharedFact]),
    threadScope,
  );

  assert.ok(
    Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
      (button) => button.getAttribute("aria-label") === "👍 reaction from Thread Actor",
    ),
    "a thread HTTP/update shape without conversationContext must still hit its thread-scoped cache",
  );
});

test("normalized optimism changes count plus overlay without inventing a shared roster", async (t) => {
  useServerStore.setState({ current: makeServer() });
  t.mock.method(api, "post", async () => ({
    data: {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
    },
  }));
  await prefetchServerFeatureFlags("server-1");
  reactionReadModelStore.getState().activatePrincipal("user-1");

  const sharedFact = reactionReadModelStore.getState().applyLegacyIngress({
    principalId: "user-1",
    serverId: "server-1",
    parentScopeKey: { serverId: "server-1", scopeKind: "channel", scopeId: channelId },
    messageId,
    source: "receiver-private",
    viewerUserId: "user-1",
    reactions: [{
      emoji: "👍",
      count: 2,
      reactorIds: ["user-1", "user-2"],
      reactorNames: ["Current User", "Bob"],
    }],
  });

  let resolveRequest!: (value: { data: Message }) => void;
  const requestResult = new Promise<{ data: Message }>((resolve) => {
    resolveRequest = resolve;
  });
  t.mock.method(api, "request", async () => requestResult);

  const { row, useMessageStore } = await renderMessage(makeMessage([...sharedFact]));
  const chip = Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
    (button) => button.getAttribute("aria-label") === "👍 reaction from Current User, Bob",
  );
  assert.ok(chip);
  fireEvent.click(chip);

  await waitFor(() => {
    const stored = useMessageStore.getState().channelMessages[channelId]?.[0];
    assert.deepEqual(stored?.reactions, [{ emoji: "👍", count: 1, previewK: [] }]);
    assert.deepEqual(
      reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", messageId, "👍"),
      { status: "loaded", reactedByMe: false },
    );
    assert.equal(JSON.stringify(stored).includes("reactorIds"), false);
    assert.equal(reactionReadModelStore.getState().actorCache.size, 1);
  });

  resolveRequest({
    data: makeMessage([
      { emoji: "👍", count: 1, reactorIds: ["user-2"], reactorNames: ["Bob"] },
    ]),
  });
  await waitFor(() => {
    assert.deepEqual(
      reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", messageId, "👍"),
      { status: "loaded", reactedByMe: false },
    );
  });
});

test("two normalized emoji mutations replay out of order and roll back only the failed target", async (t) => {
  useServerStore.setState({ current: makeServer() });
  t.mock.method(api, "post", async () => ({
    data: {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
    },
  }));
  await prefetchServerFeatureFlags("server-1");
  reactionReadModelStore.getState().activatePrincipal("user-1");

  const sharedFact = reactionReadModelStore.getState().applyLegacyIngress({
    principalId: "user-1",
    serverId: "server-1",
    parentScopeKey: { serverId: "server-1", scopeKind: "channel", scopeId: channelId },
    messageId,
    source: "receiver-private",
    viewerUserId: "user-1",
    reactions: [
      {
        emoji: "👍",
        count: 2,
        reactorIds: ["user-1", "user-2"],
        reactorNames: ["Current User", "Bob"],
      },
      {
        emoji: "👀",
        count: 2,
        reactorIds: ["user-1", "user-3"],
        reactorNames: ["Current User", "Eve"],
      },
    ],
  });

  const pending = new Map<string, {
    resolve(value: { data: Message & { reactionViewer?: unknown } }): void;
    reject(reason: Error): void;
  }>();
  t.mock.method(api, "request", async (config: { data?: { emoji?: string } }) => (
    new Promise((resolve, reject) => {
      pending.set(config.data?.emoji ?? "", { resolve, reject });
    })
  ));

  const { row, useMessageStore } = await renderMessage(makeMessage([...sharedFact]));
  const chip = (emoji: string) => Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]"))
    .find((button) => button.getAttribute("aria-label")?.startsWith(`${emoji} reaction`));

  fireEvent.click(chip("👍")!);
  await waitFor(() => assert.ok(pending.has("👍")));
  fireEvent.click(chip("👀")!);
  await waitFor(() => assert.ok(pending.has("👀")));

  pending.get("👀")!.resolve({
    data: {
      ...makeMessage([
        { emoji: "👍", count: 2, reactorIds: ["user-1", "user-2"], reactorNames: ["Current User", "Bob"] },
        { emoji: "👀", count: 1, reactorIds: ["user-3"], reactorNames: ["Eve"] },
      ]),
      reactionViewer: {
        serverId: "server-1",
        messageId,
        viewerVersion: 1,
        reactedEmojis: ["👍"],
      },
    },
  });
  await waitFor(() => {
    assert.deepEqual(
      reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", messageId, "👀"),
      { status: "loaded", reactedByMe: false },
    );
    assert.deepEqual(
      reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", messageId, "👍"),
      { status: "loaded", reactedByMe: false },
      "still-pending 👍 removal must replay over the 👀 ACK snapshot",
    );
    assert.deepEqual(
      [...reactionReadModelStore.getState().viewerVersions.values()],
      [1],
      "mutation ACK must enter the versioned complete-snapshot projector",
    );
  });

  pending.get("👍")!.reject(new Error("first emoji failed"));
  await waitFor(() => {
    const stored = useMessageStore.getState().channelMessages[channelId]?.[0];
    assert.deepEqual(stored?.reactions, [
      { emoji: "👀", count: 1, previewK: [] },
      { emoji: "👍", count: 2, previewK: [] },
    ]);
    assert.deepEqual(
      reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", messageId, "👍"),
      { status: "loaded", reactedByMe: true },
    );
    assert.deepEqual(
      reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", messageId, "👀"),
      { status: "loaded", reactedByMe: false },
    );
    assert.equal(JSON.stringify(stored).includes("reactorIds"), false);
  });
});

test("mobile reaction-add affordance appears only when reactions are visible", async () => {
  const { row } = await renderMessage(
    makeMessage([
      { emoji: "👍", count: 1, reactorIds: ["user-2"], reactorNames: ["Bob"] },
    ]),
  );
  assert.ok(
    row.querySelector("[data-message-affordance='mobile-reaction-add']"),
    "mobile add-reaction button renders alongside existing reaction chips",
  );

  cleanup();

  const noReactions = await renderMessage(makeMessage([]));
  assert.equal(
    noReactions.row.querySelector("[data-message-affordance='mobile-reaction-add']"),
    null,
    "no mobile add-reaction button when there are no visible reactions",
  );
});

test("clicking a reaction chip optimistically toggles it off then reconciles from the API", async (t) => {
  const requestMock = t.mock.method(api, "request", async () => ({
    data: {
      id: messageId,
      channelId,
      reactions: [] as MessageReaction[],
    },
  }));

  const { row, useMessageStore } = await renderMessage(
    makeMessage([
      { emoji: "👍", count: 1, reactorIds: ["user-1"], reactorNames: ["Current User"] },
    ]),
  );

  const chip = Array.from(row.querySelectorAll<HTMLElement>("button[aria-label]")).find(
    (b) => b.getAttribute("aria-label") === "👍 reaction from Current User",
  );
  assert.ok(chip);
  fireEvent.click(chip);

  // Optimistic removal: viewer's own reaction (count 1) drops to 0 immediately.
  await waitFor(() => {
    const cached = useMessageStore
      .getState()
      .channelMessages[channelId]?.find((m) => m.id === messageId);
    const thumbs = cached?.reactions?.find((r) => r.emoji === "👍");
    assert.ok(!thumbs || thumbs.count === 0, "viewer's reaction is optimistically removed");
  });

  // The DELETE round-trip fired against the reactions endpoint.
  await waitFor(() => {
    assert.equal(requestMock.mock.callCount(), 1);
  });
  const call = requestMock.mock.calls[0].arguments[0] as {
    method: string;
    url: string;
    data: { emoji: string };
  };
  assert.equal(call.method, "delete");
  assert.equal(call.url, `/messages/${messageId}/reactions`);
  assert.equal(call.data.emoji, "👍");
});
