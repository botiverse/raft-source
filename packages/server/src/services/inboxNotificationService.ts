import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  agentChannelReadCursors,
  channels,
  inboxNotificationFacts,
  inboxServingRows,
  inboxSuppressionStates,
  inboxTargetMuteStates,
  userChannelReadCursors,
} from "../db/schema.js";
import {
  projectInboxServingRowsFromNotificationFacts,
  type InboxPolicyNotificationFact,
} from "./inboxPolicyModel.js";
import { isActivityPromotionSuppressedByMute } from "./inboxMutePolicy.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import { enqueueMobilePushForInboxFacts } from "./pushService.js";

export type InboxNotificationReceiverType = "user" | "agent";
export type InboxNotificationTargetKind = "channel" | "dm" | "thread";
type InboxTraceDecisionState = "activity_promoted" | "activity_not_promoted";
type InboxTraceDecisionReason = "eligible" | "muted" | "personal_mention_pierced" | "thread_independent" | "unfollowed_thread_ordinary";
type InboxTraceRebuildState = "row_upserted" | "row_deleted" | "row_skipped";
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

function isSuppressedByUnfollowedThreadOrdinary(fact: InboxNotificationFactInput) {
  return fact.kind === "thread"
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
  } else if (fact.kind === "thread") {
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

async function getLastReadSeq(target: InboxServingTarget, executor: DatabaseExecutor = getDb()): Promise<number> {
  if (target.receiverType === "user") {
    const [row] = await executor
      .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
      .from(userChannelReadCursors)
      .where(and(
        eq(userChannelReadCursors.userId, target.receiverId),
        eq(userChannelReadCursors.channelId, target.sourceChannelId),
      ))
      .limit(1);
    return row?.lastReadSeq ?? 0;
  }

  const [row] = await executor
    .select({ lastReadSeq: agentChannelReadCursors.lastReadSeq })
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.agentId, target.receiverId),
      eq(agentChannelReadCursors.channelId, target.sourceChannelId),
    ))
    .limit(1);
  return row?.lastReadSeq ?? 0;
}

