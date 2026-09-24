import { randomUUID } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

import type { DatabaseExecutor, DatabaseTransaction } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  externalActorProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalInboundEvents,
  externalOutboundDeliveries,
} from "../db/schema.js";

export const EXTERNAL_ATTACHMENT_TRANSFER_LEASE_MS = 60_000;

type Asset = typeof externalAttachmentAssets.$inferSelect;
type MessageFact = typeof externalAttachmentMessageFacts.$inferSelect;
type TransferJob = typeof externalAttachmentTransferJobs.$inferSelect;
type TransferPhase = TransferJob["phase"];

export type ExternalAttachmentTransferClaim = Readonly<{
  job: TransferJob;
  leaseId: string;
  leaseOwner: string;
  leaseGeneration: number;
}>;

export class ExternalAttachmentTransferError extends Error {
  readonly code:
    | "authority_mismatch"
    | "replay_conflict"
    | "source_unavailable"
    | "lease_lost"
    | "invalid_transition";

  constructor(
    code: ExternalAttachmentTransferError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ExternalAttachmentTransferError";
    this.code = code;
  }
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new Error(`External attachment ${label} is invalid`);
  }
  return normalized;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`External attachment ${label} must be a positive integer`);
  }
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`External attachment ${label} must be a non-negative integer`);
  }
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`External attachment ${label} is invalid`);
  return value;
}

function sameAssetIdentity(
  asset: Asset,
  input: {
    originDirection: Asset["originDirection"];
    provider: string;
    appRegistrationId: string;
    installId: string;
    workspaceId: string;
    providerAuthorityId: string;
    providerFileId: string;
  },
): boolean {
  return asset.originDirection === input.originDirection
    && asset.provider === input.provider
    && asset.appRegistrationId === input.appRegistrationId
    && asset.installId === input.installId
    && asset.workspaceId === input.workspaceId
    && asset.providerAuthorityId === input.providerAuthorityId
    && asset.providerFileId === input.providerFileId;
}

function sameInboundFact(
  fact: MessageFact,
  input: {
    inboundEventId: string;
    assetId: string;
    sourceActorProjectionId: string | null;
    providerAuthorityId: string;
    connectionEpoch: number;
    bindingId: string;
    bindingEpoch: number;
    orderedPosition: number;
  },
): boolean {
  return fact.direction === "provider_inbound"
    && fact.inboundEventId === input.inboundEventId
    && fact.assetId === input.assetId
    && fact.sourceActorProjectionId === input.sourceActorProjectionId
    && fact.providerAuthorityId === input.providerAuthorityId
    && fact.connectionEpoch === input.connectionEpoch
    && fact.bindingId === input.bindingId
    && fact.bindingEpoch === input.bindingEpoch
    && fact.orderedPosition === input.orderedPosition;
}

async function requireInboundAuthority(
  executor: DatabaseExecutor,
  input: {
    inboundEventId: string;
    sourceActorProjectionId?: string | null;
    provider: string;
    appRegistrationId: string;
    installId: string;
    workspaceId: string;
    providerAuthorityId: string;
    connectionEpoch: number;
    bindingId: string;
    bindingEpoch: number;
  },
): Promise<void> {
  const [event] = await executor.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, input.inboundEventId)).limit(1);
  if (
    !event
    || (event.status !== "queued" && event.status !== "processing")
    || event.provider !== input.provider
    || event.appRegistrationId !== input.appRegistrationId
    || event.installId !== input.installId
    || event.workspaceId !== input.workspaceId
    || event.providerAuthorityId !== input.providerAuthorityId
    || event.connectionEpoch !== input.connectionEpoch
    || event.bindingId !== input.bindingId
    || event.bindingEpoch !== input.bindingEpoch
  ) {
    throw new ExternalAttachmentTransferError(
      "authority_mismatch",
      "External attachment ingress authority is missing or stale",
    );
  }
  if (!input.sourceActorProjectionId) return;
  const [projection] = await executor.select().from(externalActorProjections)
    .where(eq(externalActorProjections.id, input.sourceActorProjectionId)).limit(1);
  if (
    !projection
    || projection.state !== "active"
    || projection.deactivated
    || projection.provider !== input.provider
    || projection.appRegistrationId !== input.appRegistrationId
    || projection.installId !== input.installId
    || projection.workspaceId !== input.workspaceId
  ) {
    throw new ExternalAttachmentTransferError(
      "authority_mismatch",
      "External attachment actor projection is missing or stale",
    );
  }
}

export type CreateInboundExternalAttachmentTransferInput = Readonly<{
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  providerAuthorityId: string;
  providerFileId: string;
  inboundEventId: string;
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
  orderedPosition: number;
  sourceActorProjectionId: string;
}>;

/**
 * Records the provider file, its exact message occurrence, and the first
 * metadata job before any provider I/O. Replays converge on the existing
 * three rows; a reused provider/message identity with different frozen
 * coordinates is rejected instead of silently changing authority.
 */
