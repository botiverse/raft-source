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

/**
 * Online move (channel_conversion_online_move_v1): while a conversion job is
 * in phase `online_move`, the source channel stays an ordinary channel that
 * takes writes, but its new root messages are stored in the job's canonical
 * channel; its not yet moved messages stay in the source. This is the ONE
 * predicate for "this root is in an online move, and its canonical is ...":
 * the writer's storage resolution (getMessageStorageChannelIdWithExecutor,
 * under lockAndResolveMessageStorage's row lock), the joint thread projection
 * lookup (a canonical thread whose parent is still in the source), and the
 * search visibility (visibleRootChannelIds) all read it from here.
 *
 * The route only changes in a transaction holding the source row FOR UPDATE
 * (the start, a cancel, and the switch), so a reader under the source row's
 * FOR KEY SHARE sees a stable answer. Served by the partial unique index
 * idx_channel_conversion_jobs_active_source (source_channel_id WHERE status
 * IN ('pending', 'running', 'failed')): at most one active job per source.
 */
export function onlineMoveJobsSql(sourceChannelIds: SQL): SQL {
  return sql`
    SELECT online_job.source_channel_id, online_job.canonical_channel_id
      FROM ${channelConversionJobs} online_job
     WHERE online_job.source_channel_id = ANY(${sourceChannelIds})
       AND ${onlineMoveJobCondition(sql`online_job`)}`;
}

/** The condition itself, on a channel_conversion_jobs row aliased `job`: in an online move. */
function onlineMoveJobCondition(job: SQL): SQL {
  return sql`${job}.status IN ('pending', 'running')
       AND ${job}.phase = 'online_move'
       AND ${job}.canonical_channel_id IS NOT NULL`;
}

/**
 * Whether `canonicalChannelId` (an SQL expression) is the canonical channel of
 * an online move: joint storage whose people are still the source's ordinary
 * members (the audience moves at the switch), so a joint authority check
 * there has no joint membership to find. Served by
 * idx_channel_conversion_jobs_phase (phase = 'online_move' holds only the
 * in-flight online moves), filtered by canonical id.
 */
export function isOnlineMoveCanonicalSql(canonicalChannelId: SQLWrapper): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${channelConversionJobs} online_canonical_job
     WHERE online_canonical_job.canonical_channel_id = ${canonicalChannelId}
       AND ${onlineMoveJobCondition(sql`online_canonical_job`)})`;
}

export type OnlineMovePair = { sourceChannelId: string; canonicalChannelId: string };

/**
 * The online move `channelId` takes part in, as its source or its canonical
 * channel, or null. Same condition as onlineMoveJobsSql; served by
 * idx_channel_conversion_jobs_phase (phase = 'online_move': in-flight online
 * moves only).
 */
export async function onlineMovePairForChannel(executor: DatabaseExecutor, channelId: string): Promise<OnlineMovePair | null> {
  const result = await executor.execute(onlineMovePairSql(sql`${channelId}::uuid`));
  const row = result.rows[0] as { source_channel_id?: unknown; canonical_channel_id?: unknown } | undefined;
  return typeof row?.source_channel_id === "string" && typeof row.canonical_channel_id === "string"
    ? { sourceChannelId: row.source_channel_id, canonicalChannelId: row.canonical_channel_id }
    : null;
}

/** @internal The statement onlineMovePairForChannel runs (EXPLAINed by the real-PG test). */
export function onlineMovePairSql(channelId: SQLWrapper): SQL {
  return sql`
    SELECT pair_job.source_channel_id::text AS source_channel_id, pair_job.canonical_channel_id::text AS canonical_channel_id
      FROM ${channelConversionJobs} pair_job
     WHERE (pair_job.source_channel_id = ${channelId} OR pair_job.canonical_channel_id = ${channelId})
       AND ${onlineMoveJobCondition(sql`pair_job`)}
     LIMIT 1`;
}

/**
 * The source channel of the online move `channelId` (an SQL expression) takes
 * part in, as its source or its canonical channel; NULL when it is in none.
 * A scalar subquery to fold into a statement the caller runs anyway.
 */
export function onlineMoveSourceForChannelSql(channelId: SQLWrapper): SQL {
  return sql`(SELECT pair_job.source_channel_id FROM (${onlineMovePairSql(channelId)}) pair_job)`;
}

/**
 * The other channel of the online move `channelId` (an SQL expression) takes
 * part in: the canonical channel of a source, the source of a canonical
 * channel; NULL when it is in none. For the readers that take a root's
 * latest message across the pair while its messages are in both.
 */
export function onlineMoveOtherChannelSql(channelId: SQLWrapper): SQL {
  return sql`(SELECT CASE WHEN pair_job.source_channel_id::uuid = ${channelId} THEN pair_job.canonical_channel_id ELSE pair_job.source_channel_id END::uuid
    FROM (${onlineMovePairSql(channelId)}) pair_job)`;
}

/** onlineMoveJobsSql as a scalar SQL expression: the canonical id for one source id expression, or NULL. */
export function onlineMoveCanonicalForRootSql(sourceChannelId: SQLWrapper): SQL {
  return sql`(SELECT online_move.canonical_channel_id FROM (${onlineMoveJobsSql(sql`ARRAY[${sourceChannelId}]::uuid[]`)}) online_move LIMIT 1)`;
}

/** The canonical channel of `sourceChannelId`'s online move, or null when it is in none. */
export async function onlineMoveCanonicalForRoot(executor: DatabaseExecutor, sourceChannelId: string): Promise<string | null> {
  const canonical = await onlineMoveCanonicalsForRoots(executor, [sourceChannelId]);
  return canonical.get(sourceChannelId) ?? null;
}

/** onlineMoveCanonicalForRoot for many roots in one index probe each: source id to canonical id, only those in an online move. */
export async function onlineMoveCanonicalsForRoots(executor: DatabaseExecutor, sourceChannelIds: readonly string[]): Promise<Map<string, string>> {
  const byRoot = new Map<string, string>();
  if (sourceChannelIds.length === 0) return byRoot;
  const result = await executor.execute(onlineMoveJobsSql(sql`${`{${[...new Set(sourceChannelIds)].join(",")}}`}::uuid[]`));
  for (const row of result.rows as Array<{ source_channel_id?: unknown; canonical_channel_id?: unknown }>) {
    if (typeof row.source_channel_id === "string" && typeof row.canonical_channel_id === "string") {
      byRoot.set(row.source_channel_id, row.canonical_channel_id);
    }
  }
  return byRoot;
}
