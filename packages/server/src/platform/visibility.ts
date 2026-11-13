// Platform entry point: who can see an object, by its home (a conversation,
// the server, or public). The rules are services/visibilityService's
// (standing in the server, top-level homes only, the orphan rule, and a home
// in a joint channel: its canonical channel, seen from each participating
// server through that server's projection, jointHomeProjections); an app
// maps its object table's standard home columns to a home (homeOf) and names
// its author, and adds only what is its own (a deleted object is seen by
// nobody). One check by id (canViewHomes), the same turned the other way
// (viewersOfHome), and the same as a list condition (visibleHomesSql, or
// visibleHomes read once for many tables) agree.
//
// Orphans are the platform's, for every app (first-party app mechanism §八):
// an object whose home conversation is gone, soft-deleted (`deleted_at`) or
// hard-deleted (the object table's ON DELETE SET NULL left
// `home_kind = 'conversation'` with a NULL `home_channel_id`), or homed in a
// joint its server has left (disconnected, deleted its projection, or the
// joint closed; no other server sees it then). Only its
// author, the author agent's manager (the owner of a personal assistant,
// otherwise its human creator) and the server's owners and admins see one,
// by id; no list or search shows it (visibleHomesSql). The same people (an
// author while it stands in the server, a live agent author's manager, the
// owners and admins) may manage an object of their server: canManageObject
// (a guest may delete their own, never widen it).
import { and, asc, eq, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, serverMembers } from "../db/schema";
import { listedServerAgent } from "../services/agentMemberListPolicy";
import { appEnabledOn, appEnabledOnLiveServers } from "./flags";
import {
  agentManagerOf as agentManagerOfService,
  agentsManagedBy as agentsManagedByService,
  agentsCreatedBy as agentsCreatedByService,
  assertNeverViewActor,
  canActorsViewHomedObject,
  canAnonymousViewHomedObjects,
  canManageHomedObject,
  canManageHomedObjectActions,
  canManageHomedObjectActionsWithStanding,
  canView,
  canViewHomedObjects,
  jointHomeProjections,
  jointHomeRecords,
  isFullMemberOfOwnServer as actorIsFullMemberOfOwnServer,
  standsInOwnServer as actorStandsInOwnServer,
  uuidArray,
  visibleRootChannelIds,
  type HomedObject,
  type HomedObjectManagement,
  type ObjectHome,
  type ServerViewActor,
  type ViewActor,
  type ViewAuthor,
  type ViewHome,
  type VisibleRootType,
} from "../services/visibilityService";

export type { HomedObject, HomedObjectManagement, ObjectHome, ServerViewActor, ViewActor, ViewAuthor, ViewHome, VisibleRootType };
/** Branch on a ViewActor's `type` with a `switch` ending in this (RFC 080 §4.1): a `delegated` actor never falls into another branch. */
export { assertNeverViewActor };

/** An object table's standard home columns, as read (`server_id`, `home_kind`, `home_channel_id`). */
export interface HomeRow {
  serverId: ServerId;
  homeKind: "conversation" | "server" | "public";
  homeChannelId: string | null;
}

/**
 * The home an object's standard columns name. A conversation home without a
 * channel is an orphan (its conversation was hard-deleted); one naming a
 * soft-deleted conversation is one too, which canViewHomes finds out.
 */
export function homeOf(row: HomeRow): ObjectHome {
  switch (row.homeKind) {
    case "conversation": return row.homeChannelId === null ? { kind: "orphan", serverId: row.serverId } : { kind: "conversation", channelId: row.homeChannelId };
    case "server": return { kind: "server", serverId: row.serverId };
    case "public": return { kind: "public" };
  }
}

/**
 * Which of many objects one viewer can see, one boolean per object in input
 * order, in a constant number of queries
 * (visibilityService.canViewHomedObjects): the viewer's server's objects by
 * their home, another server's only when public or homed in a joint the
 * viewer sees through its own server's projection. An orphan: its author,
 * the author agent's manager, the server's owners and admins. `executor`:
 * read inside the caller's transaction.
 */
export function canViewHomes(viewer: ViewActor, objects: readonly HomedObject[], opts?: { executor?: DatabaseExecutor }): Promise<boolean[]> {
  return canViewHomedObjects(viewer, objects, opts);
}