export async function createInboundExternalAttachmentTransferWithExecutor(
  executor: DatabaseTransaction,
  rawInput: CreateInboundExternalAttachmentTransferInput,
  explicitNow?: Date,
): Promise<{ asset: Asset; messageFact: MessageFact; job: TransferJob; replay: boolean }> {
  const now = validDate(explicitNow ?? currentDate(), "clock");
  const input = {
    provider: bounded(rawInput.provider, "provider", 80),
    appRegistrationId: bounded(rawInput.appRegistrationId, "app registration ID", 320),
    installId: bounded(rawInput.installId, "install ID", 160),
    workspaceId: bounded(rawInput.workspaceId, "workspace ID", 320),
    providerAuthorityId: bounded(rawInput.providerAuthorityId, "provider authority ID", 160),
    providerFileId: bounded(rawInput.providerFileId, "provider file ID", 320),
    inboundEventId: bounded(rawInput.inboundEventId, "inbound event ID", 160),
    connectionEpoch: positive(rawInput.connectionEpoch, "connection epoch"),
    bindingId: bounded(rawInput.bindingId, "binding ID", 160),
    bindingEpoch: positive(rawInput.bindingEpoch, "binding epoch"),
    orderedPosition: nonNegative(rawInput.orderedPosition, "ordered position"),
    sourceActorProjectionId: bounded(rawInput.sourceActorProjectionId, "source actor projection ID", 160),
  };
  await requireInboundAuthority(executor, input);

  const insertedAssets = await executor.insert(externalAttachmentAssets).values({
    originDirection: "provider_inbound",
    provider: input.provider,
    appRegistrationId: input.appRegistrationId,
    installId: input.installId,
    workspaceId: input.workspaceId,
    providerAuthorityId: input.providerAuthorityId,
    providerFileId: input.providerFileId,
    state: "observed",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  const [asset] = insertedAssets.length > 0
    ? insertedAssets
    : await executor.select().from(externalAttachmentAssets).where(and(
      eq(externalAttachmentAssets.provider, input.provider),
      eq(externalAttachmentAssets.appRegistrationId, input.appRegistrationId),
      eq(externalAttachmentAssets.installId, input.installId),
      eq(externalAttachmentAssets.workspaceId, input.workspaceId),
      eq(externalAttachmentAssets.providerFileId, input.providerFileId),
    )).limit(1);
  if (!asset || !sameAssetIdentity(asset, { ...input, originDirection: "provider_inbound" })) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "External attachment provider file identity conflicts with its frozen asset",
    );
  }
  const insertedFacts = await executor.insert(externalAttachmentMessageFacts).values({
    direction: "provider_inbound",
    inboundEventId: input.inboundEventId,
    assetId: asset.id,
    sourceActorProjectionId: input.sourceActorProjectionId,
    providerAuthorityId: input.providerAuthorityId,
    connectionEpoch: input.connectionEpoch,
    bindingId: input.bindingId,
    bindingEpoch: input.bindingEpoch,
    orderedPosition: input.orderedPosition,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  const [messageFact] = insertedFacts.length > 0
    ? insertedFacts
    : await executor.select().from(externalAttachmentMessageFacts).where(and(
      eq(externalAttachmentMessageFacts.inboundEventId, input.inboundEventId),
      eq(externalAttachmentMessageFacts.assetId, asset.id),
    )).limit(1);
  if (!messageFact || !sameInboundFact(messageFact, { ...input, assetId: asset.id })) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "External attachment message occurrence conflicts with its frozen fact",
    );
  }

  const insertedJobs = await executor.insert(externalAttachmentTransferJobs).values({
    direction: "provider_inbound",
    assetId: asset.id,
    messageFactId: messageFact.id,
    phase: "metadata",
    state: "queued",
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  const [job] = insertedJobs.length > 0
    ? insertedJobs
    : await executor.select().from(externalAttachmentTransferJobs)
      .where(eq(externalAttachmentTransferJobs.messageFactId, messageFact.id)).limit(1);
  if (
    !job
    || job.direction !== "provider_inbound"
    || job.assetId !== asset.id
    || job.messageFactId !== messageFact.id
  ) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "External attachment transfer job conflicts with its frozen message fact",
    );
  }
  return {
    asset,
    messageFact,
    job,
    replay: insertedAssets.length === 0 && insertedFacts.length === 0 && insertedJobs.length === 0,
  };
}

export type CreateOutboundExternalAttachmentTransferInput = Readonly<{
  outboundDeliveryId: string;
  sourceAttachmentId: string;
}>;

