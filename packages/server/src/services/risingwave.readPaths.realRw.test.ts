/**
 * Every production RisingWave read, once, against a REAL RisingWave.
 *
 * The rest of the suite runs on PGlite with the RisingWave readers pinned to
 * their test-only Postgres references (src/test/risingWaveReadReference.ts), so
 * SQL that RisingWave rejects (e.g. a bind parameter after LIMIT) passes there. This file runs only
 * when RISINGWAVE_DATABASE_URL and DATABASE_URL point at the `risingwave-real`
 * stack (scripts/ci/risingwave-real-stack.sh); it seeds Postgres, waits for CDC
 * and the MV graph, then calls the real readers with every test seam disabled.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { ServerId, SyncConversationDoneState } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  inboxSuppressionStates,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  tasks,
  threadFollows,
  userChannelReadCursors,
  users,
} from "../db/schema";
import {
  closeRisingWavePool,
  CONVERSATION_UNREAD_VIEW,
  getRisingWavePool,
  queryRisingWave,
  UNIFIED_CHAIN_VIEWS,
} from "../db/risingwave";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";
import { seedRealRwFixture, waitForRealRwFixture, type RealRwFixture } from "../test/realRwFixture";
import {
  __testRisingWaveInbox,
  getActivityUnreadTotalsBatch,
  getAgentUnreadCounts,
  getFollowedThreads,
  getInboxItems,
  getSidebarUnreadSummaryCounts,
  getUnreadCounts,
  getUnreadSummary,
  isDmScopedInboxItem,
  isPinnedScopedInboxItem,
  listAgentInbox,
  markChannelInboxDone,
  readAgentInboxChainTargetSeqs,
  selectAgentInboxChainRows,
} from "./channelService";
import { uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { parseSyncChangesCursor, readSyncChanges } from "./syncChanges";

const required = process.env.RISINGWAVE_REAL_REQUIRED === "1";
const databaseUrl = process.env.DATABASE_URL?.trim();
const risingWaveUrl = process.env.RISINGWAVE_DATABASE_URL?.trim();
const configured = Boolean(databaseUrl && risingWaveUrl && !databaseUrl.startsWith("pglite"));

if (required && !configured) {
  throw new Error("real RW read-path test requires DATABASE_URL (real Postgres) and RISINGWAVE_DATABASE_URL");
}

let f: RealRwFixture;

type InboxItem = Awaited<ReturnType<typeof getInboxItems>>["items"][number];
/** The conversation an Activity row is about: its channel, or the thread. */
const targetOf = (item: InboxItem) => ((item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId);

beforeAll(async () => {
  if (!configured) return;
  // The global setupFiles pin the RW readers to their Postgres test references;
  // take them away, and clear the pool/query seam, so the real RW pool serves.
  uninstallRisingWaveReadReferences();
  __testRisingWaveInbox.reset();
  await initDatabase(databaseUrl!, undefined, { log: () => {} });
  const pool = getRisingWavePool();
  assert.ok(pool, "RISINGWAVE_DATABASE_URL must yield a RisingWave pool");
  f = await seedRealRwFixture(getDb());
  await waitForRealRwFixture(pool, f);
}, 180_000);

afterAll(async () => {
  if (!configured) return;
  await closeRisingWavePool();
  await closeDatabase();
});

test.skipIf(!configured)("the RisingWave catalog carries every view the server reads", async () => {
  const pool = getRisingWavePool()!;
  const expected = [...new Set([...Object.values(UNIFIED_CHAIN_VIEWS), CONVERSATION_UNREAD_VIEW])];
  const read = await queryRisingWave<{ name: string }>(
    pool,
    "SELECT name FROM rw_catalog.rw_materialized_views WHERE name = ANY($1)",
    [expected],
  );
  assert.deepEqual(read.result.rows.map((row) => row.name).sort(), [...expected].sort());
});

test.skipIf(!configured)("sidebar readers: unread count, mention flag, joint mention on the receiver's projection", async () => {
  const summary = await getUnreadSummary(f.receiverServer.id, f.receiver.id);
  assert.equal(summary[f.general.id]?.unreadCount, 1);
  assert.equal(summary[f.general.id]?.hasMention, true, "the personal mention is flagged");
  assert.equal(summary[f.receiverLocal.id]?.unreadCount, 1);
  assert.equal(summary[f.receiverLocal.id]?.hasMention, true, "the joint mention stored under the sender's projection surfaces for the receiver");
  assert.equal(summary[f.senderLocal.id], undefined, "never keyed on the sender's projection");

  const counts = await getUnreadCounts(f.receiverServer.id, f.receiver.id);
  assert.equal(counts[f.general.id], 1);
  assert.equal(counts[f.receiverLocal.id], 1);
  assert.equal(counts[f.thread.id], 1, "a followed thread counts in the sidebar");

  const perServer = await getSidebarUnreadSummaryCounts([f.receiverServer.id, f.senderServer.id], f.receiver.id);
  assert.equal(perServer[f.receiverServer.id], 2, "channels and DMs only; followed threads excluded");
  assert.equal(perServer[f.senderServer.id] ?? 0, 0);
});

test.skipIf(!configured)("Activity readers: items, mentions, scoped channel, unified all, totals", async () => {
  const all = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50 });
  const general = all.items.find((item) => item.kind === "channel" && item.channelId === f.general.id);
  assert.ok(general, "the unread channel appears in Activity");
  assert.equal(general.unreadCount, 1);
  assert.equal(general.hasMention, true);
  const joint = all.items.find((item) => item.kind === "channel" && item.channelId === f.receiverLocal.id);
  assert.ok(joint, "the joint conversation appears on the receiver's projection");
  assert.equal(joint.hasMention, true);
  const thread = all.items.find((item) => item.kind === "thread" && item.threadChannelId === f.thread.id);
  assert.ok(thread, "the followed thread appears in Activity");
  assert.equal(thread.unreadCount, 1);

  const mentions = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "mentions", limit: 50 });
  assert.deepEqual(
    mentions.items.map(targetOf).sort(),
    [f.general.id, f.receiverLocal.id].sort(),
  );

  const unread = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "unread", limit: 1 });
  assert.equal(unread.items.length, 1, "LIMIT/OFFSET paging works on RisingWave");
  const unreadMentions = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "unread_mentions", limit: 50, sort: "asc" });
  assert.equal(unreadMentions.items.length, 2);

  const scoped = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50, channelId: f.general.id });
  assert.ok(scoped.items.some((item) => targetOf(item) === f.general.id));

  const unified = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50, includeUnfollowedThreads: true });
  assert.ok(unified.items.some((item) => targetOf(item) === f.general.id));

  const totals = await getActivityUnreadTotalsBatch(
    [{ serverId: f.receiverServer.id }, { serverId: f.senderServer.id }],
    f.receiver.id,
  );
  assert.equal(totals.get(f.receiverServer.id)?.totalUnreadCount, 3, "general + joint + followed thread");
  assert.equal(totals.get(f.senderServer.id)?.totalUnreadCount ?? 0, 0);
});

