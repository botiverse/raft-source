import { markSlackAttachmentPlanWriter } from "./slackAttachmentFallbackProtocol";
import { readSlackAttachmentSelection } from "./slackAttachmentFallbackValidation";
import { loadSlackChannelDeletionEvidence } from "./slackChannelDeletionEvidence";
import { randomUUID } from "node:crypto";
import {
  and, or,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  applySlackBridgeProviderAttemptResult,
  currentDate,
  currentRandomUnit,
  planSlackBridgePartitionWork,
  needsSlackBridgeManualRetry,
  SLACK_BRIDGE_MAX_DELIVERY_AGE_MS,
  SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS,
  type SlackBridgeOutboundDeliverySnapshot,
  type SlackBridgeProviderAttemptResult,
} from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalAppRegistrations,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalMentionFacts,
  externalOutboundDeliveries,
  serverMembers,
} from "../db/schema";
import type {
  ProviderNeutralOutboundBindingAuthority,
  SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService";
import { EXTERNAL_AVATAR_ALLOWED_HOSTS } from "./externalDeliveryOutboxService";
import { finalizeAcceptedOutboundAttachmentFacts } from "./externalOutboundAttachmentCoordinator";
import { CONFIRMED_THREAD_ROOT_MISSING, type ExternalProviderPreparation } from "./externalProviderPreparation";
import { isSlackBotRecoveryWaitReason, listSlackPairRecoveryWaits, SLACK_BOT_RECOVERY_WAIT_REASONS } from "./slackBridgePairQueue";

// Lock order: a transaction that locks both rows takes the partition row
// (external_delivery_partitions) before any delivery row of that partition.
// Claiming the head and the operator skip do so through lockPartitionAndHead;
// recording a provider outcome does so through lockOutcomePartitionAndDelivery.
// Prod 2026-10-21 (15:39-17:07Z, four 40P01): the outcome transaction locked
// the delivery first and the partition only when it advanced the cursor, while
// another replica's tick held the partition and waited for that same head.

const LEASE_DURATION_MS = 60_000;
const SAFE_PROVIDER_IO_EXCEPTION = "provider_io_exception";
const LEASE_EXPIRED_AFTER_PROVIDER_IO = "lease_expired_after_provider_io";
export const EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS = 5_000;
export const EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS = 5 * 60_000;
export const EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS = 15 * 60_000;

const AUTHORITY_BLOCK_STATE_PREFIX = {
  retrying: "authority_retry:",
  overdue: "authority_overdue:",
  terminal: "authority_terminal:",
} as const;

const AUTHORITY_BLOCK_REASONS = new Set([
  "runtime_authority_inactive_or_mismatched",
  "frozen_render_authority_inactive_or_mismatched",
  "credential_unavailable_or_mismatched",
  "attempt_start_authority_lost",
]);

type Delivery = typeof externalOutboundDeliveries.$inferSelect;
type Attempt = typeof externalDeliveryAttempts.$inferSelect;
type DispatchableOriginState = "queued" | "retry_wait" | "outcome_unknown" | "dead";

/** Advancing a cursor is not evidence that the bot and audience were reverified. */
function clearPairWaitUnlessBotRecovery() {
  const keep = inArray(externalDeliveryPartitions.authorityBlockedReason, [...SLACK_BOT_RECOVERY_WAIT_REASONS]);
  return {
    authorityBlockedAt: sql<Date | null>`CASE WHEN ${keep} THEN ${externalDeliveryPartitions.authorityBlockedAt} ELSE NULL END`,
    authorityBlockedReason: sql<string | null>`CASE WHEN ${keep} THEN ${externalDeliveryPartitions.authorityBlockedReason} ELSE NULL END`,
    authorityRetryAt: sql<Date | null>`CASE WHEN ${keep} THEN ${externalDeliveryPartitions.authorityRetryAt} ELSE NULL END`,
    authorityOverdueAlertedAt: sql<Date | null>`CASE WHEN ${keep} THEN ${externalDeliveryPartitions.authorityOverdueAlertedAt} ELSE NULL END`,
  };
}

export interface ActiveExternalDeliveryRuntime {
  runtimeRevision: string;
  bindingAuthority: ProviderNeutralOutboundBindingAuthority;
}

export interface ExternalDeliveryCredentialLease {
  /** Opaque and deliberately unconstrained: the worker never serializes it. */
  handle: unknown;
  credentialRevision: number;
  runtimeRevision: string;
  provider: string;
  installId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
}

export type ExternalDeliveryProviderResult =
  | {
    kind: "accepted";
    providerMessageId: string;
    providerThreadId?: string | null;
    reconciled?: boolean;
  }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; reasonCode: string; baseDelayMs: number }
  | { kind: "deterministic_failure"; reasonCode: string; pairBlockedReason?: string }
  | { kind: "outcome_unknown"; reasonCode: string };

export interface ExternalDeliveryWorkerDependencies {
  resolveCurrentRuntime(input: {
    deliveryId: string;
    frozenSnapshot: SlackBridgeRenderSnapshot;
  }): Promise<ActiveExternalDeliveryRuntime | { blockedReason: string } | null>;
  prepareBeforeCredential?(input: {
    deliveryId: string;
    bindingId: string;
    bindingEpoch: number;
    leaseOwner: string;
    leaseGeneration: number;
    runtime: ActiveExternalDeliveryRuntime;
    reconcileUnknownOutcome: boolean;
    frozenSnapshot: SlackBridgeRenderSnapshot;
  }): Promise<{ ready: true } | { ready: false; reason: string }>;
  leaseCredential(input: {
    deliveryId: string;
    runtime: ActiveExternalDeliveryRuntime;
  }): Promise<ExternalDeliveryCredentialLease | null>;
  prepareProvider?(input: {
    deliveryId: string;
    leaseOwner: string;
    leaseGeneration: number;
    reconciliationMarker: string;
    payloadFingerprint: string;
    frozenSnapshot: SlackBridgeRenderSnapshot;
    runtime: ActiveExternalDeliveryRuntime;
    credentialHandle: unknown;
    reconcileUnknownOutcome: boolean;
  }): Promise<ExternalProviderPreparation<ExternalDeliveryProviderResult>>;
  dispatchProvider?(input: {
    deliveryId: string;
    reconciliationMarker: string;
    payloadFingerprint: string;
    frozenSnapshot: SlackBridgeRenderSnapshot;
    runtime: ActiveExternalDeliveryRuntime;
    credentialHandle: unknown;
  }): Promise<ExternalDeliveryProviderResult>;
  releaseCredential?(input: {
    deliveryId: string;
    runtime: ActiveExternalDeliveryRuntime;
    credentialHandle: unknown;
    reason: string;
  }): Promise<void>;
  now?(): Date;
  jitterUnit?(): number;
}

export interface ExternalDeliveryAuthorityAlert {
  schema: "external-delivery-authority-alert.v1";
  severity: "overdue" | "terminal";
  deliveryId: string;
  bindingId: string;
  bindingEpoch: number;
  partitionPosition: number;
  blockReason: string;
  observedAt: string;
  deliveryAgeMs: number;
  requiredAction: "restore_authority_or_audited_skip" | "audited_skip_required";
}

export type ExternalDeliveryWorkerResult =
  | { kind: "disabled" }
  | { kind: "empty" }
  | { kind: "blocked"; reason: string; deliveryId?: string }
  | {
      kind: "authority_blocked";
      severity: "retrying" | "overdue" | "terminal";
      reason: string;
      deliveryId: string;
      nextRetryAt: string | null;
      alert?: ExternalDeliveryAuthorityAlert;
    }
  | { kind: "cursor_recovered"; deliveryId: string; state: "accepted" | "skipped" }
  | { kind: "skipped"; deliveryId: string }
  | { kind: "lease_reclaimed"; deliveryId: string; phase: "pre_io" | "post_io" }
  | {
      kind: "attempted";
      deliveryId: string;
      attemptNumber: number;
      outcome: Exclude<Attempt["outcome"], "provider_io_started">;
      deliveryState: Delivery["state"];
    };

export interface ProcessExternalDeliveryPartitionHeadInput {
  db: Database;
  bindingId: string;
  bindingEpoch: number;
  leaseOwner: string;
  dependencies?: ExternalDeliveryWorkerDependencies | null;
  retryDecisionId?: string | null;
}

export interface ConsumeExternalDeliverySkipDecisionInput {
  db: Database;
  bindingId: string;
  bindingEpoch: number;
  decisionId: string;
  now?: Date;
}

let acceptedTransactionHookForTests: (() => Promise<void> | void) | null = null;
let attemptRowLockHookForTests: (() => Promise<void> | void) | null = null;

function isAuthorityBlockReason(reason: string): boolean {
  return AUTHORITY_BLOCK_REASONS.has(reason);
}

function authorityBlockStateReason(
  severity: "retrying" | "overdue" | "terminal",
  reason: string,
  sinceMs: number,
): string {
  return `${AUTHORITY_BLOCK_STATE_PREFIX[severity]}${reason.slice(0, 110)}|since=${sinceMs}`.slice(0, 160);
}

function parseAuthorityBlockStateReason(value: string | null): {
  severity: "retrying" | "overdue" | "terminal";
  reason: string;
  sinceMs?: number;
} | null {
  if (!value) return null;
  for (const severity of ["retrying", "overdue", "terminal"] as const) {
    const prefix = AUTHORITY_BLOCK_STATE_PREFIX[severity];
    if (value.startsWith(prefix)) {
      const raw = value.slice(prefix.length);
      const match = /^(.*)\|since=([0-9]{1,16})$/.exec(raw);
      const reason = match?.[1] ?? raw;
      return reason ? { severity, reason, ...(match ? { sinceMs: Number(match[2]) } : {}) } : null;
    }
  }
  return null;
}

function authorityBlockAgeMs(delivery: Delivery, now: Date): number {
  const startedAt = parseAuthorityBlockStateReason(delivery.stateReason)?.sinceMs ?? now.getTime();
  return Math.max(0, now.getTime() - startedAt);
}

function authorityBlockSeverity(
  delivery: Delivery,
  now: Date,
): "retrying" | "overdue" | "terminal" {
  const ageMs = authorityBlockAgeMs(delivery, now);
  if (ageMs >= SLACK_BRIDGE_MAX_DELIVERY_AGE_MS) return "terminal";
  if (ageMs >= EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS) return "overdue";
  return "retrying";
}

function authorityBlockBackoffMs(leaseGeneration: number): number {
  const exponent = Math.max(0, Math.min(16, leaseGeneration - 1));
  return Math.min(
    EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS,
    EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS * (2 ** exponent),
  );
}

function authorityBlockAlert(
  delivery: Delivery,
  severity: "overdue" | "terminal",
  reason: string,
  now: Date,
): ExternalDeliveryAuthorityAlert {
  return {
    schema: "external-delivery-authority-alert.v1",
    severity,
    deliveryId: delivery.id,
    bindingId: delivery.bindingId,
    bindingEpoch: delivery.bindingEpoch,
    partitionPosition: delivery.partitionPosition,
    blockReason: reason,
    observedAt: now.toISOString(),
    deliveryAgeMs: authorityBlockAgeMs(delivery, now),
    requiredAction: severity === "terminal"
      ? "audited_skip_required"
      : "restore_authority_or_audited_skip",
  };
}

export function __setExternalDeliveryAcceptedTransactionHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  acceptedTransactionHookForTests = hook;
}

export function __setExternalDeliveryAttemptRowLockHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  attemptRowLockHookForTests = hook;
}

function validBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function parseFrozenSnapshot(delivery: Delivery): SlackBridgeRenderSnapshot | null {
  const value = delivery.renderSnapshot;
  if (!isRecord(value) || !isRecord(value.bindingAuthority)) return null;
  const authority = value.bindingAuthority;
  const topLevelKeys = [
    "schema",
    "sourceMessageId",
    "sourceMessageSeq",
    "canonicalConversationId",
    "level",
    "canonicalRootMessageId",
    "sourcePermalink",
    "senderType",
    "senderId",
    "authorName",
    "authorPresentation",
    "sanitizedText",
    "externalMentions",
    "attachments",
    "bindingAuthority",
    "enqueueRuntimeRevision",
  ] as const;
  // raftMentionSubstitutions is optional on every schema version: v5 writers
  // always emit it, earlier rows and hand-built fixtures may omit it.
  const snapshotV5 = value.schema === "slack-bridge-render-snapshot.v5";
  const strippedValue = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "raftMentionSubstitutions"),
  );
  const requiredAuthorityStrings = [
    "provider",
    "environment",
    "appRegistrationId",
    "installId",
    "workspaceId",
    "bindingId",
    "privacyClass",
    "raftChannelId",
    "providerAuthorityId",
    "providerConversationId",
  ] as const;
  const requiredAuthorityRevisions = [
    "connectionEpoch",
    "bindingEpoch",
    "memberRevision",
    "contextRevision",
  ] as const;
  const authorPresentation = isRecord(value.authorPresentation) ? value.authorPresentation : null;
  const snapshotV3 = value.schema === "slack-bridge-render-snapshot.v3";
  const snapshotV4 = value.schema === "slack-bridge-render-snapshot.v4"
    || snapshotV5;
  const authorAvatar = snapshotV4 && authorPresentation && isRecord(authorPresentation.avatar)
    ? authorPresentation.avatar
    : null;
  let authorAvatarValid = snapshotV3 || authorPresentation?.avatar === null;
  if (authorAvatar) {
    try {
      const url = new URL(String(authorAvatar.publicUrl));
      const digest = typeof authorAvatar.contentDigest === "string"
        ? authorAvatar.contentDigest
        : "";
      authorAvatarValid = hasExactKeys(authorAvatar, ["publicUrl", "contentDigest"])
        && url.protocol === "https:"
        && !url.username
        && !url.password
        && !url.search
        && !url.hash
        && /^[0-9a-f]{32}$/u.test(digest)
        && (url.pathname.endsWith(`/${digest}.webp`) || EXTERNAL_AVATAR_ALLOWED_HOSTS.has(url.hostname));
    } catch {
      authorAvatarValid = false;
    }
  }
  const mentionsValid = Array.isArray(value.externalMentions)
    && value.externalMentions.every((mention) => {
      if (!isRecord(mention)) return false;
      const requiredStrings = [
        "projectionId",
        "provider",
        "appRegistrationId",
        "installId",
        "workspaceId",
        "externalActorId",
        "bindingId",
        "conversationId",
        "handleSnapshot",
      ] as const;
      const requiredRevisions = [
        "connectionEpoch",
        "bindingEpoch",
        "memberRevision",
        "contextRevision",
      ] as const;
      return hasExactKeys(mention, [
        ...requiredStrings,
        ...requiredRevisions,
        "freshnessObservedAt",
        "freshnessExpiresAt",
        "resolutionReason",
      ])
        && requiredStrings.every((key) => validBoundedString(mention[key], 320))
        && requiredRevisions.every((key) => positiveInteger(mention[key]))
        && validIsoDate(mention.freshnessObservedAt)
        && validIsoDate(mention.freshnessExpiresAt)
        && Date.parse(mention.freshnessExpiresAt) > Date.parse(mention.freshnessObservedAt)
        && (mention.resolutionReason === "explicit_projection"
          || mention.resolutionReason === "unique_dangling_handle")
        && mention.provider === authority.provider
        && mention.appRegistrationId === authority.appRegistrationId
        && mention.installId === authority.installId
        && mention.workspaceId === authority.workspaceId
        && mention.connectionEpoch === authority.connectionEpoch
        && mention.bindingId === authority.bindingId
        && mention.bindingEpoch === authority.bindingEpoch
        && mention.conversationId === authority.providerConversationId
        && mention.memberRevision === authority.memberRevision
        && mention.contextRevision === authority.contextRevision;
    });
  const substitutions = Array.isArray(value.raftMentionSubstitutions)
    ? value.raftMentionSubstitutions
    : [];
  const substitutionsValid = (value.raftMentionSubstitutions === undefined
    || Array.isArray(value.raftMentionSubstitutions))
    && substitutions.every((substitution) => {
      if (!isRecord(substitution)) return false;
      return hasExactKeys(substitution, [
        "kind",
        "handle",
        "token",
        "installId",
        "bindingId",
        "bindingEpoch",
      ])
        && (substitution.kind === "user" || substitution.kind === "usergroup")
        && validBoundedString(substitution.handle, 160)
        && (substitution.kind === "user"
          ? /^<@[UW][A-Z0-9_]{2,}>$/u.test(String(substitution.token))
          : /^<!subteam\^S[A-Z0-9_]{2,}>$/u.test(String(substitution.token)))
        && substitution.installId === authority.installId
        && substitution.bindingId === authority.bindingId
        && substitution.bindingEpoch === authority.bindingEpoch;
    });
  const attachments = value.attachments;
  const attachmentsValid = Array.isArray(attachments)
    && attachments.length <= 10
    && attachments.every((attachment, messagePosition) => (
      isRecord(attachment)
      && hasExactKeys(attachment, [
        "sourceAttachmentId",
        "objectId",
        "originServerId",
        "storageKey",
        "filename",
        "mimeType",
        "sizeBytes",
        "contentDigest",
        "messagePosition",
      ])
      && validBoundedString(attachment.sourceAttachmentId, 320)
      && validBoundedString(attachment.objectId, 320)
      && validBoundedString(attachment.originServerId, 320)
      && validBoundedString(attachment.storageKey, 1_024)
      && validBoundedString(attachment.filename, 1_024)
      && validBoundedString(attachment.mimeType, 255)
      && positiveInteger(attachment.sizeBytes)
      && (attachment.contentDigest === null
        || (typeof attachment.contentDigest === "string" && /^[0-9a-f]{64}$/.test(attachment.contentDigest)))
      && attachment.messagePosition === messagePosition
    ));
  if (
    !hasExactKeys(strippedValue, topLevelKeys)
    || !hasExactKeys(authority, [...requiredAuthorityStrings, ...requiredAuthorityRevisions])
    || (!snapshotV3 && !snapshotV4)
    || delivery.renderSnapshotSchema !== value.schema
    || value.sourceMessageId !== delivery.sourceMessageId
    || !positiveInteger(value.sourceMessageSeq)
    || !validBoundedString(value.canonicalConversationId, 320)
    || (value.level !== "top_level" && value.level !== "thread")
    || (value.level === "top_level" && value.canonicalRootMessageId !== null)
    || (value.level === "thread" && !validBoundedString(value.canonicalRootMessageId, 320))
    || !validBoundedString(value.sourcePermalink, 2_048)
    || !value.sourcePermalink.startsWith("https://app.slock.ai/s/")
    || (value.senderType !== "user" && value.senderType !== "agent")
    || !validBoundedString(value.senderId, 320)
    || !validBoundedString(value.authorName, 320)
    || !(validBoundedString(value.sanitizedText, 40_000)
      || (value.sanitizedText === "" && attachmentsValid && attachments.length > 0))
    || value.enqueueRuntimeRevision !== delivery.enqueueRuntimeRevision
    || authority.bindingId !== delivery.bindingId
    || authority.bindingEpoch !== delivery.bindingEpoch
    || !requiredAuthorityStrings.every((key) => validBoundedString(authority[key], 320))
    || !requiredAuthorityRevisions.every((key) => positiveInteger(authority[key]))
    || !authorPresentation
    || !hasExactKeys(authorPresentation, snapshotV4
      ? ["displayName", "fallbackKind", "avatar"]
      : ["displayName", "fallbackKind"])
    || !validBoundedString(authorPresentation.displayName, 320)
    || authorPresentation.displayName !== value.authorName
    || (authorPresentation.fallbackKind !== "human" && authorPresentation.fallbackKind !== "agent")
    || !authorAvatarValid
    || !mentionsValid
    || !substitutionsValid
    || !attachmentsValid
  ) return null;
  return {
    ...value,
    schema: value.schema,
    authorPresentation: {
      ...authorPresentation,
      avatar: snapshotV4 ? authorPresentation.avatar : null,
    },
    raftMentionSubstitutions: substitutions,
    attachments,
  } as unknown as SlackBridgeRenderSnapshot;
}

/** The delivery's frozen send snapshot, validated as the worker validates it; null when it is not one. */
export function parseExternalDeliveryFrozenSnapshot(delivery: Delivery): SlackBridgeRenderSnapshot | null {
  return parseFrozenSnapshot(delivery);
}

/**
 * Compare only coordinates that identify the destination of an already
 * enqueued message. Runtime/audience revisions are refresh metadata: they may
 * change while a binding remains active and must not turn a normal FIFO head
 * into a permanent authority failure.
 */
function sameHardAuthority(
  left: ProviderNeutralOutboundBindingAuthority,
  right: ProviderNeutralOutboundBindingAuthority,
): boolean {
  const keys: (keyof ProviderNeutralOutboundBindingAuthority)[] = [
    "provider",
    "environment",
    "appRegistrationId",
    "workspaceId",
    // privacyClass stays out: visibility flips are per-platform metadata
    // and must not invalidate a queued delivery (yezizp, task #241).
    "raftChannelId",
    "providerAuthorityId",
    "providerConversationId",
  ];
  return keys.every((key) => left[key] === right[key]);
}

async function frozenRenderAuthorityIsCurrent(
  executor: DatabaseExecutor,
  snapshot: SlackBridgeRenderSnapshot,
  _now: Date,
): Promise<boolean | "sender_removed"> {
  // A published Slack-bound message is an established fact. Its frozen author
  // survives later departure, deletion or archive; notifications are rechecked
  // separately at publication and may degrade to literal text.
  if (snapshot.bindingAuthority.provider === "slack") return true;
  const [bindingChannel] = await executor.select({
    serverId: channels.serverId,
    type: channels.type,
  }).from(channels).where(and(
    eq(channels.id, snapshot.bindingAuthority.raftChannelId),
    isNull(channels.deletedAt),
    isNull(channels.archivedAt),
  )).limit(2);
  if (!bindingChannel) return false;
  if (snapshot.senderType === "user") {
    const members = await executor.select({ userId: serverMembers.userId }).from(serverMembers).where(and(
      eq(serverMembers.serverId, bindingChannel.serverId),
      eq(serverMembers.userId, snapshot.senderId),
    )).limit(2);
    if (members.length !== 1) return "sender_removed";
    if (bindingChannel.type === "private") {
      const channelMembership = await executor.select({ userId: channelHumans.userId })
        .from(channelHumans).where(and(
          eq(channelHumans.channelId, snapshot.bindingAuthority.raftChannelId),
          eq(channelHumans.userId, snapshot.senderId),
        )).limit(2);
      if (channelMembership.length !== 1) return "sender_removed";
    }
  } else {
    const activeAgents = await executor.select({ id: agents.id }).from(agents).innerJoin(
      channelAgents,
      and(
        eq(channelAgents.agentId, agents.id),
        eq(channelAgents.channelId, snapshot.bindingAuthority.raftChannelId),
      ),
    ).where(and(
      eq(agents.id, snapshot.senderId),
      eq(agents.serverId, bindingChannel.serverId),
      isNull(agents.deletedAt),
    )).limit(2);
    if (activeAgents.length !== 1) return "sender_removed";
  }

  const frozenFacts = await executor.select().from(externalMentionFacts)
    .where(eq(externalMentionFacts.messageId, snapshot.sourceMessageId));
  if (frozenFacts.length !== snapshot.externalMentions.length) return false;
  const factsByProjection = new Map(frozenFacts.map((fact) => [fact.projectionId, fact]));
  for (const mention of snapshot.externalMentions) {
    const fact = factsByProjection.get(mention.projectionId);
    if (
      !fact
      || fact.provider !== mention.provider
      || fact.appRegistrationId !== mention.appRegistrationId
      || fact.installId !== mention.installId
      || fact.workspaceId !== mention.workspaceId
      || fact.externalActorId !== mention.externalActorId
      || fact.connectionEpoch !== mention.connectionEpoch
      || fact.bindingId !== mention.bindingId
      || fact.bindingEpoch !== mention.bindingEpoch
      || fact.conversationId !== mention.conversationId
      || fact.memberRevision !== mention.memberRevision
      || fact.contextRevision !== mention.contextRevision
      || fact.freshnessObservedAt.toISOString() !== mention.freshnessObservedAt
      || fact.freshnessExpiresAt.toISOString() !== mention.freshnessExpiresAt
      || fact.handleAtSendTime !== mention.handleSnapshot
      || fact.resolutionReason !== mention.resolutionReason
      // freshnessExpiresAt is a directory-refresh TTL, not a delivery
      // boundary: an overdue refresh degrades to the last observed mapping
      // rather than revoking an already-frozen mention.
    ) return false;
    // Slack rendering checks the current pair membership and falls back to literal
    // text. Frozen mention facts prove original intent, not present membership.
    if (snapshot.bindingAuthority.provider !== "slack") {
    const [addressability] = await executor.select({ id: externalAddressabilityProjections.id })
      .from(externalAddressabilityProjections)
      .where(and(
        eq(externalAddressabilityProjections.projectionId, mention.projectionId),
        eq(externalAddressabilityProjections.provider, mention.provider),
        eq(externalAddressabilityProjections.appRegistrationId, mention.appRegistrationId),
        eq(externalAddressabilityProjections.installId, mention.installId),
        eq(externalAddressabilityProjections.workspaceId, mention.workspaceId),
        eq(externalAddressabilityProjections.connectionEpoch, mention.connectionEpoch),
        eq(externalAddressabilityProjections.bindingId, mention.bindingId),
        eq(externalAddressabilityProjections.bindingEpoch, mention.bindingEpoch),
        eq(externalAddressabilityProjections.conversationId, mention.conversationId),
        // memberRevision/contextRevision are refresh watermarks: an ordinary
        // directory refresh advances them and must not revoke a mention the
        // enqueue already froze. Identity, epochs and `active` still gate —
        // a real removal still cancels the frozen mention.
        eq(externalAddressabilityProjections.state, "active"),
      )).for("update").limit(1);
    if (!addressability) return false;
    }
  }
  return true;
}

function sameCredentialAuthority(
  lease: ExternalDeliveryCredentialLease,
  runtime: ActiveExternalDeliveryRuntime,
): boolean {
  const authority = runtime.bindingAuthority;
  return positiveInteger(lease.credentialRevision)
    && lease.runtimeRevision === runtime.runtimeRevision
    && lease.provider === authority.provider
    && lease.installId === authority.installId
    && lease.providerAuthorityId === authority.providerAuthorityId
    && lease.providerConversationId === authority.providerConversationId
    && lease.connectionEpoch === authority.connectionEpoch
    && lease.bindingId === authority.bindingId
    && lease.bindingEpoch === authority.bindingEpoch;
}

