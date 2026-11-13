import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, gt, inArray, lt, or } from "drizzle-orm";
import { clearClockInterval, currentDate, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import type { AttachmentUploadSessionService, AttachmentUploadSessionContext, AttachmentUploadSessionResult, CreateAttachmentUploadSessionInput } from "../routes/attachmentUploadSessions";
import { canGenerateImagePreview, normalizeAttachmentFilename, normalizeUploadedMimeType } from "../routes/attachments";
import { getDb, type DatabaseTransaction } from "../db/index";
import { attachmentObjects, attachments, attachmentUploadReservations, attachmentUploadSessions } from "../db/schema";
import { type ResolvedAttachment, withAttachmentObjectMetadata } from "./attachmentRecord";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService";
import { terminateAttachmentReservationWithExecutor } from "./attachmentLifecycleService";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntentWithExecutor,
  terminalizeAttachmentTransferIntentWithExecutor,
} from "./attachmentTransferIntentService";
import {
  getAttachmentFileSizeLimitBytes,
  getEffectiveAttachmentDirectUploadThresholdBytes,
  getLegacyAttachmentFileSizeLimitBytes,
} from "./attachmentUploadPolicy";
import {
  FileUploadQuotaExceededError,
  getFileUploadQuotaSummary,
  reserveFileUploadQuotaForSession,
  withFileUploadQuotaReservationLock,
  finalizeFileUploadQuotaReservationInTransaction,
  releaseFileUploadQuotaReservationInTransaction,
  type FileUploadQuotaReservation,
} from "./fileUploadQuotaService";
import type { StorageBackend } from "./storageService";
import * as channelService from "./channelService";
import {
  assertChannelWritableInTransaction,
  assertChannelWritableOrConversionDrainInTransaction,
  ChannelConversionInProgressError,
} from "./channelConversionFenceService";
import { reconcileConversionUploadBlocker } from "./channelConversionUploadReconciliation";
import { errorClassOf, withTraceRoot } from "../tracing/semanticTrace";
import {
  buildDirectAttachmentStorageKey,
  getDirectUploadStorage,
  getStorage,
} from "./storageService";

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const VERIFICATION_LEASE_MS = 30 * 1000;
const CLEANUP_LEASE_MS = 5 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

type SessionRow = typeof attachmentUploadSessions.$inferSelect;
type AttachmentRow = ResolvedAttachment;
type CleanupClaim = { session: SessionRow; leaseId: string };

export interface AttachmentUploadSessionServiceHooks {
  beforeTerminalTransition?: (
    uploadId: string,
    state: "canceled" | "expired" | "failed",
  ) => Promise<void>;
  beforePublicationTransition?: (uploadId: string) => Promise<void>;
  afterPublicationFence?: (uploadId: string) => Promise<void>;
}

const forbidden = (message = "The member cannot access this upload."): AttachmentUploadSessionResult => ({
  status: 403,
  body: { code: "UPLOAD_FORBIDDEN", message, retryable: false },
});

const sessionNotFound = (): AttachmentUploadSessionResult => ({
  status: 404,
  body: { code: "UPLOAD_SESSION_NOT_FOUND", message: "The upload session does not exist.", retryable: false },
});

const objectNotFound = (): AttachmentUploadSessionResult => ({
  status: 404,
  body: {
    code: "UPLOAD_OBJECT_NOT_FOUND",
    message: "The uploaded object is not visible yet.",
    retryable: true,
    retryAfterMs: 500,
  },
});

const expired = (): AttachmentUploadSessionResult => ({
  status: 410,
  body: { code: "UPLOAD_SESSION_EXPIRED", message: "The upload session expired.", retryable: false },
});

const mismatch = (): AttachmentUploadSessionResult => ({
  status: 422,
  body: { code: "UPLOAD_OBJECT_MISMATCH", message: "The uploaded object does not match the reservation.", retryable: false },
});

