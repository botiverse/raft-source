// App step-up with a legacy passkey on the web (services/appStepUpService.ts,
// docs/contracts/app-web-step-up.md): the app's own sign-in is marked verified
// only when the app redeems the code, with its own bearer (same sign-in and
// person), its PKCE verifier and a fresh single-use code; as of the passkey's
// time. The login routes never see a step-up row. Every ceremony is a real
// WebAuthn response from the software authenticator; `raft.test` plays
// raft.build (the legacy RP ID) and `app.raft.test` app.raft.build.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { appLoginRequests, authChallenges, featureFlags, sessionFamilies, webauthnCredentials } from "../db/schema";
import { createAgent } from "../services/agentService";
import { APP_WEB_STEP_UP_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { androidApkKeyHashOrigin } from "../services/secondFactor/webauthn";
import { completeAppStepUp } from "../services/appStepUpService";
import { revokeSessionFamilyInTransaction } from "../services/sessionService";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";
import { SoftwareAuthenticator } from "../test/integration/softwareAuthenticator";

const test = createApiTest();
useTotpSecretKey();

const LEGACY_RP_ID = "raft.test";
const RP_ID = "app.raft.test";
const ORIGIN = "https://app.raft.test";
const ANDROID_CERT_SHA256 = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, "0").toUpperCase()).join(":");
const ANDROID_ORIGIN = androidApkKeyHashOrigin(ANDROID_CERT_SHA256);
const ENV = {
  APP_URL: ORIGIN,
  WEBAUTHN_RP_ID: LEGACY_RP_ID,
  WEBAUTHN_ORIGINS: ORIGIN,
  WEBAUTHN_ANDROID_APK_KEY_HASHES: ANDROID_CERT_SHA256,
  WEBAUTHN_LEGACY_RP_ID: undefined as string | undefined,
  APP_LOGIN_RETURN_URIS: undefined as string | undefined,
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "app-step-up-test-pepper-0123456789abcdef",
} as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
const beforeMove = () => setEnv({ ...ENV, WEBAUTHN_RP_ID: LEGACY_RP_ID, WEBAUTHN_LEGACY_RP_ID: undefined });
const afterMove = () => setEnv({ ...ENV, WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_LEGACY_RP_ID: LEGACY_RP_ID });
beforeEach(beforeMove);
afterAll(() => setEnv(previousEnv));

type Json = Record<string, any>;
type Res = { status: number; body: Json; headers: Headers };
type Options = { challenge: string } & Json;

const RETURN_URI = "raft://login/callback";
const MAC_RETURN_URI = "raft-mac://login/callback";
const BASE = "/api/auth/app-login";
const MINUTE = 60_000;

async function call(baseUrl: string, method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json, headers: res.headers };
}
const post = (baseUrl: string, path: string, body?: unknown, token?: string) => call(baseUrl, "POST", path, body, token);
const get = (baseUrl: string, path: string, token?: string) => call(baseUrl, "GET", path, undefined, token);

async function setFlag(on: boolean) {
  const values = { enabled: true, killSwitch: !on, defaultEnabled: true };
  await getDb().insert(featureFlags).values({ key: APP_WEB_STEP_UP_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "app-step-up-test", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });
}

/**
 * A person with two-step verification on and only a legacy passkey
 * (registered before the RP ID move), signed in to the app (`app`) and on
 * another device (`other`), neither verified; an external agent of theirs
 * (minting its key is step-up gated).
 */
async function person(baseUrl: string, seed: { human(values?: Json): Promise<any>; server(input: { owner: any }): Promise<{ id: string }> }) {
  beforeMove();
  const human = await seed.human({ passwordCredentialEstablishedAt: new Date() });
  const server = await seed.server({ owner: human });
  const agent = await createAgent(server.id, `ext-${human.id.slice(0, 8)}`, { runtime: "external" });
  const app = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  const legacy = new SoftwareAuthenticator(LEGACY_RP_ID, ORIGIN, { synced: true });
  const options = await post(baseUrl, "/api/auth/second-factor/passkeys/registration/options", {}, app.token);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const registered = await post(baseUrl, "/api/auth/second-factor/passkeys/registration/verify", { response: legacy.register(options.body.options as Options) }, app.token);
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const { backupCodes } = await enrollSecondFactor(human.id);
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: null, secondFactorMethod: null }).where(eq(sessionFamilies.userId, human.id));
  afterMove();
  await setFlag(true);
  return { userId: human.id as string, email: human.email as string, agentId: agent.id, app, other, legacy, backupCodes };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, codeChallenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function start(baseUrl: string, token: string, extra: Json = {}) {
  const { verifier, codeChallenge } = pkce();
  const res = await post(baseUrl, `${BASE}/step-up/start`, { returnUri: RETURN_URI, codeChallenge, codeChallengeMethod: "S256", action: "agent_credential_mint", ...extra }, token);
  return { res, verifier, requestId: res.body?.requestId as string };
}

