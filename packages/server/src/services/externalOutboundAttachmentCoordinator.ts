import { createHash } from "node:crypto";
import { open, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { currentDate } from "@botiverse/raft-shared";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "../db/index";
import {
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalMessageLinks,
} from "../db/schema";
import type {
  ExternalAttachmentAuthority,
  ExternalOutboundAttachmentSnapshot,
  ExternalOutboundAttachmentSelection,
  ExternalOutboundAttachmentProviderAdapter,
} from "./externalAttachmentProviderAdapter";
import {
  abandonOutboundAttachmentTicketForRetry,
  advanceExternalAttachmentTransferClaim,
  claimExternalAttachmentTransferJob,
  markExternalAttachmentTransferOutcomeUnknown,
  recordOutboundExternalAttachmentTicket,
  recordOutboundAttachmentSourceDigest,
  renewOutboundAttachmentSourceLease,
  releaseExternalAttachmentTransferClaimForRetry,
  releaseExternalAttachmentTransferClaimQueued,
  terminalizeExternalAttachmentTransferClaim,
} from "./externalAttachmentTransferService";
import type { StorageBackend } from "./storageService";

const RETRY_MS = 30_000;
export const MAX_OUTBOUND_ATTACHMENT_BATCH_BYTES = 512 * 1024 * 1024;

export type ExternalOutboundAttachmentDispatchResult =
  | { kind: "accepted"; providerMessageId: string; providerThreadId?: string | null }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; reasonCode: string; baseDelayMs: number }
  | { kind: "deterministic_failure"; reasonCode: string }
  | { kind: "outcome_unknown"; reasonCode: string };

type AttachmentWriteAdmission = (tx: DatabaseTransaction) => Promise<void>;

function selectedAttachments(snapshot: ExternalOutboundAttachmentSnapshot, selection?: ExternalOutboundAttachmentSelection) {
  if (!selection) return snapshot.attachments;
  const included = new Set(selection.includedAttachmentIds);
  const omitted = new Set(selection.omittedAttachmentIds);
  if (included.size !== selection.includedAttachmentIds.length || omitted.size !== selection.omittedAttachmentIds.length
    || included.size + omitted.size !== snapshot.attachments.length
    || snapshot.attachments.some(file => included.has(file.sourceAttachmentId) === omitted.has(file.sourceAttachmentId))) {
    throw new Error("attachment_selection_invalid");
  }
  return snapshot.attachments.filter(file => included.has(file.sourceAttachmentId));
}

function writeTransaction<T>(db: Database, admit: AttachmentWriteAdmission | undefined,
  work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async tx => { await admit?.(tx); return work(tx); });
}

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

function retryDelay(attempts: number, retryAfterMs: number | null): number {
  return Math.max(retryAfterMs ?? 0, Math.min(5 * 60_000, RETRY_MS * 2 ** Math.min(4, Math.max(0, attempts - 1))));
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

// Direct-upload and legacy objects may have no stored hash. Read them once in a
// bounded stream and persist the digest before requesting any provider ticket.
async function hashSource(
  storage: StorageBackend, key: string, expectedSize: number, parentSignal: AbortSignal | undefined,
  onProgress: () => Promise<void>,
): Promise<string> {
  const controller = new AbortController();
  const parentAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  parentSignal?.addEventListener("abort", parentAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 4 * 60_000);
  };
  resetIdle();
  let stream: Awaited<ReturnType<StorageBackend["get"]>> | undefined;
  const abort = () => stream?.destroy(new Error("attachment_source_read_aborted"));
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    stream = await storage.get(key, controller.signal);
    if (controller.signal.aborted) throw new Error("attachment_source_read_aborted");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of stream) {
      resetIdle();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > expectedSize) throw new Error("attachment_source_size_mismatch");
      hash.update(bytes);
      await onProgress();
    }
    if (size !== expectedSize) throw new Error("attachment_source_size_mismatch");
    return hash.digest("hex");
  } finally {
    clearTimeout(idleTimer!);
    parentSignal?.removeEventListener("abort", parentAbort);
    controller.signal.removeEventListener("abort", abort);
    stream?.destroy();
  }
}

/** Keep the validated bytes in an anonymous, bounded temporary file, avoiding
 * a second storage read after verification. Closing the descriptor removes the
 * bytes even if the worker crashes; no public path or upload URL is persisted. */