const conversionBlocked = (operation: "create" | "complete" | "cancel"): AttachmentUploadSessionResult => operation === "complete"
  ? {
      status: 409,
      body: {
        code: "UPLOAD_VERIFICATION_IN_PROGRESS",
        message: "Channel conversion is in progress; complete the upload after conversion finishes.",
        retryable: true,
        retryAfterMs: 1000,
      },
    }
  : {
      status: 403,
      body: {
        code: "UPLOAD_FORBIDDEN",
        message: "Uploads are paused while this channel is being converted.",
        retryable: false,
      },
    };

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function isAttachmentDirectUploadEnabled(): boolean {
  return process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED?.trim().toLowerCase() === "true";
}

function sessionTtlMs(): number {
  return integerEnv("ATTACHMENT_DIRECT_UPLOAD_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS, 60_000, 86_400_000);
}

function quotaReservation(row: SessionRow): FileUploadQuotaReservation {
  return {
    serverId: row.serverId,
    month: row.quotaMonth,
    bytes: row.quotaReservedBytes,
    limited: row.quotaLimited,
  };
}

function attachmentBody(row: AttachmentRow) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    thumbnailUrl: null,
  };
}

async function attachmentForSession(row: SessionRow): Promise<AttachmentRow | null> {
  if (row.state !== "completed") return null;
  const [found] = await getDb()
    .select({ projection: attachments, object: attachmentObjects })
    .from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(eq(attachments.id, row.attachmentId))
    .limit(1);
  if (!found) return null;
  // Type and size come from the object only.
  return withAttachmentObjectMetadata(found.projection, found.object);
}

async function sessionBody(row: SessionRow) {
  const attachment = await attachmentForSession(row);
  const [reservation] = row.state === "completed"
    ? await getDb().select({ state: attachmentUploadReservations.state })
        .from(attachmentUploadReservations)
        .where(eq(attachmentUploadReservations.id, row.attachmentId))
        .limit(1)
    : [];
  return {
    uploadId: row.id,
    state: row.state,
    expiresAt: row.expiresAt.toISOString(),
    attachment: attachment ? attachmentBody(attachment) : null,
    terminalReason: row.terminalReason,
    reservationState: reservation?.state ?? null,
  };
}

