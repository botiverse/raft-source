// Platform entry point: people and agents as an app shows and names them.
// Handles, profiles (display name, avatar), `@handle` lookup and the `@`
// directory. Actors are a user or an agent by id; maps are keyed by
// actorKey. A deleted agent has no name or profile: agent names are unique
// among live agents only, so its old name may now be another agent's handle.
// Users and agents are core's tables; an app stores only actor refs.
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, channelAgents, channelHumans, serverMembers, servers, users } from "../db/schema";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { canUserSeeHumansThroughLocalChannel, getAgentIdsVisibleThroughLocalChannels } from "../services/channelService";
import { shouldExposeHumanInHiddenDirectory, shouldHideHumanDirectoryFromRequester } from "../services/serverService";
import { agentFindableBy, type AgentFinder } from "../services/agentMemberListPolicy";

/** A person or an agent, by id. */
export type ActorRef = { type: "user" | "agent"; id: string };

/** How a person or agent is shown. */
export interface ActorProfile {
  /** The handle (`@name`). */
  name: string;
  /** The display name, else the handle. */
  displayName: string;
  avatarUrl: string | null;
  /**
   * An agent that is a person's personal assistant (agents.assistant_owner_user_id):
   * that person, by id, handle and display name (else the handle).
   */
  assistantOf?: { id: string; name: string; displayName: string };
}

/** The key of an actor in the maps here: `user:<id>` or `agent:<id>`. */
export const actorKey = (actor: ActorRef): string => `${actor.type}:${actor.id}`;

const idsOf = (actors: readonly ActorRef[], type: ActorRef["type"]) => actors.filter((actor) => actor.type === type).map((actor) => actor.id);

/**
 * Handles of users and live agents, keyed by actorKey; absent when one no
 * longer exists (or a user has no handle). `executor`: read inside the
 * caller's transaction.
 */
export async function actorNames(actors: readonly ActorRef[], executor?: DatabaseExecutor): Promise<Map<string, string>> {
  const db = executor ?? getDb();
  const userIds = idsOf(actors, "user");
  const agentIds = idsOf(actors, "agent");
  const [userRows, agentRows] = await Promise.all([
    userIds.length > 0 ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    agentIds.length > 0
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(inArray(agents.id, agentIds), isNull(agents.deletedAt)))
      : [],
  ]);
  const names = new Map<string, string>();
  for (const row of userRows) if (row.name) names.set(actorKey({ type: "user", id: row.id }), row.name);
  for (const row of agentRows) names.set(actorKey({ type: "agent", id: row.id }), row.name);
  return names;
}

/** The person an agent is the personal assistant of, joined beside the agent (actorProfiles). */
const assistantOwners = alias(users, "assistant_owner");

/**
 * Profiles of users and live agents, keyed by actorKey; absent when one no
 * longer exists. The avatar is the one the person or agent set (avatar_url);
 * nothing else of theirs (such as email) is read. A personal
 * assistant's profile names its owner (`assistantOf`), read in the agents'
 * own query: two queries however many actors.
 */
export async function actorProfiles(actors: readonly ActorRef[]): Promise<Map<string, ActorProfile>> {
  const db = getDb();
  const userIds = idsOf(actors, "user");
  const agentIds = idsOf(actors, "agent");
  const [userRows, agentRows] = await Promise.all([
    userIds.length > 0
      ? db.select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, userIds))
      : [],
    agentIds.length > 0
      ? db.select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        ownerId: assistantOwners.id,
        ownerName: assistantOwners.name,
        ownerDisplayName: assistantOwners.displayName,
      }).from(agents)
        .leftJoin(assistantOwners, eq(assistantOwners.id, agents.assistantOwnerUserId))
        .where(and(inArray(agents.id, agentIds), isNull(agents.deletedAt)))
      : [],
  ]);
  const profiles = new Map<string, ActorProfile>();
  const profile = (row: { name: string; displayName: string | null; avatarUrl: string | null }) => ({ name: row.name, displayName: row.displayName || row.name, avatarUrl: row.avatarUrl });
  for (const row of userRows) profiles.set(actorKey({ type: "user", id: row.id }), profile(row));
  for (const row of agentRows) {
    const assistantOf = row.ownerId !== null && row.ownerName !== null
      ? { assistantOf: { id: row.ownerId, name: row.ownerName, displayName: row.ownerDisplayName || row.ownerName } }
      : {};
    profiles.set(actorKey({ type: "agent", id: row.id }), { ...profile(row), ...assistantOf });
  }
  return profiles;
}

/**
 * The people (members, any role) and live agents of a server whose handle is
 * one of `handles`, exactly as written (as messages match @mentions). A
 * person and an agent may share a handle: both are returned. Another person's
 * personal assistant is not found, as a handle nobody has (agentFindableBy:
 * `finder` is who names it).
 */
