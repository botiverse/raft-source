import { createHash } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseExecutor } from "../db/index.js";
import {
  attachmentArtifactInventoryObservations,
  attachmentArtifactInventoryRuns,
  attachmentObjectInventoryClassifications,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachments,
  attachmentUploadReservations,
  attachmentUploadSessions,
  channels,
  servers,
} from "../db/schema.js";
import {
  attachmentArtifactIdentityKey,
  ensureAttachmentArtifactOwnershipWithExecutor,
  type AttachmentArtifactOwnership,
} from "./attachmentArtifactOwnershipService.js";
import {
  buildAttachmentTransferArtifactPlan,
  type AttachmentTransferArtifactBackend,
  type AttachmentTransferArtifactPlan,
} from "./attachmentTransferIntentService.js";
import type { StorageBackend } from "./storageService.js";

export type AttachmentArtifactInventoryResult = "exists" | "missing" | "unverified";
export type AttachmentObjectInventorySemanticClass =
  | "live"
  | "pending_migratable"
  | "terminal_proven"
  | "shared_artifact_blocked"
  | "legacy_unknown";
export type AttachmentObjectInventoryBytesEvidence =
  | "bytes_verified"
  | "bytes_missing"
  | "bytes_unverified";

type InventoryArtifact = AttachmentTransferArtifactPlan;
type ObjectRow = typeof attachmentObjects.$inferSelect;
type ProjectionRow = typeof attachments.$inferSelect;

type InventoryObservation = Readonly<{
  backend: AttachmentTransferArtifactBackend;
  storageKey: string;
  result: AttachmentArtifactInventoryResult;
  sizeBytes: number | null;
  errorClass: string | null;
  observedAt: Date;
}>;

type InventoryClassification = Readonly<{
  objectId: string;
  semanticClass: AttachmentObjectInventorySemanticClass;
  bytesEvidence: AttachmentObjectInventoryBytesEvidence;
}>;

type InventorySnapshot = Readonly<{
  objects: readonly ObjectRow[];
  projections: readonly ProjectionRow[];
  reservations: readonly { objectId: string; state: string }[];
  uploadSessions: readonly { objectId: string; state: string }[];
  artifacts: readonly InventoryArtifact[];
  objectArtifacts: ReadonlyMap<string, readonly InventoryArtifact[]>;
  legacyObjectlessProjectionCount: number;
  danglingProjectionCount: number;
  metadataMismatchCount: number;
  deletedOriginServerObjectCount: number;
  sourceDigest: string;
}>;

export type AttachmentArtifactInventoryDryRun = Readonly<{
  inventoryDigest: string;
  scopeServerId: string | null;
  observedAt: Date;
  objectCount: number;
  artifactCount: number;
  observations: Readonly<Record<AttachmentArtifactInventoryResult, number>>;
  semantics: Readonly<Record<AttachmentObjectInventorySemanticClass, number>>;
  bytesEvidence: Readonly<Record<AttachmentObjectInventoryBytesEvidence, number>>;
  coverageEligible: boolean;
  fullMigrationEligible: boolean;
  legacyObjectlessProjectionCount: number;
  danglingProjectionCount: number;
  metadataMismatchCount: number;
  deletedOriginServerObjectCount: number;
}>;

export type AttachmentArtifactInventoryReport = AttachmentArtifactInventoryDryRun & Readonly<{
  runId: string;
}>;

export type AttachmentArtifactInventoryInput = Readonly<{
  runId: string;
  evidenceSource: string;
  sourceRevision: string;
  scopeServerId?: string;
  observedAt?: Date;
  concurrency?: number;
  attachmentStorage: Pick<StorageBackend, "head">;
  cdnStorage: Pick<StorageBackend, "head"> | null;
}>;

export type AttachmentArtifactInventoryInspectInput = Omit<AttachmentArtifactInventoryInput, "runId"> &
  Readonly<{ runId?: string }>;

