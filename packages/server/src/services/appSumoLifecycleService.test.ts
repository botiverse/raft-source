import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { appSumoLicenseBindings, appSumoLicenses, appSumoWebhookReceipts, servers } from "../db/schema";
import { parseAppSumoLicenseKey, type AppSumoLicenseKey } from "./appSumoContracts";
import { receiveAppSumoEvent, reconcileNextAppSumoLicense, projectPaidSourceServerPlan, setAppSumoPlanChangeSink } from "./appSumoLifecycleService";
import { getActiveAppSumoGrant, hasAppSumoBillingReservation } from "./appSumoLicenseService";
import type { AppSumoLicenseEvent } from "./appSumoProvider";

const productId = "fixture";
const makeKey = () => parseAppSumoLicenseKey(randomUUID())!;
const initial = new Date("2026-10-28T00:00:00Z");
const event = (key: AppSumoLicenseKey, kind: AppSumoLicenseEvent["event"], previous?: AppSumoLicenseKey): AppSumoLicenseEvent => ({
  license_key: key, event: kind, tier: 2, license_status: "inactive", event_timestamp: initial.getTime(), created_at: initial.getTime(), test: false,
  ...(previous ? { prev_license_key: previous } : {}),
});

test("a bound successor reserves billing throughout verification and retry exhaustion, until a refund", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server] = await db.insert(servers).values({ name: "Transition", slug: randomUUID(), ownerId: owner.id }).returning();
  const oldKey = makeKey(), newKey = makeKey();
  await db.insert(appSumoLicenses).values({ productId, licenseKey: oldKey, status: "active", tier: 4, verifiedAt: initial });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: oldKey, currentLicenseKey: oldKey });
  await receiveAppSumoEvent({ db, productId, event: event(newKey, "downgrade", oldKey), requestDigest: "a".repeat(64), now: initial });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "pending verification grants no paid capacity");
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true, "pending replacement blocks a second source");
  const { createCheckoutSession } = await import("./billingService");
  await assert.rejects(createCheckoutSession(server.id, owner.id, "https://example.test/s", "https://example.test/c"),
    /Stripe changes are not supported for an AppSumo license/, "direct service entry is also protected");
  for (let n = 0; n < 8; n++) {
    const at = new Date(initial.getTime() + (n + 1) * 60 * 60_000);
    assert.equal(await reconcileNextAppSumoLicense({ db, productId, now: () => at,
      getLicense: async licenseKey => ({ licenseKey, status: "deactivated", tier: 1 }) }), true);
  }
  const [pending] = await db.select().from(appSumoLicenses).where(and(eq(appSumoLicenses.productId, productId), eq(appSumoLicenses.licenseKey, newKey)));
  assert.equal(pending.checkAttempts, 8);
  assert.equal(pending.expectedStatus, "active", "the daily retry retains the unresolved positive event");
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true);
  // Simulate a row persisted by the previous release after it cleared the marker.
  await db.update(appSumoLicenses).set({ expectedStatus: null }).where(and(eq(appSumoLicenses.productId, productId), eq(appSumoLicenses.licenseKey, newKey)));
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true, "old ambiguous exhausted rows remain protected");
  const refundAt = new Date(initial.getTime() + 10 * 60 * 60_000);
  await receiveAppSumoEvent({ db, productId, event: event(newKey, "deactivate"), requestDigest: "b".repeat(64), now: refundAt });
  assert.equal(await hasAppSumoBillingReservation(db, server.id), false, "a confirmed negative webhook releases billing");
  await receiveAppSumoEvent({ db, productId, event: event(newKey, "activate"), requestDigest: "c".repeat(64), now: new Date(refundAt.getTime() + 1_000) });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  assert.equal(await hasAppSumoBillingReservation(db, server.id), true, "reactivation reserves while still unverified");
});

test("activation requires provider confirmation; refund and old-key retries cannot revoke a successor", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server] = await db.insert(servers).values({ name: "Bound", slug: randomUUID(), ownerId: owner.id }).returning();
  const a = makeKey(), b = makeKey();
  let now = new Date();
  const receive = (value: AppSumoLicenseEvent, digest: string) => receiveAppSumoEvent({ db, productId, event: value, requestDigest: digest.repeat(64), now });
  await receive(event(a, "activate"), "1");
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: a, currentLicenseKey: a });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  now = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }), inspectStripe: async () => "safe" });
  assert.equal((await getActiveAppSumoGrant(db, server.id))?.tier, 2);
  assert.equal((await db.select().from(servers).where(eq(servers.id, server.id)))[0].plan, "pro");
  await receive(event(b, "upgrade", a), "2");
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "a new key must be confirmed before paid access");
  now = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 4 }), inspectStripe: async () => "safe" });
  await receive(event(a, "deactivate"), "3");
  assert.equal((await getActiveAppSumoGrant(db, server.id))?.tier, 4);
  await receive(event(b, "deactivate"), "4");
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  assert.equal((await db.select().from(servers).where(eq(servers.id, server.id)))[0].plan, "free");
  await receive(event(b, "activate"), "5");
  now = new Date(now.getTime() + 10_000);
  const checkedKeys: AppSumoLicenseKey[] = [];
  for (let i = 0; i < 2; i++) {
    await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => {
      checkedKeys.push(licenseKey);
      return { licenseKey, status: "deactivated", tier: 4 };
    } });
    now = new Date(now.getTime() + 10_000);
  }
  assert.ok(checkedKeys.includes(b));
  assert.equal(await getActiveAppSumoGrant(db, server.id), null, "late activation does not resurrect a refunded license");
  assert.equal(await receive(event(b, "activate"), "5"), "duplicate");
  assert.equal((await db.select().from(appSumoWebhookReceipts)).length, 5);
});

