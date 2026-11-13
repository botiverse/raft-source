import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray, lte, ne, not, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agents,
  attestedSendEvents,
  channels,
  inboxNotificationFacts,
  messageMentions,
  messages,
  users,
} from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";

export type AttestedSendEventType = "gate_triggered" | "continue" | "silence" | "e1_exempt";
export type AttestedSendTargetType = "channel" | "dm" | "thread";
export type ContinueResult = "committed" | "committed_anyway" | "reheld" | "replaced" | "expired" | "no_draft";
export const ATTESTED_SEND_HOLD_COPY_VARIANT = "no_send_v1";
export const ATTESTED_SEND_HOLD_AVAILABLE_ACTIONS = ["check_messages", "send_draft", "send_anyway"] as const;

export interface AttestedSendEventSubject {
  id: string;
  agentId: string;
  serverId: string;
  targetType: AttestedSendTargetType;
  targetRef: string;
}

type EventMetadata = Record<string, unknown>;

const targetFreshnessGates = new Map<string, Promise<void>>();

export type FreshnessMessageAnchorOptions = {
  /**
   * The sending actor. Its own messages are excluded, and so are system
   * notices the server recorded as caused by it (`causal_actor_*`) whose kind
   * is in SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES. Everything else still counts:
   * notices by anyone else, with no recorded causal actor, or of any other kind.
   */
  excludeSender?: {
    senderType: "user" | "agent";
    senderId: string;
  };
  /**
   * The plan's history cutoff (services/historyWindow.ts): only messages
   * created after it. What the window hides is never unseen; filtering by
   * time, not by a seq boundary, holds even where seq does not follow
   * created_at (an external projection keeps its source's time).
   */
  createdAfter?: Date;
  /**
   * Only people's and agents' words: system notices (lifecycle lines and the
   * like) are left out. A task write's own checks already cover the state
   * those lines restate (agentWriteLanding.ts `counts: "chat"`).
   */
  chatOnly?: boolean;
};

/**
 * System notice kinds that do not hold their own causal actor's send. A kind is
 * listed only when every field of its text is either in the actor's request,
 * in the successful response to that request, or the actor's own name
 * (#proj-runtime task #1255). This is not proof the actor read the response.
 * `task.lifecycle_thread` (created from a message, took, released, assigned,
 * status) names the task's number, title and status, all in the claim /
 * create / unclaim / assign / update-status response; listed so an agent's
 * next task write in that conversation is not held on its own line
 * (#wg-task-v2:98488173). Not listed, so it keeps holding: `channel.rename`
 * (its "from" name is read outside the update lock and is not returned). A new
 * kind holds until someone checks it and adds it here.
 */
export const SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES = [
  "agent.join_channel",
  "channel.agent_membership",
  "channel.human_membership",
  "channel.archive",
  "channel.unarchive",
  "task.created_summary",
  "task.assignment_receipt",
  "task.converted_summary",
  "task.lifecycle_thread",
] as const;

function excludeSenderConditions(excludeSender: NonNullable<FreshnessMessageAnchorOptions["excludeSender"]>) {
  return [
    not(and(
      eq(messages.senderType, excludeSender.senderType),
      eq(messages.senderId, excludeSender.senderId),
    )!),
    // COALESCE: a NULL causal actor must keep the row, not drop it.
    sql`NOT COALESCE(
      ${messages.messageType} = 'system'
      AND ${messages.causalActorType} = ${excludeSender.senderType}
      AND ${messages.causalActorId} = ${excludeSender.senderId}
      AND ${messages.systemSubtype} IN (${sql.join(SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES.map((subtype) => sql`${subtype}`), sql`, `)}),
      false
    )`,
  ];
}

export type FreshnessMessageRangeOptions = FreshnessMessageAnchorOptions & {
  latestSeq?: number;
  excludeExactSeqs?: number[];
};

export type FreshnessMessageAnchor = {
  messageId: string;
  seq: number;
};

export type AgentAttentionMessageAnchor = {
  messageId: string;
  seq: number;
  personalMention: boolean;
};

export type AgentAttentionMessageOptions = FreshnessMessageRangeOptions;

function messageAnchorConditions(channelId: string, options?: FreshnessMessageAnchorOptions) {
  const conditions = [eq(messages.channelId, channelId)];
  if (options?.excludeSender) {
    conditions.push(...excludeSenderConditions(options.excludeSender));
  }
  if (options?.createdAfter) conditions.push(gt(messages.createdAt, options.createdAfter));
  if (options?.chatOnly) conditions.push(ne(messages.messageType, "system"));
  return conditions;
}

