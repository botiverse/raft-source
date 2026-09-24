import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  currentDate,
  SLACK_BRIDGE_DELIVERY_CONTRACT_VERSION,
} from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  channels,
  externalAuthorPolicies,
  externalDeliveryPartitions,
  externalMentionFacts,
  externalOutboundDeliveries,
  externalProjectionAvatarArtifacts,
  messages,
  servers,
} from "../db/schema.js";
import type { OrdinaryMessageExternalProjectionDecision } from "./ordinaryMessageExternalProjection.js";
import { resolveExternalConversationTarget } from "./externalConversationTargetService.js";
import { appendSlackBridgeAttachmentMarker } from "./slackBridgeAttachmentPolicy.js";
import { createOutboundExternalAttachmentTransferWithExecutor } from "./externalAttachmentTransferService.js";

export const SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA_V1 = "slack-bridge-render-snapshot.v1" as const;
export const SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA = "slack-bridge-render-snapshot.v2" as const;

export interface ProviderNeutralOutboundBindingAuthority {
  provider: string;
  environment: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
  memberRevision: number;
  contextRevision: number;
  consentRevision: number;
  privacyClass: "public" | "private";
  /** Raft parent channel bound to this provider conversation. */
  raftChannelId: string;
  providerAuthorityId: string;
  providerConversationId: string;
}

export interface ProviderNeutralOutboundRuntimeFact {
  level: "top_level" | "thread";
  /** Permission-facing local conversation used to authorize and link this send. */
  authorityConversationId: string;
  runtimePredicateRevision: string;
  attachmentTransferEnabled?: boolean;
  bindingAuthority: ProviderNeutralOutboundBindingAuthority;
}

export interface SlackBridgeFrozenAttachment {
  sourceAttachmentId: string;
  objectId: string;
  originServerId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentDigest: string;
  messagePosition: number;
}

export interface SlackBridgeFrozenExternalMention {
  projectionId: string;
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  externalActorId: string;
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
  conversationId: string;
  memberRevision: number;
  contextRevision: number;
  freshnessObservedAt: string;
  freshnessExpiresAt: string;
  handleSnapshot: string;
  resolutionReason: "explicit_projection" | "unique_dangling_handle";
}

export interface SlackBridgeFrozenAuthorPolicy {
  policyId: string;
  serverId: string;
  consentRevision: number;
  displayName: string;
  fallbackKind: "human" | "agent";
  avatar: null | {
    artifactId: string;
    publicUrl: string;
    sourceDigest: string;
    artifactRevision: number;
  };
}

export interface SlackBridgeRenderSnapshot {
  schema: typeof SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA | typeof SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA_V1;
  sourceMessageId: string;
  sourceMessageSeq: number;
  canonicalConversationId: string;
  level: "top_level" | "thread";
  canonicalRootMessageId: string | null;
  sourcePermalink: string;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  authorAvatarDigest: string | null;
  authorPolicy: SlackBridgeFrozenAuthorPolicy;
  sanitizedText: string;
  externalMentions: SlackBridgeFrozenExternalMention[];
  attachments: SlackBridgeFrozenAttachment[];
  bindingAuthority: ProviderNeutralOutboundBindingAuthority;
  enqueueRuntimeRevision: string;
}

export type SlackBridgeEnqueueResult = {
  replayed: boolean;
  delivery: typeof externalOutboundDeliveries.$inferSelect;
};

export type SlackBridgeOutboundAdmissionStage =
  | "conversation_lock"
  | "source_insert"
  | "source_replay_lookup"
  | "inbox_state_reset"
  | "attachment_link"
  | "inbox_facts"
  | "authorization_resolver"
  | "render_authority"
  | "partition_prepare"
  | "replay_lookup"
  | "marker_mint"
  | "partition_advance"
  | "delivery_insert";

export class SlackBridgeOutboundAdmissionError extends Error {
  constructor(
    readonly stage: SlackBridgeOutboundAdmissionStage,
    options: { cause: unknown },
  ) {
    super("Slack Bridge outbound admission failed", options);
    this.name = "SlackBridgeOutboundAdmissionError";
  }
}

