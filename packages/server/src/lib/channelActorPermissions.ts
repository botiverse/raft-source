import { withChannelWriterFence } from "../services/channelConversionFenceService";
import { assertJointLifecycleUnchanged, lockJointLifecycleOfChannel } from "../services/jointLifecycleLock";
import {
  EXTERNAL_CHANNELS_FEATURE_FLAG_KEY,
  canAddChannelMembers,
  channelSupportsRoles,
  getChannelAdminBasis,
  hasEffectiveChannelCapability,
  type ChannelAdminBasis,
  type ChannelActorAdmissionClass,
  type ChannelRole,
  type ServerCapability,
  type ServerRole,
} from "@botiverse/raft-shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentLounges, agents, appBotBindings, channelAgents, channelHumans, channels, oauthClientInstalls, oauthClients, serverMembers } from "../db/schema";
import { resolveJointHumanMembershipScopes, filterJointHumanMemberEntries, filterJointActiveEntries, filterJointHostSidesEmpty, filterJointPendingRemovalEntries, acquireJointSourceExitFlagReadLock } from "../services/jointHumanMembershipAccess";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { acquireServerAdmissionLocks } from "../services/planService";
import { resolveActorContext, type ActorContextType } from "./actorPermissions";
import { JointActorUnavailableError, lockJointUsersFirst, withJointUsersGuessed } from "../services/jointHumanMembershipMirror";

export class JointChannelAccessChangedError extends Error {
  readonly status=403;
  readonly code="channel_access_changed";
  constructor(){super("Your access to this channel changed. Refresh and retry.");this.name="JointChannelAccessChangedError";}
}

export interface ChannelActorContext {
  /**
   * `hostCannotDisconnect`: the host entry, with external_channels_v1 on for
   * it (the server is the host's here), may not disconnect (disconnectJointChannel).
   */
  jointAuthority?: {
    isHostEntry: boolean;
    inherited: boolean;
    appointed: boolean;
    hostCannotDisconnect: boolean;
    /**
     * Read only for a host owner/admin (a person) outside an archived host
     * copy: the joint's host side is empty (jointHostSideMembersSql), so they
     * may unarchive it and rejoin. False otherwise.
     */
    recoverableByHostAdmin: boolean;
  };
  actorType: ActorContextType;
  actorId: string;
  serverId: string;
  channelId: string;
  channelType: string;
  channelName: string;
  channelArchivedAt: Date | null;
  channelDeletedAt: Date | null;
  serverRole: ServerRole | null;
  channelRole: ChannelRole | null;
  channelAuthorityRevision: number | null;
  isChannelMember: boolean;
  canAccessChannel: boolean;
  supportsChannelRoles: boolean;
  admissionClass: ChannelActorAdmissionClass;
  channelAdminBasis: ChannelAdminBasis;
  /**
   * Agent Lounge (#proj-chat:#15): an agent acting on a lounge, its own or
   * another's. No agent manages a lounge (archive, edit, add or remove
   * members, roles): that is server admins' moderation.
   */
  agentLounge?: true;
}