function normalizedExactSeqs(seqs: number[] | undefined, afterSeq = 0): number[] {
  if (!seqs) return [];
  return [...new Set(seqs
    .map((seq) => Math.floor(Number(seq)))
    .filter((seq) => Number.isInteger(seq) && seq > afterSeq))]
    .slice(0, 2_500);
}

export async function withTargetFreshnessGate<T>(channelId: string, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const previous = targetFreshnessGates.get(channelId) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  targetFreshnessGates.set(channelId, queued);

  await previous.catch(() => {});

  try {
    addTraceEvent("attested_send.target_gate.acquired", {
      wait_ms: Date.now() - start,
      backend: "server_process",
    });
    return await work();
  } finally {
    releaseCurrent();
    if (targetFreshnessGates.get(channelId) === queued) {
      targetFreshnessGates.delete(channelId);
    }
  }
}

async function recordEvent(
  eventType: AttestedSendEventType,
  subject: AttestedSendEventSubject,
  metadata: EventMetadata = {},
  extras: { messageId?: string | null; result?: ContinueResult | null; newMessageCount?: number | null } = {},
): Promise<void> {
  const copyVariant = typeof metadata.copy_variant === "string" ? metadata.copy_variant : undefined;
  const availableActions = Array.isArray(metadata.available_actions)
    ? metadata.available_actions.filter((value): value is string => typeof value === "string")
    : [];
  addTraceEvent(`attested_send.${eventType}`, {
    target_type: subject.targetType,
    target_ref_present: Boolean(subject.targetRef),
    ...((extras.result && { result: extras.result }) || {}),
    ...((extras.newMessageCount != null && { new_message_count: extras.newMessageCount }) || {}),
    ...((copyVariant && { copy_variant: copyVariant }) || {}),
    ...((availableActions.length > 0 && { available_actions: availableActions.join(",") }) || {}),
  });

  try {
    const db = getDb();
    await db.insert(attestedSendEvents).values({
      eventType,
      agentId: subject.agentId,
      serverId: subject.serverId,
      targetType: subject.targetType,
      targetRef: subject.targetRef,
      draftId: subject.id,
      messageId: extras.messageId ?? null,
      newMessageCount: extras.newMessageCount ?? null,
      result: extras.result ?? null,
      metadata,
    });
  } catch (error) {
    console.warn("[attested-send] failed to persist event", error);
  }
}

export async function recordGateTriggered(
  subject: AttestedSendEventSubject,
  metadata: {
    lastSeenMessageId: string | null;
    latestMessageId: string | null;
    hasFormalMentionSinceLastSeen: boolean;
    draftReplacedExisting: boolean;
    newMessageCount: number;
    boundarySource?: string;
    boundarySeq?: number;
    latestSeq?: number;
    /** The held write (`send`, `task_claim`, ...); older rows have none and are sends. */
    action?: string;
    /** The conversation's channel id: a task write's rerun finds its hold by it. */
    channelId?: string;
    /** Which write was held (action and task): only its own rerun is covered by the hold. */
    writeKey?: string;
  },
): Promise<void> {
  await recordEvent(
    "gate_triggered",
    subject,
    {
      last_seen_msg_id: metadata.lastSeenMessageId,
      latest_msg_id: metadata.latestMessageId,
      has_formal_mention_since_last_seen: metadata.hasFormalMentionSinceLastSeen,
      draft_replaced_existing: metadata.draftReplacedExisting,
      boundary_source: metadata.boundarySource,
      boundary_seq: metadata.boundarySeq,
      latest_seq: metadata.latestSeq,
      ...(metadata.action ? { action: metadata.action } : {}),
      ...(metadata.channelId ? { channel_id: metadata.channelId } : {}),
      ...(metadata.writeKey ? { write_key: metadata.writeKey } : {}),
      copy_variant: ATTESTED_SEND_HOLD_COPY_VARIANT,
      available_actions: [...ATTESTED_SEND_HOLD_AVAILABLE_ACTIONS],
    },
    {
      newMessageCount: metadata.newMessageCount,
    },
  );
}

