/**
 * Writes the outbox rows of a notification event, inside the transaction
 * that creates the event (design §3.1). Every transport is drained from these
 * rows, so web, desktop and mobile share one audience, and the revocations
 * that already apply to the outbox (channel conversion, task deletion) cover
 * all of them.
 *
 * Sources:
 * - a message's unread user inbox facts (recordInboxNotificationFacts), with
 *   the system-message filter D10 (only task / agent notices and real-sender
 *   producers notify, plus whoever a notice @mentions) and, for task / agent
 *   notices, the recipients of systemEventRecipients();
 * - @mentioned server members who are not in a public channel (outbox only:
 *   Activity shows them through public_channel_mention);
 * - events without a message: reminders, account notices.
 *
 * One row per receiver and event (`event_key`); joint copies of one message
 * collapse to the copy whose own levels let it through. After the
 * transaction settles, exactly the inserted rows are drained.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS, type NotificationCategory } from "@botiverse/raft-shared";
import { afterAmbientTransaction } from "../../db/ambientTransaction";
import { chunkForBindParameters, insertParametersPerRow } from "../../db/bindParameterBudget";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { channelHumans, channels, messageMentions, messages, notificationOutbox, serverMembers, tasks, threadFollows } from "../../db/schema";
import { addTraceEvent } from "../../tracing/semanticTrace";
import type { InboxNotificationFactInput } from "../inboxNotificationService";
import {
  classifySystemMessageNotification,
  systemEventRecipients,
  taskStatusPersonalRecipients,
  type SystemEventRecipient,
} from "../systemEventNotificationService";
import { scheduleNotificationDrain } from "./dispatcher";
import { decide, type NotificationPolicyRow } from "./policy";
import { loadNotificationPolicyPrefs } from "./settings";

type ChannelType = "channel" | "private" | "joint" | "dm" | "thread" | "task";

/**
 * What the message's fact recording knows about the event, passed through
 * recordInboxNotificationFacts. Absent: the facts are notified as an
 * ordinary message (mention actions, fixtures).
 */
export interface InboxFactNotificationContext {
  message: {
    id: string;
    seq: number;
    createdAt: Date;
    messageType: string;
    /** The producer stored on a system row. */
    systemSubtype?: string | null;
  };
  /** The system-message producer (broadcastSystemMessage / recordInboxFactsForPersistedMessages). */
  producer?: string | null;
  causalActor?: { type: "user" | "agent"; id: string } | null;
  /** The conversation the message was sent to. */
  channel: {
    id: string;
    serverId: string;
    type: ChannelType;
    parentMessageId: string | null;
    parentChannelId?: string | null;
    taskId?: string | null;
  };
  /** Mentions visible in the target (a system notice's personal-attention targets). */
  targetVisibleMentions: ReadonlyArray<{ type: string; id: string }>;
  /**
   * Public channel only: @mentioned server members who are not channel
   * members (and are not the sender). They get an outbox row, no fact.
   */
  mentionOnlyUserIds?: readonly string[];
}

/** One outbox row to insert. */
export interface NotificationEnqueueRow {
  receiverId: string;
  serverId: string;
  kind: "channel" | "dm" | "thread" | "task" | null;
  sourceChannelId: string | null;
  messageId: string | null;
  messageSeq: number | null;
  activityAt: Date;
  personalMention: boolean;
  eventKey: string;
  category: NotificationCategory;
  /** Event data for events without a message (reminder, notice). */
  payload?: Record<string, unknown> | null;
}

export function messageNotificationEventKey(messageId: string): string {
  return `message:${messageId}`;
}

/** The category of an ordinary message fact. A DM stays `dm` when it mentions. */
export function messageFactCategory(fact: Pick<InboxNotificationFactInput, "kind" | "personalMention">): NotificationCategory {
  if (fact.kind === "dm") return "dm";
  if (fact.personalMention === true) return "mention";
  if (fact.kind === "thread" || fact.kind === "task") return "thread";
  return "channel";
}

function rowFromFact(fact: InboxNotificationFactInput, category: NotificationCategory, personal: boolean): NotificationEnqueueRow {
  return {
    receiverId: fact.receiverId,
    serverId: fact.serverId,
    kind: fact.kind,
    sourceChannelId: fact.sourceChannelId,
    messageId: fact.messageId,
    messageSeq: fact.messageSeq,
    activityAt: fact.activityAt,
    personalMention: personal,
    eventKey: messageNotificationEventKey(fact.messageId),
    category,
  };
}

