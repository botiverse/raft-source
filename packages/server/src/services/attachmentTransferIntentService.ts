import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db/index.js";
import { getDb } from "../db/index.js";
import {
  type AttachmentUploaderType,
  attachmentObjectArtifacts,
  attachmentStorageArtifacts,
  attachmentTransferArtifacts,
  attachmentTransferIntents,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import { getCdnStorage, getStorage } from "./storageService.js";

export type AttachmentTransferArtifactRole = "original" | "thumbnail" | "svg_raster_preview";
export type AttachmentTransferArtifactBackend = "attachment" | "cdn";

export type AttachmentTransferArtifactPlan = Readonly<{
  role: AttachmentTransferArtifactRole;
  backend: AttachmentTransferArtifactBackend;
  storageKey: string;
}>;

export type CreateAttachmentTransferIntentInput = Readonly<{
  id: string;
  reservationId: string;
  objectId: string;
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: AttachmentUploaderType;
  filename: string;
  mimeType: string;
  declaredSizeBytes: number;
  expiresAt: Date;
  artifacts: readonly AttachmentTransferArtifactPlan[];
}>;

export type AdoptAttachmentTransferIntentInput = Readonly<{
  id: string;
  reservationId: string;
  objectId: string;
  serverId: string;
  channelId: string;
  uploaderId: string;
  uploaderType: AttachmentUploaderType;
  filename: string;
  mimeType: string;
  declaredSizeBytes: number;
  storageKey: string;
  thumbnailKey?: string | null;
}>;

type IntentRow = typeof attachmentTransferIntents.$inferSelect;
type TransferArtifactRow = typeof attachmentTransferArtifacts.$inferSelect;

const TRANSFER_CLEANUP_LEASE_MS = 5 * 60 * 1000;
const TRANSFER_CLEANUP_RETRY_MS = 30 * 1000;
const TRANSFER_CLEANUP_BATCH_SIZE = 100;

function isSvgMimeType(mimeType: string): boolean {
  return mimeType.split(";")[0]?.trim().toLowerCase() === "image/svg+xml";
}

export function buildSvgRasterTransferKey(thumbnailKey: string): string {
  return thumbnailKey.replace(/^thumbs\//, "previews/");
}

export function buildAttachmentTransferArtifactPlan(input: Readonly<{
  storageKey: string;
  thumbnailKey?: string | null;
  mimeType: string;
}>): AttachmentTransferArtifactPlan[] {
  const plan: AttachmentTransferArtifactPlan[] = [
    { role: "original", backend: "attachment", storageKey: input.storageKey },
  ];
  if (input.thumbnailKey) {
    plan.push({ role: "thumbnail", backend: "cdn", storageKey: input.thumbnailKey });
    if (isSvgMimeType(input.mimeType)) {
      plan.push({
        role: "svg_raster_preview",
        backend: "cdn",
        storageKey: buildSvgRasterTransferKey(input.thumbnailKey),
      });
    }
  }
  return plan;
}

async function resolveDatabaseNow(executor: DatabaseExecutor, explicitNow?: Date): Promise<Date> {
  if (explicitNow) return explicitNow;
  const result = await executor.execute(sql`SELECT CURRENT_TIMESTAMP AS now`);
  const [row] = result.rows as Array<{ now: Date | string }>;
  if (!row?.now) throw new Error("Database did not return CURRENT_TIMESTAMP.");
  return row.now instanceof Date ? row.now : new Date(row.now);
}

function assertUniqueArtifactPlan(artifacts: readonly AttachmentTransferArtifactPlan[]): void {
  if (!artifacts.some((artifact) => artifact.role === "original")) {
    throw new Error("Attachment transfer intent requires an original artifact plan.");
  }
  const roles = new Set<AttachmentTransferArtifactRole>();
  const keys = new Set<string>();
  for (const artifact of artifacts) {
    if (roles.has(artifact.role)) {
      throw new Error(`Duplicate attachment transfer artifact role: ${artifact.role}`);
    }
    const key = `${artifact.backend}\0${artifact.storageKey}`;
    if (keys.has(key)) {
      throw new Error("Attachment transfer artifact keys must be unique within an intent.");
    }
    roles.add(artifact.role);
    keys.add(key);
  }
}

function intentMatches(row: IntentRow, input: CreateAttachmentTransferIntentInput): boolean {
  return row.reservationId === input.reservationId
    && row.objectId === input.objectId
    && row.serverId === input.serverId
    && row.channelId === input.channelId
    && row.uploaderId === input.uploaderId
    && row.uploaderType === input.uploaderType
    && row.filename === input.filename
    && row.mimeType === input.mimeType
    && row.declaredSizeBytes === input.declaredSizeBytes;
}

function artifactPlanMatches(
  rows: readonly TransferArtifactRow[],
  expected: readonly AttachmentTransferArtifactPlan[],
): boolean {
  if (rows.length !== expected.length) return false;
  const byRole = new Map(rows.map((row) => [row.role, row]));
  return expected.every((artifact) => {
    const row = byRole.get(artifact.role);
    return row?.backend === artifact.backend && row.storageKey === artifact.storageKey;
  });
}

/** Persist the complete artifact plan before any external byte write. */
export async function createAttachmentTransferIntentWithExecutor(
  executor: DatabaseTransaction,
  input: CreateAttachmentTransferIntentInput,
  explicitNow?: Date,
): Promise<IntentRow> {
  assertUniqueArtifactPlan(input.artifacts);
  const now = await resolveDatabaseNow(executor, explicitNow);
  const [inserted] = await executor.insert(attachmentTransferIntents).values({
    id: input.id,
    reservationId: input.reservationId,
    objectId: input.objectId,
    serverId: input.serverId,
    channelId: input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: input.uploaderType,
    filename: input.filename,
    mimeType: input.mimeType,
    declaredSizeBytes: input.declaredSizeBytes,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();

  if (inserted) {
    await executor.insert(attachmentTransferArtifacts).values(input.artifacts.map((artifact) => ({
      intentId: input.id,
      role: artifact.role,
      backend: artifact.backend,
      storageKey: artifact.storageKey,
      createdAt: now,
      updatedAt: now,
    })));
    return inserted;
  }

  const [existing] = await executor.select().from(attachmentTransferIntents)
    .where(eq(attachmentTransferIntents.id, input.id))
    .for("update")
    .limit(1);
  const artifacts = await executor.select().from(attachmentTransferArtifacts)
    .where(eq(attachmentTransferArtifacts.intentId, input.id))
    .orderBy(asc(attachmentTransferArtifacts.role));
  if (!existing || !intentMatches(existing, input) || !artifactPlanMatches(artifacts, input.artifacts)) {
    throw new Error(`Attachment transfer intent replay conflict for ${input.id}`);
  }
  if (existing.state !== "planned" && existing.state !== "completed") {
    throw new Error(`Attachment transfer intent ${input.id} is terminal.`);
  }
  if (existing.state === "planned" && existing.expiresAt <= now) {
    throw new Error(`Attachment transfer intent ${input.id} is no longer publishable.`);
  }
  return existing;
}

export async function createAttachmentTransferIntent(
  input: CreateAttachmentTransferIntentInput,
  db: Database = getDb(),
  explicitNow?: Date,
): Promise<IntentRow> {
  return db.transaction((tx) => createAttachmentTransferIntentWithExecutor(tx, input, explicitNow));
}

function adoptionMatches(row: IntentRow, input: AdoptAttachmentTransferIntentInput): boolean {
  return row.reservationId === input.reservationId
    && row.objectId === input.objectId
    && row.serverId === input.serverId
    && row.channelId === input.channelId
    && row.uploaderId === input.uploaderId
    && row.uploaderType === input.uploaderType
    && row.filename === input.filename
    && row.mimeType === input.mimeType
    && row.declaredSizeBytes === input.declaredSizeBytes;
}

/**
 * Atomically adopt the exact planned keys into object ownership. Optional
 * preview plans that were never published remain planned cleanup obligations.
 */
export async function adoptAttachmentTransferIntentWithExecutor(
  executor: DatabaseTransaction,
  input: AdoptAttachmentTransferIntentInput,
  explicitNow?: Date,
): Promise<void> {
  const now = await resolveDatabaseNow(executor, explicitNow);
  const [intent] = await executor.select().from(attachmentTransferIntents)
    .where(eq(attachmentTransferIntents.id, input.id))
    .for("update")
    .limit(1);
  if (!intent || !adoptionMatches(intent, input)) {
    throw new Error(`Attachment transfer intent publication conflict for ${input.id}`);
  }
  if (intent.state !== "planned" || intent.expiresAt <= now) {
    throw new Error(`Attachment transfer intent ${input.id} is no longer publishable.`);
  }

  const rows = await executor.select().from(attachmentTransferArtifacts)
    .where(eq(attachmentTransferArtifacts.intentId, input.id))
    .orderBy(asc(attachmentTransferArtifacts.role))
    .for("update");
  const expected = buildAttachmentTransferArtifactPlan(input);
  const byRole = new Map(rows.map((row) => [row.role, row]));

  for (const artifact of expected) {
    const planned = byRole.get(artifact.role);
    if (!planned
      || planned.state !== "planned"
      || planned.backend !== artifact.backend
      || planned.storageKey !== artifact.storageKey) {
      throw new Error(`Attachment transfer artifact publication conflict for ${input.id}/${artifact.role}`);
    }
    const [created] = await executor.insert(attachmentStorageArtifacts).values({
      backend: planned.backend,
      storageKey: planned.storageKey,
      availabilityState: "verified",
      availabilityObservedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: attachmentStorageArtifacts.id });
    if (!created) throw new Error(`Attachment artifact was not created for ${input.id}/${artifact.role}`);
    await executor.insert(attachmentObjectArtifacts).values({
      objectId: input.objectId,
      artifactId: created.id,
      role: planned.role,
      createdAt: now,
    });
    const [adopted] = await executor.update(attachmentTransferArtifacts).set({
      state: "adopted",
      adoptedArtifactId: created.id,
      updatedAt: now,
    }).where(and(
      eq(attachmentTransferArtifacts.intentId, input.id),
      eq(attachmentTransferArtifacts.role, planned.role),
      eq(attachmentTransferArtifacts.state, "planned"),
    )).returning({ intentId: attachmentTransferArtifacts.intentId });
    if (!adopted) throw new Error(`Attachment transfer artifact lost publication fence for ${input.id}/${artifact.role}`);
  }

  const [completed] = await executor.update(attachmentTransferIntents).set({
    state: "completed",
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(attachmentTransferIntents.id, input.id),
    eq(attachmentTransferIntents.state, "planned"),
  )).returning({ id: attachmentTransferIntents.id });
  if (!completed) throw new Error(`Attachment transfer intent lost publication fence for ${input.id}`);
}

export async function terminalizeAttachmentTransferIntentWithExecutor(
  executor: DatabaseTransaction,
  intentId: string,
  state: "canceled" | "expired" | "failed",
  terminalReason: string,
  explicitNow?: Date,
): Promise<IntentRow | null> {
  const now = await resolveDatabaseNow(executor, explicitNow);
  const [intent] = await executor.select().from(attachmentTransferIntents)
    .where(eq(attachmentTransferIntents.id, intentId))
    .for("update")
    .limit(1);
  if (!intent || intent.state === "completed") return intent ?? null;
  if (intent.state !== "planned") return intent;
  const [updated] = await executor.update(attachmentTransferIntents).set({
    state,
    terminalReason,
    updatedAt: now,
  }).where(and(
    eq(attachmentTransferIntents.id, intentId),
    eq(attachmentTransferIntents.state, "planned"),
  )).returning();
  return updated ?? intent;
}

export async function terminalizeAttachmentTransferIntent(
  intentId: string,
  state: "canceled" | "expired" | "failed",
  terminalReason: string,
  db: Database = getDb(),
  explicitNow?: Date,
): Promise<IntentRow | null> {
  return db.transaction((tx) => terminalizeAttachmentTransferIntentWithExecutor(
    tx,
    intentId,
    state,
    terminalReason,
    explicitNow,
  ));
}

type TransferCleanupClaim = Readonly<{
  intentId: string;
  role: AttachmentTransferArtifactRole;
  backend: AttachmentTransferArtifactBackend;
  storageKey: string;
  leaseId: string;
}>;

async function claimNextTransferArtifact(
  db: Database,
  now: Date,
): Promise<TransferCleanupClaim | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({
      intentId: attachmentTransferArtifacts.intentId,
      role: attachmentTransferArtifacts.role,
    }).from(attachmentTransferArtifacts)
      .innerJoin(
        attachmentTransferIntents,
        eq(attachmentTransferIntents.id, attachmentTransferArtifacts.intentId),
      )
      .where(and(
        or(
          eq(attachmentTransferArtifacts.state, "planned"),
          and(
            eq(attachmentTransferArtifacts.state, "deleting"),
            lte(attachmentTransferArtifacts.deleteLeaseExpiresAt, now),
          ),
        ),
        or(
          inArray(attachmentTransferIntents.state, ["completed", "canceled", "expired", "failed"]),
          and(
            eq(attachmentTransferIntents.state, "planned"),
            lte(attachmentTransferIntents.expiresAt, now),
          ),
        ),
      ))
      .orderBy(asc(attachmentTransferIntents.expiresAt), asc(attachmentTransferArtifacts.intentId))
      .limit(1);
    if (!candidate) return null;

    const [intent] = await tx.select().from(attachmentTransferIntents)
      .where(eq(attachmentTransferIntents.id, candidate.intentId))
      .for("update")
      .limit(1);
    if (!intent) return null;
    if (intent.state === "planned") {
      if (intent.expiresAt > now) return null;
      await tx.update(attachmentTransferIntents).set({
        state: "expired",
        terminalReason: "Attachment transfer intent expired.",
        updatedAt: now,
      }).where(and(
        eq(attachmentTransferIntents.id, intent.id),
        eq(attachmentTransferIntents.state, "planned"),
      ));
    }

    const [artifact] = await tx.select().from(attachmentTransferArtifacts)
      .where(and(
        eq(attachmentTransferArtifacts.intentId, candidate.intentId),
        eq(attachmentTransferArtifacts.role, candidate.role),
      ))
      .for("update")
      .limit(1);
    if (!artifact) return null;
    const staleLease = artifact.state === "deleting"
      && artifact.deleteLeaseExpiresAt !== null
      && artifact.deleteLeaseExpiresAt <= now;
    if (artifact.state !== "planned" && !staleLease) return null;

    const leaseId = randomUUID();
    const [claimed] = await tx.update(attachmentTransferArtifacts).set({
      state: "deleting",
      deleteLeaseId: leaseId,
      deleteLeaseExpiresAt: new Date(now.getTime() + TRANSFER_CLEANUP_LEASE_MS),
      deleteAttempts: sql`${attachmentTransferArtifacts.deleteAttempts} + 1`,
      updatedAt: now,
    }).where(and(
      eq(attachmentTransferArtifacts.intentId, artifact.intentId),
      eq(attachmentTransferArtifacts.role, artifact.role),
      eq(attachmentTransferArtifacts.state, artifact.state),
    )).returning();
    if (!claimed) return null;
    return {
      intentId: claimed.intentId,
      role: claimed.role,
      backend: claimed.backend,
      storageKey: claimed.storageKey,
      leaseId,
    };
  });
}

function storageForArtifact(
  claim: TransferCleanupClaim,
  storage: StorageBackend | null,
  cdnStorage: StorageBackend | null,
): StorageBackend | null {
  return claim.backend === "attachment" ? storage : cdnStorage;
}

async function processTransferCleanupClaim(
  db: Database,
  claim: TransferCleanupClaim,
  now: Date,
  storage: StorageBackend | null,
  cdnStorage: StorageBackend | null,
): Promise<boolean> {
  const backend = storageForArtifact(claim, storage, cdnStorage);
  try {
    if (!backend) throw new Error("Attachment transfer artifact storage is unavailable.");
    await backend.delete(claim.storageKey);
    const [deleted] = await db.update(attachmentTransferArtifacts).set({
      state: "deleted",
      deleteLeaseId: null,
      deleteLeaseExpiresAt: null,
      lastErrorClass: null,
      updatedAt: now,
    }).where(and(
      eq(attachmentTransferArtifacts.intentId, claim.intentId),
      eq(attachmentTransferArtifacts.role, claim.role),
      eq(attachmentTransferArtifacts.state, "deleting"),
      eq(attachmentTransferArtifacts.deleteLeaseId, claim.leaseId),
    )).returning({ intentId: attachmentTransferArtifacts.intentId });
    return Boolean(deleted);
  } catch (error) {
    await db.update(attachmentTransferArtifacts).set({
      // Keep a timed durable lease after a known failure. Resetting to
      // `planned` here would let the same sweep hot-loop the same key up to the
      // batch limit instead of handing one retry to a later scanner pass.
      state: "deleting",
      deleteLeaseExpiresAt: new Date(now.getTime() + TRANSFER_CLEANUP_RETRY_MS),
      lastErrorClass: error instanceof Error ? error.name : typeof error,
      updatedAt: now,
    }).where(and(
      eq(attachmentTransferArtifacts.intentId, claim.intentId),
      eq(attachmentTransferArtifacts.role, claim.role),
      eq(attachmentTransferArtifacts.state, "deleting"),
      eq(attachmentTransferArtifacts.deleteLeaseId, claim.leaseId),
    ));
    return false;
  }
}

export async function cleanupAttachmentTransferArtifacts(input: Readonly<{
  db?: Database;
  now?: Date;
  storage?: StorageBackend | null;
  cdnStorage?: StorageBackend | null;
  limit?: number;
}> = {}): Promise<{ deleted: number; failed: number }> {
  const db = input.db ?? getDb();
  const now = await resolveDatabaseNow(db, input.now);
  const storage = input.storage === undefined ? getStorage() : input.storage;
  const cdnStorage = input.cdnStorage === undefined ? getCdnStorage() : input.cdnStorage;
  const limit = input.limit ?? TRANSFER_CLEANUP_BATCH_SIZE;
  let deleted = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const claim = await claimNextTransferArtifact(db, now);
    if (!claim) break;
    if (await processTransferCleanupClaim(db, claim, now, storage, cdnStorage)) deleted += 1;
    else failed += 1;
  }
  return { deleted, failed };
}
