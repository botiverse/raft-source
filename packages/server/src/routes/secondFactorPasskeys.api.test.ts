// PR 4a of passkeys + two-step verification (design v8 §1, §3, §5, §7.1):
// passkeys as a registered second factor.
// Every ceremony is a real WebAuthn response from a software authenticator
// (test/integration/softwareAuthenticator.ts) checked by the server's
// verifier: registration, management, and a passkey answering the second
// step at /verify, /step-up, /disable and /enable. Someone who never turned
// two-step verification on sees no change (design §0; last test).
// PR 4b adds the stored user handle and a passkey answering the step-up
// before adding another passkey.
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { authChallenges, integrationAuditEvents, sessionFamilies, sessions, userBackupCodes, users, webauthnCredentials } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, leaveRetiredSecondFactorFlagRowOff, totpCode, useTotpSecretKey } from "../test/integration/secondFactor";
import { SoftwareAuthenticator } from "../test/integration/softwareAuthenticator";
import { legacyWebauthnUserHandle } from "../services/secondFactor/webauthn";

const test = createApiTest();
useTotpSecretKey();

const RP_ID = "raft.test";
const ORIGIN = "https://app.raft.test";
const ENV = {
  APP_URL: ORIGIN,
  WEBAUTHN_RP_ID: RP_ID,
  WEBAUTHN_ORIGINS: ORIGIN,
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "second-factor-passkeys-test-pepper-0123456789",
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
type Options = { challenge: string } & Json;

const BASE = "/api/auth/second-factor";

async function request(baseUrl: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json };
}

const post = (baseUrl: string, path: string, body: unknown, token?: string) => request(baseUrl, "POST", path, body, token);
const keys = (body: Json) => Object.keys(body).sort();

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

async function auditsOf(userId: string, eventType: string) {
  return getDb().select({ metadata: integrationAuditEvents.metadata, serverId: integrationAuditEvents.serverId }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, userId), eq(integrationAuditEvents.eventType, eventType)));
}

async function storedPasskeys(userId: string) {
  return getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
}

function authenticator(options?: ConstructorParameters<typeof SoftwareAuthenticator>[2]) {
  return new SoftwareAuthenticator(RP_ID, ORIGIN, options);
}

