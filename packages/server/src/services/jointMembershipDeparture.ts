import { afterAmbientTransaction } from "../db/ambientTransaction";
import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import { currentDate, type Brand } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db";
import {
  jointMembershipDepartures,
  jointMembershipRemovals,
  jointChannelMembers,
  channelHumans,
  channelAgents,
  agentActivityEvents,
  channels,
  tasks,
  taskEvents,
} from "../db/schema";
import {
  acquireJointSourceExitFlagReadLock,
  jointHumanConnectedIdentitySql,
  jointHumanHasLiveSourceSql,
  jointConversationFamilySql,
  resolveJointSourceExitJointIds,
  type JointHumanMembershipScope,
} from "./jointHumanMembershipAccess";
import { recordChannelMembershipsEnded } from "./channelMembershipAudit";
import {
  createDurableTask,
  durableTaskKind,
  DurableTaskPermanentError,
  DurableTaskRegistry,
  runDurableTask,
  type DurableTaskClaim,
  type DurableTaskContext,
  type DurableTaskDefinition,
} from "./durableTasks";

export const JOINT_DEPARTURE_BATCH_SIZE = 128;
export type JointMembershipDepartureId = Brand<
  string,
  "JointMembershipDepartureId"
>;
type Removal = typeof jointMembershipRemovals.$inferSelect;
export interface JointDepartureBatch {
  departure: typeof jointMembershipDepartures.$inferSelect;
  removals: Removal[];
}
export interface JointDepartureEffects {
  /** Confirm Socket invalidation for humans. Agent access is already denied
   * server-side; exact turn cancellation is tracked separately (Warden
   * 81eeb2e3). Never label a best-effort purge as a confirmed turn stop. */
  revoke(
    batch: JointDepartureBatch,
    keepLease?: () => Promise<boolean>,
  ): Promise<void>;
}
let effects: JointDepartureEffects | null = null;
export function configureJointDepartureEffects(
  value: JointDepartureEffects | null,
) {
  effects = value;
}

async function bound(tx: DatabaseExecutor) {
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
}
async function lockJoint(tx: DatabaseExecutor, jointId: string) {
  await acquireJointSourceExitFlagReadLock(tx);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${jointId}`},0))`,
  );
}

/** Caller already owns J and has marked S's projection disconnected in this
 * same transaction. One statement fixes humans who leave J (no other connected
 * identity; with source exit, `scope.sourceExit`, no live source left once S's
 * have ended) and all participating S agents; a timeout rolls back the mark
 * too. The snapshot is the operation's decision: batches, retries and a later
 * flag change never recompute it. Tenny d9ffcab8 allows this set insert;
 * physical deletion stays <=128. */
