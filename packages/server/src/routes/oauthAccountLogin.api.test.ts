import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type webcrypto } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  featureFlagRules,
  featureFlags,
  integrationAuditEvents,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthClientInstalls,
  oauthClients,
  oauthUserConsents,
  passwordResets,
  serverMembers,
  sessionFamilies,
  users,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, signInForTest, tokenForHuman } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import { OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { ACCOUNT_LOGIN_IDENTITY_SCOPES } from "../services/oauthAccountLogin";
import {
  createOAuthClient,
  installMarketplaceOAuthClient,
  issueHumanAuthorizationCode,
  requestAgentAccess,
} from "../services/oauthService";
import { oidcIssuer } from "../services/oidcService";
import { addMember, createServer, removeMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { resetPassword } from "../services/userService";

// RFC 079 phase 3a, PR 3: the account-mode login path, end to end (design
// §3.1, §3.2; threats T4, T9-T14, T17; decisions Q1-Q4, Q8, Q13, Q15). The
// App is switched with SQL as the reviewed switch would
// (db/oauthClientLoginMode.test.ts) and the kill switch turned on.
//
// Every refusal is compared whole (status, the headers in RECORDED_HEADERS,
// body text) with a reference answer: today's answer from a server-mode App
// (REF, which never switches), or, where account mode has its own refusal, the
// answer a person outside the audience gets.
const test = createApiTest({ skipAuthRateLimit: true });

const RETURN_URL = "https://account-login.example.test/login/raft/callback";
const ALLOWED_SCOPES = ["openid", "profile", "email", "identity", "agent:read"];
const LOGIN_SCOPES = ["openid", "profile", "email", "agent:read"];
const RECORDED_HEADERS = ["cache-control", "content-type", "location", "pragma", "www-authenticate"] as const;
const APP_NOT_AVAILABLE_BODY = JSON.stringify({ error: "This app isn't available to you.", code: "app_not_available" });
const SERVER_ACCESS_DENIED_BODY = JSON.stringify({
  error: "server_access_denied",
  error_description: "This token cannot be used for this request on that Server.",
});
const DEAD_CODE_BODY = JSON.stringify({
  error: "invalid_grant",
  error_description: "The authorization code is invalid, expired, or has already been used",
});
const OTHER_SERVER_GRANT_BODY = JSON.stringify({
  error: "invalid_grant",
  error_description: "The authorization was granted for a different Server than this issuer",
});
const ACCESS_DENIED_BODY = JSON.stringify({ error: "access_denied" });
const LOGIN_MODE_CHANGED_BODY = JSON.stringify({
  error: "This app now signs you in with your Raft account. Reload this page to continue.",
  code: "login_mode_changed",
});
const HOUR_MS = 60 * 60 * 1000;

type Base = { baseUrl: string };
type Answer = { status: number; headers: Record<string, string>; body: string };
type RegisteredApp = { id: string; clientId: string; clientSecret: string };
type Person = Awaited<ReturnType<typeof seedUser>>;

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return { ...user!, bearer: await tokenForHuman(user!.email) };
}

async function answerOf(res: Response): Promise<Answer> {
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: res.status, headers, body: await res.text() };
}

function basic(client: RegisteredApp) {
  return `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
}

function challenge(verifier: string) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function lookup(app: Base, person: Person, clientKey: string, serverId: string, scopes = LOGIN_SCOPES): Promise<Answer> {
  return fetch(`${app.baseUrl}/api/oauth/clients/lookup?${new URLSearchParams({ client_id: clientKey, server_id: serverId, scope: scopes.join(" ") })}`, {
    headers: { Authorization: `Bearer ${person.bearer}` },
  }).then(answerOf);
}

function post(app: Base, path: string, person: Person, body: Record<string, unknown>): Promise<Answer> {
  return fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${person.bearer}` },
    body: JSON.stringify(body),
  }).then(answerOf);
}

/** What the account-mode setup page posts: the OIDC flow, with PKCE and a nonce, no Server. */
function accountBody(clientKey: string, extra: Record<string, unknown> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const nonce = `nonce-${randomUUID()}`;
  return {
    verifier,
    nonce,
    body: {
      clientId: clientKey,
      returnUrl: RETURN_URL,
      scopes: LOGIN_SCOPES,
      oidc: true,
      nonce,
      codeChallenge: challenge(verifier),
      codeChallengeMethod: "S256",
      ...extra,
    },
  };
}

function authorizeAccount(app: Base, person: Person, body: Record<string, unknown>, mount = ""): Promise<Answer> {
  return post(app, `${mount}/api/oauth/authorize/account`, person, body);
}

/** An account-mode code for `person` (200 asserted). */
async function accountCode(app: Base, f: Seeded, input: { person?: Person; scopes?: string[] } = {}) {
  const { verifier, nonce, body } = accountBody(f.client.clientId, input.scopes ? { scopes: input.scopes } : {});
  const answer = await authorizeAccount(app, input.person ?? f.person, body);
  assert.equal(answer.status, 200, `fixture: authorize/account (${answer.status}): ${answer.body}`);
  return { code: (JSON.parse(answer.body) as { code: string }).code, verifier, nonce, answer };
}

/** POST /token for an authorization code; with a verifier, the OIDC exchange the matrix uses. */
function exchange(app: Base, client: RegisteredApp, code: string, opts: { mount?: string; verifier?: string | null; extra?: Record<string, string> } = {}): Promise<Answer> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    ...(opts.verifier ? { redirect_uri: RETURN_URL, code_verifier: opts.verifier } : {}),
    ...opts.extra,
  });
  return fetch(`${app.baseUrl}${opts.mount ?? ""}/api/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic(client) },
    body,
  }).then(answerOf);
}

function read(app: Base, path: string, token: string): Promise<Answer> {
  return fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(answerOf);
}

type TokenBody = { access_token: string; token_type: string; expires_in: number; scope: string; id_token?: string };

async function accountLogin(app: Base, f: Seeded, input: { person?: Person; scopes?: string[] } = {}) {
  const code = await accountCode(app, f, input);
  const answer = await exchange(app, f.client, code.code, { verifier: code.verifier });
  assert.equal(answer.status, 200, `fixture: account exchange (${answer.status}): ${answer.body}`);
  return { ...code, token: JSON.parse(answer.body) as TokenBody, tokenAnswer: answer };
}

function jwtParts(idToken: string) {
  const [header, payload, signature, extra] = idToken.split(".");
  assert.ok(header && payload && signature && extra === undefined);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

async function assertSignedByJwks(app: Base, idToken: string) {
  const jwt = jwtParts(idToken);
  const jwks = await (await fetch(`${app.baseUrl}/api/oauth/jwks`)).json() as { keys: Array<webcrypto.JsonWebKey & { kid: string }> };
  const jwk = jwks.keys.find((key) => key.kid === jwt.header.kid);
  assert.ok(jwk, "the ID token's kid is in the JWKS");
  assert.ok(verify("sha256", Buffer.from(jwt.signingInput, "ascii"), {
    key: createPublicKey({ key: jwk, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }, jwt.signature), "the ID token verifies against the JWKS");
}

/** The reviewed switch's write, with SQL (db/oauthClientLoginMode.test.ts). */
async function switchToAccountMode(clientId: string) {
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${clientId}`);
}

