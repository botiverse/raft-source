import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeRowForTest,
  requireLatestActivitySeqForTest,
} from "./activitySyncService.js";
import type { InboxItem } from "./channelService.js";

// Gate B1 teeth: every inbox row-kind must carry latestActivityMessageId and
// latestActivitySeq as ONE same-source tuple, the zero-reply thread must fall
// back to the parent message via a PAIRED COALESCE (id and seq together), and
// an RW join-miss without a canonical-PG fallback must hard-reject the whole
// request before serialization — never fabricate "0", never silently drop the
// row (赵梓淇 freeze condition).

const readStates = new Map<string, { maxReadSeq: string; readStateVersion: string }>();

function channelItem(overrides: Partial<InboxItem> & { kind: "channel" | "dm" }): InboxItem {
  return {
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
  } as InboxItem;
}

function threadItem(overrides: Partial<InboxItem> & { kind: "thread" }): InboxItem {
  return {
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
  } as InboxItem;
}

test("requireLatestActivitySeq hard-rejects an RW join-miss (null/empty/0/non-canonical)", () => {
  const row = { latestActivitySeq: null } as InboxItem;
  // null — the RW serving LEFT JOIN missed and no canonical-PG fallback proved a frontier.
  assert.throws(
    () => requireLatestActivitySeqForTest(row, "row-null"),
    /no provable latestActivitySeq/,
  );
  // empty string — equally unproven.
  assert.throws(
    () => requireLatestActivitySeqForTest({ latestActivitySeq: "" } as InboxItem, "row-empty"),
    /no provable latestActivitySeq/,
  );
  // fabricated "0" — message seqs are positive canonical decimals; "0" is forbidden.
  assert.throws(
    () => requireLatestActivitySeqForTest({ latestActivitySeq: "0" } as InboxItem, "row-zero"),
    /no provable latestActivitySeq/,
  );
  // non-canonical decimal (leading zero) — rejected by the canonical pattern.
  assert.throws(
    () => requireLatestActivitySeqForTest({ latestActivitySeq: "007" } as InboxItem, "row-leading-zero"),
    /no provable latestActivitySeq/,
  );
  // number path is impossible at runtime (the wire is text) but the guard is total.
  assert.throws(
    () => requireLatestActivitySeqForTest({ latestActivitySeq: 7 as unknown as string } as InboxItem, "row-number"),
    /no provable latestActivitySeq/,
  );
});

test("requireLatestActivitySeq returns a provable canonical decimal seq", () => {
  assert.equal(
    requireLatestActivitySeqForTest({ latestActivitySeq: "10938105" } as InboxItem, "row-ok"),
    "10938105",
  );
  // A seq beyond Number.MAX_SAFE_INTEGER must survive verbatim (exact int8 text).
  assert.equal(
    requireLatestActivitySeqForTest({ latestActivitySeq: "9007199254740993" } as InboxItem, "row-big"),
    "9007199254740993",
  );
});

test("channel/dm/mention rows carry lastMessageId + latestActivitySeq as one same-source tuple", () => {
  const channel = normalizeRowForTest(channelItem({ kind: "channel" }), readStates);
  assert.equal(channel.type, "channel");
  assert.equal(channel.latestActivitySeq, "100");
  // The channel/dm common row anchors on lastMessageId; the seq is the same source.
  assert.equal("lastMessageId" in channel ? channel.lastMessageId : undefined, "msg-100");

  const dm = normalizeRowForTest(
    channelItem({ kind: "dm", channelType: "dm", channelId: "dm-1" }),
    readStates,
  );
  assert.equal(dm.type, "dm");
  assert.equal(dm.latestActivitySeq, "100");

  // A mention is a channel/dm row with hasMention=true; it flows the same common mapper.
  const mention = normalizeRowForTest(
    channelItem({ kind: "channel", hasMention: true, firstMentionMessageId: "msg-100" }),
    readStates,
  );
  assert.equal(mention.type, "channel");
  assert.equal(mention.hasMention, true);
  assert.equal(mention.latestActivitySeq, "100");
});

test("thread row carries latestActivityMessageId + latestActivitySeq as one same-source tuple", () => {
  const thread = normalizeRowForTest(threadItem({ kind: "thread" }), readStates);
  assert.equal(thread.type, "thread");
  assert.equal(thread.latestActivityMessageId, "msg-200");
  assert.equal(thread.latestActivitySeq, "200");
});

test("zero-reply thread falls back to the parent via a PAIRED COALESCE (id and seq together)", () => {
  // The PG serving query selects COALESCE(latest_message.id, parentMessageId) paired
  // with COALESCE(latest_message.seq, parentMessageSeq). A zero-reply thread has no
  // latest_message, so BOTH the id and the seq fall back to the parent — never split.
  const zeroReply = normalizeRowForTest(
    threadItem({
      kind: "thread",
      replyCount: 0,
      latestActivityMessageId: "parent-1", // COALESCE -> parent message id
      latestActivitySeq: "50", // COALESCE -> parent message seq (paired)
      lastReplyAt: null,
    }),
    readStates,
  );
  assert.equal(zeroReply.type, "thread");
  assert.equal(zeroReply.latestActivityMessageId, "parent-1");
  assert.equal(zeroReply.latestActivitySeq, "50");
  // The paired fallback must agree with the parent identity, not a fabricated frontier.
  assert.equal(zeroReply.parentMessageId, "parent-1");
});

test("a join-miss row hard-rejects the whole normalization (no silent drop, no 0)", () => {
  // If the RW serving join misses and no canonical-PG fallback proved a frontier,
  // normalizeRow must throw BEFORE producing an ActivityRowPayload — the request
  // fails closed rather than emitting a row with a fabricated or missing seq.
  assert.throws(
    () =>
      normalizeRowForTest(
        channelItem({ kind: "channel", latestActivitySeq: null }),
        readStates,
      ),
    /no provable latestActivitySeq/,
  );
  assert.throws(
    () =>
      normalizeRowForTest(
        threadItem({ kind: "thread", latestActivitySeq: null }),
        readStates,
      ),
    /no provable latestActivitySeq/,
  );
});