export async function beginJointMembershipDeparture(
  tx: DatabaseExecutor,
  scope: JointHumanMembershipScope,
  actorUserId: string | null,
) {
  await bound(tx);
  // Covers automatic empty-server departure as well as explicit disconnect.
  await tx.execute(sql`UPDATE joint_channel_admissions SET ended_at=now()
    WHERE joint_channel_id=${scope.jointId}::uuid AND server_id=${scope.entryServerId}::uuid AND ended_at IS NULL`);
  const [existing] = await tx
    .select()
    .from(jointMembershipDepartures)
    .where(
      and(
        eq(jointMembershipDepartures.jointChannelId, scope.jointId),
        eq(jointMembershipDepartures.serverId, scope.entryServerId),
        eq(jointMembershipDepartures.localChannelId, scope.localChannelId),
      ),
    )
    .orderBy(desc(jointMembershipDepartures.createdAt))
    .limit(1);
  // Retries of a tombstone neither replace the fixed snapshot nor mint another
  // cleanup. A later reconnected projection has a different local channel id.
  if (existing)
    return {
      departureId: existing.id as JointMembershipDepartureId,
      claim: null,
      subjectCountAtMost: 0,
    };
  const [departure] = await tx
    .insert(jointMembershipDepartures)
    .values({
      jointChannelId: scope.jointId,
      localChannelId: scope.localChannelId,
      serverId: scope.entryServerId,
      actorUserId,
    })
    .returning();
  const id = departure!.id as JointMembershipDepartureId;
  await tx.execute(sql`INSERT INTO joint_membership_removals (id,departure_id,user_id,agent_id,remove_membership)
    SELECT gen_random_uuid(),${id}::uuid,v.user_id,v.agent_id,v.remove_membership FROM (
      SELECT m.user_id,NULL::uuid agent_id,
        NOT (${scope.sourceExit
          // S's sources ended above and its projection is no longer active,
          // so only another server's live source keeps the person in J.
          ? jointHumanHasLiveSourceSql(sql`m.joint_channel_id`, sql`m.user_id`)
          : jointHumanConnectedIdentitySql(sql`m.joint_channel_id`, sql`m.user_id`)}) remove_membership
      FROM joint_channel_members m
      JOIN server_members sm ON sm.user_id=m.user_id AND sm.server_id=${scope.entryServerId}::uuid
        -- P3: the entry's Guest bound to this projection departs with it.
        AND (sm.role<>'guest' OR sm.guest_channel_id=${scope.localChannelId}::uuid)
      WHERE m.joint_channel_id=${scope.jointId}::uuid
      UNION
      SELECT NULL::uuid user_id,a.id agent_id,true remove_membership FROM agents a JOIN channel_agents ca ON ca.agent_id=a.id
      WHERE a.server_id=${scope.entryServerId}::uuid AND ca.channel_id IN (${jointConversationFamilySql(scope.jointId)})
    ) v`);
  const count = await tx
    .select({ id: jointMembershipRemovals.id })
    .from(jointMembershipRemovals)
    .where(eq(jointMembershipRemovals.departureId, id))
    .limit(JOINT_DEPARTURE_BATCH_SIZE + 1);
  // Ordinary disconnect performs physical revocation in the original commit.
  // Large disconnect commits the denial list and lets the durable runner chunk.
  if (count.length <= JOINT_DEPARTURE_BATCH_SIZE)
    await removeMembershipBatch(tx, departure!, scope.sourceExit);
  const claim = await createDurableTask(tx, {
    definition: jointDepartureDefinition,
    payload: { departureId: id },
  });
  // A latency kick, not a permission boundary. It runs outside the outermost
  // transaction, including nested callers; after rollback extendLease finds no
  // committed task and does nothing. Recovery covers a lost process/kick.
  afterAmbientTransaction(() => {
    if (effects)
      void runJointMembershipDeparture(claim).catch((error) => {
        console.error("[JointDeparture] post-commit run failed", error);
      });
  });
  return { departureId: id, claim, subjectCountAtMost: count.length };
}

/** One J's removals in the caller's transaction, which holds the flag locks
 * and J. Storage only: the caller owns membership audit and post-commit
 * revocation, and gets back the people whose J membership this call actually
 * deleted (not the requested ones: a retry or another writer may have done it).
 * - `full`: leave J. Their CH rows across the J family and their member row.
 * - `entryOnly`: keep J, lose `entryServerId`'s entry: that entry's CH rows.
 * - `agents`: their CA rows across the family.
 * - `tasks`: unassign the full and agent subjects from J's open tasks, with
 *   one task event each; completed tasks keep their frozen assignee.
 * - `follows`: drop thread/task follows across the family, and each joint
 *   thread's local faces, for `full`; with `entryOnly: true` also the entry's
 *   follows for `entryOnly` subjects.
 * Read positions and history are never touched. */