export async function resolveChannelActorContext(
  serverId: string,
  channelId: string,
  actorType: ActorContextType,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ChannelActorContext | null> {
  const contexts = await resolveChannelActorContextsMany(serverId, [channelId], actorType, actorId, executor);
  return contexts.get(channelId) ?? null;
}

/**
 * resolveChannelActorContext for many channels of one server in three queries
 * (the channels, the actor's server role, the actor's memberships), whatever
 * the number of channels. The single entry point of the rule: a channel list
 * resolved each channel on its own under Promise.all, three queries apiece, and
 * one request borrowed up to 381 pool connections (prod 2026-10-06). Channels
 * that do not resolve (missing, another server, or no server role) are absent.
 */
export async function resolveChannelActorContextsMany(
  serverId: string,
  channelIds: readonly string[],
  actorType: ActorContextType,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, ChannelActorContext>> {
  const contexts = new Map<string, ChannelActorContext>();
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return contexts;
  const db = executor;
  const channelRows = await db.select({
    id: channels.id,
    serverId: channels.serverId,
    name: channels.name,
    type: channels.type,
    archivedAt: channels.archivedAt,
    deletedAt: channels.deletedAt,
  }).from(channels).where(and(inArray(channels.id, ids), eq(channels.serverId, serverId)));
  if (channelRows.length === 0) return contexts;
  const actor = await resolveActorContext(serverId, actorType, actorId, executor);
  if (!actor.serverRole) return contexts;

  const foundIds = channelRows.map((channel) => channel.id);
  const memberships = actorType === "agent"
    ? await db.select({ channelId: channelAgents.channelId, role: channelAgents.role, authorityRevision: channelAgents.authorityRevision })
      .from(channelAgents)
      .where(and(inArray(channelAgents.channelId, foundIds), eq(channelAgents.agentId, actorId)))
    : await db.select({ channelId: channelHumans.channelId, role: channelHumans.role, authorityRevision: channelHumans.authorityRevision })
      .from(channelHumans)
      .where(and(inArray(channelHumans.channelId, foundIds), eq(channelHumans.userId, actorId)));
  const membershipByChannel = new Map(memberships.map((membership) => [membership.channelId, membership]));
  const loungeIds = actorType === "agent"
    ? new Set((await db.select({ channelId: agentLounges.channelId })
      .from(agentLounges)
      .where(inArray(agentLounges.channelId, foundIds))).map((row) => row.channelId))
    : new Set<string>();

  const jointScopes = await resolveJointHumanMembershipScopes({ localChannelIds: channelRows.filter(row => row.type === "joint").map(row => row.id) }, db);
  const jointScopeList = [...jointScopes.values()];
  const activeJointEntries = await filterJointActiveEntries(jointScopeList, db);
  const qualifiedEntries = actorType === "user"
    ? await filterJointHumanMemberEntries(jointScopeList, actorId, db)
    : await filterJointActiveEntries(jointScopeList, db);
  const pendingEntries = await filterJointPendingRemovalEntries([...jointScopes.values()], actorType, actorId, db);
  // Read once per batch, and only when it holds a host entry.
  const hostCannotDisconnect = jointScopeList.some((scope) => scope.entryServerId === scope.hostServerId)
    && (await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId, userId: actorType === "user" ? actorId : null }, db)).enabled;
  // P3: a Guest is in a joint channel only through the host projection it is
  // bound to, with the host's external_channels_v1 on.
  const guestChannelId = actorType === "user" && actor.serverRole === "guest" && jointScopes.size > 0
    ? (await db.select({ guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, actorId), eq(serverMembers.role, "guest")))
      .limit(1))[0]?.guestChannelId ?? null
    : null;
  // An archived host copy whose host side is empty, for a host owner/admin
  // outside it: they may bring it back (channelActorHasCapability). Read only
  // for those candidates.
  const hostAdminUser = actorType === "user" && (actor.serverRole === "owner" || actor.serverRole === "admin");
  const recoveryCandidates = hostAdminUser
    ? jointScopeList.filter((scope) => scope.entryServerId === scope.hostServerId
      && activeJointEntries.has(scope.localChannelId)
      && (!qualifiedEntries.has(scope.localChannelId) || pendingEntries.has(scope.localChannelId))
      && channelRows.some((row) => row.id === scope.localChannelId && row.archivedAt !== null && row.deletedAt === null))
    : [];
  const emptyHostSides = await filterJointHostSidesEmpty(recoveryCandidates.map((scope) => scope.jointId), db);
  const recoverableEntries = new Set<string>(recoveryCandidates.filter((scope) => emptyHostSides.has(scope.jointId)).map((scope) => scope.localChannelId));
  for (const channel of channelRows) {
    const membership = membershipByChannel.get(channel.id);
    const scope = jointScopes.get(channel.id);
    // A joint projection: J membership and the host's authority decide,
    // never this projection's CH row alone.
    const joint = scope !== undefined;
    const guestJointRefused = channel.type === "joint" && actor.serverRole === "guest"
      && !(scope?.guestEntryEnabled && scope.entryServerId === scope.hostServerId && guestChannelId === channel.id);
    const isChannelMember = !guestJointRefused && (channel.type !== "joint" || activeJointEntries.has(channel.id)) && !pendingEntries.has(channel.id) && (joint
      ? qualifiedEntries.has(channel.id) && (actorType === "user" || Boolean(membership))
      : Boolean(membership));
    const supportsChannelRoles = channelSupportsRoles(channel.type, channel.name);
    const canAccessChannel = channel.type === "channel"
      ? true
      : channel.type === "private" || channel.type === "joint"
        ? isChannelMember
        : false;
    const isHostEntry = joint && scope.entryServerId === scope.hostServerId;
    const jointAuthority = joint ? {
      isHostEntry,
      hostCannotDisconnect: isHostEntry && hostCannotDisconnect,
      inherited: actor.serverRole === "owner" || actor.serverRole === "admin",
      appointed: membership?.role === "admin",
      recoverableByHostAdmin: recoverableEntries.has(channel.id),
    } : undefined;
    const channelRole = (joint && !jointAuthority?.isHostEntry ? null
      : joint && membership?.role === "admin" && !jointAuthority?.appointed ? "member"
      : membership?.role ?? null) as ChannelRole | null;

    contexts.set(channel.id, {
      jointAuthority,
      actorType,
      actorId,
      serverId,
      channelId: channel.id,
      channelType: channel.type,
      channelName: channel.name,
      channelArchivedAt: channel.archivedAt,
      channelDeletedAt: channel.deletedAt,
      serverRole: actor.serverRole,
      channelRole,
      channelAuthorityRevision: membership?.authorityRevision ?? null,
      isChannelMember,
      canAccessChannel,
      supportsChannelRoles,
      admissionClass: actor.serverRole === "guest" ? "guest" : "current_member",
      channelAdminBasis: joint && (!jointAuthority?.isHostEntry || !isChannelMember) ? null : getChannelAdminBasis({
        serverRole: actor.serverRole,
        channelRole,
        isChannelMember,
        supportsChannelRoles,
      }),
      ...(loungeIds.has(channel.id) ? { agentLounge: true as const } : {}),
    });
  }
  return contexts;
}

