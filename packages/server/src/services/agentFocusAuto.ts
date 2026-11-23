// Focus, auto-focus (flag `agent_focus_v0`): the cases where Raft adds a
// conversation to an agent's focus set by itself (source `auto`), and the
// note on the delivery that caused it (`AgentMessage.focus_change`).
// Contract: docs/contracts/agent-focus.md, "Auto-focus".
//
// Everything here is best effort and bounded. It runs beside a delivery or
// after a task write has committed, and it must neither fail nor hold up
// either: every entry point catches and logs, nothing here waits for another
// transaction (the agent's lock is only tried, never waited for), and nothing
// is stored to be told later. Called while a transaction is open it does
// nothing: its writes would join that transaction (getDb() does).
//
// The limit, the order entries are let go in and the rule that an unfocus
// sticks are in agentFocusService.autoFocus; this file decides when to call
// it, checks that the agent can read the conversation first, and keeps the
// calls rare.
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { asChannelId, readTaskAssignmentNotice, type AgentFocusChange, type AgentFocusChangeReason, type AgentMessage, type ServerId } from "@botiverse/raft-shared";
import { isInTransaction } from "../db/ambientTransaction";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, channels, messages, tasks } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { agentFocuses, canBeFocused, focusFlagOn, forgetFocusSets, stampFocus } from "./agentFocusDelivery";
import * as agentFocusService from "./agentFocusService";
import { renderRelatedTargets } from "./agentInboxItems";
import { isLoungeOutsiderAgent } from "./agentLoungeService";
import { canView } from "./visibilityService";

/**
 * One (agent, conversation) is tried at most once per this long on a replica,
 * whatever the try did: focused it, refreshed it, or left it alone. A
 * conversation that an auto-focus let go is marked as tried too, so its next
 * trigger inside the interval does not take the place straight back. So a
 * busy focused conversation writes `last_active_at` once a minute, not once a
 * message, and that time can be up to a minute behind its last trigger.
 */
export const AUTO_FOCUS_RETRY_INTERVAL_MS = 60_000;
/** Past this many pairs the record starts over (bounds memory; the cost is one early retry each). */
const MAX_TRIES = 10_000;

/**
 * `agentId:channelId` to the last try on this replica. `deciding` is set
 * while that try runs: a second delivery to the same pair waits for it, so it
 * is tagged the same way and does not leave untagged ahead of the first.
 */
const tries = new Map<string, { at: number; deciding?: Promise<void> }>();
const pair = (agentId: string, channelId: string) => `${agentId}:${channelId}`;

/** Tests: forget every try. */
export function __clearAutoFocusTriesForTests(): void {
  tries.clear();
}

function noteTry(key: string): { at: number; deciding?: Promise<void> } {
  if (tries.size >= MAX_TRIES) tries.clear();
  const entry = { at: Date.now() };
  tries.set(key, entry);
  return entry;
}

/**
 * Reads whether a Computer advertised the Focus capability, for the claim
 * hook, which runs where no orchestrator is at hand. Set once at boot
 * (server.ts). Until it is set, a claim focuses nothing.
 */
let machineCapabilityReader: ((machineId: string) => Promise<boolean>) | null = null;

export function setAgentFocusCapabilityReader(reader: ((machineId: string) => Promise<boolean>) | null): void {
  machineCapabilityReader = reader;
}

/**
 * What kind of trigger a delivery may be, read off the message alone (no I/O):
 * - `mentioned`: a person or an agent @mentions the agent in a thread or a
 *   task conversation (which arrives as a thread);
 * - `dm`: a DM message written by a person or another agent;
 * - `system_mention`: a system line that mentions the agent in a thread. Only
 *   a task's assignment line is a trigger; the caller looks the line up.
 * Null for everything else: a mention in a plain channel, an app's message or
 * event, a system line in a DM (all the reminders DM holds), a message with
 * no channel row behind it, and a message that already carries
 * `focus_change` (another replica made that focus and handed the message on).
 */
export function deliveryFocusTrigger(message: AgentMessage): "mentioned" | "dm" | "system_mention" | null {
  if (!canBeFocused(message) || message.focus_change) return null;
  const written = message.sender_type === "human" || message.sender_type === "agent";
  if (message.channel_type === "dm") return written && !message.third_party_event ? "dm" : null;
  if (message.mentioned !== true) return null;
  if (written) return "mentioned";
  return message.sender_type === "system" && UUID_RE.test(message.message_id ?? "") ? "system_mention" : null;
}

function warn(what: string, err: unknown): void {
  console.warn(`[AgentFocus] ${what}; nothing was focused`, serializeErrorForLog(err));
}

/**
 * The thread of a task's source message on the agent's server, if there is
 * one (this creates none). `task` is the task's id, or its conversation's
 * channel id. For a task from before task v2 the source is its host message.
 */