const artifactKey = attachmentArtifactIdentityKey;
const INVENTORY_WRITE_CHUNK_SIZE = 500;

function chunks<T>(values: readonly T[], size = INVENTORY_WRITE_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function metadataMatches(projection: ProjectionRow, object: ObjectRow): boolean {
  return projection.storageKey === object.storageKey
    && projection.thumbnailKey === object.thumbnailKey
    && projection.contentHash === object.contentHash
    && projection.mimeType === object.mimeType
    && projection.sizeBytes === object.sizeBytes
    && projection.width === object.width
    && projection.height === object.height;
}

function normalizeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "non_error_throw";
  const code = "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
  return code ? `${error.name}:${code}` : error.name || "Error";
}

async function collectInventorySnapshot(
  executor: DatabaseExecutor,
  scopeServerId?: string,
): Promise<InventorySnapshot> {
  if (scopeServerId) {
    const [server] = await executor.select({ id: servers.id }).from(servers)
      .where(eq(servers.id, scopeServerId))
      .limit(1);
    if (!server) throw new Error(`Attachment artifact inventory scope server ${scopeServerId} does not exist.`);
  }
  const objectCondition = scopeServerId
    ? eq(attachmentObjects.originServerId, scopeServerId)
    : inArray(attachmentObjects.lifecycleState, ["active", "gc_pending"]);
  const objects = await executor.select().from(attachmentObjects)
    .where(scopeServerId
      ? and(objectCondition, inArray(attachmentObjects.lifecycleState, ["active", "gc_pending"]))
      : objectCondition)
    .orderBy(attachmentObjects.id);
  const [deletedOriginServerCount] = await executor.select({ count: sql<number>`count(*)::int` })
    .from(attachmentObjects)
    .leftJoin(servers, eq(servers.id, attachmentObjects.originServerId))
    .where(and(
      inArray(attachmentObjects.lifecycleState, ["active", "gc_pending"]),
      scopeServerId ? eq(attachmentObjects.originServerId, scopeServerId) : undefined,
      or(isNull(servers.id), isNotNull(servers.deletedAt)),
    ));
  const deletedOriginServerObjectCount = Number(deletedOriginServerCount?.count ?? 0);

  const projectionQuery = executor.select({
    projection: attachments,
    objectOriginServerId: attachmentObjects.originServerId,
    channelServerId: channels.serverId,
  }).from(attachments)
    .leftJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .innerJoin(channels, eq(channels.id, attachments.channelId));
  const projectionRows = scopeServerId
    ? await projectionQuery.where(or(
      eq(attachmentObjects.originServerId, scopeServerId),
      and(isNull(attachments.objectId), eq(channels.serverId, scopeServerId)),
      and(isNotNull(attachments.objectId), isNull(attachmentObjects.id), eq(channels.serverId, scopeServerId)),
    )).orderBy(attachments.id)
    : await projectionQuery.orderBy(attachments.id);
  const projections = projectionRows.map((row) => row.projection);

  const reservationQuery = executor.select({
    objectId: attachmentUploadReservations.objectId,
    state: attachmentUploadReservations.state,
  }).from(attachmentUploadReservations)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachmentUploadReservations.objectId));
  const reservations = scopeServerId
    ? await reservationQuery.where(eq(attachmentObjects.originServerId, scopeServerId))
    : await reservationQuery;

  const sessionQuery = executor.select({
    objectId: attachmentUploadSessions.objectId,
    state: attachmentUploadSessions.state,
  }).from(attachmentUploadSessions)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachmentUploadSessions.objectId));
  const uploadSessionRows = scopeServerId
    ? await sessionQuery.where(eq(attachmentObjects.originServerId, scopeServerId))
    : await sessionQuery;
  const uploadSessions = uploadSessionRows.flatMap((row) =>
    row.objectId === null ? [] : [{ objectId: row.objectId, state: row.state }]);

  const objectArtifacts = new Map<string, readonly InventoryArtifact[]>();
  const artifactsByKey = new Map<string, InventoryArtifact>();
  for (const object of objects) {
    const plans = buildAttachmentTransferArtifactPlan(object);
    objectArtifacts.set(object.id, plans);
    for (const plan of plans) artifactsByKey.set(artifactKey(plan), plan);
  }
  for (const projection of projections) {
    if (projection.objectId !== null) continue;
    for (const plan of buildAttachmentTransferArtifactPlan(projection)) {
      artifactsByKey.set(artifactKey(plan), plan);
    }
  }
  const artifacts = sorted([...artifactsByKey.values()], artifactKey);
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  const danglingProjectionCount = projections.filter(
    (projection) => projection.objectId !== null && !objectsById.has(projection.objectId),
  ).length;
  const metadataMismatchCount = projections.filter((projection) => {
    if (projection.objectId === null) return false;
    const object = objectsById.get(projection.objectId);
    return object ? !metadataMatches(projection, object) : false;
  }).length;

  const canonical = {
    scopeServerId: scopeServerId ?? null,
    objects: objects.map((object) => ({
      id: object.id,
      lifecycleState: object.lifecycleState,
      originServerId: object.originServerId,
      storageKey: object.storageKey,
      thumbnailKey: object.thumbnailKey,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes,
      contentHash: object.contentHash,
      width: object.width,
      height: object.height,
    })),
    projections: projections.map((projection) => ({
      id: projection.id,
      objectId: projection.objectId,
      messageId: projection.messageId,
      revokedAt: projection.revokedAt,
      storageKey: projection.storageKey,
      thumbnailKey: projection.thumbnailKey,
      mimeType: projection.mimeType,
      sizeBytes: projection.sizeBytes,
      contentHash: projection.contentHash,
      width: projection.width,
      height: projection.height,
    })),
    reservations: sorted(reservations, (row) => `${row.objectId}\0${row.state}`),
    uploadSessions: sorted(uploadSessions, (row) => `${row.objectId}\0${row.state}`),
    artifacts,
    deletedOriginServerObjectCount,
  };
  return {
    objects,
    projections,
    reservations,
    uploadSessions,
    artifacts,
    objectArtifacts,
    legacyObjectlessProjectionCount: projections.filter((projection) => projection.objectId === null).length,
    danglingProjectionCount,
    metadataMismatchCount,
    deletedOriginServerObjectCount,
    sourceDigest: sha256Json(canonical),
  };
}

