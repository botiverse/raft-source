// RFC 057 Phase B: operator-run keyset backfill of the int8 shadow columns.
//
// NEVER automatic: no scheduler imports this module; the only entrypoint is the
// operator script (scripts/read-cursor-widen-backfill.ts) run under the gate-B
// authorization. The job refuses to start unless the phase ledger reads
// 'backfilling' (the CAS advance to that phase is itself part of gate B).
//
// Resumability: every batch UPDATE carries `IS DISTINCT FROM`, so re-running after
// any interruption is a no-op for already-mirrored rows — the job is idempotent by
// construction and restarts from the beginning at scan cost only (no rewrites).
// RFC §4's durable-progress requirement is satisfied by this idempotence plus the
// fresh convergence report; there is deliberately NO extra progress table (the
// phase-A migration's frozen statement list creates none — deviation note in the
// PR body).
//
// Phase/epoch binding (review P1-3): EVERY batch transaction re-locks the ledger
// singleton with FOR SHARE and re-verifies it still reads the ORIGINAL
// 'backfilling' + epoch before selecting or writing anything — a concurrent
// transition CAS (which takes the row's UPDATE lock) therefore serializes against
// in-flight batches, and a mid-run flip makes the very next batch fail closed
// with zero further writes and no report. The convergence report runs in ONE
// REPEATABLE READ transaction: all three counts + a single LSN/timestamp from the
// same snapshot, with a final same-transaction FOR SHARE re-verification of the
// original phase/epoch.
//
// Live writes during the backfill are already mirrored by the phase-A triggers;
// this job only fills historical rows.
import { setClockTimeout } from "@botiverse/raft-shared";
import type { Pool } from "pg";

export interface WidenPhaseRow {
  phase: string;
  epoch: number;
}

export interface BackfillTableSpec {
  /** SQL-safe identifiers, fixed at compile time — never interpolated from input. */
  table: string;
  keyColumns: string[];
  int4Column: string;
  int8Column: string;
}

/** The three RFC 057 target tables. Frozen; tests import this list. */
export const WIDEN_BACKFILL_TABLES: BackfillTableSpec[] = [
  {
    table: "user_channel_read_cursors",
    keyColumns: ["user_id", "channel_id"],
    int4Column: "last_read_seq",
    int8Column: "last_read_seq8",
  },
  {
    table: "agent_channel_read_cursors",
    keyColumns: ["agent_id", "channel_id"],
    int4Column: "last_read_seq",
    int8Column: "last_read_seq8",
  },
  {
    table: "read_mutations",
    keyColumns: ["server_id", "principal_type", "principal_id", "mutation_id"],
    int4Column: "requested_through_seq",
    int8Column: "requested_through_seq8",
  },
];