test("replacement edges can arrive backwards; cyclic or forked histories roll back", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server] = await db.insert(servers).values({ name: "History", slug: randomUUID(), ownerId: owner.id }).returning();
  const a = makeKey(), b = makeKey(), c = makeKey(), fork = makeKey();
  await db.insert(appSumoLicenses).values({ productId, licenseKey: a, status: "active", tier: 1, verifiedAt: initial });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: a, currentLicenseKey: a });
  await receiveAppSumoEvent({ db, productId, event: event(c, "upgrade", b), requestDigest: "1".repeat(64), now: initial });
  await receiveAppSumoEvent({ db, productId, event: event(b, "upgrade", a), requestDigest: "2".repeat(64), now: initial });
  assert.equal((await db.select().from(appSumoLicenseBindings))[0].currentLicenseKey, c);
  await assert.rejects(receiveAppSumoEvent({ db, productId, event: event(a, "upgrade", c), requestDigest: "3".repeat(64), now: initial }));
  await assert.rejects(receiveAppSumoEvent({ db, productId, event: event(fork, "upgrade", a), requestDigest: "4".repeat(64), now: initial }));
  assert.equal((await db.select().from(appSumoWebhookReceipts)).length, 2);
});

test("provider budget and revision fence prevent parallel reads and stale activation after refund", async ({ db }) => {
  const key = makeKey();
  await receiveAppSumoEvent({ db, productId, event: event(key, "activate"), requestDigest: "1".repeat(64), now: initial });
  const now = new Date(initial.getTime() + 10_000);
  let reads = 0;
  await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => {
    reads++;
    assert.equal(await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async () => { throw new Error("must not run"); } }), false);
    await receiveAppSumoEvent({ db, productId, event: event(key, "deactivate"), requestDigest: "2".repeat(64), now });
    return { licenseKey, status: "active", tier: 2 };
  } });
  assert.equal(reads, 1);
  const [license] = await db.select().from(appSumoLicenses).where(and(eq(appSumoLicenses.productId, productId), eq(appSumoLicenses.licenseKey, key)));
  assert.equal(license.status, "deactivated");
  assert.equal(license.verifiedAt, null);
});

test("periodic provider checks revoke a bound license when its refund webhook was missed", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server] = await db.insert(servers).values({ name: "Missed event", slug: randomUUID(), ownerId: owner.id, plan: "pro" }).returning();
  const key = makeKey();
  await db.insert(appSumoLicenses).values({ productId, licenseKey: key, status: "active", tier: 2, verifiedAt: initial, nextCheckAt: initial });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: key, currentLicenseKey: key });
  const now = new Date(initial.getTime() + 24 * 60 * 60_000);
  assert.ok(await getActiveAppSumoGrant(db, server.id));
  await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => ({ licenseKey, status: "deactivated", tier: 2 }) });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  assert.equal((await db.select().from(servers).where(eq(servers.id, server.id)))[0].plan, "free");
});

test("an expired provider-read lease cannot grant access; the next claimant can recover", async ({ db }) => {
  const key = makeKey();
  await receiveAppSumoEvent({ db, productId, event: event(key, "activate"), requestDigest: "1".repeat(64), now: initial });
  let now = new Date(initial.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => {
    now = new Date(now.getTime() + 31_000);
    return { licenseKey, status: "active", tier: 2 };
  } });
  assert.equal((await db.select().from(appSumoLicenses))[0].status, "pending");
  await reconcileNextAppSumoLicense({ db, productId, now: () => now, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }) });
  assert.equal((await db.select().from(appSumoLicenses))[0].status, "active");
});


test("plan notifications re-read committed state, including after a rolled-back transaction", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server] = await db.insert(servers).values({ name: "Notify", slug: randomUUID(), ownerId: owner.id, plan: "pro" }).returning();
  let resolve!: (value: string) => void;
  const observed = new Promise<string>(done => { resolve = done; });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  setAppSumoPlanChangeSink(async serverId => {
    const [row] = await db.select().from(servers).where(eq(servers.id, serverId));
    resolve(row.plan);
  });
  try {
    await assert.rejects(db.transaction(async tx => {
      await tx.select().from(servers).where(eq(servers.id, server.id)).for("update");
      await projectPaidSourceServerPlan(tx, server.id, initial);
      throw new Error("rollback after temporary plan projection");
    }));
    assert.equal(await Promise.race([observed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("plan notification did not run")), 2000); })]), "pro", "the notification must never expose the rolled-back Free value");
  } finally { if (timeout) clearTimeout(timeout); setAppSumoPlanChangeSink(null); }
});