async function options(baseUrl: string, requestId: string) {
  return post(baseUrl, `${BASE}/step-up/requests/${requestId}/options`, {});
}

/** The page's passkey answer with `device` (bent per `bend`). */
async function verify(baseUrl: string, requestId: string, device: SoftwareAuthenticator, bend: Parameters<SoftwareAuthenticator["assert"]>[1] = {}) {
  const opts = await options(baseUrl, requestId);
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  return post(baseUrl, `${BASE}/step-up/requests/${requestId}/verify`, { webauthn: device.assert(opts.body.options as Options, bend) });
}

function codeOf(redirectUrl: string) {
  const url = new URL(redirectUrl);
  return { code: url.searchParams.get("code"), requestId: url.searchParams.get("requestId"), error: url.searchParams.get("error"), base: `${url.protocol}//${url.host}${url.pathname}` };
}

async function complete(baseUrl: string, token: string, code: string, verifier: string, returnUri = RETURN_URI) {
  return post(baseUrl, `${BASE}/step-up/complete`, { code, codeVerifier: verifier, returnUri }, token);
}

async function family(familyId: string) {
  const [row] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, familyId));
  return row!;
}

async function requestRow(id: string) {
  const [row] = await getDb().select().from(appLoginRequests).where(eq(appLoginRequests.id, id));
  return row!;
}

const mintAgentKey = (baseUrl: string, agentId: string, token: string) => post(baseUrl, `/api/agents/${agentId}/credentials`, {}, token);