/**
 * canViewHomes for a signed-out visitor, who is no actor of any server: one
 * boolean per object in input order, true only for a public home
 * (visibilityService.canAnonymousViewHomedObjects; no query).
 */
export function canViewHomesAnonymously(objects: readonly HomedObject[]): boolean[] {
  return canAnonymousViewHomedObjects(objects);
}

/**
 * canViewHomes turned the other way: which of many actors, each in its own
 * server, can see one object, one boolean per actor in input order
 * (visibilityService.canActorsViewHomedObject): the same answers as
 * canViewHomes for each. `requireStanding`: only those who stand in the
 * object's server, a public object too, for callers that name people of the
 * server (mentions, presence).
 */
export function viewersOfHome(
  object: HomedObject,
  actors: readonly ServerViewActor[],
  opts?: { requireStanding?: boolean },
): Promise<boolean[]> {
  return canActorsViewHomedObject(actors, object, opts);
}

/** An object of some server, by its standard home columns and its author (seenThroughJoint). */
export interface JointCandidate extends HomeRow {
  id: string;
  author: ViewAuthor;
}

/**
 * Which of these objects of other servers the viewer sees through a joint
 * channel (#68: an object in a joint is, for the other servers' people, a
 * message there): homed in a joint (its canonical channel, or a server's
 * projection of it) in which the viewer's server has an active projection,
 * the app (`appFlag`) on for both servers, which still exist, and the viewer
 * let in through it (canViewHomes). An object of the viewer's own server, or
 * one it sees any other way (public), is none of them. The one rule an
 * app's writes by another server's person and core's Activity rows of
 * another server's objects both ask, so leaving the joint ends both at once.
 * A constant number of queries.
 */
export async function seenThroughJoint(
  viewer: ViewActor,
  objects: readonly JointCandidate[],
  appFlag: string,
  opts?: { executor?: DatabaseExecutor },
): Promise<ReadonlySet<string>> {
  const asked = objects.filter((object) => object.serverId !== viewer.serverId && object.homeKind === "conversation" && object.homeChannelId !== null);
  if (asked.length === 0) return new Set();
  const homeIds = [...new Set(asked.map((object) => object.homeChannelId!))];
  const executor = opts?.executor;
  // A home naming a server's projection names the joint's canonical channel.
  const canonicalOf = new Map((await jointHomeRecords("any", { localChannelIds: homeIds, executor })).map((record) => [record.localChannelId, record.canonicalChannelId]));
  const canonical = (object: JointCandidate) => canonicalOf.get(object.homeChannelId!) ?? object.homeChannelId!;
  const viewersJoints = new Set((await jointHomeProjections([viewer.serverId], { canonicalChannelIds: [...new Set(asked.map(canonical))], executor }))
    .map((projection) => projection.canonicalChannelId));
  const inJoint = asked.filter((object) => viewersJoints.has(canonical(object)));
  if (inJoint.length === 0) return new Set();
  const servers = [...new Set([viewer.serverId, ...inJoint.map((object) => object.serverId)])];
  const on = await appEnabledOnLiveServers(servers, appFlag, { executor });
  const enabled = new Set(servers.filter((_, index) => on[index]));
  if (!enabled.has(viewer.serverId)) return new Set();
  const flagged = inJoint.filter((object) => enabled.has(object.serverId));
  const answers = await canViewHomedObjects(viewer, flagged.map((object) => ({ serverId: object.serverId, home: homeOf(object), author: object.author })), { executor });
  return new Set(flagged.filter((_, index) => answers[index]).map((object) => object.id));
}

/**
 * The other servers in the joint channel an object is homed in (active
 * projections) with the app on, while the object's own server has it on
 * too: those whose people and agents may see it from there. Empty for any
 * other home.
 */
export async function jointServersOf(object: HomeRow, appFlag: string, opts?: { executor?: DatabaseExecutor }): Promise<ServerId[]> {
  if (object.homeKind !== "conversation" || object.homeChannelId === null) return [];
  const executor = opts?.executor;
  const [record] = await jointHomeRecords("any", { localChannelIds: [object.homeChannelId], executor });
  const canonical = record?.canonicalChannelId ?? object.homeChannelId;
  const others = [...new Set((await jointHomeProjections("any", { canonicalChannelIds: [canonical], executor }))
    .map((projection) => projection.serverId)
    .filter((serverId) => serverId !== object.serverId))];
  if (others.length === 0) return [];
  const on = await appEnabledOnLiveServers([object.serverId, ...others], appFlag, { executor });
  return on[0] ? others.filter((_, index) => on[index + 1]) : [];
}

