import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { appSumoLicenseBindings, appSumoLicenses, serverMembers, servers, subscriptions } from "../db/schema";
import { parseAppSumoLicenseKey } from "./appSumoContracts";
import { startAppSumoRedemption, getAppSumoRedemptionStatus, bindAppSumoRedemption as bindWithInspection, APP_SUMO_CLAIM_TTL_MS } from "./appSumoRedemptionService";
import { receiveAppSumoEvent, reconcileNextAppSumoLicense } from "./appSumoLifecycleService";
import { addMember } from "./serverService";

const bindAppSumoRedemption = (input: Omit<Parameters<typeof bindWithInspection>[0], "inspectStripe">) =>
  bindWithInspection({ ...input, inspectStripe: async () => "safe" });

const productId = "fixture";
const now = new Date("2026-10-28T00:00:00Z");

test("owner binding rejects admins, paid sources, expired claims and cross-account adoption", async ({ db, seed }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const server = await seed.server({ owner });
  await addMember(server.id, admin.id, "admin");
  const key = parseAppSumoLicenseKey(randomUUID())!;
  for (const kind of ["purchase", "activate"] as const) await receiveAppSumoEvent({ db, productId, now,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    event: { license_key: key, event: kind, license_status: "inactive", tier: 2, created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  const token = await startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => now, exchangeCode: async () => key });
  const checked = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 1 }) });
  const status = await getAppSumoRedemptionStatus({ db, token, userId: admin.id, now: checked });
  assert.equal(status.status, "ready");
  if (status.status !== "ready") throw new Error("expected claim");
  await assert.rejects(bindAppSumoRedemption({ db, token, claimId: status.claimId, userId: admin.id, serverId: server.id, now: checked }), /owner_required/);
  await assert.rejects(bindAppSumoRedemption({ db, token, claimId: status.claimId, userId: owner.id, serverId: server.id, now: checked }), /claim_expired/);
  assert.equal((await getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked })).status, "expired");
  const ownToken = await startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => checked, exchangeCode: async () => key });
  const later = new Date(checked.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => later, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 1 }) });
  const own = await getAppSumoRedemptionStatus({ db, token: ownToken, userId: owner.id, now: later });
  if (own.status !== "ready") throw new Error("expected owner claim");
  const input = { db, token: ownToken, claimId: own.claimId, userId: owner.id, serverId: server.id, now: later };
  await db.insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "synthetic-customer", stripeSubscriptionId: "synthetic-subscription", status: "active" });
  await assert.rejects(bindAppSumoRedemption(input), /paid_source_conflict/);
  await db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.serverId, server.id));
  await db.update(servers).set({ plan: "partner" }).where(eq(servers.id, server.id));
  await assert.rejects(bindAppSumoRedemption(input), /paid_source_conflict/);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  await assert.rejects(bindAppSumoRedemption({ ...input, now: new Date(now.getTime() + APP_SUMO_CLAIM_TTL_MS + 30_000) }), /claim_expired/);
  assert.equal((await db.select().from(appSumoLicenseBindings)).length, 0);
  await db.update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const promoted = await bindAppSumoRedemption({ db, token, claimId: status.claimId, userId: admin.id, serverId: server.id, now: later });
  assert.equal(promoted.serverId, server.id, "a current owner can bind even when they did not create the server");
});

test("two owner claims for the same license cannot bind two servers or grant twice", async ({ db, seed }) => {
  const owner = await seed.human();
  const one = await seed.server({ owner });
  const two = await seed.server({ owner });
  const key = parseAppSumoLicenseKey(randomUUID())!;
  for (const kind of ["purchase", "activate"] as const) await receiveAppSumoEvent({ db, productId, now,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    event: { license_key: key, event: kind, license_status: "inactive", tier: 2, created_at: now.getTime(), event_timestamp: now.getTime(), test: false } });
  const tokens = await Promise.all([1, 2].map(() => startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => now, exchangeCode: async () => key })));
  const checked = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }) });
  const statuses = await Promise.all(tokens.map(token => getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked })));
  const results = await Promise.allSettled(tokens.map((token, i) => {
    const status = statuses[i];
    if (status.status !== "ready") throw new Error("expected ready");
    return bindAppSumoRedemption({ db, token, claimId: status.claimId, userId: owner.id, serverId: [one.id, two.id][i], now: checked });
  }));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal((await db.select().from(appSumoLicenseBindings)).length, 1);
  const winner = results.findIndex(result => result.status === "fulfilled");
  const newKey = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values({ productId, licenseKey: newKey, previousLicenseKey: key, status: "active", tier: 4, verifiedAt: checked });
  await db.update(appSumoLicenseBindings).set({ currentLicenseKey: newKey }).where(eq(appSumoLicenseBindings.currentLicenseKey, key));
  await db.update(appSumoLicenses).set({ status: "deactivated" }).where(eq(appSumoLicenses.licenseKey, key));
  const current = await getAppSumoRedemptionStatus({ db, token: tokens[winner], userId: owner.id, now: checked });
  assert.equal(current.status, "bound");
  assert.equal("tier" in current && current.tier, 4);
});

test("a provider-active key with missing purchase lineage waits instead of claiming a replacement as a fresh deal", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const key = parseAppSumoLicenseKey(randomUUID())!;
  const token = await startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => now, exchangeCode: async () => key });
  let checked = new Date(now.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }) });
  const pending = await getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked });
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") throw new Error("expected pending");
  await assert.rejects(bindAppSumoRedemption({ db, token, claimId: pending.claimId, serverId: server.id, userId: owner.id, now: checked }), /license_not_active/);
  for (const kind of ["activate", "purchase"] as const) await receiveAppSumoEvent({ db, productId, now: checked,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    event: { license_key: key, event: kind, license_status: "inactive", tier: 2, created_at: checked.getTime(), event_timestamp: checked.getTime(), test: false } });
  checked = new Date(checked.getTime() + 10_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked, getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 2 }) });
  assert.equal((await getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked })).status, "ready");
  await bindAppSumoRedemption({ db, token, claimId: pending.claimId, serverId: server.id, userId: owner.id, now: checked });
});
