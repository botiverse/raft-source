import { dbTest as test } from "../test/integration/dbTest.js";
// Teeth for the /channels/unread exit of the #632 SSOT fix.
//
// Layer 1 (unit): applyUnreadSummaryReadStates — batch isolation at the EXIT
// level per the frozen exit convention: one corrupt row must leave every
// other scope byte-intact, emit exactly one alarm line, never 500, and a
// throwing/async sink must not break anything (isolation lives in the shared
// constructor; the exit only passes callbacks).
//
// Layer 2 (real DB): getUnreadSummary against pglite — the additive authority
// query preserves presence (no COALESCE-to-0): no cursor row → absent;
// cursor at version 0 / seq "0" → present; frontier is a same-source pair
// from the storage channel's latest message; empty channel → latestActivity
// null while cursor stays present.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { formatInboxScopeCorruptionLine } from "@botiverse/raft-shared";
import { sql } from "drizzle-orm";

import { channelHumans, channels, messages, servers, users } from "../db/schema.js";
import {
  type ChannelUnreadSummaryEntry,
  type UnreadSummaryReadStateRow,
  applyUnreadSummaryReadStates,
  getFollowedThreads,
  getUnreadSummary,
  listChannels,
} from "./channelService.js";


function entry(unreadCount: number): ChannelUnreadSummaryEntry {
  return { unreadCount, hasMention: false, hasAnyMention: false, readState: { kind: "absent" } };
}

test("unit: batch isolation — one corrupt row, others intact, exactly one alarm line, throwing sink harmless", () => {
  const a = randomUUID();
  const b = randomUUID();
  const c = randomUUID();
  const summary: Record<string, ChannelUnreadSummaryEntry> = {
    [a]: entry(1),
    [b]: entry(2),
    [c]: entry(3),
  };
  const rows: UnreadSummaryReadStateRow[] = [
    { channelId: a, readCursorPresent: true, readStateVersion: 1, maxReadSeq: "5", latestActivityMessageId: "m1", latestActivitySeq: "9" },
    { channelId: b, readCursorPresent: true, readStateVersion: 2, maxReadSeq: "NOT_CANONICAL", latestActivityMessageId: null, latestActivitySeq: null },
    { channelId: c, readCursorPresent: false, readStateVersion: null, maxReadSeq: null, latestActivityMessageId: null, latestActivitySeq: null },
  ];
  const lines: string[] = [];
  // The exit convention sink INCLUDING a throw after recording — proves the
  // shared-constructor isolation covers the exit's own wiring.
  applyUnreadSummaryReadStates(summary, rows, (channelId, corruption) => {
    lines.push(formatInboxScopeCorruptionLine(channelId, corruption));
    throw new Error("sink exploded");
  });

  assert.deepEqual(summary[a].readState, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: "5",
    latestActivity: { messageId: "m1", seq: "9" },
  });
  assert.deepEqual(summary[b].readState, { kind: "corrupt" });
  assert.deepEqual(summary[c].readState, { kind: "absent" });
  assert.equal(lines.length, 1, "exactly one alarm line for the batch");
  assert.equal(
    lines[0],
    `inbox_cursor_corrupt scope=${b} field=maxReadSeq reason=not_canonical_decimal`,
  );
});

test("unit: STRUCTURAL presence with NULL value columns is corrupt, not absent (row exists but facts broken)", () => {
  const x = randomUUID();
  const summary: Record<string, ChannelUnreadSummaryEntry> = { [x]: entry(1) };
  const lines: string[] = [];
  applyUnreadSummaryReadStates(
    summary,
    [{ channelId: x, readCursorPresent: true, readStateVersion: null, maxReadSeq: null, latestActivityMessageId: null, latestActivitySeq: null }],
    (channelId, corruption) => { lines.push(formatInboxScopeCorruptionLine(channelId, corruption)); },
  );
  assert.deepEqual(summary[x].readState, { kind: "corrupt" }, "present row with broken facts must alarm, not vanish into absent");
  assert.equal(lines.length, 1);
});

test("unit: rows for unknown channels are ignored; counts untouched", () => {
  const known = randomUUID();
  const summary: Record<string, ChannelUnreadSummaryEntry> = { [known]: entry(4) };
  applyUnreadSummaryReadStates(
    summary,
    [{ channelId: randomUUID(), readCursorPresent: true, readStateVersion: 1, maxReadSeq: "3", latestActivityMessageId: null, latestActivitySeq: null }],
    () => {},
  );
  assert.deepEqual(summary[known], entry(4));
});

