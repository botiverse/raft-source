import { sql, type SQL } from "drizzle-orm";
import { messageMentions, messages } from "../db/schema";
import { SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION } from "./systemMessageBornReadRegistry";

/**
 * THE rule for "is this persisted message unread for this receiver", on the
 * application side. It is the per-row half of the unified inbox chain's unread
 * predicate (rw_inbox_normal_v5, infra/risingwave/sql/075-inbox-cursor-decouple.sql):
 *
 *   NOT (sender = receiver)
 *   AND NOT COALESCE(message_type = 'system' AND causal_actor = receiver, FALSE)
 *   AND (system_subtype IS NULL OR system_subtype NOT IN <noise subtypes>)
 *
 * (the read cursor / join boundary half lives in the chain and read positions).
 *
 * Every transport that hands a message to a receiver must agree with it: live
 * agent delivery (managed `agent:deliver` and the external inbox signal that
 * drives the notice push), the inbox fact rows, and the external pull. A message
 * the inbox considers born-read for a receiver (it caused it: "@X joined / was
 * added" by X itself) or noise must never wake that receiver or appear in its
 * notice, because its pull (`/events`) will never return it.
 */

/**
 * System subtypes that are never unread for anyone: exactly the `skip`
 * producers of the born-read registry (no inbox fact recorded). Derived, so a
 * new skip producer joins the rule automatically; the chain SQL's literal list
 * is pinned against this by inboxUnreadEligibility.test.ts.
 */
export const INBOX_NOISE_SYSTEM_SUBTYPES: readonly string[] = Object.entries(SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION)
  .filter(([, classification]) => classification === "skip")
  .map(([producer]) => producer)
  .sort();

export type InboxReceiver = { type: "user" | "agent"; id: string };

/** The message columns the rule reads (a `messages` row satisfies it). */
export type InboxEligibilityMessage = {
  senderType: string;
  senderId: string;
  messageType?: "chat" | "system" | null;
  causalActorType?: string | null;
  causalActorId?: string | null;
  systemSubtype?: string | null;
};

export function isMessageUnreadEligibleForReceiver(
  message: InboxEligibilityMessage,
  receiver: InboxReceiver,
  opts: {
    /**
     * The receiver holds a notifiable personal mention on this message. The
     * chain's mention arm (rw_inbox_mention_v6) counts it unread regardless of
     * the born-read / noise exclusions, so they do not apply to it.
     */
    personallyMentioned?: boolean;
  } = {},
): boolean {
  if (message.senderType === receiver.type && message.senderId === receiver.id) return false;
  if (opts.personallyMentioned) return true;
  // NULL causal actor / message type means no exclusion applies (chain NULL rule).
  if (
    message.messageType === "system"
    && message.causalActorType === receiver.type
    && message.causalActorId === receiver.id
  ) return false;
  if (message.systemSubtype != null && INBOX_NOISE_SYSTEM_SUBTYPES.includes(message.systemSubtype)) return false;
  return true;
}

/** The same rule as a SQL condition over `messages` (Postgres reads). */
export function messageUnreadEligibleForReceiverSql(receiver: InboxReceiver): SQL {
  return sql`(NOT (${messages.senderType} = ${receiver.type} AND ${messages.senderId} = ${receiver.id})
    AND (
      EXISTS (
        SELECT 1 FROM ${messageMentions}
        WHERE ${messageMentions.messageId} = ${messages.id}
          AND ${messageMentions.targetType} = ${receiver.type} AND ${messageMentions.targetId} = ${receiver.id}
          AND (${messageMentions.notifiableAtSend} OR ${messageMentions.notifiedAt} IS NOT NULL)
      )
      OR (
        NOT COALESCE(${messages.messageType} = 'system' AND ${messages.causalActorType} = ${receiver.type} AND ${messages.causalActorId} = ${receiver.id}, FALSE)
        AND (${messages.systemSubtype} IS NULL OR ${messages.systemSubtype} NOT IN (${sql.join(INBOX_NOISE_SYSTEM_SUBTYPES.map((subtype) => sql`${subtype}`), sql`, `)}))
      )
    ))`;
}

/**
 * Task v2: what a task conversation's human-facing unread counts — "N new" on
 * its Activity row, the followed list and the sidebar — on the same basis as
 * its reply count: chat messages from people and agents, not the lifecycle
 * lines (system messages: status moves, assignment receipts). Applied on top of
 * the cursor and own-send halves of the rule above, so "new" never exceeds the
 * replies. RisingWave: rw_task_conversation_unread_v1
 * (infra/risingwave/sql/078-task-conversations.sql). Web live increment:
 * applyTaskConversationReply (packages/web/src/store/socketBridge.ts).
 *
 * Deliberately NOT part of isMessageUnreadEligibleForReceiver: agent delivery
 * and the inbox facts keep the transport rule (an agent is still woken by a
 * status change it did not cause), and personal attention is separate — a
 * mention on a lifecycle line (the assignment notice) still reaches the
 * assignee through the mention arm and its inbox fact.
 */
export function countsTowardTaskConversationUnread(message: Pick<InboxEligibilityMessage, "messageType">): boolean {
  return message.messageType == null || message.messageType === "chat";
}

/**
 * countsTowardTaskConversationUnread as a SQL condition over a `messages` alias,
 * guarded by whether the row is a task conversation (`isTaskConversation`): a
 * thread or channel row keeps every eligible message.
 */
export function taskConversationUnreadMessageSql(messageAlias: SQL, isTaskConversation: SQL): SQL {
  return sql`(NOT (${isTaskConversation}) OR ${messageAlias}.message_type = 'chat')`;
}
