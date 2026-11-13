import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { PRO_PREPAID_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedPrepaidPurchase } from "../test/prepaidProFixture";
import { getDb } from "../db/index";
import { featureFlags, servers, users } from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { __resetStripeForTests, __setStripeForTests } from "../services/billingService";
import { __resetPrepaidPriceCacheForTests } from "../services/prepaidProBilling";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { PREPAID_PRO_PRICE_LOOKUP_KEYS } from "../services/prepaidProContracts";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const ENV_KEYS = ["STRIPE_BILLING_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID", "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID"] as const;

async function withBillingEnv(work: () => Promise<void>) {
  const snapshot = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.STRIPE_BILLING_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_prepaid_routes";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_prepaid_routes";
  process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro_seat";
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_seat_annual";
  try { await work(); } finally {
    for (const key of ENV_KEYS) { if (snapshot[key] == null) delete process.env[key]; else process.env[key] = snapshot[key]; }
    __resetStripeForTests();
    __resetPrepaidPriceCacheForTests();
  }
}

async function setPrepaidFlag(enabled: boolean) {
  await getDb().insert(featureFlags)
    .values({ key: PRO_PREPAID_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled, defaultEnabled: true, killSwitch: false } });
}

async function seedVerifiedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label,
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

function fakeStripe() {
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const prices = ([1, 12] as const).map(months => ({
    id: `price_prepaid_${months}m`, active: true, type: "one_time", currency: "usd", product: "prod_raft_pro", lookup_key: PREPAID_PRO_PRICE_LOOKUP_KEYS[months], unit_amount: months * 1000,
  }));
  __setStripeForTests({
    prices: { list: async () => ({ data: prices, has_more: false }) },
    checkout: { sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => { created.push(params); return { id: `cs_test_${randomUUID()}`, url: "https://checkout.stripe.test/prepaid" }; },
      retrieve: async (id: string) => ({ id, status: "expired" }),
    } },
  } as unknown as Stripe);
  return created;
}