test.skipIf(!configured)("Activity DMs scope: RisingWave serves the same DMs and DM threads as canonical Postgres", async () => {
  // A fresh user, so the fixture receiver's counts elsewhere in this file are untouched.
  const db = getDb();
  const [dmUser] = await db.insert(users).values({
    name: `rwreal-dmuser-${f.tag}`, email: `rwreal-dmuser-${f.tag}@test.invalid`, passwordHash: "x", emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: f.receiverServer.id, userId: dmUser.id, role: "member" });
  const [room, dm, selfDm] = await db.insert(channels).values([
    { serverId: f.receiverServer.id, name: `rwreal-dmscope-room-${f.tag}`, type: "channel" },
    { serverId: f.receiverServer.id, name: `rwreal-dmscope-dm-${f.tag}`, type: "dm" },
    { serverId: f.receiverServer.id, name: `rwreal-dmscope-self-${f.tag}`, type: "dm" },
  ]).returning();
  await db.insert(channelHumans).values([
    { channelId: room.id, userId: dmUser.id },
    { channelId: room.id, userId: f.sender.id },
    { channelId: dm.id, userId: dmUser.id },
    { channelId: dm.id, userId: f.sender.id },
    { channelId: selfDm.id, userId: dmUser.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const [roomMessage] = await db.insert(messages).values({
    channelId: room.id, senderType: "user", senderId: f.sender.id, content: `room ${f.tag}`,
  }).returning();
  const [dmMessage] = await db.insert(messages).values({
    channelId: dm.id, senderType: "user", senderId: f.sender.id, content: `dm ${f.tag}`,
  }).returning();
  const [selfMessage] = await db.insert(messages).values({
    channelId: selfDm.id, senderType: "user", senderId: dmUser.id, content: `note to self ${f.tag}`,
  }).returning();
  const [roomThread, dmThread] = await db.insert(channels).values([
    { serverId: f.receiverServer.id, name: `thread-${roomMessage.id.slice(0, 8)}`, type: "thread", parentMessageId: roomMessage.id },
    { serverId: f.receiverServer.id, name: `thread-${dmMessage.id.slice(0, 8)}`, type: "thread", parentMessageId: dmMessage.id },
  ]).returning();
  await db.insert(threadFollows).values([
    { threadChannelId: roomThread.id, parentMessageId: roomMessage.id, reason: "manual", followerType: "user", followerId: dmUser.id },
    { threadChannelId: dmThread.id, parentMessageId: dmMessage.id, reason: "manual", followerType: "user", followerId: dmUser.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await db.insert(messages).values([
    { channelId: roomThread.id, senderType: "user", senderId: f.sender.id, content: `room thread reply ${f.tag}` },
    { channelId: dmThread.id, senderType: "user", senderId: f.sender.id, content: `dm thread reply ${f.tag}` },
  ]);

  // Wait until the unscoped RW Activity carries the four conversations with activity from others.
  const expectedTargets = [room.id, dm.id, roomThread.id, dmThread.id];
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let unscoped = await getInboxItems(f.receiverServer.id, dmUser.id, { filter: "all", limit: 50 });
  while (!expectedTargets.every((id) => unscoped.items.some((item) => targetOf(item) === id)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    unscoped = await getInboxItems(f.receiverServer.id, dmUser.id, { filter: "all", limit: 50 });
  }
  assert.deepEqual(
    expectedTargets.filter((id) => !unscoped.items.some((item) => targetOf(item) === id)),
    [],
    "RisingWave Activity did not reflect the DM-scope fixture in time",
  );
  // The self-DM has only the user's own message; give its row the same chance to land.
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  for (const filter of ["all", "unread", "mentions"] as const) {
    const rw = await getInboxItems(f.receiverServer.id, dmUser.id, { filter, limit: 50, scope: "dms" });
    const pg = await getInboxItems(f.receiverServer.id, dmUser.id, { filter, limit: 50, scope: "dms", forceCanonicalPostgres: true });
    assert.deepEqual(rw.items.map(targetOf), pg.items.map(targetOf), `${filter}: RW and PG list the same rows`);
    assert.equal(rw.totalCount, pg.totalCount, `${filter}: totalCount`);
    assert.equal(rw.totalUnreadCount, pg.totalUnreadCount, `${filter}: totalUnreadCount`);
    assert.equal(rw.activeUnreadCount, pg.activeUnreadCount, `${filter}: activeUnreadCount`);
    assert.deepEqual(
      rw.groups.map((group) => [group.channelId, group.count]),
      pg.groups.map((group) => [group.channelId, group.count]),
      `${filter}: groups (ids and counts)`,
    );
    assert.ok(rw.items.every(isDmScopedInboxItem), `${filter}: only DM rows`);
    assert.ok(rw.groups.every((group) => group.channelType === "dm"), `${filter}: only DM groups`);
  }

  // Capture the exact serving query the reader sends, then print RisingWave's plan for it
  // (Rill's review: plan shape, i.e. receiver-prefix range scan vs full scan; cardinality aside).
  const pool = getRisingWavePool()!;
  let served: { text: string; values: unknown[] } | null = null;
  __testRisingWaveInbox.set({
    query: ((client: Parameters<typeof queryRisingWave>[0], text: string, values?: unknown[]) => {
      if (values?.[6] === "dms") served = { text, values };
      return queryRisingWave(client, text, values);
    }) as typeof queryRisingWave,
  });
  let scoped: Awaited<ReturnType<typeof getInboxItems>>;
  try {
    scoped = await getInboxItems(f.receiverServer.id, dmUser.id, { filter: "all", limit: 50, scope: "dms" });
  } finally {
    __testRisingWaveInbox.reset();
  }
  assert.ok(served, "the scoped read went through the RisingWave serving query");
  const { text, values } = served as { text: string; values: unknown[] };
  const literal = (value: unknown) => (value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);
  const explainText = text.replace(/\$(\d+)(?!\d)/g, (_match, index: string) => literal(values[Number(index) - 1]));
  const plan = await queryRisingWave<Record<string, string>>(pool, `EXPLAIN ${explainText}`);
  const planText = plan.result.rows.map((row) => Object.values(row).join(" ")).join("\n");
  console.log(`[dm-scope EXPLAIN] scoped Activity serving query (filter=all, scope=dms)\n${planText}`);
  assert.ok(planText.length > 0);

  const targets = scoped.items.map(targetOf);
  assert.ok(targets.includes(dm.id), "the DM is listed");
  assert.ok(targets.includes(dmThread.id), "the followed DM thread is listed");
  assert.ok(!targets.includes(room.id), "the channel is excluded");
  assert.ok(!targets.includes(roomThread.id), "the channel thread is excluded");
  assert.deepEqual(targets, unscoped.items.filter(isDmScopedInboxItem).map(targetOf), "scope is a pure restriction");
  // Reported, not patched: whether a self-DM appears follows unscoped Activity on both paths.
  assert.equal(
    targets.includes(selfDm.id),
    (await getInboxItems(f.receiverServer.id, dmUser.id, { filter: "all", limit: 50, forceCanonicalPostgres: true }))
      .items.some((item) => targetOf(item) === selfDm.id),
    `self-DM (${selfMessage.id}) presence matches canonical Postgres`,
  );
});

test.skipIf(!configured)("Activity Pinned scope: RisingWave serves the same pinned conversations, threads and tasks as canonical Postgres", async () => {
  // A fresh user, so the fixture receiver's counts elsewhere in this file are untouched.
  const db = getDb();
  const [pinUser] = await db.insert(users).values({
    name: `rwreal-pinuser-${f.tag}`, email: `rwreal-pinuser-${f.tag}@test.invalid`, passwordHash: "x", emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: f.receiverServer.id, userId: pinUser.id, role: "member" });
  const [pinnedRoom, pinnedDm, controlRoom] = await db.insert(channels).values([
    { serverId: f.receiverServer.id, name: `rwreal-pin-room-${f.tag}`, type: "channel" },
    { serverId: f.receiverServer.id, name: `rwreal-pin-dm-${f.tag}`, type: "dm" },
    { serverId: f.receiverServer.id, name: `rwreal-pin-control-${f.tag}`, type: "channel" },
  ]).returning();
  await db.insert(channelHumans).values([pinnedRoom, pinnedDm, controlRoom].flatMap((channel) => [
    { channelId: channel.id, userId: pinUser.id },
    { channelId: channel.id, userId: f.sender.id },
  ]));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const parents = await db.insert(messages).values([pinnedRoom, pinnedDm, controlRoom].flatMap((channel) => [
    { channelId: channel.id, senderType: "user" as const, senderId: f.sender.id, content: `pin thread parent ${channel.name}` },
    { channelId: channel.id, senderType: "user" as const, senderId: f.sender.id, content: `pin task parent ${channel.name}`, taskNumber: 1, taskStatus: "todo" as const },
  ])).returning();
  const threads = await db.insert(channels).values(parents.map((parent) => ({
    serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" as const, parentMessageId: parent.id,
  }))).returning();
  await db.insert(threadFollows).values(threads.map((thread) => ({
    threadChannelId: thread.id, parentMessageId: thread.parentMessageId!, reason: "manual" as const, followerType: "user" as const, followerId: pinUser.id,
  })));
  // Every second parent hosts a task (task #1 of its channel, stamped on the
  // message as createTasks does): the task's thread row is scoped by its parent channel too.
  await db.insert(tasks).values([1, 3, 5].map((index, n) => ({
    channelId: parents[index]!.channelId, taskNumber: 1, title: `pin task ${f.tag} ${n}`, status: "todo" as const,
    createdByType: "user" as const, createdById: f.sender.id, messageId: parents[index]!.id,
  })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await db.insert(messages).values(threads.map((thread) => ({
    channelId: thread.id, senderType: "user" as const, senderId: f.sender.id, content: `pin reply ${thread.name} ${f.tag}`,
  })));

  const pinnedChannelIds = [pinnedRoom.id, pinnedDm.id];
  const pinnedThreadIds = threads.slice(0, 4).map((thread) => thread.id);
  const controlTargets = [controlRoom.id, ...threads.slice(4).map((thread) => thread.id)];
  const expectedTargets = [...pinnedChannelIds, ...pinnedThreadIds, ...controlTargets];
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let unscoped = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50 });
  while (!expectedTargets.every((id) => unscoped.items.some((item) => targetOf(item) === id)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    unscoped = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50 });
  }
  assert.deepEqual(
    expectedTargets.filter((id) => !unscoped.items.some((item) => targetOf(item) === id)),
    [],
    "RisingWave Activity did not reflect the Pinned-scope fixture in time",
  );
  // Let the task rows land on the thread rows as well.
  const taskDeadline = Date.now() + timeoutMs;
  while (unscoped.items.filter((item) => item.kind === "thread" && item.taskNumber != null).length < 3 && Date.now() < taskDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    unscoped = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50 });
  }

  const pinnedSet = new Set(pinnedChannelIds);
  for (const filter of ["all", "unread", "mentions"] as const) {
    const rw = await getInboxItems(f.receiverServer.id, pinUser.id, { filter, limit: 50, pinnedChannelIds });
    const pg = await getInboxItems(f.receiverServer.id, pinUser.id, { filter, limit: 50, pinnedChannelIds, forceCanonicalPostgres: true });
    assert.deepEqual(rw.items.map(targetOf), pg.items.map(targetOf), `${filter}: RW and PG list the same rows`);
    assert.equal(rw.totalCount, pg.totalCount, `${filter}: totalCount`);
    assert.equal(rw.totalUnreadCount, pg.totalUnreadCount, `${filter}: totalUnreadCount`);
    assert.equal(rw.activeUnreadCount, pg.activeUnreadCount, `${filter}: activeUnreadCount`);
    assert.equal(rw.hasMore, pg.hasMore, `${filter}: hasMore`);
    assert.deepEqual(
      rw.groups.map((group) => [group.channelId, group.count]),
      pg.groups.map((group) => [group.channelId, group.count]),
      `${filter}: groups (ids and counts)`,
    );
    assert.ok(rw.items.every((item) => isPinnedScopedInboxItem(item, pinnedSet)), `${filter}: only pinned rows`);
    assert.ok(rw.groups.every((group) => pinnedSet.has(group.channelId)), `${filter}: only pinned groups`);
  }

  const scoped = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50, pinnedChannelIds });
  const targets = scoped.items.map(targetOf);
  assert.deepEqual([...targets].sort(), [...pinnedChannelIds, ...pinnedThreadIds].sort(), "pinned channels, DM, threads and tasks; no control rows");
  assert.equal(scoped.items.filter((item) => item.kind === "thread" && item.taskNumber != null).length, 2, "both pinned task rows carry their task");
  assert.deepEqual(targets, unscoped.items.filter((item) => isPinnedScopedInboxItem(item, pinnedSet)).map(targetOf), "scope is a pure restriction");

  // Paging (limit 1 offset 1) agrees, and the scoped totals hold on every page.
  const rwSecond = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 1, offset: 1, pinnedChannelIds });
  const pgSecond = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 1, offset: 1, pinnedChannelIds, forceCanonicalPostgres: true });
  assert.deepEqual(rwSecond.items.map(targetOf), pgSecond.items.map(targetOf));
  assert.deepEqual(rwSecond.items.map(targetOf), targets.slice(1, 2));
  assert.equal(rwSecond.hasMore, true);
  assert.equal(rwSecond.totalCount, scoped.totalCount);

  // Unified All (merges unfollowed threads) keeps the scope; the channel facet narrows within it.
  const unified = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50, pinnedChannelIds, includeUnfollowedThreads: true });
  assert.deepEqual(unified.items.map(targetOf), targets);
  const faceted = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50, pinnedChannelIds, channelId: pinnedDm.id });
  const facetedPg = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50, pinnedChannelIds, channelId: pinnedDm.id, forceCanonicalPostgres: true });
  assert.deepEqual(faceted.items.map(targetOf), facetedPg.items.map(targetOf));
  assert.deepEqual([...faceted.items.map(targetOf)].sort(), [pinnedDm.id, ...threads.slice(2, 4).map((thread) => thread.id)].sort());

  // An empty pin set is empty on both paths.
  const rwEmpty = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50, pinnedChannelIds: [] });
  const pgEmpty = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: 50, pinnedChannelIds: [], forceCanonicalPostgres: true });
  for (const empty of [rwEmpty, pgEmpty]) {
    assert.deepEqual(empty.items, []);
    assert.deepEqual(empty.groups, []);
    assert.equal(empty.totalCount, 0);
    assert.equal(empty.activeUnreadCount, 0);
  }

  // `ids` (rows by their own id) agrees on both paths; a channel id does not pull in its threads.
  const rowIds = [pinnedRoom.id, threads[0]!.id, controlRoom.id];
  const rwIds = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: rowIds.length, rowIds });
  const pgIds = await getInboxItems(f.receiverServer.id, pinUser.id, { filter: "all", limit: rowIds.length, rowIds, forceCanonicalPostgres: true });
  assert.deepEqual(rwIds.items.map(targetOf), pgIds.items.map(targetOf));
  assert.deepEqual([...rwIds.items.map(targetOf)].sort(), [...rowIds].sort());
  assert.equal(rwIds.totalCount, pgIds.totalCount);
  assert.equal(rwIds.totalCount, rowIds.length);
  assert.deepEqual(rwIds.groups.map((group) => [group.channelId, group.count]), pgIds.groups.map((group) => [group.channelId, group.count]));
});

