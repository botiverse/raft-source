import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  attachmentObjectCharges,
  attachmentObjects,
  attachmentUploadReservations,
  attachments,
  channels,
  messages,
  servers,
  users,
} from "../db/schema.js";
import {
  backfillLegacyAttachmentObjectsBatch,
  evaluateAttachmentObjectCompletionGate,
  evaluateAttachmentObjectPreflight,
  getAttachmentObjectParityReport,
} from "./attachmentObjectBackfillService.js";

/** Two servers in one database: the canary target and a bystander. */
async function twoServerFixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, name: userId, passwordHash: "test" });

  const make = async (label: string) => {
    const serverId = randomUUID();
    const channelId = randomUUID();
    await db.insert(servers).values({ id: serverId, name: label, slug: `${label}-${serverId}`, ownerId: userId });
    await db.insert(channels).values({ id: channelId, serverId, name: label });
    const [message] = await db.insert(messages).values({
      channelId, senderType: "user", senderId: userId, content: label,
    }).returning();
    return { serverId, channelId, messageId: message.id };
  };
  const target = await make("target");
  const bystander = await make("bystander");

  const attach = async (where: { channelId: string; messageId: string }, storageKey: string) => {
    const id = randomUUID();
    await db.insert(attachments).values({
      id,
      messageId: where.messageId,
      channelId: where.channelId,
      uploaderId: userId,
      uploaderType: "user" as const,
      filename: `${storageKey}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      storageKey,
      objectId: null,
    });
    return id;
  };
  // Target: one ordinary NULL plus a shared-storage-key pair (two projections,
  // one physical key — the contract says two distinct objects).
  const targetPlain = await attach(target, `target/plain-${randomUUID()}`);
  const sharedKey = `shared/${randomUUID()}`;
  const targetSharedA = await attach(target, sharedKey);
  const targetSharedB = await attach(target, sharedKey);
  // Bystander: a NULL that a scoped run must not touch.
  const bystanderNull = await attach(bystander, `bystander/${randomUUID()}`);

  return {
    client, db, userId, target, bystander,
    targetPlain, targetSharedA, targetSharedB, bystanderNull,
  };
}

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  const userId = randomUUID();
  const serverId = randomUUID();
  const channelId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, name: userId, passwordHash: "test" });
  await db.insert(servers).values({ id: serverId, name: "Backfill", slug: `backfill-${serverId}`, ownerId: userId });
  await db.insert(channels).values({ id: channelId, serverId, name: "backfill" });
  const [message] = await db.insert(messages).values({
    channelId,
    senderType: "user",
    senderId: userId,
    content: "host",
  }).returning();
  return { client, db, userId, serverId, channelId, messageId: message.id };
}

test("parallel and restarted Phase C workers preserve one legacy row to one uncharged object", async () => {
  const { client, db, userId, channelId, messageId } = await fixture();
  try {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: randomUUID(),
      messageId: index < 3 ? messageId : null,
      channelId,
      uploaderId: userId,
      uploaderType: "user" as const,
      filename: `${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: index + 1,
      storageKey: index < 2 ? "shared/backfill.txt" : `backfill/${index}.txt`,
    }));
    await db.insert(attachments).values(rows);

    const results = await Promise.all([
      backfillLegacyAttachmentObjectsBatch(db, 2),
      backfillLegacyAttachmentObjectsBatch(db, 2),
      backfillLegacyAttachmentObjectsBatch(db, 2),
    ]);
    assert.equal(results.reduce((sum, result) => sum + result.completed, 0), 5);
    assert.deepEqual(await backfillLegacyAttachmentObjectsBatch(db, 10), { claimed: 0, completed: 0 });

    const projections = await db.select().from(attachments);
    assert.equal(new Set(projections.map((row) => row.objectId)).size, 5);
    assert.ok(projections.every((row) => row.objectId !== null));
    assert.ok(projections.every((row) => row.createdById === userId && row.createdByType === "user"));
    assert.ok(projections.every((row) => row.messageId === null
      ? row.pendingChannelId === channelId
      : row.pendingChannelId === null));
    assert.equal((await db.select().from(attachmentObjects)).length, 5);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 0);
    const reservations = await db.select().from(attachmentUploadReservations);
    assert.equal(reservations.length, 2, "every migrated pending projection gets its same-id reservation");
    for (const reservation of reservations) {
      const projection = projections.find((row) => row.id === reservation.id);
      assert.ok(projection && projection.messageId === null);
      assert.equal(reservation.objectId, projection.objectId);
      assert.equal(reservation.channelId, projection.channelId);
      assert.equal(reservation.state, "pending");
      assert.equal(
        reservation.expiresAt.getTime(),
        projection.createdAt.getTime() + 60 * 60 * 1000,
        "historical expiry preserves the frozen one-hour policy",
      );
    }
    assert.deepEqual(await getAttachmentObjectParityReport(db), {
      totalProjections: 5,
      nullObjectIds: 0,
      orphanNullObjectIds: 0,
      objectRows: 5,
      danglingObjectIds: 0,
      metadataMismatches: 0,
      detachedObjects: 0,
      duplicateStorageKeyGroups: 1,
      objectBackedPendingWithoutReservation: 0,
      pendingFoundationMismatches: 0,
      orphanPendingReservations: 0,
    });
  } finally {
    await client.close();
  }
});

