import { beginJointMembershipDeparture, departureHostSideSubject, removeJointHumansInTransaction } from "./jointMembershipDeparture";
import { queueArchiveForEmptiedHostSides, snapshotJointHostSides, type JointHostSideSnapshot } from "./jointHostSideArchive";
import { announceJointInvitesForJoints } from "./listChangedRealtime";
import { recordOrdinaryJointAdmissions } from "./jointAdmissionKind";
import { acquireJointSourceExitFlagReadLock, resolveJointSourceExitJointIds, jointHumanConnectedIdentitySql, jointHumanHasLiveSourceSql, jointMembershipRemovalPendingSql, jointConversationFamilySql, resolveJointHumanMembershipScopes, jointEntryIdentitySql, resolveJointGuestEntryJointIds } from "./jointHumanMembershipAccess";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../db";
import { channels, jointChannelServers } from "../db/schema";

type Selection = { channelIds: readonly string[] } | { serverId: string; userId?: string } | { jointIds: readonly string[] };

/** Existing projection writers lock the channel row before server/member/J
 * locks, matching withLockedChannelActorCapability in both human/agent routes.
 * New, uncommitted projections cannot contend with another channel writer. */
export async function lockJointHumanMembershipChannel(tx: DatabaseExecutor, channelId: string, mode: "update" | "no key update" = "update"): Promise<void> {
  await tx.execute(sql`SELECT id FROM channels WHERE id = ${channelId}::uuid ${sql.raw(mode === "update" ? "FOR UPDATE" : "FOR NO KEY UPDATE")}`);
}

/** After any existing channel-row lock, join writers take source server/member
 * locks before J and CH/read-position rows. Server departure/role transitions
 * own stronger server/member locks and acquire no channel row afterward.
 * Do not lock another source's members while holding a joint lock. */
export async function lockJointHumanAdmissionSource(tx: DatabaseExecutor, serverId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await tx.execute(sql`SELECT id FROM servers WHERE id = ${serverId}::uuid FOR SHARE`);
  await tx.execute(sql`SELECT user_id FROM server_members
    WHERE server_id = ${serverId}::uuid AND user_id IN (${sql.join([...new Set(userIds)].sort().map(id => sql`${id}::uuid`), sql`, `)})
    ORDER BY user_id FOR KEY SHARE`);
}

/** Prepare BEFORE changing CH, projections or joint rows. All sources of one J
 * share this transaction lock, so simultaneous removal of the last two sources
 * cannot leave an orphan member. The returned function re-reads committed
 * eligibility after the lock; a queued backfill cannot resurrect a removed row.
 *
 * Membership is computed: writers apply explicit J-wide join/remove/
 * qualification changes to joint_channel_members. Without source exit, admissions
 * are historical records and never keep a member alive. With it (the host's
 * joint_source_exit_v1), a departure and a server exit (`exit`) keep a member
 * only while a live source remains (jointHumanHasLiveSourceSql).
 * No cursor/preferences are written. */
export type JointHumanMutation = "join" | "remove" | "revalidate" | "disconnect" | "retire";

export interface JointHumanMirrorOptions {
  /** `revalidate` only: the person is leaving or being removed from the
   * selected server (removeMemberInTransaction), so its sources end and, with
   * source exit on, so does J membership without another live source. Never
   * for joining a server, promotion or another role change. */
  exit?: boolean;
  /** The J locks the caller already holds (lockJointHumanMembershipJoints):
   * a selection reaching any other joint refuses (JointLockSetChangedError)
   * before it locks anything, so the caller restarts its transaction rather
   * than take a J out of order. */
  lockedJointIds?: readonly string[];
}

/** The acting person's account is retired or scheduled for deletion (lockJointUsersFirst): nothing is written for them. */
export class JointActorUnavailableError extends Error {
  constructor() {
    super("This account is being deleted");
    this.name = "JointActorUnavailableError";
  }
}