export function channelActorHasCapability(
  context: ChannelActorContext,
  capability: ServerCapability,
  memberTargetType: "user" | "agent" = "user",
): boolean {
  if (context.agentLounge) return false;
  if (context.jointAuthority) {
    if (context.serverRole === "guest" || context.channelDeletedAt) return false;
    const { isHostEntry, inherited, appointed, hostCannotDisconnect, recoverableByHostAdmin } = context.jointAuthority;
    if (!context.canAccessChannel) {
      // The one exception for someone outside the channel: a host owner/admin
      // (a person) may unarchive the host's archived copy when nobody from the
      // host is left in it; the unarchive rejoins them (POST /:id/unarchive).
      return capability === "archiveChannels" && context.actorType === "user"
        && isHostEntry && inherited && recoverableByHostAdmin && context.channelArchivedAt !== null;
    }
    if (capability === "addChannelMembers") return context.channelArchivedAt === null;
    if (capability === "removeChannelMembers") return isHostEntry ? inherited || appointed : memberTargetType === "agent" && inherited;
    if (capability === "changeChannelMemberRoles") return isHostEntry && inherited;
    if (capability === "editChannelMetadata" || capability === "archiveChannels") {
      return isHostEntry && (inherited || appointed);
    }
    // A Guest in a joint channel (P3) manages nothing (guard above). External server invites
    // belong to host owner/admin, never an explicit manager or another entry.
    if (capability === "federateChannels") return isHostEntry && inherited;
    // A joint channel is never deleted: its "delete" is disconnecting this
    // entry's server (POST /channels/:id/disconnect, disconnectJointChannel),
    // which each connected server's own owner/admin may do; with
    // external_channels_v1 on for the host, not the host's
    // (JointHostDisconnectError).
    if (capability === "deleteChannels") return !hostCannotDisconnect && inherited;
    return false;
  }
  if (capability === "addChannelMembers") {
    return canAddChannelMembers({
      serverRole: context.serverRole,
      admissionClass: context.admissionClass,
      isChannelMember: context.isChannelMember,
      channelType: context.channelType,
      channelName: context.channelName,
      archived: context.channelArchivedAt !== null,
      deleted: context.channelDeletedAt !== null,
    });
  }
  return context.canAccessChannel && hasEffectiveChannelCapability({
    serverRole: context.serverRole,
    channelRole: context.channelRole,
    isChannelMember: context.isChannelMember,
    supportsChannelRoles: context.supportsChannelRoles,
    capability,
    channelType: context.channelType,
  });
}

