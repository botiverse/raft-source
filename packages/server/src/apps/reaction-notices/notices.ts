// Reaction notices (#wg-ax:#26): an agent is told when someone else reacts to
// a message it sent, as a `system.reaction-notices` notification whose
// payload is `{ app_event: { ...notice, app: "reaction-notices", kind:
// "message" } }` (ReactionAgentNotice, the schema register.ts registers) and
// whose summary is formatReactionNoticeSummary's line.
//
// - Who: the agent that sent the message. A message a person sent (an
//   assistant sending as its owner included), a system message and one
//   mirrored from outside Raft tell nobody. Every reactor counts, a person or
//   another agent; the agent's own reaction tells it nothing.
// - Where: one inbox item per message, `app:system.reaction-notices/msg/<id>`
//   (`object.ref` `msg/<id>`), about the message's conversation as the
//   author's own server has it (a Joint Channel by its copy). A reaction
//   that comes while the item is unread joins it without a new wake: core's
//   rule for every app item (RFC 081 D7, services/appItemWakeCoalescing.ts),
//   nothing of ours.
// - When: on an add, one notice per (message, reactor, emoji). The same
//   reaction added again within REACTION_NOTICE_READD_WINDOW_MS of its notice
//   adds none (toggling tells the agent once). A removal sends nothing and
//   takes that reaction's unread notice back; the item goes with its last
//   unread notice, so an agent is never left a row for reactions that were
//   all removed before it read.
// - Switch: `agent_reaction_notices_v0` on the agent's server, and only where
//   inbox items are on for it (elsewhere every notice would be its own wake).
//   Off: nothing is queued or taken back, and the delivery guard below stops
//   what was queued before.
//
// No table of ours: what is unread is the agent event queue's own state
// (core's notice outbox), and what is on a message now is core's reactions.
//
// Three steps, as core runs them for every app that hears of reactions
// (platform/apps FirstPartyApp.messageReactions), none of which can fail the
// reaction:
// 1. prepareReactionNotice, before the reaction's transaction opens: every
//    read (the flag, inbox items, where the message is for its author, the
//    reactor's handle), with no transaction open and nothing locked. With the
//    flag off for the author's server it answers nothing, and nothing of ours
//    runs in the transaction.
// 2. The write it answers, inside the transaction, in a savepoint of its
//    own: only the outbox's queue or withdrawUnread, through the executor it
//    is handed. So a notice exists exactly when its reaction committed, and a
//    removal takes its notice back or neither happens. It reads nothing
//    itself (core refuses any other use of the database there).
// 3. The push, after the commit; a failed one leaves the notice queued for
//    the agent's next pull.
import {
  AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY,
  REACTION_NOTICE_EXCERPT_MAX_CHARS,
  REACTION_NOTICE_KIND,
  REACTION_NOTICE_READD_WINDOW_MS,
  REACTION_NOTICE_TTL_MS,
  formatReactionNoticeSummary,
  reactionNoticeExcerpt,
  reactionNoticeObjectRef,
  type ReactionAgentNotice,
  type ServerId,
} from "@botiverse/raft-shared";
import { actorKey, actorNames, agentServers } from "../../platform/actors";
import type { AppActor, AppMessageReactionContext, AppMessageReactionRequest, AppMessageReactionWrite, AppNoticeEvent } from "../../platform/apps";
import { agentConversationTargets, localConversationIds, topLevelConversationOf } from "../../platform/conversations";
import { agentInboxItemsEnabled, appEnabled, appEnabledOnCached } from "../../platform/flags";
import { messageSource } from "../../platform/messages";

/** The notice of one reaction within its message's item: who reacted with which emoji (the outbox's `key`). */
export function reactionNoticeKey(reactor: AppActor, emoji: string): string {
  return `${reactor.type}:${reactor.id}:${emoji}`;
}

/** Whether reaction notices are on for a server: its flag, and inbox items (the flag does nothing without them). Read now, never cached: what the delivery guard decides by. */
export async function reactionNoticesOn(serverId: ServerId): Promise<boolean> {
  if (!await appEnabled(serverId, AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY)) return false;
  return agentInboxItemsEnabled(serverId);
}

/**
 * The check every reaction to an agent's message makes (prepareReactionNotice).
 * First the flag through the process's short flag cache, so with it off a
 * reaction costs no flag query (one read per server per cache lifetime; the
 * change notifier forgets it when the flag changes). A cached "off" only
 * skips: it may be that far behind a change the notifier misses, a notice
 * fewer for that long. A cached "on" decides nothing: the flag and inbox
 * items are then read themselves, so no notice is written on a stale answer.
 */
async function reactionNoticesOnForReaction(serverId: ServerId): Promise<boolean> {
  const [maybeOn] = await appEnabledOnCached([serverId], AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY);
  return maybeOn === true && await reactionNoticesOn(serverId);
}

/**
 * Where a message is for the agent that sent it: the conversation as its own
 * server has it, how the agent addresses it now, and where a reply about the
 * message goes (a top-level message's own thread; for a reply already in a
 * thread or a task conversation, that conversation). Null when the agent
 * can no longer open it.
 */
