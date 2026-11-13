// The active followed-threads list served from rw_followed_threads_v5 (072)
// must be indistinguishable from the legacy all-Postgres list. On PGlite the
// global setup installs the Postgres reference for the view
// (src/test/risingWaveReadReference.ts: followedThreadRows), so every case here
// compares the RW path against forceLegacyPath on the same data.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, type TraceAttributes } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import {
  agents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  servers,
  tasks,
  threadFollows,
  userChannelReadCursors,
} from "../db/schema";
import { __testRisingWaveInbox, getFollowedThreads, RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL } from "./channelService";
import { __setActivityReadSourceForTests, type ActivityReadSource } from "./activityReadSource";
import { seedBoundGuest } from "../test/guestFixture";
import {
  installRisingWaveReadReferences,
  referenceActivityReadSource,
  uninstallRisingWaveReadReferences,
} from "../test/risingWaveReadReference";
import { createTraceDbQueryTracer, withTraceRoot } from "../tracing/semanticTrace";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";

type FollowedThreads = Awaited<ReturnType<typeof getFollowedThreads>>;
type TraceEvent = { name: string; attrs?: TraceAttributes };

const MINUTE = 60_000;
const BASE = Date.parse("2026-09-01T12:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * MINUTE);

/** Over 141 characters, with astral code points around the 100/140 cut points. */
const LONG_PARENT = `${"p".repeat(98)}😀😀${"q".repeat(60)} parent tail`;
const LONG_REPLY = `${"r".repeat(138)}😀😀😀${"s".repeat(60)} reply tail`;

async function traced<T>(work: (traceQuery: DbQueryTracer) => Promise<T>): Promise<{ result: T; events: TraceEvent[] }> {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const result = await withTraceRoot(
    tracer,
    "test.followed_threads",
    { surface: "server" },
    () => work(createTraceDbQueryTracer("followed_threads.loaded")),
  );
  const span = sink.getAllSpans().find((candidate) => candidate.name === "test.followed_threads");
  assert.ok(span);
  return { result, events: [...span.events] };
}

function eventAttrs(events: TraceEvent[], name: string): TraceAttributes | undefined {
  return events.find((event) => event.name === name)?.attrs;
}

function queryNames(events: TraceEvent[]): string[] {
  return events
    .filter((event) => event.name === "db.query.finished")
    .map((event) => String(event.attrs?.query_name));
}

const byThread = (threads: FollowedThreads) =>
  [...threads].sort((a, b) => a.threadChannelId.localeCompare(b.threadChannelId));

async function insertThread(db: Database, input: {
  serverId: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: Date;
}) {
  const [parent] = await db.insert(messages).values({
    channelId: input.channelId,
    senderType: "user",
    senderId: input.authorId,
    content: input.content,
    createdAt: input.createdAt,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: input.serverId,
    name: `thread-${parent.id.slice(0, 8)}`,
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  return { parent, thread };
}

async function reply(db: Database, threadId: string, senderId: string, content: string, createdAt: Date) {
  const [message] = await db.insert(messages).values({
    channelId: threadId,
    senderType: "user",
    senderId,
    content,
    createdAt,
  }).returning();
  return message;
}

async function follow(
  db: Database,
  threadId: string,
  parentMessageId: string,
  userId: string,
  state: { doneAt?: Date; unfollowedAt?: Date } = {},
) {
  await db.insert(threadFollows).values({
    threadChannelId: threadId,
    parentMessageId,
    reason: "manual",
    followerType: "user",
    followerId: userId,
    ...state,
  });
}

function withReadSource(source: ActivityReadSource) {
  __setActivityReadSourceForTests(source);
}

afterEach(() => {
  __testRisingWaveInbox.reset();
  installRisingWaveReadReferences();
});

test("RW path equals the legacy path: replies, unread, task with an agent claimant, previews over 141 chars", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "claim-bot", status: "active" }).returning();

  // T1: long parent, two long replies, the first read, a task claimed by an agent.
  const t1 = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: LONG_PARENT, createdAt: at(0) });
  const read = await reply(db, t1.thread.id, peer.id, `${LONG_REPLY} 1`, at(1));
  const latest = await reply(db, t1.thread.id, peer.id, `${LONG_REPLY} 2`, at(5));
  await db.insert(userChannelReadCursors).values({ userId: owner.id, channelId: t1.thread.id, lastReadSeq: read.seq, updatedAt: new Date() });
  await db.insert(tasks).values({
    channelId: channel.id, taskNumber: 7, title: "task", status: "in_progress",
    createdByType: "user", createdById: peer.id, claimedByType: "agent", claimedById: agent.id, messageId: t1.parent.id,
  });
  await follow(db, t1.thread.id, t1.parent.id, owner.id);
  // T2: zero replies.
  const t2 = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: owner.id, content: "short parent", createdAt: at(2) });
  await follow(db, t2.thread.id, t2.parent.id, owner.id);
  // T3: only the owner's own reply (read state absent, nothing unread).
  const t3 = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "own reply parent", createdAt: at(3) });
  await reply(db, t3.thread.id, owner.id, "my own reply", at(4));
  await follow(db, t3.thread.id, t3.parent.id, owner.id);
  // Done and unfollowed follows are in the view (every state) but not in the active list.
  const done = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "done", createdAt: at(6) });
  await follow(db, done.thread.id, done.parent.id, owner.id, { doneAt: at(7) });
  const unfollowed = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "unfollowed", createdAt: at(8) });
  await follow(db, unfollowed.thread.id, unfollowed.parent.id, owner.id, { unfollowedAt: at(9) });

  const legacy = await getFollowedThreads(server.id, owner.id, undefined, { forceLegacyPath: true });
  const { result: rw, events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery }));

  assert.deepEqual(rw, legacy, "same rows, same fields, same order");
  assert.deepEqual(rw.map((t) => t.threadChannelId), [t1.thread.id, t3.thread.id, t2.thread.id]);
  const row1 = rw[0]!;
  assert.equal(row1.parentMessagePreview, `${LONG_PARENT.slice(0, 100)}…`);
  assert.equal(row1.latestActivityPreview, `${latest.content.slice(0, 140)}…`);
  assert.equal(row1.latestActivityMessageId, latest.id);
  assert.equal(row1.latestActivitySeq, String(latest.seq));
  assert.equal(row1.replyCount, 2);
  assert.equal(row1.unreadCount, 1);
  assert.equal(row1.taskNumber, 7);
  assert.equal(row1.taskClaimedByType, "agent");
  assert.equal(row1.taskClaimedByName, "claim-bot");
  assert.equal(row1.maxReadSeq, Number(read.seq));
  assert.equal(row1.readState.kind, "present");
  assert.equal(rw[2]!.latestActivityMessageId, t2.parent.id, "zero replies: the parent is the latest activity");
  assert.equal(rw[2]!.latestActivitySeq, String(t2.parent.seq));

  const selected = eventAttrs(events, "followed_threads.source_selected");
  assert.equal(selected?.followed_threads_source, "rw_v5");
  assert.equal(selected?.followed_threads_count, 3);
  assert.equal(selected?.rw_rows_count, 5, "the view carries every follow state");
  assert.equal(selected?.rw_regular_threads, 3);
  assert.equal(selected?.rw_non_regular_threads, 0);
  assert.equal(selected?.rw_missing_threads, 0);
  assert.equal(selected?.rw_missing_thread_ids, undefined);
  const names = queryNames(events);
  assert.ok(!names.includes("channels.followed_threads_by_user"), "no per-thread Postgres list query");
  assert.ok(!names.includes("channels.read_state_by_channels"), "no LATERAL read-state query");
  assert.ok(!names.includes("channels.followed_threads_stats_by_threads"), "stats come from the RW row");
  assert.ok(names.includes("channels.followed_threads.read_cursors"));
});

