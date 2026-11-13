// Platform entry point: who a person may @-mention in an audience (a
// conversation, or a first-party app's object by its home), the one rule
// behind core's POST /api/mentions/audience (routes/mentions.ts; shared
// mentionAudienceContract.ts) for every picker:
//
// 1. The reader must see the audience; otherwise null (the route's one 404,
//    the same as an unknown audience).
// 2. Candidates are those who can see the audience, and of them only whom core
//    shows the reader (platform/actors actorsShownToPerson: a guest, whom it
//    meets; a member of a server that hides its people, whom it shares a
//    conversation with):
//    - a conversation (a thread: its parent; platform/conversations
//      topLevelConversationOf): its members (conversationMembers). A joint
//      channel's are every server's in it: another server's people and agents
//      are shown to whoever sees the channel, as its roster
//      (GET /api/channels/:id/members) shows them, without their roles (no
//      guest marker); the reader's own server's go through
//      actorsShownToPerson.
//    - an object: the people and live agents of its server who can see its
//      current home (the kind's registered `homes`, platform/visibility
//      viewersOfHome with requireStanding), and, when that home is a joint
//      channel, the joint's other servers' people and agents as the joint's
//      own audience has them (its roster, shown as it shows them, without
//      roles), each only while they can see the object now (through their
//      own server's projection) and their server has the app on
//      (jointObjectPeers; never anyone outside the object's server for any
//      other home). Only an object of the reader's server, whose app is on
//      there (a soft-deleted server is off).
// 3. Members of the conversation (an object's home conversation, a joint's
//    from every server) first, people before agents, then by handle; at most
//    `limit`, `capped` when more match. `q` matches handles and display names
//    as mentionCandidates does.
//
// The list is no permission: whoever sends checks each mention again. Read
// in the database up to the cap, not whole: an object's directory as
// mentionCandidates pages it (at most MENTION_AUDIENCE_POOL_MAX); a
// conversation's members a page of `limit + 1` of each kind (by handle in
// the database, then in the order above), a reader shown fewer than all of
// them reading on in growing pages until it has enough (a joint channel's,
// whose roster merges every server's projection, are read whole, and so is
// an object's joint home's). A constant number of queries however many
// people, for a reader shown everyone.
// Nothing is cached: a narrowed home applies to the next call.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isGuestRole, type MentionAudienceActor, type MentionAudienceCandidates, type ServerId, type ServerRole } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, serverMembers, users } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { actorKey, actorsShownToPerson, likeContaining, mentionCandidates, type ActorRef } from "./actors";
import type { AppObjectHome, AppObjectKind, FirstPartyApp } from "./apps";
import {
  conversationMembers,
  conversationRoster,
  localConversationIds,
  topLevelConversationOf,
  type ConversationMember,
  type ConversationMemberPages,
} from "./conversations";
import { appEnabledOnLiveServers } from "./flags";
import { canViewHomes, homeOf, jointViewersOf, seenThroughJoint, viewersOfHome } from "./visibility";

/** A person reading in a server. */
export interface MentionReader {
  userId: string;
  serverId: ServerId;
}

/** A registered object kind and its app (apps/firstPartyApps.ts registeredObjectKind), as far as audiences read it. */
export interface MentionableObjectKind {
  app: Pick<FirstPartyApp, "id" | "flag">;
  objectKind: Pick<AppObjectKind, "kind" | "homes">;
}

/** An audience the caller has resolved: a conversation id of the reader's server, or an object of a registered kind. */
export type MentionAudienceTarget =
  | { kind: "conversation"; channelId: string }
  | { kind: "object"; registered: MentionableObjectKind; objectId: string };

/**
 * How many of an object's server's directory are checked before the cap (the
 * directory's order: its home's members first). Beyond it a very large server
 * offers the first ones and reports `capped`.
 */
export const MENTION_AUDIENCE_POOL_MAX = 5000;

/**
 * Who the reader may mention in `target`, matching `q` (already trimmed and
 * cut), at most `limit`; null when the reader can't see it (or it doesn't
 * exist: the same answer).
 */
export async function mentionAudience(
  reader: MentionReader,
  target: MentionAudienceTarget,
  input: { q: string; limit: number },
): Promise<MentionAudienceCandidates | null> {
  return target.kind === "conversation"
    ? conversationAudience(reader, target.channelId, input)
    : objectAudience(reader, target.registered, target.objectId, input);
}

type Row = { type: ActorRef["type"]; id: string; name: string; displayName: string; avatarUrl: string | null };