function toPlannerSnapshot(delivery: Delivery): SlackBridgeOutboundDeliverySnapshot {
  return {
    logicalDeliveryId: delivery.id,
    bindingId: delivery.bindingId,
    bindingEpoch: delivery.bindingEpoch,
    partitionPosition: delivery.partitionPosition,
    enqueueRuntimeRevision: delivery.enqueueRuntimeRevision,
    state: delivery.state,
    providerAttempts: delivery.providerAttempts,
    ambiguityBudgetProviderAttempts: delivery.ambiguityBudgetProviderAttempts,
    dispatchedFailureAttempts: delivery.dispatchedFailureAttempts,
    firstDispatchedAt: delivery.firstDispatchedAt?.toISOString() ?? null,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
  };
}

function snapshotBeforeCurrentAttempt(delivery: Delivery): SlackBridgeOutboundDeliverySnapshot {
  if (delivery.providerAttempts <= 0) {
    throw new Error("External delivery attempt counter was not durably started");
  }
  return {
    ...toPlannerSnapshot(delivery),
    state: "dispatching",
    providerAttempts: delivery.providerAttempts - 1,
    firstDispatchedAt:
      delivery.providerAttempts === 1 ? null : delivery.firstDispatchedAt?.toISOString() ?? null,
  };
}

function originState(delivery: Delivery): DispatchableOriginState | null {
  return delivery.state === "queued"
      || delivery.state === "retry_wait"
      || delivery.state === "outcome_unknown"
      || delivery.state === "dead"
    ? delivery.state
    : null;
}

function clearLease() {
  return {
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseOriginState: null,
    leaseOriginNextAttemptAt: null,
  } as const;
}

function restoreLeaseOrigin(delivery: Delivery) {
  if (!delivery.leaseOriginState) {
    throw new Error("Dispatching delivery is missing its durable claim origin");
  }
  return {
    state: delivery.leaseOriginState,
    nextAttemptAt: delivery.leaseOriginNextAttemptAt,
    ...clearLease(),
    updatedAt: currentDate(),
  } as const;
}

/**
 * The outcome transaction's locks, in the file's order: the partition row
 * first (the cursor advances under it when the provider accepted), then the
 * delivery under the exact lease. Returns null when the lease was lost.
 */
export async function lockOutcomePartitionAndDelivery(
  executor: DatabaseExecutor,
  input: { deliveryId: string; bindingId: string; bindingEpoch: number; leaseOwner: string; leaseGeneration: number },
): Promise<Delivery | null> {
  await executor.select({ id: externalDeliveryPartitions.id })
    .from(externalDeliveryPartitions)
    .where(and(
      eq(externalDeliveryPartitions.bindingId, input.bindingId),
      eq(externalDeliveryPartitions.bindingEpoch, input.bindingEpoch),
    ))
    .for("update")
    .limit(1);
  const [delivery] = await executor.select().from(externalOutboundDeliveries)
    .where(and(
      eq(externalOutboundDeliveries.id, input.deliveryId),
      eq(externalOutboundDeliveries.state, "dispatching"),
      eq(externalOutboundDeliveries.leaseOwner, input.leaseOwner),
      eq(externalOutboundDeliveries.leaseGeneration, input.leaseGeneration),
    )).for("update").limit(1);
  return delivery ?? null;
}

/** @internal Exported for the lock-order real-Postgres test. */
export async function lockPartitionAndHead(
  executor: DatabaseExecutor,
  bindingId: string,
  bindingEpoch: number,
  options: { skipLocked?: boolean } = {},
): Promise<{
  partition: typeof externalDeliveryPartitions.$inferSelect;
  delivery: Delivery | null;
} | null> {
  await markSlackAttachmentPlanWriter(executor);
  const [partition] = await executor.select()
    .from(externalDeliveryPartitions)
    .where(and(
      eq(externalDeliveryPartitions.bindingId, bindingId),
      eq(externalDeliveryPartitions.bindingEpoch, bindingEpoch),
    ))
    // Initial worker claims pass skipLocked: every replica visits every active
    // binding on each tick, and right after a rolling deploy the new replicas
    // all start at once. Waiting on a partition another worker already holds
    // only parks a pooled connection behind that lock (prod 2026-09-26: 13+
    // sessions queued on one partition row during the bac9696a rollout).
    // Skipping admission is safe because no lease was taken. Lease-owning
    // continuations and operator paths wait: skipping would mistake contention
    // for a lost head and abandon already claimed work.
    .for("update", options.skipLocked ? { skipLocked: true } : undefined)
    .limit(1);
  // With skipLocked, a partition held by another worker also lands here and
  // reads as zero-work idle for this tick; the holder is draining it.
  // A binding becomes externally visible before it has necessarily carried
  // any outbound work. Polling that zero-work state is ordinary idleness, not
  // a worker failure. Activation now creates the partition atomically, but
  // retaining this fail-soft read keeps rolling deploys and legacy rows quiet.
  if (!partition) return null;

  const [delivery] = await executor.select()
    .from(externalOutboundDeliveries)
    .where(and(
      eq(externalOutboundDeliveries.bindingId, bindingId),
      eq(externalOutboundDeliveries.bindingEpoch, bindingEpoch),
      eq(externalOutboundDeliveries.partitionPosition, partition.cursorPosition + 1),
    ))
    // Same skipLocked rationale as the partition lock above: FOR UPDATE
    // conflicts with the FOR KEY SHARE lock a concurrent attempt-row INSERT
    // takes through the delivery FK, so a tick racing an in-flight provider
    // attempt would park (or deadlock against) that writer — observed on prod
    // as "while locking tuple" failures from runOutboundTick. A head row we
    // cannot lock is owned by that writer; it becomes visible next tick.
    .for("update", options.skipLocked ? { skipLocked: true } : undefined)
    .limit(1);
  return { partition, delivery: delivery ?? null };
}

// Consumes the oldest unconsumed audited skip decision for the head
// delivery inside the caller's transaction. Marks the delivery skipped,
// bumps its lease generation, and advances the partition cursor so the FIFO
// drains. The public consumeExternalDeliverySkipDecision wraps this in its
// own transaction; the worker tick calls it directly on the claim
// transaction so a pending decision takes effect on the next pass.
async function consumePendingSkipDecision(
  executor: DatabaseExecutor,
  input: {
    delivery: Delivery;
    partitionId: string;
    now: Date;
    decisionId?: string;
  },
): Promise<{ consumed: boolean; reason?: string }> {
  const { delivery, now } = input;
  const [decision] = await executor.select().from(externalDeliveryOperatorDecisions)
    .where(and(
      ...(input.decisionId ? [eq(externalDeliveryOperatorDecisions.id, input.decisionId)] : []),
      eq(externalDeliveryOperatorDecisions.deliveryId, delivery.id),
      eq(externalDeliveryOperatorDecisions.bindingId, delivery.bindingId),
      eq(externalDeliveryOperatorDecisions.bindingEpoch, delivery.bindingEpoch),
      eq(externalDeliveryOperatorDecisions.partitionPosition, delivery.partitionPosition),
      eq(externalDeliveryOperatorDecisions.action, "skip"),
      eq(externalDeliveryOperatorDecisions.dataLossAcknowledged, true),
      isNull(externalDeliveryOperatorDecisions.consumedAt),
    )).orderBy(externalDeliveryOperatorDecisions.createdAt).for("update").limit(1);
  if (!decision) {
    return { consumed: false, reason: "skip_decision_invalid_or_consumed" };
  }

  const consumedGeneration = delivery.leaseGeneration + 1;
  const [consumed] = await executor.update(externalDeliveryOperatorDecisions).set({
    consumedAt: now,
    consumedLeaseGeneration: consumedGeneration,
  }).where(and(
    eq(externalDeliveryOperatorDecisions.id, decision.id),
    isNull(externalDeliveryOperatorDecisions.consumedAt),
  )).returning();
  if (!consumed) {
    return { consumed: false, reason: "skip_decision_invalid_or_consumed" };
  }

  await executor.update(externalOutboundDeliveries).set({
    state: "skipped",
    nextAttemptAt: null,
    providerMessageId: null,
    acceptedAt: null,
    leaseGeneration: consumedGeneration,
    stateReason: "operator_audited_skip",
    ...clearLease(),
    updatedAt: now,
  }).where(eq(externalOutboundDeliveries.id, delivery.id));
  await executor.update(externalDeliveryPartitions).set({
    cursorPosition: delivery.partitionPosition,
    ...clearPairWaitUnlessBotRecovery(),
    updatedAt: now,
  }).where(eq(externalDeliveryPartitions.id, input.partitionId));
  return { consumed: true };
}

async function consumedSkipReceiptExists(
  executor: DatabaseExecutor,
  delivery: Delivery,
): Promise<boolean> {
  // Product policy permits dropping a confirmed orphan before any provider
  // attempt. The terminal reason and frozen thread intent are its receipt.
  if ((delivery.stateReason === "destination_deleted" || delivery.stateReason === "destination_deleted_outcome_unconfirmed")
    && parseFrozenSnapshot(delivery)?.bindingAuthority.provider === "slack") return true;
  if (delivery.stateReason === CONFIRMED_THREAD_ROOT_MISSING && delivery.providerAttempts === 0) {
    const frozen = parseFrozenSnapshot(delivery);
    if (frozen?.level === "thread" && frozen.canonicalRootMessageId) return true;
  }
  const [receipt] = await executor.select({ id: externalDeliveryOperatorDecisions.id })
    .from(externalDeliveryOperatorDecisions)
    .where(and(
      eq(externalDeliveryOperatorDecisions.deliveryId, delivery.id),
      eq(externalDeliveryOperatorDecisions.action, "skip"),
      eq(externalDeliveryOperatorDecisions.bindingId, delivery.bindingId),
      eq(externalDeliveryOperatorDecisions.bindingEpoch, delivery.bindingEpoch),
      eq(externalDeliveryOperatorDecisions.partitionPosition, delivery.partitionPosition),
      isNotNull(externalDeliveryOperatorDecisions.consumedAt),
    ))
    .limit(1);
  return !!receipt;
}

async function advanceRecoveredCursor(
  executor: DatabaseExecutor,
  partitionId: string,
  delivery: Delivery,
  deletedDestination = false,
): Promise<void> {
  await executor.update(externalDeliveryPartitions).set({
    cursorPosition: delivery.partitionPosition,
    ...(deletedDestination ? { authorityBlockedAt: null, authorityBlockedReason: null, authorityRetryAt: null,
      authorityOverdueAlertedAt: null } : clearPairWaitUnlessBotRecovery()),
    updatedAt: currentDate(),
  }).where(eq(externalDeliveryPartitions.id, partitionId));
}

function linkValues(
  delivery: Delivery,
  frozenSnapshot: SlackBridgeRenderSnapshot,
  outcome: {
    state: "unknown";
    reason: string;
  } | {
    state: "accepted";
    reason: string;
    providerMessageId: string;
    providerThreadId: string | null;
  },
) {
  const authority = frozenSnapshot.bindingAuthority;
  return {
    deliveryId: delivery.id,
    provider: authority.provider,
    installId: authority.installId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    providerMessageId: outcome.state === "accepted" ? outcome.providerMessageId : null,
    providerThreadId: outcome.state === "accepted" ? outcome.providerThreadId : null,
    bindingId: delivery.bindingId,
    bindingEpoch: delivery.bindingEpoch,
    connectionEpoch: authority.connectionEpoch,
    raftMessageId: delivery.sourceMessageId,
    raftCanonicalRootMessageId: frozenSnapshot.canonicalRootMessageId,
    firstDirection: "raft_outbound" as const,
    payloadFingerprint: delivery.renderSnapshotDigest,
    outcomeState: outcome.state,
    authorityState: "active" as const,
    stateReason: outcome.reason,
    updatedAt: currentDate(),
  };
}

async function upsertLink(
  executor: DatabaseExecutor,
  delivery: Delivery,
  frozenSnapshot: SlackBridgeRenderSnapshot,
  outcome: Parameters<typeof linkValues>[2],
): Promise<void> {
  const values = linkValues(delivery, frozenSnapshot, outcome);
  const [existing] = await executor.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.deliveryId, delivery.id))
    .for("update")
    .limit(1);
  if (existing) {
    const immutableCoordinatesMatch =
      existing.provider === values.provider
      && existing.installId === values.installId
      && existing.providerAuthorityId === values.providerAuthorityId
      && existing.providerConversationId === values.providerConversationId
      && existing.bindingId === values.bindingId
      && existing.bindingEpoch === values.bindingEpoch
      && existing.connectionEpoch === values.connectionEpoch
      && existing.raftMessageId === values.raftMessageId
      && existing.raftCanonicalRootMessageId === values.raftCanonicalRootMessageId
      && existing.firstDirection === values.firstDirection
      && existing.payloadFingerprint === values.payloadFingerprint
      && existing.outcomeState === "unknown"
      && existing.providerMessageId === null
      && existing.providerThreadId === null;
    if (!immutableCoordinatesMatch) {
      throw new Error("External delivery link identity or payload conflicts with frozen delivery");
    }
    await executor.update(externalMessageLinks).set({
      providerMessageId: values.providerMessageId,
      providerThreadId: values.providerThreadId,
      outcomeState: values.outcomeState,
      authorityState: values.authorityState,
      stateReason: values.stateReason,
      updatedAt: values.updatedAt,
    }).where(eq(externalMessageLinks.id, existing.id));
    return;
  }
  await executor.insert(externalMessageLinks).values(values);
}