async function stageSource(storage: StorageBackend, file: ExternalOutboundAttachmentSnapshot["attachments"][number],
  signal: AbortSignal, onProgress: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "raft-outbound-"));
  const path = join(dir, "source");
  const handle = await open(path, "wx+", 0o600);
  await unlink(path);
  await rmdir(dir);
  let source: Readable | undefined;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 4 * 60_000); };
  const abort = () => source?.destroy(new Error("attachment_source_read_failed"));
  combined.addEventListener("abort", abort, { once: true });
  try {
    resetIdle();
    source = await storage.get(file.storageKey, combined);
    combined.throwIfAborted();
    const hash = createHash("sha256");
    let length = 0;
    for await (const chunk of source) {
      resetIdle();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > file.sizeBytes) throw new Error("attachment_source_size_mismatch");
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset);
        offset += written.bytesWritten;
      }
      await onProgress();
    }
    if (length !== file.sizeBytes) throw new Error("attachment_source_size_mismatch");
    return { digest: hash.digest("hex"), stream: () => handle.createReadStream({ start: 0, autoClose: false }),
      close: () => handle.close() };
  } catch (error) {
    await handle.close();
    if (error instanceof Error && error.message === "attachment_source_size_mismatch") throw error;
    throw new Error("attachment_source_read_failed");
  } finally {
    clearTimeout(idle); combined.removeEventListener("abort", abort); source?.destroy();
  }
}

/** Prepare missing immutable hashes before the delivery worker marks provider I/O started. */
export async function prepareOutboundAttachmentSourceDigests(input: {
  db: Database;
  deliveryId: string;
  snapshot: ExternalOutboundAttachmentSnapshot;
  storage: StorageBackend;
  leaseOwner: string;
  now?: () => Date;
  signal?: AbortSignal;
  selection?: ExternalOutboundAttachmentSelection;
  admitWrite?: AttachmentWriteAdmission;
}): Promise<{ ready: true } | { ready: false; reason: string }> {
  // Let the dispatcher classify over-limit batches without reading source bytes.
  if (input.snapshot.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0)
    > MAX_OUTBOUND_ATTACHMENT_BATCH_BYTES) return { ready: true };
  const now = input.now ?? currentDate;
  const jobs = await input.db.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, input.deliveryId),
  ));
  if (jobs.length !== input.snapshot.attachments.length) return { ready: false, reason: "attachment_transfer_set_invalid" };
  for (const attachment of selectedAttachments(input.snapshot, input.selection)) {
    const job = jobs.find((item) => item.sourceAttachmentId === attachment.sourceAttachmentId);
    if (!job) return { ready: false, reason: "attachment_transfer_set_invalid" };
    if (job.frozenContentDigest) continue;
    const claimedAt = now();
    const claim = await writeTransaction(input.db, input.admitWrite, (tx) => claimExternalAttachmentTransferJob(tx, {
      leaseOwner: input.leaseOwner, direction: "raft_outbound", jobId: job.id,
      outboundDeliveryId: input.deliveryId, leaseMs: 5 * 60_000, now: claimedAt,
    }));
    if (!claim) return { ready: false, reason: "attachment_source_not_ready" };
    let activeClaim = claim;
    try {
      let lastRenewal = claimedAt;
      const digest = await hashSource(input.storage, attachment.storageKey, attachment.sizeBytes, input.signal, async () => {
        const progressAt = now();
        if (progressAt.getTime() - lastRenewal.getTime() >= 60_000) {
          activeClaim = await writeTransaction(input.db, input.admitWrite, (tx) => renewOutboundAttachmentSourceLease(tx, activeClaim, progressAt));
          lastRenewal = progressAt;
        }
      });
      activeClaim = await writeTransaction(input.db, input.admitWrite, (tx) => recordOutboundAttachmentSourceDigest(tx, activeClaim, digest, now()));
      await writeTransaction(input.db, input.admitWrite, (tx) => releaseExternalAttachmentTransferClaimQueued(tx, activeClaim, {
        nextPhase: "ticket", now: now(),
      }));
    } catch (error) {
      const failedAt = now();
      const errorClass = error instanceof Error && error.message === "attachment_source_size_mismatch"
        ? "attachment_source_size_mismatch" : "attachment_source_read_failed";
      try {
        await writeTransaction(input.db, input.admitWrite, (tx) => releaseExternalAttachmentTransferClaimForRetry(tx, activeClaim, {
          errorClass, retryAt: retryTime(failedAt, retryDelay(activeClaim.job.attempts, null)), now: failedAt,
        }));
      } catch {
        // Another worker reclaimed the lease. It owns the next attempt.
      }
      return { ready: false, reason: errorClass };
    }
  }
  return { ready: true };
}