export async function actorHasChannelCapability(
  serverId: string,
  channelId: string,
  actorType: ActorContextType,
  actorId: string,
  capability: ServerCapability,
  executor: DatabaseExecutor = getDb(),
  memberTargetType: "user" | "agent" = "user",
): Promise<boolean> {
  const context = await resolveChannelActorContext(
    serverId,
    channelId,
    actorType,
    actorId,
    executor,
  );
  return context ? channelActorHasCapability(context, capability, memberTargetType) : false;
}

export async function withLockedChannelActorCapability<T>(
  input: {
    serverId: string;
    channelId: string;
    actorType: ActorContextType;
    actorId: string;
    capability: ServerCapability;
    humanSubjectIds?: readonly string[];
    memberTargetType?: "user" | "agent";
    admissionServerIds?: readonly string[];
    guessUserIds?: () => Promise<readonly string[]>;
  },
  callback: (executor: DatabaseExecutor, context: ChannelActorContext, lockedUserIds: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  return withLockedChannelActorCapabilities({
    ...input,
    capabilities: [input.capability],
  }, callback);
}

export async function withLockedChannelActorCapabilities<T>(
  input: {
    serverId: string;
    channelId: string;
    actorType: ActorContextType;
    actorId: string;
    capabilities: readonly ServerCapability[];
    humanSubjectIds?: readonly string[];
    memberTargetType?: "user" | "agent";
    /**
     * Servers whose SERVER_MEMBERSHIP_ADMISSION locks the write takes first,
     * right after the conversion fence (ADMISSION_LOCK_ORDER rule 1): an
     * unarchive, which the free plan's external channel rule checks.
     */
    admissionServerIds?: readonly string[];
    /**
     * More people the write names, known for sure only under the locks (an
     * archive's bound Guests): read unlocked here, locked first with the
     * actor and the subjects, and re-read by the callback under its locks
     * against the set it is given (assertJointUsersLocked; a grown set
     * restarts the transaction).
     */
    guessUserIds?: () => Promise<readonly string[]>;
  },
  callback: (executor: DatabaseExecutor, context: ChannelActorContext, lockedUserIds: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  const globalProjectionWrite = input.capabilities.some(capability => capability === "archiveChannels" || capability === "editChannelMetadata");
  const actorUserId = input.actorType === "user" ? input.actorId : null;
  return withJointUsersGuessed(async () => [actorUserId, ...(input.humanSubjectIds ?? []), ...(await input.guessUserIds?.() ?? [])], (lockedUserIds) => withChannelWriterFence(input.channelId, async (tx) => {
    // The users rows the write names first (lockJointUsersFirst): the acting
    // person, the people it adds or removes (humanSubjectIds) and those it
    // guessed, before the admission, lifecycle, channel, server and member
    // locks below: an FK check taking one of them only at the write closes a
    // cycle with that person's account deletion (users row FOR UPDATE, then
    // the servers they own; #wg-rbac:#53). An acting person retired or being
    // deleted is refused as one without the capability.
    await lockJointUsersFirst(tx, { actorUserId, userIds: [...lockedUserIds] }).catch((err: unknown) => {
      if (err instanceof JointActorUnavailableError) throw new Error("Channel capability required");
      throw err;
    });
    if (input.admissionServerIds?.length) await acquireServerAdmissionLocks(tx, input.admissionServerIds);
    // A write to every projection of a joint takes the joint's lifecycle lock
    // before any channel row (jointLifecycleLock.ts).
    const lifecycle = globalProjectionWrite ? await lockJointLifecycleOfChannel(tx, input.channelId) : null;
    // An archive (archiveChannels) changes no key column and ends the bound
    // Guests' memberships after its channel rows: it locks them FOR NO KEY
    // UPDATE, which still serializes every channel writer (FOR SHARE and up)
    // but never makes a reader's FOR KEY SHARE wait. A Guest's read mutation
    // takes its member row before the channel's FOR KEY SHARE (the admission
    // fence, Task #93); with FOR UPDATE here that read and the archive's
    // Guest member lock would wait on each other (P3, Cody on PR #13205).
    // Likewise removing a member of a joint channel (removeHuman), which
    // never deletes the joint row; an ordinary channel keeps FOR UPDATE (an
    // emptied private channel may be deleted). The type read is unlocked:
    // only a conversion changes it, and the writer fence above excludes one.
    const archive = input.capabilities.includes("archiveChannels");
    const jointRemoval = input.capabilities.includes("removeChannelMembers")
      && (await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, input.channelId)).limit(1))[0]?.type === "joint";
    const [lockedChannel] = await tx.select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, input.serverId)))
      .for(archive || jointRemoval ? "no key update" : "update")
      .limit(1);
    if (!lockedChannel) throw new Error("Channel not found");
    if (globalProjectionWrite) await assertJointLifecycleUnchanged(tx, input.channelId, lifecycle);

    // An archive ends the joint's bound Guests' server memberships
    // (closeArchivedJointToExternalPeople): their member rows are locked here,
    // before J, as every server member removal takes them (P3).
    await lockComputedJointActor({ ...input, globalProjectionWrite, lockBoundGuests: archive }, tx);
    const context = await resolveChannelActorContext(
      input.serverId,
      input.channelId,
      input.actorType,
      input.actorId,
      tx,
    );
    if (!context || !input.capabilities.every((capability) => channelActorHasCapability(context, capability, input.memberTargetType))) {
      throw new Error("Channel capability required");
    }
    return callback(tx, context, lockedUserIds);
  }));
}

