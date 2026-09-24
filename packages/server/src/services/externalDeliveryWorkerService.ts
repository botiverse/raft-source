import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  isNotNull,
  isNull,
} from "drizzle-orm";
import {
  applySlackBridgeProviderAttemptResult,
  currentDate,
  currentRandomUnit,
  planSlackBridgePartitionWork,
  SLACK_BRIDGE_MAX_DELIVERY_AGE_MS,
  SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS,
  type SlackBridgeOutboundDeliverySnapshot,
  type SlackBridgeProviderAttemptResult,
} from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor } from "../db/index.js";
import {
  externalAddressabilityProjections,
  externalAuthorPolicies,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalMentionFacts,
  externalOutboundDeliveries,
  externalProjectionAvatarArtifacts,
} from "../db/schema.js";
import type {
  ProviderNeutralOutboundBindingAuthority,
  SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService.js";
import { finalizeAcceptedOutboundAttachmentFacts } from "./externalOutboundAttachmentCoordinator.js";

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

export interface ActiveExternalDeliveryRuntime {
  runtimeRevision: string;
  bindingAuthority: ProviderNeutralOutboundBindingAuthority;
  attachmentTransferEnabled?: boolean;
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
  | { kind: "deterministic_failure"; reasonCode: string }
  | { kind: "outcome_unknown"; reasonCode: string };

export interface ExternalDeliveryWorkerDependencies {
  resolveCurrentRuntime(input: {
    deliveryId: string;
    frozenSnapshot: SlackBridgeRenderSnapshot;
  }): Promise<ActiveExternalDeliveryRuntime | null>;
  leaseCredential(input: {
    deliveryId: string;
    runtime: ActiveExternalDeliveryRuntime;
  }): Promise<ExternalDeliveryCredentialLease | null>;
  prepareProvider?(input: {
    deliveryId: string;
    reconciliationMarker: string;
    payloadFingerprint: string;
    frozenSnapshot: SlackBridgeRenderSnapshot;
    runtime: ActiveExternalDeliveryRuntime;
    credentialHandle: unknown;
    reconcileUnknownOutcome: boolean;
  }): Promise<
    | { ready: false; reason: string }
    | { ready: true; dispatch(): Promise<ExternalDeliveryProviderResult> }
  >;
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
): string {
  return `${AUTHORITY_BLOCK_STATE_PREFIX[severity]}${reason}`.slice(0, 160);
}

function parseAuthorityBlockStateReason(value: string | null): {
  severity: "retrying" | "overdue" | "terminal";
  reason: string;
} | null {
  if (!value) return null;
  for (const severity of ["retrying", "overdue", "terminal"] as const) {
    const prefix = AUTHORITY_BLOCK_STATE_PREFIX[severity];
    if (value.startsWith(prefix)) {
      const reason = value.slice(prefix.length);
      return reason ? { severity, reason } : null;
    }
  }
  return null;
}

function authorityBlockAgeMs(delivery: Delivery, now: Date): number {
  const startedAt = delivery.firstDispatchedAt ?? delivery.createdAt;
  return Math.max(0, now.getTime() - startedAt.getTime());
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
    "authorAvatarDigest",
    "authorPolicy",
    "sanitizedText",
    "externalMentions",
    ...(value.schema === "slack-bridge-render-snapshot.v2" ? ["attachments"] : []),
    "bindingAuthority",
    "enqueueRuntimeRevision",
  ] as const;
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
    "consentRevision",
  ] as const;
  const authorPolicy = isRecord(value.authorPolicy) ? value.authorPolicy : null;
  const avatar = authorPolicy && isRecord(authorPolicy.avatar) ? authorPolicy.avatar : null;
  const avatarValid = authorPolicy?.avatar === null || (
    avatar !== null
    && hasExactKeys(avatar, ["artifactId", "publicUrl", "sourceDigest", "artifactRevision"])
    && validBoundedString(avatar.artifactId, 320)
    && validBoundedString(avatar.publicUrl, 2_048)
    && avatar.publicUrl.startsWith("https://")
    && typeof avatar.sourceDigest === "string"
    && /^[0-9a-f]{64}$/.test(avatar.sourceDigest)
    && positiveInteger(avatar.artifactRevision)
  );
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
  const attachments = value.schema === "slack-bridge-render-snapshot.v2"
    ? value.attachments
    : [];
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
      && typeof attachment.contentDigest === "string"
      && /^[0-9a-f]{64}$/.test(attachment.contentDigest)
      && attachment.messagePosition === messagePosition
    ));
  if (
    !hasExactKeys(value, topLevelKeys)
    || !hasExactKeys(authority, [...requiredAuthorityStrings, ...requiredAuthorityRevisions])
    || (value.schema !== "slack-bridge-render-snapshot.v1"
      && value.schema !== "slack-bridge-render-snapshot.v2")
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
    || !validBoundedString(value.sanitizedText, 40_000)
    || !(value.authorAvatarDigest === null
      || (typeof value.authorAvatarDigest === "string" && /^[0-9a-f]{64}$/.test(value.authorAvatarDigest)))
    || value.enqueueRuntimeRevision !== delivery.enqueueRuntimeRevision
    || authority.bindingId !== delivery.bindingId
    || authority.bindingEpoch !== delivery.bindingEpoch
    || !requiredAuthorityStrings.every((key) => validBoundedString(authority[key], 320))
    || !requiredAuthorityRevisions.every((key) => positiveInteger(authority[key]))
    || !authorPolicy
    || !hasExactKeys(authorPolicy, [
      "policyId",
      "serverId",
      "consentRevision",
      "displayName",
      "fallbackKind",
      "avatar",
    ])
    || !validBoundedString(authorPolicy.policyId, 320)
    || !validBoundedString(authorPolicy.serverId, 320)
    || !positiveInteger(authorPolicy.consentRevision)
    || authorPolicy.consentRevision !== authority.consentRevision
    || !validBoundedString(authorPolicy.displayName, 320)
    || authorPolicy.displayName !== value.authorName
    || (authorPolicy.fallbackKind !== "human" && authorPolicy.fallbackKind !== "agent")
    || !avatarValid
    || value.authorAvatarDigest !== (avatar?.sourceDigest ?? null)
    || !mentionsValid
    || !attachmentsValid
  ) return null;
  return { ...value, attachments } as unknown as SlackBridgeRenderSnapshot;
}

