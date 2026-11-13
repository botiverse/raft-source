import { createHash } from "node:crypto";
import { slackFallbackWaitElapsed } from "./slackFallbackPolicy";
import { readSlackBotMentionAuthority } from "./slackBotMentionAuthority";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";

import {
  currentDate, isSlackBotFallbackLabel, resolveExternalMention,
  type ExternalAddressabilityContext,
  type ExternalAddressabilityProjection,
  type ExternalMentionResolution,
  type ExternalMessageAuthorProjection,
  type ResolvedExternalMentionFact,
} from "@botiverse/raft-shared";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { getDb, type Database, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalChannelBindings,
  externalMessageLinks,
  externalAttachmentMessageFacts,
  externalMentionFacts,
  externalMessageAuthorFacts,
  externalInboundEvents,
  externalProjectionAvatarArtifacts,
  messages,
  slackVerifiedIngressEvents,
  slackVerifiedIngressPartitions,
  slackIngressAuthorWakeSignals,
} from "../db/schema";

export const MAX_EXTERNAL_MESSAGE_BYTES = 40_000;
// Raft accepts 32,000 UTF-16 code units, which can require up to 96,000 UTF-8
// bytes. Slack's normalized input is bounded separately; permit multilingual
// content without changing the limit for other external providers.
export const MAX_SLACK_EXTERNAL_MESSAGE_BYTES = 128_000;

export type CanonicalExternalMessageResult = {
  kind: "created" | "duplicate";
  message: typeof messages.$inferSelect;
  author: ExternalMessageAuthorProjection;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`External projection ${label} is required`);
  return normalized;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`External projection ${label} must be a positive integer`);
  }
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`External projection ${label} is invalid`);
  return value;
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function toAuthorProjection(
  row: typeof externalMessageAuthorFacts.$inferSelect,
  effectiveAvatarUrl: string | null = row.avatarUrl,
): ExternalMessageAuthorProjection {
  return {
    projectionId: row.projectionId,
    provider: row.provider,
    appRegistrationId: row.appRegistrationId,
    installId: row.installId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    externalActorId: row.identityKind === "anonymous" ? row.anonymousDisplayId! : row.externalActorId,
    ...(row.identityKind === "anonymous" ? { identityKind: "anonymous" as const } : {}),
    ...(row.profileFallback ? { profileFallback: row.profileFallback } : {}),
    externalConversationId: row.externalConversationId,
    externalMessageId: row.externalMessageId,
    displayName: row.displayName,
    actorKind: row.actorKind,
    avatarUrl: effectiveAvatarUrl,
    avatarDigest: row.avatarDigest,
    actorProjectionRevision: row.actorProjectionRevision,
  };
}

function sameExternalMessage(
  message: typeof messages.$inferSelect,
  fact: typeof externalMessageAuthorFacts.$inferSelect,
  input: {
    channelId: string;
    projectionId: string;
    provider: string;
    appRegistrationId: string;
    installId: string;
    workspaceId: string;
    externalActorId: string;
    externalConversationId: string;
    externalMessageId: string;
    actorProjectionRevision: number;
    content: string;
  },
): boolean {
  return message.senderType === "external_projection"
    && message.senderId === input.projectionId
    && message.channelId === input.channelId
    && message.messageType === "chat"
    && message.content === input.content
    && fact.projectionId === input.projectionId
    && fact.provider === input.provider
    && fact.appRegistrationId === input.appRegistrationId
    && fact.installId === input.installId
    && fact.workspaceId === input.workspaceId
    && fact.externalActorId === input.externalActorId
    && fact.externalConversationId === input.externalConversationId
    && fact.externalMessageId === input.externalMessageId
    && fact.actorProjectionRevision === input.actorProjectionRevision
    && fact.contentDigest === contentDigest(input.content);
}

/**
 * Inserts one canonical external-origin message and immutable author fact on
 * the caller's executor. Task #7 supplies the enclosing event/message/link/
 * inbox transaction; this primitive never creates Raft principal authority.
 */
type CanonicalExternalMessageInput = {
  executor: DatabaseExecutor;
  channelId: string;
  content: string;
  createdAt: Date;
  projectionId: string;
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  workspaceName?: string | null;
  externalActorId: string;
  externalConversationId: string;
  externalMessageId: string;
  actorProjectionRevision: number;
  identityKind?: "provider_actor" | "anonymous";
};

export async function insertCanonicalExternalMessage(input: CanonicalExternalMessageInput): Promise<CanonicalExternalMessageResult> {
  return insertCanonicalExternalMessageWithProfile(input, false, false);
}

