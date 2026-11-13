// Card messages (RFC 082): what the agent API needs to post a message with a
// card and to update it. The shared module (packages/shared/src/messageCard.ts)
// owns the card's rules; this file decides a send (flag, card, fallback,
// mentions), applies an update (the sender's, by message id: §4.2), writes and
// reads a card's revisions (§4.5), and deletes them after retention.

import { and, eq, lt, sql } from "drizzle-orm";
import {
  agentMessageCardMarker,
  currentDate,
  extractRaftMentionHandles,
  formatMessageCardProblem,
  formatMessageCardUpdateNotice,
  isMessageCardMetadata,
  MESSAGE_CARD_ERROR_CODES,
  MESSAGE_CARD_FIX_NEXT_STEP,
  MESSAGE_CARD_LIMITS,
  messageCardFallbackProblem,
  messageCardMetadataAfterUpdate,
  messageCardMetadataAtSend,
  messageCardStoredContent,
  parseMessageCard,
  type AgentApiMessageCardUpdateResponse,
  type AgentMessageCardMarker,
  type MessageCard,
  type MessageCardMetadata,
  type MessageCardProblem,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { messageCardRevisions, messages } from "../db/schema";
import { canonicalJson } from "../lib/canonicalJson";
import { JointChannelAccessChangedError, lockJointPostingAuthority } from "../lib/channelActorPermissions";
import { isMessageShortId, messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";
import { logMessageChanged } from "./messageChangeLog";
import { buildSearchText } from "./searchTokenizer";
import { recordSlackCardEditIntent } from "./slackCardEditSync";

/** A 400 a card send answers; nothing was posted. */
export interface MessageCardRefusal {
  status: 400;
  body: {
    error: string;
    code: typeof MESSAGE_CARD_ERROR_CODES[keyof typeof MESSAGE_CARD_ERROR_CODES];
    suggestedNextAction: string;
    /** card_invalid: where the card breaks a rule, and which rule. */
    path?: string;
    limit?: MessageCardProblem["limit"];
    /** card_invalid with limit `markdown` (RFC 082 §4.8): the node outside the Markdown subset (`heading`, `html`, `link`, ...). */
    node?: string;
  };
}

function cardInvalid(problem: MessageCardProblem): MessageCardRefusal {
  return {
    status: 400,
    body: {
      error: formatMessageCardProblem(problem),
      code: MESSAGE_CARD_ERROR_CODES.invalid,
      path: problem.path,
      limit: problem.limit,
      ...(problem.node === undefined ? {} : { node: problem.node }),
      suggestedNextAction: MESSAGE_CARD_FIX_NEXT_STEP,
    },
  };
}

/**
 * RFC 082 §4.1 (v1.7, Tenny): a card message carries no files, in a channel,
 * a DM or a thread alike, so every card stays editable everywhere (its Slack
 * copy included).
 */
export const MESSAGE_CARD_WITH_ATTACHMENTS_REFUSAL: MessageCardRefusal = {
  status: 400,
  body: {
    error: "A card message carries no files; nothing was posted. Send the card without attachmentIds, and send the files in a separate message.",
    code: MESSAGE_CARD_ERROR_CODES.withAttachments,
    suggestedNextAction: "send the files in a separate message",
  },
};

/** What a card send stores: the card's metadata, the content (fallback), and whether mentions may resolve from it. */
export interface MessageCardSend {
  card: MessageCard;
  metadata: MessageCardMetadata;
  content: string;
  /**
   * False when Raft derived the content from the card: a derived fallback
   * mentions no one, and an idempotent replay compares the card alone (the
   * sender wrote no content to compare; RFC 082 §4.1).
   */
  contentMentions: boolean;
}

/**
 * Decides a send that carries a card (the flag was checked by the caller):
 * the parsed card, and the content to store. Any `attachmentIds` refuse it
 * first, whatever they name: a card message carries no files. `content`
 * absent (or empty): the fallback derived from the card (refused when the
 * card has nothing to derive it from), and no mention resolves from it, so
 * structured `mentions` without a sender-written `content` are refused
 * rather than dropped.
 */
export function prepareMessageCardSend(input: {
  card: unknown;
  content: string | undefined;
  mentions: readonly unknown[] | undefined;
  attachmentIds?: readonly unknown[] | undefined;
  now?: Date;
}): { ok: true; send: MessageCardSend } | { ok: false; refusal: MessageCardRefusal } {
  if (input.attachmentIds && input.attachmentIds.length > 0) return { ok: false, refusal: MESSAGE_CARD_WITH_ATTACHMENTS_REFUSAL };
  const parsed = parseMessageCard(input.card);
  if (!parsed.ok) return { ok: false, refusal: cardInvalid(parsed.problem) };
  const senderWrote = typeof input.content === "string" && input.content.length > 0;
  if (!senderWrote && input.mentions && input.mentions.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: "mentions need the content they appear in: a card's derived fallback mentions no one. Write the content (with the @mentions) or leave out mentions; nothing was posted.",
          code: MESSAGE_CARD_ERROR_CODES.mentionsWithoutContent,
          suggestedNextAction: MESSAGE_CARD_FIX_NEXT_STEP,
        },
      },
    };
  }
  // The shared check the clients run before any request: a fallback needs a header, Text, Badge, time, Markdown or Fields to say something.
  const fallbackProblem = messageCardFallbackProblem(parsed.card, input.content);
  if (fallbackProblem) return { ok: false, refusal: cardInvalid(fallbackProblem) };
  const content = messageCardStoredContent(parsed.card, input.content);
  return {
    ok: true,
    send: {
      card: parsed.card,
      metadata: messageCardMetadataAtSend(parsed.card, input.now ?? new Date()),
      content,
      contentMentions: senderWrote,
    },
  };
}

