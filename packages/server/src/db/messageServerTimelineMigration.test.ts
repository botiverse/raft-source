import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { RISINGWAVE_PUBLICATION_TABLES } from "../../../../scripts/dev/raftdev-risingwave-bootstrap";
import { verifyMessageServerTimelineConversation } from "../services/messageServerTimelineBackfill";
import { channels, messages, messageServerTimeline, servers, tasks, users } from "./schema";

// message_server_timeline (0310) is derived data owned by triggers on messages
// and kept out of RisingWave CDC: its backfill must never stream through
// slock_rw_publication.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("message_server_timeline stays out of the RisingWave publication", async () => {
  assert.equal((RISINGWAVE_PUBLICATION_TABLES as readonly string[]).includes("message_server_timeline"), false);
  const migrations = (await readdir(path.join(SERVER_ROOT, "drizzle"))).filter((file) => file.endsWith(".sql"));
  for (const file of migrations) {
    const statements = (await readFile(path.join(SERVER_ROOT, "drizzle", file), "utf8")).replace(/--.*$/gm, "");
    assert.doesNotMatch(statements, /\b(?:CREATE|ALTER)\s+PUBLICATION\b[^;]*message_server_timeline/i, `${file} must not publish message_server_timeline`);
  }
});

dbTest("triggers keep one timeline row per message, following channel moves and deletes", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "mst-owner@test.com", name: "mstOwner", passwordHash: "x", emailVerified: true }).returning();
  const [serverA, serverB] = await db.insert(servers).values([
    { name: "MST A", slug: "mst-a", ownerId: owner!.id },
    { name: "MST B", slug: "mst-b", ownerId: owner!.id },
  ]).returning();
  const [chanA, chanA2, chanB] = await db.insert(channels).values([
    { serverId: serverA!.id, name: "mst-a", type: "channel" },
    { serverId: serverA!.id, name: "mst-a2", type: "channel" },
    { serverId: serverB!.id, name: "mst-b", type: "channel" },
  ]).returning();
  const createdAt = new Date("2026-09-30T12:00:00.000Z");
  const [message] = await db.insert(messages).values({
    channelId: chanA!.id, senderType: "user", senderId: owner!.id, content: "hello", searchText: "hello", createdAt,
  }).returning();
  // The placement columns only; search_vector (0658) is pinned in messageServerTimelineBackfill.test.ts.
  const row = async () => (await db.select({
    messageId: messageServerTimeline.messageId,
    serverId: messageServerTimeline.serverId,
    createdAt: messageServerTimeline.createdAt,
    channelId: messageServerTimeline.channelId,
  }).from(messageServerTimeline).where(eq(messageServerTimeline.messageId, message!.id)))[0];

  // Insert: the channel's server, the message's time.
  assert.deepEqual(await row(), { messageId: message!.id, serverId: serverA!.id, createdAt, channelId: chanA!.id });

  // Move within the server, then across servers (conversion moves parents like this).
  await db.update(messages).set({ channelId: chanA2!.id }).where(eq(messages.id, message!.id));
  assert.equal((await row())?.channelId, chanA2!.id);
  await db.update(messages).set({ channelId: chanB!.id }).where(eq(messages.id, message!.id));
  assert.deepEqual(await row(), { messageId: message!.id, serverId: serverB!.id, createdAt, channelId: chanB!.id });

  // Unrelated updates do not touch the row; a created_at rewrite is followed.
  await db.update(messages).set({ content: "edited" }).where(eq(messages.id, message!.id));
  assert.equal((await row())?.serverId, serverB!.id);
  const later = new Date("2026-09-30T13:00:00.000Z");
  await db.update(messages).set({ createdAt: later }).where(eq(messages.id, message!.id));
  assert.deepEqual((await row())?.createdAt, later);

  // A message the backfill has not reached yet (no row) gets one on its next move.
  await db.delete(messageServerTimeline).where(eq(messageServerTimeline.messageId, message!.id));
  await db.update(messages).set({ channelId: chanA!.id }).where(eq(messages.id, message!.id));
  assert.equal((await row())?.serverId, serverA!.id);

  // The backfill racing the trigger: a row that already exists is left alone.
  const backfill = await db.execute(sql`
    INSERT INTO message_server_timeline (message_id, server_id, created_at, channel_id)
    SELECT m.id, c.server_id, m.created_at, m.channel_id
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.id = ${message!.id}
    ON CONFLICT (message_id) DO NOTHING`);
  assert.equal(backfill.rowCount ?? (backfill as { affectedRows?: number }).affectedRows ?? 0, 0);

  // Delete cascades.
  await db.delete(messages).where(eq(messages.id, message!.id));
  assert.equal(await row(), undefined);
});

