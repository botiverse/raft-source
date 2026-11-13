import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/index";
import {
  type AttachmentUploaderType,
  attachmentObjectCharges,
  attachmentObjects,
  attachmentUploadReservations,
  attachments,
} from "../db/schema";
import {
  createAttachmentLifecycleFoundationWithExecutor,
  ATTACHMENT_RESERVATION_TTL_MS,
  resolveAttachmentLifecycleDatabaseNow,
} from "./attachmentLifecycleService";
import { assertChannelWritableInTransaction } from "./channelConversionFenceService";
import { addAttachmentObjectHoldWithExecutor } from "./attachmentObjectHoldService";
import { type ResolvedAttachment, withAttachmentObjectMetadata } from "./attachmentRecord";

export type PendingAttachmentProjectionInput = {
  id: string;
  objectId: string;
  transferIntentId: string;
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: AttachmentUploaderType;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  thumbnailKey?: string | null;
  contentHash?: string | null;
  width?: number | null;
  height?: number | null;
  /** Existing quota reservation month, when the upload spans requests. */
  chargeMonth?: string;
};

export type ExistingObjectPendingAttachmentProjectionInput = Readonly<{
  id: string;
  objectId: string;
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: AttachmentUploaderType;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
}>;

function currentChargeMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function resolveChargeMonth(value: string | undefined, now: Date): string {
  if (!value) return currentChargeMonth(now);
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  throw new Error(`Invalid attachment charge month: ${value}`);
}

/**
 * The immutable object (the only home of the physical metadata),
 * exactly-once logical-object charge, and creator-owned pending projection
 * commit together.
 *
 * Callers must provide a transaction executor and a durable transfer intent
 * that was committed before storage I/O. This helper adopts the written keys;
 * publishing onto a message happens later through the canonical linking
 * transaction.
 */
export async function createPendingAttachmentProjectionWithExecutor(
  executor: DatabaseTransaction,
  input: PendingAttachmentProjectionInput,
  explicitNow?: Date,
): Promise<ResolvedAttachment> {
  await assertChannelWritableInTransaction(executor, input.channelId);
  const now = await resolveAttachmentLifecycleDatabaseNow(executor, explicitNow);
  const projectionId = input.id;
  const objectId = input.objectId;

  await executor.insert(attachmentObjects).values({
    id: objectId,
    originServerId: input.serverId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    storageKey: input.storageKey,
    thumbnailKey: input.thumbnailKey ?? null,
    contentHash: input.contentHash ?? null,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    width: input.width ?? null,
    height: input.height ?? null,
  });
  await executor.insert(attachmentObjectCharges).values({
    objectId,
    originServerId: input.serverId,
    chargeMonth: resolveChargeMonth(input.chargeMonth, now),
    sizeBytes: input.sizeBytes,
  });
  await createAttachmentLifecycleFoundationWithExecutor(executor, {
    transferIntentId: input.transferIntentId,
    reservationId: projectionId,
    objectId,
    serverId: input.serverId,
    channelId: input.channelId,
    creatorId: input.uploaderId,
    creatorType: input.uploaderType,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    thumbnailKey: input.thumbnailKey,
  }, now);
  const [projection] = await executor.insert(attachments).values({
    id: projectionId,
    objectId,
    messageId: null,
    pendingChannelId: input.channelId,
    createdById: input.uploaderId,
    createdByType: input.uploaderType,
    channelId: input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    filename: input.filename,
  }).returning();

  return withAttachmentObjectMetadata(projection, {
    storageKey: input.storageKey,
    thumbnailKey: input.thumbnailKey ?? null,
    contentHash: input.contentHash ?? null,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    width: input.width ?? null,
    height: input.height ?? null,
  });
}

/**
 * Creates an occurrence-owned pending projection for an existing immutable
 * object without charging or materializing the shared bytes again. This stays
 * on the canonical projection-writer boundary so reservation/projection
 * atomicity and deterministic replay have one authority.
 */