async function probeArtifact(
  artifact: InventoryArtifact,
  input: Pick<AttachmentArtifactInventoryInput, "attachmentStorage" | "cdnStorage">,
  observedAt: Date,
): Promise<InventoryObservation> {
  const storage = artifact.backend === "attachment" ? input.attachmentStorage : input.cdnStorage;
  if (!storage?.head) {
    return { ...artifact, result: "unverified", sizeBytes: null, errorClass: "head_unsupported", observedAt };
  }
  try {
    const metadata = await storage.head(artifact.storageKey);
    return metadata
      ? { ...artifact, result: "exists", sizeBytes: metadata.sizeBytes, errorClass: null, observedAt }
      : { ...artifact, result: "missing", sizeBytes: null, errorClass: null, observedAt };
  } catch (error) {
    return {
      ...artifact,
      result: "unverified",
      sizeBytes: null,
      errorClass: normalizeErrorClass(error),
      observedAt,
    };
  }
}

async function probeArtifacts(
  artifacts: readonly InventoryArtifact[],
  input: AttachmentArtifactInventoryInput,
  observedAt: Date,
): Promise<InventoryObservation[]> {
  const concurrency = input.concurrency ?? 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error("Attachment artifact inventory concurrency must be an integer between 1 and 64.");
  }
  const results = new Array<InventoryObservation>(artifacts.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, artifacts.length) }, async () => {
    while (cursor < artifacts.length) {
      const index = cursor++;
      const artifact = artifacts[index];
      if (artifact) results[index] = await probeArtifact(artifact, input, observedAt);
    }
  }));
  return results;
}