dbTest("channels.server_id is immutable once the timeline copies it", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "mst-guard@test.com", name: "mstGuard", passwordHash: "x", emailVerified: true }).returning();
  const [serverA, serverB] = await db.insert(servers).values([
    { name: "MST G A", slug: "mst-g-a", ownerId: owner!.id },
    { name: "MST G B", slug: "mst-g-b", ownerId: owner!.id },
  ]).returning();
  const [chan] = await db.insert(channels).values({ serverId: serverA!.id, name: "mst-g", type: "channel" }).returning();

  await assert.rejects(
    db.update(channels).set({ serverId: serverB!.id }).where(eq(channels.id, chan!.id)),
    (error: Error & { cause?: Error }) => {
      assert.match(`${error.message} ${error.cause?.message ?? ""}`, /channels\.server_id is immutable/);
      return true;
    },
  );
  // Writing the same value, or other columns, is fine.
  await db.update(channels).set({ serverId: serverA!.id, name: "mst-g-renamed" }).where(eq(channels.id, chan!.id));
  assert.equal((await db.select().from(channels).where(eq(channels.id, chan!.id)))[0]?.name, "mst-g-renamed");
});

dbTest("conversation_id (0764): the joint conversation root on joint storage rows, NULL elsewhere, following moves and re-parents", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "mst-conv@test.com", name: "mstConv", passwordHash: "x", emailVerified: true }).returning();
  const [host, storage] = await db.insert(servers).values([
    { name: "MST CONV HOST", slug: "mst-conv-host", ownerId: owner!.id },
    { name: "MST CONV STORAGE", slug: "mst-conv-storage", ownerId: owner!.id, kind: "joint_storage" },
  ]).returning();
  const [hostChan, hostChan2, root, otherRoot] = await db.insert(channels).values([
    { serverId: host!.id, name: "mst-conv-host", type: "channel" },
    { serverId: host!.id, name: "mst-conv-host2", type: "channel" },
    { serverId: storage!.id, name: "mst-conv-root", type: "joint" },
    { serverId: storage!.id, name: "mst-conv-other", type: "joint" },
  ]).returning();
  const conversationOf = async (messageId: string) => (await db.select({ c: messageServerTimeline.conversationId })
    .from(messageServerTimeline).where(eq(messageServerTimeline.messageId, messageId)))[0]?.c;
  const post = async (channelId: string) => (await db.insert(messages).values({
    channelId, senderType: "user", senderId: owner!.id, content: "conv", searchText: "conv",
  }).returning())[0]!;

  // Threads take their parent message's channel as parent_channel_id (0297).
  const inRoot = await post(root!.id);
  const hostParent = await post(hostChan!.id);
  const [thread, hostThread] = await db.insert(channels).values([
    { serverId: storage!.id, name: "thread-mstconv", type: "thread", parentMessageId: inRoot.id },
    { serverId: host!.id, name: "thread-mstconvhost", type: "thread", parentMessageId: hostParent.id },
  ]).returning();

  // Insert: a storage channel's root is itself, a storage thread's is its parent; host rows NULL.
  const inThread = await post(thread!.id);
  const inHost = await post(hostChan!.id);
  const inHostThread = await post(hostThread!.id);
  assert.equal(await conversationOf(inRoot.id), root!.id);
  assert.equal(await conversationOf(inThread.id), root!.id);
  assert.equal(await conversationOf(inHost.id), null);
  assert.equal(await conversationOf(inHostThread.id), null);

  // A message moved host -> storage thread (conversion) gets the root; moved back, NULL again.
  await db.update(messages).set({ channelId: thread!.id }).where(eq(messages.id, inHost.id));
  assert.equal(await conversationOf(inHost.id), root!.id);
  await db.update(messages).set({ channelId: hostChan!.id }).where(eq(messages.id, inHost.id));
  assert.equal(await conversationOf(inHost.id), null);

  // The thread's parent message moves to another storage root: the thread is
  // re-parented (0297) and its rows follow; the moved message takes its new root.
  await db.update(messages).set({ channelId: otherRoot!.id }).where(eq(messages.id, inRoot.id));
  assert.equal((await db.select({ p: channels.parentChannelId }).from(channels).where(eq(channels.id, thread!.id)))[0]?.p, otherRoot!.id);
  assert.equal(await conversationOf(inThread.id), otherRoot!.id);
  assert.equal(await conversationOf(inRoot.id), otherRoot!.id);
  // A host thread re-parented stays NULL.
  await db.update(messages).set({ channelId: hostChan2!.id }).where(eq(messages.id, hostParent.id));
  assert.equal((await db.select({ p: channels.parentChannelId }).from(channels).where(eq(channels.id, hostThread!.id)))[0]?.p, hostChan2!.id);
  assert.equal(await conversationOf(inHostThread.id), null);

  // The partial index is built here on a small table.
  const index = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_message_server_timeline_conversation_created'`);
  assert.match(String((index.rows[0] as { indexdef?: string } | undefined)?.indexdef), /\(conversation_id, created_at, message_id\) WHERE \(conversation_id IS NOT NULL\)/);
});

