import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index";
import { afterAmbientTransaction } from "../db/ambientTransaction";
import { appSumoLicenseBindings, appSumoLicenses, appSumoProducts, appSumoRedemptionClaims, appSumoWebhookReceipts, billingCheckoutAttempts, servers, subscriptions } from "../db/schema";
import { getActiveAppSumoGrant } from "./appSumoLicenseService";
import { getActivePrepaidGrant } from "./prepaidProService";
import { acquireBillingBindLease, billingBindLeaseIsCurrent, releaseBillingBindLease } from "./billingCheckoutCustody";
import type { StripeCheckoutSafety } from "./stripeCheckoutInspection";
import type { AppSumoLicenseKey } from "./appSumoContracts";
import type { AppSumoLicenseEvent, AppSumoProviderLicense } from "./appSumoProvider";

let planChangeSink: ((serverId: string) => Promise<void>) | null = null;
/** Composition root re-reads committed plan state before notifying connected clients. */
export function setAppSumoPlanChangeSink(sink: ((serverId: string) => Promise<void>) | null): void { planChangeSink = sink; }

export class AppSumoConflict extends Error {
  constructor(readonly code: "license_chain_conflict" | "license_already_bound" | "paid_source_conflict" | "owner_required" | "license_not_active" | "claim_expired" | "stripe_checkout_pending" | "stripe_verification_unavailable") { super(code); }
}

/** Shared product lineage can join formerly unrelated keys, so serialize its mutations.
 * Lock order: product -> sorted server rows -> license/binding/claim rows. No I/O inside. */
export async function lockAppSumoProduct(tx: DatabaseTransaction, productId: string, now: Date) {
  await tx.insert(appSumoProducts).values({ productId, nextApiRequestAt: now }).onConflictDoNothing();
  const [product] = await tx.select().from(appSumoProducts).where(eq(appSumoProducts.productId, productId)).for("update");
  return product;
}

export async function getAppSumoFamily(tx: DatabaseTransaction, productId: string, seeds: readonly AppSumoLicenseKey[]): Promise<{ keys: AppSumoLicenseKey[]; rows: Array<typeof appSumoLicenses.$inferSelect> }> {
  const keys = new Set(seeds);
  const found = new Map<AppSumoLicenseKey, typeof appSumoLicenses.$inferSelect>();
  let frontier = [...seeds];
  while (frontier.length) {
    const rows = await tx.select().from(appSumoLicenses).where(and(eq(appSumoLicenses.productId, productId), or(
      inArray(appSumoLicenses.licenseKey, frontier), inArray(appSumoLicenses.previousLicenseKey, frontier),
    )));
    frontier = [];
    for (const row of rows) {
      found.set(row.licenseKey, row);
      for (const key of [row.licenseKey, row.previousLicenseKey]) {
        if (key && !keys.has(key)) { keys.add(key); frontier.push(key); }
      }
    }
  }
  return { keys: [...keys], rows: [...found.values()] };
}

async function lockFamilyServers(tx: DatabaseTransaction, productId: string, keys: readonly AppSumoLicenseKey[]) {
  const bindings = await tx.select().from(appSumoLicenseBindings).where(and(eq(appSumoLicenseBindings.productId, productId), or(
    inArray(appSumoLicenseBindings.originalLicenseKey, [...keys]), inArray(appSumoLicenseBindings.currentLicenseKey, [...keys]),
  )));
  if (bindings.length > 1) throw new AppSumoConflict("license_chain_conflict");
  const serverIds = bindings.flatMap((binding) => binding.serverId ? [binding.serverId] : []).sort();
  if (serverIds.length) await tx.select({ id: servers.id }).from(servers).where(inArray(servers.id, serverIds)).orderBy(asc(servers.id)).for("update");
  return bindings;
}

/** Caller holds the server row. Re-reads every paid source (Stripe, AppSumo,
 * prepaid), so revoking one preserves the others. */