test("RW path visibility: private parent for members only, archived parent and deleted thread hidden", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const memberPrivate = await seed.channel({ server, members: [owner, peer], visibility: "private" });
  const outsiderPrivate = await seed.channel({ server, members: [peer], visibility: "private" });
  const publicChannel = await seed.channel({ server, members: [owner, peer] });
  const archived = await seed.channel({ server, members: [owner, peer] });

  const visible = await insertThread(db, { serverId: server.id, channelId: memberPrivate.id, authorId: peer.id, content: "member private", createdAt: at(0) });
  const hiddenPrivate = await insertThread(db, { serverId: server.id, channelId: outsiderPrivate.id, authorId: peer.id, content: "outsider private", createdAt: at(1) });
  const hiddenArchived = await insertThread(db, { serverId: server.id, channelId: archived.id, authorId: peer.id, content: "archived", createdAt: at(2) });
  const hiddenDeleted = await insertThread(db, { serverId: server.id, channelId: publicChannel.id, authorId: peer.id, content: "deleted thread", createdAt: at(3) });
  for (const t of [visible, hiddenPrivate, hiddenArchived, hiddenDeleted]) {
    await reply(db, t.thread.id, peer.id, "reply", at(10));
    await follow(db, t.thread.id, t.parent.id, owner.id);
  }
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, hiddenDeleted.thread.id));

  const legacy = await getFollowedThreads(server.id, owner.id, undefined, { forceLegacyPath: true });
  const { result: rw, events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery }));
  assert.deepEqual(rw, legacy);
  assert.deepEqual(rw.map((t) => t.threadChannelId), [visible.thread.id]);
  assert.equal(rw[0]!.parentChannelType, "private");
  assert.equal(rw[0]!.parentChannelName, memberPrivate.name);
  const selected = eventAttrs(events, "followed_threads.source_selected");
  assert.equal(selected?.followed_threads_count, 3, "the deleted thread is not in the follow set");
  assert.equal(selected?.rw_hidden_threads, 2);

  // The peer is a member of the private parent the owner cannot see.
  await follow(db, hiddenPrivate.thread.id, hiddenPrivate.parent.id, peer.id);
  const peerRw = await getFollowedThreads(server.id, peer.id);
  assert.deepEqual(peerRw, await getFollowedThreads(server.id, peer.id, undefined, { forceLegacyPath: true }));
  assert.deepEqual(peerRw.map((t) => t.threadChannelId), [hiddenPrivate.thread.id]);
});