export async function rebuildInboxServingRowsForReceiverTargets(
  targets: readonly InboxServingTarget[],
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  for (const target of uniqueTargets(targets)) {
    const facts = await executor
      .select({
        receiverType: inboxNotificationFacts.receiverType,
        receiverId: inboxNotificationFacts.receiverId,
        kind: inboxNotificationFacts.kind,
        sourceChannelId: inboxNotificationFacts.sourceChannelId,
        seq: inboxNotificationFacts.messageSeq,
        messageId: inboxNotificationFacts.messageId,
        activityAt: inboxNotificationFacts.activityAt,
        personalMention: inboxNotificationFacts.personalMention,
        unreadEligible: inboxNotificationFacts.unreadEligible,
        serverId: inboxNotificationFacts.serverId,
      })
      .from(inboxNotificationFacts)
      .innerJoin(channels, and(
        eq(channels.id, inboxNotificationFacts.sourceChannelId),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ))
      .where(and(
        eq(inboxNotificationFacts.receiverType, target.receiverType),
        eq(inboxNotificationFacts.receiverId, target.receiverId),
        eq(inboxNotificationFacts.sourceChannelId, target.sourceChannelId),
      ))
      .orderBy(inboxNotificationFacts.messageSeq);
    const lastReadSeq = await getLastReadSeq(target, executor);
    const suppressionRows = target.receiverType === "user"
      ? await executor
        .select({ doneThroughSeq: inboxSuppressionStates.doneThroughSeq })
        .from(inboxSuppressionStates)
        .where(and(
          eq(inboxSuppressionStates.receiverType, "user"),
          eq(inboxSuppressionStates.receiverId, target.receiverId),
          inArray(inboxSuppressionStates.targetKind, [
            "channel",
            "dm",
            "followed_thread",
            "public_channel_mention",
            "public_thread_mention",
          ]),
          eq(inboxSuppressionStates.targetChannelId, target.sourceChannelId),
        ))
      : [];
    const doneThroughSeq = suppressionRows.reduce<number | null>((maxSeq, row) => {
      if (row.doneThroughSeq == null) return maxSeq;
      const seq = Number(row.doneThroughSeq);
      if (!Number.isSafeInteger(seq)) throw new Error(`unsafe suppression sequence: ${String(row.doneThroughSeq)}`);
      return maxSeq == null || seq > maxSeq ? seq : maxSeq;
    }, null);
    const unsuppressedFacts = doneThroughSeq == null
      ? facts
      : facts.filter((fact) => fact.seq > doneThroughSeq);

    const projected = projectInboxServingRowsFromNotificationFacts({
      receiverType: target.receiverType,
      receiverId: target.receiverId,
      facts: unsuppressedFacts satisfies readonly (InboxPolicyNotificationFact & { serverId: string })[],
      lastReadSeqByChannel: { [target.sourceChannelId]: lastReadSeq },
    })[0];

    if (!projected) {
      traceInboxServingRowRebuild(target, {
        state: "row_deleted",
        reason: "no_projected_notification_facts",
        factsCount: facts.length,
        lastReadSeq,
      });
      await executor
        .delete(inboxServingRows)
        .where(and(
          eq(inboxServingRows.receiverType, target.receiverType),
          eq(inboxServingRows.receiverId, target.receiverId),
          eq(inboxServingRows.sourceChannelId, target.sourceChannelId),
        ));
      continue;
    }

    const latestFact = facts.find((fact) => fact.messageId === projected.latestMessageId);
    if (!latestFact) {
      traceInboxServingRowRebuild(target, {
        state: "row_skipped",
        reason: "latest_fact_missing",
        factsCount: facts.length,
        lastReadSeq,
        latestNotifiedSeq: projected.latestNotifiedSeq,
        unreadCount: projected.unreadCount,
        hasAnyMention: projected.hasAnyMention,
        kind: projected.kind,
      });
      continue;
    }
    const now = new Date();
    const values: typeof inboxServingRows.$inferInsert = {
      receiverType: target.receiverType,
      receiverId: target.receiverId,
      serverId: latestFact.serverId,
      kind: projected.kind,
      sourceChannelId: target.sourceChannelId,
      latestNotifiedMessageId: projected.latestMessageId,
      latestNotifiedSeq: projected.latestNotifiedSeq,
      latestNotifiedAt: latestFact.activityAt,
      lastActivityAt: latestFact.activityAt,
      firstUnreadMessageId: projected.firstUnreadMessageId,
      firstUnreadSeq: projected.firstUnreadSeq,
      unreadCount: projected.unreadCount,
      latestPersonalMentionMessageId: projected.latestPersonalMentionSeq == null
        ? null
        : facts.find((fact) => fact.seq === projected.latestPersonalMentionSeq)?.messageId ?? null,
      latestPersonalMentionSeq: projected.latestPersonalMentionSeq,
      unreadMentionCount: projected.unreadMentionCount,
      hasAnyMention: projected.hasAnyMention,
      updatedAt: now,
    };

    await executor
      .insert(inboxServingRows)
      .values(values)
      .onConflictDoUpdate({
        target: [
          inboxServingRows.receiverType,
          inboxServingRows.receiverId,
          inboxServingRows.sourceChannelId,
        ],
        set: {
          serverId: values.serverId,
          kind: values.kind,
          latestNotifiedMessageId: values.latestNotifiedMessageId,
          latestNotifiedSeq: values.latestNotifiedSeq,
          latestNotifiedAt: values.latestNotifiedAt,
          lastActivityAt: values.lastActivityAt,
          firstUnreadMessageId: values.firstUnreadMessageId,
          firstUnreadSeq: values.firstUnreadSeq,
          unreadCount: values.unreadCount,
          latestPersonalMentionMessageId: values.latestPersonalMentionMessageId,
          latestPersonalMentionSeq: values.latestPersonalMentionSeq,
          unreadMentionCount: values.unreadMentionCount,
          hasAnyMention: values.hasAnyMention,
          updatedAt: values.updatedAt,
        },
      });
    traceInboxServingRowRebuild(target, {
      state: "row_upserted",
      reason: "projected",
      factsCount: facts.length,
      lastReadSeq,
      latestNotifiedSeq: projected.latestNotifiedSeq,
      unreadCount: projected.unreadCount,
      hasAnyMention: projected.hasAnyMention,
      kind: projected.kind,
    });
  }
}

export async function recordInboxNotificationFacts(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  if (facts.length === 0) return 0;
  const muteStateCandidates = facts.filter((fact) => fact.kind !== "thread");
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
  if (filteredFacts.length === 0) return 0;
  await executor
    .insert(inboxNotificationFacts)
    .values(filteredFacts.map((fact) => ({
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
    })))
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

  await rebuildInboxServingRowsForReceiverTargets(filteredFacts.map((fact) => ({
    receiverType: fact.receiverType,
    receiverId: fact.receiverId,
    sourceChannelId: fact.sourceChannelId,
  })), executor);
  await enqueueMobilePushForInboxFacts(filteredFacts, executor);
  return filteredFacts.length;
}
