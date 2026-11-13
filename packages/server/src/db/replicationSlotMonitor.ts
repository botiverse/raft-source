import pg from "pg";
import {
  dbReplicationSlotActive,
  dbReplicationSlotCheckErrorsTotal,
  dbReplicationSlotRetainedWalBytes,
  dbReplicationSlotWalStatus,
} from "../metrics";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler";

// Reads pg_replication_slots on the primary once a minute and reports, per
// slot, how much WAL it holds back, whether a consumer is attached and its
// wal_status. A logical slot whose consumer stalls (RisingWave CDC today, the
// slock-dist CDC source next) makes the primary keep WAL without limit, and
// Neon's own metric export has no per-slot data, so nothing else would say so.
//
// Every task reports the same slots; alert rules take max by (slot_name).
//
// Same isolation as the latency probe: its own pg.Pool with max 1, outside
// the app pools, so it never takes a connect permit or an app connection.

export const REPLICATION_SLOT_CHECK_INTERVAL_MS = 60_000;
export const REPLICATION_SLOT_CHECK_TIMEOUT_MS = 10_000;

// restart_lsn is the oldest WAL the slot still needs. wal_status (PG 13+) is
// reserved/extended/unreserved/lost; "lost" means the slot can no longer be
// used and its consumer must be rebuilt.
export const REPLICATION_SLOT_QUERY = `
SELECT slot_name,
       slot_type,
       active,
       wal_status,
       CASE WHEN restart_lsn IS NULL THEN NULL
            ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8
       END AS retained_wal_bytes
FROM pg_replication_slots`;

export interface ReplicationSlotRow {
  slot_name: string;
  slot_type: string;
  active: boolean;
  wal_status: string | null;
  retained_wal_bytes: number | string | null;
}

export interface ReplicationSlotClient {
  query(sql: string): Promise<ReplicationSlotRow[]>;
  end(): Promise<void>;
}

export interface ReplicationSlotMonitorOptions {
  intervalMs?: number;
  timeoutMs?: number;
  createClient?: (connectionString: string, timeoutMs: number) => ReplicationSlotClient;
}

/**
 * DB_REPLICATION_SLOT_MONITOR=1/true/on or 0/false/off decides; unset means on
 * only in production (DEPLOYMENT_ENV=production), like the latency probe, so a
 * staging or preview Neon compute can still auto-suspend. PGlite never checks.
 */
export function resolveReplicationSlotMonitorTarget(env: NodeJS.ProcessEnv): string | null {
  const flag = (env.DB_REPLICATION_SLOT_MONITOR ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return null;
  const forced = flag === "1" || flag === "true" || flag === "on";
  if (!forced && env.DEPLOYMENT_ENV?.trim() !== "production") return null;
  const url = env.DATABASE_URL?.trim();
  if (!url || url.startsWith("pglite")) return null;
  return url;
}

function createPgSlotClient(connectionString: string, timeoutMs: number): ReplicationSlotClient {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    // One query a minute: do not hold a pooler connection in between.
    idleTimeoutMillis: 5_000,
    ssl: connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", () => {
    // An idle connection dropped; the next check reconnects.
  });
  attachPoolClientErrorHandler(pool, "replication-slot-monitor");
  return {
    async query(sql) {
      const result = await pool.query<ReplicationSlotRow>(sql);
      return result.rows;
    },
    end: () => pool.end(),
  };
}

/** Replace the gauges with the slots that exist now, so a dropped slot disappears. */
export function recordReplicationSlots(rows: ReplicationSlotRow[]): void {
  dbReplicationSlotRetainedWalBytes.reset();
  dbReplicationSlotActive.reset();
  dbReplicationSlotWalStatus.reset();
  for (const row of rows) {
    const slot = { slot_name: row.slot_name, slot_type: row.slot_type };
    dbReplicationSlotActive.set(slot, row.active ? 1 : 0);
    if (row.retained_wal_bytes !== null) {
      const bytes = Number(row.retained_wal_bytes);
      if (Number.isFinite(bytes)) dbReplicationSlotRetainedWalBytes.set(slot, bytes);
    }
    dbReplicationSlotWalStatus.set({ ...slot, wal_status: row.wal_status ?? "unknown" }, 1);
  }
}

export function startReplicationSlotMonitor(
  connectionString: string | null = resolveReplicationSlotMonitorTarget(process.env),
  options: ReplicationSlotMonitorOptions = {},
): () => void {
  if (!connectionString) return () => undefined;
  const intervalMs = options.intervalMs ?? REPLICATION_SLOT_CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? REPLICATION_SLOT_CHECK_TIMEOUT_MS;
  const client = (options.createClient ?? createPgSlotClient)(connectionString, timeoutMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      recordReplicationSlots(await client.query(REPLICATION_SLOT_QUERY));
    } catch {
      // Keep the last values rather than reporting "no slots"; the error
      // counter says the reading is stale.
      dbReplicationSlotCheckErrorsTotal.inc();
    }
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  timer = setTimeout(tick, 0);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    void client.end().catch(() => undefined);
  };
}