export async function recordE1ExemptEvent(input: {
  agentId: string;
  serverId: string;
  targetType: AttestedSendTargetType;
  targetRef: string;
  mentionMessageId: string;
  mentionedHandle: string;
  newMessageCountSinceLastSeen: number;
}): Promise<void> {
  await recordEvent(
    "e1_exempt",
    {
      id: randomUUID(),
      agentId: input.agentId,
      serverId: input.serverId,
      targetType: input.targetType,
      targetRef: input.targetRef,
    },
    {
      mention_message_id: input.mentionMessageId,
      mentioned_handle: input.mentionedHandle,
      new_message_count_since_last_seen: input.newMessageCountSinceLastSeen,
    },
    {
      messageId: input.mentionMessageId,
      newMessageCount: input.newMessageCountSinceLastSeen,
    },
  );
}

export async function recordContinueEvent(input: {
  agentId: string;
  serverId: string;
  targetType: AttestedSendTargetType;
  targetRef: string;
  messageId: string;
  result: Extract<ContinueResult, "committed" | "committed_anyway">;
  newMessageCount: number;
}): Promise<void> {
  await recordEvent(
    "continue",
    {
      id: randomUUID(),
      agentId: input.agentId,
      serverId: input.serverId,
      targetType: input.targetType,
      targetRef: input.targetRef,
    },
    {
      continue_anyway: input.result === "committed_anyway",
    },
    {
      messageId: input.messageId,
      result: input.result,
      newMessageCount: input.newMessageCount,
    },
  );
}

export async function getLatestMessageAnchor(
  channelId: string,
  options?: FreshnessMessageAnchorOptions,
): Promise<{ seq: number; messageId: string | null }> {
  const db = getDb();
  const [latest] = await db
    .select({ seq: messages.seq, messageId: messages.id })
    .from(messages)
    .where(and(...messageAnchorConditions(channelId, options)))
    .orderBy(desc(messages.seq))
    .limit(1);
  return latest ? { seq: latest.seq, messageId: latest.messageId } : { seq: 0, messageId: null };
}

export async function getMessageIdForSeq(channelId: string, seq: number): Promise<string | null> {
  if (seq <= 0) return null;
  const db = getDb();
  const [row] = await db
    .select({ messageId: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.seq, seq)))
    .limit(1);
  return row?.messageId ?? null;
}

export async function countMessagesAfterSeq(
  channelId: string,
  seq: number,
  options?: FreshnessMessageRangeOptions,
): Promise<number> {
  const db = getDb();
  const conditions = messageAnchorConditions(channelId, options);
  conditions.push(gt(messages.seq, seq));
  const excludedSeqs = normalizedExactSeqs(options?.excludeExactSeqs, seq);
  if (excludedSeqs.length > 0) conditions.push(not(inArray(messages.seq, excludedSeqs)));
  if (typeof options?.latestSeq === "number" && Number.isFinite(options.latestSeq)) {
    conditions.push(lte(messages.seq, Math.max(0, Math.floor(options.latestSeq))));
  }
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(...conditions));
  return Number(row?.count ?? 0);
}

