import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, lte, not, sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  agents,
  attestedSendEvents,
  channels,
  inboxNotificationFacts,
  messageMentions,
  messages,
  users,
} from "../db/schema.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

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
  excludeSender?: {
    senderType: "user" | "agent";
    senderId: string;
  };
};

export type FreshnessMessageRangeOptions = FreshnessMessageAnchorOptions & {
  latestSeq?: number;
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
    conditions.push(not(and(
      eq(messages.senderType, options.excludeSender.senderType),
      eq(messages.senderId, options.excludeSender.senderId),
    )!));
  }
  return conditions;
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
  if (options?.excludeSender) {
    conditions.push(not(and(
      eq(messages.senderType, options.excludeSender.senderType),
      eq(messages.senderId, options.excludeSender.senderId),
    )!));
  }
  return conditions;
}

export async function getLatestAgentAttentionAnchor(
  agentId: string,
  channelId: string,
  options?: FreshnessMessageAnchorOptions,
): Promise<{ seq: number; messageId: string | null }> {
  const db = getDb();
  const [latest] = await db
    .select({
      seq: inboxNotificationFacts.messageSeq,
      messageId: inboxNotificationFacts.messageId,
    })
    .from(inboxNotificationFacts)
    .innerJoin(messages, eq(messages.id, inboxNotificationFacts.messageId))
    .where(and(...agentAttentionConditions(agentId, channelId, 0, options)))
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

export async function getFormalMentionFacts(agentId: string, channelId: string, lastSeenSeq: number, latestSeq: number): Promise<{
  count: number;
  firstMessageId: string | null;
  firstHandle: string | null;
}> {
  if (latestSeq <= lastSeenSeq) {
    return { count: 0, firstMessageId: null, firstHandle: null };
  }
  const db = getDb();
  const rows = await db
    .select({
      messageId: messageMentions.messageId,
      handleAtSendTime: messageMentions.handleAtSendTime,
    })
    .from(messageMentions)
    .where(and(
      eq(messageMentions.targetType, "agent"),
      eq(messageMentions.targetId, agentId),
      eq(messageMentions.channelId, channelId),
      sql`(${messageMentions.notifiableAtSend} OR ${messageMentions.notifiedAt} IS NOT NULL)`,
      gt(messageMentions.messageSeq, lastSeenSeq),
      lte(messageMentions.messageSeq, latestSeq),
    ))
    .orderBy(messageMentions.messageSeq);

  return {
    count: rows.length,
    firstMessageId: rows[0]?.messageId ?? null,
    firstHandle: rows[0]?.handleAtSendTime ?? null,
  };
}

export function __resetAttestedSendStateForTest(): void {
  // Clear the per-process freshness gate so focused suites can isolate cases.
  targetFreshnessGates.clear();
}