function classifyObjects(
  snapshot: InventorySnapshot,
  observations: readonly InventoryObservation[],
): InventoryClassification[] {
  const observationsByKey = new Map(observations.map((observation) => [artifactKey(observation), observation]));
  const projectionsByObject = new Map<string, ProjectionRow[]>();
  for (const projection of snapshot.projections) {
    if (!projection.objectId) continue;
    const rows = projectionsByObject.get(projection.objectId) ?? [];
    rows.push(projection);
    projectionsByObject.set(projection.objectId, rows);
  }
  const terminalReservationObjects = new Set(snapshot.reservations
    .filter((row) => row.state === "canceled" || row.state === "expired")
    .map((row) => row.objectId));
  const pendingReservationObjects = new Set(snapshot.reservations
    .filter((row) => row.state === "pending")
    .map((row) => row.objectId));
  const terminalSessionObjects = new Set(snapshot.uploadSessions
    .filter((row) => row.state === "canceled" || row.state === "expired" || row.state === "failed")
    .map((row) => row.objectId));

  const ownersByArtifact = new Map<string, Set<string>>();
  for (const object of snapshot.objects) {
    for (const artifact of snapshot.objectArtifacts.get(object.id) ?? []) {
      const owners = ownersByArtifact.get(artifactKey(artifact)) ?? new Set<string>();
      owners.add(object.id);
      ownersByArtifact.set(artifactKey(artifact), owners);
    }
  }

  return snapshot.objects.map((object) => {
    const plans = snapshot.objectArtifacts.get(object.id) ?? [];
    const results = plans.map((plan) => observationsByKey.get(artifactKey(plan))?.result ?? "unverified");
    const bytesEvidence: AttachmentObjectInventoryBytesEvidence = results.includes("unverified")
      ? "bytes_unverified"
      : results.includes("missing")
        ? "bytes_missing"
        : "bytes_verified";
    const objectProjections = projectionsByObject.get(object.id) ?? [];
    const sharesArtifact = plans.some((plan) => (ownersByArtifact.get(artifactKey(plan))?.size ?? 0) > 1);
    const hasLiveProjection = objectProjections.some(
      (projection) => projection.messageId !== null && projection.revokedAt === null,
    );
    const hasPendingProjection = objectProjections.some(
      (projection) => projection.messageId === null && projection.revokedAt === null,
    );
    const allProjectionsRevoked = objectProjections.length > 0
      && objectProjections.every((projection) => projection.revokedAt !== null);
    const terminalProven = object.lifecycleState !== "active"
      || terminalReservationObjects.has(object.id)
      || terminalSessionObjects.has(object.id)
      || allProjectionsRevoked;
    const shareBlocksTerminalAction = sharesArtifact && !hasLiveProjection && terminalProven;
    let semanticClass: AttachmentObjectInventorySemanticClass;
    if (hasLiveProjection) semanticClass = "live";
    else if (shareBlocksTerminalAction) semanticClass = "shared_artifact_blocked";
    else if (terminalProven) semanticClass = "terminal_proven";
    else if (hasPendingProjection || pendingReservationObjects.has(object.id)) semanticClass = "pending_migratable";
    else semanticClass = "legacy_unknown";
    return { objectId: object.id, semanticClass, bytesEvidence };
  });
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length])) as Record<T, number>;
}

