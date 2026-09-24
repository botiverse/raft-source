import { randomUUID } from "node:crypto";
import { clearClockInterval, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db/index.js";
import { getDb } from "../db/index.js";
import {
  type AttachmentUploaderType,
  attachmentObjectArtifacts,
  attachmentObjectGcJobs,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachments,
  attachmentUploadReservations,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import { getCdnStorage, getStorage } from "./storageService.js";
import {
  attachmentLifecycleGcJobs,
  attachmentLifecycleGcOldestPendingSeconds,
  attachmentLifecycleGcOutcomesTotal,
  attachmentLifecycleSweepsTotal,
} from "../metrics.js";
import { addTraceEvent, withTraceRoot } from "../tracing/semanticTrace.js";
import {
  adoptAttachmentTransferIntentWithExecutor,
  cleanupAttachmentTransferArtifacts,
} from "./attachmentTransferIntentService.js";

export const ATTACHMENT_RESERVATION_TTL_MS = 60 * 60 * 1000;
export const ATTACHMENT_LIFECYCLE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const ATTACHMENT_LIFECYCLE_BATCH_SIZE = 100;
const ATTACHMENT_GC_LEASE_MS = 60 * 1000;
const ATTACHMENT_GC_RETRY_MS = 30 * 1000;
const ATTACHMENT_GC_MAX_ATTEMPTS = 10;

export type AttachmentLifecycleFoundationInput = {
  transferIntentId: string;
  reservationId: string;
  objectId: string;
  serverId: string;
  channelId: string;
  creatorId: string;
  creatorType: AttachmentUploaderType;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  thumbnailKey?: string | null;
};

type ReservationRow = typeof attachmentUploadReservations.$inferSelect;
type ArtifactRow = typeof attachmentStorageArtifacts.$inferSelect;

export type AttachmentLifecycleHooks = Readonly<{
  afterObjectAndReservationLock?: (
    reservation: ReservationRow,
    terminalState: "canceled" | "expired",
  ) => Promise<void>;
}>;

export type AttachmentLifecycleSweepHooks = Readonly<{
  afterGcJobLease?: (claim: { objectId: string; leaseId: string }) => Promise<void>;
  afterGcJobOutcome?: (result: {
    objectId: string;
    leaseId: string;
    outcome: AttachmentGcOutcome;
  }) => Promise<void>;
}>;

export type AttachmentGcOutcome = "completed" | "blocked" | "retry" | "dead_letter" | "lease_lost";

export async function resolveAttachmentLifecycleDatabaseNow(
  executor: DatabaseExecutor,
  explicitNow?: Date,
): Promise<Date> {
  if (explicitNow) return explicitNow;
  const result = await executor.execute(sql`SELECT CURRENT_TIMESTAMP AS now`);
  const [row] = result.rows as Array<{ now: Date | string }>;
  if (!row?.now) throw new Error("Database did not return CURRENT_TIMESTAMP.");
  return row.now instanceof Date ? row.now : new Date(row.now);
}

export class AttachmentLifecycleError extends Error {
  readonly code: "attachment_expired" | "attachment_canceled" | "attachment_lifecycle_conflict";

  constructor(
    code: "attachment_expired" | "attachment_canceled" | "attachment_lifecycle_conflict",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentLifecycleError";
    this.code = code;
  }
}

/**
 * Publish the completed-upload reservation and every physical artifact in the
 * same transaction as object/charge creation. A uniqueness conflict is a
 * protocol violation: new uploads may not attach a new object to an existing
 * physical key.
 */
export async function createAttachmentLifecycleFoundationWithExecutor(
  executor: DatabaseTransaction,
  input: AttachmentLifecycleFoundationInput,
  explicitNow?: Date,
): Promise<ReservationRow> {
  const now = await resolveAttachmentLifecycleDatabaseNow(executor, explicitNow);
  await adoptAttachmentTransferIntentWithExecutor(executor, {
    id: input.transferIntentId,
    reservationId: input.reservationId,
    objectId: input.objectId,
    serverId: input.serverId,
    channelId: input.channelId,
    uploaderId: input.creatorId,
    uploaderType: input.creatorType,
    filename: input.filename,
    mimeType: input.mimeType,
    declaredSizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    thumbnailKey: input.thumbnailKey,
  }, now);

  const [reservation] = await executor.insert(attachmentUploadReservations).values({
    id: input.reservationId,
    objectId: input.objectId,
    originServerId: input.serverId,
    channelId: input.channelId,
    creatorId: input.creatorId,
    creatorType: input.creatorType,
    filename: input.filename,
    state: "pending",
    expiresAt: new Date(now.getTime() + ATTACHMENT_RESERVATION_TTL_MS),
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!reservation) {
    throw new AttachmentLifecycleError(
      "attachment_lifecycle_conflict",
      `Attachment reservation ${input.reservationId} was not created.`,
    );
  }
  return reservation;
}

async function lockObjectThenReservation(
  executor: DatabaseExecutor,
  reservationId: string,
): Promise<{ reservation: ReservationRow; object: typeof attachmentObjects.$inferSelect } | null> {
  const [mapping] = await executor.select({ objectId: attachmentUploadReservations.objectId })
    .from(attachmentUploadReservations)
    .where(eq(attachmentUploadReservations.id, reservationId))
    .limit(1);
  if (!mapping) return null;

  const [object] = await executor.select().from(attachmentObjects)
    .where(eq(attachmentObjects.id, mapping.objectId))
    .for("update")
    .limit(1);
  if (!object) return null;
  const [reservation] = await executor.select().from(attachmentUploadReservations)
    .where(eq(attachmentUploadReservations.id, reservationId))
    .for("update")
    .limit(1);
  if (!reservation || reservation.objectId !== object.id) return null;
  return { reservation, object };
}

/**
 * Lock all new-model reservations for send using the canonical object-first
 * order. Legacy projections have no reservation and are returned separately
 * by the caller during the rolling compatibility phase.
 */
export async function lockAttachmentReservationsForConsumeWithExecutor(
  executor: DatabaseExecutor,
  reservationIds: string[],
  creatorId: string,
  explicitNow?: Date,
): Promise<Map<string, ReservationRow>> {
  if (reservationIds.length === 0) return new Map();
  const mappings = await executor.select({
    id: attachmentUploadReservations.id,
    objectId: attachmentUploadReservations.objectId,
  }).from(attachmentUploadReservations)
    .where(inArray(attachmentUploadReservations.id, reservationIds));
  if (mappings.length === 0) return new Map();
  const now = await resolveAttachmentLifecycleDatabaseNow(executor, explicitNow);

  const objectIds = [...new Set(mappings.map((row) => row.objectId))].sort();
  const objects = await executor.select().from(attachmentObjects)
    .where(inArray(attachmentObjects.id, objectIds))
    .orderBy(asc(attachmentObjects.id))
    .for("update");
  const activeObjectIds = new Set(
    objects.filter((object) => object.lifecycleState === "active").map((object) => object.id),
  );

  const rows = await executor.select().from(attachmentUploadReservations)
    .where(inArray(attachmentUploadReservations.id, reservationIds))
    .orderBy(asc(attachmentUploadReservations.id))
    .for("update");
  const result = new Map<string, ReservationRow>();
  for (const reservation of rows) {
    if (reservation.creatorId !== creatorId) {
      throw new AttachmentLifecycleError(
        "attachment_lifecycle_conflict",
        `Attachment ${reservation.id} is not available for this sender.`,
      );
    }
    if (reservation.state === "expired") {
      throw new AttachmentLifecycleError(
        "attachment_expired",
        `Attachment ${reservation.id} expired before the message was sent. Re-upload the file.`,
      );
    }
    if (reservation.state === "canceled") {
      throw new AttachmentLifecycleError(
        "attachment_canceled",
        `Attachment ${reservation.id} was canceled. Re-upload the file.`,
      );
    }
    if (!activeObjectIds.has(reservation.objectId)) {
      throw new AttachmentLifecycleError(
        "attachment_lifecycle_conflict",
        `Attachment ${reservation.id} is not available for this sender.`,
      );
    }
    if (reservation.state === "pending" && reservation.expiresAt <= now) {
      throw new AttachmentLifecycleError(
        "attachment_expired",
        `Attachment ${reservation.id} expired before the message was sent. Re-upload the file.`,
      );
    }
    result.set(reservation.id, reservation);
  }
  return result;
}

export async function consumeAttachmentReservationsWithExecutor(
  executor: DatabaseExecutor,
  reservations: Map<string, ReservationRow>,
  messageId: string,
  explicitNow?: Date,
): Promise<void> {
  if (reservations.size === 0) return;
  const now = await resolveAttachmentLifecycleDatabaseNow(executor, explicitNow);
  for (const reservation of reservations.values()) {
    if (reservation.state === "consumed") {
      if (reservation.consumedMessageId !== messageId) {
        throw new AttachmentLifecycleError(
          "attachment_lifecycle_conflict",
          `Attachment ${reservation.id} is already attached to another message.`,
        );
      }
      continue;
    }
    if (reservation.state !== "pending") {
      throw new AttachmentLifecycleError(
        "attachment_lifecycle_conflict",
        `Attachment ${reservation.id} is not pending.`,
      );
    }
    const [updated] = await executor.update(attachmentUploadReservations).set({
      state: "consumed",
      consumedMessageId: messageId,
      terminalAt: now,
      terminalReason: null,
      updatedAt: now,
    }).where(and(
      eq(attachmentUploadReservations.id, reservation.id),
      eq(attachmentUploadReservations.state, "pending"),
    )).returning({ id: attachmentUploadReservations.id });
    if (!updated) {
      throw new AttachmentLifecycleError(
        "attachment_lifecycle_conflict",
        `Attachment ${reservation.id} could not be consumed.`,
      );
    }
  }
}

async function claimObjectGcIfUnreferencedWithExecutor(
  executor: DatabaseExecutor,
  objectId: string,
  now: Date,
): Promise<string | null> {
  const [activeProjection] = await executor.select({ id: attachments.id }).from(attachments)
    .where(and(
      eq(attachments.objectId, objectId),
      isNull(attachments.revokedAt),
      isNotNull(attachments.messageId),
    ))
    .limit(1);
  const [pendingReservation] = await executor.select({ id: attachmentUploadReservations.id })
    .from(attachmentUploadReservations)
    .where(and(
      eq(attachmentUploadReservations.objectId, objectId),
      eq(attachmentUploadReservations.state, "pending"),
    ))
    .limit(1);
  if (activeProjection || pendingReservation) return null;

  const gcToken = randomUUID();
  const [claimed] = await executor.update(attachmentObjects).set({
    lifecycleState: "gc_pending",
    gcToken,
    gcStartedAt: now,
  }).where(and(
    eq(attachmentObjects.id, objectId),
    eq(attachmentObjects.lifecycleState, "active"),
  )).returning({ id: attachmentObjects.id });
  if (!claimed) return null;
  await executor.insert(attachmentObjectGcJobs).values({
    objectId,
    gcToken,
    state: "ready",
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return gcToken;
}

export async function terminateAttachmentReservationWithExecutor(
  executor: DatabaseExecutor,
  reservationId: string,
  terminalState: "canceled" | "expired",
  reason: string,
  now: Date,
  hooks: AttachmentLifecycleHooks = {},
): Promise<ReservationRow | null> {
  const locked = await lockObjectThenReservation(executor, reservationId);
  if (!locked) return null;
  const { reservation, object } = locked;
  await hooks.afterObjectAndReservationLock?.(reservation, terminalState);
  if (reservation.state !== "pending") return reservation;
  if (terminalState === "expired" && reservation.expiresAt > now) return null;

  const [updated] = await executor.update(attachmentUploadReservations).set({
    state: terminalState,
    terminalAt: now,
    terminalReason: reason,
    consumedMessageId: null,
    updatedAt: now,
  }).where(and(
    eq(attachmentUploadReservations.id, reservation.id),
    eq(attachmentUploadReservations.state, "pending"),
  )).returning();
  if (!updated) return null;

  // Remove only the rollback-compatible pending projection while holding the
  // same object/reservation fence. A concurrently consumed projection cannot
  // satisfy message_id IS NULL after the consumer wins the reservation lock.
  await executor.delete(attachments).where(and(
    eq(attachments.id, reservation.id),
    eq(attachments.objectId, object.id),
    isNull(attachments.messageId),
  ));
  await claimObjectGcIfUnreferencedWithExecutor(executor, object.id, now);
  return updated;
}

export async function expireAttachmentReservation(
  reservationId: string,
  explicitNow?: Date,
  db: Database = getDb(),
  hooks: AttachmentLifecycleHooks = {},
): Promise<ReservationRow | null> {
  return db.transaction(async (tx) => {
    const now = await resolveAttachmentLifecycleDatabaseNow(tx, explicitNow);
    return terminateAttachmentReservationWithExecutor(
      tx,
      reservationId,
      "expired",
      "Completed upload expired before it was sent.",
      now,
      hooks,
    );
  });
}

export async function cancelAttachmentReservation(
  reservationId: string,
  explicitNow?: Date,
  db: Database = getDb(),
  hooks: AttachmentLifecycleHooks = {},
): Promise<ReservationRow | null> {
  return db.transaction(async (tx) => {
    const now = await resolveAttachmentLifecycleDatabaseNow(tx, explicitNow);
    return terminateAttachmentReservationWithExecutor(
      tx,
      reservationId,
      "canceled",
      "Canceled by member.",
      now,
      hooks,
    );
  });
}

type GcClaim = {
  job: typeof attachmentObjectGcJobs.$inferSelect;
  leaseId: string;
  artifacts: Array<ArtifactRow & { role: string }>;
};

async function claimNextGcJob(db: Database, now: Date): Promise<GcClaim | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(attachmentObjectGcJobs)
      .where(or(
        and(
          inArray(attachmentObjectGcJobs.state, ["ready", "retry", "blocked"]),
          lte(attachmentObjectGcJobs.nextAttemptAt, now),
        ),
        and(
          eq(attachmentObjectGcJobs.state, "leased"),
          lt(attachmentObjectGcJobs.leaseExpiresAt, now),
        ),
      ))
      .orderBy(
        sql`CASE WHEN ${attachmentObjectGcJobs.state} = 'blocked' THEN 1 ELSE 0 END`,
        asc(attachmentObjectGcJobs.nextAttemptAt),
        asc(attachmentObjectGcJobs.objectId),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate) return null;
    const leaseId = randomUUID();
    const [job] = await tx.update(attachmentObjectGcJobs).set({
      state: "leased",
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + ATTACHMENT_GC_LEASE_MS),
      attempts: candidate.attempts + 1,
      updatedAt: now,
    }).where(and(
      eq(attachmentObjectGcJobs.objectId, candidate.objectId),
      eq(attachmentObjectGcJobs.gcToken, candidate.gcToken),
      eq(attachmentObjectGcJobs.state, candidate.state),
    )).returning();
    if (!job) return null;
    const artifacts = await tx.select({
      id: attachmentStorageArtifacts.id,
      backend: attachmentStorageArtifacts.backend,
      storageKey: attachmentStorageArtifacts.storageKey,
      lifecycleState: attachmentStorageArtifacts.lifecycleState,
      availabilityState: attachmentStorageArtifacts.availabilityState,
      availabilityObservedAt: attachmentStorageArtifacts.availabilityObservedAt,
      deleteToken: attachmentStorageArtifacts.deleteToken,
      deleteLeaseId: attachmentStorageArtifacts.deleteLeaseId,
      deleteLeaseExpiresAt: attachmentStorageArtifacts.deleteLeaseExpiresAt,
      deleteAttempts: attachmentStorageArtifacts.deleteAttempts,
      lastErrorClass: attachmentStorageArtifacts.lastErrorClass,
      createdAt: attachmentStorageArtifacts.createdAt,
      updatedAt: attachmentStorageArtifacts.updatedAt,
      role: attachmentObjectArtifacts.role,
    }).from(attachmentObjectArtifacts)
      .innerJoin(
        attachmentStorageArtifacts,
        eq(attachmentStorageArtifacts.id, attachmentObjectArtifacts.artifactId),
      )
      .where(eq(attachmentObjectArtifacts.objectId, job.objectId))
      .orderBy(asc(attachmentStorageArtifacts.id));
    return { job, leaseId, artifacts };
  });
}

function backendForArtifact(
  artifact: Pick<ArtifactRow, "backend">,
  storage: StorageBackend | null,
  cdnStorage: StorageBackend | null,
): StorageBackend | null {
  return artifact.backend === "attachment" ? storage : cdnStorage;
}

async function markJobForRetry(
  db: Database,
  claim: GcClaim,
  now: Date,
  state: "retry" | "blocked",
  errorClass: string,
): Promise<"retry" | "blocked" | "dead_letter" | "lease_lost"> {
  const nextState = state === "retry" && claim.job.attempts >= ATTACHMENT_GC_MAX_ATTEMPTS
    ? "dead_letter"
    : state;
  const [updated] = await db.update(attachmentObjectGcJobs).set({
    state: nextState,
    leaseId: null,
    leaseExpiresAt: null,
    nextAttemptAt: new Date(now.getTime() + ATTACHMENT_GC_RETRY_MS),
    lastErrorClass: errorClass,
    updatedAt: now,
  }).where(and(
    eq(attachmentObjectGcJobs.objectId, claim.job.objectId),
    eq(attachmentObjectGcJobs.gcToken, claim.job.gcToken),
    eq(attachmentObjectGcJobs.state, "leased"),
    eq(attachmentObjectGcJobs.leaseId, claim.leaseId),
  )).returning({ objectId: attachmentObjectGcJobs.objectId });
  return updated ? nextState : "lease_lost";
}

async function deleteClaimedArtifact(
  db: Database,
  claim: GcClaim,
  artifact: GcClaim["artifacts"][number],
  now: Date,
  storage: StorageBackend | null,
  cdnStorage: StorageBackend | null,
): Promise<"deleted" | "blocked" | "retry"> {
  if (artifact.lifecycleState === "deleted") return "deleted";
  const artifactLeaseId = randomUUID();
  const deleteToken = artifact.deleteToken ?? randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(attachmentStorageArtifacts)
      .where(eq(attachmentStorageArtifacts.id, artifact.id))
      .for("update")
      .limit(1);
    if (!locked) return null;
    if (locked.lifecycleState === "deleted") return locked;
    if (
      locked.lifecycleState === "delete_pending"
      && locked.deleteLeaseId
      && locked.deleteLeaseExpiresAt
      && locked.deleteLeaseExpiresAt > now
    ) {
      return null;
    }
    const [activeSibling] = await tx.select({ id: attachmentObjects.id })
      .from(attachmentObjectArtifacts)
      .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachmentObjectArtifacts.objectId))
      .where(and(
        eq(attachmentObjectArtifacts.artifactId, artifact.id),
        eq(attachmentObjects.lifecycleState, "active"),
      ))
      .limit(1);
    if (activeSibling) return "blocked" as const;
    const [updated] = await tx.update(attachmentStorageArtifacts).set({
      lifecycleState: "delete_pending",
      deleteToken,
      deleteLeaseId: artifactLeaseId,
      deleteLeaseExpiresAt: new Date(now.getTime() + ATTACHMENT_GC_LEASE_MS),
      deleteAttempts: locked.deleteAttempts + 1,
      updatedAt: now,
    }).where(eq(attachmentStorageArtifacts.id, artifact.id)).returning();
    return updated ?? null;
  });
  if (claimed === "blocked") return "blocked";
  if (!claimed) return "retry";
  if (claimed.lifecycleState === "deleted") return "deleted";

  addTraceEvent("attachment.gc.artifact.claimed", {
    gc_token: claim.job.gcToken,
    gc_lease_id: claim.leaseId,
    artifact_delete_token: deleteToken,
    artifact_delete_lease_id: artifactLeaseId,
    artifact_backend: claimed.backend,
    artifact_role: artifact.role,
  });

  const backend = backendForArtifact(claimed, storage, cdnStorage);
  if (!backend) {
    await db.update(attachmentStorageArtifacts).set({
      deleteLeaseId: null,
      deleteLeaseExpiresAt: null,
      lastErrorClass: "STORAGE_BACKEND_UNAVAILABLE",
      updatedAt: now,
    }).where(and(
      eq(attachmentStorageArtifacts.id, claimed.id),
      eq(attachmentStorageArtifacts.lifecycleState, "delete_pending"),
      eq(attachmentStorageArtifacts.deleteToken, deleteToken),
      eq(attachmentStorageArtifacts.deleteLeaseId, artifactLeaseId),
    ));
    addTraceEvent("attachment.gc.artifact.delete.finished", {
      artifact_delete_token: deleteToken,
      artifact_delete_lease_id: artifactLeaseId,
      outcome: "backend_unavailable",
    });
    return "retry";
  }
  try {
    await backend.delete(claimed.storageKey);
  } catch (error) {
    await db.update(attachmentStorageArtifacts).set({
      deleteLeaseId: null,
      deleteLeaseExpiresAt: null,
      lastErrorClass: error instanceof Error ? error.name : typeof error,
      updatedAt: now,
    }).where(and(
      eq(attachmentStorageArtifacts.id, claimed.id),
      eq(attachmentStorageArtifacts.lifecycleState, "delete_pending"),
      eq(attachmentStorageArtifacts.deleteToken, deleteToken),
      eq(attachmentStorageArtifacts.deleteLeaseId, artifactLeaseId),
    ));
    addTraceEvent("attachment.gc.artifact.delete.finished", {
      artifact_delete_token: deleteToken,
      artifact_delete_lease_id: artifactLeaseId,
      outcome: "retry",
      error_class: error instanceof Error ? error.name : typeof error,
    });
    return "retry";
  }
  const [finished] = await db.update(attachmentStorageArtifacts).set({
    lifecycleState: "deleted",
    availabilityState: "missing",
    availabilityObservedAt: now,
    deleteLeaseId: null,
    deleteLeaseExpiresAt: null,
    lastErrorClass: null,
    updatedAt: now,
  }).where(and(
    eq(attachmentStorageArtifacts.id, claimed.id),
    eq(attachmentStorageArtifacts.lifecycleState, "delete_pending"),
    eq(attachmentStorageArtifacts.deleteToken, deleteToken),
    eq(attachmentStorageArtifacts.deleteLeaseId, artifactLeaseId),
  )).returning({ id: attachmentStorageArtifacts.id });
  addTraceEvent("attachment.gc.artifact.delete.finished", {
    artifact_delete_token: deleteToken,
    artifact_delete_lease_id: artifactLeaseId,
    outcome: finished ? "deleted" : "lease_lost",
  });
  return finished ? "deleted" : "retry";
}