/** Only the inbound worker may degrade an unresolved Slack profile after its receipt wait. */
export async function insertSlackProvisionalProfileMessage(
  input: CanonicalExternalMessageInput,
  timing: { receivedAt: Date; now: Date },
): Promise<CanonicalExternalMessageResult> {
  const receivedAt = validDate(timing.receivedAt, "receivedAt");
  const now = validDate(timing.now, "now");
  if (input.provider !== "slack" || now.getTime() < receivedAt.getTime() + SLACK_PROFILE_WAIT_MS) {
    throw new Error("External projection provisional profile wait has not elapsed");
  }
  return insertCanonicalExternalMessageWithProfile(input, true, false);
}

/** A display-only fallback is valid only for a still-custodied verified Slack receipt. */
export async function insertSlackFallbackAuthorMessage(
  input: Omit<CanonicalExternalMessageInput, "executor"> & { executor: DatabaseTransaction },
  proof: { inboundEventId: string; leaseOwner: string; leaseGeneration: number; at: Date; sourcePlaintext: string;
    kind: "anonymous" | "unresolved" },
): Promise<CanonicalExternalMessageResult> {
  if (input.provider !== "slack" || !Number.isFinite(proof.at.getTime()) || !proof.leaseOwner.trim()
    || !Number.isSafeInteger(proof.leaseGeneration) || proof.leaseGeneration <= 0
    || (proof.kind === "anonymous" ? input.externalActorId !== "" : !input.externalActorId.trim())) {
    throw new Error("Invalid Slack fallback author");
  }
  const [source] = await input.executor.select({ digest: externalInboundEvents.normalizedPayloadDigest,
    receivedAt: externalInboundEvents.receivedAt, bindingId: externalInboundEvents.bindingId }).from(externalInboundEvents)
    .innerJoin(slackVerifiedIngressEvents, eq(slackVerifiedIngressEvents.materializedInboundEventId, externalInboundEvents.id))
    .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
    .where(and(eq(externalInboundEvents.id, proof.inboundEventId), eq(externalInboundEvents.status, "processing"),
      eq(externalInboundEvents.leaseOwner, proof.leaseOwner), eq(externalInboundEvents.leaseGeneration, proof.leaseGeneration),
      gt(externalInboundEvents.leaseExpiresAt, proof.at), eq(externalInboundEvents.provider, "slack"),
      eq(externalInboundEvents.appRegistrationId, input.appRegistrationId), eq(externalInboundEvents.installId, input.installId),
      eq(externalInboundEvents.workspaceId, input.workspaceId), eq(externalInboundEvents.providerConversationId, input.externalConversationId),
      eq(slackVerifiedIngressEvents.state, "materialized"), eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"),
      eq(slackVerifiedIngressEvents.providerEventId, externalInboundEvents.providerEventId),
      eq(slackVerifiedIngressPartitions.appRegistrationId, input.appRegistrationId),
      eq(slackVerifiedIngressPartitions.providerAuthorityId, input.workspaceId),
      eq(slackVerifiedIngressPartitions.providerConversationId, input.externalConversationId))).limit(1);
  if (!source || createHash("sha256").update(proof.sourcePlaintext).digest("hex") !== source.digest
    || (proof.kind === "unresolved" && !await slackFallbackWaitElapsed(input.executor, {
      projectionId: input.projectionId, registrationId: input.appRegistrationId, installId: input.installId,
      workspaceId: input.workspaceId, externalActorId: input.externalActorId,
    }, source.receivedAt, proof.at))) {
    throw new Error("Slack fallback author lacks verified custody");
  }
  const body = JSON.parse(proof.sourcePlaintext) as Record<string, unknown>;
  if (body.schema !== "external-inbound-normalized-event.v3" || body.fallbackAuthor !== proof.kind
    || body.projectionId !== input.projectionId || body.externalActorId !== input.externalActorId
    || body.providerMessageId !== input.externalMessageId || body.createdAt !== input.createdAt.toISOString()
    || typeof body.content !== "string" || (input.content !== body.content
      && input.content !== `${body.content}\n\n[One or more attachments unavailable]`)) {
    throw new Error("Slack fallback author payload identity mismatch");
  }
  const anonymousDisplayId = proof.kind === "anonymous" ? `slack-anonymous:${createHash("sha256")
    .update(JSON.stringify(["slack-anonymous-pair-v1", input.appRegistrationId, source.bindingId])).digest("hex")}` : undefined;
  const result = await insertCanonicalExternalMessageWithProfile({ ...input, identityKind: proof.kind === "anonymous" ? "anonymous" : "provider_actor" },
    true, false, proof.kind === "anonymous" ? "Slack" : `Slack user ${input.externalActorId}`, anonymousDisplayId,
    proof.kind === "unresolved" ? "unresolved" : undefined);
  if (proof.kind === "unresolved" && result.author.profileFallback === "unresolved") {
    // This outbox signal shares the canonical-message transaction. It does not
    // lock raw receipts (which would invert the raw worker's lock order).
    await input.executor.insert(slackIngressAuthorWakeSignals).values({ registrationId: input.appRegistrationId,
      bindingId: source.bindingId, installId: input.installId, workspaceId: input.workspaceId,
      actorId: input.externalActorId, signaledAt: proof.at, expiresAt: new Date(proof.at.getTime() + 24 * 60 * 60_000),
    }).onConflictDoUpdate({ target: [slackIngressAuthorWakeSignals.registrationId, slackIngressAuthorWakeSignals.bindingId,
      slackIngressAuthorWakeSignals.installId, slackIngressAuthorWakeSignals.workspaceId, slackIngressAuthorWakeSignals.actorId],
      set: { signaledAt: sql`greatest(${slackIngressAuthorWakeSignals.signaledAt}, excluded.signaled_at)`,
        expiresAt: sql`greatest(${slackIngressAuthorWakeSignals.expiresAt}, excluded.expires_at)` } });
  }
  return result;
}

