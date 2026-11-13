import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { recordAssistantDoorbells } from "./assistantService";
import { getDb, type DatabaseExecutor } from "../db/index";
import { chunkForBindParameters, insertParametersPerRow } from "../db/bindParameterBudget";
import {
  agentChannelReadCursors,
  channels,
  inboxNotificationFacts,
  inboxSuppressionStates,
  inboxTargetMuteStates,
  userChannelReadCursors,
} from "../db/schema";
import {
  type InboxPolicyNotificationFact,
} from "./inboxPolicyModel";
import { isActivityPromotionSuppressedByMute } from "./inboxMutePolicy";
import { addTraceEvent } from "../tracing/semanticTrace";
import { enqueueNotificationsForFacts, type InboxFactNotificationContext } from "./notifications/enqueue";

export type InboxNotificationReceiverType = "user" | "agent";
// `task`: a task conversation (task v2) — thread semantics, own display kind.
export type InboxNotificationTargetKind = "channel" | "dm" | "thread" | "task";
type InboxTraceDecisionState = "activity_promoted" | "activity_not_promoted";
type InboxTraceDecisionReason = "eligible" | "muted" | "personal_mention_pierced" | "thread_independent" | "unfollowed_thread_ordinary";
type InboxTraceRebuildState = "row_upserted" | "row_deleted" | "row_skipped";
type InboxTraceIncrementState = "row_upserted" | "row_skipped";
type InboxTraceNegativeEvidenceBucket =
  | "does_not_prove_read_state_or_ui_rendered"
  | "muted_not_unfollowed_or_not_eligible"
  | "unfollowed_thread_not_muted_or_not_eligible"
  | "thread_follow_policy_not_evaluated"
  | "does_not_prove_message_ineligible"
  | "does_not_prove_fact_absent";

const INBOX_TRACE_CONTRACT_VERSION = 1;

export type InboxNotificationFactInput = {
  receiverType: InboxNotificationReceiverType;
  receiverId: string;
  serverId: string;
  kind: InboxNotificationTargetKind;
  sourceChannelId: string;
  messageId: string;
  messageSeq: number;
  activityAt: Date;
  personalMention?: boolean;
  unreadEligible?: boolean;
  suppressionReason?: "unfollowed_thread_ordinary";
};

export type InboxServingTarget = {
  receiverType: InboxNotificationReceiverType;
  receiverId: string;
  sourceChannelId: string;
};

function targetKey(target: InboxServingTarget) {
  return `${target.receiverType}:${target.receiverId}:${target.sourceChannelId}`;
}

function uniqueTargets(targets: readonly InboxServingTarget[]): InboxServingTarget[] {
  const byKey = new Map<string, InboxServingTarget>();
  for (const target of targets) byKey.set(targetKey(target), target);
  return [...byKey.values()];
}

function factTargetKey(fact: Pick<InboxNotificationFactInput, "receiverType" | "receiverId" | "sourceChannelId">) {
  return `${fact.receiverType}:${fact.receiverId}:${fact.sourceChannelId}`;
}

function factTraceJoinKey(fact: Pick<InboxNotificationFactInput, "receiverType" | "receiverId" | "sourceChannelId" | "messageId">) {
  return `${fact.receiverType}:${fact.receiverId}:${fact.sourceChannelId}:${fact.messageId}`;
}

function targetTraceJoinKey(target: InboxServingTarget) {
  return `${target.receiverType}:${target.receiverId}:${target.sourceChannelId}`;
}

/** Thread and task-conversation facts share the sub-conversation follow policy. */
function isSubConversationFact(fact: Pick<InboxNotificationFactInput, "kind">): boolean {
  return fact.kind === "thread" || fact.kind === "task";
}

function isSuppressedByUnfollowedThreadOrdinary(fact: InboxNotificationFactInput) {
  return isSubConversationFact(fact)
    && fact.suppressionReason === "unfollowed_thread_ordinary"
    && fact.personalMention !== true;
}

