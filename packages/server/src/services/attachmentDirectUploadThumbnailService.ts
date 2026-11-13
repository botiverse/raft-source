import type { Readable } from "node:stream";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { clearClockInterval, currentDate, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  attachmentObjects,
  attachments,
  attachmentStorageArtifacts,
  attachmentUploadSessions,
} from "../db/schema";
import {
  generateDirectUploadThumbnail,
  generateSvgRasterPreview,
  isSvgAttachmentMimeType,
  isThumbnailPixelLimitError,
} from "../routes/attachments";
import { errorClassOf, withTraceRoot } from "../tracing/semanticTrace";
import { readStreamPrefix } from "./attachmentPreviews/utils";
import {
  ensureAttachmentArtifactOwnershipWithExecutor,
  type AttachmentArtifactOwnership,
} from "./attachmentArtifactOwnershipService";
import { buildSvgRasterTransferKey } from "./attachmentTransferIntentService";
import {
  buildAttachmentThumbnailKey,
  isPublicContentV2WriteConfigured,
  type StorageBackend,
} from "./storageService";

// Direct uploads (upload sessions) go straight to object storage, so unlike the
// multipart path no thumbnail is written while uploading (task #57). This
// worker generates it after completion: never in the completing request,
// bounded in bytes, pixels, time and concurrency, owned before it is written,
// and broadcast to clients that already show the message.

/** Originals larger than this are not read at all. */
export const DIRECT_UPLOAD_THUMBNAIL_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** Tries before a thumbnail is given up (the message is unaffected). */
export const DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS = 3;
/**
 * Thumbnails generated at once in one server process. Measured (task #57):
 * a 64 MP raster original adds up to ~120 MB (sharp holds the original and
 * decodes it), two at once ~260 MB; a HEIC is decoded whole into RGBA (up to
 * 256 MB at its 64 MP cap), so one at a time keeps the worst case near the
 * 300 MB budget. Raise only with a new measurement.
 */
export const DIRECT_UPLOAD_THUMBNAIL_CONCURRENCY = 1;
/** A read of the original that takes longer is abandoned and retried. */
export const DIRECT_UPLOAD_THUMBNAIL_READ_TIMEOUT_MS = 2 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

type SessionRow = typeof attachmentUploadSessions.$inferSelect;
/** A claimed row: the lease it was claimed with guards every later write. */
export type DirectUploadThumbnailClaim = SessionRow & { thumbnailLeaseExpiresAt: Date };
export type DirectUploadThumbnailOutcome = "done" | "skipped" | "failed" | "retry" | "lost_lease" | "idle";

export type DirectUploadThumbnailDeps = Readonly<{
  /** Reads originals; the routed attachment storage reaches the direct-upload bucket. */
  storage: StorageBackend;
  /** Where thumbnails are written; without it nothing is generated (as for multipart). */
  cdnStorage: StorageBackend | null;
  now?: () => Date;
  readTimeoutMs?: number;
  /** Re-broadcast messages whose attachment just gained a thumbnail. */
  notifyMessagesUpdated?: (messageIds: readonly string[]) => Promise<void>;
  /** Test seam: runs after the thumbnail is written, before it is published. */
  afterWrite?: () => Promise<void>;
}>;

const pending = sql`${attachmentUploadSessions.thumbnailState} = 'pending'`;
const leaseFree = (now: Date) => or(
  isNull(attachmentUploadSessions.thumbnailLeaseExpiresAt),
  lt(attachmentUploadSessions.thumbnailLeaseExpiresAt, now),
);

/**
 * Claim the oldest pending thumbnail whose lease is free, counting the attempt.
 * A row that already used every attempt is failed here, not processed: its
 * last attempt may have taken the process down before it could record that.
 */
async function claimNext(now: Date): Promise<DirectUploadThumbnailClaim | null> {
  const db = getDb();
  await db.update(attachmentUploadSessions).set({
    thumbnailState: "failed",
    thumbnailLeaseExpiresAt: null,
    updatedAt: now,
  }).where(and(
    pending,
    leaseFree(now),
    gte(attachmentUploadSessions.thumbnailAttempts, DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS),
  ));
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const rows = await db.update(attachmentUploadSessions).set({
    thumbnailLeaseExpiresAt: leaseExpiresAt,
    thumbnailAttempts: sql`${attachmentUploadSessions.thumbnailAttempts} + 1`,
    updatedAt: now,
  }).where(eq(attachmentUploadSessions.id, sql`(
    SELECT ${attachmentUploadSessions.id} FROM ${attachmentUploadSessions}
    WHERE ${pending}
      AND (${attachmentUploadSessions.thumbnailLeaseExpiresAt} IS NULL
        OR ${attachmentUploadSessions.thumbnailLeaseExpiresAt} < ${now})
      AND ${attachmentUploadSessions.thumbnailAttempts} < ${DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS}
    ORDER BY ${attachmentUploadSessions.completedAt}
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )`)).returning();
  const row = rows[0];
  return row ? { ...row, thumbnailLeaseExpiresAt: leaseExpiresAt } : null;
}