test("happy path: start, describe, legacy options, verify, then the app's own redeem marks its sign-in verified as of the passkey", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  assert.equal((await mintAgentKey(app.baseUrl, p.agentId, p.app.token)).status, 403, "step-up required first");

  const started = await start(app.baseUrl, p.app.token);
  assert.equal(started.res.status, 201, JSON.stringify(started.res.body));
  assert.equal(started.res.headers.get("cache-control"), "no-store");
  assert.equal(started.res.body.stepUpUrl, `${ORIGIN}/login/app/verify?request=${started.requestId}`);
  assert.deepEqual(started.res.body.client, { id: "raft-app", name: "Raft" });
  assert.ok(Math.abs(Date.parse(started.res.body.expiresAt) - Date.now() - 5 * MINUTE) < 30_000, "5 minutes");
  const row = await requestRow(started.requestId);
  assert.equal(row.purpose, "step_up");
  assert.equal(row.userId, p.userId);
  assert.equal(row.targetFamilyId, p.app.familyId);

  // The page, with no sign-in at all.
  const described = await get(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}`);
  assert.equal(described.status, 200, JSON.stringify(described.body));
  assert.equal(described.body.action, "agent_credential_mint");
  assert.equal(described.body.account.maskedEmail, `${p.email[0]}***${p.email.slice(p.email.lastIndexOf("@"))}`);
  assert.equal(typeof described.body.account.name, "string");
  assert.deepEqual(described.body.client, { id: "raft-app", name: "Raft" });

  const opts = await options(app.baseUrl, started.requestId);
  assert.equal(opts.status, 200);
  assert.equal(opts.body.rp, "legacy");
  assert.equal(opts.body.options.rpId, LEGACY_RP_ID);
  assert.equal(opts.body.otherRps, undefined);
  const [challenge] = await getDb().select().from(authChallenges).where(and(eq(authChallenges.userId, p.userId), eq(authChallenges.kind, "webauthn_app_step_up")));
  assert.equal(challenge!.payload?.appStepUpRequestId, started.requestId, "a challenge of its own kind, bound to the request");

  const verified = await post(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}/verify`, { webauthn: p.legacy.assert(opts.body.options as Options) });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.deepEqual(Object.keys(verified.body), ["redirectUrl"], "no passkey swap offered");
  const callback = codeOf(verified.body.redirectUrl);
  assert.equal(callback.base, RETURN_URI);
  assert.equal(callback.requestId, started.requestId);
  assert.ok(callback.code);
  assert.equal((await family(p.app.familyId)).secondFactorVerifiedAt, null, "nothing is marked before the app redeems");
  const approvedAt = (await requestRow(started.requestId)).approvedAt!;
  assert.equal((await post(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}/verify`, { webauthn: p.legacy.assert(opts.body.options as Options) })).status, 409, "a second verify: already resolved");

  const done = await complete(app.baseUrl, p.app.token, callback.code!, started.verifier);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.verified, true);
  const marked = await family(p.app.familyId);
  assert.equal(marked.secondFactorVerifiedAt?.getTime(), approvedAt.getTime(), "as of the passkey, not the redeem");
  assert.equal(new Date(done.body.verifiedAt).getTime(), approvedAt.getTime());
  assert.equal(marked.secondFactorMethod, "passkey");
  assert.equal((await family(p.other.familyId)).secondFactorVerifiedAt, null, "only the app's sign-in");
  assert.equal((await mintAgentKey(app.baseUrl, p.agentId, p.app.token)).status, 201, "the gated action now passes");

  const again = await complete(app.baseUrl, p.app.token, callback.code!, started.verifier);
  assert.equal(again.status, 410);
  assert.equal(again.body.code, "code_consumed");
});

test("the code is bound to the start's sign-in and person, its verifier and return URI; a wrong one does not use it up", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const q = await person(app.baseUrl, seed);
  const started = await start(app.baseUrl, p.app.token);
  const { code } = codeOf((await verify(app.baseUrl, started.requestId, p.legacy)).body.redirectUrl);

  const otherFamily = await complete(app.baseUrl, p.other.token, code!, started.verifier);
  assert.equal(otherFamily.status, 404);
  assert.equal(otherFamily.body.code, "code_not_found");
  const otherPerson = await complete(app.baseUrl, q.app.token, code!, started.verifier);
  assert.equal(otherPerson.status, 404);
  assert.equal((await post(app.baseUrl, `${BASE}/step-up/complete`, { code, codeVerifier: started.verifier, returnUri: RETURN_URI })).status, 401, "no bearer");
  const wrongVerifier = await complete(app.baseUrl, p.app.token, code!, pkce().verifier);
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.body.code, "pkce_mismatch");
  const wrongUri = await complete(app.baseUrl, p.app.token, code!, started.verifier, MAC_RETURN_URI);
  assert.equal(wrongUri.status, 400);
  assert.equal(wrongUri.body.code, "return_uri_mismatch");
  assert.equal((await family(p.other.familyId)).secondFactorVerifiedAt, null);
  assert.equal((await family(q.app.familyId)).secondFactorVerifiedAt, null);

  assert.equal((await complete(app.baseUrl, p.app.token, code!, started.verifier)).status, 200, "still usable by its own app");
});

test("TTL: the request lives 5 minutes (expired: the app is told), the code 2 minutes from the passkey", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const expired = await start(app.baseUrl, p.app.token);
  await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, expired.requestId));
  const described = await get(app.baseUrl, `${BASE}/step-up/requests/${expired.requestId}`);
  assert.equal(described.status, 410);
  assert.equal(described.body.code, "request_expired");
  assert.equal(codeOf(described.body.redirectUrl).error, "expired");
  assert.equal((await options(app.baseUrl, expired.requestId)).status, 410);
  const cancelled = await post(app.baseUrl, `${BASE}/step-up/requests/${expired.requestId}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(codeOf(cancelled.body.redirectUrl).error, "expired");

  const late = await start(app.baseUrl, p.app.token);
  const { code } = codeOf((await verify(app.baseUrl, late.requestId, p.legacy)).body.redirectUrl);
  await getDb().update(appLoginRequests).set({ approvedAt: new Date(Date.now() - 3 * MINUTE) }).where(eq(appLoginRequests.id, late.requestId));
  const res = await complete(app.baseUrl, p.app.token, code!, late.verifier);
  assert.equal(res.status, 410);
  assert.equal(res.body.code, "code_expired");
  assert.equal((await family(p.app.familyId)).secondFactorVerifiedAt, null);
});