async function sourceThreadOf(task: { taskId: string } | { conversationChannelId: string }, serverId: string): Promise<string | null> {
  const source = sql<string | null>`coalesce(${tasks.sourceMessageId}, ${tasks.messageId})`;
  const [row] = "taskId" in task
    ? await getDb().select({ source }).from(tasks).where(eq(tasks.id, task.taskId)).limit(1)
    : await getDb().select({ source }).from(channels).innerJoin(tasks, eq(tasks.id, channels.taskId))
      .where(and(eq(channels.id, task.conversationChannelId), eq(channels.type, "task"))).limit(1);
  if (!row?.source) return null;
  // Only the agent's own server's thread: in a joint channel other servers have their own copy.
  const [thread] = await getDb().select({ id: channels.id }).from(channels)
    .where(and(eq(channels.parentMessageId, row.source), eq(channels.type, "thread"), eq(channels.serverId, serverId), isNull(channels.deletedAt)))
    .orderBy(asc(channels.createdAt), asc(channels.id)).limit(1);
  return thread?.id ?? null;
}

/**
 * Whether the system line is the assignment line that hands a task to this
 * agent: the stored message carries the assignment structure
 * (`TaskAssignmentNoticeMetadata`) and names the agent as the new assignee.
 */
async function isAssignmentLineFor(messageId: string, agentId: string): Promise<boolean> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId)).limit(1);
  const assignee = readTaskAssignmentNotice(row?.actionMetadata)?.assignee;
  return assignee?.type === "agent" && assignee.id === agentId;
}

/**
 * Focus these conversations for the agent with source `auto`, each after the
 * checks the focus route makes: the agent can read it, it is not another
 * agent's lounge, and it has an address to list it under. One it had
 * unfocused stays so unless it has written there since.
 *
 * `busy`: another call holds the agent's focus lock; nothing was tried.
 * Otherwise what to tell: the conversations focused that were not before,
 * and what was let go for them.
 */
async function autoFocusConversations(input: {
  agentId: string;
  serverId: string;
  channelIds: readonly string[];
}): Promise<"busy" | { focused: string[]; unfocused: string[] }> {
  const { agentId, serverId } = input;
  const readable = (channelIds: readonly string[], executor?: DatabaseExecutor) => canView(
    { type: "agent", id: agentId, serverId: serverId as ServerId },
    channelIds.map((id) => ({ kind: "conversation" as const, channelId: id })),
    { executor },
  );
  // The agent wrote in the conversation after it unfocused it: it came back, so the unfocus no longer holds.
  const unfocusLifted = async (unfocusedAt: Date, executor: DatabaseExecutor, channelId: string) => (await executor
    .select({ id: messages.id }).from(messages)
    .where(and(eq(messages.channelId, channelId), gt(messages.createdAt, unfocusedAt), eq(messages.senderType, "agent"), eq(messages.senderId, agentId)))
    .limit(1)).length > 0;
  const focused = new Map<string, string>();
  const evicted = new Set<string>();
  for (const [index, channelId] of input.channelIds.entries()) {
    if (!(await readable([channelId]))[0] || await isLoungeOutsiderAgent(channelId, agentId)) continue;
    const target = (await renderRelatedTargets(serverId, agentId, [channelId])).get(channelId);
    if (!target) continue;
    const result = await agentFocusService.autoFocus(agentId, asChannelId(channelId), {
      stillReadable: readable,
      unfocusLifted: (unfocusedAt, executor) => unfocusLifted(unfocusedAt, executor, channelId),
    });
    if (result === "busy") {
      if (index === 0) return "busy";
      break;
    }
    if (result === "unfocused" || result === "full") continue;
    noteTry(pair(agentId, channelId));
    if (!result.alreadyFocused) focused.set(channelId, target);
    for (const entry of result.evicted) {
      // Let go for this one: its next trigger inside the interval does not take the place back.
      noteTry(pair(agentId, entry.channelId));
      // One focused a moment ago in this same step was never the agent's to lose: not told either way.
      if (!focused.delete(entry.channelId)) evicted.add(entry.channelId);
    }
  }
  const evictedTargets = evicted.size > 0 ? await renderRelatedTargets(serverId, agentId, [...evicted]) : new Map<string, string>();
  return { focused: [...focused.values()].reverse(), unfocused: [...evicted].flatMap((id) => evictedTargets.get(id) ?? []) };
}