async function authorConversation(
  agent: { agentId: string; serverId: ServerId },
  message: AppMessageReactionRequest["message"],
): Promise<{ conversationId: string; target: string; replyTarget: string } | null> {
  const local = (await localConversationIds(agent.serverId, [message.channelId])).get(message.channelId);
  if (local === message.channelId) {
    // A conversation of the agent's own server, a thread or a task conversation included.
    const target = (await agentConversationTargets(agent, [local])).get(local);
    if (!target) return null;
    const topLevel = await topLevelConversationOf(agent.serverId, local);
    return { conversationId: local, target, replyTarget: topLevel?.conversationId === local ? `${target}:${message.id.slice(0, 8)}` : target };
  }
  // A Joint Channel's message is stored once, outside every server: the agent
  // reads it through its own server's copy (core's rule for one message).
  const source = await messageSource({ type: "agent", id: agent.agentId, serverId: agent.serverId }, message.id);
  if (!source) return null;
  const channel = (await agentConversationTargets(agent, [source.conversationId])).get(source.conversationId);
  if (!channel) return null;
  const thread = source.threadRootId ? `${channel}:${source.threadRootId.slice(0, 8)}` : null;
  return { conversationId: source.conversationId, target: thread ?? channel, replyTarget: thread ?? `${channel}:${message.id.slice(0, 8)}` };
}

/**
 * What a reaction would write (FirstPartyApp.messageReactions.prepare), asked
 * before its transaction opens: nothing unless the message is an agent's,
 * the reactor someone else, and reaction notices are on for the author's
 * server. Every read is here. The write it answers runs in the reaction's
 * transaction and only calls the outbox with the executor it is handed: the
 * author's notice queued for an add, the reaction's unread notice taken back
 * for a removal; it returns the push for after the commit.
 */
export async function prepareReactionNotice(
  request: AppMessageReactionRequest,
  { noticeOutbox }: AppMessageReactionContext,
): Promise<AppMessageReactionWrite | void> {
  // Nothing read yet: a person's message, or the author's own reaction, costs nothing.
  const author = request.message.author;
  if (!author || author.type !== "agent") return;
  if (request.reactor.type === "agent" && request.reactor.id === author.id) return;
  // The author's own server (one read by primary key), then its flag (from memory, see above).
  const serverId = (await agentServers([author.id])).get(author.id);
  if (!serverId || !await reactionNoticesOnForReaction(serverId)) return;

  const objectRef = reactionNoticeObjectRef(request.message.id);
  const key = reactionNoticeKey(request.reactor, request.emoji);
  if (request.operation === "remove") {
    return async ({ executor, at }) => {
      const { pushEventId } = await noticeOutbox.withdrawUnread(executor, { agentId: author.id, objectRef, key, now: at });
      return pushEventId ? () => noticeOutbox.push(pushEventId) : undefined;
    };
  }

  // The conversation as the author addresses it now; one it can no longer open tells it nothing.
  const where = await authorConversation({ agentId: author.id, serverId }, request.message);
  if (!where) return;
  const reactorName = (await actorNames([request.reactor])).get(actorKey(request.reactor))
    ?? (request.reactor.type === "agent" ? "an agent" : "someone");
  const { excerpt, truncated } = reactionNoticeExcerpt(request.message.content, REACTION_NOTICE_EXCERPT_MAX_CHARS);
  return async ({ executor, at }) => {
    const notice: ReactionAgentNotice = {
      message: { id: request.message.id, channelId: where.conversationId, conversation: where.target, replyTarget: where.replyTarget, excerpt, excerptTruncated: truncated },
      reactor: { id: request.reactor.id, kind: request.reactor.type === "agent" ? "agent" : "human", name: reactorName },
      emoji: request.emoji,
      reactedAt: at.toISOString(),
    };
    const { eventId } = await noticeOutbox.queue(executor, {
      serverId,
      agentId: author.id,
      summary: formatReactionNoticeSummary(notice),
      kind: REACTION_NOTICE_KIND,
      event: notice,
      ttlMs: REACTION_NOTICE_TTL_MS,
      now: at,
      objectRef,
      relatedChannelId: where.conversationId,
      key,
      // Removed and added again soon after: the notice it already has (unread again if it was taken back), never a second.
      onceWithinMs: REACTION_NOTICE_READD_WINDOW_MS,
    });
    // Core pushes nothing for a notice that joined an unread item, or that was already pushed once.
    return () => noticeOutbox.push(eventId);
  };
}

/** The conversation a queued notice is about, as the agent's server has it, from its payload (`app_event.message.channelId`). */
function noticeChannelId(payload: Record<string, unknown>): string | null {
  const body = payload.app_event;
  if (typeof body !== "object" || body === null) return null;
  const message = (body as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const channelId = (message as { channelId?: unknown }).channelId;
  return typeof channelId === "string" && channelId.length > 0 ? channelId : null;
}

/**
 * The delivery guard (agentNotice.deliverable), run by core before every
 * hand-over, listing or re-read of a notice: only while reaction notices are
 * on for the agent's server and the agent can still open the message's
 * conversation (the notice names the reactor and quotes the message). One
 * flag answer per server and one access check per agent's conversations,
 * however many notices.
 */
export async function reactionNoticeDeliveryVerdicts(events: readonly AppNoticeEvent[]): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  // Each agent's own server (a notice is queued on it): none for an agent that is gone.
  const servers = await agentServers(events.map((event) => event.agentId));
  const on = new Map<ServerId, boolean>();
  const byAgent = new Map<string, { serverId: ServerId; events: Array<{ id: string; channelId: string }> }>();
  for (const event of events) {
    const serverId = servers.get(event.agentId);
    if (serverId && !on.has(serverId)) on.set(serverId, await reactionNoticesOn(serverId));
    const channelId = noticeChannelId(event.payload);
    if (!serverId || !on.get(serverId) || !channelId) {
      verdicts.set(event.id, false);
      continue;
    }
    const group = byAgent.get(event.agentId) ?? { serverId, events: [] };
    group.events.push({ id: event.id, channelId });
    byAgent.set(event.agentId, group);
  }
  for (const [agentId, group] of byAgent) {
    const open = await agentConversationTargets({ agentId, serverId: group.serverId }, [...new Set(group.events.map((event) => event.channelId))]);
    for (const event of group.events) verdicts.set(event.id, open.has(event.channelId));
  }
  return verdicts;
}
