import { sql } from "drizzle-orm";
import { currentTimeMs } from "@botiverse/raft-shared";
import { getDb, registerDatabaseCloseHookForTests } from "../db/index";
import { messages } from "../db/schema";

type Coverage = { totalMessages: number; windowMessages: number; earliestAt: string | null; latestAt: string | null; from: string; to: string; checkedAt: string };
// A scope holds thousands of thread sources. One statement over all of them
// outran the 15 s statement timeout on a cold cache, so count in bounded chunks.
const CHUNK_SIZE = 500;
const CACHE_MS = 5 * 60_000;
// A count over thousands of sources takes tens of seconds on a busy database, longer
// than a page waits. Serve the last finished count at once and refresh it in the
// background: at most one count per scope at a time, at most one per CACHE_MS.
const cache = new Map<string, { last?: Coverage; bucket?: number; finishedAt?: number; pending?: Promise<Coverage> }>();
registerDatabaseCloseHookForTests(async () => { cache.clear(); });
/** Call only after checking both the administrator's and service identity's live source ACLs. */
export function sourceCoverage(serverId: string, revision: number, storageIds: string[], from: Date, to: Date): Promise<Coverage> {
  const ids = [...new Set(storageIds)].sort();
  // Without a run the window ends now; bucketing it keeps a finished count reusable.
  const key = JSON.stringify([serverId, revision, ids, from.toISOString()]), bucket = Math.floor(to.getTime() / CACHE_MS);
  const entry = cache.get(key) ?? {};
  if (!cache.has(key)) {
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
  }
  const stale = !entry.last || entry.bucket !== bucket || currentTimeMs() - entry.finishedAt! >= CACHE_MS;
  if (stale && !entry.pending) {
    const pending = countCoverage(ids, from, to);
    entry.pending = pending;
    pending.then(value => { Object.assign(entry, { last: value, bucket, finishedAt: currentTimeMs(), pending: undefined }); },
      () => { entry.pending = undefined; });
  }
  // The served coverage carries its own window and checkedAt.
  return entry.last ? Promise.resolve(entry.last) : entry.pending!;
}

async function countCoverage(ids: string[], from: Date, to: Date): Promise<Coverage> {
  let totalMessages = 0, windowMessages = 0, earliest: number | null = null, latest: number | null = null;
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    // Per-source lookups use the (channel_id, created_at) index; a flat IN list
    // over thousands of ids let the planner scan messages beyond the scope.
    const [row] = await getDb().select({
      totalMessages: sql<number>`coalesce(sum(per.total), 0)`.mapWith(Number),
      windowMessages: sql<number>`coalesce(sum(per.in_window), 0)`.mapWith(Number),
      earliestAt: sql<string | null>`min(per.earliest)::text`,
      latestAt: sql<string | null>`max(per.latest)::text`,
    }).from(sql`unnest(${sql.param(ids.slice(start, start + CHUNK_SIZE))}::uuid[]) AS source(channel_id)
      CROSS JOIN LATERAL (
        SELECT count(*) AS total,
          count(*) FILTER (WHERE created_at >= ${from.toISOString()}::timestamptz AND created_at < ${to.toISOString()}::timestamptz) AS in_window,
          min(created_at) AS earliest, max(created_at) AS latest
        FROM ${messages} WHERE channel_id = source.channel_id AND deleted_at IS NULL
      ) AS per`);
    totalMessages += row?.totalMessages ?? 0;
    windowMessages += row?.windowMessages ?? 0;
    if (row?.earliestAt) earliest = Math.min(earliest ?? Infinity, new Date(row.earliestAt).getTime());
    if (row?.latestAt) latest = Math.max(latest ?? -Infinity, new Date(row.latestAt).getTime());
  }
  return { totalMessages, windowMessages,
    earliestAt: earliest === null ? null : new Date(earliest).toISOString(),
    latestAt: latest === null ? null : new Date(latest).toISOString(),
    from: from.toISOString(), to: to.toISOString(), checkedAt: new Date(currentTimeMs()).toISOString() };
}