const byPeopleThenHandle = (a: Pick<Row, "type" | "name">, b: Pick<Row, "type" | "name">) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "user" ? -1 : 1);

const candidate = (row: Row, guest: boolean): MentionAudienceActor => ({
  type: row.type, id: row.id, name: row.name, displayName: row.displayName, avatarUrl: row.avatarUrl, guest,
});

/**
 * Profiles of these people (not retired) and live agents whose handle or
 * display name contains `q` (mentionCandidates' match), in two queries.
 */
async function matchingRows(actors: readonly ActorRef[], q: string): Promise<Row[]> {
  const userIds = [...new Set(actors.filter((actor) => actor.type === "user").map((actor) => actor.id))];
  const agentIds = [...new Set(actors.filter((actor) => actor.type === "agent").map((actor) => actor.id))];
  const pattern = likeContaining(q);
  const db = getDb();
  const [people, agentRows] = await Promise.all([
    userIds.length === 0 ? [] : db.select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users)
      .where(and(inArray(users.id, userIds), isNull(users.retiredAt), sql`(${users.name} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`)),
    agentIds.length === 0 ? [] : db.select({ id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl }).from(agents)
      .where(and(inArray(agents.id, agentIds), isNull(agents.deletedAt), sql`(${agents.name} ILIKE ${pattern} OR ${agents.displayName} ILIKE ${pattern})`)),
  ]);
  const row = (type: ActorRef["type"]) => (found: { id: string; name: string; displayName: string | null; avatarUrl: string | null }): Row =>
    ({ type, id: found.id, name: found.name, displayName: found.displayName || found.name, avatarUrl: found.avatarUrl });
  return [...people.map(row("user")), ...agentRows.map(row("agent"))];
}

/** The candidates in order, cut to `limit`, with whether more were left. */
function capped(rows: readonly MentionAudienceActor[], limit: number): MentionAudienceCandidates {
  return { candidates: rows.slice(0, limit), capped: rows.length > limit };
}

async function conversationAudience(reader: MentionReader, channelId: string, input: { q: string; limit: number }): Promise<MentionAudienceCandidates | null> {
  if (!UUID_RE.test(channelId)) return null;
  const top = await topLevelConversationOf(reader.serverId, channelId);
  if (!top) return null;
  // Null also when the reader can't see it.
  const roster = await conversationRoster(reader, top.conversationId);
  if (!roster) return null;
  if ("members" in roster) return wholeConversationAudience(reader, roster.members, input);
  // People first, then agents only while the people leave room under the cap.
  const pattern = likeContaining(input.q);
  const people = await firstShown(reader, "user", roster.pages, pattern, input.limit + 1);
  const agentRows = people.length > input.limit ? [] : await firstShown(reader, "agent", roster.pages, pattern, input.limit + 1 - people.length);
  return capped([...people, ...agentRows].sort(byPeopleThenHandle).map((row) => candidate(row, row.serverId === reader.serverId && isGuestRole(row.role as ServerRole | null))), input.limit);
}

type PagedRow = Row & { serverId: string; role: string | null };

/** The largest page firstShown reads at once: a reader shown few of a very large conversation reads it in pages of at most this. */
const ROSTER_PAGE_MAX = 1000;

/**
 * The first `want` of a conversation's people or agents (by handle) matching
 * `pattern` that the reader may be shown: its own server's as core shows
 * them to the reader (actorsShownToPerson), another server's as they are.
 * One page of `want` for a reader shown everyone; a reader shown fewer reads
 * on, in growing pages, until it has `want` or the roster ends.
 */
async function firstShown(
  reader: MentionReader,
  type: ActorRef["type"],
  pages: ConversationMemberPages,
  pattern: string,
  want: number,
): Promise<PagedRow[]> {
  const kept: PagedRow[] = [];
  let after: { name: string; id: string } | null = null;
  let size = want;
  for (;;) {
    const page: Parameters<ConversationMemberPages["people"]>[0] = { pattern, after, limit: size };
    const found = await (type === "user" ? pages.people(page) : pages.agents(page));
    const rows = found.map((row): PagedRow => ({ type, id: row.id, name: row.name, displayName: row.displayName || row.name, avatarUrl: row.avatarUrl, serverId: row.serverId, role: row.role }));
    const local = rows.filter((row) => row.serverId === reader.serverId);
    const shown = local.length === 0 ? new Set<string>() : new Set((await actorsShownToPerson(reader.serverId, reader.userId, local, local.length)).map(actorKey));
    kept.push(...rows.filter((row) => row.serverId !== reader.serverId || shown.has(actorKey(row))));
    const last = found.at(-1);
    if (kept.length >= want || found.length < size || !last) return kept.slice(0, want);
    after = { name: last.name, id: last.id };
    size = Math.min(size * 2, Math.max(want, ROSTER_PAGE_MAX));
  }
}

