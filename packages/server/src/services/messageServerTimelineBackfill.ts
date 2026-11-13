// message_server_timeline step 2: operator-run keyset backfill of the messages
// that existed before 0310. Live writes are already covered by the 0310
// triggers from the moment the migration committed; this only fills history.
//
// SCRIPT-ONLY: the sole non-test caller is scripts/message-server-timeline-backfill.ts,
// which builds its own single-connection pool. The server runtime never reaches
// this module.
//
// Each batch is one short autocommit INSERT ... SELECT over at most `batchSize`
// messages in messages.id order, ON CONFLICT DO NOTHING: a row the trigger (a
// new message, or a message moved during the run) already wrote is newer than
// anything this batch could compute, so it is left alone, and a re-run after
// any interruption only pays the scan. Keyset on id rather than ctid ranges, so
// a message whose tuple moves (an edit) during the run is never skipped.
//
// The table is not in slock_rw_publication, so no batch reaches RisingWave CDC;
// the cost is WAL volume (about the new table's size) and messages' primary key
// reads. Batches are still spaced so the replica keeps up.
import { setClockTimeout } from "@botiverse/raft-shared";
import { sql, type SQL } from "drizzle-orm";
import { REPLICATION_SLOT_QUERY } from "../db/replicationSlotMonitor";

export type BackfillExecutor = (query: SQL) => Promise<Array<Record<string, unknown>>>;

// The executor's connection carries the per-statement timeout (the script sets
// statement_timeout on its pool), so every batch is bounded.
export interface MessageServerTimelineBackfillOptions {
  batchSize?: number;
  sleepMs?: number;
  /** Start after this messages.id (resume point printed by a previous run). */
  afterId?: string;
  log?: (line: string) => void;
}

export interface MessageServerTimelineBackfillResult {
  batches: number;
  messagesScanned: number;
  rowsInserted: number;
  lastId: string | null;
}

