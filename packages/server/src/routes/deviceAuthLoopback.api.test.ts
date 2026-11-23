import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { deviceAuthorizations, deviceLoginGrants, users } from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { openTestApp } from "../test/integration/app";
import { signInForTest, signInThroughSecondStepForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";
import { createServer } from "../services/serverService";
import { isDeviceLoopbackReturnUri } from "../services/deviceAuthService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
useTotpSecretKey();

// Loopback device login (design "one-click Computer login when the browser is
// on the same machine", RFC 8252 + PKCE S256): authorize with `loopback` gets
// a request id and approval link and no device or user code; the page
// describes and approves by request id (same step-up, ticket and pick); approve
// answers the client's 127.0.0.1 return URI with a one-time code; the token
// phase redeems code + verifier for the same grant as device mode. Device mode
// itself is covered by deviceAuth.api.test.ts and deviceLoginGrant.api.test.ts;
// here only that a device login is unchanged next to a loopback one.

const PEPPER = "device-code-test-pepper-0123456789abcdef";
const APP_URL = "https://app.raft.test";

type App = { baseUrl: string };

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>, mailbox: EmailDelivery[]) => Promise<T>): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  const oldAppUrl = process.env.APP_URL;
  delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  process.env.APP_URL = APP_URL;
  const mailbox: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => mailbox.push(delivery));
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app, mailbox);
  } finally {
    await app.close();
    __setEmailDeliveryObserverForTests(null);
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
    if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
}

