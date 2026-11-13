import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index";
import { getDb } from "../db/index";
import { attachmentObjects, attachments, channels } from "../db/schema";
import { createMessage } from "../services/messageService";
import {
  type AttachmentObjectMetadata,
  type ResolvedAttachment,
  withAttachmentObjectMetadata,
} from "../services/attachmentRecord";

/**
 * A projection row plus the physical metadata of its object. Without an
 * `objectId` the fixture creates the object from these fields.
 */
export type AttachmentFixtureRow = Omit<typeof attachments.$inferInsert, "objectId">
  & Partial<Pick<typeof attachments.$inferInsert, "objectId">>
  & Pick<AttachmentObjectMetadata, "storageKey" | "mimeType" | "sizeBytes">
  & Partial<Pick<AttachmentObjectMetadata, "thumbnailKey" | "contentHash" | "width" | "height">>;

/**
 * Seed attachment projections the way every production writer leaves them:
 * each row bound to its own `attachment_objects` row, which alone carries the
 * physical metadata. A row that already names an `objectId` is bound to that
 * object as given (its metadata fields are then only echoed back). The
 * object's origin server is the projection channel's server. Returns the rows
 * as readers resolve them (projection + object metadata).
 */
export async function insertAttachmentsWithObjects(
  db: Database | DatabaseTransaction,
  input: AttachmentFixtureRow | AttachmentFixtureRow[],
): Promise<ResolvedAttachment[]> {
  const rows = Array.isArray(input) ? input : [input];
  const inserted: ResolvedAttachment[] = [];
  for (const row of rows) {
    const { storageKey, thumbnailKey, contentHash, mimeType, sizeBytes, width, height, ...projectionRow } = row;
    const metadata: AttachmentObjectMetadata = {
      storageKey,
      thumbnailKey: thumbnailKey ?? null,
      contentHash: contentHash ?? null,
      mimeType,
      sizeBytes,
      width: width ?? null,
      height: height ?? null,
    };
    let objectId = row.objectId ?? null;
    if (!objectId) {
      const [channel] = await db.select({ serverId: channels.serverId }).from(channels)
        .where(eq(channels.id, row.channelId)).limit(1);
      if (!channel) throw new Error(`insertAttachmentsWithObjects: channel ${row.channelId} not found`);
      objectId = randomUUID();
      await db.insert(attachmentObjects).values({
        id: objectId,
        originServerId: channel.serverId,
        uploaderId: row.uploaderId,
        uploaderType: row.uploaderType,
        ...metadata,
        ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      });
    }
    const [projection] = await db.insert(attachments).values({ ...projectionRow, objectId }).returning();
    inserted.push(withAttachmentObjectMetadata(projection, metadata));
  }
  return inserted;
}

/**
 * As insertAttachmentsWithObjects, and linked to a message the way a sent
 * attachment is: the member and agent attachment routes read only bound,
 * linked projections. A row without a messageId gets a fresh message from its
 * uploader in its channel. Uses the app database (getDb()).
 */
export async function insertLinkedAttachmentsWithObjects(
  input: AttachmentFixtureRow | AttachmentFixtureRow[],
): Promise<ResolvedAttachment[]> {
  const rows = Array.isArray(input) ? input : [input];
  const linked: AttachmentFixtureRow[] = [];
  for (const row of rows) {
    const messageId = row.messageId ?? (await createMessage(
      row.channelId,
      row.uploaderType === "agent" ? "agent" : "user",
      row.uploaderId,
      `attachment ${row.filename}`,
    )).id;
    linked.push({ ...row, messageId, pendingChannelId: null });
  }
  return insertAttachmentsWithObjects(getDb(), linked);
}