async function existingLinkMatchesFrozenDelivery(
  executor: DatabaseExecutor,
  delivery: Delivery,
  frozenSnapshot: SlackBridgeRenderSnapshot,
): Promise<boolean> {
  const [existing] = await executor.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.deliveryId, delivery.id))
    .for("update")
    .limit(1);
  if (!existing) return true;
  const expected = linkValues(delivery, frozenSnapshot, {
    state: "unknown",
    reason: "pre_io_identity_check",
  });
  return existing.provider === expected.provider
    && existing.installId === expected.installId
    && existing.providerAuthorityId === expected.providerAuthorityId
    && existing.providerConversationId === expected.providerConversationId
    && existing.bindingId === expected.bindingId
    && existing.bindingEpoch === expected.bindingEpoch
    && existing.connectionEpoch === expected.connectionEpoch
    && existing.raftMessageId === expected.raftMessageId
    && existing.raftCanonicalRootMessageId === expected.raftCanonicalRootMessageId
    && existing.firstDirection === expected.firstDirection
    && existing.payloadFingerprint === expected.payloadFingerprint
    && existing.outcomeState === "unknown"
    && existing.providerMessageId === null
    && existing.providerThreadId === null;
}

async function acceptedLinkMatchesFrozenDelivery(
  executor: DatabaseExecutor,
  delivery: Delivery,
  frozenSnapshot: SlackBridgeRenderSnapshot,
): Promise<boolean> {
  if (!delivery.providerMessageId) return false;
  const [existing] = await executor.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.deliveryId, delivery.id))
    .for("update")
    .limit(1);
  if (!existing) return false;
  const expected = linkValues(delivery, frozenSnapshot, {
    state: "accepted",
    reason: "cursor_recovery_identity_check",
    providerMessageId: delivery.providerMessageId,
    providerThreadId: existing.providerThreadId,
  });
  return existing.provider === expected.provider
    && existing.installId === expected.installId
    && existing.providerAuthorityId === expected.providerAuthorityId
    && existing.providerConversationId === expected.providerConversationId
    && existing.providerMessageId === expected.providerMessageId
    && existing.bindingId === expected.bindingId
    && existing.bindingEpoch === expected.bindingEpoch
    && existing.connectionEpoch === expected.connectionEpoch
    && existing.raftMessageId === expected.raftMessageId
    && existing.raftCanonicalRootMessageId === expected.raftCanonicalRootMessageId
    && existing.firstDirection === expected.firstDirection
    && existing.payloadFingerprint === expected.payloadFingerprint
    && existing.outcomeState === "accepted";
}

async function terminalizeExpiredStartedLease(
  executor: DatabaseExecutor,
  delivery: Delivery,
  attempt: Attempt,
  now: Date,
): Promise<void> {
  const frozenSnapshot = parseFrozenSnapshot(delivery);
  if (!frozenSnapshot) throw new Error("External delivery frozen snapshot is invalid");
  const transition = applySlackBridgeProviderAttemptResult(
    snapshotBeforeCurrentAttempt(delivery),
    { kind: "outcome_ambiguous" },
    now,
  );
  await executor.update(externalDeliveryAttempts).set({
    outcome: "outcome_unknown",
    outcomeReason: LEASE_EXPIRED_AFTER_PROVIDER_IO,
    terminalAt: now,
    updatedAt: now,
  }).where(eq(externalDeliveryAttempts.id, attempt.id));
  await upsertLink(executor, delivery, frozenSnapshot, {
    state: "unknown",
    reason: LEASE_EXPIRED_AFTER_PROVIDER_IO,
  });
  await executor.update(externalOutboundDeliveries).set({
    state: transition.state,
    providerAttempts: transition.providerAttempts,
    ambiguityBudgetProviderAttempts: transition.ambiguityBudgetProviderAttempts,
    dispatchedFailureAttempts: transition.dispatchedFailureAttempts,
    firstDispatchedAt: new Date(transition.firstDispatchedAt!),
    nextAttemptAt: null,
    stateReason: LEASE_EXPIRED_AFTER_PROVIDER_IO,
    ...clearLease(),
    updatedAt: now,
  }).where(eq(externalOutboundDeliveries.id, delivery.id));
}

/** Reclaim only local custody while holding the partition and delivery locks. */
async function reclaimExpiredDispatchLease(executor: DatabaseExecutor, delivery: Delivery, now: Date): Promise<
  | { kind: "owned" }
  | { kind: "terminal_attempt" }
  | { kind: "post_io" }
  | { kind: "pre_io"; delivery: Delivery }
> {
  if (delivery.state !== "dispatching") throw new Error("Cannot reclaim a delivery that is not dispatching");
  if (!delivery.leaseExpiresAt || delivery.leaseExpiresAt.getTime() > now.getTime()) return { kind: "owned" };
  const [attempt] = await executor.select().from(externalDeliveryAttempts)
    .where(and(eq(externalDeliveryAttempts.deliveryId, delivery.id),
      eq(externalDeliveryAttempts.leaseGeneration, delivery.leaseGeneration))).for("update").limit(1);
  if (attempt) {
    if (attempt.outcome !== "provider_io_started") return { kind: "terminal_attempt" };
    await terminalizeExpiredStartedLease(executor, delivery, attempt, now);
    return { kind: "post_io" };
  }
  const [restored] = await executor.update(externalOutboundDeliveries).set({
    ...restoreLeaseOrigin(delivery), stateReason: "lease_reclaimed_before_provider_io", updatedAt: now,
  }).where(eq(externalOutboundDeliveries.id, delivery.id)).returning();
  if (!restored) throw new Error("Expired delivery disappeared while locked");
  return { kind: "pre_io", delivery: restored };
}

async function releaseClaim(
  db: Database,
  deliveryId: string,
  leaseOwner: string,
  leaseGeneration: number,
  now: Date,
  reason: string,
  retryDelayMs = 0,
): Promise<void> {
  await db.transaction(async (executor) => {
    await markSlackAttachmentPlanWriter(executor);
    const [delivery] = await executor.select().from(externalOutboundDeliveries)
      .where(and(
        eq(externalOutboundDeliveries.id, deliveryId),
        eq(externalOutboundDeliveries.state, "dispatching"),
        eq(externalOutboundDeliveries.leaseOwner, leaseOwner),
        eq(externalOutboundDeliveries.leaseGeneration, leaseGeneration),
      )).for("update").limit(1);
    if (!delivery) return;
    const [attempt] = await executor.select({ id: externalDeliveryAttempts.id })
      .from(externalDeliveryAttempts)
      .where(and(
        eq(externalDeliveryAttempts.deliveryId, delivery.id),
        eq(externalDeliveryAttempts.leaseGeneration, delivery.leaseGeneration),
      )).limit(1);
    if (attempt) return;
    await executor.update(externalOutboundDeliveries).set({
      ...restoreLeaseOrigin(delivery),
      stateReason: delivery.leaseOriginState === "outcome_unknown" && retryDelayMs > 0
        ? `reconciliation_wait:${now.getTime() + retryDelayMs}:${reason}`.slice(0, 160) : reason,
      updatedAt: now,
    }).where(eq(externalOutboundDeliveries.id, delivery.id));
  });
}

/** Only admission skips a busy pair; a lease owner waits briefly for its own head. */
async function lockOwnedPartitionAndHead(executor: DatabaseExecutor, bindingId: string, bindingEpoch: number) {
  await executor.execute(sql`SELECT set_config('lock_timeout', '2s', true)`);
  return lockPartitionAndHead(executor, bindingId, bindingEpoch);
}

function isPairQueueLockTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function releaseAuthorityBlockedClaim(input: {
  db: Database;
  deliveryId: string;
  bindingId: string;
  bindingEpoch: number;
  leaseOwner: string;
  leaseGeneration: number;
  now: Date;
  reason: string;
  priorStateReason: string | null;
  retryAfterMs?: number;
}): Promise<ExternalDeliveryWorkerResult> {
  return input.db.transaction(async (executor): Promise<ExternalDeliveryWorkerResult> => {
    const locked = await lockOwnedPartitionAndHead(executor, input.bindingId, input.bindingEpoch);
    const delivery = locked?.delivery;
    if (!delivery || delivery.id !== input.deliveryId || delivery.state !== "dispatching"
      || delivery.leaseOwner !== input.leaseOwner || delivery.leaseGeneration !== input.leaseGeneration) {
      return { kind: "blocked", reason: "authority_block_claim_lost", deliveryId: input.deliveryId };
    }
    const [attempt] = await executor.select({ id: externalDeliveryAttempts.id })
      .from(externalDeliveryAttempts)
      .where(and(
        eq(externalDeliveryAttempts.deliveryId, delivery.id),
        eq(externalDeliveryAttempts.leaseGeneration, delivery.leaseGeneration),
      )).limit(1);
    if (attempt) {
      return { kind: "blocked", reason: "authority_block_after_attempt_start", deliveryId: delivery.id };
    }

    if (parseFrozenSnapshot(delivery)?.bindingAuthority.provider === "slack") {
      const partition = locked!.partition;
      const legacy = parseAuthorityBlockStateReason(input.priorStateReason);
      const since = isSlackControlWaitReason(partition.authorityBlockedReason) ? input.now
        : partition.authorityBlockedAt ?? (legacy?.sinceMs ? new Date(legacy.sinceMs) : input.now);
      const severity = input.now.getTime() - since.getTime() >= EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS ? "overdue" : "retrying";
      const nextRetryAt = new Date(input.now.getTime() + Math.max(authorityBlockBackoffMs(delivery.leaseGeneration),
        Number.isFinite(input.retryAfterMs) ? Math.max(0, input.retryAfterMs!) : 0));
      const changed = partition.authorityBlockedReason !== input.reason || !partition.authorityOverdueAlertedAt;
      await executor.update(externalDeliveryPartitions).set({
        authorityBlockedAt: since, authorityBlockedReason: input.reason, authorityRetryAt: nextRetryAt,
        authorityOverdueAlertedAt: severity === "overdue" ? input.now : null,
        updatedAt: input.now,
      }).where(eq(externalDeliveryPartitions.id, partition.id));
      await executor.update(externalOutboundDeliveries).set({
        ...restoreLeaseOrigin(delivery),
        stateReason: parseAuthorityBlockStateReason(input.priorStateReason) ? null : input.priorStateReason,
        updatedAt: input.now,
      }).where(eq(externalOutboundDeliveries.id, delivery.id));
      return { kind: "authority_blocked", severity, reason: input.reason, deliveryId: delivery.id,
        nextRetryAt: nextRetryAt.toISOString(), ...(severity === "overdue" && changed ? {
          alert: authorityBlockAlert({ ...delivery, stateReason: authorityBlockStateReason("overdue", input.reason, since.getTime()) }, "overdue", input.reason, input.now),
        } : {}) };
    }

    const previous = parseAuthorityBlockStateReason(input.priorStateReason);
    const sinceMs = previous?.sinceMs ?? input.now.getTime();
    const priorBlock = { ...delivery, stateReason: authorityBlockStateReason("retrying", input.reason, sinceMs) };
    const severity = authorityBlockSeverity(priorBlock, input.now);
    const nextReason = authorityBlockStateReason(severity, input.reason, sinceMs);
    const alertTransition = severity !== "retrying"
      && (previous?.severity !== severity || previous.reason !== input.reason);
    const restored = restoreLeaseOrigin(delivery);
    const nextRetryAt = severity === "terminal"
      ? null
      : new Date(input.now.getTime() + authorityBlockBackoffMs(delivery.leaseGeneration));

    await executor.update(externalOutboundDeliveries).set(severity === "terminal" ? {
      state: "quarantined",
      nextAttemptAt: null,
      providerMessageId: null,
      acceptedAt: null,
      stateReason: nextReason,
      ...clearLease(),
      updatedAt: input.now,
    } : {
      ...restored,
      stateReason: nextReason,
      updatedAt: input.now,
    }).where(eq(externalOutboundDeliveries.id, delivery.id));

    return {
      kind: "authority_blocked",
      severity,
      reason: input.reason,
      deliveryId: delivery.id,
      nextRetryAt: nextRetryAt?.toISOString() ?? null,
      ...(alertTransition
        ? { alert: authorityBlockAlert(priorBlock, severity, input.reason, input.now) }
        : {}),
    };
  }).catch(async (error): Promise<ExternalDeliveryWorkerResult> => {
    if (!isPairQueueLockTimeout(error)) throw error;
    // No provider attempt began. Restore custody promptly instead of leaving
    // dispatching work parked until its 60-second lease expires.
    await releaseClaim(input.db, input.deliveryId, input.leaseOwner, input.leaseGeneration,
      input.now, "pair_queue_lock_busy");
    return { kind: "blocked", reason: "pair_queue_lock_busy", deliveryId: input.deliveryId };
  });
}

function adapterResultForPlanner(
  result: ExternalDeliveryProviderResult,
  jitterUnit: number,
): SlackBridgeProviderAttemptResult {
  switch (result.kind) {
    case "accepted": return { kind: "accepted", reconciled: result.reconciled };
    case "rate_limited": return { kind: "rate_limited", retryAfterMs: result.retryAfterMs };
    case "transient_failure": return {
      kind: "transient_failure",
      baseDelayMs: result.baseDelayMs,
      jitterUnit,
    };
    case "deterministic_failure": return { kind: "deterministic_failure" };
    case "outcome_unknown": return { kind: "outcome_ambiguous" };
  }
}

