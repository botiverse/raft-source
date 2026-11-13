import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { channels, messages, servers, users } from "../db/schema";
import { runParentChannelIdBackfill, verifyParentChannelIds } from "./parentChannelIdBackfill";

// Rows written before 0297 carry parent_channel_id NULL. The fixture recreates
// that state by inserting with the derive trigger disabled, then checks the
// verifier finds exactly those rows, the batched backfill fixes them, and a
// re-run or a resumed run changes nothing.

test("parent_channel_id backfill fills pre-0297 thread rows in batches and the verifier gates on 0", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "pcid-bf@test.com", name: "pcidBf", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Backfill", slug: "pcid-backfill", ownerId: owner.id }).returning();
  const [room, other] = await db.insert(channels).values([
    { serverId: server.id, name: "pcid-bf-room", type: "channel" },
    { serverId: server.id, name: "pcid-bf-other", type: "channel" },
  ]).returning();
  const parents = await db.insert(messages).values(
    Array.from({ length: 5 }, (_, i) => ({ channelId: i % 2 ? other.id : room.id, senderType: "user" as const, senderId: owner.id, content: `parent ${i}` })),
  ).returning();

  // Emulate pre-CHECK orphan history; current writes must satisfy the cache invariant.
  await db.execute(sql`ALTER TABLE channels DROP CONSTRAINT channels_parent_message_requires_channel`);
  await db.execute(sql`ALTER TABLE channels DISABLE TRIGGER channels_parent_channel_id_insert`);
  const legacy = await db.insert(channels).values([
    ...parents.map((parent, i) => ({ serverId: server.id, name: `pcid-bf-t${i}`, type: "thread" as const, parentMessageId: parent.id, deletedAt: i === 4 ? new Date() : null })),
    { serverId: server.id, name: "pcid-bf-orphan", type: "thread" as const, parentMessageId: randomUUID() },
    { serverId: server.id, name: "pcid-bf-projection", type: "thread" as const },
  ]).returning();
  await db.execute(sql`ALTER TABLE channels ENABLE TRIGGER channels_parent_channel_id_insert`);
  // A thread created after 0297 is already derived by the trigger.
  const live = await db.insert(messages).values({ channelId: room.id, senderType: "user", senderId: owner.id, content: "live parent" }).returning();
  const [liveThread] = await db.insert(channels).values({ serverId: server.id, name: "pcid-bf-live", type: "thread", parentMessageId: live[0]!.id }).returning();
  assert.equal(liveThread.parentChannelId, room.id);

  const before = await verifyParentChannelIds(run, { batchSize: 3 });
  assert.equal(before.divergentThreads, 5, "the five legacy threads with a parent are divergent; orphan and projection are already NULL");
  assert.equal(before.nonThreadsWithValue, 0);
  assert.deepEqual(new Set(before.sampleIds), new Set(legacy.slice(0, 5).map((row) => row.id)));

  const lines: string[] = [];
  const first = await runParentChannelIdBackfill(run, { batchSize: 2, sleepMs: 0, log: (line) => lines.push(line) });
  assert.equal(first.rowsUpdated, 5);
  assert.ok(first.batches >= 4, "small batches walk every thread row");
  assert.equal(first.threadsScanned, 8, "every thread row in the database is scanned once");
  assert.equal(lines.length, first.batches);

  const after = await verifyParentChannelIds(run, { batchSize: 3 });
  assert.deepEqual(after, { divergentThreads: 0, nonThreadsWithValue: 0, sampleIds: [] });
  for (const [i, row] of legacy.slice(0, 5).entries()) {
    const [stored] = await db.select({ value: channels.parentChannelId }).from(channels).where(eq(channels.id, row.id));
    assert.equal(stored!.value, i % 2 ? other.id : room.id, `thread ${i} points at its parent's channel (deleted threads too)`);
  }

  const rerun = await runParentChannelIdBackfill(run, { batchSize: 2, sleepMs: 0 });
  assert.equal(rerun.rowsUpdated, 0, "a re-run writes nothing");
  const resumed = await runParentChannelIdBackfill(run, { batchSize: 2, sleepMs: 0, afterId: first.lastId! });
  assert.deepEqual({ batches: resumed.batches, rowsUpdated: resumed.rowsUpdated }, { batches: 0, rowsUpdated: 0 }, "resuming after the last id has nothing left");

  // The verifier also catches a non-thread carrying a value and an orphan thread
  // (parent message missing) carrying a stale one: both impossible with the
  // trigger on, so only reachable with it disabled.
  const orphan = legacy[5]!;
  await db.execute(sql`ALTER TABLE channels DISABLE TRIGGER channels_parent_channel_id_update`);
  await db.update(channels).set({ parentChannelId: room.id }).where(eq(channels.id, other.id));
  await db.update(channels).set({ parentChannelId: room.id }).where(eq(channels.id, orphan.id));
  await db.execute(sql`ALTER TABLE channels ENABLE TRIGGER channels_parent_channel_id_update`);
  const stray = await verifyParentChannelIds(run, { batchSize: 3 });
  assert.equal(stray.nonThreadsWithValue, 1);
  assert.equal(stray.divergentThreads, 1, "an orphan with a value is divergent: a missing parent must read NULL");
  assert.deepEqual(stray.sampleIds, [orphan.id]);
});
