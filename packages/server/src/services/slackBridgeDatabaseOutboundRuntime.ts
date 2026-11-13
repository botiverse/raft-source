import { applySlackAttachmentFallbackDeployment, type SlackAttachmentFallbackDeployment } from "./slackAttachmentFallbackDeployment";
import { prepareSlackAttachmentFallbackPlan, readSlackAttachmentFallbackForClaim } from "./slackAttachmentFallbackPlan";
import { readSlackAttachmentSelection } from "./slackAttachmentFallbackValidation";
import { assertSlackAttachmentPlanningEnabled, isSlackAttachmentPlanningEnabled,
  markSlackAttachmentPlanWriter, renderSlackAttachmentFallback } from "./slackAttachmentFallbackProtocol";
import { loadSlackReconciliationEvidence, saveSlackReconciliationScan } from "./slackReconciliationStore";
import { resolveCurrentSlackRenderMentions } from "./slackBridgeCurrentMentions";
import { isSlackBotRecoveryWaitReason, listSlackPairHeads, listSlackOutboundQueueBindings, SLACK_PAIR_HEAD_BATCH_SIZE } from "./slackBridgePairQueue";
import { observeSlackOutboundWorkerResult } from "./slackBridgeQueueMetrics";
import { resolveExternalThreadReceipt } from "./externalMessageReceiptScope";
import { CONFIRMED_THREAD_ROOT_MISSING, reconciledProviderReceipt } from "./externalProviderPreparation";
import { createHash, randomUUID } from "node:crypto";

import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  type Tracer,
} from "@botiverse/raft-shared";
import { and, desc, eq, isNull, inArray, or } from "drizzle-orm";

import { getDb, type Database, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { withTraceRoot } from "../tracing/semanticTrace";
import {
  agents,
  externalAppInstalls,
  externalAppRegistrations,
  externalAttachmentTransferJobs,
  externalOutboundDeliveries,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  serverMembers,
  users,
} from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import {
  digestSlackBridgeRenderSnapshot,
  installOrdinaryMessageOutboundRuntime,
  mintSlackBridgeReconciliationMarker,
  type OrdinaryMessageOutboundAuthorizationResolver,
  type ProviderNeutralOutboundBindingAuthority,
} from "./externalDeliveryOutboxService";
import {
  processExternalDeliveryPartitionHead,
  lockPartitionAndHead,
  recordSlackPairControlWait, clearResumedSlackPairControlWait, clearEmptySlackPairWaits, cleanupDeletedSlackPairHead, isSlackControlWaitReason,
  type ExternalDeliveryWorkerResult, type SlackControlWaitReason,
  type ExternalDeliveryAuthorityAlert,
  type ExternalDeliveryWorkerDependencies,
  type ProcessExternalDeliveryPartitionHeadInput,
} from "./externalDeliveryWorkerService";
import { evaluateFeatureFlag } from "./featureFlagService";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackOutboundAttachmentAdapter, SlackOutboundAttachmentError, type SlackOutboundAttachmentTransport } from "./slackOutboundAttachmentAdapter";
import type { ExternalAttachmentAuthority } from "./externalAttachmentProviderAdapter";
import { dispatchExternalOutboundAttachments, MAX_OUTBOUND_ATTACHMENT_BATCH_BYTES, prepareOutboundAttachmentSourceDigests, reconcileExternalOutboundAttachments } from "./externalOutboundAttachmentCoordinator";
import { getStorage } from "./storageService";
import { effectiveAgentSenderName, effectiveUserSenderName } from "./effectiveSenderName";
import {
  createSlackProviderPreparation,
  reconcileSlackOutboundDelivery,
  renderSlackBridgeText,
  type SlackBridgeCredentialHandle,
  type SlackOutboundReconciliationResult,
  type SlackProviderAuthorityFence,
} from "./slackProviderAdapter";

const DEFAULT_OUTBOUND_WORKER_INTERVAL_MS = 1_000;
// Inconsistent terminal attempts cannot be safely reclaimed. Retry observation
// at a bounded rate so one malformed head cannot lock the queue every tick.
const TERMINAL_ATTEMPT_RECHECK_MS = 60_000;

export type SlackOutboundReconciliationDecision =
  | { kind: "abort"; reason: string; retryAfterMs?: number }
  | { kind: "accept"; providerMessageId: string; providerThreadId: string | null }
  | { kind: "dispatch" };

export function classifySlackOutboundReconciliation(
  result: SlackOutboundReconciliationResult,
): SlackOutboundReconciliationDecision {
  if (result.kind === "unavailable") return { kind: "abort", reason: result.reason, ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) };
  if (result.kind === "not_found") return { kind: "dispatch" };
  return {
    kind: "accept",
    providerMessageId: result.providerMessageId,
    providerThreadId: result.providerThreadId,
  };
}

type ActiveBindingFact = Extract<
  Awaited<ReturnType<typeof resolveExternalBindingAuthority>>,
  { active: true }
>["fact"];

type CurrentOutboundAuthority = {
  active: true;
  neutral: ProviderNeutralOutboundBindingAuthority;
  runtimeRevision: string;
};

export interface SlackBridgeDatabaseOutboundRuntimeDependencies {
  db?: Database;
  provider: SlackBridgeProviderRuntime;
  reconciliationKey: Uint8Array | string;
  registrationId: string;
  attachmentFallbackDeployment?: SlackAttachmentFallbackDeployment;
  now?: () => Date;
  workerIntervalMs?: number;
  workerLeaseOwner?: string;
  runWorkerOnce?(input: ProcessExternalDeliveryPartitionHeadInput): ReturnType<
    typeof processExternalDeliveryPartitionHead
  >;
  listPairHeads?: typeof listSlackPairHeads;
  recordControlWait?: typeof recordSlackPairControlWait;
  clearControlWait?: typeof clearResumedSlackPairControlWait;
  onAuthorityAlert?(alert: ExternalDeliveryAuthorityAlert): void;
  onError?(error: unknown): void;
  tracer?: Tracer;
}

export interface SlackBridgeDatabaseOutboundRuntime {
  start(): void;
  stop(): Promise<void>;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function resolveCurrentAuthorPresentation(input: {
  executor: DatabaseExecutor;
  serverId: string;
  senderType: "user" | "agent";
  senderId: string;
}): Promise<{ displayName: string; fallbackKind: "human" | "agent" } | null> {
  if (input.senderType === "user") {
    const [subject] = await input.executor.select({
      name: users.name,
      displayName: users.displayName,
    }).from(serverMembers).innerJoin(users, eq(users.id, serverMembers.userId)).where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.senderId),
    )).limit(1);
    return subject
      ? { displayName: effectiveUserSenderName(subject), fallbackKind: "human" }
      : null;
  }
  const [subject] = await input.executor.select({
    name: agents.name,
    displayName: agents.displayName,
  }).from(agents).where(and(
    eq(agents.id, input.senderId),
    eq(agents.serverId, input.serverId),
    isNull(agents.deletedAt),
  )).limit(1);
  return subject
    ? { displayName: effectiveAgentSenderName(subject), fallbackKind: "agent" }
    : null;
}

