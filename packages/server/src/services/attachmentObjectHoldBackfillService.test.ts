import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import {
  attachmentObjectHolds,
  attachmentObjects,
  attachmentUploadReservations,
  attachments,
  channels,
  messages,
  servers,
  users,
} from "../db/schema";
import {
  backfillAttachmentObjectHoldsBatch,
  reconcileAttachmentObjectHolds,
  reportCollectableAttachmentObjects,
  runAttachmentObjectHoldBackfill,
  withAttachmentObjectHoldReadSnapshot,
} from "./attachmentObjectHoldBackfillService";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const BACKFILL_AT = new Date("2026-11-01T00:00:00.000Z");

// Object ids sort in this order, so batches of two split them predictably.
const OBJECT = {
  linked: "a0000000-0000-4000-8000-000000000001",
  pending: "a0000000-0000-4000-8000-000000000002",
  revoked: "a0000000-0000-4000-8000-000000000003",
  alreadyHeld: "a0000000-0000-4000-8000-000000000004",
  collected: "a0000000-0000-4000-8000-000000000005",
  orphan: "a0000000-0000-4000-8000-000000000006",
  shared: "a0000000-0000-4000-8000-000000000007",
} as const;
const PROJECTION = {
  linked: "b0000000-0000-4000-8000-000000000001",
  pending: "b0000000-0000-4000-8000-000000000002",
  revoked: "b0000000-0000-4000-8000-000000000003",
  alreadyHeld: "b0000000-0000-4000-8000-000000000004",
  collected: "b0000000-0000-4000-8000-000000000005",
  sharedA: "b0000000-0000-4000-8000-000000000007",
  sharedB: "b0000000-0000-4000-8000-000000000008",
} as const;

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({ id: USER_ID, email: "hold-backfill@slock.test", name: "hold-backfill", passwordHash: "test" });
  await db.insert(servers).values({ id: SERVER_ID, name: "Hold backfill", slug: "hold-backfill", ownerId: USER_ID });
  await db.insert(channels).values({ id: CHANNEL_ID, serverId: SERVER_ID, name: "hold-backfill" });
  await db.insert(messages).values({ id: MESSAGE_ID, channelId: CHANNEL_ID, senderType: "user", senderId: USER_ID, content: "host" });
  const gc = { lifecycleState: "deleted" as const, gcToken: "c0000000-0000-4000-8000-000000000005", gcStartedAt: new Date("2026-10-01T00:00:00.000Z") };
  await db.insert(attachmentObjects).values(Object.entries(OBJECT).map(([label, id]) => ({
    id,
    originServerId: SERVER_ID,
    uploaderId: USER_ID,
    uploaderType: "user" as const,
    storageKey: `hold-backfill/${label}`,
    mimeType: "text/plain",
    sizeBytes: 10,
    ...(label === "collected" ? gc : {}),
  })));
  const projection = (id: string, objectId: string, extra: Partial<typeof attachments.$inferInsert>) => ({
    id,
    objectId,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user" as const,
    filename: `${id}.txt`,
    ...extra,
  });
  await db.insert(attachments).values([
    projection(PROJECTION.linked, OBJECT.linked, { messageId: MESSAGE_ID, messagePosition: 0 }),
    projection(PROJECTION.pending, OBJECT.pending, { pendingChannelId: CHANNEL_ID }),
    projection(PROJECTION.revoked, OBJECT.revoked, {
      messageId: MESSAGE_ID,
      messagePosition: 1,
      revokedAt: new Date("2026-10-01T00:00:00.000Z"),
      revokedById: USER_ID,
      revokedByType: "user",
    }),
    projection(PROJECTION.alreadyHeld, OBJECT.alreadyHeld, { messageId: MESSAGE_ID, messagePosition: 2 }),
    // A linked row on bytes that were already collected: reported, never held.
    projection(PROJECTION.collected, OBJECT.collected, { messageId: MESSAGE_ID, messagePosition: 3 }),
    projection(PROJECTION.sharedA, OBJECT.shared, { messageId: MESSAGE_ID, messagePosition: 4 }),
    projection(PROJECTION.sharedB, OBJECT.shared, { messageId: MESSAGE_ID, messagePosition: 5 }),
  ]);
  await db.insert(attachmentUploadReservations).values({
    id: PROJECTION.pending,
    objectId: OBJECT.pending,
    originServerId: SERVER_ID,
    channelId: CHANNEL_ID,
    creatorId: USER_ID,
    creatorType: "user",
    filename: "pending.txt",
    expiresAt: new Date("2026-11-01T01:00:00.000Z"),
  });
  await db.insert(attachmentObjectHolds).values({
    holderType: "attachment",
    holderId: PROJECTION.alreadyHeld,
    objectId: OBJECT.alreadyHeld,
  });
  return { client, db };
}