function matchesFrozenFileSet(jobs: Array<typeof externalAttachmentTransferJobs.$inferSelect>, snapshot: ExternalOutboundAttachmentSnapshot): boolean {
  return jobs.length === snapshot.attachments.length && snapshot.attachments.every(file => {
    const job = jobs.find(row => row.sourceAttachmentId === file.sourceAttachmentId);
    return job && job.frozenObjectId === file.objectId && job.frozenOriginServerId === file.originServerId
      && job.frozenStorageKey === file.storageKey && job.frozenFilename === file.filename
      && job.frozenMimeType === file.mimeType && job.frozenSizeBytes === file.sizeBytes
      && (file.contentDigest === null || job.frozenContentDigest === file.contentDigest);
  });
}

/** Read-only confirmation; it never obtains a ticket, uploads or completes a file. */
export async function reconcileExternalOutboundAttachments(input: Pick<
  Parameters<typeof dispatchExternalOutboundAttachments>[0],
  "db" | "deliveryId" | "snapshot" | "adapter" | "providerRootThreadId" | "reconciliationMarker" | "selection"
>) : Promise<ExternalOutboundAttachmentDispatchResult | null> {
  const jobs = await input.db.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, input.deliveryId),
  ));
  const selected = selectedAttachments(input.snapshot, input.selection);
  if (!matchesFrozenFileSet(jobs, input.snapshot)) {
    return { kind: "deterministic_failure", reasonCode: "attachment_transfer_set_invalid" };
  }
  const selectedJobs = jobs.filter(job => selected.some(file => file.sourceAttachmentId === job.sourceAttachmentId));
  // Completion atomically records every selected file before publishing. No
  // such record means only private uploads may have happened: resume this same
  // file set, rather than trapping a legacy upload reset in reconciliation.
  if (selectedJobs.every(job => job.phase !== "correlate" && job.state !== "completed")) return null;
  if (selectedJobs.some(job => job.phase !== "correlate" && job.state !== "completed")) {
    return { kind: "deterministic_failure", reasonCode: "attachment_completion_set_inconsistent" };
  }
  const assets = await input.db.select().from(externalAttachmentAssets).where(inArray(
    externalAttachmentAssets.id, jobs.flatMap((job) => job.assetId ? [job.assetId] : []),
  ));
  const files: string[] = [];
  for (const attachment of selected) {
    const job = jobs.find((candidate) => candidate.sourceAttachmentId === attachment.sourceAttachmentId);
    const asset = assets.find((candidate) => candidate.id === job?.assetId);
    if (!job || !asset || !asset.providerFileId || !job.frozenContentDigest
      || (attachment.contentDigest !== null && job.frozenContentDigest !== attachment.contentDigest)
      || asset.provider !== input.snapshot.bindingAuthority.provider
      || asset.appRegistrationId !== input.snapshot.bindingAuthority.appRegistrationId
      || asset.installId !== input.snapshot.bindingAuthority.installId
      || asset.workspaceId !== input.snapshot.bindingAuthority.workspaceId
      || asset.providerAuthorityId !== input.snapshot.bindingAuthority.providerAuthorityId) {
      return { kind: "deterministic_failure", reasonCode: "attachment_correlation_identity_conflict" };
    }
    files.push(asset.providerFileId);
  }
  if (!files.length || new Set(files).size !== files.length) {
    return { kind: "deterministic_failure", reasonCode: "attachment_correlation_identity_conflict" };
  }
  return correlate({ adapter: input.adapter, authority: authority(input.snapshot), providerFileIds: files,
    providerRootThreadId: input.providerRootThreadId, reconciliationMarker: input.reconciliationMarker,
    signal: new AbortController().signal });
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
  selection?: ExternalOutboundAttachmentSelection;
  renderedText?: string;
  /** Upload tickets/bytes are private preparation; this mode never shares a message. */
  prepareOnly?: boolean;
  admitWrite?: AttachmentWriteAdmission;
  /** Strict parent claim validation at the only visible publication boundary. */
  admitCompletion?: AttachmentWriteAdmission;
  now?: () => Date;
}): Promise<ExternalOutboundAttachmentDispatchResult | { kind: "prepared" }> {
  const selected = selectedAttachments(input.snapshot, input.selection);
  if (
    selected.length > input.adapter.capabilities.maximumFilesPerMessage
    || selected.some((attachment) => (
      attachment.sizeBytes > input.adapter.capabilities.maximumBytesPerFile
    ))
    || selected.reduce((sum, attachment) => sum + attachment.sizeBytes, 0)
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
  if (!matchesFrozenFileSet(jobs, input.snapshot)) {
    return { kind: "deterministic_failure", reasonCode: "attachment_transfer_set_invalid" };
  }

  for (const attachment of selected) {
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
    const claim = await writeTransaction(input.db, input.admitWrite, (tx) => claimExternalAttachmentTransferJob(tx, {
      leaseOwner: input.leaseOwner,
      direction: "raft_outbound",
      jobId: job!.id,
      outboundDeliveryId: input.deliveryId,
      leaseMs: 5 * 60_000,
      now: now(),
    }));
    if (!claim) return { kind: "transient_failure", reasonCode: "attachment_job_not_claimable", baseDelayMs: RETRY_MS };
    let activeClaim = claim;
    let sourceDigest = activeClaim.job.frozenContentDigest;
    let lastRenewal = now();
    const renew = async () => {
      const at = now();
      if (at.getTime() - lastRenewal.getTime() >= 20_000) {
        activeClaim = await writeTransaction(input.db, input.admitWrite,
          tx => renewOutboundAttachmentSourceLease(tx, activeClaim, at));
        lastRenewal = at;
      }
    };
    if (!sourceDigest && !input.prepareOnly) {
      await writeTransaction(input.db, input.admitWrite, (tx) => releaseExternalAttachmentTransferClaimQueued(tx, activeClaim, {
        nextPhase: "ticket", now: now(),
      }));
      return { kind: "transient_failure", reasonCode: "attachment_source_not_prepared", baseDelayMs: RETRY_MS };
    }
    let staged: Awaited<ReturnType<typeof stageSource>> | undefined;
    try {
      if (input.prepareOnly) {
        staged = await stageSource(input.storage, attachment, signal, renew);
        if (sourceDigest && staged.digest !== sourceDigest) throw new Error("attachment_source_digest_mismatch");
        if (!sourceDigest) {
          activeClaim = await writeTransaction(input.db, input.admitWrite,
            tx => recordOutboundAttachmentSourceDigest(tx, activeClaim, staged!.digest, now()));
          sourceDigest = staged.digest;
        }
      }
      if (!sourceDigest) throw new Error("attachment_source_not_prepared");
      const ticket = await input.adapter.createOutboundUpload({
        authority: frozenAuthority,
        asset: {
          sourceAttachmentId: attachment.sourceAttachmentId,
          filename: attachment.filename,
          byteSize: attachment.sizeBytes,
          mimeType: attachment.mimeType,
          contentDigest: sourceDigest,
        },
        signal,
      });
      const recorded = await writeTransaction(input.db, input.admitWrite, (tx) => recordOutboundExternalAttachmentTicket(tx, activeClaim, {
        provider: frozenAuthority.provider,
        appRegistrationId: frozenAuthority.appRegistrationId,
        installId: frozenAuthority.installId,
        workspaceId: frozenAuthority.workspaceId,
        providerAuthorityId: frozenAuthority.providerAuthorityId,
        providerFileId: ticket.providerFileId,
        now: now(),
      }));
      activeClaim = recorded.claim;
      let source: Awaited<ReturnType<StorageBackend["get"]>>;
      try { source = staged ? staged.stream() : await input.storage.get(attachment.storageKey, signal); }
      catch (error) {
        if (!input.prepareOnly) throw error;
        await writeTransaction(input.db, input.admitWrite, tx => abandonOutboundAttachmentTicketForRetry(tx, activeClaim, {
          errorClass: "attachment_source_read_failed", retryAt: retryTime(now(), RETRY_MS), now: now(),
        }));
        return { kind: "transient_failure", reasonCode: "attachment_source_read_failed", baseDelayMs: RETRY_MS };
      }
      let uploaded: Awaited<ReturnType<typeof input.adapter.uploadOutboundAsset>>;
      try {
        uploaded = await input.adapter.uploadOutboundAsset({
          authority: frozenAuthority,
          handle: ticket.uploadHandle,
          bytes: Readable.from((async function* () {
            for await (const chunk of source) { await renew(); yield chunk; }
          })()),
          expectedByteSize: attachment.sizeBytes,
          expectedContentDigest: sourceDigest,
          signal,
        });
      } finally {
        source.destroy();
      }
      if (
        uploaded.uploadedByteSize !== attachment.sizeBytes
        || uploaded.uploadedContentDigest !== sourceDigest
      ) throw new Error("attachment_upload_receipt_mismatch");
      activeClaim = await writeTransaction(input.db, input.admitWrite, (tx) => advanceExternalAttachmentTransferClaim(tx, activeClaim, {
        nextPhase: "complete",
        now: now(),
      }));
      await writeTransaction(input.db, input.admitWrite, (tx) => releaseExternalAttachmentTransferClaimQueued(tx, activeClaim, {
        nextPhase: "complete",
        now: now(),
      }));
    } catch (error) {
      const sourceIssue = error instanceof Error && ["attachment_source_size_mismatch", "attachment_source_digest_mismatch", "attachment_source_read_failed"].includes(error.message)
        ? error.message : null;
      const failure = input.adapter.classifyFailure(error);
      const failedAt = now();
      const delay = retryDelay(activeClaim.job.attempts, failure.retryAfterMs);
      if (input.prepareOnly) {
        const reason = sourceIssue ?? failure.reason;
        await writeTransaction(input.db, input.admitWrite, tx => abandonOutboundAttachmentTicketForRetry(tx, activeClaim, {
          errorClass: reason, retryAt: retryTime(failedAt, delay), now: failedAt,
        }));
        return { kind: "transient_failure", reasonCode: reason, baseDelayMs: delay };
      }
      if (failure.class === "rate_limited" || failure.class === "transient") {
        await writeTransaction(input.db, input.admitWrite, (tx) => abandonOutboundAttachmentTicketForRetry(tx, activeClaim, {
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
          activeClaim = await writeTransaction(input.db, input.admitWrite, (tx) => advanceExternalAttachmentTransferClaim(
            tx,
            activeClaim,
            { nextPhase: "complete", now: failedAt },
          ));
        }
        await writeTransaction(input.db, input.admitWrite, (tx) => markExternalAttachmentTransferOutcomeUnknown(tx, activeClaim, {
          errorClass: failure.reason,
          reconcileAt: retryTime(failedAt, failure.retryAfterMs),
          now: failedAt,
        }));
        return { kind: "outcome_unknown", reasonCode: failure.reason };
      }
      await writeTransaction(input.db, input.admitWrite, (tx) => terminalizeExternalAttachmentTransferClaim(tx, activeClaim, {
        state: failure.class === "authority_revoked" ? "revoked" : "failed",
        errorClass: failure.reason,
        now: failedAt,
      }));
      return { kind: "deterministic_failure", reasonCode: failure.reason };
    } finally { await staged?.close(); }
  }

  jobs = await input.db.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, input.deliveryId),
  )).orderBy(asc(externalAttachmentTransferJobs.createdAt), asc(externalAttachmentTransferJobs.id));
  jobs = jobs.filter(job => selected.some(file => file.sourceAttachmentId === job.sourceAttachmentId));
  if (input.prepareOnly) {
    return jobs.length === selected.length && jobs.every(job => job.phase === "complete" && job.state === "queued")
      ? { kind: "prepared" } : { kind: "transient_failure", reasonCode: "attachment_source_not_ready", baseDelayMs: RETRY_MS };
  }
  const assets = jobs.length > 0
    ? await input.db.select().from(externalAttachmentAssets)
      .where(inArray(externalAttachmentAssets.id, jobs.flatMap((job) => job.assetId ? [job.assetId] : [])))
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const providerFileIds = selected.map((attachment) => {
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
  await writeTransaction(input.db, input.admitCompletion ?? input.admitWrite, async (tx) => {
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
      inArray(externalAttachmentTransferJobs.id, jobs.map(job => job.id)),
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
        renderedText: input.renderedText ?? input.snapshot.sanitizedText,
        reconciliationMarker: input.reconciliationMarker,
        author: {
          displayName: input.snapshot.authorPresentation.displayName,
          avatarPublicUrl: input.snapshot.authorPresentation.avatar?.publicUrl ?? null,
          fallbackKind: input.snapshot.authorPresentation.fallbackKind,
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
      await writeTransaction(input.db, input.admitWrite, (tx) => resetCompletionForRateLimit(tx, input.deliveryId, now()));
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
  selection?: ExternalOutboundAttachmentSelection,
): Promise<void> {
  selectedAttachments(snapshot, selection);
  const omitted = new Set(selection?.omittedAttachmentIds);
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
    if (job.sourceAttachmentId && omitted.has(job.sourceAttachmentId)) {
      if (job.phase === "correlate" || job.state === "completed" || job.state === "leased") {
        throw new Error("Omitted attachment has a conflicting completion");
      }
      await tx.update(externalAttachmentTransferJobs).set({ state: "failed", terminalAt: now,
        lastErrorClass: "attachment_source_missing_omitted", updatedAt: now,
      }).where(eq(externalAttachmentTransferJobs.id, job.id));
      continue;
    }
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