function sameCreate(row: SessionRow, input: CreateAttachmentUploadSessionInput): boolean {
  return row.channelId === input.channelId
    && row.filename === normalizeAttachmentFilename(input.filename)
    && row.mimeType === normalizeUploadedMimeType(input.filename, input.mimeType)
    && row.declaredSizeBytes === input.sizeBytes;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function uploadActor(context: AttachmentUploadSessionContext): Readonly<{
  id: string;
  type: "user" | "agent";
}> {
  return context.agentId
    ? { id: context.agentId, type: "agent" }
    : { id: context.userId!, type: "user" };
}

export class DurableAttachmentUploadSessionService implements AttachmentUploadSessionService {
  private readonly directUploadEnabled: boolean;
  private readonly onThumbnailPending: (() => void) | undefined;

  constructor(
    private readonly storage: StorageBackend,
    private readonly now: () => Date = currentDate,
    private readonly hooks: AttachmentUploadSessionServiceHooks = {},
    options: Readonly<{
      directUploadEnabled?: boolean;
      /** Wakes the thumbnail worker after a completed image upload (it never blocks completion). */
      onThumbnailPending?: () => void;
    }> = {},
  ) {
    this.directUploadEnabled = options.directUploadEnabled ?? true;
    this.onThumbnailPending = options.onThumbnailPending;
    if (this.directUploadEnabled && (!storage.head || !storage.getPresignedPutUrl)) {
      throw new Error("Direct attachment uploads require storage head and conditional presign support");
    }
  }

  async capabilities(context: AttachmentUploadSessionContext): Promise<AttachmentUploadSessionResult> {
    const quota = await getFileUploadQuotaSummary(context.serverId, this.now());
    if (!this.directUploadEnabled) {
      return {
        status: 200,
        body: {
          directUploadEnabled: false,
          directUploadThresholdBytes: null,
          maxBytes: getLegacyAttachmentFileSizeLimitBytes(quota.plan),
          sessionExpiresInSeconds: null,
        },
      };
    }
    return {
      status: 200,
      body: {
        directUploadEnabled: true,
        directUploadThresholdBytes: getEffectiveAttachmentDirectUploadThresholdBytes(quota.plan, this.now()),
        maxBytes: getAttachmentFileSizeLimitBytes(quota.plan),
        sessionExpiresInSeconds: Math.floor(sessionTtlMs() / 1000),
      },
    };
  }

  async listActive(context: AttachmentUploadSessionContext, channelId: string): Promise<AttachmentUploadSessionResult> {
    if (!context.userId) return forbidden("Only human members can recover browser uploads.");
    const canAccess = await channelService.canUserAccessChannel(channelId, context.userId, context.serverId);
    if (!canAccess || !await channelService.canUserPostToChannel(channelId, context.userId)) {
      return forbidden("The member cannot access uploads in this channel.");
    }
    const rows = await getDb().select({
      uploadId: attachmentUploadSessions.id,
      filename: attachmentUploadSessions.filename,
      mimeType: attachmentUploadSessions.mimeType,
      sizeBytes: attachmentUploadSessions.declaredSizeBytes,
      state: attachmentUploadSessions.state,
      expiresAt: attachmentUploadSessions.expiresAt,
    }).from(attachmentUploadSessions).where(and(
      eq(attachmentUploadSessions.serverId, context.serverId),
      eq(attachmentUploadSessions.channelId, channelId),
      eq(attachmentUploadSessions.uploaderType, "user"),
      eq(attachmentUploadSessions.uploaderId, context.userId),
      inArray(attachmentUploadSessions.state, ["pending", "verifying"]),
      gt(attachmentUploadSessions.expiresAt, this.now()),
    )).orderBy(attachmentUploadSessions.createdAt).limit(100);
    return {
      status: 200,
      body: {
        uploads: rows.map((row) => ({
          uploadId: row.uploadId,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          state: row.state,
          expiresAt: row.expiresAt.toISOString(),
        })),
      },
    };
  }

  async create(
    context: AttachmentUploadSessionContext,
    input: CreateAttachmentUploadSessionInput,
  ): Promise<AttachmentUploadSessionResult> {
    if (!this.directUploadEnabled || !this.storage.getPresignedPutUrl) {
      return forbidden("Direct uploads are disabled; cancel any unfinished upload instead.");
    }
    const actor = uploadActor(context);
    const normalizedInput = {
      ...input,
      filename: normalizeAttachmentFilename(input.filename),
      mimeType: normalizeUploadedMimeType(input.filename, input.mimeType),
    };
    const existing = await this.findByRequest(context, input.clientRequestId);
    if (existing) return this.replayCreate(existing, normalizedInput);

    const now = this.now();
    const quota = await getFileUploadQuotaSummary(context.serverId, now);
    if (input.sizeBytes > getAttachmentFileSizeLimitBytes(quota.plan)) {
      return {
        status: 413,
        body: { code: "UPLOAD_TOO_LARGE", message: "The attachment exceeds the plan limit.", retryable: false },
      };
    }

    const uploadId = randomUUID();
    const attachmentId = randomUUID();
    const objectId = randomUUID();
    const storageObjectId = randomUUID();
    const storageKey = buildDirectAttachmentStorageKey(context.serverId, uploadId, storageObjectId);
    const expiresAt = new Date(now.getTime() + sessionTtlMs());
    const uploadUrl = await this.storage.getPresignedPutUrl!(storageKey, {
      expiresIn: Math.ceil(sessionTtlMs() / 1000),
      contentType: normalizedInput.mimeType,
      ifNoneMatch: "*",
    });

    try {
      await reserveFileUploadQuotaForSession(
        context.serverId,
        input.sizeBytes,
        async (tx, reservation) => {
          await createAttachmentTransferIntentWithExecutor(tx, {
            id: uploadId,
            reservationId: attachmentId,
            objectId,
            serverId: context.serverId,
            channelId: input.channelId,
            uploaderId: actor.id,
            uploaderType: actor.type,
            filename: normalizedInput.filename,
            mimeType: normalizedInput.mimeType,
            declaredSizeBytes: input.sizeBytes,
            expiresAt,
            artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType: normalizedInput.mimeType }),
          }, now);
          await tx.insert(attachmentUploadSessions).values({
            id: uploadId,
            serverId: context.serverId,
            channelId: input.channelId,
            uploaderId: actor.id,
            uploaderType: actor.type,
            attachmentId,
            objectId,
            transferIntentId: uploadId,
            clientRequestId: input.clientRequestId,
            filename: normalizedInput.filename,
            mimeType: normalizedInput.mimeType,
            declaredSizeBytes: input.sizeBytes,
            storageKey,
            quotaMonth: reservation.month,
            quotaReservedBytes: reservation.bytes,
            quotaLimited: reservation.limited,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          });
        },
        now,
      );
    } catch (err) {
      if (err instanceof ChannelConversionInProgressError) return conversionBlocked("create");
      if (err instanceof FileUploadQuotaExceededError) return forbidden("The monthly upload quota is exhausted.");
      if (isUniqueViolation(err)) {
        const raced = await this.findByRequest(context, input.clientRequestId);
        if (raced) return this.replayCreate(raced, normalizedInput);
      }
      throw err;
    }

    return {
      status: 201,
      body: this.createBody({ id: uploadId, attachmentId, expiresAt, mimeType: normalizedInput.mimeType }, uploadUrl),
    };
  }

  async complete(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    const actor = uploadActor(context);
    let session = await this.findOwned(context, uploadId);
    if (!session) return forbidden("The member cannot complete this upload.");
    if (session.state === "completed") return this.completedResult(session);
    if (!this.directUploadEnabled) return forbidden("Direct uploads are disabled; cancel the unfinished upload.");
    if (!this.storage.head) return forbidden("The upload verifier is unavailable; cancel the unfinished upload.");
    if (session.state === "expired") return expired();
    if (session.state === "canceled" || session.state === "failed") return mismatch();
    if (session.expiresAt <= this.now()) {
      const cleanupClaim = await this.releaseTerminal(session, "expired", "Upload session expired.");
      if (cleanupClaim) await this.deleteClaimedObject(cleanupClaim);
      return expired();
    }

    const leaseId = randomUUID();
    let lease: SessionRow | "forbidden" | "busy" | "terminal";
    try {
      lease = await getDb().transaction(async (tx) => {
      const [locked] = await tx.select().from(attachmentUploadSessions)
        .where(and(
          eq(attachmentUploadSessions.id, uploadId),
          eq(attachmentUploadSessions.serverId, context.serverId),
          eq(attachmentUploadSessions.uploaderId, actor.id),
          eq(attachmentUploadSessions.uploaderType, actor.type),
        ))
        .for("update")
        .limit(1);
      if (!locked) return "forbidden" as const;
      await assertChannelWritableInTransaction(tx, locked.channelId);
      if (locked.state === "completed") return locked;
      if (locked.state === "verifying" && locked.verificationLeaseExpiresAt && locked.verificationLeaseExpiresAt > this.now()) {
        return "busy" as const;
      }
      if (locked.state !== "pending" && locked.state !== "verifying") return "terminal" as const;
      const leaseExpiresAt = new Date(this.now().getTime() + VERIFICATION_LEASE_MS);
      const [updated] = await tx.update(attachmentUploadSessions).set({
        state: "verifying",
        verificationLeaseId: leaseId,
        verificationLeaseExpiresAt: leaseExpiresAt,
        updatedAt: this.now(),
      }).where(eq(attachmentUploadSessions.id, locked.id)).returning();
      return updated;
      });
    } catch (err) {
      if (err instanceof ChannelConversionInProgressError) return conversionBlocked("complete");
      throw err;
    }
    if (lease === "forbidden") return forbidden("The member cannot complete this upload.");
    if (lease === "busy") {
      return {
        status: 409,
        body: {
          code: "UPLOAD_VERIFICATION_IN_PROGRESS",
          message: "Verification is already in progress.",
          retryable: true,
          retryAfterMs: 1000,
        },
      };
    }
    if (lease === "terminal") {
      session = await this.findOwned(context, uploadId) ?? session;
      return session.state === "completed" ? this.completedResult(session) : mismatch();
    }
    if (lease.state === "completed") return this.completedResult(lease);

    let object: Awaited<ReturnType<NonNullable<StorageBackend["head"]>>>;
    try {
      object = await this.storage.head(lease.storageKey);
    } catch {
      await this.returnLeaseToPending(lease.id, leaseId);
      return objectNotFound();
    }
    if (!object) {
      await this.returnLeaseToPending(lease.id, leaseId);
      return objectNotFound();
    }
    if (object.sizeBytes !== lease.declaredSizeBytes || object.contentType !== lease.mimeType) {
      const cleanupClaim = await this.releaseTerminal(
        lease,
        "failed",
        "Uploaded object metadata did not match the reservation.",
        leaseId,
      );
      if (cleanupClaim) await this.deleteClaimedObject(cleanupClaim);
      return mismatch();
    }

    await this.hooks.beforePublicationTransition?.(lease.id);

    let completed: SessionRow | null;
    try {
      completed = await withFileUploadQuotaReservationLock(quotaReservation(lease), async (tx) => {
      const [locked] = await tx.select().from(attachmentUploadSessions)
        .where(eq(attachmentUploadSessions.id, lease.id)).for("update").limit(1);
      if (!locked) return null;
      await assertChannelWritableInTransaction(tx, locked.channelId);
      await this.hooks.afterPublicationFence?.(locked.id);
      if (locked.state === "completed") return locked;
      if (locked.state !== "verifying" || locked.verificationLeaseId !== leaseId || locked.quotaState !== "reserved") {
        return locked;
      }
      // Compatibility for sessions created by an older task during rollout:
      // new sessions already persisted this intent before their PUT URL was
      // returned, while an old in-flight row gets an explicit cleanup owner
      // before it can publish.
      const transferIntent = await createAttachmentTransferIntentWithExecutor(tx, {
        id: locked.transferIntentId ?? locked.id,
        reservationId: locked.attachmentId,
        objectId: locked.objectId ?? randomUUID(),
        serverId: locked.serverId,
        channelId: locked.channelId,
        uploaderId: locked.uploaderId,
        uploaderType: locked.uploaderType,
        filename: locked.filename,
        mimeType: locked.mimeType,
        declaredSizeBytes: locked.declaredSizeBytes,
        expiresAt: locked.expiresAt,
        artifacts: buildAttachmentTransferArtifactPlan({ storageKey: locked.storageKey, mimeType: locked.mimeType }),
      }, this.now());
      await createPendingAttachmentProjectionWithExecutor(tx, {
        id: locked.attachmentId,
        objectId: transferIntent.objectId,
        transferIntentId: transferIntent.id,
        serverId: locked.serverId,
        channelId: locked.channelId,
        uploaderId: locked.uploaderId,
        uploaderType: locked.uploaderType,
        filename: locked.filename,
        mimeType: locked.mimeType,
        sizeBytes: locked.declaredSizeBytes,
        storageKey: locked.storageKey,
        thumbnailKey: null,
        contentHash: null,
        chargeMonth: locked.quotaMonth,
      }, this.now());
      await finalizeFileUploadQuotaReservationInTransaction(tx, quotaReservation(locked));
      const [updated] = await tx.update(attachmentUploadSessions).set({
        state: "completed",
        quotaState: "finalized",
        verificationLeaseId: null,
        verificationLeaseExpiresAt: null,
        objectEtag: object.etag,
        verifiedSizeBytes: object.sizeBytes,
        verifiedContentType: object.contentType,
        // The thumbnail worker picks a previewable image up after this commit
        // (task #57); anything else never gets one.
        thumbnailState: canGenerateImagePreview(locked.mimeType) ? "pending" : "skipped",
        completedAt: this.now(),
        updatedAt: this.now(),
      }).where(eq(attachmentUploadSessions.id, locked.id)).returning();
      return updated;
      });
    } catch (err) {
      if (err instanceof ChannelConversionInProgressError) return conversionBlocked("complete");
      throw err;
    }
    if (!completed) return forbidden("The member cannot complete this upload.");
    if (completed.state === "completed" && completed.thumbnailState === "pending") this.onThumbnailPending?.();
    if (completed.state !== "completed") {
      return {
        status: 409,
        body: {
          code: "UPLOAD_VERIFICATION_IN_PROGRESS",
          message: "Verification is already in progress.",
          retryable: true,
          retryAfterMs: 1000,
        },
      };
    }
    return this.completedResult(completed);
  }

  async cancel(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    const session = await this.findOwned(context, uploadId);
    if (!session) return sessionNotFound();
    if (session.state === "completed") {
      let reservation;
      try {
        reservation = await getDb().transaction(async (tx) => {
          await assertChannelWritableOrConversionDrainInTransaction(tx, session.channelId, {
            kind: "reservation",
            id: session.attachmentId,
          });
          return terminateAttachmentReservationWithExecutor(
            tx,
            session.attachmentId,
            "canceled",
            "Canceled by member.",
            this.now(),
            {},
            true,
          );
        });
      } catch (err) {
        if (err instanceof ChannelConversionInProgressError) return conversionBlocked("cancel");
        throw err;
      }
      if (reservation?.state === "consumed") {
        return {
          status: 409,
          body: {
            code: "ATTACHMENT_ALREADY_CONSUMED",
            message: "The completed upload is already attached to a message.",
            retryable: false,
          },
        };
      }
      return { status: 200, body: await sessionBody(session) };
    }
    if (session.quotaState === "reserved") {
      let cleanupClaim: CleanupClaim | null;
      try {
        cleanupClaim = await this.releaseTerminal(session, "canceled", "Canceled by member.");
      } catch (err) {
        if (err instanceof ChannelConversionInProgressError) return conversionBlocked("cancel");
        throw err;
      }
      if (cleanupClaim) await this.deleteClaimedObject(cleanupClaim);
    }
    // Recompute the durable prepare blocker after terminal upload cleanup.
    await reconcileConversionUploadBlocker(session.channelId);
    const current = await this.findOwned(context, uploadId);
    return current ? { status: 200, body: await sessionBody(current) } : sessionNotFound();
  }

  async status(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    let session = await this.findOwned(context, uploadId);
    if (!session) return sessionNotFound();
    if ((session.state === "pending" || session.state === "verifying") && session.expiresAt <= this.now()) {
      const cleanupClaim = await this.releaseTerminal(session, "expired", "Upload session expired.");
      if (cleanupClaim) await this.deleteClaimedObject(cleanupClaim);
      session = await this.findOwned(context, uploadId) ?? session;
    }
    return { status: 200, body: await sessionBody(session) };
  }

  async cleanupExpiredSessions(): Promise<number> {
    const candidates = await getDb().select().from(attachmentUploadSessions)
      .where(or(
        and(
          inArray(attachmentUploadSessions.state, ["pending", "verifying"]),
          lt(attachmentUploadSessions.expiresAt, this.now()),
        ),
        and(
          inArray(attachmentUploadSessions.state, ["canceled", "expired", "failed"]),
          or(
            eq(attachmentUploadSessions.objectCleanupState, "pending"),
            and(
              eq(attachmentUploadSessions.objectCleanupState, "deleting"),
              lt(attachmentUploadSessions.updatedAt, new Date(this.now().getTime() - CLEANUP_LEASE_MS)),
            ),
          ),
        ),
      ))
      .limit(SWEEP_BATCH_SIZE);
    let cleaned = 0;
    for (const session of candidates) {
      const cleanupClaim = session.quotaState === "reserved"
        ? await this.releaseTerminal(session, "expired", "Upload session expired.")
        : await this.claimPendingCleanup(session.id);
      if (!cleanupClaim) continue;
      await this.deleteClaimedObject(cleanupClaim);
      cleaned += 1;
    }
    return cleaned;
  }

  private async replayCreate(
    row: SessionRow,
    input: CreateAttachmentUploadSessionInput,
  ): Promise<AttachmentUploadSessionResult> {
    if (!sameCreate(row, input) || row.state !== "pending" || row.expiresAt <= this.now()) {
      return {
        status: 409,
        body: {
          code: "UPLOAD_IDEMPOTENCY_CONFLICT",
          message: "The request id was used for a different or terminal upload.",
          retryable: false,
        },
      };
    }
    const uploadUrl = await this.storage.getPresignedPutUrl!(row.storageKey, {
      expiresIn: Math.max(1, Math.ceil((row.expiresAt.getTime() - this.now().getTime()) / 1000)),
      contentType: row.mimeType,
      ifNoneMatch: "*",
    });
    return { status: 201, body: this.createBody(row, uploadUrl) };
  }

  private createBody(
    row: Pick<SessionRow, "id" | "attachmentId" | "expiresAt" | "mimeType">,
    uploadUrl: string,
  ) {
    return {
      uploadId: row.id,
      attachmentId: row.attachmentId,
      state: "pending" as const,
      expiresAt: row.expiresAt.toISOString(),
      upload: {
        method: "PUT" as const,
        url: uploadUrl,
        headers: { "Content-Type": row.mimeType, "If-None-Match": "*" as const },
      },
    };
  }

  private async completedResult(row: SessionRow): Promise<AttachmentUploadSessionResult> {
    const attachment = await attachmentForSession(row);
    if (!attachment) throw new Error(`Completed upload session ${row.id} has no attachment`);
    return {
      status: 200,
      body: { uploadId: row.id, state: "completed", attachment: attachmentBody(attachment) },
    };
  }

  private async findByRequest(context: AttachmentUploadSessionContext, clientRequestId: string): Promise<SessionRow | null> {
    const actor = uploadActor(context);
    const [row] = await getDb().select().from(attachmentUploadSessions).where(and(
      eq(attachmentUploadSessions.serverId, context.serverId),
      eq(attachmentUploadSessions.uploaderType, actor.type),
      eq(attachmentUploadSessions.uploaderId, actor.id),
      eq(attachmentUploadSessions.clientRequestId, clientRequestId),
    )).limit(1);
    return row ?? null;
  }

  private async findOwned(context: AttachmentUploadSessionContext, uploadId: string): Promise<SessionRow | null> {
    const actor = uploadActor(context);
    const [row] = await getDb().select().from(attachmentUploadSessions).where(and(
      eq(attachmentUploadSessions.id, uploadId),
      eq(attachmentUploadSessions.serverId, context.serverId),
      eq(attachmentUploadSessions.uploaderType, actor.type),
      eq(attachmentUploadSessions.uploaderId, actor.id),
    )).limit(1);
    return row ?? null;
  }

  private async returnLeaseToPending(uploadId: string, leaseId: string): Promise<void> {
    await getDb().update(attachmentUploadSessions).set({
      state: "pending",
      verificationLeaseId: null,
      verificationLeaseExpiresAt: null,
      updatedAt: this.now(),
    }).where(and(
      eq(attachmentUploadSessions.id, uploadId),
      eq(attachmentUploadSessions.state, "verifying"),
      eq(attachmentUploadSessions.verificationLeaseId, leaseId),
    ));
  }

  private async releaseTerminal(
    row: SessionRow,
    state: "canceled" | "expired" | "failed",
    terminalReason: string,
    leaseId?: string,
  ): Promise<CleanupClaim | null> {
    await this.hooks.beforeTerminalTransition?.(row.id, state);
    const cleanupLeaseId = randomUUID();
    return withFileUploadQuotaReservationLock(quotaReservation(row), async (tx) => {
      const [locked] = await tx.select().from(attachmentUploadSessions)
        .where(eq(attachmentUploadSessions.id, row.id)).for("update").limit(1);
      if (!locked || locked.quotaState !== "reserved" || locked.state === "completed") return null;
      await assertChannelWritableOrConversionDrainInTransaction(tx, locked.channelId, {
        kind: "session",
        id: locked.id,
      });
      if (leaseId && (locked.state !== "verifying" || locked.verificationLeaseId !== leaseId)) return null;
      await releaseFileUploadQuotaReservationInTransaction(tx, quotaReservation(locked));
      if (locked.transferIntentId) {
        await terminalizeAttachmentTransferIntentWithExecutor(
          tx,
          locked.transferIntentId,
          state,
          terminalReason,
          this.now(),
          true,
        );
      }
      await terminateAttachmentReservationWithExecutor(
        tx,
        locked.attachmentId,
        state === "expired" ? "expired" : "canceled",
        terminalReason,
        this.now(),
        {},
        true,
      );
      const [updated] = await tx.update(attachmentUploadSessions).set({
        state,
        quotaState: "released",
        verificationLeaseId: null,
        verificationLeaseExpiresAt: null,
        terminalReason,
        objectCleanupState: "deleting",
        objectCleanupLeaseId: cleanupLeaseId,
        updatedAt: this.now(),
      }).where(eq(attachmentUploadSessions.id, locked.id)).returning();
      return updated ? { session: updated, leaseId: cleanupLeaseId } : null;
    });
  }

  private async claimPendingCleanup(uploadId: string): Promise<CleanupClaim | null> {
    return getDb().transaction(async (tx) => {
      const [locked] = await tx.select().from(attachmentUploadSessions)
        .where(eq(attachmentUploadSessions.id, uploadId)).for("update").limit(1);
      if (!locked || !["canceled", "expired", "failed"].includes(locked.state)) return null;
      const staleCleanupLease = locked.objectCleanupState === "deleting"
        && locked.updatedAt < new Date(this.now().getTime() - CLEANUP_LEASE_MS);
      if (locked.objectCleanupState !== "pending" && !staleCleanupLease) return null;
      const cleanupLeaseId = randomUUID();
      const [claimed] = await tx.update(attachmentUploadSessions).set({
        objectCleanupState: "deleting",
        objectCleanupLeaseId: cleanupLeaseId,
        updatedAt: this.now(),
      }).where(and(
        eq(attachmentUploadSessions.id, locked.id),
        inArray(attachmentUploadSessions.state, ["canceled", "expired", "failed"]),
        eq(attachmentUploadSessions.objectCleanupState, locked.objectCleanupState),
      )).returning();
      return claimed ? { session: claimed, leaseId: cleanupLeaseId } : null;
    });
  }

  private async deleteClaimedObject(claim: CleanupClaim): Promise<void> {
    try {
      await this.storage.delete(claim.session.storageKey);
      await getDb().update(attachmentUploadSessions).set({
        objectCleanupState: "deleted",
        objectCleanupLeaseId: null,
        updatedAt: this.now(),
      }).where(and(
        eq(attachmentUploadSessions.id, claim.session.id),
        inArray(attachmentUploadSessions.state, ["canceled", "expired", "failed"]),
        eq(attachmentUploadSessions.objectCleanupState, "deleting"),
        eq(attachmentUploadSessions.objectCleanupLeaseId, claim.leaseId),
      ));
    } catch (err) {
      await getDb().update(attachmentUploadSessions).set({
        objectCleanupState: "pending",
        objectCleanupLeaseId: null,
        updatedAt: this.now(),
      }).where(and(
        eq(attachmentUploadSessions.id, claim.session.id),
        inArray(attachmentUploadSessions.state, ["canceled", "expired", "failed"]),
        eq(attachmentUploadSessions.objectCleanupState, "deleting"),
        eq(attachmentUploadSessions.objectCleanupLeaseId, claim.leaseId),
      ));
      console.warn("[attachment-upload-cleanup] object delete failed", {
        errorClass: errorClassOf(err),
      });
    }
  }
}

