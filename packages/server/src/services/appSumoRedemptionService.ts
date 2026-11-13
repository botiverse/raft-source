import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index";
import { appSumoLicenseBindings, appSumoLicenses, appSumoRedemptionClaims, appSumoWebhookReceipts, billingCheckoutAttempts, serverMembers, servers, subscriptions } from "../db/schema";
import type { AppSumoClaimId, AppSumoLicenseKey, AppSumoTier } from "./appSumoContracts";
import { AppSumoConflict, getAppSumoFamily, lockAppSumoProduct, projectPaidSourceServerPlan } from "./appSumoLifecycleService";
import { acquireBillingBindLease, billingBindLeaseIsCurrent, releaseBillingBindLease } from "./billingCheckoutCustody";
import type { StripeCheckoutSafety } from "./stripeCheckoutInspection";

export const APP_SUMO_CLAIM_TTL_MS = 60 * 60_000;
export function appSumoTokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function validAppSumoClaimToken(token: unknown): token is string { return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token); }

export async function startAppSumoRedemption(input: {
  db: Database; productId: string; code: string; priorToken?: string; now: () => Date;
  exchangeCode: (code: string) => Promise<AppSumoLicenseKey>;
}): Promise<string> {
  const codeHash = appSumoTokenHash(input.productId + "\0" + input.code);
  const [prior] = await input.db.select().from(appSumoRedemptionClaims).where(eq(appSumoRedemptionClaims.codeHash, codeHash));
  if (prior) {
    if (input.priorToken && validAppSumoClaimToken(input.priorToken) && appSumoTokenHash(input.priorToken) === prior.tokenHash && prior.expiresAt > input.now() && prior.state !== "failed") return input.priorToken;
    throw new AppSumoConflict("claim_expired");
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = appSumoTokenHash(token);
  const now = input.now();
  const [created] = await input.db.insert(appSumoRedemptionClaims).values({ tokenHash, codeHash, productId: input.productId,
    state: "exchanging", createdAt: now, expiresAt: new Date(now.getTime() + APP_SUMO_CLAIM_TTL_MS),
  }).onConflictDoNothing().returning();
  if (!created) throw new AppSumoConflict("claim_expired");
  try {
    const key = await input.exchangeCode(input.code);
    await input.db.transaction(async (tx) => {
      const observedAt = input.now();
      await lockAppSumoProduct(tx, input.productId, observedAt);
      await tx.insert(appSumoLicenses).values({ productId: input.productId, licenseKey: key }).onConflictDoNothing();
      const [license] = await tx.select().from(appSumoLicenses).where(and(eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, key))).for("update");
      // A fresh user authorization requests a current provider read, including
      // legitimate reactivation. It never trusts the browser's status/tier.
      await tx.update(appSumoLicenses).set({ expectedStatus: "active", nextCheckAt: observedAt, checkAttempts: 0,
        revision: license.revision + 1, checkLeaseToken: null, checkLeaseExpiresAt: null, updatedAt: observedAt,
      }).where(and(eq(appSumoLicenses.productId, input.productId), eq(appSumoLicenses.licenseKey, key)));
      await tx.update(appSumoRedemptionClaims).set({ licenseKey: key, state: "ready" }).where(eq(appSumoRedemptionClaims.tokenHash, tokenHash));
    });
    return token;
  } catch (error) {
    await input.db.update(appSumoRedemptionClaims).set({ state: "failed" }).where(eq(appSumoRedemptionClaims.tokenHash, tokenHash));
    throw error;
  }
}

/** A current key alone does not establish whether it replaced a license already
 * bound elsewhere. Require the recorded purchase root and activation edge; a
 * delayed/missing history must be reconciled rather than claimed as a new deal. */
