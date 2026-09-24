import { and, desc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  agents as agentsTable,
  channelAgents,
  channelHumans,
  channels,
  messageMentions,
  messages,
  serverMembers,
  threadFollows,
} from "../db/schema.js";
import {
  actorHasChannelCapability,
  channelActorHasCapability,
  resolveChannelActorContext,
} from "../lib/channelActorPermissions.js";
import { uuidShortIdRange } from "../lib/messageId.js";
import * as channelService from "./channelService.js";
import { recordInboxNotificationFacts, type InboxNotificationFactInput } from "./inboxNotificationService.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;
const PENDING_MENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MentionActionActorType = "user" | "agent";
export type MentionActionKind = "notify" | "add";
export type MentionActionResultStatus = "queued" | "delivered" | "dropped" | "stale" | "expired" | "no_permission" | "not_found" | "ambiguous";

export type MentionNotifyAgentQueueResult =
  | { status: "queued"; reason: string }
  | { status: "dropped"; reason: string };

export type MentionActionExecutionOptions = {
  notifyAgent?: (input: {
    resolutionId: string;
    messageId: string;
    targetId: string;
  }) => Promise<MentionNotifyAgentQueueResult>;
};

function publicMentionDeliveryDropReason(reason: string): "target_not_queued" | "delivery_unavailable" {
  return reason === "message_unavailable"
    || reason === "channel_unavailable"
    || reason === "cross_replica_receipt_unavailable"
    ? "delivery_unavailable"
    : "target_not_queued";
}

export type MentionActionRow = {
  id: string;
  messageId: string;
  messageSeq: number;
  serverId: string;
  channelId: string;
  parentMessageId: string | null;
  targetType: "user" | "agent";
  targetId: string;
  handleAtSendTime: string;
  notifiableAtSend: boolean;
  notifiedAt: Date | null;
  notifiedAction: "notify_only" | "add" | "invite" | null;
  createdAt: Date;
  senderType: MentionActionActorType;
  senderId: string;
  channelType: string;
  channelName: string;
  channelArchivedAt: Date | null;
  channelDeletedAt: Date | null;
};

export type MentionActionResult = {
  resolutionId: string;
  status: MentionActionResultStatus;
  action?: MentionActionKind;
  messageId?: string;
  channelId?: string;
  targetType?: "user" | "agent";
  targetId?: string;
  dedupedResolutionIds?: string[];
  reason?: string;
};

export function mentionActionExpiresAt(createdAt: Date): string {
  return new Date(createdAt.getTime() + PENDING_MENTION_TTL_MS).toISOString();
}

function isExpiredMentionAction(row: MentionActionRow): boolean {
  return Date.now() - row.createdAt.getTime() > PENDING_MENTION_TTL_MS;
}

function canNotifyMentionTarget(row: MentionActionRow): boolean {
  return (row.channelType === "channel" || row.channelType === "thread") && !row.channelArchivedAt && !row.channelDeletedAt;
}

async function mentionTargetCanReadMessage(row: MentionActionRow): Promise<boolean> {
  if (row.targetType === "agent") {
    return channelService.canAgentAccessChannel(row.channelId, row.targetId);
  }
  return channelService.canUserAccessChannel(row.channelId, row.targetId, asServerId(row.serverId));
}

function canAddMentionTarget(row: MentionActionRow, actorType: MentionActionActorType): boolean {
  // Human/agent is the actor axis: agent executors cannot add channel members.
  // Target type is intentionally symmetric; the write below maps user/agent to
  // the corresponding membership table.
  return actorType === "user"
    && (row.channelType === "channel" || row.channelType === "thread")
    && !row.channelArchivedAt
    && !row.channelDeletedAt;
}

async function canActorUseMemberManagementAdd(row: MentionActionRow, actorType: MentionActionActorType, actorId: string): Promise<boolean> {
  if (actorType !== "user") return false;
  if (row.channelType !== "channel" && row.channelType !== "thread") return false;
  const authorityChannelId = await channelService.getChannelMembershipAuthorityChannelId(row.channelId);
  if (!authorityChannelId) return false;
  return actorHasChannelCapability(row.serverId, authorityChannelId, actorType, actorId, "addChannelMembers");
}