async function registrationOptions(baseUrl: string, token: string, answer: Json = {}): Promise<Options> {
  const res = await post(baseUrl, `${BASE}/passkeys/registration/options`, answer, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.options as Options;
}

/** Register `device` through the API (options, then verify). */
async function registerPasskey(baseUrl: string, token: string, device: SoftwareAuthenticator, answer: Json = {}, name?: string) {
  const options = await registrationOptions(baseUrl, token, answer);
  const res = await post(baseUrl, `${BASE}/passkeys/registration/verify`, { response: device.register(options), ...(name ? { name } : {}) }, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.passkey as Json).id as string;
}

/** Assertion options for step-up on the signed-in session. */
async function stepUpOptions(baseUrl: string, token: string): Promise<Options> {
  const res = await post(baseUrl, `${BASE}/passkeys/assertion/options`, {}, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.options as Options;
}

/** Someone with a registered passkey and two-step verification on. */
async function enforcedWithPasskey(baseUrl: string, seed: { human(): Promise<Human> }, options: { totp?: boolean; device?: SoftwareAuthenticator } = {}) {
  const human = await seed.human();
  const session = await signInForTest(human.id);
  // Another sign-in of theirs, made before it was turned on.
  const other = await signInForTest(human.id);
  const device = options.device ?? authenticator();
  const passkeyId = await registerPasskey(baseUrl, session.token, device);
  const enrolled = await enrollSecondFactor(human.id, { totp: options.totp });
  return { human, session, other, device, passkeyId, ...enrolled };
}

const PASSKEY_ROUTES: Array<[string, string]> = [
  ["POST", "/passkeys/registration/options"],
  ["POST", "/passkeys/registration/verify"],
  ["GET", "/passkeys"],
  ["PATCH", "/passkeys/00000000-0000-4000-8000-000000000000"],
  ["DELETE", "/passkeys/00000000-0000-4000-8000-000000000000"],
  ["POST", "/passkeys/assertion/options"],
];

test("a leftover auth_second_factor_v1 row switched off hides no passkey route; a device login's session is refused", async ({ app, seed }) => {
  await leaveRetiredSecondFactorFlagRowOff();
  const human = await seed.human();
  const { token, familyId } = await signInForTest(human.id);
  const list = await request(app.baseUrl, "GET", `${BASE}/passkeys`, undefined, token);
  assert.equal(list.status, 200);
  const device = await createSession(await proofForDeviceLogin(human.id, familyId), undefined, { scope: "device" });
  const deviceToken = signAccessToken(human.id, device.familyId);
  for (const [method, path] of PASSKEY_ROUTES) {
    const res = await request(app.baseUrl, method, `${BASE}${path}`, method === "GET" ? undefined : {}, deviceToken);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "device_session_not_allowed");
  }
  assert.equal((await getDb().select().from(authChallenges).where(eq(authChallenges.userId, human.id))).length, 0);
});

test("without WEBAUTHN_RP_ID the ceremonies answer 503 passkeys_unavailable", async ({ app, seed }) => {
  const human = await seed.human();
  const { token } = await signInForTest(human.id);
  const saved = process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGINS;
  try {
    for (const path of ["/passkeys/registration/options", "/passkeys/assertion/options"]) {
      const res = await post(app.baseUrl, `${BASE}${path}`, {}, token);
      assert.equal(res.status, 503, path);
      assert.equal(res.body.code, "passkeys_unavailable");
    }
    const list = await request(app.baseUrl, "GET", `${BASE}/passkeys`, undefined, token);
    assert.deepEqual(list.body, { passkeys: [] });
  } finally {
    process.env.WEBAUTHN_RP_ID = saved;
    process.env.WEBAUTHN_ORIGINS = ENV.WEBAUTHN_ORIGINS;
  }
});

test("registration: options, a real attestation stored with its flags, audited and emailed; listed; excluded next time", async ({ app, seed }) => {
  const human = await seed.human();
  const { token, familyId } = await signInForTest(human.id);
  const emails = captureEmails();
  try {
    const options = await registrationOptions(app.baseUrl, token);
    assert.equal((options.rp as Json).id, RP_ID);
    assert.deepEqual(options.authenticatorSelection, { residentKey: "preferred", userVerification: "required", requireResidentKey: false });
    assert.equal(options.attestation, "none");
    assert.deepEqual(options.excludeCredentials, []);
    const handle = (options.user as Json).id as string;
    assert.notEqual(Buffer.from(handle, "base64url").toString("utf8"), human.id);
    assert.equal(handle.includes(Buffer.from(human.email).toString("base64url")), false);
    // Stable per person.
    assert.equal(((await registrationOptions(app.baseUrl, token)).user as Json).id, handle);

    const device = authenticator({ aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd" });
    const verified = await post(app.baseUrl, `${BASE}/passkeys/registration/verify`, { challenge: options.challenge, response: device.register(options) }, token);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const passkey = verified.body.passkey as Json;
    assert.deepEqual(keys(passkey), ["createdAt", "id", "lastUsedAt", "name", "synced"]);
    assert.equal(passkey.name, "iCloud Keychain");
    assert.equal(passkey.synced, true);

    const [row] = await storedPasskeys(human.id);
    assert.ok(Buffer.from(row!.credentialId).equals(device.credentialId));
    assert.equal(row!.signCount, 0);
    assert.equal(row!.aaguid, "fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
    assert.equal(row!.backupEligible, true);
    assert.equal(row!.backupState, true);
    assert.deepEqual(row!.transports, ["internal", "hybrid"]);

    const audits = await auditsOf(human.id, "account.second_factor_passkey_added");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.serverId, null);
    assert.equal((audits[0]!.metadata as Json).sessionFamilyId, familyId);
    assert.deepEqual(emails.deliveries.filter((mail) => mail.to === human.email).map((mail) => mail.subject), ["A passkey was added to your Raft account"]);

    const list = await request(app.baseUrl, "GET", `${BASE}/passkeys`, undefined, token);
    assert.deepEqual(list.body, { passkeys: [passkey] });
    const status = await request(app.baseUrl, "GET", `${BASE}/status`, undefined, token);
    assert.deepEqual(status.body, { enabled: false, methods: { totp: false, passkeys: 1, backupCodesRemaining: 0 }, sessionVerified: false, recovery: null });

    const next = await registrationOptions(app.baseUrl, token);
    assert.deepEqual((next.excludeCredentials as Json[]).map((c) => c.id), [device.id]);
    // The same authenticator credential again: 409.
    const duplicate = await post(app.baseUrl, `${BASE}/passkeys/registration/verify`, { response: device.register(next) }, token);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "passkey_already_registered");
  } finally {
    emails.stop();
  }
});

test("registration is refused for a wrong origin, a wrong RP ID, no user verification, a replayed or foreign challenge", async ({ app, seed }) => {
  const human = await seed.human();
  const { token } = await signInForTest(human.id);
  const verify = (body: Json, as = token) => post(app.baseUrl, `${BASE}/passkeys/registration/verify`, body, as);

  for (const bent of [{ origin: "https://evil.test" }, { rpId: "evil.test" }, { userVerified: false }]) {
    const options = await registrationOptions(app.baseUrl, token);
    const res = await verify({ response: authenticator().register(options, bent) });
    assert.equal(res.status, 400, JSON.stringify(bent));
    assert.equal(res.body.code, "passkey_invalid");
  }

  // Replayed: the challenge is single use, even after a success.
  const options = await registrationOptions(app.baseUrl, token);
  const response = authenticator().register(options);
  assert.equal((await verify({ response })).status, 200);
  const replay = await verify({ response });
  assert.equal(replay.status, 410);
  assert.equal(replay.body.code, "challenge_expired");

  // Another sign-in of the same person cannot answer this one's challenge.
  const other = await signInForTest(human.id);
  const foreign = await registrationOptions(app.baseUrl, token);
  const stolen = await verify({ response: authenticator().register(foreign) }, other.token);
  assert.equal(stolen.status, 410);
  assert.equal((await storedPasskeys(human.id)).length, 1);

  // A `challenge` that is not the one signed: refused.
  const mismatch = await registrationOptions(app.baseUrl, token);
  const mismatched = await verify({ challenge: foreign.challenge, response: authenticator().register(mismatch) });
  assert.equal(mismatched.status, 410);
});

test("adding a passkey needs a recent sign-in with two-step verification off, and step-up with it on", async ({ app, seed }) => {
  const human = await seed.human();
  const { token, familyId } = await signInForTest(human.id);
  await getDb().update(sessionFamilies).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sessionFamilies.id, familyId));
  const stale = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, {}, token);
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, "reauth_required");

  const { secret } = await enrollSecondFactor(human.id);
  const noCode = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, {}, token);
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.code, "step_up_required");
  assert.deepEqual(noCode.body.methods, ["totp", "backup_code"]);
  await registerPasskey(app.baseUrl, token, authenticator(), { code: totpCode(secret) });
  assert.equal((await storedPasskeys(human.id)).length, 1);
});

