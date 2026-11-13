import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index";
import { attachmentObjects, externalAttachmentTransferJobs, externalDeliveryAttempts, externalOutboundDeliveries, externalMessageLinks,
  slackAttachmentFallbackPlans, type SlackAttachmentPlanItem } from "../db/schema";
import { digestSlackBridgeRenderSnapshot, type SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import { lockPartitionAndHead } from "./externalDeliveryWorkerService";
import type { StorageBackend } from "./storageService";

type Evidence = "object_deleted" | "storage_object_missing" | null;

export { validateSlackAttachmentFallbackPlan } from "./slackAttachmentFallbackValidation";
import { validateSlackAttachmentFallbackPlan } from "./slackAttachmentFallbackValidation";

/**
 * Prepare a pre-publication plan. Upload tickets and bytes are private until
 * completion; a prior visible attempt or live transfer lease rejects revision.
 * The caller must attest the deployed fleet using the durable rollout control.
 */
export async function prepareSlackAttachmentFallbackPlan(input: {
  db: Database;
  deliveryId: string;
  bindingId: string;
  bindingEpoch: number;
  snapshot: SlackBridgeRenderSnapshot;
  storage: StorageBackend;
  now: () => Date;
  signal?: AbortSignal;
  assertWriterFleetFenced: (tx: DatabaseTransaction) => Promise<boolean>;
}): Promise<{ kind: "no_fallback" | "source_unavailable" | "lease_or_fence_unavailable" }
  | { kind: "planned"; revision: number }> {
  const files = input.snapshot.attachments;
  if (input.snapshot.bindingAuthority.provider !== "slack" || files.length < 1 || files.length > 10
    || new Set(files.map((file) => file.sourceAttachmentId)).size !== files.length) {
    throw new Error("Invalid Slack attachment plan snapshot");
  }
  const snapshotDigest = digestSlackBridgeRenderSnapshot(input.snapshot);
  // Bound the whole batch, not each file independently. Backends must honor
  // the signal; a timeout is unavailable evidence, never a missing object.
  const deadline = AbortSignal.timeout(20_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const observations: Evidence[] = [];
  for (const file of files) {
    if (signal.aborted) return { kind: "source_unavailable" };
    const [object] = await input.db.select().from(attachmentObjects).where(eq(attachmentObjects.id, file.objectId)).limit(1);
    if (!object || object.storageKey !== file.storageKey || object.originServerId !== file.originServerId
      || object.sizeBytes !== file.sizeBytes || object.mimeType !== file.mimeType) return { kind: "source_unavailable" };
    if (object.lifecycleState === "deleted") { observations.push("object_deleted"); continue; }
    if (object.lifecycleState !== "active" || !input.storage.probeObjectPresence) return { kind: "source_unavailable" };
    try {
      observations.push(await input.storage.probeObjectPresence(file.storageKey, signal) === "missing"
        ? "storage_object_missing" : null);
    } catch { return { kind: "source_unavailable" }; }
  }
  return input.db.transaction(async (tx) => {
    const locked = await lockPartitionAndHead(tx, input.bindingId, input.bindingEpoch);
    const delivery = locked?.delivery;
    const now = input.now();
    if (!locked || !delivery || delivery.id !== input.deliveryId
      || !["queued", "retry_wait"].includes(delivery.state)
      || delivery.leaseOwner !== null || delivery.leaseExpiresAt !== null || !Number.isFinite(now.getTime())
      || delivery.providerAttempts !== 0 || delivery.firstDispatchedAt !== null
      || delivery.renderSnapshotDigest !== snapshotDigest || !await input.assertWriterFleetFenced(tx)) {
      return { kind: "lease_or_fence_unavailable" as const };
    }
    const [priorAttempt] = await tx.select({ id: externalDeliveryAttempts.id }).from(externalDeliveryAttempts)
      .where(eq(externalDeliveryAttempts.deliveryId, delivery.id)).limit(1);
    const [priorReceipt] = await tx.select({ id: externalMessageLinks.id }).from(externalMessageLinks)
      .where(eq(externalMessageLinks.deliveryId, delivery.id)).limit(1);
    if (priorAttempt || priorReceipt) return { kind: "lease_or_fence_unavailable" as const };
    const jobs = await tx.select().from(externalAttachmentTransferJobs).where(and(
      eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
      eq(externalAttachmentTransferJobs.outboundDeliveryId, delivery.id),
    )).orderBy(asc(externalAttachmentTransferJobs.id)).for("update");
    if (jobs.length !== files.length || jobs.some((job) => !["ticket", "complete"].includes(job.phase)
      || !["queued", "retry_wait"].includes(job.state) || job.leaseOwner !== null || job.leaseExpiresAt !== null)) {
      return { kind: "source_unavailable" as const };
    }
    const objects = await tx.select().from(attachmentObjects)
      .where(inArray(attachmentObjects.id, files.map((file) => file.objectId)))
      .orderBy(asc(attachmentObjects.id)).for("update");
    const items: SlackAttachmentPlanItem[] = [];
    for (const [index, file] of files.entries()) {
      const job = jobs.find((row) => row.sourceAttachmentId === file.sourceAttachmentId);
      const object = objects.find((row) => row.id === file.objectId);
      const evidence = observations[index];
      if (!job || !object || job.frozenObjectId !== file.objectId || job.frozenStorageKey !== file.storageKey
        || job.frozenOriginServerId !== file.originServerId || job.frozenFilename !== file.filename
        || job.frozenMimeType !== file.mimeType || job.frozenSizeBytes !== file.sizeBytes
        || (file.contentDigest !== null && job.frozenContentDigest !== file.contentDigest)
        || object.storageKey !== file.storageKey || object.originServerId !== file.originServerId
        || object.sizeBytes !== file.sizeBytes || object.mimeType !== file.mimeType
        || (evidence === "object_deleted" && object.lifecycleState !== "deleted")
        || (evidence !== "object_deleted" && object.lifecycleState !== "active")) {
        return { kind: "source_unavailable" as const };
      }
      items.push({ transferJobId: job.id, sourceAttachmentId: file.sourceAttachmentId,
        frozenObjectId: file.objectId, decision: evidence ? "omit" : "include", evidence: evidence ?? null });
    }
    // Incrementing the generation while holding the partition and delivery
    // locks fences any stale worker whose earlier lease was already reclaimed.
    const nextGeneration = delivery.leaseGeneration + 1;
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration > 2_147_483_647) {
      return { kind: "lease_or_fence_unavailable" as const };
    }
    const transport = items.every((item) => item.decision === "omit") ? "text" : "files";
    if (delivery.attachmentFallbackPlanRevision !== null) {
      const [current] = await tx.select().from(slackAttachmentFallbackPlans).where(and(
        eq(slackAttachmentFallbackPlans.deliveryId, delivery.id),
        eq(slackAttachmentFallbackPlans.revision, delivery.attachmentFallbackPlanRevision),
      )).limit(1);
      if (!current || !validateSlackAttachmentFallbackPlan({ deliveryId: delivery.id,
        revision: delivery.attachmentFallbackPlanRevision, renderSnapshotDigest: snapshotDigest,
        snapshot: input.snapshot, plan: current, jobs })) return { kind: "source_unavailable" as const };
      if (!observations.some(Boolean)) {
        await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
        await tx.update(externalOutboundDeliveries).set({ attachmentFallbackPlanRevision: null, leaseGeneration: nextGeneration })
          .where(eq(externalOutboundDeliveries.id, delivery.id));
        return { kind: "no_fallback" as const };
      }
      if (current.transport === transport && Array.isArray(current.items) && current.items.length === items.length
        && current.items.every((item, index) => {
          const expected = items[index]!;
          return item.transferJobId === expected.transferJobId && item.sourceAttachmentId === expected.sourceAttachmentId
            && item.frozenObjectId === expected.frozenObjectId && item.decision === expected.decision
            && item.evidence === expected.evidence;
        })) {
        return { kind: "planned" as const, revision: current.revision };
      }
    }
    if (!observations.some(Boolean)) return { kind: "no_fallback" as const };
    // Read all revisions under the locked delivery: no writer can advance the
    // pointer or insert a competing revision without taking the same lock.
    // A wrong-but-existing bucket also returns NoSuchKey. Bound new durable
    // decisions globally; unchanged retries above never spend this budget.
    // This is the last lock in plan creation; no other path acquires it first.
    await tx.execute(sql`select pg_advisory_xact_lock(19204217, 1)`);
    const [recent] = await tx.select({ count: sql<number>`count(*)::integer` }).from(slackAttachmentFallbackPlans)
      .where(gte(slackAttachmentFallbackPlans.createdAt, new Date(now.getTime() - 60_000)));
    if ((recent?.count ?? 0) >= 4) return { kind: "source_unavailable" as const };
    const revisions = await tx.select({ revision: slackAttachmentFallbackPlans.revision }).from(slackAttachmentFallbackPlans)
      .where(eq(slackAttachmentFallbackPlans.deliveryId, delivery.id));
    const revision = Math.max(0, ...revisions.map((row) => row.revision)) + 1;
    if (!Number.isSafeInteger(revision) || revision > 2_147_483_647) throw new Error("Slack attachment plan revision overflow");
    const [plan] = await tx.insert(slackAttachmentFallbackPlans).values({ deliveryId: delivery.id, revision,
      snapshotDigest, transport, items, createdAt: now }).returning();
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ attachmentFallbackPlanRevision: plan.revision, leaseGeneration: nextGeneration })
      .where(eq(externalOutboundDeliveries.id, delivery.id));
    return { kind: "planned" as const, revision: plan.revision };
  });
}