function safeOutcomeReason(result: ExternalDeliveryProviderResult): string {
  if (result.kind === "accepted") {
    return result.reconciled ? "provider_reconciled" : "provider_accepted";
  }
  if (result.kind === "rate_limited") return "provider_rate_limited";
  return validBoundedString(result.reasonCode, 160) ? result.reasonCode : "provider_outcome_invalid";
}

function attemptOutcome(result: ExternalDeliveryProviderResult): Exclude<Attempt["outcome"], "provider_io_started"> {
  return result.kind === "accepted"
    ? "accepted"
    : result.kind === "rate_limited"
    ? "rate_limited"
    : result.kind === "transient_failure"
    ? "transient_failure"
    : result.kind === "deterministic_failure"
    ? "deterministic_failure"
    : "outcome_unknown";
}

export async function processExternalDeliveryPartitionHead(
  input: ProcessExternalDeliveryPartitionHeadInput,
): Promise<ExternalDeliveryWorkerResult> {
  const dependencies = input.dependencies;
  if (!dependencies) return { kind: "disabled" };
  if (!dependencies.prepareProvider && !dependencies.dispatchProvider) {
    return { kind: "disabled" };
  }
  if (!validBoundedString(input.bindingId, 160) || !positiveInteger(input.bindingEpoch)) {
    return { kind: "blocked", reason: "invalid_partition_coordinates" };
  }
  if (!validBoundedString(input.leaseOwner, 160)) {
    return { kind: "blocked", reason: "invalid_lease_owner" };
  }
  const now = dependencies.now?.() ?? currentDate();
  if (!Number.isFinite(now.getTime())) return { kind: "blocked", reason: "invalid_clock" };
  let retryDecisionId = input.retryDecisionId;

  const claim = await input.db.transaction(async (executor): Promise<
    | ExternalDeliveryWorkerResult
    | {
        kind: "claimed";
        delivery: Delivery;
        leaseGeneration: number;
        frozenSnapshot: SlackBridgeRenderSnapshot;
        priorStateReason: string | null;
      }
  > => {
    const locked = await lockPartitionAndHead(executor, input.bindingId, input.bindingEpoch, { skipLocked: true });
    if (!locked) return { kind: "empty" };
    if (!locked.delivery) return { kind: "empty" };
    let delivery = locked.delivery;

    if (delivery.state === "accepted") {
      const frozenSnapshot = parseFrozenSnapshot(delivery);
      if (
        !frozenSnapshot
        || !await acceptedLinkMatchesFrozenDelivery(executor, delivery, frozenSnapshot)
      ) {
        return {
          kind: "blocked",
          reason: "accepted_link_missing_or_conflicting",
          deliveryId: delivery.id,
        };
      }
      await advanceRecoveredCursor(executor, locked.partition.id, delivery);
      return { kind: "cursor_recovered", deliveryId: delivery.id, state: "accepted" };
    }
    if (delivery.state === "skipped") {
      if (!await consumedSkipReceiptExists(executor, delivery)) {
        return { kind: "blocked", reason: "skip_receipt_missing", deliveryId: delivery.id };
      }
      await advanceRecoveredCursor(executor, locked.partition.id, delivery);
      return { kind: "cursor_recovered", deliveryId: delivery.id, state: "skipped" };
    }

    if (delivery.state === "dispatching") {
      const reclaimed = await reclaimExpiredDispatchLease(executor, delivery, now);
      if (reclaimed.kind === "owned") {
        return { kind: "blocked", reason: "lease_owned", deliveryId: delivery.id };
      }
      if (reclaimed.kind === "terminal_attempt") {
        return { kind: "blocked", reason: "terminal_attempt_with_dispatching_delivery", deliveryId: delivery.id };
      }
      if (reclaimed.kind === "post_io") {
        return { kind: "lease_reclaimed", deliveryId: delivery.id, phase: "post_io" };
      }
      delivery = reclaimed.delivery;
    }

    // An unconsumed audited skip for the head wins over every other
    // partition-head state. Operator insertions are the only way to drain a
    // head the automatic state machine cannot move (e.g. a poisoned or
    // no-longer-wanted message), so the tick consumes them directly instead
    // of waiting for a second operator call into
    // consumeExternalDeliverySkipDecision.
    if (
      delivery.state === "queued"
      || delivery.state === "retry_wait"
      || delivery.state === "outcome_unknown"
      || delivery.state === "dead"
      || delivery.state === "quarantined"
    ) {
      const skip = await consumePendingSkipDecision(executor, {
        delivery,
        partitionId: locked.partition.id,
        now,
      });
      if (skip.consumed) {
        return { kind: "skipped", deliveryId: delivery.id };
      }
    }

    const slackSnapshot = parseFrozenSnapshot(delivery);
    const slackQueue = slackSnapshot?.bindingAuthority.provider === "slack";
    if (slackQueue && (await listSlackPairRecoveryWaits(executor, slackSnapshot.bindingAuthority)).length > 0) {
      return { kind: "blocked", reason: "slack_audience_revalidation_required", deliveryId: delivery.id };
    }
    if (slackQueue && delivery.state === "quarantined"
      && (delivery.stateReason === "historical_sender_authority_removed"
        || parseAuthorityBlockStateReason(delivery.stateReason))) {
      const [priorAttempt] = await executor.select({ id: externalDeliveryAttempts.id })
        .from(externalDeliveryAttempts).where(eq(externalDeliveryAttempts.deliveryId, delivery.id)).limit(1);
      if ((delivery.providerAttempts === 0) !== !priorAttempt) {
        return { kind: "blocked", reason: "inconsistent_attempt_history", deliveryId: delivery.id };
      }
      [delivery] = await executor.update(externalOutboundDeliveries).set({
        state: priorAttempt ? "outcome_unknown" : "queued", nextAttemptAt: null,
        stateReason: "legacy_authority_quarantine_recovered", ...clearLease(), updatedAt: now,
      }).where(eq(externalOutboundDeliveries.id, delivery.id)).returning();
    }
    if (slackQueue && locked.partition.authorityRetryAt && locked.partition.authorityRetryAt > now) {
      return { kind: "blocked", reason: "authority_backoff_not_due", deliveryId: delivery.id };
    }

    if ((delivery.stateReason === "provider_thread_receipt_unavailable"
      || delivery.stateReason === "thread_root_missing_after_provider_dispatch")
      && delivery.updatedAt.getTime() + 30_000 > now.getTime()) {
      return { kind: "blocked", reason: "historical_root_backoff_not_due", deliveryId: delivery.id };
    }
    const priorAuthorityBlock = parseAuthorityBlockStateReason(delivery.stateReason);
    if (priorAuthorityBlock) {
      if (
        delivery.state === "queued"
        || delivery.state === "retry_wait"
        || delivery.state === "outcome_unknown"
        || delivery.state === "dead"
      ) {
        const eligibleAt = delivery.updatedAt.getTime()
          + authorityBlockBackoffMs(delivery.leaseGeneration);
        if (eligibleAt > now.getTime()) {
          return {
            kind: "blocked",
            reason: "authority_backoff_not_due",
            deliveryId: delivery.id,
          };
        }
      }
    }

    const frozenSnapshot = parseFrozenSnapshot(delivery);
    if (!frozenSnapshot) {
      return { kind: "blocked", reason: "invalid_frozen_snapshot", deliveryId: delivery.id };
    }
    const state = originState(delivery);
    const reconciliationNotBefore = /^reconciliation_wait:([0-9]{1,16}):/.exec(delivery.stateReason ?? "");
    if (state === "outcome_unknown" && reconciliationNotBefore && Number(reconciliationNotBefore[1]) > now.getTime()) {
      return { kind: "blocked", reason: "reconciliation_backoff_not_due", deliveryId: delivery.id };
    }
    if (!state) return { kind: "blocked", reason: "terminal_partition_head", deliveryId: delivery.id };
    if (state === "outcome_unknown" && delivery.nextAttemptAt && delivery.nextAttemptAt > now) {
      return { kind: "blocked", reason: "reconciliation_not_due", deliveryId: delivery.id };
    }

    if (!retryDecisionId && needsSlackBridgeManualRetry(toPlannerSnapshot(delivery), now)) {
      const [pending] = await executor.select({ id: externalDeliveryOperatorDecisions.id })
        .from(externalDeliveryOperatorDecisions).where(and(
          eq(externalDeliveryOperatorDecisions.deliveryId, delivery.id),
          eq(externalDeliveryOperatorDecisions.bindingId, delivery.bindingId),
          eq(externalDeliveryOperatorDecisions.bindingEpoch, delivery.bindingEpoch),
          eq(externalDeliveryOperatorDecisions.partitionPosition, delivery.partitionPosition),
          eq(externalDeliveryOperatorDecisions.action, "retry_in_place"),
          eq(externalDeliveryOperatorDecisions.duplicateRiskAcknowledged, true),
          isNull(externalDeliveryOperatorDecisions.consumedAt),
        )).orderBy(externalDeliveryOperatorDecisions.createdAt).limit(1);
      retryDecisionId = pending?.id;
    }
    const auditedRetryRequested = !!retryDecisionId;
    if (!auditedRetryRequested) {
      const plan = planSlackBridgePartitionWork({
        delivery: toPlannerSnapshot(delivery),
        partitionCursorPosition: locked.partition.cursorPosition,
        currentRuntimeRevision: delivery.enqueueRuntimeRevision,
        runtimeActive: true,
        now,
      });
      // A write budget cannot prohibit read-only confirmation of an earlier
      // result. Attempt-start planning below still forbids another write.
      if (plan.kind !== "dispatch" && plan.kind !== "reconcile_or_redispatch") {
        return {
          kind: "blocked",
          reason: plan.kind === "blocked" ? plan.reason : "terminal_partition_head",
          deliveryId: delivery.id,
        };
      }
    } else if (state === "retry_wait") {
      if (!delivery.nextAttemptAt || delivery.nextAttemptAt.getTime() > now.getTime()) {
        return { kind: "blocked", reason: "retry_not_due", deliveryId: delivery.id };
      }
    } else if (state !== "dead" && state !== "outcome_unknown") {
      return { kind: "blocked", reason: "audited_retry_not_applicable", deliveryId: delivery.id };
    }

    const leaseGeneration = delivery.leaseGeneration + 1;
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
    const [claimed] = await executor.update(externalOutboundDeliveries).set({
      state: "dispatching",
      nextAttemptAt: null,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      leaseGeneration,
      leaseOriginState: state,
      leaseOriginNextAttemptAt: state === "retry_wait" ? delivery.nextAttemptAt : null,
      stateReason: null,
      updatedAt: now,
    }).where(eq(externalOutboundDeliveries.id, delivery.id)).returning();
    return {
      kind: "claimed",
      delivery: claimed,
      leaseGeneration,
      frozenSnapshot,
      priorStateReason: delivery.stateReason,
    };
  });

  if (claim.kind !== "claimed") return claim;

  const resolvedRuntime = await dependencies.resolveCurrentRuntime({
    deliveryId: claim.delivery.id,
    frozenSnapshot: claim.frozenSnapshot,
  });
  if (resolvedRuntime && "blockedReason" in resolvedRuntime) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now,
      reason: `runtime_authority_inactive_or_mismatched:${resolvedRuntime.blockedReason}`,
      priorStateReason: claim.priorStateReason,
    });
  }
  const runtime = resolvedRuntime;
  if (
    !runtime
    || !sameHardAuthority(runtime.bindingAuthority, claim.frozenSnapshot.bindingAuthority)
  ) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now,
      reason: "runtime_authority_inactive_or_mismatched",
      priorStateReason: claim.priorStateReason,
    });
  }

  const historicalGeneration = runtime.bindingAuthority.bindingId !== claim.frozenSnapshot.bindingAuthority.bindingId
    || runtime.bindingAuthority.bindingEpoch !== claim.frozenSnapshot.bindingAuthority.bindingEpoch
    || runtime.bindingAuthority.installId !== claim.frozenSnapshot.bindingAuthority.installId
    || runtime.bindingAuthority.connectionEpoch !== claim.frozenSnapshot.bindingAuthority.connectionEpoch;
  const quarantineRemovedHistoricalSender = async (executor: DatabaseExecutor, at: Date) => {
    const [quarantined] = await executor.update(externalOutboundDeliveries).set({
      state: "quarantined", stateReason: "historical_sender_authority_removed", nextAttemptAt: null,
      ...clearLease(), updatedAt: at,
    }).where(and(eq(externalOutboundDeliveries.id, claim.delivery.id),
      eq(externalOutboundDeliveries.state, "dispatching"), eq(externalOutboundDeliveries.leaseOwner, input.leaseOwner),
      eq(externalOutboundDeliveries.leaseGeneration, claim.leaseGeneration), gt(externalOutboundDeliveries.leaseExpiresAt, at)))
      .returning({ id: externalOutboundDeliveries.id });
    return !!quarantined;
  };
  const preCredentialAt = dependencies.now?.() ?? currentDate();
  const renderAuthorityCurrent = Number.isFinite(preCredentialAt.getTime())
    && await input.db.transaction((executor) =>
      frozenRenderAuthorityIsCurrent(executor, claim.frozenSnapshot, preCredentialAt)
    );
  if (renderAuthorityCurrent === "sender_removed" && historicalGeneration) {
    await quarantineRemovedHistoricalSender(input.db, preCredentialAt);
    return { kind: "blocked", reason: "historical_sender_authority_removed", deliveryId: claim.delivery.id };
  }
  if (renderAuthorityCurrent !== true) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now: preCredentialAt,
      reason: "frozen_render_authority_inactive_or_mismatched",
      priorStateReason: claim.priorStateReason,
    });
  }

  if (dependencies.prepareBeforeCredential) {
    let preflight: { ready: true } | { ready: false; reason: string };
    try {
      preflight = await dependencies.prepareBeforeCredential({
        deliveryId: claim.delivery.id, frozenSnapshot: claim.frozenSnapshot,
        bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
        leaseOwner: input.leaseOwner, leaseGeneration: claim.leaseGeneration, runtime,
        reconcileUnknownOutcome: claim.delivery.leaseOriginState === "outcome_unknown",
      });
    } catch {
      preflight = { ready: false, reason: "pre_credential_preflight_exception" };
    }
    if (!preflight.ready) {
      const reason = validBoundedString(preflight.reason, 160) ? preflight.reason : "pre_credential_preflight_rejected";
      await releaseClaim(input.db, claim.delivery.id, input.leaseOwner, claim.leaseGeneration,
        dependencies.now?.() ?? currentDate(), reason);
      return { kind: "blocked", reason, deliveryId: claim.delivery.id };
    }
  }

  const credential = await dependencies.leaseCredential({ deliveryId: claim.delivery.id, runtime });
  if (!credential || !sameCredentialAuthority(credential, runtime)) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now,
      reason: "credential_unavailable_or_mismatched",
      priorStateReason: claim.priorStateReason,
    });
  }

  let preparedProvider:
    | Extract<ExternalProviderPreparation<ExternalDeliveryProviderResult>, { ready: true }>
    | null = null;
  if (dependencies.prepareProvider) {
    let preparation: ExternalProviderPreparation<ExternalDeliveryProviderResult>;
    try {
      preparation = await dependencies.prepareProvider({
        deliveryId: claim.delivery.id, leaseOwner: input.leaseOwner, leaseGeneration: claim.leaseGeneration,
        reconciliationMarker: claim.delivery.reconciliationMarker,
        payloadFingerprint: claim.delivery.renderSnapshotDigest,
        frozenSnapshot: claim.frozenSnapshot,
        runtime,
        credentialHandle: credential.handle,
        reconcileUnknownOutcome: claim.delivery.leaseOriginState === "outcome_unknown",
      });
    } catch {
      preparation = { ready: false, reason: "provider_preflight_exception" };
    }
    if (!preparation.ready) {
      const reason = preparation.disposition === "discard" && claim.delivery.providerAttempts > 0
        ? "thread_root_missing_after_provider_dispatch"
        : validBoundedString(preparation.reason, 160) ? preparation.reason : "provider_preflight_rejected";
      await dependencies.releaseCredential?.({
        deliveryId: claim.delivery.id,
        runtime,
        credentialHandle: credential.handle,
        reason,
      });
      if (preparation.disposition !== "discard" && preparation.pairBlockedReason) {
        return releaseAuthorityBlockedClaim({ db: input.db, deliveryId: claim.delivery.id,
          bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
          leaseOwner: input.leaseOwner, leaseGeneration: claim.leaseGeneration,
          now: dependencies.now?.() ?? now, reason: preparation.pairBlockedReason, retryAfterMs: preparation.retryAfterMs,
          priorStateReason: claim.priorStateReason });
      }
      if (preparation.disposition === "discard" && claim.delivery.providerAttempts === 0
        && claim.frozenSnapshot.level === "thread" && claim.frozenSnapshot.canonicalRootMessageId) {
        const discarded = await input.db.transaction(async (executor) => {
          const locked = await lockPartitionAndHead(executor, claim.delivery.bindingId, claim.delivery.bindingEpoch);
          const delivery = locked?.delivery;
          const discardedAt = dependencies.now?.() ?? currentDate();
          if (!locked || !delivery || delivery.id !== claim.delivery.id
            || delivery.state !== "dispatching" || delivery.leaseOwner !== input.leaseOwner
            || delivery.leaseGeneration !== claim.leaseGeneration || delivery.providerAttempts !== 0
            || !delivery.leaseExpiresAt || delivery.leaseExpiresAt <= discardedAt) return false;
          await executor.update(externalOutboundDeliveries).set({
            state: "skipped", stateReason: CONFIRMED_THREAD_ROOT_MISSING,
            nextAttemptAt: null, ...clearLease(), updatedAt: discardedAt,
          }).where(eq(externalOutboundDeliveries.id, delivery.id));
          await executor.update(externalDeliveryPartitions).set({
            cursorPosition: delivery.partitionPosition,
            authorityBlockedAt: null, authorityBlockedReason: null, authorityRetryAt: null, authorityOverdueAlertedAt: null,
            updatedAt: discardedAt,
          }).where(eq(externalDeliveryPartitions.id, locked.partition.id));
          return true;
        });
        if (discarded) {
          console.warn("[SlackBridge] historical dependency discarded", { event: "server.slack_bridge.history.discarded",
            direction: "raft_outbound", bindingId: runtime.bindingAuthority.bindingId,
            operationId: claim.delivery.id, reason: CONFIRMED_THREAD_ROOT_MISSING });
          return { kind: "skipped", deliveryId: claim.delivery.id };
        }
      }
      await releaseClaim(
        input.db,
        claim.delivery.id,
        input.leaseOwner,
        claim.leaseGeneration,
        dependencies.now?.() ?? now,
        reason,
        Number.isFinite(preparation.retryAfterMs) ? Math.max(30_000, preparation.retryAfterMs!) : 30_000,
      );
      return { kind: "blocked", reason, deliveryId: claim.delivery.id };
    }
    if (preparation.receipt) {
      const receipt = preparation.receipt;
      if (!validBoundedString(receipt.providerMessageId, 160)
        || (receipt.providerThreadId != null && !validBoundedString(receipt.providerThreadId, 160))) {
        throw new Error("Reconciled provider receipt identity is invalid");
      }
      await dependencies.releaseCredential?.({ deliveryId: claim.delivery.id, runtime,
        credentialHandle: credential.handle, reason: "provider_reconciled" });
      const recovered = await input.db.transaction(async (executor) => {
        const locked = await lockPartitionAndHead(executor, claim.delivery.bindingId, claim.delivery.bindingEpoch);
        const delivery = locked?.delivery;
        const recoveredAt = dependencies.now?.() ?? currentDate();
        if (!locked || !delivery || delivery.id !== claim.delivery.id || delivery.state !== "dispatching"
          || delivery.leaseOwner !== input.leaseOwner || delivery.leaseGeneration !== claim.leaseGeneration
          || !delivery.leaseExpiresAt || delivery.leaseExpiresAt <= recoveredAt) return false;
        await upsertLink(executor, delivery, claim.frozenSnapshot, { state: "accepted", reason: "provider_reconciled",
          providerMessageId: receipt.providerMessageId, providerThreadId: receipt.providerThreadId ?? null });
        if (claim.frozenSnapshot.attachments.length > 0) {
          await finalizeAcceptedOutboundAttachmentFacts(executor, delivery.id, claim.frozenSnapshot, recoveredAt,
            await readSlackAttachmentSelection(executor, delivery, claim.frozenSnapshot));
        }
        await executor.update(externalOutboundDeliveries).set({
          state: "accepted", providerMessageId: receipt.providerMessageId, acceptedAt: recoveredAt,
          stateReason: "provider_reconciled", nextAttemptAt: null, ...clearLease(), updatedAt: recoveredAt,
        }).where(eq(externalOutboundDeliveries.id, delivery.id));
        await executor.update(externalDeliveryPartitions).set({ cursorPosition: delivery.partitionPosition,
          authorityBlockedAt: null, authorityBlockedReason: null, authorityRetryAt: null, authorityOverdueAlertedAt: null,
          updatedAt: recoveredAt }).where(eq(externalDeliveryPartitions.id, locked.partition.id));
        return true;
      });
      return recovered ? { kind: "cursor_recovered", deliveryId: claim.delivery.id, state: "accepted" }
        : { kind: "blocked", deliveryId: claim.delivery.id, reason: "reconciliation_lease_lost" };
    }
    preparedProvider = preparation;
  }

  try {
    let attemptStartAt = now;
    let attemptStartBlockReason = "attempt_start_authority_lost";
    const attempt = await input.db.transaction(async (executor) => {
      const locked = await lockOwnedPartitionAndHead(executor, claim.delivery.bindingId, claim.delivery.bindingEpoch);
      const delivery = locked?.delivery;
      if (delivery && (delivery.id !== claim.delivery.id || delivery.state !== "dispatching"
        || delivery.leaseOwner !== input.leaseOwner || delivery.leaseGeneration !== claim.leaseGeneration)) return null;
      if (!delivery) {
        attemptStartBlockReason = "attempt_start_authority_lost";
        return null;
      }
      if (attemptRowLockHookForTests) await attemptRowLockHookForTests();
      const freshAttemptStartAt = dependencies.now?.() ?? currentDate();
      if (!Number.isFinite(freshAttemptStartAt.getTime())) {
        attemptStartBlockReason = "invalid_clock";
        return null;
      }
      attemptStartAt = freshAttemptStartAt;
      if (
        !delivery.leaseExpiresAt
        || delivery.leaseExpiresAt.getTime() <= attemptStartAt.getTime()
      ) {
        attemptStartBlockReason = "lease_expired_before_attempt_start";
        return null;
      }
      // These ceilings stop automatic work. An exact manager decision permits
      // one more attempt, without resetting history or weakening authority checks.
      if (!retryDecisionId && (
        delivery.dispatchedFailureAttempts >= SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS
        || (
          claim.frozenSnapshot.bindingAuthority.provider !== "slack"
          && delivery.firstDispatchedAt !== null
          && attemptStartAt.getTime() - delivery.firstDispatchedAt.getTime()
            >= SLACK_BRIDGE_MAX_DELIVERY_AGE_MS
        )
      )) {
        attemptStartBlockReason = "delivery_budget_exhausted";
        return null;
      }
      if (!retryDecisionId) {
        if (!delivery.leaseOriginState) {
          attemptStartBlockReason = "claim_origin_missing";
          return null;
        }
        const automaticPlan = planSlackBridgePartitionWork({
          delivery: {
            ...toPlannerSnapshot(delivery),
            state: delivery.leaseOriginState,
            nextAttemptAt: delivery.leaseOriginNextAttemptAt?.toISOString() ?? null,
          },
          partitionCursorPosition: delivery.partitionPosition - 1,
          currentRuntimeRevision: delivery.enqueueRuntimeRevision,
          runtimeActive: true,
          now: attemptStartAt,
        });
        if (
          automaticPlan.kind !== "dispatch"
          && !(
            automaticPlan.kind === "reconcile_or_redispatch"
            && automaticPlan.automaticRedispatchAllowed
          )
        ) {
          attemptStartBlockReason = automaticPlan.kind === "blocked"
            ? automaticPlan.reason
            : "automatic_dispatch_not_authorized";
          return null;
        }
      }
      if (!await existingLinkMatchesFrozenDelivery(executor, delivery, claim.frozenSnapshot)) {
        attemptStartBlockReason = "link_identity_or_payload_conflict";
        return null;
      }
      const renderAuthority = await frozenRenderAuthorityIsCurrent(executor, claim.frozenSnapshot, attemptStartAt);
      if (renderAuthority === "sender_removed" && historicalGeneration) {
        await quarantineRemovedHistoricalSender(executor, attemptStartAt);
        attemptStartBlockReason = "historical_sender_authority_removed";
        return null;
      }
      if (renderAuthority !== true) {
        attemptStartBlockReason = "frozen_render_authority_inactive_or_mismatched";
        return null;
      }

      let decision: typeof externalDeliveryOperatorDecisions.$inferSelect | null = null;
      if (retryDecisionId) {
        [decision] = await executor.select().from(externalDeliveryOperatorDecisions)
          .where(and(
            eq(externalDeliveryOperatorDecisions.id, retryDecisionId),
            eq(externalDeliveryOperatorDecisions.deliveryId, delivery.id),
            eq(externalDeliveryOperatorDecisions.bindingId, delivery.bindingId),
            eq(externalDeliveryOperatorDecisions.bindingEpoch, delivery.bindingEpoch),
            eq(externalDeliveryOperatorDecisions.partitionPosition, delivery.partitionPosition),
            eq(externalDeliveryOperatorDecisions.action, "retry_in_place"),
            eq(externalDeliveryOperatorDecisions.duplicateRiskAcknowledged, true),
            isNull(externalDeliveryOperatorDecisions.consumedAt),
          )).for("update").limit(1);
        if (!decision) {
          attemptStartBlockReason = "audited_retry_decision_invalid_or_consumed";
          return null;
        }
      }

      const attemptNumber = delivery.providerAttempts + 1;
      const startedAt = attemptStartAt;
      if (decision) {
        const [consumed] = await executor.update(externalDeliveryOperatorDecisions).set({
          consumedAt: startedAt,
          consumedLeaseGeneration: delivery.leaseGeneration,
        }).where(and(
          eq(externalDeliveryOperatorDecisions.id, decision.id),
          isNull(externalDeliveryOperatorDecisions.consumedAt),
        )).returning();
        if (!consumed) {
          attemptStartBlockReason = "audited_retry_decision_invalid_or_consumed";
          return null;
        }
      }
      await executor.update(externalOutboundDeliveries).set({
        providerAttempts: attemptNumber,
        firstDispatchedAt: delivery.firstDispatchedAt ?? startedAt,
        updatedAt: startedAt,
      }).where(eq(externalOutboundDeliveries.id, delivery.id));
      const [inserted] = await executor.insert(externalDeliveryAttempts).values({
        id: randomUUID(),
        deliveryId: delivery.id,
        attemptNumber,
        leaseGeneration: delivery.leaseGeneration,
        runtimeRevision: runtime.runtimeRevision,
        credentialRevision: credential.credentialRevision,
        dispatchAuthorization: decision ? "audited_retry_in_place" : "automatic",
        operatorDecisionId: decision?.id ?? null,
        operatorDecisionAction: decision ? "retry_in_place" : null,
        providerIoStartedAt: startedAt,
      }).returning();
      return inserted;
    }).catch((error) => {
      if (!isPairQueueLockTimeout(error)) throw error;
      attemptStartBlockReason = "pair_queue_lock_busy";
      return null;
    });

    if (!attempt) {
      await dependencies.releaseCredential?.({
        deliveryId: claim.delivery.id,
        runtime,
        credentialHandle: credential.handle,
        reason: attemptStartBlockReason,
      });
      if (isAuthorityBlockReason(attemptStartBlockReason)) {
        return releaseAuthorityBlockedClaim({
          db: input.db,
          deliveryId: claim.delivery.id,
          bindingId: claim.delivery.bindingId, bindingEpoch: claim.delivery.bindingEpoch,
          leaseOwner: input.leaseOwner,
          leaseGeneration: claim.leaseGeneration,
          now: attemptStartAt,
          reason: attemptStartBlockReason,
          priorStateReason: claim.priorStateReason,
        });
      }
      await releaseClaim(
        input.db,
        claim.delivery.id,
        input.leaseOwner,
        claim.leaseGeneration,
        attemptStartAt,
        attemptStartBlockReason,
        claim.delivery.leaseOriginState === "outcome_unknown" && preparedProvider ? 30_000 : 0,
      );
      return { kind: "blocked", reason: attemptStartBlockReason, deliveryId: claim.delivery.id };
    }

    let providerResult: ExternalDeliveryProviderResult;
    try {
      providerResult = preparedProvider
        ? await preparedProvider.dispatch()
        : await dependencies.dispatchProvider!({
            deliveryId: claim.delivery.id,
            reconciliationMarker: claim.delivery.reconciliationMarker,
            payloadFingerprint: claim.delivery.renderSnapshotDigest,
            frozenSnapshot: claim.frozenSnapshot,
            runtime,
            credentialHandle: credential.handle,
          });
    } catch {
      providerResult = { kind: "outcome_unknown", reasonCode: SAFE_PROVIDER_IO_EXCEPTION };
    }

    const outcomeAt = dependencies.now?.() ?? currentDate();
    const jitterUnit = dependencies.jitterUnit?.() ?? currentRandomUnit();
    const outcome = attemptOutcome(providerResult);
    const reason = safeOutcomeReason(providerResult);
    const finalDelivery = await input.db.transaction(async (executor) => {
      await markSlackAttachmentPlanWriter(executor);
      const delivery = await lockOutcomePartitionAndDelivery(executor, {
        deliveryId: claim.delivery.id,
        bindingId: claim.delivery.bindingId,
        bindingEpoch: claim.delivery.bindingEpoch,
        leaseOwner: input.leaseOwner,
        leaseGeneration: claim.leaseGeneration,
      });
      if (!delivery) throw new Error("External delivery outcome lost exact lease authority");
      const [startedAttempt] = await executor.select().from(externalDeliveryAttempts)
        .where(and(
          eq(externalDeliveryAttempts.id, attempt.id),
          eq(externalDeliveryAttempts.deliveryId, delivery.id),
          eq(externalDeliveryAttempts.leaseGeneration, delivery.leaseGeneration),
          eq(externalDeliveryAttempts.outcome, "provider_io_started"),
        )).for("update").limit(1);
      if (!startedAttempt) throw new Error("External delivery outcome lost started attempt");

      let transition = applySlackBridgeProviderAttemptResult(
        snapshotBeforeCurrentAttempt(delivery),
        adapterResultForPlanner(providerResult, jitterUnit),
        outcomeAt,
      );
      if (claim.frozenSnapshot.bindingAuthority.provider === "slack"
        && providerResult.kind === "deterministic_failure" && providerResult.pairBlockedReason) {
        const [partition] = await executor.select().from(externalDeliveryPartitions).where(and(
          eq(externalDeliveryPartitions.bindingId, delivery.bindingId),
          eq(externalDeliveryPartitions.bindingEpoch, delivery.bindingEpoch),
        )).limit(1);
        if (!partition) throw new Error("External delivery pair queue missing");
        await executor.update(externalDeliveryPartitions).set({
          authorityBlockedAt: isSlackControlWaitReason(partition.authorityBlockedReason) ? outcomeAt : partition.authorityBlockedAt ?? outcomeAt,
          authorityBlockedReason: providerResult.pairBlockedReason,
          authorityRetryAt: new Date(outcomeAt.getTime() + authorityBlockBackoffMs(delivery.leaseGeneration)),
          updatedAt: outcomeAt,
        }).where(eq(externalDeliveryPartitions.id, partition.id));
        transition = { ...transition, state: "outcome_unknown", nextAttemptAt: null,
          ambiguityBudgetProviderAttempts: delivery.ambiguityBudgetProviderAttempts,
          dispatchedFailureAttempts: delivery.dispatchedFailureAttempts,
          reason: "provider_outcome_ambiguous", automaticRedispatchAllowed: false };
      }
      if (claim.frozenSnapshot.bindingAuthority.provider === "slack"
        && !(providerResult.kind === "deterministic_failure" && providerResult.pairBlockedReason)) {
        await executor.update(externalDeliveryPartitions).set({ authorityBlockedAt: null,
          authorityBlockedReason: null, authorityRetryAt: null, authorityOverdueAlertedAt: null,
        }).where(and(eq(externalDeliveryPartitions.bindingId, delivery.bindingId),
          eq(externalDeliveryPartitions.bindingEpoch, delivery.bindingEpoch)));
      }
      await executor.update(externalDeliveryAttempts).set({
        outcome,
        outcomeReason: reason,
        retryAfterMs: providerResult.kind === "rate_limited" ? providerResult.retryAfterMs : null,
        terminalAt: outcomeAt,
        updatedAt: outcomeAt,
      }).where(eq(externalDeliveryAttempts.id, attempt.id));

      if (providerResult.kind === "accepted") {
        if (!validBoundedString(providerResult.providerMessageId, 160)) {
          throw new Error("Provider acceptance identity is invalid");
        }
        if (
          providerResult.providerThreadId !== undefined
          && providerResult.providerThreadId !== null
          && !validBoundedString(providerResult.providerThreadId, 160)
        ) throw new Error("Provider thread identity is invalid");
        await upsertLink(executor, delivery, claim.frozenSnapshot, {
          state: "accepted",
          reason,
          providerMessageId: providerResult.providerMessageId,
          providerThreadId: providerResult.providerThreadId ?? null,
        });
        if (claim.frozenSnapshot.attachments.length > 0) {
          await finalizeAcceptedOutboundAttachmentFacts(
            executor,
            delivery.id,
            claim.frozenSnapshot,
            outcomeAt,
            await readSlackAttachmentSelection(executor, delivery, claim.frozenSnapshot),
          );
        }
        if (acceptedTransactionHookForTests) await acceptedTransactionHookForTests();
        const [partition] = await executor.select().from(externalDeliveryPartitions)
          .where(and(
            eq(externalDeliveryPartitions.bindingId, delivery.bindingId),
            eq(externalDeliveryPartitions.bindingEpoch, delivery.bindingEpoch),
          )).for("update").limit(1);
        if (!partition || partition.cursorPosition + 1 !== delivery.partitionPosition) {
          throw new Error("External delivery acceptance lost exact partition head");
        }
        await executor.update(externalDeliveryPartitions).set({
          cursorPosition: delivery.partitionPosition,
          updatedAt: outcomeAt,
        }).where(eq(externalDeliveryPartitions.id, partition.id));
      } else if (providerResult.kind === "outcome_unknown"
        || (claim.frozenSnapshot.bindingAuthority.provider === "slack" && providerResult.kind === "deterministic_failure" && providerResult.pairBlockedReason)) {
        await upsertLink(executor, delivery, claim.frozenSnapshot, {
          state: "unknown",
          reason,
        });
      }

      const [updated] = await executor.update(externalOutboundDeliveries).set({
        state: transition.state,
        providerAttempts: transition.providerAttempts,
        ambiguityBudgetProviderAttempts: transition.ambiguityBudgetProviderAttempts,
        dispatchedFailureAttempts: transition.dispatchedFailureAttempts,
        firstDispatchedAt: transition.firstDispatchedAt
          ? new Date(transition.firstDispatchedAt)
          : null,
        nextAttemptAt: transition.nextAttemptAt ? new Date(transition.nextAttemptAt) : null,
        providerMessageId: providerResult.kind === "accepted" ? providerResult.providerMessageId : null,
        acceptedAt: providerResult.kind === "accepted" ? outcomeAt : null,
        stateReason: transition.reason,
        ...clearLease(),
        updatedAt: outcomeAt,
      }).where(eq(externalOutboundDeliveries.id, delivery.id)).returning();
      return updated;
    });

    return {
      kind: "attempted",
      deliveryId: finalDelivery.id,
      attemptNumber: attempt.attemptNumber,
      outcome,
      deliveryState: finalDelivery.state,
    };
  } finally {
    await preparedProvider?.dispose?.();
  }
}