/** Freezes one immutable Raft object before the first provider upload call. */
export async function createOutboundExternalAttachmentTransferWithExecutor(
  executor: DatabaseExecutor,
  rawInput: CreateOutboundExternalAttachmentTransferInput,
  explicitNow?: Date,
): Promise<{ job: TransferJob; replay: boolean }> {
  const now = validDate(explicitNow ?? currentDate(), "clock");
  const input = {
    outboundDeliveryId: bounded(rawInput.outboundDeliveryId, "outbound delivery ID", 160),
    sourceAttachmentId: bounded(rawInput.sourceAttachmentId, "source attachment ID", 160),
  };
  const [delivery] = await executor.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, input.outboundDeliveryId)).limit(1);
  const [source] = await executor.select({
    projection: attachments,
    object: attachmentObjects,
  }).from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(eq(attachments.id, input.sourceAttachmentId)).limit(1);
  if (
    !delivery
    || !source
    || source.projection.messageId !== delivery.sourceMessageId
    || source.projection.revokedAt
    || source.object.lifecycleState !== "active"
  ) {
    throw new ExternalAttachmentTransferError(
      "source_unavailable",
      "Outbound attachment source is missing, revoked, or belongs to another message",
    );
  }
  if (!source.object.contentHash || !/^[0-9a-f]{64}$/.test(source.object.contentHash)) {
    throw new ExternalAttachmentTransferError(
      "source_unavailable",
      "Outbound attachment source has no immutable SHA-256 digest",
    );
  }

  const inserted = await executor.insert(externalAttachmentTransferJobs).values({
    direction: "raft_outbound",
    outboundDeliveryId: delivery.id,
    sourceAttachmentId: source.projection.id,
    frozenObjectId: source.object.id,
    frozenOriginServerId: source.object.originServerId,
    frozenStorageKey: source.object.storageKey,
    frozenFilename: source.projection.filename,
    frozenMimeType: source.object.mimeType,
    frozenSizeBytes: source.object.sizeBytes,
    frozenContentDigest: source.object.contentHash,
    phase: "ticket",
    state: "queued",
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  const [job] = inserted.length > 0
    ? inserted
    : await executor.select().from(externalAttachmentTransferJobs).where(and(
      eq(externalAttachmentTransferJobs.outboundDeliveryId, delivery.id),
      eq(externalAttachmentTransferJobs.sourceAttachmentId, source.projection.id),
    )).limit(1);
  if (
    !job
    || job.direction !== "raft_outbound"
    || job.frozenObjectId !== source.object.id
    || job.frozenOriginServerId !== source.object.originServerId
    || job.frozenStorageKey !== source.object.storageKey
    || job.frozenFilename !== source.projection.filename
    || job.frozenMimeType !== source.object.mimeType
    || job.frozenSizeBytes !== source.object.sizeBytes
    || job.frozenContentDigest !== source.object.contentHash
  ) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "Outbound attachment replay conflicts with its frozen source snapshot",
    );
  }
  return { job, replay: inserted.length === 0 };
}

export async function claimExternalAttachmentTransferJob(
  executor: DatabaseTransaction,
  rawInput: {
    leaseOwner: string;
    direction?: TransferJob["direction"];
    jobId?: string;
    outboundDeliveryId?: string;
    now?: Date;
    leaseMs?: number;
  },
): Promise<ExternalAttachmentTransferClaim | null> {
  const leaseOwner = bounded(rawInput.leaseOwner, "lease owner", 160);
  const now = validDate(rawInput.now ?? currentDate(), "claim clock");
  const leaseMs = positive(rawInput.leaseMs ?? EXTERNAL_ATTACHMENT_TRANSFER_LEASE_MS, "lease duration");
  const eligible = or(
    and(
      or(
        eq(externalAttachmentTransferJobs.state, "queued"),
        eq(externalAttachmentTransferJobs.state, "retry_wait"),
        eq(externalAttachmentTransferJobs.state, "outcome_unknown"),
      ),
      lte(externalAttachmentTransferJobs.nextAttemptAt, now),
    ),
    and(
      eq(externalAttachmentTransferJobs.state, "leased"),
      lte(externalAttachmentTransferJobs.leaseExpiresAt, now),
    ),
  );
  const filters = [
    eligible,
    ...(rawInput.direction ? [eq(externalAttachmentTransferJobs.direction, rawInput.direction)] : []),
    ...(rawInput.jobId ? [eq(externalAttachmentTransferJobs.id, rawInput.jobId)] : []),
    ...(rawInput.outboundDeliveryId
      ? [eq(externalAttachmentTransferJobs.outboundDeliveryId, rawInput.outboundDeliveryId)]
      : []),
  ];
  const [candidate] = await executor.select().from(externalAttachmentTransferJobs).where(
    and(...filters),
  ).orderBy(
    sql`CASE WHEN ${externalAttachmentTransferJobs.phase} = 'metadata' THEN 0 ELSE 1 END`,
    asc(externalAttachmentTransferJobs.nextAttemptAt),
    asc(externalAttachmentTransferJobs.createdAt),
    asc(externalAttachmentTransferJobs.id),
  ).for("update", { skipLocked: true }).limit(1);
  if (!candidate) return null;

  const leaseId = randomUUID();
  const leaseGeneration = candidate.leaseGeneration + 1;
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    state: "leased",
    attempts: candidate.attempts + 1,
    leaseId,
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
    leaseGeneration,
    lastErrorClass: null,
    startedAt: candidate.startedAt ?? now,
    terminalAt: null,
    updatedAt: now,
  }).where(and(
    eq(externalAttachmentTransferJobs.id, candidate.id),
    eq(externalAttachmentTransferJobs.leaseGeneration, candidate.leaseGeneration),
  )).returning();
  if (!job) return null;
  return { job, leaseId, leaseOwner, leaseGeneration };
}