test("the login routes refuse step-up rows and codes; the step-up routes refuse login rows", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const started = await start(app.baseUrl, p.app.token);
  // Someone signed in on the web (here the person's other sign-in, verified) cannot take it as a login.
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date(), secondFactorMethod: "totp" }).where(eq(sessionFamilies.id, p.other.familyId));
  assert.equal((await get(app.baseUrl, `${BASE}/requests/${started.requestId}`, p.other.token)).status, 404);
  assert.equal((await post(app.baseUrl, `${BASE}/requests/${started.requestId}/approve`, {}, p.other.token)).status, 404);
  assert.equal((await post(app.baseUrl, `${BASE}/requests/${started.requestId}/deny`, {}, p.other.token)).status, 404);
  assert.equal((await requestRow(started.requestId)).status, "pending");

  const { code } = codeOf((await verify(app.baseUrl, started.requestId, p.legacy)).body.redirectUrl);
  const asLogin = await post(app.baseUrl, `${BASE}/complete`, { code, codeVerifier: started.verifier, returnUri: RETURN_URI });
  assert.equal(asLogin.status, 404, "a step-up code never issues a session");
  assert.equal(asLogin.body.code, "code_not_found");
  assert.equal((await requestRow(started.requestId)).status, "approved");

  const { verifier, codeChallenge } = pkce();
  void verifier;
  const login = await post(app.baseUrl, `${BASE}/start`, { returnUri: RETURN_URI, codeChallenge });
  assert.equal(login.status, 201);
  assert.equal((await get(app.baseUrl, `${BASE}/step-up/requests/${login.body.requestId}`)).status, 404);
  assert.equal((await options(app.baseUrl, login.body.requestId)).status, 404);
  assert.equal((await post(app.baseUrl, `${BASE}/step-up/requests/${login.body.requestId}/cancel`, {})).status, 404);
});

test("replay: a request-bound assertion answers nothing else, and a family-bound one never answers the request", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const started = await start(app.baseUrl, p.app.token);

  // The request's options answered at the app's own /step-up.
  const requestOpts = await options(app.baseUrl, started.requestId);
  const crossed = await post(app.baseUrl, "/api/auth/second-factor/step-up", { webauthn: p.legacy.assert(requestOpts.body.options as Options) }, p.app.token);
  assert.equal(crossed.status, 400, JSON.stringify(crossed.body));
  assert.equal((await family(p.app.familyId)).secondFactorVerifiedAt, null);

  // The family's options answered at the request's verify.
  const familyOpts = await post(app.baseUrl, "/api/auth/second-factor/passkeys/assertion/options", { rp: "legacy" }, p.app.token);
  assert.equal(familyOpts.status, 200);
  const res = await post(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}/verify`, { webauthn: p.legacy.assert(familyOpts.body.options as Options) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "second_factor_code_invalid");

  // A used challenge, again.
  const opts = await options(app.baseUrl, started.requestId);
  const answer = p.legacy.assert(opts.body.options as Options);
  assert.equal((await post(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}/verify`, { webauthn: answer })).status, 200);
  const replay = await start(app.baseUrl, p.app.token);
  assert.equal((await post(app.baseUrl, `${BASE}/step-up/requests/${replay.requestId}/verify`, { webauthn: answer })).status, 400, "consumed, and bound to the other request");
});

test("origin and RP: only a legacy passkey from a WEBAUTHN_ORIGINS origin; Android's app origin, another origin or a current passkey are refused", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const started = await start(app.baseUrl, p.app.token);
  for (const bend of [{ origin: ANDROID_ORIGIN }, { origin: "https://raft.test" }, { origin: "https://evil.example" }, { rpId: RP_ID }]) {
    const res = await verify(app.baseUrl, started.requestId, p.legacy, bend);
    assert.equal(res.status, 400, JSON.stringify(bend));
    assert.equal(res.body.code, "second_factor_code_invalid");
  }
  // A passkey under the current RP ID (added after the move, on the other sign-in) cannot answer.
  const fresh = new SoftwareAuthenticator(RP_ID, ORIGIN);
  const registration = await post(app.baseUrl, "/api/auth/second-factor/passkeys/registration/options", { backupCode: p.backupCodes[0] }, p.other.token);
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  const added = await post(app.baseUrl, "/api/auth/second-factor/passkeys/registration/verify", { response: fresh.register(registration.body.options as Options) }, p.other.token);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  for (const bend of [{}, { rpId: LEGACY_RP_ID }]) {
    const currentAnswer = await verify(app.baseUrl, started.requestId, fresh, bend);
    assert.equal(currentAnswer.status, 400, JSON.stringify(bend));
  }
  assert.equal((await requestRow(started.requestId)).status, "pending", "wrong answers leave it open");
  assert.equal((await verify(app.baseUrl, started.requestId, p.legacy)).status, 200);
});