export async function createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(
  executor: DatabaseTransaction,
  input: ExistingObjectPendingAttachmentProjectionInput,
  explicitNow?: Date,
): Promise<ResolvedAttachment> {
  const now = await resolveAttachmentLifecycleDatabaseNow(executor, explicitNow);
  const [object] = await executor.select().from(attachmentObjects)
    .where(eq(attachmentObjects.id, input.objectId)).for("update").limit(1);
  if (
    !object
    || object.originServerId !== input.serverId
    || object.lifecycleState !== "active"
    || object.mimeType !== input.mimeType
    || object.sizeBytes !== input.sizeBytes
    || object.contentHash !== input.contentHash
  ) {
    throw new Error(`Existing attachment object conflicts with projection ${input.id}`);
  }
  const [existing] = await executor.select().from(attachments)
    .where(eq(attachments.id, input.id)).for("update").limit(1);
  if (existing) {
    const [reservation] = await executor.select().from(attachmentUploadReservations)
      .where(eq(attachmentUploadReservations.id, input.id)).for("update").limit(1);
    if (
      existing.objectId !== object.id
      || existing.messageId !== null
      || existing.pendingChannelId !== input.channelId
      || existing.uploaderId !== input.uploaderId
      || existing.uploaderType !== input.uploaderType
      || existing.filename !== input.filename
      || existing.revokedAt !== null
      || !reservation
      || reservation.objectId !== object.id
      || reservation.creatorId !== input.uploaderId
      || reservation.creatorType !== input.uploaderType
      || reservation.channelId !== input.channelId
      || reservation.state !== "pending"
    ) {
      throw new Error(`Existing attachment projection replay conflict for ${input.id}`);
    }
    return withAttachmentObjectMetadata(existing, object);
  }

  await executor.insert(attachmentUploadReservations).values({
    id: input.id,
    objectId: object.id,
    originServerId: input.serverId,
    channelId: input.channelId,
    creatorId: input.uploaderId,
    creatorType: input.uploaderType,
    filename: input.filename,
    state: "pending",
    expiresAt: new Date(now.getTime() + ATTACHMENT_RESERVATION_TTL_MS),
    createdAt: now,
    updatedAt: now,
  });
  await addAttachmentObjectHoldWithExecutor(executor, {
    holderType: "upload_reservation",
    holderId: input.id,
    objectId: object.id,
  });
  const [projection] = await executor.insert(attachments).values({
    id: input.id,
    objectId: object.id,
    messageId: null,
    pendingChannelId: input.channelId,
    createdById: input.uploaderId,
    createdByType: input.uploaderType,
    channelId: input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    filename: input.filename,
  }).returning();
  if (!projection) throw new Error(`Existing attachment projection was not created for ${input.id}`);
  return withAttachmentObjectMetadata(projection, object);
}

function sameNullable<T>(actual: T | null, expected: T | null | undefined): boolean {
  return actual === (expected ?? null);
}

function projectionReplayMatches(
  projection: typeof attachments.$inferSelect,
  input: PendingAttachmentProjectionInput & { id: string; objectId: string },
): boolean {
  const creatorMatches = (projection.createdById === null && projection.createdByType === null)
    || (projection.createdById === input.uploaderId && projection.createdByType === input.uploaderType);
  const bindingMatches = projection.messageId === null
    ? projection.pendingChannelId === null || projection.pendingChannelId === input.channelId
    : projection.pendingChannelId === null;
  return projection.channelId === input.channelId
    && projection.uploaderId === input.uploaderId
    && projection.uploaderType === input.uploaderType
    && creatorMatches
    && bindingMatches
    && projection.filename === input.filename
    && projection.revokedAt === null;
}

function objectReplayMatches(
  object: typeof attachmentObjects.$inferSelect,
  input: PendingAttachmentProjectionInput,
): boolean {
  return object.originServerId === input.serverId
    && object.uploaderId === input.uploaderId
    && object.uploaderType === input.uploaderType
    && object.storageKey === input.storageKey
    && sameNullable(object.thumbnailKey, input.thumbnailKey)
    && sameNullable(object.contentHash, input.contentHash)
    && object.mimeType === input.mimeType
    && object.sizeBytes === input.sizeBytes
    && sameNullable(object.width, input.width)
    && sameNullable(object.height, input.height)
    && object.lifecycleState === "active";
}

