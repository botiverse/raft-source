import { createHash } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";

import type { Database, DatabaseExecutor } from "../db/index.js";
import {
  channels,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalInboundEvents,
  externalMessageLinks,
  jointChannels,
  jointChannelServers,
  messages,
} from "../db/schema.js";
import { insertCanonicalExternalMessage } from "./externalProjectionService.js";
import { resolveExternalConversationTarget } from "./externalConversationTargetService.js";
import { recordInboxFactsForPersistedMessages } from "./messageService.js";
import type { JointThreadProjection } from "./channelService.js";
import {
  createInboundExternalAttachmentTransferWithExecutor,
} from "./externalAttachmentTransferService.js";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";
import { applyExternalReactionObservation } from "./externalReactionSyncService.js";

const INBOUND_LEASE_MS = 60_000;
const INBOUND_BLOCKED_RETRY_MS = 30_000;
const INBOUND_PAYLOAD_SCHEMA_V1 = "external-inbound-normalized-event.v1" as const;
const INBOUND_PAYLOAD_SCHEMA_V2 = "external-inbound-normalized-event.v2" as const;
const INBOUND_REACTION_PAYLOAD_SCHEMA = "external-inbound-normalized-reaction.v1" as const;
const ATTACHMENT_UNAVAILABLE_MARKER = "[One or more attachments unavailable]";

type InboundEvent = typeof externalInboundEvents.$inferSelect;

class ExternalInboundTargetUnavailableError extends Error {}

type LockedJointParentProjection = {
  serverId: string;
  localChannelId: string;
  role: "host" | "participant";
  status: "active" | "disconnected";
  joinedByUserId: string | null;
  channel: typeof channels.$inferSelect;
};

let inboundEventRowLockHookForTests: (() => Promise<void> | void) | null = null;
let inboundCanonicalCommitHookForTests: (() => Promise<void> | void) | null = null;

export function __setExternalInboundEventRowLockHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  inboundEventRowLockHookForTests = hook;
}

export function __setExternalInboundCanonicalCommitHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  inboundCanonicalCommitHookForTests = hook;
}

type ExternalInboundNormalizedMessageFields = {
  projectionId: string;
  actorProjectionRevision: number;
  externalActorId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  content: string;
  createdAt: string;
};

export type ExternalInboundNormalizedMessage = ExternalInboundNormalizedMessageFields & (
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V1 }
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V2; providerFileIds: string[] }
);

type ParsedExternalInboundNormalizedMessage = ExternalInboundNormalizedMessageFields & {
  schema: typeof INBOUND_PAYLOAD_SCHEMA_V1 | typeof INBOUND_PAYLOAD_SCHEMA_V2;
  providerFileIds: string[];
};

type ParsedExternalInboundNormalizedReaction = {
  schema: typeof INBOUND_REACTION_PAYLOAD_SCHEMA;
  operation: "add" | "remove";
  providerMessageId: string;
  externalActorId: string;
  providerReactionKey: string;
  eventOccurredAt: string;
  eventSequence: number;
  botUserId: string;
};

export type ExternalInboundRuntimeAuthority = {
  runtimeRevision: string;
  provider: string;
  environment: "test" | "production";
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  bindingId: string;
  bindingEpoch: number;
  connectionEpoch: number;
  raftChannelId: string;
  privacyClass: "public" | "private";
};

export interface ExternalInboundWorkerDependencies {
  decryptNormalizedPayload(input: {
    eventId: string;
    ciphertext: string;
    envelopeKeyId: string;
    aad: {
      purpose: "external-inbound-normalized-event";
      aadVersion: 1;
      schemaVersion: 1 | 2 | 3;
      provider: string;
      environment: "test" | "production";
      appRegistrationId: string;
      installId: string;
      workspaceId: string;
      providerAuthorityId: string;
      providerConversationId: string;
      providerEventId: string;
      bindingId: string;
      bindingEpoch: number;
      connectionEpoch: number;
      runtimeRevision: string;
      raftChannelId: string;
      privacyClass: "public" | "private";
    };
    signal?: AbortSignal;
  }): Promise<string>;
  resolveCurrentRuntime(input: {
    eventId: string;
    frozenAuthority: ExternalInboundRuntimeAuthority;
    requiredCapabilities?: readonly ("attachment_transfer" | "reaction_sync")[];
    signal?: AbortSignal;
  }): Promise<ExternalInboundRuntimeAuthority | null>;
  onMessageCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onMessageCommittedError?(error: unknown): void;
  onReactionCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onReactionCommittedError?(error: unknown): void;
  now?(): Date;
}