/** Render a known former Slack Human only from its still-custodied verified receipt. */
export async function insertSlackHistoricalAuthorMessage(
  input: Omit<CanonicalExternalMessageInput, "executor"> & { executor: DatabaseTransaction },
  proof: { inboundEventId: string; leaseOwner: string; leaseGeneration: number; at: Date; sourcePlaintext: string },
): Promise<CanonicalExternalMessageResult> {
  if (input.provider !== "slack") throw new Error("Historical author requires Slack custody");
  if (!Number.isFinite(proof.at.getTime()) || !proof.leaseOwner.trim()
    || !Number.isSafeInteger(proof.leaseGeneration) || proof.leaseGeneration <= 0) {
    throw new Error("Historical author lacks verified Slack custody");
  }
  const [leased] = await input.executor.select({ id: externalInboundEvents.id }).from(externalInboundEvents).where(and(
    eq(externalInboundEvents.id, proof.inboundEventId), eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, proof.leaseOwner), eq(externalInboundEvents.leaseGeneration, proof.leaseGeneration),
    gt(externalInboundEvents.leaseExpiresAt, proof.at),
  )).limit(1).for("update");
  if (!leased) throw new Error("Historical author lacks verified Slack custody");
  // This is a nonlocking read: the normalized event is locked by the caller,
  // and the raw head cannot be completed until that event commits. Taking the
  // raw row lock here would invert the raw worker's partition -> raw -> event order.
  const [receipt] = await input.executor.select({ id: slackVerifiedIngressEvents.id,
    normalizedPayloadDigest: externalInboundEvents.normalizedPayloadDigest,
    bindingId: externalInboundEvents.bindingId, bindingEpoch: externalInboundEvents.bindingEpoch,
    connectionEpoch: externalInboundEvents.connectionEpoch })
    .from(slackVerifiedIngressEvents)
    .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
    .innerJoin(externalInboundEvents, eq(externalInboundEvents.id, slackVerifiedIngressEvents.materializedInboundEventId))
    .where(and(eq(externalInboundEvents.id, proof.inboundEventId), eq(externalInboundEvents.provider, "slack"),
      eq(externalInboundEvents.appRegistrationId, input.appRegistrationId), eq(externalInboundEvents.installId, input.installId),
      eq(externalInboundEvents.workspaceId, input.workspaceId), eq(externalInboundEvents.providerConversationId, input.externalConversationId),
      eq(externalInboundEvents.status, "processing"), eq(externalInboundEvents.leaseOwner, proof.leaseOwner),
      eq(externalInboundEvents.leaseGeneration, proof.leaseGeneration), gt(externalInboundEvents.leaseExpiresAt, proof.at),
      eq(slackVerifiedIngressEvents.state, "materialized"),
      eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"),
      eq(slackVerifiedIngressEvents.appRegistrationId, input.appRegistrationId),
      eq(slackVerifiedIngressEvents.providerEventId, externalInboundEvents.providerEventId),
      eq(slackVerifiedIngressPartitions.appRegistrationId, input.appRegistrationId),
      eq(slackVerifiedIngressPartitions.environment, externalInboundEvents.environment),
      eq(slackVerifiedIngressPartitions.providerAuthorityId, input.workspaceId),
      eq(slackVerifiedIngressPartitions.partitionKind, "conversation"),
      eq(slackVerifiedIngressPartitions.providerConversationId, input.externalConversationId)))
    .limit(1);
  if (!receipt || createHash("sha256").update(proof.sourcePlaintext).digest("hex") !== receipt.normalizedPayloadDigest) {
    throw new Error("Historical author lacks verified Slack custody");
  }
  let original: Record<string, unknown>;
  try { original = JSON.parse(proof.sourcePlaintext) as Record<string, unknown>; }
  catch { throw new Error("Historical author payload is invalid"); }
  if (!original || original.schema !== "external-inbound-normalized-event.v3"
    || original.projectionId !== input.projectionId || original.externalActorId !== input.externalActorId
    || original.providerMessageId !== input.externalMessageId || original.createdAt !== input.createdAt.toISOString()) {
    throw new Error("Historical author payload identity mismatch");
  }
  const attachmentMarker = "\n\n[One or more attachments unavailable]";
  let markedPrefix = "";
  if (typeof original.content === "string") {
    const maxBytes = MAX_SLACK_EXTERNAL_MESSAGE_BYTES - Buffer.byteLength(attachmentMarker, "utf8");
    let used = 0;
    for (const character of original.content) {
      const size = Buffer.byteLength(character, "utf8");
      if (used + size > maxBytes) break;
      markedPrefix += character; used += size;
    }
  }
  if (typeof original.content !== "string" || (input.content !== original.content
    && input.content !== markedPrefix + attachmentMarker)) {
    throw new Error("Historical author content mismatch");
  }
  if (input.content !== original.content) {
    const missing = await input.executor.select({ id: externalAttachmentMessageFacts.id })
      .from(externalAttachmentMessageFacts).where(and(
        eq(externalAttachmentMessageFacts.inboundEventId, proof.inboundEventId),
        inArray(externalAttachmentMessageFacts.state, ["unavailable", "revoked"]),
      )).limit(1);
    if (!missing.length) throw new Error("Historical author attachment marker lacks evidence");
  }
  const [actor] = await input.executor.select().from(externalActorProjections).where(and(
    eq(externalActorProjections.id, input.projectionId), eq(externalActorProjections.actorKind, "human"),
    eq(externalActorProjections.appRegistrationId, input.appRegistrationId),
    eq(externalActorProjections.installId, input.installId), eq(externalActorProjections.workspaceId, input.workspaceId),
    eq(externalActorProjections.externalActorId, input.externalActorId),
  )).limit(1).for("update");
  if (!actor) throw new Error("Historical author is unavailable");
  if (actor.state === "active" && !actor.deactivated) {
    const [address] = await input.executor.select({ state: externalAddressabilityProjections.state })
      .from(externalAddressabilityProjections).where(and(
        eq(externalAddressabilityProjections.projectionId, actor.id),
        eq(externalAddressabilityProjections.bindingId, receipt.bindingId),
        eq(externalAddressabilityProjections.bindingEpoch, receipt.bindingEpoch),
        eq(externalAddressabilityProjections.connectionEpoch, receipt.connectionEpoch),
        eq(externalAddressabilityProjections.conversationId, input.externalConversationId),
      )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1).for("share");
    if (address?.state !== "removed") throw new Error("Historical author is still channel-addressable");
  }
  return insertCanonicalExternalMessageWithProfile(input, false, true);
}