test.skipIf(!configured)("threads below a deleted DM leave Activity and the sidebar, as in canonical Postgres (task #333)", async () => {
  // Deleting an agent soft-deletes its DM and leaves the DM's threads live. Two such
  // threads: one the user follows, one where only an unread mention reaches the user.
  const db = getDb();
  const [user] = await db.insert(users).values({
    name: `rwreal-deldm-${f.tag}`, email: `rwreal-deldm-${f.tag}@test.invalid`, passwordHash: "x", emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: f.receiverServer.id, userId: user.id, role: "member" });
  const [dm] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-deldm-dm-${f.tag}`, type: "dm",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: dm.id, userId: user.id },
    { channelId: dm.id, userId: f.sender.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [followedParent, mentionParent] = await db.insert(messages).values([
    { channelId: dm.id, senderType: "user", senderId: f.sender.id, content: `deldm followed ${f.tag}` },
    { channelId: dm.id, senderType: "user", senderId: f.sender.id, content: `deldm mention ${f.tag}` },
  ]).returning();
  const [followedThread, mentionThread] = await db.insert(channels).values([
    { serverId: f.receiverServer.id, name: `thread-${followedParent.id.slice(0, 8)}`, type: "thread", parentMessageId: followedParent.id },
    { serverId: f.receiverServer.id, name: `thread-${mentionParent.id.slice(0, 8)}`, type: "thread", parentMessageId: mentionParent.id },
  ]).returning();
  await db.insert(threadFollows).values({
    threadChannelId: followedThread.id, parentMessageId: followedParent.id, reason: "manual", followerType: "user", followerId: user.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await db.insert(messages).values({
    channelId: followedThread.id, senderType: "user", senderId: f.sender.id, content: `deldm followed reply ${f.tag}`,
  });
  const [mentionReply] = await db.insert(messages).values({
    channelId: mentionThread.id, senderType: "user", senderId: f.sender.id, content: `deldm @user ${f.tag}`,
  }).returning();
  await db.insert(messageMentions).values({
    messageId: mentionReply.id, messageSeq: mentionReply.seq, serverId: f.receiverServer.id,
    channelId: mentionThread.id, handleAtSendTime: "you", targetType: "user", targetId: user.id,
  });

  // A joint thread with a live parent: rw_thread_parent_v3 maps it to the user's local
  // projection of the joint channel. The parent filter must keep it (Rill's review).
  // Its own joint channel, so the fixture's joint conversation (and the agent's counts
  // on it) stays untouched.
  const [ownCanonical, ownSenderLocal, ownLocal] = await db.insert(channels).values([
    { serverId: f.storage.id, name: `rwreal-deldm-canonical-${f.tag}`, type: "joint" },
    { serverId: f.senderServer.id, name: `rwreal-deldm-sender-local-${f.tag}`, type: "joint" },
    { serverId: f.receiverServer.id, name: `rwreal-deldm-local-${f.tag}`, type: "joint" },
  ]).returning();
  const [ownJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: ownCanonical.id, createdByServerId: f.senderServer.id, createdByUserId: f.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: ownJoint.id, serverId: f.senderServer.id, localChannelId: ownSenderLocal.id, role: "host", status: "active", joinedByUserId: f.owner.id },
    { jointChannelId: ownJoint.id, serverId: f.receiverServer.id, localChannelId: ownLocal.id, role: "participant", status: "active", joinedByUserId: f.owner.id },
  ]);
  await db.insert(channelHumans).values([
    { channelId: ownLocal.id, userId: user.id },
    { channelId: ownSenderLocal.id, userId: f.sender.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [jointParent] = await db.insert(messages).values({
    channelId: ownCanonical.id, senderType: "user", senderId: f.sender.id, content: `deldm joint parent ${f.tag}`,
  }).returning();
  const [canonicalThread] = await db.insert(channels).values({
    serverId: f.storage.id, name: `thread-${jointParent.id.slice(0, 8)}`, type: "thread", parentMessageId: jointParent.id,
  }).returning();
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, jointParent.id));
  const [localThread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${jointParent.id.slice(0, 8)}`, type: "thread",
  }).returning();
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id, createdByServerId: f.senderServer.id, createdByUserId: f.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: threadJoint.id, serverId: f.receiverServer.id, localChannelId: localThread.id,
    role: "participant", status: "active", joinedByUserId: f.owner.id,
  });
  await db.insert(threadFollows).values({
    threadChannelId: localThread.id, parentMessageId: jointParent.id, reason: "manual", followerType: "user", followerId: user.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await db.insert(messages).values({
    channelId: canonicalThread.id, senderType: "user", senderId: f.sender.id, content: `deldm joint reply ${f.tag}`,
  });

  const threads = [followedThread.id, mentionThread.id];
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const waitFor = async (want: (targets: string[]) => boolean, what: string) => {
    const deadline = Date.now() + timeoutMs;
    let targets: string[] = [];
    do {
      targets = (await getInboxItems(f.receiverServer.id, user.id, { filter: "all", limit: 50 })).items.map(targetOf);
      if (want(targets)) return targets;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.fail(`${what}; RisingWave Activity lists ${JSON.stringify(targets)}`);
  };
  // Precondition: while the DM is live, both DM threads and the joint thread are in Activity.
  await waitFor(
    (targets) => [...threads, localThread.id].every((id) => targets.includes(id)),
    "the DM threads and the joint thread did not reach Activity",
  );

  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, dm.id));
  // The server-side parent check hides the threads as soon as Postgres has the
  // deletion, so also wait for the DM's own row: that is when RisingWave has it.
  const after = await waitFor(
    (targets) => [...threads, dm.id].every((id) => !targets.includes(id)),
    "the deleted DM or a thread below it is still served",
  );
  const pg = (await getInboxItems(f.receiverServer.id, user.id, { filter: "all", limit: 50, forceCanonicalPostgres: true }))
    .items.map(targetOf);
  assert.deepEqual(after, pg, "RW and canonical Postgres list the same rows");
  assert.ok(after.includes(localThread.id), "a joint thread with a live parent stays in Activity");
  for (const filter of ["unread", "mentions"] as const) {
    const rw = (await getInboxItems(f.receiverServer.id, user.id, { filter, limit: 50 })).items.map(targetOf);
    assert.ok(threads.every((id) => !rw.includes(id)), `${filter}: no thread below the deleted DM`);
  }
  const sidebar = await queryRisingWave<{ target_id: string }>(
    getRisingWavePool()!,
    `SELECT target_id FROM ${CONVERSATION_UNREAD_VIEW} WHERE receiver_type = 'user' AND receiver_id = $1 AND target_id = ANY($2)`,
    [user.id, threads],
  );
  assert.deepEqual(sidebar.result.rows, [], "the sidebar has no slot for a thread below the deleted DM");
  // The view itself drops them too (077), not only the server-side parent check.
  const served = await queryRisingWave<{ thread_channel_id: string }>(
    getRisingWavePool()!,
    `SELECT thread_channel_id FROM ${UNIFIED_CHAIN_VIEWS.serving} WHERE receiver_type = 'user' AND receiver_id = $1 AND thread_channel_id = ANY($2)`,
    [user.id, threads],
  );
  assert.deepEqual(served.result.rows, [], "the serving view has no row for a thread below the deleted DM");
});