test("rename and remove; the last factor stays while two-step verification is on", async ({ app, seed }) => {
  // Two-step verification on with a passkey and no authenticator app.
  const { human, session, device, passkeyId, backupCodes } = await enforcedWithPasskey(app.baseUrl, seed, { totp: false });
  const renamed = await request(app.baseUrl, "PATCH", `${BASE}/passkeys/${passkeyId}`, { name: "  Work laptop " }, session.token);
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body.passkey as Json).name, "Work laptop");
  const tooLong = await request(app.baseUrl, "PATCH", `${BASE}/passkeys/${passkeyId}`, { name: "x".repeat(65) }, session.token);
  assert.equal(tooLong.status, 400);

  const last = await request(app.baseUrl, "DELETE", `${BASE}/passkeys/${passkeyId}`, { backupCode: backupCodes[0] }, session.token);
  assert.equal(last.status, 409);
  assert.equal(last.body.code, "last_factor");
  const unused = await getDb().select().from(userBackupCodes).where(eq(userBackupCodes.userId, human.id));
  assert.equal(unused.filter((code) => code.usedAt).length, 0, "refused before any code is used");

  // With a second passkey the first can go: step-up inline with a passkey.
  const second = authenticator();
  const secondId = await registerPasskey(app.baseUrl, session.token, second, { backupCode: backupCodes[1] });
  const noStepUp = await request(app.baseUrl, "DELETE", `${BASE}/passkeys/${passkeyId}`, {}, session.token);
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.body.code, "step_up_required");
  const options = await stepUpOptions(app.baseUrl, session.token);
  const emails = captureEmails();
  try {
    const removed = await request(app.baseUrl, "DELETE", `${BASE}/passkeys/${passkeyId}`, { webauthn: device.assert(options) }, session.token);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body, { removed: true });
    assert.deepEqual(emails.deliveries.filter((mail) => mail.to === human.email).map((mail) => mail.subject), ["A passkey was removed from your Raft account"]);
  } finally {
    emails.stop();
  }
  const list = await request(app.baseUrl, "GET", `${BASE}/passkeys`, undefined, session.token);
  assert.deepEqual((list.body.passkeys as Json[]).map((p) => p.id), [secondId]);
  assert.equal((await auditsOf(human.id, "account.second_factor_passkey_removed")).length, 1);
  const gone = await request(app.baseUrl, "PATCH", `${BASE}/passkeys/${passkeyId}`, { name: "again" }, session.token);
  assert.equal(gone.status, 404);

  // Two-step verification off: removing needs no step-up, and the last one may go.
  const off = await seed.human();
  const offSession = await signInForTest(off.id);
  const offId = await registerPasskey(app.baseUrl, offSession.token, authenticator());
  const offRemoved = await request(app.baseUrl, "DELETE", `${BASE}/passkeys/${offId}`, undefined, offSession.token);
  assert.equal(offRemoved.status, 200);
  // Someone else's passkey is not found.
  const foreign = await request(app.baseUrl, "DELETE", `${BASE}/passkeys/${secondId}`, undefined, offSession.token);
  assert.equal(foreign.status, 404);
});

