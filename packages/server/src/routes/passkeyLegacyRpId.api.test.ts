// Passkeys move from RP ID raft.build to app.raft.build (WEBAUTHN_LEGACY_RP_ID,
// services/secondFactor/webauthn.ts): passkeys registered under the old RP ID
// keep working and are kept (never swapped for a new one), and every new one
// is registered under the new one (services/secondFactor/passkeyManagement.ts).
// Here `raft.test` plays raft.build and `app.raft.test` app.raft.build.
// Every ceremony is a real WebAuthn response from the software authenticator.
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { authChallenges, integrationAuditEvents, webauthnCredentials } from "../db/schema";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";
import { SoftwareAuthenticator } from "../test/integration/softwareAuthenticator";
import { androidApkKeyHashOrigin } from "../services/secondFactor/webauthn";

const test = createApiTest();
useTotpSecretKey();

const LEGACY_RP_ID = "raft.test";
const RP_ID = "app.raft.test";
const ORIGIN = "https://app.raft.test";
// What https://raft.build is to production: on the legacy RP ID, never an allowed origin.
const LEGACY_ORIGIN = "https://raft.test";
const ANDROID_CERT_SHA256 = Array.from({ length: 32 }, (_, i) => (i * 5 + 1).toString(16).padStart(2, "0").toUpperCase()).join(":");
const ANDROID_ORIGIN = androidApkKeyHashOrigin(ANDROID_CERT_SHA256);
const ENV = {
  APP_URL: ORIGIN,
  WEBAUTHN_RP_ID: LEGACY_RP_ID,
  WEBAUTHN_ORIGINS: ORIGIN,
  WEBAUTHN_ANDROID_APK_KEY_HASHES: ANDROID_CERT_SHA256,
  WEBAUTHN_LEGACY_RP_ID: undefined as string | undefined,
} as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
/** As production is today: everything under the old RP ID, no legacy one. */
const beforeMove = () => setEnv({ ...ENV, WEBAUTHN_RP_ID: LEGACY_RP_ID, WEBAUTHN_LEGACY_RP_ID: undefined });
/** After the move. */
const afterMove = () => setEnv({ ...ENV, WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_LEGACY_RP_ID: LEGACY_RP_ID });

beforeEach(beforeMove);
afterAll(() => setEnv(previousEnv));

type Human = { id: string; email: string };
type Json = Record<string, unknown>;
type Options = { challenge: string } & Json;

const BASE = "/api/auth/second-factor";

async function post(baseUrl: string, path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json };
}

const keys = (body: Json) => Object.keys(body).sort();

async function passkeyRow(id: string) {
  const [row] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.id, id));
  return row!;
}

async function registerPasskey(baseUrl: string, token: string, device: SoftwareAuthenticator, answer: Json = {}) {
  const options = await post(baseUrl, `${BASE}/passkeys/registration/options`, answer, token);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const res = await post(baseUrl, `${BASE}/passkeys/registration/verify`, { response: device.register(options.body.options as Options) }, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.passkey as Json).id as string;
}

/**
 * Someone whose passkey was registered before the move (under the old RP ID),
 * then the move. `preColumn`: the row is from before `rp_id` existed (NULL).
 */
async function withLegacyPasskey(
  baseUrl: string,
  seed: { human(): Promise<Human> },
  options: { synced?: boolean; preColumn?: boolean; enforced?: boolean } = {},
) {
  beforeMove();
  const human = await seed.human();
  const session = await signInForTest(human.id);
  const legacy = new SoftwareAuthenticator(LEGACY_RP_ID, ORIGIN, { synced: options.synced ?? true });
  const legacyId = await registerPasskey(baseUrl, session.token, legacy);
  assert.equal((await passkeyRow(legacyId)).rpId, LEGACY_RP_ID, "registered under the RP ID of its time");
  if (options.preColumn) await getDb().update(webauthnCredentials).set({ rpId: null }).where(eq(webauthnCredentials.id, legacyId));
  const enrolled = options.enforced === false ? { secret: "", backupCodes: [] as string[] } : await enrollSecondFactor(human.id);
  afterMove();
  return { human, session, legacy, legacyId, ...enrolled };
}

async function stepUpOptions(baseUrl: string, token: string, rp?: string) {
  return post(baseUrl, `${BASE}/passkeys/assertion/options`, rp === undefined ? {} : { rp }, token);
}

async function stepUpWith(baseUrl: string, token: string, device: SoftwareAuthenticator, rp?: string, bend: Parameters<SoftwareAuthenticator["assert"]>[1] = {}) {
  const options = await stepUpOptions(baseUrl, token, rp);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  return post(baseUrl, `${BASE}/step-up`, { webauthn: device.assert(options.body.options as Options, bend) }, token);
}

