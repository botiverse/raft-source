import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql, type SQL } from "drizzle-orm";
import { channels, messages, messageServerTimeline, servers, users } from "../db/schema";
import {
  cdcSlotVerdict,
  readCdcSlot,
  buildMessageServerTimelineConversationIndex,
  formatConversationPosition,
  parseConversationPosition,
  MESSAGE_SERVER_TIMELINE_CONVERSATION_INDEX,
  runMessageServerTimelineBackfill,
  runMessageServerTimelineConversationBackfill,
  runMessageServerTimelineSearchVectorBackfill,
  SLOT_PAUSE_BYTES,
  SLOT_RESUME_BYTES,
  SLOT_STOP_BYTES,
  type CdcSlotReading,
  verifyMessageServerTimeline,
  verifyMessageServerTimelineConversation,
  verifyMessageServerTimelineConversationAndBuildIndex,
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

// 0764: timeline rows written before it have no conversation_id. The fixture
// clears the joint storage rows' copies, then checks the verifier counts them
// (and a stray value off joint storage), the fill sets only joint storage rows,
// a re-run changes nothing, and the index builds after a clean verify.
test("message_server_timeline conversation_id fill sets joint storage rows only and the verifier gates on 0", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-convbf@test.com", name: "mstConvBf", passwordHash: "x", emailVerified: true }).returning();
  const [host, storage] = await db.insert(servers).values([
    { name: "MST CONVBF HOST", slug: "mst-convbf-host", ownerId: owner!.id },
    { name: "MST CONVBF STORAGE", slug: "mst-convbf-storage", ownerId: owner!.id, kind: "joint_storage" },
  ]).returning();
  const [hostChan, root] = await db.insert(channels).values([
    { serverId: host!.id, name: "mst-convbf-host", type: "channel" },
    { serverId: storage!.id, name: "mst-convbf-root", type: "joint" },
  ]).returning();
  const [parent] = await db.insert(messages).values({ channelId: root!.id, senderType: "user", senderId: owner!.id, content: "parent" }).returning();
  const [thread] = await db.insert(channels).values({ serverId: storage!.id, name: "thread-mstconvbf", type: "thread", parentMessageId: parent!.id }).returning();
  const storageRows = await db.insert(messages).values(
    Array.from({ length: 5 }, (_, i) => ({ channelId: i % 2 ? thread!.id : root!.id, senderType: "user" as const, senderId: owner!.id, content: `joint ${i}` })),
  ).returning();
  const hostRows = await db.insert(messages).values(
    Array.from({ length: 3 }, (_, i) => ({ channelId: hostChan!.id, senderType: "user" as const, senderId: owner!.id, content: `host ${i}` })),
  ).returning();
  const storageIds = [parent!.id, ...storageRows.map((row) => row.id)];
  const conversations = async (ids: string[]) => (await db.select({ id: messageServerTimeline.messageId, c: messageServerTimeline.conversationId })
    .from(messageServerTimeline).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[])`));

  const clean = await verifyMessageServerTimelineConversation(run, { batchSize: 3 });
  assert.deepEqual({ missing: clean.missingRows, divergent: clean.divergentRows }, { missing: 0, divergent: 0 }, "the triggers wrote every row");
  assert.ok(clean.scannedRows >= 9);

  // Before 0764: no copies on the joint storage rows; one stale value on a host row.
  await db.update(messageServerTimeline).set({ conversationId: null }).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(storageIds)}::uuid[])`);
  await db.update(messageServerTimeline).set({ conversationId: root!.id }).where(eq(messageServerTimeline.messageId, hostRows[0]!.id));
  const before = await verifyMessageServerTimelineConversation(run, { batchSize: 3 });
  assert.deepEqual({ missing: before.missingRows, divergent: before.divergentRows }, { missing: 6, divergent: 1 });
  assert.ok(before.sampleIds.includes(hostRows[0]!.id));

  const lines: string[] = [];
  const filled = await runMessageServerTimelineConversationBackfill(run, { batchSize: 2, sleepMs: 0, readSlot: async () => null, log: (line) => lines.push(line) });
  assert.equal(filled.rowsFilled, 6, "the joint storage rows only");
  assert.equal(filled.rowsScanned, 6, "keyset over the joint storage server's rows");
  assert.ok(lines.every((line) => line.startsWith("[MESSAGE_TIMELINE_CONVERSATION_BACKFILL_BATCH]")));
  for (const row of await conversations(storageIds)) assert.equal(row.c, root!.id, "a thread's rows carry its root");
  const hostAfter = await conversations(hostRows.map((row) => row.id));
  assert.deepEqual(
    hostAfter.map((row) => row.id === hostRows[0]!.id ? row.c === root!.id : row.c === null),
    [true, true, true],
    "the fill leaves other servers' rows alone",
  );

  // The stray host value is the verify's to report, not the fill's to fix.
  const stray = await verifyMessageServerTimelineConversation(run, { batchSize: 3 });
  assert.deepEqual({ missing: stray.missingRows, divergent: stray.divergentRows, sample: stray.sampleIds }, { missing: 0, divergent: 1, sample: [hostRows[0]!.id] });
  await db.update(messageServerTimeline).set({ conversationId: null }).where(eq(messageServerTimeline.messageId, hostRows[0]!.id));
  const after = await verifyMessageServerTimelineConversation(run, { batchSize: 3 });
  assert.deepEqual({ missing: after.missingRows, divergent: after.divergentRows }, { missing: 0, divergent: 0 });

  const again = await runMessageServerTimelineConversationBackfill(run, { batchSize: 2, sleepMs: 0, readSlot: async () => null });
  assert.equal(again.rowsFilled, 0, "a re-run changes nothing");
  const resumed = await verifyMessageServerTimelineConversation(run, { batchSize: 3, afterId: after.lastId! });
  assert.equal(resumed.scannedRows, 0);
  await assert.rejects(() => verifyMessageServerTimelineConversation(run, { batchSize: 0 }), RangeError);

  // The migration built the index on this small table; the build is a checked no-op.
  const built: string[] = [];
  await buildMessageServerTimelineConversationIndex(run, (line) => built.push(line));
  assert.match(built.at(-1) ?? "", new RegExp(`${MESSAGE_SERVER_TIMELINE_CONVERSATION_INDEX} valid`));
});