/** One revision of a message card, written in the transaction of the send (revision 1) or of the update. */
export async function insertMessageCardRevision(
  executor: DatabaseExecutor,
  row: {
    messageId: string;
    revision: number;
    card: MessageCard;
    content: string;
    senderAgentId: string;
    /** An update's `idempotencyKey` (unique per message); none for a send. */
    idempotencyKey?: string | null;
    createdAt?: Date;
  },
): Promise<void> {
  await executor.insert(messageCardRevisions).values(row);
}

function cardOf(actionMetadata: unknown): string | null {
  // Through JSON first: a stored card and a freshly parsed one compare by value, whatever their key order.
  return isMessageCardMetadata(actionMetadata) ? canonicalJson(JSON.parse(JSON.stringify(actionMetadata.card))) : null;
}

/** Whether two messages' metadata carry the same card, or neither carries one (an idempotent replay compares these). */
export function sameMessageCard(stored: unknown, requested: unknown): boolean {
  return cardOf(stored) === cardOf(requested);
}

/**
 * The agent-facing `message_card` of a message row (RFC 082 §4.3): revision,
 * time, and the card as markdown generated from the stored card now (so a
 * card sent before that rendering reads the same); empty for any other
 * message.
 */
export function agentMessageCardField(actionMetadata: unknown): { message_card?: AgentMessageCardMarker } {
  const marker = agentMessageCardMarker(actionMetadata);
  return marker ? { message_card: marker } : {};
}

// ---------------------------------------------------------------------------
// Update (RFC 082 §4.2): the sender replaces the card and its fallback, by
// message id, within 14 days, notifying no one.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The text the 404 of every message the caller may not update says (RFC 082 §4.2: one answer for all of them). */
export const MESSAGE_CARD_NOT_FOUND_BODY = {
  error: `No card message with this id that you can update. Updating works only on a card message you sent in the last ${MESSAGE_CARD_LIMITS.updateWindowDays} days, that is not deleted or retracted, in a conversation you can still post in; an unknown id gets this same answer. To show the new state, send a new message.`,
  code: MESSAGE_CARD_ERROR_CODES.notFound,
  suggestedNextAction: "send a new message",
} as const;

/** Whether a card message sent at `sentAt` may still be updated (at most 14 days after it was sent). */
export function withinMessageCardUpdateWindow(sentAt: Date, now: Date = currentDate()): boolean {
  return now.getTime() - sentAt.getTime() <= MESSAGE_CARD_LIMITS.updateWindowDays * DAY_MS;
}