test.skipIf(!configured)("active followed threads are served by rw_followed_threads_v5 and equal the legacy path", async () => {
  const traced: Array<{ name: string; attrs: Record<string, unknown> | undefined }> = [];
  const traceQuery: DbQueryTracer = async (name, work, onComplete) => {
    const result = await work();
    traced.push({ name, attrs: onComplete?.(result) as Record<string, unknown> | undefined });
    return result;
  };
  const threads = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { traceQuery });
  const row = threads.find((thread) => thread.threadChannelId === f.thread.id);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.replyCount, 1);
  assert.equal(row.unreadCount, 1);
  assert.equal(row.parentMessageId, f.generalMessage.id);
  assert.equal(row.parentChannelId, f.general.id);
  const rwRead = traced.find((entry) => entry.name === "channels.followed_threads_rw_rows");
  assert.equal(rwRead?.attrs?.backend, "risingwave", `rows did not come from RisingWave: ${JSON.stringify(rwRead?.attrs)}`);
  assert.equal(
    traced.some((entry) => entry.name === "channels.followed_threads_by_user"),
    false,
    "every followed thread was in the view: no legacy list query",
  );
  const byId = (list: typeof threads) => [...list].sort((a, b) => a.threadChannelId.localeCompare(b.threadChannelId));
  const legacy = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { forceLegacyPath: true });
  assert.deepEqual(byId(threads), byId(legacy));
});

test.skipIf(!configured)("rw_followed_threads_v5 carries the parent's task (rw_tasks) and long-content previews", async () => {
  const db = getDb();
  const [parentChannel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-v4-task-${f.tag}`, type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: f.sender.id },
    { channelId: parentChannel.id, userId: f.receiver.id },
  ]);
  const longParent = `${"p".repeat(98)}😀😀${"q".repeat(60)} ${f.tag}`;
  const [parent] = await db.insert(messages).values({
    channelId: parentChannel.id, senderType: "user", senderId: f.sender.id, content: longParent,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: f.receiver.id,
  });
  const [task] = await db.insert(tasks).values({
    channelId: parentChannel.id, taskNumber: 1, title: `v4 task ${f.tag}`, status: "in_progress",
    createdByType: "user", createdById: f.sender.id, claimedByType: "user", claimedById: f.sender.id, messageId: parent.id,
  }).returning();
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: f.sender.id, content: `${"r".repeat(138)}😀😀😀${"s".repeat(60)} ${f.tag}`,
  });

  const pool = getRisingWavePool()!;
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let propagated = false;
  do {
    const read = await queryRisingWave<{ n: string }>(
      pool,
      `SELECT count(*) AS n FROM rw_followed_threads_v5
        WHERE server_id = $1 AND user_id = $2 AND thread_channel_id = $3 AND task_id = $4 AND reply_count = 1`,
      [f.receiverServer.id, f.receiver.id, thread.id, task.id],
    );
    propagated = Number(read.result.rows[0]?.n) === 1;
    if (propagated) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(propagated, "the thread, its reply and its task reached rw_followed_threads_v5");

  const rw = await getFollowedThreads(f.receiverServer.id, f.receiver.id);
  const legacy = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { forceLegacyPath: true });
  const rwRow = rw.find((t) => t.threadChannelId === thread.id);
  assert.ok(rwRow);
  assert.deepEqual(rwRow, legacy.find((t) => t.threadChannelId === thread.id), "byte-identical to the legacy row");
  assert.equal(rwRow.taskId, task.id);
  assert.equal(rwRow.taskClaimedById, f.sender.id);
  assert.equal(rwRow.parentMessagePreview, `${longParent.slice(0, 100)}…`);
}, 180_000);

test.skipIf(!configured)("followed-thread stats are served by rw_followed_threads_v5 (legacy path)", async () => {
  const traced: Array<{ name: string; attrs: Record<string, unknown> | undefined }> = [];
  const traceQuery: DbQueryTracer = async (name, work, onComplete) => {
    const result = await work();
    traced.push({ name, attrs: onComplete?.(result) as Record<string, unknown> | undefined });
    return result;
  };
  const threads = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { traceQuery, forceLegacyPath: true });
  const row = threads.find((thread) => thread.threadChannelId === f.thread.id);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.replyCount, 1);
  const stats = traced.find((entry) => entry.name === "channels.followed_threads_stats_by_threads");
  assert.equal(stats?.attrs?.backend, "risingwave", `stats read did not come from RisingWave: ${JSON.stringify(stats?.attrs)}`);
});

test.skipIf(!configured)("unfollowed and done threads list without error, with stats from rw_followed_threads_v5", async () => {
  const db = getDb();
  // A channel of its own (no agent member): parents posted in the shared
  // fixture's general would change the agent inbox counts asserted below.
  const [parentChannel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-follow-states-${f.tag}`, type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: f.sender.id },
    { channelId: parentChannel.id, userId: f.receiver.id },
  ]);
  const seeded: Record<"unfollowed" | "done", string> = { unfollowed: "", done: "" };
  for (const kind of ["unfollowed", "done"] as const) {
    const [parent] = await db.insert(messages).values({
      channelId: parentChannel.id, senderType: "user", senderId: f.sender.id, content: `${kind} parent ${f.tag}`,
    }).returning();
    const [thread] = await db.insert(channels).values({
      serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
    }).returning();
    await db.insert(messages).values({
      channelId: thread.id, senderType: "user", senderId: f.sender.id, content: `${kind} reply ${f.tag}`,
    });
    await db.insert(threadFollows).values({
      threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: f.receiver.id,
      ...(kind === "unfollowed" ? { unfollowedAt: new Date() } : { doneAt: new Date() }),
    });
    seeded[kind] = thread.id;
  }

  const unfollowed = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "unfollowed_active" });
  assert.ok(unfollowed.some((t) => t.threadChannelId === seeded.unfollowed), "the unfollowed thread is listed");
  const done = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "done" });
  assert.ok(done.some((t) => t.threadChannelId === seeded.done), "the done thread is listed");
  // Activity "All" reads the unfollowed-active list; it must not 500.
  await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50 });

  // Once CDC catches up, RW serves real stats for the done and unfollowed
  // follows too (v1 held only active follows, so these stayed stat-less).
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let replyCounts: Record<"unfollowed" | "done", number | undefined> = { unfollowed: undefined, done: undefined };
  do {
    const [u, d] = await Promise.all([
      getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "unfollowed_active" }),
      getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "done" }),
    ]);
    replyCounts = {
      unfollowed: u.find((t) => t.threadChannelId === seeded.unfollowed)?.replyCount,
      done: d.find((t) => t.threadChannelId === seeded.done)?.replyCount,
    };
    if (replyCounts.unfollowed === 1 && replyCounts.done === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.deepEqual(replyCounts, { unfollowed: 1, done: 1 }, "RW serves stats for done and unfollowed follows");
}, 180_000);

