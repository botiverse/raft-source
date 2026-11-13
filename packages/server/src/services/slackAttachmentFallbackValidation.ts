import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalAttachmentTransferJobs, slackAttachmentFallbackPlans, SLACK_ATTACHMENT_FALLBACK_MARKER } from "../db/schema";
import type { ExternalOutboundAttachmentSelection } from "./externalAttachmentProviderAdapter";
import type { SlackAttachmentPlanItem } from "../db/schema";
import { digestSlackBridgeRenderSnapshot, type SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";

type PlanRow = typeof slackAttachmentFallbackPlans.$inferSelect;
type TransferJob = typeof externalAttachmentTransferJobs.$inferSelect;

/**
 * Validate a persisted decision before it is used for a send OR reconciliation.
 * Callers must fetch the delivery, plan, and jobs under the delivery/partition
 * lock and hold that lock through any state transition. In particular, a missing
 * or malformed pointed-to plan is an error, never an ordinary non-fallback send.
 * Do not re-probe storage here: after an attempt the original file set is the
 * only safe basis for finding the provider receipt, even if sources changed.
 */
export function validateSlackAttachmentFallbackPlan(input: {
  deliveryId: string;
  revision: number;
  renderSnapshotDigest: string;
  snapshot: SlackBridgeRenderSnapshot;
  plan: PlanRow | undefined;
  jobs: TransferJob[];
}): { transport: "text" | "files"; items: SlackAttachmentPlanItem[] } | null {
  const { snapshot, plan, jobs } = input;
  const files = snapshot.attachments;
  if (snapshot.bindingAuthority.provider !== "slack" || !Number.isSafeInteger(input.revision)
    || input.revision <= 0 || files.length < 1 || files.length > 10
    || new Set(files.map((file) => file.sourceAttachmentId)).size !== files.length
    || !plan || plan.deliveryId !== input.deliveryId || plan.revision !== input.revision
    || digestSlackBridgeRenderSnapshot(snapshot) !== input.renderSnapshotDigest
    || plan.snapshotDigest !== input.renderSnapshotDigest || plan.unavailableMarker !== SLACK_ATTACHMENT_FALLBACK_MARKER
    || !Array.isArray(plan.items)
    || plan.items.length !== files.length || jobs.length !== files.length) return null;

  const seenJobs = new Set<string>();
  const items: SlackAttachmentPlanItem[] = [];
  for (const [index, file] of files.entries()) {
    const item = plan.items[index];
    if (!item || typeof item !== "object" || item.sourceAttachmentId !== file.sourceAttachmentId
      || item.frozenObjectId !== file.objectId || typeof item.transferJobId !== "string"
      || seenJobs.has(item.transferJobId)
      || !((item.decision === "include" && item.evidence === null)
        || (item.decision === "omit" && (item.evidence === "object_deleted" || item.evidence === "storage_object_missing")))) return null;
    const job = jobs.find((candidate) => candidate.id === item.transferJobId);
    if (!job || job.direction !== "raft_outbound" || job.outboundDeliveryId !== input.deliveryId
      || job.sourceAttachmentId !== file.sourceAttachmentId || job.frozenObjectId !== file.objectId
      || job.frozenStorageKey !== file.storageKey || job.frozenOriginServerId !== file.originServerId
      || job.frozenFilename !== file.filename || job.frozenMimeType !== file.mimeType
      || job.frozenSizeBytes !== file.sizeBytes
      || (file.contentDigest !== null && job.frozenContentDigest !== file.contentDigest)) return null;
    seenJobs.add(item.transferJobId);
    items.push({ transferJobId: item.transferJobId, sourceAttachmentId: item.sourceAttachmentId,
      frozenObjectId: item.frozenObjectId, decision: item.decision, evidence: item.evidence });
  }
  if (!items.some((item) => item.decision === "omit")) return null;
  const transport = items.every((item) => item.decision === "omit") ? "text" : "files";
  return plan.transport === transport ? { transport, items } : null;
}


/** Caller already holds the delivery lock; read its exact pointed-to plan and original job set. */
export async function readSlackAttachmentSelection(tx: DatabaseExecutor, delivery: {
  id: string; attachmentFallbackPlanRevision: number | null; renderSnapshotDigest: string;
}, snapshot: SlackBridgeRenderSnapshot): Promise<(ExternalOutboundAttachmentSelection & { transport: "text" | "files" }) | undefined> {
  if (delivery.attachmentFallbackPlanRevision === null) return undefined;
  const [plan] = await tx.select().from(slackAttachmentFallbackPlans).where(and(
    eq(slackAttachmentFallbackPlans.deliveryId, delivery.id),
    eq(slackAttachmentFallbackPlans.revision, delivery.attachmentFallbackPlanRevision),
  )).limit(1);
  const jobs = await tx.select().from(externalAttachmentTransferJobs).where(and(
    eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
    eq(externalAttachmentTransferJobs.outboundDeliveryId, delivery.id),
  ));
  const valid = validateSlackAttachmentFallbackPlan({ deliveryId: delivery.id, revision: delivery.attachmentFallbackPlanRevision,
    renderSnapshotDigest: delivery.renderSnapshotDigest, snapshot, plan, jobs });
  if (!valid) throw new Error("attachment_fallback_plan_invalid");
  return { transport: valid.transport,
    includedAttachmentIds: valid.items.filter(item => item.decision === "include").map(item => item.sourceAttachmentId),
    omittedAttachmentIds: valid.items.filter(item => item.decision === "omit").map(item => item.sourceAttachmentId) };
}
