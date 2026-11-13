import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import {
  attachmentObjectGcJobs,
  attachmentObjectHolds,
  attachmentObjects,
  attachmentUploadReservations,
  channels,
  messages,
  servers,
  users,
} from "../db/schema";
import type { StorageBackend } from "./storageService";
import {
  cancelAttachmentReservation,
  expireAttachmentReservation,
  runAttachmentLifecycleSweep,
} from "./attachmentLifecycleService";
import {
  AttachmentObjectHoldError,
  addAttachmentObjectHoldWithExecutor,
  removeAttachmentObjectHoldWithExecutor,
} from "./attachmentObjectHoldService";
import {
  createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor,
  createPendingAttachmentProjectionWithExecutor,
} from "./attachmentProjectionWriterService";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const COMPLETED_AT = new Date("2026-08-12T00:00:00.000Z");
const SENT_AT = new Date("2026-08-12T00:30:00.000Z");
const EXPIRED_AT = new Date("2026-08-12T01:00:00.000Z");

class FakeStorage implements StorageBackend {
  readonly deletes: string[] = [];
  async put(): Promise<void> {}
  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(key: string): Promise<void> { this.deletes.push(key); }
}

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({ id: USER_ID, email: "holds@slock.test", name: "holds", passwordHash: "test" });
  await db.insert(servers).values({ id: SERVER_ID, name: "Holds", slug: "holds", ownerId: USER_ID });
  await db.insert(channels).values({ id: CHANNEL_ID, serverId: SERVER_ID, name: "holds" });
  await db.insert(messages).values({
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: USER_ID,
    content: "host",
  });
  return { client, db };
}

async function upload(db: Database, id: string) {
  const objectId = randomUUID();
  const transferIntentId = randomUUID();
  const storageKey = `${SERVER_ID}/${id}`;
  await createAttachmentTransferIntent({
    id: transferIntentId,
    reservationId: id,
    objectId,
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    filename: `${id}.txt`,
    mimeType: "text/plain",
    declaredSizeBytes: 42,
    expiresAt: new Date(COMPLETED_AT.getTime() + 15 * 60 * 1000),
    artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType: "text/plain" }),
  }, db, COMPLETED_AT);
  const projection = await db.transaction((tx) => createPendingAttachmentProjectionWithExecutor(tx, {
    id,
    objectId,
    transferIntentId,
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 42,
    storageKey,
  }, COMPLETED_AT));
  return { id, objectId: projection.objectId! };
}

async function holdsOf(db: Database, objectId: string) {
  return db.select({
    holderType: attachmentObjectHolds.holderType,
    holderId: attachmentObjectHolds.holderId,
  }).from(attachmentObjectHolds)
    .where(eq(attachmentObjectHolds.objectId, objectId))
    .orderBy(asc(attachmentObjectHolds.holderType), asc(attachmentObjectHolds.holderId));
}

async function objectRow(db: Database, objectId: string) {
  const [row] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, objectId));
  assert.ok(row);
  return row;
}

test("a completed upload is held by its pending reservation", async () => {
  const { client, db } = await fixture();
  try {
    const { id, objectId } = await upload(db, "55555555-5555-4555-8555-555555555555");
    assert.deepEqual(await holdsOf(db, objectId), [{ holderType: "upload_reservation", holderId: id }]);
    assert.equal((await objectRow(db, objectId)).unheldSince, null);
  } finally {
    await client.close();
  }
});

