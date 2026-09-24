import { currentDate } from "@botiverse/raft-shared";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "../db/index.js";
import {
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalMessageLinks,
} from "../db/schema.js";
import type {
  ExternalAttachmentAuthority,
  ExternalOutboundAttachmentSnapshot,
  ExternalOutboundAttachmentProviderAdapter,
} from "./externalAttachmentProviderAdapter.js";
import {
  abandonOutboundAttachmentTicketForRetry,
  advanceExternalAttachmentTransferClaim,
  claimExternalAttachmentTransferJob,
  markExternalAttachmentTransferOutcomeUnknown,
  recordOutboundExternalAttachmentTicket,
  releaseExternalAttachmentTransferClaimForRetry,
  releaseExternalAttachmentTransferClaimQueued,
  terminalizeExternalAttachmentTransferClaim,
} from "./externalAttachmentTransferService.js";
import type { StorageBackend } from "./storageService.js";

const RETRY_MS = 30_000;
const MAX_OUTBOUND_ATTACHMENT_BATCH_BYTES = 512 * 1024 * 1024;

export type ExternalOutboundAttachmentDispatchResult =
  | { kind: "accepted"; providerMessageId: string; providerThreadId?: string | null }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; reasonCode: string; baseDelayMs: number }
  | { kind: "deterministic_failure"; reasonCode: string }
  | { kind: "outcome_unknown"; reasonCode: string };

function authority(snapshot: ExternalOutboundAttachmentSnapshot): ExternalAttachmentAuthority {
  const value = snapshot.bindingAuthority;
  return {
    provider: value.provider,
    appRegistrationId: value.appRegistrationId,
    installId: value.installId,
    workspaceId: value.workspaceId,
    providerAuthorityId: value.providerAuthorityId,
    providerConversationId: value.providerConversationId,
    connectionEpoch: value.connectionEpoch,
    bindingId: value.bindingId,
    bindingEpoch: value.bindingEpoch,
  };
}

function retryTime(now: Date, retryAfterMs: number | null): Date {
  return new Date(now.getTime() + Math.max(0, retryAfterMs ?? RETRY_MS));
}

async function resetCompletionForRateLimit(
  tx: DatabaseTransaction,
  deliveryId: string,
  now: Date,
): Promise<void> {
  await tx.update(externalAttachmentTransferJobs).set({
    phase: "complete",
    state: "queued",
    nextAttemptAt: now,
    lastErrorClass: null,
    terminalAt: null,
    updatedAt: now,
  }).where(and(
    eq(externalAttachmentTransferJobs.outboundDeliveryId, deliveryId),
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.phase, "correlate"),
    eq(externalAttachmentTransferJobs.state, "outcome_unknown"),
  ));
}

async function correlate(
  input: {
    adapter: ExternalOutboundAttachmentProviderAdapter<unknown>;
    authority: ExternalAttachmentAuthority;
    providerFileIds: string[];
    providerRootThreadId: string | null;
    reconciliationMarker: string;
    signal: AbortSignal;
  },
): Promise<ExternalOutboundAttachmentDispatchResult> {
  let result: Awaited<ReturnType<typeof input.adapter.correlateOutboundMessage>>;
  try {
    result = await input.adapter.correlateOutboundMessage({
      authority: input.authority,
      correlation: {
        providerConversationId: input.authority.providerConversationId,
        providerRootThreadId: input.providerRootThreadId,
        providerFileIds: input.providerFileIds,
        reconciliationMarker: input.reconciliationMarker,
      },
      signal: input.signal,
    });
  } catch (error) {
    const failure = input.adapter.classifyFailure(error);
    if (failure.class === "rate_limited") {
      return { kind: "rate_limited", retryAfterMs: failure.retryAfterMs ?? RETRY_MS };
    }
    if (failure.class === "deterministic" || failure.class === "authority_revoked") {
      return { kind: "deterministic_failure", reasonCode: failure.reason };
    }
    return { kind: "outcome_unknown", reasonCode: failure.reason };
  }
  if (result.kind === "matched") {
    return { kind: "accepted", providerMessageId: result.providerMessageId };
  }
  if (result.kind === "conflict") {
    return { kind: "deterministic_failure", reasonCode: result.reason };
  }
  return { kind: "outcome_unknown", reasonCode: "attachment_message_correlation_pending" };
}