export async function runSlackBridgeOutboundAdmissionStage<T>(
  stage: SlackBridgeOutboundAdmissionStage,
  work: () => Promise<T>,
  options?: { preserveError?: (error: unknown) => boolean },
): Promise<T> {
  if (!ordinaryAuthorizationResolver || !reconciliationMarkerMinter) return work();
  try {
    return await work();
  } catch (error) {
    if (error instanceof SlackBridgeOutboundAdmissionError || options?.preserveError?.(error)) throw error;
    throw new SlackBridgeOutboundAdmissionError(stage, { cause: error });
  }
}

export function projectSlackBridgeOutboundAdmissionFailure(
  error: unknown,
  nodeEnv: string | undefined,
): { code: "slack_bridge_outbound_admission_failed"; phase: SlackBridgeOutboundAdmissionStage } | null {
  if (nodeEnv === "production" || !(error instanceof SlackBridgeOutboundAdmissionError)) return null;
  return {
    code: "slack_bridge_outbound_admission_failed",
    phase: error.stage,
  };
}

export type SlackBridgeOutboundPipelineStage =
  | "channel_resolution"
  | "archive_gate"
  | "replay_facts_read"
  | "frontend_channel_read"
  | "frontend_projection_read"
  | "frontend_max_seq"
  | "frontend_payload_projection"
  | "frontend_socket_emit"
  | "frontend_emit";

export type SlackBridgeOutboundPipelineTopology =
  | "ordinary_channel"
  | "joint_channel"
  | "ordinary_thread"
  | "joint_thread"
  | "dm"
  | "missing";

export class SlackBridgeOutboundPipelineError extends Error {
  constructor(
    readonly stage: SlackBridgeOutboundPipelineStage,
    options: { cause: unknown; topology?: SlackBridgeOutboundPipelineTopology },
  ) {
    super("Slack Bridge outbound pipeline failed", options);
    this.name = "SlackBridgeOutboundPipelineError";
    this.topology = options.topology;
  }

  readonly topology?: SlackBridgeOutboundPipelineTopology;
}

export async function runSlackBridgeOutboundPipelineStage<T>(
  stage: SlackBridgeOutboundPipelineStage,
  work: () => T | Promise<T>,
  options?: {
    preserveError?: (error: unknown) => boolean;
    topology?: SlackBridgeOutboundPipelineTopology;
  },
): Promise<T> {
  if (!ordinaryAuthorizationResolver || !reconciliationMarkerMinter) return work();
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof SlackBridgeOutboundAdmissionError
      || error instanceof SlackBridgeOutboundPipelineError
      || options?.preserveError?.(error)
    ) throw error;
    throw new SlackBridgeOutboundPipelineError(stage, {
      cause: error,
      topology: options?.topology,
    });
  }
}

export function projectSlackBridgeOutboundPipelineFailure(
  error: unknown,
  nodeEnv: string | undefined,
): {
  code: "slack_bridge_outbound_pipeline_failed";
  phase: SlackBridgeOutboundPipelineStage;
  topology?: SlackBridgeOutboundPipelineTopology;
} | null {
  if (nodeEnv === "production" || !(error instanceof SlackBridgeOutboundPipelineError)) return null;
  return {
    code: "slack_bridge_outbound_pipeline_failed",
    phase: error.stage,
    ...(error.topology ? { topology: error.topology } : {}),
  };
}

export interface OrdinaryMessageOutboundAuthorization {
  activeRuntime: ProviderNeutralOutboundRuntimeFact;
  canonicalConversationId: string;
  canonicalRootMessageId?: string | null;
  sanitizedText: string;
}

export type OrdinaryMessageOutboundAuthorizationResolver = (input: {
  executor: DatabaseExecutor;
  message: typeof messages.$inferSelect;
  requestedChannelId: string;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  sourceText: string;
}) => Promise<OrdinaryMessageOutboundAuthorization | null>;