// The dispatch revision only covers what this resolver actually fences on:
// the bound-destination coordinates plus the audience revision frozen at
// dispatch. Grant/credential/scope drift no longer feeds the digest — losing
// provider access surfaces as a concrete provider or credential failure
// rather than an opaque authority mismatch that wedges the FIFO head.
function canonicalRevision(input: {
  neutral: ProviderNeutralOutboundBindingAuthority;
  audienceRevision: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schema: "slack-bridge-database-outbound-runtime.v2",
    neutral: input.neutral,
    audienceRevision: input.audienceRevision,
  }), "utf8").digest("hex");
}

// Runtime/audience revisions are refreshed per dispatch. Only coordinates that
// identify the bound destination belong in this fence; revision drift must not
// poison an ordinary FIFO head.
function sameHardNeutralAuthority(
  left: ProviderNeutralOutboundBindingAuthority,
  right: ProviderNeutralOutboundBindingAuthority,
): boolean {
  return left.provider === right.provider
    && left.environment === right.environment
    && left.appRegistrationId === right.appRegistrationId
    && left.workspaceId === right.workspaceId
    && left.raftChannelId === right.raftChannelId
    && left.providerAuthorityId === right.providerAuthorityId
    && left.providerConversationId === right.providerConversationId;
}

function providerFence(
  fact: ActiveBindingFact,
): SlackProviderAuthorityFence {
  return {
    installId: fact.installId,
    providerAppId: fact.providerAppId,
    providerAuthorityId: fact.providerAuthorityId,
    providerConversationId: fact.providerConversationId,
    connectionEpoch: fact.connectionEpoch,
    credentialRevision: fact.credentialRevision,
    bindingId: fact.bindingId,
    bindingEpoch: fact.bindingEpoch,
  };
}

/** Keep durable file/job identities frozen while using the current pair's credentials. */
function continueAttachmentTransport(
  transport: SlackOutboundAttachmentTransport,
  frozen: ProviderNeutralOutboundBindingAuthority,
  current: ProviderNeutralOutboundBindingAuthority,
  currentRenderedText: () => Promise<string | null>,
): SlackOutboundAttachmentTransport {
  const keys = ["provider", "appRegistrationId", "installId", "workspaceId", "providerAuthorityId",
    "providerConversationId", "connectionEpoch", "bindingId", "bindingEpoch"] as const;
  const operation = (authority: ExternalAttachmentAuthority): ExternalAttachmentAuthority => {
    if (!sameHardNeutralAuthority(frozen, current) || keys.some((key) => authority[key] !== frozen[key])) {
      throw new SlackOutboundAttachmentError({ class: "authority_revoked", reason: "attachment_pair_changed",
        retryAfterMs: null, scope: "occurrence_local" });
    }
    return current;
  };
  return {
    createUpload: (input) => transport.createUpload({ ...input, authority: operation(input.authority) }),
    upload: (input) => transport.upload({ ...input, authority: operation(input.authority) }),
    async complete(input) {
      const authority = operation(input.authority);
      const renderedText = await currentRenderedText();
      if (renderedText === null) throw new SlackOutboundAttachmentError({ class: "deterministic",
        reason: "provider_message_render_invalid", retryAfterMs: null, scope: "occurrence_local" });
      return transport.complete({ ...input, authority, completion: { ...input.completion, renderedText } });
    },
    correlate: (input) => transport.correlate({ ...input, authority: operation(input.authority) }),
    classify: (error) => transport.classify(error),
  };
}

export type CurrentOutboundAuthorityDecision =
  | { current: true; authority: CurrentOutboundAuthority }
  | { current: false; reason: string };