function sameAuthority(
  left: ProviderNeutralOutboundBindingAuthority,
  right: ProviderNeutralOutboundBindingAuthority,
): boolean {
  const keys: (keyof ProviderNeutralOutboundBindingAuthority)[] = [
    "provider",
    "environment",
    "appRegistrationId",
    "installId",
    "workspaceId",
    "connectionEpoch",
    "bindingId",
    "bindingEpoch",
    "memberRevision",
    "contextRevision",
    "consentRevision",
    "privacyClass",
    "raftChannelId",
    "providerAuthorityId",
    "providerConversationId",
  ];
  return keys.every((key) => left[key] === right[key]);
}

async function frozenRenderAuthorityIsCurrent(
  executor: DatabaseExecutor,
  snapshot: SlackBridgeRenderSnapshot,
  now: Date,
): Promise<boolean> {
  const policy = snapshot.authorPolicy;
  const authority = snapshot.bindingAuthority;
  const [currentPolicy] = await executor.select().from(externalAuthorPolicies).where(and(
    eq(externalAuthorPolicies.id, policy.policyId),
    eq(externalAuthorPolicies.serverId, policy.serverId),
    eq(externalAuthorPolicies.provider, authority.provider),
    eq(externalAuthorPolicies.appRegistrationId, authority.appRegistrationId),
    eq(externalAuthorPolicies.installId, authority.installId),
    eq(externalAuthorPolicies.bindingId, authority.bindingId),
    eq(externalAuthorPolicies.bindingEpoch, authority.bindingEpoch),
    eq(externalAuthorPolicies.authorType, snapshot.senderType),
    eq(externalAuthorPolicies.authorId, snapshot.senderId),
    eq(externalAuthorPolicies.consentRevision, policy.consentRevision),
    eq(externalAuthorPolicies.state, "granted"),
  )).for("update").limit(1);
  if (
    !currentPolicy
    || currentPolicy.displayName !== policy.displayName
    || currentPolicy.fallbackKind !== policy.fallbackKind
    || currentPolicy.avatarArtifactId !== (policy.avatar?.artifactId ?? null)
  ) return false;

  if (policy.avatar) {
    const [avatar] = await executor.select().from(externalProjectionAvatarArtifacts).where(and(
      eq(externalProjectionAvatarArtifacts.id, policy.avatar.artifactId),
      eq(externalProjectionAvatarArtifacts.ownerType, snapshot.senderType),
      eq(externalProjectionAvatarArtifacts.ownerId, snapshot.senderId),
      eq(externalProjectionAvatarArtifacts.publicUrl, policy.avatar.publicUrl),
      eq(externalProjectionAvatarArtifacts.sourceDigest, policy.avatar.sourceDigest),
      eq(externalProjectionAvatarArtifacts.artifactRevision, policy.avatar.artifactRevision),
      eq(externalProjectionAvatarArtifacts.state, "active"),
    )).for("update").limit(1);
    if (!avatar) return false;
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
      || fact.freshnessExpiresAt.getTime() <= now.getTime()
    ) return false;
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
        eq(externalAddressabilityProjections.memberRevision, mention.memberRevision),
        eq(externalAddressabilityProjections.contextRevision, mention.contextRevision),
        eq(externalAddressabilityProjections.state, "active"),
      )).for("update").limit(1);
    if (!addressability) return false;
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