export type SlackBridgeReconciliationMarkerMinter = (input: {
  deliveryId: string;
}) => Promise<string> | string;

// Admission remains fail-closed until one process-owned runtime is installed.
// Managed and local server compositions install this seam only while their
// durable authority resolver and delivery worker lifecycle are active.
let ordinaryAuthorizationResolver: OrdinaryMessageOutboundAuthorizationResolver | null = null;
let reconciliationMarkerMinter: SlackBridgeReconciliationMarkerMinter | null = null;

export function __setOrdinaryMessageOutboundAuthorizationResolverForTests(
  resolver: OrdinaryMessageOutboundAuthorizationResolver,
): void {
  ordinaryAuthorizationResolver = resolver;
}

export function __setSlackBridgeReconciliationMarkerMinterForTests(
  minter: SlackBridgeReconciliationMarkerMinter,
): void {
  reconciliationMarkerMinter = minter;
}

export function __resetOrdinaryMessageOutboundAuthorizationResolverForTests(): void {
  ordinaryAuthorizationResolver = null;
  reconciliationMarkerMinter = null;
}

/**
 * Installs the single process-local outbound admission runtime. The caller
 * owns lifecycle and must release it during shutdown; a second runtime cannot
 * replace an active authority implicitly.
 */
export function installOrdinaryMessageOutboundRuntime(input: {
  authorizationResolver: OrdinaryMessageOutboundAuthorizationResolver;
  reconciliationMarkerMinter: SlackBridgeReconciliationMarkerMinter;
}): () => void {
  if (ordinaryAuthorizationResolver || reconciliationMarkerMinter) {
    throw new Error("Slack Bridge outbound runtime is already installed");
  }
  ordinaryAuthorizationResolver = input.authorizationResolver;
  reconciliationMarkerMinter = input.reconciliationMarkerMinter;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (ordinaryAuthorizationResolver === input.authorizationResolver) {
      ordinaryAuthorizationResolver = null;
    }
    if (reconciliationMarkerMinter === input.reconciliationMarkerMinter) {
      reconciliationMarkerMinter = null;
    }
  };
}

/**
 * Serialize eligible admission before messages.seq allocation. The inherited
 * authority row (the local parent for a Joint thread), requested projection,
 * and canonical storage row are locked in that order with duplicates skipped.
 * Holding the full chain through source insert, derived facts, and enqueue
 * prevents archive/conversion races and preserves FIFO allocation.
 */
