// PR 3 of passkeys + two-step verification (design v8 §3, §7.3): the second
// step at sign-in. With two-step verification on (the person's own
// setting), each first-factor entry point answers a challenge and no tokens;
// POST /api/auth/second-factor/verify finishes exactly as the entry point
// would have. Device and app approval need a verified sign-in. Someone who
// never turned it on sees no change (design §0; last tests).
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  authChallenges,
  integrationAuditEvents,
  oauthTransactions,
  sessionFamilies,
  sessions,
  socialAuthCompletions,
  userAuthIdentities,
  users,
} from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { createSession } from "../services/sessionService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { signAccessToken } from "../middleware/auth";
import { signInForTest } from "../test/integration/credentials";
import { socialCompletionCookie } from "../test/integration/socialCompletionCookie";
import {
  enrollSecondFactor,
  leaveRetiredSecondFactorFlagRowOff,
  totpCode,
  useTotpSecretKey,
  wrongTotpCode,
} from "../test/integration/secondFactor";

const test = createApiTest();
useTotpSecretKey();

const ENV = {
  APP_URL: "https://app.raft.test",
  MOBILE_OAUTH_RETURN_URI: "raft://oauth/callback",
  // The device-login code hashes with this pepper (as deviceAuth.api.test.ts).
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "second-factor-sign-in-test-pepper-0123456789",
} as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
beforeAll(() => { Object.assign(process.env, ENV); });
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Human = { id: string; email: string };
type Json = Record<string, unknown>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Web social completion (`/api/auth/:provider/complete`) carries the browser binding its callback left. */
function webCompletionCookie(path: string, body: unknown): Record<string, string> {
  const provider = /^\/api\/auth\/(google|github|apple)\/complete$/.exec(path)?.[1];
  const code = (body as { code?: unknown } | null)?.code;
  return provider && typeof code === "string" ? { Cookie: socialCompletionCookie(provider, code) } : {};
}

async function post(baseUrl: string, path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...webCompletionCookie(path, body),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json };
}

async function enforced(seed: { human(): Promise<Human> }, options?: { totp?: boolean }) {
  const human = await seed.human();
  return { human, ...(await enrollSecondFactor(human.id, options)) };
}

async function familiesOf(userId: string) {
  return getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, userId));
}