export async function resolveCurrentOutboundAuthority(input: {
  executor: DatabaseExecutor;
  bindingId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  expectedAudienceRevision?: number;
  /** Queue admission only; never valid for a frozen dispatch check. */
  allowLifecyclePausedAdmission?: true;
  senderType: "user" | "agent";
  senderId: string;
  now: Date;
  registrationId: string;
}): Promise<CurrentOutboundAuthorityDecision> {
  const inactive = (reason: string): CurrentOutboundAuthorityDecision => ({ current: false, reason });
  if (!validDate(input.now)) return inactive("invalid_now");
  const [binding] = await input.executor.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, input.bindingId),
    eq(externalChannelBindings.registrationId, input.registrationId),
  )).limit(1);
  if (!binding) return inactive("binding_missing_for_registration");
  if (binding.state !== "active" && !(input.allowLifecyclePausedAdmission
    && input.expectedAudienceRevision === undefined && binding.state === "paused"
    && (binding.stateReason === "provider_channel_archived" || binding.stateReason === "provider_bot_removed"))) {
    return inactive("binding_inactive");
  }
  // privacyFreshUntil is directory-cache metadata: a stale privacy
  // observation degrades to the recorded class rather than stopping
  // outbound (task #241 — visibility is per-platform).
  if (
    binding.connectionEpoch !== input.expectedConnectionEpoch
    || binding.bindingEpoch !== input.expectedBindingEpoch
  ) return inactive("epoch_mismatch");

  // The master kill-switch stays outside the dispatch fence (it is not a
  // property of this delivery's authority) but both call sites still need
  // it: admission must refuse new enqueues outright so an OFF window never
  // queues provider I/O, and a dispatch path that somehow runs while OFF
  // fails closed with a named reason instead of sending.
  const launch = await evaluateFeatureFlag({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    serverId: binding.serverId,
  }, input.executor as ReturnType<typeof getDb>);
  if (!launch.enabled) return inactive("master_flag_disabled");

  // The one consent boundary the worker still fences before dispatch: the
  // audience snapshot the delivery froze on must still be a matched,
  // unexpired observation of this binding. Freshness is checked on the
  // frozen dispatch carries the audience revision the message was queued
  // under; it is metadata for the snapshot/mention joins, never a gate.
  const frozenDispatch = input.expectedAudienceRevision !== undefined;
  if (frozenDispatch
    && (!Number.isSafeInteger(input.expectedAudienceRevision)
      || input.expectedAudienceRevision! <= 0)) {
    return inactive("expected_audience_revision_invalid");
  }
  // Audience observations are refresh metadata, not a consent gate. One
  // rule for both privacy classes: only an explicit "mismatch" newest
  // snapshot fails closed — that is the one observation proving the member
  // set actually diverged. A refresh that failed or came back unavailable
  // degrades to the last observation; missing or expired snapshots never
  // block body delivery. Grant/credential/scope health is deliberately
  // absent — the credential lease and provider API surface those failures
  // concretely.
  const [newest] = await input.executor.select({
    status: externalBindingAudienceSnapshots.status,
  }).from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
  // A verified missing bot writes a mismatch in the new paused epoch. Keep
  // admitting messages to custody in that one state; dispatch remains fenced
  // by the pause and requires a fresh matched audience before recovery.
  const pausedBotQueueOnly = input.allowLifecyclePausedAdmission === true
    && !frozenDispatch && binding.state === "paused" && binding.stateReason === "provider_bot_removed";
  if (newest?.status === "mismatch" && !pausedBotQueueOnly) {
    return inactive(frozenDispatch
      ? "frozen_audience_snapshot_missing_or_expired"
      : "audience_snapshot_missing");
  }
  const [matched] = await input.executor.select({
    audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
  }).from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
    eq(externalBindingAudienceSnapshots.status, "matched"),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
  // memberRevision feeds the frozen snapshot's mention coordinates, which
  // require a positive integer. With no matched observation yet there is
  // nothing to match mentions against anyway, so a placeholder is fine.
  const audienceRevision = frozenDispatch
    ? input.expectedAudienceRevision!
    : (matched?.audienceRevision ?? binding.audienceRevision ?? 1);

  const [install] = await input.executor.select({
    providerAuthorityId: externalAppInstalls.providerAuthorityId,
    state: externalAppInstalls.state,
  }).from(externalAppInstalls).where(eq(externalAppInstalls.id, binding.installId)).limit(1);
  if (!install) return inactive("install_missing");
  if (binding.state === "paused" && install.state !== "active") return inactive("installation_inactive");
  const [registration] = await input.executor.select({
    provider: externalAppRegistrations.provider,
    environment: externalAppRegistrations.environment,
  }).from(externalAppRegistrations).where(eq(externalAppRegistrations.id, binding.registrationId)).limit(1);
  if (!registration) return inactive("registration_missing");

  const neutral: ProviderNeutralOutboundBindingAuthority = {
    provider: registration.provider,
    environment: registration.environment,
    appRegistrationId: binding.registrationId,
    installId: binding.installId,
    workspaceId: install.providerAuthorityId,
    connectionEpoch: binding.connectionEpoch,
    bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch,
    memberRevision: input.expectedAudienceRevision ?? audienceRevision,
    contextRevision: input.expectedAudienceRevision ?? audienceRevision,
    privacyClass: binding.privacyClass,
    raftChannelId: binding.channelId,
    providerAuthorityId: install.providerAuthorityId,
    providerConversationId: binding.providerConversationId,
  };
  // Enqueue-time call sites omit expectedAudienceRevision; there the sender
  // must still resolve to a live server subject so the frozen author
  // presentation is real. Dispatch-time call sites pass the frozen revision
  // and skip this — the sender is already frozen into the snapshot.
  if (
    input.expectedAudienceRevision === undefined
    && !await resolveCurrentAuthorPresentation({
      executor: input.executor,
      serverId: binding.serverId,
      senderType: input.senderType,
      senderId: input.senderId,
    })
  ) return inactive("author_presentation_unavailable");
  return {
    current: true,
    authority: {
      active: true,
      neutral,
      runtimeRevision: canonicalRevision({
        neutral,
        audienceRevision: input.expectedAudienceRevision ?? audienceRevision,
      }),
    },
  };
}

export async function resolveSlackOutboundMessageSurface(input: {
  executor: DatabaseExecutor;
  requestedChannelId: string;
  messageChannelId: string;
}): Promise<{
  level: "top_level" | "thread";
  authorityConversationId: string;
  bindingChannelId: string;
  canonicalRootMessageId: string | null;
} | null> {
  const target = await resolveExternalConversationTarget({
    executor: input.executor,
    authorityChannelId: input.requestedChannelId,
    expectedStorageChannelId: input.messageChannelId,
  });
  if (!target || (target.kind === "joint" && target.role !== "host")) return null;
  return {
    level: target.level,
    authorityConversationId: target.authorityChannelId,
    bindingChannelId: target.bindingChannelId,
    canonicalRootMessageId: target.canonicalRootMessageId,
  };
}

export const SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE = 100;

/** Drizzle wrappers contain timestamped query parameters. Key the bounded
 * report cache by a hash of the underlying failure, rather than those wrappers. */
function deploymentFailureFingerprint(error: unknown): string {
  let underlying = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!(underlying instanceof Error) || !(underlying.cause instanceof Error)) break;
    underlying = underlying.cause;
  }
  const value = underlying instanceof Error
    ? `${underlying.name}:${"code" in underlying && typeof underlying.code === "string" ? underlying.code : ""}:${underlying.message}`
    : typeof underlying === "string" ? underlying : typeof underlying;
  return createHash("sha256").update(value).digest("hex");
}