/**
 * Insert outbox rows (chunked to the bind-parameter limit) and drain exactly
 * the inserted ones after the surrounding transaction settles. A row whose
 * (receiver, event) already exists is skipped.
 */
export async function enqueueNotificationRows(
  rows: readonly NotificationEnqueueRow[],
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  if (rows.length === 0) return [];
  const unique = new Map<string, NotificationEnqueueRow>();
  for (const row of rows) {
    const key = `${row.receiverId}\0${row.eventKey}`;
    const previous = unique.get(key);
    unique.set(key, previous ? { ...previous, personalMention: previous.personalMention || row.personalMention } : row);
  }
  const values = [...unique.values()];
  const insertedIds: string[] = [];
  // ON CONFLICT DO NOTHING without a target: a retried enqueue conflicts on
  // (receiver_id, event_key), idx_notification_outbox_receiver_event, the
  // table's only unique key besides the primary key (contract step 2 retired
  // the legacy (receiver, source channel, message) key).
  for (const chunk of chunkForBindParameters(values, insertParametersPerRow(notificationOutbox))) {
    const inserted = await executor
      .insert(notificationOutbox)
      .values(chunk.map((row) => ({
        receiverType: "user" as const,
        receiverId: row.receiverId,
        serverId: row.serverId,
        kind: row.kind,
        sourceChannelId: row.sourceChannelId,
        messageId: row.messageId,
        messageSeq: row.messageSeq,
        activityAt: row.activityAt,
        personalMention: row.personalMention,
        unreadEligible: true,
        eventKey: row.eventKey,
        category: row.category,
        payload: row.payload ?? null,
        updatedAt: sql`now()`,
      })))
      .onConflictDoNothing()
      .returning({ id: notificationOutbox.id });
    insertedIds.push(...inserted.map((row) => row.id));
  }
  addTraceEvent("notification.enqueued", {
    row_count: values.length,
    inserted_count: insertedIds.length,
    categories: [...new Set(values.map((row) => row.category))].join(","),
  });
  // After commit: the drain reads on its own connection and opens a
  // writer-fence transaction, which inside this one would become a savepoint
  // that outlives the commit (prod 25P01, 2026-10-14).
  if (insertedIds.length > 0) afterAmbientTransaction(() => scheduleNotificationDrain(insertedIds));
  return insertedIds;
}

/**
 * A person in several servers of one joint channel has one fact per copy of
 * the message; they are notified once. Keep the copy whose own levels let it
 * through (each server keeps its own levels), then the lowest source channel
 * id, so a retried enqueue lands on the same row.
 */
