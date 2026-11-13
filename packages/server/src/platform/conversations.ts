// Platform entry point: conversations as an app's object homes. Resolving an
// agent's `target` to a top-level conversation it can see and the home an
// object put there names, a conversation id (a thread's: its parent) to the
// top-level conversation it is part of, a conversation id to one a person
// can see now, or may post in now (and the home it names), the agent-facing target of a
// conversation (`#channel`, `dm:@peer`), a conversation's name as a person
// sees it (a DM by its peer), its members (and whether one actor is on its
// roster), and whether guests are in it or may read it. A
// home in a joint channel is the joint's canonical channel, never a server's
// projection of it; each server names it by its own projection
// (services/visibilityService jointHomeProjections). The target grammar, DM
// peers, guests' access and channel access are core's
// (services/channelService).
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isGuestRole, type ServerId, type ServerRole } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelHumans, channels, serverMembers } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import * as channelService from "../services/channelService";
import { AGENT_LOUNGE_OUTSIDER_REFUSAL, isLoungeOutsiderAgent } from "../services/agentLoungeService";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { renderRelatedTargets } from "../services/agentInboxItems";
import { isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService";
import { canView, jointHomeProjections, jointHomeRecords, type VisibleRootType } from "../services/visibilityService";

/** The top-level conversation types an object may be homed in. */
export type ConversationType = VisibleRootType;

const CONVERSATION_TYPES: ReadonlySet<string> = new Set<ConversationType>(["channel", "private", "dm", "joint"]);

/** An agent acting in its server. */
export interface ConversationAgent {
  agentId: string;
  serverId: ServerId;
}

/** A person reading in a server. */
export interface ConversationReader {
  userId: string;
  serverId: ServerId;
}

/** A `target` resolved to a top-level conversation; a thread target names its parent. */
export interface ResolvedConversationTarget {
  /** The conversation, as the agent's server has it (a joint by the server's projection). */
  conversationId: string;
  /**
   * The home an object put in this conversation names: the conversation
   * itself, or for a joint projection the joint's canonical channel, so that
   * the object is the joint's on every server in it.
   */
  homeChannelId: string;
  /** The conversation's own target (`#channel`, `dm:@peer`), without a thread suffix. */
  target: string;
  /** The thread's short id when the target was a thread. */
  homeFromThread: string | null;
}

/**
 * A conversation target: `#channel`, `dm:@peer`, or a thread target
 * (`#channel:<shortid>`, `dm:@peer:<shortid>`), which names its parent
 * conversation; `homeFromThread` keeps the thread's short id. Null when the
 * agent can't see the conversation, or the target is malformed or names an
 * ambiguous DM peer. The thread itself is not looked up: the suffix only says
 * the target came from a thread.
 */
/** Why an agent may not put something in another agent's lounge (the apps' refusal text). */
export const AGENT_LOUNGE_PLACEMENT_REFUSAL = AGENT_LOUNGE_OUTSIDER_REFUSAL;

/**
 * Whether an agent may put an object in a conversation (an Artifact homed
 * there, say): not in another agent's lounge (#proj-chat:#15), which other
 * agents may read but never take part in. A thread or task conversation
 * answers as the conversation it hangs under.
 */
export async function agentMayPlaceInConversation(conversationId: string, agentId: string): Promise<boolean> {
  return !await isLoungeOutsiderAgent(conversationId, agentId);
}

export async function resolveConversationTarget(agent: ConversationAgent, target: string): Promise<ResolvedConversationTarget | null> {
  const { baseRef, threadShortId } = channelService.parseChannelRef(target.trim());
  let resolved: Awaited<ReturnType<typeof channelService.resolveChannelByName>>;
  try {
    resolved = await channelService.resolveChannelByName(agent.serverId, agent.agentId, baseRef);
  } catch (error) {
    // An ambiguous or malformed DM peer is not a conversation the agent can name.
    if (error instanceof DmTargetResolutionError) return null;
    throw error;
  }
  if (!resolved || resolved.type === "thread") return null;
  const access = resolved.type === "joint" ? await channelService.resolveChannelAccess({ serverId: agent.serverId, channelId: resolved.channelId }) : null;
  if (resolved.type === "joint" && access?.kind !== "joint") return null;
  return { conversationId: resolved.channelId, homeChannelId: access?.canonicalChannelId ?? resolved.channelId, target: baseRef, homeFromThread: threadShortId };
}

/**
 * Homes (conversation ids an object names) as conversations of `serverId`:
 * the server's own conversations as they are, a joint's canonical channel,
 * or another server's projection of a joint (a home named before publish
 * stored the canonical channel, or a channel converted since), as the
 * server's active projection of it (jointHomeProjections); absent for
 * anything else. In one query, plus two when some id is not the server's.
 */
export async function localConversationIds(serverId: ServerId, homeChannelIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(homeChannelIds)];
  if (ids.length === 0) return new Map();
  const own = await getDb().select({ id: channels.id }).from(channels).where(and(inArray(channels.id, ids), eq(channels.serverId, serverId)));
  const local = new Map(own.map((row) => [row.id, row.id]));
  const others = ids.filter((id) => !local.has(id));
  if (others.length > 0) {
    // Another server's projection names the joint's canonical channel.
    const canonicalOf = new Map((await jointHomeRecords("any", { localChannelIds: others })).map((record) => [record.localChannelId, record.canonicalChannelId]));
    const canonicalIds = [...new Set(others.map((id) => canonicalOf.get(id) ?? id))];
    const projectionOf = new Map((await jointHomeProjections([serverId], { canonicalChannelIds: canonicalIds })).map((projection) => [projection.canonicalChannelId, projection.localChannelId]));
    for (const id of others) {
      const projection = projectionOf.get(canonicalOf.get(id) ?? id);
      if (projection) local.set(id, projection);
    }
  }
  return local;
}