export async function dispatchExternalOutboundAttachments(input: {
  db: Database;
  deliveryId: string;
  reconciliationMarker: string;
  snapshot: ExternalOutboundAttachmentSnapshot;
  adapter: ExternalOutboundAttachmentProviderAdapter<unknown>;
  storage: StorageBackend;
  providerRootThreadId: string | null;
  leaseOwner: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<ExternalOutboundAttachmentDispatchResult> {
  if (
    input.snapshot.attachments.length > input.adapter.capabilities.maximumFilesPerMessage
    || input.snapshot.attachments.some((attachment) => (
      attachment.sizeBytes > input.adapter.capabilities.maximumBytesPerFile
    ))
    || input.snapshot.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0)
      > MAX_OUTBOUND_ATTACHMENT_BATCH_BYTES
  ) {
    return { kind: "deterministic_failure", reasonCode: "attachment_provider_capability_exceeded" };
  }
  if (input.snapshot.attachments.length === 0) {
    return { kind: "deterministic_failure", reasonCode: "attachment_snapshot_empty" };
  }
  const now = input.now ?? currentDate;
  const signal = input.signal ?? new AbortController().signal;
  const frozenAuthority = authority(input.snapshot);
  let jobs = await input.db.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, input.deliveryId),
  )).orderBy(asc(externalAttachmentTransferJobs.createdAt), asc(externalAttachmentTransferJobs.id));
  if (jobs.length !== input.snapshot.attachments.length) {
    return { kind: "deterministic_failure", reasonCode: "attachment_transfer_set_invalid" };
  }

  for (const attachment of input.snapshot.attachments) {
    let job = jobs.find((candidate) => candidate.sourceAttachmentId === attachment.sourceAttachmentId);
    if (!job) return { kind: "deterministic_failure", reasonCode: "attachment_transfer_set_invalid" };
    if (
      (job.state === "retry_wait" || job.state === "outcome_unknown")
      && job.nextAttemptAt > now()
    ) {
      return {
        kind: "rate_limited",
        retryAfterMs: Math.max(0, job.nextAttemptAt.getTime() - now().getTime()),
      };
    }
    if (job.state === "outcome_unknown" && job.phase === "upload") {
      return { kind: "outcome_unknown", reasonCode: "attachment_upload_outcome_unknown" };
    }
    if (job.phase === "complete" || job.phase === "correlate" || job.state === "completed") continue;
    const claim = await input.db.transaction((tx) => claimExternalAttachmentTransferJob(tx, {
      leaseOwner: input.leaseOwner,
      direction: "raft_outbound",
      jobId: job!.id,
      outboundDeliveryId: input.deliveryId,
      leaseMs: 5 * 60_000,
      now: now(),
    }));
    if (!claim) return { kind: "transient_failure", reasonCode: "attachment_job_not_claimable", baseDelayMs: RETRY_MS };
    let activeClaim = claim;
    try {
      const ticket = await input.adapter.createOutboundUpload({
        authority: frozenAuthority,
        asset: {
          sourceAttachmentId: attachment.sourceAttachmentId,
          filename: attachment.filename,
          byteSize: attachment.sizeBytes,
          mimeType: attachment.mimeType,
          contentDigest: attachment.contentDigest,
        },
        signal,
      });
      const recorded = await input.db.transaction((tx) => recordOutboundExternalAttachmentTicket(tx, activeClaim, {
        provider: frozenAuthority.provider,
        appRegistrationId: frozenAuthority.appRegistrationId,
        installId: frozenAuthority.installId,
        workspaceId: frozenAuthority.workspaceId,
        providerAuthorityId: frozenAuthority.providerAuthorityId,
        providerFileId: ticket.providerFileId,
        now: now(),
      }));
      activeClaim = recorded.claim;
      const source = await input.storage.get(attachment.storageKey);
      const uploaded = await input.adapter.uploadOutboundAsset({
        authority: frozenAuthority,
        handle: ticket.uploadHandle,
        bytes: source,
        expectedByteSize: attachment.sizeBytes,
        expectedContentDigest: attachment.contentDigest,
        signal,
      });
      if (
        uploaded.uploadedByteSize !== attachment.sizeBytes
        || uploaded.uploadedContentDigest !== attachment.contentDigest
      ) throw new Error("attachment_upload_receipt_mismatch");
      activeClaim = await input.db.transaction((tx) => advanceExternalAttachmentTransferClaim(tx, activeClaim, {
        nextPhase: "complete",
        now: now(),
      }));
      await input.db.transaction((tx) => releaseExternalAttachmentTransferClaimQueued(tx, activeClaim, {
        nextPhase: "complete",
        now: now(),
      }));
    } catch (error) {
      const failure = input.adapter.classifyFailure(error);
      const failedAt = now();
      if (failure.class === "rate_limited" || failure.class === "transient") {
        await input.db.transaction((tx) => abandonOutboundAttachmentTicketForRetry(tx, activeClaim, {
          errorClass: failure.reason,
          retryAt: retryTime(failedAt, failure.retryAfterMs),
          now: failedAt,
        }));
        return failure.class === "rate_limited"
          ? { kind: "rate_limited", retryAfterMs: failure.retryAfterMs ?? RETRY_MS }
          : { kind: "transient_failure", reasonCode: failure.reason, baseDelayMs: RETRY_MS };
      }
      if (failure.class === "outcome_unknown") {
        if (activeClaim.job.phase === "upload") {
          activeClaim = await input.db.transaction((tx) => advanceExternalAttachmentTransferClaim(
            tx,
            activeClaim,
            { nextPhase: "complete", now: failedAt },
          ));
        }
        await input.db.transaction((tx) => markExternalAttachmentTransferOutcomeUnknown(tx, activeClaim, {
          errorClass: failure.reason,
          reconcileAt: retryTime(failedAt, failure.retryAfterMs),
          now: failedAt,
        }));
        return { kind: "outcome_unknown", reasonCode: failure.reason };
      }
      await input.db.transaction((tx) => terminalizeExternalAttachmentTransferClaim(tx, activeClaim, {
        state: failure.class === "authority_revoked" ? "revoked" : "failed",
        errorClass: failure.reason,
        now: failedAt,
      }));
      return { kind: "deterministic_failure", reasonCode: failure.reason };
    }
  }

  jobs = await input.db.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, input.deliveryId),
  )).orderBy(asc(externalAttachmentTransferJobs.createdAt), asc(externalAttachmentTransferJobs.id));
  const assets = jobs.length > 0
    ? await input.db.select().from(externalAttachmentAssets)
      .where(inArray(externalAttachmentAssets.id, jobs.flatMap((job) => job.assetId ? [job.assetId] : [])))
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const providerFileIds = input.snapshot.attachments.map((attachment) => {
    const job = jobs.find((candidate) => candidate.sourceAttachmentId === attachment.sourceAttachmentId);
    return job?.assetId ? assetById.get(job.assetId)?.providerFileId ?? "" : "";
  });
  if (providerFileIds.some((fileId) => !fileId)) {
    return { kind: "deterministic_failure", reasonCode: "attachment_provider_file_set_invalid" };
  }
  if (jobs.some((job) => job.phase === "correlate" || job.state === "completed")) {
    if (!jobs.every((job) => job.phase === "correlate" || job.state === "completed")) {
      return { kind: "deterministic_failure", reasonCode: "attachment_completion_set_inconsistent" };
    }
    return correlate({
      adapter: input.adapter,
      authority: frozenAuthority,
      providerFileIds,
      providerRootThreadId: input.providerRootThreadId,
      reconciliationMarker: input.reconciliationMarker,
      signal,
    });
  }
  const completionAt = now();
  await input.db.transaction(async (tx) => {
    const updated = await tx.update(externalAttachmentTransferJobs).set({
      phase: "correlate",
      state: "outcome_unknown",
      nextAttemptAt: retryTime(completionAt, null),
      lastErrorClass: "attachment_completion_started",
      terminalAt: null,
      updatedAt: completionAt,
    }).where(and(
      eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
      eq(externalAttachmentTransferJobs.outboundDeliveryId, input.deliveryId),
      eq(externalAttachmentTransferJobs.phase, "complete"),
      inArray(externalAttachmentTransferJobs.state, ["queued", "retry_wait", "outcome_unknown"]),
    )).returning({ id: externalAttachmentTransferJobs.id });
    if (updated.length !== jobs.length) throw new Error("Attachment completion pre-call fence failed");
  });
  try {
    const completion = await input.adapter.completeOutboundMessage({
      authority: frozenAuthority,
      completion: {
        providerConversationId: frozenAuthority.providerConversationId,
        providerRootThreadId: input.providerRootThreadId,
        providerFileIds,
        renderedText: input.snapshot.sanitizedText,
        reconciliationMarker: input.reconciliationMarker,
        author: {
          displayName: input.snapshot.authorPolicy.displayName,
          avatarPublicUrl: input.snapshot.authorPolicy.avatar?.publicUrl ?? null,
          fallbackKind: input.snapshot.authorPolicy.fallbackKind,
        },
      },
      signal,
    });
    if (completion.kind === "outcome_unknown") {
      return { kind: "outcome_unknown", reasonCode: completion.reason };
    }
    return correlate({
      adapter: input.adapter,
      authority: frozenAuthority,
      providerFileIds,
      providerRootThreadId: input.providerRootThreadId,
      reconciliationMarker: input.reconciliationMarker,
      signal,
    });
  } catch (error) {
    const failure = input.adapter.classifyFailure(error);
    if (failure.class === "rate_limited") {
      await input.db.transaction((tx) => resetCompletionForRateLimit(tx, input.deliveryId, now()));
      return { kind: "rate_limited", retryAfterMs: failure.retryAfterMs ?? RETRY_MS };
    }
    if (failure.class === "deterministic" || failure.class === "authority_revoked") {
      return { kind: "deterministic_failure", reasonCode: failure.reason };
    }
    return { kind: "outcome_unknown", reasonCode: failure.reason };
  }
}