test("followed threads missing from RW (CDC lag) are left out and counted, not filled in from Postgres", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const lagging = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: LONG_PARENT, createdAt: at(0) });
  await reply(db, lagging.thread.id, peer.id, LONG_REPLY, at(1));
  await follow(db, lagging.thread.id, lagging.parent.id, owner.id);
  const parentLagging = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "parent not in RW", createdAt: at(2) });
  await follow(db, parentLagging.thread.id, parentLagging.parent.id, owner.id);
  const present = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "present", createdAt: at(3) });
  await reply(db, present.thread.id, peer.id, "present reply", at(4));
  await follow(db, present.thread.id, present.parent.id, owner.id);

  const legacy = await getFollowedThreads(server.id, owner.id, undefined, { forceLegacyPath: true });
  withReadSource({
    ...referenceActivityReadSource,
    async followedThreadRows(query) {
      const rows = await referenceActivityReadSource.followedThreadRows(query);
      return rows
        // The thread row has not reached RW at all.
        .filter((row) => row.threadChannelId !== lagging.thread.id)
        // The thread row has, its parent message (rw_messages) has not.
        .map((row) => row.threadChannelId === parentLagging.thread.id
          ? { ...row, parentChannelId: null, parentServerId: null, parentMessageContent: null, parentMessageCreatedAt: null }
          : row);
    },
  });
  const { result: rw, events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery }));
  // Same as the legacy path for the thread RW has; the two lagging ones are absent.
  assert.deepEqual(byThread(rw), byThread(legacy.filter((t) => t.threadChannelId === present.thread.id)));
  assert.equal(rw.length, 1);
  const selected = eventAttrs(events, "followed_threads.source_selected");
  assert.equal(selected?.followed_threads_source, "rw_v5");
  assert.equal(selected?.rw_missing_threads, 2);
  assert.deepEqual(
    String(selected?.rw_missing_thread_ids).split(",").sort(),
    [lagging.thread.id, parentLagging.thread.id].sort(),
    "the missing thread ids are traced",
  );
  assert.equal(selected?.rw_regular_threads, 1);
  assert.equal(events.find((event) => event.attrs?.query_name === "channels.followed_threads_by_user"), undefined, "no Postgres list query for the missing threads");
});

test("a failed RW read runs the whole legacy path and never surfaces the error", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const t = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "parent", createdAt: at(0) });
  await reply(db, t.thread.id, peer.id, "reply", at(1));
  await follow(db, t.thread.id, t.parent.id, owner.id);

  const legacy = await getFollowedThreads(server.id, owner.id, undefined, { forceLegacyPath: true });
  withReadSource({
    ...referenceActivityReadSource,
    async followedThreadRows() {
      throw new Error('relation "rw_followed_threads_v5" does not exist');
    },
  });
  const { result, events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery }));
  assert.deepEqual(result, legacy);
  assert.ok(eventAttrs(events, "followed_threads.rw_rows.failed")?.error_class);
  const selected = eventAttrs(events, "followed_threads.source_selected");
  assert.equal(selected?.followed_threads_source, "legacy");
  assert.equal(selected?.legacy_reason, "rw_failed");
  assert.ok(queryNames(events).includes("channels.followed_threads_by_user"));
});