test("mixed old and new passkeys: options offer one RP group (current first), `rp` picks one, a group with none is a clear 404", async ({ app, seed }) => {
  const { human, session, legacy, legacyId, backupCodes } = await withLegacyPasskey(app.baseUrl, seed, { preColumn: true });

  // Only the legacy one (its row predates rp_id: NULL is the legacy RP ID).
  const onlyLegacy = await stepUpOptions(app.baseUrl, session.token);
  assert.equal(onlyLegacy.status, 200);
  assert.equal(onlyLegacy.body.rp, "legacy");
  assert.equal((onlyLegacy.body.options as Json).rpId, LEGACY_RP_ID);
  assert.equal(onlyLegacy.body.otherRps, undefined, "no other group: no otherRps");
  assert.deepEqual(((onlyLegacy.body.options as Json).allowCredentials as Json[]).map((c) => c.id), [legacy.id]);
  const [challenge] = await getDb().select().from(authChallenges)
    .where(and(eq(authChallenges.userId, human.id), eq(authChallenges.kind, "webauthn_assertion"), isNull(authChallenges.consumedAt)));
  assert.equal(challenge!.payload?.rpId, LEGACY_RP_ID, "the challenge records its RP ID");
  // iOS asks for the current group only: nothing there, and it is told what is.
  const askCurrent = await stepUpOptions(app.baseUrl, session.token, "current");
  assert.equal(askCurrent.status, 404);
  assert.equal(askCurrent.body.code, "passkey_rp_unavailable");
  assert.equal(askCurrent.body.rp, "current");
  assert.deepEqual(askCurrent.body.availableRps, ["legacy"]);
  const bogus = await stepUpOptions(app.baseUrl, session.token, "raft.test");
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.code, "invalid_request");

  // A new one: under the current RP ID only.
  const fresh = new SoftwareAuthenticator(RP_ID, ORIGIN, { synced: false });
  const registration = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, { backupCode: backupCodes[0] }, session.token);
  assert.equal(((registration.body.options as Json).rp as Json).id, RP_ID);
  assert.deepEqual((registration.body.options as Json).excludeCredentials, [], "legacy passkeys cannot collide with a new RP ID");
  const wrongRp = await post(app.baseUrl, `${BASE}/passkeys/registration/verify`, {
    response: new SoftwareAuthenticator(LEGACY_RP_ID, ORIGIN).register(registration.body.options as Options),
  }, session.token);
  assert.equal(wrongRp.body.code, "passkey_invalid", "never registered under the legacy RP ID");
  const freshId = await registerPasskey(app.baseUrl, session.token, fresh, { backupCode: backupCodes[1] });
  assert.equal((await passkeyRow(freshId)).rpId, RP_ID);

  // Both: current by default, legacy when asked; each answers in its own group.
  const byDefault = await stepUpOptions(app.baseUrl, session.token);
  assert.equal(byDefault.body.rp, "current");
  assert.equal((byDefault.body.options as Json).rpId, RP_ID);
  assert.deepEqual(byDefault.body.otherRps, ["legacy"], "names the other group only, never credential ids");
  assert.deepEqual(((byDefault.body.options as Json).allowCredentials as Json[]).map((c) => c.id), [fresh.id]);
  const steppedNew = await stepUpWith(app.baseUrl, session.token, fresh);
  assert.equal(steppedNew.status, 200, JSON.stringify(steppedNew.body));
  assert.deepEqual(steppedNew.body, { verified: true });
  const steppedOld = await stepUpWith(app.baseUrl, session.token, legacy, "legacy");
  assert.equal(steppedOld.status, 200, JSON.stringify(steppedOld.body));
  assert.deepEqual(steppedOld.body, { verified: true });
  assert.ok((await passkeyRow(legacyId)).lastUsedAt);

  // The second step of a sign-in groups the same way.
  const login = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  const signInOptions = await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge: login.body.challenge, rp: "legacy" });
  assert.equal(signInOptions.status, 200);
  assert.equal((signInOptions.body.options as Json).rpId, LEGACY_RP_ID);
  assert.equal(signInOptions.body.rp, "legacy");
  assert.deepEqual(signInOptions.body.otherRps, ["current"]);
  // Never on the anonymous passkey sign-in.
  const anonymous = await post(app.baseUrl, "/api/auth/passkey/options", {});
  assert.equal(anonymous.body.otherRps, undefined);
});