async function processGcClaim(
  db: Database,
  claim: GcClaim,
  now: Date,
  storage: StorageBackend | null,
  cdnStorage: StorageBackend | null,
): Promise<AttachmentGcOutcome> {
  if (claim.artifacts.length === 0) {
    return markJobForRetry(db, claim, now, "blocked", "ARTIFACT_INVENTORY_MISSING");
  }
  for (const artifact of claim.artifacts) {
    const outcome = await deleteClaimedArtifact(db, claim, artifact, now, storage, cdnStorage);
    if (outcome === "blocked") {
      return markJobForRetry(db, claim, now, "blocked", "ARTIFACT_STILL_SHARED");
    }
    if (outcome === "retry") {
      return markJobForRetry(db, claim, now, "retry", "ARTIFACT_DELETE_RETRY");
    }
  }

  return db.transaction(async (tx) => {
    const [ownedJob] = await tx.select({ objectId: attachmentObjectGcJobs.objectId })
      .from(attachmentObjectGcJobs)
      .where(and(
        eq(attachmentObjectGcJobs.objectId, claim.job.objectId),
        eq(attachmentObjectGcJobs.gcToken, claim.job.gcToken),
        eq(attachmentObjectGcJobs.state, "leased"),
        eq(attachmentObjectGcJobs.leaseId, claim.leaseId),
      ))
      .for("update")
      .limit(1);
    if (!ownedJob) return "lease_lost" as const;
    const [remaining] = await tx.select({ id: attachmentStorageArtifacts.id })
      .from(attachmentObjectArtifacts)
      .innerJoin(
        attachmentStorageArtifacts,
        eq(attachmentStorageArtifacts.id, attachmentObjectArtifacts.artifactId),
      )
      .where(and(
        eq(attachmentObjectArtifacts.objectId, claim.job.objectId),
        ne(attachmentStorageArtifacts.lifecycleState, "deleted"),
      ))
      .limit(1);
    if (remaining) return "lease_lost" as const;
    const [completedObject] = await tx.update(attachmentObjects).set({ lifecycleState: "deleted" })
      .where(and(
        eq(attachmentObjects.id, claim.job.objectId),
        eq(attachmentObjects.lifecycleState, "gc_pending"),
        eq(attachmentObjects.gcToken, claim.job.gcToken),
      )).returning({ id: attachmentObjects.id });
    if (!completedObject) return "lease_lost" as const;
    const [completedJob] = await tx.update(attachmentObjectGcJobs).set({
      state: "completed",
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorClass: null,
      updatedAt: now,
    }).where(and(
      eq(attachmentObjectGcJobs.objectId, claim.job.objectId),
      eq(attachmentObjectGcJobs.gcToken, claim.job.gcToken),
      eq(attachmentObjectGcJobs.state, "leased"),
      eq(attachmentObjectGcJobs.leaseId, claim.leaseId),
    )).returning({ objectId: attachmentObjectGcJobs.objectId });
    if (!completedJob) {
      throw new Error(`Attachment GC job ${claim.job.objectId} lost its lease during finalization.`);
    }
    return "completed" as const;
  });
}

