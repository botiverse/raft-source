// Prepaid Pro lapse sweep (task #19; docs/billing/prepaid-pro.md). Nothing
// tells Raft when prepaid time runs out, unlike a Stripe subscription, so the
// hourly maintenance re-projects every Pro Server whose prepaid time (grace
// included) recently ended. The decision reads every paid source
// (projectPaidSourceServerPlan): a Server another source keeps Pro stays Pro,
// founder and partner are never touched. Independent of `pro_prepaid`: paid
// time is honoured, and ends, whatever the flag says.
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { servers } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { addTraceEvent } from "../tracing/semanticTrace";
import { projectPaidSourceServerPlan } from "./appSumoLifecycleService";
import { listLapsedPrepaidServerIds } from "./prepaidProService";

export interface PrepaidLapseSweepResult {
  candidates: number;
  downgraded: string[];
  /** Runs in a row that failed somewhere (0 after a clean one). */
  consecutiveFailures: number;
}

/** Candidates look back 30 days: a sweep failing that long would leave `servers.plan` stale, so say so early. */
const ALERT_AFTER_FAILED_RUNS = 3;
let consecutiveFailures = 0;

export function __resetPrepaidSweepFailuresForTests(): void {
  consecutiveFailures = 0;
}

function noteRun(failed: boolean): number {
  consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
  if (failed && consecutiveFailures >= ALERT_AFTER_FAILED_RUNS) {
    console.error(`[Billing] ALERT: the prepaid lapse sweep failed ${consecutiveFailures} runs in a row; lapsed Servers stay Pro in servers.plan until it recovers`);
    addTraceEvent("billing.prepaid.sweep_failing", { consecutive_failures: consecutiveFailures });
  }
  return consecutiveFailures;
}

/** `clock` is read again under each Server's row lock: a renewal that committed after the candidates were listed must count. */
export async function sweepLapsedPrepaidServers(clock: () => Date = () => new Date()): Promise<PrepaidLapseSweepResult> {
  const db = getDb();
  let candidates: string[];
  try {
    candidates = await listLapsedPrepaidServerIds(db, clock());
  } catch (err) {
    noteRun(true);
    throw err;
  }
  const downgraded: string[] = [];
  let failed = false;
  for (const serverId of candidates) {
    try {
      const plan = await db.transaction(async tx => {
        await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).for("update");
        await projectPaidSourceServerPlan(tx, serverId, clock());
        const [after] = await tx.select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId));
        return after?.plan ?? null;
      });
      if (plan === "free") downgraded.push(serverId);
    } catch (err) {
      // One Server's failure must not stop the rest; the next hour retries it.
      failed = true;
      console.error(`[Billing] Prepaid lapse sweep failed for server ${serverId}:`, serializeErrorForLog(err));
    }
  }
  return { candidates: candidates.length, downgraded, consecutiveFailures: noteRun(failed) };
}