const MESSAGE_WINDOW_SECONDS = 60;
const SENDER_WINDOW_SECONDS = 60 * 60;
const updateBudgets = createFixedWindowCounter();
let updateLimitOverridesForTests: { perMessagePerMinute?: number; perSenderPerHour?: number } = {};

/** Tests only: smaller update limits; `{}` restores RFC 082's. */
export function __setMessageCardUpdateLimitsForTests(limits: { perMessagePerMinute?: number; perSenderPerHour?: number }): void {
  updateLimitOverridesForTests = limits;
}

/** Tests only: RFC 082's limits and an empty count in this process. */
export function __resetMessageCardUpdateLimitsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Card message limit hooks are test-only");
  updateLimitOverridesForTests = {};
  updateBudgets.clear();
}

export type MessageCardUpdateAdmission =
  | { admitted: true }
  | { admitted: false; scope: "message" | "sender"; limit: number; windowSeconds: number; retryAfterSeconds: number };

/**
 * RFC 082 §4.2's limits: 10 updates of one message a minute, 300 by one
 * sender an hour, each a fixed window counted across replicas in Redis
 * (fixedWindowRateLimit.ts; this process's memory without Redis or when it
 * errors, never open). The route spends a unit only for an update the checks
 * passed (flag, sender, window, conversation, card): another agent cannot
 * spend a message's budget. The message's window first; a sender over its
 * hour has spent that message's unit too.
 */
export async function admitMessageCardUpdate(input: { messageId: string; senderAgentId: string }, nowMs = Date.now()): Promise<MessageCardUpdateAdmission> {
  const perMessage = updateLimitOverridesForTests.perMessagePerMinute ?? MESSAGE_CARD_LIMITS.updatesPerMessagePerMinute;
  const message = await updateBudgets.admit(`slock:message-card-update:message:${input.messageId}`, perMessage, MESSAGE_WINDOW_SECONDS, nowMs);
  if (!message.admitted) {
    return { admitted: false, scope: "message", limit: perMessage, windowSeconds: MESSAGE_WINDOW_SECONDS, retryAfterSeconds: message.retryAfterSeconds };
  }
  const perSender = updateLimitOverridesForTests.perSenderPerHour ?? MESSAGE_CARD_LIMITS.updatesPerSenderPerHour;
  const sender = await updateBudgets.admit(`slock:message-card-update:sender:${input.senderAgentId}`, perSender, SENDER_WINDOW_SECONDS, nowMs);
  if (!sender.admitted) {
    return { admitted: false, scope: "sender", limit: perSender, windowSeconds: SENDER_WINDOW_SECONDS, retryAfterSeconds: sender.retryAfterSeconds };
  }
  return { admitted: true };
}

/**
 * The new card and fallback of an update, validated as at send (a derived
 * fallback when `content` is absent). `senderWroteContent`: the content is the
 * sender's, not derived, so a replay under the update's key compares it.
 */
export function prepareMessageCardUpdate(input: { card: unknown; content: string | undefined }):
  { ok: true; card: MessageCard; content: string; senderWroteContent: boolean } | { ok: false; refusal: MessageCardRefusal } {
  // No mentions: an update never resolves one, whatever its content says.
  const prepared = prepareMessageCardSend({ card: input.card, content: input.content, mentions: undefined });
  return prepared.ok
    ? { ok: true, card: prepared.send.card, content: prepared.send.content, senderWroteContent: prepared.send.contentMentions }
    : prepared;
}

/** The update's answer: the revision, and that nobody was told, naming each @mention of the new fallback. */
export function messageCardUpdateAnswer(input: { messageId: string; revision: number; updatedAt: Date; content: string }): AgentApiMessageCardUpdateResponse {
  const unnotifiedMentionHandles = extractRaftMentionHandles(input.content).map((handle) => `@${handle}`);
  return {
    ok: true,
    messageId: input.messageId,
    revision: input.revision,
    updatedAt: input.updatedAt.toISOString(),
    unnotifiedMentionHandles,
    notice: formatMessageCardUpdateNotice(unnotifiedMentionHandles),
  };
}