export async function consumeExternalDeliverySkipDecision(
  input: ConsumeExternalDeliverySkipDecisionInput,
): Promise<{ kind: "skipped"; deliveryId: string } | { kind: "blocked"; reason: string }> {
  const now = input.now ?? currentDate();
  return input.db.transaction(async (executor) => {
    const locked = await lockPartitionAndHead(executor, input.bindingId, input.bindingEpoch);
    if (!locked) return { kind: "blocked", reason: "partition_head_missing" };
    const delivery = locked.delivery;
    if (!delivery) return { kind: "blocked", reason: "partition_head_missing" };
    if (delivery.state === "dispatching") return { kind: "blocked", reason: "lease_owned" };
    if (delivery.state === "accepted" || delivery.state === "skipped") {
      return { kind: "blocked", reason: "already_terminal" };
    }
    const consumed = await consumePendingSkipDecision(executor, {
      delivery,
      partitionId: locked.partition.id,
      now,
      decisionId: input.decisionId,
    });
    if (!consumed.consumed) {
      return { kind: "blocked", reason: consumed.reason ?? "skip_decision_invalid_or_consumed" };
    }
    return { kind: "skipped", deliveryId: delivery.id };
  });
}

/** The caller authorizes the manager; the partition lock makes double-clicks idempotent. */
export async function recordExternalDeliveryRetryDecision(input: {
  executor: DatabaseExecutor;
  bindingId: string;
  bindingEpoch: number;
  deliveryId: string;
  expectedProviderAttempts: number;
  actorId: string;
  now: Date;
}): Promise<boolean> {
  const locked = await lockPartitionAndHead(input.executor, input.bindingId, input.bindingEpoch);
  const [existing] = await input.executor.select().from(externalDeliveryOperatorDecisions).where(and(
    eq(externalDeliveryOperatorDecisions.deliveryId, input.deliveryId),
    eq(externalDeliveryOperatorDecisions.bindingId, input.bindingId),
    eq(externalDeliveryOperatorDecisions.bindingEpoch, input.bindingEpoch),
    eq(externalDeliveryOperatorDecisions.action, "retry_in_place"),
    eq(externalDeliveryOperatorDecisions.decisionRevision, input.expectedProviderAttempts + 1),
  )).limit(1);
  // A replay remains the same operation even after its attempt finished or the
  // FIFO advanced. A fresh UI observation is required to authorize another one.
  if (existing) return true;
  const delivery = locked?.delivery;
  if (!delivery || delivery.id !== input.deliveryId
    || delivery.providerAttempts !== input.expectedProviderAttempts
    || !needsSlackBridgeManualRetry(toPlannerSnapshot(delivery), input.now)) return false;
  await input.executor.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: delivery.id,
    bindingId: delivery.bindingId,
    bindingEpoch: delivery.bindingEpoch,
    partitionPosition: delivery.partitionPosition,
    action: "retry_in_place",
    actorType: "user",
    actorId: input.actorId,
    reason: "manager_requested_delivery_retry",
    duplicateRiskAcknowledged: true,
    dataLossAcknowledged: false,
    decisionRevision: input.expectedProviderAttempts + 1,
    createdAt: input.now,
  });
  return true;
}