async function allHolds(db: Database) {
  return db.select({
    holderType: attachmentObjectHolds.holderType,
    holderId: attachmentObjectHolds.holderId,
    objectId: attachmentObjectHolds.objectId,
  }).from(attachmentObjectHolds).orderBy(asc(attachmentObjectHolds.objectId), asc(attachmentObjectHolds.holderId));
}

const EXPECTED_HOLDS = [
  { holderType: "attachment", holderId: PROJECTION.linked, objectId: OBJECT.linked },
  { holderType: "upload_reservation", holderId: PROJECTION.pending, objectId: OBJECT.pending },
  { holderType: "attachment", holderId: PROJECTION.alreadyHeld, objectId: OBJECT.alreadyHeld },
  { holderType: "attachment", holderId: PROJECTION.sharedA, objectId: OBJECT.shared },
  { holderType: "attachment", holderId: PROJECTION.sharedB, objectId: OBJECT.shared },
];

test("reconciliation names every holder without a hold before the backfill and is clean after", async () => {
  const { client, db } = await fixture();
  try {
    const before = await reconcileAttachmentObjectHolds(db, { sampleSize: 10 });
    assert.equal(before.ok, false);
    assert.deepEqual(before.objects, { active: 6, gc_pending: 0, deleted: 1 });
    assert.equal(before.missingAttachmentHolds.count, 3);
    assert.deepEqual(
      before.missingAttachmentHolds.sample.map((row) => row.attachmentId).sort(),
      [PROJECTION.linked, PROJECTION.sharedA, PROJECTION.sharedB],
    );
    assert.deepEqual(before.missingReservationHolds.sample, [{ reservationId: PROJECTION.pending, objectId: OBJECT.pending }]);
    assert.equal(before.referencedObjectsWithoutHold.count, 3);
    assert.deepEqual(before.referencedNonActiveObjects.sample, [{ objectId: OBJECT.collected, lifecycleState: "deleted" }]);
    assert.equal(before.holdsOnNonActiveObjects.count, 0);
    assert.equal(before.staleHolds.count, 0);
    assert.equal(before.unheldUntracked, 5);

    const run = await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 3 });
    assert.equal(run.done, true);
    assert.equal(run.totals.scannedObjects, 7);
    assert.equal(run.totals.attachmentHoldsInserted, 3);
    assert.equal(run.totals.reservationHoldsInserted, 1);
    assert.equal(run.totals.unheldSinceSet, 2, "the revoked-only and the orphan objects");

    const after = await reconcileAttachmentObjectHolds(db);
    assert.equal(after.ok, true);
    assert.deepEqual(after.holds, { attachment: 4, upload_reservation: 1 });
    assert.equal(after.unheldUntracked, 0);
    assert.equal(after.heldWithUnheldSince, 0);
    assert.equal(after.referencedNonActiveObjects.count, 1, "an anomaly that predates holds stays visible");
    assert.deepEqual(await allHolds(db), EXPECTED_HOLDS);
  } finally {
    await client.close();
  }
});