test("start: flag, return URIs (mobile and Mac only, never loopback), action, two-step verification and a legacy passkey", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const loopback = await start(app.baseUrl, p.app.token, { returnUri: "http://127.0.0.1:49152/callback" });
  assert.equal(loopback.res.status, 400);
  assert.equal(loopback.res.body.code, "return_uri_not_allowed");
  assert.equal((await start(app.baseUrl, p.app.token, { returnUri: "https://evil.example/cb" })).res.status, 400);
  assert.equal((await start(app.baseUrl, p.app.token, { returnUri: RETURN_URI, clientId: "raft-mac" })).res.body.code, "client_mismatch");
  assert.equal((await start(app.baseUrl, p.app.token, { action: "drop_tables" })).res.body.code, "invalid_action");
  assert.equal((await start(app.baseUrl, p.app.token, { codeChallenge: "short" })).res.body.code, "code_challenge_invalid");
  const mac = await start(app.baseUrl, p.app.token, { returnUri: MAC_RETURN_URI, clientId: "raft-mac" });
  assert.equal(mac.res.status, 201);
  assert.deepEqual(mac.res.body.client, { id: "raft-mac", name: "Raft for Mac" });
  assert.equal((await post(app.baseUrl, `${BASE}/step-up/start`, { returnUri: RETURN_URI, codeChallenge: pkce().codeChallenge, action: "data_export" })).status, 401, "the app's bearer is required");

  await setFlag(false);
  const off = await start(app.baseUrl, p.app.token);
  assert.equal(off.res.status, 404);
  assert.equal(off.res.body.code, "not_enabled");
  assert.equal((await get(app.baseUrl, `${BASE}/step-up/requests/${mac.requestId}`)).status, 404, "off: an open request is gone too");
  assert.equal((await options(app.baseUrl, mac.requestId)).status, 404);
  await getDb().delete(featureFlags).where(eq(featureFlags.key, APP_WEB_STEP_UP_FEATURE_FLAG_KEY));
  assert.equal((await start(app.baseUrl, p.app.token)).res.status, 404, "no flag row: off");
  await setFlag(true);

  await getDb().update(webauthnCredentials).set({ revokedAt: new Date() }).where(eq(webauthnCredentials.userId, p.userId));
  const noPasskey = await start(app.baseUrl, p.app.token);
  assert.equal(noPasskey.res.status, 404);
  assert.equal(noPasskey.res.body.code, "passkey_not_found");
});

test("a new start ends the previous one for the same sign-in; cancel tells the app; a revoked sign-in's step-up is denied", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const first = await start(app.baseUrl, p.app.token);
  const fromOther = await start(app.baseUrl, p.other.token);
  const second = await start(app.baseUrl, p.app.token);
  assert.equal((await requestRow(first.requestId)).status, "denied");
  assert.equal((await requestRow(fromOther.requestId)).status, "pending", "another sign-in's request is its own");
  assert.equal((await get(app.baseUrl, `${BASE}/step-up/requests/${first.requestId}`)).status, 409);
  assert.equal((await options(app.baseUrl, first.requestId)).status, 409);

  const cancelled = await post(app.baseUrl, `${BASE}/step-up/requests/${second.requestId}/cancel`, {});
  assert.equal(cancelled.status, 200);
  const callback = codeOf(cancelled.body.redirectUrl);
  assert.equal(callback.error, "access_denied");
  assert.equal(callback.requestId, second.requestId);
  assert.equal(callback.code, null);

  const third = await start(app.baseUrl, p.app.token);
  const { code } = codeOf((await verify(app.baseUrl, third.requestId, p.legacy)).body.redirectUrl);
  await getDb().transaction((tx) => revokeSessionFamilyInTransaction(tx, p.userId, p.app.familyId, "logout"));
  assert.equal((await requestRow(third.requestId)).status, "denied", "the revoke denies a verified, unredeemed step-up");
  assert.equal((await complete(app.baseUrl, p.app.token, code!, third.verifier)).status, 401);
  assert.equal((await family(p.app.familyId)).secondFactorVerifiedAt, null);
});

