import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  currentDate,
  SLACK_BRIDGE_DELIVERY_CONTRACT_VERSION,
} from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import {
  agents,
  attachmentObjects,
  attachments,
  channels,
  externalDeliveryPartitions,
  externalMentionFacts,
  externalOutboundDeliveries,
  messageMentions,
  messages,
  serverMembers,
  servers,
  slackUsergroupIdentities,
  users,
} from "../db/schema";
import type { OrdinaryMessageExternalProjectionDecision } from "./ordinaryMessageExternalProjection";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { attachmentSha256OrNull, createOutboundExternalAttachmentTransferWithExecutor } from "./externalAttachmentTransferService";
import { effectiveAgentSenderName, effectiveUserSenderName } from "./effectiveSenderName";
import { isStoredServerScopedAvatarUrl, isStoredUserAvatarUrl } from "./avatarService";
import { cdnPublicBaseUrl } from "./storageService";

export const SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA = "slack-bridge-render-snapshot.v5" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
  contentDigest: string | null;
  messagePosition: number;
}

/**
 * A Raft-principal mention frozen to its exact Slack token at enqueue.
 * `handle` is the literal text (`handleAtSendTime`) the adapter finds in
 * sanitizedText; `token` is the exact mrkdwn token written — `<!subteam^S…>`
 * for both humans and agents through the install/server-scoped
 * slack_usergroup_identities map. Per-member OAuth links are no longer the
 * bridge precondition. The adapter renders it verbatim and never re-derives
 * identity at dispatch.
 */
export interface SlackBridgeFrozenMentionSubstitution {
  kind: "user" | "usergroup";
  handle: string;
  /** `<@U…>` or `<!subteam^S…>` — validated by a strict pattern. */
  token: string;
  installId: string;
  bindingId: string;
  bindingEpoch: number;
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

export interface SlackBridgeFrozenAuthorPresentation {
  displayName: string;
  fallbackKind: "human" | "agent";
  avatar: {
    publicUrl: string;
    contentDigest: string;
  } | null;
}

// Hosts whose public avatar URLs may be forwarded to Slack as-is, without
// requiring the asset to be stored on our own CDN. Slack fetches icon_url
// server-side, so the URL only needs to be publicly reachable over HTTPS.
// Exported so the delivery worker can apply the same boundary when
// validating snapshots; do not add a separate copy.
export const EXTERNAL_AVATAR_ALLOWED_HOSTS = new Set([
  "lh3.googleusercontent.com",
]);

function frozenAuthorAvatar(input: {
  senderType: "user" | "agent";
  serverId: string;
  avatarUrl: string | null;
}): SlackBridgeFrozenAuthorPresentation["avatar"] {
  if (!input.avatarUrl) return null;
  let url: URL;
  let cdnBase: URL | null;
  try {
    url = new URL(input.avatarUrl);
    const base = cdnPublicBaseUrl();
    cdnBase = base ? new URL(base) : null;
  } catch {
    return null;
  }
  if (!cdnBase) return null;
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) return null;
  if (cdnBase.origin !== url.origin) {
    if (!EXTERNAL_AVATAR_ALLOWED_HOSTS.has(url.hostname)) return null;
    return {
      publicUrl: url.toString(),
      contentDigest: createHash("sha256").update(url.toString()).digest("hex").slice(0, 32),
    };
  }
  const basePath = cdnBase.pathname.replace(/\/$/u, "");
  if (cdnBase.protocol !== "https:" || !url.pathname.startsWith(`${basePath}/`)) return null;
  const owned = input.senderType === "user"
    ? isStoredUserAvatarUrl(input.avatarUrl)
    : isStoredServerScopedAvatarUrl(input.avatarUrl, input.serverId);
  if (!owned) return null;
  const digest = url.pathname.match(/\/([0-9a-f]{32})\.webp$/iu)?.[1]?.toLowerCase();
  return digest ? { publicUrl: url.toString(), contentDigest: digest } : null;
}

export interface SlackBridgeRenderSnapshot {
  schema: "slack-bridge-render-snapshot.v3"
    | "slack-bridge-render-snapshot.v4"
    | typeof SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA;
  sourceMessageId: string;
  sourceMessageSeq: number;
  canonicalConversationId: string;
  level: "top_level" | "thread";
  canonicalRootMessageId: string | null;
  sourcePermalink: string;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  authorPresentation: SlackBridgeFrozenAuthorPresentation;
  sanitizedText: string;
  externalMentions: SlackBridgeFrozenExternalMention[];
  raftMentionSubstitutions: SlackBridgeFrozenMentionSubstitution[];
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
 *
 * The rows are locked FOR NO KEY UPDATE, not FOR UPDATE. That still excludes
 * every other admission holder (FIFO) and every archive/delete write, but not
 * the FOR KEY SHARE a foreign-key check takes. It must not: the same
 * transaction later inserts inbox facts and push outbox rows whose
 * source_channel_id is every Joint projection's local row, including the
 * requested projection another server's sender holds here. With FOR UPDATE,
 * sender A (holding its own projection and the canonical row) waited on
 * sender B's projection for that key share while B, holding its projection,
 * waited on the canonical row: a 40P01 cycle on every concurrent pair of sends
 * into one Joint channel or Joint thread from two servers.
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
      .for("no key update")
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

