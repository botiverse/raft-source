import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render } from "@testing-library/react";
import type { InboxItem } from "../src/store/inboxStore.js";

const { isInboxItemActive, useIsItemActive } = await import("../src/components/thread/useIsItemActive.js");
const { default: ConversationPreviewCard } = await import("../src/components/ui/cards/ConversationPreviewCard.js");
const { useThreadStore } = await import("../src/store/threadStore.js");

const inactiveThread = { openParentChannelId: null, openParentMessageId: null, openThreadChannelId: null };

test.afterEach(() => {
  cleanup();
});

function makeChannelItem(overrides: Partial<Extract<InboxItem, { kind: "channel" | "dm" }>> = {}): Extract<InboxItem, { kind: "channel" | "dm" }> {
  return {
    kind: "channel",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-2",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-06-22T00:00:00.000Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "alice",
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

function makeThreadItem(overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {}): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-1",
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent message",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-2",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 2,
    lastActivityAt: "2026-06-22T00:00:00.000Z",
    lastReplyAt: "2026-06-22T00:00:00.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function makeMentionActionItem(overrides: Partial<Extract<InboxItem, { kind: "mention_action" }>> = {}): Extract<InboxItem, { kind: "mention_action" }> {
  return {
    kind: "mention_action",
    id: "mention-action-1",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    messageId: "message-1",
    messagePreview: "please check this",
    createdAt: "2026-06-22T00:00:00.000Z",
    pendingMentionActions: [],
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

test("non-thread activity items do not stay active after they navigate away from Activity", () => {
  const channel = makeChannelItem();
  const dm = makeChannelItem({ kind: "dm", channelId: "dm-1", channelType: "dm" });
  const mention = makeMentionActionItem();
  const channelWithThreadLikeFields = {
    ...channel,
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
  };

  assert.equal(isInboxItemActive(channel, inactiveThread), false);
  assert.equal(isInboxItemActive(dm, inactiveThread), false);
  assert.equal(isInboxItemActive(mention, inactiveThread), false);
  assert.equal(isInboxItemActive(channelWithThreadLikeFields, {
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  }), false);
});

test("thread activity items stay active for the open thread channel or parent anchor", () => {
  const thread = makeThreadItem();

  assert.equal(isInboxItemActive(thread, { ...inactiveThread, openThreadChannelId: "thread-1" }), true);
  assert.equal(isInboxItemActive(thread, { openThreadChannelId: null, openParentChannelId: "channel-1", openParentMessageId: "parent-1" }), true);
  assert.equal(isInboxItemActive(thread, { openThreadChannelId: null, openParentChannelId: "channel-1", openParentMessageId: "different-parent" }), false);
  assert.equal(isInboxItemActive(thread, { openThreadChannelId: null, openParentChannelId: "different-channel", openParentMessageId: "parent-1" }), false);
});

test("thread activity items stay active on the Activity route thread permalink", () => {
  const parentChannelId = "5cfe4ef7-0ab5-40fe-a226-b7fe245a4497";
  const parentMessageId = "61875d59-01ca-4623-a9df-5294e7a1041f";
  const thread = makeThreadItem({
    threadChannelId: "thread-resolved",
    parentChannelId,
    parentMessageId,
  });

  assert.equal(isInboxItemActive(thread, {
    openThreadChannelId: null,
    openParentChannelId: parentChannelId,
    openParentMessageId: parentMessageId,
  }), true);
});

test("useIsItemActive wires thread store state into the active predicate", () => {
  const item = makeThreadItem();
  function ActiveProbe() {
    const isActive = useIsItemActive();
    return createElement("span", { "data-active": isActive(item) ? "true" : "false" });
  }

  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: null,
  });
  const { container, rerender } = render(createElement(ActiveProbe));
  assert.equal(container.querySelector("span")?.getAttribute("data-active"), "true");

  act(() => {
    useThreadStore.setState({
      openParentChannelId: "different-channel",
      openParentMessageId: "different-parent",
      openThreadChannelId: "thread-1",
    });
  });
  rerender(createElement(ActiveProbe));
  assert.equal(container.querySelector("span")?.getAttribute("data-active"), "true");

  act(() => {
    useThreadStore.setState({
      openParentChannelId: "channel-1",
      openParentMessageId: "different-parent",
      openThreadChannelId: null,
    });
  });
  rerender(createElement(ActiveProbe));

  assert.equal(container.querySelector("span")?.getAttribute("data-active"), "false");
});

test("conversation preview cards expose active state separately from one-shot focus", () => {
  const markup = renderToStaticMarkup(
    createElement(ConversationPreviewCard, {
      channelLabel: "#general",
      preview: "Opened item",
      active: true,
    }),
  );
  const inactiveMarkup = renderToStaticMarkup(
    createElement(ConversationPreviewCard, {
      channelLabel: "#general",
      preview: "Closed item",
    }),
  );

  assert.match(markup, /data-active="true"/);
  assert.match(markup, /aria-current="true"/);
  assert.doesNotMatch(markup, /data-focused="true"/);
  assert.doesNotMatch(inactiveMarkup, /data-active=/);
  assert.doesNotMatch(inactiveMarkup, /data-focused=/);
  assert.doesNotMatch(inactiveMarkup, /aria-current=/);
});

test("interactive conversation preview cards expose active state separately from focus", () => {
  const activeMarkup = renderToStaticMarkup(
    createElement(ConversationPreviewCard, {
      channelLabel: "#general",
      preview: "Opened item",
      active: true,
      onClick: () => {},
    }),
  );
  const focusedMarkup = renderToStaticMarkup(
    createElement(ConversationPreviewCard, {
      channelLabel: "#general",
      preview: "Focused item",
      focused: true,
      onClick: () => {},
    }),
  );
  const inactiveMarkup = renderToStaticMarkup(
    createElement(ConversationPreviewCard, {
      channelLabel: "#general",
      preview: "Inactive item",
      onClick: () => {},
    }),
  );

  assert.match(activeMarkup, /<button/);
  assert.match(activeMarkup, /data-active="true"/);
  assert.match(activeMarkup, /aria-current="true"/);
  assert.doesNotMatch(activeMarkup, /data-focused="true"/);
  assert.match(focusedMarkup, /data-focused="true"/);
  assert.match(focusedMarkup, /aria-current="true"/);
  assert.doesNotMatch(focusedMarkup, /data-active="true"/);
  assert.doesNotMatch(inactiveMarkup, /data-active=/);
  assert.doesNotMatch(inactiveMarkup, /data-focused=/);
  assert.doesNotMatch(inactiveMarkup, /aria-current=/);
});
