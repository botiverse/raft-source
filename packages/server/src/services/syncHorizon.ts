// Sync horizon: message catch-up that does not skip out-of-order commits.
//
// messages.seq is a bigserial allocated at INSERT, but transactions commit in
// another order. A catch-up read (`GET /messages/sync`, socket `sync:resume`)
// returns `seq > since`, and the client moves its cursor to the largest seq it
// saw; a message whose (smaller) seq was allocated by a transaction that
// committed after that read was never fetched.
//
// Every message row records its inserting transaction (messages.insert_xid,
// set by a BEFORE INSERT trigger). A read takes, in the same statement, the
// horizon H = pg_snapshot_xmin(pg_current_snapshot()): every transaction below
// H had finished when the rows were read, so a committed row with
// insert_xid < H was visible to that read. A client that sends the horizon of
// its previous round back (since_horizon S) gets:
//   - the page: seq > since_seq, only rows whose transaction finished
//     (insert_xid IS NULL OR insert_xid < H), ORDER BY seq LIMIT n;
//   - the late rows: seq <= since_seq AND S <= insert_xid < H, the rows that
//     finished after the previous round passed their seq. Unpaged, at most
//     SYNC_LATE_CAP; more than that returns none of them and a reset signal
//     (the client refetches its visible scope instead of paging this arm).
// Both arms apply the same visibility and history-cutoff filters.
//
// Paging rule (clients): send since_horizon only on a round's FIRST page. The
// next round's since_horizon is the horizon returned by this round's first
// page; later pages of a round omit it (and ignore the horizon they return).
// Late rows sit at or below since_seq: a client's cursor is
// max(since_seq, largest seq returned), and only rows above since_seq count
// toward "has more". On a reset (X-Sync-Horizon-Reset: 1 / horizonReset: true)
// the client refetches its visible scope and starts the next round with this
// response's horizon.
// Requests without since_horizon behave exactly as before (no finished-
// transaction filter, no late rows); they still get the horizon, so a client
// can start using it from its next round.

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db/index";

/** The most late rows one sync read returns; above it the read signals a reset. */
export const SYNC_LATE_CAP = 500;

let lateCapOverrideForTests: number | null = null;

export function syncLateCap(): number {
  return lateCapOverrideForTests ?? SYNC_LATE_CAP;
}

/** Tests only: a small cap so the reset path needs few rows. null restores SYNC_LATE_CAP. */
export function __setSyncLateCapForTests(cap: number | null): void {
  lateCapOverrideForTests = cap;
}

/** HTTP response header carrying the horizon (decimal xid8). */
export const SYNC_HORIZON_HEADER = "X-Sync-Horizon";
/** HTTP response header set to "1" when the late rows exceeded the cap and were dropped. */
export const SYNC_HORIZON_RESET_HEADER = "X-Sync-Horizon-Reset";

/** A horizon as the client echoes it: the decimal text of an xid8. */
export type SyncHorizon = string & { readonly __brand: "SyncHorizon" };

const XID8_MAX = (1n << 64n) - 1n;
const DECIMAL_RE = /^(?:0|[1-9][0-9]{0,19})$/;

/**
 * A client-supplied horizon: the decimal string of a non-negative integer that
 * fits xid8 (unsigned 64-bit). Anything else (signs, spaces, leading zeros,
 * exponents, numbers, arrays) is null.
 */
export function parseSyncHorizon(value: unknown): SyncHorizon | null {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) return null;
  if (BigInt(value) > XID8_MAX) return null;
  return value as SyncHorizon;
}

/** The producing adapter: a horizon PostgreSQL printed (xid8::text). */
export function syncHorizonFromDatabase(value: unknown): SyncHorizon {
  const parsed = parseSyncHorizon(typeof value === "bigint" || typeof value === "number" ? String(value) : value);
  if (!parsed) throw new Error("sync_horizon_invalid_from_database");
  return parsed;
}

/**
 * xmax - xmin of the read's snapshot, a lag proxy for tracing. pg_snapshot_xmax is
 * latestCompletedXid + 1 (not the next xid to be assigned), so this counts the
 * transaction ids between the oldest still in flight and the newest completed one;
 * it is 0 when the oldest in-flight transaction is also the newest (or none is in
 * flight). It grows while a long transaction holds the horizon back.
 */
