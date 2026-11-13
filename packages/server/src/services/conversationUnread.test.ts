// Sidebar unread (GET /channels/unread, GET /servers/unread-summary) reads ONE
// source: rw_conversation_unread_v4. Here the global test setup answers it from
// the Postgres reference (src/test/conversationUnreadReference.ts); the last cases
// take the reference away to pin the RisingWave read itself and its no-fallback
// contract.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { inboxTargetMuteStates, messages } from "../db/schema";
import {
  __testRisingWaveInbox,
  getSidebarUnreadSummaryCounts,
  getUnreadCounts,
  getUnreadSummary,
  markRead,
} from "./channelService";
import {
  __setConversationUnreadSourceForTests,
  getConversationUnreadSourceOverride,
} from "./conversationUnreadSource";

const installedSource = getConversationUnreadSourceOverride();

afterEach(() => {
  __setConversationUnreadSourceForTests(installedSource);
  __testRisingWaveInbox.reset();
});

test("a non-joined public channel reports hasNew without a count and is absent from bare counts", async ({ seed }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const outside = await seed.channel({ server, members: [peer], name: "not-joined" });
  await seed.message({ channel: outside, author: peer, content: "one" });
  const latest = await seed.message({ channel: outside, author: peer, content: "two" });

  const summary = await getUnreadSummary(server.id, owner.id);
  assert.deepEqual(
    summary[outside.id],
    { unreadCount: 0, hasMention: false, hasAnyMention: false, hasNew: true, readState: { kind: "absent" } },
  );
  assert.equal((await getUnreadCounts(server.id, owner.id))[outside.id], undefined, "no exact count for a non-joined channel");

  await markRead(owner.id, outside.id, latest.seq);
  assert.equal((await getUnreadSummary(server.id, owner.id))[outside.id], undefined, "nothing past the cursor: no entry");

  // A joined channel is counted exactly and never carries hasNew.
  const joined = await seed.channel({ server, members: [owner, peer], name: "joined" });
  await seed.message({ channel: joined, author: peer, content: "hello" });
  const joinedEntry = (await getUnreadSummary(server.id, owner.id))[joined.id];
  assert.equal(joinedEntry.unreadCount, 1);
  assert.equal(joinedEntry.hasNew, undefined);
});

test("unread excludes own sends, self-caused system messages and the noise subtypes; a NULL causal actor never excludes", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await db.insert(messages).values([
    { channelId: channel.id, senderType: "user", senderId: peer.id, content: "counted chat" },
    { channelId: channel.id, senderType: "user", senderId: owner.id, content: "own send" },
    { channelId: channel.id, senderType: "user", senderId: peer.id, content: "owner did this", messageType: "system", causalActorType: "user", causalActorId: owner.id },
    { channelId: channel.id, senderType: "user", senderId: peer.id, content: "peer did this", messageType: "system", causalActorType: "user", causalActorId: peer.id },
    { channelId: channel.id, senderType: "user", senderId: peer.id, content: "legacy system", messageType: "system" },
    { channelId: channel.id, senderType: "user", senderId: peer.id, content: "noise", messageType: "system", systemSubtype: "task.deleted_summary" },
    { channelId: channel.id, senderType: "user", senderId: peer.id, content: "noise", messageType: "system", systemSubtype: "channel.self_unfollow_thread" },
  ]);

  assert.equal((await getUnreadCounts(server.id, owner.id))[channel.id], 3);
  assert.equal((await getUnreadSummary(server.id, owner.id))[channel.id].unreadCount, 3);
});

test("the per-server sidebar count sums joined channels (muted included), not non-joined channels", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const other = await seed.server({ owner: peer, members: [owner] });
  const joined = await seed.channel({ server, members: [owner, peer], name: "joined" });
  const muted = await seed.channel({ server, members: [owner, peer], name: "muted" });
  const outside = await seed.channel({ server, members: [peer], name: "outside" });
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "user",
    receiverId: owner.id,
    serverId: server.id,
    sourceChannelId: muted.id,
    muteFromSeq: 0,
  });
  await seed.message({ channel: joined, author: peer, content: "a" });
  await seed.message({ channel: joined, author: peer, content: "b" });
  await seed.message({ channel: muted, author: peer, content: "c" });
  await seed.message({ channel: outside, author: peer, content: "d" });

  const counts = await getSidebarUnreadSummaryCounts([server.id, other.id], owner.id);
  assert.deepEqual(counts, { [server.id]: 3, [other.id]: 0 });

  const summary = await getUnreadSummary(server.id, owner.id);
  assert.equal(summary[muted.id].unreadCount, 1, "a muted joined channel keeps its full count in the sidebar");
  assert.equal(summary[outside.id].hasNew, true);
});