export async function removeJointHumansInTransaction(
  tx: DatabaseExecutor,
  input: {
    jointId: string;
    entryServerId?: string;
    full: readonly string[];
    entryOnly?: readonly string[];
    agents?: readonly string[];
    tasks: { actorUserId: string | null; reason: string } | null;
    follows: { full: boolean; entryOnly: boolean };
  },
): Promise<string[]> {
  const humans = [...new Set(input.full)].sort();
  const entryOnly = [...new Set(input.entryOnly ?? [])].sort();
  const agents = [...new Set(input.agents ?? [])];
  if (entryOnly.length && !input.entryServerId) throw new Error("Entry-only joint removal needs its entry server");
  const rootChannels = jointConversationFamilySql(input.jointId);
  let removed: string[] = [];
  if (humans.length) {
    await tx
      .delete(channelHumans)
      .where(
        and(
          inArray(channelHumans.userId, humans),
          sql`${channelHumans.channelId} IN (${rootChannels})`,
        ),
      );
    removed = (await tx
      .delete(jointChannelMembers)
      .where(
        and(
          eq(jointChannelMembers.jointChannelId, input.jointId),
          inArray(jointChannelMembers.userId, humans),
        ),
      )
      .returning({ userId: jointChannelMembers.userId })).map((row) => row.userId).sort();
  }
  if (entryOnly.length)
    await tx
      .delete(channelHumans)
      .where(
        and(
          inArray(channelHumans.userId, entryOnly),
          sql`${channelHumans.channelId} IN (SELECT c.id FROM channels c WHERE c.server_id=${input.entryServerId}::uuid AND c.id IN (${rootChannels}))`,
        ),
      );
  if (agents.length) {
    await tx
      .delete(channelAgents)
      .where(
        and(
          inArray(channelAgents.agentId, agents),
          sql`${channelAgents.channelId} IN (${rootChannels})`,
        ),
      );
  }
  if ((input.follows.full && humans.length) || (input.follows.entryOnly && entryOnly.length)) {
    // A joint thread's local faces carry no parent pointer: they are the
    // projections of the thread's own joint, whose canonical is in the family.
    const followed = sql`(SELECT id FROM (${rootChannels}) family
      UNION SELECT tp.local_channel_id FROM joint_channel_servers tp JOIN joint_channels tj ON tj.id=tp.joint_channel_id
      WHERE tj.canonical_channel_id IN (${rootChannels}))`;
    if (input.follows.full && humans.length)
      await tx.execute(sql`DELETE FROM thread_follows WHERE follower_type='user'
        AND follower_id IN (${sql.join(humans.map((id) => sql`${id}::uuid`), sql`, `)})
        AND thread_channel_id IN ${followed}`);
    if (input.follows.entryOnly && entryOnly.length)
      await tx.execute(sql`DELETE FROM thread_follows f USING channels fc WHERE fc.id=f.thread_channel_id
        AND fc.server_id=${input.entryServerId}::uuid AND f.follower_type='user'
        AND f.follower_id IN (${sql.join(entryOnly.map((id) => sql`${id}::uuid`), sql`, `)})
        AND f.thread_channel_id IN ${followed}`);
  }
  const taskSettlement = input.tasks;
  if (taskSettlement && (humans.length || agents.length)) {
    // Settle only these assignees, preserving every other principal and
    // task. Completed tasks are historical and retain their frozen assignee.
    const changed = await tx.execute<{
      id: string;
      oldType: "user" | "agent";
      oldId: string;
    }>(sql`
      WITH removed AS (
        SELECT id,claimed_by_type,claimed_by_id FROM tasks
        WHERE channel_id=(SELECT canonical_channel_id FROM joint_channels WHERE id=${input.jointId}::uuid)
          AND status<>'done' AND (
            ${
              humans.length
                ? sql`(claimed_by_type='user' AND claimed_by_id IN (${sql.join(
                    humans.map((id) => sql`${id}`),
                    sql`, `,
                  )}))`
                : sql`false`
            }
            OR ${
              agents.length
                ? sql`(claimed_by_type='agent' AND claimed_by_id IN (${sql.join(
                    agents.map((id) => sql`${id}`),
                    sql`, `,
                  )}))`
                : sql`false`
            }
          ) FOR UPDATE
      ), updated AS (
        UPDATE tasks t SET claimed_by_type=NULL,claimed_by_id=NULL,claimed_at=NULL,revision=t.revision+1,updated_at=now(),last_activity_at=now()
        FROM removed r WHERE t.id=r.id RETURNING t.id,r.claimed_by_type AS "oldType",r.claimed_by_id AS "oldId"
      ) SELECT * FROM updated`);
    if (changed.rows.length)
      await tx.insert(taskEvents).values(
        changed.rows.map((row) => ({
          taskId: row.id,
          eventType: "assignee_changed" as const,
          actorType: taskSettlement.actorUserId
            ? ("user" as const)
            : ("system" as const),
          actorId: taskSettlement.actorUserId,
          payload: {
            assigneeType: null,
            assigneeId: null,
            previousAssigneeType: row.oldType,
            previousAssigneeId: row.oldId,
            reason: taskSettlement.reason,
          },
        })),
      );
  }
  return removed;
}

/** A host-side member (non-Guest member of J's host) this departure takes out
 * of J, the lowest id: the causal subject when it empties the host side. */
export async function departureHostSideSubject(tx: DatabaseExecutor, departureId: JointMembershipDepartureId): Promise<string | null> {
  const result = await tx.execute<{ userId: string }>(sql`SELECT jmr.user_id AS "userId" FROM joint_membership_removals jmr
    JOIN joint_membership_departures d ON d.id=jmr.departure_id
    JOIN joint_channels j ON j.id=d.joint_channel_id
    JOIN server_members hsm ON hsm.server_id=j.created_by_server_id AND hsm.user_id=jmr.user_id AND hsm.role<>'guest'
    WHERE jmr.departure_id=${departureId}::uuid AND jmr.remove_membership
    ORDER BY jmr.user_id LIMIT 1`);
  return result.rows[0]?.userId ?? null;
}

/** Who removed the people a departure batch takes out of J, for its audit:
 * the person who disconnected or deleted, else the system. Never the worker
 * running the batch, never the removed person by default. */
