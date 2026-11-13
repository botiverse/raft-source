// channels.parent_channel_id phase 2: operator-run keyset backfill of the
// thread rows that existed before 0297. Live writes are already derived by the
// 0297 triggers; this only fills history.
//
// SCRIPT-ONLY: the sole non-test caller is scripts/parent-channel-id-backfill.ts,
// which builds its own single-connection pool. The server runtime never reaches
// this module.
//
// Each batch is one short autocommit UPDATE over at most `batchSize` thread rows
// in channels.id order. The value it writes is re-derived by the
// channels_parent_channel_id_update trigger anyway, so the column can only ever
// hold the parent message's current channel: a parent moved by a concurrent
// conversion is re-derived by whichever statement commits last, and the job is
// idempotent (`IS DISTINCT FROM`), so a re-run after any interruption only pays
// the scan. Row locks are FOR NO KEY UPDATE on thread rows, which readers' FOR
// KEY SHARE never waits on.
//
// Every updated row is also a CDC update to rw_channels, so batches are small
// and spaced; the operator runs it off-peak with the RW lag watch on.
import { setClockTimeout } from "@botiverse/raft-shared";
import { sql, type SQL } from "drizzle-orm";

export type BackfillExecutor = (query: SQL) => Promise<Array<Record<string, unknown>>>;

// The executor's connection carries the per-statement timeout (the script sets
// statement_timeout on its pool), so every batch is bounded.
export interface ParentChannelIdBackfillOptions {
  batchSize?: number;
  sleepMs?: number;
  /** Start after this channels.id (resume point printed by a previous run). */
  afterId?: string;
  log?: (line: string) => void;
}

export interface ParentChannelIdBackfillResult {
  batches: number;
  threadsScanned: number;
  rowsUpdated: number;
  lastId: string | null;
}

export interface ParentChannelIdDivergence {
  /** Thread rows whose value differs from the parent message's current channel (NULL when it has none). */
  divergentThreads: number;
  /** Non-thread rows with a value (must be 0; the trigger forces NULL). */
  nonThreadsWithValue: number;
  sampleIds: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

export async function runParentChannelIdBackfill(
  run: BackfillExecutor,
  options: ParentChannelIdBackfillOptions = {},
): Promise<ParentChannelIdBackfillResult> {
  const batchSize = options.batchSize ?? 1000;
  const sleepMs = options.sleepMs ?? 200;
  const log = options.log ?? (() => {});
  const result: ParentChannelIdBackfillResult = { batches: 0, threadsScanned: 0, rowsUpdated: 0, lastId: options.afterId ?? null };
  for (;;) {
    const rows = await run(sql`
      WITH batch AS (
        SELECT thread.id
        FROM channels thread
        WHERE thread.type = 'thread'
          AND thread.id > ${result.lastId ?? MIN_UUID}::uuid
        ORDER BY thread.id
        LIMIT ${batchSize}
      ),
      updated AS (
        UPDATE channels thread
        SET parent_channel_id = parent_message.channel_id
        FROM batch, messages parent_message
        WHERE thread.id = batch.id
          AND parent_message.id = thread.parent_message_id
          AND thread.parent_channel_id IS DISTINCT FROM parent_message.channel_id
        RETURNING thread.id
      )
      SELECT
        (SELECT count(*)::int FROM batch) AS scanned,
        (SELECT count(*)::int FROM updated) AS updated,
        (SELECT max(id::text) FROM batch) AS last_id
    `);
    const row = rows[0] as { scanned: number; updated: number; last_id: string | null } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    result.batches += 1;
    result.threadsScanned += row.scanned;
    result.rowsUpdated += row.updated;
    result.lastId = row.last_id;
    log(`[PARENT_CHANNEL_BACKFILL_BATCH] n=${result.batches} scanned=${row.scanned} updated=${row.updated} last_id=${row.last_id}`);
    if (row.scanned < batchSize) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return result;
}

/**
 * The phase-4 gate, in keyset slices so no single statement reads every thread's
 * parent: counts thread rows whose value is not their parent message's current
 * channel (a missing parent must read NULL) and non-thread rows with a value.
 */
export async function verifyParentChannelIds(
  run: BackfillExecutor,
  options: { batchSize?: number; sampleLimit?: number } = {},
): Promise<ParentChannelIdDivergence> {
  const batchSize = options.batchSize ?? 5000;
  const sampleLimit = options.sampleLimit ?? 20;
  const divergence: ParentChannelIdDivergence = { divergentThreads: 0, nonThreadsWithValue: 0, sampleIds: [] };
  let lastId = MIN_UUID;
  for (;;) {
    const rows = await run(sql`
      WITH slice AS (
        SELECT channel.id, channel.type, channel.parent_channel_id, channel.parent_message_id
        FROM channels channel
        WHERE channel.id > ${lastId}::uuid
        ORDER BY channel.id
        LIMIT ${batchSize}
      ),
      bad AS (
        SELECT slice.id
        FROM slice
        LEFT JOIN messages parent_message ON parent_message.id = slice.parent_message_id
        WHERE slice.type = 'thread'
          AND slice.parent_channel_id IS DISTINCT FROM parent_message.channel_id
      )
      SELECT
        (SELECT count(*)::int FROM slice) AS scanned,
        (SELECT max(id::text) FROM slice) AS last_id,
        (SELECT count(*)::int FROM bad) AS divergent,
        -- Task v2 conversations (type 'task') carry parent_channel_id by design.
        (SELECT count(*)::int FROM slice WHERE type NOT IN ('thread', 'task') AND parent_channel_id IS NOT NULL) AS non_thread,
        (SELECT coalesce(array_agg(id::text), '{}') FROM (SELECT id FROM bad LIMIT ${sampleLimit}) sample) AS sample_ids
    `);
    const row = rows[0] as { scanned: number; last_id: string | null; divergent: number; non_thread: number; sample_ids: string[] } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    divergence.divergentThreads += row.divergent;
    divergence.nonThreadsWithValue += row.non_thread;
    for (const id of row.sample_ids) {
      if (divergence.sampleIds.length < sampleLimit) divergence.sampleIds.push(id);
    }
    lastId = row.last_id;
    if (row.scanned < batchSize) break;
  }
  return divergence;
}