export async function lockOrdinaryMessageExternalDeliveryAdmission(input: {
  executor: DatabaseExecutor;
  authorityChannelId: string;
  requestedChannelId: string;
  canonicalConversationId: string;
  decision: OrdinaryMessageExternalProjectionDecision;
}): Promise<void> {
  if (!input.decision.eligible || !ordinaryAuthorizationResolver) return;
  const lockedChannelIds = new Set<string>();
  for (const channelId of [
    input.authorityChannelId,
    input.requestedChannelId,
    input.canonicalConversationId,
  ]) {
    if (lockedChannelIds.has(channelId)) continue;
    lockedChannelIds.add(channelId);
    const [conversation] = await input.executor
      .select({
        id: channels.id,
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for("update")
      .limit(1);
    if (!conversation || conversation.archivedAt || conversation.deletedAt) {
      throw new Error("Slack Bridge outbound admission conversation is unavailable");
    }
  }
}

export async function maybeEnqueueOrdinaryMessageExternalDelivery(input: {
  executor: DatabaseExecutor;
  message: typeof messages.$inferSelect;
  requestedChannelId: string;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  sourceText: string;
  decision: OrdinaryMessageExternalProjectionDecision;
}): Promise<SlackBridgeEnqueueResult | null> {
  if (
    !input.decision.eligible
    || !ordinaryAuthorizationResolver
    || !reconciliationMarkerMinter
  ) return null;

  const authorization = await runSlackBridgeOutboundAdmissionStage(
    "authorization_resolver",
    () => ordinaryAuthorizationResolver!({
      executor: input.executor,
      message: input.message,
      requestedChannelId: input.requestedChannelId,
      senderType: input.senderType,
      senderId: input.senderId,
      authorName: input.authorName,
      sourceText: input.sourceText,
    }),
  );
  if (!authorization) return null;

  return enqueueSlackBridgeOutboundDelivery({
    executor: input.executor,
    message: input.message,
    activeRuntime: authorization.activeRuntime,
    canonicalConversationId: authorization.canonicalConversationId,
    canonicalRootMessageId: authorization.canonicalRootMessageId,
    senderType: input.senderType,
    senderId: input.senderId,
    authorName: input.authorName,
    sanitizedText: authorization.sanitizedText,
    mintReconciliationMarker: reconciliationMarkerMinter,
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function digestSlackBridgeRenderSnapshot(snapshot: SlackBridgeRenderSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)), "utf8")
    .digest("hex");
}

export function mintSlackBridgeReconciliationMarker(
  serviceKey: Uint8Array | string,
  deliveryId: string,
): string {
  assertNonEmpty(deliveryId, "logical delivery ID");
  if ((typeof serviceKey === "string" ? serviceKey.length : serviceKey.byteLength) === 0) {
    throw new Error("Slack Bridge reconciliation marker service key must be non-empty");
  }
  return createHmac("sha256", serviceKey)
    .update(JSON.stringify([
      "slack-bridge-reconciliation-marker",
      "v1",
      deliveryId,
    ]), "utf8")
    .digest("base64url");
}

function assertReconciliationMarker(marker: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(marker)) {
    throw new Error("Slack Bridge reconciliation marker must be canonical 32-byte base64url");
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Slack Bridge ${label} must be non-empty`);
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Slack Bridge ${label} must be a positive safe integer`);
  }
}

function validateBindingAuthority(authority: ProviderNeutralOutboundBindingAuthority): void {
  assertNonEmpty(authority.provider, "provider");
  assertNonEmpty(authority.environment, "provider environment");
  assertNonEmpty(authority.appRegistrationId, "app registration ID");
  assertNonEmpty(authority.installId, "install ID");
  assertNonEmpty(authority.workspaceId, "workspace ID");
  assertNonEmpty(authority.bindingId, "binding ID");
  assertNonEmpty(authority.raftChannelId, "Raft binding channel ID");
  assertNonEmpty(authority.providerAuthorityId, "provider authority ID");
  assertNonEmpty(authority.providerConversationId, "provider conversation ID");
  assertPositiveRevision(authority.connectionEpoch, "connection epoch");
  assertPositiveRevision(authority.bindingEpoch, "binding epoch");
  assertPositiveRevision(authority.memberRevision, "member revision");
  assertPositiveRevision(authority.contextRevision, "context revision");
  assertPositiveRevision(authority.consentRevision, "consent revision");
}

function validateFrozenMentions(
  mentions: readonly SlackBridgeFrozenExternalMention[],
  authority: ProviderNeutralOutboundBindingAuthority,
): void {
  for (const mention of mentions) {
    assertNonEmpty(mention.projectionId, "mention projection ID");
    assertNonEmpty(mention.provider, "mention provider");
    assertNonEmpty(mention.appRegistrationId, "mention app registration ID");
    assertNonEmpty(mention.installId, "mention install ID");
    assertNonEmpty(mention.workspaceId, "mention workspace ID");
    assertNonEmpty(mention.externalActorId, "mention external actor ID");
    assertNonEmpty(mention.bindingId, "mention binding ID");
    assertNonEmpty(mention.conversationId, "mention conversation ID");
    assertNonEmpty(mention.handleSnapshot, "mention handle snapshot");
    assertPositiveRevision(mention.connectionEpoch, "mention connection epoch");
    assertPositiveRevision(mention.bindingEpoch, "mention binding epoch");
    assertPositiveRevision(mention.memberRevision, "mention member revision");
    assertPositiveRevision(mention.contextRevision, "mention context revision");
    if (!Number.isFinite(Date.parse(mention.freshnessObservedAt))) {
      throw new Error("Slack Bridge mention observed time is invalid");
    }
    if (
      !Number.isFinite(Date.parse(mention.freshnessExpiresAt))
      || Date.parse(mention.freshnessExpiresAt) <= Date.parse(mention.freshnessObservedAt)
    ) throw new Error("Slack Bridge mention expiry is invalid");
    if (
      mention.provider !== authority.provider
      || mention.appRegistrationId !== authority.appRegistrationId
      || mention.installId !== authority.installId
      || mention.workspaceId !== authority.workspaceId
      || mention.connectionEpoch !== authority.connectionEpoch
      || mention.bindingId !== authority.bindingId
      || mention.bindingEpoch !== authority.bindingEpoch
      || mention.conversationId !== authority.providerConversationId
      || mention.memberRevision !== authority.memberRevision
      || mention.contextRevision !== authority.contextRevision
    ) throw new Error("Slack Bridge mention authority does not match the outbound binding");
  }
}

