import { DOWNGRADE_GRACE_PERIOD_DAYS } from "@botiverse/raft-shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a server tells its people it went back to Free: for
 * DOWNGRADE_GRACE_PERIOD_DAYS after the change. After that the server's hourly
 * maintenance clears `planDowngradedAt` (downgradeEnforcement.ts); Free has no
 * agent cap, so nothing is stopped.
 */
export function showsPlanDowngradeNotice(
  server: { plan: string; planDowngradedAt: string | null },
  now: number = Date.now(),
): boolean {
  if (server.plan !== "free" || !server.planDowngradedAt) return false;
  // An unreadable timestamp parses to NaN, which compares false: no notice.
  return now < Date.parse(server.planDowngradedAt) + DOWNGRADE_GRACE_PERIOD_DAYS * DAY_MS;
}
