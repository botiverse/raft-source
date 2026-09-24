/**
 * RFC 037 L1 transport adapter pins — request shaping, event shaping, and
 * the message:new → item-upsert construction rules.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  fetchInboxHydrate,
  fetchInboxReconcile,
  inboxPatchFromMessageNew,
  INBOX_PAGE_SIZE,
} from "../src/store/transport/inboxTransport";
import type {
  InboxChannelContext,
  InboxChannelRow,
} from "../src/store/transport/inboxTransport";
import type { InboxItem } from "../src/store/inboxStore";

function row(overrides: Record<string, unknown> = {}): InboxChannelRow {
  return {
    kind: "channel",
    channelId: "ch-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "m-1",
    firstUnreadMessageId: "m-0",
    firstMentionMessageId: "m-0",
    lastMessageAt: "2026-07-06T00:00:00Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "u-1",
    lastMessageSenderName: "A",
    unreadCount: 2,
    hasMention: true,
    ...overrides,
  } as InboxChannelRow;
}

function context(overrides: Partial<InboxChannelContext> = {}): InboxChannelContext {
  return {
    channelName: "general",
    channelType: "channel",
    previousItem: null,
    mentionsCurrentUser: false,
    ...overrides,
  };
}

test("hydrate: reset pulls offset 0, pagination pulls current offset; response mapped verbatim", async () => {
  const calls: Array<{ filter: string; limit: number; offset: number }> = [];
  const items: InboxItem[] = [row()];
  const fetcher = async (params: { filter: never; limit: number; offset: number }) => {
    calls.push(params);
    return { items, hasMore: true, totalCount: 7, totalUnreadCount: 3 };
  };

  const reset = await fetchInboxHydrate({ filter: "all", offset: 55, reset: true }, fetcher as never);
  assert.deepEqual(calls[0], { filter: "all", limit: INBOX_PAGE_SIZE, offset: 0 });
  assert.deepEqual(reset, {
    kind: "hydrate", filter: "all", reset: true,
    items, hasMore: true, totalCount: 7, totalUnreadCount: 3,
  });

  const page = await fetchInboxHydrate({ filter: "all", offset: 55, reset: false }, fetcher as never);
  assert.equal(calls[1].offset, 55);
  assert.equal(page.reset, false);
});

test("hydrate/reconcile: missing response fields default safely (empty items, false hasMore, null totals)", async () => {
  const fetcher = async () => ({});
  const h = await fetchInboxHydrate({ filter: "unread", offset: 0, reset: true }, fetcher as never);
  assert.deepEqual(h.items, []);
  assert.equal(h.hasMore, false);
  assert.equal(h.totalCount, null);
  assert.equal(h.totalUnreadCount, null);

  const r = await fetchInboxReconcile("unread", fetcher as never);
  assert.equal(r.kind, "reconcile");
  assert.equal(r.filter, "unread");
  assert.deepEqual(r.items, []);
});

test("message:new adapter: rejects payloads without id or channelId", () => {
  assert.equal(inboxPatchFromMessageNew({ id: "", channelId: "ch-1" }, context()), null);
  assert.equal(inboxPatchFromMessageNew({ id: "m-1", channelId: "" }, context()), null);
});

test("message:new adapter: fresh channel row — unread 1, firstUnread = this message, marker = message id", () => {
  const patch = inboxPatchFromMessageNew(
    { id: "m-9", channelId: "ch-1", content: "hi", createdAt: "2026-07-06T01:00:00Z", senderType: "agent", senderId: "a-1", senderName: "Bot" },
    context(),
  );
  assert.ok(patch && patch.patch === "item-upsert");
  assert.equal(patch.marker, "m-9");
  const item = patch.item as InboxChannelRow;
  assert.equal(item.kind, "channel");
  assert.equal(item.unreadCount, 1);
  assert.equal(item.firstUnreadMessageId, "m-9");
  assert.equal(item.firstMentionMessageId, null);
  assert.equal(item.hasMention, false);
  assert.equal(item.lastMessagePreview, "hi");
  assert.equal(item.lastMessageSenderType, "agent");
  assert.equal(item.lastMessageSenderName, "Bot");
});

test("message:new adapter: existing row increments unread and preserves firstUnread anchor", () => {
  const patch = inboxPatchFromMessageNew(
    { id: "m-9", channelId: "ch-1" },
    context({ previousItem: row({ unreadCount: 2, firstUnreadMessageId: "m-0", hasMention: false, firstMentionMessageId: null }) }),
  );
  assert.ok(patch && patch.patch === "item-upsert");
  const item = patch.item as InboxChannelRow;
  assert.equal(item.unreadCount, 3);
  assert.equal(item.firstUnreadMessageId, "m-0", "existing anchor preserved");
});

test("message:new adapter: mention semantics — sets flag and anchors first mention only once", () => {
  const first = inboxPatchFromMessageNew(
    { id: "m-9", channelId: "ch-1" },
    context({ mentionsCurrentUser: true }),
  );
  const firstItem = first!.item as InboxChannelRow;
  assert.equal(firstItem.hasMention, true);
  assert.equal(firstItem.firstMentionMessageId, "m-9");

  const later = inboxPatchFromMessageNew(
    { id: "m-10", channelId: "ch-1" },
    context({ mentionsCurrentUser: true, previousItem: row({ firstMentionMessageId: "m-5", hasMention: true }) }),
  );
  const laterItem = later!.item as InboxChannelRow;
  assert.equal(laterItem.firstMentionMessageId, "m-5", "existing mention anchor preserved");

  const nonMention = inboxPatchFromMessageNew(
    { id: "m-11", channelId: "ch-1" },
    context({ previousItem: row({ hasMention: true, firstMentionMessageId: "m-5" }) }),
  );
  const nonMentionItem = nonMention!.item as InboxChannelRow;
  assert.equal(nonMentionItem.hasMention, true, "prior mention state sticky until read");
  assert.equal(nonMentionItem.firstMentionMessageId, "m-5");
});

test("message:new adapter: dm context produces a dm-kind row", () => {
  const patch = inboxPatchFromMessageNew(
    { id: "m-9", channelId: "dm-1" },
    context({ channelType: "dm", channelName: "alice" }),
  );
  assert.equal((patch!.item as InboxChannelRow).kind, "dm");
});
