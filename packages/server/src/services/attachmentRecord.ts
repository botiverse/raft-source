import type { attachmentObjects, attachments } from "../db/schema";

/**
 * The physical metadata of an attachment. It lives only on the immutable
 * `attachment_objects` row: `attachments` is the occurrence (where, by whom,
 * under which name) and no longer carries copies of it (storage step 2c).
 */
export type AttachmentObjectMetadata = Pick<
  typeof attachmentObjects.$inferSelect,
  "storageKey" | "thumbnailKey" | "contentHash" | "mimeType" | "sizeBytes" | "width" | "height"
>;

/** One attachment as readers serve it: the projection with its object's metadata. */
export type ResolvedAttachment = typeof attachments.$inferSelect & AttachmentObjectMetadata;

export function withAttachmentObjectMetadata<P extends typeof attachments.$inferSelect>(
  projection: P,
  object: AttachmentObjectMetadata,
): P & AttachmentObjectMetadata {
  return {
    ...projection,
    storageKey: object.storageKey,
    thumbnailKey: object.thumbnailKey,
    contentHash: object.contentHash,
    mimeType: object.mimeType,
    sizeBytes: object.sizeBytes,
    width: object.width,
    height: object.height,
  };
}