async function setAccountLoginFlag(state: "on" | "off" | "killed" | "missing") {
  const db = getDb();
  if (state === "missing") {
    await db.delete(featureFlags).where(eq(featureFlags.key, OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY));
    return;
  }
  const values = { enabled: true, killSwitch: state === "killed", defaultEnabled: state !== "off" };
  await db.insert(featureFlags)
    .values({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "account-login-test", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });
}

async function setRole(serverId: string, userId: string, role: "member" | "guest" | "admin") {
  // A Guest always has its one channel; any other role has none (server_members guest CHECKs).
  if (role === "guest") {
    await seedBoundGuest({ serverId, userId });
    return;
  }
  await getDb().update(serverMembers).set({ role, guestChannelId: null })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

async function setInstall(clientId: string, serverId: string, set: Partial<typeof oauthClientInstalls.$inferInsert>) {
  await getDb().update(oauthClientInstalls).set(set)
    .where(and(eq(oauthClientInstalls.clientId, clientId), eq(oauthClientInstalls.serverId, serverId)));
}

async function requestCount(clientId: string) {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(oauthAccessRequests)
    .where(eq(oauthAccessRequests.clientId, clientId));
  return row!.n;
}

async function tokenCount(clientId: string) {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.clientId, clientId));
  return row!.n;
}

/** The request behind a code: its row id is the code's request id (the OIDC code carries it). */
async function requestRowOf(clientId: string, userId: string) {
  return getDb().select().from(oauthAccessRequests)
    .where(and(eq(oauthAccessRequests.clientId, clientId), eq(oauthAccessRequests.userId, userId), isNull(oauthAccessRequests.serverId)));
}

async function registerApp(label: string, publisher: { id: string }, owner: { id: string }, suffix: string, installOn: Array<{ id: string }>): Promise<RegisteredApp> {
  const { client, clientSecret } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `${label}-${suffix}`,
    name: `${label} App`,
    returnUrl: RETURN_URL,
    allowedScopes: ALLOWED_SCOPES,
  });
  await getDb().update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, client.id));
  for (const server of installOn) {
    assert.ok(await installMarketplaceOAuthClient({
      serverId: server.id,
      clientId: client.id,
      installedByUserId: owner.id,
      expected: await currentAppPermissions(client.id),
    }));
  }
  return { id: client.id, clientId: client.clientId, clientSecret };
}

/** A server-mode OIDC login through the setup page's continue (before the switch, or with REF). */
async function serverModeOidcCode(app: Base, person: Person, client: RegisteredApp, serverId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const nonce = `nonce-${randomUUID()}`;
  const answer = await post(app, "/api/oauth/authorize/human", person, {
    clientId: client.clientId,
    serverId,
    returnUrl: RETURN_URL,
    scopes: LOGIN_SCOPES,
    oidc: true,
    nonce,
    codeChallenge: challenge(verifier),
    codeChallengeMethod: "S256",
  });
  assert.equal(answer.status, 200, `fixture: server-mode continue (${answer.status}): ${answer.body}`);
  return { code: (JSON.parse(answer.body) as { code: string }).code, verifier, nonce };
}

/**
 * A published third-party App (APP) installed on A and B, and REF, the same
 * but never switched; the person is a member of A, B and C (C has no
 * installation: outside the audience, a Marketplace install target) and not of
 * the publisher's Server. Names sort B before A. Before the switch: APP's
 * setup-page answers on each Server, a server-mode OIDC login on A (its token
 * and ID token) and two open codes on A (OIDC and legacy). Then APP switches
 * and the flag is turned on.
 */
async function seedAccountLogin(app: Base) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("login-owner");
  const person = await seedUser("login-person");
  const publisher = await createServer("Login Publisher", `login-pub-${suffix}`, owner.id);
  const a = await createServer(`Bravo ${suffix}`, `login-a-${suffix}`, owner.id);
  const b = await createServer(`Alpha ${suffix}`, `login-b-${suffix}`, owner.id);
  const c = await createServer(`Charlie ${suffix}`, `login-c-${suffix}`, owner.id);
  for (const server of [a, b, c]) await addMember(server.id, person.id, "member");
  const client = await registerApp("account", publisher, owner, suffix, [a, b]);
  const ref = await registerApp("reference", publisher, owner, suffix, [a, b]);

  // The setup page's answers for APP before the switch: ready on A, suspended on B, install on C.
  await setInstall(client.id, b.id, { status: "suspended" });
  const before = {
    ready: await lookup(app, person, client.clientId, a.id),
    suspended: await lookup(app, person, client.clientId, b.id),
    install: await lookup(app, person, client.clientId, c.id),
  };
  await setInstall(client.id, b.id, { status: "active" });
  assert.equal(JSON.parse(before.ready.body).availability, "ready");
  assert.equal(JSON.parse(before.suspended.body).availability, "suspended");
  assert.equal(JSON.parse(before.install.body).availability, "install_required");

  const serverLogin = await serverModeOidcCode(app, person, client, a.id);
  const serverExchange = await exchange(app, client, serverLogin.code, { verifier: serverLogin.verifier });
  assert.equal(serverExchange.status, 200, serverExchange.body);
  const serverToken = JSON.parse(serverExchange.body) as TokenBody;
  const preSwitch = {
    token: serverToken.access_token,
    idToken: serverToken.id_token!,
    oidcCode: await serverModeOidcCode(app, person, client, a.id),
    legacyCode: (await issueHumanAuthorizationCode({ clientKey: client.clientId, userId: person.id, serverId: a.id, returnUrl: RETURN_URL, scopes: LOGIN_SCOPES, approverSessionFamilyId: (await signInForTest(person.id)).familyId })).code,
  };

  await switchToAccountMode(client.id);
  await setAccountLoginFlag("on");
  return { suffix, owner, person, publisher, a, b, c, client, ref, before, preSwitch };
}

type Seeded = Awaited<ReturnType<typeof seedAccountLogin>>;

/** Today's one refusal of the continue (an unknown App on A), and of the lookup. */
async function notAvailableReferences(app: Base, f: Seeded) {
  const unknown = `unknown-${f.suffix}`;
  const continueRef = await post(app, "/api/oauth/authorize/human", f.person, { clientId: unknown, serverId: f.a.id, returnUrl: RETURN_URL, scopes: LOGIN_SCOPES });
  const lookupRef = await lookup(app, f.person, unknown, f.a.id);
  for (const ref of [continueRef, lookupRef]) {
    assert.equal(ref.status, 403);
    assert.equal(ref.body, APP_NOT_AVAILABLE_BODY);
  }
  return { continueRef, lookupRef };
}