async function lockPartitionAndHead(
  executor: DatabaseExecutor,
  bindingId: string,
  bindingEpoch: number,
): Promise<{
  partition: typeof externalDeliveryPartitions.$inferSelect;
  delivery: Delivery | null;
}> {
  const [partition] = await executor.select()
    .from(externalDeliveryPartitions)
    .where(and(
      eq(externalDeliveryPartitions.bindingId, bindingId),
      eq(externalDeliveryPartitions.bindingEpoch, bindingEpoch),
    ))
    .for("update")
    .limit(1);
  if (!partition) throw new Error("External delivery partition not found");

  const [delivery] = await executor.select()
    .from(externalOutboundDeliveries)
    .where(and(
      eq(externalOutboundDeliveries.bindingId, bindingId),
      eq(externalOutboundDeliveries.bindingEpoch, bindingEpoch),
      eq(externalOutboundDeliveries.partitionPosition, partition.cursorPosition + 1),
    ))
    .for("update")
    .limit(1);
  return { partition, delivery: delivery ?? null };
}

async function consumedSkipReceiptExists(
  executor: DatabaseExecutor,
  delivery: Delivery,
): Promise<boolean> {
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
): Promise<void> {
  await executor.update(externalDeliveryPartitions).set({
    cursorPosition: delivery.partitionPosition,
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
      && existing.authorityState === "active"
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
    && existing.authorityState === "active"
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
    && existing.authorityState === "active"
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

async function releaseClaim(
  db: Database,
  deliveryId: string,
  leaseOwner: string,
  leaseGeneration: number,
  now: Date,
  reason: string,
): Promise<void> {
  await db.transaction(async (executor) => {
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
      stateReason: reason,
      updatedAt: now,
    }).where(eq(externalOutboundDeliveries.id, delivery.id));
  });
}

async function releaseAuthorityBlockedClaim(input: {
  db: Database;
  deliveryId: string;
  leaseOwner: string;
  leaseGeneration: number;
  now: Date;
  reason: string;
  priorStateReason: string | null;
}): Promise<ExternalDeliveryWorkerResult> {
  return input.db.transaction(async (executor): Promise<ExternalDeliveryWorkerResult> => {
    const [delivery] = await executor.select().from(externalOutboundDeliveries)
      .where(and(
        eq(externalOutboundDeliveries.id, input.deliveryId),
        eq(externalOutboundDeliveries.state, "dispatching"),
        eq(externalOutboundDeliveries.leaseOwner, input.leaseOwner),
        eq(externalOutboundDeliveries.leaseGeneration, input.leaseGeneration),
      )).for("update").limit(1);
    if (!delivery) {
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

    const severity = authorityBlockSeverity(delivery, input.now);
    const nextReason = authorityBlockStateReason(severity, input.reason);
    const previous = parseAuthorityBlockStateReason(input.priorStateReason);
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
        ? { alert: authorityBlockAlert(delivery, severity, input.reason, input.now) }
        : {}),
    };
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
    const locked = await lockPartitionAndHead(executor, input.bindingId, input.bindingEpoch);
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
      if (!delivery.leaseExpiresAt || delivery.leaseExpiresAt.getTime() > now.getTime()) {
        return { kind: "blocked", reason: "lease_owned", deliveryId: delivery.id };
      }
      const [attempt] = await executor.select().from(externalDeliveryAttempts)
        .where(and(
          eq(externalDeliveryAttempts.deliveryId, delivery.id),
          eq(externalDeliveryAttempts.leaseGeneration, delivery.leaseGeneration),
        )).for("update").limit(1);
      if (attempt) {
        if (attempt.outcome !== "provider_io_started") {
          return {
            kind: "blocked",
            reason: "terminal_attempt_with_dispatching_delivery",
            deliveryId: delivery.id,
          };
        }
        await terminalizeExpiredStartedLease(executor, delivery, attempt, now);
        return { kind: "lease_reclaimed", deliveryId: delivery.id, phase: "post_io" };
      }
      await executor.update(externalOutboundDeliveries).set({
        ...restoreLeaseOrigin(delivery),
        stateReason: "lease_reclaimed_before_provider_io",
        updatedAt: now,
      }).where(eq(externalOutboundDeliveries.id, delivery.id));
      [delivery] = await executor.select().from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.id, delivery.id)).limit(1);
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
    if (!state) return { kind: "blocked", reason: "terminal_partition_head", deliveryId: delivery.id };

    const auditedRetryRequested = !!input.retryDecisionId;
    if (!auditedRetryRequested) {
      const plan = planSlackBridgePartitionWork({
        delivery: toPlannerSnapshot(delivery),
        partitionCursorPosition: locked.partition.cursorPosition,
        currentRuntimeRevision: delivery.enqueueRuntimeRevision,
        runtimeActive: true,
        now,
      });
      if (plan.kind === "reconcile_or_redispatch" && !plan.automaticRedispatchAllowed) {
        return { kind: "blocked", reason: "audited_retry_required", deliveryId: delivery.id };
      }
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

  const runtime = await dependencies.resolveCurrentRuntime({
    deliveryId: claim.delivery.id,
    frozenSnapshot: claim.frozenSnapshot,
  });
  if (
    !runtime
    || runtime.runtimeRevision !== claim.delivery.enqueueRuntimeRevision
    || !sameAuthority(runtime.bindingAuthority, claim.frozenSnapshot.bindingAuthority)
    || (claim.frozenSnapshot.attachments.length > 0 && runtime.attachmentTransferEnabled !== true)
  ) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now,
      reason: "runtime_authority_inactive_or_mismatched",
      priorStateReason: claim.priorStateReason,
    });
  }

  const preCredentialAt = dependencies.now?.() ?? currentDate();
  const renderAuthorityCurrent = Number.isFinite(preCredentialAt.getTime())
    && await input.db.transaction((executor) =>
      frozenRenderAuthorityIsCurrent(executor, claim.frozenSnapshot, preCredentialAt)
    );
  if (!renderAuthorityCurrent) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now: preCredentialAt,
      reason: "frozen_render_authority_inactive_or_mismatched",
      priorStateReason: claim.priorStateReason,
    });
  }

  const credential = await dependencies.leaseCredential({ deliveryId: claim.delivery.id, runtime });
  if (!credential || !sameCredentialAuthority(credential, runtime)) {
    return releaseAuthorityBlockedClaim({
      db: input.db,
      deliveryId: claim.delivery.id,
      leaseOwner: input.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
      now,
      reason: "credential_unavailable_or_mismatched",
      priorStateReason: claim.priorStateReason,
    });
  }

  let preparedProvider:
    | { ready: true; dispatch(): Promise<ExternalDeliveryProviderResult> }
    | null = null;
  if (dependencies.prepareProvider) {
    let preparation:
      | { ready: false; reason: string }
      | { ready: true; dispatch(): Promise<ExternalDeliveryProviderResult> };
    try {
      preparation = await dependencies.prepareProvider({
        deliveryId: claim.delivery.id,
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
      const reason = validBoundedString(preparation.reason, 160)
        ? preparation.reason
        : "provider_preflight_rejected";
      await dependencies.releaseCredential?.({
        deliveryId: claim.delivery.id,
        runtime,
        credentialHandle: credential.handle,
        reason,
      });
      await releaseClaim(
        input.db,
        claim.delivery.id,
        input.leaseOwner,
        claim.leaseGeneration,
        now,
        reason,
      );
      return { kind: "blocked", reason, deliveryId: claim.delivery.id };
    }
    preparedProvider = preparation;
  }

  let attemptStartAt = now;
  let attemptStartBlockReason = "attempt_start_authority_lost";
  const attempt = await input.db.transaction(async (executor) => {
    const [delivery] = await executor.select().from(externalOutboundDeliveries)
      .where(and(
        eq(externalOutboundDeliveries.id, claim.delivery.id),
        eq(externalOutboundDeliveries.state, "dispatching"),
        eq(externalOutboundDeliveries.leaseOwner, input.leaseOwner),
        eq(externalOutboundDeliveries.leaseGeneration, claim.leaseGeneration),
      )).for("update").limit(1);
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
    if (
      delivery.dispatchedFailureAttempts >= SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS
      || (
        delivery.firstDispatchedAt !== null
        && attemptStartAt.getTime() - delivery.firstDispatchedAt.getTime()
          >= SLACK_BRIDGE_MAX_DELIVERY_AGE_MS
      )
    ) {
      attemptStartBlockReason = "delivery_budget_exhausted";
      return null;
    }
    if (!input.retryDecisionId) {
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
    if (!await frozenRenderAuthorityIsCurrent(executor, claim.frozenSnapshot, attemptStartAt)) {
      attemptStartBlockReason = "frozen_render_authority_inactive_or_mismatched";
      return null;
    }

    let decision: typeof externalDeliveryOperatorDecisions.$inferSelect | null = null;
    if (input.retryDecisionId) {
      [decision] = await executor.select().from(externalDeliveryOperatorDecisions)
        .where(and(
          eq(externalDeliveryOperatorDecisions.id, input.retryDecisionId),
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
    const [delivery] = await executor.select().from(externalOutboundDeliveries)
      .where(and(
        eq(externalOutboundDeliveries.id, claim.delivery.id),
        eq(externalOutboundDeliveries.state, "dispatching"),
        eq(externalOutboundDeliveries.leaseOwner, input.leaseOwner),
        eq(externalOutboundDeliveries.leaseGeneration, claim.leaseGeneration),
      )).for("update").limit(1);
    if (!delivery) throw new Error("External delivery outcome lost exact lease authority");
    const [startedAttempt] = await executor.select().from(externalDeliveryAttempts)
      .where(and(
        eq(externalDeliveryAttempts.id, attempt.id),
        eq(externalDeliveryAttempts.deliveryId, delivery.id),
        eq(externalDeliveryAttempts.leaseGeneration, delivery.leaseGeneration),
        eq(externalDeliveryAttempts.outcome, "provider_io_started"),
      )).for("update").limit(1);
    if (!startedAttempt) throw new Error("External delivery outcome lost started attempt");

    const transition = applySlackBridgeProviderAttemptResult(
      snapshotBeforeCurrentAttempt(delivery),
      adapterResultForPlanner(providerResult, jitterUnit),
      outcomeAt,
    );
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
    } else if (providerResult.kind === "outcome_unknown") {
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
}

export async function consumeExternalDeliverySkipDecision(
  input: ConsumeExternalDeliverySkipDecisionInput,
): Promise<{ kind: "skipped"; deliveryId: string } | { kind: "blocked"; reason: string }> {
  const now = input.now ?? currentDate();
  return input.db.transaction(async (executor) => {
    const locked = await lockPartitionAndHead(executor, input.bindingId, input.bindingEpoch);
    const delivery = locked.delivery;
    if (!delivery) return { kind: "blocked", reason: "partition_head_missing" };
    if (delivery.state === "dispatching") return { kind: "blocked", reason: "lease_owned" };
    if (delivery.state === "accepted" || delivery.state === "skipped") {
      return { kind: "blocked", reason: "already_terminal" };
    }
    const [decision] = await executor.select().from(externalDeliveryOperatorDecisions)
      .where(and(
        eq(externalDeliveryOperatorDecisions.id, input.decisionId),
        eq(externalDeliveryOperatorDecisions.deliveryId, delivery.id),
        eq(externalDeliveryOperatorDecisions.bindingId, delivery.bindingId),
        eq(externalDeliveryOperatorDecisions.bindingEpoch, delivery.bindingEpoch),
        eq(externalDeliveryOperatorDecisions.partitionPosition, delivery.partitionPosition),
        eq(externalDeliveryOperatorDecisions.action, "skip"),
        eq(externalDeliveryOperatorDecisions.dataLossAcknowledged, true),
        isNull(externalDeliveryOperatorDecisions.consumedAt),
      )).for("update").limit(1);
    if (!decision) return { kind: "blocked", reason: "skip_decision_invalid_or_consumed" };

    const consumedGeneration = delivery.leaseGeneration + 1;
    const [consumed] = await executor.update(externalDeliveryOperatorDecisions).set({
      consumedAt: now,
      consumedLeaseGeneration: consumedGeneration,
    }).where(and(
      eq(externalDeliveryOperatorDecisions.id, decision.id),
      isNull(externalDeliveryOperatorDecisions.consumedAt),
    )).returning();
    if (!consumed) return { kind: "blocked", reason: "skip_decision_invalid_or_consumed" };

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
      updatedAt: now,
    }).where(eq(externalDeliveryPartitions.id, locked.partition.id));
    return { kind: "skipped", deliveryId: delivery.id };
  });
}