  const presentation = input.senderType === "user"
    ? await input.executor.select({
      name: users.name,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    }).from(serverMembers).innerJoin(users, eq(users.id, serverMembers.userId)).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, input.senderId),
    )).limit(2)
    : await input.executor.select({
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
    }).from(agents).where(and(
      eq(agents.serverId, server.id),
      eq(agents.id, input.senderId),
      isNull(agents.deletedAt),
    )).limit(2);
  if (presentation.length !== 1) {
    throw new Error("Slack Bridge current author is unavailable");
  }
  const displayName = input.senderType === "user"
    ? effectiveUserSenderName(presentation[0])
    : effectiveAgentSenderName(presentation[0]);
  if (displayName !== input.authorName) {
    throw new Error("Slack Bridge current author display does not match the source message");
  }
  const mentionRows = await input.executor.select().from(externalMentionFacts)
    .where(eq(externalMentionFacts.messageId, input.message.id));
  // Raft-principal mentions freeze to their Slack token here, inside the
  // admission transaction. Humans use the install's confirmed canonical
  // group; agents use the install/server usergroup mapping. A
  // principal without either stays a literal @handle (highlightless, same
  // as today) rather than blocking the send.
  const raftMentionRows = await input.executor.select({
    targetType: messageMentions.targetType,
    targetId: messageMentions.targetId,
    handleAtSendTime: messageMentions.handleAtSendTime,
  }).from(messageMentions).where(and(
    eq(messageMentions.messageId, input.message.id),
    eq(messageMentions.serverId, conversation.serverId),
  ));
  const raftUserMentionIds = raftMentionRows
    .filter((mention) => mention.targetType === "user")
    .map((mention) => mention.targetId);
  const raftAgentMentionIds = raftMentionRows
    .filter((mention) => mention.targetType === "agent")
    .map((mention) => mention.targetId);
  // Usergroup mappings only exist for real install identities; a synthetic
  // test authority (non-UUID installId) cannot have any, so skip before the
  // uuid-typed join column rejects the value.
  const installUuid = UUID_PATTERN.test(authority.installId);
  const allPrincipalIds = [...raftUserMentionIds, ...raftAgentMentionIds];
  const principalUsergroups = installUuid && allPrincipalIds.length > 0
    ? await input.executor.select({
      principalId: slackUsergroupIdentities.principalId,
      principalKind: slackUsergroupIdentities.principalKind,
      providerUsergroupId: slackUsergroupIdentities.providerUsergroupId,
    }).from(slackUsergroupIdentities).where(and(
      eq(slackUsergroupIdentities.installId, authority.installId),
      or(
        and(eq(slackUsergroupIdentities.principalKind, "user"), eq(slackUsergroupIdentities.humanCanonical, true), inArray(slackUsergroupIdentities.principalId, raftUserMentionIds)),
        and(eq(slackUsergroupIdentities.principalKind, "agent"), eq(slackUsergroupIdentities.serverId, conversation.serverId), inArray(slackUsergroupIdentities.principalId, raftAgentMentionIds)),
      ),
    ))
    : [];
  const providerUsergroupByPrincipal = new Map(
    principalUsergroups.map((row) => [`${row.principalKind}:${row.principalId}`, row.providerUsergroupId]),
  );
  const raftMentionSubstitutions: SlackBridgeFrozenMentionSubstitution[] = [];
  const seenSubstitutionTargets = new Set<string>();
  for (const mention of raftMentionRows) {
    const handle = mention.handleAtSendTime.trim();
    if (
      !handle
      || /^[@<>&\s\u0000-\u001f\u007f]/u.test(handle)
      || seenSubstitutionTargets.has(`${mention.targetType}:${mention.targetId}`)
    ) continue;
    const providerUsergroupId = providerUsergroupByPrincipal.get(`${mention.targetType}:${mention.targetId}`) ?? null;
    const token = providerUsergroupId && /^S[A-Z0-9_]{2,}$/.test(providerUsergroupId)
      ? `<!subteam^${providerUsergroupId}>`
      : null;
    if (!token) continue;
    seenSubstitutionTargets.add(`${mention.targetType}:${mention.targetId}`);
    raftMentionSubstitutions.push({
      // The kind field follows the token shape, not the Raft principal type:
      // every live substitution renders through a managed usergroup, so the
      // worker's frozen-snapshot contract only accepts "usergroup" here.
      kind: "usergroup",
      handle,
      token,
      installId: authority.installId,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
    });
  }
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

  const frozenAttachments: SlackBridgeFrozenAttachment[] = linkedAttachments.map(({ projection, object }, messagePosition) => {
    if (
      projection.revokedAt
      || !object
      || object.lifecycleState !== "active"
      || projection.messagePosition !== messagePosition
    ) throw new Error("Slack Bridge attachment source is not immutable and ordered");
    return {
      sourceAttachmentId: projection.id,
      objectId: object.id,
      originServerId: object.originServerId,
      storageKey: object.storageKey,
      filename: projection.filename,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes,
      contentDigest: attachmentSha256OrNull(object.contentHash),
      messagePosition,
    };
  });

  const authorPresentation: SlackBridgeFrozenAuthorPresentation = {
    displayName,
    fallbackKind: input.senderType === "user" ? "human" : "agent",
    avatar: frozenAuthorAvatar({
      senderType: input.senderType,
      serverId: server.id,
      avatarUrl: presentation[0]!.avatarUrl,
    }),
  };
  const sanitizedText = input.sanitizedText;

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
    authorPresentation,
    sanitizedText,
    externalMentions,
    raftMentionSubstitutions,
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