test("the backfill runs in bounded batches, resumes from its cursor, and is idempotent", async () => {
  const { client, db } = await fixture();
  try {
    // Left by an instance on the previous release ending a reservation mid-rollout.
    await db.insert(attachmentObjectHolds).values({
      holderType: "upload_reservation",
      holderId: PROJECTION.collected,
      objectId: OBJECT.collected,
    });
    assert.equal((await reconcileAttachmentObjectHolds(db)).holdsOnNonActiveObjects.count, 1);
    const first = await backfillAttachmentObjectHoldsBatch(db, { afterObjectId: null, limit: 2, now: BACKFILL_AT });
    assert.deepEqual(first, {
      scannedObjects: 2,
      activeObjects: 2,
      attachmentHoldsInserted: 1,
      reservationHoldsInserted: 1,
      unheldSinceSet: 0,
      unheldSinceCleared: 0,
      staleReservationHoldsRemoved: 0,
      staleAttachmentHoldsRemoved: 0,
      holdsOnNonActiveRemoved: 0,
      lastObjectId: OBJECT.pending,
      done: false,
    });
    // An interrupted run picks up after the last committed batch.
    const cursors: Array<string | null> = [];
    const resumed = await runAttachmentObjectHoldBackfill({
      db,
      cursor: first.lastObjectId,
      batchSize: 2,
      maxBatches: 1,
      onBatch: async (batch) => { cursors.push(batch.lastObjectId); },
    });
    assert.deepEqual(resumed, {
      batches: 1,
      cursor: OBJECT.alreadyHeld,
      done: false,
      totals: {
        scannedObjects: 2,
        attachmentHoldsInserted: 0,
        reservationHoldsInserted: 0,
        unheldSinceSet: 1,
        unheldSinceCleared: 0,
        staleReservationHoldsRemoved: 0,
        staleAttachmentHoldsRemoved: 0,
        holdsOnNonActiveRemoved: 0,
      },
    });
    assert.deepEqual(cursors, [OBJECT.alreadyHeld]);
    const rest = await runAttachmentObjectHoldBackfill({ db, cursor: resumed.cursor, batchSize: 2 });
    assert.equal(rest.done, true);
    assert.equal(rest.cursor, OBJECT.shared);
    assert.equal(rest.totals.holdsOnNonActiveRemoved, 1);
    assert.equal((await reconcileAttachmentObjectHolds(db)).ok, true);
    assert.deepEqual(await allHolds(db), EXPECTED_HOLDS);

    const [revoked] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, OBJECT.revoked));
    const unheldSince = revoked?.unheldSince?.toISOString();
    assert.ok(unheldSince);

    const again = await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 100 });
    assert.deepEqual(again.totals, {
      scannedObjects: 7,
      attachmentHoldsInserted: 0,
      reservationHoldsInserted: 0,
      unheldSinceSet: 0,
      unheldSinceCleared: 0,
      staleReservationHoldsRemoved: 0,
      staleAttachmentHoldsRemoved: 0,
      holdsOnNonActiveRemoved: 0,
    });
    const [revokedAgain] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, OBJECT.revoked));
    assert.equal(revokedAgain?.unheldSince?.toISOString(), unheldSince, "a re-run does not restart the grace clock");
    assert.deepEqual(await allHolds(db), EXPECTED_HOLDS);

    await assert.rejects(backfillAttachmentObjectHoldsBatch(db, { afterObjectId: "not-a-uuid", limit: 2 }), /cursor/);
    await assert.rejects(backfillAttachmentObjectHoldsBatch(db, { afterObjectId: null, limit: 0 }), /batch size/);
  } finally {
    await client.close();
  }
});