function buildDryRun(input: {
  inventoryDigest: string;
  scopeServerId?: string;
  observedAt: Date;
  snapshot: InventorySnapshot;
  observations: readonly InventoryObservation[];
  classifications: readonly InventoryClassification[];
}): AttachmentArtifactInventoryDryRun {
  const observations = countBy(
    input.observations.map((row) => row.result),
    ["exists", "missing", "unverified"] as const,
  );
  const semantics = countBy(
    input.classifications.map((row) => row.semanticClass),
    ["live", "pending_migratable", "terminal_proven", "shared_artifact_blocked", "legacy_unknown"] as const,
  );
  const bytesEvidence = countBy(
    input.classifications.map((row) => row.bytesEvidence),
    ["bytes_verified", "bytes_missing", "bytes_unverified"] as const,
  );
  const coverageEligible = observations.missing === 0
    && observations.unverified === 0
    && bytesEvidence.bytes_missing === 0
    && bytesEvidence.bytes_unverified === 0
    && input.snapshot.danglingProjectionCount === 0
    && input.snapshot.metadataMismatchCount === 0;
  return {
    inventoryDigest: input.inventoryDigest,
    scopeServerId: input.scopeServerId ?? null,
    observedAt: input.observedAt,
    objectCount: input.snapshot.objects.length,
    artifactCount: input.snapshot.artifacts.length,
    observations,
    semantics,
    bytesEvidence,
    coverageEligible,
    fullMigrationEligible: coverageEligible
      && semantics.legacy_unknown === 0
      && input.snapshot.legacyObjectlessProjectionCount === 0
      && input.snapshot.deletedOriginServerObjectCount === 0,
    legacyObjectlessProjectionCount: input.snapshot.legacyObjectlessProjectionCount,
    danglingProjectionCount: input.snapshot.danglingProjectionCount,
    metadataMismatchCount: input.snapshot.metadataMismatchCount,
    deletedOriginServerObjectCount: input.snapshot.deletedOriginServerObjectCount,
  };
}

async function prepareAttachmentArtifactInventory(
  db: Database,
  input: AttachmentArtifactInventoryInput,
): Promise<{
  dryRun: AttachmentArtifactInventoryDryRun;
  snapshot: InventorySnapshot;
  observations: readonly InventoryObservation[];
  classifications: readonly InventoryClassification[];
}> {
  const observedAt = input.observedAt ?? currentDate();
  const snapshot = await collectInventorySnapshot(db, input.scopeServerId);
  const observations = await probeArtifacts(snapshot.artifacts, input, observedAt);
  const classifications = classifyObjects(snapshot, observations);
  const inventoryDigest = sha256Json({
    evidenceSource: input.evidenceSource,
    sourceRevision: input.sourceRevision,
    sourceDigest: snapshot.sourceDigest,
    observations: observations.map((row) => ({
      backend: row.backend,
      storageKey: row.storageKey,
      result: row.result,
      sizeBytes: row.sizeBytes,
      errorClass: row.errorClass,
      observedAt: row.observedAt.toISOString(),
    })),
    classifications,
  });
  return {
    dryRun: buildDryRun({
      inventoryDigest,
      scopeServerId: input.scopeServerId,
      observedAt,
      snapshot,
      observations,
      classifications,
    }),
    snapshot,
    observations,
    classifications,
  };
}

/** Read-only candidate collection plus HEAD evidence. Persists nothing. */
export async function inspectAttachmentArtifactInventory(
  db: Database,
  input: AttachmentArtifactInventoryInspectInput,
): Promise<AttachmentArtifactInventoryDryRun> {
  return (await prepareAttachmentArtifactInventory(db, { ...input, runId: input.runId ?? "dry-run" })).dryRun;
}

/**
 * Inventory historical storage ownership and external byte evidence. This
 * function has no storage-delete capability and never changes object,
 * reservation, charge, projection, or artifact lifecycle state.
 */