export type ExternalInboundWorkerResult =
  | { kind: "disabled" }
  | { kind: "empty" }
  | { kind: "blocked"; eventId: string; reason: string }
  | { kind: "committed" | "duplicate" | "echo"; eventId: string; messageId: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmpty(value: unknown, max = 320): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validClock(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function frozenAuthority(event: InboundEvent): ExternalInboundRuntimeAuthority {
  return {
    runtimeRevision: event.runtimeRevision,
    provider: event.provider,
    environment: event.environment,
    appRegistrationId: event.appRegistrationId,
    installId: event.installId,
    workspaceId: event.workspaceId,
    providerAuthorityId: event.providerAuthorityId,
    providerConversationId: event.providerConversationId,
    bindingId: event.bindingId,
    bindingEpoch: event.bindingEpoch,
    connectionEpoch: event.connectionEpoch,
    raftChannelId: event.raftChannelId,
    privacyClass: event.privacyClass,
  };
}

function sameAuthority(left: ExternalInboundRuntimeAuthority, right: ExternalInboundRuntimeAuthority): boolean {
  return (Object.keys(left) as (keyof ExternalInboundRuntimeAuthority)[])
    .every((key) => left[key] === right[key]);
}

function appendAttachmentUnavailableMarker(content: string): string {
  const suffix = `\n\n${ATTACHMENT_UNAVAILABLE_MARKER}`;
  const maximumContentBytes = 40_000 - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  let prefixBytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + characterBytes > maximumContentBytes) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}

function parseNormalizedMessage(
  plaintext: string,
  expectedDigest: string,
): ParsedExternalInboundNormalizedMessage | null {
  if (sha256(plaintext) !== expectedDigest) return null;
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  const commonKeys = [
    "actorProjectionRevision",
    "content",
    "createdAt",
    "externalActorId",
    "projectionId",
    "providerMessageId",
    "providerThreadId",
  ];
  const expectedKeys = message.schema === INBOUND_PAYLOAD_SCHEMA_V2
    ? [...commonKeys, "providerFileIds", "schema"].sort()
    : [...commonKeys, "schema"].sort();
  if (Object.keys(message).sort().join("\0") !== expectedKeys.join("\0")) return null;
  const providerFileIds = message.schema === INBOUND_PAYLOAD_SCHEMA_V2
    ? message.providerFileIds
    : [];
  if (
    (message.schema !== INBOUND_PAYLOAD_SCHEMA_V1 && message.schema !== INBOUND_PAYLOAD_SCHEMA_V2)
    || !nonEmpty(message.projectionId)
    || !positive(message.actorProjectionRevision)
    || !nonEmpty(message.externalActorId)
    || !nonEmpty(message.providerMessageId, 160)
    || !(message.providerThreadId === null || nonEmpty(message.providerThreadId, 160))
    || !nonEmpty(message.content, 40_000)
    || !nonEmpty(message.createdAt, 80)
    || !Number.isFinite(Date.parse(message.createdAt))
    || new Date(message.createdAt).toISOString() !== message.createdAt
    || !Array.isArray(providerFileIds)
    || providerFileIds.length > 10
    || providerFileIds.some((fileId) => !nonEmpty(fileId, 320))
    || new Set(providerFileIds).size !== providerFileIds.length
  ) return null;
  return { ...message, providerFileIds } as unknown as ParsedExternalInboundNormalizedMessage;
}

function parseNormalizedReaction(
  plaintext: string,
  expectedDigest: string,
): ParsedExternalInboundNormalizedReaction | null {
  if (sha256(plaintext) !== expectedDigest) return null;
  let value: unknown;
  try { value = JSON.parse(plaintext); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reaction = value as Record<string, unknown>;
  if (
    Object.keys(reaction).sort().join("\0") !== [
      "botUserId",
      "eventOccurredAt",
      "eventSequence",
      "externalActorId",
      "operation",
      "providerMessageId",
      "providerReactionKey",
      "schema",
    ].sort().join("\0")
    || reaction.schema !== INBOUND_REACTION_PAYLOAD_SCHEMA
    || (reaction.operation !== "add" && reaction.operation !== "remove")
    || !nonEmpty(reaction.providerMessageId, 160)
    || !nonEmpty(reaction.externalActorId, 160)
    || !nonEmpty(reaction.providerReactionKey, 160)
    || !nonEmpty(reaction.botUserId, 160)
    || !nonEmpty(reaction.eventOccurredAt, 80)
    || !positive(reaction.eventSequence)
    || !Number.isFinite(Date.parse(reaction.eventOccurredAt))
    || new Date(reaction.eventOccurredAt).toISOString() !== reaction.eventOccurredAt
  ) return null;
  return reaction as ParsedExternalInboundNormalizedReaction;
}

function terminalErase(event: InboundEvent, status: "committed" | "duplicate" | "echo", messageId: string, now: Date) {
  return {
    status,
    encryptedPayload: null,
    envelopeKeyId: null,
    payloadExpiresAt: null,
    payloadErasedAt: now,
    payloadTombstoneDigest: sha256(JSON.stringify([
      "external-inbound-payload-tombstone",
      "v1",
      event.id,
      event.normalizedPayloadDigest,
      status,
      messageId,
    ])),
    committedMessageId: messageId,
    outcomeReason: `provider_inbound_${status}`,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
}

function terminalEraseWithoutMessage(
  event: InboundEvent,
  status: "dead" | "quarantined" | "revoked",
  reason: string,
  now: Date,
) {
  return {
    status,
    encryptedPayload: null,
    envelopeKeyId: null,
    payloadExpiresAt: null,
    payloadErasedAt: now,
    payloadTombstoneDigest: sha256(JSON.stringify([
      "external-inbound-payload-tombstone",
      "v1",
      event.id,
      event.normalizedPayloadDigest,
      status,
      reason,
    ])),
    committedMessageId: null,
    outcomeReason: reason,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
}

async function releaseLease(
  db: Database,
  eventId: string,
  leaseOwner: string,
  leaseGeneration: number,
  reason: string,
  now: Date,
): Promise<void> {
  await db.update(externalInboundEvents).set({
    status: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    outcomeReason: reason,
    updatedAt: now,
  }).where(and(
    eq(externalInboundEvents.id, eventId),
    eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, leaseOwner),
    eq(externalInboundEvents.leaseGeneration, leaseGeneration),
  ));
}

async function terminalizeLeaseWithoutMessage(
  db: Database,
  event: InboundEvent,
  leaseOwner: string,
  leaseGeneration: number,
  status: "dead" | "quarantined" | "revoked",
  reason: string,
  now: Date,
): Promise<void> {
  await db.update(externalInboundEvents).set(terminalEraseWithoutMessage(event, status, reason, now)).where(and(
    eq(externalInboundEvents.id, event.id),
    eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, leaseOwner),
    eq(externalInboundEvents.leaseGeneration, leaseGeneration),
  ));
}

async function resolveTargetChannel(
  executor: DatabaseExecutor,
  event: InboundEvent,
  payload: ExternalInboundNormalizedMessage,
): Promise<{
  channel: typeof channels.$inferSelect;
  canonicalRootMessageId: string | null;
  jointThreadProjection: JointThreadProjection | null;
} | null> {
  const conversationTarget = await resolveExternalConversationTarget({
    executor,
    authorityChannelId: event.raftChannelId,
  });
  if (!conversationTarget) return null;
  const [authorityChannel] = await executor.select().from(channels)
    .where(eq(channels.id, conversationTarget.authorityChannelId)).for("update").limit(1);
  const [parentChannel] = await executor.select().from(channels)
    .where(eq(channels.id, conversationTarget.storageChannelId)).for("update").limit(1);
  if (
    !authorityChannel
    || !parentChannel
    || authorityChannel.deletedAt
    || authorityChannel.archivedAt
    || parentChannel.type === "thread"
    || parentChannel.deletedAt
    || parentChannel.archivedAt
    || (conversationTarget.kind === "joint" && (
      conversationTarget.role !== "host"
      || event.privacyClass !== "public"
      || authorityChannel.type !== "joint"
      || parentChannel.type !== "channel"
    ))
    || (conversationTarget.kind === "ordinary"
      && event.privacyClass === "public" && parentChannel.type !== "channel")
    || (conversationTarget.kind === "ordinary"
      && event.privacyClass === "private" && parentChannel.type !== "private")
  ) return null;
  if (!payload.providerThreadId) {
    return {
      channel: parentChannel,
      canonicalRootMessageId: null,
      jointThreadProjection: null,
    };
  }

  const [rootLink] = await executor.select().from(externalMessageLinks).where(and(
    eq(externalMessageLinks.provider, event.provider),
    eq(externalMessageLinks.installId, event.installId),
    eq(externalMessageLinks.providerAuthorityId, event.providerAuthorityId),
    eq(externalMessageLinks.providerConversationId, event.providerConversationId),
    eq(externalMessageLinks.providerMessageId, payload.providerThreadId),
    eq(externalMessageLinks.bindingId, event.bindingId),
    eq(externalMessageLinks.bindingEpoch, event.bindingEpoch),
    eq(externalMessageLinks.connectionEpoch, event.connectionEpoch),
    eq(externalMessageLinks.outcomeState, "accepted"),
    eq(externalMessageLinks.authorityState, "active"),
  )).for("update").limit(1);
  if (!rootLink) return null;
  const [rootMessage] = await executor.select().from(messages)
    .where(eq(messages.id, rootLink.raftMessageId)).for("update").limit(1);
  if (!rootMessage || rootMessage.channelId !== parentChannel.id) return null;

  let lockedJointParentProjections: LockedJointParentProjection[] | null = null;
  if (conversationTarget.kind === "joint") {
    const [parentJoint] = await executor.select().from(jointChannels).where(and(
      eq(jointChannels.id, conversationTarget.jointChannelId),
      eq(jointChannels.canonicalChannelId, parentChannel.id),
      eq(jointChannels.status, "active"),
    )).for("update").limit(1);
    if (!parentJoint) return null;

    const parentProjections = await executor.select({
      serverId: jointChannelServers.serverId,
      localChannelId: jointChannelServers.localChannelId,
      role: jointChannelServers.role,
      status: jointChannelServers.status,
      joinedByUserId: jointChannelServers.joinedByUserId,
      channel: channels,
    }).from(jointChannelServers)
      .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, parentJoint.id),
        eq(jointChannelServers.status, "active"),
      ))
      .orderBy(asc(jointChannelServers.serverId))
      .for("update");
    if (
      parentProjections.length === 0
      || parentProjections.some((projection) =>
        projection.status !== "active"
        || projection.channel.serverId !== projection.serverId
        || projection.channel.type !== "joint"
        || projection.channel.deletedAt
        || projection.channel.archivedAt
      )
      || !parentProjections.some((projection) =>
        projection.localChannelId === event.raftChannelId
        && projection.serverId === conversationTarget.serverId
        && projection.role === "host"
      )
    ) return null;
    lockedJointParentProjections = parentProjections;
  }

  let [threadChannel] = await executor.select().from(channels).where(and(
    eq(channels.type, "thread"),
    eq(channels.parentMessageId, rootMessage.id),
  )).for("update").limit(1);
  if (!threadChannel) {
    [threadChannel] = await executor.insert(channels).values({
      serverId: parentChannel.serverId,
      name: `thread-${rootMessage.id.slice(0, 8)}`,
      type: "thread",
      parentMessageId: rootMessage.id,
    }).onConflictDoNothing().returning();
    if (!threadChannel) {
      [threadChannel] = await executor.select().from(channels).where(and(
        eq(channels.type, "thread"),
        eq(channels.parentMessageId, rootMessage.id),
      )).for("update").limit(1);
    }
  }
  if (!threadChannel || threadChannel.serverId !== parentChannel.serverId || threadChannel.deletedAt) {
    throw new ExternalInboundTargetUnavailableError();
  }
  if (rootMessage.threadId !== threadChannel.id) {
    await executor.update(messages).set({ threadId: threadChannel.id })
      .where(eq(messages.id, rootMessage.id));
  }

  if (conversationTarget.kind === "ordinary") {
    return {
      channel: threadChannel,
      canonicalRootMessageId: rootMessage.id,
      jointThreadProjection: null,
    };
  }

  // The accepted provider root serializes every reply racing to create the
  // same canonical thread. Under that lock, freeze the complete active Joint
  // parent projection set and materialize one local thread face per active
  // server before the reply itself is inserted.
  if (!lockedJointParentProjections) throw new ExternalInboundTargetUnavailableError();

  const existingJointThreads = await executor.select().from(jointChannels).where(and(
    eq(jointChannels.canonicalChannelId, threadChannel.id),
    eq(jointChannels.status, "active"),
  )).for("update").limit(2);
  if (existingJointThreads.length > 1) throw new ExternalInboundTargetUnavailableError();
  let [jointThread] = existingJointThreads;
  if (!jointThread) {
    [jointThread] = await executor.insert(jointChannels).values({
      canonicalChannelId: threadChannel.id,
      createdByServerId: conversationTarget.serverId,
      createdByUserId: null,
      status: "active",
    }).returning();
  }
  if (!jointThread || jointThread.canonicalChannelId !== threadChannel.id) {
    throw new ExternalInboundTargetUnavailableError();
  }

  let hostThreadProjection: JointThreadProjection | null = null;
  for (const parentProjection of lockedJointParentProjections) {
    let [threadProjection] = await executor.select().from(jointChannelServers).where(and(
      eq(jointChannelServers.jointChannelId, jointThread.id),
      eq(jointChannelServers.serverId, parentProjection.serverId),
    )).for("update").limit(1);
    let localThreadChannel: typeof channels.$inferSelect | undefined;
    if (threadProjection) {
      [localThreadChannel] = await executor.select().from(channels)
        .where(eq(channels.id, threadProjection.localChannelId)).for("update").limit(1);
    } else {
      [localThreadChannel] = await executor.insert(channels).values({
        serverId: parentProjection.serverId,
        name: `thread-${rootMessage.id.slice(0, 8)}`,
        type: "thread",
        parentMessageId: null,
      }).returning();
      [threadProjection] = await executor.insert(jointChannelServers).values({
        jointChannelId: jointThread.id,
        serverId: parentProjection.serverId,
        localChannelId: localThreadChannel.id,
        role: parentProjection.role,
        status: "active",
        joinedByUserId: parentProjection.joinedByUserId,
      }).returning();
    }
    if (
      !threadProjection
      || !localThreadChannel
      || threadProjection.status !== "active"
      || threadProjection.role !== parentProjection.role
      || threadProjection.localChannelId !== localThreadChannel.id
      || localThreadChannel.serverId !== parentProjection.serverId
      || localThreadChannel.type !== "thread"
      || localThreadChannel.parentMessageId !== null
      || localThreadChannel.deletedAt
      || localThreadChannel.archivedAt
    ) throw new ExternalInboundTargetUnavailableError();

    if (parentProjection.localChannelId === event.raftChannelId) {
      hostThreadProjection = {
        jointThreadId: jointThread.id,
        localThreadChannelId: localThreadChannel.id,
        canonicalThreadChannelId: threadChannel.id,
        localServerId: parentProjection.serverId,
        localParentChannelId: parentProjection.localChannelId,
        canonicalParentChannelId: parentChannel.id,
        canonicalParentMessageId: rootMessage.id,
        role: parentProjection.role,
        threadChannel: localThreadChannel,
      };
    }
  }
  if (!hostThreadProjection) throw new ExternalInboundTargetUnavailableError();
  return {
    channel: threadChannel,
    canonicalRootMessageId: rootMessage.id,
    jointThreadProjection: hostThreadProjection,
  };
}