export async function releaseExternalAttachmentTransferClaimQueued(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { nextPhase?: TransferPhase; nextAttemptAt?: Date; now?: Date },
): Promise<TransferJob> {
  const now = validDate(rawInput.now ?? currentDate(), "release clock");
  const nextAttemptAt = validDate(rawInput.nextAttemptAt ?? now, "next attempt");
  if (nextAttemptAt < now) throw new Error("External attachment next attempt is in the past");
  const nextPhase = rawInput.nextPhase ?? claim.job.phase;
  if (!phaseAllowed(claim.job.direction, nextPhase)) {
    throw new ExternalAttachmentTransferError("invalid_transition", "Attachment release phase is invalid");
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    phase: nextPhase,
    state: "queued",
    nextAttemptAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: null,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  return job;
}

/**
 * Atomically fences provider-byte materialization to the job that first froze
 * metadata for the shared asset. Retries by that job may resume store; every
 * other occurrence waits for the immutable object and then reuses it.
 */
export async function beginInboundExternalAttachmentMaterialization(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { now?: Date },
): Promise<{ asset: Asset; claim: ExternalAttachmentTransferClaim }> {
  if (
    claim.job.direction !== "provider_inbound"
    || (claim.job.phase !== "download" && claim.job.phase !== "store")
    || !claim.job.assetId
    || !claim.job.messageFactId
  ) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only an inbound download/store lease can materialize provider bytes",
    );
  }
  const now = validDate(rawInput.now ?? currentDate(), "materialization clock");
  const [asset] = await executor.select().from(externalAttachmentAssets)
    .where(eq(externalAttachmentAssets.id, claim.job.assetId)).for("update").limit(1);
  if (
    !asset
    || asset.originDirection !== "provider_inbound"
    || asset.materializationOwnerJobId !== claim.job.id
    || (claim.job.phase === "download" && asset.state !== "metadata_ready")
    || (claim.job.phase === "store" && asset.state !== "transferring")
  ) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Inbound attachment materialization is not owned by this job",
    );
  }
  if (claim.job.phase === "store") return { asset, claim };
  const [transferringAsset] = await executor.update(externalAttachmentAssets).set({
    state: "transferring",
    updatedAt: now,
  }).where(and(
    eq(externalAttachmentAssets.id, asset.id),
    eq(externalAttachmentAssets.state, "metadata_ready"),
    eq(externalAttachmentAssets.materializationOwnerJobId, claim.job.id),
  )).returning();
  if (!transferringAsset) {
    throw new ExternalAttachmentTransferError(
      "lease_lost",
      "Inbound attachment materialization fence was lost",
    );
  }
  const advancedClaim = await advanceExternalAttachmentTransferClaim(executor, claim, {
    nextPhase: "store",
    now,
  });
  return { asset: transferringAsset, claim: advancedClaim };
}

