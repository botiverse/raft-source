// The jobs first-party apps register (FirstPartyApp.jobs, apps/firstPartyApps.ts),
// run by server.ts on every replica: maintenance jobs in the hourly
// maintenance, interval jobs on their own timers, one run at a time each.
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { firstPartyApps } from "../apps/firstPartyApps";
import { appNoticeOutbox } from "./firstPartyAppHost";
import type { SystemAppAgentEventDeliverer } from "./systemAppAgentEvents";

/** Every app's maintenance jobs, for the hourly maintenance to run (each under its own `site`). */
export function firstPartyAppMaintenanceJobs(): Array<{ app: string; site: string; run(): Promise<unknown> }> {
  return firstPartyApps().flatMap((app) => (app.jobs?.maintenance ?? []).map((job) => ({ app: app.id, site: job.site, run: () => job.run() })));
}

/**
 * Starts every app's interval jobs, their notices pushed through `deliverer`.
 * A job's run is skipped while its previous one is still going. `stop` clears
 * the timers now and resolves once the runs in flight are done.
 */
export function startFirstPartyAppIntervalJobs(deliverer: SystemAppAgentEventDeliverer): { stop(): Promise<void> } {
  const running = new Set<Promise<void>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const app of firstPartyApps()) {
    for (const job of app.jobs?.every ?? []) {
      let inFlight: Promise<void> | null = null;
      const timer = setInterval(() => {
        if (inFlight) return;
        const run: Promise<void> = job.run({ noticeOutbox: appNoticeOutbox(app, deliverer) }).then(() => {}, (err) => {
          console.error(`[Slock] ${app.id} ${job.name} failed:`, serializeErrorForLog(err));
        }).finally(() => {
          inFlight = null;
          running.delete(run);
        });
        inFlight = run;
        running.add(run);
      }, job.everyMs);
      timer.unref?.();
      timers.push(timer);
    }
  }
  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
      return Promise.all([...running]).then(() => undefined);
    },
  };
}