export async function enqueueExternalInboundEvent(input: {
  db: Database;
  authority: ExternalInboundRuntimeAuthority;
  providerEventId: string;
  normalizedPayloadDigest: string;
  encryptedPayload: string;
  envelopeKeyId: string;
  payloadSchemaVersion?: 1 | 2;
  payloadExpiresAt: Date;
  receivedAt?: Date;
}): Promise<{ event: InboundEvent; duplicate: boolean }> {
  const now = input.receivedAt ?? currentDate();
  const payloadSchemaVersion = input.payloadSchemaVersion ?? 1;
  if (
    !validClock(now)
    || !validClock(input.payloadExpiresAt)
    || input.payloadExpiresAt.getTime() <= now.getTime()
    || !nonEmpty(input.providerEventId, 320)
    || !/^[0-9a-f]{64}$/.test(input.normalizedPayloadDigest)
    || !nonEmpty(input.encryptedPayload, 1_000_000)
    || !nonEmpty(input.envelopeKeyId, 320)
    || (payloadSchemaVersion !== 1 && payloadSchemaVersion !== 2)
  ) throw new Error("External inbound sealed event admission is invalid");
  const authority = input.authority;
  if (
    !nonEmpty(authority.runtimeRevision)
    || !nonEmpty(authority.provider, 80)
    || !nonEmpty(authority.appRegistrationId)
    || !nonEmpty(authority.installId, 160)
    || !nonEmpty(authority.workspaceId)
    || !nonEmpty(authority.providerAuthorityId, 160)
    || !nonEmpty(authority.providerConversationId, 160)
    || !nonEmpty(authority.bindingId, 160)
    || !nonEmpty(authority.raftChannelId)
    || !positive(authority.bindingEpoch)
    || !positive(authority.connectionEpoch)
    || (authority.environment !== "test" && authority.environment !== "production")
    || (authority.privacyClass !== "public" && authority.privacyClass !== "private")
  ) throw new Error("External inbound frozen authority is invalid");

  const [event] = await input.db.insert(externalInboundEvents).values({
    provider: authority.provider,
    environment: authority.environment,
    appRegistrationId: authority.appRegistrationId,
    installId: authority.installId,
    workspaceId: authority.workspaceId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    providerEventId: input.providerEventId,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
    connectionEpoch: authority.connectionEpoch,
    runtimeRevision: authority.runtimeRevision,
    raftChannelId: authority.raftChannelId,
    privacyClass: authority.privacyClass,
    normalizedPayloadDigest: input.normalizedPayloadDigest,
    encryptedPayload: input.encryptedPayload,
    envelopeKeyId: input.envelopeKeyId,
    payloadSchemaVersion,
    payloadExpiresAt: input.payloadExpiresAt,
    receivedAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [
      externalInboundEvents.provider,
      externalInboundEvents.appRegistrationId,
      externalInboundEvents.providerEventId,
    ],
  }).returning();
  if (event) return { event, duplicate: false };

  const [existing] = await input.db.select().from(externalInboundEvents).where(and(
    eq(externalInboundEvents.provider, authority.provider),
    eq(externalInboundEvents.appRegistrationId, authority.appRegistrationId),
    eq(externalInboundEvents.providerEventId, input.providerEventId),
  )).limit(1);
  if (!existing) throw new Error("External inbound provider event replay disappeared");
  if (
    existing.normalizedPayloadDigest !== input.normalizedPayloadDigest
    || existing.payloadSchemaVersion !== payloadSchemaVersion
    || !sameAuthority(frozenAuthority(existing), authority)
  ) throw new Error("External inbound provider event identity conflicts with frozen admission");
  return { event: existing, duplicate: true };
}

