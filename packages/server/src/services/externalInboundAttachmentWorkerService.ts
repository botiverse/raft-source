import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import type { Database, DatabaseExecutor } from "../db/index.js";
import {
  channels,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalInboundEvents,
} from "../db/schema.js";
import type {
  ExternalAttachmentAuthority,
  ExternalAttachmentProviderFailure,
  ExternalInboundAttachmentProviderAdapter,
} from "./externalAttachmentProviderAdapter.js";
import {
  beginInboundExternalAttachmentMaterialization,
  claimExternalAttachmentTransferJob,
  recordInboundExternalAttachmentMetadata,
  recordInboundExternalAttachmentStored,
  releaseExternalAttachmentTransferClaimQueued,
  releaseExternalAttachmentTransferClaimForRetry,
  terminalizeInboundExternalAttachmentUnavailable,
} from "./externalAttachmentTransferService.js";
import {
  reuseStoredExternalInboundAttachmentWithExecutor,
  storeExternalInboundAttachment,
} from "./externalInboundAttachmentStorageService.js";
import type { StorageBackend } from "./storageService.js";

const DEFAULT_RETRY_MS = 30_000;
const MATERIALIZATION_WAIT_MS = 1_000;
const MAX_INBOUND_ATTACHMENT_BATCH_BYTES = 512 * 1024 * 1024;

class InboundAttachmentAuthorityError extends Error {}

export interface ExternalInboundAttachmentWorkerDependencies {
  storage: StorageBackend;
  resolveAdapter(provider: string): ExternalInboundAttachmentProviderAdapter<unknown> | null;
  authorityIsCurrent(
    authority: ExternalAttachmentAuthority,
    sourceActorProjectionId: string,
    executor?: DatabaseExecutor,
  ): Promise<boolean>;
  maximumFileSizeBytes(serverId: string, now: Date): Promise<number>;
  now?(): Date;
}

export type ExternalInboundAttachmentWorkerResult =
  | { kind: "empty" }
  | { kind: "metadata_ready"; jobId: string; assetId: string }
  | { kind: "stored"; jobId: string; assetId: string; attachmentProjectionId: string }
  | { kind: "retry"; jobId: string; reason: string; retryAt: Date }
  | { kind: "unavailable"; jobId: string; reason: string };

function safeMimeType(value: string): boolean {
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(mime)
    && mime !== "text/html"
    && mime !== "image/svg+xml"
    && mime !== "application/javascript"
    && mime !== "application/x-javascript"
    && mime !== "application/x-msdownload"
    && mime !== "application/x-sh"
    && mime !== "application/x-httpd-php";
}

