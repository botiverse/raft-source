import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  integrationAuditEvents,
  reauthAttemptWindows,
  secondFactorAttemptWindows,
  sessionFamilies,
  userBackupCodes,
  users,
  userTotp,
} from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { leaveRetiredSecondFactorFlagRowOff } from "../test/integration/secondFactor";
import { base32Decode, hotp, totpStepAt } from "../services/secondFactor/totp";
import { TOTP_SECRET_KEY_ENV } from "../services/secondFactor/totpSecretCrypto";
import { createSession } from "../services/sessionService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { signInForTest } from "../test/integration/credentials";

// PR 2 of passkeys + two-step verification (design v8): the management API
// (its auth_second_factor_v1 flag is retired, #raft-architecture:#32). The
// last tests pin that a person who never turned it on sees no change.

const test = createApiTest();

const previousKey = process.env[TOTP_SECRET_KEY_ENV];
const previousPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
beforeAll(() => {
  process.env[TOTP_SECRET_KEY_ENV] = randomBytes(32).toString("base64");
  // The device-login token poll hashes with this pepper (as deviceAuth.api.test.ts).
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "second-factor-test-pepper-0123456789abcdef";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env[TOTP_SECRET_KEY_ENV];
  else process.env[TOTP_SECRET_KEY_ENV] = previousKey;
  if (previousPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = previousPepper;
});

type Human = { id: string; email: string };


const webSession = signInForTest;

function call(baseUrl: string, token: string | null, method: "GET" | "POST", path: string, body?: unknown) {
  return fetch(`${baseUrl}/api/auth/second-factor${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}

/** The code for `offset` steps from now (the server accepts -1..+1). */
function totpCode(secret: string, offset: number): string {
  return hotp(base32Decode(secret)!, totpStepAt(new Date()) + offset);
}

/** A six-digit code that matches none of the steps the server would accept. */
function wrongCode(secret: string): string {
  const valid = new Set([-1, 0, 1, 2].map((offset) => totpCode(secret, offset)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}

/** Set up and confirm an authenticator app; uses the code one step back. */
async function setUpAndConfirm(baseUrl: string, token: string): Promise<string> {
  const setup = await call(baseUrl, token, "POST", "/totp/setup");
  assert.equal(setup.status, 200);
  const { secret } = await setup.json() as { secret: string };
  const confirm = await call(baseUrl, token, "POST", "/totp/confirm", { code: totpCode(secret, -1) });
  assert.equal(confirm.status, 200);
  assert.deepEqual(await confirm.json(), { confirmed: true, enabled: false });
  return secret;
}

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

const ROUTES: Array<["GET" | "POST", string]> = [
  ["GET", "/status"],
  ["POST", "/totp/setup"],
  ["POST", "/totp/confirm"],
  ["POST", "/enable"],
  ["POST", "/disable"],
  ["POST", "/backup-codes/regenerate"],
  ["POST", "/reauth/password"],
];

test("a leftover auth_second_factor_v1 row switched off hides nothing: the routes answer for every person", async ({ app, seed }) => {
  await leaveRetiredSecondFactorFlagRowOff();
  const human = await seed.human();
  const { token } = await webSession(human.id);
  const status = await call(app.baseUrl, token, "GET", "/status");
  assert.equal(status.status, 200);
  const setup = await call(app.baseUrl, token, "POST", "/totp/setup", {});
  assert.notEqual(setup.status, 404);
});

test("a device login's session and a token with no session family are refused", async ({ app, seed }) => {
  const human = await seed.human();
  const approver = await webSession(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, approver.familyId), undefined, { scope: "device" });
  const deviceToken = signAccessToken(human.id, device.familyId);
  for (const [method, path] of ROUTES) {
    const res = await call(app.baseUrl, deviceToken, method, path, {});
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json() as { code: string }).code, "device_session_not_allowed");
  }
  // A token with no family is refused before any route (design v8 §5).
  const familyless = jwt.sign({ sub: human.id, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
  const refused = await call(app.baseUrl, familyless, "GET", "/status");
  assert.equal(refused.status, 401);
  assert.equal((await refused.json() as { code: string }).code, "auth_required");
  const anonymous = await call(app.baseUrl, null, "GET", "/status");
  assert.equal(anonymous.status, 401);
});

test("TOTP setup with two-step verification off needs a recent sign-in; the password re-authenticates", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  await getDb().update(sessionFamilies).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sessionFamilies.id, session.familyId));
  const reauthenticatedAt = async () => (await getDb().select({ at: sessionFamilies.reauthenticatedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, session.familyId)))[0]?.at;

  const stale = await call(app.baseUrl, session.token, "POST", "/totp/setup");
  assert.equal(stale.status, 403);
  assert.equal((await stale.json() as { code: string }).code, "reauth_required");
  assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id))).length, 0);

  const wrong = await call(app.baseUrl, session.token, "POST", "/reauth/password", { password: "not-the-password" });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json() as { code: string }).code, "password_incorrect");
  assert.equal(await reauthenticatedAt(), null);
  assert.equal((await call(app.baseUrl, session.token, "POST", "/totp/setup")).status, 403);

  const right = await call(app.baseUrl, session.token, "POST", "/reauth/password", { password: "password123" });
  assert.equal(right.status, 204);
  assert.ok(await reauthenticatedAt());
  // The wrong password stays counted; the right one gave its claim back.
  assert.equal((await getDb().select().from(reauthAttemptWindows).where(eq(reauthAttemptWindows.userId, human.id)))[0]?.attempts, 1);
  assert.deepEqual(await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id)), []);
  const fresh = await call(app.baseUrl, session.token, "POST", "/totp/setup");
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("cache-control"), "no-store");
  const body = await fresh.json() as { secret: string; otpauthUri: string };
  assert.match(body.secret, /^[A-Z2-7]{32}$/);
  assert.ok(body.otpauthUri.startsWith("otpauth://totp/Raft:"));
  assert.ok(body.otpauthUri.includes(`secret=${body.secret}`));
  const [row] = await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id));
  assert.equal(row?.confirmedAt, null);
  assert.ok(row && !row.secretCiphertext.includes(body.secret), "only the sealed secret is stored");

  const status = await call(app.baseUrl, session.token, "GET", "/status");
  assert.deepEqual(await status.json(), { enabled: false, methods: { totp: false, passkeys: 0, backupCodesRemaining: 0 }, sessionVerified: false, recovery: null });
});

test("turning it on: 10 backup codes once, this sign-in marked, other web sign-ins out, device sign-ins kept", async ({ app, seed }) => {
  const human = await seed.human() as Human;
  const emails = captureEmails();
  try {
    const current = await webSession(human.id);
    const otherWeb = await webSession(human.id);
    const device = await createSession(await proofForDeviceLogin(human.id, current.familyId), undefined, { scope: "device" });

    const secret = await setUpAndConfirm(app.baseUrl, current.token);
    // Confirming alone does not turn it on.
    assert.equal((await getDb().select({ at: users.secondFactorRequiredAt }).from(users).where(eq(users.id, human.id)))[0]?.at, null);
    const confirmedStatus = await call(app.baseUrl, current.token, "GET", "/status");
    assert.deepEqual(await confirmedStatus.json(), { enabled: false, methods: { totp: true, passkeys: 0, backupCodesRemaining: 0 }, sessionVerified: false, recovery: null });

    const enabled = await call(app.baseUrl, current.token, "POST", "/enable", { code: totpCode(secret, 0) });
    assert.equal(enabled.status, 200);
    const { backupCodes } = await enabled.json() as { backupCodes: string[] };
    assert.equal(backupCodes.length, 10);
    for (const code of backupCodes) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);

    const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
    const byId = new Map(families.map((family) => [family.id, family]));
    assert.equal(byId.get(current.familyId)?.secondFactorMethod, "totp");
    assert.ok(byId.get(current.familyId)?.secondFactorVerifiedAt);
    assert.equal(byId.get(current.familyId)?.revokedAt, null);
    assert.equal(byId.get(otherWeb.familyId)?.revokedReason, "second_factor_enabled");
    assert.equal(byId.get(device.familyId)?.revokedAt, null);
    assert.equal(byId.get(device.familyId)?.secondFactorVerifiedAt, null);

    const me = (token: string) => fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await me(current.token)).status, 200);
    assert.equal((await me(otherWeb.token)).status, 401);
    assert.equal((await me(signAccessToken(human.id, device.familyId))).status, 200);
    const refreshOther = await fetch(`${app.baseUrl}/api/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: otherWeb.refreshToken }),
    });
    assert.equal(refreshOther.status, 401);
    assert.equal((await refreshOther.json() as { code?: string }).code, "session_revoked");
    const refreshCurrent = await fetch(`${app.baseUrl}/api/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
    assert.equal(refreshCurrent.status, 200);

    const status = await call(app.baseUrl, current.token, "GET", "/status");
    assert.deepEqual(await status.json(), { enabled: true, methods: { totp: true, passkeys: 0, backupCodesRemaining: 10 }, sessionVerified: true, recovery: null });

    const again = await call(app.baseUrl, current.token, "POST", "/enable", { code: totpCode(secret, 1) });
    assert.equal(again.status, 409);
    assert.equal((await again.json() as { code: string }).code, "second_factor_already_enabled");

    const audits = await getDb().select({ eventType: integrationAuditEvents.eventType, metadata: integrationAuditEvents.metadata, serverId: integrationAuditEvents.serverId })
      .from(integrationAuditEvents).where(eq(integrationAuditEvents.actorId, human.id));
    assert.deepEqual(audits.map((event) => event.eventType).sort(), ["account.second_factor_enabled", "account.second_factor_totp_confirmed"]);
    const enabledAudit = audits.find((event) => event.eventType === "account.second_factor_enabled");
    assert.deepEqual(enabledAudit?.metadata, { sessionFamilyId: current.familyId, method: "totp", signedOutSessionCount: 1 });
    assert.equal(enabledAudit?.serverId, null);
    assert.deepEqual(emails.deliveries.filter((mail) => mail.to === human.email).map((mail) => mail.subject), [
      "An authenticator app was added to your Raft account",
      "Two-step verification is on — Raft",
    ]);
    assert.equal(emails.deliveries.some((mail) => backupCodes.some((code) => mail.html.includes(code))), false);
  } finally {
    emails.stop();
  }
});

test("regenerating replaces every backup code; disabling with a backup code turns it all off", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);

  const offRegenerate = await call(app.baseUrl, session.token, "POST", "/backup-codes/regenerate", { code: "123456" });
  assert.equal(offRegenerate.status, 409);
  assert.equal((await offRegenerate.json() as { code: string }).code, "second_factor_not_enabled");
  const offDisable = await call(app.baseUrl, session.token, "POST", "/disable", { code: "123456" });
  assert.equal(offDisable.status, 409);
  assert.equal((await offDisable.json() as { code: string }).code, "second_factor_not_enabled");

  const secret = await setUpAndConfirm(app.baseUrl, session.token);
  const enabled = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  const { backupCodes: first } = await enabled.json() as { backupCodes: string[] };

  const regenerated = await call(app.baseUrl, session.token, "POST", "/backup-codes/regenerate", { code: totpCode(secret, 1) });
  assert.equal(regenerated.status, 200);
  const { backupCodes: second } = await regenerated.json() as { backupCodes: string[] };
  assert.equal(second.length, 10);
  assert.equal(second.some((code) => first.includes(code)), false);
  assert.equal((await getDb().select().from(userBackupCodes).where(eq(userBackupCodes.userId, human.id))).length, 10);

  const old = await call(app.baseUrl, session.token, "POST", "/disable", { backupCode: first[0] });
  assert.equal(old.status, 400);
  assert.equal((await old.json() as { code: string }).code, "second_factor_code_invalid");

  // Typed the way people type it: lower case, no hyphen.
  const disabled = await call(app.baseUrl, session.token, "POST", "/disable", { backupCode: second[0]!.replace("-", "").toLowerCase() });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { enabled: false });
  const status = await call(app.baseUrl, session.token, "GET", "/status");
  assert.deepEqual(await status.json(), { enabled: false, methods: { totp: false, passkeys: 0, backupCodesRemaining: 0 }, sessionVerified: true, recovery: null });
  assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id))).length, 0);
});

test("a backup code works once; re-binding TOTP while on needs step-up", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  const secret = await setUpAndConfirm(app.baseUrl, session.token);
  const enabled = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  const { backupCodes } = await enabled.json() as { backupCodes: string[] };

  const noStepUp = await call(app.baseUrl, session.token, "POST", "/totp/setup");
  assert.equal(noStepUp.status, 403);
  const refused = await noStepUp.json() as { code: string; methods: string[] };
  assert.equal(refused.code, "step_up_required");
  assert.deepEqual(refused.methods, ["totp", "backup_code"]);
  const [before] = await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id));
  assert.ok(before?.confirmedAt, "the confirmed secret is untouched without step-up");

  const rebind = await call(app.baseUrl, session.token, "POST", "/totp/setup", { backupCode: backupCodes[0] });
  assert.equal(rebind.status, 200);
  const [after] = await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id));
  assert.ok(after?.confirmedAt);
  assert.equal(after?.secretCiphertext, before?.secretCiphertext);
  assert.ok(after?.pendingSecretCiphertext && after.pendingCreatedAt);

  const reused = await call(app.baseUrl, session.token, "POST", "/disable", { backupCode: backupCodes[0] });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json() as { code: string }).code, "backup_code_used");

  const disabled = await call(app.baseUrl, session.token, "POST", "/disable", { backupCode: backupCodes[1] });
  assert.equal(disabled.status, 200);
});

test("each backup code used for step-up, a TOTP re-bind or turning it off: one audit and one email; TOTP and a wrong code: neither", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  const secret = await setUpAndConfirm(app.baseUrl, session.token);
  const enabled = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  const { backupCodes } = await enabled.json() as { backupCodes: string[] };
  const audits = async () => (await getDb().select({ metadata: integrationAuditEvents.metadata, serverId: integrationAuditEvents.serverId }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.second_factor_backup_code_used"))));
  const emails = captureEmails();
  const backupMails = () => emails.deliveries.filter((mail) => mail.subject === "A backup code was used on your Raft account");
  try {
    assert.equal((await call(app.baseUrl, session.token, "POST", "/step-up", { code: totpCode(secret, 1) })).status, 200);
    assert.equal((await call(app.baseUrl, session.token, "POST", "/step-up", { backupCode: "AAAAA-AAAAA" })).status, 400);
    assert.equal((await audits()).length, 0);
    assert.equal(emails.deliveries.length, 0, "a TOTP step-up or a wrong backup code sends nothing");

    // Spend down to 2 left with step-ups: each one audit, one email.
    for (let i = 0; i < 7; i += 1) {
      const stepped = await call(app.baseUrl, session.token, "POST", "/step-up", { backupCode: backupCodes[i] });
      assert.equal(stepped.status, 200);
      assert.deepEqual(await stepped.json(), { verified: true, backupCodesRemaining: 9 - i });
      assert.equal((await audits()).length, i + 1);
      assert.equal(backupMails().length, i + 1);
    }
    const stepUps = await audits();
    assert.deepEqual(stepUps.at(-1), { serverId: null, metadata: { method: "backup_code", context: "step_up", remaining: 3, sessionFamilyId: session.familyId } });
    assert.match(backupMails()[0]!.text ?? "", /used to confirm it's you/);
    assert.match(backupMails()[0]!.text ?? "", /You have 9 backup codes left\.$/m);
    assert.match(backupMails().at(-1)!.text ?? "", /You have 3 backup codes left\.$/m);

    const rebind = await call(app.baseUrl, session.token, "POST", "/totp/setup", { backupCode: backupCodes[7] });
    assert.equal(rebind.status, 200);
    assert.equal((await audits()).length, 8);
    assert.deepEqual((await audits()).at(-1)!.metadata, { method: "backup_code", context: "totp_setup", remaining: 2, sessionFamilyId: session.familyId });
    assert.equal(backupMails().length, 8);
    assert.match(backupMails().at(-1)!.text ?? "", /You have 2 backup codes left\. Create a new set in Settings soon\./);

    const disabled = await call(app.baseUrl, session.token, "POST", "/disable", { backupCode: backupCodes[8] });
    assert.equal(disabled.status, 200);
    assert.equal((await audits()).length, 9);
    assert.deepEqual((await audits()).at(-1)!.metadata, { method: "backup_code", context: "disable", remaining: 0, sessionFamilyId: session.familyId });
    assert.equal(backupMails().length, 9);
    assert.match(backupMails().at(-1)!.text ?? "", /turned off with it, so your other backup codes were removed/);
    assert.equal(emails.deliveries.filter((mail) => mail.to === human.email).length, emails.deliveries.length);
  } finally {
    emails.stop();
  }
});

test("ten wrong codes in an hour lock the second step; the eleventh is refused even when right", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  const secret = await setUpAndConfirm(app.baseUrl, session.token);
  const wrong = wrongCode(secret);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const res = await call(app.baseUrl, session.token, "POST", "/enable", { code: wrong });
    assert.equal(res.status, 400, `attempt ${attempt}`);
    assert.equal((await res.json() as { code: string }).code, "second_factor_code_invalid");
    const [window] = await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id));
    assert.equal(window?.attempts, attempt);
  }
  const locked = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  assert.equal(locked.status, 429);
  const body = await locked.json() as { code: string; lockedUntil: string; methods: string[] };
  assert.equal(body.code, "second_factor_locked");
  assert.ok(Date.parse(body.lockedUntil) > Date.now());
  assert.deepEqual(body.methods, ["totp"]);
  assert.equal((await getDb().select({ at: users.secondFactorRequiredAt }).from(users).where(eq(users.id, human.id)))[0]?.at, null);
});

test("ten wrong passwords lock re-authentication only; the second step stays open", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  const secret = await setUpAndConfirm(app.baseUrl, session.token);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const res = await call(app.baseUrl, session.token, "POST", "/reauth/password", { password: "not-the-password" });
    assert.equal(res.status, 401, `attempt ${attempt}`);
    assert.equal((await res.json() as { code: string }).code, "password_incorrect");
  }
  const locked = await call(app.baseUrl, session.token, "POST", "/reauth/password", { password: "password123" });
  assert.equal(locked.status, 429);
  const body = await locked.json() as { code: string; lockedUntil: string };
  assert.equal(body.code, "reauth_locked");
  assert.ok(Date.parse(body.lockedUntil) > Date.now());
  assert.equal((await getDb().select({ at: sessionFamilies.reauthenticatedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, session.familyId)))[0]?.at, null);

  // A code for the same person still claims from the second-step window.
  const enabled = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await getDb().select({ attempts: secondFactorAttemptWindows.attempts, lockedUntil: secondFactorAttemptWindows.lockedUntil }).from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id)), [
    { attempts: 0, lockedUntil: null },
  ]);
});

test("a second-step lock does not block password re-authentication", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  const secret = await setUpAndConfirm(app.baseUrl, session.token);
  const wrong = wrongCode(secret);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.equal((await call(app.baseUrl, session.token, "POST", "/enable", { code: wrong })).status, 400, `attempt ${attempt}`);
  }
  const locked = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  assert.equal((await locked.json() as { code: string }).code, "second_factor_locked");

  const right = await call(app.baseUrl, session.token, "POST", "/reauth/password", { password: "password123" });
  assert.equal(right.status, 204);
  assert.ok((await getDb().select({ at: sessionFamilies.reauthenticatedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, session.familyId)))[0]?.at);
  // The right password gave its claim back.
  assert.equal((await getDb().select().from(reauthAttemptWindows).where(eq(reauthAttemptWindows.userId, human.id)))[0]?.attempts, 0);
});

// Design §0: a person who never turned two-step verification on sees no
// change. Sign-in, refresh and device approval answer as before, with or
// without a leftover (retired) flag row.
for (const leftoverRow of [false, true] as const) {
  test(`no change for a person without two-step verification (leftover flag row: ${leftoverRow}): login, refresh, device approval`, async ({ app, seed }) => {
    const human = await seed.human();
    if (leftoverRow) await leaveRetiredSecondFactorFlagRowOff();
    const json = { "Content-Type": "application/json" };

    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST", headers: json, body: JSON.stringify({ email: human.email, password: "password123" }),
    });
    assert.equal(login.status, 200);
    const signedIn = await login.json() as { user: { id: string }; accessToken: string; refreshToken: string };
    assert.deepEqual(Object.keys(signedIn).sort(), ["accessToken", "refreshToken", "user"]);
    assert.equal(signedIn.user.id, human.id);
    const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
    assert.equal(family?.secondFactorVerifiedAt, null);
    assert.equal(family?.scope, "full");

    const refresh = await fetch(`${app.baseUrl}/api/auth/refresh`, {
      method: "POST", headers: json, body: JSON.stringify({ refreshToken: signedIn.refreshToken }),
    });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json() as { accessToken: string; refreshToken: string };
    assert.deepEqual(Object.keys(refreshed).sort(), ["accessToken", "refreshToken"]);

    const authorize = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST", headers: json, body: JSON.stringify({ clientName: "raft-computer" }),
    });
    assert.equal(authorize.status, 201);
    const grant = await authorize.json() as { deviceCode: string; userCode: string };
    const bearer = { ...json, Authorization: `Bearer ${refreshed.accessToken}` };
    const described = await fetch(`${app.baseUrl}/api/auth/device/describe`, {
      method: "POST", headers: bearer, body: JSON.stringify({ userCode: grant.userCode }),
    });
    assert.equal(described.status, 200);
    const { approvalTicket } = await described.json() as { approvalTicket: string };
    const approve = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST", headers: bearer, body: JSON.stringify({ userCode: grant.userCode, approvalTicket }),
    });
    assert.equal(approve.status, 200);
    assert.deepEqual(await approve.json(), { ok: true, action: "approved" });
    const token = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST", headers: json, body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    assert.equal(token.status, 200);
    const deviceSession = await token.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(deviceSession).sort(), ["accessToken", "refreshToken", "userId"]);

    // Nothing two-step was written for them.
    const families = await getDb().select().from(sessionFamilies)
      .where(and(eq(sessionFamilies.userId, human.id)));
    assert.equal(families.every((row) => row.secondFactorVerifiedAt === null && row.revokedAt === null), true);
    assert.equal((await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id))).length, 0);
  });
}

test("a re-bind keeps the confirmed authenticator working until the new one is confirmed", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await webSession(human.id);
  const oldSecret = await setUpAndConfirm(app.baseUrl, session.token);
  const enabled = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(oldSecret, 0) });
  const { backupCodes } = await enabled.json() as { backupCodes: string[] };
  const totpRow = async () => (await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id)))[0]!;
  const confirmedCiphertext = (await totpRow()).secretCiphertext;

  // A re-bind the person abandons: the old secret still works, nothing else changed.
  const abandoned = await call(app.baseUrl, session.token, "POST", "/totp/setup", { backupCode: backupCodes[0] });
  assert.equal(abandoned.status, 200);
  const { secret: abandonedSecret } = await abandoned.json() as { secret: string };
  const status = await call(app.baseUrl, session.token, "GET", "/status");
  assert.deepEqual((await status.json() as { methods: { totp: boolean } }).methods.totp, true);
  const oldStillWorks = await call(app.baseUrl, session.token, "POST", "/backup-codes/regenerate", { code: totpCode(oldSecret, 1) });
  assert.equal(oldStillWorks.status, 200);
  const { backupCodes: fresh } = await oldStillWorks.json() as { backupCodes: string[] };
  assert.equal((await totpRow()).secretCiphertext, confirmedCiphertext);

  // The next re-bind replaces the pending secret; the abandoned one never confirms.
  const rebind = await call(app.baseUrl, session.token, "POST", "/totp/setup", { backupCode: fresh[0] });
  assert.equal(rebind.status, 200);
  const { secret: newSecret } = await rebind.json() as { secret: string };
  const stalePending = await call(app.baseUrl, session.token, "POST", "/totp/confirm", { code: totpCode(abandonedSecret, -1) });
  assert.equal(stalePending.status, 400);
  assert.equal((await stalePending.json() as { code: string }).code, "second_factor_code_invalid");
  const pendingCiphertext = (await totpRow()).pendingSecretCiphertext;

  const confirmed = await call(app.baseUrl, session.token, "POST", "/totp/confirm", { code: totpCode(newSecret, -1) });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { confirmed: true, enabled: true });
  const swapped = await totpRow();
  assert.equal(swapped.secretCiphertext, pendingCiphertext);
  assert.equal(swapped.pendingSecretCiphertext, null);
  assert.equal(swapped.pendingCreatedAt, null);
  assert.ok(swapped.confirmedAt);

  // Swapped: the old secret no longer works, the new one does.
  const old = await call(app.baseUrl, session.token, "POST", "/backup-codes/regenerate", { code: totpCode(oldSecret, 0) });
  assert.equal(old.status, 400);
  const current = await call(app.baseUrl, session.token, "POST", "/backup-codes/regenerate", { code: totpCode(newSecret, 0) });
  assert.equal(current.status, 200);
  const audits = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.second_factor_totp_confirmed")));
  assert.deepEqual(audits.map((event) => (event.metadata as { rebind: boolean }).rebind).sort(), [false, true]);
});

test("one code turns it on: /enable right after /totp/setup confirms the app and enables, no /totp/confirm", async ({ app, seed }) => {
  const human = await seed.human() as Human;
  const session = await webSession(human.id);

  // No authenticator set up yet: nothing to check the code against.
  const tooEarly = await call(app.baseUrl, session.token, "POST", "/enable", { code: "123456" });
  assert.equal(tooEarly.status, 409);
  assert.equal((await tooEarly.json() as { code: string }).code, "totp_setup_required");

  const setup = await call(app.baseUrl, session.token, "POST", "/totp/setup");
  assert.equal(setup.status, 200);
  const { secret } = await setup.json() as { secret: string };

  // A wrong code leaves the new app unconfirmed and two-step verification off.
  const wrong = await call(app.baseUrl, session.token, "POST", "/enable", { code: wrongCode(secret) });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json() as { code: string }).code, "second_factor_code_invalid");
  assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id)))[0]?.confirmedAt, null);

  const enabled = await call(app.baseUrl, session.token, "POST", "/enable", { code: totpCode(secret, 0) });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json() as { backupCodes: string[] }).backupCodes.length, 10);
  const totp = (await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id)))[0]!;
  assert.ok(totp.confirmedAt, "the setup secret is confirmed by the same code");
  assert.ok(totp.lastUsedStep !== null, "that code's step is the replay guard");
  const status = await call(app.baseUrl, session.token, "GET", "/status");
  assert.deepEqual(await status.json(), { enabled: true, methods: { totp: true, passkeys: 0, backupCodesRemaining: 10 }, sessionVerified: true, recovery: null });
});