/**
 * Id, type and agent-facing target of homes as conversations of the agent's
 * server (localConversationIds: a joint's canonical channel by the server's
 * projection), for this agent (a DM by `dm:@peer` as the agent names it,
 * null when it can't); absent for a deleted channel, another server's, or
 * one that is not a top-level conversation.
 */
export async function agentConversationRefs(
  agent: ConversationAgent,
  homeChannelIds: readonly string[],
): Promise<Map<string, { id: string; type: ConversationType; target: string | null }>> {
  const local = await localConversationIds(agent.serverId, homeChannelIds);
  const rows = local.size === 0 ? [] : await getDb().select({ id: channels.id, name: channels.name, type: channels.type }).from(channels).where(and(
    inArray(channels.id, [...new Set(local.values())]),
    eq(channels.serverId, agent.serverId),
    isNull(channels.deletedAt),
  ));
  const dmRefs = await channelService.resolveAgentFacingDmRefs(
    agent.serverId,
    agent.agentId,
    rows.filter((row) => row.type === "dm").map((row) => row.id),
  );
  const byId = new Map<string, { id: string; type: ConversationType; target: string | null }>();
  for (const row of rows) {
    if (!CONVERSATION_TYPES.has(row.type)) continue;
    const type = row.type as ConversationType;
    byId.set(row.id, { id: row.id, type, target: type === "dm" ? dmRefs.get(row.id) ?? null : `#${row.name}` });
  }
  return homeRefs(local, byId);
}

/**
 * How the agent addresses each of these conversations now, by conversation
 * id, for the ones it can open (absent otherwise): sub-conversations too, a
 * thread as `<parent>:<msg8>` and a task conversation as `<board>:#<n>`.
 * The names an agent's inbox shows a notice's related conversation by
 * (services/agentInboxItems renderRelatedTargets), so a notice that names
 * its conversation and the inbox row agree, and the check an app's delivery
 * guard needs for a notice about a conversation.
 */
export function agentConversationTargets(agent: ConversationAgent, conversationIds: readonly string[]): Promise<Map<string, string>> {
  return renderRelatedTargets(agent.serverId, agent.agentId, conversationIds);
}

/** Each home's entry, by the conversation it is on the server. */
function homeRefs<T>(local: ReadonlyMap<string, string>, byId: ReadonlyMap<string, T>): Map<string, T> {
  const refs = new Map<string, T>();
  for (const [home, id] of local) {
    const ref = byId.get(id);
    if (ref) refs.set(home, ref);
  }
  return refs;
}

/** A home as the reader names it; a DM also carries its peer's display name, as the sidebar labels it, and who the peer is. */
export type ConversationName = { id: string; name: string; type: ConversationType; peerDisplayName?: string; peer?: { type: "user" | "agent"; id: string } };