test("the RW read: one rw_followed_threads_v5 lookup on (server, user), traced as a RisingWave query", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const t = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "parent", createdAt: at(0) });
  await reply(db, t.thread.id, peer.id, "reply", at(1));
  await follow(db, t.thread.id, t.parent.id, owner.id);

  const legacy = await getFollowedThreads(server.id, owner.id, undefined, { forceLegacyPath: true });
  const referenceRows = await referenceActivityReadSource.followedThreadRows({ serverId: server.id, userId: owner.id, traceQuery: (_n, work) => work() });
  const rwCalls: Array<{ text: string; values: unknown[] | undefined }> = [];
  uninstallRisingWaveReadReferences();
  __testRisingWaveInbox.set({
    getPool: () => ({}) as never,
    query: (async (_pool: unknown, text: string, values?: unknown[]) => {
      // hasMention reads the sidebar unread view alongside; no mentions here.
      if (!text.includes("rw_followed_threads_v5")) {
        return { result: { rows: [] }, acquireWaitMs: 0, poolState: { rw_pool_total: 1, rw_pool_idle: 0, rw_pool_waiting: 0 } };
      }
      rwCalls.push({ text, values });
      return { result: { rows: referenceRows }, acquireWaitMs: 3, poolState: { rw_pool_total: 1, rw_pool_idle: 0, rw_pool_waiting: 0 } };
    }) as never,
  });
  const { result, events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery }));
  assert.deepEqual(result, legacy);
  assert.equal(rwCalls.length, 1, "one rw_followed_threads_v5 read");
  assert.equal(rwCalls[0]!.text, RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL);
  assert.match(rwCalls[0]!.text, /FROM rw_followed_threads_v5 v\s+WHERE v\.server_id = \$1\s+AND v\.user_id = \$2/);
  assert.deepEqual(rwCalls[0]!.values, [server.id, owner.id]);
  const rwQuery = events.find((event) => event.attrs?.query_name === "channels.followed_threads_rw_rows");
  assert.equal(rwQuery?.attrs?.backend, "risingwave");
  assert.equal(rwQuery?.attrs?.db_system, "risingwave");
  assert.equal(rwQuery?.attrs?.rw_followed_threads_view, "rw_followed_threads_v5");
  assert.equal(rwQuery?.attrs?.rows_count, 1);
  assert.equal(rwQuery?.attrs?.["rw.acquire_wait_ms"], 3);
});