test("backfill failure rolls back both object insertion and projection binding", async () => {
  const { client, db, userId, channelId } = await fixture();
  try {
    const projectionId = randomUUID();
    await db.insert(attachments).values({
      id: projectionId,
      channelId,
      uploaderId: userId,
      uploaderType: "user",
      filename: "rollback.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
      storageKey: "backfill/rollback.txt",
    });
    await assert.rejects(
      backfillLegacyAttachmentObjectsBatch(db, 1, {
        afterObjectInsert: async () => { throw new Error("injected backfill failure"); },
      }),
      /injected backfill failure/,
    );
    assert.equal((await db.select().from(attachmentObjects)).length, 0);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 0);
    assert.equal((await db.select().from(attachmentUploadReservations)).length, 0);
    assert.equal((await db.select().from(attachments))[0]?.objectId, null);
  } finally {
    await client.close();
  }
});

test("an earlier object-only backfill is completed by adding the same-id pending reservation", async () => {
  const { client, db, userId, serverId, channelId } = await fixture();
  try {
    const projectionId = randomUUID();
    const objectId = randomUUID();
    const createdAt = new Date("2026-08-12T10:00:00.000Z");
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: serverId,
      uploaderId: userId,
      uploaderType: "user",
      storageKey: "backfill/object-only.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      createdAt,
    });
    await db.insert(attachments).values({
      id: projectionId,
      objectId,
      messageId: null,
      pendingChannelId: channelId,
      channelId,
      uploaderId: userId,
      uploaderType: "user",
      filename: "object-only.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      storageKey: "backfill/object-only.bin",
      createdAt,
    });

    const before = await getAttachmentObjectParityReport(db);
    assert.equal(before.nullObjectIds, 0);
    assert.equal(before.objectBackedPendingWithoutReservation, 1);
    assert.deepEqual(await backfillLegacyAttachmentObjectsBatch(db, 100), { claimed: 1, completed: 1 });

    const [reservation] = await db.select().from(attachmentUploadReservations);
    assert.equal(reservation?.id, projectionId);
    assert.equal(reservation?.objectId, objectId);
    assert.equal((await db.select().from(attachmentObjects)).length, 1, "the object is not duplicated");
    assert.deepEqual(await backfillLegacyAttachmentObjectsBatch(db, 100), { claimed: 0, completed: 0 });
    assert.equal((await getAttachmentObjectParityReport(db)).objectBackedPendingWithoutReservation, 0);
  } finally {
    await client.close();
  }
});

test("one immutable object with multiple closed pending projections passes parity and preflight", async () => {
  const { client, db, userId, serverId, channelId } = await fixture();
  try {
    const objectId = randomUUID();
    const projectionIds = [randomUUID(), randomUUID()];
    const createdAt = new Date("2026-08-12T10:00:00.000Z");
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: serverId,
      uploaderId: userId,
      uploaderType: "user",
      storageKey: "backfill/shared-object.bin",
      contentHash: "a".repeat(64),
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      createdAt,
    });
    await db.insert(attachments).values(projectionIds.map((id) => ({
      id,
      objectId,
      messageId: null,
      pendingChannelId: channelId,
      createdById: userId,
      createdByType: "user" as const,
      channelId,
      uploaderId: userId,
      uploaderType: "user" as const,
      filename: "shared-object.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      storageKey: "backfill/shared-object.bin",
      contentHash: "a".repeat(64),
      createdAt,
    })));
    await db.insert(attachmentUploadReservations).values(projectionIds.map((id) => ({
      id,
      objectId,
      originServerId: serverId,
      channelId,
      creatorId: userId,
      creatorType: "user" as const,
      filename: "shared-object.bin",
      expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1_000),
      createdAt,
      updatedAt: createdAt,
    })));

    const parity = await getAttachmentObjectParityReport(db);
    assert.equal(parity.pendingFoundationMismatches, 0);
    assert.equal(parity.objectBackedPendingWithoutReservation, 0);
    assert.equal(parity.orphanPendingReservations, 0);
    assert.deepEqual(evaluateAttachmentObjectCompletionGate(parity), { complete: true, failures: [] });
    assert.deepEqual(evaluateAttachmentObjectPreflight(parity), { safeToApply: true, reason: null });
  } finally {
    await client.close();
  }
});