export function availableMentionActions(row: MentionActionRow): MentionActionKind[] {
  if (row.notifiedAction === "add" || row.notifiedAction === "invite") return [];
  const actions: MentionActionKind[] = [];
  if (!row.notifiedAt && canNotifyMentionTarget(row)) actions.push("notify");
  if (canAddMentionTarget(row, row.senderType)) actions.push("add");
  return actions;
}

function mentionResolutionIdConditions(input: string) {
  const id = input.trim().toLowerCase();
  if (UUID_RE.test(id)) return [eq(messageMentions.id, id)];
  if (!SHORT_ID_RE.test(id)) return null;
  const bounds = uuidShortIdRange(id);
  const conditions = [gte(messageMentions.id, bounds.lower)];
  if (bounds.upper) conditions.push(lt(messageMentions.id, bounds.upper));
  return conditions;
}

function mentionActionSelectShape() {
  return {
    id: messageMentions.id,
    messageId: messageMentions.messageId,
    messageSeq: messageMentions.messageSeq,
    serverId: messageMentions.serverId,
    channelId: messageMentions.channelId,
    parentMessageId: channels.parentMessageId,
    targetType: messageMentions.targetType,
    targetId: messageMentions.targetId,
    handleAtSendTime: messageMentions.handleAtSendTime,
    notifiableAtSend: messageMentions.notifiableAtSend,
    notifiedAt: messageMentions.notifiedAt,
    notifiedAction: messageMentions.notifiedAction,
    createdAt: messageMentions.createdAt,
    senderType: messages.senderType,
    senderId: messages.senderId,
    channelType: channels.type,
    channelName: channels.name,
    channelArchivedAt: channels.archivedAt,
    channelDeletedAt: channels.deletedAt,
  };
}

function toMentionActionRow(row: Record<string, unknown>): MentionActionRow {
  return {
    id: row.id as string,
    messageId: row.messageId as string,
    messageSeq: Number(row.messageSeq),
    serverId: row.serverId as string,
    channelId: row.channelId as string,
    parentMessageId: (row.parentMessageId as string | null) ?? null,
    targetType: row.targetType as "user" | "agent",
    targetId: row.targetId as string,
    handleAtSendTime: row.handleAtSendTime as string,
    notifiableAtSend: Boolean(row.notifiableAtSend),
    notifiedAt: (row.notifiedAt as Date | null) ?? null,
    notifiedAction: (row.notifiedAction as "notify_only" | "add" | "invite" | null) ?? null,
    createdAt: row.createdAt as Date,
    senderType: row.senderType as MentionActionActorType,
    senderId: row.senderId as string,
    channelType: row.channelType as string,
    channelName: row.channelName as string,
    channelArchivedAt: (row.channelArchivedAt as Date | null) ?? null,
    channelDeletedAt: (row.channelDeletedAt as Date | null) ?? null,
  };
}

export function buildPendingMentionActionPayload(row: MentionActionRow) {
  return {
    resolutionId: row.id,
    messageId: row.messageId,
    messageSeq: row.messageSeq,
    channelId: row.channelId,
    channelName: row.channelName,
    targetType: row.targetType,
    targetId: row.targetId,
    targetHandle: row.handleAtSendTime,
    reason: "not_member",
    availableActions: availableMentionActions(row),
    createdAt: row.createdAt.toISOString(),
    expiresAt: mentionActionExpiresAt(row.createdAt),
  };
}

export async function listPendingMentionActionsForSender(
  serverId: string,
  actorType: MentionActionActorType,
  actorId: string,
  limit: number,
): Promise<MentionActionRow[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - PENDING_MENTION_TTL_MS);
  const rows = await db
    .select(mentionActionSelectShape())
    .from(messageMentions)
    .innerJoin(messages, eq(messages.id, messageMentions.messageId))
    .innerJoin(channels, eq(channels.id, messageMentions.channelId))
    .where(and(
      eq(messageMentions.serverId, serverId),
      eq(messageMentions.source, "send_path"),
      eq(messageMentions.notifiableAtSend, false),
      or(
        isNull(messageMentions.notifiedAt),
        and(
          eq(messages.senderType, "user"),
          eq(messageMentions.notifiedAction, "notify_only"),
        ),
      ),
      gt(messageMentions.createdAt, cutoff),
      eq(messages.senderType, actorType),
      eq(messages.senderId, actorId),
      isNull(channels.deletedAt),
    ))
    .orderBy(desc(messageMentions.createdAt))
    .limit(limit);
  return rows.map((row) => toMentionActionRow(row));
}

