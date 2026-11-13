import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { needsSlackBridgeManualRetry, type SlackBridgeRawHealth, type SlackPairConfirmationDetail } from "@botiverse/raft-shared";

import type { DatabaseExecutor } from "../db/index";
import {
  externalAppInstalls, externalAppRegistrations, externalChannelBindings,
  externalDeliveryPartitions, externalOutboundDeliveries, slackChannelDeletions,
} from "../db/schema";

export const SLACK_PAIR_HEAD_BATCH_SIZE = 500;

/** A bot-removal wait stays attached to the pair until a fresh audience check succeeds. */
export const SLACK_BOT_RECOVERY_WAIT_REASONS = ["binding_paused_bot_removed", "slack_not_in_channel"] as const;

export function isSlackBotRecoveryWaitReason(reason: string | null): boolean {
  return SLACK_BOT_RECOVERY_WAIT_REASONS.some((candidate) => candidate === reason);
}

/** Include empty historical partitions: an audited skip must not authorize later queued work. */
export async function listSlackPairRecoveryWaits(executor: DatabaseExecutor, pair: {
  appRegistrationId: string; environment: string; raftChannelId: string;
  providerAuthorityId: string; providerConversationId: string;
}) {
  return executor.select({ id: externalDeliveryPartitions.id, bindingId: externalDeliveryPartitions.bindingId,
    bindingEpoch: externalDeliveryPartitions.bindingEpoch, reason: externalDeliveryPartitions.authorityBlockedReason })
    .from(externalDeliveryPartitions)
    .innerJoin(externalChannelBindings, sql`${externalDeliveryPartitions.bindingId} = ${externalChannelBindings.id}::text`)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
    .where(and(eq(externalChannelBindings.registrationId, pair.appRegistrationId),
      eq(externalChannelBindings.channelId, pair.raftChannelId),
      eq(externalChannelBindings.providerConversationId, pair.providerConversationId),
      eq(externalAppInstalls.providerAuthorityId, pair.providerAuthorityId),
      eq(externalAppRegistrations.provider, "slack"), sql`${externalAppRegistrations.environment} = ${pair.environment}`,
      inArray(externalDeliveryPartitions.authorityBlockedReason, [...SLACK_BOT_RECOVERY_WAIT_REASONS])))
    .orderBy(asc(externalDeliveryPartitions.id)).limit(1);
}

export async function findSlackPairRecoveryIdentity(executor: DatabaseExecutor, input: { bindingId: string; bindingEpoch: number }) {
  const [pair] = await executor.select({ appRegistrationId: externalChannelBindings.registrationId,
    environment: externalAppRegistrations.environment, raftChannelId: externalChannelBindings.channelId,
    providerAuthorityId: externalAppInstalls.providerAuthorityId, providerConversationId: externalChannelBindings.providerConversationId })
    .from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
    .where(and(eq(externalChannelBindings.id, input.bindingId), eq(externalChannelBindings.bindingEpoch, input.bindingEpoch),
      eq(externalAppRegistrations.provider, "slack"))).limit(1);
  return pair ?? null;
}

export type SlackPairRecoveryFence = {
  head: { bindingId: string; bindingEpoch: number; deliveryId: string; state: string; leaseGeneration: number } | null;
  waitId: string | null;
};

/** Capture queue custody before reading Slack, so a later failure invalidates that proof. */
export async function readSlackPairRecoveryFence(executor: DatabaseExecutor, input: { bindingId: string; bindingEpoch: number }): Promise<SlackPairRecoveryFence | null> {
  const pair = await findSlackPairRecoveryIdentity(executor, input);
  if (!pair) return null;
  const [head] = await listSlackPairHeads(executor, [input]);
  const [wait] = await listSlackPairRecoveryWaits(executor, pair);
  return { head: head ? { bindingId: head.bindingId, bindingEpoch: head.bindingEpoch, deliveryId: head.deliveryId,
    state: head.state, leaseGeneration: head.leaseGeneration } : null, waitId: wait?.id ?? null };
}