/**
 * The `users` rows a joint membership or connection transaction writes rows
 * naming (joint invite, source, departure, audit, invite, conversion job
 * FKs), FOR KEY SHARE in id order, as its FIRST lock: before any server,
 * member, channel, flag or J lock (only the channel conversion writer fence,
 * which account deletion never takes, may come before). Account deletion
 * takes a person's row FOR UPDATE and then the servers they own (FOR UPDATE,
 * handOverOwnedServers): a row taken only through a later FK closes a
 * server <-> users cycle (#13716, #13760, #13773). The entry points are listed
 * in jointUsersFirstLockOrder.realPg.test.ts.
 *
 * `actorUserId` (also locked) is the person the transaction acts for: an
 * account retired, or with a pending deletion request, refuses
 * (JointActorUnavailableError). The other rows (an authorizer, an inviter, a
 * removed member) are only locked: a person mid-deletion may still be removed,
 * and an account's own cleanup never reaches these entry points (it holds its
 * row FOR UPDATE; a KEY SHARE re-taken in that transaction never waits).
 * Re-entrant. Null and repeated ids are skipped.
 *
 * Two statements on purpose: a deletion request takes the users row FOR UPDATE
 * and inserts its pending request in that transaction. A statement that waited
 * for that lock re-reads only the locked row; its subqueries keep the snapshot
 * from before the wait and would miss the request (READ COMMITTED). The check
 * runs in the next statement, with a snapshot taken after the lock.
 */
export async function lockJointUsersFirst(
  tx: DatabaseExecutor,
  input: { actorUserId?: string | null; userIds?: readonly (string | null | undefined)[] },
): Promise<void> {
  const actor = input.actorUserId ?? null;
  const ids = [...new Set([actor, ...(input.userIds ?? [])].filter((id): id is string => !!id))].sort();
  if (ids.length === 0) return;
  const locked = (await tx.execute<{ id: string }>(sql`
    SELECT u.id FROM users u WHERE u.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY u.id FOR KEY SHARE OF u`)).rows;
  if (actor === null) return;
  if (!locked.some((row) => row.id === actor)) throw new JointActorUnavailableError();
  if (await jointUserUnavailable(tx, actor)) throw new JointActorUnavailableError();
}

/**
 * The person's account is retired or has a pending deletion request (or is
 * gone). Read in its own statement after their users row is locked
 * (lockJointUsersFirst), so it sees a request committed while that lock waited.
 */
export async function jointUserUnavailable(tx: DatabaseExecutor, userId: string): Promise<boolean> {
  const [row] = (await tx.execute<{ retired: boolean; pending: boolean }>(sql`
    SELECT u.retired_at IS NOT NULL AS retired,
      EXISTS (SELECT 1 FROM account_deletion_requests r WHERE r.user_id = u.id AND r.state = 'pending') AS pending
    FROM users u WHERE u.id = ${userId}::uuid`)).rows;
  return !row || row.retired || row.pending;
}

/**
 * A transaction found, under its locks, a person to write for whose users
 * row its first lock (lockJointUsersFirst, on a set guessed unlocked) did not
 * take: it restarts with the new set (withJointUsersGuessed).
 */
export class JointUsersLockSetChangedError extends Error {
  constructor() {
    super("The people this change names changed while it ran; try again");
    this.name = "JointUsersLockSetChangedError";
  }
}

/** Every one of `userIds` is in `locked` (the users rows taken first), else JointUsersLockSetChangedError. */
export function assertJointUsersLocked(locked: ReadonlySet<string>, userIds: readonly string[]): void {
  if (userIds.some((id) => !locked.has(id))) throw new JointUsersLockSetChangedError();
}

/**
 * The users-first lock on a set of people known for sure only under later
 * locks (bound Guests): `guess` reads them without a lock, `run` locks them
 * first (lockJointUsersFirst) and re-reads them under its locks
 * (assertJointUsersLocked); a set that grew restarts, three tries in all.
 */
export async function withJointUsersGuessed<T>(
  guess: () => Promise<readonly (string | null | undefined)[]>,
  run: (guessed: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const guessed = new Set((await guess()).filter((id): id is string => !!id));
    try {
      return await run(guessed);
    } catch (err) {
      if (!(err instanceof JointUsersLockSetChangedError) || attempt >= 2) throw err;
    }
  }
}

/** lockJointUsersFirst for the acting person alone. */
export async function lockJointActorFirst(tx: DatabaseExecutor, userId: string): Promise<void> {
  await lockJointUsersFirst(tx, { actorUserId: userId });
}

/** A prepare's selection reached a joint outside the J locks its caller holds: restart the transaction. */
export class JointLockSetChangedError extends Error {
  constructor(readonly jointIds: readonly string[]) {
    super("The joint channels this change needs changed while it prepared; try again");
    this.name = "JointLockSetChangedError";
  }
}

/**
 * The joints prepareJointHumanMembershipMirror would lock for `selection`,
 * read without any lock (the same structural lookup). For a caller that must
 * hold every J it will need before the first (a self_connect releasing its
 * actor's Guest seat): it locks them (lockJointHumanMembershipJoints), then
 * prepares with `lockedJointIds`.
 */