export async function recordInboundExternalAttachmentStored(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { attachmentProjectionId: string; now?: Date },
): Promise<{ asset: Asset; messageFact: MessageFact; job: TransferJob }> {
  if (
    claim.job.direction !== "provider_inbound"
    || (claim.job.phase !== "metadata" && claim.job.phase !== "download" && claim.job.phase !== "store")
    || !claim.job.assetId
    || !claim.job.messageFactId
  ) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only an inbound metadata/download/store lease can publish a canonical attachment projection",
    );
  }
  const now = validDate(rawInput.now ?? currentDate(), "store clock");
  const attachmentProjectionId = bounded(
    rawInput.attachmentProjectionId,
    "attachment projection ID",
    160,
  );
  const [asset] = await executor.select().from(externalAttachmentAssets)
    .where(eq(externalAttachmentAssets.id, claim.job.assetId)).for("update").limit(1);
  const [messageFact] = await executor.select().from(externalAttachmentMessageFacts)
    .where(eq(externalAttachmentMessageFacts.id, claim.job.messageFactId)).for("update").limit(1);
  const [projection] = await executor.select({
    projection: attachments,
    object: attachmentObjects,
  }).from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(eq(attachments.id, attachmentProjectionId)).limit(1);
  const ownsMaterialization = asset?.state === "transferring"
    && claim.job.phase === "store"
    && asset.materializationOwnerJobId === claim.job.id;
  const reusesMaterialization = asset?.state === "stored" || asset?.state === "linked";
  if (
    !asset
    || asset.originDirection !== "provider_inbound"
    || (!ownsMaterialization && !reusesMaterialization)
    || !asset.filename
    || !asset.mimeType
    || !asset.declaredSizeBytes
    || !messageFact
    || messageFact.state !== "pending"
    || !messageFact.sourceActorProjectionId
    || !projection
    || projection.projection.messageId !== null
    || projection.projection.uploaderType !== "external_projection"
    || projection.projection.uploaderId !== messageFact.sourceActorProjectionId
    || projection.projection.filename !== asset.filename
    || projection.object.mimeType !== asset.mimeType
    || projection.object.sizeBytes !== asset.declaredSizeBytes
    || projection.object.lifecycleState !== "active"
    || !projection.object.contentHash
    || !/^[0-9a-f]{64}$/.test(projection.object.contentHash)
  ) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "Stored inbound attachment conflicts with its frozen provider asset",
    );
  }
  if (asset.state === "stored" || asset.state === "linked") {
    if (
      asset.raftObjectId !== projection.object.id
      || asset.sourceContentDigest !== projection.object.contentHash
    ) {
      throw new ExternalAttachmentTransferError(
        "replay_conflict",
        "Re-shared inbound attachment projection conflicts with its immutable object",
      );
    }
  }
  const [updatedAsset] = ownsMaterialization
    ? await executor.update(externalAttachmentAssets).set({
      raftObjectId: projection.object.id,
      sourceContentDigest: projection.object.contentHash,
      state: "stored",
      updatedAt: now,
    }).where(and(
      eq(externalAttachmentAssets.id, asset.id),
      eq(externalAttachmentAssets.state, "transferring"),
      eq(externalAttachmentAssets.materializationOwnerJobId, claim.job.id),
    )).returning()
    : [asset];
  const [updatedFact] = await executor.update(externalAttachmentMessageFacts).set({
    attachmentProjectionId: projection.projection.id,
    state: "stored",
    updatedAt: now,
  }).where(and(
    eq(externalAttachmentMessageFacts.id, messageFact.id),
    eq(externalAttachmentMessageFacts.state, "pending"),
  )).returning();
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    phase: "link",
    state: "completed",
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: null,
    terminalAt: now,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!updatedAsset || !updatedFact || !job) {
    throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer store lease was lost");
  }
  return { asset: updatedAsset, messageFact: updatedFact, job };
}

export async function terminalizeInboundExternalAttachmentUnavailable(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: {
    errorClass: string;
    failureScope: "asset_global" | "occurrence_local";
    state?: "failed" | "revoked" | "quarantined";
    now?: Date;
  },
): Promise<{ asset: Asset; messageFact: MessageFact; job: TransferJob }> {
  if (
    claim.job.direction !== "provider_inbound"
    || !claim.job.assetId
    || !claim.job.messageFactId
  ) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only an inbound attachment lease can record an unavailable file",
    );
  }
  const now = validDate(rawInput.now ?? currentDate(), "unavailable clock");
  const errorClass = bounded(rawInput.errorClass, "terminal error class", 160);
  const terminalState = rawInput.state ?? "failed";
  const assetState = terminalState === "revoked" ? "revoked" : "failed";
  const factState = terminalState === "revoked" ? "revoked" : "unavailable";
  const [lockedAsset] = await executor.select().from(externalAttachmentAssets)
    .where(eq(externalAttachmentAssets.id, claim.job.assetId)).for("update").limit(1);
  const ownerOccurrenceFailure = rawInput.failureScope === "occurrence_local"
    && lockedAsset?.materializationOwnerJobId === claim.job.id
    && (lockedAsset.state === "metadata_ready" || lockedAsset.state === "transferring");
  const [successor] = ownerOccurrenceFailure
    ? await executor.select({ job: externalAttachmentTransferJobs })
      .from(externalAttachmentTransferJobs)
      .innerJoin(
        externalAttachmentMessageFacts,
        eq(externalAttachmentMessageFacts.id, externalAttachmentTransferJobs.messageFactId),
      )
      .where(and(
        eq(externalAttachmentTransferJobs.direction, "provider_inbound"),
        eq(externalAttachmentTransferJobs.assetId, claim.job.assetId),
        ne(externalAttachmentTransferJobs.id, claim.job.id),
        inArray(externalAttachmentTransferJobs.state, ["queued", "leased", "retry_wait"]),
        eq(externalAttachmentMessageFacts.state, "pending"),
      ))
      .orderBy(
        sql`CASE
          WHEN ${externalAttachmentTransferJobs.state} = 'leased'
            AND ${externalAttachmentTransferJobs.leaseExpiresAt} > ${now} THEN 0
          WHEN ${externalAttachmentTransferJobs.state} = 'leased'
            OR ${externalAttachmentTransferJobs.nextAttemptAt} <= ${now} THEN 1
          ELSE 2
        END`,
        sql`CASE
          WHEN ${externalAttachmentTransferJobs.state} = 'leased'
            THEN ${externalAttachmentTransferJobs.leaseExpiresAt}
          ELSE ${externalAttachmentTransferJobs.nextAttemptAt}
        END`,
        asc(externalAttachmentTransferJobs.createdAt),
        asc(externalAttachmentTransferJobs.id),
      )
      .for("update")
      .limit(1)
    : [];
  const preserveSharedAsset = rawInput.failureScope === "occurrence_local"
    || lockedAsset?.state === "stored"
    || lockedAsset?.state === "linked";
  const [asset] = ownerOccurrenceFailure
    ? await executor.update(externalAttachmentAssets).set({
      state: "metadata_ready",
      materializationOwnerJobId: successor?.job.id ?? null,
      terminalFailureClass: null,
      updatedAt: now,
    }).where(and(
      eq(externalAttachmentAssets.id, claim.job.assetId),
      eq(externalAttachmentAssets.materializationOwnerJobId, claim.job.id),
      inArray(externalAttachmentAssets.state, ["metadata_ready", "transferring"]),
    )).returning()
    : preserveSharedAsset
      ? [lockedAsset]
      : await executor.update(externalAttachmentAssets).set({
      state: assetState,
      terminalFailureClass: errorClass,
      updatedAt: now,
    }).where(eq(externalAttachmentAssets.id, claim.job.assetId)).returning();
  const [messageFact] = await executor.update(externalAttachmentMessageFacts).set({
    state: factState,
    terminalFailureClass: errorClass,
    updatedAt: now,
  }).where(eq(externalAttachmentMessageFacts.id, claim.job.messageFactId)).returning();
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    state: terminalState,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: errorClass,
    terminalAt: now,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!asset || !messageFact || !job) {
    throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer terminal lease was lost");
  }
  return { asset, messageFact, job };
}

