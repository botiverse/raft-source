import { asc, and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { attachmentObjects, attachments } from "../db/schema";
import {
  AttachmentLifecycleError,
  consumeAttachmentReservationsWithExecutor,
  lockAttachmentReservationsForConsumeWithExecutor,
} from "./attachmentLifecycleService";
import { assertChannelWritableInTransaction } from "./channelConversionFenceService";
import {
  AttachmentObjectHoldError,
  addAttachmentObjectHoldsWithExecutor,
  transferAttachmentObjectHoldsWithExecutor,
} from "./attachmentObjectHoldService";
import { UUID_RE } from "../lib/messageId";
import { type ResolvedAttachment, withAttachmentObjectMetadata } from "./attachmentRecord";

export type AttachmentLinkErrorCode =
  | "attachment_id_invalid"
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

/** Names the entry by position only; the rejected value is never echoed. */
export function attachmentIdInvalidMessage(entryNumber: number): string {
  return `Not sent: attachmentIds entry ${entryNumber} is not a single attachment ID. `
    + "Each entry must be one ID returned when the file was uploaded. "
    + "CLI: pass one ID per --attachment-id and repeat the flag for more files. "
    + "API/SDK: put one ID in each attachmentIds entry.";
}

/**
 * Reject ids that are not UUIDs before they reach a uuid column, where
 * Postgres answers 22P02 and the send used to fail as a 500 (task #20; agents
 * passed `--attachment-id "id1 id2"`).
 */
function assertWellFormedAttachmentIds(attachmentIds: string[]): void {
  const index = attachmentIds.findIndex((id) => typeof id !== "string" || !UUID_RE.test(id));
  if (index < 0) return;
  throw new AttachmentLinkError("attachment_id_invalid", attachmentIdInvalidMessage(index + 1));
}

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
): Promise<Map<string, ResolvedAttachment[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await executor
    .select({
      projection: attachments,
      object: attachmentObjects,
    })
    .from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(inArray(attachments.messageId, [...new Set(messageIds)]))
    .orderBy(
      asc(attachments.messageId),
      sql`${attachments.messagePosition} ASC NULLS LAST`,
      sql`CASE WHEN ${attachments.messagePosition} IS NULL THEN ${attachments.createdAt} END ASC`,
      asc(attachments.id),
    );

  const byMessage = new Map<string, ResolvedAttachment[]>();
  for (const { projection, object } of rows) {
    if (!projection.messageId || projection.revokedAt) continue;
    // Physical metadata comes only from the projection's immutable object
    // (object_id is NOT NULL); a non-active object fails closed.
    if (object.lifecycleState !== "active") continue;
    const row = withAttachmentObjectMetadata(projection, object);
    const current = byMessage.get(projection.messageId) ?? [];
    current.push(row);
    byMessage.set(projection.messageId, current);
  }
  return byMessage;
}

export async function getAttachmentsForMessageWithExecutor(
  executor: DatabaseExecutor,
  messageId: string,
): Promise<ResolvedAttachment[]> {
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
): Promise<ResolvedAttachment[]> {
  assertWellFormedAttachmentIds(attachmentIds);
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
      channelId: attachments.channelId,
      objectId: attachments.objectId,
      revokedAt: attachments.revokedAt,
    })
    .from(attachments)
    .where(inArray(attachments.id, attachmentIds))
    .for("update");

  for (const channelId of new Set(rows.map((row) => row.channelId))) {
    // DatabaseExecutor is the transaction contract. Keep the writer fence
    // unconditional so production and test adapters cannot silently diverge
    // based on runtime object shape.
    await assertChannelWritableInTransaction(executor, channelId);
  }

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

  // The linked attachment now holds its bytes. A pending reservation (same id
  // as its attachment) hands its hold over in one UPDATE, so the object is
  // never without a hold; a row without a reservation adds a new hold.
  try {
    await transferAttachmentObjectHoldsWithExecutor(executor, rows.flatMap((row) => {
      if (row.revokedAt) return [];
      const to = { holderType: "attachment" as const, holderId: row.id, objectId: row.objectId };
      const reservation = reservations.get(row.id);
      return reservation?.state === "pending" && reservation.objectId === row.objectId
        ? [{ from: { holderType: "upload_reservation" as const, holderId: reservation.id, objectId: row.objectId }, to }]
        : [];
    }), now);
    await addAttachmentObjectHoldsWithExecutor(executor, rows.flatMap((row) => {
      if (row.revokedAt) return [];
      const reservation = reservations.get(row.id);
      return reservation?.state === "pending" && reservation.objectId === row.objectId
        ? []
        : [{ holderType: "attachment" as const, holderId: row.id, objectId: row.objectId }];
    }));
  } catch (error) {
    if (error instanceof AttachmentObjectHoldError) {
      throw new AttachmentLinkError(
        "attachment_not_found",
        "One or more attachments are no longer stored. Re-upload the file and send the new attachment ID.",
      );
    }
    throw error;
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