test("a challenge answers only in the RP group it was issued for", async ({ app, seed }) => {
  const { session, legacy, backupCodes } = await withLegacyPasskey(app.baseUrl, seed);
  const fresh = new SoftwareAuthenticator(RP_ID, ORIGIN);
  await registerPasskey(app.baseUrl, session.token, fresh, { backupCode: backupCodes[0] });

  // Current-group options answered by the legacy passkey (signing for its own RP ID, or claiming the new one).
  for (const bend of [{}, { rpId: RP_ID }]) {
    const res = await stepUpWith(app.baseUrl, session.token, legacy, "current", bend);
    assert.equal(res.status, 400, JSON.stringify(bend));
    assert.equal(res.body.code, "second_factor_code_invalid");
  }
  // Legacy-group options answered by the new passkey.
  for (const bend of [{}, { rpId: LEGACY_RP_ID }]) {
    const res = await stepUpWith(app.baseUrl, session.token, fresh, "legacy", bend);
    assert.equal(res.status, 400, JSON.stringify(bend));
  }
  // Passkey sign-in: a current challenge does not take the legacy passkey.
  const current = (await post(app.baseUrl, "/api/auth/passkey/options", {})).body.options as Options;
  const crossed = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: current.challenge, response: legacy.assert(current) });
  assert.equal(crossed.status, 401);
  assert.equal(crossed.body.code, "passkey_not_recognized");
  const old = (await post(app.baseUrl, "/api/auth/passkey/options", { rp: "legacy" })).body.options as Options;
  const crossedBack = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: old.challenge, response: fresh.assert(old, { rpId: LEGACY_RP_ID }) });
  assert.equal(crossedBack.status, 401);
});

test("origins stay the allow-list: https://<legacy RP ID> is refused under both RP IDs; the Android app passes under both", async ({ app, seed }) => {
  const { session, legacy, backupCodes } = await withLegacyPasskey(app.baseUrl, seed);
  const fresh = new SoftwareAuthenticator(RP_ID, ORIGIN);
  await registerPasskey(app.baseUrl, session.token, fresh, { backupCode: backupCodes[0] });

  for (const [device, rp] of [[legacy, "legacy"], [fresh, "current"]] as const) {
    const refused = await stepUpWith(app.baseUrl, session.token, device, rp, { origin: LEGACY_ORIGIN });
    assert.equal(refused.status, 400, rp);
    const signInOptions = (await post(app.baseUrl, "/api/auth/passkey/options", { rp })).body.options as Options;
    const signIn = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: signInOptions.challenge, response: device.assert(signInOptions, { origin: LEGACY_ORIGIN }) });
    assert.equal(signIn.status, 401, rp);

    const android = await stepUpWith(app.baseUrl, session.token, device, rp, { origin: ANDROID_ORIGIN });
    assert.equal(android.status, 200, `${rp}: ${JSON.stringify(android.body)}`);
    assert.deepEqual(android.body, { verified: true }, rp);
  }
});

test("passkey sign-in: current RP ID by default, the legacy one when asked", async ({ app, seed }) => {
  const { legacy, legacyId } = await withLegacyPasskey(app.baseUrl, seed, { enforced: false });

  const current = await post(app.baseUrl, "/api/auth/passkey/options", {});
  assert.equal(current.status, 200);
  assert.deepEqual(keys(current.body), ["expiresAt", "options", "rp"]);
  assert.equal(current.body.rp, "current");
  assert.equal((current.body.options as Json).rpId, RP_ID);
  const old = await post(app.baseUrl, "/api/auth/passkey/options", { rp: "legacy" });
  assert.equal(old.body.rp, "legacy");
  assert.equal((old.body.options as Json).rpId, LEGACY_RP_ID);
  assert.equal((await post(app.baseUrl, "/api/auth/passkey/options", { rp: "x" })).status, 400);

  const signedIn = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: (old.body.options as Options).challenge, response: legacy.assert(old.body.options as Options) });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.ok((await passkeyRow(legacyId)).lastUsedAt);
});