// (Wording debt from #5729 review: the earlier title claimed an
// "empty-channel null frontier" case, but a scope with no unread signal never
// enters the sparse summary — that case is covered at the LIST exit below,
// where every visible channel row appears regardless of unread signal.)
test("real DB: summary presence preserved end to end (absent / present-at-zero / same-source pair)", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "unread-exit@example.com",
    name: "unread-exit",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "UnreadExit",
    slug: "unread-exit",
    ownerId: owner.id,
  }).returning();
  const mk = async (name: string) => {
    const [ch] = await db.insert(channels).values({ serverId: server.id, name, type: "channel" }).returning();
    await db.insert(channelHumans).values({ channelId: ch.id, userId: owner.id });
    return ch;
  };
  const noCursor = await mk("no-cursor");
  const zeroCursor = await mk("zero-cursor");
  const emptyWithCursor = await mk("empty-with-cursor");

  // Messages must come from ANOTHER user: self-sent messages do not count
  // as unread, and the summary only lists channels with unread signal.
  const [peer] = await db.insert(users).values({
    email: "unread-exit-peer@example.com",
    name: "unread-exit-peer",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  await db.insert(messages).values([
    { channelId: noCursor.id, senderType: "user", senderId: peer.id, content: "a" },
    { channelId: zeroCursor.id, senderType: "user", senderId: peer.id, content: "b" },
  ]);
  // Cursor rows: zeroCursor at version 0 / seq 0 (present-at-zero), and a
  // cursor for the EMPTY channel (present with null frontier). noCursor has
  // no row at all (absent).
  await db.execute(sql`
    INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version)
    VALUES (${owner.id}::uuid, ${zeroCursor.id}::uuid, 0, 0),
           (${owner.id}::uuid, ${emptyWithCursor.id}::uuid, 0, 0)
  `);

  const summary = await getUnreadSummary(server.id, owner.id);

  const noCursorEntry = summary[noCursor.id];
  assert.ok(noCursorEntry, "unread channel without cursor appears in summary");
  assert.deepEqual(noCursorEntry.readState, { kind: "absent" }, "no cursor row must be absent, not zero");

  const zeroEntry = summary[zeroCursor.id];
  assert.ok(zeroEntry, "unread channel with zero cursor appears in summary");
  assert.equal(zeroEntry.readState.kind, "present", "cursor at 0 is present — presence is not value-derived");
  if (zeroEntry.readState.kind === "present") {
    assert.equal(zeroEntry.readState.readStateVersion, 0);
    assert.equal(zeroEntry.readState.maxReadSeq, "0");
    assert.ok(zeroEntry.readState.latestActivity, "channel with messages has a same-source frontier");
    const rows = await db.execute(sql`
      SELECT id::text AS id, seq::text AS seq FROM messages
      WHERE channel_id = ${zeroCursor.id}::uuid ORDER BY seq DESC LIMIT 1
    `);
    const top = rows.rows[0] as { id: string; seq: string };
    assert.deepEqual(
      zeroEntry.readState.latestActivity,
      { messageId: top.id, seq: top.seq },
      "frontier pair must match the storage channel's latest message row",
    );
  }
});