async function seedUser(): Promise<{ id: string; bearer: string; familyId: string }> {
  const suffix = randomUUID();
  const [u] = await getDb().insert(users).values({
    email: `loopback-${suffix}@slock.test`,
    name: `loopback-${suffix}`,
    displayName: "Loopback Tester",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const web = await signInForTest(u!.id);
  return { id: u!.id, bearer: web.token, familyId: web.familyId };
}

async function post(app: App, path: string, body: unknown, token?: string) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

const ATTACH = { kind: "computer_attach", machineName: "Maria's laptop", hostname: "maria-mbp", os: "macOS" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const STATE = "st_0123456789abcdefghij";

async function startLoopback(app: App, opts: { returnUri?: string; challenge?: string; grant?: unknown } = {}) {
  const keys = pkce();
  const returnUri = opts.returnUri ?? `http://127.0.0.1:53682/callback?state=${STATE}`;
  const res = await post(app, "/api/auth/device/authorize", {
    clientName: "raft-computer",
    grant: opts.grant ?? ATTACH,
    loopback: { returnUri, codeChallenge: opts.challenge ?? keys.challenge, codeChallengeMethod: "S256" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...(res.body as { requestId: string; approvalUrl: string; expiresIn: number }), verifier: keys.verifier, returnUri, body: res.body };
}

async function describeRequest(app: App, bearer: string, requestId: string) {
  const res = await post(app, "/api/auth/device/describe", { requestId }, bearer);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function approveRequest(app: App, bearer: string, requestId: string, serverId: string) {
  const described = await describeRequest(app, bearer, requestId);
  return post(app, "/api/auth/device/approve", { requestId, approvalTicket: described.approvalTicket, serverId }, bearer);
}

function callbackParams(redirectUrl: string) {
  const url = new URL(redirectUrl);
  return { origin: url.origin, pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
}

async function redeem(app: App, body: Record<string, unknown>) {
  return post(app, "/api/auth/device/token", body);
}

async function mailCount(mailbox: EmailDelivery[], count: number) {
  for (let i = 0; i < 100 && mailbox.length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailbox.length, count);
}

async function authRow(requestId: string) {
  const [row] = await getDb().select().from(deviceAuthorizations).where(eq(deviceAuthorizations.requestId, requestId));
  return row!;
}

test("loopback end to end: authorize → describe and approve by request id → redirect with code + state → token with code + verifier → the device-mode attach grant, mailed on attach", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);

    const login = await startLoopback(app);
    // No device code, no user code, no poll interval: nothing to poll or type.
    assert.deepEqual(Object.keys(login.body).sort(), ["approvalUrl", "expiresIn", "requestId"]);
    assert.match(login.requestId, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    assert.equal(login.approvalUrl, `${APP_URL}/login/device?request=${login.requestId}`);
    assert.equal(login.expiresIn, 600);
    const stored = await authRow(login.requestId);
    assert.equal(stored.mode, "loopback");
    assert.equal(stored.userCode, null);
    assert.equal(stored.deviceCodeHash, null);
    assert.equal(stored.deviceCodeLookupHash, null);
    assert.equal(stored.returnUri, login.returnUri);

    const described = await describeRequest(app, bearer, login.requestId);
    assert.equal(described.mode, "loopback");
    assert.equal(described.requestId, login.requestId);
    assert.equal("userCode" in described, false);
    assert.equal(described.clientName, "raft-computer");
    assert.equal(described.grant.kind, "computer_attach");
    assert.equal(described.grant.machineName, "Maria's laptop");
    assert.deepEqual((described.grant.servers as Array<{ id: string }>).map((s) => s.id), [owned.id]);
    assert.equal(typeof described.approvalTicket, "string");

    // The same approve rules as device mode: a ticket and an explicit pick.
    const noTicket = await post(app, "/api/auth/device/approve", { requestId: login.requestId, serverId: owned.id }, bearer);
    assert.deepEqual([noTicket.status, noTicket.body.code], [400, "approval_ticket_required"]);
    const noPick = await post(app, "/api/auth/device/approve", { requestId: login.requestId, approvalTicket: described.approvalTicket }, bearer);
    assert.deepEqual([noPick.status, noPick.body.code], [400, "grant_selection_required"]);

    const approved = await approveRequest(app, bearer, login.requestId, owned.id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.action, "approved");
    const callback = callbackParams(approved.body.redirectUrl);
    assert.equal(callback.origin, "http://127.0.0.1:53682");
    assert.equal(callback.pathname, "/callback");
    assert.deepEqual(Object.keys(callback.params).sort(), ["code", "state"]);
    assert.equal(callback.params.state, STATE, "state echoed untouched");
    const { code } = callback.params as { code: string };
    // Only the hash is stored; it lives 2 minutes.
    const approvedRow = await authRow(login.requestId);
    assert.equal(approvedRow.callbackCodeHash, createHash("sha256").update(code).digest("hex"));
    const ttl = approvedRow.callbackCodeExpiresAt!.getTime() - approvedRow.approvedAt!.getTime();
    assert.ok(ttl > 119_000 && ttl <= 120_000, String(ttl));

    const token = await redeem(app, { requestId: login.requestId, code, codeVerifier: login.verifier });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.deepEqual(Object.keys(token.body).sort(), ["attachToken", "expiresIn", "kind", "serverId", "serverName", "serverSlug"]);
    assert.equal(token.body.kind, "computer_attach");
    assert.match(token.body.attachToken, /^dvat_/);
    assert.equal(token.body.serverId, owned.id);
    assert.equal(token.body.serverSlug, owned.slug);
    assert.equal((await authRow(login.requestId)).status, "consumed");

    // The attach and its notice are the device code's: "You added …" with a revoke link.
    const attached = await post(app, "/api/computer/attach", {}, token.body.attachToken);
    assert.equal(attached.status, 201, JSON.stringify(attached.body));
    await mailCount(mailbox, 1);
    assert.equal(mailbox[0]!.subject, "You added a machine to Alpha Co — Raft");
    assert.match(mailbox[0]!.html, /\?revoke_device_login=dvcr_/);
  });
});

test("loopback return URI: app login's strict loopback rule, plus at most a state in the query", async () => {
  const accepted = [
    "http://127.0.0.1:53682/callback",
    "http://[::1]:53682/callback",
    "http://127.0.0.1:1/callback",
    "http://127.0.0.1:65535/callback",
    `http://127.0.0.1:53682/callback?state=${STATE}`,
    `http://[::1]:53682/callback?state=${"a".repeat(128)}`,
  ];
  const rejected = [
    "https://127.0.0.1:53682/callback",
    "http://localhost:53682/callback",
    "http://evil.test:53682/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:80/callback",
    "http://127.0.0.1:65536/callback",
    "http://127.0.0.1:053682/callback",
    "http://127.0.0.1:53682/",
    "http://127.0.0.1:53682/callback/",
    "http://127.0.0.1:53682/other",
    "http://127.1:53682/callback",
    "http://evil.test@127.0.0.1:53682/callback",
    "http://127.0.0.1:53682/callback#frag",
    "http://127.0.0.1:53682/callback?",
    "http://127.0.0.1:53682/callback?state=short",
    `http://127.0.0.1:53682/callback?state=${"a".repeat(129)}`,
    `http://127.0.0.1:53682/callback?state=${STATE}&code=planted`,
    `http://127.0.0.1:53682/callback?code=planted`,
    `http://127.0.0.1:53682/callback?state=${STATE}#frag`,
    `http://127.0.0.1:53682/callback?state=abc%20def0123456789`,
    "raft://login/callback",
  ];
  for (const uri of accepted) assert.equal(isDeviceLoopbackReturnUri(uri), true, uri);
  for (const uri of rejected) assert.equal(isDeviceLoopbackReturnUri(uri), false, uri);

  await withApp(async (app) => {
    const { challenge } = pkce();
    for (const returnUri of rejected) {
      const res = await post(app, "/api/auth/device/authorize", { grant: ATTACH, loopback: { returnUri, codeChallenge: challenge, codeChallengeMethod: "S256" } });
      assert.deepEqual([res.status, res.body.code], [400, "return_uri_not_allowed"], returnUri);
    }
    for (const loopback of ["http://127.0.0.1:53682/callback", [], { codeChallenge: challenge, codeChallengeMethod: "S256" }, { returnUri: 5, codeChallenge: challenge, codeChallengeMethod: "S256" }]) {
      const res = await post(app, "/api/auth/device/authorize", { grant: ATTACH, loopback });
      assert.equal(res.status, 400, JSON.stringify(loopback));
    }
    // S256 only, and a well-formed challenge.
    for (const codeChallengeMethod of ["plain", "s256", undefined]) {
      const res = await post(app, "/api/auth/device/authorize", { grant: ATTACH, loopback: { returnUri: "http://127.0.0.1:53682/callback", codeChallenge: challenge, codeChallengeMethod } });
      assert.deepEqual([res.status, res.body.code], [400, "code_challenge_method_unsupported"], String(codeChallengeMethod));
    }
    for (const codeChallenge of ["short", "x".repeat(129), `${challenge.slice(0, 42)}=`, 5]) {
      const res = await post(app, "/api/auth/device/authorize", { grant: ATTACH, loopback: { returnUri: "http://127.0.0.1:53682/callback", codeChallenge, codeChallengeMethod: "S256" } });
      assert.deepEqual([res.status, res.body.code], [400, "code_challenge_invalid"], String(codeChallenge));
    }
    // Loopback completes a one-time grant, never a device session.
    const noGrant = await post(app, "/api/auth/device/authorize", { loopback: { returnUri: "http://127.0.0.1:53682/callback", codeChallenge: challenge, codeChallengeMethod: "S256" } });
    assert.deepEqual([noGrant.status, noGrant.body.code], [400, "loopback_grant_required"]);
    assert.equal((await getDb().select({ id: deviceAuthorizations.id }).from(deviceAuthorizations)).length, 0);
  });
});

test("loopback token: wrong verifier refused without burning the code; reuse, expiry, wrong code and device-code polling all refused", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);

    const login = await startLoopback(app);
    // Before approval there is no code to redeem.
    const early = await redeem(app, { requestId: login.requestId, code: "anything", codeVerifier: login.verifier });
    assert.deepEqual([early.status, early.body.code], [400, "code_invalid"]);
    const approved = await approveRequest(app, bearer, login.requestId, owned.id);
    const { code } = callbackParams(approved.body.redirectUrl).params as { code: string };

    const wrongVerifier = await redeem(app, { requestId: login.requestId, code, codeVerifier: pkce().verifier });
    assert.deepEqual([wrongVerifier.status, wrongVerifier.body.code], [400, "pkce_mismatch"]);
    const noVerifier = await redeem(app, { requestId: login.requestId, code });
    assert.deepEqual([noVerifier.status, noVerifier.body.code], [400, "pkce_mismatch"]);
    const wrongCode = await redeem(app, { requestId: login.requestId, code: randomBytes(32).toString("base64url"), codeVerifier: login.verifier });
    assert.deepEqual([wrongCode.status, wrongCode.body.code], [400, "code_invalid"]);
    const otherRequest = await redeem(app, { requestId: randomBytes(32).toString("base64url"), code, codeVerifier: login.verifier });
    assert.deepEqual([otherRequest.status, otherRequest.body.code], [400, "code_invalid"]);
    // A loopback request has no device code: polling anything gets nothing.
    for (const deviceCode of [code, login.requestId, `dvc_${randomBytes(32).toString("base64url")}`]) {
      const polled = await redeem(app, { deviceCode });
      assert.deepEqual([polled.status, polled.body.code], [400, "device_code_invalid"], deviceCode);
    }
    assert.equal((await authRow(login.requestId)).status, "approved", "nothing above burned it");

    const ok = await redeem(app, { requestId: login.requestId, code, codeVerifier: login.verifier });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const reused = await redeem(app, { requestId: login.requestId, code, codeVerifier: login.verifier });
    assert.deepEqual([reused.status, reused.body.code], [410, "device_code_consumed"]);

    // A code past its 2 minutes.
    const late = await startLoopback(app);
    const lateApproved = await approveRequest(app, bearer, late.requestId, owned.id);
    const lateCode = callbackParams(lateApproved.body.redirectUrl).params.code!;
    await getDb().update(deviceAuthorizations).set({ callbackCodeExpiresAt: new Date(Date.now() - 1000) }).where(eq(deviceAuthorizations.requestId, late.requestId));
    const expired = await redeem(app, { requestId: late.requestId, code: lateCode, codeVerifier: late.verifier });
    assert.deepEqual([expired.status, expired.body.code], [410, "expired_token"]);
    assert.equal((await authRow(late.requestId)).status, "approved");

    // Two at once: exactly one gets the grant.
    const race = await startLoopback(app);
    const raceCode = callbackParams((await approveRequest(app, bearer, race.requestId, owned.id)).body.redirectUrl).params.code!;
    const both = await Promise.all([0, 1].map(() => redeem(app, { requestId: race.requestId, code: raceCode, codeVerifier: race.verifier })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 410]);
  });
});