/** Only the holder of the claimed lease may write the outcome. */
const heldBy = (claim: DirectUploadThumbnailClaim) => and(
  eq(attachmentUploadSessions.id, claim.id),
  eq(attachmentUploadSessions.thumbnailLeaseExpiresAt, claim.thumbnailLeaseExpiresAt),
);

async function settle<S extends "skipped" | "failed">(
  claim: DirectUploadThumbnailClaim,
  state: S,
  now: Date,
): Promise<S | "lost_lease"> {
  const rows = await getDb().update(attachmentUploadSessions).set({
    thumbnailState: state,
    thumbnailLeaseExpiresAt: null,
    updatedAt: now,
  }).where(heldBy(claim)).returning({ id: attachmentUploadSessions.id });
  return rows.length > 0 ? state : "lost_lease";
}

async function retryLater(claim: DirectUploadThumbnailClaim, now: Date): Promise<"retry" | "failed" | "lost_lease"> {
  if (claim.thumbnailAttempts >= DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS) return settle(claim, "failed", now);
  const rows = await getDb().update(attachmentUploadSessions).set({
    thumbnailLeaseExpiresAt: new Date(now.getTime() + RETRY_DELAY_MS),
    updatedAt: now,
  }).where(heldBy(claim)).returning({ id: attachmentUploadSessions.id });
  return rows.length > 0 ? "retry" : "lost_lease";
}

/**
 * Read the original whole, never past the byte cap, abandoning a stalled read.
 * sharp buffers its input anyway; a buffer turns a reset connection into a
 * rejected read instead of an error event nothing listens to.
 */
async function readOriginal(storage: StorageBackend, key: string, timeoutMs: number): Promise<Buffer | "too_large"> {
  const source: Readable = await storage.get(key);
  const timer = setTimeout(() => source.destroy(new Error("thumbnail source read timed out")), timeoutMs);
  try {
    const { buffer, truncated } = await readStreamPrefix(source, DIRECT_UPLOAD_THUMBNAIL_MAX_SOURCE_BYTES);
    return truncated ? "too_large" : buffer;
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
}

async function deleteQuietly(storage: StorageBackend, keys: readonly string[]): Promise<void> {
  for (const key of keys) await storage.delete(key).catch(() => undefined);
}

/** Generate one claimed session's thumbnail. Exported for tests. */
export async function processDirectUploadThumbnail(
  deps: DirectUploadThumbnailDeps,
  claim: DirectUploadThumbnailClaim,
): Promise<DirectUploadThumbnailOutcome> {
  const now = deps.now ?? currentDate;
  const db = getDb();
  const cdnStorage = deps.cdnStorage;
  const sizeBytes = claim.verifiedSizeBytes ?? claim.declaredSizeBytes;
  if (!cdnStorage || sizeBytes > DIRECT_UPLOAD_THUMBNAIL_MAX_SOURCE_BYTES) return settle(claim, "skipped", now());

  const [projection] = await db.select({ objectId: attachments.objectId }).from(attachments)
    .where(eq(attachments.id, claim.attachmentId)).limit(1);
  const objectId = projection?.objectId ?? null;
  const [object] = objectId
    ? await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, objectId)).limit(1)
    : [];
  if (!object || object.lifecycleState !== "active" || object.thumbnailKey) return settle(claim, "skipped", now());

  const generation = isPublicContentV2WriteConfigured() ? "v2" : "legacy";
  const thumbnailKey = buildAttachmentThumbnailKey(claim.serverId, claim.attachmentId, generation);
  const svgRasterKey = isSvgAttachmentMimeType(claim.mimeType) ? buildSvgRasterTransferKey(thumbnailKey) : null;
  const ownerships: AttachmentArtifactOwnership[] = [
    { backend: "cdn", storageKey: thumbnailKey, objectId: object.id, role: "thumbnail" },
    ...(svgRasterKey ? [{ backend: "cdn" as const, storageKey: svgRasterKey, objectId: object.id, role: "svg_raster_preview" as const }] : []),
  ];
  const writtenKeys = ownerships.map((ownership) => ownership.storageKey);

  try {
    // Owned before written: deleting the attachment deletes these keys, and a
    // crash between the write and the commit below leaves no orphan.
    await db.transaction((tx) => ensureAttachmentArtifactOwnershipWithExecutor(tx, [], ownerships, now()));
    const original = await readOriginal(deps.storage, claim.storageKey, deps.readTimeoutMs ?? DIRECT_UPLOAD_THUMBNAIL_READ_TIMEOUT_MS);
    if (original === "too_large") return settle(claim, "skipped", now());
    const thumbnail = await generateDirectUploadThumbnail(original, claim.mimeType);
    const svgRaster = svgRasterKey ? await generateSvgRasterPreview(original) : null;
    if (svgRasterKey && svgRaster) await cdnStorage.put(svgRasterKey, svgRaster, "image/webp");
    await cdnStorage.put(thumbnailKey, thumbnail, "image/webp");
  } catch (err) {
    if (isThumbnailPixelLimitError(err)) return settle(claim, "skipped", now());
    console.error("[direct-upload-thumbnail] generation failed", {
      uploadId: claim.id,
      attempt: claim.thumbnailAttempts,
      errorClass: errorClassOf(err),
    });
    return retryLater(claim, now());
  }
  await deps.afterWrite?.();

  const result = await db.transaction(async (tx) => {
    const at = now();
    // The attachment may have been deleted while generating: the GC could
    // have swept the (then absent) keys, so publishing now would orphan them.
    const [locked] = await tx.select({ lifecycleState: attachmentObjects.lifecycleState, thumbnailKey: attachmentObjects.thumbnailKey })
      .from(attachmentObjects).where(eq(attachmentObjects.id, object.id)).for("update");
    if (!locked || locked.lifecycleState !== "active" || locked.thumbnailKey) return { outcome: "gone" as const };
    const held = await tx.update(attachmentUploadSessions).set({
      thumbnailState: "done",
      thumbnailLeaseExpiresAt: null,
      updatedAt: at,
    }).where(heldBy(claim)).returning({ id: attachmentUploadSessions.id });
    if (held.length === 0) return { outcome: "lost_lease" as const };
    await tx.update(attachmentStorageArtifacts).set({ availabilityState: "verified", updatedAt: at }).where(and(
      eq(attachmentStorageArtifacts.backend, "cdn"),
      inArray(attachmentStorageArtifacts.storageKey, writtenKeys),
    ));
    // The key lives on the object only; every projection of it reads it there.
    await tx.update(attachmentObjects).set({ thumbnailKey }).where(eq(attachmentObjects.id, object.id));
    const linked = await tx.selectDistinct({ messageId: attachments.messageId }).from(attachments)
      .where(and(eq(attachments.objectId, object.id), isNotNull(attachments.messageId)));
    return { outcome: "done" as const, messageIds: linked.map((row) => row.messageId).filter((id): id is string => !!id) };
  });

  if (result.outcome === "gone") {
    await deleteQuietly(cdnStorage, writtenKeys);
    return settle(claim, "skipped", now());
  }
  if (result.outcome === "lost_lease") return "lost_lease";
  if (result.messageIds.length > 0 && deps.notifyMessagesUpdated) {
    await deps.notifyMessagesUpdated(result.messageIds).catch((err) => {
      console.error("[direct-upload-thumbnail] message update broadcast failed", { uploadId: claim.id, errorClass: errorClassOf(err) });
    });
  }
  return "done";
}