export async function processExternalInboundEventOnce(input: {
  db: Database;
  leaseOwner: string;
  dependencies?: ExternalInboundWorkerDependencies | null;
  signal?: AbortSignal;
}): Promise<ExternalInboundWorkerResult> {
  if (!input.dependencies) return { kind: "disabled" };
  if (!nonEmpty(input.leaseOwner, 160)) throw new Error("External inbound lease owner is invalid");
  const claimAt = input.dependencies.now?.() ?? currentDate();
  if (!validClock(claimAt)) throw new Error("External inbound clock is invalid");
  const blockedRetryThreshold = new Date(claimAt.getTime() - INBOUND_BLOCKED_RETRY_MS);

  const claim = await input.db.transaction(async (executor) => {
    const eligibleAt = sql<Date>`CASE
      WHEN ${externalInboundEvents.status} = 'processing' THEN ${externalInboundEvents.leaseExpiresAt}
      WHEN ${externalInboundEvents.outcomeReason} IS NULL THEN ${externalInboundEvents.receivedAt}
      ELSE ${externalInboundEvents.updatedAt} + (${INBOUND_BLOCKED_RETRY_MS} * interval '1 millisecond')
    END`;
    const [candidate] = await executor.select().from(externalInboundEvents).where(or(
      and(
        eq(externalInboundEvents.status, "queued"),
        or(
          isNull(externalInboundEvents.outcomeReason),
          lte(externalInboundEvents.updatedAt, blockedRetryThreshold),
        ),
      ),
      and(
        eq(externalInboundEvents.status, "processing"),
        lt(externalInboundEvents.leaseExpiresAt, claimAt),
      ),
    )).orderBy(asc(eligibleAt), asc(externalInboundEvents.receivedAt)).for("update").limit(1);
    if (!candidate) return null;
    const leaseGeneration = candidate.leaseGeneration + 1;
    const [claimed] = await executor.update(externalInboundEvents).set({
      status: "processing",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(claimAt.getTime() + INBOUND_LEASE_MS),
      leaseGeneration,
      outcomeReason: null,
      updatedAt: claimAt,
    }).where(eq(externalInboundEvents.id, candidate.id)).returning();
    return claimed;
  });
  if (!claim) return { kind: "empty" };
  const releaseClaim = async (reason: string): Promise<void> => {
    const releaseAt = input.dependencies?.now?.() ?? currentDate();
    if (!validClock(releaseAt)) throw new Error("External inbound release clock is invalid");
    await releaseLease(
      input.db,
      claim.id,
      input.leaseOwner,
      claim.leaseGeneration,
      reason,
      releaseAt,
    );
  };
  if (!claim.encryptedPayload || !claim.envelopeKeyId || !claim.payloadExpiresAt) {
    await releaseClaim("payload_custody_missing");
    return { kind: "blocked", eventId: claim.id, reason: "payload_custody_missing" };
  }
  if (claim.payloadExpiresAt.getTime() <= claimAt.getTime()) {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "dead",
      "payload_expired",
      claimAt,
    );
    return { kind: "blocked", eventId: claim.id, reason: "payload_expired" };
  }

  let plaintext: string;
  try {
    plaintext = await input.dependencies.decryptNormalizedPayload({
      eventId: claim.id,
      ciphertext: claim.encryptedPayload,
      envelopeKeyId: claim.envelopeKeyId,
      aad: {
        purpose: "external-inbound-normalized-event",
        aadVersion: 1,
        schemaVersion: claim.payloadSchemaVersion as 1 | 2 | 3,
        provider: claim.provider,
        environment: claim.environment,
        appRegistrationId: claim.appRegistrationId,
        installId: claim.installId,
        workspaceId: claim.workspaceId,
        providerAuthorityId: claim.providerAuthorityId,
        providerConversationId: claim.providerConversationId,
        providerEventId: claim.providerEventId,
        bindingId: claim.bindingId,
        bindingEpoch: claim.bindingEpoch,
        connectionEpoch: claim.connectionEpoch,
        runtimeRevision: claim.runtimeRevision,
        raftChannelId: claim.raftChannelId,
        privacyClass: claim.privacyClass,
      },
      signal: input.signal,
    });
  } catch {
    await releaseClaim("payload_decrypt_failed");
    return { kind: "blocked", eventId: claim.id, reason: "payload_decrypt_failed" };
  }
  const reactionPayload = claim.payloadSchemaVersion === 3
    ? parseNormalizedReaction(plaintext, claim.normalizedPayloadDigest)
    : null;
  const payload = claim.payloadSchemaVersion === 3
    ? null
    : parseNormalizedMessage(plaintext, claim.normalizedPayloadDigest);
  if (!payload && !reactionPayload) {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "quarantined",
      "payload_invalid",
      claimAt,
    );
    return { kind: "blocked", eventId: claim.id, reason: "payload_invalid" };
  }
  const frozen = frozenAuthority(claim);
  const runtime = await input.dependencies.resolveCurrentRuntime({
    eventId: claim.id,
    frozenAuthority: frozen,
    requiredCapabilities: reactionPayload
      ? ["reaction_sync"]
      : payload!.providerFileIds.length > 0
        ? ["attachment_transfer"]
        : [],
    signal: input.signal,
  }).catch(() => null);
  if (!runtime || !sameAuthority(runtime, frozen)) {
    await releaseClaim("runtime_authority_inactive_or_mismatched");
    return { kind: "blocked", eventId: claim.id, reason: "runtime_authority_inactive_or_mismatched" };
  }

  if (reactionPayload) {
    const reactionAt = input.dependencies.now?.() ?? currentDate();
    try {
      const applied = await input.db.transaction(async (tx) => {
        const [event] = await tx.select().from(externalInboundEvents).where(and(
          eq(externalInboundEvents.id, claim.id),
          eq(externalInboundEvents.status, "processing"),
          eq(externalInboundEvents.leaseOwner, input.leaseOwner),
          eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
        )).for("update").limit(1);
        if (!event || !event.leaseExpiresAt || event.leaseExpiresAt <= reactionAt) return null;
        const result = await applyExternalReactionObservation({
          tx,
          inboundEventId: event.id,
          providerEventId: event.providerEventId,
          operation: reactionPayload.operation,
          providerMessageId: reactionPayload.providerMessageId,
          externalActorId: reactionPayload.externalActorId,
          providerReactionKey: reactionPayload.providerReactionKey,
          eventOccurredAt: new Date(reactionPayload.eventOccurredAt),
          eventSequence: reactionPayload.eventSequence,
          botUserId: reactionPayload.botUserId,
          now: reactionAt,
        });
        if (result.outcome === "quarantined") {
          await tx.update(externalInboundEvents).set(terminalEraseWithoutMessage(
            event,
            "quarantined",
            "reaction_event_order_conflict",
            reactionAt,
          )).where(eq(externalInboundEvents.id, event.id));
          return { status: "quarantined" as const, messageId: result.raftMessageId, changed: false };
        }
        const status = result.outcome === "bot_echo" ? "echo" as const : "committed" as const;
        await tx.update(externalInboundEvents).set(terminalErase(event, status, result.raftMessageId, reactionAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { status, messageId: result.raftMessageId, changed: result.changed };
      });
      if (!applied) {
        await releaseClaim("reaction_commit_authority_lost");
        return { kind: "blocked", eventId: claim.id, reason: "reaction_commit_authority_lost" };
      }
      if (applied.status === "quarantined") {
        return { kind: "blocked", eventId: claim.id, reason: "reaction_event_order_conflict" };
      }
      if (applied.status === "committed" && applied.changed && input.dependencies.onReactionCommitted) {
        try {
          await input.dependencies.onReactionCommitted({
            eventId: claim.id,
            messageId: applied.messageId,
          });
        } catch (error) {
          // Reaction state is already durable. Realtime is an acceleration
          // path and must never replay the provider event on socket failure.
          try {
            input.dependencies.onReactionCommittedError?.(error);
          } catch {
            // Observability must not restore a retry after durable commit.
          }
        }
      }
      return { kind: applied.status, eventId: claim.id, messageId: applied.messageId };
    } catch {
      await releaseClaim("reaction_commit_blocked");
      return { kind: "blocked", eventId: claim.id, reason: "reaction_commit_blocked" };
    }
  }
  if (!payload) throw new Error("External inbound message payload routing invariant failed");

  if (payload.providerFileIds.length > 0) {
    let attachmentFacts;
    try {
      attachmentFacts = await input.db.transaction(async (executor) => {
        const [event] = await executor.select().from(externalInboundEvents).where(and(
          eq(externalInboundEvents.id, claim.id),
          eq(externalInboundEvents.status, "processing"),
          eq(externalInboundEvents.leaseOwner, input.leaseOwner),
          eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
        )).for("update").limit(1);
        if (!event) return null;
        for (const [orderedPosition, providerFileId] of payload.providerFileIds.entries()) {
          await createInboundExternalAttachmentTransferWithExecutor(executor, {
            provider: event.provider,
            appRegistrationId: event.appRegistrationId,
            installId: event.installId,
            workspaceId: event.workspaceId,
            providerAuthorityId: event.providerAuthorityId,
            providerFileId,
            inboundEventId: event.id,
            connectionEpoch: event.connectionEpoch,
            bindingId: event.bindingId,
            bindingEpoch: event.bindingEpoch,
            orderedPosition,
            sourceActorProjectionId: payload.projectionId,
          }, claimAt);
        }
        return executor.select().from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, event.id))
          .orderBy(asc(externalAttachmentMessageFacts.orderedPosition))
          .for("update");
      });
    } catch {
      await releaseClaim("attachment_transfer_prepare_failed");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_prepare_failed" };
    }
    if (!attachmentFacts || attachmentFacts.length !== payload.providerFileIds.length) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "quarantined",
        "attachment_transfer_set_invalid",
        claimAt,
      );
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_set_invalid" };
    }
    if (attachmentFacts.some((fact) => fact.state === "pending")) {
      await releaseClaim("attachment_transfer_pending");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_pending" };
    }
    if (attachmentFacts.some((fact) => fact.state !== "stored" && fact.state !== "unavailable" && fact.state !== "revoked")) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "quarantined",
        "attachment_transfer_state_invalid",
        claimAt,
      );
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_state_invalid" };
    }
  }

  let commitAt = claimAt;
  let commitBlockReason = "commit_authority_lost_or_root_unavailable";
  let committed: ExternalInboundWorkerResult | null = null;
  try {
    committed = await input.db.transaction(async (executor): Promise<ExternalInboundWorkerResult | null> => {
      const [event] = await executor.select().from(externalInboundEvents).where(and(
        eq(externalInboundEvents.id, claim.id),
        eq(externalInboundEvents.status, "processing"),
        eq(externalInboundEvents.leaseOwner, input.leaseOwner),
        eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
      )).for("update").limit(1);
      if (!event) return null;
      if (inboundEventRowLockHookForTests) await inboundEventRowLockHookForTests();
      const freshCommitAt = input.dependencies?.now?.() ?? currentDate();
      if (!validClock(freshCommitAt)) {
        commitBlockReason = "invalid_commit_clock";
        return null;
      }
      commitAt = freshCommitAt;
      if (!event.leaseExpiresAt || event.leaseExpiresAt.getTime() <= commitAt.getTime()) {
        commitBlockReason = "lease_expired_before_canonical_commit";
        return null;
      }
      if (!event.payloadExpiresAt || event.payloadExpiresAt.getTime() <= commitAt.getTime()) {
        commitBlockReason = "payload_expired_before_canonical_commit";
        return null;
      }

      const [existingLink] = await executor.select().from(externalMessageLinks).where(and(
        eq(externalMessageLinks.provider, event.provider),
        eq(externalMessageLinks.installId, event.installId),
        eq(externalMessageLinks.providerAuthorityId, event.providerAuthorityId),
        eq(externalMessageLinks.providerConversationId, event.providerConversationId),
        eq(externalMessageLinks.providerMessageId, payload.providerMessageId),
      )).for("update").limit(1);
      if (existingLink) {
        if (
          existingLink.firstDirection === "provider_inbound"
          && existingLink.payloadFingerprint !== event.normalizedPayloadDigest
        ) {
          await executor.update(externalInboundEvents).set(terminalEraseWithoutMessage(
            event,
            "quarantined",
            "provider_message_payload_conflict",
            commitAt,
          )).where(eq(externalInboundEvents.id, event.id));
          return {
            kind: "blocked",
            eventId: event.id,
            reason: "provider_message_payload_conflict",
          };
        }
        const status = existingLink.firstDirection === "raft_outbound" ? "echo" : "duplicate";
        await executor.update(externalInboundEvents).set(terminalErase(event, status, existingLink.raftMessageId, commitAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { kind: status, eventId: event.id, messageId: existingLink.raftMessageId };
      }

      const target = await resolveTargetChannel(executor, event, payload);
      if (!target) return null;
      const attachmentFacts = payload.providerFileIds.length === 0
        ? []
        : await executor.select().from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, event.id))
          .orderBy(asc(externalAttachmentMessageFacts.orderedPosition))
          .for("update");
      if (
        attachmentFacts.length !== payload.providerFileIds.length
        || attachmentFacts.some((fact) => (
          fact.state !== "stored" && fact.state !== "unavailable" && fact.state !== "revoked"
        ))
      ) {
        commitBlockReason = "attachment_transfer_pending";
        return null;
      }
      const unavailableAttachment = attachmentFacts.some(
        (fact) => fact.state === "unavailable" || fact.state === "revoked",
      );
      const result = await insertCanonicalExternalMessage({
        executor,
        channelId: target.channel.id,
        content: unavailableAttachment
          ? appendAttachmentUnavailableMarker(payload.content)
          : payload.content,
        createdAt: new Date(payload.createdAt),
        projectionId: payload.projectionId,
        provider: event.provider,
        appRegistrationId: event.appRegistrationId,
        installId: event.installId,
        workspaceId: event.workspaceId,
        externalActorId: payload.externalActorId,
        externalConversationId: event.providerConversationId,
        externalMessageId: payload.providerMessageId,
        actorProjectionRevision: payload.actorProjectionRevision,
      });
      const [messageLink] = await executor.insert(externalMessageLinks).values({
        provider: event.provider,
        installId: event.installId,
        providerAuthorityId: event.providerAuthorityId,
        providerConversationId: event.providerConversationId,
        providerMessageId: payload.providerMessageId,
        providerThreadId: payload.providerThreadId,
        bindingId: event.bindingId,
        bindingEpoch: event.bindingEpoch,
        connectionEpoch: event.connectionEpoch,
        raftMessageId: result.message.id,
        raftCanonicalRootMessageId: target.canonicalRootMessageId,
        firstDirection: "provider_inbound",
        payloadFingerprint: event.normalizedPayloadDigest,
        outcomeState: "accepted",
        authorityState: "active",
        stateReason: "provider_inbound_committed",
        createdAt: commitAt,
        updatedAt: commitAt,
      }).returning();
      if (!messageLink) throw new Error("External attachment message link was not created");
      const storedFacts = attachmentFacts.filter((fact) => fact.state === "stored");
      if (storedFacts.length > 0) {
        const projectionIds = storedFacts.map((fact) => fact.attachmentProjectionId!);
        await linkAttachmentsToMessageWithExecutor(
          executor,
          projectionIds,
          result.message.id,
          payload.projectionId,
          "new",
          commitAt,
        );
        const assetIds = storedFacts.map((fact) => fact.assetId);
        await executor.update(externalAttachmentAssets).set({
          state: "linked",
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentAssets.id, assetIds));
        await executor.update(externalAttachmentMessageFacts).set({
          messageLinkId: messageLink.id,
          state: "linked",
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentMessageFacts.id, storedFacts.map((fact) => fact.id)));
      }
      const unavailableFacts = attachmentFacts.filter(
        (fact) => fact.state === "unavailable" || fact.state === "revoked",
      );
      if (unavailableFacts.length > 0) {
        await executor.update(externalAttachmentMessageFacts).set({
          messageLinkId: messageLink.id,
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentMessageFacts.id, unavailableFacts.map((fact) => fact.id)));
      }
      await recordInboxFactsForPersistedMessages([result.message], {
        executor,
        channel: target.channel,
        // resolveTargetChannel locks the permission-facing binding anchor,
        // canonical storage target, and every active Joint thread projection.
        allowExecutorThread: target.jointThreadProjection === null,
        jointThreadProjection: target.jointThreadProjection,
        inboxFactPolicy: {
          mode: "record",
          producer: "external_projection.inbound",
          reason: "provider inbound canonical message committed",
        },
      });
      if (inboundCanonicalCommitHookForTests) await inboundCanonicalCommitHookForTests();
      const status = result.kind === "duplicate" ? "duplicate" : "committed";
      await executor.update(externalInboundEvents).set(terminalErase(event, status, result.message.id, commitAt))
        .where(eq(externalInboundEvents.id, event.id));
      return { kind: status, eventId: event.id, messageId: result.message.id };
    });
  } catch (error) {
    if (error instanceof ExternalInboundTargetUnavailableError) {
      await releaseClaim(commitBlockReason);
      return { kind: "blocked", eventId: claim.id, reason: commitBlockReason };
    }
    const actorRevoked = error instanceof Error
      && error.message === "External projection actor authority is not current";
    if (actorRevoked) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "revoked",
        "external_actor_authority_revoked",
        commitAt,
      );
      return { kind: "blocked", eventId: claim.id, reason: "external_actor_authority_revoked" };
    }
    await releaseClaim("canonical_commit_failed");
    return { kind: "blocked", eventId: claim.id, reason: "canonical_commit_failed" };
  }

  if (committed) {
    if (committed.kind === "committed" && input.dependencies.onMessageCommitted) {
      try {
        await input.dependencies.onMessageCommitted({
          eventId: committed.eventId,
          messageId: committed.messageId,
        });
      } catch (error) {
        // Persistence and inbox facts are already committed. Realtime is an
        // acceleration path; a socket/read-model failure must not replay the
        // provider event or duplicate the canonical message.
        try {
          input.dependencies.onMessageCommittedError?.(error);
        } catch {
          // Observability must not turn a durable commit into a retry.
        }
      }
    }
    return committed;
  }
  if (commitBlockReason === "payload_expired_before_canonical_commit") {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "dead",
      commitBlockReason,
      commitAt,
    );
  } else {
    await releaseClaim(commitBlockReason);
  }
  return { kind: "blocked", eventId: claim.id, reason: commitBlockReason };
}

export function createExternalInboundWorkerRuntime(input: {
  db: Database;
  leaseOwner: string;
  dependencies?: ExternalInboundWorkerDependencies | null;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("External inbound worker interval must be positive");
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;
  let controller: AbortController | null = null;
  const tick = () => {
    if (running) return;
    controller = new AbortController();
    running = processExternalInboundEventOnce({
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
      if (timer || !input.dependencies) return;
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
