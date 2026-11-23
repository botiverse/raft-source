import pg from "pg";
import {
  dbActivityCheckErrorsTotal,
  dbLockWaitingBackends,
  dbOldestXactAgeSeconds,
} from "../metrics";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler";

// Reads pg_stat_activity on the primary every 30 s and reports the oldest
// non-idle client transaction age and the count of active client backends
// waiting on a heavyweight lock for over 5 s. Added after the 2026-11-19
// channel-conversion incident (#proj-deploy:1f630e47), where a background job
// held FOR KEY SHARE on users rows inside a multi-minute transaction and
// stalled POST /api/auth/refresh into 15 s statement_timeout HTTP 500s.
//
// Every task reads the same database; alert rules take max() across tasks.
//
// Isolated like replicationSlotMonitor: its own pg.Pool with max 1, outside
// the app pools, so it never takes a connect permit or an app connection, and
// idleTimeoutMillis releases the pooled connection between checks.

export const PG_ACTIVITY_CHECK_INTERVAL_MS = 30_000;
export const PG_ACTIVITY_CHECK_TIMEOUT_MS = 5_000;

export const PG_ACTIVITY_QUERY = `
SELECT GREATEST(
         COALESCE(
           MAX(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)))
             FILTER (WHERE xact_start IS NOT NULL AND state <> 'idle'),
           0
         ),
         0
       )::float8 AS oldest_xact_age_seconds,
       COUNT(*) FILTER (
         WHERE state = 'active'
           AND wait_event_type = 'Lock'
           AND state_change IS NOT NULL
           AND clock_timestamp() - state_change > interval '5 seconds'
       )::int AS lock_waiting_backends
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND backend_type = 'client backend'`;

export interface PgActivityRow {
  oldest_xact_age_seconds: number | string | null;
  lock_waiting_backends: number | string | null;
}

export interface PgActivityClient {
  query(sql: string): Promise<PgActivityRow[]>;
  end(): Promise<void>;
}

export interface PgActivityMonitorOptions {
  intervalMs?: number;
  timeoutMs?: number;
  createClient?: (connectionString: string, timeoutMs: number) => PgActivityClient;
}

/**
 * DB_ACTIVITY_MONITOR=1/true/on or 0/false/off decides; unset means on only in
 * production (DEPLOYMENT_ENV=production), matching replicationSlotMonitor and
 * latencyProbe so staging or preview Neon computes can still auto-suspend.
 * PGlite never checks.
 */
export function resolvePgActivityMonitorTarget(env: NodeJS.ProcessEnv): string | null {
  const flag = (env.DB_ACTIVITY_MONITOR ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return null;
  const forced = flag === "1" || flag === "true" || flag === "on";
  if (!forced && env.DEPLOYMENT_ENV?.trim() !== "production") return null;
  const url = env.DATABASE_URL?.trim();
  if (!url || url.startsWith("pglite")) return null;
  return url;
}

function createPgActivityClient(connectionString: string, timeoutMs: number): PgActivityClient {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    // One query every 30 s: do not hold a pooler connection in between.
    idleTimeoutMillis: 5_000,
    ssl: connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", () => {
    // An idle connection dropped; the next check reconnects.
  });
  attachPoolClientErrorHandler(pool, "pg-activity-monitor");
  return {
    async query(sql) {
      const result = await pool.query<PgActivityRow>(sql);
      return result.rows;
    },
    end: () => pool.end(),
  };
}

export function recordPgActivity(rows: PgActivityRow[]): void {
  const row = rows[0];
  if (!row) return;
  const oldestAge = Number(row.oldest_xact_age_seconds ?? 0);
  if (Number.isFinite(oldestAge) && oldestAge >= 0) {
    dbOldestXactAgeSeconds.set(oldestAge);
  }
  const lockWaiting = Number(row.lock_waiting_backends ?? 0);
  if (Number.isFinite(lockWaiting) && lockWaiting >= 0) {
    dbLockWaitingBackends.set(lockWaiting);
  }
}

export function startPgActivityMonitor(
  connectionString: string | null = resolvePgActivityMonitorTarget(process.env),
  options: PgActivityMonitorOptions = {},
): () => void {
  if (!connectionString) return () => undefined;
  const intervalMs = options.intervalMs ?? PG_ACTIVITY_CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PG_ACTIVITY_CHECK_TIMEOUT_MS;
  const client = (options.createClient ?? createPgActivityClient)(connectionString, timeoutMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      const rows = await client.query(PG_ACTIVITY_QUERY);
      if (!stopped) recordPgActivity(rows);
    } catch {
      // Keep the last values rather than reporting 0 during a check timeout;
      // the error counter signals that the reading is stale.
      if (!stopped) dbActivityCheckErrorsTotal.inc();
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
    dbOldestXactAgeSeconds.reset();
    dbLockWaitingBackends.reset();
    void client.end().catch(() => undefined);
  };
}