function claimPredicate(claim: ExternalAttachmentTransferClaim) {
  return and(
    eq(externalAttachmentTransferJobs.id, claim.job.id),
    eq(externalAttachmentTransferJobs.state, "leased"),
    eq(externalAttachmentTransferJobs.leaseId, claim.leaseId),
    eq(externalAttachmentTransferJobs.leaseOwner, claim.leaseOwner),
    eq(externalAttachmentTransferJobs.leaseGeneration, claim.leaseGeneration),
  );
}

const INBOUND_PHASES = ["metadata", "download", "store", "link"] as const;
const OUTBOUND_PHASES = ["ticket", "upload", "complete", "correlate", "link"] as const;

function phaseAllowed(direction: TransferJob["direction"], phase: TransferPhase): boolean {
  return direction === "provider_inbound"
    ? INBOUND_PHASES.includes(phase as typeof INBOUND_PHASES[number])
    : OUTBOUND_PHASES.includes(phase as typeof OUTBOUND_PHASES[number]);
}

function phaseCanAdvance(
  direction: TransferJob["direction"],
  current: TransferPhase,
  next: TransferPhase,
): boolean {
  const phases: readonly TransferPhase[] = direction === "provider_inbound"
    ? INBOUND_PHASES
    : OUTBOUND_PHASES;
  const currentIndex = phases.indexOf(current);
  const nextIndex = phases.indexOf(next);
  return currentIndex >= 0 && (nextIndex === currentIndex || nextIndex === currentIndex + 1);
}