/**
 * Id, name and type of homes as conversations of the reader's server
 * (localConversationIds: a joint's canonical channel by the server's
 * projection) as the reader sees them (a DM by its peer's name, every DM in
 * one batch), deleted ones of the server included; absent for another
 * server's, or one that is not a top-level conversation.
 */
export async function conversationNames(
  reader: ConversationReader,
  homeChannelIds: readonly string[],
): Promise<Map<string, ConversationName>> {
  const local = await localConversationIds(reader.serverId, homeChannelIds);
  const rows = local.size === 0 ? [] : await getDb().select({ id: channels.id, name: channels.name, type: channels.type }).from(channels)
    .where(and(inArray(channels.id, [...new Set(local.values())]), eq(channels.serverId, reader.serverId)));
  const peers = await channelService.getReadableDMPeersForUser(rows.filter((row) => row.type === "dm").map((row) => row.id), reader.userId);
  const byId = new Map<string, ConversationName>();
  for (const row of rows) {
    if (!CONVERSATION_TYPES.has(row.type)) continue;
    const type = row.type as ConversationType;
    const peer = type === "dm" ? peers.get(row.id) : undefined;
    byId.set(row.id, { id: row.id, name: peer?.name ?? row.name, type, ...(peer?.displayName ? { peerDisplayName: peer.displayName } : {}), ...(peer ? { peer: { type: peer.type, id: peer.id } } : {}) });
  }
  return homeRefs(local, byId);
}

/**
 * The top-level conversation a conversation id of `serverId` is part of, and
 * its type: a channel, private channel, DM or joint projection is its own; a
 * thread or task conversation is its parent's (`parent_channel_id`). Null
 * when it isn't a live conversation of that server, or a sub-conversation
 * without a live top-level parent there. Says nothing about who may see it:
 * the caller checks that (platform/visibility canViewHomes).
 */
export async function topLevelConversationOf(
  serverId: ServerId,
  channelId: string,
): Promise<{ conversationId: string; type: ConversationType } | null> {
  type Row = { id: string; type: string; parentChannelId: string | null };
  const row = async (id: string): Promise<Row | null> => {
    const [found] = await getDb().select({ id: channels.id, type: channels.type, parentChannelId: channels.parentChannelId }).from(channels)
      .where(and(eq(channels.id, id), eq(channels.serverId, serverId), isNull(channels.deletedAt))).limit(1);
    return found ?? null;
  };
  let conversation = await row(channelId);
  if (conversation && !CONVERSATION_TYPES.has(conversation.type)) {
    conversation = conversation.parentChannelId ? await row(conversation.parentChannelId) : null;
  }
  if (!conversation || !CONVERSATION_TYPES.has(conversation.type)) return null;
  return { conversationId: conversation.id, type: conversation.type as ConversationType };
}

/** A conversation a person can see now, and the home an object put there names. */
export interface ReadableConversation {
  /** The top-level conversation, as the reader's server has it (a joint by the server's projection). */
  conversationId: string;
  type: ConversationType;
  /** The conversation itself, or for a joint projection the joint's canonical channel (as ResolvedConversationTarget). */
  homeChannelId: string;
}

/**
 * Of live top-level conversations of the reader's server, those the reader
 * can see now, by core's channel access (visibilityService canView, as
 * conversationMembers checks it), with the home an object put there names:
 * for a joint projection the joint's canonical channel
 * (channelService resolveChannelAccessMany, as resolveConversationTarget has
 * it); a joint projection with no active joint isn't one. The one rule of
 * readableConversation and readableConversations, in a constant number of
 * queries however many are asked.
 */
async function readableOf(reader: ConversationReader, conversations: ReadonlyArray<{ conversationId: string; type: ConversationType }>): Promise<ReadableConversation[]> {
  const visible = await canView({ type: "user", id: reader.userId, serverId: reader.serverId }, conversations.map(({ conversationId }) => ({ kind: "conversation", channelId: conversationId })));
  const seen = conversations.filter((_, index) => visible[index]);
  const access = await channelService.resolveChannelAccessMany({ serverId: reader.serverId, channelIds: seen.filter(({ type }) => type === "joint").map(({ conversationId }) => conversationId) });
  return seen.flatMap((conversation) => {
    if (conversation.type !== "joint") return [{ ...conversation, homeChannelId: conversation.conversationId }];
    const joint = access.get(conversation.conversationId);
    return joint?.kind === "joint" ? [{ ...conversation, homeChannelId: joint.canonicalChannelId }] : [];
  });
}

