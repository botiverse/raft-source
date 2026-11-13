import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql, type SQL } from "drizzle-orm";
import { channels, messages, messageServerTimeline, servers, users } from "../db/schema";
import {
  cdcSlotVerdict,
  readCdcSlot,
  runMessageServerTimelineBackfill,
  runMessageServerTimelineSearchVectorBackfill,
  SLOT_PAUSE_BYTES,
  SLOT_RESUME_BYTES,
  SLOT_STOP_BYTES,
  type CdcSlotReading,
  verifyMessageServerTimeline,
  verifyMessageServerTimelineSearchVector,
} from "./messageServerTimelineBackfill";

// Messages written before 0310 have no timeline row. The fixture recreates that
// state by inserting with the insert trigger disabled, then checks the verifier
// finds exactly those rows, the batched backfill fills them (leaving live
// trigger-written rows alone), and a re-run or a resumed run changes nothing.

test("message_server_timeline backfill fills pre-0310 messages in batches and the verifier gates on 0", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-bf@test.com", name: "mstBf", passwordHash: "x", emailVerified: true }).returning();
  const [serverA, serverB] = await db.insert(servers).values([
    { name: "MST BF A", slug: "mst-bf-a", ownerId: owner!.id },
    { name: "MST BF B", slug: "mst-bf-b", ownerId: owner!.id },
  ]).returning();
  const [chanA, chanB] = await db.insert(channels).values([
    { serverId: serverA!.id, name: "mst-bf-a", type: "channel" },
    { serverId: serverB!.id, name: "mst-bf-b", type: "channel" },
  ]).returning();

  await db.execute(sql`ALTER TABLE messages DISABLE TRIGGER messages_server_timeline_insert`);
  const legacy = await db.insert(messages).values(
    Array.from({ length: 7 }, (_, i) => ({ channelId: i % 2 ? chanB!.id : chanA!.id, senderType: "user" as const, senderId: owner!.id, content: `legacy ${i}` })),
  ).returning();
  await db.execute(sql`ALTER TABLE messages ENABLE TRIGGER messages_server_timeline_insert`);
  // Written after 0310: the trigger already has it.
  const [live] = await db.insert(messages).values({ channelId: chanA!.id, senderType: "user", senderId: owner!.id, content: "live" }).returning();
  // A legacy message moved during the rollout: the update trigger upserts it now.
  await db.update(messages).set({ channelId: chanB!.id }).where(eq(messages.id, legacy[0]!.id));

  const before = await verifyMessageServerTimeline(run, { batchSize: 3 });
  assert.equal(before.missingRows, 6, "six legacy messages have no row; the moved one got its row from the update trigger");
  assert.equal(before.divergentRows, 0);

  const lines: string[] = [];
  const first = await runMessageServerTimelineBackfill(run, { batchSize: 2, sleepMs: 0, log: (line) => lines.push(line) });
  assert.equal(first.rowsInserted, 6);
  assert.equal(first.messagesScanned, 8, "every message is scanned once");
  assert.ok(first.batches >= 4);
  assert.equal(lines.length, first.batches);

  const progress: string[] = [];
  assert.deepEqual(await verifyMessageServerTimeline(run, { batchSize: 3, log: (line) => progress.push(line) }), { missingRows: 0, divergentRows: 0, sampleIds: [], scannedRows: 8 });
  assert.equal(progress.length, 3, "one progress line per slice (3 + 3 + 2)");
  const midway = JSON.parse(progress[0]!.replace("[MESSAGE_TIMELINE_VERIFY_PROGRESS] ", "")) as { lastId: string; scannedRows: number };
  assert.equal(midway.scannedRows, 3);
  const resumedVerify = await verifyMessageServerTimeline(run, { batchSize: 3, afterId: midway.lastId });
  assert.equal(resumedVerify.scannedRows, 5, "resuming after the first slice scans only the remaining five");
  for (const message of [...legacy, live!]) {
    const [row] = await db.select().from(messageServerTimeline).where(eq(messageServerTimeline.messageId, message.id));
    const [current] = await db.select().from(messages).where(eq(messages.id, message.id));
    assert.equal(row?.serverId, current!.channelId === chanA!.id ? serverA!.id : serverB!.id);
    assert.equal(row?.channelId, current!.channelId);
    assert.deepEqual(row?.createdAt, current!.createdAt);
  }

  const rerun = await runMessageServerTimelineBackfill(run, { batchSize: 2, sleepMs: 0 });
  assert.equal(rerun.rowsInserted, 0, "a re-run writes nothing");
  const resumed = await runMessageServerTimelineBackfill(run, { batchSize: 2, sleepMs: 0, afterId: first.lastId! });
  assert.deepEqual({ batches: resumed.batches, rowsInserted: resumed.rowsInserted }, { batches: 0, rowsInserted: 0 });

  // The verifier catches a row that went stale (e.g. a trigger disabled by hand).
  await db.execute(sql`UPDATE message_server_timeline SET server_id = ${serverB!.id} WHERE message_id = ${live!.id}`);
  const stale = await verifyMessageServerTimeline(run, { batchSize: 3 });
  assert.deepEqual({ missing: stale.missingRows, divergent: stale.divergentRows, sample: stale.sampleIds }, { missing: 0, divergent: 1, sample: [live!.id] });

  // A 0-row slice would scan nothing and report 0/0; the verifier refuses it.
  await assert.rejects(verifyMessageServerTimeline(run, { batchSize: 0 }), RangeError);
});