function traceInboxNotificationFactDecision(
  fact: InboxNotificationFactInput,
  muteFromSeq: number | null | undefined,
  suppressedByMute: boolean,
) {
  const personalMention = fact.personalMention === true;
  const suppressedByUnfollowedThreadOrdinary = isSuppressedByUnfollowedThreadOrdinary(fact);
  let state: InboxTraceDecisionState = suppressedByMute || suppressedByUnfollowedThreadOrdinary ? "activity_not_promoted" : "activity_promoted";
  let reason: InboxTraceDecisionReason = "eligible";
  let negativeEvidenceBucket: InboxTraceNegativeEvidenceBucket = "does_not_prove_read_state_or_ui_rendered";

  if (suppressedByMute) {
    reason = "muted";
    negativeEvidenceBucket = "muted_not_unfollowed_or_not_eligible";
  } else if (suppressedByUnfollowedThreadOrdinary) {
    reason = "unfollowed_thread_ordinary";
    negativeEvidenceBucket = "unfollowed_thread_not_muted_or_not_eligible";
  } else if (isSubConversationFact(fact)) {
    reason = "thread_independent";
    negativeEvidenceBucket = "thread_follow_policy_not_evaluated";
  } else if (personalMention && muteFromSeq != null && fact.messageSeq >= muteFromSeq) {
    reason = "personal_mention_pierced";
  }

  addTraceEvent("inbox.notification_fact.decision", {
    "inbox.trace_contract_version": INBOX_TRACE_CONTRACT_VERSION,
    "inbox.trace_join_key": factTraceJoinKey(fact),
    receiver_type: fact.receiverType,
    receiver_id: fact.receiverId,
    source_channel_id: fact.sourceChannelId,
    message_id: fact.messageId,
    message_seq: fact.messageSeq,
    target_kind: fact.kind,
    state,
    reason,
    negative_evidence_bucket: negativeEvidenceBucket,
    personal_mention: personalMention,
    unread_eligible: fact.unreadEligible !== false,
    suppression_reason: fact.suppressionReason ?? null,
    mute_from_seq_present: muteFromSeq != null,
    ...(muteFromSeq != null ? { mute_from_seq: muteFromSeq } : {}),
  });
}

function traceInboxServingRowRebuild(
  target: InboxServingTarget,
  attrs: {
    state: InboxTraceRebuildState;
    reason: "projected" | "no_projected_notification_facts" | "latest_fact_missing";
    factsCount: number;
    lastReadSeq: number;
    latestNotifiedSeq?: number;
    unreadCount?: number;
    hasAnyMention?: boolean;
    kind?: InboxNotificationTargetKind;
  },
) {
  const negativeEvidenceBucket: InboxTraceNegativeEvidenceBucket = attrs.state === "row_deleted"
    ? "does_not_prove_message_ineligible"
    : attrs.state === "row_skipped"
      ? "does_not_prove_fact_absent"
      : "does_not_prove_read_state_or_ui_rendered";
  addTraceEvent("inbox.serving_row.rebuild", {
    "inbox.trace_contract_version": INBOX_TRACE_CONTRACT_VERSION,
    "inbox.trace_join_key": targetTraceJoinKey(target),
    receiver_type: target.receiverType,
    receiver_id: target.receiverId,
    source_channel_id: target.sourceChannelId,
    state: attrs.state,
    reason: attrs.reason,
    negative_evidence_bucket: negativeEvidenceBucket,
    facts_count: attrs.factsCount,
    last_read_seq: attrs.lastReadSeq,
    ...(attrs.latestNotifiedSeq != null ? { latest_notified_seq: attrs.latestNotifiedSeq } : {}),
    ...(attrs.unreadCount != null ? { unread_count: attrs.unreadCount } : {}),
    ...(attrs.hasAnyMention != null ? { has_any_mention: attrs.hasAnyMention } : {}),
    ...(attrs.kind ? { target_kind: attrs.kind } : {}),
  });
}

type InboxServingRowIncrementTraceAttrs = {
  state: InboxTraceIncrementState;
  reason: "inserted_facts" | "suppressed_by_done_watermark" | "inactive_channel";
  factsCount: number;
  unreadCount: number;
  hasAnyMention: boolean;
  kind: InboxNotificationTargetKind;
};