test("loopback deny: redirect with error=access_denied and the state, and nothing to redeem", async () => {
  await withApp(async (app) => {
    const { bearer } = await seedUser();
    const login = await startLoopback(app);
    // Denying needs no ticket, as in device mode.
    const denied = await post(app, "/api/auth/device/approve", { requestId: login.requestId, approve: false }, bearer);
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.action, "denied");
    const callback = callbackParams(denied.body.redirectUrl);
    assert.equal(callback.origin, "http://127.0.0.1:53682");
    assert.deepEqual(callback.params, { state: STATE, error: "access_denied" });
    assert.equal((await authRow(login.requestId)).status, "denied");
    const [grant] = await getDb().select({ status: deviceLoginGrants.status }).from(deviceLoginGrants)
      .where(eq(deviceLoginGrants.deviceAuthorizationId, (await authRow(login.requestId)).id));
    assert.equal(grant?.status, "denied");
    const again = await post(app, "/api/auth/device/describe", { requestId: login.requestId }, bearer);
    assert.deepEqual([again.status, again.body.code], [409, "already_resolved"]);
  });
});

test("describe / approve by request id: exactly one of userCode and requestId; misses are uniform; a user code never finds a loopback request, nor a request id a device one", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const login = await startLoopback(app);
    const device = await post(app, "/api/auth/device/authorize", { clientName: "raft-computer", grant: ATTACH });
    assert.equal(device.status, 201);

    const both = await post(app, "/api/auth/device/describe", { requestId: login.requestId, userCode: device.body.userCode }, bearer);
    assert.deepEqual([both.status, both.body.code], [400, "user_code_or_request_id"]);
    const bothApprove = await post(app, "/api/auth/device/approve", { requestId: login.requestId, userCode: device.body.userCode }, bearer);
    assert.deepEqual([bothApprove.status, bothApprove.body.code], [400, "user_code_or_request_id"]);
    for (const requestId of ["", 5]) {
      const res = await post(app, "/api/auth/device/describe", { requestId }, bearer);
      assert.deepEqual([res.status, res.body.code], [400, "request_id_required"], String(requestId));
    }
    for (const requestId of ["short", randomBytes(32).toString("base64url"), `${login.requestId}x`, login.requestId.toLowerCase() === login.requestId ? login.requestId.toUpperCase() : login.requestId.toLowerCase()]) {
      const res = await post(app, "/api/auth/device/describe", { requestId }, bearer);
      assert.deepEqual([res.status, res.body.code], [404, "request_invalid"], requestId);
      const approved = await post(app, "/api/auth/device/approve", { requestId, approvalTicket: "x", serverId: owned.id }, bearer);
      assert.deepEqual([approved.status, approved.body.code], [404, "request_invalid"], requestId);
    }
    // Unauthenticated: refused before anything is read.
    const anonymous = await post(app, "/api/auth/device/describe", { requestId: login.requestId });
    assert.equal(anonymous.status, 401);

    // A ticket from the device request does not approve the loopback one.
    const deviceTicket = (await post(app, "/api/auth/device/describe", { userCode: device.body.userCode }, bearer)).body.approvalTicket;
    const crossTicket = await post(app, "/api/auth/device/approve", { requestId: login.requestId, approvalTicket: deviceTicket, serverId: owned.id }, bearer);
    assert.deepEqual([crossTicket.status, crossTicket.body.code], [400, "approval_ticket_required"]);

    // Expired.
    await getDb().update(deviceAuthorizations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(deviceAuthorizations.requestId, login.requestId));
    const expired = await post(app, "/api/auth/device/describe", { requestId: login.requestId }, bearer);
    assert.deepEqual([expired.status, expired.body.code], [410, "expired"]);
  });
});

