import { createHash } from "node:crypto";
import { slackFallbackWaitElapsed } from "./slackFallbackPolicy";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalActorProjections, externalAttachmentAssets, externalAttachmentMessageFacts, externalInboundEvents,
  slackVerifiedIngressEvents, slackVerifiedIngressFileFacts, slackVerifiedIngressPartitions } from "../db/schema";

export type VerifiedSlackFileProof = { leaseOwner: string; leaseGeneration: number; at: Date; sourcePlaintext: string };

/** Prove the selected file and author are in the leased normalized payload that
 * came from the exact retained, signature-verified raw event. */
export async function verifySlackInboundFile(executor: DatabaseExecutor, input: {
  eventId: string; projectionId: string; providerFileId: string; orderedPosition: number; proof: VerifiedSlackFileProof;
}): Promise<{ rawEventId: string; digest: string } | null> {
  const { proof } = input;
  if (!Number.isFinite(proof.at.getTime()) || !proof.leaseOwner.trim() || !Number.isSafeInteger(proof.leaseGeneration)
    || proof.leaseGeneration <= 0 || !Number.isSafeInteger(input.orderedPosition) || input.orderedPosition < 0) return null;
  const [row] = await executor.select({ event: externalInboundEvents, actor: externalActorProjections, raw: slackVerifiedIngressEvents })
    .from(externalInboundEvents).innerJoin(externalActorProjections, eq(externalActorProjections.id, input.projectionId))
    .innerJoin(slackVerifiedIngressEvents, eq(slackVerifiedIngressEvents.materializedInboundEventId, externalInboundEvents.id))
    .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
    .where(and(eq(externalInboundEvents.id, input.eventId), eq(externalInboundEvents.provider, "slack"),
      eq(externalInboundEvents.status, "processing"), eq(externalInboundEvents.leaseOwner, proof.leaseOwner),
      eq(externalInboundEvents.leaseGeneration, proof.leaseGeneration), gt(externalInboundEvents.leaseExpiresAt, proof.at),
      eq(externalActorProjections.provider, "slack"), inArray(externalActorProjections.actorKind, ["human", "guest", "remote", "unknown"]),
      eq(externalActorProjections.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(externalActorProjections.installId, externalInboundEvents.installId), eq(externalActorProjections.workspaceId, externalInboundEvents.workspaceId),
      eq(slackVerifiedIngressEvents.state, "materialized"),
      eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"),
      eq(slackVerifiedIngressEvents.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(slackVerifiedIngressEvents.providerEventId, externalInboundEvents.providerEventId),
      eq(slackVerifiedIngressPartitions.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(slackVerifiedIngressPartitions.environment, externalInboundEvents.environment),
      eq(slackVerifiedIngressPartitions.providerAuthorityId, externalInboundEvents.providerAuthorityId),
      eq(slackVerifiedIngressPartitions.providerConversationId, externalInboundEvents.providerConversationId),
      eq(slackVerifiedIngressPartitions.partitionKind, "conversation"))).limit(1);
  if (!row || createHash("sha256").update(proof.sourcePlaintext).digest("hex") !== row.event.normalizedPayloadDigest) return null;
  try {
    const parsed: unknown = JSON.parse(proof.sourcePlaintext);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Record<string, unknown>;
    if (payload.schema !== "external-inbound-normalized-event.v3" || payload.projectionId !== row.actor.id
      || payload.externalActorId !== row.actor.externalActorId || !Array.isArray(payload.providerFileIds)
      || payload.providerFileIds[input.orderedPosition] !== input.providerFileId) return null;
    if (row.actor.actorKind !== "human" && !(payload.fallbackAuthor === "anonymous"
      && row.actor.identityKind === "anonymous" && row.actor.externalActorId === ""
      || payload.fallbackAuthor === "unresolved" && row.actor.identityKind === "provider_actor"
      && await slackFallbackWaitElapsed(executor, { projectionId: row.actor.id, registrationId: row.event.appRegistrationId,
        installId: row.event.installId, workspaceId: row.event.workspaceId, externalActorId: row.actor.externalActorId },
        row.event.receivedAt, proof.at))) return null;
    return { rawEventId: row.raw.id, digest: row.event.normalizedPayloadDigest };
  } catch { return null; }
}

/** Later file work can use only an exact occurrence proof minted above; old
 * facts without one remain subject to the existing active-author rule. */
export async function hasVerifiedSlackFileFact(executor: DatabaseExecutor, input: {
  factId: string; eventId: string; projectionId: string; providerFileId: string;
}): Promise<boolean> {
  const [row] = await executor.select({ id: slackVerifiedIngressFileFacts.factId })
    .from(slackVerifiedIngressFileFacts)
    .innerJoin(externalAttachmentMessageFacts, eq(externalAttachmentMessageFacts.id, slackVerifiedIngressFileFacts.factId))
    .innerJoin(externalAttachmentAssets, eq(externalAttachmentAssets.id, externalAttachmentMessageFacts.assetId))
    .innerJoin(externalInboundEvents, eq(externalInboundEvents.id, externalAttachmentMessageFacts.inboundEventId))
    .innerJoin(externalActorProjections, eq(externalActorProjections.id, externalAttachmentMessageFacts.sourceActorProjectionId))
    .innerJoin(slackVerifiedIngressEvents, eq(slackVerifiedIngressEvents.id, slackVerifiedIngressFileFacts.rawEventId))
    .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
    .where(and(eq(slackVerifiedIngressFileFacts.factId, input.factId), eq(externalInboundEvents.id, input.eventId),
      eq(externalAttachmentMessageFacts.direction, "provider_inbound"), eq(externalActorProjections.id, input.projectionId),
      eq(externalActorProjections.provider, "slack"), inArray(externalActorProjections.actorKind, ["human", "guest", "remote", "unknown"]),
      eq(externalAttachmentAssets.provider, "slack"), eq(externalAttachmentAssets.originDirection, "provider_inbound"),
      eq(externalAttachmentAssets.providerFileId, input.providerFileId),
      eq(externalInboundEvents.provider, "slack"), inArray(externalInboundEvents.status, ["queued", "processing"]),
      eq(slackVerifiedIngressEvents.state, "materialized"), eq(slackVerifiedIngressEvents.materializedInboundEventId, externalInboundEvents.id),
      eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"),
      eq(slackVerifiedIngressFileFacts.normalizedPayloadDigest, externalInboundEvents.normalizedPayloadDigest),
      eq(externalAttachmentMessageFacts.bindingId, externalInboundEvents.bindingId),
      eq(externalAttachmentMessageFacts.bindingEpoch, externalInboundEvents.bindingEpoch),
      eq(externalAttachmentMessageFacts.connectionEpoch, externalInboundEvents.connectionEpoch),
      eq(externalAttachmentAssets.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(externalAttachmentAssets.installId, externalInboundEvents.installId), eq(externalAttachmentAssets.workspaceId, externalInboundEvents.workspaceId),
      eq(externalAttachmentAssets.providerAuthorityId, externalInboundEvents.providerAuthorityId),
      eq(externalActorProjections.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(externalActorProjections.installId, externalInboundEvents.installId), eq(externalActorProjections.workspaceId, externalInboundEvents.workspaceId),
      eq(slackVerifiedIngressEvents.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(slackVerifiedIngressEvents.providerEventId, externalInboundEvents.providerEventId),
      eq(slackVerifiedIngressPartitions.environment, externalInboundEvents.environment),
      eq(slackVerifiedIngressPartitions.appRegistrationId, externalInboundEvents.appRegistrationId),
      eq(slackVerifiedIngressPartitions.partitionKind, "conversation"),
      eq(slackVerifiedIngressPartitions.providerAuthorityId, externalInboundEvents.providerAuthorityId),
      eq(slackVerifiedIngressPartitions.providerConversationId, externalInboundEvents.providerConversationId))).limit(1);
  return Boolean(row);
}
