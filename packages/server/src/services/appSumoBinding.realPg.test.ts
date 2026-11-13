import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { appSumoLicenseBindings, appSumoLicenses, appSumoProducts, billingCheckoutAttempts, serverMembers, servers, subscriptions, users } from "../db/schema";
import { parseAppSumoLicenseKey } from "./appSumoContracts";
import { getActiveAppSumoGrant, hasAppSumoBillingReservation } from "./appSumoLicenseService";
import { receiveAppSumoEvent, reconcileNextAppSumoLicense } from "./appSumoLifecycleService";
import { startAppSumoRedemption, getAppSumoRedemptionStatus, bindAppSumoRedemption as bindWithInspection } from "./appSumoRedemptionService";

const bindAppSumoRedemption = (input: Omit<Parameters<typeof bindWithInspection>[0], "inspectStripe">) =>
  bindWithInspection({ ...input, inspectStripe: async () => "safe" });

const url = process.env.APPSUMO_REAL_PG_URL ?? process.env.CHANNEL_CONVERSION_REAL_PG_URL;
const required = process.env.APPSUMO_REAL_PG_REQUIRED === "1" || process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
let pool: pg.Pool | undefined;
beforeAll(async () => {
  if (!url) { if (required) throw new Error("APPSUMO_REAL_PG_URL is required"); return; }
  pool = new pg.Pool({ connectionString: url, max: 4 });
  await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  await initDatabase(url);
});
afterAll(async () => { if (url) await closeDatabase(); await pool?.end(); });

async function blockedBy(holder: number, minimum: number) {
  for (let i = 0; i < 100; i++) {
    const result = await pool!.query("WITH RECURSIVE waits AS (SELECT pid, unnest(pg_blocking_pids(pid)) AS blocker FROM pg_stat_activity), blocked AS (SELECT pid FROM waits WHERE blocker=$1 UNION SELECT w.pid FROM waits w JOIN blocked b ON w.blocker=b.pid) SELECT count(DISTINCT pid)::integer AS count FROM blocked", [holder]);
    if (result.rows[0].count >= minimum) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const rows = await pool!.query("SELECT pid, state, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database()");
  throw new Error("real competing connections did not block on the expected row: " + JSON.stringify({ holder, minimum, sessions: rows.rows }));
}

test.skipIf(!url && !required)("real concurrent owner bindings serialize, and Stripe reads do not deadlock with license revocation", async () => {
  const db = getDb();
  const productId = `race-${randomUUID()}`;
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const destinations = await db.insert(servers).values([1, 2].map(() => ({ name: "AppSumo PG", slug: randomUUID(), ownerId: owner.id }))).returning();
  await db.insert(serverMembers).values(destinations.map(server => ({ serverId: server.id, userId: owner.id, role: "owner" as const })));
  const key = parseAppSumoLicenseKey(randomUUID())!;
  const now = new Date();
  for (const kind of ["purchase", "activate"] as const) await receiveAppSumoEvent({ db, productId, now,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    event: { license_key: key, event: kind, license_status: "inactive", tier: 2, created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  const tokens = await Promise.all([1, 2].map(() => startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => now, exchangeCode: async () => key })));
  const checked = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }) });
  const claims = await Promise.all(tokens.map(token => getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked })));
  // Bind outside the ambient transaction so these acquire different PG connections.
  const compete = AsyncResource.bind(() => tokens.map((token, i) => {
    const claim = claims[i];
    if (claim.status !== "ready") throw new Error("claim not ready");
    return bindAppSumoRedemption({ db, token, userId: owner.id, claimId: claim.claimId, serverId: destinations[i].id, now: checked });
  }));
  let pending: Promise<PromiseSettledResult<{ serverId: string; serverSlug: string }>[]> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(appSumoProducts).where(eq(appSumoProducts.productId, productId)).for("update");
    const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    const holder = Number(result.rows[0].pid);
    pending = Promise.allSettled(compete());
    await blockedBy(holder, 2);
  });
  const results = await pending!;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const [binding] = await db.select().from(appSumoLicenseBindings).where(eq(appSumoLicenseBindings.productId, productId));
  assert.ok(binding.serverId);
  const winningServer = binding.serverId;
  const revoke = AsyncResource.bind(() => receiveAppSumoEvent({ db, productId, requestDigest: "9".repeat(64), now: checked,
    event: { license_key: key, event: "deactivate", license_status: "active", tier: 2, created_at: checked.getTime(), event_timestamp: checked.getTime(), test: false } }));
  let revoking: Promise<unknown> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(servers).where(eq(servers.id, winningServer)).for("update");
    const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    revoking = revoke();
    await blockedBy(Number(result.rows[0].pid), 1);
    assert.ok(await getActiveAppSumoGrant(tx, winningServer), "billing's grant read must not wait on the product lock");
    await tx.insert(subscriptions).values({ serverId: winningServer, stripeCustomerId: randomUUID(), stripeSubscriptionId: randomUUID(), status: "active" });
  });
  await revoking;
  assert.equal(await getActiveAppSumoGrant(db, winningServer), null);
  assert.equal((await db.select().from(servers).where(eq(servers.id, winningServer)))[0].plan, "pro", "revocation preserves the concurrently committed Stripe source");
}, 30_000);