test("a joint thread is served from rw_followed_threads_v5 with the local joint parent, without the Postgres joint query", async ({ seed, db }) => {
  const owner = await seed.human();
  const sender = await seed.human();
  const receiverServer = await seed.server({ owner });
  const senderServer = await seed.server({ owner: sender });
  const [storage] = await db.insert(servers).values({
    name: "joint storage", slug: `__joint_storage_${receiverServer.id.slice(0, 8)}__`, ownerId: sender.id, kind: "joint_storage",
  }).returning();
  const [canonical, senderLocal, receiverLocal] = await db.insert(channels).values([
    { serverId: storage.id, name: "canonical", type: "joint" },
    { serverId: senderServer.id, name: "sender-local", type: "joint" },
    { serverId: receiverServer.id, name: "receiver-local", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id, createdByServerId: senderServer.id, createdByUserId: sender.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: senderServer.id, localChannelId: senderLocal.id, role: "host", status: "active", joinedByUserId: sender.id },
    { jointChannelId: joint.id, serverId: receiverServer.id, localChannelId: receiverLocal.id, role: "participant", status: "active", joinedByUserId: owner.id },
  ]);
  await db.insert(channelHumans).values({ channelId: receiverLocal.id, userId: owner.id });
  // Canonical thread in storage; the receiver's local thread projection has no parent message.
  const canonicalThread = await insertThread(db, { serverId: storage.id, channelId: canonical.id, authorId: sender.id, content: "joint parent", createdAt: at(0) });
  await reply(db, canonicalThread.thread.id, sender.id, "joint reply", at(1));
  const [localThread] = await db.insert(channels).values({
    serverId: receiverServer.id, name: "receiver-thread", type: "thread",
  }).returning();
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.thread.id, createdByServerId: senderServer.id, createdByUserId: sender.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: threadJoint.id, serverId: receiverServer.id, localChannelId: localThread.id, role: "participant", status: "active", joinedByUserId: owner.id,
  });
  await follow(db, localThread.id, canonicalThread.parent.id, owner.id);
  // And one regular thread beside it.
  const channel = await seed.channel({ server: receiverServer, members: [owner] });
  const regular = await insertThread(db, { serverId: receiverServer.id, channelId: channel.id, authorId: owner.id, content: "regular", createdAt: at(2) });
  await follow(db, regular.thread.id, regular.parent.id, owner.id);

  const legacy = await getFollowedThreads(receiverServer.id, owner.id, undefined, { forceLegacyPath: true });
  const { result: rw, events } = await traced((traceQuery) => getFollowedThreads(receiverServer.id, owner.id, undefined, { traceQuery }));
  assert.deepEqual(byThread(rw), byThread(legacy));
  const jointRow = rw.find((t) => t.threadChannelId === localThread.id);
  assert.ok(jointRow, "the joint thread is listed");
  assert.equal(jointRow.parentChannelId, receiverLocal.id);
  assert.equal(jointRow.replyCount, 1);
  const selected = eventAttrs(events, "followed_threads.source_selected");
  assert.equal(selected?.rw_non_regular_threads, 0);
  assert.equal(selected?.joint_threads, 1);
  assert.equal(selected?.rw_regular_threads, 2, "the joint projection is served like a regular thread");
  assert.ok(!queryNames(events).includes("channels.followed_joint_threads_by_user"), "no Postgres joint query on the RW path");

  // Not a member of the local joint channel: hidden on both paths (the joint
  // query's parent_member rule). Archived local joint channel: hidden too.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, receiverLocal.id), eq(channelHumans.userId, owner.id)));
  const legacyNonMember = await getFollowedThreads(receiverServer.id, owner.id, undefined, { forceLegacyPath: true });
  const rwNonMember = await getFollowedThreads(receiverServer.id, owner.id);
  assert.deepEqual(byThread(rwNonMember), byThread(legacyNonMember));
  assert.equal(rwNonMember.some((t) => t.threadChannelId === localThread.id), false);
  await db.insert(channelHumans).values({ channelId: receiverLocal.id, userId: owner.id });
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, receiverLocal.id));
  const legacyArchived = await getFollowedThreads(receiverServer.id, owner.id, undefined, { forceLegacyPath: true });
  const rwArchived = await getFollowedThreads(receiverServer.id, owner.id);
  assert.deepEqual(byThread(rwArchived), byThread(legacyArchived));
  assert.equal(rwArchived.some((t) => t.threadChannelId === localThread.id), false);
});

test("guests, other states, search, channel filter and row caps take the legacy path", async ({ seed, db }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id }, db);
  const t = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: owner.id, content: "parent", createdAt: at(0) });
  await follow(db, t.thread.id, t.parent.id, guest.id);
  await follow(db, t.thread.id, t.parent.id, owner.id);

  const reasonOf = async (userId: string, opts: Parameters<typeof getFollowedThreads>[3] = {}) => {
    const { events } = await traced((traceQuery) => getFollowedThreads(server.id, userId, undefined, { ...opts, traceQuery }));
    const selected = eventAttrs(events, "followed_threads.source_selected");
    return selected?.followed_threads_source === "legacy" ? selected.legacy_reason : selected?.followed_threads_source;
  };
  assert.equal(await reasonOf(guest.id), "guest");
  assert.equal(await reasonOf(owner.id), "rw_v5");
  assert.equal(await reasonOf(owner.id, { state: "done" }), "state");
  assert.equal(await reasonOf(owner.id, { state: "unfollowed_active" }), "state");
  assert.equal(await reasonOf(owner.id, { q: "parent" }), "search");
  assert.equal(await reasonOf(owner.id, { channelId: channel.id }), "channel_filter");
  assert.equal(await reasonOf(owner.id, { maxRows: 10 }), "max_rows");
  assert.equal(await reasonOf(owner.id, { forceLegacyPath: true }), "forced");
  assert.equal(
    await db.transaction(async (executor) => {
      const { events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { executor, traceQuery }));
      return eventAttrs(events, "followed_threads.source_selected")?.legacy_reason;
    }),
    "executor",
  );
});