test("stale holds left by the previous release fail reconciliation and the backfill removes them", async () => {
  const { client, db } = await fixture();
  try {
    await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 100 });
    assert.equal((await reconcileAttachmentObjectHolds(db)).ok, true);

    // An instance on the previous release cancels the pending reservation and
    // revokes a linked attachment without touching holds; a channel/message
    // delete cascades one attachment row away under its hold.
    await db.update(attachmentUploadReservations).set({
      state: "canceled",
      terminalAt: BACKFILL_AT,
      terminalReason: "canceled",
    }).where(eq(attachmentUploadReservations.id, PROJECTION.pending));
    await db.update(attachments).set({
      revokedAt: BACKFILL_AT,
      revokedById: USER_ID,
      revokedByType: "user",
    }).where(eq(attachments.id, PROJECTION.linked));
    await db.delete(attachments).where(eq(attachments.id, PROJECTION.sharedB));

    const before = await reconcileAttachmentObjectHolds(db, { sampleSize: 10 });
    assert.equal(before.ok, false, "a stale hold blocks the cleanup of its object, so it fails reconciliation");
    assert.equal(before.missingAttachmentHolds.count, 0);
    assert.equal(before.missingReservationHolds.count, 0);
    assert.equal(before.staleHolds.count, 3);
    assert.deepEqual(
      before.staleHolds.sample.map((row) => `${row.holderType}:${row.holderId}`).sort(),
      [
        `attachment:${PROJECTION.linked}`,
        `attachment:${PROJECTION.sharedB}`,
        `upload_reservation:${PROJECTION.pending}`,
      ],
    );

    const run = await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 2 });
    assert.equal(run.done, true);
    assert.equal(run.totals.staleReservationHoldsRemoved, 1);
    assert.equal(run.totals.staleAttachmentHoldsRemoved, 2);
    assert.equal(run.totals.attachmentHoldsInserted, 0);
    assert.equal(run.totals.unheldSinceSet, 2, "the canceled reservation's and the revoked attachment's objects");

    const after = await reconcileAttachmentObjectHolds(db);
    assert.equal(after.ok, true);
    assert.equal(after.staleHolds.count, 0);
    assert.deepEqual(await allHolds(db), [
      { holderType: "attachment", holderId: PROJECTION.alreadyHeld, objectId: OBJECT.alreadyHeld },
      { holderType: "attachment", holderId: PROJECTION.sharedA, objectId: OBJECT.shared },
    ]);
    const unheld = await db.select({ id: attachmentObjects.id, unheldSince: attachmentObjects.unheldSince })
      .from(attachmentObjects)
      .where(and(eq(attachmentObjects.lifecycleState, "active"), sql`${attachmentObjects.unheldSince} IS NOT NULL`))
      .orderBy(asc(attachmentObjects.id));
    assert.deepEqual(unheld.map((row) => row.id), [OBJECT.linked, OBJECT.pending, OBJECT.revoked, OBJECT.orphan]);

    // A pending reservation's hold is never stale.
    await db.update(attachmentUploadReservations).set({ state: "pending", terminalAt: null, terminalReason: null })
      .where(eq(attachmentUploadReservations.id, PROJECTION.pending));
    await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 100 });
    const again = await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 100 });
    assert.equal(again.totals.staleReservationHoldsRemoved, 0);
    assert.equal(again.totals.reservationHoldsInserted, 0);
    assert.equal((await reconcileAttachmentObjectHolds(db)).ok, true);
  } finally {
    await client.close();
  }
});