export interface MessageServerTimelineDivergence {
  /** Messages with no timeline row. */
  missingRows: number;
  /** Timeline rows whose server, time or channel differs from the message's current values. */
  divergentRows: number;
  sampleIds: string[];
  /** Messages the verify actually scanned: a 0/0 result is only meaningful when this covers the table. */
  scannedRows: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

export async function runMessageServerTimelineBackfill(
  run: BackfillExecutor,
  options: MessageServerTimelineBackfillOptions = {},
): Promise<MessageServerTimelineBackfillResult> {
  const batchSize = options.batchSize ?? 5000;
  const sleepMs = options.sleepMs ?? 200;
  const log = options.log ?? (() => {});
  const result: MessageServerTimelineBackfillResult = { batches: 0, messagesScanned: 0, rowsInserted: 0, lastId: options.afterId ?? null };
  for (;;) {
    const rows = await run(sql`
      WITH batch AS (
        SELECT m.id, m.channel_id, m.created_at
        FROM messages m
        WHERE m.id > ${result.lastId ?? MIN_UUID}::uuid
        ORDER BY m.id
        LIMIT ${batchSize}
      ),
      inserted AS (
        INSERT INTO message_server_timeline (message_id, server_id, created_at, channel_id)
        SELECT batch.id, c.server_id, batch.created_at, batch.channel_id
        FROM batch
        JOIN channels c ON c.id = batch.channel_id
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      )
      SELECT
        (SELECT count(*)::int FROM batch) AS scanned,
        (SELECT count(*)::int FROM inserted) AS inserted,
        (SELECT max(id::text) FROM batch) AS last_id
    `);
    const row = rows[0] as { scanned: number; inserted: number; last_id: string | null } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    result.batches += 1;
    result.messagesScanned += row.scanned;
    result.rowsInserted += row.inserted;
    result.lastId = row.last_id;
    log(`[MESSAGE_TIMELINE_BACKFILL_BATCH] n=${result.batches} scanned=${row.scanned} inserted=${row.inserted} last_id=${row.last_id}`);
    if (row.scanned < batchSize) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return result;
}

/**
 * The switch gate, in keyset slices over messages.id so no statement reads the
 * whole table: messages without a timeline row, and rows that disagree with the
 * message's current channel, the channel's server, or the message's time.
 * Timeline rows without a message cannot exist (FK ON DELETE CASCADE).
 * Run after the backfill has finished; during it, "missing" counts the messages
 * it has not reached yet.
 */
export async function verifyMessageServerTimeline(
  run: BackfillExecutor,
  options: { batchSize?: number; sampleLimit?: number; afterId?: string; log?: (line: string) => void } = {},
): Promise<MessageServerTimelineDivergence> {
  const batchSize = options.batchSize ?? 20_000;
  // A 0-row slice scans nothing and would report a clean 0/0.
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`verify batchSize must be >= 1, got ${batchSize}`);
  const sampleLimit = options.sampleLimit ?? 20;
  const divergence: MessageServerTimelineDivergence = { missingRows: 0, divergentRows: 0, sampleIds: [], scannedRows: 0 };
  // afterId resumes a verify that was cancelled part-way (e.g. by replica replay
  // conflicts); counts then cover only the messages after it.
  let lastId = options.afterId ?? MIN_UUID;
  for (;;) {
    const rows = await run(sql`
      WITH slice AS (
        SELECT m.id, m.channel_id, m.created_at
        FROM messages m
        WHERE m.id > ${lastId}::uuid
        ORDER BY m.id
        LIMIT ${batchSize}
      ),
      checked AS (
        SELECT
          slice.id,
          t.message_id IS NULL AS missing,
          t.message_id IS NOT NULL AND (
            t.server_id IS DISTINCT FROM c.server_id
            OR t.created_at IS DISTINCT FROM slice.created_at
            OR t.channel_id IS DISTINCT FROM slice.channel_id
          ) AS divergent
        FROM slice
        JOIN channels c ON c.id = slice.channel_id
        LEFT JOIN message_server_timeline t ON t.message_id = slice.id
      )
      SELECT
        (SELECT count(*)::int FROM slice) AS scanned,
        (SELECT max(id::text) FROM slice) AS last_id,
        (SELECT count(*)::int FROM checked WHERE missing) AS missing,
        (SELECT count(*)::int FROM checked WHERE divergent) AS divergent,
        (SELECT coalesce(array_agg(id::text), '{}') FROM (SELECT id FROM checked WHERE missing OR divergent LIMIT ${sampleLimit}) sample) AS sample_ids
    `);
    const row = rows[0] as { scanned: number; last_id: string | null; missing: number; divergent: number; sample_ids: string[] } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    divergence.scannedRows += row.scanned;
    divergence.missingRows += row.missing;
    divergence.divergentRows += row.divergent;
    for (const id of row.sample_ids) {
      if (divergence.sampleIds.length < sampleLimit) divergence.sampleIds.push(id);
    }
    lastId = row.last_id;
    options.log?.(`[MESSAGE_TIMELINE_VERIFY_PROGRESS] ${JSON.stringify({ lastId, scannedRows: divergence.scannedRows, missingRows: divergence.missingRows, divergentRows: divergence.divergentRows })}`);
    if (row.scanned < batchSize) break;
  }
  return divergence;
}

// search_vector (0658) fill: the same operator tool, a second pass over the
// timeline itself (keyset on message_id) copying messages.search_vector into
// rows that do not have it yet. Only NULL rows are filled: a row the triggers
// wrote or re-copied since 0658 (a new message, an edit) already holds the
// current vector, and the `IS NULL` recheck on the locked row version keeps a
// batch that read the message before a concurrent edit from overwriting it.
// Touches no messages row, so a send never waits on it; not in the RisingWave
// publication, so the cost is WAL (about the vectors' size) and the replica.
//
// The fill writes about 30 GB of WAL, and the CDC slot has to read past all of
// it even though none of it is published: a slow RisingWave consumer makes the
// slot hold it. Before every batch the fill reads slock_dist_cdc_slot with
// replicationSlotMonitor's query and applies the closed-server purge's rule
// (#13866): retained WAL over 64 MB pauses until it is under 32 MB, over 250 MB
// or wal_status other than `reserved` stops the run (re-run with the printed
// --after-id). A slot that does not exist (dev, staging, tests) is no reading.
export const CDC_SLOT_NAME = "slock_dist_cdc_slot";
const MB = 1024 * 1024;
export const SLOT_PAUSE_BYTES = 64 * MB;
export const SLOT_RESUME_BYTES = 32 * MB;
export const SLOT_STOP_BYTES = 250 * MB;

export interface CdcSlotReading {
  retainedWalBytes: number | null;
  walStatus: string | null;
}

/** The CDC slot's reading on the primary; null when the slot does not exist. */
export async function readCdcSlot(run: BackfillExecutor): Promise<CdcSlotReading | null> {
  const rows = await run(sql`
    SELECT wal_status, retained_wal_bytes FROM (${sql.raw(REPLICATION_SLOT_QUERY)}) slots
     WHERE slot_name = ${CDC_SLOT_NAME}`);
  const row = rows[0] as { wal_status: string | null; retained_wal_bytes: number | string | null } | undefined;
  if (!row) return null;
  return { walStatus: row.wal_status, retainedWalBytes: row.retained_wal_bytes === null ? null : Number(row.retained_wal_bytes) };
}

export type CdcSlotVerdict = "go" | "pause" | "stop";

/** `paused`: an earlier reading paused and none since has been under SLOT_RESUME_BYTES. */
export function cdcSlotVerdict(reading: CdcSlotReading | null, paused: boolean): CdcSlotVerdict {
  if (!reading) return "go";
  if (reading.walStatus !== null && reading.walStatus !== "reserved") return "stop";
  const bytes = reading.retainedWalBytes;
  if (bytes === null || !Number.isFinite(bytes)) return paused ? "pause" : "go";
  if (bytes > SLOT_STOP_BYTES) return "stop";
  if (bytes > SLOT_PAUSE_BYTES) return "pause";
  if (paused && bytes >= SLOT_RESUME_BYTES) return "pause";
  return "go";
}

export interface MessageServerTimelineSearchVectorBackfillOptions extends MessageServerTimelineBackfillOptions {
  /** Defaults to readCdcSlot on the same connection. */
  readSlot?: () => Promise<CdcSlotReading | null>;
  /** Wait between readings while paused. */
  slotPollMs?: number;
}

export interface MessageServerTimelineSearchVectorBackfillResult {
  batches: number;
  rowsScanned: number;
  rowsFilled: number;
  lastId: string | null;
  /** Set when the CDC slot stopped the run: resume with --after-id lastId. */
  stoppedBy: "slot" | null;
  slotPauses: number;
}

export async function runMessageServerTimelineSearchVectorBackfill(
  run: BackfillExecutor,
  options: MessageServerTimelineSearchVectorBackfillOptions = {},
): Promise<MessageServerTimelineSearchVectorBackfillResult> {
  const batchSize = options.batchSize ?? 2000;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`backfill batchSize must be >= 1, got ${batchSize}`);
  const sleepMs = options.sleepMs ?? 200;
  const log = options.log ?? (() => {});
  const readSlot = options.readSlot ?? (() => readCdcSlot(run));
  const slotPollMs = options.slotPollMs ?? 10_000;
  const result: MessageServerTimelineSearchVectorBackfillResult = {
    batches: 0,
    rowsScanned: 0,
    rowsFilled: 0,
    lastId: options.afterId ?? null,
    stoppedBy: null,
    slotPauses: 0,
  };
  let paused = false;
  for (;;) {
    for (;;) {
      const reading = await readSlot();
      const verdict = cdcSlotVerdict(reading, paused);
      if (verdict === "go") {
        if (paused) log(`[MESSAGE_TIMELINE_VECTOR_BACKFILL_SLOT] resumed retained_wal_bytes=${reading?.retainedWalBytes}`);
        paused = false;
        break;
      }
      if (verdict === "stop") {
        log(`[MESSAGE_TIMELINE_VECTOR_BACKFILL_SLOT] stopped retained_wal_bytes=${reading?.retainedWalBytes} wal_status=${reading?.walStatus} after_id=${result.lastId}`);
        result.stoppedBy = "slot";
        return result;
      }
      if (!paused) {
        result.slotPauses += 1;
        log(`[MESSAGE_TIMELINE_VECTOR_BACKFILL_SLOT] paused retained_wal_bytes=${reading?.retainedWalBytes}`);
      }
      paused = true;
      await sleep(slotPollMs);
    }
    const rows = await run(sql`
      WITH batch AS (
        SELECT t.message_id
        FROM message_server_timeline t
        WHERE t.message_id > ${result.lastId ?? MIN_UUID}::uuid
        ORDER BY t.message_id
        LIMIT ${batchSize}
      ),
      filled AS (
        UPDATE message_server_timeline t
        SET search_vector = m.search_vector
        FROM batch
        JOIN messages m ON m.id = batch.message_id
        WHERE t.message_id = batch.message_id
          AND t.search_vector IS NULL
        RETURNING t.message_id
      )
      SELECT
        (SELECT count(*)::int FROM batch) AS scanned,
        (SELECT count(*)::int FROM filled) AS filled,
        (SELECT max(message_id::text) FROM batch) AS last_id
    `);
    const row = rows[0] as { scanned: number; filled: number; last_id: string | null } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    result.batches += 1;
    result.rowsScanned += row.scanned;
    result.rowsFilled += row.filled;
    result.lastId = row.last_id;
    log(`[MESSAGE_TIMELINE_VECTOR_BACKFILL_BATCH] n=${result.batches} scanned=${row.scanned} filled=${row.filled} last_id=${row.last_id}`);
    if (row.scanned < batchSize) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return result;
}

export interface MessageServerTimelineSearchVectorDivergence {
  /** Timeline rows whose search_vector differs from the message's (NULL counts as different). */
  divergentRows: number;
  sampleIds: string[];
  /** Timeline rows the verify actually scanned. */
  scannedRows: number;
  lastId: string | null;
}

/**
 * The switch gate for search_server_gin_v0, in keyset slices over the
 * timeline: every row's search_vector must equal its message's. Pair it with
 * verifyMessageServerTimeline (every message has a row). `afterId` resumes a
 * verify a replica cancelled.
 */
export async function verifyMessageServerTimelineSearchVector(
  run: BackfillExecutor,
  options: { batchSize?: number; sampleLimit?: number; afterId?: string; log?: (line: string) => void } = {},
): Promise<MessageServerTimelineSearchVectorDivergence> {
  const batchSize = options.batchSize ?? 5000;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`verify batchSize must be >= 1, got ${batchSize}`);
  const sampleLimit = options.sampleLimit ?? 20;
  const log = options.log ?? (() => {});
  const divergence: MessageServerTimelineSearchVectorDivergence = { divergentRows: 0, sampleIds: [], scannedRows: 0, lastId: options.afterId ?? null };
  for (;;) {
    const rows = await run(sql`
      WITH slice AS (
        SELECT t.message_id, t.search_vector
        FROM message_server_timeline t
        WHERE t.message_id > ${divergence.lastId ?? MIN_UUID}::uuid
        ORDER BY t.message_id
        LIMIT ${batchSize}
      ),
      checked AS (
        SELECT slice.message_id AS id
        FROM slice
        JOIN messages m ON m.id = slice.message_id
        WHERE slice.search_vector IS DISTINCT FROM m.search_vector
      )
      SELECT
        (SELECT count(*)::int FROM slice) AS scanned,
        (SELECT max(message_id::text) FROM slice) AS last_id,
        (SELECT count(*)::int FROM checked) AS divergent,
        (SELECT coalesce(array_agg(id::text), '{}') FROM (SELECT id FROM checked LIMIT ${sampleLimit}) sample) AS sample_ids
    `);
    const row = rows[0] as { scanned: number; last_id: string | null; divergent: number; sample_ids: string[] } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    divergence.scannedRows += row.scanned;
    divergence.divergentRows += row.divergent;
    for (const id of row.sample_ids) {
      if (divergence.sampleIds.length < sampleLimit) divergence.sampleIds.push(id);
    }
    divergence.lastId = row.last_id;
    log(`[MESSAGE_TIMELINE_VECTOR_VERIFY_SLICE] scanned=${divergence.scannedRows} divergent=${divergence.divergentRows} last_id=${row.last_id}`);
    if (row.scanned < batchSize) break;
  }
  return divergence;
}