export async function projectPaidSourceServerPlan(tx: DatabaseTransaction, serverId: string, now: Date) {
  const [server] = await tx.select().from(servers).where(eq(servers.id, serverId));
  if (!server || server.deletedAt || server.plan === "founder" || server.plan === "partner") return;
  const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.serverId, serverId));
  const paid = subscription?.status === "active" || subscription?.status === "past_due"
    || Boolean(await getActiveAppSumoGrant(tx, serverId)) || Boolean(await getActivePrepaidGrant(tx, serverId, now));
  const plan = paid ? "pro" : "free";
  afterAmbientTransaction(() => {
    const sink = planChangeSink;
    if (sink) void sink(serverId).catch(() => console.warn("[AppSumo] plan notification unavailable"));
  });
  if (server.plan === plan) return;
  await tx.update(servers).set({ plan, planDowngradedAt: paid ? null : now, updatedAt: now }).where(eq(servers.id, serverId));
}

async function moveBindingToTip(tx: DatabaseTransaction, productId: string, key: AppSumoLicenseKey, now: Date) {
  const family = await getAppSumoFamily(tx, productId, [key]);
  const bindings = await tx.select().from(appSumoLicenseBindings).where(and(eq(appSumoLicenseBindings.productId, productId), or(
    inArray(appSumoLicenseBindings.originalLicenseKey, family.keys), inArray(appSumoLicenseBindings.currentLicenseKey, family.keys),
  )));
  if (bindings.length > 1) throw new AppSumoConflict("license_chain_conflict");
  const predecessorKeys = new Set(family.rows.flatMap((row) => row.previousLicenseKey ? [row.previousLicenseKey] : []));
  const tips = family.rows.filter((row) => !predecessorKeys.has(row.licenseKey));
  if (tips.length !== 1) throw new AppSumoConflict("license_chain_conflict");
  const binding = bindings[0];
  if (binding) {
    // A preverified successor may have been observed before it became bound.
    // Reconfirm it through the bound-server Stripe fence before granting it.
    if (binding.serverId && binding.currentLicenseKey !== tips[0].licenseKey && tips[0].status === "active") {
      await tx.update(appSumoLicenses).set({ status: "inactive", expectedStatus: "active", nextCheckAt: now,
        revision: tips[0].revision + 1, checkLeaseToken: null, checkLeaseExpiresAt: null, updatedAt: now,
      }).where(and(eq(appSumoLicenses.productId, productId), eq(appSumoLicenses.licenseKey, tips[0].licenseKey)));
    }
    await tx.update(appSumoLicenseBindings).set({ currentLicenseKey: tips[0].licenseKey, updatedAt: now }).where(eq(appSumoLicenseBindings.id, binding.id));
    if (binding.serverId) await projectPaidSourceServerPlan(tx, binding.serverId, now);
  }
}

export async function receiveAppSumoEvent(input: {
  db: Database; productId: string; event: AppSumoLicenseEvent; requestDigest: string; now: Date;
}): Promise<"applied" | "duplicate" | "test"> {
  if (input.event.test) return "test";
  if (input.event.parent_license_key) throw new AppSumoConflict("license_chain_conflict");
  return input.db.transaction(async (tx) => {
    await lockAppSumoProduct(tx, input.productId, input.now);
    const [already] = await tx.select({ id: appSumoWebhookReceipts.id }).from(appSumoWebhookReceipts).where(and(
      eq(appSumoWebhookReceipts.productId, input.productId), eq(appSumoWebhookReceipts.requestDigest, input.requestDigest),
    ));
    if (already) return "duplicate";
    const event = input.event;
    const family = await getAppSumoFamily(tx, input.productId, [event.license_key, ...(event.prev_license_key ? [event.prev_license_key] : [])]);
    await lockFamilyServers(tx, input.productId, family.keys);
    const existing = family.rows.find((row) => row.licenseKey === event.license_key);
    if (event.prev_license_key) {
      if (existing?.previousLicenseKey && existing.previousLicenseKey !== event.prev_license_key) throw new AppSumoConflict("license_chain_conflict");
      let ancestor: AppSumoLicenseKey | null = event.prev_license_key;
      const visited = new Set<AppSumoLicenseKey>();
      while (ancestor) {
        if (ancestor === event.license_key || visited.has(ancestor)) throw new AppSumoConflict("license_chain_conflict");
        visited.add(ancestor);
        ancestor = family.rows.find((row) => row.licenseKey === ancestor)?.previousLicenseKey ?? null;
      }
      await tx.insert(appSumoLicenses).values({ productId: input.productId, licenseKey: event.prev_license_key }).onConflictDoNothing();
    }
    await tx.insert(appSumoLicenses).values({ productId: input.productId, licenseKey: event.license_key }).onConflictDoNothing();
    if (event.event !== "purchase") {
      const expectedStatus = event.event === "deactivate" ? "deactivated" : "active";
      await tx.update(appSumoLicenses).set({
        ...(event.prev_license_key ? { previousLicenseKey: event.prev_license_key } : {}),
        // Negative facts remove access immediately. Positive notifications do
        // not grant access until the provider read confirms the current state.
        ...(expectedStatus === "deactivated" ? { status: "deactivated" as const } : {}),
        expectedStatus, revision: (existing?.revision ?? 0) + 1,
        nextCheckAt: new Date(input.now.getTime() + 5000), checkAttempts: 0,
        checkLeaseToken: null, checkLeaseExpiresAt: null, updatedAt: input.now,
      }).where(and(eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, event.license_key)));
      if (event.prev_license_key) await tx.update(appSumoLicenses).set({ status: "deactivated", nextCheckAt: null, expectedStatus: null,
        checkLeaseToken: null, checkLeaseExpiresAt: null, updatedAt: input.now,
      }).where(and(eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, event.prev_license_key)));
    }
    await moveBindingToTip(tx, input.productId, event.license_key, input.now);
    await tx.insert(appSumoWebhookReceipts).values({ productId: input.productId, licenseKey: event.license_key,
      requestDigest: input.requestDigest, event: event.event, previousLicenseKey: event.prev_license_key ?? null, tier: event.tier ?? null,
      providerEventTimestamp: event.event_timestamp, providerCreatedAt: event.created_at, receivedAt: input.now });
    return "applied";
  });
}