test("a synced legacy passkey that answers from the web is kept: no swap offer after step-up, the second step or passkey sign-in", async ({ app, seed }) => {
  const { human, session, legacy, legacyId } = await withLegacyPasskey(app.baseUrl, seed);
  const registrationChallenges = async () => (await getDb().select({ id: authChallenges.id }).from(authChallenges)
    .where(and(eq(authChallenges.userId, human.id), eq(authChallenges.kind, "webauthn_registration")))).length;
  const challengesBefore = await registrationChallenges();

  const stepped = await stepUpWith(app.baseUrl, session.token, legacy);
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.deepEqual(stepped.body, { verified: true });

  const login = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  const challenge = login.body.challenge as string;
  const options = (await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge })).body.options as Options;
  assert.equal(options.rpId, LEGACY_RP_ID, "only legacy passkeys: the legacy group by default");
  const secondStep = await post(app.baseUrl, `${BASE}/verify`, { challenge, webauthn: legacy.assert(options) });
  assert.equal(secondStep.status, 200, JSON.stringify(secondStep.body));

  const old = (await post(app.baseUrl, "/api/auth/passkey/options", { rp: "legacy" })).body.options as Options;
  const passkeySignedIn = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: old.challenge, response: legacy.assert(old) });
  assert.equal(passkeySignedIn.status, 200, JSON.stringify(passkeySignedIn.body));

  for (const body of [secondStep.body, passkeySignedIn.body]) {
    assert.equal(body.swapSuggested, undefined, JSON.stringify(body));
    assert.equal(body.passkeySwap, undefined, JSON.stringify(body));
  }
  assert.equal(await registrationChallenges(), challengesBefore, "no registration offered");
  const row = await passkeyRow(legacyId);
  assert.equal(row.revokedAt, null, "still active");
  assert.equal(row.rpId, LEGACY_RP_ID);
  const removed = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.second_factor_passkey_removed")));
  assert.equal(removed.length, 0);
  // And it keeps answering.
  assert.deepEqual((await stepUpWith(app.baseUrl, session.token, legacy)).body, { verified: true });
});

test("legacy RP ID unset: as before (no `rp` in bodies or challenges, NULL rows are the RP ID); `rp: legacy` is refused", async ({ app, seed }) => {
  const human = await seed.human();
  const session = await signInForTest(human.id);
  const device = new SoftwareAuthenticator(LEGACY_RP_ID, ORIGIN);
  const passkeyId = await registerPasskey(app.baseUrl, session.token, device);
  await getDb().update(webauthnCredentials).set({ rpId: null }).where(eq(webauthnCredentials.id, passkeyId));
  await enrollSecondFactor(human.id);

  const options = await stepUpOptions(app.baseUrl, session.token);
  assert.deepEqual(keys(options.body), ["options"]);
  assert.equal((options.body.options as Json).rpId, LEGACY_RP_ID);
  const rows = await getDb().select().from(authChallenges).where(and(eq(authChallenges.userId, human.id), eq(authChallenges.kind, "webauthn_assertion")));
  assert.deepEqual(rows.map((row) => row.payload), [{ familyId: session.familyId }]);
  const stepped = await post(app.baseUrl, `${BASE}/step-up`, { webauthn: device.assert(options.body.options as Options) }, session.token);
  assert.deepEqual(stepped.body, { verified: true });

  const signIn = await post(app.baseUrl, "/api/auth/passkey/options", {});
  assert.deepEqual(keys(signIn.body), ["expiresAt", "options"]);
  const signInOptions = signIn.body.options as Options;
  const passkeySignedIn = await post(app.baseUrl, "/api/auth/passkey/verify", { challenge: signInOptions.challenge, response: device.assert(signInOptions) });
  assert.equal(passkeySignedIn.status, 200, JSON.stringify(passkeySignedIn.body));

  const login = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
  const secondStep = (await post(app.baseUrl, `${BASE}/passkeys/assertion/options`, { challenge: login.body.challenge })).body;
  assert.deepEqual(keys(secondStep), ["options"]);
  const secondStepSignedIn = await post(app.baseUrl, `${BASE}/verify`, { challenge: login.body.challenge, webauthn: device.assert(secondStep.options as Options) });
  assert.equal(secondStepSignedIn.status, 200, JSON.stringify(secondStepSignedIn.body));
  const legacy = await post(app.baseUrl, "/api/auth/passkey/options", { rp: "legacy" });
  assert.equal(legacy.status, 404);
  assert.equal(legacy.body.code, "passkey_rp_unavailable");
  const askLegacy = await stepUpOptions(app.baseUrl, session.token, "legacy");
  assert.equal(askLegacy.status, 404);
  assert.deepEqual(askLegacy.body.availableRps, ["current"]);
});

test("registration under the current RP ID requires user verification: options ask for it, an answer without it is refused", async ({ app, seed }) => {
  const synced = await withLegacyPasskey(app.baseUrl, seed);
  const normal = await post(app.baseUrl, `${BASE}/passkeys/registration/options`, { backupCode: synced.backupCodes[0] }, synced.session.token);
  assert.equal(((normal.body.options as Json).authenticatorSelection as Json).userVerification, "required");
  const noUv = await post(app.baseUrl, `${BASE}/passkeys/registration/verify`, {
    response: new SoftwareAuthenticator(RP_ID, ORIGIN).register(normal.body.options as Options, { userVerified: false }),
  }, synced.session.token);
  assert.equal(noUv.body.code, "passkey_invalid");
});