test("a non-active object-backed pending row is a blocker and is never repaired", async () => {
  const { client, db, userId, serverId, channelId } = await fixture();
  try {
    const objectId = randomUUID();
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: serverId,
      uploaderId: userId,
      uploaderType: "user",
      storageKey: "backfill/non-active.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      lifecycleState: "gc_pending",
      gcToken: randomUUID(),
      gcStartedAt: new Date(),
    });
    await db.insert(attachments).values({
      id: randomUUID(),
      objectId,
      messageId: null,
      pendingChannelId: channelId,
      channelId,
      uploaderId: userId,
      uploaderType: "user",
      filename: "non-active.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      storageKey: "backfill/non-active.bin",
    });

    const before = await getAttachmentObjectParityReport(db);
    assert.equal(before.objectBackedPendingWithoutReservation, 0);
    assert.equal(before.pendingFoundationMismatches, 1);
    assert.deepEqual(await backfillLegacyAttachmentObjectsBatch(db, 100), { claimed: 0, completed: 0 });
    assert.equal((await db.select().from(attachmentUploadReservations)).length, 0);
  } finally {
    await client.close();
  }
});

test("a reservation bound to the same object under another id is a blocker, not an insert conflict", async () => {
  const { client, db, userId, serverId, channelId } = await fixture();
  try {
    const objectId = randomUUID();
    const projectionId = randomUUID();
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: serverId,
      uploaderId: userId,
      uploaderType: "user",
      storageKey: "backfill/wrong-reservation-id.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
    });
    await db.insert(attachments).values({
      id: projectionId,
      objectId,
      messageId: null,
      pendingChannelId: channelId,
      channelId,
      uploaderId: userId,
      uploaderType: "user",
      filename: "wrong-reservation-id.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 9,
      storageKey: "backfill/wrong-reservation-id.bin",
    });
    await db.insert(attachmentUploadReservations).values({
      id: randomUUID(),
      objectId,
      originServerId: serverId,
      channelId,
      creatorId: userId,
      creatorType: "user",
      filename: "wrong-reservation-id.bin",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const before = await getAttachmentObjectParityReport(db);
    assert.equal(before.objectBackedPendingWithoutReservation, 1);
    assert.equal(before.pendingFoundationMismatches, 0);
    assert.equal(before.orphanPendingReservations, 1);
    assert.deepEqual(await backfillLegacyAttachmentObjectsBatch(db, 100), { claimed: 0, completed: 0 });
  } finally {
    await client.close();
  }
});

test("a send that wins after claim prevents reservation synthesis and rolls the object back", async () => {
  const { client, db, userId, channelId, messageId } = await fixture();
  try {
    const projectionId = randomUUID();
    await db.insert(attachments).values({
      id: projectionId,
      messageId: null,
      channelId,
      uploaderId: userId,
      uploaderType: "user",
      filename: "send-race.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
      storageKey: "backfill/send-race.txt",
    });
    await assert.rejects(
      backfillLegacyAttachmentObjectsBatch(db, 1, {
        afterProjectionClaim: async (id, tx) => {
          await tx.update(attachments).set({ messageId }).where(eq(attachments.id, id));
        },
      }),
      /changed while backfill lock was held/,
    );
    assert.equal((await db.select().from(attachmentObjects)).length, 0);
    assert.equal((await db.select().from(attachmentUploadReservations)).length, 0);
    assert.equal((await db.select().from(attachments))[0]?.messageId, null, "the injected send rolls back too");
  } finally {
    await client.close();
  }
});

test("a scoped backfill touches the target only, and leaves the bystander row-for-row identical", async () => {
  const f = await twoServerFixture();
  try {
    const before = await f.db.select().from(attachments).where(eq(attachments.id, f.bystanderNull));

    // Scoped claim: three target projections exist, the bystander must not be claimed.
    const first = await backfillLegacyAttachmentObjectsBatch(f.db, 100, {}, f.target.serverId);
    assert.equal(first.completed, 3, "exactly the target's three projections");

    const after = await f.db.select().from(attachments).where(eq(attachments.id, f.bystanderNull));
    assert.deepEqual(after, before, "the bystander projection must be byte-for-byte unchanged");
    assert.equal(after[0]?.objectId, null, "and still unmigrated");

    // The shared storage key yields TWO objects, not one merged row.
    const objs = await f.db.select().from(attachmentObjects);
    assert.equal(objs.length, 3, "one deterministic object per target projection");

    // Scoped rerun is idempotent: nothing left to claim.
    const second = await backfillLegacyAttachmentObjectsBatch(f.db, 100, {}, f.target.serverId);
    assert.equal(second.claimed, 0, "a scoped rerun claims nothing");
    assert.equal((await f.db.select().from(attachmentObjects)).length, 3, "and creates no new objects");

    // Scoped parity sees the target as complete while the bystander is still NULL.
    const scoped = await getAttachmentObjectParityReport(f.db, f.target.serverId);
    assert.equal(scoped.nullObjectIds, 0, "target reached zero");
    const global = await getAttachmentObjectParityReport(f.db);
    assert.equal(global.nullObjectIds, 1, "the bystander's NULL is still there — and must not block the target");
  } finally {
    await f.client.close();
  }
});

