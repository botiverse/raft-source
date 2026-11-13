import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentTurnTriggers, messages, wechatBridgeInboundMessages } from "../db/schema";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, evaluateFeatureFlags, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "./featureFlagService";

// Which of a personal assistant's turns carry a WeChat message (design
// "微信接入 Ottie", main line, #proj-assistant:742b8915). WeChat messages reach
// the assistant like its owner's own DM messages, through its one (main)
// credential, and it reads everything as usual. What this record decides is
// only which replies go back to WeChat (wechatMirrorDecision.ts): the
// top-level replies in the DM of a turn that a WeChat message triggered, or
// that one was merged into, from then on.
//
// The turn is the server's own record (agent_turn_triggers), never what the
// runtime reports. A personal assistant is hosted: messages reach it only
// through its inbox pull (`GET /internal/agent-api/events`, after a
// content-free push notice). Each pull that hands over anything records it
// here (recordAssistantTurnTriggers):
//   - it STARTS a new turn (new server-minted turn_id; ids and WeChat state
//     replaced) only when the agent was observed idle (activity online or
//     offline: its turn ended or its runtime is gone) after the turn's latest
//     hand-off;
//   - otherwise it JOINS the current turn (a message injected mid-turn): the
//     ids are appended, and a WeChat message makes it a WeChat turn from then
//     on (never the other way).
// A turn ends at the next hand-off that starts one.
//
// The WeChat tag is a wechat_bridge_inbound_messages row, written only by the
// bridge and BEFORE the message is posted (the tag-first contract):
//   1. insert the inbound row with a bridge-generated random_id `wechat:<uuid>`;
//   2. post the message as the owner with randomId = that random_id (the send
//      path is idempotent per sender and randomId, so a retry or a crash replay
//      makes one message);
//   3. fill the row's message_id.
// So a message is tagged from the moment it exists: it matches by
// messages.random_id (sent by the owner) before step 3, and by message_id after.
//
// Gate: only while `personal_assistant` is on for the server and
// `assistant_wechat_v0` for the owner; otherwise nothing is recorded or
// marked. Cached per replica (GATE_TTL_MS) so an assistant's hot path pays no
// flag query on most requests; an evaluation error counts as on (the turn
// record then decides, and a turn with no WeChat message mirrors nothing).

/**
 * How many trigger ids a turn keeps (the most recent). The WeChat state is
 * sticky, but the mirror answers the most recent WeChat trigger still kept:
 * once it falls out, later replies of the turn are not mirrored (fail closed).
 */
export const TURN_TRIGGER_IDS_KEPT = 200;

const GATE_TTL_MS = 30_000;
const GATE_CACHE_MAX = 10_000;
const gateCache = new Map<string, { active: boolean; expiresAtMs: number }>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Whether the WeChat bridge is on for an assistant of `ownerUserId` in
 * `serverId`: both flags on. Cached per replica for GATE_TTL_MS; an
 * evaluation failure is not cached and counts as on.
 */
export async function isAssistantWeChatActive(serverId: string, ownerUserId: string, nowMs = Date.now()): Promise<boolean> {
  const key = `${serverId}:${ownerUserId}`;
  const cached = gateCache.get(key);
  if (cached && cached.expiresAtMs > nowMs) return cached.active;
  let active: boolean;
  try {
    const [assistant, wechat] = await evaluateFeatureFlags([
      { key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, serverId },
      { key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, userId: ownerUserId, serverId },
    ]);
    active = assistant?.enabled === true && wechat?.enabled === true;
  } catch (err) {
    console.error("[wechat-turn] flag evaluation failed; counting as on:", err instanceof Error ? err.name : "error");
    return true;
  }
  if (gateCache.size >= GATE_CACHE_MAX) gateCache.clear();
  gateCache.set(key, { active, expiresAtMs: nowMs + GATE_TTL_MS });
  return active;
}

/** Test seam: forget cached gate answers. */
export function __resetAssistantWeChatGateCacheForTests(): void {
  gateCache.clear();
}

/**
 * Whether any of `messageIds` was written by the WeChat bridge, and into which
 * DM: `{ wechat: false }` when none was; `{ wechat: true, dmChannelId }` when
 * some were, all into one DM; `dmChannelId: null` when that cannot be told (the
 * tagged messages name more than one DM, or the lookup failed), which a turn
 * then keeps: it mirrors nothing (fail closed).
 */