/** Today's token-endpoint answers with REF: a replayed OIDC code, a code exchanged at another Server's issuer, a refresh grant. */
async function tokenReferences(app: Base, f: Seeded) {
  const replayed = await serverModeOidcCode(app, f.person, f.ref, f.a.id);
  assert.equal((await exchange(app, f.ref, replayed.code, { verifier: replayed.verifier })).status, 200);
  const deadCode = await exchange(app, f.ref, replayed.code, { verifier: replayed.verifier });
  assert.equal(deadCode.body, DEAD_CODE_BODY);
  const otherServer = await serverModeOidcCode(app, f.person, f.ref, f.a.id);
  const otherServerGrant = await exchange(app, f.ref, otherServer.code, { verifier: otherServer.verifier, mount: `/oidc/${f.b.id}` });
  assert.equal(otherServerGrant.body, OTHER_SERVER_GRANT_BODY);
  const refresh = await exchange(app, f.ref, "unused", { extra: { grant_type: "refresh_token", refresh_token: "slock_rt_unused" } });
  assert.equal(refresh.status, 400);
  assert.deepEqual(JSON.parse(refresh.body), { error: "Unsupported grant type" });
  return { deadCode, otherServerGrant, refresh };
}

test("happy path: lookup says account, authorize/account issues a code naming no Server, /token returns a one-hour token, its ID token and userinfo carry no Server; two logins keep one consent (T13)", async ({ app }) => {
  const f = await seedAccountLogin(app);

  // Lookup (Q1): today's ready answer plus loginMode, on each audience Server.
  const ready = await lookup(app, f.person, f.client.clientId, f.a.id);
  assert.deepEqual(ready, { ...f.before.ready, body: JSON.stringify({ ...JSON.parse(f.before.ready.body), loginMode: "account" }) });

  // authorize/account: { code, client, scopes, returnUrl }, no server.
  const login = await accountCode(app, f);
  const authorized = JSON.parse(login.answer.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(authorized), ["code", "client", "scopes", "returnUrl"]);
  assert.match(String(authorized.code), /^raft_oidc_/);
  assert.deepEqual(authorized.client, { clientId: f.client.clientId, appType: "third_party_global", name: "account App", description: null, homepageUrl: null });
  assert.deepEqual(authorized.scopes, ["agent:read", "email", "openid", "profile"]);
  assert.equal(authorized.returnUrl, RETURN_URL);
  const [request] = await requestRowOf(f.client.id, f.person.id);
  assert.ok(request, "a server-less request");
  assert.equal(request.serverId, null);
  assert.equal(request.principalType, "human");
  assert.equal(request.status, "approved");
  assert.equal(request.consumedAt, null);

  // /token at the root issuer.
  const answer = await exchange(app, f.client, login.code, { verifier: login.verifier });
  assert.equal(answer.status, 200, answer.body);
  assert.equal(answer.headers["cache-control"], "no-store");
  const token = JSON.parse(answer.body) as TokenBody;
  assert.deepEqual(Object.keys(token), ["access_token", "token_type", "expires_in", "scope", "id_token"]);
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, "agent:read email openid profile");
  const [row] = await getDb().select().from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.tokenHash, createHash("sha256").update(token.access_token).digest("hex")));
  assert.ok(row);
  assert.equal(row.serverId, null);
  assert.equal(row.principalType, "human");
  assert.equal(row.userId, f.person.id);
  assert.equal(row.requestId, request.id);
  assert.equal(row.resource, null);
  assert.equal(row.expiresAt.getTime() - row.createdAt.getTime(), HOUR_MS);
  const [consumed] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, request.id));
  assert.ok(consumed?.consumedAt, "the request is consumed");

  // The ID token: server mode's payload for the same person and App (the
  // pre-switch login on A) without the server claims, in its order; `iss`
  // the root issuer (D21); signed with the JWKS key.
  await assertSignedByJwks(app, token.id_token!);
  const account = jwtParts(token.id_token!);
  const server = jwtParts(f.preSwitch.idToken);
  assert.deepEqual(account.header, server.header);
  const serverKeys = Object.keys(server.payload);
  assert.deepEqual(serverKeys.slice(-3), ["server_id", "server_slug", "server_role"], "witness: server mode carries them last");
  assert.deepEqual(Object.keys(account.payload), serverKeys.slice(0, -3));
  for (const key of Object.keys(account.payload)) {
    if (key === "iat" || key === "exp" || key === "nonce") continue;
    assert.deepEqual(account.payload[key], server.payload[key], key);
  }
  assert.equal(account.payload.iss, oidcIssuer());
  assert.equal(account.payload.iss, new URL(String(account.payload.iss)).origin, "the root issuer: an origin, no /oidc/ path");
  assert.equal(account.payload.nonce, login.nonce);
  assert.equal(account.payload.sub, f.person.id);
  assert.equal(account.payload.aud, f.client.clientId);
  assert.equal(account.payload.type, "human");
  assert.equal(account.payload.email, f.person.email);
  assert.equal(Number(account.payload.exp) - Number(account.payload.iat), token.expires_in);

  // userinfo with the token: no Server claims.
  const userinfo = await read(app, "/api/oauth/userinfo", token.access_token);
  assert.equal(userinfo.status, 200, userinfo.body);
  const claims = JSON.parse(userinfo.body) as Record<string, unknown>;
  assert.equal(claims.sub, f.person.id);
  assert.equal(claims.scope, token.scope);
  for (const key of ["server_id", "server_slug", "server_role"]) assert.equal(key in claims, false, key);

  // The account-mode consent (user, NULL, App): one row after two logins (T13).
  const consents = () => getDb().select().from(oauthUserConsents)
    .where(and(eq(oauthUserConsents.userId, f.person.id), eq(oauthUserConsents.clientId, f.client.id), isNull(oauthUserConsents.serverId)));
  const [first] = await consents();
  assert.ok(first);
  assert.deepEqual(first.scopes, ["agent:read", "email", "openid", "profile"]);
  assert.equal(first.source, "login");
  await accountLogin(app, f, { scopes: ["openid", "identity"] });
  const after = await consents();
  assert.equal(after.length, 1, "one account-mode consent per person and App");
  assert.equal(after[0]!.id, first.id);
  assert.deepEqual(after[0]!.scopes, ["agent:read", "email", "identity", "openid", "profile"], "an active consent adds the new scopes");
  assert.equal(after[0]!.grantedAt.getTime(), first.grantedAt.getTime(), "and keeps when it was first granted");
  // The pre-switch per-Server consent on A is untouched.
  const perServer = await getDb().select().from(oauthUserConsents)
    .where(and(eq(oauthUserConsents.userId, f.person.id), eq(oauthUserConsents.clientId, f.client.id), eq(oauthUserConsents.serverId, f.a.id)));
  assert.equal(perServer.length, 1);

  // The audit trail marks both steps as account mode's.
  const lifecycle = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, f.client.id), eq(integrationAuditEvents.eventType, "oauth.lifecycle")));
  const accountStages = lifecycle.map(({ metadata }) => metadata as Record<string, unknown>)
    .filter((metadata) => metadata.loginMode === "account" && metadata.result === "issued")
    .map((metadata) => metadata.stage);
  assert.deepEqual(accountStages.sort(), ["authorization", "authorization", "token_exchange", "token_exchange"]);
});