function departureAuditActor(departure: typeof jointMembershipDepartures.$inferSelect) {
  return departure.actorUserId ? { type: "human" as const, id: departure.actorUserId } : { type: "system" as const };
}

async function removeMembershipBatch(
  tx: DatabaseExecutor,
  departure: typeof jointMembershipDepartures.$inferSelect,
  sourceExit: boolean,
): Promise<Removal[]> {
  // Completed rows stay as history (who the disconnect removed) and are
  // skipped: the batch is the next rows still owing a removal or revocation.
  const rows = await tx
    .select()
    .from(jointMembershipRemovals)
    .where(
      and(
        eq(jointMembershipRemovals.departureId, departure.id),
        isNull(jointMembershipRemovals.completedAt),
      ),
    )
    .orderBy(jointMembershipRemovals.id)
    .limit(JOINT_DEPARTURE_BATCH_SIZE)
    .for("update");
  const fresh = rows.filter((row) => row.membershipRemovedAt === null);
  const agents = fresh.flatMap((row) => (row.agentId ? [row.agentId] : []));
  // The frozen snapshot decides full vs entry-only, whatever the flags say now.
  const removed = await removeJointHumansInTransaction(tx, {
    jointId: departure.jointChannelId,
    entryServerId: departure.serverId,
    full: fresh.flatMap((row) => row.userId && row.removeMembership ? [row.userId] : []),
    entryOnly: fresh.flatMap((row) => row.userId && !row.removeMembership ? [row.userId] : []),
    agents,
    tasks: fresh.length ? { actorUserId: departure.actorUserId, reason: "joint_channel_disconnected" } : null,
    // Leaving J ends its follows in both modes; an entry-only row's follows
    // through the departed entry go only with source exit.
    follows: { full: true, entryOnly: sourceExit },
  });
  if (fresh.length) {
    if (removed.length) {
      // One event per person whose J membership this batch actually ended, in
      // the commit that ends it and marks its progress, in both modes (the
      // snapshot is the decision, whatever the flag says now). A retry finds
      // the rows marked, or the member already gone, and writes none again.
      // Entry-only rows end no J membership and are not audited.
      const [joint] = await tx.execute<{ hostServerId: string }>(sql`SELECT created_by_server_id AS "hostServerId"
        FROM joint_channels WHERE id=${departure.jointChannelId}::uuid`).then((result) => result.rows);
      for (const userId of removed) {
        await recordChannelMembershipsEnded(tx, {
          reason: "server_departure",
          actor: departureAuditActor(departure),
          targetUserId: userId,
          memberships: [{
            serverId: departure.serverId,
            channelId: departure.localChannelId,
            channelType: "joint",
            joint: joint ? { jointChannelId: departure.jointChannelId, hostServerId: joint.hostServerId } : null,
          }],
        });
      }
    }
    const [source] = await tx
      .select({ name: channels.name })
      .from(channels)
      .where(eq(channels.id, departure.localChannelId))
      .limit(1);
    for (const agentId of agents) {
      const [latest] = await tx
        .select({
          activity: agentActivityEvents.activity,
          detail: agentActivityEvents.detail,
        })
        .from(agentActivityEvents)
        .where(eq(agentActivityEvents.agentId, agentId))
        .orderBy(desc(agentActivityEvents.createdAt))
        .limit(1);
      const key = `joint_departure:${departure.id}:${agentId}`;
      await tx
        .insert(agentActivityEvents)
        .values({
          agentId,
          activity: latest?.activity ?? "offline",
          detail: latest?.detail ?? "",
          dedupeKey: key,
          entries: [
            {
              kind: "slock_action",
              title: "Removed from joint channel",
              text: `Your server disconnected from #${source?.name ?? "joint"}. Reads, sends and task actions there are no longer allowed. Do not retry them. Other channels remain available. Stopping only an affected turn needs additional Computer support; the current turn has not been confirmed stopped.`,
              producerFactId: key,
            },
          ],
        })
        .onConflictDoNothing();
    }
    await tx
      .update(jointMembershipRemovals)
      .set({ membershipRemovedAt: currentDate() })
      .where(
        inArray(
          jointMembershipRemovals.id,
          fresh.map((row) => row.id),
        ),
      );
  }
  return rows;
}

/** A generation is the durable departure id. Reconnecting is refused until
 * completedAt, so an old worker can never delete a newly connected projection.
 * External effects run after commit, with the denial rows still in force. */