async function recordedAppSumoClaimChain(tx: DatabaseTransaction, productId: string, key: AppSumoLicenseKey) {
  const family = await getAppSumoFamily(tx, productId, [key]);
  const roots = family.rows.filter(row => row.previousLicenseKey === null);
  if (roots.length !== 1) return false;
  const receipts = await tx.select({ licenseKey: appSumoWebhookReceipts.licenseKey, event: appSumoWebhookReceipts.event })
    .from(appSumoWebhookReceipts).where(and(eq(appSumoWebhookReceipts.productId, productId), inArray(appSumoWebhookReceipts.licenseKey, [roots[0].licenseKey, key])));
  return receipts.some(row => row.licenseKey === roots[0].licenseKey && row.event === "purchase")
    && receipts.some(row => row.licenseKey === key && (row.event === "activate" || row.event === "upgrade" || row.event === "downgrade"));
}

export type AppSumoRedemptionStatus =
  | { status: "expired" }
  | { status: "pending"; claimId: AppSumoClaimId }
  | { status: "ready"; claimId: AppSumoClaimId; tier: AppSumoTier }
  | { status: "bound"; claimId: AppSumoClaimId; serverId: string; serverSlug: string; tier: AppSumoTier };

export async function getAppSumoRedemptionStatus(input: { db: Database; token: string; userId: string; now: Date }): Promise<AppSumoRedemptionStatus> {
  if (!validAppSumoClaimToken(input.token)) return { status: "expired" };
  const hash = appSumoTokenHash(input.token);
  return input.db.transaction(async (tx) => {
    const [claim] = await tx.select().from(appSumoRedemptionClaims).where(eq(appSumoRedemptionClaims.tokenHash, hash)).for("update");
    if (!claim || claim.expiresAt <= input.now || claim.state === "failed" || (claim.userId && claim.userId !== input.userId)) return { status: "expired" };
    if (!claim.userId) await tx.update(appSumoRedemptionClaims).set({ userId: input.userId }).where(eq(appSumoRedemptionClaims.tokenHash, hash));
    if (!claim.licenseKey || claim.state === "exchanging") return { status: "pending", claimId: claim.id };
    if (claim.state === "consumed") {
      if (!claim.boundServerId) return { status: "expired" };
      const [server] = await tx.select({ id: servers.id, slug: servers.slug }).from(servers).innerJoin(serverMembers, and(
        eq(serverMembers.serverId, servers.id), eq(serverMembers.userId, input.userId), eq(serverMembers.role, "owner"),
      )).where(and(eq(servers.id, claim.boundServerId), isNull(servers.deletedAt)));
      if (!server) return { status: "expired" };
      const [binding] = await tx.select().from(appSumoLicenseBindings).where(and(eq(appSumoLicenseBindings.serverId, server.id), eq(appSumoLicenseBindings.productId, claim.productId)));
      if (!binding) return { status: "expired" };
      const [current] = await tx.select().from(appSumoLicenses).where(and(eq(appSumoLicenses.productId, claim.productId), eq(appSumoLicenses.licenseKey, binding.currentLicenseKey)));
      if (!current || current.status !== "active" || !current.verifiedAt || (current.tier !== 1 && current.tier !== 2 && current.tier !== 3 && current.tier !== 4)) throw new AppSumoConflict("license_not_active");
      return { status: "bound", claimId: claim.id, serverId: server.id, serverSlug: server.slug, tier: current.tier };
    }
    const [license] = await tx.select().from(appSumoLicenses).where(and(eq(appSumoLicenses.productId, claim.productId), eq(appSumoLicenses.licenseKey, claim.licenseKey)));
    if (!license || license.status !== "active" || !license.verifiedAt || license.verifiedAt < claim.createdAt || license.expectedStatus !== null || (license.tier !== 1 && license.tier !== 2 && license.tier !== 3 && license.tier !== 4)) {
      if (license && license.expectedStatus === null) throw new AppSumoConflict("license_not_active");
      return { status: "pending", claimId: claim.id };
    }
    if (!await recordedAppSumoClaimChain(tx, claim.productId, claim.licenseKey)) return { status: "pending", claimId: claim.id };
    return { status: "ready", claimId: claim.id, tier: license.tier };
  });
}