export const SLACK_PROFILE_WAIT_MS = 10 * 60_000;

async function insertCanonicalExternalMessageWithProfile(
  input: CanonicalExternalMessageInput,
  provisionalProfile: boolean,
  historicalProfile: boolean,
  fallbackDisplayName?: string,
  anonymousDisplayId?: string,
  profileFallback?: "unresolved",
): Promise<CanonicalExternalMessageResult> {
  const normalized = {
    ...input,
    channelId: nonEmpty(input.channelId, "channel ID"),
    content: input.content,
    createdAt: validDate(input.createdAt, "createdAt"),
    projectionId: nonEmpty(input.projectionId, "projection ID"),
    provider: nonEmpty(input.provider, "provider"),
    appRegistrationId: nonEmpty(input.appRegistrationId, "app registration ID"),
    installId: nonEmpty(input.installId, "install ID"),
    workspaceId: nonEmpty(input.workspaceId, "workspace ID"),
    workspaceName: input.workspaceName?.trim() || null,
    externalActorId: input.identityKind === "anonymous" && input.provider === "slack" && input.externalActorId === ""
      ? "" : nonEmpty(input.externalActorId, "actor ID"),
    externalConversationId: nonEmpty(input.externalConversationId, "conversation ID"),
    externalMessageId: nonEmpty(input.externalMessageId, "message ID"),
    actorProjectionRevision: positive(input.actorProjectionRevision, "actor revision"),
  };
  if (!normalized.content.trim() || normalized.content.includes("\0")) {
    throw new Error("External projection content is invalid");
  }
  if (Buffer.byteLength(normalized.content, "utf8") > (normalized.provider === "slack"
    ? MAX_SLACK_EXTERNAL_MESSAGE_BYTES : MAX_EXTERNAL_MESSAGE_BYTES)) {
    throw new Error("External projection content is too large");
  }

  const [existingFact] = await input.executor
    .select()
    .from(externalMessageAuthorFacts)
    .where(and(
      eq(externalMessageAuthorFacts.provider, normalized.provider),
      eq(externalMessageAuthorFacts.installId, normalized.installId),
      eq(externalMessageAuthorFacts.workspaceId, normalized.workspaceId),
      eq(externalMessageAuthorFacts.externalConversationId, normalized.externalConversationId),
      eq(externalMessageAuthorFacts.externalMessageId, normalized.externalMessageId),
    ))
    .limit(1);
  if (existingFact) {
    const [existingMessage] = await input.executor
      .select()
      .from(messages)
      .where(eq(messages.id, existingFact.messageId))
      .limit(1);
    if (!existingMessage || !sameExternalMessage(existingMessage, existingFact, normalized)) {
      throw new Error("External projection provider identity conflict");
    }
    const author = (await loadExternalMessageAuthors([existingFact.messageId], input.executor)).get(existingFact.messageId);
    if (!author) throw new Error("External projection immutable author fact is unavailable");
    return {
      kind: "duplicate",
      message: existingMessage,
      author,
    };
  }

  // Lock before the actor projection: install updates and verified ingress use
  // this order. This is a final guard if an own Slack bot receipt reached the
  // writer despite sender classification; do not create another local message.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const [slackInstall] = normalized.provider === "slack" && uuid.test(normalized.installId) && uuid.test(normalized.appRegistrationId)
    ? await input.executor.select({ providerBotId: externalAppInstalls.providerBotId }).from(externalAppInstalls)
      .where(and(eq(externalAppInstalls.id, normalized.installId), eq(externalAppInstalls.registrationId, normalized.appRegistrationId),
        eq(externalAppInstalls.providerAuthorityId, normalized.workspaceId))).limit(1).for("share")
    : [];
  const [actor] = await input.executor
    .select({
      id: externalActorProjections.id,
      provider: externalActorProjections.provider,
      appRegistrationId: externalActorProjections.appRegistrationId,
      installId: externalActorProjections.installId,
      workspaceId: externalActorProjections.workspaceId,
      externalActorId: externalActorProjections.externalActorId,
      identityKind: externalActorProjections.identityKind,
      displayName: externalActorProjections.displayName,
      actorKind: externalActorProjections.actorKind,
      state: externalActorProjections.state,
      deactivated: externalActorProjections.deactivated,
      projectionRevision: externalActorProjections.projectionRevision,
      avatarArtifactId: externalActorProjections.avatarArtifactId,
    })
    .from(externalActorProjections)
    .where(and(
      eq(externalActorProjections.id, normalized.projectionId),
      eq(externalActorProjections.provider, normalized.provider),
      eq(externalActorProjections.appRegistrationId, normalized.appRegistrationId),
      eq(externalActorProjections.installId, normalized.installId),
      eq(externalActorProjections.workspaceId, normalized.workspaceId),
      eq(externalActorProjections.externalActorId, normalized.externalActorId),
      eq(externalActorProjections.identityKind, input.identityKind ?? "provider_actor"),
      eq(externalActorProjections.projectionRevision, normalized.actorProjectionRevision),
      historicalProfile || fallbackDisplayName
        ? undefined // Historical custody and departure were verified above under row locks.
        : and(eq(externalActorProjections.state, "active"), eq(externalActorProjections.deactivated, false)),
      or(
        eq(externalActorProjections.actorKind, "human"),
        !historicalProfile ? and(eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.actorKind, "bot")) : undefined,
        provisionalProfile
          ? and(eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.actorKind, "unknown"))
          : undefined,
        fallbackDisplayName
          ? and(eq(externalActorProjections.provider, "slack"), inArray(externalActorProjections.actorKind, ["guest", "remote"]))
          : undefined,
      ),
    ))
    .limit(1)
    .for("update");
  if (!actor) throw new Error("External projection actor authority is not current");
  if (actor.provider === "slack" && actor.actorKind === "bot"
    && slackInstall?.providerBotId === actor.externalActorId) {
    throw new Error("External projection cannot write the current Slack bridge bot");
  }

  // Slack message-level names and icons are app-controlled and are not
  // authoritative identity. They must never replace the bot's formal profile.
  const displayName = fallbackDisplayName ?? actor.displayName;
  const avatarId = historicalProfile || fallbackDisplayName ? null : actor.avatarArtifactId;
  const [selectedAvatar] = avatarId
    ? await input.executor
      .select()
      .from(externalProjectionAvatarArtifacts)
      .where(and(
        eq(externalProjectionAvatarArtifacts.id, avatarId),
        eq(externalProjectionAvatarArtifacts.ownerType, "external_projection"),
        eq(externalProjectionAvatarArtifacts.ownerId, actor.id),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      ))
      .limit(1)
      .for("update")
    : [];
  const avatar = selectedAvatar;

  const [message] = await input.executor
    .insert(messages)
    .values({
      channelId: normalized.channelId,
      senderType: "external_projection",
      senderId: actor.id,
      messageType: "chat",
      content: normalized.content,
      searchText: normalized.content,
      createdAt: normalized.createdAt,
      updatedAt: normalized.createdAt,
    })
    .returning();
  if (!message) throw new Error("External projection canonical message insert failed");

  const [fact] = await input.executor
    .insert(externalMessageAuthorFacts)
    .values({
      messageId: message.id,
      projectionId: actor.id,
      provider: actor.provider,
      appRegistrationId: actor.appRegistrationId,
      installId: actor.installId,
      workspaceId: actor.workspaceId,
      workspaceName: normalized.workspaceName,
      externalActorId: actor.externalActorId,
      identityKind: actor.identityKind,
      anonymousDisplayId: actor.identityKind === "anonymous" ? anonymousDisplayId : null,
      profileFallback: profileFallback ?? null,
      externalConversationId: normalized.externalConversationId,
      externalMessageId: normalized.externalMessageId,
      displayName,
      actorKind: fallbackDisplayName ? "unknown" : actor.actorKind,
      avatarArtifactId: avatar?.id ?? null,
      avatarUrl: avatar?.publicUrl ?? null,
      avatarDigest: avatar?.sourceDigest ?? null,
      actorProjectionRevision: actor.projectionRevision,
      contentDigest: contentDigest(normalized.content),
      createdAt: normalized.createdAt,
    })
    .returning();
  if (!fact) throw new Error("External projection author fact insert failed");

  return { kind: "created", message, author: toAuthorProjection(fact) };
}