test("reconcile and report read one READ ONLY snapshot with a statement_timeout", async () => {
  const { client, db } = await fixture();
  try {
    const settings = await withAttachmentObjectHoldReadSnapshot(db, { statementTimeoutMs: 45_000 }, async (tx) => {
      const [row] = (await tx.execute(sql`
        SELECT current_setting('transaction_read_only') AS read_only,
               current_setting('transaction_isolation') AS isolation,
               current_setting('statement_timeout') AS statement_timeout
      `)).rows as Array<Record<string, string>>;
      await assert.rejects(
        tx.execute(sql`UPDATE attachment_objects SET unheld_since = NULL`),
        (error: unknown) => /read-only transaction/.test(String((error as { cause?: unknown }).cause ?? error)),
      );
      return row;
    });
    assert.deepEqual(settings, { read_only: "on", isolation: "repeatable read", statement_timeout: "45s" });

    const configs: unknown[] = [];
    const recording = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (fn: Parameters<Database["transaction"]>[0], config?: Parameters<Database["transaction"]>[1]) => {
          configs.push(config);
          return target.transaction(fn, config);
        };
      },
    });
    await reconcileAttachmentObjectHolds(recording, { statementTimeoutMs: 5_000 });
    await reportCollectableAttachmentObjects(recording, {});
    assert.deepEqual(configs, [
      { isolationLevel: "repeatable read", accessMode: "read only" },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);
  } finally {
    await client.close();
  }
});

test("a batch that cannot get its locks within lock_timeout rolls back and is retried", async () => {
  const { client, db } = await fixture();
  try {
    let attempts = 0;
    const failing = {
      ...db,
      transaction: async (...args: Parameters<Database["transaction"]>) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        return db.transaction(...args);
      },
    } as unknown as Database;
    const records: Array<Record<string, unknown>> = [];
    const run = await runAttachmentObjectHoldBackfill({
      db: failing,
      cursor: null,
      batchSize: 100,
      log: (record) => records.push(record),
    });
    assert.equal(run.done, true);
    assert.equal(attempts, 2);
    assert.equal(records[0]?.event, "attachment_object_holds.backfill.retry");
    assert.equal(records[0]?.code, "55P03");
  } finally {
    await client.close();
  }
});

test("the record-only report lists unheld objects past the grace period and flags any still referenced", async () => {
  const { client, db } = await fixture();
  try {
    await runAttachmentObjectHoldBackfill({ db, cursor: null, batchSize: 100 });
    await db.update(attachmentObjects).set({ unheldSince: BACKFILL_AT })
      .where(eq(attachmentObjects.id, OBJECT.revoked));
    await db.update(attachmentObjects).set({ unheldSince: new Date("2026-11-20T00:00:00.000Z") })
      .where(eq(attachmentObjects.id, OBJECT.orphan));

    const inside = await reportCollectableAttachmentObjects(db, { now: new Date("2026-11-30T00:00:00.000Z") });
    assert.equal(inside.candidates, 0, "nothing is eligible inside 30 days");
    assert.equal(inside.unheldWithinGrace, 2);

    const report = await reportCollectableAttachmentObjects(db, { now: new Date("2026-12-05T00:00:00.000Z") });
    assert.deepEqual(report, {
      mode: "record_only",
      graceDays: 30,
      cutoff: "2026-11-05T00:00:00.000Z",
      candidates: 1,
      candidateBytes: 10,
      oldestUnheldSince: BACKFILL_AT.toISOString(),
      newestUnheldSince: BACKFILL_AT.toISOString(),
      sampleObjectIds: [OBJECT.revoked],
      stillReferenced: { count: 0, sample: [] },
      unheldUntracked: 0,
      unheldWithinGrace: 1,
    });

    // A hold-less object a holder still references must show up as a blocker.
    await db.delete(attachmentObjectHolds).where(eq(attachmentObjectHolds.objectId, OBJECT.linked));
    await db.update(attachmentObjects).set({ unheldSince: BACKFILL_AT }).where(eq(attachmentObjects.id, OBJECT.linked));
    const unsafe = await reportCollectableAttachmentObjects(db, { now: new Date("2026-12-05T00:00:00.000Z") });
    assert.equal(unsafe.candidates, 2);
    assert.deepEqual(unsafe.stillReferenced, { count: 1, sample: [{ objectId: OBJECT.linked }] });

    // The report changes nothing.
    const objects = await db.select({ state: attachmentObjects.lifecycleState }).from(attachmentObjects);
    assert.equal(objects.filter((row) => row.state === "active").length, 6);
  } finally {
    await client.close();
  }
});