/** A joint channel's audience from its whole roster (every server's projection; channelService getChannelMembers). */
async function wholeConversationAudience(reader: MentionReader, members: readonly ConversationMember[], input: { q: string; limit: number }): Promise<MentionAudienceCandidates> {
  const memberOf = new Map<string, ConversationMember>(members.map((member) => [actorKey(member), member]));
  const rows = (await matchingRows(members, input.q)).sort(byPeopleThenHandle);
  // The reader's own server's people and agents as core shows them to the
  // reader; another server's (a joint channel's) as its roster shows them,
  // to whoever sees the channel.
  const local = rows.filter((row) => memberOf.get(actorKey(row))?.serverId === reader.serverId);
  const shown = new Set((await actorsShownToPerson(reader.serverId, reader.userId, local, local.length)).map(actorKey));
  const kept = rows.filter((row) => memberOf.get(actorKey(row))?.serverId !== reader.serverId || shown.has(actorKey(row)));
  return capped(kept.slice(0, input.limit + 1).map((row) => {
    const member = memberOf.get(actorKey(row))!;
    // Another server's person carries no role (the joint roster's rule).
    return candidate(row, member.serverId === reader.serverId && member.guest);
  }), input.limit);
}

async function objectAudience(
  reader: MentionReader,
  registered: MentionableObjectKind,
  objectId: string,
  input: { q: string; limit: number },
): Promise<MentionAudienceCandidates | null> {
  const located = (await registered.objectKind.homes([objectId])).get(objectId);
  if (!located) return null;
  // Another server's object, homed in a joint the reader sees it through: the joint's roster (jointObjectAudience).
  if (located.serverId !== reader.serverId) return jointObjectAudience(reader, registered, objectId, located, input);
  // An object of the reader's server is named on by its own people, and
  // only while its app is on there.
  const [enabled] = await appEnabledOnLiveServers([reader.serverId], registered.app.flag);
  if (!enabled) return null;
  const object = { serverId: located.serverId, home: homeOf(located), author: located.author };
  const [readerSees] = await canViewHomes({ type: "user", id: reader.userId, serverId: reader.serverId }, [object]);
  if (!readerSees) return null;
  // Its home as the object's server has it (a joint by its projection there): its members first.
  const homeChannelId = located.homeKind === "conversation" && located.homeChannelId
    ? (await localConversationIds(located.serverId, [located.homeChannelId])).get(located.homeChannelId) ?? null
    : null;
  const pool = await mentionCandidates({ serverId: located.serverId, q: input.q, homeChannelId, limit: MENTION_AUDIENCE_POOL_MAX, finder: { userId: reader.userId } });
  const sees = await viewersOfHome(object, pool.map((actor) => ({ ...actor, serverId: located.serverId })), { requireStanding: true });
  const shown = await actorsShownToPerson(reader.serverId, reader.userId, pool.filter((_, index) => sees[index]), input.limit + 1);
  // A joint home: its other servers' members who may be named on it too.
  const joint = homeChannelId === null ? null : await jointHomeAudience(reader, located, homeChannelId, registered.app.flag);
  const userIds = shown.filter((actor) => actor.type === "user").map((actor) => actor.id);
  const [rows, roles, peerRows] = await Promise.all([
    matchingRows(shown, ""),
    userIds.length === 0 ? [] : getDb().select({ userId: serverMembers.userId, role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, located.serverId), inArray(serverMembers.userId, userIds))),
    !joint || joint.peers.length === 0 ? [] : matchingRows(joint.peers, input.q),
  ]);
  const rowOf = new Map(rows.map((row) => [actorKey(row), row]));
  const guests = new Set(roles.filter((row) => isGuestRole(row.role as ServerRole)).map((row) => row.userId));
  const own = shown.flatMap((actor) => {
    const row = rowOf.get(actorKey(actor));
    return row ? [candidate(row, actor.type === "user" && guests.has(actor.id))] : [];
  });
  if (!joint || peerRows.length === 0) return capped(own, input.limit);
  // Another server's people and agents as the joint's roster shows them,
  // without roles; the joint's members (every server's) first, then as above.
  const inHome = new Set(joint.members.map(actorKey));
  const merged = [...own, ...peerRows.map((row) => candidate(row, false))]
    .sort((a, b) => Number(inHome.has(actorKey(b))) - Number(inHome.has(actorKey(a))) || byPeopleThenHandle(a, b));
  return capped(merged, input.limit);
}

