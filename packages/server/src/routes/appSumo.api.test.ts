import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { appSumoLicenseBindings, appSumoLicenses, appSumoRedemptionClaims, appSumoWebhookReceipts } from "../db/schema";
import { parseAppSumoLicenseKey } from "../services/appSumoContracts";
import { reconcileNextAppSumoLicense } from "../services/appSumoLifecycleService";
import { createAppSumoProvider } from "../services/appSumoProvider";
import { getAppSumoConfig } from "../services/appSumoConfig";
import { addMember } from "../services/serverService";
import { __resetStripeForTests, __setStripeForTests } from "../services/billingService";
import type Stripe from "stripe";

const test = createApiTest();
const envKeys = ["APPSUMO_PRODUCT_ID", "APPSUMO_API_KEY", "APPSUMO_REDIRECT_URI", "APPSUMO_CLIENT_ID", "APPSUMO_CLIENT_SECRET", "APP_URL"] as const;
function environment() {
  const prior = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { APPSUMO_PRODUCT_ID: "fixture", APPSUMO_API_KEY: "synthetic-provider-key", APPSUMO_CLIENT_ID: "fixture-client",
    APPSUMO_CLIENT_SECRET: "fixture-client-secret", APPSUMO_REDIRECT_URI: "https://api.raft.test/api/appsumo/oauth/callback", APP_URL: "https://app.raft.test" });
  return () => { for (const key of envKeys) { const value = prior.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test("real callback and authenticated redemption bind once to an owner server without exposing license keys", async ({ app, db, seed }) => {
  const restore = environment();
  const realFetch = globalThis.fetch;
  const licenseKey = parseAppSumoLicenseKey(randomUUID())!;
  let exchanges = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://appsumo.com" && url.pathname === "/openid/token/") {
      exchanges++;
      return new Response(JSON.stringify({ access_token: "synthetic-access-token" }));
    }
    if (url.origin === "https://appsumo.com" && url.pathname === "/openid/license_key/") return new Response(JSON.stringify({ license_key: licenseKey }));
    if (url.origin === "https://api.licensing.appsumo.com") return new Response(JSON.stringify({ license_key: licenseKey, status: "active", tier: 2 }));
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const owner = await seed.human();
    const admin = await seed.human();
    const server = await seed.server({ owner });
    const other = await seed.server({ owner });
    await addMember(server.id, admin.id, "admin");
    const bearer = await tokenForHuman(owner.email);
    const adminBearer = await tokenForHuman(admin.email);
    const probe = await fetch(`${app.baseUrl}/api/appsumo/oauth/callback`);
    assert.equal(probe.status, 200);
    assert.equal((await db.select().from(appSumoRedemptionClaims)).length, 0);
    for (const event of ["purchase", "activate"]) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ license_key: licenseKey, event, license_status: "inactive", tier: 2, created_at: Date.now(), event_timestamp: Date.now(), test: false });
      const signature = createHmac("sha256", "synthetic-provider-key").update(timestamp).update(body).digest("hex");
      const response = await fetch(`${app.baseUrl}/api/appsumo/webhook`, { method: "POST", body,
        headers: { "Content-Type": "application/json", "X-Appsumo-Timestamp": timestamp, "X-Appsumo-Signature": signature } });
      assert.equal(response.status, 200);
    }
    const callback = await fetch(`${app.baseUrl}/api/appsumo/oauth/callback?code=fixture-code-owner`, { redirect: "manual" });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "https://app.raft.test/appsumo/redeem");
    const setCookie = callback.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";")[0];
    const headers = { Authorization: `Bearer ${bearer}`, Cookie: cookie, Origin: "https://app.raft.test", "Content-Type": "application/json" };
    assert.equal((await fetch(`${app.baseUrl}/api/appsumo/redemption`, { headers: { Cookie: cookie } })).status, 401);
    const pending = await fetch(`${app.baseUrl}/api/appsumo/redemption`, { headers });
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).status, "pending");
    const config = getAppSumoConfig()!;
    await reconcileNextAppSumoLicense({ db, productId: config.productId, now: () => new Date(Date.now() + 15_000), getLicense: createAppSumoProvider(config).getLicense });
    const ready = await (await fetch(`${app.baseUrl}/api/appsumo/redemption`, { headers })).json();
    assert.equal(ready.status, "ready");
    assert.equal(ready.tier, 2);
    assert.equal(JSON.stringify(ready).includes(licenseKey), false);
    const bind = (body: object, override = headers) => fetch(`${app.baseUrl}/api/appsumo/redemption/bind`, { method: "POST", headers: override, body: JSON.stringify(body) });
    assert.equal((await bind({ serverId: server.id, claimId: ready.claimId, tier: 4 })).status, 400);
    assert.equal((await bind({ serverId: server.id, claimId: ready.claimId }, { ...headers, Origin: "https://untrusted.example" })).status, 403);
    assert.equal((await bind({ serverId: server.id, claimId: randomUUID() })).status, 409);
    __setStripeForTests({ checkout: { sessions: { list: async () => { throw new Error("unavailable"); } } } } as unknown as Stripe);
    const unavailable = await bind({ serverId: server.id, claimId: ready.claimId });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, "stripe_verification_unavailable");
    assert.equal((await db.select().from(appSumoLicenseBindings)).length, 0);
    __setStripeForTests({ checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } } } as unknown as Stripe);
    const bound = await bind({ serverId: server.id, claimId: ready.claimId });
    assert.equal(bound.status, 200);
    assert.equal((await bound.json()).serverId, server.id);
    assert.equal((await bind({ serverId: server.id, claimId: ready.claimId })).status, 200);
    assert.equal((await bind({ serverId: other.id, claimId: ready.claimId })).status, 409);
    assert.equal((await db.select().from(appSumoLicenseBindings)).length, 1);
    const replay = await fetch(`${app.baseUrl}/api/appsumo/oauth/callback?code=fixture-code-owner`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(replay.status, 303);
    assert.equal(exchanges, 1);
    assert.equal((await fetch(`${app.baseUrl}/api/appsumo/oauth/callback?code=fixture-code-owner`, { redirect: "manual" })).status, 409);
    const otherUser = await (await fetch(`${app.baseUrl}/api/appsumo/redemption`, { headers: { ...headers, Authorization: `Bearer ${adminBearer}` } })).json();
    assert.equal(otherUser.status, "expired");
  } finally { __resetStripeForTests(); globalThis.fetch = realFetch; restore(); }
});