/**
 * seenThroughJoint turned the other way: of these people and agents, the
 * servers other than the object's own each sees `object` from through a
 * joint channel it is homed in (a person by each such server it is a member
 * of, an agent by its own server), the app on for both servers; absent for
 * one who sees it from none. Who of a joint's other side an object's events
 * are for (recipients, notices, the Activity ping), by the same rule as
 * seenThroughJoint. A constant number of queries.
 */
export async function jointViewersOf(
  object: JointCandidate,
  actors: ReadonlyArray<{ type: "user" | "agent"; id: string }>,
  appFlag: string,
  opts?: { executor?: DatabaseExecutor },
): Promise<ReadonlyMap<string, ServerId[]>> {
  const found = new Map<string, ServerId[]>();
  if (actors.length === 0) return found;
  const executor = opts?.executor;
  const db = executor ?? getDb();
  const enabled = await jointServersOf(object, appFlag, opts);
  if (enabled.length === 0) return found;
  const users = new Set<string>();
  const agentSet = new Set<string>();
  for (const actor of actors) {
    switch (actor.type) {
      case "user": users.add(actor.id); break;
      case "agent": agentSet.add(actor.id); break;
    }
  }
  const userIds = [...users];
  const agentIds = [...agentSet];
  const [people, ownAgents] = await Promise.all([
    userIds.length === 0 ? [] : db.select({ id: serverMembers.userId, serverId: serverMembers.serverId }).from(serverMembers)
      .where(and(sql`${serverMembers.userId} = ANY(${uuidArray(userIds)})`, sql`${serverMembers.serverId} = ANY(${uuidArray(enabled)})`)),
    agentIds.length === 0 ? [] : db.select({ id: agents.id, serverId: agents.serverId }).from(agents)
      .where(and(sql`${agents.id} = ANY(${uuidArray(agentIds)})`, sql`${agents.serverId} = ANY(${uuidArray(enabled)})`)),
  ]);
  const pairs: ServerViewActor[] = [
    ...people.map((row) => ({ type: "user" as const, id: row.id, serverId: row.serverId as ServerId })),
    ...ownAgents.map((row) => ({ type: "agent" as const, id: row.id, serverId: row.serverId as ServerId })),
  ];
  if (pairs.length === 0) return found;
  const sees = await canActorsViewHomedObject(pairs, { serverId: object.serverId, home: homeOf(object), author: object.author });
  pairs.forEach((pair, index) => {
    if (!sees[index]) return;
    const key = `${pair.type}:${pair.id}`;
    found.set(key, [...(found.get(key) ?? []), pair.serverId]);
  });
  return found;
}

/**
 * What moving an object to `to` takes from its own server: of the server's
 * people (its members, any role) and agents (live, as member lists show
 * them), at most `maxCounted` (people first, each kind in id order), how
 * many see it where it is now and wouldn't in `to` (viewersOfHome, both
 * ways). `capped` when the server has more than were counted: the counts
 * are then a lower bound. Nobody outside the server is counted (a public
 * object's signed-out visitors and other servers' readers, a joint's other
 * side). Four queries, plus viewersOfHome's twice.
 */