test.skipIf(!url && !required)("real concurrent checkout reservation and AppSumo binding cannot both win", async () => {
  const db = getDb();
  const productId = `checkout-race-${randomUUID()}`;
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Checkout race", slug: randomUUID(), ownerId: owner.id }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const key = parseAppSumoLicenseKey(randomUUID())!;
  const now = new Date();
  for (const event of ["purchase", "activate"] as const) await receiveAppSumoEvent({ db, productId, now,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    event: { license_key: key, event, license_status: "inactive", tier: 1, created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  const token = await startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => now, exchangeCode: async () => key });
  const checked = new Date(now.getTime() + 1_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 1 }) });
  const claim = await getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked });
  if (claim.status !== "ready") throw new Error("claim not ready");
  const { reserveStripeCheckout } = await import("./billingCheckoutCustody");
  const compete = AsyncResource.bind(() => Promise.allSettled([
    reserveStripeCheckout(db, server.id),
    bindAppSumoRedemption({ db, token, claimId: claim.claimId, serverId: server.id, userId: owner.id, now: checked }),
  ]));
  let pending: ReturnType<typeof compete> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(servers).where(eq(servers.id, server.id)).for("update");
    const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    pending = compete();
    await blockedBy(Number(result.rows[0].pid), 2);
  });
  const [checkout, binding] = await pending!;
  assert.notEqual(checkout.status, binding.status, "exactly one billing source can reserve the server");
  const rows = await db.select().from(appSumoLicenseBindings).where(eq(appSumoLicenseBindings.serverId, server.id));
  assert.equal(rows.length, binding.status === "fulfilled" ? 1 : 0);
}, 30_000);