async function resolveMentionActionRowForSender(
  inputId: string,
  serverId: string,
  actorType: MentionActionActorType,
  actorId: string,
): Promise<
  | { status: "ok"; row: MentionActionRow }
  | { status: "not_found" }
  | { status: "ambiguous" }
> {
  const idConditions = mentionResolutionIdConditions(inputId);
  if (!idConditions) return { status: "not_found" };
  const db = getDb();
  const rows = await db
    .select(mentionActionSelectShape())
    .from(messageMentions)
    .innerJoin(messages, eq(messages.id, messageMentions.messageId))
    .innerJoin(channels, eq(channels.id, messageMentions.channelId))
    .where(and(
      ...idConditions,
      eq(messageMentions.serverId, serverId),
      eq(messageMentions.source, "send_path"),
      eq(messages.senderType, actorType),
      eq(messages.senderId, actorId),
    ))
    .limit(2);
  if (rows.length === 0) return { status: "not_found" };
  if (rows.length > 1) return { status: "ambiguous" };
  return { status: "ok", row: toMentionActionRow(rows[0]!) };
}

async function mentionTargetStillExists(row: MentionActionRow, executor: ReturnType<typeof getDb> = getDb()): Promise<boolean> {
  if (row.targetType === "agent") {
    const [agent] = await executor
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, row.targetId), eq(agentsTable.serverId, row.serverId), isNull(agentsTable.deletedAt)));
    return Boolean(agent);
  }
  const [member] = await executor
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.userId, row.targetId), eq(serverMembers.serverId, row.serverId)));
  return Boolean(member);
}

async function mentionTargetIsChannelMember(row: MentionActionRow, executor: ReturnType<typeof getDb> = getDb()): Promise<boolean> {
  if (row.channelType === "thread") {
    const [follow] = await executor
      .select({ threadChannelId: threadFollows.threadChannelId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, row.channelId),
        eq(threadFollows.followerType, row.targetType),
        eq(threadFollows.followerId, row.targetId),
        isNull(threadFollows.doneAt),
        isNull(threadFollows.unfollowedAt),
      ));
    return Boolean(follow);
  }
  if (row.targetType === "agent") {
    const [member] = await executor
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, row.channelId), eq(channelAgents.agentId, row.targetId)));
    return Boolean(member);
  }
  const [member] = await executor
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, row.channelId), eq(channelHumans.userId, row.targetId)));
  return Boolean(member);
}

async function mentionSenderCanAct(
  row: MentionActionRow,
  actorType: MentionActionActorType,
  actorId: string,
  executor: ReturnType<typeof getDb> = getDb(),
): Promise<boolean> {
  if (row.senderType !== actorType || row.senderId !== actorId) return false;
  let membershipChannelId = row.channelId;
  if (row.channelType === "thread") {
    if (!row.parentMessageId) return false;
    const [parentMessage] = await executor
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, row.parentMessageId))
      .limit(1);
    if (!parentMessage?.channelId) return false;
    membershipChannelId = parentMessage.channelId;
  }
  if (actorType === "agent") {
    const [member] = await executor
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, membershipChannelId), eq(channelAgents.agentId, actorId)));
    return Boolean(member);
  }
  const [member] = await executor
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, membershipChannelId), eq(channelHumans.userId, actorId)));
  return Boolean(member);
}