export function snapshotXidSpan(xmin: SyncHorizon, xmax: unknown): number | null {
  const parsedXmax = typeof xmax === "string" ? parseSyncHorizon(xmax) : null;
  if (!parsedXmax) return null;
  const span = BigInt(parsedXmax) - BigInt(xmin);
  return span < 0n ? null : Number(span);
}

export type SyncHorizonSnapshot = { horizon: SyncHorizon; snapshotXidSpan: number | null };

/** The current horizon alone (socket `sync:horizon`, and reads that return no rows): no message access. */
export async function readSyncHorizon(): Promise<SyncHorizonSnapshot> {
  // PRIMARY ONLY: the horizon statement runs on getDb(), never the search/read
  // replica (DATABASE_URL_READ_REPLICA -> getSearchDb()). On a standby,
  // pg_current_snapshot()/pg_snapshot_xmin describe the replica's replay
  // state, not the writer's in-flight transactions, so the horizon would be
  // wrong for rows a primary transaction has not committed yet.
  const result = await getDb().execute(sql`
    SELECT pg_snapshot_xmin(s.snap)::text AS "horizon", pg_snapshot_xmax(s.snap)::text AS "xmax"
    FROM (SELECT pg_current_snapshot() AS snap) s
  `);
  const row = result.rows[0] as { horizon?: unknown; xmax?: unknown } | undefined;
  const horizon = syncHorizonFromDatabase(row?.horizon);
  return { horizon, snapshotXidSpan: snapshotXidSpan(horizon, row?.xmax) };
}

/**
 * A server-side reader's version of the read above (the WeChat bridge's
 * outbound mirror walks a DM this way): one statement takes the horizon H,
 * the page (rows matching `where` with seq > afterSeq whose transaction
 * finished: insert_xid IS NULL OR insert_xid < H, ORDER BY seq LIMIT
 * pageLimit) and, with the previous read's horizon S, the late rows (seq <=
 * afterSeq AND S <= insert_xid < H, ORDER BY seq LIMIT lateLimit + 1, so the
 * caller can tell it hit the cap). `where` and `columns` are the caller's,
 * over "messages"; insert_xid stays in this module. Primary only (see
 * readSyncHorizon).
 */
export async function readMessagesAcrossSyncHorizon(input: {
  where: SQL;
  columns: SQL;
  afterSeq: number;
  sinceHorizon: SyncHorizon | null;
  pageLimit: number;
  lateLimit: number;
}): Promise<{ horizon: SyncHorizon; rows: Array<Record<string, unknown> & { late: boolean }> }> {
  const insertXid = sql.raw(`"messages"."insert_xid"`);
  const lateArm = input.sinceHorizon
    ? sql`,
    late AS (
      SELECT ${input.columns}, TRUE AS "late" FROM "messages"
      WHERE (${input.where})
        AND "messages"."seq" <= ${input.afterSeq}
        AND ${insertXid} >= ${input.sinceHorizon}::xid8
        AND ${insertXid} < (SELECT xmin FROM horizon)
      ORDER BY "messages"."seq"
      LIMIT ${input.lateLimit + 1}
    )`
    : sql``;
  const lateRows = input.sinceHorizon ? sql`UNION ALL SELECT * FROM late` : sql``;
  const result = await getDb().execute(sql`
    WITH horizon AS MATERIALIZED (
      SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin
    ),
    page AS (
      SELECT ${input.columns}, FALSE AS "late" FROM "messages"
      WHERE (${input.where})
        AND "messages"."seq" > ${input.afterSeq}
        AND (${insertXid} IS NULL OR ${insertXid} < (SELECT xmin FROM horizon))
      ORDER BY "messages"."seq"
      LIMIT ${input.pageLimit}
    )${lateArm}
    SELECT h.xmin::text AS "__horizon", r.* FROM horizon h
    LEFT JOIN (SELECT * FROM page ${lateRows}) r ON TRUE
  `);
  const all = result.rows as Array<Record<string, unknown>>;
  const horizon = syncHorizonFromDatabase(all[0]?.__horizon);
  const rows: Array<Record<string, unknown> & { late: boolean }> = [];
  for (const row of all) {
    if (row.late === null || row.late === undefined) continue; // the horizon row of an empty read
    const { __horizon: _horizon, ...rest } = row;
    rows.push({ ...rest, late: row.late === true || row.late === "t" });
  }
  return { horizon, rows };
}