export async function cleanJointMembershipDepartureBatch(
  id: JointMembershipDepartureId,
  sideEffects: JointDepartureEffects,
  keepLease?: () => Promise<boolean>,
): Promise<boolean> {
  const batch = await getDb().transaction(async (tx) => {
    await bound(tx);
    const [departure] = await tx
      .select()
      .from(jointMembershipDepartures)
      .where(eq(jointMembershipDepartures.id, id))
      .for("update");
    if (!departure || departure.completedAt) return null;
    // The batch's audit rows reference the departed server (server_id FK:
    // KEY SHARE on its row). Take that row lock here, before the flags and J:
    // deleting the server holds it FOR UPDATE and then waits for J, so taking
    // it through the INSERT after J would close a cycle. The departure row is
    // held FOR UPDATE, so its state cannot change while we wait.
    await tx.execute(sql`SELECT id FROM servers WHERE id=${departure.serverId}::uuid FOR KEY SHARE`);
    await lockJoint(tx, departure.jointChannelId);
    const sourceExit = (await resolveJointSourceExitJointIds([departure.jointChannelId], tx)).has(departure.jointChannelId);
    return { departure, removals: await removeMembershipBatch(tx, departure, sourceExit) };
  });
  if (!batch) return true;
  if (batch.removals.length) await sideEffects.revoke(batch, keepLease);
  return getDb().transaction(async (tx) => {
    await bound(tx);
    const [departure] = await tx
      .select()
      .from(jointMembershipDepartures)
      .where(eq(jointMembershipDepartures.id, id))
      .for("update");
    if (!departure || departure.completedAt) return true;
    // Kept, marked completed: who a disconnect removed outlives its cleanup
    // (deleted 90 days after the departure completed,
    // jointMembershipRemovalRetention.ts). Pending-removal reads go through
    // the departure's completed_at, set below once no row is left owing.
    if (batch.removals.length)
      await tx
        .update(jointMembershipRemovals)
        .set({ completedAt: currentDate() })
        .where(
          and(
            eq(jointMembershipRemovals.departureId, id),
            inArray(
              jointMembershipRemovals.id,
              batch.removals.map((row) => row.id),
            ),
            sql`${jointMembershipRemovals.membershipRemovedAt} IS NOT NULL`,
            isNull(jointMembershipRemovals.completedAt),
          ),
        );
    const pending = await tx
      .select({ id: jointMembershipRemovals.id })
      .from(jointMembershipRemovals)
      .where(
        and(
          eq(jointMembershipRemovals.departureId, id),
          isNull(jointMembershipRemovals.completedAt),
        ),
      )
      .limit(1);
    if (pending.length) return false;
    await tx
      .update(jointMembershipDepartures)
      .set({ completedAt: currentDate() })
      .where(eq(jointMembershipDepartures.id, id));
    return true;
  });
}

export async function assertJointReconnectReady(
  tx: DatabaseExecutor,
  jointId: string,
  serverId: string,
) {
  const [pending] = await tx
    .select({ id: jointMembershipDepartures.id })
    .from(jointMembershipDepartures)
    .where(
      and(
        eq(jointMembershipDepartures.jointChannelId, jointId),
        eq(jointMembershipDepartures.serverId, serverId),
        isNull(jointMembershipDepartures.completedAt),
      ),
    )
    .limit(1);
  if (pending) throw new Error("Joint membership cleanup in progress");
}

const jointDepartureDefinition: DurableTaskDefinition<{
  departureId: JointMembershipDepartureId;
}> = {
  kind: durableTaskKind("joint.membership_departure"),
  payloadVersion: 1,
  leaseMs: 30_000,
  maxAttempts: 12,
  decode(payload, version) {
    if (
      version !== 1 ||
      typeof payload !== "object" ||
      payload === null ||
      !("departureId" in payload) ||
      typeof payload.departureId !== "string" ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.departureId)
    ) {
      throw new DurableTaskPermanentError("JOINT_DEPARTURE_PAYLOAD_INVALID");
    }
    return { departureId: payload.departureId as JointMembershipDepartureId };
  },
  async handle(payload, context: DurableTaskContext) {
    if (!effects)
      throw new Error("Joint departure runtime effects unavailable");
    for (;;) {
      if (!(await context.extendLease())) return;
      if (
        await cleanJointMembershipDepartureBatch(
          payload.departureId,
          effects,
          () => context.extendLease(),
        )
      )
        return;
    }
  },
};
// A dedicated registered kind is available before any functional cutover. Its
// recovery is started by the server independently of the legacy env switch.
export const jointDepartureRegistry = new DurableTaskRegistry().register(
  jointDepartureDefinition,
);
export function runJointMembershipDeparture(claim: DurableTaskClaim) {
  return runDurableTask(claim, jointDepartureRegistry);
}