export async function inventoryAttachmentArtifacts(
  db: Database,
  input: AttachmentArtifactInventoryInput,
): Promise<AttachmentArtifactInventoryReport> {
  if (!input.runId || !input.evidenceSource.trim() || !input.sourceRevision.trim()) {
    throw new Error("Attachment artifact inventory requires runId, evidenceSource, and sourceRevision.");
  }
  const [existingRun] = await db.select({ id: attachmentArtifactInventoryRuns.id })
    .from(attachmentArtifactInventoryRuns)
    .where(eq(attachmentArtifactInventoryRuns.id, input.runId))
    .limit(1);
  if (existingRun) throw new Error(`Attachment artifact inventory run ${input.runId} already exists.`);
  const { dryRun, snapshot, observations, classifications } =
    await prepareAttachmentArtifactInventory(db, input);
  const observedAt = dryRun.observedAt;
  const inventoryDigest = dryRun.inventoryDigest;

  await db.transaction(async (tx) => {
    const fresh = await collectInventorySnapshot(tx, input.scopeServerId);
    if (fresh.sourceDigest !== snapshot.sourceDigest) {
      throw new Error("Attachment artifact inventory candidate set changed during external observation; no inventory receipt was written.");
    }
    const [run] = await tx.insert(attachmentArtifactInventoryRuns).values({
      id: input.runId,
      evidenceSource: input.evidenceSource,
      sourceRevision: input.sourceRevision,
      inventoryDigest,
      scopeServerId: input.scopeServerId,
      objectCount: snapshot.objects.length,
      artifactCount: snapshot.artifacts.length,
      observationCount: observations.length,
      classificationCount: classifications.length,
      legacyObjectlessProjectionCount: snapshot.legacyObjectlessProjectionCount,
      danglingProjectionCount: snapshot.danglingProjectionCount,
      metadataMismatchCount: snapshot.metadataMismatchCount,
      deletedOriginServerObjectCount: snapshot.deletedOriginServerObjectCount,
      observedAt,
      createdAt: observedAt,
    }).onConflictDoNothing().returning({ id: attachmentArtifactInventoryRuns.id });
    if (!run) throw new Error(`Attachment artifact inventory run ${input.runId} already exists.`);

    const ownerships: AttachmentArtifactOwnership[] = snapshot.objects.flatMap((object) =>
      (snapshot.objectArtifacts.get(object.id) ?? []).map((artifact) => ({
        objectId: object.id,
        role: artifact.role,
        backend: artifact.backend,
        storageKey: artifact.storageKey,
      })));
    const artifactIds = await ensureAttachmentArtifactOwnershipWithExecutor(
      tx,
      snapshot.artifacts,
      ownerships,
      observedAt,
    );

    const persistedObservations = observations.map((observation) => {
      const artifactId = artifactIds.get(artifactKey(observation));
      if (!artifactId) throw new Error(`Artifact identity missing for observation ${artifactKey(observation)}`);
      return {
        runId: input.runId,
        artifactId,
        result: observation.result,
        sizeBytes: observation.sizeBytes,
        errorClass: observation.errorClass,
        observedAt: observation.observedAt,
        createdAt: observedAt,
      };
    });
    for (const batch of chunks(persistedObservations)) {
      if (batch.length > 0) await tx.insert(attachmentArtifactInventoryObservations).values(batch);
    }
    for (const result of ["exists", "missing", "unverified"] as const) {
      const availabilityState = result === "exists" ? "verified" : result;
      const artifactIdsForResult = persistedObservations
        .filter((observation) => observation.result === result)
        .map((observation) => observation.artifactId);
      for (const ids of chunks(artifactIdsForResult)) {
        if (ids.length === 0) continue;
        await tx.update(attachmentStorageArtifacts).set({
          availabilityState,
          availabilityObservedAt: observedAt,
          updatedAt: observedAt,
        }).where(and(
          inArray(attachmentStorageArtifacts.id, ids),
          or(
            isNull(attachmentStorageArtifacts.availabilityObservedAt),
            lte(attachmentStorageArtifacts.availabilityObservedAt, observedAt),
          ),
        ));
      }
    }

    for (const batch of chunks(classifications)) {
      if (batch.length === 0) continue;
      await tx.insert(attachmentObjectInventoryClassifications).values(batch.map((classification) => ({
        runId: input.runId,
        objectId: classification.objectId,
        semanticClass: classification.semanticClass,
        bytesEvidence: classification.bytesEvidence,
        observedAt,
        createdAt: observedAt,
      })));
    }
  });

  return { runId: input.runId, ...dryRun };
}