function traceInboxServingRowIncrement(
  target: InboxServingTarget,
  attrs: InboxServingRowIncrementTraceAttrs,
) {
  addTraceEvent("inbox.serving_row.increment", {
    "inbox.trace_contract_version": INBOX_TRACE_CONTRACT_VERSION,
    "inbox.trace_join_key": targetTraceJoinKey(target),
    receiver_type: target.receiverType,
    receiver_id: target.receiverId,
    source_channel_id: target.sourceChannelId,
    state: attrs.state,
    reason: attrs.reason,
    negative_evidence_bucket: "does_not_prove_read_state_or_ui_rendered",
    facts_count: attrs.factsCount,
    unread_count: attrs.unreadCount,
    has_any_mention: attrs.hasAnyMention,
    target_kind: attrs.kind,
  });
}

type SuppressionDoneTargetKind = "channel" | "dm" | "followed_thread" | "public_channel_mention" | "public_thread_mention";

// Suppression target kinds whose `done_through_seq` watermark suppresses Activity promotion
// for the target channel. Declared once, beside the reader that consumes it, so the batched
// and single-target lookups cannot drift apart.
const DONE_TARGET_KINDS: SuppressionDoneTargetKind[] = [
  "channel",
  "dm",
  "followed_thread",
  "public_channel_mention",
  "public_thread_mention",
];

/**
 * Batched read-frontier lookup: one statement per principal class, not one per (receiver,
 * channel) target. `targets` is the fan-out of the send being recorded, so the cost stays
 * proportional to that fan-out and never to the accumulated history of any receiver.
 *
 * The source query may return pairs outside `targets`; results are keyed by the exact pair,
 * so only requested pairs are ever read back.
 */
async function getLastReadSeqByTarget(
  targets: readonly InboxServingTarget[],
  executor: DatabaseExecutor,
): Promise<Map<string, number>> {
  const lastReadSeqByTarget = new Map<string, number>();
  const userTargets = targets.filter((target) => target.receiverType === "user");
  const agentTargets = targets.filter((target) => target.receiverType === "agent");
  const channelIds = [...new Set(targets.map((target) => target.sourceChannelId))];

  if (userTargets.length > 0) {
    const rows = await executor
      .select({
        receiverId: userChannelReadCursors.userId,
        sourceChannelId: userChannelReadCursors.channelId,
        lastReadSeq: userChannelReadCursors.lastReadSeq,
      })
      .from(userChannelReadCursors)
      .where(and(
        inArray(userChannelReadCursors.userId, [...new Set(userTargets.map((target) => target.receiverId))]),
        inArray(userChannelReadCursors.channelId, channelIds),
      ));
    for (const row of rows) {
      lastReadSeqByTarget.set(targetKey({
        receiverType: "user",
        receiverId: row.receiverId,
        sourceChannelId: row.sourceChannelId,
      }), row.lastReadSeq);
    }
  }

  if (agentTargets.length > 0) {
    const rows = await executor
      .select({
        receiverId: agentChannelReadCursors.agentId,
        sourceChannelId: agentChannelReadCursors.channelId,
        lastReadSeq: agentChannelReadCursors.lastReadSeq,
      })
      .from(agentChannelReadCursors)
      .where(and(
        inArray(agentChannelReadCursors.agentId, [...new Set(agentTargets.map((target) => target.receiverId))]),
        inArray(agentChannelReadCursors.channelId, channelIds),
      ));
    for (const row of rows) {
      lastReadSeqByTarget.set(targetKey({
        receiverType: "agent",
        receiverId: row.receiverId,
        sourceChannelId: row.sourceChannelId,
      }), row.lastReadSeq);
    }
  }

  return lastReadSeqByTarget;
}

// Single-target wrappers keep the rebuild path's call sites and semantics unchanged.
async function getLastReadSeq(
  target: InboxServingTarget,
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  return (await getLastReadSeqByTarget([target], executor)).get(targetKey(target)) ?? 0;
}

/**
 * Batched Done-frontier lookup. Rows for pairs outside `targets` are ignored before the
 * unsafe-sequence guard runs, so the guard still fires on exactly the pairs the
 * single-target version checked.
 */