export async function jointHumanMembershipMirrorJointIds(tx: DatabaseExecutor, selection: Selection): Promise<string[]> {
  return [...new Set((await mirrorScopes(tx, selection)).map((row) => row.jointId))].sort();
}

/**
 * The joint membership locks of these joints, in the one order every writer
 * takes them (J id), after the source-exit flag's share lock: what
 * prepareJointHumanMembershipMirror takes, for a caller preparing several
 * selections at once. Re-entrant: each prepare re-takes its own without waiting.
 */
export async function lockJointHumanMembershipJoints(tx: DatabaseExecutor, jointIds: readonly string[]): Promise<void> {
  const ids = [...new Set(jointIds)].sort();
  if (ids.length === 0) return;
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await acquireJointSourceExitFlagReadLock(tx);
  for (const jointId of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${jointId}`}, 0))`);
  }
}

async function mirrorScopes(tx: DatabaseExecutor, selection: Selection) {
  const where = "channelIds" in selection
    ? selection.channelIds.length ? inArray(jointChannelServers.localChannelId, [...selection.channelIds]) : sql`false`
    : "serverId" in selection ? eq(jointChannelServers.serverId, selection.serverId)
      : selection.jointIds.length ? inArray(jointChannelServers.jointChannelId, [...selection.jointIds]) : sql`false`;
  // Revalidate only this person's current CH or J membership. Historical
  // admission records must neither select unrelated work nor supply a grant.
  const personSource = "serverId" in selection && selection.userId !== undefined
    ? sql`(EXISTS (SELECT 1 FROM channel_humans ch
        WHERE ch.channel_id = ${jointChannelServers.localChannelId} AND ch.user_id = ${selection.userId}::uuid)
      OR EXISTS (SELECT 1 FROM joint_channel_members m
        WHERE m.joint_channel_id = ${jointChannelServers.jointChannelId} AND m.user_id = ${selection.userId}::uuid))`
    : sql`true`;
  return tx.select({ jointId: jointChannelServers.jointChannelId, serverId: jointChannelServers.serverId, localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    // Thread/task projection records are structural, not separate human joins.
    .where(and(where, personSource, sql`${channels.type} IN ('joint', 'channel', 'private')`));
}

export async function prepareJointHumanMembershipMirror(
  tx: DatabaseExecutor,
  selection: Selection,
  mutation: JointHumanMutation,
  mirrorOptions: JointHumanMirrorOptions = {},
) {
  const scopes = await mirrorScopes(tx, selection);
  if (mirrorOptions.lockedJointIds) {
    const locked = new Set(mirrorOptions.lockedJointIds);
    const outside = [...new Set(scopes.map((scope) => scope.jointId))].filter((jointId) => !locked.has(jointId));
    if (outside.length > 0) throw new JointLockSetChangedError(outside);
  }
  // Structural lookup above is flag-independent. Only actual joint writers
  // pin the flag; ordinary channel membership does not take this lock.
  if (scopes.length > 0) {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await acquireJointSourceExitFlagReadLock(tx);
  }
  const jointIds = [...new Set(scopes.map(row => row.jointId))].sort();
  for (const jointId of jointIds) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${jointId}`}, 0))`);
  }
  const sourceExit = await resolveJointSourceExitJointIds(jointIds, tx);
  const exit = mutation === "revalidate" && mirrorOptions.exit === true;
  // P3 (Tenny/Cody, PR #13205): preserving an existing bound Guest (the
  // eligibility rows behind conversion finalize, reconciliation) is ungated;
  // admitting a NEW Guest (an explicit join of named people below) needs the
  // host's external_channels_v1 at admission time.
  const guestJoints = "ungated" as const;
  const admitGuestJoints = mutation === "join"
    ? await resolveJointGuestEntryJointIds(scopes.map(scope => scope.jointId), tx)
    : [];
  // Under J and before the change: which hosts' sides still have a member, so
  // the removal that empties one archives the joint (jointHostSideArchive.ts).
  // With source exit a disconnect/retire can take host-side people out of J
  // too (their only source was the departing server's).
  let hostSidesBefore: JointHostSideSnapshot | null = mutation === "remove" || mutation === "revalidate"
    ? await snapshotJointHostSides(tx, jointIds)
    : (mutation === "disconnect" || mutation === "retire") && sourceExit.size > 0
      ? await snapshotJointHostSides(tx, [...sourceExit])
      : null;
  const apply = async (userIds?: readonly string[], options: { actorUserId?: string } = {}) => {
    if (userIds?.length === 0) return;
    // Joints a source copy left (retired, disconnected, emptied): their
    // pending invites leave the invitees' lists with no invite row written.
    const leftJoints = new Set<string>();
    // Who emptied each J's host side, for its archive: the explicit subjects,
    // else the host-side member a departure of THAT J took out of it. Per J: a
    // retire departs several joints at once.
    const departureSubjects = new Map<string, string[]>();
    const causalUserIds = (jointId: string) => userIds ?? departureSubjects.get(jointId) ?? [];
    const addDepartureSubject = (jointId: string, subject: string | null) => {
      if (subject) departureSubjects.set(jointId, [...(departureSubjects.get(jointId) ?? []), subject]);
    };
    const selectedUsers = userIds === undefined ? sql`true`
      : sql`ch.user_id IN (${sql.join([...new Set(userIds)].sort().map(id => sql`${id}::uuid`), sql`, `)})`;
    for (const scope of scopes) {
      if (mutation === "disconnect" || mutation === "retire") {
        leftJoints.add(scope.jointId);
        await tx.execute(sql`UPDATE joint_channel_admissions SET ended_at=now()
          WHERE joint_channel_id=${scope.jointId}::uuid AND server_id=${scope.serverId}::uuid AND ended_at IS NULL`);
      } else if (mutation === "revalidate" && userIds?.length) {
        // A later identity rejoin/promotion must not revive this episode's source.
        await tx.execute(sql`UPDATE joint_channel_admissions a SET ended_at=now()
          FROM joint_channel_members m WHERE a.joint_channel_id=m.joint_channel_id
            AND a.user_id=m.user_id AND a.generation=m.generation AND a.ended_at IS NULL
            AND a.joint_channel_id=${scope.jointId}::uuid AND a.server_id=${scope.serverId}::uuid
            AND a.user_id IN (${sql.join(userIds.map(id=>sql`${id}::uuid`),sql`, `)})
            AND NOT EXISTS (SELECT 1 FROM server_members sm
              JOIN joint_channel_servers ap ON ap.joint_channel_id=a.joint_channel_id AND ap.server_id=sm.server_id
              WHERE sm.server_id=a.server_id AND sm.user_id=a.user_id
                AND ${jointEntryIdentitySql("sm", "ap", "ungated")})`);
      }
      if (mutation === "disconnect" || mutation === "retire") {
        const resolved = (await resolveJointHumanMembershipScopes({ localChannelIds: [scope.localChannelId] }, tx)).get(scope.localChannelId);
        if (!resolved) throw new Error("Joint channel not found");
        if (mutation === "retire") await tx.execute(sql`UPDATE joint_channel_servers SET status='disconnected',disconnected_at=now(),
            disconnected_by_user_id=${options.actorUserId ?? null}::uuid
          WHERE server_id=${scope.serverId}::uuid AND status='active'
            AND local_channel_id IN (${jointConversationFamilySql(scope.jointId)})`);
        const departure = await beginJointMembershipDeparture(tx, resolved, options.actorUserId ?? null);
        if (resolved.sourceExit) {
          addDepartureSubject(resolved.jointId, await departureHostSideSubject(tx, departure.departureId));
        }
        continue;
      }
      if (mutation === "join") {
        if (userIds !== undefined) {
          // A completed departure's rows are history (kept 90 days): only an
          // unfinished one refuses the join.
          const pending = await tx.execute(sql`SELECT 1 FROM joint_membership_removals jmr
            JOIN joint_membership_departures jmd ON jmd.id=jmr.departure_id
            WHERE jmd.completed_at IS NULL AND jmd.joint_channel_id=${scope.jointId}::uuid AND jmr.remove_membership
              AND jmr.user_id IN (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)}) LIMIT 1`);
          if (pending.rows.length) throw new Error("Joint membership cleanup in progress");
          // P3: a Guest joins only through the host projection it is bound to.
          const allowed = await tx.execute<{ userId: string }>(sql`
            SELECT sm.user_id AS "userId" FROM server_members sm
            JOIN joint_channel_servers p ON p.joint_channel_id=${scope.jointId}::uuid
              AND p.local_channel_id=${scope.localChannelId}::uuid AND p.server_id=sm.server_id
            WHERE sm.server_id=${scope.serverId}::uuid AND ${jointEntryIdentitySql("sm", "p", admitGuestJoints)}
              AND sm.user_id IN (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)})`);
          if (new Set(allowed.rows.map(row => row.userId)).size !== new Set(userIds).size) {
            throw new Error("Channel capability required");
          }
        }
        const eligible = sql`SELECT ch.user_id,ch.joined_at FROM (${jointHumanEntryChannelHumanRows(scope.jointId, guestJoints)}) ch
          WHERE ch.server_id=${scope.serverId}::uuid AND ${selectedUsers}`;
        const added = await upsertJointMemberEpisodes(tx, scope.jointId, eligible);
        if (added.length > 0) {
          await recordOrdinaryJointAdmissions(tx, sql`SELECT m.joint_channel_id,m.user_id,${scope.serverId}::uuid AS server_id,m.generation,
              e.joined_at AS admitted_at,${options.actorUserId ?? null}::uuid AS admitted_by
            FROM (${eligible}) e JOIN joint_channel_members m
              ON m.joint_channel_id=${scope.jointId}::uuid AND m.user_id=e.user_id
            WHERE e.user_id IN (${sql.join(added.map(id => sql`${id}::uuid`), sql`, `)})`);
        }
      } else {
        if (mutation === "revalidate" && userIds?.length) {
          // Leaving/demotion to guest in H permanently revokes an explicit
          // appointment, even when another entry preserves J membership.
          await tx.execute(sql`UPDATE channel_humans ch SET role='member',authority_revision=authority_revision+1
            FROM joint_channels j JOIN joint_channel_servers host
              ON host.joint_channel_id=j.id AND host.server_id=j.created_by_server_id
            WHERE j.id=${scope.jointId}::uuid AND ch.channel_id=host.local_channel_id AND ch.role='admin'
              AND ch.user_id IN (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)})
              AND NOT EXISTS (SELECT 1 FROM server_members sm
                WHERE sm.server_id=j.created_by_server_id AND sm.user_id=ch.user_id AND sm.role<>'guest')`);
        }
        if (userIds === undefined) throw new Error("Computed member mutation needs explicit subjects");
        const targets = [...new Set(userIds)].sort();
        // A server exit under source exit: S's sources ended above, so the
        // person stays only with a live source elsewhere. A live source
        // implies a connected identity, so this never keeps more people.
        const sourceExitHere = exit && sourceExit.has(scope.jointId);
        const remove = mutation === "remove" ? targets : (await tx.execute<{ userId: string }>(sql`
          SELECT m.user_id AS "userId" FROM joint_channel_members m
          WHERE m.joint_channel_id=${scope.jointId}::uuid
            AND m.user_id IN (${sql.join(targets.map(id => sql`${id}::uuid`), sql`, `)})
            AND NOT (${sourceExitHere
              ? jointHumanHasLiveSourceSql(sql`m.joint_channel_id`, sql`m.user_id`)
              : jointHumanConnectedIdentitySql(sql`m.joint_channel_id`, sql`m.user_id`)})`)).rows.map(row => row.userId);
        // Same COMMIT for the member row and every CH projection row.
        // The caller audits the removal (removeHuman, removeMemberInTransaction).
        await removeJointHumansInTransaction(tx, {
          jointId: scope.jointId,
          full: remove,
          tasks: sourceExitHere ? { actorUserId: options.actorUserId ?? null, reason: "joint_source_ended" } : null,
          follows: { full: sourceExitHere, entryOnly: false },
        });
      }
    }
    for (const jointId of jointIds) {
      if (mutation !== "join") {
        // A connection survives while ANY current J member has that entry's
        // nonguest identity, irrespective of who introduced that member.
        const empty = await tx.execute<{ localChannelId: string }>(sql`
          SELECT p.local_channel_id AS "localChannelId" FROM joint_channel_servers p
          JOIN joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
          WHERE p.joint_channel_id=${jointId}::uuid AND p.status='active' AND p.server_id<>j.created_by_server_id
            AND NOT EXISTS (SELECT 1 FROM joint_channel_members m JOIN server_members sm
              ON sm.user_id=m.user_id AND sm.server_id=p.server_id AND sm.role<>'guest'
              WHERE m.joint_channel_id=p.joint_channel_id
                AND NOT (${jointMembershipRemovalPendingSql(sql`m.joint_channel_id`, "user", sql`m.user_id`)}))
          ORDER BY p.server_id`);
        for (const row of empty.rows) {
          leftJoints.add(jointId);
          const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [row.localChannelId] }, tx)).get(row.localChannelId);
          if (!scope) throw new Error("Joint channel not found");
          // Projection status is the immediate entry fence.
          // Do not acquire other channel rows after J: a server-departure
          // transaction already owns SM and would invert a channel writer.
          await tx.execute(sql`UPDATE joint_channel_servers SET status='disconnected',disconnected_at=now(),
            disconnected_by_user_id=${options.actorUserId ?? null}::uuid
            WHERE server_id=${scope.entryServerId}::uuid AND status='active'
              AND local_channel_id IN (${jointConversationFamilySql(jointId)})`);
          const departure = await beginJointMembershipDeparture(tx, scope, options.actorUserId ?? null);
          if (scope.sourceExit) {
            addDepartureSubject(scope.jointId, await departureHostSideSubject(tx, departure.departureId));
          }
        }
      }
    }
    if (hostSidesBefore) {
      await queueArchiveForEmptiedHostSides(tx, hostSidesBefore, causalUserIds);
      hostSidesBefore = null;
    }
    await announceJointInvitesForJoints(tx, leftJoints);
  };
  return {
    apply,
    /** Whether `localChannelId` is a projection of a J this prepare covers. */
    coversChannel: (localChannelId: string) => scopes.some(scope => scope.localChannelId === localChannelId),
  };
}

