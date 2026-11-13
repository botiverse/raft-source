import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { appSumoLicenseBindings, appSumoLicenses, appSumoWebhookReceipts, servers } from "../db/schema";

import type { AppSumoLicenseKey, AppSumoTier } from "./appSumoContracts";
export type { AppSumoTier } from "./appSumoContracts";
export type ActiveAppSumoGrant = Readonly<{
  serverId: string;
  tier: AppSumoTier;
  /** Provider identifier for backend reconciliation; never serialize in billing summaries. */
  currentLicenseKey: AppSumoLicenseKey;
  activatedAt: Date;
}>;

/** One canonical active-grant relation, usable on its own or inside an entitlement query. */
export function activeAppSumoGrantsQuery(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
) {
  return executor.select({
    serverId: appSumoLicenseBindings.serverId,
    tier: appSumoLicenses.tier,
    currentLicenseKey: sql<AppSumoLicenseKey>`${appSumoLicenseBindings.currentLicenseKey}`.as("current_license_key"),
    activatedAt: appSumoLicenseBindings.activatedAt,
  }).from(appSumoLicenseBindings).innerJoin(appSumoLicenses, and(
    eq(appSumoLicenses.productId, appSumoLicenseBindings.productId),
    eq(appSumoLicenses.licenseKey, appSumoLicenseBindings.currentLicenseKey),
  )).innerJoin(servers, eq(servers.id, appSumoLicenseBindings.serverId)).where(and(
    inArray(appSumoLicenseBindings.serverId, [...new Set(serverIds)]),
    isNull(servers.deletedAt),
    eq(servers.kind, "normal"),
    eq(appSumoLicenses.status, "active"),
    isNotNull(appSumoLicenses.verifiedAt),
  ));
}

/** Bound, provider-confirmed grants only. Purchase and pending claims grant nothing. */
export async function getActiveAppSumoGrants(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
): Promise<Map<string, ActiveAppSumoGrant>> {
  const grants = new Map<string, ActiveAppSumoGrant>();
  if (serverIds.length === 0) return grants;
  const rows = await activeAppSumoGrantsQuery(executor, serverIds);
  for (const row of rows) {
    if (!row.serverId || (row.tier !== 1 && row.tier !== 2 && row.tier !== 3 && row.tier !== 4)) continue;
    grants.set(row.serverId, { serverId: row.serverId, tier: row.tier, currentLicenseKey: row.currentLicenseKey, activatedAt: row.activatedAt });
  }
  return grants;
}

export async function getActiveAppSumoGrant(
  executor: DatabaseExecutor,
  serverId: string,
): Promise<ActiveAppSumoGrant | null> {
  return (await getActiveAppSumoGrants(executor, [serverId])).get(serverId) ?? null;
}

/** A license can reserve billing before provider verification grants access.
 * Keep this separate from the active-grant query: pending licenses must not
 * provide paid capacity, but must not permit a second paid source either. */
export async function hasAppSumoBillingReservation(executor: DatabaseExecutor, serverId: string): Promise<boolean> {
  const [row] = await executor.select({ productId: appSumoLicenses.productId, key: appSumoLicenses.licenseKey,
    status: appSumoLicenses.status, expectedStatus: appSumoLicenses.expectedStatus,
    checkAttempts: appSumoLicenses.checkAttempts }).from(appSumoLicenseBindings)
    .innerJoin(appSumoLicenses, and(eq(appSumoLicenses.productId, appSumoLicenseBindings.productId),
      eq(appSumoLicenses.licenseKey, appSumoLicenseBindings.currentLicenseKey)))
    .where(eq(appSumoLicenseBindings.serverId, serverId)).limit(1);
  if (!row) return false;
  if (row.status !== "deactivated" || row.expectedStatus === "active") return true;
  if (row.expectedStatus !== null || row.checkAttempts < 8) return false;
  // Before this fix an exhausted positive reconciliation cleared the pending
  // marker. Preserve those ambiguous cases until a later signed deactivation;
  // a missed refund webhook can require support rather than a second purchase.
  const [events] = await executor.select({
    positive: sql<Date | null>`max(${appSumoWebhookReceipts.receivedAt}) filter (where ${appSumoWebhookReceipts.event} in ('activate','upgrade','downgrade'))`,
    negative: sql<Date | null>`max(${appSumoWebhookReceipts.receivedAt}) filter (where ${appSumoWebhookReceipts.event} = 'deactivate')`,
  }).from(appSumoWebhookReceipts).where(and(eq(appSumoWebhookReceipts.productId, row.productId),
    eq(appSumoWebhookReceipts.licenseKey, row.key)));
  return Boolean(events?.positive && (!events.negative || new Date(events.positive) >= new Date(events.negative)));
}
