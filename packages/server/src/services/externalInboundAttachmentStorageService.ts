import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  attachmentTransferIntents,
  type AttachmentUploaderType,
} from "../db/schema.js";
import { withFileUploadQuota } from "./fileUploadQuotaService.js";
import {
  createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor,
  createIdempotentPendingAttachmentProjectionWithExecutor,
} from "./attachmentProjectionWriterService.js";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";
import type { StorageBackend } from "./storageService.js";

export const EXTERNAL_INBOUND_ATTACHMENT_INTENT_TTL_MS = 15 * 60_000;

function deterministicUuid(namespace: string, identity: string): string {
  const bytes = createHash("sha256").update(namespace).update("\0").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
}

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`External inbound attachment ${label} is invalid`);
  return value;
}

function declaredMimeMatchesBytes(mimeType: string, prefix: Buffer): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "application/pdf") return prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "image/png") {
    return prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mime === "image/jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (mime === "image/gif") {
    const magic = prefix.subarray(0, 6).toString("ascii");
    return magic === "GIF87a" || magic === "GIF89a";
  }
  if (mime === "image/webp") {
    return prefix.subarray(0, 4).toString("ascii") === "RIFF"
      && prefix.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (
    mime === "application/zip"
    || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return prefix.length >= 4
      && prefix[0] === 0x50
      && prefix[1] === 0x4b
      && (prefix[2] === 0x03 || prefix[2] === 0x05 || prefix[2] === 0x07)
      && (prefix[3] === 0x04 || prefix[3] === 0x06 || prefix[3] === 0x08);
  }
  if (mime?.startsWith("text/")) return !prefix.includes(0);
  return true;
}

export type StoreExternalInboundAttachmentInput = Readonly<{
  assetId: string;
  messageFactId: string;
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: Extract<AttachmentUploaderType, "external_projection">;
  filename: string;
  mimeType: string;
  declaredSizeBytes: number;
  maximumSizeBytes: number;
  bytes: AsyncIterable<Uint8Array>;
  storage: StorageBackend;
  db: Database;
  beforePublish?: () => Promise<void>;
  now?: Date;
}>;

/**
 * Streams one provider file through a pre-recorded transfer intent into the
 * canonical attachment object model. The projection remains pending until the
 * inbound message/link transaction publishes the complete ordered file set.
 */
