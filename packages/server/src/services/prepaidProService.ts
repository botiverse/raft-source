// Prepaid Pro (task #19, #proj-commercial; docs/billing/prepaid-pro.md): Pro
// paid once for 1 or 12 months, no auto-renewal. Grants are derived from
// `prepaid_pro_purchases` on every read; `servers.plan` is the compatibility
// projection, written under the server row lock by projectPaidSourceServerPlan
// and by the hourly lapse sweep.
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { PRO_PREPAID_GRACE_DAYS, type PrepaidEntitlement, type ProPrepaidMonths } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { prepaidProPurchases, servers, subscriptions } from "../db/schema";
import { getActiveAppSumoGrants } from "./appSumoLicenseService";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = PRO_PREPAID_GRACE_DAYS * DAY_MS;

type GrantRow = {
  serverId: string;
  kind: "period" | "seats";
  seatQuantity: number;
  startsAt: Date;
  endsAt: Date;
};

/** `months` calendar months later in UTC; a day the target month lacks clamps to its last day (Jan 31 + 1 = Feb 28/29). */
export function addCalendarMonthsUtc(from: Date, months: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}

/**
 * The window a newly paid period covers. Renewing while time is left, or
 * during the grace days, continues from the end of what was paid (grace days
 * used are paid for); later, it starts now.
 */
export function prepaidPeriodWindow(paidThrough: Date | null, now: Date, months: ProPrepaidMonths): { startsAt: Date; endsAt: Date } {
  const startsAt = paidThrough && now.getTime() < paidThrough.getTime() + GRACE_MS ? paidThrough : now;
  return { startsAt, endsAt: addCalendarMonthsUtc(startsAt, months) };
}

/** Derive one Server's grant from its paid rows. Exported for tests. */
export function prepaidGrantOf(rows: readonly GrantRow[], now: Date): PrepaidEntitlement | null {
  const periods = rows.filter(row => row.kind === "period").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let covering: GrantRow | null = null;
  for (const period of periods) {
    if (period.startsAt.getTime() > now.getTime()) continue;
    if (!covering || period.endsAt.getTime() > covering.endsAt.getTime()) covering = period;
  }
  if (!covering) return null;
  // Periods bought ahead start where the previous one ends: follow the chain.
  let chainEnd = covering.endsAt.getTime();
  for (const period of periods) {
    if (period.startsAt.getTime() <= chainEnd && period.endsAt.getTime() > chainEnd) chainEnd = period.endsAt.getTime();
  }
  if (now.getTime() >= chainEnd + GRACE_MS) return null;
  // In grace, the seats are the ones at the end of the paid time.
  const at = Math.min(now.getTime(), chainEnd - 1);
  const covers = (row: GrantRow) => row.startsAt.getTime() <= at && at < row.endsAt.getTime();
  let base: GrantRow | null = null;
  for (const period of periods) {
    if (covers(period) && (!base || period.startsAt.getTime() >= base.startsAt.getTime())) base = period;
  }
  const added = rows.filter(row => row.kind === "seats" && covers(row)).reduce((sum, row) => sum + row.seatQuantity, 0);
  return {
    endsAt: new Date(chainEnd).toISOString(),
    graceEndsAt: new Date(chainEnd + GRACE_MS).toISOString(),
    inGrace: now.getTime() >= chainEnd,
    seatQuantity: (base ?? covering).seatQuantity + added,
  };
}

/** Paid, non-conflicting purchases of normal, live Servers that can still matter at `now`. */
async function grantRows(executor: DatabaseExecutor, serverIds: readonly string[], now: Date): Promise<GrantRow[]> {
  const rows = await executor.select({
    serverId: prepaidProPurchases.serverId,
    kind: prepaidProPurchases.kind,
    seatQuantity: prepaidProPurchases.seatQuantity,
    startsAt: prepaidProPurchases.startsAt,
    endsAt: prepaidProPurchases.endsAt,
  }).from(prepaidProPurchases).innerJoin(servers, eq(servers.id, prepaidProPurchases.serverId)).where(and(
    inArray(prepaidProPurchases.serverId, [...new Set(serverIds)]),
    isNull(servers.deletedAt),
    eq(servers.kind, "normal"),
    eq(prepaidProPurchases.status, "paid"),
    gt(prepaidProPurchases.endsAt, new Date(now.getTime() - GRACE_MS)),
  )).orderBy(asc(prepaidProPurchases.serverId), asc(prepaidProPurchases.startsAt));
  // The inner join keeps only rows whose Server still exists.
  return rows.flatMap(row => row.serverId ? [{ ...row, serverId: row.serverId }] : []);
}

