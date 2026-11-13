import { resolveAgentLounge } from "./agentLoungeService";
import { JointActorUnavailableError, lockJointHumanAdmissionSource, lockJointUsersFirst, prepareJointHumanMembershipMirror } from "./jointHumanMembershipMirror";
import { and, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index";
import {
  agentLounges,
  agents as agentsTable,
  channelAgents,
  channelHumans,
  channels,
  messageMentions,
  messages,
  serverMembers,
  threadFollows,
} from "../db/schema";
import {
  actorHasChannelCapability,
  channelActorHasCapability,
  resolveChannelActorContext,
  lockComputedJointActor,
} from "../lib/channelActorPermissions";
import { uuidShortIdRange } from "../lib/messageId";
import * as channelService from "./channelService";
import { recordInboxNotificationFacts, type InboxNotificationFactInput } from "./inboxNotificationService";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;
const PENDING_MENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Thread level after the mention re-follows the thread (contract §1.1): a
 * stored 'mentions' (= unfollowed) goes back to NULL (default); an explicit
 * 'none' and 'all' / 'default' stay.
 */
const refollowNotificationLevelSql = sql<"default" | "all" | "mentions" | "none" | null>`CASE WHEN ${threadFollows.notificationLevel} = 'mentions' THEN NULL ELSE ${threadFollows.notificationLevel} END`;

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
  /** Task v2: a task conversation names its parent channel and task on the row. */
  parentChannelId: string | null;
  taskId: string | null;
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

/**
 * A thread or a task v2 conversation: membership is the parent channel's, and
 * "already in it" means following it. A task conversation's parent channel is
 * on its row (`parent_channel_id`); a thread's is its parent message's channel.
 */
function isSubConversationRow(row: MentionActionRow): boolean {
  return row.channelType === "thread" || row.channelType === "task";
}

function canNotifyMentionTarget(row: MentionActionRow): boolean {
  return (row.channelType === "channel" || isSubConversationRow(row)) && !row.channelArchivedAt && !row.channelDeletedAt;
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
    && (row.channelType === "channel" || isSubConversationRow(row))
    && !row.channelArchivedAt
    && !row.channelDeletedAt;
}

async function canActorUseMemberManagementAdd(row: MentionActionRow, actorType: MentionActionActorType, actorId: string): Promise<boolean> {
  if (actorType !== "user") return false;
  if (row.channelType !== "channel" && !isSubConversationRow(row)) return false;
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
    parentChannelId: channels.parentChannelId,
    taskId: channels.taskId,
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
    parentChannelId: (row.parentChannelId as string | null) ?? null,
    taskId: (row.taskId as string | null) ?? null,
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
      // Agent Lounge: nobody unreached there is reminded later (a person who
      // has not joined, tygg #proj-chat:30a58e4d; another agent, never), so
      // no mention there is a pending action.
      sql`not exists (
        select 1 from ${agentLounges}
        where ${agentLounges.channelId} in (${channels.id}, ${channels.parentChannelId})
      )`,
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
  if (isSubConversationRow(row)) {
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
  if (row.channelType === "task") {
    if (!row.parentChannelId) return false;
    membershipChannelId = row.parentChannelId;
  } else if (row.channelType === "thread") {
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
  // Agent Lounge: neither notify nor add reaches anyone there afterwards
  // (another agent never; a person who has not joined, tygg #proj-chat:30a58e4d).
  if (await resolveAgentLounge(row.channelId)) {
    return { ...base, status: "no_permission", reason: row.targetType === "agent" ? "agent_lounge_outsider" : "agent_lounge_no_reminders" };
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
  if (action === "add" && row.channelType === "task") {
    if (!row.parentChannelId || !row.taskId) {
      return { ...base, status: "stale", reason: "thread_parent_unavailable" };
    }
    threadAddParentChannelId = row.parentChannelId;
  } else if (action === "add" && row.channelType === "thread") {
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
      // The users rows first (lockJointUsersFirst): the person added (their
      // channel row, a joint's membership and admission name them) and the
      // person adding (admitted_by), before the channel row: taken only by
      // those rows' FK checks, after the channel, server and member rows, one
      // closes a cycle with that person's account deletion (users row FOR
      // UPDATE, then the servers they own). The adder retired or being
      // deleted: as one without the authority to add.
      const usersFirst = await lockJointUsersFirst(tx, {
        actorUserId: actorType === "user" ? actorId : null,
        userIds: row.targetType === "agent" ? [] : [row.targetId],
      }).then(() => true, (err: unknown) => {
        if (err instanceof JointActorUnavailableError) return false;
        throw err;
      });
      if (!usersFirst) return null;
      const membershipChannelId = isSubConversationRow(row) ? threadAddParentChannelId! : row.channelId;
      const [lockedChannel] = await tx
        .select({ id: channels.id, type: channels.type, archivedAt: channels.archivedAt, deletedAt: channels.deletedAt })
        .from(channels)
        .where(and(eq(channels.id, membershipChannelId), eq(channels.serverId, serverId)))
        .for("update")
        .limit(1);
      if (lockedChannel?.type === "joint") await lockComputedJointActor({ serverId, channelId: membershipChannelId,
        actorType, actorId, humanSubjectIds: row.targetType === "agent" ? [] : [row.targetId],
      },tx);
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
      // Match the member-management routes: the existing channel lock must
      // precede source member and J locks. Ordinary/agent adds keep their old
      // behavior and take no new joint-source admission locks.
      let mirrorHumans: Awaited<ReturnType<typeof prepareJointHumanMembershipMirror>> | null = null;
      if (row.targetType !== "agent" && lockedChannel.type === "joint") {
        await lockJointHumanAdmissionSource(tx, serverId, [row.targetId]);
        mirrorHumans = await prepareJointHumanMembershipMirror(tx, { channelIds: [membershipChannelId] }, "join");
      }
      // As addHuman: a current joint member is in the channel already
      // (through any server), so nothing is written for the channel: no CH
      // row, read position or source. A thread/task
      // mention still follows that conversation below.
      const jointMember = mirrorHumans?.coversChannel(membershipChannelId)
        ? (await tx.execute<{ member: boolean }>(sql`SELECT EXISTS (
            SELECT 1 FROM joint_channel_members m JOIN joint_channel_servers p ON p.joint_channel_id=m.joint_channel_id
            WHERE p.local_channel_id=${membershipChannelId}::uuid AND m.user_id=${row.targetId}::uuid
          ) AS member`)).rows[0]?.member === true
        : false;
      if (jointMember) mirrorHumans = null;
      const joinedChannel = jointMember ? [] : row.targetType === "agent"
        ? await tx
          .insert(channelAgents)
          .values({ channelId: membershipChannelId, agentId: row.targetId })
          .onConflictDoNothing()
          .returning({ channelId: channelAgents.channelId })
        : await tx
          .insert(channelHumans)
          .values({ channelId: membershipChannelId, userId: row.targetId })
          .onConflictDoNothing()
          .returning({ channelId: channelHumans.channelId });
      const principalKind = row.targetType === "agent" ? "agent" : "human";
      if (joinedChannel.length > 0) {
        // The mention that brought them in stays unread; a thread mention joins the parent
        // channel at its latest message and the thread itself just before the mention.
        await channelService.startReadPositionAtJoin(
          tx,
          principalKind,
          row.targetId,
          membershipChannelId,
          isSubConversationRow(row) ? undefined : row.messageSeq - 1,
        );
      }
      // The person who acted admitted them; an agent is no person (admitted_by stays empty).
      if (mirrorHumans) await mirrorHumans.apply([row.targetId], actorType === "user" ? { actorUserId: actorId } : {});
      if (row.channelType === "task") {
        // Task v2: joins the parent channel (above) and follows the task
        // conversation just before the mention, like a thread.
        await channelService.startReadPositionAtJoin(tx, principalKind, row.targetId, row.channelId, row.messageSeq - 1);
        await tx
          .insert(threadFollows)
          .values({
            threadChannelId: row.channelId,
            followerType: row.targetType,
            followerId: row.targetId,
            parentMessageId: null,
            parentTaskId: row.taskId!,
            reason: "mentioned",
          })
          .onConflictDoUpdate({
            target: [threadFollows.threadChannelId, threadFollows.followerType, threadFollows.followerId],
            set: {
              parentTaskId: row.taskId!,
              reason: "mentioned",
              doneAt: null,
              unfollowedAt: null,
              notificationLevel: refollowNotificationLevelSql,
              createdAt: deliveredAt,
            },
          });
      } else if (row.channelType === "thread") {
        await channelService.startReadPositionAtJoin(tx, principalKind, row.targetId, row.channelId, row.messageSeq - 1);
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
              notificationLevel: refollowNotificationLevelSql,
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
      kind: row.channelType === "thread" ? "thread" : row.channelType === "task" ? "task" : "channel",
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
