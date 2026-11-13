import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { DEPRECATED_GRAVATAR_HASH, 
  asChannelId,
  asServerId,
  type Brand,
  type ChannelId,
  type ServerId,
  type ChannelRole,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db";
import { channels, jointChannels, jointChannelServers } from "../db/schema";
import { acquireFeatureFlagReadLock, evaluateFeatureFlags } from "./featureFlagService";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

/** Host-scoped: a person stays in J only while they hold a live source
 * (jointHumanHasLiveSourceSql). J membership itself is always computed from
 * joint_channel_members (the retired joint_human_membership_v1 rollout flag is
 * not read; a leftover row of it changes nothing). */
export const JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY = "joint_source_exit_v1";

/** Every writer that decides or depends on J membership pins the source-exit
 * flag and reads its mode after it. Lock order: identity and resource rows
 * (servers, server_members, server_agent_members, channel and projection rows,
 * bound Guests' member rows), then the source-exit flag's shared lock, then J.
 * Take it immediately before the first J lock, never before a row lock: a path
 * holding that row (a server departure holds server_members) would otherwise
 * queue behind activation's exclusive lock (jointSourceExitActivation.ts)
 * while activation waits for this holder. */
export async function acquireJointSourceExitFlagReadLock(tx: DatabaseExecutor): Promise<void> {
  await acquireFeatureFlagReadLock(tx, JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY);
}
export type JointHumanMembershipId = Brand<string, "JointHumanMembershipId">;

/** A structurally resolved local projection, not an authorization. Storage ids cannot mint this
 * scope, and every entry of a J evaluates the same host's feature flags. */
export interface JointHumanMembershipScope {
  jointId: JointHumanMembershipId;
  localChannelId: ChannelId;
  canonicalChannelId: ChannelId;
  entryServerId: ServerId;
  hostServerId: ServerId;
  /** The host's joint_source_exit_v1: membership also needs a live source
   * (jointHumanHasLiveSourceSql). */
  sourceExit: boolean;
  /** P3 (guests in joint channels): the host's external_channels_v1. Only then
   * may a Guest of the host, bound to the host's projection, enter this J. */
  guestEntryEnabled: boolean;
}

/**
 * P3 entry identity at projection `p` for server member row `sm` (SQL aliases):
 * a non-guest member of p's server, or a Guest of the HOST bound to the host's
 * own projection (server_members.guest_channel_id = p.local_channel_id).
 * A Guest never enters from any other server. `guestJoints` gates the guest
 * branch on the host's external_channels_v1: the J ids whose host has it on,
 * or "ungated".
 * Preserving an existing bound guest (conversion, revalidation, departure, cleanup, archive) is ungated; admitting a new guest and every access check are gated by the host's external_channels_v1.
 */
export function jointEntryIdentitySql(
  sm: string,
  p: string,
  guestJoints: readonly string[] | "ungated",
) {
  const smRef = sql.raw(sm);
  const pRef = sql.raw(p);
  const gate = guestJoints === "ungated"
    ? sql`true`
    : guestJoints.length
      ? sql`${pRef}.joint_channel_id IN (${sql.join([...new Set(guestJoints)].map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`false`;
  return sql<boolean>`(${smRef}.role<>'guest' OR (${smRef}.role='guest'
    AND ${smRef}.guest_channel_id=${pRef}.local_channel_id AND ${pRef}.role='host' AND ${gate}))`;
}

/** The J ids among `scopes` whose host admits its bound guests (P3). */
export function guestEntryJointIds(scopes: Iterable<JointHumanMembershipScope>): string[] {
  return [...new Set([...scopes].filter((scope) => scope.guestEntryEnabled).map((scope) => scope.jointId))];
}

/** The J ids whose host has external_channels_v1 on (P3 guest entry). */
export async function resolveJointGuestEntryJointIds(
  jointIds: readonly string[],
  tx: DatabaseExecutor = getDb(),
): Promise<string[]> {
  if (jointIds.length === 0) return [];
  const joints = await tx
    .select({ id: jointChannels.id, hostServerId: jointChannels.createdByServerId })
    .from(jointChannels)
    .where(inArray(jointChannels.id, [...new Set(jointIds)]));
  const hosts = [...new Set(joints.map((row) => row.hostServerId))];
  const flags = await evaluateFeatureFlags(
    hosts.map((serverId) => ({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId, userId: null })),
    tx,
  );
  const enabled = new Set(hosts.filter((_, i) => flags[i]?.enabled === true));
  return joints.filter((row) => enabled.has(row.hostServerId)).map((row) => row.id);
}

/** The J ids among `jointIds` whose host has joint_source_exit_v1 on.
 * Writers call this after acquireJointSourceExitFlagReadLock. */
export async function resolveJointSourceExitJointIds(
  jointIds: readonly string[],
  tx: DatabaseExecutor,
): Promise<Set<string>> {
  if (jointIds.length === 0) return new Set();
  const joints = await tx
    .select({ id: jointChannels.id, hostServerId: jointChannels.createdByServerId })
    .from(jointChannels)
    .where(inArray(jointChannels.id, [...new Set(jointIds)]));
  const hosts = [...new Set(joints.map((row) => row.hostServerId))];
  const flags = await evaluateFeatureFlags(
    hosts.map((serverId) => ({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId })),
    tx,
  );
  const enabled = new Set(hosts.filter((_, i) => flags[i]?.enabled === true));
  return new Set(joints.filter((row) => enabled.has(row.hostServerId)).map((row) => row.id));
}

export async function resolveJointHumanMembershipScopes(
  input: { localChannelIds: readonly string[]; serverId?: ServerId },
  tx: DatabaseExecutor = getDb(),
): Promise<Map<string, JointHumanMembershipScope>> {
  const { localChannelIds, serverId } = input;
  if (localChannelIds.length === 0) return new Map();
  const projections = await tx
    .select({
      jointId: jointChannels.id,
      localChannelId: jointChannelServers.localChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
      hostServerId: jointChannels.createdByServerId,
      entryServerId: jointChannelServers.serverId,
    })
    .from(jointChannelServers)
    .innerJoin(
      jointChannels,
      eq(jointChannels.id, jointChannelServers.jointChannelId),
    )
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(
      and(
        serverId === undefined
          ? undefined
          : eq(jointChannelServers.serverId, serverId),
        eq(channels.serverId, jointChannelServers.serverId),
        eq(channels.type, "joint"),
        inArray(jointChannelServers.localChannelId, [
          ...new Set(localChannelIds),
        ]),
      ),
    );
  const hosts = [...new Set(projections.map((row) => row.hostServerId))];
  const evaluations = await evaluateFeatureFlags(
    hosts.flatMap((host) => [
      // No user/client/entry identity: all projections of a J choose one mode.
      { key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: host, userId: null },
      { key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId: host },
    ]),
    tx,
  );
  const guestsByHost = new Map(
    hosts.map((host, i) => [host, evaluations[i * 2]?.enabled === true]),
  );
  const sourceExitByHost = new Map(
    hosts.map((host, i) => [host, evaluations[i * 2 + 1]?.enabled === true]),
  );
  return new Map(
    projections.map((row) => [
      row.localChannelId,
      {
        // These brands are produced by the structural projection query above, not by
        // rebranding arbitrary strings inside an authorization decision.
        jointId: row.jointId as JointHumanMembershipId,
        localChannelId: asChannelId(row.localChannelId),
        canonicalChannelId: asChannelId(row.canonicalChannelId),
        hostServerId: asServerId(row.hostServerId),
        entryServerId: asServerId(row.entryServerId),
        sourceExit: sourceExitByHost.get(row.hostServerId) === true,
        guestEntryEnabled: guestsByHost.get(row.hostServerId) === true,
      },
    ]),
  );
}

/** Current J members entering through each scope's entry. A Guest enters only
 * through the host projection it is bound to, and only while the host has
 * external_channels_v1 on (P3, jointEntryIdentitySql). With source exit on
 * (scope.sourceExit) the member also needs a live source, on any server. */
export async function filterJointHumanMemberEntries(
  scopes: readonly JointHumanMembershipScope[],
  userId: string,
  tx: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  if (scopes.length === 0) return new Set();
  const rows = await tx.execute<{ localChannelId: string }>(sql`
    SELECT p.local_channel_id AS "localChannelId"
    FROM joint_channel_servers p
    JOIN joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
    JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id
      AND c.type='joint' AND c.deleted_at IS NULL
    JOIN servers s ON s.id=p.server_id AND s.deleted_at IS NULL
    JOIN server_members sm ON sm.server_id=p.server_id AND sm.user_id=${userId}::uuid
      AND ${jointEntryIdentitySql("sm", "p", guestEntryJointIds(scopes))}
    JOIN joint_channel_members m ON m.joint_channel_id=p.joint_channel_id AND m.user_id=sm.user_id
    WHERE NOT (${jointMembershipRemovalPendingSql(sql`p.joint_channel_id`, "user", sql`sm.user_id`)})
      AND p.status='active'${jointSourceExitGateSql(sourceExitJointIds(scopes), sql`p.joint_channel_id`, sql`sm.user_id`)} AND (p.joint_channel_id,p.local_channel_id,p.server_id) IN
      (VALUES ${sql.join(
        scopes.map(
          (scope) => sql`
      (${scope.jointId}::uuid,${scope.localChannelId}::uuid,${scope.entryServerId}::uuid)`,
        ),
        sql`, `,
      )})`);
  return new Set(rows.rows.map((row) => row.localChannelId));
}

/** Current eligibility for departure/disconnect cleanup. Correlated SQL keeps
 * batch cleanup and single-member departure on the same rule. A Guest bound to
 * the host projection stays eligible (P3); cleanup is ungated by default so a
 * flag rollback never deletes a guest's membership, while access paths gate. */
export function jointHumanConnectedIdentitySql(
  jointId: SQLWrapper,
  userId: SQLWrapper,
  guestJoints: readonly string[] | "ungated" = "ungated",
) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM joint_channel_servers jhi_p
    JOIN channels jhi_c ON jhi_c.id=jhi_p.local_channel_id AND jhi_c.server_id=jhi_p.server_id
      AND jhi_c.type='joint' AND jhi_c.deleted_at IS NULL
    JOIN servers jhi_s ON jhi_s.id=jhi_p.server_id AND jhi_s.deleted_at IS NULL
    JOIN server_members jhi_sm ON jhi_sm.server_id=jhi_p.server_id AND jhi_sm.user_id=${userId}
      AND ${jointEntryIdentitySql("jhi_sm", "jhi_p", guestJoints)}
    WHERE jhi_p.joint_channel_id=${jointId} AND jhi_p.status='active'
  )`;
}

/** Live entry check for agent authority. Agent participation remains CA-based;
 * this only validates the addressed projection, never another server's entry. */
export async function filterJointActiveEntries(
  scopes: readonly JointHumanMembershipScope[],
  tx: DatabaseExecutor,
) {
  if (!scopes.length) return new Set<string>();
  const result = await tx.execute<{ localChannelId: string }>(sql`
    SELECT p.local_channel_id AS "localChannelId" FROM joint_channel_servers p
    JOIN joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
    JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.type='joint' AND c.deleted_at IS NULL
    JOIN servers s ON s.id=p.server_id AND s.deleted_at IS NULL
    WHERE p.status='active' AND (p.joint_channel_id,p.local_channel_id,p.server_id) IN
      (VALUES ${sql.join(
        scopes.map(
          (scope) =>
            sql`(${scope.jointId}::uuid,${scope.localChannelId}::uuid,${scope.entryServerId}::uuid)`,
        ),
        sql`, `,
      )})`);
  return new Set(result.rows.map((row) => row.localChannelId));
}

/** Durable disconnect victims are denied until physical
 * cleanup and post-commit revocation complete. Never recompute this fixed list
 * from identities that may have been added after the disconnect committed.
 * Rows outlive their departure as history (90 days); every read of the table
 * as a denial must filter on jmd.completed_at IS NULL, as this one does. */
export function jointMembershipRemovalPendingSql(
  jointId: SQLWrapper,
  type: "user" | "agent",
  principalId: SQLWrapper,
) {
  const column = type === "user" ? sql`jmr.user_id` : sql`jmr.agent_id`;
  return sql<boolean>`EXISTS (SELECT 1 FROM joint_membership_removals jmr
    JOIN joint_membership_departures jmd ON jmd.id=jmr.departure_id
    WHERE jmd.completed_at IS NULL AND jmd.joint_channel_id=${jointId} AND jmr.remove_membership AND ${column}=${principalId})`;
}

/**
 * The host side of joint `jointId`: its current members who are non-Guest
 * members of the host server, not queued for removal. Agents and Guests never
 * count. A joint whose host side empties is archived (jointHostSideArchive.ts);
 * while archived with it empty, a host owner/admin may bring it back
 * (channelActorHasCapability). Rows: `user_id`.
 */
export function jointHostSideMembersSql(jointId: SQLWrapper) {
  return sql`SELECT hm.user_id FROM joint_channel_members hm
    JOIN joint_channels hj ON hj.id=hm.joint_channel_id
    JOIN server_members hsm ON hsm.server_id=hj.created_by_server_id AND hsm.user_id=hm.user_id AND hsm.role<>'guest'
    WHERE hm.joint_channel_id=${jointId}
      AND NOT (${jointMembershipRemovalPendingSql(sql`hm.joint_channel_id`, "user", sql`hm.user_id`)})`;
}

/** The joints among `jointIds` whose host side is empty (jointHostSideMembersSql). */
export async function filterJointHostSidesEmpty(jointIds: readonly string[], tx: DatabaseExecutor): Promise<Set<string>> {
  const ids = [...new Set(jointIds)];
  if (ids.length === 0) return new Set();
  const result = await tx.execute<{ jointId: string }>(sql`SELECT j.id AS "jointId" FROM joint_channels j
    WHERE j.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      AND NOT EXISTS (${jointHostSideMembersSql(sql`j.id`)})`);
  return new Set(result.rows.map((row) => row.jointId));
}

/** Whether `userId` is on the host side (jointHostSideMembersSql) of the joint behind local channel `localChannelId`. */
export async function isJointHostSideMember(localChannelId: string, userId: string, tx: DatabaseExecutor): Promise<boolean> {
  const [projection] = (await tx.execute<{ jointId: string }>(sql`SELECT p.joint_channel_id AS "jointId" FROM joint_channel_servers p
    WHERE p.local_channel_id=${localChannelId}::uuid AND p.status='active'`)).rows;
  if (!projection) return false;
  const result = await tx.execute<{ member: boolean }>(sql`SELECT EXISTS (
    SELECT 1 FROM (${jointHostSideMembersSql(sql`${projection.jointId}::uuid`)}) h WHERE h.user_id=${userId}::uuid) AS member`);
  return result.rows[0]?.member === true;
}

export async function filterJointPendingRemovalEntries(
  scopes: readonly JointHumanMembershipScope[],
  type: "user" | "agent",
  id: string,
  tx: DatabaseExecutor,
) {
  if (!scopes.length) return new Set<string>();
  const rows = await tx.execute<{
    jointId: string;
  }>(sql`SELECT DISTINCT jmd.joint_channel_id AS "jointId"
    FROM joint_membership_departures jmd JOIN joint_membership_removals jmr ON jmr.departure_id=jmd.id
    WHERE jmd.completed_at IS NULL AND jmr.remove_membership AND ${type === "user" ? sql`jmr.user_id` : sql`jmr.agent_id`}=${id}::uuid
      AND jmd.joint_channel_id IN (${sql.join(
        [...new Set(scopes.map((scope) => scope.jointId))].map(
          (id) => sql`${id}::uuid`,
        ),
        sql`, `,
      )})`);
  const denied = new Set(rows.rows.map((row) => row.jointId));
  return new Set(
    scopes
      .filter((scope) => denied.has(scope.jointId))
      .map((scope) => scope.localChannelId),
  );
}

/** Canonical and local root faces plus their task/thread descendants. This is
 * the physical compatibility cleanup scope, never a source of membership.
 * The validated channels_parent_message_requires_channel CHECK plus the
 * derivation/move triggers guarantee a parent cache for every parent message.
 * Deploy validates before new code starts; offline tools check that gate too.
 * No deleted/type filter: detached and soft-deleted descendants remain in scope.
 * OFFSET 0 keeps the child probe parameterized; flattening it into a recursive
 * hash join can scan all channels at every depth despite the parent index. */
export function jointConversationFamilySql(jointId: string) {
  return sql`WITH RECURSIVE joint_family(id) AS (
    SELECT local_channel_id FROM joint_channel_servers WHERE joint_channel_id=${jointId}::uuid
    UNION SELECT canonical_channel_id FROM joint_channels WHERE id=${jointId}::uuid
    UNION SELECT child.id FROM joint_family f CROSS JOIN LATERAL (
      SELECT c.id FROM channels c WHERE c.parent_channel_id=f.id OFFSET 0
    ) child
  ) SELECT id FROM joint_family`;
}

/**
 * The joint ids a set of storage channels belongs to: a joint whose canonical
 * channel is one of them, or the joint of the conversation a child channel
 * (thread or task conversation) hangs under, by its parent message's channel,
 * its task's channel, or its parent_channel_id, in that order. Same rows as
 * the former inline `IN (SELECT root.id ... OR EXISTS (...))`, as a UNION of
 * two index lookups on joint_channels.canonical_channel_id.
 */
export async function resolveJointIdsForStorageChannels(
  storageChannelIds: readonly string[],
  tx: DatabaseExecutor,
): Promise<string[]> {
  const ids = sql.join(storageChannelIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await tx.execute(sql`
    SELECT root.id::text AS id FROM joint_channels root
    WHERE root.canonical_channel_id IN (${ids})
    UNION
    SELECT root.id::text FROM joint_channels root
    WHERE root.canonical_channel_id IN (
      SELECT coalesce(pm.channel_id, parent_task.channel_id, child.parent_channel_id)
      FROM channels child
      LEFT JOIN messages pm ON pm.id = child.parent_message_id
      LEFT JOIN tasks parent_task ON parent_task.id = child.task_id
      WHERE child.id IN (${ids})
    )
  `);
  return (rows.rows as Array<{ id: string }>).map((row) => row.id);
}

/** Resolve a constant-size flag snapshot for a raw SQL read. Call once per
 * batch/request, then reuse the returned correlated predicate for every row.
 * This is the same host-scoped flag contract as the single/batch access helper. */
export async function resolveJointHumanEntrySql(
  input: {
    serverId?: string;
    localChannelIds?: readonly string[];
    jointIds?: readonly string[];
    storageChannelIds?: readonly string[];
  },
  tx: DatabaseExecutor = getDb(),
) {
  if (
    input.localChannelIds?.length === 0 ||
    input.jointIds?.length === 0 ||
    input.storageChannelIds?.length === 0
  )
    return (_channel: SQLWrapper, _user: SQLWrapper) => sql<boolean>`false`;
  // Storage channels resolve to their joint ids in a statement of their own.
  // Inlined as `joint_channel_id IN (SELECT ... OR EXISTS (...))`, the
  // condition could not be planned before the join, so every call
  // parallel-scanned all of `channels` (~26k blocks) to find the few
  // `type = 'joint'` rows. Resolved first, the projection lookup below is an
  // index lookup by joint id. No joint id means no joint membership: return
  // `false` rather than an empty `IN ()` or a dropped condition.
  const storageJointIds = input.storageChannelIds
    ? await resolveJointIdsForStorageChannels(input.storageChannelIds, tx)
    : undefined;
  if (storageJointIds?.length === 0)
    return (_channel: SQLWrapper, _user: SQLWrapper) => sql<boolean>`false`;
  const projections = await tx
    .select({ id: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(
      and(
        eq(channels.type, "joint"),
        input.serverId
          ? eq(jointChannelServers.serverId, input.serverId)
          : undefined,
        input.jointIds
          ? inArray(jointChannelServers.jointChannelId, [...input.jointIds])
          : undefined,
        storageJointIds
          ? inArray(jointChannelServers.jointChannelId, storageJointIds)
          : undefined,
        input.localChannelIds
          ? inArray(jointChannelServers.localChannelId, [
              ...input.localChannelIds,
            ])
          : undefined,
      ),
    );
  const scopes = await resolveJointHumanMembershipScopes(
    { localChannelIds: projections.map((row) => row.id) },
    tx,
  );
  const guestJoints = guestEntryJointIds(scopes.values());
  const sourceExitJoints = sourceExitJointIds(scopes.values());
  return (channelId: SQLWrapper, userId: SQLWrapper) => sql<boolean>`EXISTS (
    SELECT 1 FROM joint_channel_servers jhp
    JOIN joint_channels jhj ON jhj.id=jhp.joint_channel_id AND jhj.status='active'
    JOIN channels jhc ON jhc.id=jhp.local_channel_id AND jhc.server_id=jhp.server_id AND jhc.type='joint' AND jhc.deleted_at IS NULL
    JOIN servers jhs ON jhs.id=jhp.server_id AND jhs.deleted_at IS NULL
    JOIN server_members jhsm ON jhsm.server_id=jhp.server_id AND jhsm.user_id=${userId}
      AND ${jointEntryIdentitySql("jhsm", "jhp", guestJoints)}
    WHERE jhp.local_channel_id=${channelId} AND jhp.status='active'
      AND NOT (${jointMembershipRemovalPendingSql(sql`jhp.joint_channel_id`, "user", userId)})
      AND EXISTS (SELECT 1 FROM joint_channel_members jhm WHERE jhm.joint_channel_id=jhp.joint_channel_id AND jhm.user_id=${userId})${jointSourceExitGateSql(sourceExitJoints, sql`jhp.joint_channel_id`, userId)}
  )`;
}

/** Internal delivery audience, per current local entry. Do not publish this
 * projection list as a roster's foreign-server identity badges. */
export async function getJointHumanDeliveryRows(
  localChannelIds: readonly string[],
  tx: DatabaseExecutor = getDb(),
) {
  if (!localChannelIds.length) return [];
  const allowed = await resolveJointHumanEntrySql({ localChannelIds }, tx);
  const { users, servers, serverMembers, channelHumans } = await import(
    "../db/schema"
  );
  const rows = await tx
    .select({
      channelId: channels.id,
      id: users.id,
      serverId: channels.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      role: serverMembers.role,
      serverRole: serverMembers.role,
      channelRole: sql<ChannelRole>`coalesce(${channelHumans.role},'member')`,
    })
    .from(channels)
    .innerJoin(serverMembers, eq(serverMembers.serverId, channels.serverId))
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .leftJoin(
      channelHumans,
      and(
        eq(channelHumans.channelId, channels.id),
        eq(channelHumans.userId, users.id),
      ),
    )
    .where(
      and(
        inArray(channels.id, [...localChannelIds]),
        eq(channels.type, "joint"),
        allowed(channels.id, users.id),
      ),
    );
  return rows.map((row) => ({ ...row, gravatarHash: DEPRECATED_GRAVATAR_HASH }));
}

/** A live source of the person's current J episode: an unended admission of
 * m.generation through an active projection of a live channel and server,
 * where the person still has that server's entry identity, with no pending
 * removal. `serverId` names the source server; null means any server.
 * Deliberately no filter on `kind`: a 'recovery' source (#wg-rbac:#23) is a
 * live source exactly like an ordinary 'admission' one. The one definition
 * behind provenance labels, ops recovery and source exit. */
function jointHumanSourceSql(
  jointId: SQLWrapper,
  userId: SQLWrapper,
  serverId: SQLWrapper | null,
) {
  return sql`EXISTS (
    SELECT 1 FROM joint_channel_members current_member
    JOIN joint_channel_admissions source
      ON source.joint_channel_id=current_member.joint_channel_id
      AND source.user_id=current_member.user_id AND source.generation=current_member.generation AND source.ended_at IS NULL
    JOIN joint_channel_servers source_projection
      ON source_projection.joint_channel_id=source.joint_channel_id
      AND source_projection.server_id=source.server_id AND source_projection.status='active'
    JOIN joint_channels source_joint ON source_joint.id=source.joint_channel_id AND source_joint.status='active'
    JOIN channels source_channel ON source_channel.id=source_projection.local_channel_id
      AND source_channel.type='joint' AND source_channel.deleted_at IS NULL
    JOIN servers source_server ON source_server.id=source.server_id AND source_server.deleted_at IS NULL
    JOIN server_members source_identity ON source_identity.server_id=source.server_id
      AND source_identity.user_id=source.user_id
      AND ${jointEntryIdentitySql("source_identity", "source_projection", "ungated")}
    WHERE current_member.joint_channel_id=${jointId} AND current_member.user_id=${userId}
      ${serverId === null ? sql`` : sql`AND source.server_id=${serverId}`}
      AND NOT (${jointMembershipRemovalPendingSql(sql`current_member.joint_channel_id`, "user", sql`current_member.user_id`)})
  )`;
}

/** Current-episode provenance through server `serverId` (jointHumanSourceSql).
 * Labels and ops read it; with source exit off it authorizes nothing. */
export function jointHumanCurrentSourceSql(
  jointId: SQLWrapper,
  userId: SQLWrapper,
  serverId: SQLWrapper,
) {
  return jointHumanSourceSql(jointId, userId, serverId);
}

/** Whether the person holds any live source of J (jointHumanSourceSql), on any
 * server: a source on B keeps an entry through A valid. With source exit on,
 * computed membership requires it; departure and leave use it to decide who
 * leaves J. */
export function jointHumanHasLiveSourceSql(jointId: SQLWrapper, userId: SQLWrapper) {
  return jointHumanSourceSql(jointId, userId, null);
}

/** The J ids among `scopes` with source exit on. */
export function sourceExitJointIds(scopes: Iterable<JointHumanMembershipScope>): string[] {
  return [...new Set([...scopes].filter((scope) => scope.sourceExit).map((scope) => scope.jointId))];
}

/** ` AND <J has no source exit OR the person has a live source>` for the J ids
 * with source exit on, or nothing at all, so a reader with the flag off emits
 * exactly its earlier SQL. Append after a complete condition. */
export function jointSourceExitGateSql(sourceExitJoints: readonly string[], jointId: SQLWrapper, userId: SQLWrapper) {
  if (sourceExitJoints.length === 0) return sql``;
  return sql` AND (${jointId} NOT IN (${sql.join(sourceExitJoints.map((id) => sql`${id}::uuid`), sql`, `)})
      OR ${jointHumanHasLiveSourceSql(jointId, userId)})`;
}

/** J-scoped public identity. Sources are current-episode labels, never the
 * person's other server memberships. Empty source fields preserve old roster
 * wire shapes; no-source members still have a public identity (Warden 93d2aac8). */
export async function getComputedJointHumanPublicRowsForScopes(
  scopes: readonly JointHumanMembershipScope[],
  onlyIds?: readonly string[],
  tx: DatabaseExecutor = getDb(),
) {
  const views = scopes;
  if (!views.length || onlyIds?.length === 0) return [];
  const result = await tx.execute<{
    localChannelId: string;
    id: string;
    name: string;
    displayName: string | null;
    description: string | null;
    avatarUrl: string | null;
    servers: Array<{ id: string; name: string; slug: string }>;
    entryServerRole: string | null;
    isManager: boolean;
  }>(sql`WITH views(joint_id,local_channel_id,entry_server_id) AS (VALUES
    ${sql.join(
      views.map(
        (scope) =>
          sql`(${scope.jointId}::uuid,${scope.localChannelId}::uuid,${scope.entryServerId}::uuid)`,
      ),
      sql`, `,
    )})
    SELECT v.local_channel_id AS "localChannelId",u.id,u.name,u.display_name AS "displayName",u.description,u.avatar_url AS "avatarUrl",
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'slug',s.slug)
      ORDER BY (s.id=v.entry_server_id) DESC,s.name,s.id)
      FROM joint_channel_admissions label JOIN servers s ON s.id=label.server_id
      WHERE s.id<>v.entry_server_id AND label.joint_channel_id=m.joint_channel_id AND label.user_id=u.id AND label.generation=m.generation AND label.ended_at IS NULL
        AND ${jointHumanCurrentSourceSql(sql`m.joint_channel_id`, sql`u.id`, sql`s.id`)}),'[]'::jsonb) servers,
    (SELECT entry_sm.role FROM server_members entry_sm
      WHERE entry_sm.server_id=v.entry_server_id AND entry_sm.user_id=u.id) AS "entryServerRole",
    EXISTS (SELECT 1 FROM server_members host_sm
      WHERE host_sm.server_id=j.created_by_server_id AND host_sm.user_id=u.id AND host_sm.role<>'guest'
        AND (host_sm.role IN ('owner','admin') OR (
          EXISTS (SELECT 1 FROM channel_humans host_role JOIN joint_channel_servers hp ON hp.local_channel_id=host_role.channel_id
            WHERE hp.joint_channel_id=m.joint_channel_id AND hp.server_id=host_sm.server_id AND hp.status='active'
              AND host_role.user_id=u.id AND host_role.role='admin')))) AS "isManager"
    FROM views v JOIN joint_channels j ON j.id=v.joint_id AND j.status='active'
    JOIN joint_channel_servers ep ON ep.joint_channel_id=v.joint_id AND ep.local_channel_id=v.local_channel_id
      AND ep.server_id=v.entry_server_id AND ep.status='active'
    JOIN channels ec ON ec.id=ep.local_channel_id AND ec.type='joint' AND ec.deleted_at IS NULL
    JOIN servers es ON es.id=ep.server_id AND es.deleted_at IS NULL
    JOIN joint_channel_members m ON m.joint_channel_id=v.joint_id JOIN users u ON u.id=m.user_id
    WHERE true
      AND ${jointHumanConnectedIdentitySql(sql`m.joint_channel_id`, sql`m.user_id`, guestEntryJointIds(views))}${jointSourceExitGateSql(sourceExitJointIds(views), sql`m.joint_channel_id`, sql`m.user_id`)}
      AND NOT (${jointMembershipRemovalPendingSql(sql`m.joint_channel_id`, "user", sql`m.user_id`)})
      AND ${
        onlyIds
          ? sql`u.id IN (${sql.join(
              onlyIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql`true`
      }
    ORDER BY v.local_channel_id,m.joined_at,u.id`);
  return result.rows.map(({ localChannelId, entryServerRole, ...row }) => ({
    localChannelId: asChannelId(localChannelId),
    human: {
      ...row,
      // Member-list grouping (cindyz 2026-11-04): whether the person belongs
      // to the viewed entry's own server, any role including guest. That is
      // the entry's own directory fact; no other membership is read.
      inViewerServer: entryServerRole !== null,
      // Legacy display metadata is the first visible source, not a primary
      // identity or authorization input. Current entry identity grants access.
      serverId: row.servers[0]?.id ?? "",
      serverName: row.servers[0]?.name ?? "",
      serverSlug: row.servers[0]?.slug ?? "",
      // No raw foreign role, email or email-derived hash is public in J.
      // The entry's own guests keep their guest label there.
      role: entryServerRole === "guest" ? ("guest" as const) : ("member" as const),
      serverRole: entryServerRole === "guest" ? ("guest" as const) : ("member" as const),
      channelRole: row.isManager ? ("admin" as const) : ("member" as const),
      gravatarHash: "",
    },
  }));
}

export async function getComputedJointHumanPublicRows(
  scope: JointHumanMembershipScope,
  onlyIds?: readonly string[],
  tx: DatabaseExecutor = getDb(),
) {
  return (
    await getComputedJointHumanPublicRowsForScopes([scope], onlyIds, tx)
  ).map((row) => row.human);
}