/** The CH rows of J's active joint projections whose person holds that
 * entry's identity: the people an explicit join admits through each source
 * projection. A Guest of the host is eligible through its bound host
 * projection (P3), ungated: membership writes never depend on the access flag. */
function jointHumanEntryChannelHumanRows(jointId: string, guestJoints: readonly string[] | "ungated" = "ungated") {
  return sql`SELECT p.joint_channel_id, p.server_id, ch.user_id, ch.joined_at
    FROM joint_channel_servers p
    JOIN joint_channels j ON j.id = p.joint_channel_id AND j.status = 'active'
    JOIN channels c ON c.id = p.local_channel_id AND c.type = 'joint' AND c.deleted_at IS NULL
    JOIN servers s ON s.id = p.server_id AND s.deleted_at IS NULL
    JOIN channel_humans ch ON ch.channel_id = c.id
    JOIN server_members sm ON sm.server_id = p.server_id AND sm.user_id = ch.user_id
      AND ${jointEntryIdentitySql("sm", "p", guestJoints)}
    WHERE p.joint_channel_id = ${jointId}::uuid AND p.status = 'active'
      AND NOT (${jointMembershipRemovalPendingSql(sql`p.joint_channel_id`, "user", sql`ch.user_id`)})`;
}

/** Caller holds the J advisory lock. The durable counter survives removal and
 * advances only on a new explicit episode. */