test.skipIf(!configured)("rw_followed_threads_v5 counts unread with the chain rule: self-caused system and noise subtypes excluded, a peer's message counted", async () => {
  const db = getDb();
  // A channel of its own (no agent member), so the agent inbox counts below hold.
  const [parentChannel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-chain-rule-${f.tag}`, type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: f.sender.id },
    { channelId: parentChannel.id, userId: f.receiver.id },
  ]);
  const [parent] = await db.insert(messages).values({
    channelId: parentChannel.id, senderType: "user", senderId: f.sender.id, content: `chain-rule parent ${f.tag}`,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: f.receiver.id,
  });
  // Oldest first, so first_unread_message_id also proves the exclusions.
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: "system", content: `receiver did this ${f.tag}`,
    messageType: "system", causalActorType: "user", causalActorId: f.receiver.id,
  });
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: "system", content: `task deleted ${f.tag}`,
    messageType: "system", systemSubtype: "task.deleted_summary",
  });
  const [peerReply] = await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: f.sender.id, content: `peer reply ${f.tag}`,
  }).returning();

  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let row: Awaited<ReturnType<typeof getFollowedThreads>>[number] | undefined;
  do {
    const threads = await getFollowedThreads(f.receiverServer.id, f.receiver.id);
    row = threads.find((t) => t.threadChannelId === thread.id);
    if (row?.replyCount === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.replyCount, 3, "reply count is every message in the thread, unfiltered");
  assert.equal(row.unreadCount, 1, "only the peer's message is unread");
  assert.equal(row.firstUnreadMessageId, peerReply.id);
}, 180_000);

test.skipIf(!configured)("agent inbox readers: chain rows, paged list, unread counts", async () => {
  const selection = await selectAgentInboxChainRows(f.agent.id);
  assert.equal(selection.source, "chain", `agent chain read failed: ${JSON.stringify(selection)}`);
  const rows = selection.source === "chain" ? selection.rows : [];
  const general = rows.find((row) => row.targetId === f.general.id);
  assert.ok(general, "the agent is offered its channel");
  assert.equal(general.unreadCount, 1);
  assert.equal(general.mentionUnread, 1);
  const joint = rows.find((row) => row.targetId === f.receiverLocal.id);
  assert.ok(joint, "the joint mention surfaces on the agent's own projection");
  assert.equal(joint.storageChannelId, f.canonical.id);
  assert.equal(joint.mentionUnread, 1);
  assert.equal(joint.maxMentionSeq, Number(f.jointMessage.seq));

  // /events?wait_for= re-check: the same rows by target id (ANY($2) prepares on RW).
  const seqs = await readAgentInboxChainTargetSeqs(f.agent.id, [f.general.id, f.receiverLocal.id]);
  assert.deepEqual(
    seqs?.map((row) => [row.targetId, row.latestSeq, row.maxMentionSeq, row.lastReadSeq]).sort(),
    [general, joint].map((row) => [row.targetId, row.latestSeq, row.maxMentionSeq, row.lastReadSeq]).sort(),
  );

  const counts = await getAgentUnreadCounts(f.agent.id, rows);
  assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), 2);

  const page = await listAgentInbox(f.agent.id, f.receiverServer.id, { view: "unread", limit: 1 });
  assert.equal(page.items.length, 1, "LIMIT is inlined as a constant RisingWave accepts");
  assert.equal(page.hasMore, true);
  assert.equal(page.totals.conversations, 2);
  assert.equal(page.totals.mentions, 2);
  const next = await listAgentInbox(f.agent.id, f.receiverServer.id, {
    view: "mentions",
    limit: 5,
    beforeSeq: page.nextBeforeSeq ?? undefined,
  });
  assert.equal(next.items.length, 1, "keyset paging by activity_seq");
});

test.skipIf(!configured)("a task conversation is a sub-conversation: Activity, sidebar, totals and agent inbox list it with its task (078)", async () => {
  // Its own channel, people and agent, so the fixture's counts stay untouched.
  const db = getDb();
  const pool = getRisingWavePool()!;
  const [follower, member] = await db.insert(users).values(["follower", "member"].map((role) => ({
    name: `rwreal-taskconv-${role}-${f.tag}`, email: `rwreal-taskconv-${role}-${f.tag}@test.invalid`, passwordHash: "x", emailVerified: true,
  }))).returning();
  await db.insert(serverMembers).values([
    { serverId: f.receiverServer.id, userId: follower.id, role: "member" },
    { serverId: f.receiverServer.id, userId: member.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-taskconv-${f.tag}`, type: "channel",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: f.receiverServer.id, name: `rwreal-taskconv-agent-${f.tag}`, status: "active",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: follower.id },
    { channelId: channel.id, userId: member.id },
    { channelId: channel.id, userId: f.sender.id },
  ]);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [task] = await db.insert(tasks).values({
    channelId: channel.id, taskNumber: 7, title: `rw task conversation ${f.tag}`,
    createdByType: "user", createdById: f.sender.id,
  }).returning();
  // The task's conversation: type 'task', no parent message, parent = the task's channel.
  const [conversation] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `task-${task.id}`, type: "task", taskId: task.id, parentChannelId: channel.id,
  }).returning();
  await db.update(tasks).set({ conversationChannelId: conversation.id }).where(eq(tasks.id, task.id));
  await db.insert(threadFollows).values([
    { threadChannelId: conversation.id, parentMessageId: null, parentTaskId: task.id, reason: "assigned", followerType: "user", followerId: follower.id },
    { threadChannelId: conversation.id, parentMessageId: null, parentTaskId: task.id, reason: "assigned", followerType: "agent", followerId: agent.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A lifecycle line (a system message): neither a reply nor "new" (the reply
  // basis); the agent inbox still offers it (transport rule).
  await db.insert(messages).values({
    channelId: conversation.id, senderType: "user", senderId: f.sender.id, content: `📌 assigned #7 ${f.tag}`,
    messageType: "system", systemSubtype: "task.assignment_receipt", causalActorType: "user", causalActorId: f.sender.id,
  });
  const [reply] = await db.insert(messages).values({
    channelId: conversation.id, senderType: "user", senderId: f.sender.id, content: `task conversation reply ${f.tag}`,
  }).returning();
  // A mention of a channel member who does not follow the conversation: a
  // mention-only row through the parent channel (rw_inbox_mention_v7).
  const [mentioning] = await db.insert(messages).values({
    channelId: conversation.id, senderType: "user", senderId: f.sender.id, content: `@member look ${f.tag}`,
  }).returning();
  await db.insert(messageMentions).values({
    messageId: mentioning.id, messageSeq: mentioning.seq, serverId: f.receiverServer.id, channelId: conversation.id,
    handleAtSendTime: "member", targetType: "user", targetId: member.id, notifiableAtSend: true,
  });

  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const waitForRw = async (sqlText: string, values: unknown[], what: string) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const read = await queryRisingWave<{ n: string }>(pool, sqlText, values);
      if (Number(read.result.rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    assert.fail(`${what} did not reach RisingWave`);
  };
  await waitForRw(
    `SELECT count(*) AS n FROM ${UNIFIED_CHAIN_VIEWS.serving} WHERE receiver_type = 'user' AND receiver_id = $1 AND thread_channel_id = $2 AND unread_count = 2`,
    [follower.id, conversation.id],
    "the follower's task conversation row",
  );
  await waitForRw(
    `SELECT count(*) AS n FROM ${UNIFIED_CHAIN_VIEWS.serving} WHERE receiver_type = 'user' AND receiver_id = $1 AND thread_channel_id = $2`,
    [member.id, conversation.id],
    "the mentioned member's task conversation row",
  );

  // Activity (RisingWave): a kind 'task' row with its task, parent = the task's channel.
  const activity = await getInboxItems(f.receiverServer.id, follower.id, { filter: "all", limit: 50 });
  const item = activity.items.find((candidate) => candidate.kind === "task" && candidate.threadChannelId === conversation.id);
  assert.ok(item && item.kind === "task", "the followed task conversation is in Activity");
  assert.equal(item.parentChannelId, channel.id);
  assert.equal(item.parentMessageId, null);
  assert.equal(item.taskId, task.id);
  assert.equal(item.taskNumber, 7);
  assert.equal(item.taskTitle, task.title);
  assert.equal(item.unreadCount, 2, "the lifecycle line is not new: unread is on the reply basis");
  assert.equal(item.replyCount, 2, "replies are the chat messages, not the lifecycle line");
  assert.equal(item.latestActivityMessageId, mentioning.id);
  // The canonical Postgres read (search / guest / authority paths) lists it the same way.
  const canonical = await getInboxItems(f.receiverServer.id, follower.id, { filter: "all", limit: 50, forceCanonicalPostgres: true });
  const canonicalItem = canonical.items.find((candidate) => candidate.kind === "task" && candidate.threadChannelId === conversation.id);
  assert.ok(canonicalItem && canonicalItem.kind === "task", "the canonical Postgres read lists the task conversation");
  assert.equal(canonicalItem.taskTitle, task.title);
  assert.equal(canonicalItem.unreadCount, item.unreadCount);
  assert.equal(canonicalItem.replyCount, 2, "the canonical read counts chat replies only too");
  assert.equal(canonicalItem.latestActivityMessageId, item.latestActivityMessageId);

  // A parent-channel member mentioned inside it, not following: a mention row.
  const mentions = await getInboxItems(f.receiverServer.id, member.id, { filter: "mentions", limit: 50 });
  const mentionRow = mentions.items.find((candidate) => candidate.kind === "task" && candidate.threadChannelId === conversation.id);
  assert.ok(mentionRow && mentionRow.hasMention, "a mention in a task conversation reaches a parent member");

  // Sidebar: the followed conversation counts; the per-server badge (channels/DMs) does not.
  const counts = await getUnreadCounts(f.receiverServer.id, follower.id);
  assert.equal(counts[conversation.id], 2, "the followed task conversation counts its unread replies in the sidebar");
  const sidebarRow = await queryRisingWave<{ kind: string }>(
    pool,
    `SELECT kind FROM ${CONVERSATION_UNREAD_VIEW} WHERE receiver_type = 'user' AND receiver_id = $1 AND target_id = $2`,
    [follower.id, conversation.id],
  );
  assert.equal(sidebarRow.result.rows[0]?.kind, "task");
  const perServer = await getSidebarUnreadSummaryCounts([f.receiverServer.id], follower.id);
  assert.equal(perServer[f.receiverServer.id] ?? 0, 0, "task conversations are not in the channel/DM badge");
  const totals = await getActivityUnreadTotalsBatch([{ serverId: f.receiverServer.id }], follower.id);
  assert.equal(totals.get(f.receiverServer.id)?.totalUnreadCount, 2, "Activity totals count the task conversation's unread replies");

  // Agent inbox: a kind 'task' row addressed by the task ref.
  await waitForRw(
    `SELECT count(*) AS n FROM ${UNIFIED_CHAIN_VIEWS.agentInbox} WHERE agent_id = $1 AND target_id = $2`,
    [agent.id, conversation.id],
    "the agent's task conversation row",
  );
  const selection = await selectAgentInboxChainRows(agent.id);
  assert.equal(selection.source, "chain");
  const agentRow = selection.source === "chain" ? selection.rows.find((row) => row.targetId === conversation.id) : undefined;
  assert.ok(agentRow, "the agent is offered the task conversation");
  assert.equal(agentRow.kind, "task");
  assert.equal(agentRow.taskNumber, 7);
  assert.equal(agentRow.parentChannelId, channel.id);
  assert.equal(agentRow.unreadCount, 3);
  const agentCounts = await getAgentUnreadCounts(agent.id, selection.source === "chain" ? selection.rows : []);
  assert.equal(agentCounts[`#${channel.name}:#7`], 3, "the agent-facing target is the task ref");
  const page = await listAgentInbox(agent.id, f.receiverServer.id, { view: "unread", limit: 10 });
  const listed = page.items.find((row) => row.target === `#${channel.name}:#7`);
  assert.ok(listed, "raft inbox check lists the task conversation");
  assert.equal(listed.kind, "thread", "the contract kind stays thread for older CLIs");
  assert.equal(listed.conversationKind, "task");
  assert.equal(listed.title, task.title);
  assert.equal(reply.channelId, conversation.id);
});

test.skipIf(!configured)("first-mention anchors and display times on RisingWave equal canonical Postgres (078)", async () => {
  // A fresh user and channels, so the fixture's counts elsewhere stay untouched.
  const db = getDb();
  const [user] = await db.insert(users).values({
    name: `rwreal-anchor-${f.tag}`, email: `rwreal-anchor-${f.tag}@test.invalid`, passwordHash: "x", emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: f.receiverServer.id, userId: user.id, role: "member" });
  const [room, notifiedLater, deleted, outside, timeRoom, ownCanonical, ownSenderLocal, ownLocal] = await db.insert(channels).values([
    { serverId: f.receiverServer.id, name: `rwreal-anchor-room-${f.tag}`, type: "channel" },
    { serverId: f.receiverServer.id, name: `rwreal-anchor-later-${f.tag}`, type: "channel" },
    { serverId: f.receiverServer.id, name: `rwreal-anchor-deleted-${f.tag}`, type: "channel" },
    // Public, and the user is not a member: a mention-only (outsider) row.
    { serverId: f.receiverServer.id, name: `rwreal-anchor-outside-${f.tag}`, type: "channel" },
    { serverId: f.receiverServer.id, name: `rwreal-anchor-time-${f.tag}`, type: "channel" },
    { serverId: f.storage.id, name: `rwreal-anchor-canonical-${f.tag}`, type: "joint" },
    { serverId: f.senderServer.id, name: `rwreal-anchor-sender-local-${f.tag}`, type: "joint" },
    { serverId: f.receiverServer.id, name: `rwreal-anchor-local-${f.tag}`, type: "joint" },
  ]).returning();
  const [ownJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: ownCanonical.id, createdByServerId: f.senderServer.id, createdByUserId: f.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: ownJoint.id, serverId: f.senderServer.id, localChannelId: ownSenderLocal.id, role: "host", status: "active", joinedByUserId: f.owner.id },
    { jointChannelId: ownJoint.id, serverId: f.receiverServer.id, localChannelId: ownLocal.id, role: "participant", status: "active", joinedByUserId: f.owner.id },
  ]);
  await db.insert(channelHumans).values([
    ...[room, notifiedLater, deleted, timeRoom, ownLocal].map((channel) => ({ channelId: channel.id, userId: user.id })),
    ...[room, notifiedLater, deleted, outside, timeRoom, ownSenderLocal].map((channel) => ({ channelId: channel.id, userId: f.sender.id })),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const post = async (channelId: string, content: string, extra: Partial<typeof messages.$inferInsert> = {}) => {
    const [message] = await db.insert(messages).values({
      channelId, senderType: "user", senderId: f.sender.id, content: `${content} ${f.tag}`, ...extra,
    }).returning();
    return message;
  };
  const mention = async (
    message: { id: string; seq: number },
    channelId: string,
    flags: { notifiableAtSend?: boolean; notifiedAt?: Date | null; serverId?: string } = {},
  ) => {
    await db.insert(messageMentions).values({
      messageId: message.id, messageSeq: message.seq, serverId: flags.serverId ?? f.receiverServer.id, channelId,
      handleAtSendTime: "you", targetType: "user", targetId: user.id,
      notifiableAtSend: flags.notifiableAtSend ?? true, notifiedAt: flags.notifiedAt ?? null,
    });
  };

  // (6) + (1) A member row: a mention below the read cursor, then a mention that
  // does not notify (neither notifiable at send nor notified), then one that does.
  const roomBelow = await post(room.id, "@user below the cursor");
  await mention(roomBelow, room.id);
  await db.insert(userChannelReadCursors).values({ userId: user.id, channelId: room.id, lastReadSeq: roomBelow.seq });
  const roomSilent = await post(room.id, "@user silent");
  await mention(roomSilent, room.id, { notifiableAtSend: false });
  const roomAbove = await post(room.id, "@user above the cursor");
  await mention(roomAbove, room.id);

  // (2) Only a silent mention: no @ until it is notified later.
  const later = await post(notifiedLater.id, "@user notified later");
  await mention(later, notifiedLater.id, { notifiableAtSend: false });

  // (7) Two mentions; the first one's mention row goes away (CDC delete).
  const deletedFirst = await post(deleted.id, "@user first");
  await mention(deletedFirst, deleted.id);
  const deletedSecond = await post(deleted.id, "@user second");
  await mention(deletedSecond, deleted.id);

  // (3) A followed thread and a followed task conversation, each with a mention.
  const threadParent = await post(room.id, "thread parent");
  const [thread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${threadParent.id.slice(0, 8)}`, type: "thread", parentMessageId: threadParent.id,
  }).returning();
  const [task] = await db.insert(tasks).values({
    channelId: room.id, taskNumber: 11, title: `rw anchor task ${f.tag}`, createdByType: "user", createdById: f.sender.id,
  }).returning();
  const [taskConversation] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `task-${task.id}`, type: "task", taskId: task.id, parentChannelId: room.id,
  }).returning();
  await db.update(tasks).set({ conversationChannelId: taskConversation.id }).where(eq(tasks.id, task.id));
  await db.insert(threadFollows).values([
    { threadChannelId: thread.id, parentMessageId: threadParent.id, reason: "manual", followerType: "user", followerId: user.id },
    { threadChannelId: taskConversation.id, parentMessageId: null, parentTaskId: task.id, reason: "assigned", followerType: "user", followerId: user.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const threadMention = await post(thread.id, "@user in the thread");
  await mention(threadMention, thread.id);
  const taskMention = await post(taskConversation.id, "@user in the task conversation");
  await mention(taskMention, taskConversation.id);

  // (4) Joint: stored in canonical storage, mention row under the SENDER's projection.
  const jointMention = await post(ownCanonical.id, "@user joint");
  await mention(jointMention, ownSenderLocal.id, { serverId: f.senderServer.id });

  // (5) Outsider: two notified mentions with the read cursor between them.
  const outsideFirst = await post(outside.id, "@user outsider first");
  await mention(outsideFirst, outside.id, { notifiedAt: new Date() });
  const outsideSecond = await post(outside.id, "@user outsider second");
  await mention(outsideSecond, outside.id, { notifiedAt: new Date() });
  await db.insert(userChannelReadCursors).values({ userId: user.id, channelId: outside.id, lastReadSeq: outsideFirst.seq });

  // Display time: the highest-seq message carries an older timestamp.
  await post(timeRoom.id, "now");
  const backdated = await post(timeRoom.id, "imported", { createdAt: new Date(Date.now() - 86_400_000) });

  type Item = Awaited<ReturnType<typeof getInboxItems>>["items"][number];
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const rwItems = async () => new Map(
    (await getInboxItems(f.receiverServer.id, user.id, { filter: "all", limit: 50 })).items.map((item) => [targetOf(item), item] as const),
  );
  const pgItems = async () => new Map(
    (await getInboxItems(f.receiverServer.id, user.id, { filter: "all", limit: 50, forceCanonicalPostgres: true }))
      .items.map((item) => [targetOf(item), item] as const),
  );
  const waitForRw = async (want: (items: Map<string, Item>) => boolean, what: string) => {
    const deadline = Date.now() + timeoutMs;
    let items = new Map<string, Item>();
    do {
      items = await rwItems();
      if (want(items)) return items;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.fail(`${what}; RisingWave Activity: ${JSON.stringify([...items.values()].map((item) => [targetOf(item), item.firstMentionMessageId]))}`);
  };
  const anchors = (items: Map<string, Item>, ids: string[]) => ids.map((id) => [id, items.get(id)?.firstMentionMessageId ?? null]);
  const allTargets = [room.id, deleted.id, thread.id, taskConversation.id, ownLocal.id, outside.id, timeRoom.id];

  const rw = await waitForRw(
    (items) => items.get(room.id)?.firstMentionMessageId === roomAbove.id
      && items.get(outside.id)?.firstMentionMessageId === outsideFirst.id
      && [deleted.id, thread.id, taskConversation.id, ownLocal.id, timeRoom.id].every((id) => items.has(id)),
    "the anchors did not reach Activity",
  );
  const pg = await pgItems();
  assert.deepEqual(anchors(rw, allTargets), anchors(pg, allTargets), "RW and canonical Postgres anchor the same mentions");
  assert.deepEqual(anchors(rw, allTargets), [
    [room.id, roomAbove.id], // above the cursor, skipping the silent one
    [deleted.id, deletedFirst.id],
    [thread.id, threadMention.id],
    [taskConversation.id, taskMention.id],
    [ownLocal.id, jointMention.id],
    [outside.id, outsideFirst.id], // mention-only: the read cursor does not gate it
    [timeRoom.id, null],
  ]);
  const outsideItem = rw.get(outside.id)!;
  assert.equal(outsideItem.firstUnreadMessageId, outsideFirst.id, "a mention-only row opens at its anchor, as in Postgres");
  assert.equal(outsideItem.firstUnreadMessageId, pg.get(outside.id)?.firstUnreadMessageId);
  assert.equal(rw.get(notifiedLater.id)?.hasMention ?? false, false, "a silent mention is not an @");
  assert.equal(rw.get(notifiedLater.id)?.firstMentionMessageId ?? null, null);

  // Display times are the highest-seq message's, as in Postgres; the row stays.
  const timeItem = rw.get(timeRoom.id)!;
  const pgTimeItem = pg.get(timeRoom.id)!;
  assert.ok(timeItem.kind === "channel" && pgTimeItem.kind === "channel");
  assert.equal(timeItem.lastMessageId, backdated.id);
  assert.equal(timeItem.lastMessageAt, pgTimeItem.lastMessageAt);
  assert.equal(new Date(`${timeItem.lastMessageAt.replace(" ", "T").replace(/\+00$/, "Z")}`).getTime(), backdated.createdAt.getTime());
  const served = await queryRisingWave<{ last_activity_at: Date; activity_at: Date }>(
    getRisingWavePool()!,
    `SELECT last_activity_at, activity_at FROM ${UNIFIED_CHAIN_VIEWS.serving} WHERE receiver_type = 'user' AND receiver_id = $1 AND channel_id = $2`,
    [user.id, timeRoom.id],
  );
  assert.equal(new Date(served.result.rows[0]!.last_activity_at).getTime(), backdated.createdAt.getTime());
  assert.equal(new Date(served.result.rows[0]!.activity_at).getTime(), backdated.createdAt.getTime());

  // (2) Notified later: the @ and its anchor appear.
  await db.update(messageMentions).set({ notifiedAt: new Date() })
    .where(and(eq(messageMentions.messageId, later.id), eq(messageMentions.targetId, user.id)));
  // (7) The first mention's row goes away: the anchor moves to the second.
  await db.delete(messageMentions)
    .where(and(eq(messageMentions.messageId, deletedFirst.id), eq(messageMentions.targetId, user.id)));
  // (5) Done through the first outsider mention: the anchor moves to the second.
  await db.insert(inboxSuppressionStates).values({
    receiverType: "user", receiverId: user.id, serverId: f.receiverServer.id, targetKind: "public_channel_mention",
    targetChannelId: outside.id, sourceChannelId: outside.id, doneThroughSeq: outsideFirst.seq, writeSite: "test",
  });
  const moved = await waitForRw(
    (items) => items.get(notifiedLater.id)?.firstMentionMessageId === later.id
      && items.get(deleted.id)?.firstMentionMessageId === deletedSecond.id
      && items.get(outside.id)?.firstMentionMessageId === outsideSecond.id,
    "the anchors did not move",
  );
  const movedTargets = [notifiedLater.id, deleted.id, outside.id];
  assert.deepEqual(anchors(moved, movedTargets), anchors(await pgItems(), movedTargets));
  assert.equal(moved.get(notifiedLater.id)?.hasMention, true);

  // (7) The last mention goes away too: no anchor, no @. (5) Done through the
  // second outsider mention: the row leaves; a newer mention brings it back on it.
  await db.delete(messageMentions)
    .where(and(eq(messageMentions.messageId, deletedSecond.id), eq(messageMentions.targetId, user.id)));
  await db.update(inboxSuppressionStates).set({ doneThroughSeq: outsideSecond.seq })
    .where(and(eq(inboxSuppressionStates.receiverId, user.id), eq(inboxSuppressionStates.targetChannelId, outside.id)));
  await waitForRw(
    (items) => (items.get(deleted.id)?.firstMentionMessageId ?? null) === null && !items.has(outside.id),
    "the deleted mentions or the done outsider row are still served",
  );
  const outsideThird = await post(outside.id, "@user outsider after done");
  await mention(outsideThird, outside.id, { notifiedAt: new Date() });
  const reopened = await waitForRw(
    (items) => items.get(outside.id)?.firstMentionMessageId === outsideThird.id,
    "a newer outsider mention after done did not reopen the row on it",
  );
  const reopenedPg = await pgItems();
  assert.deepEqual(anchors(reopened, [deleted.id, outside.id]), anchors(reopenedPg, [deleted.id, outside.id]));
  assert.equal(reopened.get(outside.id)?.firstUnreadMessageId, outsideThird.id);
});

test.skipIf(!configured)("Done frontier parity: canonical Postgres doneFrontierSeq = RisingWave latestActivitySeq = sync done.doneFrontierSeq", async () => {
  // Web clients decide whether another device's Done covers an Activity row by
  // comparing the sync change's done.doneFrontierSeq with the row's
  // latestActivitySeq (RW rows' doneFrontierSeq is not a contract). So, per
  // conversation, the PG row's doneFrontierSeq (fetchReadStateAuthorityRows),
  // the RW row's latestActivitySeq (rw_inbox_serving_v9) and the sync done
  // state (readConversationStates) must be the same number.
  // A fresh viewer and conversations, so the fixture's counts stay untouched.
  const db = getDb();
  const [viewer] = await db.insert(users).values({
    name: `rwreal-donefrontier-${f.tag}`, email: `rwreal-donefrontier-${f.tag}@test.invalid`, passwordHash: "x", emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: f.receiverServer.id, userId: viewer.id, role: "member" });
  const [room, dm, canonical, senderLocal, local] = await db.insert(channels).values([
    { serverId: f.receiverServer.id, name: `rwreal-donefrontier-room-${f.tag}`, type: "channel" },
    { serverId: f.receiverServer.id, name: `rwreal-donefrontier-dm-${f.tag}`, type: "dm" },
    { serverId: f.storage.id, name: `rwreal-donefrontier-canonical-${f.tag}`, type: "joint" },
    { serverId: f.senderServer.id, name: `rwreal-donefrontier-sender-local-${f.tag}`, type: "joint" },
    { serverId: f.receiverServer.id, name: `rwreal-donefrontier-local-${f.tag}`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id, createdByServerId: f.senderServer.id, createdByUserId: f.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: f.senderServer.id, localChannelId: senderLocal.id, role: "host", status: "active", joinedByUserId: f.owner.id },
    { jointChannelId: joint.id, serverId: f.receiverServer.id, localChannelId: local.id, role: "participant", status: "active", joinedByUserId: f.owner.id },
  ]);
  await db.insert(channelHumans).values([
    ...[room, dm, local].map((channel) => ({ channelId: channel.id, userId: viewer.id })),
    ...[room, dm, senderLocal].map((channel) => ({ channelId: channel.id, userId: f.sender.id })),
  ]);
  // Joint read authority is computed membership only: the viewer and the sender are J members.
  await fillJointMembersFromChannelHumans([joint.id]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const post = async (channelId: string, authorId: string, content: string, extra: Partial<typeof messages.$inferInsert> = {}) => {
    const [message] = await db.insert(messages).values({
      channelId, senderType: "user", senderId: authorId, content: `${content} ${f.tag}`, ...extra,
    }).returning();
    return message;
  };

  // A thread and a task conversation below the room, both followed by the viewer.
  const threadParent = await post(room.id, f.sender.id, "done frontier thread parent");
  const [thread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${threadParent.id.slice(0, 8)}`, type: "thread", parentMessageId: threadParent.id,
  }).returning();
  const [task] = await db.insert(tasks).values({
    channelId: room.id, taskNumber: 13, title: `rw done frontier task ${f.tag}`, createdByType: "user", createdById: f.sender.id,
  }).returning();
  const [taskConversation] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `task-${task.id}`, type: "task", taskId: task.id, parentChannelId: room.id,
  }).returning();
  await db.update(tasks).set({ conversationChannelId: taskConversation.id }).where(eq(tasks.id, task.id));
  await db.insert(threadFollows).values([
    { threadChannelId: thread.id, parentMessageId: threadParent.id, reason: "manual", followerType: "user", followerId: viewer.id },
    { threadChannelId: taskConversation.id, parentMessageId: null, parentTaskId: task.id, reason: "assigned", followerType: "user", followerId: viewer.id },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Channel: the latest message is the viewer's own.
  await post(room.id, f.sender.id, "room from the other");
  const roomLatest = await post(room.id, viewer.id, "room from the viewer");
  // DM: the latest message is the other's.
  await post(dm.id, viewer.id, "dm from the viewer");
  const dmLatest = await post(dm.id, f.sender.id, "dm from the other");
  // Joint (receiver's projection): stored in canonical storage; the latest is the other's.
  await post(canonical.id, viewer.id, "joint from the viewer");
  const jointLatest = await post(canonical.id, f.sender.id, "joint from the other");
  // Thread: replies; the latest reply is the viewer's own.
  await post(thread.id, f.sender.id, "thread reply from the other");
  const threadLatest = await post(thread.id, viewer.id, "thread reply from the viewer");
  // Task conversation: a lifecycle line, then replies; the latest reply is the other's.
  await post(taskConversation.id, f.sender.id, `assigned #13`, {
    messageType: "system", systemSubtype: "task.assignment_receipt", causalActorType: "user", causalActorId: f.sender.id,
  });
  await post(taskConversation.id, f.sender.id, "task reply from the other");
  await post(taskConversation.id, viewer.id, "task reply from the viewer");
  const taskLatest = await post(taskConversation.id, f.sender.id, "task reply from the other, latest");

  type Item = Awaited<ReturnType<typeof getInboxItems>>["items"][number];
  const cases = [
    { what: "channel", id: room.id, kind: "channel", latest: roomLatest, syncDone: true },
    { what: "DM", id: dm.id, kind: "dm", latest: dmLatest, syncDone: true },
    { what: "joint (receiver's projection)", id: local.id, kind: "channel", latest: jointLatest, syncDone: true },
    { what: "thread", id: thread.id, kind: "thread", latest: threadLatest, syncDone: false },
    { what: "task conversation", id: taskConversation.id, kind: "task", latest: taskLatest, syncDone: false },
  ] as const;
  const seqOf = (value: string | null | undefined) => (value === null || value === undefined ? null : BigInt(value));
  const itemsOf = async (forceCanonicalPostgres: boolean) => new Map(
    (await getInboxItems(f.receiverServer.id, viewer.id, { filter: "all", limit: 50, forceCanonicalPostgres }))
      .items.map((item) => [targetOf(item), item] as const),
  );
  const describe = (items: Map<string, Item>) => JSON.stringify(cases.map((c) => [c.what, items.get(c.id)?.latestActivitySeq ?? null]));
  // Wait for CDC: every RW row reflects its last message.
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let rw = await itemsOf(false);
  while (!cases.every((c) => seqOf(rw.get(c.id)?.latestActivitySeq) === BigInt(c.latest.seq)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    rw = await itemsOf(false);
  }
  const pg = await itemsOf(true);
  for (const c of cases) {
    const rwItem = rw.get(c.id);
    const pgItem = pg.get(c.id);
    assert.ok(rwItem, `${c.what}: RisingWave Activity lists it; RW: ${describe(rw)}`);
    assert.ok(pgItem, `${c.what}: canonical Postgres Activity lists it`);
    assert.equal(rwItem.kind, c.kind, `${c.what}: RW kind`);
    assert.equal(pgItem.kind, c.kind, `${c.what}: PG kind`);
    assert.ok(pgItem.doneFrontierSeq, `${c.what}: the PG row carries doneFrontierSeq`);
    assert.equal(
      seqOf(pgItem.doneFrontierSeq),
      seqOf(rwItem.latestActivitySeq),
      `${c.what}: PG doneFrontierSeq (${pgItem.doneFrontierSeq}) = RW latestActivitySeq (${rwItem.latestActivitySeq})`,
    );
    assert.equal(seqOf(rwItem.latestActivitySeq), BigInt(c.latest.seq), `${c.what}: both are the last message's seq`);
  }

  // Done from "another device", then the sync pull: done.doneFrontierSeq is the
  // same number. Only channels and DMs carry a done state (inbox_state); a
  // thread's or task conversation's Done travels as `follow`, without a frontier.
  const viewerRef = { userId: viewer.id, serverId: f.receiverServer.id as ServerId, isGuest: false };
  const start = parseSyncChangesCursor((await readSyncChanges({ viewer: viewerRef, since: null, limit: 1 })).cursor);
  assert.ok(start, "the sync cursor parses");
  const syncCases = cases.filter((c) => c.syncDone);
  for (const c of syncCases) {
    const ack = await markChannelInboxDone(viewer.id, c.id, rw.get(c.id)!.latestActivitySeq);
    assert.equal(ack.terminalReason, "effect_applied", `${c.what}: Done applied`);
  }
  const doneById = new Map<string, SyncConversationDoneState>();
  let since = start;
  for (let page = 0; page < 20; page += 1) {
    const read = await readSyncChanges({ viewer: viewerRef, since, limit: 200 });
    assert.equal(read.reset, null, "no reset");
    for (const change of read.changes) {
      if (change.entity === "conversation" && change.done) doneById.set(change.id, change.done);
    }
    since = parseSyncChangesCursor(read.cursor)!;
    if (!read.hasMore) break;
  }
  for (const c of syncCases) {
    const done = doneById.get(c.id);
    assert.ok(done, `${c.what}: the sync pull carries its done state; got ${JSON.stringify([...doneById])}`);
    assert.equal(done.done, true, `${c.what}: done`);
    assert.equal(
      seqOf(done.doneFrontierSeq),
      seqOf(rw.get(c.id)!.latestActivitySeq),
      `${c.what}: sync done.doneFrontierSeq (${done.doneFrontierSeq}) = RW latestActivitySeq`,
    );
    assert.equal(seqOf(done.doneFrontierSeq), seqOf(pg.get(c.id)!.doneFrontierSeq), `${c.what}: = PG doneFrontierSeq`);
  }
});