async function executeMentionActionForRow(
  row: MentionActionRow,
  serverId: string,
  actorType: MentionActionActorType,
  actorId: string,
  action: MentionActionKind,
  options: MentionActionExecutionOptions,
): Promise<MentionActionResult> {
  const base: MentionActionResult = {
    resolutionId: row.id,
    action,
    messageId: row.messageId,
    channelId: row.channelId,
    targetType: row.targetType,
    targetId: row.targetId,
    status: action === "notify" ? "queued" : "delivered",
  };
  if ((row.notifiedAction === "add" || row.notifiedAction === "invite") || (row.notifiedAt && (action === "notify" || row.notifiedAction !== "notify_only"))) {
    return {
      ...base,
      status: action === "notify" ? "queued" : "delivered",
      dedupedResolutionIds: [row.id],
      reason: action === "notify" ? "already_queued" : "already_delivered",
    };
  }
  if (row.notifiableAtSend || row.channelArchivedAt || row.channelDeletedAt) {
    return { ...base, status: "stale", reason: "no_longer_pending" };
  }
  if (isExpiredMentionAction(row)) {
    return { ...base, status: "expired" };
  }
  if (!await mentionSenderCanAct(row, actorType, actorId)) {
    return { ...base, status: "no_permission", reason: "sender_lacks_channel_access" };
  }
  if (!await mentionTargetStillExists(row)) {
    return { ...base, status: "stale", reason: "target_unavailable" };
  }
  if (await mentionTargetIsChannelMember(row)) {
    return { ...base, status: "stale", reason: "target_already_member" };
  }
  if (action === "notify" && (!canNotifyMentionTarget(row) || !await mentionTargetCanReadMessage(row))) {
    return { ...base, status: "no_permission", reason: "target_lacks_read_access" };
  }
  if (action === "add") {
    if (actorType === "agent") {
      return { ...base, status: "no_permission", reason: "add_requires_human_member_authority" };
    }
    if (!canAddMentionTarget(row, actorType)) {
      return { ...base, status: "no_permission", reason: "add_not_allowed_for_surface" };
    }
    if (!await canActorUseMemberManagementAdd(row, actorType, actorId)) {
      return { ...base, status: "no_permission", reason: "add_requires_member_management_authority" };
    }
  }

  if (action === "notify" && row.targetType === "agent") {
    if (!options.notifyAgent) {
      return { ...base, status: "dropped", reason: "delivery_unavailable" };
    }
    try {
      const receipt = await options.notifyAgent({
        resolutionId: row.id,
        messageId: row.messageId,
        targetId: row.targetId,
      });
      if (receipt.status !== "queued") {
        console.warn(
          `[MentionActionService] notify ${row.id} was not queued for target ${row.targetId}: ${receipt.reason}`,
        );
        return {
          ...base,
          status: "dropped",
          reason: publicMentionDeliveryDropReason(receipt.reason),
        };
      }
    } catch (error) {
      console.warn(
        `[MentionActionService] notify ${row.id} delivery handoff failed for target ${row.targetId}:`,
        error,
      );
      return { ...base, status: "dropped", reason: "delivery_unavailable" };
    }
  }

  const db = getDb();
  let threadAddParentChannelId: string | null = null;
  let threadAddParentMessageId: string | null = null;
  if (action === "add" && row.channelType === "thread") {
    if (!row.parentMessageId) {
      return { ...base, status: "stale", reason: "thread_parent_unavailable" };
    }
    threadAddParentMessageId = row.parentMessageId;
    const [parentMessage] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, threadAddParentMessageId))
      .limit(1);
    if (!parentMessage?.channelId) {
      return { ...base, status: "stale", reason: "thread_parent_unavailable" };
    }
    threadAddParentChannelId = parentMessage.channelId;
  }

  const deliveredAt = new Date();
  const cutoff = new Date(Date.now() - PENDING_MENTION_TTL_MS);
  const dedupedResolutionIds = await db.transaction(async (tx) => {
    if (action === "add") {
      const membershipChannelId = row.channelType === "thread" ? threadAddParentChannelId! : row.channelId;
      const [lockedChannel] = await tx
        .select({ id: channels.id, archivedAt: channels.archivedAt, deletedAt: channels.deletedAt })
        .from(channels)
        .where(and(eq(channels.id, membershipChannelId), eq(channels.serverId, serverId)))
        .for("update")
        .limit(1);
      const context = lockedChannel
        ? await resolveChannelActorContext(serverId, membershipChannelId, actorType, actorId, tx)
        : null;
      if (
        !lockedChannel
        || lockedChannel.archivedAt
        || lockedChannel.deletedAt
        || !context
        || !channelActorHasCapability(context, "addChannelMembers")
      ) {
        return null;
      }
      if (row.targetType === "agent") {
        await tx
          .insert(channelAgents)
          .values({ channelId: membershipChannelId, agentId: row.targetId })
          .onConflictDoNothing();
      } else {
        await tx
          .insert(channelHumans)
          .values({ channelId: membershipChannelId, userId: row.targetId })
          .onConflictDoNothing();
      }
      if (row.channelType === "thread") {
        await tx
          .insert(threadFollows)
          .values({
            threadChannelId: row.channelId,
            followerType: row.targetType,
            followerId: row.targetId,
            parentMessageId: threadAddParentMessageId!,
            reason: "mentioned",
          })
          .onConflictDoUpdate({
            target: [threadFollows.threadChannelId, threadFollows.followerType, threadFollows.followerId],
            set: {
              parentMessageId: threadAddParentMessageId!,
              reason: "mentioned",
              doneAt: null,
              unfollowedAt: null,
              createdAt: deliveredAt,
            },
          });
      }
    }

    const duplicates = await tx
      .select({ id: messageMentions.id })
      .from(messageMentions)
      .innerJoin(messages, eq(messages.id, messageMentions.messageId))
      .where(and(
        eq(messageMentions.serverId, serverId),
        eq(messageMentions.source, "send_path"),
        eq(messageMentions.notifiableAtSend, false),
        action === "add"
          ? or(isNull(messageMentions.notifiedAt), eq(messageMentions.notifiedAction, "notify_only"))
          : isNull(messageMentions.notifiedAt),
        gt(messageMentions.createdAt, cutoff),
        eq(messageMentions.channelId, row.channelId),
        eq(messageMentions.targetType, row.targetType),
        eq(messageMentions.targetId, row.targetId),
        eq(messages.senderType, actorType),
        eq(messages.senderId, actorId),
      ));
    const ids = duplicates.map((duplicate) => duplicate.id);
    if (ids.length === 0) {
      await recordQueuedMentionActionFacts([row.id], tx);
      return [row.id];
    }
    await tx
      .update(messageMentions)
      .set({
        notifiedAt: deliveredAt,
        notifiedByType: actorType,
        notifiedById: actorId,
        notifiedAction: action === "notify" ? "notify_only" : "add",
      })
      .where(inArray(messageMentions.id, ids));
    await recordQueuedMentionActionFacts(ids, tx);
    return ids;
  });

  if (!dedupedResolutionIds) {
    return { ...base, status: "no_permission", reason: "add_requires_member_management_authority" };
  }

  return {
    ...base,
    status: action === "notify" ? "queued" : "delivered",
    dedupedResolutionIds,
  };
}