async function sessionCount(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

const keys = (body: Json) => Object.keys(body).sort();

/** The challenge answer every first-factor entry point gives an enforced person. */
function assertChallenge(res: { status: number; body: Json }, human: Human, methods: string[] = ["totp", "backup_code"]) {
  assert.equal(res.status, 200);
  assert.deepEqual(keys(res.body), ["challenge", "expiresAt", "maskedEmail", "methods", "secondFactorRequired"]);
  assert.equal(res.body.secondFactorRequired, true);
  assert.deepEqual(res.body.methods, methods);
  assert.equal(res.body.maskedEmail, `${human.email[0]}***${human.email.slice(human.email.indexOf("@"))}`);
  assert.equal("accessToken" in res.body || "refreshToken" in res.body, false);
  return res.body.challenge as string;
}

function login(baseUrl: string, human: Human, extra: Json = {}) {
  return post(baseUrl, "/api/auth/login", { email: human.email, password: "password123", ...extra });
}

function verify(baseUrl: string, body: Json) {
  return post(baseUrl, "/api/auth/second-factor/verify", body);
}

/** A web social completion code for an existing account (as the provider callback leaves it). */
async function webCompletion(userId: string, providerUserId = `google-${randomUUID()}`): Promise<string> {
  const code = randomBytes(24).toString("hex");
  await getDb().insert(socialAuthCompletions).values({
    codeHash: sha256(code), provider: "google", mode: "login", intendedAction: "login", status: "provider_completed",
    userId, providerUserId, providerEmail: "someone@gmail.test", returnTo: "/s/home",
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  return code;
}

/** A mobile OAuth handoff code + its verifier for an existing account. */
async function mobileCompletion(userId: string): Promise<{ code: string; codeVerifier: string }> {
  const code = randomBytes(24).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  await getDb().insert(oauthTransactions).values({
    codeHash: sha256(code), provider: "github", mode: "login", intendedAction: "login", status: "provider_completed",
    codeChallenge: pkce(codeVerifier), userId, providerUserId: `gh-${randomUUID()}`, providerEmail: "someone@github.test",
    returnTo: "raft://oauth/callback", expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  return { code, codeVerifier };
}

/** A pending Google link for `userId` (what /:provider/complete hands out on an email conflict). */
async function pendingLink(userId: string, email: string): Promise<{ token: string; providerUserId: string }> {
  const token = randomBytes(32).toString("hex");
  const providerUserId = `google-${randomUUID()}`;
  await getDb().insert(socialAuthCompletions).values({
    codeHash: sha256(token), provider: "google", mode: "login", intendedAction: "link", status: "pending_link",
    userId, providerUserId, providerEmail: email, expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return { token, providerUserId };
}

async function googleIdentity(providerUserId: string) {
  const [row] = await getDb().select().from(userAuthIdentities)
    .where(and(eq(userAuthIdentities.provider, "google"), eq(userAuthIdentities.providerUserId, providerUserId)));
  return row;
}

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

// ---------------------------------------------------------------------------
// Each first-factor entry point: first factor only => a challenge, no tokens.
// ---------------------------------------------------------------------------

test("password login: first factor only gets a challenge; TOTP and a backup code each finish like /login", async ({ app, seed }) => {
  const { human, secret, backupCodes } = await enforced(seed);
  // What /login answers someone without two-step verification, for the shape.
  const plain = await seed.human();
  const baseline = await login(app.baseUrl, plain);
  assert.equal(baseline.status, 200);

  const challenge = assertChallenge(await login(app.baseUrl, human), human);
  assert.equal(await sessionCount(human.id), 0, "no session from the first factor");

  const viaTotp = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
  assert.equal(viaTotp.status, 200);
  assert.deepEqual(keys(viaTotp.body), keys(baseline.body));
  assert.deepEqual(keys(viaTotp.body.user as Json), keys(baseline.body.user as Json));
  assert.equal((viaTotp.body.user as Json).id, human.id);
  const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${viaTotp.body.accessToken}` } });
  assert.equal(me.status, 200);
  const [family] = await familiesOf(human.id);
  assert.equal(family!.secondFactorMethod, "totp");
  assert.ok(family!.secondFactorVerifiedAt);
  assert.equal(family!.scope, "full");

  // Used once: the same challenge is gone.
  const again = await verify(app.baseUrl, { challenge, totp: totpCode(secret, 1) });
  assert.equal(again.status, 410);
  assert.equal(again.body.code, "challenge_expired");

  const second = assertChallenge(await login(app.baseUrl, human), human);
  const viaBackup = await verify(app.baseUrl, { challenge: second, backupCode: backupCodes[0]!.toLowerCase().replace("-", " ") });
  assert.equal(viaBackup.status, 200);
  assert.deepEqual(keys(viaBackup.body), [...keys(baseline.body), "backupCodesRemaining"].sort());
  assert.equal(viaBackup.body.backupCodesRemaining, 9);
  const backupFamily = (await familiesOf(human.id)).find((row) => row.secondFactorMethod === "backup_code");
  assert.ok(backupFamily?.secondFactorVerifiedAt);

  // A used backup code says so.
  const third = assertChallenge(await login(app.baseUrl, human), human, ["totp", "backup_code"]);
  const reused = await verify(app.baseUrl, { challenge: third, backupCode: backupCodes[0] });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.code, "backup_code_used");
});

async function backupCodeAudits(userId: string) {
  return getDb().select({ metadata: integrationAuditEvents.metadata, serverId: integrationAuditEvents.serverId }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, userId), eq(integrationAuditEvents.eventType, "account.second_factor_backup_code_used")));
}

test("a backup code at sign-in: one audit and one email with the codes left; a TOTP code or a wrong backup code: neither", async ({ app, seed }) => {
  const { human, secret, backupCodes } = await enforced(seed);
  const emails = captureEmails();
  try {
    const viaTotp = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), totp: totpCode(secret) });
    assert.equal(viaTotp.status, 200);
    const wrong = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), backupCode: "AAAAA-AAAAA" });
    assert.equal(wrong.status, 400);
    assert.equal((await backupCodeAudits(human.id)).length, 0);
    assert.equal(emails.deliveries.length, 0, "no email for a TOTP sign-in or a wrong backup code");

    const viaBackup = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), backupCode: backupCodes[0] });
    assert.equal(viaBackup.status, 200);
    const audits = await backupCodeAudits(human.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.serverId, null, "the person's own, never on a server's audit page");
    assert.deepEqual(audits[0]!.metadata, { method: "backup_code", context: "sign_in", remaining: 9, sessionFamilyId: null, signInFlow: "password_login" });
    assert.equal(emails.deliveries.length, 1);
    assert.equal(emails.deliveries[0]!.to, human.email);
    assert.equal(emails.deliveries[0]!.subject, "A backup code was used on your Raft account");
    assert.match(emails.deliveries[0]!.text ?? "", /used to sign in to your account/);
    assert.match(emails.deliveries[0]!.text ?? "", /You have 9 backup codes left\.$/m);
    assert.match(emails.deliveries[0]!.text ?? "", /If this wasn't you, change your password now .* and create new backup codes/);

    // Reused: refused, nothing more.
    const reused = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), backupCode: backupCodes[0] });
    assert.equal(reused.body.code, "backup_code_used");
    assert.equal((await backupCodeAudits(human.id)).length, 1);
    assert.equal(emails.deliveries.length, 1);
  } finally {
    emails.stop();
  }
});

test("password login with a pending link: a failed second step leaves no link; a passed one links and says so", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const pending = await pendingLink(human.id, human.email);

  const challenge = assertChallenge(await login(app.baseUrl, human, { pendingLinkToken: pending.token }), human);
  assert.equal(await googleIdentity(pending.providerUserId), undefined, "not linked by the first factor");

  const wrong = await verify(app.baseUrl, { challenge, totp: wrongTotpCode(secret) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "second_factor_code_invalid");
  assert.equal(await googleIdentity(pending.providerUserId), undefined, "a failed second step links nothing");
  assert.equal(await sessionCount(human.id), 0);

  const right = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
  assert.equal(right.status, 200);
  assert.equal(right.body.linkedProvider, "google");
  assert.deepEqual(keys(right.body), ["accessToken", "linkedProvider", "refreshToken", "user"]);
  assert.equal((await googleIdentity(pending.providerUserId))?.userId, human.id);
});

test("password login: a password changed since the first step voids the challenge", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const challenge = assertChallenge(await login(app.baseUrl, human), human);
  await getDb().update(users).set({ passwordHash: "changed" }).where(eq(users.id, human.id));
  const res = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, "challenge_expired");
  assert.equal(await sessionCount(human.id), 0);
});

test("web social (existing account): a challenge, then the /:provider/complete body; a pending link waits for the second step", async ({ app, seed }) => {
  const plain = await seed.human();
  const baseline = await post(app.baseUrl, "/api/auth/google/complete", { code: await webCompletion(plain.id) });
  assert.equal(baseline.status, 200);

  const { human, secret, backupCodes } = await enforced(seed);
  const pending = await pendingLink(human.id, human.email);
  const challenge = assertChallenge(
    await post(app.baseUrl, "/api/auth/google/complete", { code: await webCompletion(human.id), pendingLinkToken: pending.token }),
    human,
  );
  assert.equal(await sessionCount(human.id), 0);

  const wrong = await verify(app.baseUrl, { challenge, backupCode: "AAAAA-AAAAA" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "second_factor_code_invalid");
  assert.equal(await googleIdentity(pending.providerUserId), undefined, "a failed second step links nothing");

  const right = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
  assert.equal(right.status, 200);
  assert.deepEqual(keys(right.body), [...keys(baseline.body), "linkedProvider"].sort());
  assert.deepEqual({ provider: right.body.provider, mode: right.body.mode, returnTo: right.body.returnTo }, { provider: "google", mode: "login", returnTo: "/s/home" });
  assert.equal((await googleIdentity(pending.providerUserId))?.userId, human.id);

  const plainChallenge = assertChallenge(await post(app.baseUrl, "/api/auth/google/complete", { code: await webCompletion(human.id) }), human);
  const viaBackup = await verify(app.baseUrl, { challenge: plainChallenge, backupCode: backupCodes[3] });
  assert.equal(viaBackup.status, 200);
  assert.deepEqual(keys(viaBackup.body), [...keys(baseline.body), "backupCodesRemaining"].sort());
});

test("mobile social: a challenge bound to the PKCE verifier, then the mobile complete body", async ({ app, seed }) => {
  const plain = await seed.human();
  const baseline = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", await mobileCompletion(plain.id));
  assert.equal(baseline.status, 200);

  const { human, secret, backupCodes } = await enforced(seed);
  const handoff = await mobileCompletion(human.id);
  const challenge = assertChallenge(await post(app.baseUrl, "/api/auth/mobile/oauth/complete", handoff), human);
  assert.equal(await sessionCount(human.id), 0);
  // The handoff code is spent: it cannot mint a second challenge.
  const replay = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", handoff);
  assert.equal(replay.status, 410);

  for (const codeVerifier of [undefined, "someone-else-verifier-0123456789"]) {
    const unbound = await verify(app.baseUrl, { challenge, totp: totpCode(secret), ...(codeVerifier ? { codeVerifier } : {}) });
    assert.equal(unbound.status, 400);
    assert.equal(unbound.body.code, "pkce_mismatch");
  }
  assert.equal(await sessionCount(human.id), 0);

  const right = await verify(app.baseUrl, { challenge, totp: totpCode(secret), codeVerifier: handoff.codeVerifier });
  assert.equal(right.status, 200);
  assert.deepEqual(keys(right.body), keys(baseline.body));
  assert.deepEqual(keys(right.body.user as Json), keys(baseline.body.user as Json));
  assert.deepEqual({ provider: right.body.provider, mode: right.body.mode, returnUri: right.body.returnUri }, { provider: "github", mode: "login", returnUri: "raft://oauth/callback" });

  const next = await mobileCompletion(human.id);
  const nextChallenge = assertChallenge(await post(app.baseUrl, "/api/auth/mobile/oauth/complete", next), human);
  const viaBackup = await verify(app.baseUrl, { challenge: nextChallenge, backupCode: backupCodes[5], codeVerifier: next.codeVerifier });
  assert.equal(viaBackup.status, 200);
  assert.deepEqual(keys(viaBackup.body), [...keys(baseline.body), "backupCodesRemaining"].sort());
});

test("methods list only what is set up: backup codes alone when there is no authenticator app", async ({ app, seed }) => {
  const { human } = await enforced(seed, { totp: false });
  assertChallenge(await login(app.baseUrl, human), human, ["backup_code"]);
});

// ---------------------------------------------------------------------------
// Limits and races
// ---------------------------------------------------------------------------

test("two simultaneous right answers to one challenge give at most one session", async ({ app, seed }) => {
  const { human, secret, backupCodes } = await enforced(seed);
  const challenge = assertChallenge(await login(app.baseUrl, human), human);
  const results = await Promise.all([
    verify(app.baseUrl, { challenge, totp: totpCode(secret) }),
    verify(app.baseUrl, { challenge, backupCode: backupCodes[1] }),
    verify(app.baseUrl, { challenge, backupCode: backupCodes[2] }),
  ]);
  assert.equal(results.filter((res) => res.status === 200).length, 1, JSON.stringify(results.map((res) => [res.status, res.body.code])));
  assert.equal((await familiesOf(human.id)).length, 1);
  assert.equal(await sessionCount(human.id), 1);
});

test("a challenge takes five answers; then it is used up", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const challenge = assertChallenge(await login(app.baseUrl, human), human);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await verify(app.baseUrl, { challenge, totp: wrongTotpCode(secret) })).body.code, "second_factor_code_invalid");
  }
  const exhausted = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.body.code, "challenge_attempts_exhausted");
  assert.equal(await sessionCount(human.id), 0);
});

test("an expired challenge is refused", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const challenge = assertChallenge(await login(app.baseUrl, human), human);
  await getDb().update(authChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authChallenges.userId, human.id));
  const res = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, "challenge_expired");
  const malformed = await verify(app.baseUrl, { challenge: "nope", totp: "123456" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_request");
});

test("ten failed second steps lock the second step and send one email; a right code is refused while locked", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const emails = captureEmails();
  try {
    let failures = 0;
    while (failures < 10) {
      const challenge = assertChallenge(await login(app.baseUrl, human), human);
      for (let i = 0; i < 5 && failures < 10; i += 1, failures += 1) {
        const res = await verify(app.baseUrl, { challenge, totp: wrongTotpCode(secret) });
        assert.equal(res.body.code, "second_factor_code_invalid", `failure ${failures + 1}`);
      }
    }
    assert.equal(emails.deliveries.length, 0);
    const challenge = assertChallenge(await login(app.baseUrl, human), human);
    const locked = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, "second_factor_locked");
    assert.deepEqual(locked.body.methods, ["totp", "backup_code"]);
    assert.ok(Date.parse(locked.body.lockedUntil as string) > Date.now());
    const lockedAgain = await verify(app.baseUrl, { challenge, totp: totpCode(secret) });
    assert.equal(lockedAgain.body.code, "second_factor_locked");

    assert.equal(emails.deliveries.length, 1, "one email, when the lock starts");
    assert.equal(emails.deliveries[0]!.to, human.email);
    assert.match(emails.deliveries[0]!.text ?? "", /signed in with your password and reached the second step/);
    assert.match(emails.deliveries[0]!.text ?? "", /Change your password: https:\/\/app\.raft\.test/);
    assert.match(emails.deliveries[0]!.text ?? "", /Reset your password by email: https:\/\/app\.raft\.test\/forgot-password$/m);
    assert.match(emails.deliveries[0]!.html, /href="https:\/\/app\.raft\.test\/forgot-password"/);
    assert.equal(await sessionCount(human.id), 0);
  } finally {
    emails.stop();
  }
});

// ---------------------------------------------------------------------------
// Refresh, device and app approval, step-up
// ---------------------------------------------------------------------------

async function deviceApprove(baseUrl: string, token: string) {
  const authorize = await post(baseUrl, "/api/auth/device/authorize", { clientName: "raft-computer" });
  assert.equal(authorize.status, 201);
  const { userCode } = authorize.body as { userCode: string };
  const described = await post(baseUrl, "/api/auth/device/describe", { userCode }, token);
  if (described.status !== 200) return described;
  return post(baseUrl, "/api/auth/device/approve", { userCode, approvalTicket: described.body.approvalTicket }, token);
}

async function appLoginApprove(baseUrl: string, token: string) {
  const started = await post(baseUrl, "/api/auth/app-login/start", { returnUri: "raft://login/callback", codeChallenge: pkce(randomBytes(32).toString("base64url")) });
  assert.equal(started.status, 201);
  return post(baseUrl, `/api/auth/app-login/requests/${started.body.requestId}/approve`, {}, token);
}

test("refresh never upgrades: a sign-in from before two-step verification stays unverified and cannot approve", async ({ app, seed }) => {
  const human = await seed.human();
  const before = await signInForTest(human.id);
  const { secret } = await enrollSecondFactor(human.id);

  const refreshed = await post(app.baseUrl, "/api/auth/refresh", { refreshToken: before.refreshToken });
  assert.equal(refreshed.status, 200);
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, before.familyId));
  assert.equal(family!.secondFactorVerifiedAt, null);
  assert.equal(family!.secondFactorMethod, null);

  for (const approve of [deviceApprove, appLoginApprove]) {
    const refused = await approve(app.baseUrl, refreshed.body.accessToken as string);
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, {
      error: "Confirm it's you with your second step before approving this sign-in.",
      code: "second_factor_step_up_required",
      methods: ["totp", "backup_code"],
    });
  }

  // Step-up on this sign-in marks it; then both approvals go through.
  const stepUp = await post(app.baseUrl, "/api/auth/second-factor/step-up", { code: totpCode(secret) }, refreshed.body.accessToken as string);
  assert.equal(stepUp.status, 200);
  assert.deepEqual(stepUp.body, { verified: true });
  const [marked] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, before.familyId));
  assert.equal(marked!.secondFactorMethod, "totp");
  assert.equal((await deviceApprove(app.baseUrl, refreshed.body.accessToken as string)).status, 200);
  assert.equal((await appLoginApprove(app.baseUrl, refreshed.body.accessToken as string)).status, 200);
});

test("a sign-in that passed the second step approves device and app logins directly", async ({ app, seed }) => {
  const { human, backupCodes } = await enforced(seed);
  const challenge = assertChallenge(await login(app.baseUrl, human), human);
  const signedIn = await verify(app.baseUrl, { challenge, backupCode: backupCodes[9] });
  assert.equal(signedIn.status, 200);
  const approved = await deviceApprove(app.baseUrl, signedIn.body.accessToken as string);
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body, { ok: true, action: "approved" });
  assert.equal((await appLoginApprove(app.baseUrl, signedIn.body.accessToken as string)).status, 200);
});

test("a device login's session can neither approve nor step up, even for someone with two-step verification", async ({ app, seed }) => {
  const human = await seed.human();
  const approver = await signInForTest(human.id);
  const { secret } = await enrollSecondFactor(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, approver.familyId), undefined, { scope: "device" });
  const deviceToken = signAccessToken(human.id, device.familyId);

  const stepUp = await post(app.baseUrl, "/api/auth/second-factor/step-up", { code: totpCode(secret) }, deviceToken);
  assert.equal(stepUp.status, 403);
  assert.equal(stepUp.body.code, "device_session_not_allowed");
  const describe = await deviceApprove(app.baseUrl, deviceToken);
  assert.equal(describe.status, 403);
  assert.equal(describe.body.code, "device_session_not_allowed");
  const approve = await post(app.baseUrl, "/api/auth/device/approve", { userCode: "ABCD-EFGH", approvalTicket: "x" }, deviceToken);
  assert.equal(approve.status, 403);
  assert.equal(approve.body.code, "device_session_not_allowed");
  assert.equal((await appLoginApprove(app.baseUrl, deviceToken)).body.code, "device_session_not_allowed");
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, device.familyId));
  assert.equal(family!.secondFactorVerifiedAt, null);
});

test("step-up needs two-step verification on, and a right code", async ({ app, seed }) => {
  const off = await seed.human();
  const offSession = await signInForTest(off.id);
  const notEnabled = await post(app.baseUrl, "/api/auth/second-factor/step-up", { code: "123456" }, offSession.token);
  assert.equal(notEnabled.status, 409);
  assert.equal(notEnabled.body.code, "second_factor_not_enabled");

  const human = await seed.human();
  const session = await signInForTest(human.id);
  const { secret, backupCodes } = await enrollSecondFactor(human.id);
  const wrong = await post(app.baseUrl, "/api/auth/second-factor/step-up", { code: wrongTotpCode(secret) }, session.token);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "second_factor_code_invalid");
  const viaBackup = await post(app.baseUrl, "/api/auth/second-factor/step-up", { backupCode: backupCodes[4] }, session.token);
  assert.equal(viaBackup.status, 200);
  assert.deepEqual(viaBackup.body, { verified: true, backupCodesRemaining: 9 });
});

// ---------------------------------------------------------------------------
// Design §0: someone who never turned it on sees no change, with or without a
// leftover (retired) auth_second_factor_v1 row.
// (Password login, refresh and device approval: secondFactor.api.test.ts.)
// ---------------------------------------------------------------------------

for (const leftoverRow of [false, true] as const) {
  test(`no change without two-step verification (leftover flag row: ${leftoverRow}): web social, mobile social, app-login approval`, async ({ app, seed }) => {
    const human = await seed.human();
    if (leftoverRow) await leaveRetiredSecondFactorFlagRowOff();

    const web = await post(app.baseUrl, "/api/auth/google/complete", { code: await webCompletion(human.id) });
    assert.equal(web.status, 200);
    assert.deepEqual(keys(web.body), ["accessToken", "mode", "provider", "refreshToken", "returnTo"]);

    const pending = await pendingLink(human.id, human.email);
    const linked = await post(app.baseUrl, "/api/auth/google/complete", { code: await webCompletion(human.id), pendingLinkToken: pending.token });
    assert.equal(linked.status, 200);
    assert.deepEqual(keys(linked.body), ["accessToken", "linkedProvider", "mode", "provider", "refreshToken", "returnTo"]);
    assert.equal((await googleIdentity(pending.providerUserId))?.userId, human.id);

    const mobile = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", await mobileCompletion(human.id));
    assert.equal(mobile.status, 200);
    assert.deepEqual(keys(mobile.body), ["accessToken", "mode", "provider", "refreshToken", "returnUri", "user"]);

    const approved = await appLoginApprove(app.baseUrl, web.body.accessToken as string);
    assert.equal(approved.status, 200);
    assert.deepEqual(keys(approved.body), ["redirectUrl"]);

    // Nothing two-step was written for them.
    assert.equal((await familiesOf(human.id)).every((row) => row.secondFactorVerifiedAt === null && row.revokedAt === null), true);
    assert.equal((await getDb().select().from(authChallenges).where(eq(authChallenges.userId, human.id))).length, 0);
  });
}

test("/verify takes the TOTP code as `code` (like /step-up) or as `totp`; both at once is refused", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const both = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), code: totpCode(secret), totp: totpCode(secret) });
  assert.equal(both.status, 400);
  assert.equal(both.body.code, "invalid_request");
  const codeAndBackup = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), code: totpCode(secret), backupCode: "abcde-fghjk" });
  assert.equal(codeAndBackup.status, 400);

  const viaCode = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), code: totpCode(secret) });
  assert.equal(viaCode.status, 200, JSON.stringify(viaCode.body));
  assert.ok(viaCode.body.accessToken);
  // The next step: the same code is spent, so the next one.
  const viaTotp = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), totp: totpCode(secret, 1) });
  assert.equal(viaTotp.status, 200, JSON.stringify(viaTotp.body));
  assert.deepEqual((await familiesOf(human.id)).map((family) => family.secondFactorMethod), ["totp", "totp"]);
});

test("GET /status says whether this sign-in passed the second factor: not a fresh one, yes after /step-up or a /verify sign-in", async ({ app, seed }) => {
  const human = await seed.human();
  // Sign-ins from before it was turned on (enrolled directly, so none is signed out).
  const fresh = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  const { secret } = await enrollSecondFactor(human.id);
  const status = async (token: string) => {
    const res = await fetch(`${app.baseUrl}/api/auth/second-factor/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    return (await res.json() as Json).sessionVerified;
  };
  assert.equal(await status(fresh.token), false);
  const stepped = await post(app.baseUrl, "/api/auth/second-factor/step-up", { code: totpCode(secret) }, fresh.token);
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.equal(await status(fresh.token), true);
  // Another sign-in of theirs is not verified by that.
  assert.equal(await status(other.token), false);

  const signedIn = await verify(app.baseUrl, { challenge: assertChallenge(await login(app.baseUrl, human), human), code: totpCode(secret, 1) });
  assert.equal(signedIn.status, 200);
  assert.equal(await status(signedIn.body.accessToken as string), true);
});

test("a web page older than the second step is told to reload instead of getting a challenge it can't read (#triage:#165)", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  const oldPage = { "X-Raft-Client-Platform": "browser", "X-Raft-Client-Version": "1.21.42" };
  const postAs = async (path: string, body: Json, headers: Record<string, string>) => {
    const res = await fetch(`${app.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers, ...webCompletionCookie(path, body) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Json };
  };
  const challenges = async () => (await getDb().select().from(authChallenges).where(eq(authChallenges.userId, human.id))).length;

  const password = await postAs("/api/auth/login", { email: human.email, password: "password123" }, oldPage);
  assert.equal(password.status, 426);
  assert.equal(password.body.code, "web_client_too_old");
  assert.match(String(password.body.error), /out of date/);
  const social = await postAs("/api/auth/google/complete", { code: await webCompletion(human.id) }, oldPage);
  assert.equal(social.status, 426);
  assert.equal(social.body.code, "web_client_too_old");
  assert.equal(await challenges(), 0);
  assert.equal(await sessionCount(human.id), 0);

  // A current page, and a sign-in that names no version (most of them), get the challenge as before.
  assertChallenge(await postAs("/api/auth/login", { email: human.email, password: "password123" }, { ...oldPage, "X-Raft-Client-Version": "1.21.44" }), human);
  assertChallenge(await login(app.baseUrl, human), human);

  // Someone without two-step verification signs in from the old page as before.
  const plain = await seed.human();
  const plainLogin = await postAs("/api/auth/login", { email: plain.email, password: "password123" }, oldPage);
  assert.equal(plainLogin.status, 200);
  assert.ok(plainLogin.body.accessToken);
});