test.skipIf(!url && !required)("a committed replacement reserves billing while verification is pending; a refund releases it", async () => {
  const db = getDb(), productId = `transition-${randomUUID()}`, now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Transition PG", slug: randomUUID(), ownerId: owner.id }).returning();
  const a = parseAppSumoLicenseKey(randomUUID())!, b = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values({ productId, licenseKey: a, status: "active", tier: 4, verifiedAt: now });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: a, currentLicenseKey: a });
  await receiveAppSumoEvent({ db, productId, now, requestDigest: "a".repeat(64),
    event: { license_key: b, prev_license_key: a, event: "downgrade", license_status: "inactive", tier: 1,
      created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true);
  const { reserveStripeCheckout } = await import("./billingCheckoutCustody");
  await assert.rejects(reserveStripeCheckout(db, server.id), /Stripe changes are not supported for an AppSumo license/,
    "the atomic checkout reservation must also reject an unverified successor");
  await receiveAppSumoEvent({ db, productId, now: new Date(now.getTime() + 1_000), requestDigest: "b".repeat(64),
    event: { license_key: b, event: "deactivate", license_status: "inactive", tier: 1,
      created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  assert.equal(await hasAppSumoBillingReservation(db, server.id), false);
  await receiveAppSumoEvent({ db, productId, now: new Date(now.getTime() + 2_000), requestDigest: "c".repeat(64),
    event: { license_key: b, event: "activate", license_status: "inactive", tier: 1,
      created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  await db.update(appSumoLicenses).set({ expectedStatus: null, checkAttempts: 8 }).where(eq(appSumoLicenses.licenseKey, b));
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true, "old exhausted reactivation is ambiguous");
  await receiveAppSumoEvent({ db, productId, now: new Date(now.getTime() + 3_000), requestDigest: "d".repeat(64),
    event: { license_key: b, event: "deactivate", license_status: "inactive", tier: 1,
      created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  assert.equal(await hasAppSumoBillingReservation(db, server.id), false, "a later refund resolves the ambiguity");
  assert.ok(await reserveStripeCheckout(db, server.id), "a confirmed refund permits a new checkout reservation");
}, 30_000);

test.skipIf(!url && !required)("reactivation holds an uncertain checkout and recovers only after provider evidence", async () => {
  const db = getDb(), productId = `reactivate-${randomUUID()}`, now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Reactivation", slug: randomUUID(), ownerId: owner.id }).returning();
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values({ productId, licenseKey: key, status: "active", tier: 1, verifiedAt: now });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: key, currentLicenseKey: key });
  const event = async (kind: "activate" | "deactivate", at: Date) => receiveAppSumoEvent({ db, productId, now: at,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"), event: { license_key: key, event: kind,
      license_status: "inactive", tier: 1, created_at: at.getTime(), event_timestamp: at.getTime(), test: false } });
  await event("deactivate", now);
  const { reserveStripeCheckout, markCheckoutAmbiguous } = await import("./billingCheckoutCustody");
  const attemptId = await reserveStripeCheckout(db, server.id);
  await markCheckoutAmbiguous(db, { id: attemptId, serverId: server.id });
  const activation = new Date(now.getTime() + 1_000);
  await event("activate", activation);
  let scans = 0;
  const provider = async (licenseKey: typeof key) => ({ licenseKey, status: "active" as const, tier: 1 as const });
  const checked = new Date(now.getTime() + 8_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: provider,
    inspectStripe: async () => { scans++; return "safe"; } });
  assert.equal(scans, 0, "an unknown creation must not be declared safe by a provider listing");
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true);
  const [held] = await db.select().from(appSumoLicenses).where(eq(appSumoLicenses.licenseKey, key));
  assert.equal(held.expectedStatus, "active");
  const sessionId = `cs_test_${randomUUID()}`;
  await db.update(billingCheckoutAttempts).set({ state: "known", stripeSessionId: sessionId }).where(eq(billingCheckoutAttempts.id, attemptId));
  const retryAt = new Date(checked.getTime() + 20_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => retryAt, getLicense: provider,
    inspectStripe: async ({ knownSessionIds }) => { assert.deepEqual(knownSessionIds, [sessionId]); scans++; return "conflict"; } });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "an open session cannot restore the other source");
  const safeAt = new Date(retryAt.getTime() + 30_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => safeAt, getLicense: provider,
    inspectStripe: async () => { scans++; return "safe"; } });
  assert.ok(await getActiveAppSumoGrant(db, server.id), "a fully settled session permits restoration");
  assert.equal(scans, 2);
}, 30_000);