async function collapseJointCopies(
  rows: readonly NotificationEnqueueRow[],
  executor: DatabaseExecutor,
): Promise<NotificationEnqueueRow[]> {
  const groups = new Map<string, NotificationEnqueueRow[]>();
  for (const row of rows) {
    const key = `${row.receiverId}\0${row.eventKey}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const duplicated = [...groups.values()].filter((group) => group.length > 1).flat();
  if (duplicated.length === 0) return [...rows];
  const prefs = await loadNotificationPolicyPrefs(executor, {
    userIds: [...new Set(duplicated.map((row) => row.receiverId))],
    serverIds: [...new Set(duplicated.map((row) => row.serverId))],
    channelIds: [...new Set(duplicated.flatMap((row) => row.sourceChannelId ? [row.sourceChannelId] : []))],
    threadChannelIds: [],
  });
  const now = new Date();
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const personalMention = group.some((row) => row.personalMention);
    const notifies = (row: NotificationEnqueueRow) => {
      const policyRow: NotificationPolicyRow = {
        receiverId: row.receiverId,
        serverId: row.serverId,
        category: row.category,
        personal: personalMention,
        levelChannelId: row.kind === "thread" || row.kind === "task" ? null : row.sourceChannelId,
        threadChannelId: null,
        levelChannelSeq: row.messageSeq,
      };
      // Quiet hours are account-wide: they cannot prefer one copy.
      return decide(policyRow, prefs, now, DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS).kind !== "suppressed";
    };
    const [chosen] = [...group].sort((a, b) =>
      Number(notifies(b)) - Number(notifies(a))
      || ((a.sourceChannelId ?? "") < (b.sourceChannelId ?? "") ? -1 : (a.sourceChannelId ?? "") > (b.sourceChannelId ?? "") ? 1 : 0));
    return { ...chosen!, personalMention, category: personalMention && chosen!.category === "channel" ? "mention" : chosen!.category };
  });
}

type TaskRow = Parameters<typeof taskStatusPersonalRecipients>[0];

async function loadTaskNoticeContext(
  channel: InboxFactNotificationContext["channel"],
  executor: DatabaseExecutor,
): Promise<{ task: TaskRow; parent: { id: string; type: ChannelType } } | null> {
  const taskColumns = {
    status: tasks.status,
    createdByType: tasks.createdByType,
    createdById: tasks.createdById,
    claimedByType: tasks.claimedByType,
    claimedById: tasks.claimedById,
  };
  if (channel.type === "task") {
    if (!channel.taskId || !channel.parentChannelId) return null;
    const [task] = await executor.select(taskColumns).from(tasks).where(eq(tasks.id, channel.taskId)).limit(1);
    const [parent] = await executor.select({ id: channels.id, type: channels.type }).from(channels).where(eq(channels.id, channel.parentChannelId)).limit(1);
    return task && parent ? { task, parent } : null;
  }
  if (channel.type !== "thread" || !channel.parentMessageId) return null;
  const [task] = await executor.select(taskColumns).from(tasks).where(eq(tasks.messageId, channel.parentMessageId)).limit(1);
  const [parent] = await executor
    .select({ id: channels.id, type: channels.type })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, channel.parentMessageId))
    .limit(1);
  return task && parent ? { task, parent } : null;
}

/** Task creator / assignee who can see the parent channel and did not unfollow the task conversation. */
async function taskStatusPersonalUserIds(
  context: InboxFactNotificationContext,
  executor: DatabaseExecutor,
): Promise<string[]> {
  const notice = await loadTaskNoticeContext(context.channel, executor);
  if (!notice) return [];
  const candidates = taskStatusPersonalRecipients(notice.task)
    .filter((id) => !(context.causalActor?.type === "user" && context.causalActor.id === id));
  if (candidates.length === 0) return [];
  const members = await executor
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, context.channel.serverId), inArray(serverMembers.userId, candidates)));
  let reachable = new Set(members.map((row) => row.userId));
  if (notice.parent.type !== "channel" && reachable.size > 0) {
    const joined = await executor
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, notice.parent.id), inArray(channelHumans.userId, [...reachable])));
    reachable = new Set(joined.map((row) => row.userId));
  }
  const unfollowed = await executor
    .select({ userId: threadFollows.followerId })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, context.channel.id),
      eq(threadFollows.followerType, "user"),
      inArray(threadFollows.followerId, candidates),
      isNotNull(threadFollows.unfollowedAt),
    ));
  const unfollowedIds = new Set(unfollowed.map((row) => row.userId));
  return candidates.filter((id) => reachable.has(id) && !unfollowedIds.has(id));
}

function systemProducerOf(context: InboxFactNotificationContext): string | null {
  if (context.message.messageType !== "system") return null;
  return context.producer ?? context.message.systemSubtype ?? null;
}

/**
 * Receivers among the facts whom the message @mentions, including mentions
 * that were not a send-time mention target (message_mentions rows written in
 * the same transaction, before the facts). One indexed read, only for
 * sub-conversation messages whose facts are not all mentions already.
 */
async function mentionedFollowerIds(
  executor: DatabaseExecutor,
  messageId: string,
  facts: readonly InboxNotificationFactInput[],
): Promise<Set<string>> {
  const candidates = [...new Set(facts.filter((fact) => fact.personalMention !== true).map((fact) => fact.receiverId))];
  if (candidates.length === 0) return new Set();
  const found = new Set<string>();
  for (const chunk of chunkForBindParameters(candidates, 1)) {
    const rows = await executor
      .select({ targetId: messageMentions.targetId })
      .from(messageMentions)
      .where(and(
        eq(messageMentions.messageId, messageId),
        eq(messageMentions.targetType, "user"),
        inArray(messageMentions.targetId, chunk),
      ));
    for (const row of rows) found.add(row.targetId);
  }
  return found;
}

/**
 * The outbox rows of one message's facts (the facts have already passed the
 * mute and unfollowed-thread filters of recordInboxNotificationFacts).
 */
export async function enqueueNotificationsForFacts(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor = getDb(),
  context?: InboxFactNotificationContext,
): Promise<number> {
  const userFacts = facts.filter((fact) => fact.receiverType === "user" && fact.unreadEligible !== false);
  const producer = context ? systemProducerOf(context) : null;
  const classification = context?.message.messageType === "system"
    ? classifySystemMessageNotification(producer)
    : { kind: "message" as const };

  let rows: NotificationEnqueueRow[] = [];
  if (classification.kind === "message") {
    // A thread / task reply that @mentions one of its followers is addressed
    // to them even when the mention is not a send-time mention target (a
    // follower outside the public parent channel): they can see the thread,
    // so it is a mention, not an ordinary followed-thread reply.
    const mentionedUserIds = context && (context.channel.type === "thread" || context.channel.type === "task")
      ? await mentionedFollowerIds(executor, context.message.id, userFacts)
      : null;
    rows = userFacts.map((fact) => {
      const personal = fact.personalMention === true || (mentionedUserIds?.has(fact.receiverId) ?? false);
      return rowFromFact(fact, messageFactCategory({ ...fact, personalMention: personal }), personal);
    });
    if (context?.mentionOnlyUserIds?.length && context.channel.type === "channel") {
      const factReceivers = new Set(userFacts.map((fact) => fact.receiverId));
      for (const userId of new Set(context.mentionOnlyUserIds)) {
        if (factReceivers.has(userId)) continue;
        rows.push({
          receiverId: userId,
          serverId: context.channel.serverId,
          kind: "channel",
          sourceChannelId: context.channel.id,
          messageId: context.message.id,
          messageSeq: context.message.seq,
          activityAt: context.message.createdAt,
          personalMention: true,
          eventKey: messageNotificationEventKey(context.message.id),
          category: "mention",
        });
      }
    }
  } else if (classification.kind === "event" && context) {
    const recipients: SystemEventRecipient[] = systemEventRecipients({
      event: classification.event,
      factReceiverIds: [...new Set(userFacts.map((fact) => fact.receiverId))],
      personalAttentionUserIds: context.targetVisibleMentions.filter((target) => target.type === "user").map((target) => target.id),
      taskPersonalUserIds: classification.event === "task_status" ? await taskStatusPersonalUserIds(context, executor) : [],
      agentDm: context.channel.type === "dm" && context.causalActor?.type === "agent",
      actor: context.causalActor ?? null,
    });
    const factByReceiver = new Map(userFacts.map((fact) => [fact.receiverId, fact]));
    const subConversationKind = context.channel.type === "task" ? "task" : context.channel.type === "thread" ? "thread" : null;
    rows = recipients.map((recipient) => {
      const fact = factByReceiver.get(recipient.userId);
      if (fact) return rowFromFact(fact, recipient.category, recipient.personal);
      return {
        receiverId: recipient.userId,
        serverId: context.channel.serverId,
        kind: subConversationKind ?? (context.channel.type === "dm" ? "dm" : "channel"),
        sourceChannelId: context.channel.id,
        messageId: context.message.id,
        messageSeq: context.message.seq,
        activityAt: context.message.createdAt,
        personalMention: recipient.personal,
        eventKey: messageNotificationEventKey(context.message.id),
        category: recipient.category,
      };
    });
  } else {
    // A notice that is not a notification event still notifies the people it
    // @mentions, as a mention (desktop parity, base PR 37ec18383); everyone
    // else only sees it in Activity.
    rows = userFacts
      .filter((fact) => fact.personalMention === true)
      .map((fact) => rowFromFact(fact, messageFactCategory(fact), true));
    addTraceEvent("notification.enqueue.system_message_silent", {
      producer: producer ?? "unknown",
      fact_count: userFacts.length,
      mention_count: rows.length,
    });
  }
  if (rows.length === 0) return 0;
  const collapsed = await collapseJointCopies(rows, executor);
  return (await enqueueNotificationRows(collapsed, executor)).length;
}