test("/verify with a passkey: same body as /login, family verified by passkey, use recorded; options are bound to the sign-in", async ({ app, seed }) => {
  const { human, device, passkeyId } = await enforcedWithPasskey(app.baseUrl, seed);
  const plain = await seed.human();
  const baseline = await post(app.baseUrl, "/api/auth/login", { email: plain.email, password: "password123" });

  const first = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  assert.equal(first.status, 200);
  assert.deepEqual(keys(first.body), ["challenge", "expiresAt", "maskedEmail", "methods", "secondFactorRequired"]);
  assert.deepEqual(first.body.methods, ["totp", "passkey", "backup_code"]);
  const challenge = first.body.challenge as string;

  // Options for another sign-in's challenge do not answer this one.
  const other = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  const otherOptions = await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge: other.body.challenge });
  assert.equal(otherOptions.status, 200);
  const crossed = await post(app.baseUrl, `${BASE}/verify`, { challenge, webauthn: device.assert(otherOptions.body.options as Options) });
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.code, "second_factor_code_invalid");

  const optionsRes = await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge });
  assert.equal(optionsRes.status, 200);
  const options = optionsRes.body.options as Options;
  assert.equal(options.rpId, RP_ID);
  assert.equal(options.userVerification, "required");
  assert.deepEqual((options.allowCredentials as Json[]).map((c) => c.id), [device.id]);

  // No user verification: refused (and that WebAuthn challenge is used up).
  const noUv = await post(app.baseUrl, `${BASE}/verify`, { challenge, webauthn: device.assert(options, { userVerified: false }) });
  assert.equal(noUv.status, 400);
  const retried = await post(app.baseUrl, `${BASE}/verify`, { challenge, webauthn: device.assert(options) });
  assert.equal(retried.status, 400, "a WebAuthn challenge answers once");

  const fresh = (await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge })).body.options as Options;
  const signedIn = await post(app.baseUrl, `${BASE}/verify`, { challenge, webauthn: device.assert(fresh) });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.deepEqual(keys(signedIn.body), keys(baseline.body));
  const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
  assert.equal(families.filter((family) => family.secondFactorMethod === "passkey").length, 1);
  const [row] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.id, passkeyId));
  assert.ok(row!.lastUsedAt);
  assert.equal(row!.signCount, 0, "a counter that stays 0 is fine");
  assert.equal((await auditsOf(human.id, "account.second_factor_passkey_counter_regressed")).length, 0);
  assert.equal((await auditsOf(human.id, "account.second_factor_backup_code_used")).length, 0, "a passkey is not a backup code");

  // The sign-in challenge is used: no more options for it.
  const after = await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge });
  assert.equal(after.status, 410);
});