test("T13: concurrent exchanges of two codes leave exactly one account-mode consent row", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const codes = [await accountCode(app, f), await accountCode(app, f, { scopes: ["openid", "identity"] })];
  const answers = await Promise.all(codes.map((code) => exchange(app, f.client, code.code, { verifier: code.verifier })));
  for (const answer of answers) assert.equal(answer.status, 200, answer.body);
  const rows = await getDb().select().from(oauthUserConsents)
    .where(and(eq(oauthUserConsents.userId, f.person.id), eq(oauthUserConsents.clientId, f.client.id), isNull(oauthUserConsents.serverId)));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.scopes, ["agent:read", "email", "identity", "openid", "profile"]);
});

test("T12 (D15): expires_in is at most an hour, no refresh_token, and the refresh grant gets today's 400", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const refs = await tokenReferences(app, f);
  const { token } = await accountLogin(app, f);
  assert.ok(token.expires_in <= 3600 && token.expires_in >= 3590, String(token.expires_in));
  assert.equal("refresh_token" in token, false);
  assert.deepEqual(
    await exchange(app, f.client, "unused", { extra: { grant_type: "refresh_token", refresh_token: token.access_token } }),
    refs.refresh,
  );
});

test("T9 (D16, Q3): a pre-switch token keeps working, bound to its Server; a pre-switch code is a dead code, refused before any write", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const refs = await tokenReferences(app, f);

  // The server-mode token minted before the switch: valid, still bound to A.
  const userinfo = await read(app, "/api/oauth/userinfo", f.preSwitch.token);
  assert.equal(userinfo.status, 200, userinfo.body);
  assert.equal(JSON.parse(userinfo.body).server_id, f.a.id);
  const other = await read(app, `/api/oauth/serverinfo?server_id=${f.b.id}`, f.preSwitch.token);
  assert.deepEqual({ status: other.status, body: other.body }, { status: 403, body: SERVER_ACCESS_DENIED_BODY });

  // The open codes: today's dead-code invalid_grant, OIDC and legacy alike.
  // Nothing is written (no token, the request stays as it was), so the
  // database's rule (b) is never reached.
  const tokensBefore = await tokenCount(f.client.id);
  assert.deepEqual(await exchange(app, f.client, f.preSwitch.oidcCode.code, { verifier: f.preSwitch.oidcCode.verifier }), refs.deadCode, "OIDC");
  assert.deepEqual(await exchange(app, f.client, f.preSwitch.legacyCode), refs.deadCode, "legacy");
  assert.equal(await tokenCount(f.client.id), tokensBefore);
  const [legacy] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, f.preSwitch.legacyCode));
  assert.equal(legacy?.consumedAt, null);
  // Recorded as a refused exchange.
  const failures = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, f.client.id), eq(integrationAuditEvents.eventType, "oauth.token_exchange_failed")));
  assert.ok(failures.some(({ metadata }) => (metadata as Record<string, unknown>).errorCode === "login_mode_changed"));
});

