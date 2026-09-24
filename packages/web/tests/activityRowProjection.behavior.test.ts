/**
 * task #364 Projection P — teeth for the core row → panel item inverse projection.
 *
 * Every sentinel below is DISTINCT, so a mapping that reads the neighbouring
 * field still fails. A fixture reusing "channel-1" for both id and name would
 * pass a swapped mapping and prove nothing.
 *
 * VERIFIED REVERSE CUTS (each reddens on its own):
 *  - swap any field mapping                    -> that kind's deep-equal RED
 *  - route `latestActivitySeq` through Number  -> byte-exact RED
 *  - drop the AJV narrow                       -> unknown/missing-field RED
 *  - default `isFollowing`                     -> thread deep-equal RED
 *  - default `doneAt`                          -> absent-field RED
 *
 * NOT a cut — stated so nobody assumes coverage: making `projectRow` skip a bad
 * row instead of failing the set reddens NOTHING. `ActivityRow` is exactly
 * {channel, dm, thread}, so every row surviving the narrow projects and that
 * branch is unreachable today. All-or-nothing is enforced by the NARROW.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { projectActivityRows } from "../src/store/activityPanel/projection";

/** 2^53 + 1 — unrepresentable as a double. */
const BIG_SEQ = "9007199254740993";

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row-id-c", rowVersion: "11", latestActivitySeq: BIG_SEQ,
    lastActivityAt: "2026-08-01T00:00:00.000Z", unreadCount: 3, hasMention: true,
    firstUnreadMessageId: "first-unread-c", firstMentionMessageId: "first-mention-c",
    maxReadSeq: "12", readStateVersion: "13",
    type: "channel", channelId: "chan-id-c", channelName: "chan-name-c",
    channelKind: "private", lastMessageId: "last-msg-c",
    lastMessagePreview: "preview-c", lastMessageSenderKind: "agent",
    lastMessageSenderId: "sender-id-c", lastMessageSenderName: "sender-name-c",
    ...overrides,
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row-id-t", rowVersion: "21", latestActivitySeq: BIG_SEQ,
    lastActivityAt: "2026-08-02T00:00:00.000Z", unreadCount: 5, hasMention: false,
    firstUnreadMessageId: null, firstMentionMessageId: null,
    maxReadSeq: "22", readStateVersion: "23",
    type: "thread", threadChannelId: "thread-chan-t", parentMessageId: "parent-msg-t",
    parentChannelId: "parent-chan-t", parentChannelName: "parent-name-t",
    parentChannelKind: "joint", parentMessagePreview: "parent-preview-t",
    parentMessageSenderKind: "user", parentMessageSenderId: "parent-sender-t",
    latestActivityPreview: "latest-preview-t", latestActivitySenderKind: "system",
    latestActivitySenderName: "latest-sender-name-t",
    latestActivitySenderId: "latest-sender-t", latestActivityMessageId: "latest-msg-t",
    isFollowing: false,
    replyCount: 7, lastReplyAt: "2026-08-02T01:00:00.000Z",
    taskNumber: 42, taskStatus: "in_progress", taskClaimedByName: "claimed-by-t",
    ...overrides,
  };
}

test("a channel row projects field-for-field with a byte-exact content frontier", () => {
  const [item] = projectActivityRows([channelRow()]) ?? [];
  assert.ok(item);

  assert.deepEqual(item, {
    kind: "channel",
    channelId: "chan-id-c",
    channelName: "chan-name-c",
    channelType: "private",
    lastMessageId: "last-msg-c",
    latestActivitySeq: BIG_SEQ,
    firstUnreadMessageId: "first-unread-c",
    firstMentionMessageId: "first-mention-c",
    lastMessageAt: "2026-08-01T00:00:00.000Z",
    lastMessagePreview: "preview-c",
    lastMessageSenderType: "agent",
    lastMessageSenderId: "sender-id-c",
    lastMessageSenderName: "sender-name-c",
    unreadCount: 3,
    hasMention: true,
  });

  assert.equal(
    item.latestActivitySeq,
    BIG_SEQ,
    "the channel content frontier must survive as a canonical decimal string, never through a number",
  );

  // deepEqual above already pins absence, but say it explicitly: these are
  // transport/read-state bookkeeping and must not become panel state.
  for (const leak of ["rowId", "rowVersion", "maxReadSeq", "readStateVersion"]) {
    assert.ok(!(leak in (item as Record<string, unknown>)), `${leak} must not leak into the panel row`);
  }
  // Optional legacy fields must be ABSENT, not defaulted: `doneAt: null` would
  // assert "not done" where the contract says nothing at all.
  assert.ok(!("doneAt" in (item as Record<string, unknown>)), "doneAt must be absent, not defaulted");
});