export async function listRecentMessagesAfterSeq(
  channelId: string,
  seq: number,
  limit: number,
  options?: FreshnessMessageRangeOptions,
): Promise<FreshnessMessageAnchor[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const conditions = messageAnchorConditions(channelId, options);
  conditions.push(gt(messages.seq, seq));
  const excludedSeqs = normalizedExactSeqs(options?.excludeExactSeqs, seq);
  if (excludedSeqs.length > 0) conditions.push(not(inArray(messages.seq, excludedSeqs)));
  if (typeof options?.latestSeq === "number" && Number.isFinite(options.latestSeq)) {
    conditions.push(lte(messages.seq, Math.max(0, Math.floor(options.latestSeq))));
  }
  const rows = await db
    .select({
      messageId: messages.id,
      seq: messages.seq,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

function agentAttentionConditions(
  agentId: string,
  channelId: string,
  seq: number,
  options?: AgentAttentionMessageOptions,
) {
  const conditions = [
    eq(inboxNotificationFacts.receiverType, "agent" as const),
    eq(inboxNotificationFacts.receiverId, agentId),
    eq(inboxNotificationFacts.sourceChannelId, channelId),
    gt(inboxNotificationFacts.messageSeq, seq),
  ];
  if (typeof options?.latestSeq === "number" && Number.isFinite(options.latestSeq)) {
    conditions.push(lte(inboxNotificationFacts.messageSeq, Math.max(0, Math.floor(options.latestSeq))));
  }
  const excludedSeqs = normalizedExactSeqs(options?.excludeExactSeqs, seq);
  if (excludedSeqs.length > 0) {
    conditions.push(not(inArray(inboxNotificationFacts.messageSeq, excludedSeqs)));
  }
  if (options?.excludeSender) {
    conditions.push(...excludeSenderConditions(options.excludeSender));
  }
  // Every query on these facts joins the message row.
  if (options?.createdAfter) conditions.push(gt(messages.createdAt, options.createdAfter));
  if (options?.chatOnly) conditions.push(ne(messages.messageType, "system"));
  return conditions;
}

export async function getLatestAgentAttentionAnchor(
  agentId: string,
  channelId: string,
  options?: FreshnessMessageAnchorOptions & {
    /**
     * Only facts after this seq: the caller's model-seen boundary. Anything
     * at or before it cannot be unseen, and without the bound an agent that
     * wrote most of a channel walked back through every fact of its own
     * messages (excluded only after the join) on each gated write
     * (#proj-o11y:#24). Not found means nothing after it, not "no message".
     */
    afterSeq?: number;
  },
): Promise<{ seq: number; messageId: string | null }> {
  const db = getDb();
  const [latest] = await db
    .select({
      seq: inboxNotificationFacts.messageSeq,
      messageId: inboxNotificationFacts.messageId,
    })
    .from(inboxNotificationFacts)
    .innerJoin(messages, eq(messages.id, inboxNotificationFacts.messageId))
    .where(and(...agentAttentionConditions(agentId, channelId, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(options?.afterSeq ?? 0))), options)))
    .orderBy(desc(inboxNotificationFacts.messageSeq))
    .limit(1);
  return latest ? { seq: latest.seq, messageId: latest.messageId } : { seq: 0, messageId: null };
}

export async function countAgentAttentionMessagesAfterSeq(
  agentId: string,
  channelId: string,
  seq: number,
  options?: AgentAttentionMessageOptions,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(inboxNotificationFacts)
    .innerJoin(messages, eq(messages.id, inboxNotificationFacts.messageId))
    .where(and(...agentAttentionConditions(agentId, channelId, seq, options)));
  return Number(row?.count ?? 0);
}

export async function listRecentAgentAttentionMessagesAfterSeq(
  agentId: string,
  channelId: string,
  seq: number,
  limit: number,
  options?: AgentAttentionMessageOptions,
): Promise<AgentAttentionMessageAnchor[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      messageId: inboxNotificationFacts.messageId,
      seq: inboxNotificationFacts.messageSeq,
      personalMention: inboxNotificationFacts.personalMention,
    })
    .from(inboxNotificationFacts)
    .innerJoin(messages, eq(messages.id, inboxNotificationFacts.messageId))
    .where(and(...agentAttentionConditions(agentId, channelId, seq, options)))
    .orderBy(desc(inboxNotificationFacts.messageSeq))
    .limit(limit);
  return rows.reverse();
}

export async function getThreadParentAnchor(channelId: string): Promise<{ seq: number; messageId: string } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      parentMessageId: channels.parentMessageId,
      parentSeq: messages.seq,
    })
    .from(channels)
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(and(
      eq(channels.id, channelId),
      eq(channels.type, "thread"),
    ))
    .limit(1);
  if (!row?.parentMessageId || row.parentSeq <= 0) return null;
  return { seq: row.parentSeq, messageId: row.parentMessageId };
}

/**
 * Thread-start anchor with body, for the freshness-hold digest (task #41):
 * a thread hold shows where the conversation started so the agent sees the
 * topic anchor alongside the latest window. Content is served untruncated —
 * preview truncation is a rendering concern and stays client-side.
 */