export type MessageCardUpdateOutcome =
  /** Written, or (`replayed`) the first answer of the same key and body: nothing written. */
  | { kind: "updated"; answer: AgentApiMessageCardUpdateResponse; replayed: boolean; channelId: string }
  | { kind: "revision_conflict"; currentRevision: number }
  | { kind: "idempotency_conflict" }
  /** No longer the sender's live card message (deleted or changed since it was checked). */
  | { kind: "not_found" };

/**
 * An update under a key that already wrote `earlier`: its first answer again,
 * else a conflict. Compared on what the sender sent (RFC 082 §4.2): the card
 * by value, and the content only when the sender wrote it. Content Raft
 * derived from the card is not compared: it follows from the card, and a
 * Server that derives it differently (a deploy between the two attempts)
 * must still answer the first result.
 */
function replayMessageCardUpdate(
  earlier: { revision: number; card: unknown; content: string; createdAt: Date },
  update: { messageId: string; channelId: string; card: MessageCard; content: string; senderWroteContent: boolean },
): MessageCardUpdateOutcome {
  if (canonicalJson(earlier.card) !== canonicalJson(JSON.parse(JSON.stringify(update.card)))
    || (update.senderWroteContent && earlier.content !== update.content)) {
    return { kind: "idempotency_conflict" };
  }
  return {
    kind: "updated",
    replayed: true,
    channelId: update.channelId,
    answer: messageCardUpdateAnswer({ messageId: update.messageId, revision: earlier.revision, updatedAt: earlier.createdAt, content: earlier.content }),
  };
}

/**
 * The update this sender already committed on its message (a full or
 * 8-character short id) under `idempotencyKey`, read before the route's
 * checks: the first answer again, or the conflict of another card or
 * fallback under the key. Null when the key wrote nothing there (or the card
 * does not validate, so it is not the one committed): the checks decide.
 * Reads only the sender's own messages.
 */
export async function findCommittedMessageCardUpdate(input: {
  messageId: string;
  senderAgentId: string;
  idempotencyKey: string;
  card: unknown;
  content: string | undefined;
}): Promise<MessageCardUpdateOutcome | null> {
  const id = input.messageId.trim();
  const idConditions = UUID_RE.test(id) ? [eq(messages.id, id)] : isMessageShortId(id) ? messageIdShortPrefixConditions(id) : null;
  if (!idConditions) return null;
  const prepared = prepareMessageCardUpdate({ card: input.card, content: input.content });
  if (!prepared.ok) return null;
  const found = await getDb().select({
    messageId: messages.id,
    channelId: messages.channelId,
    revision: messageCardRevisions.revision,
    card: messageCardRevisions.card,
    content: messageCardRevisions.content,
    createdAt: messageCardRevisions.createdAt,
  }).from(messageCardRevisions)
    .innerJoin(messages, eq(messages.id, messageCardRevisions.messageId))
    .where(and(
      ...idConditions,
      eq(messages.senderType, "agent"),
      eq(messages.senderId, input.senderAgentId),
      eq(messageCardRevisions.idempotencyKey, input.idempotencyKey),
    ))
    .limit(2);
  // A short id naming two of the sender's messages with this key: the checks resolve it.
  const [earlier, another] = found;
  if (!earlier || another) return null;
  return replayMessageCardUpdate(earlier, {
    messageId: earlier.messageId, channelId: earlier.channelId, card: prepared.card, content: prepared.content, senderWroteContent: prepared.senderWroteContent,
  });
}

/**
 * Applies an update the route checked (flag, sender, window, card), in one
 * transaction: for a Joint Channel's card, first the sender's posting
 * authority on its own Server's side of the joint, locked and re-checked
 * (lockJointPostingAuthority, as a send takes it before its message row: the
 * local channel row, the server and membership rows, the joint membership
 * lock, all before any message row; a revoked authority is `not_found`), then
 * the message row locked, then the key's earlier revision
 * (replayed, or a conflict), then `expectedRevision`, then the bump as a
 * compare-and-swap on the stored revision; the new `action_metadata`
 * (revision + 1, `updatedAt`), `content` and its search text, the revision row,
 * the change_log row (§4.4) and, for a message with a Slack delivery, the
 * latest revision its Slack copy should show (§4.6; the edit worker sends it).
 * No mention, inbox item, push or agent wakeup: nothing here notifies. The
 * caller emits `message:updated` after it commits.
 */
