import { sql } from "drizzle-orm";
import { getDb } from "../db/index";

/**
 * change_log retention (migration `change_log`): daily partitions are created
 * ahead and dropped after the retention by the SQL function
 * change_log_maintain(). The server's hourly maintenance runs it.
 *
 * - One replica at a time: a transaction-scoped advisory lock; the others skip.
 * - New days are created ahead (14 days) and ATTACHed, which does not block
 *   inserts into change_log. Dropping an expired day needs a DETACH that does
 *   lock change_log (the default partition rules out DETACH CONCURRENTLY), so it
 *   runs only 18:00-22:00 UTC, the daily low, with a 100ms lock timeout; a busy
 *   lock is retried the next hour (migration change_log_nonblocking_maintenance).
 * - change_log_default only receives rows when maintenance has not run for
 *   that long. It is reported loudly: a day with rows there cannot get its
 *   partition, and those rows are never dropped by retention.
 */
export const CHANGE_LOG_AHEAD_DAYS = 14;
export const CHANGE_LOG_KEEP_DAYS = 8;
const CHANGE_LOG_MAINTAIN_LOCK = "raft.change_log_maintain";

export interface ChangeLogMaintenanceResult {
  ran: boolean;
  created: string[];
  dropped: string[];
  skipped: string[];
  lockBusy: string[];
  defaultRows: number;
}

/** UTC hours [start, end) in which expired partitions may be detached. */
export const CHANGE_LOG_DROP_WINDOW_UTC = { start: 18, end: 22 } as const;

export function changeLogDropAllowed(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= CHANGE_LOG_DROP_WINDOW_UTC.start && hour < CHANGE_LOG_DROP_WINDOW_UTC.end;
}

export async function maintainChangeLog(now: Date = new Date()): Promise<ChangeLogMaintenanceResult> {
  return getDb().transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${CHANGE_LOG_MAINTAIN_LOCK})) AS locked`);
    if ((lock.rows[0] as { locked?: boolean } | undefined)?.locked !== true) {
      return { ran: false, created: [], dropped: [], skipped: [], lockBusy: [], defaultRows: 0 };
    }
    await tx.execute(sql`SELECT set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '30s', true)`);
    const rows = (await tx.execute(sql`
      SELECT action, partition_name FROM change_log_maintain(${CHANGE_LOG_AHEAD_DAYS}, ${CHANGE_LOG_KEEP_DAYS}, ${changeLogDropAllowed(now)})`)).rows as Array<{ action: string; partition_name: string }>;
    const defaultRows = Number(((await tx.execute(sql`SELECT count(*) AS n FROM (SELECT 1 FROM change_log_default LIMIT 1000) d`)).rows[0] as { n: number | string }).n);
    const pick = (action: string) => rows.filter((row) => row.action === action).map((row) => row.partition_name);
    return { ran: true, created: pick("created"), dropped: pick("dropped"), skipped: pick("skipped_default_has_rows"), lockBusy: pick("lock_busy"), defaultRows };
  });
}

/** Hourly maintenance step: runs maintainChangeLog and reports what needs a person. */
export async function runChangeLogMaintenance(
  log: Pick<Console, "info" | "error"> = console,
  now: Date = new Date(),
): Promise<ChangeLogMaintenanceResult> {
  const result = await maintainChangeLog(now);
  if (!result.ran) return result;
  if (result.created.length > 0 || result.dropped.length > 0) {
    log.info(`[Slock] change_log partitions: created ${result.created.length}, dropped ${result.dropped.length}`);
  }
  if (result.lockBusy.length > 0) {
    log.info(`[Slock] change_log partitions busy, retrying next hour: ${result.lockBusy.join(", ")}`);
  }
  if (result.skipped.length > 0 || result.defaultRows > 0) {
    log.error(`[Slock] change_log_default holds rows (${result.defaultRows}${result.defaultRows >= 1000 ? "+" : ""}); days without a partition: ${result.skipped.join(", ") || "none"}`);
  }
  return result;
}