export async function serverViewersLost(
  object: HomedObject,
  to: ObjectHome,
  opts: { maxCounted: number },
): Promise<{ people: number; agents: number; capped: boolean }> {
  const db = getDb();
  const limit = opts.maxCounted + 1;
  const [people, liveAgents] = await Promise.all([
    db.select({ id: serverMembers.userId }).from(serverMembers)
      .where(eq(serverMembers.serverId, object.serverId)).orderBy(asc(serverMembers.userId)).limit(limit),
    db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.serverId, object.serverId), isNull(agents.deletedAt), listedServerAgent()))
      .orderBy(asc(agents.id)).limit(limit),
  ]);
  const roster: ServerViewActor[] = [
    ...people.map((row) => ({ type: "user" as const, id: row.id, serverId: object.serverId })),
    ...liveAgents.map((row) => ({ type: "agent" as const, id: row.id, serverId: object.serverId })),
  ];
  const counted = roster.slice(0, opts.maxCounted);
  const [now, after] = await Promise.all([
    canActorsViewHomedObject(counted, object),
    canActorsViewHomedObject(counted, { ...object, home: to }),
  ]);
  let lostPeople = 0;
  let lostAgents = 0;
  for (const actor of counted.filter((_, index) => now[index]! && !after[index]!)) {
    switch (actor.type) {
      case "user":
        lostPeople += 1;
        break;
      case "agent":
        lostAgents += 1;
        break;
      default:
        return assertNeverViewActor(actor);
    }
  }
  return { people: lostPeople, agents: lostAgents, capped: roster.length > counted.length };
}

/** An object table's home columns (the standard `server_id`, `home_kind`, `home_channel_id`). */
export interface HomeColumns {
  serverId: SQLWrapper;
  homeKind: SQLWrapper;
  homeChannelId: SQLWrapper;
}

/**
 * Which homes a list keeps: only these kinds of home and, of conversation
 * homes, only these conversation types. Absent: every home. It only narrows
 * what visibleHomesSql lets through, never widens it.
 */
export interface HomeNarrowing {
  kinds: readonly ViewHome["kind"][];
  conversationTypes?: readonly VisibleRootType[];
}

/**
 * The list form of canViewHomes, as a condition on an object table's home
 * columns: objects of the viewer's server whose home the viewer can see, and
 * objects of any server homed in a joint the viewer sees. Computed once per
 * request in a constant number of queries, to sit in the same statement as
 * the list's order and LIMIT.
 *
 * Conversation homes match the viewer's visible top-level conversations
 * (visibleRootChannelIds: the same top-level homes canViewHomes accepts, for
 * a viewer who stands in the server; its query is gated on the viewer's
 * membership, so someone who no longer stands in the server gets no
 * conversations and lists public objects only, as canViewHomes answers), as
 * one uuid[] parameter, and, whatever the object's server, the canonical
 * channels of the visible joint projections among them
 * (jointHomeProjections), for the objects of the servers still in the joint
 * (an active projection: once its server has left, an object is an orphan
 * of that server, never listed) that have the app (`appFlag`) on: an object
 * in a joint is listed only while its own server has the app on, as reading
 * it by id needs that server's flag
 * (the viewer's own server's flag is the caller's to check first, as for
 * every list). Orphans are never listed, whoever asks: a NULL
 * home_channel_id matches nothing, and deleted conversations are never among
 * the visible ones; those who may still see one reach it by id through
 * canViewHomes. Another server's public objects are not listed. The app adds
 * its own conditions (deleted objects).
 */
export async function visibleHomesSql(
  viewer: ViewActor,
  columns: HomeColumns,
  opts: { appFlag: string; executor?: DatabaseExecutor; narrow?: HomeNarrowing },
): Promise<SQL> {
  return (await visibleHomes(viewer, { executor: opts.executor, appFlags: [opts.appFlag] })).sql(columns, { appFlag: opts.appFlag, narrow: opts.narrow });
}

/** The homes one viewer can see, read once: visibleHomesSql's condition for any object table, without reading again. */
export interface VisibleHomes {
  /**
   * visibleHomesSql's condition on these home columns, for the app whose
   * flag is `appFlag` (one of the flags visibleHomes read): it names the
   * viewer's server, and nothing else of another server passes than objects
   * in the viewer's joints whose server has that flag on.
   */
  sql(columns: HomeColumns, opts: { appFlag: string; narrow?: HomeNarrowing }): SQL;
}

/**
 * The homes the viewer can see (visibleRootChannelIds and canView of the
 * server home, a constant number of queries), for conditions on as many
 * object tables as asked: core's search reads them once per request and
 * hands each app's search the condition (first-party app mechanism §五).
 * `appFlags`: the flags of the apps whose conditions will be asked; for
 * each, which of the servers in the viewer's visible joints have it on (one
 * batched flag evaluation per flag; nothing when the viewer sees no joint).
 */