export async function applyMessageCardUpdate(input: {
  messageId: string;
  senderAgentId: string;
  card: MessageCard;
  content: string;
  /** False when `content` is the fallback Raft derived from the card: a replay under the key compares the card alone. Default true. */
  senderWroteContent?: boolean;
  expectedRevision?: number;
  idempotencyKey?: string | null;
  /**
   * A Joint Channel's card: the local channel whose Joint membership admits
   * the sender's post (the route's checks resolved it: the sender's own
   * Server's projection, or a thread's local parent). Absent otherwise.
   */
  jointPostingAuthorityChannelId?: string | null;
  /**
   * The message's stored channel the route's checks ran on. Moved since (its
   * channel converted to a joint, or a conversion rolled back), the update
   * writes nothing (`not_found`): the sender's retry resolves it again.
   */
  expectedChannelId?: string;
  now?: Date;
}): Promise<MessageCardUpdateOutcome> {
  const now = input.now ?? currentDate();
  return getDb().transaction(async (tx) => {
    // Lock order: the Joint posting authority first (the local channel row
    // FOR SHARE, the server and the agent's server membership FOR SHARE, the
    // joint membership lock when that mode is on), then the message row FOR
    // UPDATE, then what follows it (the revision, the change log, the Slack
    // edit's sync rows: slackCardEditSync.ts). The send path's order
    // (broadcastAndDeliver takes lockJointPostingAuthority before its message
    // write), and the one writers holding the projection row FOR UPDATE need:
    // a mention action's add (mentionActionService.ts) locks it, then inserts
    // an inbox fact whose foreign key takes FOR KEY SHARE on the mentioned
    // message, so an update holding the message row while it waited for the
    // projection would close a cycle with it. Before any lock here an update
    // holds nothing. The Slack edit worker takes the message FOR SHARE, then
    // the projection row FOR SHARE: both shared, so it never waits for this
    // update's channel lock (nor queues behind an archive waiting there).
    // Guards: slackCardEditLockOrder.realPg.test.ts.
    if (input.jointPostingAuthorityChannelId) {
      try {
        await lockJointPostingAuthority(input.jointPostingAuthorityChannelId, "agent", input.senderAgentId, tx);
      } catch (err) {
        if (err instanceof JointChannelAccessChangedError) return { kind: "not_found" };
        throw err;
      }
    }
    const [row] = await tx.select({
      id: messages.id,
      channelId: messages.channelId,
      senderType: messages.senderType,
      senderId: messages.senderId,
      actionMetadata: messages.actionMetadata,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
      updatedAt: messages.updatedAt,
    }).from(messages).where(eq(messages.id, input.messageId)).for("update").limit(1);
    if (!row || row.deletedAt || row.senderType !== "agent" || row.senderId !== input.senderAgentId
      || !isMessageCardMetadata(row.actionMetadata) || !withinMessageCardUpdateWindow(row.createdAt, now)) {
      return { kind: "not_found" };
    }
    if (input.idempotencyKey) {
      const [earlier] = await tx.select().from(messageCardRevisions)
        .where(and(eq(messageCardRevisions.messageId, row.id), eq(messageCardRevisions.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      // The key's update the route's lookup did not answer (a concurrent retry): its first answer, or the conflict.
      if (earlier) {
        return replayMessageCardUpdate(earlier, {
          messageId: row.id, channelId: row.channelId, card: input.card, content: input.content, senderWroteContent: input.senderWroteContent !== false,
        });
      }
    }
    // Under the row lock: still in the conversation the checks (and the
    // authority above, or its absence) were for. A conversion moves messages
    // under their row locks, so it either committed before (seen here) or
    // waits for this commit.
    if (input.expectedChannelId !== undefined && row.channelId !== input.expectedChannelId) return { kind: "not_found" };
    const current = row.actionMetadata;
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      return { kind: "revision_conflict", currentRevision: current.revision };
    }
    const next = messageCardMetadataAfterUpdate(current, input.card, now);
    // Reply previews use updatedAt as their content revision: keep it monotonic.
    const updatedAt = new Date(Math.max(now.getTime(), row.updatedAt.getTime() + 1));
    // Compare-and-swap on the stored revision (the row lock already orders
    // writers; this keeps two updates from both winning without it).
    const swapped = await tx.update(messages)
      .set({ actionMetadata: next, content: input.content, searchText: buildSearchText(input.content), updatedAt })
      .where(and(eq(messages.id, row.id), sql`(${messages.actionMetadata}->>'revision')::int = ${current.revision}`))
      .returning({ id: messages.id });
    if (swapped.length === 0) throw new Error("message card revision moved under its row lock");
    await insertMessageCardRevision(tx, {
      messageId: row.id,
      revision: next.revision,
      card: input.card,
      content: input.content,
      senderAgentId: input.senderAgentId,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    });
    await logMessageChanged(tx, { messageId: row.id, channelId: row.channelId });
    // RFC 082 §4.6: the intent to edit the Slack copy commits with the update or not at all.
    await recordSlackCardEditIntent(tx, { messageId: row.id, revision: next.revision, now });
    return {
      kind: "updated",
      replayed: false,
      channelId: row.channelId,
      answer: messageCardUpdateAnswer({ messageId: row.id, revision: next.revision, updatedAt: now, content: input.content }),
    };
  });
}

// ---------------------------------------------------------------------------
// Revisions (RFC 082 §4.5): read from the message by whoever may read it (the
// route checks that), deleted 44 days after the message was sent.

/** One kept version of a card, oldest first. */
export interface MessageCardRevisionView {
  revision: number;
  card: unknown;
  content: string;
  createdAt: string;
}

export async function listMessageCardRevisions(messageId: string): Promise<MessageCardRevisionView[]> {
  const rows = await getDb().select({
    revision: messageCardRevisions.revision,
    card: messageCardRevisions.card,
    content: messageCardRevisions.content,
    createdAt: messageCardRevisions.createdAt,
  }).from(messageCardRevisions).where(eq(messageCardRevisions.messageId, messageId)).orderBy(messageCardRevisions.revision);
  return rows.map((row) => ({ revision: row.revision, card: row.card, content: row.content, createdAt: row.createdAt.toISOString() }));
}

const PRUNE_BATCH_SIZE = 1000;
const PRUNE_MAX_BATCHES = 20;

/**
 * Hourly maintenance (server.ts, `prune_message_card_revisions`): every
 * revision of a message sent more than 44 days ago, in bounded batches. A
 * revision is written within 14 days of its message, so the candidates are
 * read through the `created_at` index (older than 30 days), then kept to
 * messages past retention. The message keeps its current card.
 */
export async function pruneMessageCardRevisions(opts: { now?: Date; batchSize?: number; maxBatches?: number; executor?: DatabaseExecutor } = {}): Promise<number> {
  const db = opts.executor ?? getDb();
  const now = (opts.now ?? currentDate()).getTime();
  const messageCutoff = new Date(now - MESSAGE_CARD_LIMITS.revisionRetentionDays * DAY_MS);
  const revisionCutoff = new Date(now - (MESSAGE_CARD_LIMITS.revisionRetentionDays - MESSAGE_CARD_LIMITS.updateWindowDays) * DAY_MS);
  const batchSize = opts.batchSize ?? PRUNE_BATCH_SIZE;
  let total = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? PRUNE_MAX_BATCHES); batch += 1) {
    const old = db.select({ messageId: messageCardRevisions.messageId, revision: messageCardRevisions.revision })
      .from(messageCardRevisions)
      .innerJoin(messages, eq(messages.id, messageCardRevisions.messageId))
      .where(and(lt(messageCardRevisions.createdAt, revisionCutoff), lt(messages.createdAt, messageCutoff)))
      .orderBy(messageCardRevisions.createdAt)
      .limit(batchSize);
    const deleted = await db.delete(messageCardRevisions)
      .where(sql`(${messageCardRevisions.messageId}, ${messageCardRevisions.revision}) IN (${old})`)
      .returning({ messageId: messageCardRevisions.messageId });
    total += deleted.length;
    if (deleted.length < batchSize) break;
  }
  return total;
}