test("a scoped batch rolls back when a claimed projection leaves the target before write-back", async () => {
  const f = await twoServerFixture();
  try {
    const targetProjectionIds = new Set<string>([
      f.targetPlain,
      f.targetSharedA,
      f.targetSharedB,
    ]);
    const sortedBy = <T>(rows: T[], key: (row: T) => string) =>
      [...rows].sort((left, right) => key(left).localeCompare(key(right)));
    const readTargetProjections = async () => sortedBy(
      await f.db.select().from(attachments)
        .where(eq(attachments.channelId, f.target.channelId)),
      (row) => row.id,
    );

    const before = {
      projections: await readTargetProjections(),
      objects: sortedBy(await f.db.select().from(attachmentObjects), (row) => row.id),
      charges: sortedBy(await f.db.select().from(attachmentObjectCharges), (row) => row.objectId),
      channel: await f.db.select().from(channels)
        .where(eq(channels.id, f.target.channelId)),
    };

    await assert.rejects(
      backfillLegacyAttachmentObjectsBatch(f.db, 100, {
        afterObjectInsert: async (projectionId, tx) => {
          assert.ok(targetProjectionIds.has(projectionId), "the hook runs after a target projection was claimed");
          await tx.update(channels)
            .set({ serverId: f.bystander.serverId })
            .where(eq(channels.id, f.target.channelId));
        },
      }, f.target.serverId),
      (error: Error) => {
        assert.match(
          error.message,
          /write-back scope guard rejected the batch/,
          "the named scope guard must reject the stale claim",
        );
        assert.doesNotMatch(error.message, /timeout|deadlock/i, "a fixture self-lock is not guard evidence");
        return true;
      },
    );

    assert.deepEqual(await readTargetProjections(), before.projections, "projection writes roll back with the batch");
    assert.deepEqual(
      sortedBy(await f.db.select().from(attachmentObjects), (row) => row.id),
      before.objects,
      "the object inserted before the guard also rolls back",
    );
    assert.deepEqual(
      sortedBy(await f.db.select().from(attachmentObjectCharges), (row) => row.objectId),
      before.charges,
      "the failed batch leaves no persistent charge write",
    );
    assert.deepEqual(
      await f.db.select().from(channels).where(eq(channels.id, f.target.channelId)),
      before.channel,
      "the same-transaction reparent used by the race tooth rolls back too",
    );
  } finally {
    await f.client.close();
  }
});

test("the unscoped default still processes both servers", async () => {
  const f = await twoServerFixture();
  try {
    const result = await backfillLegacyAttachmentObjectsBatch(f.db, 100);
    assert.equal(result.completed, 4, "all four projections across both servers");
    assert.equal((await getAttachmentObjectParityReport(f.db)).nullObjectIds, 0);
  } finally {
    await f.client.close();
  }
});

test("a bystander metadata mismatch never counts against the target's scoped parity", async () => {
  // The precedence bug this pins: with the seven mismatch branches unbracketed,
  // `A OR B OR ... OR G AND inScope` attaches the scope to G only, so a
  // bystander's storage_key mismatch (branch A) leaked into the target's count.
  // Corrupting branch A specifically is what makes the test discriminating —
  // corrupting the last branch would pass even with the bug.
  const f = await twoServerFixture();
  try {
    await backfillLegacyAttachmentObjectsBatch(f.db, 100);
    const [obj] = await f.db.select().from(attachmentObjects).limit(1);
    assert.ok(obj, "objects exist after the unscoped run");

    // Break the bystander's projection→object metadata on the FIRST branch.
    const [bystanderRow] = await f.db.select().from(attachments)
      .where(eq(attachments.id, f.bystanderNull));
    await f.db.update(attachmentObjects)
      .set({ storageKey: `drifted-${randomUUID()}` })
      .where(eq(attachmentObjects.id, bystanderRow.objectId!));

    const target = await getAttachmentObjectParityReport(f.db, f.target.serverId);
    assert.equal(target.metadataMismatches, 0, "a bystander's mismatch must not enter the target's parity");

    const global = await getAttachmentObjectParityReport(f.db);
    assert.equal(global.metadataMismatches, 1, "and the global view must still see it");
  } finally {
    await f.client.close();
  }
});