export async function visibleHomes(viewer: ViewActor, opts: { appFlags: readonly string[]; executor?: DatabaseExecutor }): Promise<VisibleHomes> {
  const executor = opts.executor;
  const roots = await visibleRootChannelIds(viewer, { executor, includeThreads: false });
  const [seesServer] = await canView(viewer, [{ kind: "server", serverId: viewer.serverId }], { executor });
  // The joints among the visible roots: their canonical channels, the home their objects name.
  const visibleJointRoots = roots.roots.filter((root) => root.type === "joint").map((root) => root.id);
  const jointHomeIds = visibleJointRoots.length === 0 ? [] : (await jointHomeProjections([viewer.serverId], { localChannelIds: visibleJointRoots, executor }))
    .map((projection) => projection.canonicalChannelId);
  // Whose objects each joint shows: the servers still in it (an active
  // projection: a server that left takes its objects with it), of those
  // the ones that have each app on.
  const inJoints = jointHomeIds.length === 0 ? [] : await jointHomeProjections("any", { canonicalChannelIds: jointHomeIds, executor });
  const participants = [...new Set(inJoints.map((projection) => projection.serverId))];
  // Per flag: the ids a joint object may name (any server's), and, per
  // server, the ones its own objects may name.
  const shownIn = new Map<string, { homeIds: string[]; byServer: Map<string, string[]> }>();
  for (const flag of new Set(opts.appFlags)) {
    const on = await appEnabledOn(participants, flag, { executor });
    const enabled = new Set(participants.filter((_, index) => on[index]));
    // A server's object names the joint's canonical channel, or (homed before
    // publish stored that, or in a channel converted to a joint since) that
    // server's projection of it: the same joint (visibilityService).
    const byServer = new Map<string, string[]>();
    for (const projection of inJoints) {
      if (!enabled.has(projection.serverId)) continue;
      const ids = byServer.get(projection.serverId) ?? [];
      ids.push(projection.canonicalChannelId, projection.localChannelId);
      byServer.set(projection.serverId, ids);
    }
    shownIn.set(flag, { homeIds: [...new Set([...byServer.values()].flat())], byServer });
  }
  return {
    sql(columns, { appFlag, narrow }) {
      const shown = shownIn.get(appFlag);
      if (!shown) throw new Error(`visibleHomes: the flag ${appFlag} was not read`);
      const keeps = (kind: ViewHome["kind"]) => !narrow || narrow.kinds.includes(kind);
      const conversationTypes = narrow?.conversationTypes;
      const rootIds = uuidArray(roots.roots.filter((root) => !conversationTypes || conversationTypes.includes(root.type)).map((root) => root.id));
      const ownServer = sql`(${columns.serverId} = ${viewer.serverId}
        AND (
          (${columns.homeKind} = 'conversation' AND ${keeps("conversation") ? sql`TRUE` : sql`FALSE`} AND ${columns.homeChannelId} IS NOT NULL AND ${columns.homeChannelId} = ANY(${rootIds}))
          OR (${columns.homeKind} = 'server' AND ${seesServer && keeps("server") ? sql`TRUE` : sql`FALSE`})
          OR (${columns.homeKind} = 'public' AND ${keeps("public") ? sql`TRUE` : sql`FALSE`})
        ))`;
      const joints = keeps("conversation") && (!conversationTypes || conversationTypes.includes("joint"));
      // No joint homes: the viewer's server's branch alone, on
      // idx_items_server_home. With some, a branch of its own on
      // idx_items_home_channel (home_channel_id = ANY), each server then held
      // to its own pairs: the canonical channels of the joints it is still in
      // and its own projections of them (never a joint it has left, nor
      // another server's projection). No subquery, so each branch keeps its
      // index under the OR.
      if (!joints || shown.homeIds.length === 0) return sql`(${ownServer})`;
      const perServer = sql.join([...shown.byServer].map(([serverId, ids]) => sql`(${columns.serverId} = ${serverId} AND ${columns.homeChannelId} = ANY(${uuidArray(ids)}))`), sql` OR `);
      return sql`(${ownServer}
        OR (${columns.homeKind} = 'conversation' AND ${columns.homeChannelId} = ANY(${uuidArray(shown.homeIds)}) AND (${perServer})))`;
    },
  };
}