export async function finalizeAcceptedOutboundAttachmentFacts(
  tx: DatabaseTransaction,
  deliveryId: string,
  snapshot: ExternalOutboundAttachmentSnapshot,
  now: Date,
): Promise<void> {
  const [messageLink] = await tx.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.deliveryId, deliveryId)).limit(1);
  if (!messageLink || messageLink.outcomeState !== "accepted") {
    throw new Error("Accepted attachment delivery has no authenticated message link");
  }
  const jobs = await tx.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, deliveryId),
  )).orderBy(asc(externalAttachmentTransferJobs.createdAt), asc(externalAttachmentTransferJobs.id));
  const positionByAttachmentId = new Map(
    snapshot.attachments.map((attachment) => [attachment.sourceAttachmentId, attachment.messagePosition]),
  );
  for (const job of jobs) {
    if (!job.assetId || !job.sourceAttachmentId || job.phase !== "correlate") {
      throw new Error("Accepted attachment transfer job is incomplete");
    }
    const orderedPosition = positionByAttachmentId.get(job.sourceAttachmentId);
    if (orderedPosition === undefined) throw new Error("Accepted attachment position is unavailable");
    const [fact] = await tx.insert(externalAttachmentMessageFacts).values({
      direction: "raft_outbound",
      messageLinkId: messageLink.id,
      assetId: job.assetId,
      providerAuthorityId: messageLink.providerAuthorityId,
      connectionEpoch: messageLink.connectionEpoch,
      bindingId: messageLink.bindingId,
      bindingEpoch: messageLink.bindingEpoch,
      attachmentProjectionId: job.sourceAttachmentId,
      orderedPosition,
      state: "linked",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (!fact) {
      const [existing] = await tx.select().from(externalAttachmentMessageFacts).where(and(
        eq(externalAttachmentMessageFacts.messageLinkId, messageLink.id),
        eq(externalAttachmentMessageFacts.assetId, job.assetId),
      )).limit(1);
      if (!existing || existing.attachmentProjectionId !== job.sourceAttachmentId || existing.state !== "linked") {
        throw new Error("Outbound attachment fact replay conflict");
      }
    }
    await tx.update(externalAttachmentAssets).set({ state: "linked", updatedAt: now })
      .where(eq(externalAttachmentAssets.id, job.assetId));
    await tx.update(externalAttachmentTransferJobs).set({
      phase: "link",
      state: "completed",
      lastErrorClass: null,
      terminalAt: now,
      nextAttemptAt: now,
      updatedAt: now,
    }).where(eq(externalAttachmentTransferJobs.id, job.id));
  }
}
