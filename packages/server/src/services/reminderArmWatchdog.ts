import * as reminderService from "../apps/reminder/service";
import type { TimeProvider } from "../apps/reminder/service";
import { noopTracer, type Tracer } from "@botiverse/raft-shared";
import { withTraceChildSpan, withTraceRoot } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "./agentOrchestrator";

/**
 * Server-side arm watchdog. It never fires or wakes a Reminder. Its jobs:
 * make a missing target-Computer armed(revision) receipt visible as durable
 * `not_armed` business state and re-push that exact revision; and tell the
 * Computer to drop its copy of a reminder the legacy import moved to the
 * Reminder App (`reminder.cancel` at the migrated revision).
 */
export interface ReminderArmWatchdogClock extends TimeProvider {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemReminderArmWatchdogClock: ReminderArmWatchdogClock = {
  now: () => new Date(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ReminderArmWatchdogOptions {
  orchestrator: Pick<AgentOrchestrator, "pushReminderUpsert" | "pushReminderCancel">;
  clock?: ReminderArmWatchdogClock;
  intervalMs?: number;
  /** Scheduled rows this close to fireAt must already carry armed(version). */
  horizonMs?: number;
  batchSize?: number;
  onResync?: (reminderId: string, delivered: boolean) => void;
  /**
   * Process-owned tracer. Each tick runs outside any request, so the tick is
   * its own trace root and every re-push span joins it. Untraced (default
   * noop) keeps the historical console-only behavior.
   */
  tracer?: Tracer;
}

export interface ReminderArmWatchdogHandle {
  tick(): Promise<void>;
  stop(): void;
}

export function startReminderArmWatchdog(
  opts: ReminderArmWatchdogOptions,
): ReminderArmWatchdogHandle {
  const clock = opts.clock ?? systemReminderArmWatchdogClock;
  const tracer = opts.tracer ?? noopTracer;
  const intervalMs = opts.intervalMs ?? 30_000;
  const horizonMs = opts.horizonMs ?? 15_000;
  const batchSize = opts.batchSize ?? 100;
  let running = false;

  const resyncGaps = async () => {
    const horizonAt = new Date(clock.now().getTime() + horizonMs);
    const gaps = await reminderService.getReminderArmGaps(horizonAt, {
      limit: batchSize,
      clock,
    });
    for (const candidate of gaps) {
      await withTraceChildSpan(
        "server.reminder_arm_watchdog.resync",
        {
          surface: "server",
          kind: "internal",
          attrs: {
            reminder_id: candidate.id,
            owner_agent_id: candidate.ownerAgentId,
            version: candidate.version,
          },
        },
        async () => {
          const row = await reminderService.markReminderNotArmed(candidate.id, candidate.ownerAgentId, candidate.version, {
            clock,
          });
          if (!row) return { outcome: "not_marked" };
          const delivered = await opts.orchestrator.pushReminderUpsert(row.ownerAgentId, row);
          opts.onResync?.(row.id, delivered);
          return { outcome: delivered ? "pushed" : "push_failed" };
        },
        { onSuccess: (result) => result },
      );
    }
  };

  // A migrated row is already safe on current daemons: its version moved, so
  // the server refuses a fire from the stale copy. The cancel clears that copy
  // (it matters for daemons that fire locally and report afterwards). Marked
  // done whether or not the push landed: an offline Computer's reconnect
  // snapshot lists scheduled rows only, and retrying every tick for Computers
  // that stay offline would never end.
  const disarmMigrated = async () => {
    const rows = await reminderService.listMigratedRemindersToDisarm({ limit: batchSize, clock });
    for (const row of rows) {
      await withTraceChildSpan(
        "server.reminder_arm_watchdog.disarm_migrated",
        {
          surface: "server",
          kind: "internal",
          attrs: { reminder_id: row.id, owner_agent_id: row.ownerAgentId, version: row.version },
        },
        async () => {
          const delivered = await opts.orchestrator.pushReminderCancel(row.ownerAgentId, row.id, row.version);
          const marked = await reminderService.markMigratedReminderDisarmed(row.id, row.version, { clock });
          return { outcome: delivered ? "pushed" : "owner_unreachable", marked };
        },
        { onSuccess: (result) => result },
      );
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // The tick spans reminders across every server, so the root carries no
      // server_id attr. A thrown tick ends the root as error with error_class.
      await withTraceRoot(
        tracer,
        "server.reminder_arm_watchdog.tick",
        { surface: "server", kind: "internal" },
        async () => {
          await resyncGaps();
          await disarmMigrated();
        },
      );
    } catch (error) {
      console.error("[reminderArmWatchdog] tick failed:", error);
    } finally {
      running = false;
    }
  };

  const handle = clock.setInterval(() => void tick(), intervalMs);
  return { tick, stop: () => clock.clearInterval(handle) };
}
