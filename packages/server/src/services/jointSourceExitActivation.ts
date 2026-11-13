import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db";
import {
  createFirstServerAllowFeatureFlagRule,
  type FeatureFlagOperatorActor,
} from "./featureFlagService";
import {
  JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY,
  jointHumanHasLiveSourceSql,
  jointMembershipRemovalPendingSql,
} from "./jointHumanMembershipAccess";

/** Current members of the hosts' active joints who hold no live source, per
 * joint. Turning source exit on would deny them silently, with no removal,
 * audit or revocation, so activation refuses while any exist. Members already
 * queued for removal are denied either way and do not count. */
export async function countJointMembersWithoutLiveSource(
  tx: DatabaseExecutor,
  hostServerIds: readonly string[],
): Promise<Array<{ hostServerId: string; jointId: string; members: number }>> {
  const hosts = [...new Set(hostServerIds)].sort();
  if (hosts.length === 0) return [];
  const result = await tx.execute<{ hostServerId: string; jointId: string; members: number }>(sql`
    SELECT j.created_by_server_id AS "hostServerId", j.id AS "jointId", count(*)::int AS members
    FROM joint_channels j JOIN joint_channel_members m ON m.joint_channel_id=j.id
    WHERE j.status='active' AND j.created_by_server_id IN (${sql.join(hosts.map((id) => sql`${id}::uuid`), sql`, `)})
      AND NOT (${jointMembershipRemovalPendingSql(sql`m.joint_channel_id`, "user", sql`m.user_id`)})
      AND NOT (${jointHumanHasLiveSourceSql(sql`m.joint_channel_id`, sql`m.user_id`)})
    GROUP BY j.created_by_server_id, j.id
    ORDER BY j.created_by_server_id, j.id`);
  return result.rows.map((row) => ({ ...row, members: Number(row.members) }));
}

export class JointSourceExitActivationRefusedError extends Error {
  constructor(readonly withoutLiveSource: Array<{ hostServerId: string; jointId: string; members: number }>) {
    super(`Source exit not enabled: ${withoutLiveSource.reduce((sum, row) => sum + row.members, 0)} joint member(s) have no live source (${
      withoutLiveSource.map((row) => `host ${row.hostServerId} joint ${row.jointId}: ${row.members}`).join("; ")})`);
  }
}

/**
 * Turn joint_source_exit_v1 on for `hostServerIds` (the flag's first server
 * allow rule) only if none of their joints has a member without a live
 * source. The count and the rule are one primary transaction under the flag's
 * exclusive lock; every membership writer holds the shared lock before its J
 * lock (acquireJointSourceExitFlagReadLock), so no leave can end a last
 * source between the check and the flag change. Refuses, writing nothing,
 * with the counts otherwise. Returns null when the flag row does not exist.
 */
export async function activateJointSourceExit(input: {
  hostServerIds: string[];
  expectedConfigVersion: number;
  actor: FeatureFlagOperatorActor;
  auditEventId?: string | null;
}) {
  return createFirstServerAllowFeatureFlagRule({
    flagKey: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY,
    serverIds: input.hostServerIds,
    expectedConfigVersion: input.expectedConfigVersion,
    actor: input.actor,
    auditEventId: input.auditEventId ?? null,
    preflight: async (tx, hosts) => {
      const withoutLiveSource = await countJointMembersWithoutLiveSource(tx, hosts);
      if (withoutLiveSource.length) throw new JointSourceExitActivationRefusedError(withoutLiveSource);
    },
  });
}