/** One try for a triggering delivery: what to tell the agent, `busy`, or null when nothing new was focused. */
async function tryDelivery(input: {
  agentId: string;
  serverId: string;
  message: AgentMessage;
  trigger: NonNullable<ReturnType<typeof deliveryFocusTrigger>>;
  machineCapable: () => boolean | Promise<boolean>;
}): Promise<AgentFocusChange | "busy" | null> {
  const { agentId, serverId, message, trigger } = input;
  const channelId = message.channel_id;
  if (!await input.machineCapable()) return null;
  let reason: AgentFocusChangeReason;
  let channelIds = [channelId];
  if (trigger === "system_mention") {
    if (!await isAssignmentLineFor(message.message_id!, agentId)) return null;
    reason = "task_assigned";
    // The thread first, so the task's own conversation is the more recently active of the two and is let go last.
    const thread = await sourceThreadOf({ conversationChannelId: channelId }, serverId);
    if (thread) channelIds = [thread, channelId];
  } else {
    reason = trigger;
    if (await agentFocuses(agentId, channelId)) {
      // Focused already (the cached read the tag makes anyway): move its last-active time, in one statement.
      if (!await agentFocusService.touch(agentId, asChannelId(channelId))) forgetFocusSets([channelId]);
      return null;
    }
  }
  const outcome = await autoFocusConversations({ agentId, serverId, channelIds });
  if (outcome === "busy") return "busy";
  return outcome.focused.length > 0 ? { reason, ...outcome } : null;
}

/** The delivery triggers, behind the throttle. Never throws. */
async function autoFocusForDelivery(input: Parameters<typeof tryDelivery>[0]): Promise<AgentFocusChange | null> {
  if (isInTransaction()) return null;
  const key = pair(input.agentId, input.message.channel_id);
  try {
    if (!await focusFlagOn(input.serverId)) return null;
    const last = tries.get(key);
    if (last?.deciding) {
      await last.deciding;
      return null;
    }
    if (last && Date.now() - last.at < AUTO_FOCUS_RETRY_INTERVAL_MS) return null;
    const entry = noteTry(key);
    let change: AgentFocusChange | null = null;
    entry.deciding = tryDelivery(input).then((outcome) => {
      // Lock contention is no try: the next message tries again.
      if (outcome === "busy") tries.delete(key);
      else change = outcome;
    }, (err) => warn("auto-focus on a delivery failed", err)).finally(() => {
      delete entry.deciding;
    });
    await entry.deciding;
    return change;
  } catch (err) {
    warn("auto-focus on a delivery failed", err);
    return null;
  }
}

/**
 * One message on its way to one agent, as it should leave: the conversation
 * auto-focused first when the message is a trigger, then the Focus tag
 * (stampFocus), then `focus_change` on the tagged message when this delivery
 * focused something.
 *
 * The auto-focus comes before the tag on purpose: focusing drops the
 * conversation's cached focus set, so the tag read that follows sees the new
 * entry and the triggering message itself leaves tagged.
 *
 * Call it where stampFocus is called on the live path: after the delivery's
 * access check. Never throws; on any failure the message leaves as stampFocus
 * alone would send it.
 */
export async function focusOnDelivery(input: {
  agentId: string;
  serverId: string | null | undefined;
  message: AgentMessage;
  machineCapable: () => boolean | Promise<boolean>;
}): Promise<AgentMessage> {
  const { serverId } = input;
  const trigger = serverId ? deliveryFocusTrigger(input.message) : null;
  const change = trigger && serverId ? await autoFocusForDelivery({ ...input, serverId, trigger }) : null;
  const [message] = await stampFocus({ ...input, messages: [input.message] }) as [AgentMessage];
  return change && message.focused === true ? { ...message, focus_change: change } : message;
}

/**
 * An agent took a task itself (a claim, or assigning it to itself). Nothing
 * is delivered to it for that, so this focuses silently: the task's
 * conversation as the agent's server sees it (`conversationChannelId`, null
 * when the task has none) and the thread of the task's source message when
 * there is one. No `focus_change` is sent for it.
 *
 * Call it only after the task write has committed. Never throws.
 */
export async function autoFocusOwnTask(input: { taskId: string; agentId: string; conversationChannelId: string | null }): Promise<void> {
  const { agentId } = input;
  if (!machineCapabilityReader || isInTransaction()) return;
  try {
    const [agent] = await getDb()
      .select({ serverId: agents.serverId, machineId: agents.machineId })
      .from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent?.machineId || !await focusFlagOn(agent.serverId)) return;
    if (!await machineCapabilityReader(agent.machineId)) return;
    const thread = await sourceThreadOf({ taskId: input.taskId }, agent.serverId);
    const channelIds = [thread, input.conversationChannelId].filter((id): id is string => Boolean(id));
    if (channelIds.length > 0) await autoFocusConversations({ agentId, serverId: agent.serverId, channelIds });
  } catch (err) {
    warn(`auto-focus for the claim of task ${input.taskId} failed`, err);
  }
}