async function getDoneThroughSeqByTarget(
  targets: readonly InboxServingTarget[],
  executor: DatabaseExecutor,
): Promise<Map<string, number | null>> {
  const doneThroughSeqByTarget = new Map<string, number | null>();
  const userTargets = targets.filter((target) => target.receiverType === "user");
  const requestedKeys = new Set(userTargets.map((target) => targetKey(target)));

  if (userTargets.length > 0) {
    const suppressionRows = await executor
      .select({
        receiverId: inboxSuppressionStates.receiverId,
        sourceChannelId: inboxSuppressionStates.targetChannelId,
        doneThroughSeq: inboxSuppressionStates.doneThroughSeq,
      })
      .from(inboxSuppressionStates)
      .where(and(
        eq(inboxSuppressionStates.receiverType, "user"),
        inArray(inboxSuppressionStates.receiverId, [...new Set(userTargets.map((target) => target.receiverId))]),
        inArray(inboxSuppressionStates.targetKind, [...DONE_TARGET_KINDS]),
        inArray(inboxSuppressionStates.targetChannelId, [...new Set(userTargets.map((target) => target.sourceChannelId))]),
      ));
    for (const row of suppressionRows) {
      const key = targetKey({
        receiverType: "user",
        receiverId: row.receiverId,
        sourceChannelId: row.sourceChannelId,
      });
      if (!requestedKeys.has(key)) continue;
      if (row.doneThroughSeq == null) continue;
      const seq = Number(row.doneThroughSeq);
      if (!Number.isSafeInteger(seq)) throw new Error(`unsafe suppression sequence: ${String(row.doneThroughSeq)}`);
      const previous = doneThroughSeqByTarget.get(key);
      if (previous == null || seq > previous) doneThroughSeqByTarget.set(key, seq);
    }
  }

  for (const key of requestedKeys) {
    if (!doneThroughSeqByTarget.has(key)) doneThroughSeqByTarget.set(key, null);
  }
  return doneThroughSeqByTarget;
}

async function getDoneThroughSeq(
  target: InboxServingTarget,
  executor: DatabaseExecutor,
): Promise<number | null> {
  return (await getDoneThroughSeqByTarget([target], executor)).get(targetKey(target)) ?? null;
}

function inboxFactInsertValues(fact: InboxNotificationFactInput): typeof inboxNotificationFacts.$inferInsert {
  return {
    receiverType: fact.receiverType,
    receiverId: fact.receiverId,
    serverId: fact.serverId,
    kind: fact.kind,
    sourceChannelId: fact.sourceChannelId,
    messageId: fact.messageId,
    messageSeq: fact.messageSeq,
    activityAt: fact.activityAt,
    personalMention: fact.personalMention === true,
    unreadEligible: fact.unreadEligible !== false,
  };
}

/**
 * Record a send's inbox facts and, in the same transaction, its notification
 * outbox rows (services/notifications/enqueue.ts): the facts that survive the
 * mute / unfollowed-thread filters below are the one audience of every
 * notification transport. `notification` describes the event (producer,
 * mention-only public channel recipients); without it the facts notify as an
 * ordinary message.
 */
