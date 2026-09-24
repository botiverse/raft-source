import * as reminderService from "../apps/reminder/service.js";
import type { TimeProvider } from "../apps/reminder/service.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";

/**
 * Server-side arm watchdog. It never fires or wakes a Reminder. Its sole job
 * is to make a missing target-Computer armed(revision) receipt visible as
 * durable `not_armed` business state and re-push that exact revision.
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
  orchestrator: Pick<AgentOrchestrator, "pushReminderUpsert">;
  clock?: ReminderArmWatchdogClock;
  intervalMs?: number;
  /** Scheduled rows this close to fireAt must already carry armed(version). */
  horizonMs?: number;
  batchSize?: number;
  onResync?: (reminderId: string, delivered: boolean) => void;
}

export interface ReminderArmWatchdogHandle {
  tick(): Promise<void>;
  stop(): void;
}

export function startReminderArmWatchdog(
  opts: ReminderArmWatchdogOptions,
): ReminderArmWatchdogHandle {
  const clock = opts.clock ?? systemReminderArmWatchdogClock;
  const intervalMs = opts.intervalMs ?? 30_000;
  const horizonMs = opts.horizonMs ?? 15_000;
  const batchSize = opts.batchSize ?? 100;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const horizonAt = new Date(clock.now().getTime() + horizonMs);
      const gaps = await reminderService.getReminderArmGaps(horizonAt, {
        limit: batchSize,
        clock,
      });
      for (const candidate of gaps) {
        const row = await reminderService.markReminderNotArmed(candidate.id, candidate.ownerAgentId, candidate.version, {
          clock,
        });
        if (!row) continue;
        const delivered = await opts.orchestrator.pushReminderUpsert(row.ownerAgentId, row);
        opts.onResync?.(row.id, delivered);
      }
    } catch (error) {
      console.error("[reminderArmWatchdog] tick failed:", error);
    } finally {
      running = false;
    }
  };

  const handle = clock.setInterval(() => void tick(), intervalMs);
  return { tick, stop: () => clock.clearInterval(handle) };
}
