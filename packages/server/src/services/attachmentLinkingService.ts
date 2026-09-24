import { asc, and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index.js";
import { attachmentObjects, attachments } from "../db/schema.js";
import {
  AttachmentLifecycleError,
  consumeAttachmentReservationsWithExecutor,
  lockAttachmentReservationsForConsumeWithExecutor,
} from "./attachmentLifecycleService.js";

export type AttachmentLinkErrorCode =
  | "attachment_duplicate"
  | "attachment_not_found"
  | "attachment_already_linked"
  | "attachment_not_linked"
  | "attachment_replay_conflict"
  | "attachment_expired"
  | "attachment_canceled";

export class AttachmentLinkError extends Error {
  readonly code: AttachmentLinkErrorCode;
  readonly status: number;

  constructor(code: AttachmentLinkErrorCode, message: string, status = 400) {
    super(message);
    this.name = "AttachmentLinkError";
    this.code = code;
    this.status = status;
  }
}

export type AttachmentLinkMode = "new" | "replay";
export type AttachmentLinkHooks = Readonly<{
  afterObjectAndReservationLocks?: () => Promise<void>;
}>;

function assertNoDuplicateAttachmentIds(attachmentIds: string[]): void {
  const seen = new Set<string>();
  const duplicateId = attachmentIds.find((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  if (!duplicateId) return;
  throw new AttachmentLinkError(
    "attachment_duplicate",
    `Attachment ${duplicateId} was requested more than once. Send each attachment ID exactly once.`,
  );
}

function attachmentOrderMatches(
  rows: Array<Pick<typeof attachments.$inferSelect, "id" | "messagePosition" | "uploaderId">>,
  attachmentIds: string[],
  uploaderId: string,
): boolean {
  return rows.length === attachmentIds.length
    && rows.every((row, index) =>
      row.id === attachmentIds[index]
      && row.messagePosition === index
      && row.uploaderId === uploaderId
    );
}

/**
 * Read linked attachments in their persisted message order.
 *
 * During the rolling phase, old writers can still leave a null position after
 * the migration backfill. Those rows sort after positioned rows and use the
 * same deterministic created_at/id fallback as the migration.
 */
export async function getAttachmentsForMessagesWithExecutor(
  executor: DatabaseExecutor,
  messageIds: string[],
): Promise<Map<string, typeof attachments.$inferSelect[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await executor
    .select({
      projection: attachments,
      object: attachmentObjects,
    })
    .from(attachments)
    .leftJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(inArray(attachments.messageId, [...new Set(messageIds)]))
    .orderBy(
      asc(attachments.messageId),
      sql`${attachments.messagePosition} ASC NULLS LAST`,
      sql`CASE WHEN ${attachments.messagePosition} IS NULL THEN ${attachments.createdAt} END ASC`,
      asc(attachments.id),
    );

  const byMessage = new Map<string, typeof attachments.$inferSelect[]>();
  for (const { projection, object } of rows) {
    if (!projection.messageId || projection.revokedAt) continue;
    // Once a projection has an object binding, physical metadata comes only
    // from that immutable active object. A missing/non-active object fails
    // closed instead of silently falling back to mutable legacy columns.
    if (projection.objectId && (!object || object.lifecycleState !== "active")) continue;
    const row = object
      ? {
          ...projection,
          mimeType: object.mimeType,
          sizeBytes: object.sizeBytes,
          storageKey: object.storageKey,
          thumbnailKey: object.thumbnailKey,
          contentHash: object.contentHash,
          width: object.width,
          height: object.height,
        }
      : projection;
    const current = byMessage.get(projection.messageId) ?? [];
    current.push(row);
    byMessage.set(projection.messageId, current);
  }
  return byMessage;
}

export async function getAttachmentsForMessageWithExecutor(
  executor: DatabaseExecutor,
  messageId: string,
): Promise<typeof attachments.$inferSelect[]> {
  return (await getAttachmentsForMessagesWithExecutor(executor, [messageId])).get(messageId) ?? [];
}

/**
 * Canonical ordered attachment writer and replay validator.
 *
 * Callers must pass a transaction executor. New sends lock and validate every
 * requested row before writing message_id + the request ordinal, then perform
 * an explicit ordered SELECT for the response. Replay accepts only the exact
 * same ordered attachment IDs/positions and performs no writes.
 */
export async function linkAttachmentsToMessageWithExecutor(
  executor: DatabaseExecutor,
  attachmentIds: string[],
  messageId: string,
  uploaderId: string,
  mode: AttachmentLinkMode = "new",
  now?: Date,
  hooks: AttachmentLinkHooks = {},
): Promise<typeof attachments.$inferSelect[]> {
  assertNoDuplicateAttachmentIds(attachmentIds);

  if (mode === "replay") {
    const linked = await getAttachmentsForMessageWithExecutor(executor, messageId);
    if (attachmentOrderMatches(linked, attachmentIds, uploaderId)) return linked;
    throw new AttachmentLinkError(
      "attachment_replay_conflict",
      "This idempotent send was already committed with a different ordered attachment set.",
    );
  }

  if (attachmentIds.length === 0) return [];

  let reservations;
  try {
    reservations = await lockAttachmentReservationsForConsumeWithExecutor(
      executor,
      attachmentIds,
      uploaderId,
      now,
    );
  } catch (error) {
    if (error instanceof AttachmentLifecycleError && error.code === "attachment_expired") {
      throw new AttachmentLinkError("attachment_expired", error.message, 410);
    }
    if (error instanceof AttachmentLifecycleError && error.code === "attachment_canceled") {
      throw new AttachmentLinkError("attachment_canceled", error.message, 410);
    }
    if (error instanceof AttachmentLifecycleError) {
      throw new AttachmentLinkError("attachment_not_found", error.message);
    }
    throw error;
  }
  await hooks.afterObjectAndReservationLocks?.();

  const rows = await executor
    .select({
      id: attachments.id,
      uploaderId: attachments.uploaderId,
      messageId: attachments.messageId,
    })
    .from(attachments)
    .where(inArray(attachments.id, attachmentIds))
    .for("update");

  const byId = new Map(rows.map((row) => [row.id, row]));
  const missingOrForeignId = attachmentIds.find((id) => byId.get(id)?.uploaderId !== uploaderId);
  if (missingOrForeignId) {
    throw new AttachmentLinkError(
      "attachment_not_found",
      `Attachment ${missingOrForeignId} is not available for this sender. Re-upload the file and send the new attachment ID.`,
    );
  }

  const alreadyLinked = rows.find((row) => row.messageId !== null);
  if (alreadyLinked) {
    throw new AttachmentLinkError(
      "attachment_already_linked",
      `Attachment ${alreadyLinked.id} is already attached to another message. Re-upload the file and send the new attachment ID.`,
    );
  }

  for (const [messagePosition, attachmentId] of attachmentIds.entries()) {
    const updated = await executor
      .update(attachments)
      .set({ messageId, messagePosition, pendingChannelId: null })
      .where(and(
        eq(attachments.id, attachmentId),
        eq(attachments.uploaderId, uploaderId),
        isNull(attachments.messageId),
      ))
      .returning({ id: attachments.id });
    if (updated.length !== 1) {
      throw new AttachmentLinkError(
        "attachment_not_linked",
        "One or more attachments could not be attached to this message. Re-upload the file and send the new attachment ID.",
      );
    }
  }

  await consumeAttachmentReservationsWithExecutor(executor, reservations, messageId, now);

  const linked = await getAttachmentsForMessageWithExecutor(executor, messageId);
  if (!attachmentOrderMatches(linked, attachmentIds, uploaderId)) {
    throw new AttachmentLinkError(
      "attachment_not_linked",
      "One or more attachments could not be attached to this message. Re-upload the file and send the new attachment ID.",
    );
  }
  return linked;
}