test("a dm row keeps its own kind and channelKind rather than being folded into channel", () => {
  const [item] = projectActivityRows([
    channelRow({ type: "dm", channelKind: "dm", channelId: "chan-id-d", channelName: "chan-name-d" }),
  ]) ?? [];
  assert.ok(item);
  assert.equal((item as { kind: string }).kind, "dm");
  assert.equal((item as { channelType: string }).channelType, "dm");
  assert.equal((item as { channelId: string }).channelId, "chan-id-d");
});

test("a thread row projects field-for-field and carries latestActivitySeq BYTE-EXACT", () => {
  const [item] = projectActivityRows([threadRow()]) ?? [];
  assert.ok(item);

  assert.deepEqual(item, {
    kind: "thread",
    threadChannelId: "thread-chan-t",
    parentMessageId: "parent-msg-t",
    parentChannelId: "parent-chan-t",
    parentChannelName: "parent-name-t",
    parentChannelType: "joint",
    parentMessagePreview: "parent-preview-t",
    parentMessageSenderType: "user",
    parentMessageSenderId: "parent-sender-t",
    latestActivityPreview: "latest-preview-t",
    latestActivitySenderType: "system",
    latestActivitySenderId: "latest-sender-t",
    latestActivitySenderName: "latest-sender-name-t",
    latestActivityMessageId: "latest-msg-t",
    latestActivitySeq: BIG_SEQ,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 7,
    lastActivityAt: "2026-08-02T00:00:00.000Z",
    lastReplyAt: "2026-08-02T01:00:00.000Z",
    unreadCount: 5,
    hasMention: false,
    taskNumber: 42,
    taskStatus: "in_progress",
    taskClaimedByName: "claimed-by-t",
    isFollowing: false,
  });

  // The property, stated separately from the deep-equal: a value routed through
  // a number comes back ...992 and this fails. A small seq would pass either way.
  assert.equal(
    (item as { latestActivitySeq: string }).latestActivitySeq,
    BIG_SEQ,
    "the content frontier must survive as a canonical decimal string, never through a number",
  );
  assert.equal(item.kind === "thread" ? item.isFollowing : null, false);
});

test("an unknown row type is refused rather than coerced — mention_action is not in the contract", () => {
  assert.equal(
    projectActivityRows([channelRow({ type: "mention_action" })]),
    null,
    "synthesising an actionable row from an unknown type would fabricate a user-visible action",
  );
  assert.equal(projectActivityRows([channelRow({ type: "tombstone" })]), null);
});

test("a row failing the generated schema is refused — the narrow is the only shape check", () => {
  // Missing a required field.
  const { channelName: _dropped, ...missing } = channelRow();
  assert.equal(projectActivityRows([missing]), null, "missing required field must be refused");

  // Wrong primitive type for a schema-pinned field.
  assert.equal(
    projectActivityRows([channelRow({ unreadCount: "3" })]),
    null,
    "wrong type must be refused by the schema, not silently coerced",
  );

  // Non-canonical seq: the schema pins ^(0|[1-9][0-9]*)$.
  assert.equal(
    projectActivityRows([channelRow({ latestActivitySeq: "007" })]),
    null,
    "a non-canonical decimal must be refused",
  );
});

test("ALL-OR-NOTHING: one row that fails the narrow rejects the entire set", () => {
  // Note this is enforced by the schema narrow, not by projectRow's unknown-kind
  // branch — see the header. The bad row here is refused by the schema.
  const result = projectActivityRows([channelRow(), threadRow(), channelRow({ type: "nope" })]);
  assert.equal(
    result,
    null,
    "a partially projected list would show a subset of core rows beside the core's totals — the splice the bundle exists to prevent",
  );
});

test("an empty row set projects to an empty list, not null", () => {
  // Otherwise a legitimately empty core window would be indistinguishable from
  // a projection failure and fall back forever.
  assert.deepEqual(projectActivityRows([]), []);
});