export function sameSlackPairRecoveryFence(left: SlackPairRecoveryFence, right: SlackPairRecoveryFence): boolean {
  return left.waitId === right.waitId && ((!left.head && !right.head) || Boolean(left.head && right.head
    && left.head.bindingId === right.head.bindingId && left.head.bindingEpoch === right.head.bindingEpoch
    && left.head.deliveryId === right.head.deliveryId && left.head.state === right.head.state
    && left.head.leaseGeneration === right.head.leaseGeneration));
}

/** One oldest storage head per actual pair, independent of binding generations. */
export async function listSlackPairHeads(executor: DatabaseExecutor, bindings: readonly {
  bindingId: string; bindingEpoch: number;
}[]) {
  if (!bindings.length) return [];
  if (bindings.length > SLACK_PAIR_HEAD_BATCH_SIZE) throw new Error("Chunk Slack pair head reads");
  const current = alias(externalChannelBindings, "pair_current");
  const currentInstall = alias(externalAppInstalls, "pair_current_install");
  const currentRegistration = alias(externalAppRegistrations, "pair_current_registration");
  const historical = alias(externalChannelBindings, "pair_history");
  const historicalInstall = alias(externalAppInstalls, "pair_history_install");
  const historicalRegistration = alias(externalAppRegistrations, "pair_history_registration");
  return executor.selectDistinctOn([current.id], {
    authorityBlockedAt: externalDeliveryPartitions.authorityBlockedAt,
    authorityBlockedReason: externalDeliveryPartitions.authorityBlockedReason,
    authorityRetryAt: externalDeliveryPartitions.authorityRetryAt,
    currentBindingId: current.id, currentBindingEpoch: current.bindingEpoch,
    bindingId: externalDeliveryPartitions.bindingId, bindingEpoch: externalDeliveryPartitions.bindingEpoch,
    deliveryId: externalOutboundDeliveries.id, state: externalOutboundDeliveries.state,
    leaseGeneration: externalOutboundDeliveries.leaseGeneration,
    leaseExpiresAt: externalOutboundDeliveries.leaseExpiresAt,
    providerAttempts: externalOutboundDeliveries.providerAttempts,
    ambiguityBudgetProviderAttempts: externalOutboundDeliveries.ambiguityBudgetProviderAttempts,
    dispatchedFailureAttempts: externalOutboundDeliveries.dispatchedFailureAttempts,
    firstDispatchedAt: externalOutboundDeliveries.firstDispatchedAt, stateReason: externalOutboundDeliveries.stateReason,
    createdAt: externalOutboundDeliveries.createdAt,
    // Only partitions with a head join, so this sums every unsent message of the pair.
    pairPendingMessages: sql<string>`sum(${externalDeliveryPartitions.lastEnqueuedPosition} - ${externalDeliveryPartitions.cursorPosition}) over (partition by ${current.id})`,
  }).from(current)
    .innerJoin(currentInstall, eq(currentInstall.id, current.installId))
    .innerJoin(currentRegistration, eq(currentRegistration.id, current.registrationId))
    .innerJoin(historical, and(eq(historical.registrationId, current.registrationId), eq(historical.channelId, current.channelId),
      eq(historical.providerConversationId, current.providerConversationId)))
    .innerJoin(historicalInstall, and(eq(historicalInstall.id, historical.installId),
      eq(historicalInstall.providerAuthorityId, currentInstall.providerAuthorityId)))
    .innerJoin(historicalRegistration, and(eq(historicalRegistration.id, historical.registrationId),
      eq(historicalRegistration.environment, currentRegistration.environment),
      eq(historicalRegistration.provider, currentRegistration.provider)))
    .innerJoin(externalDeliveryPartitions, sql`${externalDeliveryPartitions.bindingId} = ${historical.id}::text`)
    .innerJoin(externalOutboundDeliveries, and(
      eq(externalOutboundDeliveries.bindingId, externalDeliveryPartitions.bindingId),
      eq(externalOutboundDeliveries.bindingEpoch, externalDeliveryPartitions.bindingEpoch),
      eq(externalOutboundDeliveries.partitionPosition, sql`${externalDeliveryPartitions.cursorPosition} + 1`),
    )).where(and(
      or(...bindings.map((binding) => and(eq(current.id, binding.bindingId), eq(current.bindingEpoch, binding.bindingEpoch)))),
    )).orderBy(asc(current.id), asc(externalOutboundDeliveries.createdAt), asc(externalOutboundDeliveries.id));
}