/**
 * Who a joint's member of another server may name on an object homed in that
 * joint (#68: a joint's object is a message there): the joint's roster as the
 * reader's server's projection shows it (conversationAudience, the joint's
 * own messages' rule), each only while it can see the object now, as an
 * actor of the object's server (standing there) or from another server in
 * the joint (platform/visibility jointViewersOf). Null unless the reader
 * sees the object through the joint (seenThroughJoint, the rule its writes
 * ask). The same rule as each app's send-time check.
 */
async function jointObjectAudience(
  reader: MentionReader,
  registered: MentionableObjectKind,
  objectId: string,
  located: AppObjectHome,
  input: { q: string; limit: number },
): Promise<MentionAudienceCandidates | null> {
  if (located.homeKind !== "conversation" || located.homeChannelId === null) return null;
  const subject = { id: objectId, serverId: located.serverId, homeKind: located.homeKind, homeChannelId: located.homeChannelId, author: located.author };
  const seen = await seenThroughJoint({ type: "user", id: reader.userId, serverId: reader.serverId }, [subject], registered.app.flag);
  if (!seen.has(objectId)) return null;
  const projection = (await localConversationIds(reader.serverId, [located.homeChannelId])).get(located.homeChannelId);
  if (!projection) return null;
  const roster = await conversationAudience(reader, projection, { q: input.q, limit: MENTION_AUDIENCE_POOL_MAX });
  if (!roster) return null;
  const actors = roster.candidates.map(({ type, id }) => ({ type, id }));
  const object = { serverId: located.serverId, home: homeOf(located), author: located.author };
  const own = await viewersOfHome(object, actors.map((actor) => ({ ...actor, serverId: located.serverId })), { requireStanding: true });
  const peers = await jointViewersOf(subject, actors.filter((_, index) => !own[index]), registered.app.flag);
  const sees = new Set([...actors.filter((_, index) => own[index]).map(actorKey), ...peers.keys()]);
  return capped(roster.candidates.filter((entry) => sees.has(actorKey(entry))), input.limit);
}

/**
 * Who of other servers may be named on an object of the reader's server
 * (`located`, as its kind's `homes` reports it) whose home is a joint
 * channel: the joint's members (its roster as the reader's server's
 * projection has it, conversationMembers, the joint's own messages' rule) of
 * every other server in it, each only while it can see the object now
 * (platform/visibility viewersOfHome, through its own server's projection:
 * it stands in its server and the channel lets it in) and its server has
 * the object's app on (`appFlag`; reading another server's object needs
 * both servers' flags; a soft-deleted server is off). Empty for any other
 * home, and for an object of another server: nobody outside the object's
 * server is named on it otherwise. The audience's object rule and each
 * app's send-time check (a mention never grants access) ask the same.
 */
export async function jointObjectPeers(reader: MentionReader, located: AppObjectHome, appFlag: string): Promise<ConversationMember[]> {
  if (located.serverId !== reader.serverId || located.homeKind !== "conversation" || located.homeChannelId === null) return [];
  const projection = (await localConversationIds(located.serverId, [located.homeChannelId])).get(located.homeChannelId);
  return projection ? ((await jointHomeAudience(reader, located, projection, appFlag))?.peers ?? []) : [];
}

/**
 * An object's home as the object's server has it (`projection`), when that
 * is a joint channel the reader sees: its whole roster (every server's
 * members) and, of other servers', those who may be named on the object
 * (jointObjectPeers). Null for any other conversation.
 */
async function jointHomeAudience(
  reader: MentionReader,
  located: AppObjectHome,
  projection: string,
  appFlag: string,
): Promise<{ members: ConversationMember[]; peers: ConversationMember[] } | null> {
  const top = await topLevelConversationOf(located.serverId, projection);
  if (top?.type !== "joint" || top.conversationId !== projection) return null;
  const members = await conversationMembers(reader, projection);
  if (!members) return null;
  const others = members.filter((member) => member.serverId !== located.serverId);
  const servers = [...new Set(others.map((member) => member.serverId))];
  const on = await appEnabledOnLiveServers(servers, appFlag);
  const enabled = new Set(servers.filter((_, index) => on[index]));
  const asked = others.filter((member) => enabled.has(member.serverId));
  const object = { serverId: located.serverId, home: homeOf(located), author: located.author };
  const sees = asked.length === 0 ? [] : await viewersOfHome(object, asked.map(({ type, id, serverId }) => ({ type, id, serverId })));
  return { members, peers: asked.filter((_, index) => sees[index]) };
}
