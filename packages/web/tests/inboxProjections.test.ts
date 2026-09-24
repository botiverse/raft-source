/**
 * RFC 037 L3 projection pins — every decision branch, both axes.
 * (Mutation-gate follow-up: the exemplar's tests must kill its mutants.)
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  formatUnreadBadge,
  selectInboxAttention,
  selectInboxBadgeText,
  selectItemByKey,
  selectTotalUnread,
  selectUnreadItems,
} from "../src/store/projections/inboxProjections";
import { getInboxItemKey } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import type { InboxDomainState } from "../src/store/events/inboxEvents";

function item(overrides: Record<string, unknown> = {}): InboxItem {
  return {
    kind: "channel",
    channelId: "ch-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "m-1",
    firstUnreadMessageId: "m-1",
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-06T00:00:00Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "u-1",
    lastMessageSenderName: "A",
    unreadCount: 1,
    hasMention: false,
    ...overrides,
  } as InboxItem;
}

function state(items: InboxItem[], totalUnreadCount = items.reduce((s, i) => s + i.unreadCount, 0)): InboxDomainState {
  return { filter: "all", items, hasMore: false, totalCount: items.length, totalUnreadCount };
}

test("formatUnreadBadge: null at 0 and below, exact count through 99, 99+ above", () => {
  assert.equal(formatUnreadBadge(0), null);
  assert.equal(formatUnreadBadge(-1), null);
  assert.equal(formatUnreadBadge(1), "1");
  assert.equal(formatUnreadBadge(99), "99");
  assert.equal(formatUnreadBadge(100), "99+");
});

test("selectTotalUnread and badge text read the domain total, not a recount", () => {
  const s = state([item({ unreadCount: 1 })], 42);
  assert.equal(selectTotalUnread(s), 42);
  assert.equal(selectInboxBadgeText(s), "42");
  assert.equal(selectInboxBadgeText(state([], 0)), null);
});

test("attention: mention with unread outranks unread; read mention does not", () => {
  const mentionUnread = state([
    item({ channelId: "a", hasMention: true, unreadCount: 1 }),
    item({ channelId: "b", unreadCount: 3 }),
  ]);
  assert.equal(selectInboxAttention(mentionUnread), "mention");

  // A mention on a fully-read row must NOT fire (hasMention && unreadCount>0).
  const mentionRead = state([item({ hasMention: true, unreadCount: 0 })], 0);
  assert.equal(selectInboxAttention(mentionRead), "none");

  assert.equal(selectInboxAttention(state([item({ unreadCount: 2 })])), "unread");
  assert.equal(selectInboxAttention(state([item({ unreadCount: 0 })], 0)), "none");
});

test("attention muted axis: muted unread suppressed, mention pierces mute, includeMuted overrides", () => {
  const muted = (i: InboxItem) => i.kind !== "mention_action" && i.channelId === "muted-ch";
  const mutedUnreadOnly = state([item({ channelId: "muted-ch", unreadCount: 4 })]);
  assert.equal(selectInboxAttention(mutedUnreadOnly, { isMuted: muted }), "none");
  assert.equal(selectInboxAttention(mutedUnreadOnly, { isMuted: muted, includeMuted: true }), "unread");

  const mutedMention = state([item({ channelId: "muted-ch", unreadCount: 1, hasMention: true })]);
  assert.equal(selectInboxAttention(mutedMention, { isMuted: muted }), "mention", "direct mention pierces mute");
});

test("selectUnreadItems filters strictly positive; selectItemByKey hits and misses", () => {
  const a = item({ channelId: "a", unreadCount: 0 });
  const b = item({ channelId: "b", unreadCount: 2 });
  const s = state([a, b]);
  assert.deepEqual(selectUnreadItems(s), [b]);
  assert.equal(selectItemByKey(s, getInboxItemKey(b)), b);
  assert.equal(selectItemByKey(s, "nope"), null);
});
