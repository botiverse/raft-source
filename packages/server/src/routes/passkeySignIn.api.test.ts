// PR 4b of passkeys + two-step verification (design v8 §1, §2 D3, §5, §7):
// signing in with a passkey alone (POST /api/auth/passkey/options and
// /verify). Every assertion is a real WebAuthn response from a software
// authenticator (test/integration/softwareAuthenticator.ts) checked by the
// server's verifier. A passkey is both factors: someone with two-step
// verification on gets in without a second step; anyone passkey sign-in is
// not open to (retired) looks exactly like an unknown passkey.
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { authChallenges, integrationAuditEvents, secondFactorAttemptWindows, sessionFamilies, users, webauthnCredentials } from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";
import { SoftwareAuthenticator } from "../test/integration/softwareAuthenticator";

const test = createApiTest();
useTotpSecretKey();

const RP_ID = "raft.test";
const ORIGIN = "https://app.raft.test";
const ENV = {
  APP_URL: ORIGIN,
  WEBAUTHN_RP_ID: RP_ID,
  WEBAUTHN_ORIGINS: ORIGIN,
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "passkey-sign-in-test-pepper-0123456789",
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

function authenticator(options?: ConstructorParameters<typeof SoftwareAuthenticator>[2]) {
  return new SoftwareAuthenticator(RP_ID, ORIGIN, options);
}

/** `human` with `device` registered through the API. */
async function withPasskey(baseUrl: string, human: Human, device = authenticator()) {
  const { token } = await signInForTest(human.id);
  const options = (await post(baseUrl, "/api/auth/second-factor/passkeys/registration/options", {}, token)).body.options as Options;
  const res = await post(baseUrl, "/api/auth/second-factor/passkeys/registration/verify", { response: device.register(options) }, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { device, passkeyId: (res.body.passkey as Json).id as string };
}

async function signInOptions(baseUrl: string): Promise<Options> {
  const res = await post(baseUrl, "/api/auth/passkey/options", {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.options as Options;
}

async function signInWith(baseUrl: string, device: SoftwareAuthenticator, bend: Parameters<SoftwareAuthenticator["assert"]>[1] = {}) {
  const options = await signInOptions(baseUrl);
  return post(baseUrl, "/api/auth/passkey/verify", { challenge: options.challenge, response: device.assert(options, bend) });
}

const NOT_RECOGNIZED = { error: "That passkey wasn't recognized. Try another way to sign in.", code: "passkey_not_recognized" };

test("options: discoverable (no allowCredentials), user verification required, a single-use challenge bound to no one; 404 (not a 5xx) without a relying party", async ({ app }) => {
  const res = await post(app.baseUrl, "/api/auth/passkey/options", {});
  assert.equal(res.status, 200);
  assert.deepEqual(keys(res.body), ["expiresAt", "options"]);
  const options = res.body.options as Options;
  assert.equal(options.rpId, RP_ID);
  assert.equal(options.userVerification, "required");
  assert.equal(((options.allowCredentials as unknown[] | undefined) ?? []).length, 0);
  const [row] = await getDb().select().from(authChallenges).where(eq(authChallenges.flow, "passkey_login"));
  assert.equal(row!.kind, "webauthn_assertion");
  assert.equal(row!.userId, null);
  assert.equal(row!.payload, null);
  assert.equal(row!.expiresAt.getTime() - row!.createdAt.getTime(), 5 * 60_000);

  const saved = { rp: process.env.WEBAUTHN_RP_ID, origins: process.env.WEBAUTHN_ORIGINS };
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGINS;
  try {
    for (const path of ["/api/auth/passkey/options", "/api/auth/passkey/verify"]) {
      const body = path.endsWith("verify") ? { challenge: options.challenge, response: authenticator().assert(options) } : {};
      const off = await post(app.baseUrl, path, body);
      assert.equal(off.status, 404, path);
      assert.equal(off.body.code, "passkeys_unavailable");
    }
  } finally {
    process.env.WEBAUTHN_RP_ID = saved.rp;
    process.env.WEBAUTHN_ORIGINS = saved.origins;
  }
});

test("signs in with the same body as /login; the tokens work; the family is verified by passkey; the use is recorded", async ({ app, seed }) => {
  const human = await seed.human();
  const { device, passkeyId } = await withPasskey(app.baseUrl, human);
  const baseline = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  assert.equal(baseline.status, 200);

  const signedIn = await signInWith(app.baseUrl, device);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.deepEqual(keys(signedIn.body), keys(baseline.body));
  assert.deepEqual(signedIn.body.user, baseline.body.user);
  const me = await request(app.baseUrl, "GET", "/api/auth/me", undefined, signedIn.body.accessToken as string);
  assert.equal(me.status, 200);
  const refreshed = await post(app.baseUrl, "/api/auth/refresh", { refreshToken: signedIn.body.refreshToken });
  assert.equal(refreshed.status, 200);

  const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
  const verified = families.filter((family) => family.secondFactorMethod === "passkey");
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.scope, "full");
  assert.ok(verified[0]!.secondFactorVerifiedAt);
  const [row] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.id, passkeyId));
  assert.ok(row!.lastUsedAt);
});

test("two-step verification on: a passkey signs in without a second step, even while the second-step lock is on", async ({ app, seed }) => {
  const human = await seed.human();
  const { device } = await withPasskey(app.baseUrl, human);
  await enrollSecondFactor(human.id);
  const password = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  assert.equal(password.body.secondFactorRequired, true, "the password alone still asks for a second step");

  // Locked by wrong second steps after a password (design §3: never blocks passkey sign-in).
  await getDb().insert(secondFactorAttemptWindows).values({ userId: human.id, windowStartedAt: new Date(), attempts: 10, lockedUntil: new Date(Date.now() + 15 * 60_000) });
  const signedIn = await signInWith(app.baseUrl, device);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.ok(signedIn.body.accessToken);
  assert.equal(signedIn.body.secondFactorRequired, undefined);
  const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
  assert.equal(families.filter((family) => family.secondFactorMethod === "passkey").length, 1);
});

test("a challenge answers once: a replay, or a retry after a failed answer, is refused", async ({ app, seed }) => {
  const human = await seed.human();
  const { device } = await withPasskey(app.baseUrl, human);
  const options = await signInOptions(app.baseUrl);
  const response = device.assert(options);
  assert.equal((await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: options.challenge, response })).status, 200);
  const replay = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: options.challenge, response });
  assert.equal(replay.status, 410);
  assert.equal(replay.body.code, "challenge_expired");

  const next = await signInOptions(app.baseUrl);
  const failed = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: next.challenge, response: device.assert(next, { userVerified: false }) });
  assert.deepEqual(failed.body, NOT_RECOGNIZED);
  const retried = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: next.challenge, response: device.assert(next) });
  assert.equal(retried.status, 410);

  // A step-up assertion challenge (bound to a person) is not a sign-in challenge.
  const { token } = await signInForTest(human.id);
  const stepUp = (await post(app.baseUrl, "/api/auth/second-factor/passkeys/assertion/options", {}, token)).body.options as Options;
  const crossed = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: stepUp.challenge, response: device.assert(stepUp) });
  assert.equal(crossed.status, 410);
});

