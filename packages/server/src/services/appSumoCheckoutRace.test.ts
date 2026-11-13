import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index";
import { appSumoLicenseBindings, billingCheckoutAttempts, billingSourceGuards } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { parseAppSumoLicenseKey } from "./appSumoContracts";
import { receiveAppSumoEvent, reconcileNextAppSumoLicense } from "./appSumoLifecycleService";
import { startAppSumoRedemption, getAppSumoRedemptionStatus, bindAppSumoRedemption } from "./appSumoRedemptionService";
import { markCheckoutAmbiguous, markCheckoutKnown, reserveStripeCheckout } from "./billingCheckoutCustody";

async function ready(db: Database, seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const productId = `test-${randomUUID()}`;
  const key = parseAppSumoLicenseKey(randomUUID())!;
  const created = new Date();
  for (const event of ["purchase", "activate"] as const) await receiveAppSumoEvent({ db, productId, now: created,
    requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    event: { license_key: key, event, license_status: "inactive", tier: 1,
      created_at: created.getTime(), event_timestamp: created.getTime(), test: false } });
  const token = await startAppSumoRedemption({ db, productId, code: randomUUID(), now: () => created, exchangeCode: async () => key });
  const checked = new Date(created.getTime() + 1_000);
  await reconcileNextAppSumoLicense({ db, productId, now: () => checked,
    getLicense: async licenseKey => ({ licenseKey, status: "active", tier: 1 }) });
  const claim = await getAppSumoRedemptionStatus({ db, token, userId: owner.id, now: checked });
  if (claim.status !== "ready") throw new Error("expected ready claim");
  return { db, token, claimId: claim.claimId, userId: owner.id, serverId: server.id, now: checked };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a bind scan fences checkout before provider creation and the committed grant fences it afterwards", async ({ db, seed }) => {
  const input = await ready(db, seed);
  const scanning = deferred(); const finish = deferred();
  const binding = bindAppSumoRedemption({ ...input, inspectStripe: async () => {
    scanning.resolve(); await finish.promise; return "safe";
  } });
  await scanning.promise;
  await assert.rejects(reserveStripeCheckout(db, input.serverId), /checking another plan change/);
  assert.equal((await db.select().from(billingCheckoutAttempts)).length, 0);
  finish.resolve();
  assert.equal((await binding).serverId, input.serverId);
  await assert.rejects(reserveStripeCheckout(db, input.serverId), /AppSumo/);
});

test("a checkout reserved before provider I/O or left ambiguous blocks binding and another checkout", async ({ db, seed }) => {
  const input = await ready(db, seed);
  const id = await reserveStripeCheckout(db, input.serverId);
  let scans = 0;
  const attempt = () => bindAppSumoRedemption({ ...input, inspectStripe: async () => { scans++; return "safe"; } });
  await assert.rejects(attempt(), /stripe_verification_unavailable/);
  await markCheckoutAmbiguous(db, { id, serverId: input.serverId });
  await assert.rejects(attempt(), /stripe_verification_unavailable/);
  await assert.rejects(reserveStripeCheckout(db, input.serverId), /checkout could not be confirmed/i);
  assert.equal(scans, 0);
  assert.equal((await db.select().from(appSumoLicenseBindings)).length, 0);
});

test("a known session is independently inspected and unresolved or unavailable evidence never binds", async ({ db, seed }) => {
  const input = await ready(db, seed);
  const id = await reserveStripeCheckout(db, input.serverId);
  assert.equal(await markCheckoutKnown(db, { id, serverId: input.serverId, stripeSessionId: "cs_known" }), true);
  let received: readonly string[] = [];
  const attempt = (result: "safe" | "conflict" | "unavailable") => bindAppSumoRedemption({ ...input,
    inspectStripe: async evidence => { received = evidence.knownSessionIds; return result; } });
  await assert.rejects(attempt("conflict"), /stripe_checkout_pending/);
  assert.deepEqual(received, ["cs_known"]);
  await assert.rejects(attempt("unavailable"), /stripe_verification_unavailable/);
  assert.equal((await db.select().from(appSumoLicenseBindings)).length, 0);
  assert.equal((await attempt("safe")).serverId, input.serverId);
});

test("a scan that loses its lease cannot commit after another owner takes over", async ({ db, seed }) => {
  const input = await ready(db, seed);
  const scanning = deferred(); const finish = deferred();
  const binding = bindAppSumoRedemption({ ...input, inspectStripe: async () => {
    scanning.resolve(); await finish.promise; return "safe";
  } });
  await scanning.promise;
  const replacement = randomUUID();
  await db.update(billingSourceGuards).set({ bindLeaseToken: replacement,
    bindLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(billingSourceGuards.serverId, input.serverId));
  finish.resolve();
  await assert.rejects(binding, /stripe_verification_unavailable/);
  assert.equal((await db.select().from(appSumoLicenseBindings)).length, 0);
  const [guard] = await db.select().from(billingSourceGuards).where(eq(billingSourceGuards.serverId, input.serverId));
  assert.equal(guard.bindLeaseToken, replacement, "a stale worker must not release the new owner's lease");
});