test("real DB: list exit carries readState on every row; cross-exit same-scope same-union; empty channel = present with null frontier", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "list-exit@example.com",
    name: "list-exit",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [peer] = await db.insert(users).values({
    email: "list-exit-peer@example.com",
    name: "list-exit-peer",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "ListExit",
    slug: "list-exit",
    ownerId: owner.id,
  }).returning();
  const mk = async (name: string) => {
    const [ch] = await db.insert(channels).values({ serverId: server.id, name, type: "channel" }).returning();
    await db.insert(channelHumans).values({ channelId: ch.id, userId: owner.id });
    return ch;
  };
  const withCursorAndUnread = await mk("cursor-and-unread");
  const emptyWithCursor = await mk("empty-with-cursor");
  const noCursorNoMessages = await mk("bare");

  await db.insert(messages).values([
    { channelId: withCursorAndUnread.id, senderType: "user", senderId: peer.id, content: "x" },
  ]);
  await db.execute(sql`
    INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version)
    VALUES (${owner.id}::uuid, ${withCursorAndUnread.id}::uuid, 0, 0),
           (${owner.id}::uuid, ${emptyWithCursor.id}::uuid, 0, 0)
  `);

  const list = await listChannels(server.id, owner.id) as unknown as Array<{
    id: string;
    maxReadSeq: number;
    readStateVersion: number;
    readState: { kind: string; latestActivity?: { messageId: string; seq: string } | null };
  }>;
  const byId = new Map(list.map((row) => [row.id, row]));

  const unreadRow = byId.get(withCursorAndUnread.id);
  assert.ok(unreadRow, "channel row present in list");
  assert.equal(unreadRow.readState.kind, "present");
  assert.ok(unreadRow.readState.latestActivity, "message-bearing channel carries a frontier pair");
  // Legacy fields keep their historical coalesce shape.
  assert.equal(unreadRow.maxReadSeq, 0);
  assert.equal(unreadRow.readStateVersion, 0);

  // The case unreachable at the sparse summary IS reachable here: a channel
  // with a cursor but zero messages -> present with null frontier.
  const emptyRow = byId.get(emptyWithCursor.id);
  assert.ok(emptyRow);
  assert.deepEqual(emptyRow.readState, {
    kind: "present",
    readStateVersion: 0,
    maxReadSeq: "0",
    latestActivity: null,
  });

  const bareRow = byId.get(noCursorNoMessages.id);
  assert.ok(bareRow);
  assert.deepEqual(bareRow.readState, { kind: "absent" }, "no cursor row is absent on list rows too");
  assert.equal(bareRow.maxReadSeq, 0, "legacy coalesce shape preserved for absent");

  // Cross-exit consistency (server-side half of the frozen tooth): the same
  // scope through the summary exit and the list exit yields the SAME union.
  const summary = await getUnreadSummary(server.id, owner.id);
  const summaryEntry = summary[withCursorAndUnread.id];
  assert.ok(summaryEntry, "unread scope present in summary");
  assert.deepEqual(
    summaryEntry.readState,
    unreadRow.readState,
    "summary exit and list exit must produce the identical union for the same scope",
  );
});

test("real DB: followed-thread route rows carry readState through the manual map (absent + present-at-zero + same-source pair)", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "ft-exit@example.com",
    name: "ft-exit",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "FtExit",
    slug: "ft-exit",
    ownerId: owner.id,
  }).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id, name: "parent", type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id });
  const mkThread = async (name: string, parentSeq: number) => {
    const [pm] = await db.insert(messages).values({
      channelId: parentChannel.id, senderType: "user", senderId: owner.id,
      content: `parent-${name}`, seq: parentSeq,
    }).returning();
    const [tc] = await db.insert(channels).values({
      serverId: server.id, name, type: "thread", parentMessageId: pm.id,
    }).returning();
    await db.execute(sql`
      INSERT INTO thread_follows (thread_channel_id, follower_type, follower_id, parent_message_id, reason)
      VALUES (${tc.id}::uuid, 'user', ${owner.id}::uuid, ${pm.id}::uuid, 'authored')
    `);
    return { pm, tc };
  };
  const cursored = await mkThread("t-cursored", 10);
  const bare = await mkThread("t-bare", 20);
  // Reply in the cursored thread so it carries a thread-side frontier.
  const [reply] = await db.insert(messages).values({
    channelId: cursored.tc.id, senderType: "user", senderId: owner.id,
    content: "reply", seq: 30,
  }).returning();
  await db.execute(sql`
    INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version)
    VALUES (${owner.id}::uuid, ${cursored.tc.id}::uuid, 0, 0)
  `);

  const followed = await getFollowedThreads(server.id, owner.id, undefined) as unknown as Array<{
    threadChannelId: string;
    readState: { kind: string; readStateVersion?: number; maxReadSeq?: string; latestActivity?: { messageId: string; seq: string } | null };
    maxReadSeq: number;
    readStateVersion: number;
  }>;
  const byThread = new Map(followed.map((t) => [t.threadChannelId, t]));

  const cursoredRow = byThread.get(cursored.tc.id);
  assert.ok(cursoredRow, "cursored thread returned");
  assert.equal(cursoredRow.readState.kind, "present", "cursor at 0 must be present on the route row");
  assert.equal(cursoredRow.readState.readStateVersion, 0);
  assert.equal(cursoredRow.readState.maxReadSeq, "0");
  assert.deepEqual(
    cursoredRow.readState.latestActivity,
    { messageId: reply.id, seq: "30" },
    "thread frontier is the same-source latest reply pair",
  );
  // Legacy manual-map fields stay byte-compatible.
  assert.equal(cursoredRow.maxReadSeq, 0);
  assert.equal(cursoredRow.readStateVersion, 0);

  const bareRow = byThread.get(bare.tc.id);
  assert.ok(bareRow, "bare thread returned");
  assert.deepEqual(
    bareRow.readState,
    { kind: "absent" },
    "no cursor row must surface as absent on the route row — deleting the readState passthrough in the manual map REDs here",
  );
});