export async function getThreadParentMessage(channelId: string): Promise<{
  seq: number;
  messageId: string;
  senderName: string | null;
  createdAt: Date | null;
  content: string;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      parentMessageId: channels.parentMessageId,
      parentSeq: messages.seq,
      content: messages.content,
      createdAt: messages.createdAt,
      userName: users.name,
      agentName: agents.name,
    })
    .from(channels)
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    // messages.sender_id is text while users.id/agents.id are uuid; the cast
    // follows the repo-wide `id::text = sender_id` join pattern. Joining the
    // uuid column directly is a runtime `operator does not exist: uuid = text`
    // — a 500 on every thread freshness hold since #7262, surfacing in the
    // field as thread-clustered send UNKNOWNs while DMs pass (task #41).
    .leftJoin(users, and(eq(messages.senderType, "user"), sql`${users.id}::text = ${messages.senderId}`))
    .leftJoin(agents, and(eq(messages.senderType, "agent"), sql`${agents.id}::text = ${messages.senderId}`))
    .where(and(
      eq(channels.id, channelId),
      eq(channels.type, "thread"),
    ))
    .limit(1);
  if (!row?.parentMessageId || row.parentSeq <= 0) return null;
  return {
    seq: row.parentSeq,
    messageId: row.parentMessageId,
    senderName: row.userName ?? row.agentName ?? null,
    createdAt: row.createdAt,
    content: row.content ?? "",
  };
}

export async function getFormalMentionFacts(
  agentId: string,
  channelId: string,
  lastSeenSeq: number,
  latestSeq: number,
  excludeExactSeqs?: number[],
  /** As `FreshnessMessageAnchorOptions.createdAfter`. */
  createdAfter?: Date,
): Promise<{
  count: number;
  firstMessageId: string | null;
  firstHandle: string | null;
}> {
  if (latestSeq <= lastSeenSeq) {
    return { count: 0, firstMessageId: null, firstHandle: null };
  }
  const db = getDb();
  const conditions = [
    eq(messageMentions.targetType, "agent"),
    eq(messageMentions.targetId, agentId),
    eq(messageMentions.channelId, channelId),
    sql`(${messageMentions.notifiableAtSend} OR ${messageMentions.notifiedAt} IS NOT NULL)`,
    gt(messageMentions.messageSeq, lastSeenSeq),
    lte(messageMentions.messageSeq, latestSeq),
  ];
  const excludedSeqs = normalizedExactSeqs(excludeExactSeqs, lastSeenSeq);
  if (excludedSeqs.length > 0) conditions.push(not(inArray(messageMentions.messageSeq, excludedSeqs)));
  const select = db
    .select({
      messageId: messageMentions.messageId,
      handleAtSendTime: messageMentions.handleAtSendTime,
    })
    .from(messageMentions);
  const rows = await (createdAfter
    ? select
      .innerJoin(messages, eq(messages.id, messageMentions.messageId))
      .where(and(...conditions, gt(messages.createdAt, createdAfter)))
    : select.where(and(...conditions)))
    .orderBy(messageMentions.messageSeq);

  return {
    count: rows.length,
    firstMessageId: rows[0]?.messageId ?? null,
    firstHandle: rows[0]?.handleAtSendTime ?? null,
  };
}

/** How long a task write's hold covers its rerun: one hold per catch-up (glimpse G2). */
export const TASK_WRITE_REHOLD_WINDOW_MS = 10 * 60_000;

/**
 * This agent's newest hold of one write (`writeKey`: the action and its task)
 * on a conversation within `withinMs`, or null. Matched by the channel id and
 * write key recorded with the hold, so another write on the same board is
 * never covered by it. The hold is a row, so a rerun on another replica finds
 * it; the query reads only this agent's recent rows (agent_id, created_at).
 */
export async function getRecentGateTriggered(
  agentId: string,
  channelId: string,
  writeKey: string,
  withinMs: number,
): Promise<{ latestSeq: number } | null> {
  const db = getDb();
  const [row] = await db
    .select({ metadata: attestedSendEvents.metadata })
    .from(attestedSendEvents)
    .where(and(
      eq(attestedSendEvents.agentId, agentId),
      eq(attestedSendEvents.eventType, "gate_triggered"),
      gt(attestedSendEvents.createdAt, new Date(Date.now() - withinMs)),
      sql`${attestedSendEvents.metadata}->>'channel_id' = ${channelId}`,
      sql`${attestedSendEvents.metadata}->>'write_key' = ${writeKey}`,
    ))
    .orderBy(desc(attestedSendEvents.createdAt))
    .limit(1);
  const latestSeq = Number((row?.metadata as { latest_seq?: unknown } | undefined)?.latest_seq);
  return row && Number.isFinite(latestSeq) ? { latestSeq } : null;
}

export function __resetAttestedSendStateForTest(): void {
  // Clear the per-process freshness gate so focused suites can isolate cases.
  targetFreshnessGates.clear();
}