async function resolveFrozenRenderAuthority(input: {
  executor: DatabaseExecutor;
  message: typeof messages.$inferSelect;
  activeRuntime: ProviderNeutralOutboundRuntimeFact;
  canonicalConversationId: string;
  canonicalRootMessageId?: string | null;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  sanitizedText: string;
}): Promise<SlackBridgeRenderSnapshot> {
  const authority = input.activeRuntime.bindingAuthority;
  validateBindingAuthority(authority);
  assertNonEmpty(input.canonicalConversationId, "canonical conversation ID");
  assertNonEmpty(input.activeRuntime.authorityConversationId, "authority conversation ID");
  assertNonEmpty(input.senderId, "sender ID");
  assertNonEmpty(input.authorName, "author name");
  assertNonEmpty(input.activeRuntime.runtimePredicateRevision, "runtime predicate revision");

  if (input.message.id.trim().length === 0 || input.message.channelId !== input.canonicalConversationId) {
    throw new Error("Slack Bridge source message must match canonical conversation storage");
  }
  if (!Number.isSafeInteger(input.message.seq) || input.message.seq <= 0) {
    throw new Error("Slack Bridge source message sequence must be positive");
  }
  if (input.message.senderType !== input.senderType || input.message.senderId !== input.senderId) {
    throw new Error("Slack Bridge frozen sender must match the source message");
  }
  if (input.activeRuntime.level === "top_level" && input.canonicalRootMessageId != null) {
    throw new Error("Slack Bridge top-level delivery cannot carry a canonical root");
  }
  if (input.activeRuntime.level === "thread" && !input.canonicalRootMessageId) {
    throw new Error("Slack Bridge thread delivery requires a canonical root");
  }

  const [conversation] = await input.executor.select().from(channels)
    .where(eq(channels.id, input.canonicalConversationId)).limit(1);
  if (!conversation) throw new Error("Slack Bridge canonical conversation is unavailable");
  const conversationTarget = await resolveExternalConversationTarget({
    executor: input.executor,
    authorityChannelId: input.activeRuntime.authorityConversationId,
    expectedStorageChannelId: input.canonicalConversationId,
  });
  if (
    !conversationTarget
    || conversationTarget.level !== input.activeRuntime.level
    || conversationTarget.bindingChannelId !== authority.raftChannelId
    || (conversationTarget.kind === "joint" && conversationTarget.role !== "host")
    || conversationTarget.canonicalRootMessageId !== (input.canonicalRootMessageId ?? null)
  ) throw new Error("Slack Bridge conversation target does not match frozen binding authority");
  if (
    conversationTarget.kind === "ordinary"
    && conversation.serverId !== conversationTarget.serverId
  ) {
    throw new Error("Slack Bridge canonical conversation server does not match local authority");
  }
  const [server] = await input.executor.select({ id: servers.id, slug: servers.slug }).from(servers)
    .where(eq(servers.id, conversationTarget.serverId)).limit(1);
  if (!server) throw new Error("Slack Bridge canonical server is unavailable");

  let sourcePermalink: string;
  if (input.activeRuntime.level === "top_level") {
    if (conversation.type === "thread") {
      throw new Error("Slack Bridge top-level binding channel does not match source storage");
    }
    const [localConversation] = await input.executor.select().from(channels)
      .where(eq(channels.id, conversationTarget.authorityChannelId)).limit(1);
    if (
      !localConversation
      || localConversation.serverId !== server.id
      || localConversation.type === "thread"
    ) throw new Error("Slack Bridge top-level local projection is unavailable");
    const surface = localConversation.type === "dm" ? "dm" : "channel";
    sourcePermalink = `https://app.slock.ai/s/${encodeURIComponent(server.slug)}/${surface}/${localConversation.id}?msg=${input.message.id}`;
  } else {
    if (conversation.type !== "thread" || !conversation.parentMessageId) {
      throw new Error("Slack Bridge thread source must use a canonical thread channel");
    }
    const [root] = await input.executor.select().from(messages)
      .where(eq(messages.id, input.canonicalRootMessageId!)).limit(1);
    if (
      !root
      || root.id !== conversation.parentMessageId
      || root.threadId !== conversation.id
    ) throw new Error("Slack Bridge thread root relation is not canonical");
    const [parentChannel] = await input.executor.select().from(channels)
      .where(eq(channels.id, conversationTarget.bindingChannelId)).limit(1);
    if (!parentChannel || parentChannel.serverId !== server.id || parentChannel.type === "thread") {
      throw new Error("Slack Bridge thread parent channel is not canonical");
    }
    const surface = parentChannel.type === "dm" ? "dm" : "channel";
    const params = new URLSearchParams({
      thread: `${parentChannel.id}:${root.id}`,
      msg: input.message.id,
    });
    sourcePermalink = `https://app.slock.ai/s/${encodeURIComponent(server.slug)}/${surface}/${parentChannel.id}?${params.toString()}`;
  }

  const [policy] = await input.executor.select().from(externalAuthorPolicies).where(and(
    eq(externalAuthorPolicies.serverId, server.id),
    eq(externalAuthorPolicies.provider, authority.provider),
    eq(externalAuthorPolicies.appRegistrationId, authority.appRegistrationId),
    eq(externalAuthorPolicies.installId, authority.installId),
    eq(externalAuthorPolicies.bindingId, authority.bindingId),
    eq(externalAuthorPolicies.bindingEpoch, authority.bindingEpoch),
    eq(externalAuthorPolicies.authorType, input.senderType),
    eq(externalAuthorPolicies.authorId, input.senderId),
    eq(externalAuthorPolicies.consentRevision, authority.consentRevision),
    eq(externalAuthorPolicies.state, "granted"),
  )).for("update").limit(1);
  if (!policy || policy.displayName !== input.authorName) {
    throw new Error("Slack Bridge author consent or frozen display name is unavailable");
  }
  const [avatar] = policy.avatarArtifactId
    ? await input.executor.select().from(externalProjectionAvatarArtifacts).where(and(
        eq(externalProjectionAvatarArtifacts.id, policy.avatarArtifactId),
        eq(externalProjectionAvatarArtifacts.ownerType, input.senderType),
        eq(externalProjectionAvatarArtifacts.ownerId, input.senderId),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      )).for("update").limit(1)
    : [];
  if (policy.avatarArtifactId && !avatar) {
    throw new Error("Slack Bridge controlled author avatar is unavailable");
  }

  const mentionRows = await input.executor.select().from(externalMentionFacts)
    .where(eq(externalMentionFacts.messageId, input.message.id));
  const linkedAttachments = await input.executor.select({
    projection: attachments,
    object: attachmentObjects,
  }).from(attachments)
    .leftJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(eq(attachments.messageId, input.message.id))
    .orderBy(asc(attachments.messagePosition), asc(attachments.id));
  const externalMentions: SlackBridgeFrozenExternalMention[] = mentionRows.map((mention) => ({
    projectionId: mention.projectionId,
    provider: mention.provider,
    appRegistrationId: mention.appRegistrationId,
    installId: mention.installId,
    workspaceId: mention.workspaceId,
    externalActorId: mention.externalActorId,
    connectionEpoch: mention.connectionEpoch,
    bindingId: mention.bindingId,
    bindingEpoch: mention.bindingEpoch,
    conversationId: mention.conversationId,
    memberRevision: mention.memberRevision,
    contextRevision: mention.contextRevision,
    freshnessObservedAt: mention.freshnessObservedAt.toISOString(),
    freshnessExpiresAt: mention.freshnessExpiresAt.toISOString(),
    handleSnapshot: mention.handleAtSendTime,
    resolutionReason: mention.resolutionReason,
  }));
  validateFrozenMentions(externalMentions, authority);

  const attachmentTransferEnabled = input.activeRuntime.attachmentTransferEnabled === true;
  const frozenAttachments: SlackBridgeFrozenAttachment[] = attachmentTransferEnabled
    ? linkedAttachments.map(({ projection, object }, messagePosition) => {
        if (
          projection.revokedAt
          || !object
          || object.lifecycleState !== "active"
          || projection.messagePosition !== messagePosition
          || !object.contentHash
          || !/^[0-9a-f]{64}$/.test(object.contentHash)
        ) throw new Error("Slack Bridge attachment source is not immutable and ordered");
        return {
          sourceAttachmentId: projection.id,
          objectId: object.id,
          originServerId: object.originServerId,
          storageKey: object.storageKey,
          filename: projection.filename,
          mimeType: object.mimeType,
          sizeBytes: object.sizeBytes,
          contentDigest: object.contentHash,
          messagePosition,
        };
      })
    : [];

  const authorPolicy: SlackBridgeFrozenAuthorPolicy = {
    policyId: policy.id,
    serverId: policy.serverId,
    consentRevision: policy.consentRevision,
    displayName: policy.displayName,
    fallbackKind: policy.fallbackKind,
    avatar: avatar ? {
      artifactId: avatar.id,
      publicUrl: avatar.publicUrl,
      sourceDigest: avatar.sourceDigest,
      artifactRevision: avatar.artifactRevision,
    } : null,
  };
  const sanitizedText = linkedAttachments.length > 0 && !attachmentTransferEnabled
    ? appendSlackBridgeAttachmentMarker(input.sanitizedText)
    : input.sanitizedText;
  if (sanitizedText.length > 40_000) {
    throw new Error("Slack Bridge attachment marker exceeds the provider text limit");
  }

  return {
    schema: SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA,
    sourceMessageId: input.message.id,
    sourceMessageSeq: input.message.seq,
    canonicalConversationId: input.canonicalConversationId,
    level: input.activeRuntime.level,
    canonicalRootMessageId: input.canonicalRootMessageId ?? null,
    sourcePermalink,
    senderType: input.senderType,
    senderId: input.senderId,
    authorName: input.authorName,
    authorAvatarDigest: avatar?.sourceDigest ?? null,
    authorPolicy,
    sanitizedText,
    externalMentions,
    attachments: frozenAttachments,
    bindingAuthority: { ...authority },
    enqueueRuntimeRevision: input.activeRuntime.runtimePredicateRevision,
  };
}