async function recordQueuedMentionActionFacts(
  resolutionIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
) {
  if (resolutionIds.length === 0) return;
  const rows = await executor
    .select({
      id: messageMentions.id,
      serverId: messageMentions.serverId,
      channelId: messageMentions.channelId,
      targetType: messageMentions.targetType,
      targetId: messageMentions.targetId,
      messageId: messageMentions.messageId,
      messageSeq: messageMentions.messageSeq,
      channelType: channels.type,
      senderType: messages.senderType,
      senderId: messages.senderId,
      createdAt: messages.createdAt,
    })
    .from(messageMentions)
    .innerJoin(messages, eq(messages.id, messageMentions.messageId))
    .innerJoin(channels, eq(channels.id, messageMentions.channelId))
    .where(inArray(messageMentions.id, [...resolutionIds]));

  const facts = rows
    .filter((row) => row.targetType === "user" || row.targetType === "agent")
    .map((row) => ({
      receiverType: row.targetType,
      receiverId: row.targetId,
      serverId: row.serverId,
      kind: row.channelType === "thread" ? "thread" : "channel",
      sourceChannelId: row.channelId,
      messageId: row.messageId,
      messageSeq: Number(row.messageSeq),
      activityAt: row.createdAt,
      personalMention: true,
      unreadEligible: !(row.senderType === row.targetType && row.senderId === row.targetId),
    } satisfies InboxNotificationFactInput));
  await recordInboxNotificationFacts(facts, executor);
}

export async function executeMentionActionId(
  resolutionId: string,
  serverId: string,
  actorType: MentionActionActorType,
  actorId: string,
  action: MentionActionKind,
  options: MentionActionExecutionOptions = {},
): Promise<MentionActionResult> {
  const resolved = await resolveMentionActionRowForSender(resolutionId, serverId, actorType, actorId);
  if (resolved.status === "not_found") return { resolutionId, action, status: "not_found" };
  if (resolved.status === "ambiguous") return { resolutionId, action, status: "ambiguous" };
  return executeMentionActionForRow(resolved.row, serverId, actorType, actorId, action, options);
}