test("send moves the hold from the reservation to the linked attachment in the same transaction", async () => {
  const { client, db } = await fixture();
  try {
    const { id, objectId } = await upload(db, "66666666-6666-4666-8666-666666666666");
    await db.transaction((tx) => linkAttachmentsToMessageWithExecutor(tx, [id], MESSAGE_ID, USER_ID, "new", SENT_AT));
    assert.deepEqual(await holdsOf(db, objectId), [{ holderType: "attachment", holderId: id }]);
    // The object was never without a hold, so it never became unheld.
    assert.equal((await objectRow(db, objectId)).unheldSince, null);

    // A failed send leaves the reservation hold exactly as it was.
    const second = await upload(db, "67676767-6767-4767-8767-676767676767");
    const [other] = await db.insert(messages).values({
      channelId: CHANNEL_ID,
      senderType: "user",
      senderId: USER_ID,
      content: "rolled back",
    }).returning();
    await assert.rejects(db.transaction(async (tx) => {
      await linkAttachmentsToMessageWithExecutor(tx, [second.id], other!.id, USER_ID, "new", SENT_AT);
      throw new Error("rollback after linking");
    }), /rollback after linking/);
    assert.deepEqual(await holdsOf(db, second.objectId), [{ holderType: "upload_reservation", holderId: second.id }]);

    // A reservation written before holds existed has no hold to hand over:
    // the send adds the attachment's hold instead.
    const legacy = await upload(db, "68686868-6868-4868-8868-686868686868");
    await db.delete(attachmentObjectHolds).where(eq(attachmentObjectHolds.objectId, legacy.objectId));
    await db.transaction((tx) => linkAttachmentsToMessageWithExecutor(tx, [legacy.id], other!.id, USER_ID, "new", SENT_AT));
    assert.deepEqual(await holdsOf(db, legacy.objectId), [{ holderType: "attachment", holderId: legacy.id }]);
    assert.equal((await objectRow(db, legacy.objectId)).unheldSince, null);
  } finally {
    await client.close();
  }
});

test("cancel and expiry drop the reservation hold and the existing cleanup still collects the bytes", async () => {
  const { client, db } = await fixture();
  try {
    const canceled = await upload(db, "77777777-7777-4777-8777-777777777777");
    const expired = await upload(db, "78787878-7878-4878-8878-787878787878");
    const cancelAt = new Date("2026-08-12T00:10:00.000Z");
    assert.equal((await cancelAttachmentReservation(canceled.id, cancelAt, db))?.state, "canceled");
    assert.equal((await expireAttachmentReservation(expired.id, EXPIRED_AT, db))?.state, "expired");

    for (const [{ objectId }, at] of [[canceled, cancelAt], [expired, EXPIRED_AT]] as const) {
      assert.deepEqual(await holdsOf(db, objectId), []);
      const object = await objectRow(db, objectId);
      assert.equal(object.lifecycleState, "gc_pending", "unchanged: the reservation cleanup claims unreferenced bytes");
      assert.equal(object.unheldSince?.toISOString(), at.toISOString());
    }
    const storage = new FakeStorage();
    const sweep = await runAttachmentLifecycleSweep({ db, now: EXPIRED_AT, storage, cdnStorage: null, metrics: null });
    assert.equal(sweep.gcCompleted, 2);
    assert.deepEqual(storage.deletes.sort(), [`${SERVER_ID}/${canceled.id}`, `${SERVER_ID}/${expired.id}`].sort());
  } finally {
    await client.close();
  }
});

test("the existing cleanup never claims an object that still has any hold", async () => {
  const { client, db } = await fixture();
  try {
    const { id, objectId } = await upload(db, "79797979-7979-4979-8979-797979797979");
    // Stands in for a future app holder (an Artifact version file).
    await db.transaction((tx) => addAttachmentObjectHoldWithExecutor(tx, {
      holderType: "attachment",
      holderId: "app-holder-stand-in",
      objectId,
    }));
    assert.equal((await expireAttachmentReservation(id, EXPIRED_AT, db))?.state, "expired");
    const object = await objectRow(db, objectId);
    assert.equal(object.lifecycleState, "active");
    assert.equal(object.unheldSince, null);
    assert.equal((await db.select().from(attachmentObjectGcJobs)).length, 0);
    assert.deepEqual(await holdsOf(db, objectId), [{ holderType: "attachment", holderId: "app-holder-stand-in" }]);
  } finally {
    await client.close();
  }
});