/** Claim and process the next pending thumbnail, if any. */
export async function processNextDirectUploadThumbnail(deps: DirectUploadThumbnailDeps): Promise<DirectUploadThumbnailOutcome> {
  const claim = await claimNext((deps.now ?? currentDate)());
  if (!claim) return "idle";
  return processDirectUploadThumbnail(deps, claim);
}

/** Claim without processing. Exported for tests (a worker that dies mid-way). */
export const claimNextDirectUploadThumbnailForTests = claimNext;

export type DirectUploadThumbnailWorker = Readonly<{
  /** Wake the worker (after an upload completes); returns at once. */
  kick: () => void;
  stop: () => void;
}>;

/**
 * Drains pending thumbnails at most `concurrency` at a time, on a kick and on
 * an interval (which also resumes work a restart or an expired lease left).
 */
export function startDirectUploadThumbnailWorker(
  deps: DirectUploadThumbnailDeps,
  opts: { concurrency?: number; intervalMs?: number; tracer?: Tracer } = {},
): DirectUploadThumbnailWorker {
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? DIRECT_UPLOAD_THUMBNAIL_CONCURRENCY));
  const tracer = opts.tracer ?? noopTracer;
  let running = 0;
  let stopped = false;
  const drainOne = (): void => {
    if (stopped || running >= concurrency) return;
    running += 1;
    withTraceRoot(
      tracer,
      "server.attachment_direct_upload_thumbnail.process",
      { surface: "server", kind: "internal" },
      () => processNextDirectUploadThumbnail(deps),
      "server.attachment_direct_upload_thumbnail.error",
    ).then((outcome) => {
      running -= 1;
      if (outcome !== "idle") drainOne();
    }, (err) => {
      // A DB or storage outage: wait for the next interval instead of spinning.
      running -= 1;
      console.error("[direct-upload-thumbnail] worker run failed", { errorClass: errorClassOf(err) });
    });
  };
  const kick = () => {
    for (let slot = 0; slot < concurrency; slot += 1) drainOne();
  };
  kick();
  const timer = setClockInterval(kick, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  return {
    kick,
    stop: () => {
      stopped = true;
      clearClockInterval(timer);
    },
  };
}
