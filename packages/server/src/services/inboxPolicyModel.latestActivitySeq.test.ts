import assert from "node:assert/strict";
import { test } from "vitest";
import { mapInboxPolicyRowsToItems } from "./inboxPolicyModel.js";
import { normalizeRowForTest } from "./activitySyncService.js";
import type { InboxItem } from "./channelService.js";

// Gate B1 P1 successor teeth (John/赵梓淇 independent repro): the SQL projects
// latestActivitySeq, but every real inbox row flows through the shared
// mapInboxPolicyRowsToItems() mapper before getInboxItems() casts to InboxItem
// and activitySyncService.normalizeRow() runs requireLatestActivitySeq(). These
// teeth drive the REAL exported mapper (no hand-crafted post-map InboxItem) and
// prove the canonical decimal latestActivitySeq survives raw-row -> mapper ->
// normalize as one same-source tuple for all four row-kinds, fails closed when
// the frontier is absent, and REDs if the mapper stops copying the field.

const readStates = new Map<string, { maxReadSeq: string; readStateVersion: string }>();

function rawChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "channel",
    channelId: "channel-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "msg-100",
    latestActivitySeq: "100",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-29 00:00:00.000000+00",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "alice",
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
}

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-1",
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent preview",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply preview",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "msg-200",
    latestActivitySeq: "200",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: "2026-07-29 00:00:00.000000+00",
    lastReplyAt: "2026-07-29 00:00:00.000000+00",
    replyCount: 1,
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

test("P1: real shared mapper threads latestActivitySeq for channel/dm/mention -> normalize keeps the same-source tuple", () => {
  const rawRows = [
    rawChannel({ kind: "channel" }),
    rawChannel({ kind: "dm", channelId: "dm-1", channelType: "dm" }),
    rawChannel({ kind: "channel", channelId: "channel-mention", hasMention: true, firstMentionMessageId: "msg-100" }),
  ];
  const items = mapInboxPolicyRowsToItems(rawRows) as unknown as InboxItem[];

  // The mapper must actually own the field (the P1 was hasOwn === false).
  for (const item of items) {
    assert.equal(Object.hasOwn(item, "latestActivitySeq"), true, "mapper must copy latestActivitySeq");
  }

  const channel = normalizeRowForTest(items[0]!, readStates);
  assert.equal(channel.type, "channel");
  assert.equal(channel.latestActivitySeq, "100");

  const dm = normalizeRowForTest(items[1]!, readStates);
  assert.equal(dm.type, "dm");
  assert.equal(dm.latestActivitySeq, "100");

  const mention = normalizeRowForTest(items[2]!, readStates);
  assert.equal(mention.type, "channel");
  assert.equal(mention.hasMention, true);
  assert.equal(mention.latestActivitySeq, "100");
});

test("P1: real shared mapper threads latestActivitySeq for thread -> normalize keeps latestActivityMessageId+seq paired", () => {
  const items = mapInboxPolicyRowsToItems([rawThread()]) as unknown as InboxItem[];
  assert.equal(Object.hasOwn(items[0]!, "latestActivitySeq"), true, "mapper must copy latestActivitySeq");

  const thread = normalizeRowForTest(items[0]!, readStates);
  assert.equal(thread.type, "thread");
  assert.equal(thread.latestActivityMessageId, "msg-200");
  assert.equal(thread.latestActivitySeq, "200");
});

test("P1: zero-reply thread falls back to the parent via PAIRED COALESCE through the real mapper", () => {
  // The canonical-PG thread query selects COALESCE(latest_message.id, parentMessageId)
  // paired with COALESCE(latest_message.seq, parentMessageSeq); a zero-reply thread
  // arrives already fallen back to the parent's (id, seq) tuple in the raw row.
  const items = mapInboxPolicyRowsToItems([
    rawThread({
      replyCount: 0,
      lastReplyAt: null,
      latestActivityMessageId: "parent-1",
      latestActivitySeq: "50",
    }),
  ]) as unknown as InboxItem[];

  const thread = normalizeRowForTest(items[0]!, readStates);
  assert.equal(thread.type, "thread");
  assert.equal(thread.latestActivityMessageId, "parent-1");
  assert.equal(thread.latestActivitySeq, "50");
  assert.equal(thread.parentMessageId, "parent-1");
});

test("P1: a raw row missing the frontier fails closed after the real mapper (no silent drop, no 0)", () => {
  // Join-miss / missing frontier: the raw row has no latestActivitySeq, the mapper
  // yields null, and normalizeRow hard-rejects the whole row before serialization.
  const channelItems = mapInboxPolicyRowsToItems([
    rawChannel({ latestActivitySeq: null }),
  ]) as unknown as InboxItem[];
  assert.equal(channelItems[0]!.latestActivitySeq, null);
  assert.throws(
    () => normalizeRowForTest(channelItems[0]!, readStates),
    /no provable latestActivitySeq/,
  );

  const threadItems = mapInboxPolicyRowsToItems([
    rawThread({ latestActivitySeq: null }),
  ]) as unknown as InboxItem[];
  assert.throws(
    () => normalizeRowForTest(threadItems[0]!, readStates),
    /no provable latestActivitySeq/,
  );
});

test("P1 RED guard: deleting the mapper's latestActivitySeq copy must break the chain", () => {
  // This tooth pins the mapper source so a future deletion/non-copy of the field
  // is caught: the mapped item must own latestActivitySeq AND it must equal the raw
  // canonical decimal. If the mapper stops copying the field, hasOwn flips false and
  // normalizeRow would throw — exactly the P1 this successor closes.
  const raw = rawChannel({ latestActivitySeq: "10938105" });
  const items = mapInboxPolicyRowsToItems([raw]) as unknown as InboxItem[];
  assert.equal(Object.hasOwn(items[0]!, "latestActivitySeq"), true);
  assert.equal(items[0]!.latestActivitySeq, "10938105");
  const normalized = normalizeRowForTest(items[0]!, readStates);
  assert.equal(normalized.latestActivitySeq, "10938105");
});

test("Done frontier stays in storage space when the incident display pair diverges", () => {
  const [item] = mapInboxPolicyRowsToItems([
    rawChannel({
      latestActivitySeq: "11429659",
      doneFrontierSeq: "11426997",
    }),
  ], undefined, "authority") as unknown as InboxItem[];

  assert.equal(item?.kind, "channel");
  if (!item) throw new Error("expected a channel item");
  assert.equal(item.latestActivitySeq, "11429659", "display pair remains unchanged");
  assert.equal(item.doneFrontierSeq, "11426997", "Done uses the guard's storage sequence space");
});

test("RW serving rows expose their already-storage-scoped pair as the Done frontier", () => {
  const [item] = mapInboxPolicyRowsToItems([
    rawChannel({ latestActivitySeq: "11426997" }),
  ], undefined, "servingPair") as unknown as InboxItem[];

  assert.equal(item?.kind, "channel");
  if (!item) throw new Error("expected a channel item");
  assert.equal(item.doneFrontierSeq, "11426997");
});