test("T10 (D21, Q2): an account code at a Server-scoped /token gets today's other-Server invalid_grant and stays usable at the root; agent codes still work there", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const refs = await tokenReferences(app, f);
  const login = await accountCode(app, f);
  const [request] = await requestRowOf(f.client.id, f.person.id);
  const tokensBefore = await tokenCount(f.client.id);
  for (const mount of [`/oidc/${f.a.id}`, `/oidc/${f.a.slug}`, `/oidc/${f.c.id}`]) {
    assert.deepEqual(await exchange(app, f.client, login.code, { verifier: login.verifier, mount }), refs.otherServerGrant, mount);
  }
  // Nothing was written: no token, the request is not consumed.
  assert.equal(await tokenCount(f.client.id), tokensBefore);
  const [after] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, request!.id));
  assert.equal(after?.consumedAt, null);
  // The same code at the root issuer: a token whose `iss` is the root's.
  const root = await exchange(app, f.client, login.code, { verifier: login.verifier });
  assert.equal(root.status, 200, root.body);
  const token = JSON.parse(root.body) as TokenBody;
  assert.equal(jwtParts(token.id_token!).payload.iss, oidcIssuer());
  // The account token on a scoped userinfo: the 401 of a token issued for another Server.
  const scopedUserinfo = await read(app, `/oidc/${f.a.id}/api/oauth/userinfo`, token.access_token);
  assert.equal(scopedUserinfo.status, 401);
  assert.deepEqual(JSON.parse(scopedUserinfo.body), { error: "Access token was issued for a different Server than this issuer" });

  // Q2: an agent's grant of the account-mode App is Server-bound and still exchanges at its Server's issuer.
  const agent = await createAgent(f.a.id, "AccountLoginAgent", { runtime: "external", model: "external" });
  const requested = await requestAgentAccess({ clientId: f.client.id, serverSlug: f.a.slug, agentId: agent.id, scopes: ["openid", "profile"] });
  assert.equal(requested.status, "approved");
  const agentAnswer = await fetch(`${app.baseUrl}/oidc/${f.a.slug}/api/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic(f.client) },
    body: new URLSearchParams({ grant_type: "urn:slock:grant-type:agent_request", request_id: requested.request.id }),
  }).then(answerOf);
  assert.equal(agentAnswer.status, 200, agentAnswer.body);
  assert.equal(jwtParts((JSON.parse(agentAnswer.body) as TokenBody).id_token!).payload.server_id, f.a.id);
});

test("T10: authorize/account with `server` answers root_issuer_required once the audience check passes, and writes nothing", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const before = await requestCount(f.client.id);
  for (const server of [f.a.id, f.a.slug, "", null]) {
    const answer = await authorizeAccount(app, f.person, accountBody(f.client.clientId, { server }).body);
    assert.deepEqual({ status: answer.status, body: answer.body }, {
      status: 400,
      body: JSON.stringify({ error: "invalid_request", code: "root_issuer_required" }),
    }, `server: ${JSON.stringify(server)}`);
  }
  assert.equal(await requestCount(f.client.id), before);
});

test("T11 (D4/D11): authorize/account refuses an unknown App, a server-mode App, a person outside the audience, a guest-only person and a switched-off person with the same bytes, `server` or not; the route is 404 on a scoped mount", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { continueRef } = await notAvailableReferences(app, f);
  const outsider = await seedUser("login-outsider");
  await addMember(f.c.id, outsider.id, "member");
  const nonMember = await seedUser("login-non-member");
  const guestOnly = await seedUser("login-guest");
  await seedBoundGuest({ serverId: f.a.id, userId: guestOnly.id });
  await seedBoundGuest({ serverId: f.b.id, userId: guestOnly.id });
  const switchedOff = await seedUser("login-switched-off");
  await addMember(f.a.id, switchedOff.id, "member");
  // Off for one person only: default off, a user rule for everyone else here.
  await setAccountLoginFlag("off");
  await getDb().insert(featureFlagRules).values({
    flagKey: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY,
    stage: "user",
    decision: "allow",
    values: [f.person.id, outsider.id, nonMember.id, guestOnly.id],
  });

  const cases: Array<[string, Person, string]> = [
    ["an unknown App", f.person, `unknown-${f.suffix}`],
    ["a server-mode App", f.person, f.ref.clientId],
    ["a member of a Server without the App (outside the audience)", outsider, f.client.clientId],
    ["a member of no Server", nonMember, f.client.clientId],
    ["a guest on every audience Server", guestOnly, f.client.clientId],
    ["the kill switch off for the person", switchedOff, f.client.clientId],
  ];
  const before = await requestCount(f.client.id);
  for (const [label, person, clientKey] of cases) {
    for (const extra of [{}, { server: f.a.id }]) {
      const answer = await authorizeAccount(app, person, accountBody(clientKey, extra).body);
      assert.deepEqual(answer, continueRef, `${label} ${JSON.stringify(extra)}`);
    }
  }
  assert.equal(await requestCount(f.client.id), before, "no request is written");
  // Witness: the person the flag lets in gets a code.
  await accountCode(app, f);

  // Not on the Server-scoped mount: its guard's 404 for a route it does not serve.
  for (const segment of [f.a.id, f.a.slug]) {
    const ref = await post(app, `/oidc/${segment}/api/oauth/authorize/human`, f.person, {});
    assert.equal(ref.status, 404);
    assert.deepEqual(await authorizeAccount(app, f.person, accountBody(f.client.clientId).body, `/oidc/${segment}`), ref, segment);
  }
});

test("returnUrl must be the registered URL: a mismatch is the continue's 400, audited as a redirect mismatch; outside the audience it is the one refusal", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { continueRef } = await notAvailableReferences(app, f);
  const wrong = "https://account-login.example.test/elsewhere";
  // The reference: the continue's mismatch answer for REF.
  const ref = await post(app, "/api/oauth/authorize/human", f.person, { clientId: f.ref.clientId, serverId: f.a.id, returnUrl: wrong, scopes: LOGIN_SCOPES, oidc: true });
  assert.deepEqual(JSON.parse(ref.body), { error: "returnUrl does not match registered OAuth client" });

  const audit = () => getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, f.client.id), eq(integrationAuditEvents.eventType, "oauth.redirect_mismatch")));
  const before = await requestCount(f.client.id);
  for (const returnUrl of [wrong, `${RETURN_URL}/`, `${RETURN_URL}?x=1`]) {
    assert.deepEqual(await authorizeAccount(app, f.person, accountBody(f.client.clientId, { returnUrl }).body), ref, returnUrl);
  }
  const events = await audit();
  assert.equal(events.length, 3);
  assert.equal(events[0]!.serverId, null);
  assert.deepEqual(events[0]!.metadata, { clientKey: f.client.clientId, errorCode: "return_url_mismatch" });
  // The registered URL with surrounding spaces is the registered URL.
  assert.equal((await authorizeAccount(app, f.person, accountBody(f.client.clientId, { returnUrl: ` ${RETURN_URL} ` }).body)).status, 200);
  assert.equal(await requestCount(f.client.id), before + 1);
  // Missing: a 400 before anything is read.
  assert.deepEqual(
    await authorizeAccount(app, f.person, accountBody(f.client.clientId, { returnUrl: undefined }).body),
    { ...ref, body: JSON.stringify({ error: "returnUrl is required" }) },
  );

  // Outside the audience, the mismatch is never reached.
  const outsider = await seedUser("login-outsider");
  await addMember(f.c.id, outsider.id, "member");
  assert.deepEqual(await authorizeAccount(app, outsider, accountBody(f.client.clientId, { returnUrl: wrong }).body), continueRef);
  assert.equal((await audit()).length, 3);
});

test("D13: the identity scopes are the catalog's identity phase; openid approved nowhere is invalid_scope with the account wording; agent:read approved on one installation is enough; guests' installations never count", async ({ app }) => {
  const f = await seedAccountLogin(app);
  assert.deepEqual(ACCOUNT_LOGIN_IDENTITY_SCOPES, ["openid", "profile", "email", "identity"]);

  // Every identity scope, approved on A and B.
  const identity = await accountCode(app, f, { scopes: ["openid", "profile", "email", "identity"] });
  assert.deepEqual(JSON.parse(identity.answer.body).scopes, ["email", "identity", "openid", "profile"]);

  // agent:read approved on B only: granted (Q8); each request still checks its Server (T7).
  await setInstall(f.client.id, f.a.id, { approvedScopes: ALLOWED_SCOPES.filter((scope) => scope !== "agent:read") });
  const { token } = await accountLogin(app, f);
  assert.equal(token.scope, "agent:read email openid profile");
  const agentsA = await read(app, `/api/oauth/agents?server_id=${f.a.id}`, token.access_token);
  assert.deepEqual({ status: agentsA.status, body: agentsA.body }, { status: 403, body: SERVER_ACCESS_DENIED_BODY });
  assert.equal((await read(app, `/api/oauth/agents?server_id=${f.b.id}`, token.access_token)).status, 200);

  // The person a guest on B: B's approval does not count (D7); agent:read is dropped, the rest granted.
  await setRole(f.b.id, f.person.id, "guest");
  assert.deepEqual(JSON.parse((await accountCode(app, f)).answer.body).scopes, ["email", "openid", "profile"]);
  await setRole(f.b.id, f.person.id, "member");

  // A resource-bound scope is never granted in account mode (Q15), even allowed and approved.
  await getDb().update(oauthClients).set({ allowedScopes: [...ALLOWED_SCOPES, "agent:event:write"] }).where(eq(oauthClients.id, f.client.id));
  await setInstall(f.client.id, f.b.id, { approvedScopes: [...ALLOWED_SCOPES, "agent:event:write"] });
  assert.deepEqual(JSON.parse((await accountCode(app, f, { scopes: ["openid", "agent:event:write"] })).answer.body).scopes, ["openid"]);

  // openid approved nowhere: invalid_scope for the App's registered URL,
  // today's body with the account wording (no Server named); nothing written.
  // The reference: REF's continue on A with openid unapproved there.
  for (const server of [f.a, f.b]) {
    await setInstall(f.client.id, server.id, { approvedScopes: ["profile", "email"] });
  }
  await setInstall(f.ref.id, f.a.id, { approvedScopes: ["profile", "email"] });
  const ref = await post(app, "/api/oauth/authorize/human", f.person, { clientId: f.ref.clientId, serverId: f.a.id, returnUrl: RETURN_URL, scopes: ["openid", "profile"] });
  assert.equal(ref.status, 400);
  const before = await requestCount(f.client.id);
  const refused = await authorizeAccount(app, f.person, accountBody(f.client.clientId, { scopes: ["openid", "profile"] }).body);
  assert.deepEqual(refused, {
    ...ref,
    body: JSON.stringify({ ...JSON.parse(ref.body), error_description: "No Server where you can use this app has approved: openid." }),
  });
  assert.deepEqual(JSON.parse(refused.body).returnUrl, RETURN_URL);
  assert.equal(await requestCount(f.client.id), before);
  // openid approved only where the person is a guest: the same refusal.
  await setInstall(f.client.id, f.b.id, { approvedScopes: ALLOWED_SCOPES });
  await setRole(f.b.id, f.person.id, "guest");
  assert.deepEqual(await authorizeAccount(app, f.person, accountBody(f.client.clientId, { scopes: ["openid", "profile"] }).body), refused);
});

test("the exchange recomputes D13 live: a scope no longer approved anywhere is dropped; openid no longer approved is access_denied", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const dropped = await accountCode(app, f);
  const denied = await accountCode(app, f);
  for (const server of [f.a, f.b]) {
    await setInstall(f.client.id, server.id, { approvedScopes: ["openid", "profile", "email"] });
  }
  const answer = await exchange(app, f.client, dropped.code, { verifier: dropped.verifier });
  assert.equal(answer.status, 200, answer.body);
  assert.equal((JSON.parse(answer.body) as TokenBody).scope, "email openid profile");

  for (const server of [f.a, f.b]) {
    await setInstall(f.client.id, server.id, { approvedScopes: ["profile", "email"] });
  }
  const refused = await exchange(app, f.client, denied.code, { verifier: denied.verifier });
  assert.deepEqual({ status: refused.status, body: refused.body }, { status: 403, body: ACCESS_DENIED_BODY });
});

test("T14-lite, T4: the exchange re-checks the audience live: leaving one audience Server is fine, leaving the last (or every installation suspended) is access_denied, and the code is not consumed", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const kept = await accountCode(app, f);
  const lost = await accountCode(app, f);
  const suspended = await accountCode(app, f);

  // Every installation suspended (T4): access_denied.
  await setInstall(f.client.id, f.a.id, { status: "suspended" });
  await setInstall(f.client.id, f.b.id, { status: "suspended" });
  const refusedSuspended = await exchange(app, f.client, suspended.code, { verifier: suspended.verifier });
  assert.deepEqual({ status: refusedSuspended.status, body: refusedSuspended.body }, { status: 403, body: ACCESS_DENIED_BODY });
  await setInstall(f.client.id, f.a.id, { status: "active" });
  await setInstall(f.client.id, f.b.id, { status: "active" });

  await removeMember(f.a.id, f.person.id);
  assert.equal((await exchange(app, f.client, kept.code, { verifier: kept.verifier })).status, 200, "B still holds the person");
  await removeMember(f.b.id, f.person.id);
  const refused = await exchange(app, f.client, lost.code, { verifier: lost.verifier });
  assert.deepEqual(refused, refusedSuspended, "the same refusal");
  const rows = await requestRowOf(f.client.id, f.person.id);
  assert.equal(rows.filter((row) => row.consumedAt === null).length, 2, "the refused codes are not consumed");
});

test("the exchange keeps today's one-time and ten-minute rules for an account code", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const refs = await tokenReferences(app, f);
  const login = await accountCode(app, f);
  assert.equal((await exchange(app, f.client, login.code, { verifier: login.verifier })).status, 200);
  assert.deepEqual(await exchange(app, f.client, login.code, { verifier: login.verifier }), refs.deadCode, "replayed");

  const late = await accountCode(app, f);
  await getDb().execute(sql`UPDATE "oauth_access_requests" SET "created_at" = now() - interval '11 minutes'
    WHERE "server_id" IS NULL AND "consumed_at" IS NULL AND "client_id" = ${f.client.id}`);
  assert.deepEqual(await exchange(app, f.client, late.code, { verifier: late.verifier }), refs.deadCode, "expired");
});

test("T17 (Q15): an account exchange with a resource is a 400, before anything is written; without one the same code works", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const login = await accountCode(app, f);
  const tokensBefore = await tokenCount(f.client.id);
  for (const resource of [`urn:raft:server:${f.a.id}:agent-inbound`, "https://resource.example.test", " "]) {
    const answer = await exchange(app, f.client, login.code, { verifier: login.verifier, extra: { resource } });
    assert.deepEqual({ status: answer.status, body: answer.body }, {
      status: 400,
      body: JSON.stringify({ error: "resource is not supported for account-mode logins" }),
    }, resource);
  }
  assert.equal(await tokenCount(f.client.id), tokensBefore);
  const answer = await exchange(app, f.client, login.code, { verifier: login.verifier, extra: { resource: "" } });
  assert.equal(answer.status, 200, answer.body);
  assert.equal("resource" in JSON.parse(answer.body), false);
});

test("/authorize/human for an account-mode App: 409 login_mode_changed only where the account login is open to the person on that Server, else the one refusal; never a write", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { continueRef } = await notAvailableReferences(app, f);
  const human = (serverId: string, person = f.person) => post(app, "/api/oauth/authorize/human", person, {
    clientId: f.client.clientId, serverId, returnUrl: RETURN_URL, scopes: LOGIN_SCOPES,
  });
  const before = await requestCount(f.client.id);

  const changed = await human(f.a.id);
  assert.deepEqual({ status: changed.status, body: changed.body }, { status: 409, body: LOGIN_MODE_CHANGED_BODY });
  assert.deepEqual(await human(f.b.id), changed, "B, the other audience Server");
  assert.deepEqual(await human(f.c.id), continueRef, "C: no installation");
  assert.deepEqual(await human(f.publisher.id), continueRef, "the publisher's Server: not a member");
  assert.deepEqual(await human(randomUUID()), continueRef, "an unknown Server");
  await setInstall(f.client.id, f.b.id, { status: "suspended" });
  assert.deepEqual(await human(f.b.id), continueRef, "B suspended: not installation_suspended");
  await setInstall(f.client.id, f.b.id, { status: "active" });
  await setRole(f.a.id, f.person.id, "guest");
  assert.deepEqual(await human(f.a.id), continueRef, "a guest on A");
  await setRole(f.a.id, f.person.id, "member");
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
  assert.deepEqual(await human(f.a.id), continueRef, "the App disabled");
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, f.client.id));
  await setAccountLoginFlag("off");
  assert.deepEqual(await human(f.a.id), continueRef, "the kill switch off");
  await setAccountLoginFlag("on");
  assert.deepEqual(await human(f.a.id), changed);
  assert.equal(await requestCount(f.client.id), before, "no Server-bound code for an account-mode App");

  // A server-mode App on the same Server: today's code.
  const ref = await post(app, "/api/oauth/authorize/human", f.person, { clientId: f.ref.clientId, serverId: f.a.id, returnUrl: RETURN_URL, scopes: LOGIN_SCOPES });
  assert.equal(ref.status, 200, ref.body);
  assert.equal(JSON.parse(ref.body).server.id, f.a.id);
});

test("lookup for an account-mode App: today's ready, suspended and install answers plus loginMode; a guest, the kill switch off and a non-member get the one refusal; a server-mode App's answer has no loginMode", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { lookupRef } = await notAvailableReferences(app, f);
  const plus = (answer: Answer) => ({ ...answer, body: JSON.stringify({ ...JSON.parse(answer.body), loginMode: "account" }) });

  await setInstall(f.client.id, f.b.id, { status: "suspended" });
  const now = {
    ready: await lookup(app, f.person, f.client.clientId, f.a.id),
    suspended: await lookup(app, f.person, f.client.clientId, f.b.id),
    install: await lookup(app, f.person, f.client.clientId, f.c.id),
  };
  assert.deepEqual(now.ready, plus(f.before.ready), "ready on A");
  assert.deepEqual(now.suspended, plus(f.before.suspended), "suspended on B");
  assert.deepEqual(now.install, plus(f.before.install), "install on C");
  assert.equal(Object.keys(JSON.parse(now.ready.body)).at(-1), "loginMode");

  for (const state of ["off", "killed", "missing"] as const) {
    await setAccountLoginFlag(state);
    for (const server of [f.a, f.b, f.c]) {
      assert.deepEqual(await lookup(app, f.person, f.client.clientId, server.id), lookupRef, `flag ${state}, ${server.name}`);
    }
  }
  await setAccountLoginFlag("on");
  for (const server of [f.a, f.b, f.c]) {
    await setRole(server.id, f.person.id, "guest");
    assert.deepEqual(await lookup(app, f.person, f.client.clientId, server.id), lookupRef, `a guest on ${server.name}`);
    await setRole(server.id, f.person.id, "member");
  }
  assert.deepEqual(await lookup(app, f.person, f.client.clientId, f.publisher.id), lookupRef, "not a member");
  // Disabled, it is not ready anywhere (the account audience reads `enabled`).
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
  assert.deepEqual(await lookup(app, f.person, f.client.clientId, f.a.id), lookupRef, "disabled");
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, f.client.id));
  assert.deepEqual(await lookup(app, f.person, f.client.clientId, f.a.id), now.ready);

  // REF, in server mode on the same Servers: no loginMode.
  const ref = await lookup(app, f.person, f.ref.clientId, f.a.id);
  assert.equal(ref.status, 200);
  assert.equal("loginMode" in JSON.parse(ref.body), false);
});

test("Q4: authorize/account says installation_suspended when every installation on the person's Servers is suspended; as a guest there, the one refusal", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { continueRef } = await notAvailableReferences(app, f);
  await setInstall(f.client.id, f.a.id, { status: "suspended" });
  assert.equal((await authorizeAccount(app, f.person, accountBody(f.client.clientId).body)).status, 200, "B is still active");
  await setInstall(f.client.id, f.b.id, { status: "suspended" });
  const answer = await authorizeAccount(app, f.person, accountBody(f.client.clientId).body);
  assert.deepEqual({ status: answer.status, body: answer.body }, {
    status: 403,
    body: JSON.stringify({
      error: "installation_suspended",
      errorCode: "OAUTH_INSTALLATION_SUSPENDED",
      error_description: "This App's installations on your Servers are suspended. Ask a Server owner or admin to restore it.",
    }),
  });
  await setRole(f.a.id, f.person.id, "guest");
  await setRole(f.b.id, f.person.id, "guest");
  assert.deepEqual(await authorizeAccount(app, f.person, accountBody(f.client.clientId).body), continueRef);
});

test("kill switch: with oauth_account_login off for the person, every new account login is refused: the lookup, authorize/account and the token exchange", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { continueRef, lookupRef } = await notAvailableReferences(app, f);
  // The exchange's reference: a person outside the audience at exchange time.
  const leaver = await seedUser("login-leaver");
  await addMember(f.a.id, leaver.id, "member");
  const leaverCode = await accountCode(app, f, { person: leaver });
  await removeMember(f.a.id, leaver.id);
  const outsideRef = await exchange(app, f.client, leaverCode.code, { verifier: leaverCode.verifier });
  assert.deepEqual({ status: outsideRef.status, body: outsideRef.body }, { status: 403, body: ACCESS_DENIED_BODY });

  // A code issued while the switch is on.
  const open = await accountCode(app, f);
  const tokensBefore = await tokenCount(f.client.id);
  for (const state of ["off", "killed", "missing"] as const) {
    await setAccountLoginFlag(state);
    assert.deepEqual(await lookup(app, f.person, f.client.clientId, f.a.id), lookupRef, `lookup, flag ${state}`);
    assert.deepEqual(await authorizeAccount(app, f.person, accountBody(f.client.clientId).body), continueRef, `authorize/account, flag ${state}`);
    assert.deepEqual(await exchange(app, f.client, open.code, { verifier: open.verifier }), outsideRef, `exchange, flag ${state}`);
  }
  assert.equal(await tokenCount(f.client.id), tokensBefore, "no token while it is off");
  // Server mode never reads it: REF still logs in.
  const ref = await serverModeOidcCode(app, f.person, f.ref, f.a.id);
  assert.equal((await exchange(app, f.ref, ref.code, { verifier: ref.verifier })).status, 200);

  // On again: the lookup and the login answer again (the refused code was never consumed).
  await setAccountLoginFlag("on");
  assert.equal((await lookup(app, f.person, f.client.clientId, f.a.id)).status, 200);
  assert.equal((await exchange(app, f.client, open.code, { verifier: open.verifier })).status, 200);
});

test("kill switch: a token issued while the flag was on stops working on the very next request once it is off, and works again when it is back on", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { token } = await accountLogin(app, f);
  const unknownRef = await read(app, "/api/oauth/userinfo", "slock_at_not-a-token");
  assert.equal(unknownRef.status, 401);
  assert.deepEqual(JSON.parse(unknownRef.body), { error: "Invalid or expired access token" });

  const live = await read(app, "/api/oauth/userinfo", token.access_token);
  assert.equal(live.status, 200, live.body);
  assert.equal((await read(app, "/api/oauth/servers", token.access_token)).status, 200);
  for (const state of ["off", "killed", "missing"] as const) {
    await setAccountLoginFlag(state);
    assert.deepEqual(await read(app, "/api/oauth/userinfo", token.access_token), unknownRef, `userinfo, flag ${state}`);
    assert.deepEqual(await read(app, "/api/oauth/servers", token.access_token), await read(app, "/api/oauth/servers", "slock_at_not-a-token"), `servers, flag ${state}`);
    await setAccountLoginFlag("on");
    assert.deepEqual(await read(app, "/api/oauth/userinfo", token.access_token), live, `userinfo, on again after ${state}`);
  }
});

test("a server-local App in account mode: ready on its own Server, every allowed scope granted (no installation gate); disabled, refused everywhere (Q11)", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const { continueRef, lookupRef } = await notAvailableReferences(app, f);
  const { client, clientSecret } = await createOAuthClient({
    serverId: f.a.id,
    createdByUserId: f.owner.id,
    clientId: `account-local-${f.suffix}`,
    name: "Account Local",
    returnUrl: RETURN_URL,
    allowedScopes: ALLOWED_SCOPES,
  });
  assert.equal(client.appType, "server_local");
  const local: RegisteredApp = { id: client.id, clientId: client.clientId, clientSecret };
  const before = await lookup(app, f.person, local.clientId, f.a.id);
  assert.equal(before.status, 200, before.body);
  await switchToAccountMode(local.id);

  assert.deepEqual(await lookup(app, f.person, local.clientId, f.a.id), { ...before, body: JSON.stringify({ ...JSON.parse(before.body), loginMode: "account" }) });
  assert.deepEqual(await lookup(app, f.person, local.clientId, f.b.id), lookupRef, "another Server");
  const { verifier, body } = accountBody(local.clientId, { scopes: ["openid", "profile", "email", "identity", "agent:read"] });
  const authorized = await authorizeAccount(app, f.person, body);
  assert.equal(authorized.status, 200, authorized.body);
  assert.deepEqual(JSON.parse(authorized.body).scopes, ["agent:read", "email", "identity", "openid", "profile"]);
  const answer = await exchange(app, local, (JSON.parse(authorized.body) as { code: string }).code, { verifier });
  assert.equal(answer.status, 200, answer.body);

  // Disabled: server mode's lookup does not read `enabled` for a server-local
  // App; account mode's audience does, so the lookup and the login refuse.
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, local.id));
  assert.deepEqual(await lookup(app, f.person, local.clientId, f.a.id), lookupRef, "lookup, disabled");
  assert.deepEqual(await authorizeAccount(app, f.person, accountBody(local.clientId).body), continueRef, "authorize/account, disabled");
});

// A person's Login with Raft code dies with the sign-in that asked for it
// (#raft-architecture msg=532a7a40, B2), in account mode (APP) and server mode
// (REF, on A). Two guards, each enough alone: the exchange refuses a code
// whose sign-in is no longer live, and every revoke of that sign-in denies
// the codes it asked for that nobody exchanged.

type Approver = Awaited<ReturnType<typeof signInForTest>>;

function signedInAs(f: Seeded, approver: Approver): Person {
  return { ...f.person, bearer: approver.token };
}

/** Both codes a sign-in asks for: an account-mode one for APP, a server-mode one for REF on A. */
async function codesAskedBy(app: Base, f: Seeded, approver: Approver) {
  return {
    account: await accountCode(app, f, { person: signedInAs(f, approver) }),
    server: await serverModeOidcCode(app, signedInAs(f, approver), f.ref, f.a.id),
  };
}

async function logoutOf(app: Base, approver: Approver) {
  const res = await fetch(`${app.baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: approver.refreshToken }),
  });
  assert.equal(res.status, 200);
}

