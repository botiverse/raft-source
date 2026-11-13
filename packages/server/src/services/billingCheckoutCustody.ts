import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db/index";
import { billingCheckoutAttempts, billingSourceGuards, prepaidProPurchases, servers, subscriptions } from "../db/schema";
import { getActiveAppSumoGrant, hasAppSumoBillingReservation } from "./appSumoLicenseService";
import { getActivePrepaidGrant } from "./prepaidProService";

export class CheckoutOutcomeUnknownError extends Error {
  readonly code = "checkout_outcome_unknown";
  constructor() { super("The checkout could not be confirmed. Contact support before trying again."); }
}
export class BillingSourceCheckBusyError extends Error {
  readonly code = "billing_source_check_busy";
  constructor() { super("Billing is checking another plan change. Please try again shortly."); }
}

/** A subscription checkout while prepaid time (grace included) grants Pro: it would charge for time already paid. */
export class PrepaidActiveError extends Error {
  readonly code = "PREPAID_ACTIVE";
  constructor() { super("This server has prepaid Pro time. You can switch to a subscription after it ends."); }
}
/** A prepaid checkout while another paid source (or an internal or by-hand plan) makes the Server Pro. */
export class PrepaidPaidSourceError extends Error {
  readonly code = "PREPAID_OTHER_PAID_SOURCE";
  constructor() { super("This server's Pro comes from a subscription or license. Prepaid time cannot be added to it."); }
}

/**
 * Whether prepaid time can be bought for the Server now: it is Free, or its
 * Pro comes from prepaid time (a renewal, including the hour after grace ends
 * before the lapse sweep drops the plan). Founder, partner, an entitling
 * subscription, an AppSumo license or Pro set by hand refuse, so a Server
 * Pro some other way never carries a prepaid record. Caller holds the row or
 * accepts a pre-check answer.
 */
export async function canBuyPrepaid(tx: DatabaseExecutor, server: { id: string; plan: string }, now: Date): Promise<boolean> {
  if (server.plan === "founder" || server.plan === "partner") return false;
  const [subscription] = await tx.select({ status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.serverId, server.id));
  if (subscription?.status === "active" || subscription?.status === "past_due") return false;
  if (await getActiveAppSumoGrant(tx, server.id)) return false;
  if (server.plan === "free") return true;
  if (await getActivePrepaidGrant(tx, server.id, now)) return true;
  // `pro` with no source left: lapsed prepaid time the sweep has not projected yet.
  const [paid] = await tx.select({ id: prepaidProPurchases.id }).from(prepaidProPurchases).where(and(
    eq(prepaidProPurchases.serverId, server.id), eq(prepaidProPurchases.kind, "period"), eq(prepaidProPurchases.status, "paid"),
  )).limit(1);
  return Boolean(paid);
}

/** Server row is the shared serialization point for checkout and AppSumo binding. */
export async function reserveStripeCheckout(db: Database, serverId: string, kind: "subscription" | "prepaid" = "subscription"): Promise<string> {
  return db.transaction(async tx => {
    const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).for("update");
    if (!server || server.deletedAt || server.kind !== "normal") throw new Error("Server is unavailable");
    if (await hasAppSumoBillingReservation(tx, serverId)) {
      throw new Error("Stripe changes are not supported for an AppSumo license. Manage the license in AppSumo or contact support.");
    }
    const now = new Date();
    if (kind === "subscription" && await getActivePrepaidGrant(tx, serverId, now)) throw new PrepaidActiveError();
    if (kind === "prepaid" && !await canBuyPrepaid(tx, server, now)) throw new PrepaidPaidSourceError();
    const [busy] = await tx.select({ serverId: billingSourceGuards.serverId }).from(billingSourceGuards).where(and(
      eq(billingSourceGuards.serverId, serverId), gt(billingSourceGuards.bindLeaseExpiresAt, sql`clock_timestamp()`),
    ));
    if (busy) throw new BillingSourceCheckBusyError();
    const [uncertain] = await tx.select({ id: billingCheckoutAttempts.id }).from(billingCheckoutAttempts).where(and(
      eq(billingCheckoutAttempts.serverId, serverId), inArray(billingCheckoutAttempts.state, ["creating", "ambiguous"]),
    )).limit(1);
    if (uncertain) throw new CheckoutOutcomeUnknownError();
    const id = randomUUID();
    await tx.insert(billingCheckoutAttempts).values({ id, serverId, state: "creating" });
    return id;
  });
}

export async function markCheckoutKnown(db: Database, input: { id: string; serverId: string; stripeSessionId: string }): Promise<boolean> {
  const [row] = await db.update(billingCheckoutAttempts).set({ state: "known", stripeSessionId: input.stripeSessionId,
    updatedAt: sql`clock_timestamp()` }).where(and(eq(billingCheckoutAttempts.id, input.id),
    eq(billingCheckoutAttempts.serverId, input.serverId), eq(billingCheckoutAttempts.state, "creating"))).returning({ id: billingCheckoutAttempts.id });
  return Boolean(row);
}

/** Never erase a possibly-sent request because a process, timeout or network failed. */
export async function markCheckoutAmbiguous(db: Database, input: { id: string; serverId: string }): Promise<void> {
  await db.update(billingCheckoutAttempts).set({ state: "ambiguous", updatedAt: sql`clock_timestamp()` }).where(and(
    eq(billingCheckoutAttempts.id, input.id), eq(billingCheckoutAttempts.serverId, input.serverId),
    eq(billingCheckoutAttempts.state, "creating"),
  ));
}

/** Caller already holds the server row. No provider call occurs inside this transaction. */
export async function acquireBillingBindLease(tx: DatabaseTransaction, serverId: string): Promise<string | null> {
  await tx.insert(billingSourceGuards).values({ serverId }).onConflictDoNothing();
  const token = randomUUID();
  const [row] = await tx.update(billingSourceGuards).set({ bindLeaseToken: token,
    bindLeaseExpiresAt: sql`clock_timestamp() + interval '2 minutes'` }).where(and(eq(billingSourceGuards.serverId, serverId),
    sql`(${billingSourceGuards.bindLeaseToken} IS NULL OR ${billingSourceGuards.bindLeaseExpiresAt} <= clock_timestamp())`,
  )).returning({ serverId: billingSourceGuards.serverId });
  return row ? token : null;
}

/** Revalidate inside the final server-locked transaction, not against a process clock. */
export async function billingBindLeaseIsCurrent(tx: DatabaseTransaction, serverId: string, token: string): Promise<boolean> {
  const [row] = await tx.select({ serverId: billingSourceGuards.serverId }).from(billingSourceGuards).where(and(
    eq(billingSourceGuards.serverId, serverId), eq(billingSourceGuards.bindLeaseToken, token),
    gt(billingSourceGuards.bindLeaseExpiresAt, sql`clock_timestamp()`),
  )).for("update");
  return Boolean(row);
}

export async function releaseBillingBindLease(db: Database, serverId: string, token: string): Promise<void> {
  await db.update(billingSourceGuards).set({ bindLeaseToken: null, bindLeaseExpiresAt: null }).where(and(
    eq(billingSourceGuards.serverId, serverId), eq(billingSourceGuards.bindLeaseToken, token),
  ));
}