export async function createCanonicalExternalMessage(input: Omit<
  Parameters<typeof insertCanonicalExternalMessage>[0],
  "executor"
>): Promise<CanonicalExternalMessageResult> {
  return getDb().transaction((executor) => insertCanonicalExternalMessage({ ...input, executor }));
}

export async function loadExternalMessageAuthors(
  messageIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
  now: Date = currentDate(),
): Promise<Map<string, ExternalMessageAuthorProjection>> {
  if (messageIds.length === 0) return new Map();
  const rows = await executor
    .select({
      fact: externalMessageAuthorFacts,
      avatarArtifactId: externalProjectionAvatarArtifacts.id,
      avatarPublicUrl: externalProjectionAvatarArtifacts.publicUrl,
      avatarSourceDigest: externalProjectionAvatarArtifacts.sourceDigest,
      avatarState: externalProjectionAvatarArtifacts.state,
    })
    .from(externalMessageAuthorFacts)
    .leftJoin(
      externalProjectionAvatarArtifacts,
      eq(externalProjectionAvatarArtifacts.id, externalMessageAuthorFacts.avatarArtifactId),
    )
    .where(inArray(externalMessageAuthorFacts.messageId, [...messageIds]));
  const result = new Map(rows.map((row) => {
    const effectiveAvatarUrl = row.fact.avatarArtifactId
      && row.avatarArtifactId === row.fact.avatarArtifactId
      && row.avatarState === "active"
      && row.avatarPublicUrl === row.fact.avatarUrl
      && row.avatarSourceDigest === row.fact.avatarDigest
      ? row.avatarPublicUrl
      : null;
    return [row.fact.messageId, toAuthorProjection(row.fact, effectiveAvatarUrl)];
  }));
  const fallbackIds = rows.filter(({ fact }) => fact.provider === "slack" && fact.actorKind === "bot"
    && isSlackBotFallbackLabel(fact.displayName, fact.externalActorId)).map(({ fact }) => fact.messageId);
  if (!fallbackIds.length) return result;
  // Follow each message's original provider link back to its exact pair. An
  // actor can be shared by multiple pairs; another still-authorized pair must
  // not refresh the presentation in a channel whose pair was revoked.
  const profiles = await executor.select({ fact: externalMessageAuthorFacts, link: externalMessageLinks,
    binding: externalChannelBindings, actor: externalActorProjections,
    avatar: externalProjectionAvatarArtifacts }).from(externalMessageAuthorFacts)
    .innerJoin(externalMessageLinks, and(eq(externalMessageLinks.raftMessageId, externalMessageAuthorFacts.messageId),
      eq(externalMessageLinks.provider, externalMessageAuthorFacts.provider), eq(externalMessageLinks.installId, externalMessageAuthorFacts.installId),
      eq(externalMessageLinks.providerAuthorityId, externalMessageAuthorFacts.workspaceId),
      eq(externalMessageLinks.providerConversationId, externalMessageAuthorFacts.externalConversationId),
      eq(externalMessageLinks.providerMessageId, externalMessageAuthorFacts.externalMessageId),
      eq(externalMessageLinks.firstDirection, "provider_inbound")))
    .innerJoin(externalChannelBindings, sql`${externalChannelBindings.id} = CASE WHEN ${externalMessageLinks.bindingId}
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN ${externalMessageLinks.bindingId}::uuid ELSE NULL END`)
    .innerJoin(externalActorProjections, eq(externalActorProjections.id, externalMessageAuthorFacts.projectionId))
    .leftJoin(externalProjectionAvatarArtifacts, eq(externalProjectionAvatarArtifacts.id, externalActorProjections.avatarArtifactId))
    .where(inArray(externalMessageAuthorFacts.messageId, fallbackIds));
  const checked = new Map<string, boolean>();
  for (const { fact, link, binding, actor, avatar } of profiles) {
    if (actor.provider !== "slack" || actor.actorKind !== "bot" || actor.state !== "active" || actor.deactivated
      || actor.appRegistrationId !== fact.appRegistrationId || actor.installId !== fact.installId
      || actor.workspaceId !== fact.workspaceId || actor.externalActorId !== fact.externalActorId
      || binding.state !== "active" || binding.bindingEpoch !== link.bindingEpoch || binding.connectionEpoch !== link.connectionEpoch) continue;
    const key = `${binding.id}:${link.bindingEpoch}:${link.connectionEpoch}`;
    let active = checked.get(key);
    if (active === undefined) {
      try {
        const authority = await resolveExternalBindingAuthority({ serverId: binding.serverId, bindingId: binding.id,
          expectedConnectionEpoch: link.connectionEpoch, expectedBindingEpoch: link.bindingEpoch, now }, executor as Database);
        active = authority.active && authority.fact.installId === fact.installId && authority.fact.registrationId === fact.appRegistrationId
          && authority.fact.providerAuthorityId === fact.workspaceId && authority.fact.providerConversationId === fact.externalConversationId;
      } catch (error) {
        console.warn("[SlackBridge] bot profile authority lookup failed", { bindingId: binding.id,
          errorClass: error instanceof Error ? error.name : "unknown" });
        throw error; // A failed statement may have aborted the caller's transaction.
      }
      checked.set(key, active);
    }
    if (!active) continue;
    const author = result.get(fact.messageId);
    if (!author) continue;
    const formalName = actor.displayName !== fact.displayName ? actor.displayName : null;
    const formalAvatar = avatar && avatar.id === actor.avatarArtifactId && avatar.ownerType === "external_projection"
      && avatar.ownerId === actor.id && avatar.state === "active" ? avatar.publicUrl : null;
    if (formalName || formalAvatar) result.set(fact.messageId, { ...author,
      ...(formalName ? { profileDisplayName: formalName } : {}), ...(formalAvatar ? { profileAvatarUrl: formalAvatar } : {}) });
  }
  return result;
}

