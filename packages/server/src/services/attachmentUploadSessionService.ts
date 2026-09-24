import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";
import { isAttachmentDirectUploadEnabledForServer } from "../config/attachmentDirectUpload.js";
import type { AttachmentUploadSessionService, AttachmentUploadSessionContext, AttachmentUploadSessionResult, CreateAttachmentUploadSessionInput } from "../routes/attachmentUploadSessions.js";
import { normalizeAttachmentFilename, normalizeUploadedMimeType } from "../routes/attachments.js";
import { getDb, type DatabaseTransaction } from "../db/index.js";
import { attachments, attachmentUploadReservations, attachmentUploadSessions } from "../db/schema.js";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService.js";
import { cancelAttachmentReservation } from "./attachmentLifecycleService.js";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntentWithExecutor,
  terminalizeAttachmentTransferIntentWithExecutor,
} from "./attachmentTransferIntentService.js";
import {
  getAttachmentFileSizeLimitBytes,
  getEffectiveAttachmentDirectUploadThresholdBytes,
  getLegacyAttachmentFileSizeLimitBytes,
} from "./attachmentUploadPolicy.js";
import {
  FileUploadQuotaExceededError,
  getFileUploadQuotaSummary,
  reserveFileUploadQuotaForSession,
  withFileUploadQuotaReservationLock,
  finalizeFileUploadQuotaReservationInTransaction,
  releaseFileUploadQuotaReservationInTransaction,
  type FileUploadQuotaReservation,
} from "./fileUploadQuotaService.js";
import type { StorageBackend } from "./storageService.js";
import {
  ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX,
  getDirectUploadStorage,
  getStorage,
} from "./storageService.js";

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const VERIFICATION_LEASE_MS = 30 * 1000;
const CLEANUP_LEASE_MS = 5 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

type SessionRow = typeof attachmentUploadSessions.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;
type CleanupClaim = { session: SessionRow; leaseId: string };

export interface AttachmentUploadSessionServiceHooks {
  beforeTerminalTransition?: (
    uploadId: string,
    state: "canceled" | "expired" | "failed",
  ) => Promise<void>;
}

export type AttachmentDirectUploadGate = (
  context: AttachmentUploadSessionContext,
) => Promise<boolean>;

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
  const [attachment] = await getDb().select().from(attachments).where(eq(attachments.id, row.attachmentId)).limit(1);
  return attachment ?? null;
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
  constructor(
    private readonly storage: StorageBackend,
    private readonly isEnabledForServer: AttachmentDirectUploadGate,
    private readonly now: () => Date = currentDate,
    private readonly hooks: AttachmentUploadSessionServiceHooks = {},
  ) {
    if (!storage.head || !storage.getPresignedPutUrl) {
      throw new Error("Direct attachment uploads require storage head and conditional presign support");
    }
  }

  async capabilities(context: AttachmentUploadSessionContext): Promise<AttachmentUploadSessionResult> {
    const quota = await getFileUploadQuotaSummary(context.serverId, this.now());
    if (!await this.isEnabledForServer(context)) {
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

  async create(
    context: AttachmentUploadSessionContext,
    input: CreateAttachmentUploadSessionInput,
  ): Promise<AttachmentUploadSessionResult> {
    if (!await this.isEnabledForServer(context)) return forbidden("Direct uploads are disabled for this server.");
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
    const storageKey = `${ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX}${context.serverId}/${uploadId}/${randomUUID()}`;
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
    if (!await this.isEnabledForServer(context)) return forbidden("Direct uploads are disabled for this server.");
    const actor = uploadActor(context);
    let session = await this.findOwned(context, uploadId);
    if (!session) return forbidden("The member cannot complete this upload.");
    if (session.state === "completed") return this.completedResult(session);
    if (session.state === "expired") return expired();
    if (session.state === "canceled" || session.state === "failed") return mismatch();
    if (session.expiresAt <= this.now()) {
      const cleanupClaim = await this.releaseTerminal(session, "expired", "Upload session expired.");
      if (cleanupClaim) await this.deleteClaimedObject(cleanupClaim);
      return expired();
    }

    const leaseId = randomUUID();
    const lease = await getDb().transaction(async (tx) => {
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
      object = await this.storage.head!(lease.storageKey);
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

    const completed = await withFileUploadQuotaReservationLock(quotaReservation(lease), async (tx) => {
      const [locked] = await tx.select().from(attachmentUploadSessions)
        .where(eq(attachmentUploadSessions.id, lease.id)).for("update").limit(1);
      if (!locked) return null;
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
        completedAt: this.now(),
        updatedAt: this.now(),
      }).where(eq(attachmentUploadSessions.id, locked.id)).returning();
      return updated;
    });
    if (!completed) return forbidden("The member cannot complete this upload.");
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
    if (!await this.isEnabledForServer(context)) return forbidden("Direct uploads are disabled for this server.");
    const session = await this.findOwned(context, uploadId);
    if (!session) return sessionNotFound();
    if (session.state === "completed") {
      const reservation = await cancelAttachmentReservation(session.attachmentId);
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
      const cleanupClaim = await this.releaseTerminal(session, "canceled", "Canceled by member.");
      if (cleanupClaim) await this.deleteClaimedObject(cleanupClaim);
    }
    const current = await this.findOwned(context, uploadId);
    return current ? { status: 200, body: await sessionBody(current) } : sessionNotFound();
  }

  async status(context: AttachmentUploadSessionContext, uploadId: string): Promise<AttachmentUploadSessionResult> {
    if (!await this.isEnabledForServer(context)) return forbidden("Direct uploads are disabled for this server.");
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
      if (leaseId && (locked.state !== "verifying" || locked.verificationLeaseId !== leaseId)) return null;
      await releaseFileUploadQuotaReservationInTransaction(tx, quotaReservation(locked));
      if (locked.transferIntentId) {
        await terminalizeAttachmentTransferIntentWithExecutor(
          tx,
          locked.transferIntentId,
          state,
          terminalReason,
          this.now(),
        );
      }
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
        errorClass: err instanceof Error ? err.name : typeof err,
      });
    }
  }
}

export function createDurableAttachmentUploadSessionService(): DurableAttachmentUploadSessionService | null {
  if (!isAttachmentDirectUploadEnabled()) return null;
  // Completed objects are read and garbage-collected through the shared
  // attachment storage router. Require that route as well as the dedicated
  // writer so we cannot create objects that the application cannot retrieve.
  const attachmentStorage = getStorage();
  const storage = getDirectUploadStorage();
  if (!attachmentStorage || !storage?.head || !storage.getPresignedPutUrl) return null;
  return new DurableAttachmentUploadSessionService(
    storage,
    isAttachmentDirectUploadEnabledForServer,
    currentDate,
    {},
  );
}

export function startAttachmentUploadSessionCleanup(service: DurableAttachmentUploadSessionService): () => void {
  const run = () => service.cleanupExpiredSessions().catch((err) => {
    console.error("[attachment-upload-cleanup] sweep failed", err);
  });
  run();
  const timer = setClockInterval(run, 15 * 60 * 1000);
  return () => clearClockInterval(timer);
}
