import { noopTracer, type Tracer } from "@botiverse/raft-shared";
import {
  listDueReminderAppInstalls,
  planReminderAppMigrationReport,
  readReminderAppMigrationConfig,
  reminderAppMigrationAllowsServer,
  runReminderAppMigration,
  type ReminderAppImportFn,
  type ReminderAppMigrationConfig,
} from "../apps/reminder/appMigration";
import { recordTraceEvent, withTraceRoot } from "../tracing/semanticTrace";
import { systemTimeProvider, type TimeProvider } from "../apps/reminder/service";

/**
 * Polls for servers whose Reminder App installation has no completed legacy
 * migration and migrates them (`runReminderAppMigration`), or reports the plan
 * in dry-run mode. Polling, not an install hook: an installation can be created
 * on several paths, and a restart picks up where it left off.
 *
 * Every tick emits `server.reminder_app_migration.tick` (also with zero counts),
 * so a stopped worker is itself alertable; each server run emits `.start` and
 * `.end` (or `.dry_run`) with the report counts.
 */
export interface ReminderAppMigrationWorkerOptions {
  tracer?: Tracer;
  clock?: TimeProvider & {
    setInterval?(fn: () => void, ms: number): unknown;
    clearInterval?(handle: unknown): void;
  };
  intervalMs?: number;
  batchSize?: number;
  /** Re-reads the environment each tick when omitted, so a config change needs no restart. */
  config?: () => ReminderAppMigrationConfig | null;
  importFn?: ReminderAppImportFn;
}

export interface ReminderAppMigrationWorkerHandle {
  tick(): Promise<void>;
  stop(): void;
}

const DRY_RUN_REPORT_EVERY_MS = 60 * 60_000;

export function startReminderAppMigrationWorker(opts: ReminderAppMigrationWorkerOptions = {}): ReminderAppMigrationWorkerHandle {
  const tracer = opts.tracer ?? noopTracer;
  const clock = opts.clock ?? systemTimeProvider;
  const intervalMs = opts.intervalMs ?? 60_000;
  const batchSize = opts.batchSize ?? 5;
  const readConfig = opts.config ?? (() => readReminderAppMigrationConfig());
  const lastDryRunAt = new Map<string, number>();
  let running = false;

  const runTick = async () => {
    const config = readConfig();
    if (!config) return;
    const now = clock.now();
    const due = (await listDueReminderAppInstalls(config, { now, limit: batchSize * 4 }))
      .filter((install) => reminderAppMigrationAllowsServer(config, install.serverId))
      .slice(0, batchSize);
    const summary = {
      mode: config.mode,
      ...(config.liveBlockedReason ? { live_blocked: config.liveBlockedReason } : {}),
      due: due.length, processed: 0, completed: 0, failed: 0, deferred: 0, dry_run: 0,
    };
    for (const install of due) {
      const attrs = { server_id: install.serverId, install_id: install.installId, mode: config.mode };
      if (config.mode === "dry_run") {
        const last = lastDryRunAt.get(install.installId) ?? 0;
        if (now.getTime() - last < DRY_RUN_REPORT_EVERY_MS) continue;
        lastDryRunAt.set(install.installId, now.getTime());
        const report = await planReminderAppMigrationReport(install, { clock });
        recordTraceEvent("server.reminder_app_migration.dry_run", {
          ...attrs,
          ...prefixCounts(report.counts),
          ...(report.errorCode ? { error_code: report.errorCode } : {}),
        }, tracer);
        summary.dry_run += 1;
        continue;
      }
      recordTraceEvent("server.reminder_app_migration.start", attrs, tracer);
      const outcome = await runReminderAppMigration(install, { config, clock, importFn: opts.importFn });
      if (!outcome) continue; // another worker holds this run
      summary.processed += 1;
      if (outcome.state === "completed") summary.completed += 1;
      else if (outcome.state === "failed") summary.failed += 1;
      else summary.deferred += 1;
      recordTraceEvent("server.reminder_app_migration.end", {
        ...attrs,
        state: outcome.state,
        reminder_app_active: outcome.state === "completed",
        ...prefixCounts(outcome.counts),
        ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
      }, tracer);
    }
    recordTraceEvent("server.reminder_app_migration.tick", summary, tracer);
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await withTraceRoot(tracer, "server.reminder_app_migration.worker_tick", { surface: "server", kind: "internal" }, runTick);
    } catch (error) {
      console.error("[reminderAppMigration] tick failed:", error);
    } finally {
      running = false;
    }
  };

  const setIntervalFn = opts.clock?.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = opts.clock?.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const handle = setIntervalFn(() => void tick(), intervalMs);
  return { tick, stop: () => clearIntervalFn(handle) };
}

function prefixCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [`count_${key}`, value]));
}