test("adding a hold requires an active object and is idempotent; unheld_since follows the last hold", async () => {
  const { client, db } = await fixture();
  try {
    const { id, objectId } = await upload(db, "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a");
    const extra = { holderType: "attachment" as const, holderId: randomUUID(), objectId };
    await db.transaction((tx) => addAttachmentObjectHoldWithExecutor(tx, extra));
    await db.transaction((tx) => addAttachmentObjectHoldWithExecutor(tx, extra));
    assert.equal((await holdsOf(db, objectId)).length, 2);

    const reservationHold = { holderType: "upload_reservation" as const, holderId: id, objectId };
    const removedAt = new Date("2026-08-20T00:00:00.000Z");
    assert.equal(await db.transaction((tx) => removeAttachmentObjectHoldWithExecutor(tx, reservationHold, removedAt)), 1);
    assert.equal((await objectRow(db, objectId)).unheldSince, null, "another hold remains");
    assert.equal(await db.transaction((tx) => removeAttachmentObjectHoldWithExecutor(tx, extra, removedAt)), 1);
    assert.equal((await objectRow(db, objectId)).unheldSince?.toISOString(), removedAt.toISOString());
    assert.equal(await db.transaction((tx) => removeAttachmentObjectHoldWithExecutor(tx, extra, new Date())), 0);
    assert.equal(
      (await objectRow(db, objectId)).unheldSince?.toISOString(),
      removedAt.toISOString(),
      "removing a hold that is already gone does not move the clock",
    );

    await db.transaction((tx) => addAttachmentObjectHoldWithExecutor(tx, extra));
    assert.equal((await objectRow(db, objectId)).unheldSince, null, "a new hold clears unheld_since");

    for (const lifecycleState of ["gc_pending", "deleted"] as const) {
      await db.update(attachmentObjects).set({ lifecycleState, gcToken: randomUUID(), gcStartedAt: new Date() })
        .where(eq(attachmentObjects.id, objectId));
      await assert.rejects(
        db.transaction((tx) => addAttachmentObjectHoldWithExecutor(tx, {
          holderType: "attachment",
          holderId: randomUUID(),
          objectId,
        })),
        (error: unknown) => error instanceof AttachmentObjectHoldError && error.lifecycleState === lifecycleState,
      );
    }
    await assert.rejects(
      db.transaction((tx) => addAttachmentObjectHoldWithExecutor(tx, {
        holderType: "attachment",
        holderId: randomUUID(),
        objectId: randomUUID(),
      })),
      (error: unknown) => error instanceof AttachmentObjectHoldError && error.lifecycleState === null,
    );
    // The blob row cannot be deleted while a hold names it.
    await assert.rejects(db.delete(attachmentObjects).where(eq(attachmentObjects.id, objectId)));
  } finally {
    await client.close();
  }
});

test("reusing an existing object for a new reservation adds that reservation's hold; a non-active object is refused", async () => {
  const { client, db } = await fixture();
  try {
    const objectId = "abababab-abab-4bab-8bab-abababababab";
    const contentHash = "a".repeat(64);
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: SERVER_ID,
      uploaderId: USER_ID,
      uploaderType: "user",
      storageKey: "holds/shared-object.txt",
      contentHash,
      mimeType: "text/plain",
      sizeBytes: 12,
      unheldSince: new Date("2026-08-01T00:00:00.000Z"),
    });
    const input = {
      id: "acacacac-acac-4cac-8cac-acacacacacac",
      objectId,
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      uploaderId: "external-actor",
      uploaderType: "external_projection" as const,
      filename: "shared-object.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      contentHash,
    };
    await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(tx, input, COMPLETED_AT));
    assert.deepEqual(await holdsOf(db, objectId), [{ holderType: "upload_reservation", holderId: input.id }]);
    assert.equal((await objectRow(db, objectId)).unheldSince, null);
    assert.equal((await db.select().from(attachmentUploadReservations)).length, 1);
  } finally {
    await client.close();
  }
});