const GC_JOB_STATES = ["ready", "leased", "retry", "blocked", "dead_letter", "completed"] as const;

export type AttachmentLifecycleSweepMetrics = Readonly<{
  onGcOutcome?: (outcome: AttachmentGcOutcome) => void;
  onGcBacklog?: (state: typeof GC_JOB_STATES[number], count: number) => void;
  onGcOldestPendingSeconds?: (seconds: number) => void;
}>;

const defaultAttachmentLifecycleSweepMetrics: AttachmentLifecycleSweepMetrics = {
  onGcOutcome: (outcome) => attachmentLifecycleGcOutcomesTotal.inc({ outcome }),
  onGcBacklog: (state, count) => attachmentLifecycleGcJobs.set({ state }, count),
  onGcOldestPendingSeconds: (seconds) => attachmentLifecycleGcOldestPendingSeconds.set(seconds),
};

export async function runAttachmentLifecycleSweep(input: {
  db?: Database;
  now?: Date;
  storage?: StorageBackend | null;
  cdnStorage?: StorageBackend | null;
  hooks?: AttachmentLifecycleSweepHooks;
  metrics?: AttachmentLifecycleSweepMetrics | null;
} = {}): Promise<{
  expired: number;
  gcCompleted: number;
  transferArtifactsDeleted: number;
  transferArtifactFailures: number;
}> {
  const db = input.db ?? getDb();
  const now = await resolveAttachmentLifecycleDatabaseNow(db, input.now);
  const storage = input.storage === undefined ? getStorage() : input.storage;
  const cdnStorage = input.cdnStorage === undefined ? getCdnStorage() : input.cdnStorage;
  const metrics = input.metrics === undefined ? defaultAttachmentLifecycleSweepMetrics : input.metrics;
  const candidates = await db.select({ id: attachmentUploadReservations.id })
    .from(attachmentUploadReservations)
    .where(and(
      eq(attachmentUploadReservations.state, "pending"),
      lte(attachmentUploadReservations.expiresAt, now),
    ))
    .orderBy(asc(attachmentUploadReservations.expiresAt), asc(attachmentUploadReservations.id))
    .limit(ATTACHMENT_LIFECYCLE_BATCH_SIZE);
  let expired = 0;
  for (const candidate of candidates) {
    const result = await expireAttachmentReservation(candidate.id, now, db);
    if (result?.state === "expired") expired += 1;
  }

  let gcCompleted = 0;
  for (let index = 0; index < ATTACHMENT_LIFECYCLE_BATCH_SIZE; index += 1) {
    const claim = await claimNextGcJob(db, now);
    if (!claim) break;
    addTraceEvent("attachment.gc.job.claimed", {
      gc_token: claim.job.gcToken,
      gc_lease_id: claim.leaseId,
      artifact_count: claim.artifacts.length,
      attempt: claim.job.attempts,
    });
    await input.hooks?.afterGcJobLease?.({ objectId: claim.job.objectId, leaseId: claim.leaseId });
    const outcome = await processGcClaim(db, claim, now, storage, cdnStorage);
    metrics?.onGcOutcome?.(outcome);
    addTraceEvent("attachment.gc.job.finished", {
      gc_token: claim.job.gcToken,
      gc_lease_id: claim.leaseId,
      outcome,
    });
    await input.hooks?.afterGcJobOutcome?.({
      objectId: claim.job.objectId,
      leaseId: claim.leaseId,
      outcome,
    });
    if (outcome === "completed") gcCompleted += 1;
  }
  const transferCleanup = await cleanupAttachmentTransferArtifacts({
    db,
    now,
    storage,
    cdnStorage,
    limit: ATTACHMENT_LIFECYCLE_BATCH_SIZE,
  });
  if (metrics) {
    const result = await db.execute(sql`
      SELECT state, count(*)::int AS count
        FROM attachment_object_gc_jobs
       GROUP BY state
    `);
    const counts = new Map(
      (result.rows as Array<{ state: string; count: number | string }>)
        .map((row) => [row.state, Number(row.count)]),
    );
    for (const state of GC_JOB_STATES) metrics.onGcBacklog?.(state, counts.get(state) ?? 0);

    const oldestResult = await db.execute(sql`
      SELECT min(created_at) AS oldest
        FROM attachment_object_gc_jobs
       WHERE state <> 'completed'
    `);
    const [oldestRow] = oldestResult.rows as Array<{ oldest: Date | string | null }>;
    const oldest = oldestRow?.oldest
      ? oldestRow.oldest instanceof Date ? oldestRow.oldest : new Date(oldestRow.oldest)
      : null;
    metrics.onGcOldestPendingSeconds?.(
      oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1_000) : 0,
    );
  }
  return {
    expired,
    gcCompleted,
    transferArtifactsDeleted: transferCleanup.deleted,
    transferArtifactFailures: transferCleanup.failed,
  };
}