async function resetThePassword(userId: string) {
  const token = randomUUID();
  await getDb().insert(passwordResets).values({
    userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(await resetPassword(token, "a-new-password-456"), { success: true, userId });
}

async function consentsOf(userId: string, clientId: string) {
  return (await getDb().select({ serverId: oauthUserConsents.serverId }).from(oauthUserConsents)
    .where(and(eq(oauthUserConsents.userId, userId), eq(oauthUserConsents.clientId, clientId))))
    .map((consent) => String(consent.serverId)).sort();
}

/** The requests a sign-in asked for, by status. */
async function requestStatusesOf(familyId: string) {
  return (await getDb().select({ status: oauthAccessRequests.status, consumedAt: oauthAccessRequests.consumedAt })
    .from(oauthAccessRequests).where(eq(oauthAccessRequests.approverSessionFamilyId, familyId)))
    .map((row) => `${row.status}${row.consumedAt ? "+consumed" : ""}`).sort();
}

/** Exchanged after the sign-in went: access_denied, as a denied code is, and no token or consent written. */
async function assertCodesRefused(app: Base, f: Seeded, codes: Awaited<ReturnType<typeof codesAskedBy>>, label: string) {
  const written = async () => ({
    appTokens: await tokenCount(f.client.id),
    refTokens: await tokenCount(f.ref.id),
    appConsents: await consentsOf(f.person.id, f.client.id),
    refConsents: await consentsOf(f.person.id, f.ref.id),
  });
  const before = await written();
  for (const [mode, client, code] of [["account", f.client, codes.account], ["server", f.ref, codes.server]] as const) {
    const answer = await exchange(app, client, code.code, { verifier: code.verifier });
    assert.equal(answer.status, 403, `${label} (${mode}): ${answer.body}`);
    assert.equal(answer.body, ACCESS_DENIED_BODY, `${label} (${mode})`);
  }
  assert.deepEqual(await written(), before, `${label}: no token, no consent`);
}

test("B2: a code dies with the sign-in that asked for it: after a logout or a password reset the exchange is access_denied in both modes and writes nothing; a live sign-in's codes still work", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const signedOut = await signInForTest(f.person.id);
  const live = await signInForTest(f.person.id);
  const ofSignedOut = await codesAskedBy(app, f, signedOut);
  const ofLive = await codesAskedBy(app, f, live);

  await logoutOf(app, signedOut);
  await assertCodesRefused(app, f, ofSignedOut, "sign-in signed out");
  // Another sign-in of the same person is untouched: both its codes log in.
  const accountLogin = await exchange(app, f.client, ofLive.account.code, { verifier: ofLive.account.verifier });
  assert.equal(accountLogin.status, 200, accountLogin.body);
  const serverLogin = await exchange(app, f.ref, ofLive.server.code, { verifier: ofLive.server.verifier });
  assert.equal(serverLogin.status, 200, serverLogin.body);
  assert.deepEqual(await consentsOf(f.person.id, f.client.id), [f.a.id, "null"].sort());
  assert.deepEqual(await consentsOf(f.person.id, f.ref.id), [f.a.id]);

  const beforeReset = await codesAskedBy(app, f, await signInForTest(f.person.id));
  await resetThePassword(f.person.id);
  await assertCodesRefused(app, f, beforeReset, "password reset after the code");
});

test("B2: authorize/human and authorize/account record the sign-in that asked; revoking it denies its unexchanged codes, a password reset every one of the person's", async ({ app }) => {
  const f = await seedAccountLogin(app);
  const signedOut = await signInForTest(f.person.id);
  const other = await signInForTest(f.person.id);
  await codesAskedBy(app, f, signedOut);
  await codesAskedBy(app, f, other);
  const exchanged = await codesAskedBy(app, f, other);
  assert.equal((await exchange(app, f.client, exchanged.account.code, { verifier: exchanged.account.verifier })).status, 200);
  assert.deepEqual(await requestStatusesOf(signedOut.familyId), ["approved", "approved"]);

  await logoutOf(app, signedOut);
  assert.deepEqual(await requestStatusesOf(signedOut.familyId), ["denied", "denied"]);
  assert.deepEqual(await requestStatusesOf(other.familyId), ["approved", "approved", "approved", "approved+consumed"], "another sign-in's codes stay");

  await resetThePassword(f.person.id);
  assert.deepEqual(await requestStatusesOf(other.familyId), ["approved+consumed", "denied", "denied", "denied"], "an exchanged code is left as it is");
});

test("B2: the exchange itself refuses a code whose sign-in is no longer live, though nothing denied it, and a code that records no sign-in", async ({ app }) => {
  const f = await seedAccountLogin(app);
  // Revoked the way no revoker does here, so its codes stay `approved`.
  const revoked = await signInForTest(f.person.id);
  const ofRevoked = await codesAskedBy(app, f, revoked);
  await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(sessionFamilies.id, revoked.familyId));
  await assertCodesRefused(app, f, ofRevoked, "sign-in revoked");
  assert.deepEqual(await requestStatusesOf(revoked.familyId), ["approved", "approved"], "refused at the exchange, not consumed");

  // Issued before the column (or by anything that records no sign-in): refused.
  const unrecorded = await signInForTest(f.person.id);
  const ofUnrecorded = await codesAskedBy(app, f, unrecorded);
  await getDb().update(oauthAccessRequests).set({ approverSessionFamilyId: null }).where(eq(oauthAccessRequests.approverSessionFamilyId, unrecorded.familyId));
  await assertCodesRefused(app, f, ofUnrecorded, "no sign-in recorded");
});