const SLACK_CONTROL_WAIT_REASONS = ["master_disabled", "binding_paused", "binding_paused_archived", "binding_paused_bot_removed", "binding_quarantined", "installation_inactive"] as const;
export type SlackControlWaitReason = (typeof SLACK_CONTROL_WAIT_REASONS)[number];

export function isSlackControlWaitReason(reason: string | null): reason is SlackControlWaitReason {
  return SLACK_CONTROL_WAIT_REASONS.some((candidate) => candidate === reason);
}

export interface SlackPairQueueControlScope {
  registrationId: string;
  currentBindingId: string;
  currentBindingEpoch: number;
  bindingId: string;
  bindingEpoch: number;
}

async function currentSlackPairControl(executor: DatabaseExecutor, scope: SlackPairQueueControlScope) {
  const [row] = await executor.select({
    state: externalChannelBindings.state, stateReason: externalChannelBindings.stateReason,
    channelId: externalChannelBindings.channelId, providerConversationId: externalChannelBindings.providerConversationId,
    installState: externalAppInstalls.state, workspaceId: externalAppInstalls.providerAuthorityId,
    providerAppId: externalAppInstalls.providerAppId,
    environment: externalAppRegistrations.environment,
  }).from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .innerJoin(externalAppRegistrations, and(eq(externalAppRegistrations.id, externalChannelBindings.registrationId),
      eq(externalAppRegistrations.providerAppId, externalAppInstalls.providerAppId)))
    .where(and(eq(externalChannelBindings.id, scope.currentBindingId),
      eq(externalChannelBindings.bindingEpoch, scope.currentBindingEpoch),
      eq(externalChannelBindings.registrationId, scope.registrationId), eq(externalAppRegistrations.provider, "slack")))
    .limit(1);
  return row ?? null;
}