/** Report a sticky wait from any generation on the pair's visible FIFO head. */
export async function listSlackPairHeadsForHealth(executor: DatabaseExecutor, bindings: readonly {
  bindingId: string; bindingEpoch: number;
}[]) {
  const heads = await listSlackPairHeads(executor, bindings);
  if (!heads.length) return heads;
  const current = alias(externalChannelBindings, "health_current");
  const currentInstall = alias(externalAppInstalls, "health_current_install");
  const history = alias(externalChannelBindings, "health_history");
  const historyInstall = alias(externalAppInstalls, "health_history_install");
  const waits = await executor.selectDistinctOn([current.id], {
    currentBindingId: current.id,
    authorityBlockedAt: externalDeliveryPartitions.authorityBlockedAt,
    authorityBlockedReason: externalDeliveryPartitions.authorityBlockedReason,
    authorityRetryAt: externalDeliveryPartitions.authorityRetryAt,
  }).from(current)
    .innerJoin(currentInstall, eq(currentInstall.id, current.installId))
    .innerJoin(history, and(eq(history.registrationId, current.registrationId), eq(history.channelId, current.channelId),
      eq(history.providerConversationId, current.providerConversationId)))
    .innerJoin(historyInstall, and(eq(historyInstall.id, history.installId),
      eq(historyInstall.providerAuthorityId, currentInstall.providerAuthorityId)))
    .innerJoin(externalDeliveryPartitions, sql`${externalDeliveryPartitions.bindingId} = ${history.id}::text`)
    .where(and(or(...heads.map((head) => and(eq(current.id, head.currentBindingId),
      eq(current.bindingEpoch, head.currentBindingEpoch)))),
      inArray(externalDeliveryPartitions.authorityBlockedReason, [...SLACK_BOT_RECOVERY_WAIT_REASONS])))
    .orderBy(asc(current.id), asc(externalDeliveryPartitions.authorityBlockedAt),
      asc(externalDeliveryPartitions.bindingId), asc(externalDeliveryPartitions.bindingEpoch));
  const byBinding = new Map(waits.map((wait) => [wait.currentBindingId, wait]));
  return heads.map((head) => {
    const wait = byBinding.get(head.currentBindingId);
    return wait?.authorityBlockedAt && wait.authorityBlockedReason ? { ...head,
      authorityBlockedAt: wait.authorityBlockedAt, authorityBlockedReason: wait.authorityBlockedReason,
      authorityRetryAt: wait.authorityRetryAt } : head;
  });
}

/** Active controls, plus deleted retired bindings only while they still own work. */
export async function listSlackOutboundQueueBindings(executor: DatabaseExecutor, registrationId: string) {
  const recordedDeletion = sql<boolean>`EXISTS (SELECT 1 FROM ${slackChannelDeletions}
      WHERE ${slackChannelDeletions.registrationId} = ${externalChannelBindings.registrationId}
        AND ${slackChannelDeletions.environment} = ${externalAppRegistrations.environment}
        AND ${slackChannelDeletions.providerAppId} = ${externalAppInstalls.providerAppId}
        AND ${slackChannelDeletions.providerAuthorityId} = ${externalAppInstalls.providerAuthorityId}
        AND ${slackChannelDeletions.providerConversationId} = ${externalChannelBindings.providerConversationId})`;

  return executor.select({
    id: externalChannelBindings.id,
    bindingEpoch: externalChannelBindings.bindingEpoch,
    serverId: externalChannelBindings.serverId,
    state: externalChannelBindings.state, stateReason: externalChannelBindings.stateReason,
    installState: externalAppInstalls.state, hasDeletion: recordedDeletion,
  }).from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
    .where(and(
      eq(externalChannelBindings.registrationId, registrationId),
      or(inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
        and(recordedDeletion, sql`EXISTS (SELECT 1 FROM ${externalDeliveryPartitions}
          WHERE ${externalDeliveryPartitions.bindingId} = ${externalChannelBindings.id}::text
            AND ${externalDeliveryPartitions.cursorPosition} < ${externalDeliveryPartitions.lastEnqueuedPosition})`)),
    ));
}