export const MESSAGE_SERVER_TIMELINE_SEARCH_INDEX = "idx_message_server_timeline_server_search";

/**
 * Builds the server search GIN after the vector verify passed. CONCURRENTLY,
 * so writes continue; the executor must be in autocommit (no transaction). An
 * invalid leftover from an interrupted build is dropped first, and the result
 * must be valid and ready or this throws.
 */
export async function buildMessageServerTimelineSearchIndex(run: BackfillExecutor, log: (line: string) => void = () => {}): Promise<void> {
  await run(sql`CREATE EXTENSION IF NOT EXISTS btree_gin`);
  const existing = await run(sql`
    SELECT i.indisvalid AS valid
    FROM pg_index i
    WHERE i.indexrelid = to_regclass(${`public.${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX}`})
  `);
  if (existing[0] && existing[0].valid !== true) {
    log(`[MESSAGE_TIMELINE_SEARCH_INDEX] dropping invalid ${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX} from an interrupted build`);
    await run(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX}`));
  }
  const started = Date.now();
  await run(sql.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX} `
    + `ON message_server_timeline USING gin (server_id, search_vector) WITH (fastupdate = off)`,
  ));
  const built = await run(sql`
    SELECT i.indisvalid AS valid, i.indisready AS ready, pg_relation_size(i.indexrelid)::bigint AS bytes
    FROM pg_index i
    WHERE i.indexrelid = to_regclass(${`public.${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX}`})
  `);
  const state = built[0] as { valid: boolean; ready: boolean; bytes: string | number } | undefined;
  if (!state || state.valid !== true || state.ready !== true) {
    throw new Error(`${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX} is not valid after the build; rerun to drop and rebuild it`);
  }
  log(`[MESSAGE_TIMELINE_SEARCH_INDEX] ${MESSAGE_SERVER_TIMELINE_SEARCH_INDEX} valid bytes=${state.bytes} ms=${Date.now() - started}`);
}
