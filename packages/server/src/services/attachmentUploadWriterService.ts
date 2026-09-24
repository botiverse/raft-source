import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import type { AttachmentUploaderType, attachments } from "../db/schema.js";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService.js";
import {
  buildAttachmentTransferArtifactPlan,
  buildSvgRasterTransferKey,
  createAttachmentTransferIntentWithExecutor,
  terminalizeAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";
import { withFileUploadQuota } from "./fileUploadQuotaService.js";
import type { StorageBackend } from "./storageService.js";

export const ATTACHMENT_TRANSFER_INTENT_TTL_MS = 15 * 60 * 1000;

export type AttachmentUploadBuffer = Readonly<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
  contentHash?: string | null;
}>;

export type AttachmentPreviewWriter = Readonly<{
  canGenerate: (mimeType: string) => boolean;
  generateThumbnail: (buffer: Buffer, mimeType: string) => Promise<Buffer>;
  isSvg: (mimeType: string) => boolean;
  generateSvgRasterPreview: (buffer: Buffer) => Promise<Buffer>;
}>;

export type UploadAttachmentBuffersInput = Readonly<{
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: AttachmentUploaderType;
  files: readonly AttachmentUploadBuffer[];
  storage: StorageBackend;
  cdnStorage: StorageBackend | null;
  preview: AttachmentPreviewWriter;
  now?: Date;
}>;

type PlannedUpload = Readonly<{
  transferIntentId: string;
  id: string;
  objectId: string;
  storageKey: string;
  plannedThumbnailKey: string | null;
  file: AttachmentUploadBuffer;
}>;

async function terminalizeAll(intents: readonly PlannedUpload[], reason: string): Promise<void> {
  await Promise.all(intents.map((intent) => terminalizeAttachmentTransferIntent(
    intent.transferIntentId,
    "failed",
    reason,
  ).catch(() => null)));
}

/**
 * Common server-buffer upload writer. Every key is committed to the transfer
 * manifest before the first PUT; publication adopts only successfully written
 * previews and leaves every other planned key as an idempotent cleanup duty.
 */
export async function uploadAttachmentBuffers(
  input: UploadAttachmentBuffersInput,
): Promise<Array<typeof attachments.$inferSelect>> {
  const requestedBytes = input.files.reduce((total, file) => total + file.buffer.length, 0);
  const now = input.now ?? currentDate();
  const expiresAt = new Date(now.getTime() + ATTACHMENT_TRANSFER_INTENT_TTL_MS);
  let planned: PlannedUpload[] = [];

  return withFileUploadQuota(input.serverId, requestedBytes, async () => {
    planned = input.files.map((file) => {
      const id = randomUUID();
      const transferIntentId = randomUUID();
      const objectId = randomUUID();
      const extension = path.extname(file.filename).toLowerCase();
      const storageKey = `${input.serverId}/${id}${extension}`;
      const plannedThumbnailKey = input.cdnStorage && input.preview.canGenerate(file.mimeType)
        ? `thumbs/${input.serverId}/${id}.webp`
        : null;
      return { transferIntentId, id, objectId, storageKey, plannedThumbnailKey, file };
    });

    await getDb().transaction(async (tx) => {
      for (const item of planned) {
        await createAttachmentTransferIntentWithExecutor(tx, {
          id: item.transferIntentId,
          reservationId: item.id,
          objectId: item.objectId,
          serverId: input.serverId,
          channelId: input.channelId,
          uploaderId: input.uploaderId,
          uploaderType: input.uploaderType,
          filename: item.file.filename,
          mimeType: item.file.mimeType,
          declaredSizeBytes: item.file.buffer.length,
          expiresAt,
          artifacts: buildAttachmentTransferArtifactPlan({
            storageKey: item.storageKey,
            thumbnailKey: item.plannedThumbnailKey,
            mimeType: item.file.mimeType,
          }),
        }, now);
      }
    });

    try {
      const writeResults = await Promise.allSettled(planned.map(async (item) => {
        await input.storage.put(item.storageKey, item.file.buffer, item.file.mimeType);
        let thumbnailKey: string | null = null;
        if (input.cdnStorage && item.plannedThumbnailKey) {
          try {
            const thumbnail = await input.preview.generateThumbnail(item.file.buffer, item.file.mimeType);
            if (input.preview.isSvg(item.file.mimeType)) {
              const raster = await input.preview.generateSvgRasterPreview(item.file.buffer);
              await input.cdnStorage.put(
                buildSvgRasterTransferKey(item.plannedThumbnailKey),
                raster,
                "image/webp",
              );
            }
            await input.cdnStorage.put(item.plannedThumbnailKey, thumbnail, "image/webp");
            thumbnailKey = item.plannedThumbnailKey;
          } catch {
            // The original remains publishable. Every preview key was already
            // planned, so partial writes are swept instead of becoming blobs
            // with no durable owner.
          }
        }
        return { ...item, thumbnailKey };
      }));
      const failedWrite = writeResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedWrite) throw failedWrite.reason;
      const written = writeResults.map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value;
      });

      return await getDb().transaction(async (tx) => {
        const rows = [];
        for (const item of written) {
          rows.push(await createPendingAttachmentProjectionWithExecutor(tx, {
            id: item.id,
            objectId: item.objectId,
            transferIntentId: item.transferIntentId,
            serverId: input.serverId,
            channelId: input.channelId,
            uploaderId: input.uploaderId,
            uploaderType: input.uploaderType,
            filename: item.file.filename,
            mimeType: item.file.mimeType,
            sizeBytes: item.file.buffer.length,
            storageKey: item.storageKey,
            thumbnailKey: item.thumbnailKey,
            contentHash: item.file.contentHash ?? null,
          }, now));
        }
        return rows;
      });
    } catch (error) {
      await terminalizeAll(planned, "Attachment transfer did not publish.");
      throw error;
    }
  }, now);
}