/**
 * Allocate one immutable FIFO position and persist its frozen delivery on the
 * caller's executor. Replays return the original logical row without minting
 * a marker or consuming another position.
 */
export async function enqueueSlackBridgeOutboundDelivery(input: {
  executor: DatabaseExecutor;
  message: typeof messages.$inferSelect;
  activeRuntime: ProviderNeutralOutboundRuntimeFact;
  canonicalConversationId: string;
  canonicalRootMessageId?: string | null;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  sanitizedText: string;
  mintReconciliationMarker: SlackBridgeReconciliationMarkerMinter;
}): Promise<SlackBridgeEnqueueResult> {
  const snapshot = await runSlackBridgeOutboundAdmissionStage(
    "render_authority",
    () => resolveFrozenRenderAuthority(input),
  );
  const snapshotDigest = digestSlackBridgeRenderSnapshot(snapshot);
  const { bindingId, bindingEpoch } = snapshot.bindingAuthority;

  const partition = await runSlackBridgeOutboundAdmissionStage("partition_prepare", async () => {
    await input.executor
      .insert(externalDeliveryPartitions)
      .values({ bindingId, bindingEpoch })
      .onConflictDoNothing({
        target: [externalDeliveryPartitions.bindingId, externalDeliveryPartitions.bindingEpoch],
      });
    const [locked] = await input.executor
      .select()
      .from(externalDeliveryPartitions)
      .where(and(
        eq(externalDeliveryPartitions.bindingId, bindingId),
        eq(externalDeliveryPartitions.bindingEpoch, bindingEpoch),
      ))
      .for("update")
      .limit(1);
    if (!locked) throw new Error("Slack Bridge delivery partition disappeared during enqueue");
    return locked;
  });

  const existing = await runSlackBridgeOutboundAdmissionStage("replay_lookup", async () => {
    const [row] = await input.executor
      .select()
      .from(externalOutboundDeliveries)
      .where(and(
        eq(externalOutboundDeliveries.sourceMessageId, input.message.id),
        eq(externalOutboundDeliveries.bindingId, bindingId),
        eq(externalOutboundDeliveries.bindingEpoch, bindingEpoch),
      ))
      .limit(1);
    return row;
  });
  if (existing) {
    if (
      existing.enqueueRuntimeRevision !== snapshot.enqueueRuntimeRevision
      || existing.renderSnapshotDigest !== snapshotDigest
    ) {
      throw new Error("Slack Bridge logical delivery replay conflicts with frozen enqueue authority");
    }
    return { replayed: true, delivery: existing };
  }

  const deliveryId = randomUUID();
  const reconciliationMarker = await runSlackBridgeOutboundAdmissionStage("marker_mint", async () => {
    const marker = await input.mintReconciliationMarker({ deliveryId });
    assertReconciliationMarker(marker);
    return marker;
  });

  const advancedPartition = await runSlackBridgeOutboundAdmissionStage("partition_advance", async () => {
    const [advanced] = await input.executor
      .update(externalDeliveryPartitions)
      .set({
        lastEnqueuedPosition: sql`${externalDeliveryPartitions.lastEnqueuedPosition} + 1`,
        updatedAt: currentDate(),
      })
      .where(eq(externalDeliveryPartitions.id, partition.id))
      .returning({ position: externalDeliveryPartitions.lastEnqueuedPosition });
    if (!advanced || !Number.isSafeInteger(advanced.position) || advanced.position <= 0) {
      throw new Error("Slack Bridge delivery partition position is invalid");
    }
    return advanced;
  });

  const delivery = await runSlackBridgeOutboundAdmissionStage("delivery_insert", async () => {
    const [inserted] = await input.executor
      .insert(externalOutboundDeliveries)
      .values({
        id: deliveryId,
        sourceMessageId: input.message.id,
        bindingId,
        bindingEpoch,
        partitionPosition: advancedPartition.position,
        deliveryContractVersion: SLACK_BRIDGE_DELIVERY_CONTRACT_VERSION,
        enqueueRuntimeRevision: snapshot.enqueueRuntimeRevision,
        state: "queued",
        renderSnapshotSchema: SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA,
        renderSnapshot: { ...snapshot },
        renderSnapshotDigest: snapshotDigest,
        reconciliationMarker,
      })
      .returning();
    if (!inserted) throw new Error("Slack Bridge delivery insert returned no row");
    return inserted;
  });
  for (const attachment of snapshot.attachments) {
    await createOutboundExternalAttachmentTransferWithExecutor(input.executor, {
      outboundDeliveryId: delivery.id,
      sourceAttachmentId: attachment.sourceAttachmentId,
    });
  }
  return { replayed: false, delivery };
}