/** Take these locks before any Slack actor/addressability row in a transaction
 * which will resolve provider mentions, including edits of inbound messages. */
export async function lockSlackMentionAuthority(executor: DatabaseExecutor,
  scope: { provider: string; installId: string; bindingId: string }): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (scope.provider !== "slack" || !uuid.test(scope.installId)) return;
  await executor.select({ id: externalAppInstalls.id }).from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, scope.installId)).limit(1).for("share");
  if (uuid.test(scope.bindingId)) await executor.select({ id: externalChannelBindings.id }).from(externalChannelBindings)
    .where(and(eq(externalChannelBindings.id, scope.bindingId),
      eq(externalChannelBindings.installId, scope.installId))).limit(1).for("share");
}

export async function resolveExternalMentionFromDurableAuthority(input: {
  executor?: DatabaseExecutor;
  rawHandle: string;
  explicitProjectionId?: string | null;
  raftPrincipalCollision: boolean;
  context: ExternalAddressabilityContext;
  now: Date;
}): Promise<ExternalMentionResolution> {
  const executor = input.executor ?? getDb();
  // Audience refresh takes the binding before its member rows; do the same
  // for both inbound and outbound mention facts to avoid lock cycles.
  await lockSlackMentionAuthority(executor, input.context);
  // Lock one table at a time in deterministic order; joining under FOR UPDATE
  // would let the planner choose the actor/addressability lock order.
  const addresses = await executor.select().from(externalAddressabilityProjections).where(and(
    eq(externalAddressabilityProjections.provider, input.context.provider),
    eq(externalAddressabilityProjections.appRegistrationId, input.context.appRegistrationId),
    eq(externalAddressabilityProjections.installId, input.context.installId),
    eq(externalAddressabilityProjections.workspaceId, input.context.workspaceId),
    eq(externalAddressabilityProjections.connectionEpoch, input.context.connectionEpoch),
    eq(externalAddressabilityProjections.bindingId, input.context.bindingId),
    eq(externalAddressabilityProjections.bindingEpoch, input.context.bindingEpoch),
    eq(externalAddressabilityProjections.conversationId, input.context.conversationId),
    eq(externalAddressabilityProjections.memberRevision, input.context.memberRevision),
    eq(externalAddressabilityProjections.contextRevision, input.context.contextRevision),
  )).orderBy(asc(externalAddressabilityProjections.id)).for("update");
  const actorIds = [...new Set(addresses.map(address => address.projectionId))];
  const actors = actorIds.length ? await executor.select().from(externalActorProjections)
    .where(inArray(externalActorProjections.id, actorIds)).orderBy(asc(externalActorProjections.id)).for("share") : [];
  const actorsById = new Map(actors.map(actor => [actor.id, actor]));
  const rows = addresses.flatMap(addressability => {
    const actor = actorsById.get(addressability.projectionId);
    return actor ? [{ actor, addressability }] : [];
  });
  const candidates: ExternalAddressabilityProjection[] = rows.map(({ actor, addressability }) => ({
    actor: {
      projectionId: actor.id,
      provider: actor.provider,
      appRegistrationId: actor.appRegistrationId,
      installId: actor.installId,
      workspaceId: actor.workspaceId,
      externalActorId: actor.externalActorId,
      displayName: actor.displayName,
      handles: actor.handles,
      state: actor.state,
      actorKind: actor.actorKind,
      deactivated: actor.deactivated,
    },
    context: {
      provider: addressability.provider,
      appRegistrationId: addressability.appRegistrationId,
      installId: addressability.installId,
      workspaceId: addressability.workspaceId,
      connectionEpoch: addressability.connectionEpoch,
      bindingId: addressability.bindingId,
      bindingEpoch: addressability.bindingEpoch,
      conversationId: addressability.conversationId,
      memberRevision: addressability.memberRevision,
      contextRevision: addressability.contextRevision,
    },
    state: addressability.state,
    observedAt: addressability.observedAt.toISOString(),
    expiresAt: addressability.expiresAt.toISOString(),
  }));
  let explicitProjectionId = input.explicitProjectionId;
  // Channel membership is observed under the Slack U id, whereas the bot's
  // stable author projection is keyed by B id. Synthesize a candidate only
  // from a unique live bots.info mapping and that exact U membership.
  if (input.context.provider === "slack") {
    const remoteIds = rows.filter(row => row.actor.actorKind === "remote").map(row => row.actor.externalActorId);
    if (remoteIds.length) {
      const bots = await executor.select({ id: externalActorProjections.id }).from(externalActorProjections).where(and(
        eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, input.context.appRegistrationId),
        eq(externalActorProjections.installId, input.context.installId), eq(externalActorProjections.workspaceId, input.context.workspaceId),
        eq(externalActorProjections.actorKind, "bot"), inArray(externalActorProjections.slackBotUserId, remoteIds)));
      for (const bot of bots) {
        const mapping = await readSlackBotMentionAuthority({ executor, context: input.context, botProjectionId: bot.id, now: input.now });
        if (!mapping || mapping.addressability.memberRevision !== input.context.memberRevision
          || mapping.addressability.contextRevision !== input.context.contextRevision) continue;
        candidates.push({ actor: { projectionId: mapping.bot.id, provider: mapping.bot.provider,
          appRegistrationId: mapping.bot.appRegistrationId, installId: mapping.bot.installId, workspaceId: mapping.bot.workspaceId,
          externalActorId: mapping.bot.externalActorId, displayName: mapping.bot.displayName, handles: mapping.user.handles,
          state: mapping.bot.state, actorKind: "bot", deactivated: mapping.bot.deactivated,
          slackBotMappingRevision: mapping.mappingRevision }, context: input.context, state: mapping.addressability.state,
          observedAt: mapping.addressability.observedAt.toISOString(), expiresAt: mapping.addressability.expiresAt.toISOString() });
        if (explicitProjectionId === mapping.user.id) explicitProjectionId = mapping.bot.id;
      }
    }
  }
  return resolveExternalMention({
    rawHandle: input.rawHandle,
    explicitProjectionId,
    raftPrincipalCollision: input.raftPrincipalCollision,
    context: input.context,
    candidates,
    now: input.now,
  });
}

export async function insertExternalMentionFact(input: {
  executor: DatabaseExecutor;
  messageId: string;
  fact: ResolvedExternalMentionFact;
}): Promise<void> {
  await input.executor.insert(externalMentionFacts).values({
    messageId: input.messageId,
    projectionId: input.fact.projectionId,
    provider: input.fact.provider,
    appRegistrationId: input.fact.appRegistrationId,
    installId: input.fact.installId,
    workspaceId: input.fact.workspaceId,
    externalActorId: input.fact.externalActorId,
    connectionEpoch: input.fact.connectionEpoch,
    bindingId: input.fact.bindingId,
    bindingEpoch: input.fact.bindingEpoch,
    conversationId: input.fact.conversationId,
    memberRevision: input.fact.memberRevision,
    contextRevision: input.fact.contextRevision,
    freshnessObservedAt: new Date(input.fact.freshnessObservedAt),
    freshnessExpiresAt: new Date(input.fact.freshnessExpiresAt),
    handleAtSendTime: input.fact.handleAtSendTime,
    slackBotMappingRevision: input.fact.slackBotMappingRevision ?? null,
    resolutionReason: input.fact.resolutionReason,
  });
}