export async function bindAppSumoRedemption(input: {
  db: Database; token: string; claimId: AppSumoClaimId; serverId: string; userId: string; now: Date;
  inspectStripe: (input: { serverId: string; knownCustomerId: string | null; knownSubscriptionId: string | null; knownSessionIds: readonly string[] }) => Promise<StripeCheckoutSafety>;
}): Promise<{ serverId: string; serverSlug: string }> {
  if (!validAppSumoClaimToken(input.token)) throw new AppSumoConflict("claim_expired");
  const hash = appSumoTokenHash(input.token);
  const [hint] = await input.db.select().from(appSumoRedemptionClaims).where(eq(appSumoRedemptionClaims.tokenHash, hash));
  if (!hint) throw new AppSumoConflict("claim_expired");
  const startedAt = performance.now();
  const now = () => new Date(input.now.getTime() + Math.max(0, performance.now() - startedAt));
  // Authenticate and serialize before provider I/O. The lease fences new
  // checkout reservations, but never turns an uncertain prior attempt safe.
  const prepared = await input.db.transaction(async tx => {
    const [server] = await tx.select().from(servers).where(eq(servers.id, input.serverId)).for("update");
    if (!server || server.deletedAt || server.kind !== "normal") throw new AppSumoConflict("owner_required");
    const [membership] = await tx.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, input.userId))).for("share");
    if (membership?.role !== "owner") throw new AppSumoConflict("owner_required");
    const [claim] = await tx.select().from(appSumoRedemptionClaims).where(eq(appSumoRedemptionClaims.tokenHash, hash)).for("update");
    if (!claim || claim.id !== input.claimId || claim.productId !== hint.productId || claim.expiresAt <= now()
      || !claim.licenseKey || claim.userId !== input.userId || claim.state === "exchanging" || claim.state === "failed") throw new AppSumoConflict("claim_expired");
    if (claim.state === "consumed") {
      if (claim.boundServerId === server.id) return { kind: "already" as const, serverId: server.id, serverSlug: server.slug };
      throw new AppSumoConflict("license_already_bound");
    }
    const attempts = await tx.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.serverId, server.id));
    if (attempts.some(attempt => attempt.state !== "known" || !attempt.stripeSessionId)) throw new AppSumoConflict("stripe_verification_unavailable");
    const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    const [existingBinding] = await tx.select({ id: appSumoLicenseBindings.id }).from(appSumoLicenseBindings)
      .where(eq(appSumoLicenseBindings.serverId, server.id));
    if (!existingBinding && (server.plan !== "free" || (subscription && subscription.status !== "canceled"))) {
      throw new AppSumoConflict("paid_source_conflict");
    }
    const lease = await acquireBillingBindLease(tx, server.id);
    if (!lease) throw new AppSumoConflict("stripe_verification_unavailable");
    return { kind: "scan" as const, lease, knownCustomerId: subscription?.stripeCustomerId ?? null, knownSubscriptionId: subscription?.stripeSubscriptionId ?? null,
      knownSessionIds: attempts.map(attempt => attempt.stripeSessionId!) };
  });
  if (prepared.kind === "already") return { serverId: prepared.serverId, serverSlug: prepared.serverSlug };
  try {
    let safety: StripeCheckoutSafety;
    try { safety = await input.inspectStripe({ serverId: input.serverId,
      knownCustomerId: prepared.knownCustomerId, knownSubscriptionId: prepared.knownSubscriptionId, knownSessionIds: prepared.knownSessionIds }); }
    catch { safety = "unavailable"; }
    if (safety === "conflict") throw new AppSumoConflict("stripe_checkout_pending");
    if (safety !== "safe") throw new AppSumoConflict("stripe_verification_unavailable");
    return await input.db.transaction(async (tx) => {
    await lockAppSumoProduct(tx, hint.productId, now());
    const [server] = await tx.select().from(servers).where(eq(servers.id, input.serverId)).for("update");
    if (!server || server.deletedAt || server.kind !== "normal") throw new AppSumoConflict("owner_required");
    if (!await billingBindLeaseIsCurrent(tx, server.id, prepared.lease)) throw new AppSumoConflict("stripe_verification_unavailable");
    const currentAttempts = await tx.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.serverId, server.id));
    if (currentAttempts.some(attempt => attempt.state !== "known" || !attempt.stripeSessionId
      || !prepared.knownSessionIds.includes(attempt.stripeSessionId))) throw new AppSumoConflict("stripe_verification_unavailable");
    const [currentSubscription] = await tx.select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    if ((currentSubscription?.stripeCustomerId ?? null) !== prepared.knownCustomerId
      || (currentSubscription?.stripeSubscriptionId ?? null) !== prepared.knownSubscriptionId
      || (currentSubscription && currentSubscription.status !== "canceled")) throw new AppSumoConflict("stripe_verification_unavailable");
    const [membership] = await tx.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, input.userId))).for("share");
    if (membership?.role !== "owner") throw new AppSumoConflict("owner_required");
    const [claim] = await tx.select().from(appSumoRedemptionClaims).where(eq(appSumoRedemptionClaims.tokenHash, hash)).for("update");
    if (!claim || claim.id !== input.claimId || claim.productId !== hint.productId || claim.expiresAt <= now() || !claim.licenseKey || claim.userId !== input.userId || claim.state === "exchanging" || claim.state === "failed") throw new AppSumoConflict("claim_expired");
    if (claim.state === "consumed") {
      if (claim.boundServerId === server.id) return { serverId: server.id, serverSlug: server.slug };
      throw new AppSumoConflict("license_already_bound");
    }
    const family = await getAppSumoFamily(tx, claim.productId, [claim.licenseKey]);
    const license = family.rows.find((row) => row.licenseKey === claim.licenseKey);
    const superseded = family.rows.some((row) => row.previousLicenseKey === claim.licenseKey);
    if (!license || superseded || license.status !== "active" || !license.verifiedAt || license.verifiedAt < claim.createdAt || license.expectedStatus !== null || license.tier === null) throw new AppSumoConflict("license_not_active");
    if (!await recordedAppSumoClaimChain(tx, claim.productId, claim.licenseKey)) throw new AppSumoConflict("license_not_active");
    const bindings = await tx.select().from(appSumoLicenseBindings).where(or(eq(appSumoLicenseBindings.serverId, server.id), and(
      eq(appSumoLicenseBindings.productId, claim.productId), or(inArray(appSumoLicenseBindings.originalLicenseKey, family.keys), inArray(appSumoLicenseBindings.currentLicenseKey, family.keys)),
    ))).for("update");
    if (bindings.length && !(bindings.length === 1 && bindings[0].serverId === server.id && bindings[0].productId === claim.productId && family.keys.includes(bindings[0].currentLicenseKey))) throw new AppSumoConflict("license_already_bound");
    if (!bindings.length) {
      const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.serverId, server.id)).for("update");
      if (server.plan !== "free" || (subscription && subscription.status !== "canceled")) throw new AppSumoConflict("paid_source_conflict");
      await tx.insert(appSumoLicenseBindings).values({ serverId: server.id, productId: claim.productId,
        originalLicenseKey: claim.licenseKey, currentLicenseKey: claim.licenseKey, boundByUserId: input.userId, activatedAt: now(), updatedAt: now() });
    }
    await projectPaidSourceServerPlan(tx, server.id, now());
    await tx.update(appSumoRedemptionClaims).set({ state: "consumed", boundServerId: server.id }).where(eq(appSumoRedemptionClaims.tokenHash, hash));
    return { serverId: server.id, serverSlug: server.slug };
    });
  } finally {
    await releaseBillingBindLease(input.db, input.serverId, prepared.lease);
  }
}