/**
 * P3: the server member rows of every Guest bound to a projection of joint J,
 * in the global order channel -> server -> member -> J (removeHuman,
 * removeMemberInTransaction): servers FOR SHARE, then the members FOR UPDATE,
 * by server id then user id. The caller holds every active projection's
 * channel row FOR UPDATE, so the set read here cannot grow before commit: a
 * Guest is bound only by accepting an external invite, which locks the
 * projection's channel row first (acceptExternalInviteAsGuest), and no role
 * transition binds one. A Guest removed meanwhile is re-checked under its
 * lock (onlyIfGuestBoundTo).
 */
export async function lockBoundJointGuestMemberships(tx: DatabaseExecutor, jointId: string): Promise<string[]> {
  const keys = await boundJointGuestKeys(tx, jointId);
  const byServer = new Map<string, string[]>();
  for (const key of keys) {
    const [serverId, userId] = key.split("/") as [string, string];
    byServer.set(serverId, [...(byServer.get(serverId) ?? []), userId]);
  }
  for (const serverId of [...byServer.keys()].sort()) {
    await tx.execute(sql`SELECT id FROM servers WHERE id=${serverId}::uuid FOR SHARE`);
    const ids = [...new Set(byServer.get(serverId)!)].sort();
    await tx.execute(sql`SELECT user_id FROM server_members WHERE server_id=${serverId}::uuid
      AND user_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY user_id FOR UPDATE`);
  }
  return keys;
}

/** `server/user` of each Guest bound to a projection of J, sorted. */
async function boundJointGuestKeys(tx: DatabaseExecutor, jointId: string): Promise<string[]> {
  const rows = await tx.execute<{ serverId: string; userId: string }>(sql`
    SELECT sm.server_id AS "serverId", sm.user_id AS "userId" FROM server_members sm
    JOIN joint_channel_servers p ON p.local_channel_id=sm.guest_channel_id AND p.server_id=sm.server_id
    WHERE p.joint_channel_id=${jointId}::uuid AND sm.role='guest'`);
  return rows.rows.map((row) => `${row.serverId}/${row.userId}`).sort();
}

/** Channel -> own current server/member -> flag -> J. Pin the source-exit mode
 * and J membership through commit, so a removed manager cannot finish a queued
 * mutation using a preflight role. Do not acquire CH rows before this lock. */