test("a counter that does not go up is allowed, audited and emailed; the stored counter never goes down", async ({ app, seed }) => {
  const device = authenticator({ counter: 5, synced: false });
  const { human, session, passkeyId } = await enforcedWithPasskey(app.baseUrl, seed, { device });

  // Counting up: no signal.
  const up = await post(app.baseUrl, `${BASE}/step-up`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token)) }, session.token);
  assert.equal(up.status, 200);
  assert.equal((await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.id, passkeyId)))[0]!.signCount, 6);

  const emails = captureEmails();
  try {
    const login = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
    const challenge = login.body.challenge as string;
    const options = (await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge })).body.options as Options;
    const regressed = await post(app.baseUrl, `${BASE}/verify`, { challenge, webauthn: device.assert(options, { counter: 3 }) });
    assert.equal(regressed.status, 200, "allowed, never rejected");
    const audits = await auditsOf(human.id, "account.second_factor_passkey_counter_regressed");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]!.metadata, { passkeyId, storedCounter: 6, receivedCounter: 3, context: "sign_in", sessionFamilyId: null });
    assert.deepEqual(emails.deliveries.filter((mail) => mail.to === human.email).map((mail) => mail.subject), ["Check the passkeys on your Raft account"]);
  } finally {
    emails.stop();
  }
  assert.equal((await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.id, passkeyId)))[0]!.signCount, 6);
});

test("step-up and turning it off with a passkey; options are bound to the signed-in session", async ({ app, seed }) => {
  const { human, session, other, device } = await enforcedWithPasskey(app.baseUrl, seed);
  // Options from another sign-in do not step this one up.
  const foreign = await post(app.baseUrl, `${BASE}/step-up`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, other.token)) }, session.token);
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.code, "second_factor_code_invalid");
  // Wrong RP ID: refused.
  const wrongRp = await post(app.baseUrl, `${BASE}/step-up`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token), { rpId: "evil.test" }) }, session.token);
  assert.equal(wrongRp.status, 400);

  const stepped = await post(app.baseUrl, `${BASE}/step-up`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token)) }, session.token);
  assert.equal(stepped.status, 200);
  assert.deepEqual(stepped.body, { verified: true });
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, session.familyId));
  assert.equal(family!.secondFactorMethod, "passkey");

  const disabled = await post(app.baseUrl, `${BASE}/disable`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token)) }, session.token);
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body, { enabled: false });
  const [user] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, human.id));
  assert.equal(user!.requiredAt, null);
  assert.equal((await storedPasskeys(human.id)).length, 1, "passkeys stay");
  assert.equal((await auditsOf(human.id, "account.second_factor_backup_code_used")).length, 0, "no backup code was used");
});

test("turning it on with an existing passkey (A9): backup codes, this sign-in verified by passkey, others signed out", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await signInForTest(human.id);
  const elsewhere = await signInForTest(human.id);
  const device = authenticator();
  await registerPasskey(app.baseUrl, session.token, device);

  const enabled = await post(app.baseUrl, `${BASE}/enable`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token)) }, session.token);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal((enabled.body.backupCodes as string[]).length, 10);
  const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
  assert.equal(families.find((f) => f.id === session.familyId)!.secondFactorMethod, "passkey");
  assert.ok(families.find((f) => f.id === elsewhere.familyId)!.revokedAt);
  const refresh = (refreshToken: string) => post(app.baseUrl, "/api/auth/refresh", { refreshToken });
  const refreshedElsewhere = await refresh(elsewhere.refreshToken);
  assert.equal(refreshedElsewhere.status, 401);
  assert.equal(refreshedElsewhere.body.code, "session_revoked");
  assert.equal((await refresh(session.refreshToken)).status, 200);
  const status = await request(app.baseUrl, "GET", `${BASE}/status`, undefined, session.token);
  assert.deepEqual(status.body, { enabled: true, methods: { totp: false, passkeys: 1, backupCodesRemaining: 10 }, sessionVerified: true, recovery: null });
  const audits = await auditsOf(human.id, "account.second_factor_enabled");
  assert.equal((audits[0]!.metadata as Json).method, "passkey");
});