test("real raw webhook mount verifies signatures and never grants from setup probes", async ({ app, db }) => {
  const restore = environment();
  try {
    const payload = { license_key: randomUUID(), event: "activate", license_status: "inactive", tier: 1,
      event_timestamp: Date.now(), created_at: Date.now(), test: true };
    const post = (body: string, headers: Record<string, string> = {}) => fetch(`${app.baseUrl}/api/appsumo/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
    });
    const probe = await post(JSON.stringify(payload));
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { event: "activate", success: true });
    assert.equal((await db.select().from(appSumoLicenses)).length, 0);
    assert.equal((await db.select().from(appSumoWebhookReceipts)).length, 0);
    const body = JSON.stringify({ ...payload, test: false });
    assert.equal((await post(body)).status, 401);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "synthetic-provider-key").update(timestamp).update(body).digest("hex");
    const signed = { "X-Appsumo-Timestamp": timestamp, "X-Appsumo-Signature": signature };
    assert.equal((await post(body + " ", signed)).status, 401);
    assert.equal((await post(body, signed)).status, 200);
    assert.equal((await post(body, signed)).status, 200);
    assert.equal((await db.select().from(appSumoWebhookReceipts)).length, 1);
    assert.equal((await db.select().from(appSumoLicenses))[0].status, "pending");
    assert.equal((await post("x".repeat(65_537))).status, 413);
  } finally { restore(); }
});


test("portal probes work before configuration without claims, grants or provider calls", async ({ app, db }) => {
  const restore = environment();
  for (const key of envKeys) delete process.env[key];
  const realFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== app.baseUrl) { providerCalls++; throw new Error("Unexpected external provider call"); }
    return realFetch(input, init);
  }) as typeof fetch;
  const post = (body: string) => fetch(`${app.baseUrl}/api/appsumo/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  const payload = { license_key: "00000000-aaaa-1111-bbbb-abcdef012345", license_status: "inactive",
    event_timestamp: 1318781876406, created_at: 1318738512, test: true };
  try {
    const callback = await fetch(`${app.baseUrl}/api/appsumo/oauth/callback`, { redirect: "manual" });
    assert.equal(callback.status, 200);
    assert.deepEqual(await callback.json(), { success: true });
    assert.equal(callback.headers.get("set-cookie"), null);
    assert.equal(callback.headers.get("location"), null);
    for (const event of ["activate", "deactivate", "purchase"]) {
      const response = await post(JSON.stringify({ ...payload, event }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { event, success: true });
      assert.equal(response.headers.get("set-cookie"), null);
    }
    for (const testValue of [false, undefined]) {
      const response = await post(JSON.stringify({ ...payload, event: "activate", tier: 1, test: testValue }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "appsumo_not_configured" });
    }
    for (const query of ["code=synthetic-code", "unexpected=1"]) {
      const response = await fetch(`${app.baseUrl}/api/appsumo/oauth/callback?${query}`, { redirect: "manual" });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("location"), null);
    }
    assert.equal((await post(JSON.stringify({ ...payload, event: "activate", test: "true" }))).status, 400);
    assert.equal((await post(JSON.stringify({ ...payload, event: "unknown" }))).status, 400);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post("x".repeat(65_537))).status, 413);
    assert.equal((await fetch(`${app.baseUrl}/api/appsumo/redemption`)).status, 401);
    assert.equal((await fetch(`${app.baseUrl}/api/appsumo/redemption/bind`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal(providerCalls, 0);
    for (const table of [appSumoLicenses, appSumoWebhookReceipts, appSumoRedemptionClaims, appSumoLicenseBindings]) {
      assert.equal((await db.select().from(table)).length, 0);
    }
  } finally { globalThis.fetch = realFetch; restore(); }
});