export async function lockComputedJointActor(
  input: { serverId: string; channelId: string; actorType: ActorContextType; actorId: string; humanSubjectIds?: readonly string[]; globalProjectionWrite?: boolean; lockBoundGuests?: boolean },
  tx: DatabaseExecutor,
) {
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [input.channelId] }, tx)).get(input.channelId);
  if (!scope) return;
  // The source-exit flag is pinned after every row lock below, right before
  // J; the caller's authority is evaluated after.
  let lockedGuests: string[] | null = null;
  if (input.globalProjectionWrite) {
    // Only the host may mutate shared metadata.
    if (scope.entryServerId !== scope.hostServerId) throw new Error("Channel capability required");
    lockedGuests = await lockJointProjectionWrite(tx, scope.jointId, { lockBoundGuests: input.lockBoundGuests === true });
  }
  // Source server/member locks precede J. The current-generation source check
  // runs under J; it needs no fence on an unrelated, absent host identity.
  const servers = [input.serverId];
  for (const serverId of servers) await tx.execute(sql`SELECT id FROM servers WHERE id=${serverId}::uuid FOR SHARE`);
  for (const serverId of servers) {
    const ids = [...new Set([...(input.humanSubjectIds ?? []), ...(input.actorType === "user" && serverId === input.serverId ? [input.actorId] : [])])].sort();
    if (ids.length) await tx.execute(sql`SELECT user_id FROM server_members WHERE server_id=${serverId}::uuid
      AND user_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}) ORDER BY user_id FOR SHARE`);
  }
  if (input.actorType === "agent") {
    await tx.execute(sql`SELECT agent_id FROM server_agent_members WHERE server_id=${input.serverId}::uuid AND agent_id=${input.actorId}::uuid FOR SHARE`);
  }
  // Flag pinned; ordinary (non-joint) writes do not take these additional locks.
  await acquireJointSourceExitFlagReadLock(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${scope.jointId}`},0))`);
  if (lockedGuests) await assertBoundJointGuestsUnchanged(tx, scope.jointId, lockedGuests);
}

/**
 * A write to every projection of joint J (archive, metadata), after the
 * joint's lifecycle lock and the entry's channel row, BEFORE J: every active
 * projection's channel row, sorted (otherwise a B membership writer holding
 * B's row while waiting for J deadlocks a host archive trying to update B),
 * and for an archive (`lockBoundGuests`, FOR NO KEY UPDATE) the bound Guests'
 * member rows. Returns the locked Guests for assertBoundJointGuestsUnchanged
 * under J, or null. Shared by the archive route and the joint host-side
 * archive task.
 */
export async function lockJointProjectionWrite(tx: DatabaseExecutor, jointId: string, options: { lockBoundGuests: boolean }): Promise<string[] | null> {
  await tx.execute(sql`SELECT c.id FROM joint_channel_servers p JOIN channels c ON c.id=p.local_channel_id
    WHERE p.joint_channel_id=${jointId}::uuid AND p.status='active' ORDER BY c.id
    ${sql.raw(options.lockBoundGuests ? "FOR NO KEY UPDATE" : "FOR UPDATE")} OF c`);
  return options.lockBoundGuests ? lockBoundJointGuestMemberships(tx, jointId) : null;
}

/** Under J: the bound Guests are still exactly the locked set (it cannot
 * grow while the projection rows are held; see lockBoundJointGuestMemberships). */
export async function assertBoundJointGuestsUnchanged(tx: DatabaseExecutor, jointId: string, lockedGuests: readonly string[]): Promise<void> {
  if ((await boundJointGuestKeys(tx, jointId)).some((key) => !lockedGuests.includes(key))) {
    throw new JointChannelAccessChangedError();
  }
}

/** Authorize an App Bot only for its explicitly joined joint entry. This does
 * not create or infer general server membership or grant channel management. */
async function lockManagedBotJointPosting(input: { serverId: string; channelId: string; agentId: string }, tx: DatabaseExecutor): Promise<boolean> {
  // Hints are untrusted until revalidated under the lifecycle's client-first
  // locks. Credential issuance also locks the client before the installation.
  const [hint] = await tx.select({ installId: agents.managedByAppInstallId, clientId: oauthClientInstalls.clientId }).from(agents)
    .innerJoin(oauthClientInstalls, eq(oauthClientInstalls.id, agents.managedByAppInstallId))
    .where(eq(agents.id, input.agentId)).limit(1);
  if (!hint?.installId || !hint.clientId) return false;
  const [client] = await tx.select().from(oauthClients).where(eq(oauthClients.id, hint.clientId)).limit(1).for("share");
  if (!client || !client.enabled || !client.enableBot) return false;
  const [install] = await tx.select().from(oauthClientInstalls).where(and(eq(oauthClientInstalls.id, hint.installId),
    eq(oauthClientInstalls.clientId, client.id))).limit(1).for("share");
  if (!install || install.serverId !== input.serverId || install.status !== "active" || install.botGrant !== "granted") return false;
  const [binding] = await tx.select().from(appBotBindings).where(and(eq(appBotBindings.installId, install.id),
    eq(appBotBindings.agentId, input.agentId), eq(appBotBindings.serverId, input.serverId), eq(appBotBindings.state, "active")))
    .limit(1).for("share");
  if (!binding) return false;
  const [agent] = await tx.select().from(agents).where(eq(agents.id, input.agentId)).limit(1).for("share");
  if (!agent || agent.serverId !== input.serverId || agent.managedByAppInstallId !== install.id || agent.deletedAt) return false;
  const [member] = await tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, input.channelId),
    eq(channelAgents.agentId, input.agentId))).limit(1).for("share");
  if (!member) return false;
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [input.channelId] }, tx)).get(input.channelId);
  if (!scope || scope.entryServerId !== input.serverId) return false;
  const active = await filterJointActiveEntries([scope], tx);
  const pending = await filterJointPendingRemovalEntries([scope], "agent", input.agentId, tx);
  return active.has(input.channelId) && !pending.has(input.channelId);
}