function validClock(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function retryAt(now: Date, failure: ExternalAttachmentProviderFailure): Date {
  const delay = failure.class === "rate_limited" && failure.retryAfterMs !== null
    ? Math.max(0, failure.retryAfterMs)
    : DEFAULT_RETRY_MS;
  return new Date(now.getTime() + Math.min(delay, 24 * 60 * 60_000));
}

async function loadFrozenWork(db: Database, assetId: string, messageFactId: string) {
  const [asset] = await db.select().from(externalAttachmentAssets)
    .where(eq(externalAttachmentAssets.id, assetId)).limit(1);
  const [messageFact] = await db.select().from(externalAttachmentMessageFacts)
    .where(eq(externalAttachmentMessageFacts.id, messageFactId)).limit(1);
  const [event] = messageFact?.inboundEventId
    ? await db.select().from(externalInboundEvents)
      .where(eq(externalInboundEvents.id, messageFact.inboundEventId)).limit(1)
    : [];
  const [channel] = event
    ? await db.select({ serverId: channels.serverId }).from(channels)
      .where(eq(channels.id, event.raftChannelId)).limit(1)
    : [];
  if (!asset || !messageFact || !event || !channel || !messageFact.sourceActorProjectionId) return null;
  const authority: ExternalAttachmentAuthority = {
    provider: asset.provider,
    appRegistrationId: asset.appRegistrationId,
    installId: asset.installId,
    workspaceId: asset.workspaceId,
    providerAuthorityId: messageFact.providerAuthorityId,
    providerConversationId: event.providerConversationId,
    connectionEpoch: messageFact.connectionEpoch,
    bindingId: messageFact.bindingId,
    bindingEpoch: messageFact.bindingEpoch,
  };
  return {
    asset,
    messageFact,
    event,
    authority,
    serverId: channel.serverId,
    sourceActorProjectionId: messageFact.sourceActorProjectionId,
  };
}

async function loadInboundBatchMetadata(db: Database, inboundEventId: string, now: Date) {
  const rows = await db.select({
    factState: externalAttachmentMessageFacts.state,
    assetState: externalAttachmentAssets.state,
    declaredSizeBytes: externalAttachmentAssets.declaredSizeBytes,
    jobState: externalAttachmentTransferJobs.state,
    jobNextAttemptAt: externalAttachmentTransferJobs.nextAttemptAt,
  }).from(externalAttachmentMessageFacts)
    .innerJoin(
      externalAttachmentAssets,
      eq(externalAttachmentAssets.id, externalAttachmentMessageFacts.assetId),
    )
    .innerJoin(
      externalAttachmentTransferJobs,
      eq(externalAttachmentTransferJobs.messageFactId, externalAttachmentMessageFacts.id),
    )
    .where(and(
      eq(externalAttachmentMessageFacts.inboundEventId, inboundEventId),
      eq(externalAttachmentMessageFacts.direction, "provider_inbound"),
    ));
  const pendingMetadata = rows.some((row) => (
    row.factState === "pending"
    && row.assetState === "observed"
  ));
  const invalidMetadata = rows.some((row) => (
    row.factState === "pending"
    && row.assetState !== "observed"
    && row.assetState !== "metadata_ready"
    && row.assetState !== "transferring"
  ));
  const totalDeclaredBytes = rows.reduce(
    (total, row) => total + (row.declaredSizeBytes ?? 0),
    0,
  );
  const pendingMetadataRetryAt = rows.reduce<Date | null>((latest, row) => {
    if (row.factState !== "pending" || row.assetState !== "observed") return latest;
    const peerReadyAt = row.jobState === "leased"
      ? now
      : row.jobNextAttemptAt > now
        ? row.jobNextAttemptAt
        : now;
    const candidate = new Date(peerReadyAt.getTime() + MATERIALIZATION_WAIT_MS);
    return !latest || candidate > latest ? candidate : latest;
  }, null);
  return { pendingMetadata, pendingMetadataRetryAt, invalidMetadata, totalDeclaredBytes };
}

export async function processExternalInboundAttachmentOnce(input: {
  db: Database;
  leaseOwner: string;
  dependencies: ExternalInboundAttachmentWorkerDependencies;
  signal?: AbortSignal;
}): Promise<ExternalInboundAttachmentWorkerResult> {
  const claimAt = input.dependencies.now?.() ?? currentDate();
  if (!validClock(claimAt)) throw new Error("External inbound attachment worker clock is invalid");
  const claim = await input.db.transaction((tx) => claimExternalAttachmentTransferJob(tx, {
    leaseOwner: input.leaseOwner,
    direction: "provider_inbound",
    now: claimAt,
  }));
  if (!claim) return { kind: "empty" };
  if (!claim.job.assetId || !claim.job.messageFactId) {
    await input.db.transaction((tx) => terminalizeInboundExternalAttachmentUnavailable(tx, claim, {
      state: "quarantined",
      errorClass: "attachment_coordinates_invalid",
      failureScope: "occurrence_local",
      now: claimAt,
    }));
    return { kind: "unavailable", jobId: claim.job.id, reason: "attachment_coordinates_invalid" };
  }
  const work = await loadFrozenWork(input.db, claim.job.assetId, claim.job.messageFactId);
  const adapter = work ? input.dependencies.resolveAdapter(work.asset.provider) : null;
  if (!work || !adapter) {
    await input.db.transaction((tx) => terminalizeInboundExternalAttachmentUnavailable(tx, claim, {
      state: "quarantined",
      errorClass: "attachment_provider_unavailable",
      failureScope: "occurrence_local",
      now: claimAt,
    }));
    return { kind: "unavailable", jobId: claim.job.id, reason: "attachment_provider_unavailable" };
  }

  const requireCurrentAuthority = async (executor?: DatabaseExecutor) => {
    if (!await input.dependencies.authorityIsCurrent(
      work.authority,
      work.sourceActorProjectionId,
      executor,
    )) {
      throw new InboundAttachmentAuthorityError("attachment_authority_revoked");
    }
  };

  const reuseStoredAsset = async (
    asset: typeof work.asset,
    activeClaim: typeof claim,
  ): Promise<ExternalInboundAttachmentWorkerResult> => {
    if (
      (asset.state !== "stored" && asset.state !== "linked")
      || !asset.raftObjectId
      || !asset.sourceContentDigest
      || !asset.filename
      || !asset.mimeType
      || !asset.declaredSizeBytes
    ) {
      throw new Error("provider_file_materialization_incomplete");
    }
    const reused = await input.db.transaction(async (tx) => {
      await requireCurrentAuthority(tx);
      const projection = await reuseStoredExternalInboundAttachmentWithExecutor(tx, {
        objectId: asset.raftObjectId!,
        messageFactId: work.messageFact.id,
        serverId: work.serverId,
        channelId: work.event.raftChannelId,
        uploaderId: work.sourceActorProjectionId,
        uploaderType: "external_projection",
        filename: asset.filename!,
        mimeType: asset.mimeType!,
        declaredSizeBytes: asset.declaredSizeBytes!,
        contentHash: asset.sourceContentDigest!,
        now: claimAt,
      });
      return recordInboundExternalAttachmentStored(tx, activeClaim, {
        attachmentProjectionId: projection.id,
        now: claimAt,
      });
    });
    return {
      kind: "stored",
      jobId: reused.job.id,
      assetId: reused.asset.id,
      attachmentProjectionId: reused.messageFact.attachmentProjectionId!,
    };
  };

  let activeClaim = claim;

  try {
    await requireCurrentAuthority();
    if (
      claim.job.phase !== "metadata"
      && claim.job.phase !== "download"
      && claim.job.phase !== "store"
    ) {
      throw new Error("attachment_retry_phase_unsupported");
    }
    if (work.asset.state === "failed" || work.asset.state === "revoked") {
      const reason = work.asset.terminalFailureClass ?? "provider_file_materialization_unavailable";
      await input.db.transaction((tx) => terminalizeInboundExternalAttachmentUnavailable(tx, activeClaim, {
        state: work.asset.state === "revoked" ? "revoked" : "failed",
        errorClass: reason,
        failureScope: "asset_global",
        now: claimAt,
      }));
      return { kind: "unavailable", jobId: claim.job.id, reason };
    }
    if (work.asset.state === "stored" || work.asset.state === "linked") {
      return reuseStoredAsset(work.asset, activeClaim);
    }
    if (
      claim.job.phase !== "metadata"
      && work.asset.materializationOwnerJobId !== claim.job.id
      && (work.asset.state === "metadata_ready" || work.asset.state === "transferring")
    ) {
      await input.db.transaction((tx) => releaseExternalAttachmentTransferClaimQueued(tx, activeClaim, {
        nextAttemptAt: new Date(claimAt.getTime() + MATERIALIZATION_WAIT_MS),
        now: claimAt,
      }));
      return { kind: "metadata_ready", jobId: claim.job.id, assetId: work.asset.id };
    }
    const inspected = await adapter.inspectInboundAsset({
      authority: work.authority,
      providerFileId: work.asset.providerFileId,
      signal: input.signal ?? new AbortController().signal,
    });
    const maximumFileSizeBytes = await input.dependencies.maximumFileSizeBytes(
      work.serverId,
      claimAt,
    );
    if (
      !Number.isSafeInteger(maximumFileSizeBytes)
      || maximumFileSizeBytes <= 0
      || inspected.metadata.declaredSizeBytes > maximumFileSizeBytes
    ) {
      throw new Error("recipient_plan_file_limit_exceeded");
    }
    if (!safeMimeType(inspected.metadata.mimeType)) {
      throw new Error("provider_file_mime_disallowed");
    }
    if (claim.job.phase === "metadata") {
      const metadata = await input.db.transaction((tx) => recordInboundExternalAttachmentMetadata(
        tx,
        claim,
        {
          sourceActorProjectionId: work.sourceActorProjectionId,
          filename: inspected.metadata.filename,
          declaredSizeBytes: inspected.metadata.declaredSizeBytes,
          mimeType: inspected.metadata.mimeType,
          providerCreatedAt: inspected.metadata.providerCreatedAt,
          now: claimAt,
        },
      ));
      if (
        (metadata.asset.state === "stored" || metadata.asset.state === "linked")
        && metadata.asset.raftObjectId
        && metadata.asset.sourceContentDigest
      ) {
        return reuseStoredAsset(metadata.asset, metadata.claim);
      }
      await input.db.transaction((tx) => releaseExternalAttachmentTransferClaimQueued(tx, metadata.claim, {
        nextPhase: "download",
        nextAttemptAt: metadata.asset.materializationOwnerJobId === claim.job.id
          ? claimAt
          : new Date(claimAt.getTime() + MATERIALIZATION_WAIT_MS),
        now: claimAt,
      }));
      return { kind: "metadata_ready", jobId: claim.job.id, assetId: work.asset.id };
    }
    if (
      work.asset.materializationOwnerJobId !== claim.job.id
      || (claim.job.phase === "download" && work.asset.state !== "metadata_ready")
      || (claim.job.phase === "store" && work.asset.state !== "transferring")
      || work.asset.filename !== inspected.metadata.filename
      || work.asset.mimeType !== inspected.metadata.mimeType
      || work.asset.declaredSizeBytes !== inspected.metadata.declaredSizeBytes
      || work.asset.providerCreatedAt?.getTime() !== inspected.metadata.providerCreatedAt?.getTime()
    ) {
      throw new Error("provider_file_metadata_changed");
    }
    const batch = await loadInboundBatchMetadata(input.db, work.event.id, claimAt);
    if (batch.invalidMetadata) throw new Error("provider_file_batch_metadata_invalid");
    if (batch.pendingMetadata) {
      await input.db.transaction((tx) => releaseExternalAttachmentTransferClaimQueued(tx, claim, {
        nextPhase: "download",
        nextAttemptAt: batch.pendingMetadataRetryAt
          ?? new Date(claimAt.getTime() + MATERIALIZATION_WAIT_MS),
        now: claimAt,
      }));
      return { kind: "metadata_ready", jobId: claim.job.id, assetId: work.asset.id };
    }
    const aggregateLimit = Math.min(
      MAX_INBOUND_ATTACHMENT_BATCH_BYTES,
      maximumFileSizeBytes * adapter.capabilities.maximumFilesPerMessage,
    );
    if (batch.totalDeclaredBytes > aggregateLimit) {
      throw new Error("provider_file_batch_limit_exceeded");
    }
    await requireCurrentAuthority();
    const materialization = await input.db.transaction((tx) => beginInboundExternalAttachmentMaterialization(
      tx,
      activeClaim,
      {
        now: claimAt,
      },
    ));
    activeClaim = materialization.claim;
    const projection = await storeExternalInboundAttachment({
      assetId: work.asset.id,
      messageFactId: work.messageFact.id,
      serverId: work.serverId,
      channelId: work.event.raftChannelId,
      uploaderId: work.sourceActorProjectionId,
      uploaderType: "external_projection",
      filename: inspected.metadata.filename,
      mimeType: inspected.metadata.mimeType,
      declaredSizeBytes: inspected.metadata.declaredSizeBytes,
      maximumSizeBytes: Math.min(maximumFileSizeBytes, adapter.capabilities.maximumBytesPerFile),
      bytes: adapter.downloadInboundAsset({
        authority: work.authority,
        handle: inspected.downloadHandle,
        maximumBytes: Math.min(maximumFileSizeBytes, adapter.capabilities.maximumBytesPerFile),
        signal: input.signal ?? new AbortController().signal,
      }),
      storage: input.dependencies.storage,
      db: input.db,
      beforePublish: requireCurrentAuthority,
      now: claimAt,
    });
    await requireCurrentAuthority();
    const stored = await input.db.transaction(async (tx) => {
      await requireCurrentAuthority(tx);
      return recordInboundExternalAttachmentStored(tx, activeClaim, {
        attachmentProjectionId: projection.id,
        now: input.dependencies.now?.() ?? currentDate(),
      });
    });
    return {
      kind: "stored",
      jobId: stored.job.id,
      assetId: stored.asset.id,
      attachmentProjectionId: stored.messageFact.attachmentProjectionId!,
    };
  } catch (error) {
    const now = input.dependencies.now?.() ?? currentDate();
    const failure: ExternalAttachmentProviderFailure = error instanceof InboundAttachmentAuthorityError
      ? {
        class: "authority_revoked",
        reason: "attachment_authority_revoked",
        retryAfterMs: null,
        scope: "occurrence_local",
      }
      : error instanceof Error && (
          error.message === "recipient_plan_file_limit_exceeded"
          || error.message === "provider_file_mime_disallowed"
          || error.message === "provider_file_metadata_changed"
          || error.message === "provider_file_batch_metadata_invalid"
          || error.message === "provider_file_batch_limit_exceeded"
        )
        ? {
          class: "deterministic",
          reason: error.message,
          retryAfterMs: null,
          scope: error.message === "recipient_plan_file_limit_exceeded"
            || error.message === "provider_file_batch_metadata_invalid"
            || error.message === "provider_file_batch_limit_exceeded"
            ? "occurrence_local"
            : "asset_global",
        }
        : adapter.classifyFailure(error);
    if (failure.class === "rate_limited" || failure.class === "transient") {
      const nextAttempt = retryAt(now, failure);
      await input.db.transaction((tx) => releaseExternalAttachmentTransferClaimForRetry(tx, activeClaim, {
        errorClass: failure.reason,
        retryAt: nextAttempt,
        retryPhase: activeClaim.job.phase === "store" ? "store" : "metadata",
        now,
      }));
      return { kind: "retry", jobId: claim.job.id, reason: failure.reason, retryAt: nextAttempt };
    }
    await input.db.transaction((tx) => terminalizeInboundExternalAttachmentUnavailable(tx, activeClaim, {
      state: failure.class === "authority_revoked" ? "revoked" : "failed",
      errorClass: failure.reason,
      failureScope: failure.scope,
      now,
    }));
    return { kind: "unavailable", jobId: claim.job.id, reason: failure.reason };
  }
}

export function createExternalInboundAttachmentWorkerRuntime(input: {
  db: Database;
  leaseOwner: string;
  dependencies: ExternalInboundAttachmentWorkerDependencies;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("External inbound attachment worker interval must be positive");
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;
  let controller: AbortController | null = null;
  const tick = () => {
    if (running) return;
    controller = new AbortController();
    running = processExternalInboundAttachmentOnce({
      db: input.db,
      leaseOwner: input.leaseOwner,
      dependencies: input.dependencies,
      signal: controller.signal,
    }).catch(() => undefined).finally(() => {
      running = null;
      controller = null;
    });
  };
  return {
    start() {
      if (timer) return;
      tick();
      timer = setClockInterval(tick, intervalMs) as ReturnType<typeof setInterval>;
      timer.unref?.();
    },
    async stop() {
      if (timer) clearClockInterval(timer);
      timer = null;
      controller?.abort();
      await running?.catch(() => undefined);
    },
    tick,
  };
}
