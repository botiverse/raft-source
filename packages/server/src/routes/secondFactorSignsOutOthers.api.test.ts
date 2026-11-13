import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { integrationAuditEvents, sessionFamilies } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, totpCode, useTotpSecretKey } from "../test/integration/secondFactor";
import { SoftwareAuthenticator } from "../test/integration/softwareAuthenticator";

// Which account security changes sign out the person's other sign-ins
// (secondFactor/management.ts, "Other sign-ins"; userService.changePassword):
// a change that invalidates a credential someone else might hold does, and
// keeps the sign-in that made it; adding or confirming something new does not.
// A signed-out sign-in's next refresh is a 401 `session_revoked` (every client
// signs in again on a 401 from /auth/refresh); the sign-in that made the change
// keeps refreshing, except after a password change, which signs out every one.
// Device sign-ins (Computers, the raft CLI) stay for the second-factor changes.

const test = createApiTest();
useTotpSecretKey();

const RP_ID = "raft.test";
const ORIGIN = "https://app.raft.test";
const ENV = { APP_URL: ORIGIN, WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_ORIGINS: ORIGIN } as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
beforeAll(() => { Object.assign(process.env, ENV); });
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const json = { "Content-Type": "application/json" };

async function refresh(baseUrl: string, refreshToken: string): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${baseUrl}/api/auth/refresh`, { method: "POST", headers: json, body: JSON.stringify({ refreshToken }) });
  const body = await res.json() as { code?: string };
  return { status: res.status, code: body.code };
}

function secondFactor(baseUrl: string, token: string, path: string, body: unknown, method: "POST" | "DELETE" = "POST") {
  return fetch(`${baseUrl}/api/auth/second-factor${path}`, {
    method, headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
}

function me(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Registers a passkey through the API from the sign-in holding `token` (two-step verification off). */
async function registerPasskey(baseUrl: string, token: string): Promise<string> {
  const device = new SoftwareAuthenticator(RP_ID, ORIGIN);
  const options = await secondFactor(baseUrl, token, "/passkeys/registration/options", {});
  assert.equal(options.status, 200);
  const verified = await secondFactor(baseUrl, token, "/passkeys/registration/verify", {
    response: device.register((await options.json() as { options: { challenge: string } }).options),
  });
  assert.equal(verified.status, 200);
  return (await verified.json() as { passkey: { id: string } }).passkey.id;
}

/** The other sign-in is out (refresh session_revoked, access token refused); this one and the device keep working. */
async function assertOthersSignedOut(baseUrl: string, userId: string, signIns: Awaited<ReturnType<typeof threeSignIns>>) {
  const { current, other, device } = signIns;
  assert.deepEqual(await refresh(baseUrl, other.refreshToken), { status: 401, code: "session_revoked" });
  assert.equal((await me(baseUrl, other.token)).status, 401);
  assert.equal((await me(baseUrl, current.token)).status, 200);
  assert.equal((await refresh(baseUrl, current.refreshToken)).status, 200);
  assert.equal((await me(baseUrl, signAccessToken(userId, device.familyId))).status, 200);
  assert.equal((await refresh(baseUrl, device.refreshToken)).status, 200);
  const reasons = await revokedReasons(userId);
  assert.equal(reasons.get(other.familyId), "second_factor_changed");
  assert.equal(reasons.get(current.familyId), null);
  assert.equal(reasons.get(device.familyId), null);
}

/** This sign-in, another web sign-in and a device sign-in of the same person. */
async function threeSignIns(userId: string) {
  const current = await signInForTest(userId);
  const other = await signInForTest(userId);
  const device = await createSession(await proofForDeviceLogin(userId, current.familyId), undefined, { scope: "device" });
  return { current, other, device };
}

async function revokedReasons(userId: string): Promise<Map<string, string | null>> {
  const families = await getDb().select({ id: sessionFamilies.id, reason: sessionFamilies.revokedReason }).from(sessionFamilies)
    .where(eq(sessionFamilies.userId, userId));
  return new Map(families.map((family) => [family.id, family.reason]));
}

async function auditMetadata(userId: string, eventType: string) {
  const [event] = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, userId), eq(integrationAuditEvents.eventType, eventType)));
  return event?.metadata;
}

test("turning two-step verification on: the other sign-in's refresh is session_revoked, this one and the device keep refreshing", async ({ app, seed }) => {
  const human = await seed.human();
  const { current, other, device } = await threeSignIns(human.id);
  const setup = await secondFactor(app.baseUrl, current.token, "/totp/setup", {});
  assert.equal(setup.status, 200);
  const { secret } = await setup.json() as { secret: string };

  assert.equal((await secondFactor(app.baseUrl, current.token, "/enable", { code: totpCode(secret) })).status, 200);

  assert.deepEqual(await refresh(app.baseUrl, other.refreshToken), { status: 401, code: "session_revoked" });
  assert.equal((await refresh(app.baseUrl, current.refreshToken)).status, 200);
  assert.equal((await refresh(app.baseUrl, device.refreshToken)).status, 200);
  const reasons = await revokedReasons(human.id);
  assert.equal(reasons.get(other.familyId), "second_factor_enabled");
  assert.equal(reasons.get(current.familyId), null);
  assert.equal(reasons.get(device.familyId), null);
});

test("new backup codes: the other sign-in is signed out (session_revoked), this one and the device stay", async ({ app, seed }) => {
  const human = await seed.human();
  const { current, other, device } = await threeSignIns(human.id);
  const { secret } = await enrollSecondFactor(human.id);

  const regenerated = await secondFactor(app.baseUrl, current.token, "/backup-codes/regenerate", { code: totpCode(secret) });
  assert.equal(regenerated.status, 200);

  assert.deepEqual(await refresh(app.baseUrl, other.refreshToken), { status: 401, code: "session_revoked" });
  // Its access token stops at once, not only at its refresh.
  assert.equal((await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${other.token}` } })).status, 401);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${current.token}` } })).status, 200);
  assert.equal((await refresh(app.baseUrl, current.refreshToken)).status, 200);
  assert.equal((await refresh(app.baseUrl, device.refreshToken)).status, 200);
  const reasons = await revokedReasons(human.id);
  assert.equal(reasons.get(other.familyId), "second_factor_changed");
  assert.equal(reasons.get(current.familyId), null);
  assert.equal(reasons.get(device.familyId), null);
  assert.deepEqual(await auditMetadata(human.id, "account.second_factor_backup_codes_regenerated"), {
    sessionFamilyId: current.familyId, method: "totp", signedOutSessionCount: 1,
  });
});

test("a re-bound authenticator app while on: the other sign-in is signed out (session_revoked), this one stays", async ({ app, seed }) => {
  const human = await seed.human();
  const { current, other, device } = await threeSignIns(human.id);
  const { secret } = await enrollSecondFactor(human.id);

  const setup = await secondFactor(app.baseUrl, current.token, "/totp/setup", { code: totpCode(secret) });
  assert.equal(setup.status, 200);
  const { secret: next } = await setup.json() as { secret: string };
  // Asking for a new secret alone signs nobody out: the old one still works until confirmed.
  assert.equal((await revokedReasons(human.id)).get(other.familyId), null);

  const confirmed = await secondFactor(app.baseUrl, current.token, "/totp/confirm", { code: totpCode(next) });
  assert.equal(confirmed.status, 200);

  assert.deepEqual(await refresh(app.baseUrl, other.refreshToken), { status: 401, code: "session_revoked" });
  assert.equal((await refresh(app.baseUrl, current.refreshToken)).status, 200);
  assert.equal((await refresh(app.baseUrl, device.refreshToken)).status, 200);
  const reasons = await revokedReasons(human.id);
  assert.equal(reasons.get(other.familyId), "second_factor_changed");
  assert.equal(reasons.get(current.familyId), null);
  assert.equal(reasons.get(device.familyId), null);
  assert.deepEqual(await auditMetadata(human.id, "account.second_factor_totp_confirmed"), {
    sessionFamilyId: current.familyId, rebind: true, signedOutSessionCount: 1,
  });
});

test("confirming a first authenticator app (two-step verification still off) signs nobody out", async ({ app, seed }) => {
  const human = await seed.human();
  const { current, other } = await threeSignIns(human.id);
  const setup = await secondFactor(app.baseUrl, current.token, "/totp/setup", {});
  const { secret } = await setup.json() as { secret: string };
  assert.equal((await secondFactor(app.baseUrl, current.token, "/totp/confirm", { code: totpCode(secret) })).status, 200);
  assert.equal((await refresh(app.baseUrl, other.refreshToken)).status, 200);
  assert.equal((await revokedReasons(human.id)).get(other.familyId), null);
});

test("turning two-step verification off: the other sign-in is signed out (session_revoked), this one and the device stay", async ({ app, seed }) => {
  const human = await seed.human();
  const signIns = await threeSignIns(human.id);
  const { secret } = await enrollSecondFactor(human.id);

  assert.equal((await secondFactor(app.baseUrl, signIns.current.token, "/disable", { code: totpCode(secret) })).status, 200);

  await assertOthersSignedOut(app.baseUrl, human.id, signIns);
  assert.deepEqual(await auditMetadata(human.id, "account.second_factor_disabled"), {
    sessionFamilyId: signIns.current.familyId, method: "totp", signedOutSessionCount: 1,
  });
});

test("adding a passkey signs nobody out; removing it (two-step verification off) signs out the other sign-in", async ({ app, seed }) => {
  const human = await seed.human();
  const signIns = await threeSignIns(human.id);
  const passkeyId = await registerPasskey(app.baseUrl, signIns.current.token);
  assert.equal((await revokedReasons(human.id)).get(signIns.other.familyId), null, "adding signs nobody out");

  const removed = await secondFactor(app.baseUrl, signIns.current.token, `/passkeys/${passkeyId}`, {}, "DELETE");
  assert.equal(removed.status, 200);

  await assertOthersSignedOut(app.baseUrl, human.id, signIns);
  assert.deepEqual(await auditMetadata(human.id, "account.second_factor_passkey_removed"), {
    sessionFamilyId: signIns.current.familyId, passkeyId, method: null, signedOutSessionCount: 1,
  });
});

test("removing a passkey with two-step verification on (step-up inline) signs out the other sign-in", async ({ app, seed }) => {
  const human = await seed.human();
  const signIns = await threeSignIns(human.id);
  const passkeyId = await registerPasskey(app.baseUrl, signIns.current.token);
  const { secret } = await enrollSecondFactor(human.id);

  const removed = await secondFactor(app.baseUrl, signIns.current.token, `/passkeys/${passkeyId}`, { code: totpCode(secret) }, "DELETE");
  assert.equal(removed.status, 200);

  await assertOthersSignedOut(app.baseUrl, human.id, signIns);
});

test("a password change signs out every sign-in, the one that made it too: each refresh is session_revoked", async ({ app, seed }) => {
  const human = await seed.human();
  const { current, other, device } = await threeSignIns(human.id);

  const changed = await fetch(`${app.baseUrl}/api/auth/me`, {
    method: "PATCH", headers: { ...json, Authorization: `Bearer ${current.token}` },
    body: JSON.stringify({ currentPassword: "password123", newPassword: "a-new-password-123" }),
  });
  assert.equal(changed.status, 200);

  for (const signIn of [other, current, device]) {
    assert.deepEqual(await refresh(app.baseUrl, signIn.refreshToken), { status: 401, code: "session_revoked" });
  }
  const reasons = await revokedReasons(human.id);
  assert.equal(reasons.get(current.familyId), "password_changed");
  assert.equal(reasons.get(other.familyId), "revoke_all");
});

test("signing out: the refresh token is session_revoked; a token never issued stays a plain 401", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await signInForTest(human.id);
  const logout = await fetch(`${app.baseUrl}/api/auth/logout`, { method: "POST", headers: json, body: JSON.stringify({ refreshToken: session.refreshToken }) });
  assert.ok(logout.ok, `logout ${logout.status}`);
  assert.deepEqual(await refresh(app.baseUrl, session.refreshToken), { status: 401, code: "session_revoked" });
  assert.deepEqual(await refresh(app.baseUrl, "0".repeat(64)), { status: 401, code: undefined });
  assert.equal((await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${signAccessToken(human.id, session.familyId)}` } })).status, 401);
});