test("free plan cutoff: numbers come from RW as-is, only a latest reply older than the cutoff loses its preview", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const cutoff = at(100);
  const old = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "old parent", createdAt: at(0) });
  await reply(db, old.thread.id, peer.id, "old reply content", at(10));
  await reply(db, old.thread.id, peer.id, "older latest reply content", at(20));
  await follow(db, old.thread.id, old.parent.id, owner.id);
  const fresh = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "fresh parent", createdAt: at(1) });
  await reply(db, fresh.thread.id, peer.id, "before cutoff", at(30));
  await reply(db, fresh.thread.id, peer.id, "after cutoff", at(200));
  await follow(db, fresh.thread.id, fresh.parent.id, owner.id);

  const uncut = await getFollowedThreads(server.id, owner.id);
  let statsCalls = 0;
  withReadSource({
    ...referenceActivityReadSource,
    async followedThreadStats(query) {
      statsCalls += 1;
      return referenceActivityReadSource.followedThreadStats(query);
    },
  });
  const { result: cut, events } = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, cutoff, { traceQuery }));
  const { result: cutLegacy, events: legacyEvents } = await traced((traceQuery) =>
    getFollowedThreads(server.id, owner.id, cutoff, { traceQuery, forceLegacyPath: true }));
  assert.deepEqual(cut, cutLegacy, "both paths apply the same cutoff rule");

  const oldRow = cut.find((t) => t.threadChannelId === old.thread.id)!;
  const oldUncut = uncut.find((t) => t.threadChannelId === old.thread.id)!;
  assert.equal(oldRow.latestActivityPreview, "", "content older than the cutoff is withheld");
  assert.equal(oldRow.parentMessagePreview, "old parent", "the parent preview is not cut");
  assert.deepEqual(
    { ...oldRow, latestActivityPreview: oldUncut.latestActivityPreview },
    oldUncut,
    "everything else (counts, lastReplyAt, ids, seqs, sender) is unchanged",
  );
  assert.equal(oldRow.replyCount, 2);
  assert.equal(oldRow.unreadCount, 2);
  const freshRow = cut.find((t) => t.threadChannelId === fresh.thread.id)!;
  assert.equal(freshRow.latestActivityPreview, "after cutoff");
  assert.equal(freshRow.replyCount, 2, "replies before the cutoff still count");
  assert.deepEqual(freshRow, uncut.find((t) => t.threadChannelId === fresh.thread.id));

  // The cutoff no longer reroutes stats to Postgres: the legacy path asked the
  // RW stats source (here its reference) and traced no history_cutoff read.
  assert.equal(statsCalls, 1, "legacy path: one RW stats read despite the cutoff");
  assert.ok(![...events, ...legacyEvents].some((event) => event.attrs?.fallback_reason === "history_cutoff"));
});

test("read state is traced: read_cursors on the RW path, read_state_by_channels on the legacy path", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const t = await insertThread(db, { serverId: server.id, channelId: channel.id, authorId: peer.id, content: "parent", createdAt: at(0) });
  const first = await reply(db, t.thread.id, peer.id, "reply", at(1));
  await reply(db, t.thread.id, peer.id, "reply 2", at(2));
  await db.insert(userChannelReadCursors).values({ userId: owner.id, channelId: t.thread.id, lastReadSeq: first.seq, updatedAt: new Date() });
  await follow(db, t.thread.id, t.parent.id, owner.id);

  const rw = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery }));
  const cursors = rw.events.find((event) => event.attrs?.query_name === "channels.followed_threads.read_cursors");
  assert.equal(cursors?.attrs?.input_count, 1);
  assert.equal(cursors?.attrs?.read_cursor_rows_count, 1);
  const legacy = await traced((traceQuery) => getFollowedThreads(server.id, owner.id, undefined, { traceQuery, forceLegacyPath: true }));
  const authority = legacy.events.find((event) => event.attrs?.query_name === "channels.read_state_by_channels");
  assert.equal(authority?.attrs?.read_state_authority_rows_count, 1);
  assert.deepEqual(rw.result, legacy.result);
  assert.equal(rw.result[0]!.unreadCount, 1);
  assert.equal(rw.result[0]!.maxReadSeq, Number(first.seq));
});
