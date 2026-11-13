import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentTurnTriggers, assistantWechatMirrorMarks, messages, wechatBridgeInboundMessages } from "../db/schema";

// Which of a personal assistant's messages may be mirrored back to WeChat
// (the outbound mirror asks getWeChatMirrorDecision): only a message it sent
// while its turn carried a WeChat message (agent_turn_triggers, wechatTurn.ts:
// a WeChat message triggered the turn, or was merged into it), into that
// turn's DM, top level. A Raft-triggered turn (say, summarising another channel
// into the DM) is never mirrored; neither is a reply sent before a WeChat
// message reached the turn mid-way, nor a message in a thread or any other
// conversation.
//
// Decided once, at send time: markWeChatMirrorInTransaction runs inside the
// send's own transaction (messageService.broadcastAndDeliver's
// afterAgentInsertInTransaction, only for a newly inserted message, never for
// an idempotent replay) and reads the turn record as it is then. So the mark
// commits with the message, and whoever sees the message sees its mark.

export type WeChatMirrorDecision = { mirror: true; inboundRandomId: string } | { mirror: false };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Whether the assistant's message `messageId` may be mirrored to WeChat, and
 * the inbound WeChat message (its random_id, `wechat:<uuid>`) whose
 * context_token the reply carries: the turn's most recent WeChat trigger when
 * the message was sent. Anything else, including an unknown id or any error,
 * is `{ mirror: false }` (fail closed).
 */
export async function getWeChatMirrorDecision(
  messageId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<WeChatMirrorDecision> {
  try {
    if (typeof messageId !== "string" || !UUID_RE.test(messageId)) return { mirror: false };
    const [row] = await executor
      .select({ inboundRandomId: assistantWechatMirrorMarks.inboundRandomId })
      .from(assistantWechatMirrorMarks)
      .where(eq(assistantWechatMirrorMarks.messageId, messageId.toLowerCase()))
      .limit(1);
    return row ? { mirror: true, inboundRandomId: row.inboundRandomId } : { mirror: false };
  } catch (err) {
    console.error("[wechat-mirror] decision failed closed:", err instanceof Error ? err.name : "error");
    return { mirror: false };
  }
}

/**
 * The random_id of the most recent of `triggerMessageIds` (oldest first) that
 * the WeChat bridge wrote into `dmChannelId`, matched as wechatTurn.ts
 * does (by message_id once filled, by the owner's randomId before); null if none.
 */
async function latestWeChatTriggerRandomId(
  triggerMessageIds: readonly string[],
  dmChannelId: string,
  executor: DatabaseExecutor,
): Promise<string | null> {
  const ids = triggerMessageIds.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  if (ids.length === 0) return null;
  const randomIdByMessage = new Map<string, string>();
  const byMessageId = await executor
    .select({ messageId: wechatBridgeInboundMessages.messageId, randomId: wechatBridgeInboundMessages.randomId })
    .from(wechatBridgeInboundMessages)
    .where(and(inArray(wechatBridgeInboundMessages.messageId, ids), eq(wechatBridgeInboundMessages.dmChannelId, dmChannelId)));
  for (const row of byMessageId) if (row.messageId) randomIdByMessage.set(row.messageId, row.randomId);
  const byRandomId = await executor
    .select({ messageId: messages.id, randomId: wechatBridgeInboundMessages.randomId })
    .from(messages)
    .innerJoin(wechatBridgeInboundMessages, and(
      eq(wechatBridgeInboundMessages.randomId, messages.randomId),
      eq(messages.senderId, sql`${wechatBridgeInboundMessages.ownerUserId}::text`),
    ))
    .where(and(
      inArray(messages.id, ids),
      eq(messages.senderType, "user"),
      isNotNull(messages.randomId),
      eq(wechatBridgeInboundMessages.dmChannelId, dmChannelId),
    ));
  for (const row of byRandomId) randomIdByMessage.set(row.messageId, row.randomId);
  for (let i = ids.length - 1; i >= 0; i--) {
    const randomId = randomIdByMessage.get(ids[i]!);
    if (randomId) return randomId;
  }
  return null;
}

/**
 * In the send's transaction, right after the assistant's message is inserted:
 * mark it mirrorable when the agent's turn carries a WeChat message from
 * exactly the message's channel. Callers apply the gate (wechatTurn.ts
 * isAssistantWeChatActive) before the transaction. Runs in a savepoint and
 * never throws: a failure only means no mark (no mirror), never a failed send.
 */
export async function markWeChatMirrorInTransaction(
  input: { agentId: string; messageId: string; channelId: string },
  executor: DatabaseExecutor,
): Promise<boolean> {
  try {
    return await executor.transaction(async (savepoint) => {
      const [turn] = await savepoint
        .select({
          turnId: agentTurnTriggers.turnId,
          wechatRestricted: agentTurnTriggers.wechatRestricted,
          dmChannelId: agentTurnTriggers.wechatAllowedChannelId,
          triggerMessageIds: agentTurnTriggers.triggerMessageIds,
        })
        .from(agentTurnTriggers)
        .where(eq(agentTurnTriggers.agentId, input.agentId))
        .limit(1);
      if (!turn?.wechatRestricted || turn.dmChannelId === null || turn.dmChannelId !== input.channelId) return false;
      const inboundRandomId = await latestWeChatTriggerRandomId(turn.triggerMessageIds, turn.dmChannelId, savepoint);
      if (!inboundRandomId) return false;
      await savepoint.insert(assistantWechatMirrorMarks).values({
        messageId: input.messageId,
        agentId: input.agentId,
        turnId: turn.turnId,
        inboundRandomId,
      }).onConflictDoNothing();
      return true;
    });
  } catch (err) {
    console.error("[wechat-mirror] mark failed; not mirrored:", err instanceof Error ? err.name : "error");
    return false;
  }
}