export function createSlackBridgeDatabaseOutboundRuntime(
  dependencies: SlackBridgeDatabaseOutboundRuntimeDependencies,
): SlackBridgeDatabaseOutboundRuntime {
  const db = dependencies.db ?? getDb();
  const now = dependencies.now ?? currentDate;
  const workerIntervalMs = dependencies.workerIntervalMs ?? DEFAULT_OUTBOUND_WORKER_INTERVAL_MS;
  if (!Number.isSafeInteger(workerIntervalMs) || workerIntervalMs <= 0) {
    throw new Error("Slack Bridge outbound worker interval is invalid");
  }
  const workerLeaseOwner = dependencies.workerLeaseOwner
    ?? `slack-outbound:${dependencies.registrationId}:${randomUUID()}`;
  const runWorkerOnce = dependencies.runWorkerOnce ?? processExternalDeliveryPartitionHead;
  const recordControlWait = dependencies.recordControlWait ?? recordSlackPairControlWait;
  const clearControlWait = dependencies.clearControlWait ?? clearResumedSlackPairControlWait;
  const listPairHeads = dependencies.listPairHeads ?? listSlackPairHeads;
  const terminalAttemptBackoff = new Map<string, { signature: string; until: number }>();
  let started = false;
  let stopped = false;
  let timer: unknown | null = null;
  let workerPromise: Promise<void> | null = null;
  let uninstallAdmission: (() => void) | null = null;
  let deploymentConfigApplied = !dependencies.attachmentFallbackDeployment;
  const deploymentErrorReports = new Map<string, number>();
  // Hashing may wait on storage. Keep it outside both the serial delivery tick
  // and the workspace-wide credential lease, with bounded concurrency.
  const sourcePreparations = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  const authorizationResolver: OrdinaryMessageOutboundAuthorizationResolver = async (request) => {
    if (
      stopped
      || request.sourceText.includes("\0")
      || Buffer.byteLength(request.sourceText, "utf8") > 40_000
    ) return null;
    const surface = await resolveSlackOutboundMessageSurface({
      executor: request.executor,
      requestedChannelId: request.requestedChannelId,
      messageChannelId: request.message.channelId,
    });
    if (!surface) return null;
    const bindings = await request.executor.select({
      id: externalChannelBindings.id,
      connectionEpoch: externalChannelBindings.connectionEpoch,
      bindingEpoch: externalChannelBindings.bindingEpoch,
    }).from(externalChannelBindings).where(and(
      eq(externalChannelBindings.registrationId, dependencies.registrationId),
      eq(externalChannelBindings.channelId, surface.bindingChannelId),
      or(eq(externalChannelBindings.state, "active"), and(eq(externalChannelBindings.state, "paused"),
        inArray(externalChannelBindings.stateReason, ["provider_channel_archived", "provider_bot_removed"]))),
    )).limit(2);
    if (bindings.length !== 1) return null;
    const current = await resolveCurrentOutboundAuthority({
      executor: request.executor,
      bindingId: bindings[0]!.id,
      expectedConnectionEpoch: bindings[0]!.connectionEpoch,
      expectedBindingEpoch: bindings[0]!.bindingEpoch,
      senderType: request.senderType,
      senderId: request.senderId,
      now: now(),
      registrationId: dependencies.registrationId,
      allowLifecyclePausedAdmission: true,
    });
    if (!current.current) return null;
    const authority = current.authority;
    if (authority.neutral.raftChannelId !== surface.bindingChannelId || stopped) return null;
    return {
      activeRuntime: {
        level: surface.level,
        authorityConversationId: surface.authorityConversationId,
        runtimePredicateRevision: authority.runtimeRevision,
        bindingAuthority: authority.neutral,
      },
      canonicalConversationId: request.message.channelId,
      canonicalRootMessageId: surface.canonicalRootMessageId,
      sanitizedText: request.sourceText,
    };
  };

  const resolveCurrentRuntime: ExternalDeliveryWorkerDependencies["resolveCurrentRuntime"] = async ({
    frozenSnapshot,
  }) => db.transaction(async (tx) => {
    if (stopped) return { blockedReason: "runtime_stopped" };
    const frozen = frozenSnapshot.bindingAuthority;
    const candidates = await tx.select({ binding: externalChannelBindings }).from(externalChannelBindings)
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
      .where(and(
        eq(externalChannelBindings.registrationId, dependencies.registrationId),
        eq(externalChannelBindings.channelId, frozen.raftChannelId),
        eq(externalChannelBindings.providerConversationId, frozen.providerConversationId),
        eq(externalChannelBindings.state, "active"),
        eq(externalAppInstalls.providerAuthorityId, frozen.providerAuthorityId),
        eq(externalAppInstalls.state, "active"),
      )).limit(2);
    if (candidates.length !== 1) return { blockedReason: "current_channel_pair_unavailable_or_conflicting" };
    const binding = candidates[0]!.binding;
    const current = await resolveCurrentOutboundAuthority({
      executor: tx,
      bindingId: binding.id,
      expectedConnectionEpoch: binding.connectionEpoch,
      expectedBindingEpoch: binding.bindingEpoch,
      expectedAudienceRevision: frozen.memberRevision,
      senderType: frozenSnapshot.senderType,
      senderId: frozenSnapshot.senderId,
      now: now(),
      registrationId: dependencies.registrationId,
    });
    if (!current.current) return { blockedReason: current.reason };
    const authority = current.authority;
    if (stopped) return { blockedReason: "runtime_stopped" };
    if (!sameHardNeutralAuthority(authority.neutral, frozen)) {
      return { blockedReason: "hard_authority_mismatch" };
    }
    return {
      runtimeRevision: authority.runtimeRevision,
      bindingAuthority: authority.neutral,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const leaseCredential: ExternalDeliveryWorkerDependencies["leaseCredential"] = async ({
    runtime,
  }) => {
    const lease = await db.transaction(async (tx) => {
      if (stopped) return null;
      const authority = runtime.bindingAuthority;
      const bindings = await tx.select({
        serverId: externalChannelBindings.serverId,
      }).from(externalChannelBindings).where(and(
        eq(externalChannelBindings.id, authority.bindingId),
        eq(externalChannelBindings.registrationId, dependencies.registrationId),
      )).limit(2);
      if (bindings.length !== 1) return null;
      const decision = await resolveExternalBindingAuthority({
        serverId: bindings[0]!.serverId,
        bindingId: authority.bindingId,
        expectedConnectionEpoch: authority.connectionEpoch,
        expectedBindingEpoch: authority.bindingEpoch,
        now: now(),
        allowArchivedForQueuedDelivery: true,
      }, tx as ReturnType<typeof getDb>);
      return decision.active
        ? { fact: decision.fact, serverId: bindings[0]!.serverId, reason: null }
        : { fact: null, serverId: bindings[0]!.serverId, reason: decision.reason };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    const fact = lease?.fact ?? null;
    if (!fact || stopped) return null;
    const handle = await dependencies.provider.credentialResolver.resolve({
      authority: providerFence(fact),
      now: now(),
    });
    if (!handle) return null;
    return {
      handle,
      credentialRevision: fact.credentialRevision,
      runtimeRevision: runtime.runtimeRevision,
      provider: fact.provider,
      installId: fact.installId,
      providerAuthorityId: fact.providerAuthorityId,
      providerConversationId: fact.providerConversationId,
      connectionEpoch: fact.connectionEpoch,
      bindingId: fact.bindingId,
      bindingEpoch: fact.bindingEpoch,
    };
  };

  const threadAuthority = {
    async resolve(input: {
      canonicalRootMessageId: string;
      authority: SlackProviderAuthorityFence;
    }) {
      const receipt = await resolveExternalThreadReceipt({ executor: db, canonicalRootMessageId: input.canonicalRootMessageId, authority: input.authority,
        allowArchivedForQueuedDelivery: true });
      if (receipt.kind !== "found") return { active: false as const,
        reason: receipt.kind === "absent" ? "missing" as const : receipt.kind };
      return {
        active: true as const,
        fact: {
          providerThreadId: receipt.providerThreadId,
          rootLinkRevision: 1,
          installId: input.authority.installId,
          providerAuthorityId: input.authority.providerAuthorityId,
          providerConversationId: input.authority.providerConversationId,
          connectionEpoch: input.authority.connectionEpoch,
          bindingId: input.authority.bindingId,
          bindingEpoch: input.authority.bindingEpoch,
        },
      };
    },
  };
  const prepareSlackProvider = createSlackProviderPreparation({
    transport: dependencies.provider.transport,
    quarantineSink: dependencies.provider.quarantineSink,
    threadAuthority,
    now,
  });
  const readPlan = (request: { deliveryId: string; leaseOwner: string; leaseGeneration: number;
    frozenSnapshot: Parameters<typeof readSlackAttachmentFallbackForClaim>[0]["snapshot"] }) =>
    readSlackAttachmentFallbackForClaim({ db, deliveryId: request.deliveryId,
      bindingId: request.frozenSnapshot.bindingAuthority.bindingId,
      bindingEpoch: request.frozenSnapshot.bindingAuthority.bindingEpoch,
      leaseOwner: request.leaseOwner, leaseGeneration: request.leaseGeneration,
      snapshot: request.frozenSnapshot, now });

  function attachmentWriteAdmission(request: { deliveryId: string;
    frozenSnapshot: Parameters<typeof readSlackAttachmentFallbackForClaim>[0]["snapshot"];
    leaseOwner?: string; leaseGeneration?: number }, revision: number | null, completion = false) {
    return async (tx: DatabaseTransaction) => {
      const frozen = request.frozenSnapshot.bindingAuthority;
      const locked = await lockPartitionAndHead(tx, frozen.bindingId, frozen.bindingEpoch);
      const delivery = locked?.delivery;
      if (!delivery || delivery.id !== request.deliveryId
        || delivery.attachmentFallbackPlanRevision !== revision
        || digestSlackBridgeRenderSnapshot(request.frozenSnapshot) !== delivery.renderSnapshotDigest
        || ["accepted", "skipped", "dead", "quarantined"].includes(delivery.state)) {
        throw new Error("attachment_parent_or_plan_changed");
      }
      await readSlackAttachmentSelection(tx, delivery, request.frozenSnapshot);
      if (request.leaseOwner !== undefined) {
        const checkedAt = now();
        const expiresAt = delivery.leaseExpiresAt;
        const sameClaim = delivery.state === "dispatching" && delivery.leaseOwner === request.leaseOwner
          && delivery.leaseGeneration === request.leaseGeneration && expiresAt !== null;
        if (completion && (!sameClaim || !expiresAt || expiresAt <= checkedAt)) throw new Error("attachment_parent_lease_lost");
        // Private file work owns its own generation. If the parent was reclaimed,
        // that work may finish privately, but this claimant cannot publish it.
        if (sameClaim) await tx.update(externalOutboundDeliveries)
          .set({ leaseExpiresAt: new Date(checkedAt.getTime() + 60_000) })
          .where(eq(externalOutboundDeliveries.id, delivery.id));
      }
    };
  }

  const workerDependencies: ExternalDeliveryWorkerDependencies = {
    resolveCurrentRuntime,
    leaseCredential,
    async prepareBeforeCredential(request) {
      const { deliveryId, frozenSnapshot } = request;
      if (!frozenSnapshot.attachments.length || frozenSnapshot.attachments.reduce((sum, item) => sum + item.sizeBytes, 0) > MAX_OUTBOUND_ATTACHMENT_BATCH_BYTES) return { ready: true };
      // An uncertain visible completion always reconciles the original persisted transport.
      if (request.reconcileUnknownOutcome) return { ready: true };
      const plan = await readPlan(request);
      if (plan.kind === "unavailable") return { ready: false, reason: "attachment_fallback_plan_unavailable" };
      const enabled = plan.kind === "planned" || await isSlackAttachmentPlanningEnabled(db);
      if (enabled) {
        const selection = plan.kind === "planned" ? plan : undefined;
        if (selection?.transport === "text") return { ready: true };
        const selected = new Set(selection?.includedAttachmentIds ?? frozenSnapshot.attachments.map(file => file.sourceAttachmentId));
        const jobs = await db.select().from(externalAttachmentTransferJobs).where(and(
          eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
          eq(externalAttachmentTransferJobs.outboundDeliveryId, deliveryId),
        ));
        const activeJobs = jobs.filter(job => job.sourceAttachmentId && selected.has(job.sourceAttachmentId));
        if (jobs.length !== frozenSnapshot.attachments.length || activeJobs.length !== selected.size) {
          return { ready: false, reason: "attachment_transfer_set_invalid" };
        }
        if (activeJobs.every(job => job.leaseOwner === null && job.leaseExpiresAt === null
          && ((job.phase === "complete" && ["queued", "retry_wait"].includes(job.state))
            || job.phase === "correlate" || job.state === "completed"))) return { ready: true };
        const lastIssue = activeJobs.find(job => job.lastErrorClass !== null)?.lastErrorClass;
        const preparationIssue = lastIssue && !lastIssue.startsWith("attachment_source_")
          ? "attachment_private_preparation_failed" : lastIssue;
        if (activeJobs.some(job => job.nextAttemptAt > now()) || stopped
          || sourcePreparations.has(deliveryId) || sourcePreparations.size >= 4) {
          return { ready: false, reason: preparationIssue ?? "attachment_source_preparing" };
        }
        const storage = getStorage();
        if (!storage) return { ready: false, reason: "provider_attachment_runtime_unavailable" };
        const controller = new AbortController();
        const admitWrite = attachmentWriteAdmission({ deliveryId, frozenSnapshot }, plan.kind === "planned" ? plan.revision : null);
        const promise = Promise.resolve().then(async () => {
          const credential = await leaseCredential({ deliveryId, runtime: request.runtime });
          if (!credential) return;
          const handle = credential.handle as SlackBridgeCredentialHandle;
          try {
            const current = request.runtime.bindingAuthority;
            const fence: SlackProviderAuthorityFence = { ...current, providerAppId: handle.providerAppId,
              credentialRevision: handle.credentialRevision };
            const transport = await dependencies.provider.createOutboundAttachmentTransport(handle, fence);
            if (!transport) return;
            const adapter = createSlackOutboundAttachmentAdapter(continueAttachmentTransport(
              transport, frozenSnapshot.bindingAuthority, current, async () => null,
            ));
            const result = await dispatchExternalOutboundAttachments({ db, deliveryId,
              reconciliationMarker: "private-upload-preparation", snapshot: frozenSnapshot, selection,
              adapter, storage, providerRootThreadId: null, leaseOwner: `${workerLeaseOwner}:attachment-prepare`,
              now, signal: controller.signal, prepareOnly: true, admitWrite });
            if (result.kind === "transient_failure" && result.reasonCode === "attachment_source_read_failed") {
              await prepareSlackAttachmentFallbackPlan({ db, deliveryId, bindingId: request.bindingId,
                bindingEpoch: request.bindingEpoch, snapshot: frozenSnapshot, storage, now, signal: controller.signal,
                assertWriterFleetFenced: assertSlackAttachmentPlanningEnabled });
            }
          } finally { await dependencies.provider.releaseCredential(handle); }
        }).catch(error => { dependencies.onError?.(error); }).finally(() => { sourcePreparations.delete(deliveryId); });
        sourcePreparations.set(deliveryId, { controller, promise });
        return { ready: false, reason: preparationIssue ?? "attachment_source_preparing" };
      }
      const jobs = await db.select().from(externalAttachmentTransferJobs).where(and(
        eq(externalAttachmentTransferJobs.direction, "raft_outbound"),
        eq(externalAttachmentTransferJobs.outboundDeliveryId, deliveryId),
      ));
      if (jobs.length !== frozenSnapshot.attachments.length || frozenSnapshot.attachments.some(
        (attachment) => !jobs.some((job) => job.sourceAttachmentId === attachment.sourceAttachmentId),
      )) return { ready: false, reason: "attachment_transfer_set_invalid" };
      // A pause cannot make an already running private preparation into a visible attempt.
      if (sourcePreparations.has(deliveryId) || jobs.some(job => job.state === "leased"
        && job.leaseExpiresAt && job.leaseExpiresAt > now())) return { ready: false, reason: "attachment_source_preparing" };
      if (jobs.every((job) => job.frozenContentDigest)) return { ready: true };
      const waiting = jobs.find((job) => !job.frozenContentDigest && job.state === "retry_wait"
        && job.nextAttemptAt && job.nextAttemptAt > now());
      if (waiting) return { ready: false, reason: waiting.lastErrorClass ?? "attachment_source_not_ready" };
      if (stopped || sourcePreparations.has(deliveryId) || sourcePreparations.size >= 4) {
        return { ready: false, reason: "attachment_source_preparing" };
      }
      const storage = getStorage();
      if (!storage) return { ready: false, reason: "provider_attachment_runtime_unavailable" };
      const controller = new AbortController();
      const promise = prepareOutboundAttachmentSourceDigests({
        db, deliveryId, snapshot: frozenSnapshot, storage,
        leaseOwner: `${workerLeaseOwner}:attachment-prepare`, now, signal: controller.signal,
      }).then(() => undefined).catch((error) => { dependencies.onError?.(error); }).finally(() => {
        sourcePreparations.delete(deliveryId);
      });
      sourcePreparations.set(deliveryId, { controller, promise });
      return { ready: false, reason: "attachment_source_preparing" };
    },
    async prepareProvider(request) {
      let handle = request.credentialHandle as SlackBridgeCredentialHandle;
      try {
        const operation = request.runtime.bindingAuthority;
        const currentRenderSnapshot = async () => ({ ...request.frozenSnapshot,
          ...await db.transaction(tx => resolveCurrentSlackRenderMentions(tx, request.frozenSnapshot, operation, now())) });
        const plan = request.frozenSnapshot.attachments.length ? await readPlan(request) : { kind: "none" as const };
        if (plan.kind === "unavailable") return { ready: false, reason: "attachment_fallback_plan_unavailable" };
        const selection = plan.kind === "planned" ? plan : undefined;
        const textTransport = request.frozenSnapshot.attachments.length === 0 || selection?.transport === "text";
        const withMarker = (text: string | null) => text !== null && selection ? renderSlackAttachmentFallback(text) : text;
        // The frozen snapshot stays byte-identical; only the final rendered text is decorated.
        const renderSnapshot = request.frozenSnapshot;
        const authority: SlackProviderAuthorityFence = {
          installId: operation.installId,
          providerAppId: handle.providerAppId,
          providerAuthorityId: operation.providerAuthorityId,
          providerConversationId: operation.providerConversationId,
          connectionEpoch: operation.connectionEpoch,
          credentialRevision: handle.credentialRevision,
          bindingId: operation.bindingId,
          bindingEpoch: operation.bindingEpoch,
        };
        // File shares have durable provider-file IDs, not the text metadata
        // marker. Resume their coordinator below with the worker's existing
        // lease instead of entering a second credential acquisition here.
        if (request.reconcileUnknownOutcome && textTransport) {
          let providerThreadId: string | null = null;
          if (request.frozenSnapshot.level === "thread") {
            const root = await threadAuthority.resolve({
              canonicalRootMessageId: request.frozenSnapshot.canonicalRootMessageId!,
              authority,
            });
            if (!root.active) return root.reason === "missing"
              ? { ready: false, disposition: "discard", reason: CONFIRMED_THREAD_ROOT_MISSING }
              : { ready: false, reason: "provider_thread_receipt_" + root.reason };
            providerThreadId = root.fact.providerThreadId;
          }
          const claim = { deliveryId: request.deliveryId, leaseOwner: request.leaseOwner, leaseGeneration: request.leaseGeneration };
          const evidence = await loadSlackReconciliationEvidence(db, claim, now());
          if (!evidence) return { ready: false, reason: "reconciliation_attempt_evidence_missing" };
          const { delivery, firstAttemptAt } = evidence;
          // Reconciliation obtains one-use read leases itself. Do not hold a
          // second exclusive credential lease while trying to acquire them.
          await dependencies.provider.releaseCredential(handle);
          const reconciliation = await reconcileSlackOutboundDelivery({
            transport: dependencies.provider.transport,
            leaseCredential: async () => dependencies.provider.credentialResolver.resolve({
              authority,
              now: now(),
            }),
            authority,
            reconciliationMarker: request.reconciliationMarker,
            providerThreadId,
            now: now(), firstAttemptAt, providerAttempt: delivery.providerAttempts,
            scan: delivery.reconciliationScan,
            releaseCredential: (credential) => dependencies.provider.releaseCredential(credential),
            saveScan: (scan) => db.transaction(async tx => {
              await markSlackAttachmentPlanWriter(tx);
              await saveSlackReconciliationScan(tx, { ...claim,
                providerAttempt: delivery.providerAttempts, scan, now: now() });
            }),
          });
          if (reconciliation.kind === "unavailable" && reconciliation.unconfirmable
            && !delivery.reconciliationScan?.conclusion) {
            console.warn("[SlackBridge] receipt cannot be confirmed", { event: "server.slack_bridge.reconciliation.unconfirmable",
              bindingId: operation.bindingId, deliveryId: request.deliveryId, reason: reconciliation.unconfirmable });
          }
          const decision = classifySlackOutboundReconciliation(reconciliation);
          if (decision.kind === "abort") {
            return { ready: false, reason: decision.reason, retryAfterMs: decision.retryAfterMs,
              ...(reconciliation.kind === "unavailable" && reconciliation.unconfirmable
                ? { pairBlockedReason: reconciliation.unconfirmable }
                : reconciliation.kind === "unavailable" && reconciliation.reason === "app_access_restricted"
                  ? { pairBlockedReason: "slack_workspace_admin_required" as const } : {}) };
          }
          if (decision.kind === "accept") {
            return reconciledProviderReceipt({ kind: "accepted" as const, providerMessageId: decision.providerMessageId,
              providerThreadId: decision.providerThreadId, reconciled: true });
          }
          const replacement = await dependencies.provider.credentialResolver.resolve({ authority, now: now() });
          if (!replacement || replacement.credentialRevision !== handle.credentialRevision) {
            if (replacement) await dependencies.provider.releaseCredential(replacement);
            return { ready: false, reason: "reconciliation_dispatch_credential_changed" };
          }
          handle = replacement;
        }
        if (!textTransport) {
          const attachmentFence: SlackProviderAuthorityFence = {
            installId: operation.installId,
            providerAppId: handle.providerAppId,
            providerAuthorityId: operation.providerAuthorityId,
            providerConversationId: operation.providerConversationId,
            connectionEpoch: operation.connectionEpoch,
            credentialRevision: handle.credentialRevision,
            bindingId: operation.bindingId,
            bindingEpoch: operation.bindingEpoch,
          };
          const transport = await dependencies.provider.createOutboundAttachmentTransport(handle, attachmentFence);
          const storage = getStorage();
          if (!transport) return { ready: false, reason: "provider_attachment_runtime_unavailable" };
          let providerRootThreadId: string | null = null;
          if (request.frozenSnapshot.level === "thread") {
            const root = await threadAuthority.resolve({
              canonicalRootMessageId: request.frozenSnapshot.canonicalRootMessageId!,
              authority: attachmentFence,
            });
            if (!root.active) return root.reason === "missing"
              ? { ready: false, disposition: "discard", reason: CONFIRMED_THREAD_ROOT_MISSING }
              : { ready: false, reason: "provider_thread_receipt_" + root.reason };
            providerRootThreadId = root.fact.providerThreadId;
          }
          const renderedText = withMarker(renderSlackBridgeText(renderSnapshot));
          if (renderedText === null) return { ready: false, reason: "provider_message_render_invalid" };
          const adapter = createSlackOutboundAttachmentAdapter(continueAttachmentTransport(
            transport, request.frozenSnapshot.bindingAuthority, operation,
            async () => withMarker(renderSlackBridgeText(await currentRenderSnapshot())),
          ));
          if (request.reconcileUnknownOutcome) {
            const result = await reconcileExternalOutboundAttachments({ db, deliveryId: request.deliveryId,
              snapshot: request.frozenSnapshot, adapter, providerRootThreadId,
              reconciliationMarker: request.reconciliationMarker, selection });
            if (result?.kind === "accepted") return reconciledProviderReceipt({ ...result,
              providerThreadId: providerRootThreadId, reconciled: true });
            if (result) return { ready: false, reason: result.kind === "rate_limited"
              ? "reconciliation_rate_limited" : "reconciliation_attachment_pending_or_unavailable",
              ...(result.kind === "rate_limited" ? { retryAfterMs: result.retryAfterMs } : {}) };
            // No selected file reached the atomic completion fence. Resume the
            // original file set; only private uploads could have happened.
          }
          if (!storage) return { ready: false, reason: "provider_attachment_runtime_unavailable" };
          return {
            ready: true,
            async dispatch() {
              try {
                const result = await dispatchExternalOutboundAttachments({
                  db,
                  deliveryId: request.deliveryId,
                  reconciliationMarker: request.reconciliationMarker,
                  snapshot: renderSnapshot,
                  renderedText,
                  selection,
                  admitWrite: attachmentWriteAdmission(request, plan.kind === "planned" ? plan.revision : null),
                  admitCompletion: attachmentWriteAdmission(request, plan.kind === "planned" ? plan.revision : null, true),
                  adapter,
                  storage,
                  providerRootThreadId,
                  leaseOwner: `${workerLeaseOwner}:attachment`,
                  now,
                });
                if (result.kind === "prepared") throw new Error("attachment_completion_not_dispatched");
                return result.kind === "accepted" ? { ...result, providerThreadId: providerRootThreadId } : result;
              } finally {
                await dependencies.provider.releaseCredential(handle);
              }
            },
          };
        }
        const prepared = await prepareSlackProvider({
          deliveryId: request.deliveryId,
          reconciliationMarker: request.reconciliationMarker,
          renderSnapshot,
          credentialHandle: handle,
          operationAuthority: authority,
          resolveCurrentRenderMentions: async () => db.transaction(tx => resolveCurrentSlackRenderMentions(tx, request.frozenSnapshot, operation, now())),
          decorateRenderedText: text => selection ? renderSlackAttachmentFallback(text) : text,
        });
        if (!prepared.ready) {
          await dependencies.provider.releaseCredential(handle);
          return prepared;
        }
        return {
          ready: true,
          // The replacement read-to-write lease also belongs to preparation when
          // attempt admission fails before dispatch (budget, expiry or revoke).
          dispose: () => dependencies.provider.releaseCredential(handle),
          async dispatch() {
            const result = await prepared.dispatch().finally(() => dependencies.provider.releaseCredential(handle));
            if (result.kind === "accepted" || result.kind === "rate_limited") return result;
            if (result.kind === "transient_failure") {
              return { ...result, reasonCode: "provider_transient_failure" } as const;
            }
            if (result.kind === "deterministic_failure") {
              return { ...result, reasonCode: "provider_deterministic_failure" } as const;
            }
            return { kind: "outcome_unknown", reasonCode: "provider_outcome_unknown" } as const;
          },
        };
      } catch (error) {
        await dependencies.provider.releaseCredential(handle);
        throw error;
      }
    },
    async releaseCredential({ credentialHandle }) {
      await dependencies.provider.releaseCredential(
        credentialHandle as SlackBridgeCredentialHandle,
      );
    },
    now,
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setClockTimeout(() => {
      timer = null;
      if (stopped || workerPromise) return;
      // Each tick is a root span, so the onError report is tied to it.
      workerPromise = withTraceRoot(dependencies.tracer, "server.slack_bridge.outbound.tick", {
        surface: "server",
        kind: "internal",
      }, async () => {
        try {
          await runOutboundTick();
        } catch (error) {
          dependencies.onError?.(error);
          throw error;
        }
      }).catch(() => {
        // Already reported through onError inside the span.
      }).finally(() => {
        workerPromise = null;
        schedule(workerIntervalMs);
      });
    }, delayMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  };

  const runOutboundTick = async () => {
    if (!deploymentConfigApplied && dependencies.attachmentFallbackDeployment) {
      let outcome: Awaited<ReturnType<typeof applySlackAttachmentFallbackDeployment>> | undefined;
      try {
        outcome = await applySlackAttachmentFallbackDeployment({ db,
          config: dependencies.attachmentFallbackDeployment, now: now() });
      } catch (error) {
        const reportedAt = now().getTime();
        const fingerprint = deploymentFailureFingerprint(error);
        const previousReport = deploymentErrorReports.get(fingerprint);
        if (previousReport === undefined || reportedAt < previousReport || reportedAt - previousReport >= 60_000) {
          if (previousReport === undefined && deploymentErrorReports.size >= 16) {
            const oldest = deploymentErrorReports.keys().next().value;
            if (oldest !== undefined) deploymentErrorReports.delete(oldest);
          }
          deploymentErrorReports.set(fingerprint, reportedAt);
          if (dependencies.onError) dependencies.onError(error);
          else console.error("[SlackBridge] attachment deployment configuration was not applied; outbound tick will retry");
        }
        // Keep existing queue work alive under the canonical DB decision.
        // Planning separately rechecks its protocol before every new plan.
      }
      deploymentConfigApplied = outcome !== undefined;
      if (outcome !== undefined && deploymentErrorReports.size > 0) {
        if (outcome !== "conflict") console.info("[SlackBridge] attachment deployment configuration recovered", {
          generation: dependencies.attachmentFallbackDeployment.generation, outcome,
        });
        deploymentErrorReports.clear();
      }
      if (outcome === "conflict") {
        console.error("[SlackBridge] attachment deployment configuration generation conflicts; publish a higher generation");
        dependencies.onError?.(new Error("Slack attachment deployment configuration generation conflicts; publish a higher generation"));
      }
    }
    const bindings = await listSlackOutboundQueueBindings(db, dependencies.registrationId);
    const heads: Awaited<ReturnType<typeof listSlackPairHeads>> = [];
    for (let offset = 0; offset < bindings.length; offset += SLACK_PAIR_HEAD_BATCH_SIZE) {
      heads.push(...await listPairHeads(db, bindings.slice(offset, offset + SLACK_PAIR_HEAD_BATCH_SIZE)
        .map((binding) => ({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch }))));
    }
    const oldestByBinding = new Map(heads.map((head) => [head.currentBindingId, head]));
    for (const bindingId of terminalAttemptBackoff.keys()) {
      if (!oldestByBinding.has(bindingId)) terminalAttemptBackoff.delete(bindingId);
    }
    const emptyBindings = bindings.filter((binding) => !oldestByBinding.has(binding.id));
    for (let offset = 0; offset < emptyBindings.length; offset += SLACK_PAIR_HEAD_BATCH_SIZE) {
      await clearEmptySlackPairWaits({ db, now: now(), bindings: emptyBindings.slice(offset, offset + SLACK_PAIR_HEAD_BATCH_SIZE)
        .map((binding) => ({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch })) });
    }
    for (const binding of bindings) {
      if (stopped) return;
      const oldest = oldestByBinding.get(binding.id);
      if (!oldest) continue;
      if ((oldest.authorityBlockedReason === "destination_cleanup_custody_conflict"
        || oldest.authorityBlockedReason === "accepted_receipt_counter_conflict")
        && oldest.authorityRetryAt && oldest.authorityRetryAt > now()) continue;
      const scope = { registrationId: dependencies.registrationId, currentBindingId: binding.id,
        currentBindingEpoch: binding.bindingEpoch, bindingId: oldest.bindingId, bindingEpoch: oldest.bindingEpoch };
      // OFF prevents claims/provider I/O; queued work retains a durable explanation.
      const masterGate = await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: binding.serverId }, db);
      const results: ExternalDeliveryWorkerResult[] = [];
      if (masterGate.enabled && binding.hasDeletion) {
        terminalAttemptBackoff.delete(binding.id);
        let next: typeof oldest | undefined = oldest;
        for (let processed = 0; next && processed < SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE && !stopped; processed += 1) {
          const result = await cleanupDeletedSlackPairHead({ ...scope, bindingId: next.bindingId, bindingEpoch: next.bindingEpoch, db, now: now() });
          results.push(result);
          if (result.kind !== "skipped" && result.kind !== "cursor_recovered") break;
          [next] = await listPairHeads(db, [{ bindingId: binding.id, bindingEpoch: binding.bindingEpoch }]);
        }
      } else if (!masterGate.enabled || binding.state !== "active" || binding.installState !== "active") {
        const reason: SlackControlWaitReason = !masterGate.enabled ? "master_disabled"
          : binding.installState !== "active" ? "installation_inactive" : binding.state === "paused" ? binding.stateReason === "provider_channel_archived" ? "binding_paused_archived" : binding.stateReason === "provider_bot_removed" ? "binding_paused_bot_removed" : "binding_paused" : binding.state === "quarantined" ? "binding_quarantined" : "installation_inactive";
        const signature = JSON.stringify([binding.bindingEpoch, reason, oldest.bindingId, oldest.bindingEpoch,
          oldest.deliveryId, oldest.leaseGeneration, oldest.leaseExpiresAt?.getTime(), oldest.state,
          oldest.authorityBlockedAt?.getTime(), oldest.authorityBlockedReason]);
        const previousTerminal = terminalAttemptBackoff.get(binding.id);
        const terminalBackoffActive = previousTerminal?.signature === signature && previousTerminal.until > now().getTime();
        if (previousTerminal && !terminalBackoffActive) terminalAttemptBackoff.delete(binding.id);
        if (!terminalBackoffActive && ((oldest.state === "dispatching" && oldest.leaseExpiresAt && oldest.leaseExpiresAt <= now())
          || !oldest.authorityBlockedAt || !oldest.authorityBlockedReason
          || (isSlackControlWaitReason(oldest.authorityBlockedReason)
            && !isSlackBotRecoveryWaitReason(oldest.authorityBlockedReason) && oldest.authorityBlockedReason !== reason)
          || (reason === "binding_paused_archived" && oldest.authorityBlockedReason === "slack_channel_archived"))) {
          const result = await recordControlWait({ ...scope, db, reason, now: now() });
          results.push(result);
          if (result.kind === "blocked" && result.reason === "terminal_attempt_with_dispatching_delivery") {
            terminalAttemptBackoff.set(binding.id, { signature, until: now().getTime() + TERMINAL_ATTEMPT_RECHECK_MS });
          }
        }
      } else {
        terminalAttemptBackoff.delete(binding.id);
        // Only a sampled control wait needs clearing; the transactional recheck
        // cannot erase a provider failure recorded by another worker meanwhile.
        if (isSlackControlWaitReason(oldest.authorityBlockedReason) && !isSlackBotRecoveryWaitReason(oldest.authorityBlockedReason)) {
          await clearControlWait({ ...scope, db, now: now() });
        }
        results.push(await runWorkerOnce({ db, bindingId: scope.bindingId, bindingEpoch: scope.bindingEpoch,
          leaseOwner: workerLeaseOwner, dependencies: workerDependencies }));
      }
      for (const result of results) {
        observeSlackOutboundWorkerResult(result);
        if (result.kind === "authority_blocked" && result.alert) {
          try { dependencies.onAuthorityAlert?.(result.alert); }
          catch (error) { dependencies.onError?.(error); }
        }
      }
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      uninstallAdmission = installOrdinaryMessageOutboundRuntime({
        authorizationResolver,
        reconciliationMarkerMinter: ({ deliveryId }) =>
          mintSlackBridgeReconciliationMarker(dependencies.reconciliationKey, deliveryId),
      });
      schedule(0);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      uninstallAdmission?.();
      uninstallAdmission = null;
      if (timer) clearClockTimeout(timer);
      timer = null;
      await workerPromise?.catch(() => undefined);
      for (const preparation of sourcePreparations.values()) preparation.controller.abort();
      // fanout-ok: at most four already-running preparations; this only awaits them, without starting I/O.
      await Promise.allSettled([...sourcePreparations.values()].map((preparation) => preparation.promise));
    },
  };
}