/**
 * A conversation id of the reader's server (a thread's or task's: its
 * parent, topLevelConversationOf) as a conversation the reader can see now,
 * and the home an object put there names (readableOf). Null when it isn't a
 * live conversation of that server, the reader can't see it, or a joint
 * projection has no active joint (and for an id that isn't one): one answer
 * for every reason.
 */
export async function readableConversation(reader: ConversationReader, channelId: string): Promise<ReadableConversation | null> {
  if (!UUID_RE.test(channelId)) return null;
  const conversation = await topLevelConversationOf(reader.serverId, channelId);
  if (!conversation) return null;
  const [readable] = await readableOf(reader, [conversation]);
  return readable ?? null;
}

/**
 * A top-level conversation of the reader's server the person may post in now,
 * and the home an object put there names (a joint projection: the joint's
 * canonical channel, as readableOf). The rule core's own send makes for that
 * person (routes/messages.ts createHumanMessage), the one an app's message
 * as the reader is held to (services/firstPartyAppMessages postMessageAsReader):
 * a live conversation of that server, not a thread or task (a thread is named
 * by its root, never as a place), that the person can read
 * (canUserAccessChannel) and post to (canUserPostToChannel), not archived and
 * not read-only by the plan. Null for every other case (and for an id that
 * isn't one): one answer for every reason.
 */
export async function postableConversation(reader: ConversationReader, conversationId: string): Promise<ReadableConversation | null> {
  if (!UUID_RE.test(conversationId)) return null;
  const channel = await channelService.getChannel(conversationId);
  if (!channel || channel.serverId !== reader.serverId || channel.deletedAt || !CONVERSATION_TYPES.has(channel.type)) return null;
  if (!await channelService.canUserAccessChannel(channel.id, reader.userId, reader.serverId)) return null;
  if (!await channelService.canUserPostToChannel(channel.id, reader.userId)) return null;
  if (channel.archivedAt) return null;
  if (await isChannelReadOnlyByBillingFeature(channel.id, reader.serverId) || await isChannelReadOnlyByQuota(channel.id, reader.serverId)) return null;
  const type = channel.type as ConversationType;
  if (type !== "joint") return { conversationId: channel.id, type, homeChannelId: channel.id };
  const access = await channelService.resolveChannelAccess({ serverId: reader.serverId, channelId: channel.id });
  return access?.kind === "joint" ? { conversationId: channel.id, type, homeChannelId: access.canonicalChannelId } : null;
}

/**
 * readableConversation for many top-level conversation ids of the reader's
 * server, in a constant number of queries: those it would answer for, by id.
 * An id that isn't a live top-level conversation of that server is absent, a
 * thread's or task's too: a list of homes names no thread, so there is no
 * parent to walk to.
 */