test("unknown, removed and retired look the same: passkey_not_recognized", async ({ app, seed }) => {
  const refusals: Json[] = [];
  const unknown = await signInWith(app.baseUrl, authenticator());
  assert.equal(unknown.status, 401);
  refusals.push(unknown.body);

  const removed = await seed.human();
  const removedPasskey = await withPasskey(app.baseUrl, removed);
  await getDb().update(webauthnCredentials).set({ revokedAt: new Date() }).where(eq(webauthnCredentials.id, removedPasskey.passkeyId));
  refusals.push((await signInWith(app.baseUrl, removedPasskey.device)).body);

  const retired = await seed.human();
  const retiredPasskey = await withPasskey(app.baseUrl, retired);
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));
  refusals.push((await signInWith(app.baseUrl, retiredPasskey.device)).body);

  for (const body of refusals) assert.deepEqual(body, NOT_RECOGNIZED);
  for (const person of [removed, retired]) {
    const families = await getDb().select().from(sessionFamilies).where(and(eq(sessionFamilies.userId, person.id), eq(sessionFamilies.secondFactorMethod, "passkey")));
    assert.equal(families.length, 0);
  }
});

test("wrong origin, wrong RP ID, no user verification, a signature by another key: refused", async ({ app, seed }) => {
  const human = await seed.human();
  const { device } = await withPasskey(app.baseUrl, human);
  for (const bent of [{ origin: "https://evil.test" }, { rpId: "evil.test" }, { userVerified: false }]) {
    const res = await signInWith(app.baseUrl, device, bent);
    assert.deepEqual(res.body, NOT_RECOGNIZED, JSON.stringify(bent));
  }
  // Same credential id, a different private key.
  const impostor = authenticator();
  Object.defineProperty(impostor, "credentialId", { value: device.credentialId });
  assert.deepEqual((await signInWith(app.baseUrl, impostor)).body, NOT_RECOGNIZED);
  const families = await getDb().select().from(sessionFamilies).where(and(eq(sessionFamilies.userId, human.id), eq(sessionFamilies.secondFactorMethod, "passkey")));
  assert.equal(families.length, 0);
});

test("a counter that does not go up signs in, audited and emailed", async ({ app, seed }) => {
  const human = await seed.human();
  const { device, passkeyId } = await withPasskey(app.baseUrl, human, authenticator({ counter: 5, synced: false }));
  assert.equal((await signInWith(app.baseUrl, device)).status, 200);
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  try {
    const regressed = await signInWith(app.baseUrl, device, { counter: 2 });
    assert.equal(regressed.status, 200, "allowed, never rejected");
  } finally {
    __setEmailDeliveryObserverForTests(null);
  }
  const audits = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.second_factor_passkey_counter_regressed")));
  assert.deepEqual(audits.map((audit) => audit.metadata), [{ passkeyId, storedCounter: 6, receivedCounter: 2, context: "passkey_sign_in", sessionFamilyId: null }]);
  assert.deepEqual(deliveries.filter((mail) => mail.to === human.email).map((mail) => mail.subject), ["Check the passkeys on your Raft account"]);
  const [row] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.id, passkeyId));
  assert.equal(row!.signCount, 6, "never goes down");
});

test("design §0: password sign-in is unchanged for someone without two-step verification and for someone with a passkey but two-step verification off", async ({ app, seed }) => {
  const plain = await seed.human();
  const withKey = await seed.human();
  await withPasskey(app.baseUrl, withKey);
  for (const person of [plain, withKey]) {
    const login = await post(app.baseUrl, "/api/auth/login", { email: person.email, password: "password123" });
    assert.equal(login.status, 200);
    assert.deepEqual(keys(login.body), ["accessToken", "refreshToken", "user"]);
  }
  const challenges = await getDb().select().from(authChallenges).where(eq(authChallenges.kind, "second_factor_login"));
  assert.equal(challenges.length, 0);
});