// Supported depth (0764): the root is at most two levels above a message's
// channel. A joint storage channel nested deeper is not derived; the verify
// counts its rows as divergent whatever they hold, and the gate builds no index.
test("message_server_timeline conversation_id verify fails a joint storage chain deeper than two levels and builds no index", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-deep@test.com", name: "mstDeep", passwordHash: "x", emailVerified: true }).returning();
  const [storage] = await db.insert(servers).values({ name: "MST DEEP STORAGE", slug: "mst-deep-storage", ownerId: owner!.id, kind: "joint_storage" }).returning();
  const [root] = await db.insert(channels).values({ serverId: storage!.id, name: "mst-deep-root", type: "joint" }).returning();
  // root <- thread1 <- thread2 <- thread3: thread3's grandparent (thread1) still has a parent.
  let parentChannelId = root!.id;
  const chain: string[] = [];
  for (let depth = 1; depth <= 3; depth += 1) {
    const [parent] = await db.insert(messages).values({ channelId: parentChannelId, senderType: "user", senderId: owner!.id, content: `depth ${depth - 1}` }).returning();
    const [thread] = await db.insert(channels).values({ serverId: storage!.id, name: `thread-mstdeep${depth}`, type: "thread", parentMessageId: parent!.id }).returning();
    chain.push(thread!.id);
    parentChannelId = thread!.id;
  }
  const [deep] = await db.insert(messages).values({ channelId: chain[2]!, senderType: "user", senderId: owner!.id, content: "three levels down" }).returning();

  await db.execute(sql.raw(`DROP INDEX IF EXISTS ${MESSAGE_SERVER_TIMELINE_CONVERSATION_INDEX}`));
  const lines: string[] = [];
  const gate = await verifyMessageServerTimelineConversationAndBuildIndex(run, { batchSize: 3, log: (line) => lines.push(line) });
  assert.equal(gate.divergence.missingRows, 0);
  assert.equal(gate.divergence.divergentRows, 1, "the depth-3 channel's row, whatever it holds");
  assert.deepEqual(gate.divergence.sampleIds, [deep!.id]);
  assert.equal(gate.indexBuilt, false);
  const index = await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = ${MESSAGE_SERVER_TIMELINE_CONVERSATION_INDEX}`);
  assert.equal(index.rows.length, 0, "no index on a failed verify");

  // Without the depth-3 channel the gate passes and builds the index.
  await db.delete(messages).where(eq(messages.id, deep!.id));
  const passed = await verifyMessageServerTimelineConversationAndBuildIndex(run, { batchSize: 3, log: (line) => lines.push(line) });
  assert.deepEqual({ missing: passed.divergence.missingRows, divergent: passed.divergence.divergentRows, built: passed.indexBuilt }, { missing: 0, divergent: 0, built: true });
});

// The fill walks each joint_storage server in idx_message_server_timeline_server_created's
// order (keyset on created_at, message_id), so its resume point carries the
// exact created_at: microseconds, and message_id for rows at the same instant.
test("message_server_timeline conversation_id fill resumes per server from an exact (created_at, message_id) position", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-convpos@test.com", name: "mstConvPos", passwordHash: "x", emailVerified: true }).returning();
  const storages = await db.insert(servers).values([
    { name: "MST CONVPOS A", slug: "mst-convpos-a", ownerId: owner!.id, kind: "joint_storage" },
    { name: "MST CONVPOS B", slug: "mst-convpos-b", ownerId: owner!.id, kind: "joint_storage" },
  ]).returning();
  const roots = await db.insert(channels).values(storages.map((server, i) => ({ serverId: server.id, name: `mst-convpos-${i}`, type: "joint" as const }))).returning();
  const ids: string[] = [];
  for (const root of roots) {
    const rows = await db.insert(messages).values(
      Array.from({ length: 3 }, (_, i) => ({ channelId: root.id, senderType: "user" as const, senderId: owner!.id, content: `pos ${i}` })),
    ).returning();
    ids.push(...rows.map((row) => row.id));
  }
  // Every row at one instant below a millisecond: only microseconds and
  // message_id tell the rows apart.
  await db.execute(sql`UPDATE messages SET created_at = '2026-11-20T08:00:00.123456Z' WHERE id = ANY(${sql.param(ids)}::uuid[])`);
  await db.update(messageServerTimeline).set({ conversationId: null }).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[])`);

  // Batch 1 (2 rows of the first server), then the slot stops the run.
  const readings: Array<CdcSlotReading | null> = [null, { retainedWalBytes: SLOT_STOP_BYTES + 1, walStatus: "reserved" }];
  let reads = 0;
  const lines: string[] = [];
  const stopped = await runMessageServerTimelineConversationBackfill(run, { batchSize: 2, sleepMs: 0, slotPollMs: 0, readSlot: async () => readings[reads++] ?? null, log: (line) => lines.push(line) });
  assert.equal(stopped.stoppedBy, "slot");
  assert.equal(stopped.rowsFilled, 2);
  const position = stopped.lastPosition!;
  assert.equal(position.createdAt, "2026-11-20T08:00:00.123456Z", "the exact stored time, not a millisecond Date");
  assert.deepEqual(parseConversationPosition(formatConversationPosition(position)), position);
  assert.ok(lines.some((line) => line.endsWith(`after_position=${formatConversationPosition(position)}`)));
  assert.equal(parseConversationPosition("not,a,position"), null);

  const resumed = await runMessageServerTimelineConversationBackfill(run, { batchSize: 2, sleepMs: 0, afterPosition: position, readSlot: async () => null });
  assert.equal(resumed.rowsScanned, 4, "the first server's last row, then the second server's three");
  assert.equal(resumed.rowsFilled, 4);
  const left = await db.select({ id: messageServerTimeline.messageId }).from(messageServerTimeline)
    .where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[]) AND ${messageServerTimeline.conversationId} IS NULL`);
  assert.equal(left.length, 0, "every row filled once across the stop");
  const verified = await verifyMessageServerTimelineConversation(run);
  assert.deepEqual({ missing: verified.missingRows, divergent: verified.divergentRows }, { missing: 0, divergent: 0 });
});

// A cold cache can push one batch past the statement timeout (production
// branch, 2026-11-20: 28.9-37.9 s for four of the first five 5,000-row
// batches). That batch is retried at half its size rather than ending the run.
test("message_server_timeline conversation_id fill retries a timed-out batch at half its size", async ({ db }) => {
  const exec = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-convretry@test.com", name: "mstConvRetry", passwordHash: "x", emailVerified: true }).returning();
  const [storage] = await db.insert(servers).values({ name: "MST CONVRETRY", slug: "mst-convretry", ownerId: owner!.id, kind: "joint_storage" }).returning();
  const [root] = await db.insert(channels).values({ serverId: storage!.id, name: "mst-convretry", type: "joint" }).returning();
  const rows = await db.insert(messages).values(
    Array.from({ length: 5 }, (_, i) => ({ channelId: root!.id, senderType: "user" as const, senderId: owner!.id, content: `retry ${i}` })),
  ).returning();
  const ids = rows.map((row) => row.id);
  await db.update(messageServerTimeline).set({ conversationId: null }).where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[])`);

  const timeout = () => new Error("query failed", { cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) });
  // Call 1 lists the joint storage servers; call 2 is the first batch.
  let calls = 0;
  const lines: string[] = [];
  const filled = await runMessageServerTimelineConversationBackfill(async (query) => {
    calls += 1;
    if (calls === 2) throw timeout();
    return exec(query);
  }, { batchSize: 4, sleepMs: 0, readSlot: async () => null, log: (line) => lines.push(line) });
  assert.equal(filled.timeoutRetries, 1);
  assert.equal(filled.rowsFilled, 5, "every row once, across the retry");
  assert.ok(lines.some((line) => line === "[MESSAGE_TIMELINE_CONVERSATION_BACKFILL_TIMEOUT] retrying at batch_size=2"));
  // 2 rows at half size, then back to 4: 2 + 3 (the last, short batch ends the server).
  assert.deepEqual(lines.filter((line) => line.includes("_BATCH]")).map((line) => /scanned=(\d+)/.exec(line)![1]), ["2", "3"]);
  const left = await db.select({ id: messageServerTimeline.messageId }).from(messageServerTimeline)
    .where(sql`${messageServerTimeline.messageId} = ANY(${sql.param(ids)}::uuid[]) AND ${messageServerTimeline.conversationId} IS NULL`);
  assert.equal(left.length, 0);

  // Any other failure still ends the run.
  calls = 0;
  await assert.rejects(() => runMessageServerTimelineConversationBackfill(async (query) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    return exec(query);
  }, { batchSize: 4, sleepMs: 0, readSlot: async () => null }), /deadlock/);
});