export async function readableConversations(reader: ConversationReader, conversationIds: readonly string[]): Promise<Map<string, ReadableConversation>> {
  const ids = [...new Set(conversationIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({ id: channels.id, type: channels.type }).from(channels)
    .where(and(inArray(channels.id, ids), eq(channels.serverId, reader.serverId), isNull(channels.deletedAt)));
  const conversations = rows.flatMap((row) => (CONVERSATION_TYPES.has(row.type) ? [{ conversationId: row.id, type: row.type as ConversationType }] : []));
  return new Map((await readableOf(reader, conversations)).map((conversation) => [conversation.conversationId, conversation]));
}

/**
 * Whether guests of `serverId` are in a top-level conversation of it:
 * `guest_members` when one of its people is a guest of the server, else null.
 * A guest reads only the one channel it belongs to (#wg-rbac:#15), so no
 * conversation is open to guests without them being in it; the
 * `open_to_guests` answer is kept in the type for callers and is never given.
 */
export async function conversationGuestAccess(
  serverId: ServerId,
  conversationId: string,
): Promise<"guest_members" | "open_to_guests" | null> {
  const [guest] = await getDb().select({ userId: channelHumans.userId }).from(channelHumans)
    .innerJoin(serverMembers, and(eq(serverMembers.userId, channelHumans.userId), eq(serverMembers.serverId, serverId), eq(serverMembers.role, "guest")))
    .where(eq(channelHumans.channelId, conversationId)).limit(1);
  return guest ? "guest_members" : null;
}

/**
 * Whether a person or agent is a member of a top-level conversation (on its
 * roster: channelService getChannelMembers, so a joint channel's from every
 * server, `#all` the server's audience), not merely one who may read it (a
 * public channel is read by every member and agent of its server without
 * joining). Asks nothing about whether the conversation is live or whose it
 * is: the caller has resolved it (topLevelConversationOf).
 */
export async function isConversationMember(conversationId: string, actor: { type: "user" | "agent"; id: string }): Promise<boolean> {
  const roster = await channelService.getChannelMembers(conversationId, actor.type === "user" ? { userIds: [actor.id], agentIds: [] } : { userIds: [], agentIds: [actor.id] });
  return actor.type === "user" ? roster.humans.some((human) => human.id === actor.id) : roster.agents.some((agent) => agent.id === actor.id);
}

/** A member of a conversation: a person (with whether they are a guest of the server they take part through) or an agent. */
export interface ConversationMember {
  type: "user" | "agent";
  id: string;
  /** The server they take part through (a joint channel's: their own server's projection; the reader's when in several). */
  serverId: ServerId;
  guest: boolean;
}

/**
 * The members of a top-level conversation of the reader's server that the
 * reader can see: its people and agents (channelService getChannelMembers: a
 * joint channel's from every server, `#all` the server's audience), people
 * first, each once. Null when the conversation doesn't exist, is deleted,
 * another server's, a thread, or one the reader can't see (and for an id
 * that isn't one).
 */
export async function conversationMembers(reader: ConversationReader, conversationId: string): Promise<ConversationMember[] | null> {
  if (!(await seesTopLevelConversation(reader, conversationId))) return null;
  return wholeRoster(conversationId, reader.serverId);
}

/** Whether `conversationId` is a live top-level conversation of the reader's server that the reader can see (conversationMembers' rule). */
async function seesTopLevelConversation(reader: ConversationReader, conversationId: string): Promise<boolean> {
  if (!UUID_RE.test(conversationId)) return false;
  const [row] = await getDb().select({ id: channels.id, type: channels.type, serverId: channels.serverId, deletedAt: channels.deletedAt })
    .from(channels).where(eq(channels.id, conversationId)).limit(1);
  if (!row || row.serverId !== reader.serverId || row.deletedAt !== null || !CONVERSATION_TYPES.has(row.type)) return false;
  const [visible] = await canView({ type: "user", id: reader.userId, serverId: reader.serverId }, [{ kind: "conversation", channelId: row.id }]);
  return visible === true;
}

/** A conversation's roster a page at a time (channelService getChannelMemberPager). */
export type ConversationMemberPages = channelService.ChannelMemberPager;

/**
 * The members of a top-level conversation the reader can see, as
 * conversationMembers has them, read a page at a time where core can
 * (channelService getChannelMemberPager: a channel, private channel, DM or
 * `#all`): `pages`, each person with their server role there; else (a joint
 * channel) the whole roster, `members`. Null when conversationMembers is.
 */
export async function conversationRoster(
  reader: ConversationReader,
  conversationId: string,
): Promise<{ pages: ConversationMemberPages } | { members: ConversationMember[] } | null> {
  if (!(await seesTopLevelConversation(reader, conversationId))) return null;
  const pages = await channelService.getChannelMemberPager(conversationId);
  return pages ? { pages } : { members: await wholeRoster(conversationId, reader.serverId) };
}

async function wholeRoster(conversationId: string, viewedServerId: string): Promise<ConversationMember[]> {
  const roster = await channelService.getChannelMembers(conversationId);
  const members = new Map<string, ConversationMember>();
  for (const human of roster.humans) {
    // A joint roster's person (computed membership): a member of the viewed
    // server takes part through it, anyone else through their first other
    // source; one with neither has no server to stand in and is left out.
    const serverId = human.inViewerServer ? viewedServerId : human.serverId;
    if (!serverId) continue;
    if (!members.has(`user:${human.id}`)) members.set(`user:${human.id}`, { type: "user", id: human.id, serverId: serverId as ServerId, guest: isGuestRole(human.role as ServerRole | null) });
  }
  for (const agent of roster.agents) {
    if (!members.has(`agent:${agent.id}`)) members.set(`agent:${agent.id}`, { type: "agent", id: agent.id, serverId: agent.serverId as ServerId, guest: false });
  }
  return [...members.values()];
}