async function validateExistingIdempotentProjection(
  executor: DatabaseTransaction,
  projection: typeof attachments.$inferSelect,
  input: PendingAttachmentProjectionInput & { id: string; objectId: string },
): Promise<ResolvedAttachment> {
  if (!projectionReplayMatches(projection, input)) {
    throw new Error(`Attachment projection replay conflict for ${input.id}`);
  }
  const [object] = await executor.select().from(attachmentObjects)
    .where(eq(attachmentObjects.id, projection.objectId)).limit(1);
  if (!object || !objectReplayMatches(object, input)) {
    throw new Error(`Attachment projection replay conflict for ${input.id}`);
  }
  const [charge] = await executor.select().from(attachmentObjectCharges)
    .where(eq(attachmentObjectCharges.objectId, projection.objectId)).limit(1);
  // An object created by this deterministic writer must retain its atomic
  // charge. A different object ID is a Phase-C backfill and intentionally has
  // no charge row; if one exists, its immutable fingerprint must still match.
  if (projection.objectId === input.objectId && !charge) {
    throw new Error(`Attachment projection replay conflict for ${input.id}`);
  }
  if (charge && (charge.originServerId !== input.serverId || charge.sizeBytes !== input.sizeBytes)) {
    throw new Error(`Attachment projection replay conflict for ${input.id}`);
  }
  const [reservation] = await executor.select().from(attachmentUploadReservations)
    .where(eq(attachmentUploadReservations.id, projection.id)).limit(1);
  if (reservation && (
    reservation.objectId !== projection.objectId
    || reservation.creatorId !== input.uploaderId
    || reservation.creatorType !== input.uploaderType
    || reservation.channelId !== input.channelId
  )) {
    throw new Error(`Attachment reservation replay conflict for ${input.id}`);
  }
  return withAttachmentObjectMetadata(projection, object);
}

/**
 * Idempotent variant for deterministic system artifacts and replay writers.
 * Both IDs are required so retries converge on the same logical object. A
 * conflicting pre-existing row fails the surrounding transaction instead of
 * accepting mismatched bytes or leaving an unreferenced object/charge behind.
 */
export async function createIdempotentPendingAttachmentProjectionWithExecutor(
  executor: DatabaseTransaction,
  input: PendingAttachmentProjectionInput & { id: string; objectId: string },
  explicitNow?: Date,
): Promise<ResolvedAttachment> {
  await assertChannelWritableInTransaction(executor, input.channelId);
  const now = await resolveAttachmentLifecycleDatabaseNow(executor, explicitNow);
  const [existing] = await executor.select().from(attachments)
    .where(eq(attachments.id, input.id)).limit(1).for("update");
  if (existing) return validateExistingIdempotentProjection(executor, existing, input);

  const [insertedObject] = await executor.insert(attachmentObjects).values({
    id: input.objectId,
    originServerId: input.serverId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    storageKey: input.storageKey,
    thumbnailKey: input.thumbnailKey ?? null,
    contentHash: input.contentHash ?? null,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    width: input.width ?? null,
    height: input.height ?? null,
  }).onConflictDoNothing().returning({ id: attachmentObjects.id });
  if (insertedObject) {
    await executor.insert(attachmentObjectCharges).values({
      objectId: input.objectId,
      originServerId: input.serverId,
      chargeMonth: resolveChargeMonth(input.chargeMonth, now),
      sizeBytes: input.sizeBytes,
    });
    await createAttachmentLifecycleFoundationWithExecutor(executor, {
      transferIntentId: input.transferIntentId,
      reservationId: input.id,
      objectId: input.objectId,
      serverId: input.serverId,
      channelId: input.channelId,
      creatorId: input.uploaderId,
      creatorType: input.uploaderType,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      thumbnailKey: input.thumbnailKey,
    }, now);
    await executor.insert(attachments).values({
      id: input.id,
      objectId: input.objectId,
      messageId: null,
      pendingChannelId: input.channelId,
      createdById: input.uploaderId,
      createdByType: input.uploaderType,
      channelId: input.channelId,
      uploaderId: input.uploaderId,
      uploaderType: input.uploaderType,
      filename: input.filename,
    }).onConflictDoNothing();
  }

  const [projection] = await executor.select().from(attachments)
    .where(eq(attachments.id, input.id)).limit(1).for("update");
  if (!projection) {
    throw new Error(`Attachment projection replay conflict for ${input.id}`);
  }
  // A conflicting legacy writer must abort the whole surrounding transaction.
  // That rollback removes any object/charge/reservation/artifact rows created
  // above; accepting the foreign projection would reintroduce split ownership.
  return validateExistingIdempotentProjection(executor, projection, input);
}