// 0658: timeline rows written before it have no search_vector. The fixture
// recreates that by clearing the copies, then checks the verifier counts them,
// an edit's trigger re-copies its row, the batched fill completes the rest
// (and only NULL rows), and the verify resumes from --after-id.
test("message_server_timeline search_vector fill copies only missing vectors and the verifier gates on 0", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-vec@test.com", name: "mstVec", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "MST VEC", slug: "mst-vec", ownerId: owner!.id }).returning();
  const [chan] = await db.insert(channels).values({ serverId: server!.id, name: "mst-vec", type: "channel" }).returning();
  const rows = await db.insert(messages).values(
    Array.from({ length: 7 }, (_, i) => ({ channelId: chan!.id, senderType: "user" as const, senderId: owner!.id, content: `vec ${i}`, searchText: `vecword${i}` })),
  ).returning();
  const ids = rows.map((row) => row.id);
  const copies = await db.select({ v: messageServerTimeline.searchVector }).from(messageServerTimeline).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[])`);
  assert.ok(copies.every((row) => row.v !== null), "the insert trigger copies the vector");

  await db.update(messageServerTimeline).set({ searchVector: null }).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[])`);
  const before = await verifyMessageServerTimelineSearchVector(run, { batchSize: 3 });
  assert.equal(before.divergentRows, 7);
  // An edit re-copies its own row through the update trigger.
  await db.update(messages).set({ searchText: "vecedited" }).where(eq(messages.id, ids[0]!));
  const afterEdit = await verifyMessageServerTimelineSearchVector(run, { batchSize: 3 });
  assert.equal(afterEdit.divergentRows, 6);

  const lines: string[] = [];
  const filled = await runMessageServerTimelineSearchVectorBackfill(run, { batchSize: 2, sleepMs: 0, log: (line) => lines.push(line) });
  assert.equal(filled.rowsFilled, 6, "only the NULL rows; the edited row keeps its trigger-written vector");
  assert.ok(lines.every((line) => line.startsWith("[MESSAGE_TIMELINE_VECTOR_BACKFILL_BATCH]")));
  const after = await verifyMessageServerTimelineSearchVector(run, { batchSize: 3 });
  assert.equal(after.divergentRows, 0);
  assert.ok(after.scannedRows >= 7);
  const [edited] = await db.select({ v: messageServerTimeline.searchVector }).from(messageServerTimeline).where(eq(messageServerTimeline.messageId, ids[0]!));
  assert.ok(edited?.v?.includes("vecedited"));

  const again = await runMessageServerTimelineSearchVectorBackfill(run, { batchSize: 2, sleepMs: 0 });
  assert.equal(again.rowsFilled, 0, "a re-run changes nothing");
  // A resumed verify scans only what is after its --after-id.
  const resumed = await verifyMessageServerTimelineSearchVector(run, { batchSize: 3, afterId: after.lastId! });
  assert.equal(resumed.scannedRows, 0);
  await assert.rejects(() => verifyMessageServerTimelineSearchVector(run, { batchSize: 0 }), RangeError);
});