test("design §0: a passkey registered without two-step verification changes nothing at sign-in", async ({ app, seed }) => {
  const human = await seed.human();
  const plain = await seed.human();
  const { token } = await signInForTest(human.id);
  await registerPasskey(app.baseUrl, token, authenticator());

  const baseline = await post(app.baseUrl, "/api/auth/login", { email: plain.email, password: "password123" });
  const login = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  assert.equal(login.status, 200);
  assert.deepEqual(keys(login.body), keys(baseline.body));
  assert.ok(login.body.accessToken);
  const loggedIn = await getDb().select().from(sessions).where(eq(sessions.userId, human.id));
  assert.ok(loggedIn.length >= 2);
  // No sign-in challenge was made for them.
  const challenges = await getDb().select().from(authChallenges)
    .where(and(eq(authChallenges.userId, human.id), eq(authChallenges.kind, "second_factor_login")));
  assert.equal(challenges.length, 0);
});

async function storedHandle(userId: string) {
  const [row] = await getDb().select({ handle: users.webauthnUserHandle }).from(users).where(eq(users.id, userId));
  return row!.handle ? Buffer.from(row!.handle) : null;
}

test("user handle: 32 random bytes stored at the first registration, then the same every time, whatever JWT_SECRET becomes", async ({ app, seed }) => {
  const human = await seed.human();
  const { token, familyId } = await signInForTest(human.id);
  assert.equal(await storedHandle(human.id), null, "nothing until they start registering one");

  const options = await registrationOptions(app.baseUrl, token);
  const stored = await storedHandle(human.id);
  assert.equal(stored?.length, 32);
  assert.equal((options.user as Json).id, stored!.toString("base64url"));
  assert.equal(stored!.equals(legacyWebauthnUserHandle(human.id)), false, "not derived from the id");
  await post(app.baseUrl, `${BASE}/passkeys/registration/verify`, { response: authenticator().register(options) }, token);

  const savedSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "a-rotated-jwt-secret-for-the-handle-test-0123456789";
  try {
    const rotatedToken = signAccessToken(human.id, familyId);
    const again = await registrationOptions(app.baseUrl, rotatedToken);
    assert.equal((again.user as Json).id, stored!.toString("base64url"));
    assert.ok((await storedHandle(human.id))!.equals(stored!));
  } finally {
    process.env.JWT_SECRET = savedSecret;
  }
  // Another person gets another handle.
  const someone = await seed.human();
  await registrationOptions(app.baseUrl, (await signInForTest(someone.id)).token);
  assert.equal((await storedHandle(someone.id))!.equals(stored!), false);
});

test("user handle backfill: someone with passkeys from before the column keeps the HMAC handle they were registered under", async ({ app, seed }) => {
  const human = await seed.human();
  const { token } = await signInForTest(human.id);
  const device = authenticator();
  await registerPasskey(app.baseUrl, token, device);
  // As a staging account that registered before webauthn_user_handle existed.
  await getDb().update(users).set({ webauthnUserHandle: null }).where(eq(users.id, human.id));

  const options = await registrationOptions(app.baseUrl, token);
  const legacy = legacyWebauthnUserHandle(human.id);
  assert.equal((options.user as Json).id, legacy.toString("base64url"));
  assert.ok((await storedHandle(human.id))!.equals(legacy));
  assert.deepEqual((options.excludeCredentials as Json[]).map((c) => c.id), [device.id]);
});

test("adding a passkey with two-step verification on: a passkey bound to this sign-in answers the step-up, no backup code spent", async ({ app, seed }) => {
  const { human, session, other, device } = await enforcedWithPasskey(app.baseUrl, seed, { totp: false });
  const unused = async () => (await getDb().select().from(userBackupCodes).where(eq(userBackupCodes.userId, human.id))).filter((code) => !code.usedAt).length;
  const before = await unused();

  const asked = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, {}, session.token);
  assert.equal(asked.status, 403);
  assert.equal(asked.body.code, "step_up_required");
  assert.deepEqual(asked.body.methods, ["passkey", "backup_code"]);

  // An assertion bound to another of their sign-ins does not answer this one.
  const foreign = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, other.token)) }, session.token);
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.code, "second_factor_code_invalid");
  // No user verification: refused.
  const noUv = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token), { userVerified: false }) }, session.token);
  assert.equal(noUv.status, 400);

  const second = authenticator();
  await registerPasskey(app.baseUrl, session.token, second, { webauthn: device.assert(await stepUpOptions(app.baseUrl, session.token)) });
  assert.equal((await storedPasskeys(human.id)).filter((row) => !row.revokedAt).length, 2);
  assert.equal(await unused(), before, "no backup code spent");
});