test("flag off: verify and complete refuse too, before using the challenge or the code", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const started = await start(app.baseUrl, p.app.token);
  const opts = await options(app.baseUrl, started.requestId);
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const answer = p.legacy.assert(opts.body.options as Options);

  await setFlag(false);
  const verifyOff = await post(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}/verify`, { webauthn: answer });
  assert.equal(verifyOff.status, 404, JSON.stringify(verifyOff.body));
  assert.equal(verifyOff.body.code, "request_not_found");
  assert.equal((await requestRow(started.requestId)).status, "pending");
  await setFlag(true);
  const verified = await post(app.baseUrl, `${BASE}/step-up/requests/${started.requestId}/verify`, { webauthn: answer });
  assert.equal(verified.status, 200, "the refused answer was not consumed");
  const { code } = codeOf(verified.body.redirectUrl);

  await setFlag(false);
  const completeOff = await complete(app.baseUrl, p.app.token, code!, started.verifier);
  assert.equal(completeOff.status, 404, JSON.stringify(completeOff.body));
  assert.equal(completeOff.body.code, "not_enabled");
  assert.equal((await requestRow(started.requestId)).status, "approved");
  assert.equal((await family(p.app.familyId)).secondFactorVerifiedAt, null);
  await setFlag(true);
  assert.equal((await complete(app.baseUrl, p.app.token, code!, started.verifier)).status, 200, "the refused code was not used up");
});

test("someone else's passkey: another person's legacy passkey cannot answer the request", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const q = await person(app.baseUrl, seed);
  const started = await start(app.baseUrl, p.app.token);
  const res = await verify(app.baseUrl, started.requestId, q.legacy);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, "second_factor_code_invalid");
  assert.equal((await requestRow(started.requestId)).status, "pending");
  assert.equal((await verify(app.baseUrl, started.requestId, p.legacy)).status, 200, "the person's own passkey still answers");
});

test("a new start voids a verified, unredeemed step-up: its code can no longer be redeemed", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const first = await start(app.baseUrl, p.app.token);
  const { code } = codeOf((await verify(app.baseUrl, first.requestId, p.legacy)).body.redirectUrl);
  assert.equal((await requestRow(first.requestId)).status, "approved");

  const second = await start(app.baseUrl, p.app.token);
  assert.equal(second.res.status, 201);
  assert.equal((await requestRow(first.requestId)).status, "denied");
  const res = await complete(app.baseUrl, p.app.token, code!, first.verifier);
  assert.equal(res.status, 410, JSON.stringify(res.body));
  assert.equal(res.body.code, "code_expired");
  assert.equal((await family(p.app.familyId)).secondFactorVerifiedAt, null);
});

test("a purged sign-in (family row deleted, target SET NULL): its step-ups can't be read, approved or redeemed", async ({ app, seed }) => {
  const p = await person(app.baseUrl, seed);
  const pending = await start(app.baseUrl, p.app.token);
  const approved = await start(app.baseUrl, p.other.token);
  const { code } = codeOf((await verify(app.baseUrl, approved.requestId, p.legacy)).body.redirectUrl);
  assert.ok(code);

  // As the release-QA seed purge does: delete the family rows outright, no revoke.
  await getDb().delete(sessionFamilies).where(inArray(sessionFamilies.id, [p.app.familyId, p.other.familyId]));
  for (const id of [pending.requestId, approved.requestId]) {
    const row = await requestRow(id);
    assert.equal(row.purpose, "step_up", "still a step-up row, never a login");
    assert.equal(row.targetFamilyId, null);
  }

  assert.equal((await get(app.baseUrl, `${BASE}/step-up/requests/${pending.requestId}`)).status, 404, "describe");
  assert.equal((await options(app.baseUrl, pending.requestId)).status, 404, "options");
  const verified = await post(app.baseUrl, `${BASE}/step-up/requests/${pending.requestId}/verify`, { webauthn: {} });
  assert.equal(verified.status, 404, `approve: ${JSON.stringify(verified.body)}`);
  assert.equal((await requestRow(pending.requestId)).status, "pending");

  assert.equal((await complete(app.baseUrl, p.other.token, code, approved.verifier)).status, 401, "the purged sign-in's bearer is gone");
  const exchanged = await getDb().transaction((tx) => completeAppStepUp(tx, {
    userId: p.userId, familyId: p.other.familyId, code, codeVerifier: approved.verifier, returnUri: RETURN_URI,
  }));
  assert.deepEqual(exchanged, { ok: false, error: "code_not_found" }, "exchange");
  assert.equal((await requestRow(approved.requestId)).status, "approved", "not consumed");
});