export type SlackPairQueueStatus = "idle" | "flowing" | "waiting" | "stalled" | "paused";

type SlackPairHead = Awaited<ReturnType<typeof listSlackPairHeads>>[number];

/**
 * One status per pair, with the same precedence as the setup health panel: a
 * pair-level block hides its head, and a head that needs a retry or skip is
 * stalled. A pair whose binding or installation is not active, or whose head
 * waits on an intentional control such as the master switch, is paused.
 */
export function classifySlackPairQueue(input: {
  bindingState: string;
  installState: string;
  head: Pick<SlackPairHead, "authorityBlockedAt" | "state" | "ambiguityBudgetProviderAttempts"
    | "dispatchedFailureAttempts" | "firstDispatchedAt"> | undefined;
  /** The head waits on an intentional control (master switch, pause), not a fault. */
  pairControlled?: boolean;
  now: Date;
}): SlackPairQueueStatus {
  const { head } = input;
  // A stopped pair counts as paused even with nothing queued yet.
  if (input.bindingState !== "active" || input.installState !== "active") return "paused";
  if (!head) return "idle";
  if (input.pairControlled) return "paused";
  if (head.authorityBlockedAt) return "waiting";
  if (head.state === "quarantined" || needsSlackBridgeManualRetry({
    ...head, firstDispatchedAt: head.firstDispatchedAt?.toISOString() ?? null,
  }, input.now)) return "stalled";
  return "flowing";
}

export type SlackPairBlockHint = NonNullable<SlackBridgeRawHealth["outboundPairBlocks"]>[number]["reason"];

/** The closed, actionable hint for a recorded pair-level block reason. */
export function slackPairBlockHint(block: string): SlackPairBlockHint {
  return block === "slack_not_in_channel" || block === "binding_paused_bot_removed" ? "invite_app"
    : block === "slack_channel_archived" || block === "binding_paused_archived" ? "unarchive"
      : block === "slack_channel_not_found" ? "check_channel"
        : block === "slack_permission_missing" || block === "provider_credential_revoked" ? "reauthorize"
          : block.includes("credential") ? "credentials"
            : block.includes("runtime") ? "connection" : "configuration";
}

/**
 * A block that is not a fault to fix but a delivery Raft cannot confirm yet (its reconciliation
 * scan found neither the message nor proof it is absent): which case, for a specific hint.
 */
export function slackPairConfirmationDetail(block: string): SlackPairConfirmationDetail | undefined {
  return block === "reconciliation_history_limited" ? "history_limited"
    : block === "reconciliation_bridge_metadata_missing" ? "metadata_missing"
      : block === "reconciliation_marker_unconfirmed" ? "marker_unconfirmed" : undefined;
}

export type SlackPairOutboundHold =
  | { status: "waiting"; reason: SlackPairBlockHint; detail?: SlackPairConfirmationDetail; since: string }
  | { status: "stalled"; since: string };

/** What a bridged channel shows while its Raft messages for Slack are held; null while they flow. */
export function slackPairOutboundHold(head: SlackPairHead, now: Date): SlackPairOutboundHold | null {
  if (head.authorityBlockedAt && head.authorityBlockedReason) {
    const detail = slackPairConfirmationDetail(head.authorityBlockedReason);
    return {
      status: "waiting",
      reason: slackPairBlockHint(head.authorityBlockedReason),
      // The channel list is not parsed strictly: an older web ignores it and shows `reason`.
      ...(detail ? { detail } : {}),
      since: head.authorityBlockedAt.toISOString(),
    };
  }
  return classifySlackPairQueue({ bindingState: "active", installState: "active", head, now }) === "stalled"
    ? { status: "stalled", since: head.createdAt.toISOString() }
    : null;
}