test.skipIf(!url && !required)("preverified successor is held and the final activation rechecks concurrent checkout evidence", async () => {
  const db = getDb(), productId = `successor-${randomUUID()}`, now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Successor", slug: randomUUID(), ownerId: owner.id }).returning();
  const oldKey = parseAppSumoLicenseKey(randomUUID())!, nextKey = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values([
    { productId, licenseKey: oldKey, status: "deactivated", tier: 1, verifiedAt: now },
    { productId, licenseKey: nextKey, status: "active", tier: 2, verifiedAt: now },
  ]);
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: oldKey, currentLicenseKey: oldKey });
  await receiveAppSumoEvent({ db, productId, now, requestDigest: "e".repeat(64), event: { license_key: nextKey,
    prev_license_key: oldKey, event: "upgrade", license_status: "active", tier: 2,
    created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "a preverified successor cannot bypass the reactivation fence");
  const checked = new Date(now.getTime() + 8_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked,
    getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }),
    inspectStripe: async () => {
      await db.insert(billingCheckoutAttempts).values({ id: randomUUID(), serverId: server.id, state: "ambiguous" });
      return "safe";
    } });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "the transaction must recheck newly observed checkout uncertainty");
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true);
}, 30_000);

test.skipIf(!url && !required)("reactivation rechecks a subscription discovered while Stripe is being inspected", async () => {
  const db = getDb(), productId = `sub-inspection-race-${randomUUID()}`, now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Subscription inspection race", slug: randomUUID(), ownerId: owner.id }).returning();
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values({ productId, licenseKey: key, status: "deactivated", tier: 1, verifiedAt: now });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: key, currentLicenseKey: key });
  const originalSubscriptionId = `sub_${randomUUID()}`;
  await db.insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_test", stripeSubscriptionId: originalSubscriptionId, status: "canceled" });
  await receiveAppSumoEvent({ db, productId, now, requestDigest: "f".repeat(64), event: { license_key: key, event: "activate",
    license_status: "inactive", tier: 1, created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  await reconcileNextAppSumoLicense({ db, productId, now: () => new Date(now.getTime() + 8_000),
    getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 1 }), inspectStripe: async evidence => {
      assert.equal(evidence.knownSubscriptionId, originalSubscriptionId);
      await db.update(subscriptions).set({ stripeSubscriptionId: `sub_${randomUUID()}` }).where(eq(subscriptions.serverId, server.id));
      return "safe";
    } });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "new subscription evidence needs its own provider inspection");
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true);
}, 30_000);

test.skipIf(!url && !required)("first binding rechecks a subscription discovered during the Stripe scan", async () => {
  const db = getDb(), productId = `bind-sub-scan-${randomUUID()}`, now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Binding subscription race", slug: randomUUID(), ownerId: owner.id }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const key = parseAppSumoLicenseKey(randomUUID())!;
  for (const kind of ["purchase", "activate"] as const) await receiveAppSumoEvent({ db, productId, now,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"), event: { license_key: key, event: kind,
      license_status: "inactive", tier: 1, created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  const token = await startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => now, exchangeCode: async () => key });
  const checked = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 1 }) });
  const claim = await getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked });
  if (claim.status !== "ready") throw new Error("claim not ready");
  await assert.rejects(bindWithInspection({ db, token, claimId: claim.claimId, serverId: server.id, userId: owner.id, now: checked,
    inspectStripe: async evidence => {
      assert.equal(evidence.knownSubscriptionId, null);
      await db.insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_test", stripeSubscriptionId: `sub_${randomUUID()}`, status: "canceled" });
      return "safe";
    } }), /stripe_verification_unavailable/);
  assert.equal((await db.select().from(appSumoLicenseBindings).where(eq(appSumoLicenseBindings.serverId, server.id))).length, 0);
}, 30_000);