export async function storeExternalInboundAttachment(
  input: StoreExternalInboundAttachmentInput,
): Promise<typeof attachments.$inferSelect> {
  if (!input.storage.putStream) {
    throw new Error("Attachment storage does not support bounded streaming writes");
  }
  if (
    !Number.isSafeInteger(input.declaredSizeBytes)
    || input.declaredSizeBytes <= 0
    || !Number.isSafeInteger(input.maximumSizeBytes)
    || input.maximumSizeBytes <= 0
    || input.declaredSizeBytes > input.maximumSizeBytes
  ) {
    throw new Error("External inbound attachment size is invalid");
  }
  const now = validDate(input.now ?? currentDate(), "clock");
  const projectionId = deterministicUuid("external-attachment-projection-v1", input.messageFactId);
  const objectId = deterministicUuid("external-attachment-object-v2", input.messageFactId);
  const transferIntentId = deterministicUuid("external-attachment-intent-v2", input.messageFactId);
  const storageKey = `${input.serverId}/${projectionId}${safeExtension(input.filename)}`;
  const existing = await input.db.select({
    projection: attachments,
    object: attachmentObjects,
  }).from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(and(
      eq(attachments.id, projectionId),
      eq(attachmentObjects.id, objectId),
    )).limit(1);
  if (existing[0]) {
    const { projection, object } = existing[0];
    if (
      projection.messageId !== null
      || projection.pendingChannelId !== input.channelId
      || projection.uploaderId !== input.uploaderId
      || projection.uploaderType !== input.uploaderType
      || projection.filename !== input.filename
      || object.originServerId !== input.serverId
      || object.storageKey !== storageKey
      || object.mimeType !== input.mimeType
      || object.sizeBytes !== input.declaredSizeBytes
      || object.lifecycleState !== "active"
    ) {
      throw new Error("External inbound attachment replay conflicts with its canonical projection");
    }
    return projection;
  }

  const expiresAt = new Date(now.getTime() + EXTERNAL_INBOUND_ATTACHMENT_INTENT_TTL_MS);
  await createAttachmentTransferIntent({
    id: transferIntentId,
    reservationId: projectionId,
    objectId,
    serverId: input.serverId,
    channelId: input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    filename: input.filename,
    mimeType: input.mimeType,
    declaredSizeBytes: input.declaredSizeBytes,
    expiresAt,
    artifacts: buildAttachmentTransferArtifactPlan({
      storageKey,
      mimeType: input.mimeType,
    }),
  }, input.db, now);

  let actualSizeBytes = 0;
  const hash = createHash("sha256");
  let sniffPrefix = Buffer.alloc(0);
  const boundedBytes = async function* () {
    for await (const rawChunk of input.bytes) {
      const chunk = Buffer.from(rawChunk);
      actualSizeBytes += chunk.length;
      if (actualSizeBytes > input.declaredSizeBytes || actualSizeBytes > input.maximumSizeBytes) {
        throw new Error("External inbound attachment stream exceeded its declared bound");
      }
      hash.update(chunk);
      if (sniffPrefix.length < 512) {
        sniffPrefix = Buffer.concat([sniffPrefix, chunk.subarray(0, 512 - sniffPrefix.length)]);
      }
      yield chunk;
    }
    if (actualSizeBytes !== input.declaredSizeBytes) {
      throw new Error("External inbound attachment stream length did not match provider metadata");
    }
    if (!declaredMimeMatchesBytes(input.mimeType, sniffPrefix)) {
      throw new Error("External inbound attachment bytes did not match the declared MIME type");
    }
  };

  return withFileUploadQuota(input.serverId, input.declaredSizeBytes, async () => {
    await input.storage.putStream!(
      storageKey,
      Readable.from(boundedBytes()),
      input.mimeType,
      input.declaredSizeBytes,
    );
    const contentHash = hash.digest("hex");
    await input.beforePublish?.();
    return input.db.transaction((tx) => createIdempotentPendingAttachmentProjectionWithExecutor(tx, {
      id: projectionId,
      objectId,
      transferIntentId,
      serverId: input.serverId,
      channelId: input.channelId,
      uploaderId: input.uploaderId,
      uploaderType: input.uploaderType,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: actualSizeBytes,
      storageKey,
      contentHash,
    }, now));
  }, now);
}

export async function externalInboundAttachmentIntentState(
  db: Database,
  messageFactId: string,
): Promise<string | null> {
  const transferIntentId = deterministicUuid("external-attachment-intent-v2", messageFactId);
  const [intent] = await db.select({ state: attachmentTransferIntents.state })
    .from(attachmentTransferIntents)
    .where(eq(attachmentTransferIntents.id, transferIntentId)).limit(1);
  return intent?.state ?? null;
}

export type ReuseStoredExternalInboundAttachmentInput = Readonly<{
  objectId: string;
  messageFactId: string;
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: Extract<AttachmentUploaderType, "external_projection">;
  filename: string;
  mimeType: string;
  declaredSizeBytes: number;
  contentHash: string;
  now?: Date;
}>;

/**
 * Creates a new message-scoped projection for bytes already materialized by a
 * previous provider occurrence. The immutable object and its quota charge are
 * reused; only the occurrence-owned projection and send reservation are new.
 */
export async function reuseStoredExternalInboundAttachmentWithExecutor(
  executor: DatabaseTransaction,
  input: ReuseStoredExternalInboundAttachmentInput,
): Promise<typeof attachments.$inferSelect> {
  const now = validDate(input.now ?? currentDate(), "reuse clock");
  const projectionId = deterministicUuid("external-attachment-projection-v1", input.messageFactId);
  return createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(executor, {
    id: projectionId,
    objectId: input.objectId,
    serverId: input.serverId,
    channelId: input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.declaredSizeBytes,
    contentHash: input.contentHash,
  }, now);
}