export async function weChatTriggerOf(
  messageIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<{ wechat: false } | { wechat: true; dmChannelId: string | null }> {
  const ids = [...new Set(messageIds.filter((id) => typeof id === "string" && UUID_RE.test(id)).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return { wechat: false };
  try {
    const channels = new Set<string>();
    const byMessageId = await executor
      .select({ dmChannelId: wechatBridgeInboundMessages.dmChannelId })
      .from(wechatBridgeInboundMessages)
      .where(inArray(wechatBridgeInboundMessages.messageId, ids));
    for (const row of byMessageId) channels.add(row.dmChannelId);
    // Before message_id is filled: the message the owner "sent" with the bridge's randomId.
    const byRandomId = await executor
      .select({ dmChannelId: wechatBridgeInboundMessages.dmChannelId })
      .from(messages)
      .innerJoin(wechatBridgeInboundMessages, and(
        eq(wechatBridgeInboundMessages.randomId, messages.randomId),
        eq(messages.senderId, sql`${wechatBridgeInboundMessages.ownerUserId}::text`),
      ))
      .where(and(
        inArray(messages.id, ids),
        eq(messages.senderType, "user"),
        isNotNull(messages.randomId),
      ));
    for (const row of byRandomId) channels.add(row.dmChannelId);
    if (channels.size === 0) return { wechat: false };
    return { wechat: true, dmChannelId: channels.size === 1 ? [...channels][0]! : null };
  } catch (err) {
    console.error("[wechat-turn] trigger lookup failed; nothing of this turn is mirrored:", err instanceof Error ? err.name : "error");
    return { wechat: true, dmChannelId: null };
  }
}

export type AssistantTurnIdentity = { agentId: string; serverId: string; ownerUserId: string };

export type RecordedAssistantTurn = {
  turnId: string;
  startedTurn: boolean;
  /** Whether the turn (as it is now) carries a WeChat message, and the DM its replies are mirrored from (null: none). */
  wechat: { triggered: false } | { triggered: true; dmChannelId: string | null };
};

/**
 * Record a hand-off of `messageIds` (the message ids of what one inbox pull
 * gave the assistant; an empty list for a pull of only app events, e.g. a
 * scheduled check) into the assistant's current turn. `idleObservedAtMs`: when
 * the agent was last observed idle (AgentOrchestrator.getTurnIdleObservedAtMs),
 * null when it is not idle or unknown. Throws on a write failure: the caller
 * must then hand nothing over (so nothing goes unrecorded).
 */
export async function recordAssistantTurnTriggers(
  input: AssistantTurnIdentity & { messageIds: readonly string[]; idleObservedAtMs: number | null; nowMs?: number },
  executor: DatabaseExecutor = getDb(),
): Promise<RecordedAssistantTurn | null> {
  if (!await isAssistantWeChatActive(input.serverId, input.ownerUserId)) return null;
  const ids = [...new Set(input.messageIds.filter((id) => typeof id === "string" && UUID_RE.test(id)).map((id) => id.toLowerCase()))];
  const trigger = await weChatTriggerOf(ids, executor);
  let dmChannelId = trigger.wechat ? trigger.dmChannelId : null;
  if (dmChannelId !== null) {
    // Only the assistant's own DM with its owner is mirrored: a tag naming any
    // other conversation leaves the turn with no DM to mirror from. (Imported
    // lazily: channelService is heavy and this module is loaded by the push
    // service and the Agent API alike.)
    const { assistantMayPostTo } = await import("./channelService");
    const ownDm = await assistantMayPostTo(dmChannelId, input.agentId).catch(() => false);
    if (ownDm !== true) dmChannelId = null;
  }

  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const t = agentTurnTriggers;
  const startsTurn = input.idleObservedAtMs === null
    ? sql`false`
    : sql`(${t.lastTriggerAt} < ${new Date(input.idleObservedAtMs).toISOString()}::timestamptz)`;
  const appended = sql`(${t.triggerMessageIds} || excluded.trigger_message_ids)`;
  const turnId = randomUUID();
  const [row] = await executor.insert(t).values({
    agentId: input.agentId,
    turnId,
    triggerMessageIds: ids,
    wechatRestricted: trigger.wechat,
    wechatAllowedChannelId: dmChannelId,
    turnStartedAt: now,
    lastTriggerAt: now,
  }).onConflictDoUpdate({
    target: t.agentId,
    // Every expression reads the row as it was (Postgres evaluates SET against the old row).
    set: {
      turnId: sql`CASE WHEN ${startsTurn} THEN excluded.turn_id ELSE ${t.turnId} END`,
      turnStartedAt: sql`CASE WHEN ${startsTurn} THEN excluded.turn_started_at ELSE ${t.turnStartedAt} END`,
      triggerMessageIds: sql`CASE WHEN ${startsTurn} THEN excluded.trigger_message_ids
        ELSE ${appended}[GREATEST(cardinality(${appended}) - ${sql.raw(String(TURN_TRIGGER_IDS_KEPT - 1))}, 1):] END`,
      wechatRestricted: sql`CASE WHEN ${startsTurn} THEN excluded.wechat_restricted
        ELSE (${t.wechatRestricted} OR excluded.wechat_restricted) END`,
      // Joining: a turn without WeChat takes the new answer; a WeChat turn keeps
      // its DM when the new hand-off has no WeChat message or names the same
      // DM, and has none (mirrors nothing more) when they disagree.
      wechatAllowedChannelId: sql`CASE
        WHEN ${startsTurn} THEN excluded.wechat_allowed_channel_id
        WHEN NOT ${t.wechatRestricted} THEN excluded.wechat_allowed_channel_id
        WHEN NOT excluded.wechat_restricted THEN ${t.wechatAllowedChannelId}
        WHEN ${t.wechatAllowedChannelId} = excluded.wechat_allowed_channel_id THEN ${t.wechatAllowedChannelId}
        ELSE NULL END`,
      lastTriggerAt: sql`GREATEST(${t.lastTriggerAt}, excluded.last_trigger_at)`,
    },
  }).returning({ turnId: t.turnId, wechatRestricted: t.wechatRestricted, wechatAllowedChannelId: t.wechatAllowedChannelId });
  if (!row) throw new Error("agent turn triggers not recorded");
  return {
    turnId: row.turnId,
    startedTurn: row.turnId === turnId,
    wechat: row.wechatRestricted ? { triggered: true, dmChannelId: row.wechatAllowedChannelId } : { triggered: false },
  };
}