/** Record an administrative pause without claiming a delivery or touching attempts. */
export async function recordSlackPairControlWait(input: SlackPairQueueControlScope & {
  db: Database; reason: SlackControlWaitReason; now: Date;
}): Promise<ExternalDeliveryWorkerResult> {
  return input.db.transaction(async (tx) => {
    const locked = await lockPartitionAndHead(tx, input.bindingId, input.bindingEpoch, { skipLocked: true });
    if (!locked?.delivery) return { kind: "empty" };
    const pair = await currentSlackPairControl(tx, input);
    const reasonStillCurrent = pair && (input.reason === "master_disabled"
      || (input.reason === "installation_inactive" ? pair.installState !== "active"
        : input.reason === "binding_paused_archived" ? pair.state === "paused" && pair.stateReason === "provider_channel_archived"
          : input.reason === "binding_paused_bot_removed" ? pair.state === "paused" && pair.stateReason === "provider_bot_removed"
          : pair.state === (input.reason === "binding_paused" ? "paused" : "quarantined")));
    if (!reasonStillCurrent) return { kind: "blocked", reason: "pair_control_changed", deliveryId: locked.delivery.id };
    if (locked.delivery.state === "dispatching") {
      const reclaimed = await reclaimExpiredDispatchLease(tx, locked.delivery, input.now);
      if (reclaimed.kind === "owned") return { kind: "blocked", reason: "lease_owned", deliveryId: locked.delivery.id };
      if (reclaimed.kind === "terminal_attempt") {
        return { kind: "blocked", reason: "terminal_attempt_with_dispatching_delivery", deliveryId: locked.delivery.id };
      }
    }
    // An already observed provider/authority failure remains the more specific
    // reason while maintenance is off. Do not erase its recovery cooldown.
    const previous = locked.partition.authorityBlockedReason;
    const controlReason = !isSlackBotRecoveryWaitReason(previous) && (!previous || isSlackControlWaitReason(previous)
      || ((input.reason === "binding_paused_archived" || input.reason === "binding_paused")
        && pair.stateReason === "provider_channel_archived" && previous === "slack_channel_archived"));
    const reason = controlReason
      ? pair.stateReason === "provider_channel_archived" && input.reason === "binding_paused" ? "binding_paused_archived" : input.reason
      : previous ?? input.reason;
    const since = locked.partition.authorityBlockedAt ?? input.now;
    const overdue = input.now.getTime() - since.getTime() >= EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS;
    if (!previous || reason !== previous || !locked.partition.authorityBlockedAt) {
      await tx.update(externalDeliveryPartitions).set({ authorityBlockedAt: since, authorityBlockedReason: reason,
        ...(controlReason ? { authorityRetryAt: null } : {}),
        updatedAt: input.now,
      }).where(eq(externalDeliveryPartitions.id, locked.partition.id));
    }
    return { kind: "authority_blocked", deliveryId: locked.delivery.id, severity: overdue ? "overdue" : "retrying", reason,
      nextRetryAt: controlReason ? null : locked.partition.authorityRetryAt?.toISOString() ?? null,
    };
  });
}

/** A resumed control cannot leave an obsolete pause banner over a manual/dead head. */
export async function clearResumedSlackPairControlWait(input: SlackPairQueueControlScope & {
  db: Database; now: Date;
  /** Only a fenced positive conversations.info observation can clear provider membership/archive errors. */
  verifiedConversationAvailable?: true;
}): Promise<void> {
  await input.db.transaction(async (tx) => {
    const locked = await lockPartitionAndHead(tx, input.bindingId, input.bindingEpoch, { skipLocked: true });
    if (!locked) return;
    const reason = locked.partition.authorityBlockedReason;
    if (isSlackBotRecoveryWaitReason(reason)) return;
    if (!isSlackControlWaitReason(reason) && !(input.verifiedConversationAvailable
      && (reason === "slack_not_in_channel" || reason === "slack_channel_archived"))) return;
    if (locked.delivery?.state === "dispatching") return;
    const pair = await currentSlackPairControl(tx, input);
    if (!pair || pair.state !== "active" || pair.installState !== "active") return;
    await tx.update(externalDeliveryPartitions).set({ authorityBlockedAt: null, authorityBlockedReason: null,
      authorityRetryAt: null, authorityOverdueAlertedAt: null, updatedAt: input.now,
    }).where(eq(externalDeliveryPartitions.id, locked.partition.id));
  });
}

/** Batch-repair stale empty clocks; the cursor predicate fences racing admissions. */
export async function clearEmptySlackPairWaits(input: {
  db: Database; bindings: readonly { bindingId: string; bindingEpoch: number }[]; now: Date;
}): Promise<void> {
  if (!input.bindings.length) return;
  await input.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: null, authorityBlockedReason: null,
    authorityRetryAt: null, authorityOverdueAlertedAt: null, updatedAt: input.now,
  }).where(and(or(...input.bindings.map((binding) => and(
    eq(externalDeliveryPartitions.bindingId, binding.bindingId), eq(externalDeliveryPartitions.bindingEpoch, binding.bindingEpoch)))),
    eq(externalDeliveryPartitions.cursorPosition, externalDeliveryPartitions.lastEnqueuedPosition),
    or(isNull(externalDeliveryPartitions.authorityBlockedReason),
      notInArray(externalDeliveryPartitions.authorityBlockedReason, [...SLACK_BOT_RECOVERY_WAIT_REASONS])),
    isNotNull(externalDeliveryPartitions.authorityBlockedAt)));
}

/** Trusted lifecycle deletion is different from a provider access error. This is local I/O only. */
export async function cleanupDeletedSlackPairHead(input: SlackPairQueueControlScope & {
  db: Database; now: Date;
}): Promise<ExternalDeliveryWorkerResult> {
  let audit: { reason: string; providerAttempts: number; providerConversationId: string } | undefined;
  const result = await input.db.transaction(async (tx): Promise<ExternalDeliveryWorkerResult> => {
    const locked = await lockPartitionAndHead(tx, input.bindingId, input.bindingEpoch, { skipLocked: true });
    if (!locked?.delivery) return { kind: "empty" };
    const { delivery } = locked;
    const pair = await currentSlackPairControl(tx, input);
    const deletion = pair && await loadSlackChannelDeletionEvidence(tx, {
      registrationId: input.registrationId, environment: pair.environment, providerAppId: pair.providerAppId,
      providerAuthorityId: pair.workspaceId, providerConversationId: pair.providerConversationId,
    });
    if (!pair || !deletion) {
      return { kind: "blocked", reason: "destination_deletion_unconfirmed", deliveryId: delivery.id };
    }
    const frozen = parseFrozenSnapshot(delivery);
    const conflict = async (reason: string): Promise<ExternalDeliveryWorkerResult> => {
      await tx.update(externalDeliveryPartitions).set({
        authorityBlockedAt: isSlackControlWaitReason(locked.partition.authorityBlockedReason) ? input.now
          : locked.partition.authorityBlockedAt ?? input.now,
        authorityBlockedReason: reason, authorityRetryAt: new Date(input.now.getTime() + 60_000), updatedAt: input.now,
      }).where(eq(externalDeliveryPartitions.id, locked.partition.id));
      audit = { reason, providerAttempts: delivery.providerAttempts, providerConversationId: pair.providerConversationId };
      return { kind: "blocked", reason, deliveryId: delivery.id };
    };
    if (!frozen) return conflict("destination_cleanup_custody_conflict");
    const scope = frozen.bindingAuthority;
    if (scope.provider !== "slack" || scope.appRegistrationId !== input.registrationId
      || scope.environment !== pair.environment || scope.providerAuthorityId !== pair.workspaceId
      || scope.providerConversationId !== pair.providerConversationId || scope.raftChannelId !== pair.channelId) {
      return conflict("destination_cleanup_custody_conflict");
    }
    if (delivery.state === "dispatching" && (!delivery.leaseExpiresAt || delivery.leaseExpiresAt > input.now)) {
      return { kind: "blocked", reason: "lease_owned", deliveryId: delivery.id };
    }
    // Terminalize unfinished attempt evidence without changing its original
    // coordinates. An expired provider writer remains fenced from the delivery.
    await tx.update(externalDeliveryAttempts).set({ outcome: "outcome_unknown", outcomeReason: "destination_deleted",
      retryAfterMs: null, terminalAt: input.now, updatedAt: input.now,
    }).where(and(eq(externalDeliveryAttempts.deliveryId, delivery.id), eq(externalDeliveryAttempts.outcome, "provider_io_started")));
    if (delivery.state === "skipped" && await consumedSkipReceiptExists(tx, delivery)) {
      await advanceRecoveredCursor(tx, locked.partition.id, delivery, true);
      audit = { reason: delivery.stateReason ?? "existing_skip_receipt", providerAttempts: delivery.providerAttempts,
        providerConversationId: pair.providerConversationId };
      return { kind: "cursor_recovered", deliveryId: delivery.id, state: "skipped" };
    }
    const [link] = await tx.select().from(externalMessageLinks).where(eq(externalMessageLinks.deliveryId, delivery.id)).for("update").limit(1);
    let acceptedId = delivery.state === "accepted" ? delivery.providerMessageId : null;
    if (!acceptedId && link?.outcomeState === "accepted" && link.providerMessageId
      && await acceptedLinkMatchesFrozenDelivery(tx, { ...delivery, providerMessageId: link.providerMessageId }, frozen)) {
      acceptedId = link.providerMessageId;
    }
    if (acceptedId) {
      if (delivery.providerAttempts < 1) return conflict("accepted_receipt_counter_conflict");
      await tx.update(externalOutboundDeliveries).set({ state: "accepted", providerMessageId: acceptedId,
        acceptedAt: delivery.acceptedAt ?? input.now, nextAttemptAt: null,
        leaseGeneration: delivery.leaseGeneration + 1,
        ...clearLease(), updatedAt: input.now,
      }).where(eq(externalOutboundDeliveries.id, delivery.id));
      await advanceRecoveredCursor(tx, locked.partition.id, delivery, true);
      audit = { reason: "destination_deleted_accepted_receipt", providerAttempts: delivery.providerAttempts,
        providerConversationId: pair.providerConversationId };
      return { kind: "cursor_recovered", deliveryId: delivery.id, state: "accepted" };
    }
    const [attempt] = await tx.select({ id: externalDeliveryAttempts.id }).from(externalDeliveryAttempts)
      .where(eq(externalDeliveryAttempts.deliveryId, delivery.id)).limit(1);
    const reason = delivery.providerAttempts > 0 || attempt ? "destination_deleted_outcome_unconfirmed" : "destination_deleted";
    await tx.update(externalOutboundDeliveries).set({ state: "skipped", providerMessageId: null, acceptedAt: null,
      nextAttemptAt: null, stateReason: reason, leaseGeneration: delivery.leaseGeneration + 1,
      ...clearLease(), updatedAt: input.now,
    }).where(eq(externalOutboundDeliveries.id, delivery.id));
    await advanceRecoveredCursor(tx, locked.partition.id, delivery, true);
    audit = { reason, providerAttempts: delivery.providerAttempts, providerConversationId: pair.providerConversationId };
    return { kind: "skipped", deliveryId: delivery.id };
  });
  if (audit && (result.kind === "skipped" || result.kind === "cursor_recovered" || result.kind === "blocked")) {
    console.warn("[SlackBridge] deleted destination queue result", { event: "server.slack_bridge.destination.cleaned",
      registrationId: input.registrationId, bindingId: input.currentBindingId, bindingEpoch: input.currentBindingEpoch,
      deliveryId: result.deliveryId, ...audit,
      outcome: result.kind === "blocked" ? "blocked"
        : result.kind === "cursor_recovered" && result.state === "accepted" ? "accepted_receipt"
          : audit.reason === "operator_audited_skip" ? "operator_skip" : "discarded" });
  }
  return result;
}
