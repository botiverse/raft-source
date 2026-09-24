import { createHash } from "node:crypto";

import {
  resolveExternalMention,
  type ExternalAddressabilityContext,
  type ExternalAddressabilityProjection,
  type ExternalMentionResolution,
  type ExternalMessageAuthorProjection,
  type ResolvedExternalMentionFact,
} from "@botiverse/raft-shared";
import { and, eq, inArray } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAuthorPolicies,
  externalMentionFacts,
  externalMessageAuthorFacts,
  externalProjectionAvatarArtifacts,
  messages,
} from "../db/schema.js";

const MAX_EXTERNAL_MESSAGE_BYTES = 40_000;

export type CanonicalExternalMessageResult = {
  kind: "created" | "duplicate";
  message: typeof messages.$inferSelect;
  author: ExternalMessageAuthorProjection;
};

export type ExternalAuthorPolicyFact = {
  policyId: string;
  serverId: string;
  provider: string;
  appRegistrationId: string;
  installId: string;
  bindingId: string;
  bindingEpoch: number;
  authorType: "user" | "agent";
  authorId: string;
  displayName: string;
  consentRevision: number;
  avatar: null | {
    artifactId: string;
    publicUrl: string;
    sourceDigest: string;
    artifactRevision: number;
  };
  fallbackKind: "human" | "agent";
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
    externalActorId: row.externalActorId,
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
export async function insertCanonicalExternalMessage(input: {
  executor: DatabaseExecutor;
  channelId: string;
  content: string;
  createdAt: Date;
  projectionId: string;
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  externalActorId: string;
  externalConversationId: string;
  externalMessageId: string;
  actorProjectionRevision: number;
}): Promise<CanonicalExternalMessageResult> {
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
    externalActorId: nonEmpty(input.externalActorId, "actor ID"),
    externalConversationId: nonEmpty(input.externalConversationId, "conversation ID"),
    externalMessageId: nonEmpty(input.externalMessageId, "message ID"),
    actorProjectionRevision: positive(input.actorProjectionRevision, "actor revision"),
  };
  if (!normalized.content.trim() || normalized.content.includes("\0")) {
    throw new Error("External projection content is invalid");
  }
  if (Buffer.byteLength(normalized.content, "utf8") > MAX_EXTERNAL_MESSAGE_BYTES) {
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

  const [actor] = await input.executor
    .select({
      id: externalActorProjections.id,
      provider: externalActorProjections.provider,
      appRegistrationId: externalActorProjections.appRegistrationId,
      installId: externalActorProjections.installId,
      workspaceId: externalActorProjections.workspaceId,
      externalActorId: externalActorProjections.externalActorId,
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
      eq(externalActorProjections.projectionRevision, normalized.actorProjectionRevision),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
      eq(externalActorProjections.actorKind, "human"),
    ))
    .limit(1)
    .for("update");
  if (!actor) throw new Error("External projection actor authority is not current");

  const [avatar] = actor.avatarArtifactId
    ? await input.executor
      .select()
      .from(externalProjectionAvatarArtifacts)
      .where(and(
        eq(externalProjectionAvatarArtifacts.id, actor.avatarArtifactId),
        eq(externalProjectionAvatarArtifacts.ownerType, "external_projection"),
        eq(externalProjectionAvatarArtifacts.ownerId, actor.id),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      ))
      .limit(1)
      .for("update")
    : [];

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
      externalActorId: actor.externalActorId,
      externalConversationId: normalized.externalConversationId,
      externalMessageId: normalized.externalMessageId,
      displayName: actor.displayName,
      actorKind: actor.actorKind,
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
  return new Map(rows.map((row) => {
    const effectiveAvatarUrl = row.fact.avatarArtifactId
      && row.avatarArtifactId === row.fact.avatarArtifactId
      && row.avatarState === "active"
      && row.avatarPublicUrl === row.fact.avatarUrl
      && row.avatarSourceDigest === row.fact.avatarDigest
      ? row.avatarPublicUrl
      : null;
    return [row.fact.messageId, toAuthorProjection(row.fact, effectiveAvatarUrl)];
  }));
}

export async function resolveExternalAuthorPolicy(input: {
  executor?: DatabaseExecutor;
  serverId: string;
  provider: string;
  appRegistrationId: string;
  installId: string;
  bindingId: string;
  bindingEpoch: number;
  authorType: "user" | "agent";
  authorId: string;
}): Promise<ExternalAuthorPolicyFact | null> {
  const executor = input.executor ?? getDb();
  const [policy] = await executor
    .select()
    .from(externalAuthorPolicies)
    .where(and(
      eq(externalAuthorPolicies.serverId, input.serverId),
      eq(externalAuthorPolicies.provider, input.provider),
      eq(externalAuthorPolicies.appRegistrationId, input.appRegistrationId),
      eq(externalAuthorPolicies.installId, input.installId),
      eq(externalAuthorPolicies.bindingId, input.bindingId),
      eq(externalAuthorPolicies.bindingEpoch, input.bindingEpoch),
      eq(externalAuthorPolicies.authorType, input.authorType),
      eq(externalAuthorPolicies.authorId, input.authorId),
      eq(externalAuthorPolicies.state, "granted"),
    ))
    .limit(1)
    .for("update");
  if (!policy) return null;

  const [avatar] = policy.avatarArtifactId
    ? await executor
      .select()
      .from(externalProjectionAvatarArtifacts)
      .where(and(
        eq(externalProjectionAvatarArtifacts.id, policy.avatarArtifactId),
        eq(externalProjectionAvatarArtifacts.ownerType, policy.authorType),
        eq(externalProjectionAvatarArtifacts.ownerId, policy.authorId),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      ))
      .limit(1)
      .for("update")
    : [];
  if (policy.avatarArtifactId && !avatar) return null;

  return {
    policyId: policy.id,
    serverId: policy.serverId,
    provider: policy.provider,
    appRegistrationId: policy.appRegistrationId,
    installId: policy.installId,
    bindingId: policy.bindingId,
    bindingEpoch: policy.bindingEpoch,
    authorType: policy.authorType,
    authorId: policy.authorId,
    displayName: policy.displayName,
    consentRevision: policy.consentRevision,
    avatar: avatar
      ? {
          artifactId: avatar.id,
          publicUrl: avatar.publicUrl,
          sourceDigest: avatar.sourceDigest,
          artifactRevision: avatar.artifactRevision,
        }
      : null,
    fallbackKind: policy.fallbackKind,
  };
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
  const rows = await executor
    .select({ actor: externalActorProjections, addressability: externalAddressabilityProjections })
    .from(externalAddressabilityProjections)
    .innerJoin(
      externalActorProjections,
      eq(externalActorProjections.id, externalAddressabilityProjections.projectionId),
    )
    .where(and(
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
    ))
    .for("update");
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
  return resolveExternalMention({
    rawHandle: input.rawHandle,
    explicitProjectionId: input.explicitProjectionId,
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
    resolutionReason: input.fact.resolutionReason,
  });
}