test.skipIf(!url && !required)("real concurrent Stripe cancellation and stale update preserve the terminal subscription", async () => {
  const db = getDb(), productId = `stripe-event-race-${randomUUID()}`, now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Stripe event race", slug: randomUUID(), ownerId: owner.id }).returning();
  const key = parseAppSumoLicenseKey(randomUUID())!, subId = `sub_${randomUUID()}`;
  await db.insert(appSumoLicenses).values({ productId, licenseKey: key, status: "active", tier: 1, verifiedAt: now });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: key, currentLicenseKey: key });
  await db.insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_test", stripeSubscriptionId: subId, status: "active" });
  const sub = (status: "active" | "canceled") => ({ id: subId, customer: "cus_test", status,
    cancel_at_period_end: false, cancel_at: null, metadata: { serverId: server.id, userId: owner.id, targetPlan: "pro",
      pricingContract: "raft-pro-seat-v1", billingInterval: "monthly", seatQuantity: "1", proPackQuantity: "1" },
    items: { data: [{ id: "si_test", quantity: 1, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000,
      price: { id: "price_test", product: "prod_test", recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription);
  const { handleWebhookEvent, getBillingSummary } = await import("./billingService");
  const event = (type: "customer.subscription.deleted" | "customer.subscription.updated", status: "active" | "canceled") =>
    ({ id: `evt_${randomUUID()}`, type, data: { object: sub(status) } } as Stripe.Event);
  const cancel = AsyncResource.bind(() => handleWebhookEvent(event("customer.subscription.deleted", "canceled")));
  const stale = AsyncResource.bind(() => handleWebhookEvent(event("customer.subscription.updated", "active")));
  let canceled: Promise<void> | undefined;
  let updated: Promise<void> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(subscriptions).where(eq(subscriptions.serverId, server.id)).for("update");
    const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    const holder = Number(result.rows[0].pid);
    canceled = cancel();
    await blockedBy(holder, 1);
    updated = stale();
    await blockedBy(holder, 2);
  });
  await Promise.all([canceled!, updated!]);
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
  assert.equal(row.status, "canceled", "late active event must not undo the committed cancellation");
  assert.equal((await getBillingSummary(server.id)).sourceConflict, null);
  assert.ok(await getActiveAppSumoGrant(db, server.id));
}, 30_000);

test.skipIf(!url && !required)("real Stripe subscription replacement cannot overwrite a newer projection during provider I/O", async () => {
  const db = getDb(), now = new Date();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "synthetic", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Provider replacement race", slug: randomUUID(), ownerId: owner.id }).returning();
  const old = `sub_old_${randomUUID()}`, incoming = `sub_new_${randomUUID()}`, winner = `sub_winner_${randomUUID()}`;
  await db.insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_test", stripeSubscriptionId: old, status: "canceled" });
  const providerSub = { id: incoming, customer: "cus_test", status: "active", cancel_at_period_end: false, cancel_at: null,
    metadata: { serverId: server.id, userId: owner.id, targetPlan: "pro", pricingContract: "raft-pro-seat-v1", billingInterval: "monthly", seatQuantity: "1" },
    items: { data: [{ id: "si_test", quantity: 1, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000,
      price: { id: "price_test", product: "prod_test", recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription;
  const { handleWebhookEvent, __setStripeForTests, __resetStripeForTests } = await import("./billingService");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  __setStripeForTests({ subscriptions: { retrieve: async () => { entered(); await gate; return providerSub; } } } as unknown as Stripe);
  try {
    const event = { id: `evt_${randomUUID()}`, type: "customer.subscription.updated", data: { object: providerSub } } as Stripe.Event;
    const pending = handleWebhookEvent(event);
    await started;
    await db.update(subscriptions).set({ stripeSubscriptionId: winner, status: "canceled", updatedAt: now }).where(eq(subscriptions.serverId, server.id));
    release();
    await assert.rejects(pending, /requires reconciliation/);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(row.stripeSubscriptionId, winner);
    assert.equal(row.status, "canceled");
  } finally { release(); __resetStripeForTests(); }
}, 30_000);