export type AttachmentFoundationReadiness = Readonly<{
  eligible: boolean;
  activeObjectsWithoutVerifiedOriginal: number;
  activeDetachedObjects: number;
  objectBackedPendingWithoutReservation: number;
  legacyObjectlessPending: number;
  gcDeadLetters: number;
}>;

/**
 * Aggregate-only DB gate used by migration/capability consumers. A database
 * relationship is not byte evidence: active/gc-pending objects require an
 * active original artifact whose latest inventory state is verified.
 */
export async function getAttachmentFoundationReadiness(
  db: Database = getDb(),
): Promise<AttachmentFoundationReadiness> {
  const result = await db.execute(sql`
    SELECT
      (
        SELECT count(*)::int
        FROM attachment_objects object
        LEFT JOIN attachment_object_artifacts ownership
          ON ownership.object_id = object.id
         AND ownership.role = 'original'
        LEFT JOIN attachment_storage_artifacts artifact
          ON artifact.id = ownership.artifact_id
        WHERE object.lifecycle_state IN ('active', 'gc_pending')
          AND (
            artifact.id IS NULL
            OR artifact.lifecycle_state <> 'active'
            OR artifact.availability_state <> 'verified'
            OR artifact.availability_observed_at IS NULL
          )
      ) AS "activeObjectsWithoutVerifiedOriginal",
      (
        SELECT count(*)::int
        FROM attachment_objects object
        WHERE object.lifecycle_state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM attachments projection
             WHERE projection.object_id = object.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM attachment_upload_reservations reservation
             WHERE reservation.object_id = object.id
               AND reservation.state = 'pending'
          )
      ) AS "activeDetachedObjects",
      (
        SELECT count(*)::int
        FROM attachments projection
        LEFT JOIN attachment_upload_reservations reservation
          ON reservation.id = projection.id
         AND reservation.object_id = projection.object_id
        WHERE projection.message_id IS NULL
          AND projection.object_id IS NOT NULL
          AND reservation.id IS NULL
      ) AS "objectBackedPendingWithoutReservation",
      (
        SELECT count(*)::int
        FROM attachments projection
        WHERE projection.message_id IS NULL
          AND projection.object_id IS NULL
      ) AS "legacyObjectlessPending",
      (
        SELECT count(*)::int
        FROM attachment_object_gc_jobs job
        WHERE job.state = 'dead_letter'
      ) AS "gcDeadLetters"
  `);
  const [raw] = result.rows as Array<Record<string, number | string>>;
  if (!raw) throw new Error("Attachment foundation readiness query returned no row.");
  const readiness = {
    activeObjectsWithoutVerifiedOriginal: Number(raw.activeObjectsWithoutVerifiedOriginal),
    activeDetachedObjects: Number(raw.activeDetachedObjects),
    objectBackedPendingWithoutReservation: Number(raw.objectBackedPendingWithoutReservation),
    legacyObjectlessPending: Number(raw.legacyObjectlessPending),
    gcDeadLetters: Number(raw.gcDeadLetters),
  };
  return {
    eligible: Object.values(readiness).every((value) => value === 0),
    ...readiness,
  };
}

let lifecycleTimer: unknown | null = null;

export function isAttachmentLifecycleSweepEnabled(): boolean {
  return process.env.ATTACHMENT_LIFECYCLE_SWEEP_ENABLED?.trim().toLowerCase() === "true";
}

export function startAttachmentLifecycleSweep(input: { tracer?: Tracer } = {}): () => void {
  if (!isAttachmentLifecycleSweepEnabled()) return () => undefined;
  if (lifecycleTimer) return () => undefined;
  const run = () => withTraceRoot(
    input.tracer,
    "attachment.lifecycle.sweep",
    { surface: "server", kind: "consumer" },
    () => runAttachmentLifecycleSweep(),
  ).then(() => {
    attachmentLifecycleSweepsTotal.inc({ outcome: "success" });
  }).catch((error) => {
    attachmentLifecycleSweepsTotal.inc({ outcome: "error" });
    console.error("[attachment-lifecycle] sweep failed", error);
  });
  run();
  lifecycleTimer = setClockInterval(run, ATTACHMENT_LIFECYCLE_SWEEP_INTERVAL_MS);
  return () => {
    if (!lifecycleTimer) return;
    clearClockInterval(lifecycleTimer);
    lifecycleTimer = null;
  };
}