/**
 * Whether the actor may manage an object of its own server (`widen`: move it
 * to a larger home; `delete`): its author, the manager of a live agent
 * author, the server's owners and admins, each while standing in the server;
 * widening only by a non-guest member or a live agent, so a guest may delete
 * their own and never widen it; `moderate` (take it down, restore it) only
 * by the server's owners and admins (visibilityService.canManageHomedObject). Not
 * whether it can see it: a caller that needs both asks canViewHomes too.
 */
export function canManageObject(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  action: HomedObjectManagement,
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean> {
  return canManageHomedObject(actor, object, action, opts);
}

/** canManageObject for several actions at once, one answer per action in input order, by the same rule in the same queries. */
export function canManageObjectActions(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  actions: readonly HomedObjectManagement[],
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean[]> {
  return canManageHomedObjectActions(actor, object, actions, opts);
}

/**
 * canManageObjectActions and, from the same standing read, whether the actor
 * is a full member of the object's server (isFullMemberOfOwnServer; false for
 * another server's object): both in the queries of one.
 */
export function canManageObjectActionsWithStanding(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  actions: readonly HomedObjectManagement[],
  opts?: { executor?: DatabaseExecutor },
): Promise<{ manages: boolean[]; fullMember: boolean }> {
  return canManageHomedObjectActionsWithStanding(actor, object, actions, opts);
}

/**
 * The person who manages a live agent of the server, by user id (the owner of
 * a personal assistant, otherwise its human creator: the same rule as
 * canManageObject's); null when it has none (an agent made by an agent).
 */
export function agentManagerOf(agent: { id: string; serverId: ServerId }, opts?: { executor?: DatabaseExecutor }): Promise<string | null> {
  return agentManagerOfService(agent.id, agent.serverId, opts);
}

/**
 * agentManagerOf turned the other way: the live agents of the server a
 * person manages, by id (their personal assistant, and the agents they made
 * that are no one's assistant: canManageObject's manager rule). One query.
 */
export function agentsManagedBy(user: { id: string; serverId: ServerId }, opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  return agentsManagedByService(user.id, user.serverId, opts);
}

/** The live agents of the user's server it created (services/visibilityService agentsCreatedBy): "my agents" for what counts as made by me. One query. */
export function agentsCreatedBy(user: { id: string; serverId: ServerId }, opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  return agentsCreatedByService(user.id, user.serverId, opts);
}

/**
 * Whether the viewer stands in its own server (`viewer.serverId`): a member of
 * any role (guests included), or a live agent of it. canViewHomes applies it
 * to non-public homes; this binds a viewer to its server whatever the home
 * (one named by a token rather than a session).
 */
export function standsInOwnServer(viewer: ViewActor, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return actorStandsInOwnServer(viewer, opts);
}

/**
 * Whether the viewer is a non-guest member (owner, admin, member) or a live
 * agent of its own server (`viewer.serverId`): who may change what others in
 * it made, where a guest may only change their own (an Artifact's title).
 */
export function isFullMemberOfOwnServer(viewer: ViewActor, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return actorIsFullMemberOfOwnServer(viewer, opts);
}

/**
 * The joints a server is in: the canonical channels of the top-level joints
 * `serverId` has an active projection of (jointHomeProjections). A canonical
 * channel is one namespace across the joint's servers (an app's names
 * unique per home), with every server's projection of it, which an object
 * homed before publish stored the canonical channel (or in a channel
 * converted to a joint since) names instead (jointHomeAliases); an app looks
 * names up in them as it checks them. One query.
 */
export async function jointCanonicalChannelIds(serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  return (await jointHomeProjections([serverId], opts)).map((projection) => projection.canonicalChannelId);
}

/**
 * Every id an object homed in these joints may name: each canonical channel
 * and each server's projection of it, active or not (an app's filter by
 * conversation, beside visibility). One query.
 */
export async function jointHomeAliases(canonicalChannelIds: readonly string[], opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  if (canonicalChannelIds.length === 0) return [];
  const records = await jointHomeRecords("any", { canonicalChannelIds, executor: opts?.executor });
  return [...new Set([...canonicalChannelIds, ...records.map((record) => record.localChannelId)])];
}