async function upsertJointMemberEpisodes(tx: DatabaseExecutor, jointId: string, eligible: SQL): Promise<string[]> {
  const result = await tx.execute<{ userId: string }>(sql`
    WITH eligible AS (${eligible}), new_people AS (
      SELECT user_id,min(joined_at) joined_at FROM eligible e
      WHERE NOT EXISTS (SELECT 1 FROM joint_channel_members m
        WHERE m.joint_channel_id=${jointId}::uuid AND m.user_id=e.user_id)
      GROUP BY user_id
    ), episodes AS (
      INSERT INTO joint_membership_generations (joint_channel_id,principal_kind,principal_id,last_generation)
      SELECT ${jointId}::uuid,'user',user_id,1 FROM new_people
      ON CONFLICT (joint_channel_id,principal_kind,principal_id) DO UPDATE
        SET last_generation=joint_membership_generations.last_generation+1
      RETURNING principal_id AS user_id,last_generation AS generation
    )
    INSERT INTO joint_channel_members (joint_channel_id,user_id,generation,joined_at)
    SELECT ${jointId}::uuid,n.user_id,g.generation,n.joined_at
    FROM new_people n JOIN episodes g USING(user_id)
    ON CONFLICT (joint_channel_id,user_id) DO NOTHING RETURNING user_id AS "userId"`);
  await tx.execute(sql`UPDATE joint_channel_members m SET joined_at=e.joined_at
    FROM (SELECT user_id,min(joined_at) joined_at FROM (${eligible}) rows GROUP BY user_id) e
    WHERE m.joint_channel_id=${jointId}::uuid AND m.user_id=e.user_id AND e.joined_at<m.joined_at`);
  return result.rows.map(row => row.userId);
}