export async function recordInboxNotificationFacts(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor = getDb(),
  notification?: InboxFactNotificationContext,
): Promise<number> {
  if (facts.length === 0) {
    // Mention-only public channel recipients and a task's personal recipients
    // have no fact but are notified.
    if (notification) await enqueueNotificationsForFacts([], executor, notification);
    return 0;
  }
  const muteStateCandidates = facts.filter((fact) => !isSubConversationFact(fact));
  let filteredFacts = facts;
  let muteByTarget = new Map<string, number | null>();
  if (muteStateCandidates.length > 0) {
    const sourceChannelIds = [...new Set(muteStateCandidates.map((fact) => fact.sourceChannelId))];
    const receiverIds = [...new Set(muteStateCandidates.map((fact) => fact.receiverId))];
    const muteRows = await executor
      .select({
        receiverType: inboxTargetMuteStates.receiverType,
        receiverId: inboxTargetMuteStates.receiverId,
        sourceChannelId: inboxTargetMuteStates.sourceChannelId,
        muteFromSeq: inboxTargetMuteStates.muteFromSeq,
      })
      .from(inboxTargetMuteStates)
      .where(and(
        inArray(inboxTargetMuteStates.sourceChannelId, sourceChannelIds),
        inArray(inboxTargetMuteStates.receiverId, receiverIds),
        // An assistant DM's row keeps it out of Activity, not off the phone.
        eq(inboxTargetMuteStates.pushMuted, true),
      ));
    muteByTarget = new Map(muteRows.map((row) => [factTargetKey(row), row.muteFromSeq]));
  }
  filteredFacts = facts.filter((fact) => {
    const muteFromSeq = muteByTarget.get(factTargetKey(fact));
    const suppressedByMute = isActivityPromotionSuppressedByMute({
      kind: fact.kind,
      messageSeq: fact.messageSeq,
      muteFromSeq,
      personalMention: fact.personalMention === true,
    });
    traceInboxNotificationFactDecision(fact, muteFromSeq, suppressedByMute);
    return !suppressedByMute && !isSuppressedByUnfollowedThreadOrdinary(fact);
  });
  if (filteredFacts.length === 0) {
    if (notification) await enqueueNotificationsForFacts([], executor, notification);
    return 0;
  }
  const factsByIdentity = new Map<string, InboxNotificationFactInput>();
  for (const fact of filteredFacts) {
    const previous = factsByIdentity.get(factTraceJoinKey(fact));
    factsByIdentity.set(factTraceJoinKey(fact), previous
      ? {
        ...fact,
        personalMention: previous.personalMention === true || fact.personalMention === true,
        unreadEligible: previous.unreadEligible !== false && fact.unreadEligible !== false,
      }
      : fact);
  }
  const uniqueFacts = [...factsByIdentity.values()];
  // One statement per bind-parameter chunk: a single multi-row VALUES for a large channel's
  // fan-out would exceed PostgreSQL's 65,535-parameter limit (≈5,957 receivers at 11 per row).
  // `uniqueFacts` is unique per conflict key, so chunks never conflict with each other.
  const factParametersPerRow = insertParametersPerRow(inboxNotificationFacts);
  const insertedRows: { receiverType: InboxNotificationReceiverType; receiverId: string; sourceChannelId: string; messageId: string }[] = [];
  for (const chunk of chunkForBindParameters(uniqueFacts, factParametersPerRow)) {
    insertedRows.push(...await executor
      .insert(inboxNotificationFacts)
      .values(chunk.map(inboxFactInsertValues))
      .onConflictDoNothing({
        target: [
          inboxNotificationFacts.receiverType,
          inboxNotificationFacts.receiverId,
          inboxNotificationFacts.sourceChannelId,
          inboxNotificationFacts.messageId,
        ],
      })
      .returning({
        receiverType: inboxNotificationFacts.receiverType,
        receiverId: inboxNotificationFacts.receiverId,
        sourceChannelId: inboxNotificationFacts.sourceChannelId,
        messageId: inboxNotificationFacts.messageId,
      }));
  }
  // A retry after facts committed but serving-row maintenance failed lands in
  // the conflict bucket and takes the authoritative rebuild path. Normal new
  // facts avoid reading target history altogether.
  const insertedKeys = new Set(insertedRows.map(factTraceJoinKey));
  const insertedFacts = uniqueFacts.filter((fact) => insertedKeys.has(factTraceJoinKey(fact)));
  const conflictingFacts = uniqueFacts.filter((fact) => !insertedKeys.has(factTraceJoinKey(fact)));
  const conflictingTargetKeys = new Set(conflictingFacts.map(factTargetKey));

  if (conflictingFacts.length > 0) {
    for (const chunk of chunkForBindParameters(conflictingFacts, factParametersPerRow)) {
      await executor
        .insert(inboxNotificationFacts)
        .values(chunk.map(inboxFactInsertValues))
        .onConflictDoUpdate({
          target: [
            inboxNotificationFacts.receiverType,
            inboxNotificationFacts.receiverId,
            inboxNotificationFacts.sourceChannelId,
            inboxNotificationFacts.messageId,
          ],
          set: {
            serverId: sql`excluded.server_id`,
            kind: sql`excluded.kind`,
            messageSeq: sql`excluded.message_seq`,
            activityAt: sql`excluded.activity_at`,
            personalMention: sql`${inboxNotificationFacts.personalMention} OR excluded.personal_mention`,
            unreadEligible: sql`${inboxNotificationFacts.unreadEligible} AND excluded.unread_eligible`,
          },
        });
    }
  }

  await enqueueNotificationsForFacts(filteredFacts, executor, notification);
  // RFC 074 §2: ring the owner's assistant (if any) in this same transaction.
  await recordAssistantDoorbells(filteredFacts, executor);
  return filteredFacts.length;
}