test("the CDC slot rule: over 64 MB pauses until under 32 MB, over 250 MB or a non-reserved slot stops", () => {
  const at = (bytes: number | null, walStatus: string | null = "reserved"): CdcSlotReading => ({ retainedWalBytes: bytes, walStatus });
  assert.equal(cdcSlotVerdict(null, false), "go", "no slot (dev, staging) is no reading");
  assert.equal(cdcSlotVerdict(at(SLOT_PAUSE_BYTES), false), "go");
  assert.equal(cdcSlotVerdict(at(SLOT_PAUSE_BYTES + 1), false), "pause");
  assert.equal(cdcSlotVerdict(at(SLOT_RESUME_BYTES + 1), true), "pause", "still paused until under 32 MB");
  assert.equal(cdcSlotVerdict(at(SLOT_RESUME_BYTES - 1), true), "go");
  assert.equal(cdcSlotVerdict(at(SLOT_STOP_BYTES + 1), false), "stop");
  assert.equal(cdcSlotVerdict(at(0, "extended"), false), "stop");
  assert.equal(cdcSlotVerdict(at(null), true), "pause");
});

test("the search_vector fill waits out a slot pause and stops on the slot with a resumable after-id", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  assert.equal(await readCdcSlot(run), null, "the test database has no CDC slot");
  const [owner] = await db.insert(users).values({ email: "mst-slot@test.com", name: "mstSlot", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "MST SLOT", slug: "mst-slot", ownerId: owner!.id }).returning();
  const [chan] = await db.insert(channels).values({ serverId: server!.id, name: "mst-slot", type: "channel" }).returning();
  const rows = await db.insert(messages).values(
    Array.from({ length: 6 }, (_, i) => ({ channelId: chan!.id, senderType: "user" as const, senderId: owner!.id, content: `slot ${i}`, searchText: `slotword${i}` })),
  ).returning();
  const ids = rows.map((row) => row.id);
  await db.update(messageServerTimeline).set({ searchVector: null }).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[])`);

  const MB = 1024 * 1024;
  // 5 MB: batch 1. 100 MB pauses, 40 MB holds the pause, 10 MB resumes: batch
  // 2. 5 MB: batch 3. 300 MB stops before batch 4.
  const readings = [5, 100, 40, 10, 5, 300].map((mb): CdcSlotReading => ({ retainedWalBytes: mb * MB, walStatus: "reserved" }));
  let reads = 0;
  const lines: string[] = [];
  const stopped = await runMessageServerTimelineSearchVectorBackfill(run, {
    batchSize: 2,
    sleepMs: 0,
    slotPollMs: 0,
    readSlot: async () => readings[reads++] ?? null,
    log: (line) => lines.push(line),
  });
  assert.equal(stopped.stoppedBy, "slot");
  assert.equal(stopped.batches, 3);
  assert.equal(stopped.slotPauses, 1);
  assert.equal(reads, 6);
  assert.ok(lines.some((line) => line.includes("paused")) && lines.some((line) => line.includes("resumed")) && lines.some((line) => line.includes("stopped")));

  const resumed = await runMessageServerTimelineSearchVectorBackfill(run, { batchSize: 2, sleepMs: 0, afterId: stopped.lastId!, readSlot: async () => null });
  assert.equal(resumed.stoppedBy, null);
  const left = await db.select({ id: messageServerTimeline.messageId }).from(messageServerTimeline)
    .where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[]) AND ${messageServerTimeline.searchVector} IS NULL`);
  assert.equal(left.length, 0, "the resumed run fills what the stopped one left");
});