export async function advanceExternalAttachmentTransferClaim(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { nextPhase: TransferPhase; now?: Date },
): Promise<ExternalAttachmentTransferClaim> {
  const now = validDate(rawInput.now ?? currentDate(), "advance clock");
  if (
    !phaseAllowed(claim.job.direction, rawInput.nextPhase)
    || !phaseCanAdvance(claim.job.direction, claim.job.phase, rawInput.nextPhase)
  ) {
    throw new ExternalAttachmentTransferError("invalid_transition", "Attachment transfer phase is invalid");
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    phase: rawInput.nextPhase,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  return { ...claim, job };
}


export async function recordInboundExternalAttachmentMetadata(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: {
    sourceActorProjectionId: string;
    filename: string;
    declaredSizeBytes: number;
    mimeType: string;
    providerCreatedAt?: Date | null;
    now?: Date;
  },
): Promise<{ asset: Asset; claim: ExternalAttachmentTransferClaim }> {
  if (claim.job.direction !== "provider_inbound" || claim.job.phase !== "metadata" || !claim.job.assetId) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only an inbound metadata lease can record provider file metadata",
    );
  }
  const now = validDate(rawInput.now ?? currentDate(), "metadata clock");
  const sourceActorProjectionId = bounded(
    rawInput.sourceActorProjectionId,
    "source actor projection ID",
    160,
  );
  const filename = bounded(rawInput.filename, "filename", 1024);
  const declaredSizeBytes = positive(rawInput.declaredSizeBytes, "declared size");
  const mimeType = bounded(rawInput.mimeType, "MIME type", 255);
  const providerCreatedAt = rawInput.providerCreatedAt
    ? validDate(rawInput.providerCreatedAt, "provider creation time")
    : null;
  const [asset] = await executor.select().from(externalAttachmentAssets)
    .where(eq(externalAttachmentAssets.id, claim.job.assetId)).for("update").limit(1);
  const [messageFact] = await executor.select().from(externalAttachmentMessageFacts)
    .where(eq(externalAttachmentMessageFacts.id, claim.job.messageFactId!)).limit(1);
  if (!asset || asset.originDirection !== "provider_inbound" || !messageFact) {
    throw new ExternalAttachmentTransferError("replay_conflict", "Inbound attachment asset is missing");
  }
  await requireInboundAuthority(executor, {
    inboundEventId: messageFact.inboundEventId!,
    sourceActorProjectionId,
    provider: asset.provider,
    appRegistrationId: asset.appRegistrationId,
    installId: asset.installId,
    workspaceId: asset.workspaceId,
    providerAuthorityId: asset.providerAuthorityId,
    connectionEpoch: messageFact.connectionEpoch,
    bindingId: messageFact.bindingId,
    bindingEpoch: messageFact.bindingEpoch,
  });
  if (messageFact.sourceActorProjectionId !== sourceActorProjectionId) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "Inbound attachment source actor conflicts with its frozen message occurrence",
    );
  }
  const replay = asset.state !== "observed";
  if (replay && (
    asset.filename !== filename
    || asset.declaredSizeBytes !== declaredSizeBytes
    || asset.mimeType !== mimeType
    || asset.providerCreatedAt?.getTime() !== providerCreatedAt?.getTime()
  )) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "Inbound attachment metadata conflicts with the frozen provider snapshot",
    );
  }
  const shouldClaimMaterialization = asset.state === "observed"
    || (asset.state === "metadata_ready" && asset.materializationOwnerJobId === null);
  const [updatedAsset] = shouldClaimMaterialization
    ? await executor.update(externalAttachmentAssets).set({
      filename,
      declaredSizeBytes,
      mimeType,
      providerCreatedAt,
      materializationOwnerJobId: claim.job.id,
      state: "metadata_ready",
      updatedAt: now,
    }).where(and(
      eq(externalAttachmentAssets.id, asset.id),
      or(
        eq(externalAttachmentAssets.state, "observed"),
        and(
          eq(externalAttachmentAssets.state, "metadata_ready"),
          isNull(externalAttachmentAssets.materializationOwnerJobId),
        ),
      ),
    )).returning()
    : [asset];
  if (!updatedAsset) {
    throw new ExternalAttachmentTransferError("replay_conflict", "Inbound attachment metadata lost its race");
  }
  const advancedClaim = await advanceExternalAttachmentTransferClaim(executor, claim, {
    nextPhase: "download",
    now,
  });
  return { asset: updatedAsset, claim: advancedClaim };
}