/**
 * Read the immutable transport decision only for the still-owned queue head.
 * Callers must revalidate the claim at the provider I/O boundary: this read
 * releases its transaction before network I/O, so it does not extend the lease.
 */
export async function readSlackAttachmentFallbackForClaim(input: {
  db: Database;
  deliveryId: string;
  bindingId: string;
  bindingEpoch: number;
  leaseOwner: string;
  leaseGeneration: number;
  snapshot: SlackBridgeRenderSnapshot;
  now: () => Date;
}): Promise<{ kind: "unavailable" | "none" } | {
  kind: "planned"; revision: number; transport: "text" | "files";
  includedAttachmentIds: string[]; omittedAttachmentIds: string[];
}> {
  if (!input.leaseOwner.trim() || !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    return { kind: "unavailable" };
  }
  return input.db.transaction(async tx => {
    const locked = await lockPartitionAndHead(tx, input.bindingId, input.bindingEpoch);
    const delivery = locked?.delivery;
    const checkedAt = input.now();
    if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) return { kind: "unavailable" as const };
    if (!delivery || delivery.id !== input.deliveryId || delivery.state !== "dispatching"
      || delivery.leaseOwner !== input.leaseOwner || delivery.leaseGeneration !== input.leaseGeneration
      || !delivery.leaseExpiresAt || delivery.leaseExpiresAt <= checkedAt
      || digestSlackBridgeRenderSnapshot(input.snapshot) !== delivery.renderSnapshotDigest) return { kind: "unavailable" as const };
    if (delivery.attachmentFallbackPlanRevision === null) return { kind: "none" as const };
    const [plan] = await tx.select().from(slackAttachmentFallbackPlans).where(and(
      eq(slackAttachmentFallbackPlans.deliveryId, delivery.id),
      eq(slackAttachmentFallbackPlans.revision, delivery.attachmentFallbackPlanRevision),
    )).limit(1);
    const jobs = await tx.select().from(externalAttachmentTransferJobs).where(and(
      eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
      eq(externalAttachmentTransferJobs.outboundDeliveryId, delivery.id),
    )).for("update");
    const validated = validateSlackAttachmentFallbackPlan({ deliveryId: delivery.id,
      revision: delivery.attachmentFallbackPlanRevision, renderSnapshotDigest: delivery.renderSnapshotDigest,
      snapshot: input.snapshot, plan, jobs });
    const completedAt = input.now();
    if (!validated || !(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())
      || completedAt < checkedAt || delivery.leaseExpiresAt <= completedAt) return { kind: "unavailable" as const };
    return { kind: "planned" as const, revision: delivery.attachmentFallbackPlanRevision,
      transport: validated.transport,
      includedAttachmentIds: validated.items.filter(item => item.decision === "include").map(item => item.sourceAttachmentId),
      omittedAttachmentIds: validated.items.filter(item => item.decision === "omit").map(item => item.sourceAttachmentId) };
  });
}
