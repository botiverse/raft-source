// The one visibility entry: who can see which home, and so every object homed
// in it. A home is a conversation (messages, threads, attachments, tasks,
// Artifacts, ...), the whole server, or public.
//
// The rules live in exactly one place per actor kind and are reused here, not
// restated:
// - conversations, humans: channelService.filterUserAccessibleChannelIds (the
//   batched canUserAccessChannel: guests, #all, DMs, joint, threads);
// - conversations, agents: channelService.filterAgentAccessibleChannelIds (the
//   batched canAgentAccessChannel, pinned to the agent's own server);
// - conversations, an assistant acting for its owner (RFC 080 `delegated`):
//   the owner's human rules, minus the DMs the owner's assistant may not read
//   (assistantDmScope, RFC 077 §3.1);
// - the server: its non-guest members (the actor's server role, through lib/actorPermissions) and its
//   live agents (channelService.isLiveAgentOfServer, the same pin). Guests
//   never see a server home, nor does anyone through another server;
// - public: everyone.
// Objects that name their own home (Artifacts) go through canViewHomedObjects:
// the same answers, plus the actor's standing in the server, top-level homes
// only, and the orphan rule (its author, the author agent's manager, the
// server's owners and admins) for an object whose home conversation is gone:
// soft-deleted, or hard-deleted (the app's foreign key set its channel to
// NULL; an `orphan` home). An object homed in a joint channel names the
// joint's canonical channel, and each server sees it through its own
// projection (jointHomeProjections, the one place that maps them) while the
// object's own server is still in the joint; once that server has left, the
// object is an orphan of that server.
//
// Visibility is NOT the archived filter. An archived conversation stays
// visible (canUserAccessChannel has always answered true for it); whether a
// surface lists archived conversations is that surface's product choice and
// stays at the call site. Deleted conversations are never visible.
import { and, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { isAdminOrOwner, isGuestRole, type ServerId, type ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, channelAgents, channelHumans, channels, jointChannels, jointChannelServers, serverMembers, servers } from "../db/schema";
import {
  filterAgentAccessibleChannelIds,
  filterAgentsWithChannelAccess,
  filterUserAccessibleChannelIds,
  filterUsersWithChannelAccess,
  isLiveAgentOfServer,
} from "./channelService";
import { resolveActorContext } from "../lib/actorPermissions";
import { dmScopeOf, readableOwnerDmPolicy } from "./assistantDmScope";

/**
 * Who is looking, and through which server.
 *
 * `delegated` (RFC 080): an assistant acting for its owner. `id` is the
 * owner, whose visibility applies; `agentId` is the assistant, whose owner's
 * DM switch and own DM with the owner narrow it. Branch on `type` with a
 * `switch` ending in `assertNeverViewActor`, never a two-way `=== "user"`
 * test: a `delegated` actor must not fall into the user or agent branch.
 */
export type ViewActor =
  | { type: "user"; id: string; serverId: ServerId }
  | { type: "agent"; id: string; serverId: ServerId }
  | { type: "delegated"; id: string; agentId: string; serverId: ServerId };

/** A person or an agent looking for themselves (not `delegated`): the actors named as people of a server. */
export type ServerViewActor = Exclude<ViewActor, { type: "delegated" }>;

export function assertNeverViewActor(actor: never): never {
  throw new Error(`unhandled ViewActor type: ${(actor as { type?: unknown }).type}`);
}

/**
 * Where an object lives: a conversation (a channel, private channel, DM or
 * joint, by its local id), the whole server, or public.
 */
export type ViewHome =
  | { kind: "conversation"; channelId: string }
  | { kind: "server"; serverId: ServerId }
  | { kind: "public" };

/** Who made an object. */
export type ViewAuthor = { type: "user" | "agent"; id: string };

export type VisibleRootType = "channel" | "private" | "dm" | "joint";

/** A visible top-level conversation of the actor's server. */
export type VisibleRoot = { id: string; type: VisibleRootType; name: string; archivedAt: Date | null };

/**
 * Everything one actor can see in one server, computed once per request.
 *
 * A conversation row is visible iff COALESCE(parent_channel_id, id) is one of
 * `visibleConversationRootIds(roots)`: a top-level conversation by its own id,
 * a thread by its parent (channels.parent_channel_id, 0297). Two kinds of
 * thread have no parent_channel_id and are listed by their own id instead:
 * joint thread projections (their parent is the joint's local projection, but
 * they carry no parent message) and legacy parentless threads the actor sees
 * through their own membership row.
 */
export interface VisibleRoots {
  serverId: ServerId;
  /** Visible top-level conversations, archived included, ordered by (name, id). */
  roots: readonly VisibleRoot[];
  /** Visible threads without a parent_channel_id (see above). */
  parentlessThreadIds: readonly string[];
  /**
   * Visible joint conversations (roots and thread projections): local
   * projection id -> canonical storage channel id. Joint messages live in
   * canonical storage, outside this server; a content query maps through this.
   */
  jointStorageByLocalId: ReadonlyMap<string, string>;
}

/**
 * canView for many homes at once: one boolean per home, in input order, in a
 * constant number of queries however many homes are passed.
 */
export async function canView(
  actor: ViewActor,
  homes: readonly ViewHome[],
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean[]> {
  if (homes.length === 0) return [];
  return answerHomes(actor, homes, opts?.executor ?? getDb(), null);
}

/** canView's answers; `standing`, when the caller already read it, saves the server-home query. */
async function answerHomes(
  actor: ViewActor,
  homes: readonly ViewHome[],
  executor: DatabaseExecutor,
  standing: ServerStanding | null,
): Promise<boolean[]> {
  const channelIds = homes.flatMap((home) => home.kind === "conversation" ? [home.channelId] : []);
  const visibleChannels = channelIds.length === 0 ? new Set<string>() : await filterVisibleChannelIds(actor, channelIds, executor);
  // Only the actor's own server can be visible; one query however many server homes.
  const seesOwnServer = homes.some((home) => home.kind === "server" && home.serverId === actor.serverId)
    && isFullMember(actor, standing ?? await serverStanding(actor, executor));
  return homes.map((home) => {
    switch (home.kind) {
      case "conversation": return visibleChannels.has(home.channelId);
      case "server": return home.serverId === actor.serverId && seesOwnServer;
      case "public": return true;
    }
  });
}

/** The actor's standing in its own server: a human's role (null: not a member), or whether an agent is a live agent of it. */
type ServerStanding = { type: "user"; role: ServerRole | null } | { type: "agent"; live: boolean };

async function serverStanding(actor: ViewActor, executor: DatabaseExecutor): Promise<ServerStanding> {
  switch (actor.type) {
    case "user":
      return { type: "user", role: (await resolveActorContext(actor.serverId, "user", actor.id, executor)).serverRole };
    case "agent":
      return { type: "agent", live: await isLiveAgentOfServer(actor.id, actor.serverId, executor) };
    case "delegated":
      // RFC 080 hasn't decided what an assistant acting for its owner may do with
      // objects that name their own home: no standing of its own (not a member),
      // so server homes, orphans and managing them stay closed to it.
      return { type: "user", role: null };
    default:
      return assertNeverViewActor(actor);
  }
}

/** In the server at all: a member of any role (guests included), or a live agent of it. */
function standsInServer(standing: ServerStanding): boolean {
  switch (standing.type) {
    case "user": return standing.role !== null;
    case "agent": return standing.live;
  }
}

/** A human's role in the server (null: not a member); null for an agent. */
function roleOf(standing: ServerStanding): ServerRole | null {
  switch (standing.type) {
    case "user": return standing.role;
    case "agent": return null;
  }
}

/** The id of `who` when it is an agent (an object's author, a viewer of a server); null for a person. */
function agentIdOf(who: ViewAuthor): string | null {
  switch (who.type) {
    case "agent": return who.id;
    case "user": return null;
  }
}

/**
 * Whether the actor stands in its own server (`actor.serverId`): a member of
 * any role (guests included), or a live agent of it. The precondition
 * canViewHomedObjects applies to non-public homes, for callers that must bind
 * an actor to its server whatever the home (a public object's members-only
 * parts, an actor named by a token rather than a session).
 */
export async function standsInOwnServer(actor: ViewActor, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return standsInServer(await serverStanding(actor, opts?.executor ?? getDb()));
}

/** Whether the actor is a non-guest member (owner, admin, member) or a live agent of its own server (`actor.serverId`). */
export async function isFullMemberOfOwnServer(actor: ViewActor, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return isFullMember(actor, await serverStanding(actor, opts?.executor ?? getDb()));
}

/** A non-guest member (owner, admin, member) or a live agent of the server. */
function isFullMember(actor: ViewActor, standing: ServerStanding): boolean {
  switch (standing.type) {
    case "user": return standing.role !== null && !isGuestRole(standing.role);
    case "agent": return standing.live;
  }
}

/**
 * Where an object that names its own home lives: a home, or an `orphan` of
 * `serverId`, a conversation home whose conversation is gone and whose id
 * was cleared (a hard delete, through the object table's ON DELETE SET NULL).
 * A conversation home naming a soft-deleted conversation is an orphan too.
 */
export type ObjectHome = ViewHome | { kind: "orphan"; serverId: ServerId };

/** An object that names its own home (an Artifact): the server it belongs to, its home, and who made it. */
export type HomedObject = { serverId: ServerId; home: ObjectHome; author: ViewAuthor };

/** A joint's canonical channel as one server reaches it: that server's projection of the joint. */
export interface JointHomeProjection {
  canonicalChannelId: string;
  serverId: ServerId;
  localChannelId: string;
}

/**
 * A server's projection of a top-level joint, whatever its state: `active`
 * when the projection is not disconnected, its local channel not deleted and
 * the joint not closed (what jointHomeProjections returns).
 */
export interface JointHomeRecord extends JointHomeProjection {
  active: boolean;
}

/**
 * Joint admission for objects homed in a joint channel: the one place that
 * maps a joint's canonical channel (the home such an object names) to the
 * projection through which a server's members reach it. Each of `serverIds`
 * (every server when "any") gets its ACTIVE projection of each ACTIVE
 * top-level joint (a projection not disconnected, its local channel a
 * `joint` channel, not deleted), of the joints whose canonical channel is
 * among `canonicalChannelIds`, or whose projection is among
 * `localChannelIds` (every joint of these servers when neither is given);
 * the normal channel rules on that projection then decide who of the server
 * sees the object. A server with no active projection reaches nothing (its
 * members see nothing, as with the joint's messages). A joint's thread or
 * task conversation (also a joint_channels record, its projections `thread`
 * or `task` channels) is never a home: an object naming its canonical
 * channel maps to nothing.
 *
 * An object in a joint is seen on any server only while its own server (the
 * publisher's) still has an active projection too; once that server has left
 * (disconnected, deleted its projection, or the joint closed), the object is
 * an orphan of its own server (jointHomeRecords tells which) and nobody
 * elsewhere sees it (Tenny, the joint review's F3).
 *
 * Every form of object visibility calls it: by id (canViewHomedObjects),
 * turned around (canActorsViewHomedObject) and as a list
 * (platform/visibility visibleHomes), and the names an object's home is shown
 * by (platform/conversations). When joint admission becomes per person
 * (RFC 074 phase 3), this is the function that changes. One query.
 */
export async function jointHomeProjections(
  serverIds: readonly ServerId[] | "any",
  opts?: { canonicalChannelIds?: readonly string[]; localChannelIds?: readonly string[]; executor?: DatabaseExecutor },
): Promise<JointHomeProjection[]> {
  const rows = await jointRecords(serverIds, { ...opts, activeOnly: true });
  return rows.map(({ canonicalChannelId, serverId, localChannelId }) => ({ canonicalChannelId, serverId, localChannelId }));
}

/**
 * Each of `serverIds`' (every server's when "any") projection of the
 * top-level joints whose canonical channel is among `canonicalChannelIds`,
 * or of the projections among `localChannelIds`, active or not (a server
 * that left keeps its row): whether the server is still in the joint, or
 * was. An object of a server that was but is no longer is an orphan of that
 * server (canViewHomedObjects). One query.
 */
export function jointHomeRecords(
  serverIds: readonly ServerId[] | "any",
  opts: { canonicalChannelIds?: readonly string[]; localChannelIds?: readonly string[]; executor?: DatabaseExecutor },
): Promise<JointHomeRecord[]> {
  return jointRecords(serverIds, { ...opts, activeOnly: false });
}

async function jointRecords(
  serverIds: readonly ServerId[] | "any",
  opts: { canonicalChannelIds?: readonly string[]; localChannelIds?: readonly string[]; executor?: DatabaseExecutor; activeOnly: boolean },
): Promise<JointHomeRecord[]> {
  const { canonicalChannelIds, localChannelIds } = opts;
  if (serverIds.length === 0 || canonicalChannelIds?.length === 0 || localChannelIds?.length === 0) return [];
  const active = and(eq(jointChannelServers.status, "active"), eq(jointChannels.status, "active"), isNull(channels.deletedAt))!;
  const rows = await (opts.executor ?? getDb())
    .select({
      canonicalChannelId: jointChannels.canonicalChannelId,
      serverId: jointChannelServers.serverId,
      localChannelId: jointChannelServers.localChannelId,
      active: sql<boolean>`(${active})`,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(
      serverIds === "any" ? undefined : sql`${jointChannelServers.serverId} = ANY(${uuidArray(serverIds)})`,
      canonicalChannelIds ? sql`${jointChannels.canonicalChannelId} = ANY(${uuidArray(canonicalChannelIds)})` : undefined,
      localChannelIds ? sql`${jointChannelServers.localChannelId} = ANY(${uuidArray(localChannelIds)})` : undefined,
      // Top-level joints only: a joint thread's or task conversation's projection is a `thread` or `task` channel.
      eq(channels.type, "joint"),
      opts.activeOnly ? active : undefined,
    ));
  return rows.map((row) => ({ ...row, serverId: row.serverId as ServerId, active: row.active === true }));
}

/**
 * canViewHomedObjects for someone with no actor at all (a signed-out
 * visitor): public homes only, every other home (a conversation, the server,
 * an orphan) never. No query: nothing about a visitor is stored.
 */
export function canAnonymousViewHomedObjects(homed: readonly HomedObject[]): boolean[] {
  return homed.map((object) => object.home.kind === "public");
}

/** The conversation types an object may be homed in: top-level conversations, never threads. */
const TOP_LEVEL_CONVERSATION_TYPES: ReadonlySet<string> = new Set(["channel", "private", "dm", "joint"]);

/**
 * canView for objects that name their own home, in a constant number of
 * queries. Stricter than canView in what routes otherwise check, so a check
 * by id and a list built on visibleRootChannelIds agree:
 * - the actor must stand in `actor.serverId` (a member of any role, or a live
 *   agent of it); otherwise only public homes. A removed member's stale
 *   channel rows, or public channels, grant nothing;
 * - a conversation home is either a top-level conversation of the object's
 *   own server, for an actor of that server (a channel, private channel, DM
 *   or the server's joint projection; a thread or another server's channel
 *   never is), or a joint's canonical channel, for an actor of any server,
 *   seen through the actor's server's active projection of the joint
 *   (jointHomeProjections) by the channel rules, while the object's own
 *   server still has an active projection too;
 * - a server home and an orphan are only the object's own server's;
 * - an orphan (an `orphan` home of `actor.serverId`, a home conversation
 *   that was soft-deleted, or a joint the object's server was in and has
 *   left: disconnected, its projection deleted, the joint closed;
 *   jointHomeRecords) is seen only by its author (a non-guest member or
 *   live agent), the human who manages an agent author (the owner of a
 *   personal assistant, otherwise its human creator; a non-guest member) and
 *   the server's owners and admins. Guests never. Another server's orphan:
 *   nobody.
 */
export async function canViewHomedObjects(
  actor: ViewActor,
  homed: readonly HomedObject[],
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean[]> {
  let objects = homed;
  if (objects.every((object) => object.home.kind === "public")) return objects.map(() => true);
  const executor = opts?.executor ?? getDb();
  const standing = await serverStanding(actor, executor);
  if (!standsInServer(standing)) return objects.map((object) => object.home.kind === "public");

  const channelIds = [...new Set(objects.flatMap((object) => object.home.kind === "conversation" ? [object.home.channelId] : []))];
  const rows = channelIds.length === 0 ? [] : await executor
    .select({ id: channels.id, serverId: channels.serverId, type: channels.type, deletedAt: channels.deletedAt })
    .from(channels)
    .where(sql`${channels.id} = ANY(${uuidArray(channelIds)})`);
  // An object homed on its own server's projection of a joint (published
  // there before publish stored the canonical channel, or in a channel
  // converted to a joint since) is homed in the joint: read it as homed on
  // the canonical channel (jointHomeRecords; no data migration).
  const projectionIds = rows.filter((row) => row.type === "joint").map((row) => row.id);
  const canonicalOf = new Map((projectionIds.length === 0 ? [] : await jointHomeRecords("any", { localChannelIds: projectionIds, executor }))
    .map((record) => [record.localChannelId, record]));
  objects = objects.map((object) => {
    const record = object.home.kind === "conversation" ? canonicalOf.get(object.home.channelId) : undefined;
    return record && record.serverId === object.serverId ? { ...object, home: { kind: "conversation", channelId: record.canonicalChannelId } } : object;
  });
  const homeRows = new Map(rows
    .filter((row) => row.serverId === actor.serverId && TOP_LEVEL_CONVERSATION_TYPES.has(row.type) && !canonicalOf.has(row.id))
    .map((row) => [row.id, row]));
  // Any other conversation home may be a joint's canonical channel: seen
  // through the actor's server's active projection of it, while the
  // object's own server is still in the joint too.
  const others = new Set(objects.flatMap((object) => object.home.kind === "conversation" && !homeRows.has(object.home.channelId) ? [object.home.channelId] : []));
  const jointServers = [...new Set([actor.serverId, ...objects.flatMap((object) => object.home.kind === "conversation" && others.has(object.home.channelId) ? [object.serverId] : [])])];
  const records = new Map((others.size === 0 ? [] : await jointHomeRecords(jointServers, { canonicalChannelIds: [...others], executor }))
    .map((record) => [`${record.canonicalChannelId}:${record.serverId}`, record]));
  const recordOf = (channelId: string, serverId: ServerId) => records.get(`${channelId}:${serverId}`);

  const asked = objects.flatMap((object, index): Array<{ index: number; object: HomedObject; home: ViewHome }> => {
    const home = object.home;
    if (home.kind === "orphan") return [];
    if (home.kind !== "conversation") return [{ index, object, home }];
    if (homeRows.has(home.channelId)) return object.serverId === actor.serverId ? [{ index, object, home }] : [];
    const projection = recordOf(home.channelId, actor.serverId);
    return projection?.active && recordOf(home.channelId, object.serverId)?.active
      ? [{ index, object, home: { kind: "conversation" as const, channelId: projection.localChannelId } }]
      : [];
  });
  const answers = await answerHomes(actor, asked.map((entry) => entry.home), executor, standing);
  const visible = objects.map(() => false);
  asked.forEach((entry, position) => { visible[entry.index] = answers[position]!; });

  const orphans = objects.flatMap((object, index) => {
    const home = object.home;
    // A conversation home of the actor's server that was soft-deleted, or a
    // joint its server was in but has left (disconnected, its projection
    // deleted, the joint closed).
    const left = home.kind === "conversation" && recordOf(home.channelId, object.serverId)?.active === false;
    const orphaned = home.kind === "orphan"
      ? home.serverId === actor.serverId
      : home.kind === "conversation" && !visible[index] && object.serverId === actor.serverId && (homeRows.get(home.channelId)?.deletedAt != null || left);
    return orphaned ? [{ index, object }] : [];
  });
  if (orphans.length === 0 || !isFullMember(actor, standing)) return visible;
  // A full member here: a person has a role (a delegated actor stands as no member, so never gets here), an agent none.
  const role = roleOf(standing);
  const admin = isAdminOrOwner(role);
  const managedAgentIds = new Set<string>();
  const authorAgentIds = role !== null && !admin
    ? [...new Set(orphans.flatMap(({ object }) => agentIdOf(object.author) ?? []))]
    : [];
  if (authorAgentIds.length > 0) {
    const authorAgents = await executor
      .select({ id: agents.id, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
      .from(agents)
      .where(and(sql`${agents.id} = ANY(${uuidArray(authorAgentIds)})`, eq(agents.serverId, actor.serverId)));
    for (const agent of authorAgents) {
      if (agentManager(agent) === actor.id) managedAgentIds.add(agent.id);
    }
  }
  for (const { index, object } of orphans) {
    visible[index] = (object.author.type === actor.type && object.author.id === actor.id)
      || admin
      || managedAgentIds.has(agentIdOf(object.author) ?? "");
  }
  return visible;
}

/**
 * What canManageHomedObject is asked for: moving the object to a larger
 * home, deleting it, or moderating it (taking it down and restoring it: the
 * server's owners and admins only, never its author or an agent's manager as
 * such).
 */
export type HomedObjectManagement = "widen" | "delete" | "moderate";

/**
 * Whether the actor may manage an object homed in `object.serverId` (move it
 * to a larger home, delete it): its author, the human who manages a live
 * agent author (agentManager), and the server's owners and admins. Only
 * through the object's own server (another server of a joint conversation
 * never may) and only while the actor stands in it: an author who left loses
 * it and the owners and admins take over, as does a deleted agent author's
 * manager. Deleting needs a member of any role (a guest deletes their own)
 * or a live agent; widening shows the object to more people, so it needs a
 * non-guest member or a live agent (a guest never widens, not even their
 * own). Moderating (`moderate`: taking it down, restoring it) is the
 * owners' and admins' alone, its author or an agent's manager never as such.
 * Seeing the object is not part of it: a caller that needs both checks
 * canViewHomedObjects too. Two queries at most.
 */
export async function canManageHomedObject(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  action: HomedObjectManagement,
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean> {
  return (await canManageHomedObjectActions(actor, object, [action], opts))[0]!;
}

/**
 * canManageHomedObject for several actions at once, one answer per action in
 * input order, by the same rule in the same two queries at most (the actor's
 * standing and an agent author's manager read once for all of them).
 */
export async function canManageHomedObjectActions(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  actions: readonly HomedObjectManagement[],
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean[]> {
  if (actions.length === 0 || object.serverId !== actor.serverId) return actions.map(() => false);
  const executor = opts?.executor ?? getDb();
  return manageAnswers(actor, object, actions, executor, await serverStanding(actor, executor));
}

/**
 * canManageHomedObjectActions' answers and, from the same standing read,
 * whether the actor is a non-guest member or a live agent of the object's
 * server (isFullMemberOfOwnServer, for an object of the actor's own server;
 * false, unread, for another server's): for a caller that asks both at once
 * (an Artifact viewer's capabilities, its rename rule among them) in the
 * queries of one.
 */
export async function canManageHomedObjectActionsWithStanding(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  actions: readonly HomedObjectManagement[],
  opts?: { executor?: DatabaseExecutor },
): Promise<{ manages: boolean[]; fullMember: boolean }> {
  if (object.serverId !== actor.serverId) return { manages: actions.map(() => false), fullMember: false };
  const executor = opts?.executor ?? getDb();
  const standing = await serverStanding(actor, executor);
  return { manages: await manageAnswers(actor, object, actions, executor, standing), fullMember: isFullMember(actor, standing) };
}

/** canManageHomedObjectActions' rule, for an object of the actor's own server, on its standing read. */
async function manageAnswers(
  actor: ViewActor,
  object: { serverId: ServerId; author: ViewAuthor },
  actions: readonly HomedObjectManagement[],
  executor: DatabaseExecutor,
  standing: ServerStanding,
): Promise<boolean[]> {
  const none = actions.map(() => false);
  if (actions.length === 0) return none;
  const stands = actions.map((action) => (action === "delete" ? standsInServer(standing) : isFullMember(actor, standing)));
  if (!stands.some(Boolean)) return none;
  // Moderating is the owners' and admins' alone: as its author or an agent's manager, never.
  const unlessModerating = (allowed: boolean, index: number) => allowed && actions[index] !== "moderate";
  const role = roleOf(standing);
  if (isAdminOrOwner(role)) return stands;
  if (object.author.type === actor.type && object.author.id === actor.id) return stands.map(unlessModerating);
  // Beyond its author, only people: a member's role (an agent, and a delegated actor, have none here).
  if (role === null) return none;
  const authorAgent = agentIdOf(object.author);
  if (authorAgent === null) return none;
  const manages = (await agentManagerOf(authorAgent, actor.serverId, { executor })) === actor.id;
  return stands.map((allowed, index) => unlessModerating(allowed && manages, index));
}

/** The human who manages an agent: the owner of a personal assistant, otherwise its human creator. */
function agentManager(agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null }): string | null {
  return agent.assistantOwnerUserId ?? (agent.creatorType === "user" ? agent.creatorId : null);
}

/**
 * The human who manages a live agent of `serverId` (agentManager), by user
 * id; null when it has none (an agent made by an agent) or is no live agent
 * of that server. One query.
 */
export async function agentManagerOf(agentId: string, serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<string | null> {
  const [agent] = await (opts?.executor ?? getDb())
    .select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .limit(1);
  return agent ? agentManager(agent) : null;
}

/**
 * agentManagerOf turned the other way: the live agents of `serverId` whose
 * manager (agentManager) is `userId`, by id: their personal assistant, and
 * the agents they made that are no one's assistant. One query
 * (idx_agents_server_assistant_owner, idx_agents_creator).
 */
export async function agentsManagedBy(userId: string, serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  const rows = await (opts?.executor ?? getDb())
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      or(
        eq(agents.assistantOwnerUserId, userId),
        and(isNull(agents.assistantOwnerUserId), eq(agents.creatorType, "user"), eq(agents.creatorId, userId)),
      ),
    ));
  return rows.map((row) => row.id);
}

/**
 * The live agents of `serverId` that `userId` created (agents.creator), by id:
 * the person Raft records as having made them, one each (an agent made by an
 * agent has none). One query (idx_agents_creator).
 */
export async function agentsCreatedBy(userId: string, serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<string[]> {
  const rows = await (opts?.executor ?? getDb())
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), eq(agents.creatorType, "user"), eq(agents.creatorId, userId)));
  return rows.map((row) => row.id);
}

/**
 * canViewHomedObjects turned the other way: which of many actors can see ONE
 * object, one boolean per actor in input order, in a fixed number of queries
 * per server among the actors (plus one check per guest on a conversation
 * home: filterUsersWithChannelAccess). The same rules, each actor in its own
 * server (`actor.serverId`): public is everyone's; otherwise the actor must
 * stand in its server (a member of any role, or a live agent); a server home
 * is the object's server's non-guest members and live agents; a conversation
 * home is a top-level conversation of the object's server, seen by its
 * actors by the channel rules, or a joint's canonical channel, seen by each
 * server's actors through that server's active projection of the joint
 * (jointHomeProjections) while the object's server is in it too; an orphan
 * (an `orphan` home, a joint the object's server has left, or a soft-deleted home
 * conversation of the object's server) is seen by its author, the author
 * agent's manager and the object's server's owners and admins, guests never.
 * visibility.db.test.ts holds both forms to the same matrix.
 * `requireStanding`: only actors who stand in the object's server, whatever
 * the home (as standsInOwnServer), for callers that name people of the
 * server (mentions, presence).
 */
export async function canActorsViewHomedObject(
  actors: readonly ServerViewActor[],
  homed: HomedObject,
  opts?: { requireStanding?: boolean },
): Promise<boolean[]> {
  let object = homed;
  let home = object.home;
  if (home.kind === "public" && !opts?.requireStanding) return actors.map(() => true);
  const db = getDb();
  const answers = actors.map(() => false);
  const byServer = new Map<ServerId, number[]>();
  actors.forEach((actor, index) => {
    if (opts?.requireStanding && actor.serverId !== object.serverId) return;
    byServer.set(actor.serverId, [...(byServer.get(actor.serverId) ?? []), index]);
  });
  if (byServer.size === 0) return answers;

  // A conversation home: the object's server's own top-level conversation,
  // or else a joint's canonical channel, seen through each server's active
  // projection while the object's server is in the joint, an orphan of the
  // object's server once it has left.
  let row: { serverId: string; type: string; deletedAt: Date | null } | null = null;
  const projectionOf = new Map<ServerId, string>();
  let leftJoint = false;
  if (home.kind === "conversation") {
    [row = null] = await db.select({ serverId: channels.serverId, type: channels.type, deletedAt: channels.deletedAt })
      .from(channels).where(eq(channels.id, home.channelId)).limit(1);
    // The object's own server's projection of a joint: homed in the joint (as canViewHomedObjects).
    if (row?.type === "joint" && row.serverId === object.serverId) {
      const [record] = await jointHomeRecords([object.serverId], { localChannelIds: [home.channelId], executor: db });
      if (record) {
        home = { kind: "conversation", channelId: record.canonicalChannelId };
        object = { ...object, home };
        row = null;
      }
    }
    if (!row || row.serverId !== object.serverId || !TOP_LEVEL_CONVERSATION_TYPES.has(row.type)) {
      row = null;
      const records = await jointHomeRecords([...new Set([...byServer.keys(), object.serverId])], { canonicalChannelIds: [home.channelId], executor: db });
      const publisher = records.find((record) => record.serverId === object.serverId);
      leftJoint = publisher?.active === false;
      if (publisher?.active) {
        for (const record of records) if (record.active) projectionOf.set(record.serverId, record.localChannelId);
      }
    }
  }
  for (const [serverId, indexes] of byServer) {
    let conversation: string | "orphan" | null = null;
    if (home.kind === "conversation") {
      if (row && serverId === object.serverId) {
        conversation = row.deletedAt == null ? home.channelId : "orphan";
      } else if (leftJoint && serverId === object.serverId) {
        conversation = "orphan";
      } else {
        conversation = projectionOf.get(serverId) ?? null;
        if (!conversation) continue;
      }
    } else if (home.kind !== "public" && serverId !== object.serverId) {
      // Another server's server home or orphan.
      continue;
    }
    const seen = await viewersInServer(serverId, indexes.map((index) => actors[index]!), object, conversation);
    indexes.forEach((index, position) => { answers[index] = seen[position]!; });
  }
  return answers;
}

/**
 * canActorsViewHomedObject for the actors of one server `serverId`. A
 * conversation home is `conversation`: a conversation of `serverId` (the
 * home itself, or the server's projection of the joint it names), or
 * "orphan" when the object is an orphan of `serverId`, its own server (its
 * home conversation soft-deleted, or the joint it names left).
 */
async function viewersInServer(
  serverId: ServerId,
  actors: readonly ViewAuthor[],
  object: HomedObject,
  conversation: string | "orphan" | null,
): Promise<boolean[]> {
  const db = getDb();
  const userIds = [...new Set(actors.flatMap((actor) => (agentIdOf(actor) === null ? [actor.id] : [])))];
  const agentIds = [...new Set(actors.flatMap((actor) => agentIdOf(actor) ?? []))];
  // Standing, as serverStanding: a human's role (getMemberRole: a live server), a live agent of the server.
  const [roleRows, liveRows] = await Promise.all([
    userIds.length === 0 ? [] : db.select({ userId: serverMembers.userId, role: serverMembers.role }).from(serverMembers)
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, userIds), isNull(servers.deletedAt))),
    agentIds.length === 0 ? [] : db.select({ id: agents.id }).from(agents)
      .where(and(inArray(agents.id, agentIds), eq(agents.serverId, serverId), isNull(agents.deletedAt))),
  ]);
  const roles = new Map(roleRows.map((row) => [row.userId, row.role as ServerRole]));
  const live = new Set(liveRows.map((row) => row.id));
  const standingOf = (actor: ViewAuthor): ServerStanding => {
    switch (actor.type) {
      case "user": return { type: "user", role: roles.get(actor.id) ?? null };
      case "agent": return { type: "agent", live: live.has(actor.id) };
    }
  };
  const stands = (actor: ViewAuthor) => standsInServer(standingOf(actor));
  const fullMember = (actor: ViewAuthor) => {
    const standing = standingOf(actor);
    switch (standing.type) {
      case "user": return standing.role !== null && !isGuestRole(standing.role);
      case "agent": return standing.live;
    }
  };

  const home = object.home;
  if (home.kind === "public") return actors.map(stands);
  if (home.kind === "server") return actors.map((actor) => home.serverId === serverId && fullMember(actor));
  if (home.kind === "orphan" && home.serverId !== serverId) return actors.map(() => false);

  if (home.kind === "conversation") {
    if (!conversation) return actors.map(() => false);
    if (conversation !== "orphan") {
      const [users, agentsSeeing] = await Promise.all([
        filterUsersWithChannelAccess(conversation, userIds.filter((id) => roles.has(id)), serverId),
        filterAgentsWithChannelAccess(conversation, agentIds.filter((id) => live.has(id))),
      ]);
      return actors.map((actor) => stands(actor) && (agentIdOf(actor) === null ? users.has(actor.id) : agentsSeeing.has(actor.id)));
    }
  }
  // An orphan of `serverId`, the object's server.
  let manager: string | null = null;
  const authorAgent = agentIdOf(object.author);
  if (authorAgent !== null) {
    const [author] = await db.select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
      .from(agents).where(and(eq(agents.id, authorAgent), eq(agents.serverId, serverId))).limit(1);
    manager = author ? agentManager(author) : null;
  }
  return actors.map((actor) => fullMember(actor) && (
    (actor.type === object.author.type && actor.id === object.author.id)
    || (agentIdOf(actor) === null && (isAdminOrOwner(roles.get(actor.id)) || (authorAgent !== null && manager === actor.id)))
  ));
}

async function filterVisibleChannelIds(actor: ViewActor, channelIds: readonly string[], executor: DatabaseExecutor): Promise<Set<string>> {
  switch (actor.type) {
    case "user":
      return filterUserAccessibleChannelIds(channelIds, actor.id, actor.serverId, { executor });
    case "agent":
      return filterAgentAccessibleChannelIds(channelIds, actor.id, actor.serverId, { executor });
    case "delegated": {
      const ownerVisible = await filterUserAccessibleChannelIds(channelIds, actor.id, actor.serverId, { executor });
      return withoutUnreadableOwnerDms(actor, ownerVisible, executor);
    }
    default:
      return assertNeverViewActor(actor);
  }
}

/**
 * The owner-visible ids a delegated actor may still read: DM-scoped ones
 * (a DM, or a thread or task conversation under one) only when the owner lets
 * the assistant read DMs, and never the assistant's own DM with the owner.
 * Read live on every call (the owner's switch takes effect on the next read).
 * An unresolvable DM scope fails closed (dmScopeOf).
 */
async function withoutUnreadableOwnerDms(
  actor: Extract<ViewActor, { type: "delegated" }>,
  visible: Set<string>,
  executor: DatabaseExecutor,
): Promise<Set<string>> {
  if (visible.size === 0) return visible;
  const policy = await readableOwnerDmPolicy({ agentId: actor.agentId, serverId: actor.serverId, ownerUserId: actor.id });
  const rows = await executor
    .select({ id: channels.id, serverId: channels.serverId, type: channels.type, parentMessageId: channels.parentMessageId, parentChannelId: channels.parentChannelId })
    .from(channels)
    .where(inArray(channels.id, [...visible]));
  const kept = new Set<string>();
  for (const row of rows) {
    const scope = await dmScopeOf(row);
    if (!scope.dm) { kept.add(row.id); continue; }
    if (policy !== null && scope.rootChannelId !== null && scope.rootChannelId !== policy.excludedRootChannelId) kept.add(row.id);
  }
  return kept;
}

/**
 * The visible conversations of `actor.serverId` (see VisibleRoots), in a
 * constant number of queries. Candidates are a superset read through indexes
 * (every public and joint channel of the server, the actor's own membership
 * rows, the server's joint thread projections); canView's rules decide.
 * A human who is not a member of the server sees nothing here.
 */
export async function visibleRootChannelIds(
  actor: ViewActor,
  opts?: {
    executor?: DatabaseExecutor;
    /**
     * false: only the top-level roots. Skips the parentless-thread candidates
     * and the joint storage map (parentlessThreadIds and jointStorageByLocalId
     * come back empty), for callers that never read thread or joint content
     * through these roots (the task board). Default true.
     */
    includeThreads?: boolean;
  },
): Promise<VisibleRoots> {
  const db = opts?.executor ?? getDb();
  const includeThreads = opts?.includeThreads ?? true;
  // Reject absent humans before reading candidates, matching canView's
  // current server-membership requirement. Agents are pinned to their own
  // server by filterAgentAccessibleChannelIds. A delegated actor's
  // candidates are its owner's.
  const { membership, actorInServer } = candidateScope(actor);
  const result = await db.execute(sql`
    SELECT candidate.id::text AS id, candidate.type, candidate.name, candidate.archived_at
    FROM (
      SELECT c.id, c.type, c.name, c.archived_at
      FROM ${channels} c
      WHERE c.server_id = ${actor.serverId}
        AND c.type IN ('channel', 'joint')
        AND c.deleted_at IS NULL
      UNION
      SELECT c.id, c.type, c.name, c.archived_at
      FROM ${channels} c
      WHERE c.id IN (${membership})
        AND c.server_id = ${actor.serverId}
        AND c.deleted_at IS NULL
        AND (c.type IN ('private', 'dm')${includeThreads ? sql` OR (c.type = 'thread' AND c.parent_message_id IS NULL)` : sql``})
      ${includeThreads ? sql`UNION
      SELECT c.id, c.type, c.name, c.archived_at
      FROM ${jointChannelServers} projection
      JOIN ${channels} c
        ON c.id = projection.local_channel_id
      WHERE projection.server_id = ${actor.serverId}
        AND projection.status = 'active'
        AND c.type = 'thread'
        AND c.deleted_at IS NULL` : sql``}
    ) candidate
    WHERE ${actorInServer}
    ORDER BY candidate.name, candidate.id
  `);
  const candidates = result.rows as Array<{ id: string; type: VisibleRootType | "thread"; name: string; archived_at: Date | string | null }>;
  const visible = await filterVisibleChannelIds(actor, candidates.map((candidate) => candidate.id), db);

  const roots: VisibleRoot[] = [];
  const parentlessThreadIds: string[] = [];
  for (const candidate of candidates) {
    if (!visible.has(candidate.id)) continue;
    if (candidate.type === "thread") parentlessThreadIds.push(candidate.id);
    else roots.push({ id: candidate.id, type: candidate.type, name: candidate.name, archivedAt: candidate.archived_at == null ? null : new Date(candidate.archived_at) });
  }

  const jointLocalIds = !includeThreads ? [] : [
    ...roots.filter((root) => root.type === "joint").map((root) => root.id),
    ...parentlessThreadIds,
  ];
  const jointStorageByLocalId = new Map<string, string>();
  if (jointLocalIds.length > 0) {
    const rows = await db
      .select({ localChannelId: jointChannelServers.localChannelId, canonicalChannelId: jointChannels.canonicalChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        sql`${jointChannelServers.localChannelId} = ANY(${uuidArray(jointLocalIds)})`,
        eq(jointChannelServers.serverId, actor.serverId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      ));
    for (const row of rows) jointStorageByLocalId.set(row.localChannelId, row.canonicalChannelId);
  }
  return { serverId: actor.serverId, roots, parentlessThreadIds, jointStorageByLocalId };
}

function candidateScope(actor: ViewActor): { membership: SQL; actorInServer: SQL } {
  switch (actor.type) {
    case "user":
    case "delegated":
      return {
        membership: sql`SELECT member.channel_id FROM ${channelHumans} member WHERE member.user_id = ${actor.id}`,
        actorInServer: sql`EXISTS (SELECT 1 FROM ${serverMembers} sm WHERE sm.server_id = ${actor.serverId} AND sm.user_id = ${actor.id})`,
      };
    case "agent":
      return {
        membership: sql`SELECT member.channel_id FROM ${channelAgents} member WHERE member.agent_id = ${actor.id}`,
        actorInServer: sql`TRUE`,
      };
    default:
      return assertNeverViewActor(actor);
  }
}

/**
 * The ids a row's COALESCE(parent_channel_id, id) is matched against: the
 * visible roots, the visible parentless threads, and (for content queries)
 * the canonical storage channels of the visible joint roots, whose canonical
 * threads carry that storage channel as their parent_channel_id.
 */
export function visibleConversationRootIds(roots: VisibleRoots): string[] {
  const ids = new Set<string>();
  for (const root of roots.roots) {
    ids.add(root.id);
    const storage = root.type === "joint" ? roots.jointStorageByLocalId.get(root.id) : undefined;
    if (storage) ids.add(storage);
  }
  for (const id of roots.parentlessThreadIds) ids.add(id);
  return [...ids];
}

/**
 * The list form of canView, as a SQL condition: the row whose channel id and
 * parent channel id are these columns is visible iff COALESCE(parent, id) is
 * among `visibleConversationRootIds(roots)`.
 *
 * Written as `id = ANY(ids) OR parent = ANY(ids)`, the same rows (a row with a
 * parent is a thread and a thread is never in the id list), so each arm can
 * use an index (the primary key; idx_channels_thread_parent_channel when the
 * caller also states `type = 'thread' AND deleted_at IS NULL`). The ids are
 * one array parameter, not one bind parameter per id.
 *
 * Only visibility: callers still apply their own deleted_at (a deleted thread
 * under a visible root is not visible to canView) and archived filters.
 */
export function visibleConversationSql(roots: VisibleRoots, channelIdColumn: SQLWrapper, parentChannelIdColumn: SQLWrapper): SQL {
  const ids = uuidArray(visibleConversationRootIds(roots));
  return sql`(${channelIdColumn} = ANY(${ids}) OR ${parentChannelIdColumn} = ANY(${ids}))`;
}

/** One `uuid[]` parameter. */
export function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/**
 * VisibleRoots narrowed to `allowedRootChannelIds` (the guest search prefilter):
 * a root, a parentless thread or a joint storage mapping stays only when its
 * own local id is allowed. Never widens.
 */
export function intersectVisibleRoots(roots: VisibleRoots, allowedRootChannelIds: readonly string[]): VisibleRoots {
  const allowed = new Set(allowedRootChannelIds);
  return {
    serverId: roots.serverId,
    roots: roots.roots.filter((root) => allowed.has(root.id)),
    parentlessThreadIds: roots.parentlessThreadIds.filter((id) => allowed.has(id)),
    jointStorageByLocalId: new Map([...roots.jointStorageByLocalId].filter(([localId]) => allowed.has(localId))),
  };
}
