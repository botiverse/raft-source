import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db";
import {
  lockComputedJointActor,
  resolveChannelActorContext,
} from "../lib/channelActorPermissions";
import { resolveJointHumanEntrySql } from "./jointHumanMembershipAccess";

export type JointTaskWriteActor = {
  type: "user" | "agent";
  id: string;
  serverId?: string;
};
export class JointTaskWriteDeniedError extends Error {
  readonly status = 403;
  readonly code = "task_channel_membership_required";
  constructor() {
    super("Current channel membership is required");
  }
}

/** Recheck at persistence, before task/channel row locks. Human requests pin
 * their addressed server; agents always use their own server. Canonical task
 * storage is never an entry. Background maintenance has no acting principal. */
export async function lockJointTaskWriteAuthority(
  tx: DatabaseExecutor,
  channelId: string,
  actor: JointTaskWriteActor,
) {
  const root = await tx.execute<{ jointId: string }>(sql`
    SELECT j.id AS "jointId" FROM joint_channels j JOIN channels c ON c.id=j.canonical_channel_id
    WHERE (j.canonical_channel_id=${channelId}::uuid OR EXISTS (SELECT 1 FROM joint_channel_servers p
      WHERE p.joint_channel_id=j.id AND p.local_channel_id=${channelId}::uuid))
      AND c.type IN ('channel','private','joint') LIMIT 1`);
  if (!root.rows.length) return;
  const permission =
    actor.type === "user"
      ? await resolveJointHumanEntrySql(
          { jointIds: [root.rows[0]!.jointId] },
          tx,
        )
      : null;
  const entries = await tx.execute<{ id: string; serverId: string }>(sql`
    SELECT p.local_channel_id id,p.server_id AS "serverId" FROM joint_channel_servers p
    WHERE p.joint_channel_id=${root.rows[0]!.jointId}::uuid
      AND ${actor.serverId ? sql`p.server_id=${actor.serverId}::uuid` : sql`true`}
      AND ${
        actor.type === "agent"
          ? sql`EXISTS (SELECT 1 FROM agents a WHERE a.id=${actor.id}::uuid AND a.server_id=p.server_id AND a.deleted_at IS NULL)`
          : permission!(sql`p.local_channel_id`, sql`${actor.id}::uuid`)
      }
    ORDER BY p.server_id LIMIT 1`);
  const entry = entries.rows[0];
  if (!entry) throw new JointTaskWriteDeniedError();
  await tx.execute(
    sql`SELECT id FROM channels WHERE id=${entry.id}::uuid FOR SHARE`,
  );
  await lockComputedJointActor(
    {
      serverId: entry.serverId,
      channelId: entry.id,
      actorType: actor.type,
      actorId: actor.id,
    },
    tx,
  );
  const context = await resolveChannelActorContext(
    entry.serverId,
    entry.id,
    actor.type,
    actor.id,
    tx,
  );
  // A Guest writes tasks only where its context admits it: the host
  // projection it is bound to, host external_channels_v1 on (P3), and never
  // in an archived channel (the guest read rule).
  if (
    !context?.canAccessChannel ||
    (context.serverRole === "guest" && context.channelArchivedAt) ||
    context.channelDeletedAt
  )
    throw new JointTaskWriteDeniedError();
}