/** One API call per reserved slot across all replicas; no request when the budget is occupied. */
export async function reconcileNextAppSumoLicense(input: {
  db: Database; productId: string; now: () => Date;
  getLicense: (key: AppSumoLicenseKey) => Promise<AppSumoProviderLicense>;
  inspectStripe?: (input: { serverId: string; knownCustomerId: string | null; knownSubscriptionId: string | null; knownSessionIds: readonly string[] }) => Promise<StripeCheckoutSafety>;
}): Promise<boolean> {
  const claim = await input.db.transaction(async (tx) => {
    const now = input.now();
    const product = await lockAppSumoProduct(tx, input.productId, now);
    const expired = await tx.select({ tokenHash: appSumoRedemptionClaims.tokenHash }).from(appSumoRedemptionClaims)
      .where(and(eq(appSumoRedemptionClaims.productId, input.productId), lte(appSumoRedemptionClaims.expiresAt, now)))
      .limit(100).for("update", { skipLocked: true });
    if (expired.length) await tx.delete(appSumoRedemptionClaims).where(inArray(appSumoRedemptionClaims.tokenHash, expired.map(row => row.tokenHash)));
    if (product.nextApiRequestAt > now) return null;
    const [license] = await tx.select().from(appSumoLicenses).where(and(
      eq(appSumoLicenses.productId, input.productId), lte(appSumoLicenses.nextCheckAt, now),
      or(isNull(appSumoLicenses.checkLeaseExpiresAt), lte(appSumoLicenses.checkLeaseExpiresAt, now)),
    )).orderBy(asc(appSumoLicenses.nextCheckAt)).limit(1).for("update");
    if (!license) return null;
    const family = await getAppSumoFamily(tx, input.productId, [license.licenseKey]);
    const bindings = await lockFamilyServers(tx, input.productId, family.keys);
    const boundServerId = bindings.find(binding => binding.currentLicenseKey === license.licenseKey)?.serverId ?? null;
    let fence: { serverId: string; lease: string; knownCustomerId: string | null; knownSubscriptionId: string | null; knownSessionIds: string[] } | null = null;
    const needsFence = Boolean(boundServerId && license.status !== "active");
    if (needsFence && boundServerId && input.inspectStripe) {
      const attempts = await tx.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.serverId, boundServerId));
      const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.serverId, boundServerId));
      if ((!subscription || subscription.status === "canceled") && attempts.every(attempt => attempt.state === "known" && attempt.stripeSessionId)) {
        const lease = await acquireBillingBindLease(tx, boundServerId);
        if (lease) fence = { serverId: boundServerId, lease, knownCustomerId: subscription?.stripeCustomerId ?? null, knownSubscriptionId: subscription?.stripeSubscriptionId ?? null,
          knownSessionIds: attempts.map(attempt => attempt.stripeSessionId!) };
      }
    }
    const token = randomUUID();
    await tx.update(appSumoProducts).set({ nextApiRequestAt: new Date(now.getTime() + 3100) }).where(eq(appSumoProducts.productId, input.productId));
    await tx.update(appSumoLicenses).set({ checkLeaseToken: token, checkLeaseExpiresAt: new Date(now.getTime() + (needsFence ? 120_000 : 30_000)) })
      .where(and(eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, license.licenseKey)));
    return { license, token, needsFence, fence };
  });
  if (!claim) return false;
  let observed: AppSumoProviderLicense | null = null;
  try { observed = await input.getLicense(claim.license.licenseKey); } catch { /* Persist retry; never infer active on an unavailable provider. */ }
  let stripeSafety: StripeCheckoutSafety = "unavailable";
  if (claim.fence && observed?.status === "active" && input.inspectStripe) {
    try { stripeSafety = await input.inspectStripe(claim.fence); } catch { /* Unknown is never safe. */ }
  }
  try {
  await input.db.transaction(async (tx) => {
    const now = input.now();
    await lockAppSumoProduct(tx, input.productId, now);
    const family = await getAppSumoFamily(tx, input.productId, [claim.license.licenseKey]);
    await lockFamilyServers(tx, input.productId, family.keys);
    const [current] = await tx.select().from(appSumoLicenses).where(and(
      eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, claim.license.licenseKey),
    )).for("update");
    if (!current || current.revision !== claim.license.revision || current.checkLeaseToken !== claim.token || !current.checkLeaseExpiresAt || current.checkLeaseExpiresAt <= now) return;
    const attempts = current.checkAttempts + 1;
    let safeToActivate = !claim.needsFence;
    if (claim.needsFence && claim.fence && stripeSafety === "safe" && await billingBindLeaseIsCurrent(tx, claim.fence.serverId, claim.fence.lease)) {
      const checkoutAttempts = await tx.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.serverId, claim.fence.serverId));
      const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.serverId, claim.fence.serverId));
      safeToActivate = (!subscription || subscription.status === "canceled") && (subscription?.stripeCustomerId ?? null) === claim.fence.knownCustomerId
        && (subscription?.stripeSubscriptionId ?? null) === claim.fence.knownSubscriptionId
        && checkoutAttempts.every(attempt => attempt.state === "known" && !!attempt.stripeSessionId && claim.fence!.knownSessionIds.includes(attempt.stripeSessionId));
    }
    const matches = observed?.licenseKey === current.licenseKey && (current.expectedStatus === null || observed.status === current.expectedStatus);
    const anotherKeySupersedes = family.rows.some((row) => row.previousLicenseKey === current.licenseKey);
    const held = observed?.status === "active" && !safeToActivate && !anotherKeySupersedes;
    const retry = (!matches || held) && !anotherKeySupersedes && attempts < 8;
    await tx.update(appSumoLicenses).set({
      ...(observed && observed.licenseKey === current.licenseKey && (observed.status !== "active" || (matches && !held))
        ? { status: anotherKeySupersedes ? "deactivated" as const : observed.status, tier: observed.tier, verifiedAt: now }
        : {}),
      nextCheckAt: retry ? new Date(now.getTime() + Math.min(15 * 60_000, 5000 * 2 ** attempts))
        : anotherKeySupersedes ? null : new Date(now.getTime() + 24 * 60 * 60_000),
      // A positive provider event remains unresolved after the short retry
      // budget; daily reconciliation may still confirm it later.
      expectedStatus: held ? "active" : matches || anotherKeySupersedes ? null : current.expectedStatus,
      checkLeaseToken: null, checkLeaseExpiresAt: null, checkAttempts: attempts, updatedAt: now,
    }).where(and(eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, current.licenseKey)));
    await moveBindingToTip(tx, input.productId, current.licenseKey, now);
  });
  } finally {
    if (claim.fence) await releaseBillingBindLease(input.db, claim.fence.serverId, claim.fence.lease);
  }
  return true;
}