test("without RisingWave (and no test reference) the readers fail; there is no Postgres fallback", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __setConversationUnreadSourceForTests(null);
  __testRisingWaveInbox.set({ getPool: () => null });

  await assert.rejects(getUnreadSummary(server.id, owner.id), /RisingWave is not configured/);
  await assert.rejects(getUnreadCounts(server.id, owner.id), /RisingWave is not configured/);
  await assert.rejects(getSidebarUnreadSummaryCounts([server.id], owner.id), /RisingWave is not configured/);
});

// The summary also reads the person's marked-unread conversations from Postgres
// (loadMarkedUnreadScopes): the db fixture gives it a database, with none marked.
test("the RisingWave read: one round trip, receiver-keyed, public arm only for the summary; rows merge per channel", async ({ db: _db }) => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const serverId = "22222222-2222-4222-8222-222222222222";
  const joined = "33333333-3333-4333-8333-333333333333";
  const mentionedOutside = "44444444-4444-4444-8444-444444444444";
  const reads: Array<{ text: string; values: unknown[] | undefined }> = [];
  let answer: Record<string, unknown>[] = [];
  __setConversationUnreadSourceForTests(null);
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values?: unknown[]) => {
      reads.push({ text, values });
      return { result: { rows: answer }, acquireWaitMs: 0, poolState: { rw_pool_total: 1, rw_pool_idle: 1, rw_pool_waiting: 0 } };
    }) as never,
  });
  const viewRow = (over: Record<string, unknown>) => ({
    server_id: serverId, kind: "channel", subscribed: true, unread_count: 0, mention_unread: 0, total_mentions: 0,
    has_new: false, latest_seq: "9", latest_message_id: "m9", cursor_present: true, last_read_seq: "4", read_state_version: 2,
    ...over,
  });
  answer = [
    viewRow({ target_id: joined, unread_count: 5, mention_unread: 1, total_mentions: 1 }),
    viewRow({ target_id: mentionedOutside, subscribed: false, mention_unread: 0, total_mentions: 2, cursor_present: false, last_read_seq: null, read_state_version: null }),
    viewRow({ target_id: mentionedOutside, subscribed: false, has_new: true, latest_message_id: null, cursor_present: false, last_read_seq: null, read_state_version: null }),
  ];

  const summary = await getUnreadSummary(serverId, userId);
  assert.equal(reads.length, 1, "counts, mentions, read state and hasNew come from one RisingWave read");
  assert.match(reads[0].text, /FROM rw_conversation_unread_v4/);
  assert.match(reads[0].text, /receiver_type = 'user'/);
  assert.match(reads[0].text, /FROM rw_channels AS c/);
  assert.match(reads[0].text, /rw_target_latest_v4/);
  assert.match(reads[0].text, /rw_target_eligible_v1/);
  assert.match(reads[0].text, /rw_user_channel_read_cursors_v2/);
  assert.deepEqual(reads[0].values, [userId, serverId]);
  assert.deepEqual(summary[joined], {
    unreadCount: 5,
    hasMention: true,
    hasAnyMention: true,
    readState: { kind: "present", readStateVersion: 2, maxReadSeq: "4", latestActivity: { messageId: "m9", seq: "9" } },
  });
  assert.deepEqual(summary[mentionedOutside], {
    unreadCount: 0,
    hasMention: false,
    hasAnyMention: true,
    hasNew: true,
    readState: { kind: "absent" },
  });

  reads.length = 0;
  const counts = await getUnreadCounts(serverId, userId);
  assert.doesNotMatch(reads[0].text, /rw_channels/, "bare counts do not ask the public arm");
  assert.deepEqual(counts, { [joined]: 5 });

  reads.length = 0;
  answer = [{ server_id: serverId, unread_count: "7" }];
  const other = "55555555-5555-4555-8555-555555555555";
  assert.deepEqual(await getSidebarUnreadSummaryCounts([serverId, other], userId), { [serverId]: 7, [other]: 0 });
  assert.match(reads[0].text, /FROM rw_conversation_unread_v4/);
  assert.match(reads[0].text, /AND subscribed/);
  assert.match(reads[0].text, /kind NOT IN \('thread', 'task'\)/);
  assert.deepEqual(reads[0].values, [userId, [serverId, other]]);
});

test("a RisingWave read failure fails the request", async () => {
  __setConversationUnreadSourceForTests(null);
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async () => {
      throw new Error("rw down");
    }) as never,
  });
  await assert.rejects(
    getUnreadSummary("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"),
    /rw down/,
  );
});