test("prepaid offer is for owners and admins; checkout is owner-only, behind pro_prepaid, and checks its input", async ({ app }) => {
  await withBillingEnv(async () => {
    const owner = await seedVerifiedUser("prepaid-route-owner");
    const admin = await seedVerifiedUser("prepaid-route-admin");
    const member = await seedVerifiedUser("prepaid-route-member");
    const server = await createServer("Prepaid routes", `prepaid-routes-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await addMember(server.id, member.id, "member");
    fakeStripe();
    const headers = async (email: string) => ({ Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" });
    const offer = (email: string) => headers(email).then(h => fetch(`${app.baseUrl}/api/billing/prepaid/offer`, { headers: h }));
    const checkout = (email: string, body: Record<string, unknown>) => headers(email).then(h => fetch(`${app.baseUrl}/api/billing/prepaid/checkout`, { method: "POST", headers: h, body: JSON.stringify(body) }));
    const body = { months: 12, seatQuantity: 3, successUrl: "http://127.0.0.1:4173/billing", cancelUrl: "http://127.0.0.1:4173/billing" };

    assert.equal((await offer(member.email)).status, 403);
    const off = await (await offer(owner.email)).json() as { unavailableReason: string };
    assert.equal(off.unavailableReason, "disabled");
    const disabled = await checkout(owner.email, body);
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json() as { code: string }).code, "FEATURE_DISABLED");

    await setPrepaidFlag(true);
    const adminOffer = await (await offer(admin.email)).json() as { unavailableReason: string | null; periods: unknown[]; minimumSeatQuantity: number };
    assert.equal(adminOffer.unavailableReason, null);
    assert.equal(adminOffer.periods.length, 2);
    assert.equal(adminOffer.minimumSeatQuantity, 3);
    assert.equal((await checkout(admin.email, body)).status, 403, "admins cannot pay");
    assert.equal((await checkout(owner.email, { ...body, successUrl: "https://evil.example/" })).status, 400);
    const badMonths = await checkout(owner.email, { ...body, months: 6 });
    assert.equal(badMonths.status, 400);
    const badMonthsBody = await badMonths.json() as { code: string };
    assert.equal(badMonthsBody.code, "invalid_months", JSON.stringify(badMonthsBody));
  });
});

test("an owner's prepaid checkout must cover the seats in use and takes no price from the request", async ({ app }) => {
  await withBillingEnv(async () => {
    const owner = await seedVerifiedUser("prepaid-route-seats-owner");
    const member = await seedVerifiedUser("prepaid-route-seats-member");
    const server = await createServer("Prepaid seats", `prepaid-seats-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id, "member");
    await setPrepaidFlag(true);
    const created = fakeStripe();
    const h = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
    const checkout = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/billing/prepaid/checkout`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const body = { months: 12, seatQuantity: 2, successUrl: "http://127.0.0.1:4173/billing", cancelUrl: "http://127.0.0.1:4173/billing" };
    const tooFew = await checkout({ ...body, seatQuantity: 1 });
    assert.equal(tooFew.status, 400);
    assert.equal((await tooFew.json() as { code: string }).code, "seat_quantity_below_usage");
    const ok = await checkout({ ...body, unitAmount: 1 });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { url: string }).url, "https://checkout.stripe.test/prepaid");
    assert.deepEqual(created.at(-1)?.line_items, [{ price: "price_prepaid_12m", quantity: 2 }], "a price in the request is ignored");
  });
});

test("a prepaid checkout keeps the paywall's surface on the session and billing_prepaid_checkout_started; an unknown one is dropped", async ({ app }) => {
  await withBillingEnv(async () => {
    const owner = await seedVerifiedUser("prepaid-route-surface-owner");
    const server = await createServer("Prepaid surface", `prepaid-surface-${randomUUID()}`, owner.id);
    await setPrepaidFlag(true);
    const created = fakeStripe();
    const rows: ProductEventRow[] = [];
    const sink: ProductEventSink = { enqueue: (batch) => { rows.push(...batch); }, flush: async () => {} };
    app.app.set(PRODUCT_EVENT_SINK_APP_KEY, sink);
    const h = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
    const checkout = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/billing/prepaid/checkout`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const body = { months: 1, seatQuantity: 1, successUrl: "http://127.0.0.1:4173/billing", cancelUrl: "http://127.0.0.1:4173/billing", entry: "upload_monthly_quota" };

    // Save as Artifact's quota paywall opened the dialog (#proj-commercial:#22).
    assert.equal((await checkout({ ...body, surface: "artifact" })).status, 200);
    assert.equal(created.at(-1)?.metadata?.checkoutSurface, "artifact");
    // Analytics only: a surface the server does not know is dropped, never a 4xx.
    assert.equal((await checkout({ ...body, surface: "attachment" })).status, 200);
    assert.equal(created.at(-1)?.metadata?.checkoutSurface, undefined);
    for (let i = 0; i < 100 && rows.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(rows.filter((row) => row.event === "billing_prepaid_checkout_started").map((row) => row.properties), [
      { entry: "upload_monthly_quota", months: 1, seat_quantity: 1, renewal: false, surface: "artifact" },
      { entry: "upload_monthly_quota", months: 1, seat_quantity: 1, renewal: false },
    ]);
  });
});

test("while prepaid time grants Pro, subscription routes answer 409 and the portal stays open", async ({ app }) => {
  await withBillingEnv(async () => {
    const owner = await seedVerifiedUser("prepaid-guard-owner");
    const server = await createServer("Prepaid guard", `prepaid-guard-${randomUUID()}`, owner.id);
    const now = Date.now();
    await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: new Date(now - 60_000), endsAt: new Date(now + 10 * 86_400_000), seatQuantity: 2 });
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
    fakeStripe();
    const h = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
    const post = (path: string, body: Record<string, unknown> = {}) => fetch(`${app.baseUrl}/api/billing${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const sub = await post("/checkout", { targetPlan: "pro", successUrl: "http://127.0.0.1:4173/b", cancelUrl: "http://127.0.0.1:4173/b" });
    assert.equal(sub.status, 409);
    assert.equal((await sub.json() as { code: string }).code, "PREPAID_ACTIVE");
    for (const path of ["/seat-pack-quantity", "/seat-pack-quantity/preview", "/pack-quantity", "/cancel"]) {
      const res = await post(path, { seatQuantity: 3 });
      assert.equal(res.status, 409, path);
      assert.equal((await res.json() as { code: string }).code, "PREPAID_BILLING_MANAGED", path);
    }
    const portal = await post("/portal", { returnUrl: "http://127.0.0.1:4173/b" });
    assert.notEqual(portal.status, 409, "invoices stay reachable");
    const summary = await (await fetch(`${app.baseUrl}/api/billing/subscription`, { headers: h })).json() as { source: string; price: unknown; prepaid: { seatQuantity: number } };
    assert.equal(summary.source, "prepaid");
    assert.equal(summary.price, null);
    assert.equal(summary.prepaid.seatQuantity, 2);
  });
});

test("seats mid-period: the quote is for owners and admins, the checkout owner-only behind pro_prepaid, priced by the server", async ({ app }) => {
  await withBillingEnv(async () => {
    const owner = await seedVerifiedUser("prepaid-seats-route-owner");
    const admin = await seedVerifiedUser("prepaid-seats-route-admin");
    const member = await seedVerifiedUser("prepaid-seats-route-member");
    const server = await createServer("Prepaid seat adds", `prepaid-seat-adds-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await addMember(server.id, member.id, "member");
    const now = new Date();
    await seedPrepaidPurchase(getDb(), { serverId: server.id, months: 1, seatQuantity: 3, startsAt: new Date(now.getTime() - 10 * 86_400_000), endsAt: new Date(now.getTime() + 20 * 86_400_000) });
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
    const created = fakeStripe();
    const headers = async (email: string) => ({ Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" });
    const quote = (email: string, seats: string) => headers(email).then(h => fetch(`${app.baseUrl}/api/billing/prepaid/seats/quote?seatQuantity=${seats}`, { headers: h }));
    const checkout = (email: string, body: Record<string, unknown>) => headers(email).then(h => fetch(`${app.baseUrl}/api/billing/prepaid/seats/checkout`, { method: "POST", headers: h, body: JSON.stringify(body) }));
    const body = { seatQuantity: 2, successUrl: "http://127.0.0.1:4173/billing", cancelUrl: "http://127.0.0.1:4173/billing" };

    assert.equal((await quote(member.email, "2")).status, 403);
    assert.equal((await (await quote(owner.email, "2")).json() as { unavailableReason: string }).unavailableReason, "disabled");
    assert.equal((await checkout(owner.email, body)).status, 403, "behind pro_prepaid");

    await setPrepaidFlag(true);
    const badQuote = await quote(admin.email, "0");
    assert.equal(badQuote.status, 400);
    assert.equal((await badQuote.json() as { code: string }).code, "invalid_seat_quantity");
    const priced = await (await quote(admin.email, "2")).json() as { unavailableReason: string | null; unitAmount: number; amountTotal: number; days: number };
    assert.deepEqual([priced.unavailableReason, priced.unitAmount, priced.amountTotal, priced.days], [null, Math.round(1000 * 20 / 30), Math.round(1000 * 20 / 30) * 2, 20]);
    assert.equal((await checkout(admin.email, body)).status, 403, "admins cannot pay");
    assert.equal((await checkout(owner.email, { ...body, successUrl: "https://evil.example/" })).status, 400);
    const ok = await checkout(owner.email, { ...body, unitAmount: 1 });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { url: string }).url, "https://checkout.stripe.test/prepaid");
    assert.deepEqual(created.at(-1)?.line_items, [{ price_data: { currency: "usd", product: "prod_raft_pro", unit_amount: priced.unitAmount }, quantity: 2 }], "a price in the request is ignored");
  });
});