export interface BackfillOptions {
  batchSize?: number;
  sleepMs?: number;
  /** Per-batch SET LOCAL statement_timeout (review P2). */
  batchTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface TableBackfillResult {
  table: string;
  batches: number;
  rowsUpdated: number;
}

export interface ConvergenceEntry {
  table: string;
  divergentOrNull: number;
  checkedAtLsn: string;
  checkedAt: string;
}

export interface BackfillReport {
  phase: string;
  epoch: number;
  tables: TableBackfillResult[];
  convergence: ConvergenceEntry[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));

/** Reads the singleton ledger row; throws if absent (phase A not applied). */
export async function readWidenPhase(pool: Pool): Promise<WidenPhaseRow> {
  const res = await pool.query(
    'SELECT phase, epoch FROM "read_cursor_widen_phase" WHERE id',
  );
  const row = res.rows[0] as WidenPhaseRow | undefined;
  if (!row) {
    throw new Error("read_cursor_widen_phase has no singleton row (phase A not applied?)");
  }
  return { phase: row.phase, epoch: Number(row.epoch) };
}

/**
 * Gate check: the job runs ONLY in 'backfilling'. Kept as its own export so the
 * wrong-phase-refusal tooth exercises exactly the production predicate.
 */
export async function assertBackfillPhase(pool: Pool): Promise<WidenPhaseRow> {
  const row = await readWidenPhase(pool);
  if (row.phase !== "backfilling") {
    throw new Error(
      `read-cursor widen backfill refused: phase is '${row.phase}' (epoch ${row.epoch}), requires 'backfilling'`,
    );
  }
  return row;
}

function keyTuple(spec: BackfillTableSpec): string {
  return spec.keyColumns.map((c) => `"${c}"`).join(", ");
}

/**
 * Same-transaction gate re-verification (review-pinned): FOR SHARE on the
 * singleton serializes against the transition function's UPDATE-locking CAS.
 * Throws (aborting the surrounding transaction) on any phase/epoch drift.
 */
async function verifyGateInTx(
  client: import("pg").PoolClient,
  expected: WidenPhaseRow,
): Promise<void> {
  // FOR SHARE on the singleton serializes the batch against the transition
  // CAS (which UPDATE-locks the same row). Any phase/epoch drift fails closed.
  const res = await client.query(
    'SELECT phase, epoch FROM "read_cursor_widen_phase" WHERE id FOR SHARE',
  );
  const row = res.rows[0] as WidenPhaseRow | undefined;
  if (!row || row.phase !== expected.phase || Number(row.epoch) !== expected.epoch) {
    throw new Error(
      `read-cursor widen backfill fail-closed: phase ledger moved to ` +
        `'${row?.phase}'/${row?.epoch} (expected '${expected.phase}'/${expected.epoch})`,
    );
  }
}

/**
 * One keyset pass over one table. EVERY batch runs in its own transaction:
 * re-verify the gate under FOR SHARE, then select the key window, then the
 * idempotent UPDATE — so no write can ever land under a moved phase/epoch.
 */
export async function backfillTable(
  pool: Pool,
  spec: BackfillTableSpec,
  gate: WidenPhaseRow,
  opts: BackfillOptions = {},
): Promise<TableBackfillResult> {
  const batchSize = opts.batchSize ?? 1000;
  const batchTimeoutMs = opts.batchTimeoutMs ?? 30_000;
  const log = opts.log ?? (() => {});
  let lastKey: unknown[] | null = null;
  let batches = 0;
  let rowsUpdated = 0;

  for (;;) {
    const client = await pool.connect();
    let batchRowCount = 0;
    let updated = 0;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${Math.trunc(batchTimeoutMs)}ms'`);
      await verifyGateInTx(client, gate);

      const keys = keyTuple(spec);
      const afterClause = lastKey
        ? `WHERE (${keys}) > (${lastKey.map((_, i) => `$${i + 2}`).join(", ")})`
        : "";
      const params: unknown[] = lastKey ? [batchSize, ...lastKey] : [batchSize];
      const batchRes = await client.query(
        `SELECT ${keys} FROM "${spec.table}" ${afterClause} ORDER BY ${keys} LIMIT $1`,
        params,
      );
      batchRowCount = batchRes.rows.length;
      if (batchRowCount > 0) {
        const first = batchRes.rows[0] as Record<string, unknown>;
        const last = batchRes.rows[batchRowCount - 1] as Record<string, unknown>;
        const firstKey = spec.keyColumns.map((c) => first[c]);
        const nextKey = spec.keyColumns.map((c) => last[c]);
        const updateRes = await client.query(
          `UPDATE "${spec.table}"
              SET "${spec.int8Column}" = "${spec.int4Column}"
            WHERE (${keys}) >= (${firstKey.map((_, i) => `$${i + 1}`).join(", ")})
              AND (${keys}) <= (${nextKey.map((_, i) => `$${firstKey.length + i + 1}`).join(", ")})
              AND "${spec.int8Column}" IS DISTINCT FROM "${spec.int4Column}"`,
          [...firstKey, ...nextKey],
        );
        updated = updateRes.rowCount ?? 0;
        lastKey = nextKey;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (batchRowCount === 0) break;
    batches += 1;
    rowsUpdated += updated;
    log(`widen_backfill table=${spec.table} batch=${batches} updated=${updated}`);
    if (batchRowCount < batchSize) break;
    if (opts.sleepMs) await sleep(opts.sleepMs);
  }

  return { table: spec.table, batches, rowsUpdated };
}

/**
 * Divergence predicate — the same one the C4 fence re-runs under lock. ONE
 * REPEATABLE READ transaction: all three counts and a single LSN/timestamp come
 * from the same snapshot, and the ORIGINAL gate is re-verified under FOR SHARE
 * at the end of the same transaction (review-pinned shape).
 */
export async function convergenceReport(
  pool: Pool,
  gate: WidenPhaseRow,
): Promise<ConvergenceEntry[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    // Review P2: take the gate's FOR SHARE lock BEFORE the snapshot stamp and
    // counts, so the phase row lock demonstrably covers the whole report; the
    // end-of-transaction re-verification below then closes the bracket.
    await verifyGateInTx(client, gate);
    const stamp = await client.query(
      `SELECT pg_current_wal_lsn()::text AS lsn, now()::text AS at`,
    );
    const { lsn, at } = stamp.rows[0] as { lsn: string; at: string };
    const out: ConvergenceEntry[] = [];
    for (const spec of WIDEN_BACKFILL_TABLES) {
      const res = await client.query(
        `SELECT count(*)::int AS n
           FROM "${spec.table}"
          WHERE "${spec.int8Column}" IS DISTINCT FROM "${spec.int4Column}"`,
      );
      out.push({
        table: spec.table,
        divergentOrNull: (res.rows[0] as { n: number }).n,
        checkedAtLsn: lsn,
        checkedAt: at,
      });
    }
    await verifyGateInTx(client, gate);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The full operator job: gate check → three keyset passes (each batch
 * re-verifying the SAME phase/epoch in-transaction) → single-snapshot
 * convergence report bound to that epoch.
 */
export async function runReadCursorWidenBackfill(
  pool: Pool,
  opts: BackfillOptions = {},
): Promise<BackfillReport> {
  const gate = await assertBackfillPhase(pool);
  const tables: TableBackfillResult[] = [];
  for (const spec of WIDEN_BACKFILL_TABLES) {
    tables.push(await backfillTable(pool, spec, gate, opts));
  }
  const convergence = await convergenceReport(pool, gate);
  return { phase: gate.phase, epoch: gate.epoch, tables, convergence };
}