test("loopback approve needs the same two-step verification step-up as device mode", async () => {
  await withApp(async (app) => {
    // Signed in before two-step verification was turned on: this sign-in never passed it.
    const { id: userId, bearer } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    await enrollSecondFactor(userId);
    const login = await startLoopback(app);
    const refused = await approveRequest(app, bearer, login.requestId, owned.id);
    assert.deepEqual([refused.status, refused.body.code], [403, "second_factor_step_up_required"]);
    assert.equal("redirectUrl" in refused.body, false);
    assert.equal((await authRow(login.requestId)).status, "pending");
    const verified = await signInThroughSecondStepForTest(userId);
    const approved = await approveRequest(app, verified.token, login.requestId, owned.id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.ok(approved.body.redirectUrl);
  });
});

test("describe by request id goes through the same per-IP auth rate limit as by user code", async () => {
  await withApp(async (app) => {
    const { bearer } = await seedUser();
    const login = await startLoopback(app);
    let limited: { status: number; body: Record<string, any> } | null = null;
    // 200 a minute per IP for the whole /api/auth/device surface (app.ts authLimiter).
    for (let batch = 0; batch < 12 && !limited; batch += 1) {
      const results = await Promise.all(Array.from({ length: 20 }, () => post(app, "/api/auth/device/describe", { requestId: randomBytes(32).toString("base64url") }, bearer)));
      limited = results.find((r) => r.status === 429) ?? null;
    }
    assert.ok(limited, "rate limited");
    const blocked = await post(app, "/api/auth/device/describe", { requestId: login.requestId }, bearer);
    assert.equal(blocked.status, 429);
    const blockedByCode = await post(app, "/api/auth/device/describe", { userCode: "ABCD-EFGH" }, bearer);
    assert.equal(blockedByCode.status, 429);
  });
});

test("device mode is unchanged next to loopback: same authorize shape, describe and approve by user code, no redirectUrl, polled grant", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    await startLoopback(app);
    const device = await post(app, "/api/auth/device/authorize", { clientName: "raft-computer", grant: ATTACH });
    assert.equal(device.status, 201);
    assert.deepEqual(Object.keys(device.body).sort(), ["deviceCode", "expiresIn", "interval", "userCode", "verificationUri"]);
    assert.equal(device.body.verificationUri, `${APP_URL}/login/device`);
    const [row] = await getDb().select().from(deviceAuthorizations).where(eq(deviceAuthorizations.userCode, device.body.userCode));
    assert.equal(row?.mode, "device");
    assert.equal(row?.requestId, null);

    const described = await post(app, "/api/auth/device/describe", { userCode: device.body.userCode }, bearer);
    assert.equal(described.status, 200);
    assert.deepEqual(Object.keys(described.body).sort(), ["approvalTicket", "clientName", "grant", "requestedAt", "requester", "userCode"]);
    const approved = await post(app, "/api/auth/device/approve", { userCode: device.body.userCode, approvalTicket: described.body.approvalTicket, serverId: owned.id }, bearer);
    assert.deepEqual(approved.body, { ok: true, action: "approved" });
    // A device request has no loopback redeem.
    const byRequest = await redeem(app, { requestId: row!.id, code: "x", codeVerifier: "y" });
    assert.deepEqual([byRequest.status, byRequest.body.code], [400, "code_invalid"]);
    const token = await redeem(app, { deviceCode: device.body.deviceCode });
    assert.equal(token.status, 200);
    assert.equal(token.body.kind, "computer_attach");
    const missing = await redeem(app, {});
    assert.deepEqual([missing.status, missing.body.code], [400, "device_code_required"]);
  });
});