dbTest("conversation_id (0764): a thread nested in a joint storage task conversation takes the storage root", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-nest@test.com", name: "mstNest", passwordHash: "x", emailVerified: true }).returning();
  const [storage] = await db.insert(servers).values({ name: "MST NEST STORAGE", slug: "mst-nest-storage", ownerId: owner!.id, kind: "joint_storage" }).returning();
  const [root] = await db.insert(channels).values({ serverId: storage!.id, name: "mst-nest-root", type: "joint" }).returning();
  const [task] = await db.insert(tasks).values({ channelId: root!.id, taskNumber: 1, title: "nested", createdByType: "user", createdById: owner!.id }).returning();
  // Production has threads whose parent_channel_id is a task conversation (or a thread).
  const [conversation] = await db.insert(channels).values({ serverId: storage!.id, name: "task-mstnest", type: "task", taskId: task!.id, parentChannelId: root!.id }).returning();
  const [inConversation] = await db.insert(messages).values({ channelId: conversation!.id, senderType: "user", senderId: owner!.id, content: "in the task" }).returning();
  const [nested] = await db.insert(channels).values({ serverId: storage!.id, name: "thread-mstnest", type: "thread", parentMessageId: inConversation!.id }).returning();
  assert.equal(nested!.parentChannelId, conversation!.id, "a thread inside the task conversation");
  const [reply] = await db.insert(messages).values({ channelId: nested!.id, senderType: "user", senderId: owner!.id, content: "nested reply" }).returning();
  const conversationOf = async (messageId: string) => (await db.select({ c: messageServerTimeline.conversationId })
    .from(messageServerTimeline).where(eq(messageServerTimeline.messageId, messageId)))[0]?.c;

  // Two levels up: the storage root, not the task conversation one level up.
  assert.equal(await conversationOf(inConversation!.id), root!.id);
  assert.equal(await conversationOf(reply!.id), root!.id);
  const clean = await verifyMessageServerTimelineConversation(run);
  assert.deepEqual({ missing: clean.missingRows, divergent: clean.divergentRows }, { missing: 0, divergent: 0 });

  // The one-level value (the task conversation) is caught by the verify.
  await db.update(messageServerTimeline).set({ conversationId: conversation!.id }).where(eq(messageServerTimeline.messageId, reply!.id));
  const oneLevel = await verifyMessageServerTimelineConversation(run);
  assert.deepEqual({ missing: oneLevel.missingRows, divergent: oneLevel.divergentRows, sample: oneLevel.sampleIds }, { missing: 0, divergent: 1, sample: [reply!.id] });
  await db.update(messageServerTimeline).set({ conversationId: root!.id }).where(eq(messageServerTimeline.messageId, reply!.id));

  // The task conversation re-parented to another storage root: its rows and
  // its direct children's (the nested thread) follow.
  const [otherRoot] = await db.insert(channels).values({ serverId: storage!.id, name: "mst-nest-other", type: "joint" }).returning();
  await db.update(channels).set({ parentChannelId: otherRoot!.id }).where(eq(channels.id, conversation!.id));
  assert.equal(await conversationOf(inConversation!.id), otherRoot!.id);
  assert.equal(await conversationOf(reply!.id), otherRoot!.id);
});