/** Re-authorize a Joint sender at the actual message persistence boundary.
 * A thread/task derives the local root; canonical storage is never substituted
 * for the actor's addressed entry. A Joint thread's local face carries no
 * parent pointer, so its callers pass the thread's local parent (the local
 * joint channel) instead. Conversion fence is owned by the caller. */
export async function lockJointPostingAuthority(
  channelId: string, actorType: ActorContextType, actorId: string, tx: DatabaseExecutor,
  options: {
    /**
     * A message send: lock the joint row FOR NO KEY UPDATE, the strength its
     * outbound admission takes later (lockOrdinaryMessageExternalDeliveryAdmission).
     * FOR SHARE here, then J, then the upgrade at admission deadlocked two
     * concurrent sends into one computed-membership Joint: each held the row
     * shared, one held J and waited for the other's share to upgrade
     * (#proj-o11y:058cb07b, 2026-11-05). FOR KEY SHARE (foreign keys) still passes.
     */
    forSend?: boolean;
  } = {},
): Promise<void> {
  let id = channelId;
  const visited = new Set<string>();
  while (!visited.has(id) && visited.size < 32) {
    visited.add(id);
    const result = await tx.execute<{ id: string; serverId: string; type: string; parentId: string | null }>(sql`
      SELECT c.id,c.server_id AS "serverId",c.type,coalesce(c.parent_channel_id,pm.channel_id) AS "parentId"
      FROM channels c LEFT JOIN messages pm ON pm.id=c.parent_message_id WHERE c.id=${id}::uuid`);
    const row = result.rows[0];
    if (!row) throw new Error("Channel not found");
    if (row.type === "thread" || row.type === "task") {
      if (!row.parentId) return;
      id = row.parentId; continue;
    }
    if (row.type !== "joint") return;
    const [lockedChannel] = await tx.select({ id: channels.id, serverId: channels.serverId, type: channels.type,
      deletedAt: channels.deletedAt, archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, row.id)).limit(1)
      .for(options.forSend ? "no key update" : "share");
    if (!lockedChannel || lockedChannel.serverId !== row.serverId || lockedChannel.type !== "joint"
      || lockedChannel.deletedAt || lockedChannel.archivedAt) throw new JointChannelAccessChangedError();
    await lockComputedJointActor({ serverId: row.serverId, channelId: row.id, actorType, actorId }, tx);
    if (actorType === "agent") {
      const [identity] = await tx.select({ installId: agents.managedByAppInstallId }).from(agents).where(eq(agents.id, actorId)).limit(1);
      if (identity?.installId) {
        if (!await lockManagedBotJointPosting({ serverId: row.serverId, channelId: row.id, agentId: actorId }, tx)) {
          throw new JointChannelAccessChangedError();
        }
        return;
      }
    }
    const context = await resolveChannelActorContext(row.serverId, row.id, actorType, actorId, tx);
    // A Guest posts only where its context admits it: the host projection it
    // is bound to, host external_channels_v1 on (P3, resolveChannelActorContextsMany).
    if (!context || !context.canAccessChannel || context.channelDeletedAt || context.channelArchivedAt) {
      throw new JointChannelAccessChangedError();
    }
    // Agent identity is owned by its server, even if a stale SAM row remains.
    if (actorType === "agent") {
      const live = await tx.execute(sql`SELECT id FROM agents WHERE id=${actorId}::uuid
        AND server_id=${row.serverId}::uuid AND deleted_at IS NULL`);
      if (!live.rows.length) throw new JointChannelAccessChangedError();
    }
    return;
  }
  throw new Error("Invalid conversation parent chain");
}