export async function recordOutboundExternalAttachmentTicket(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: {
    provider: string;
    appRegistrationId: string;
    installId: string;
    workspaceId: string;
    providerAuthorityId: string;
    providerFileId: string;
    now?: Date;
  },
): Promise<{ asset: Asset; claim: ExternalAttachmentTransferClaim }> {
  if (
    claim.job.direction !== "raft_outbound"
    || claim.job.phase !== "ticket"
    || !claim.job.frozenObjectId
    || !claim.job.frozenOriginServerId
    || !claim.job.frozenStorageKey
    || !claim.job.frozenFilename
    || !claim.job.frozenMimeType
    || !claim.job.frozenSizeBytes
    || !claim.job.frozenContentDigest
  ) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only an outbound ticket lease can record a provider file obligation",
    );
  }
  const now = validDate(rawInput.now ?? currentDate(), "ticket clock");
  const input = {
    provider: bounded(rawInput.provider, "provider", 80),
    appRegistrationId: bounded(rawInput.appRegistrationId, "app registration ID", 320),
    installId: bounded(rawInput.installId, "install ID", 160),
    workspaceId: bounded(rawInput.workspaceId, "workspace ID", 320),
    providerAuthorityId: bounded(rawInput.providerAuthorityId, "provider authority ID", 160),
    providerFileId: bounded(rawInput.providerFileId, "provider file ID", 320),
  };
  const inserted = await executor.insert(externalAttachmentAssets).values({
    originDirection: "raft_outbound",
    ...input,
    filename: claim.job.frozenFilename,
    declaredSizeBytes: claim.job.frozenSizeBytes,
    mimeType: claim.job.frozenMimeType,
    sourceContentDigest: claim.job.frozenContentDigest,
    raftObjectId: claim.job.frozenObjectId,
    state: "metadata_ready",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  const [asset] = inserted.length > 0
    ? inserted
    : await executor.select().from(externalAttachmentAssets).where(and(
      eq(externalAttachmentAssets.provider, input.provider),
      eq(externalAttachmentAssets.appRegistrationId, input.appRegistrationId),
      eq(externalAttachmentAssets.installId, input.installId),
      eq(externalAttachmentAssets.workspaceId, input.workspaceId),
      eq(externalAttachmentAssets.providerFileId, input.providerFileId),
    )).limit(1);
  if (
    !asset
    || !sameAssetIdentity(asset, { ...input, originDirection: "raft_outbound" })
    || asset.raftObjectId !== claim.job.frozenObjectId
    || asset.filename !== claim.job.frozenFilename
    || asset.mimeType !== claim.job.frozenMimeType
    || asset.declaredSizeBytes !== claim.job.frozenSizeBytes
    || asset.sourceContentDigest !== claim.job.frozenContentDigest
  ) {
    throw new ExternalAttachmentTransferError(
      "replay_conflict",
      "Provider upload ticket conflicts with its frozen Raft attachment",
    );
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    assetId: asset.id,
    phase: "upload",
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  return { asset, claim: { ...claim, job } };
}

export async function releaseExternalAttachmentTransferClaimForRetry(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { errorClass: string; retryAt: Date; retryPhase?: TransferPhase; now?: Date },
): Promise<TransferJob> {
  const now = validDate(rawInput.now ?? currentDate(), "retry clock");
  const retryAt = validDate(rawInput.retryAt, "retry time");
  if (retryAt < now) throw new Error("External attachment retry time is in the past");
  const errorClass = bounded(rawInput.errorClass, "retry error class", 160);
  const retryPhase = rawInput.retryPhase ?? claim.job.phase;
  if (!phaseAllowed(claim.job.direction, retryPhase)) {
    throw new ExternalAttachmentTransferError("invalid_transition", "Attachment retry phase is invalid");
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    phase: retryPhase,
    state: "retry_wait",
    nextAttemptAt: retryAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: errorClass,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  return job;
}

export async function abandonOutboundAttachmentTicketForRetry(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { errorClass: string; retryAt: Date; now?: Date },
): Promise<TransferJob> {
  if (claim.job.direction !== "raft_outbound") {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only an outbound attachment ticket can be abandoned",
    );
  }
  const now = validDate(rawInput.now ?? currentDate(), "ticket abandon clock");
  const retryAt = validDate(rawInput.retryAt, "ticket retry time");
  const errorClass = bounded(rawInput.errorClass, "ticket retry error class", 160);
  if (claim.job.assetId) {
    await executor.update(externalAttachmentAssets).set({
      state: "failed",
      terminalFailureClass: errorClass,
      updatedAt: now,
    }).where(eq(externalAttachmentAssets.id, claim.job.assetId));
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    assetId: null,
    phase: "ticket",
    state: "retry_wait",
    nextAttemptAt: retryAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: errorClass,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  return job;
}

export async function markExternalAttachmentTransferOutcomeUnknown(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: { errorClass: string; reconcileAt: Date; now?: Date },
): Promise<TransferJob> {
  const now = validDate(rawInput.now ?? currentDate(), "outcome clock");
  const reconcileAt = validDate(rawInput.reconcileAt, "reconcile time");
  if (reconcileAt < now) throw new Error("External attachment reconciliation time is in the past");
  if (!(["upload", "complete", "correlate"] as TransferPhase[]).includes(claim.job.phase)) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "Only provider I/O or correlation can have an unknown attachment outcome",
    );
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    state: "outcome_unknown",
    nextAttemptAt: reconcileAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: bounded(rawInput.errorClass, "outcome error class", 160),
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  return job;
}

export async function terminalizeExternalAttachmentTransferClaim(
  executor: DatabaseTransaction,
  claim: ExternalAttachmentTransferClaim,
  rawInput: {
    state: "completed" | "failed" | "revoked" | "quarantined";
    errorClass?: string | null;
    now?: Date;
  },
): Promise<TransferJob> {
  const now = validDate(rawInput.now ?? currentDate(), "terminal clock");
  const errorClass = rawInput.state === "completed"
    ? null
    : bounded(rawInput.errorClass ?? "", "terminal error class", 160);
  if (rawInput.state === "completed" && rawInput.errorClass) {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "A completed attachment transfer cannot retain an error class",
    );
  }
  if (rawInput.state === "completed" && claim.job.phase !== "link") {
    throw new ExternalAttachmentTransferError(
      "invalid_transition",
      "An attachment transfer completes only after its canonical link phase",
    );
  }
  const [job] = await executor.update(externalAttachmentTransferJobs).set({
    state: rawInput.state,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorClass: errorClass,
    terminalAt: now,
    updatedAt: now,
  }).where(claimPredicate(claim)).returning();
  if (!job) throw new ExternalAttachmentTransferError("lease_lost", "Attachment transfer lease was lost");
  if (rawInput.state !== "completed" && job.assetId) {
    await executor.update(externalAttachmentAssets).set({
      state: rawInput.state === "revoked" ? "revoked" : "failed",
      terminalFailureClass: errorClass,
      updatedAt: now,
    }).where(eq(externalAttachmentAssets.id, job.assetId));
  }
  return job;
}