export async function actorsByHandle(serverId: ServerId, handles: readonly string[], finder: AgentFinder): Promise<Array<ActorRef & { name: string }>> {
  if (handles.length === 0) return [];
  const db = getDb();
  const [agentRows, userRows] = await Promise.all([
    db.select({ id: agents.id, name: agents.name }).from(agents)
      .where(and(eq(agents.serverId, serverId), inArray(agents.name, [...handles]), isNull(agents.deletedAt), agentFindableBy(finder))),
    db.select({ id: users.id, name: users.name }).from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(users.name, [...handles]))),
  ]);
  return [
    ...agentRows.map((row) => ({ type: "agent" as const, id: row.id, name: row.name })),
    ...userRows.map((row) => ({ type: "user" as const, id: row.id, name: row.name })),
  ];
}

/**
 * The ILIKE pattern of a mention query: names containing `q`, `%`, `_` and
 * `\` matched literally (mentionCandidates', and platform/mentions').
 */
export const likeContaining = (q: string) => `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * The directory `@` completes from: people (members of `serverId`, any role,
 * guests included, not retired) and live agents of it whose handle or display
 * name contains `q` (any case, `%` and `_` literal), at most `limit`. Members
 * of `homeChannelId` (when given) first, then people before agents, then by
 * handle. Only candidates: callers decide who may be named where. Another
 * person's personal assistant is never one (agentFindableBy: `finder` is the
 * reader).
 */
export async function mentionCandidates(input: {
  serverId: ServerId;
  q: string;
  homeChannelId: string | null;
  limit: number;
  finder: AgentFinder;
}): Promise<ActorRef[]> {
  const { serverId, q, homeChannelId, limit, finder } = input;
  const db = getDb();
  const pattern = likeContaining(q);
  const inHomeHuman = homeChannelId
    ? sql<boolean>`EXISTS (SELECT 1 FROM ${channelHumans} WHERE ${channelHumans.channelId} = ${homeChannelId} AND ${channelHumans.userId} = ${users.id})`
    : sql<boolean>`FALSE`;
  const inHomeAgent = homeChannelId
    ? sql<boolean>`EXISTS (SELECT 1 FROM ${channelAgents} WHERE ${channelAgents.channelId} = ${homeChannelId} AND ${channelAgents.agentId} = ${agents.id})`
    : sql<boolean>`FALSE`;
  const [people, agentRows] = await Promise.all([
    db.select({ id: users.id, name: users.name, inHome: inHomeHuman }).from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(
        eq(serverMembers.serverId, serverId),
        isNull(users.retiredAt),
        sql`(${users.name} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`,
      ))
      // Postgres refuses a constant ORDER BY: rank by the home only when there is one.
      .orderBy(...(homeChannelId ? [sql`${inHomeHuman} DESC`] : []), asc(users.name)).limit(limit),
    db.select({ id: agents.id, name: agents.name, inHome: inHomeAgent }).from(agents)
      .where(and(
        eq(agents.serverId, serverId),
        isNull(agents.deletedAt),
        agentFindableBy(finder),
        sql`(${agents.name} ILIKE ${pattern} OR ${agents.displayName} ILIKE ${pattern})`,
      ))
      .orderBy(...(homeChannelId ? [sql`${inHomeAgent} DESC`] : []), asc(agents.name)).limit(limit),
  ]);
  // Members of the home conversation first, people before agents, then by handle.
  return [
    ...people.map((row) => ({ type: "user" as const, id: row.id, name: row.name, inHome: row.inHome })),
    ...agentRows.map((row) => ({ type: "agent" as const, id: row.id, name: row.name, inHome: row.inHome })),
  ]
    .sort((a, b) => Number(b.inHome) - Number(a.inHome) || (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "user" ? -1 : 1))
    .slice(0, limit)
    .map(({ type, id }) => ({ type, id }));
}

/**
 * The first `limit` of `actors` (people and agents of `serverId`, in order)
 * that the person `userId`, of that server, may be shown there, as core's
 * directory has it (the people in one batch, not a query per person):
 * - a guest: only itself and those it meets in a conversation it can read
 *   (the people of GET /api/servers/:id/members/:memberId/profile,
 *   channelService canUserSeeHumansThroughLocalChannel; the agents of
 *   GET /api/agents, getAgentIdsVisibleThroughLocalChannels);
 * - a member of a server that hides its people from members
 *   (servers.hideHumansFromMembers, serverService
 *   shouldHideHumanDirectoryFromRequester): of the people, only itself, those
 *   it shares a conversation with other than #all, and the always-shown ones
 *   (shouldExposeHumanInHiddenDirectory), as that profile route and
 *   POST /api/actors/resolve have it; every agent;
 * - anyone else (an owner or admin, or a member where people are not
 *   hidden): all of them.
 */
export async function actorsShownToPerson(serverId: ServerId, userId: string, actors: readonly ActorRef[], limit: number): Promise<ActorRef[]> {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  const guest = role === "guest";
  if (!guest && !(role === "member" && await shouldHideHumanDirectoryFromRequester(serverId, userId))) return actors.slice(0, limit);
  const [agentIds, userIds] = await Promise.all([
    // null: every agent.
    guest && actors.some((actor) => actor.type === "agent") ? getAgentIdsVisibleThroughLocalChannels(serverId, userId) : null,
    peopleShownTo(serverId, userId, guest, idsOf(actors, "user")),
  ]);
  return actors.filter((actor) => actor.type === "agent" ? !agentIds || agentIds.has(actor.id) : userIds.has(actor.id)).slice(0, limit);
}

/** Of `ids`, the people a guest, or a member the server hides its people from, may be shown (actorsShownToPerson). */
async function peopleShownTo(serverId: ServerId, userId: string, guest: boolean, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (guest) return canUserSeeHumansThroughLocalChannel(serverId, userId, ids);
  const [throughConversations, rows] = await Promise.all([
    canUserSeeHumansThroughLocalChannel(serverId, userId, ids),
    getDb().select({ id: serverMembers.userId, role: serverMembers.role, serverSlug: servers.slug }).from(serverMembers)
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, [...ids]))),
  ]);
  for (const row of rows) if (shouldExposeHumanInHiddenDirectory(row, userId)) throughConversations.add(row.id);
  return throughConversations;
}

const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Botiverse, the platform's own Server: its human owners and admins are
 * Raft's platform owners and admins. The same rule, and the same pinned id,
 * as the official App registry's operator (migration 0489,
 * official_app_registry_require_operator) and App Admin's reviews.
 */
export const PLATFORM_SERVER_ID = asServerId("95f993fa-2a68-4797-b8ae-7beb7d984ada");

/** The person `who` picks is a human owner or admin of Botiverse now (an account not retired, the server not deleted). */
const platformOwnerOrAdmin = (who: SQL) => and(
  eq(serverMembers.serverId, PLATFORM_SERVER_ID),
  inArray(serverMembers.role, ["owner", "admin"]),
  isNull(users.retiredAt),
  isNull(servers.deletedAt),
  who,
);

/**
 * Whether the person is a Raft platform owner or admin now: a human owner or
 * admin of Botiverse (PLATFORM_SERVER_ID), an account not retired. Read only.
 */
export async function isPlatformOwnerOrAdmin(userId: string, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  if (!UUID_REF.test(userId)) return false;
  const [row] = await (opts?.executor ?? getDb()).select({ role: serverMembers.role }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(platformOwnerOrAdmin(eq(serverMembers.userId, userId.toLowerCase()))).limit(1);
  return row !== undefined;
}

/**
 * A person named by id, email or handle (`users.name`) who is a Raft platform
 * owner or admin now (isPlatformOwnerOrAdmin), with their handle; null for
 * anyone else (no such person, not in Botiverse or another role there, a
 * retired account). Read only.
 */
export async function platformOwnerOrAdminByRef(ref: string): Promise<{ id: string; name: string } | null> {
  const value = ref.trim();
  if (!value) return null;
  const who = UUID_REF.test(value) ? eq(users.id, value.toLowerCase()) : value.includes("@") ? eq(users.email, value) : eq(users.name, value);
  const [row] = await getDb().select({ id: users.id, name: users.name }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(platformOwnerOrAdmin(who)).limit(1);
  return row ?? null;
}

/** Each of these agents' own server (an agent is of one server), by id; absent for no such agent. Read only. */
export async function agentServers(agentIds: readonly string[], opts?: { executor?: DatabaseExecutor }): Promise<Map<string, ServerId>> {
  if (agentIds.length === 0) return new Map();
  const rows = await (opts?.executor ?? getDb()).select({ id: agents.id, serverId: agents.serverId }).from(agents).where(inArray(agents.id, [...new Set(agentIds)]));
  return new Map(rows.map((row) => [row.id, asServerId(row.serverId)]));
}

/** The live (not retired) human owners of the server now, by id. Read only. */
export async function serverOwnerIds(serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  const rows = await (opts?.executor ?? getDb()).select({ id: serverMembers.userId }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "owner"), isNull(users.retiredAt)))
    .orderBy(asc(serverMembers.userId));
  return rows.map((row) => row.id);
}

/**
 * What a principal id is in the server, whatever type it was said to be: an
 * agent of it (`deleted` or not), a member of it (with the role; a retired
 * account too), or neither (null: another server's, someone who left, no
 * such id). Read only.
 */
export async function principalInServer(
  serverId: ServerId,
  id: string,
  opts?: { executor?: DatabaseExecutor },
): Promise<{ kind: "agent"; deleted: boolean } | { kind: "member"; role: "owner" | "admin" | "member" | "guest" } | null> {
  if (!UUID_REF.test(id)) return null;
  const db = opts?.executor ?? getDb();
  const value = id.toLowerCase();
  const [agent] = await db.select({ deletedAt: agents.deletedAt }).from(agents).where(and(eq(agents.serverId, serverId), eq(agents.id, value))).limit(1);
  if (agent) return { kind: "agent", deleted: agent.deletedAt !== null };
  const [member] = await db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, value))).limit(1);
  return member ? { kind: "member", role: member.role } : null;
}