export async function getActivePrepaidGrants(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date,
): Promise<Map<string, PrepaidEntitlement>> {
  const grants = new Map<string, PrepaidEntitlement>();
  if (serverIds.length === 0) return grants;
  const byServer = new Map<string, GrantRow[]>();
  for (const row of await grantRows(executor, serverIds, now)) {
    const list = byServer.get(row.serverId);
    if (list) list.push(row); else byServer.set(row.serverId, [row]);
  }
  for (const [serverId, rows] of byServer) {
    const grant = prepaidGrantOf(rows, now);
    if (grant) grants.set(serverId, grant);
  }
  return grants;
}

export async function getActivePrepaidGrant(executor: DatabaseExecutor, serverId: string, now: Date): Promise<PrepaidEntitlement | null> {
  return (await getActivePrepaidGrants(executor, [serverId], now)).get(serverId) ?? null;
}

/** Paid periods still running or ahead at `now` (what seats added now are priced over: prepaidProSeatsPricing.ts). */
export async function listPrepaidPeriodsAhead(executor: DatabaseExecutor, serverId: string, now: Date): Promise<Array<{ months: number | null; startsAt: Date; endsAt: Date }>> {
  return executor.select({ months: prepaidProPurchases.months, startsAt: prepaidProPurchases.startsAt, endsAt: prepaidProPurchases.endsAt })
    .from(prepaidProPurchases).where(and(
      eq(prepaidProPurchases.serverId, serverId),
      eq(prepaidProPurchases.kind, "period"),
      eq(prepaidProPurchases.status, "paid"),
      gt(prepaidProPurchases.endsAt, now),
    )).orderBy(asc(prepaidProPurchases.startsAt));
}

/** End of the latest paid period (any age): where a renewal continues from (prepaidPeriodWindow). Caller holds the server row. */
export async function getPrepaidPaidThrough(executor: DatabaseExecutor, serverId: string): Promise<Date | null> {
  const [row] = await executor.select({ endsAt: sql<Date | string | null>`max(${prepaidProPurchases.endsAt})` })
    .from(prepaidProPurchases).where(and(
      eq(prepaidProPurchases.serverId, serverId),
      eq(prepaidProPurchases.kind, "period"),
      eq(prepaidProPurchases.status, "paid"),
    ));
  return row?.endsAt ? new Date(row.endsAt) : null;
}

/**
 * Pro Servers whose prepaid time (grace included) has run out and that no
 * other paid source keeps Pro: candidates for the hourly lapse sweep, which
 * re-projects each from every source under its row lock. Servers an
 * entitling subscription or an AppSumo license keeps Pro are left out, so they
 * are not re-projected (and their clients not notified) every hour. Bounded to
 * recently lapsed purchases so the scan stays small; a Server missed for
 * longer is caught by any later projection of it.
 */
export async function listLapsedPrepaidServerIds(executor: DatabaseExecutor, now: Date, lookbackDays = 30): Promise<string[]> {
  const lapsedBefore = new Date(now.getTime() - GRACE_MS);
  const lapsedAfter = new Date(lapsedBefore.getTime() - lookbackDays * DAY_MS);
  const rows = await executor.selectDistinct({ serverId: prepaidProPurchases.serverId })
    .from(prepaidProPurchases).innerJoin(servers, eq(servers.id, prepaidProPurchases.serverId)).where(and(
      eq(servers.plan, "pro"),
      isNull(servers.deletedAt),
      eq(prepaidProPurchases.kind, "period"),
      inArray(prepaidProPurchases.status, ["paid", "refunded"]),
      sql`${prepaidProPurchases.endsAt} <= ${lapsedBefore}`,
      sql`${prepaidProPurchases.endsAt} > ${lapsedAfter}`,
    ));
  const candidates = rows.flatMap(row => row.serverId ? [row.serverId] : []);
  if (candidates.length === 0) return [];
  const stillGranted = await getActivePrepaidGrants(executor, candidates, now);
  const appSumo = await getActiveAppSumoGrants(executor, candidates);
  const subscribed = new Set((await executor.select({ serverId: subscriptions.serverId }).from(subscriptions).where(and(
    inArray(subscriptions.serverId, candidates), inArray(subscriptions.status, ["active", "past_due"]),
  ))).map(row => row.serverId));
  return candidates.filter(serverId => !stillGranted.has(serverId) && !appSumo.has(serverId) && !subscribed.has(serverId));
}
