import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { RISINGWAVE_PUBLICATION_TABLES } from "../../../../scripts/dev/raftdev-risingwave-bootstrap";
import { channels, messages, messageServerTimeline, servers, users } from "./schema";

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