export function createDurableAttachmentUploadSessionService(
  options: Readonly<{ onThumbnailPending?: () => void }> = {},
): DurableAttachmentUploadSessionService | null {
  const attachmentStorage = getStorage();
  const storage = getDirectUploadStorage();
  const directUploadEnabled = isAttachmentDirectUploadEnabled();
  if (directUploadEnabled && (!attachmentStorage || !storage?.head || !storage.getPresignedPutUrl)) return null;
  // Preserve cancellation/reconciliation of existing sessions when new upload admission is off.
  const recoveryStorage: StorageBackend = storage ?? attachmentStorage ?? {
    put: async () => {},
    get: async () => Readable.from([]),
    delete: async () => {},
  };
  return new DurableAttachmentUploadSessionService(recoveryStorage, currentDate, {}, {
    directUploadEnabled,
    onThumbnailPending: options.onThumbnailPending,
  });
}

export function startAttachmentUploadSessionCleanup(
  service: DurableAttachmentUploadSessionService,
  tracer: Tracer = noopTracer,
): () => void {
  // Each sweep is a root span. A failure also records the
  // `server.attachment_upload_session_cleanup.error` event inside it.
  const run = () => withTraceRoot(
    tracer,
    "server.attachment_upload_session_cleanup.sweep",
    { surface: "server", kind: "internal" },
    () => service.cleanupExpiredSessions(),
    "server.attachment_upload_session_cleanup.error",
  ).catch((err) => {
    console.error("[attachment-upload-cleanup] sweep failed", err);
  });
  run();
  const timer = setClockInterval(run, 15 * 60 * 1000);
  return () => clearClockInterval(timer);
}
