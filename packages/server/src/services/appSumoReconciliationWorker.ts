import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { getAppSumoConfig } from "./appSumoConfig";
import { createAppSumoProvider } from "./appSumoProvider";
import { reconcileNextAppSumoLicense } from "./appSumoLifecycleService";
import { inspectStripeBillingForAppSumo } from "./billingService";

/** One durable, cross-replica-budgeted provider read per tick. Unconfigured is inert. */
export function startAppSumoReconciliationWorker() {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    const config = getAppSumoConfig();
    if (!config) return;
    running = (async () => {
      try {
        await reconcileNextAppSumoLicense({ db: getDb(), productId: config.productId, now: currentDate,
          getLicense: createAppSumoProvider(config).getLicense, inspectStripe: inspectStripeBillingForAppSumo });
      } catch { console.error("[AppSumo] license reconciliation failed"); }
    })();
    try { await running; } finally { running = null; }
  };
  const timer = setClockInterval(() => void tick(), 3100);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  return { tick, async stop() { stopped = true; clearClockInterval(timer); await running; } };
}
