import { eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { channels, channelConversionJobs, jointChannels, jointChannelServers, messages } from "../db/schema";

/** Storage equivalence only; callers must authorize the local request surface.
 * Resolve in the read statement's snapshot so committing a batch cannot hide
 * rows between resolving an id list and reading it. Never joins peer projections.
 * Retain the mapping after success for requests that straddle final cutover.
 */
export function conversionReadChannelIdsQuery(channelId: string | SQLWrapper): SQL {
  return sql`
    SELECT ${channelId}::uuid AS id
    UNION
    SELECT paired.id FROM ${channelConversionJobs} job
      CROSS JOIN LATERAL (VALUES (job.source_channel_id), (job.canonical_channel_id)) paired(id)
      WHERE job.status <> 'canceled'
        AND ${channelId}::uuid IN (job.source_channel_id, job.canonical_channel_id)
    UNION
    SELECT paired.id
      FROM ${jointChannelServers} projection
      JOIN ${jointChannels} joint_thread ON joint_thread.id = projection.joint_channel_id
      JOIN ${channels} canonical_thread ON canonical_thread.id = joint_thread.canonical_channel_id
      JOIN ${messages} parent_message ON parent_message.id = canonical_thread.parent_message_id
      JOIN ${channelConversionJobs} job ON parent_message.channel_id IN (job.source_channel_id, job.canonical_channel_id)
        AND job.server_id = projection.server_id AND job.status <> 'canceled'
      CROSS JOIN LATERAL (VALUES (projection.local_channel_id), (joint_thread.canonical_channel_id)) paired(id)
      WHERE projection.role = 'host' AND projection.status = 'active'
        AND ${channelId}::uuid IN (projection.local_channel_id, joint_thread.canonical_channel_id)
        -- Index prefilter only: implied by, never a replacement for, the line
        -- above (which keeps peer projections out). Lets each side of that OR
        -- use its own index instead of fanning out from every host projection
        -- on the job's server (~5 ms on prod, growing with joints).
        AND joint_thread.id IN (
          SELECT local_projection.joint_channel_id FROM ${jointChannelServers} local_projection
            WHERE local_projection.local_channel_id = ${channelId}::uuid
          UNION ALL
          SELECT canonical_joint.id FROM ${jointChannels} canonical_joint
            WHERE canonical_joint.canonical_channel_id = ${channelId}::uuid
        )
  `;
}

export function conversionReadChannelPredicate(column: SQLWrapper, channelId: string | SQLWrapper) {
  return sql`(${column} IN (${conversionReadChannelIdsQuery(channelId)}))`;
}

export async function resolveConversionReadChannelIds(
  executor: DatabaseExecutor,
  channelId: string,
): Promise<string[]> {
  const result = await executor.execute(conversionReadChannelIdsQuery(channelId));
  return result.rows.map((row) => String(row.id));
}

/**
 * Bind an already-resolved conversion scope as literal values. For a
 * newest-first LIMIT, this keeps channel_id in an index condition instead of
 * letting Postgres walk the global seq index and apply a subquery join filter.
 * Resolve and consume these ids inside the same repeatable-read transaction.
 */
export function resolvedConversionReadChannelPredicate(
  column: Parameters<typeof eq>[0],
  channelIds: string[],
): SQL {
  if (channelIds.length === 0) return sql`false`;
  if (channelIds.length === 1) return eq(column, channelIds[0]);
  return inArray(column, channelIds);
}
