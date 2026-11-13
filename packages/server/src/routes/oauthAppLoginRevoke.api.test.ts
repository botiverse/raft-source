import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  featureFlags,
  integrationAuditEvents,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthClients,
  oauthLinkPreviewDeclines,
  oauthUserConsents,
  users,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import {
  createOAuthClient,
  grantOAuthUserConsent,
  installMarketplaceOAuthClient,
} from "../services/oauthService";
import { addMember, createServer } from "../services/serverService";

// RFC 079 phase 3a, PR 4: per-app revoke (design §3.2; threat T14; Q9).
// GET /api/me/app-logins lists the caller's account-mode logins; DELETE
// /api/me/app-logins/:clientId revokes everything one App holds of the
// caller: open requests, tokens and consents, on every Server and none.
//
// Account-mode logins go through the real PR 3 flow (authorize/account, then
// /token) once the App is switched with SQL, as the reviewed switch would, and
// the kill switch is on; server-mode logins are made before the switch.
// Refusals are compared whole (status, RECORDED_HEADERS, body) with a
// reference answer.
const test = createApiTest({ skipAuthRateLimit: true });

const RETURN_URL = "https://app-login-revoke.example.test/login/raft/callback";
const ALLOWED_SCOPES = ["openid", "profile", "email", "identity", "agent:read"];
const LOGIN_SCOPES = ["openid", "profile", "email"];
const RECORDED_HEADERS = ["cache-control", "content-type", "location", "pragma", "www-authenticate"] as const;
const ACCESS_DENIED_BODY = JSON.stringify({ error: "access_denied" });

type Base = { baseUrl: string };
type Answer = { status: number; headers: Record<string, string>; body: string };
type RegisteredApp = { id: string; clientId: string; clientSecret: string };
type Person = Awaited<ReturnType<typeof seedUser>>;
type TokenBody = { access_token: string; scope: string };

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

function challenge(verifier: string) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function call(app: Base, method: string, path: string, person: Person | null, body?: Record<string, unknown>): Promise<Answer> {
  return fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(person ? { Authorization: `Bearer ${person.bearer}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(answerOf);
}

function listLogins(app: Base, person: Person | null) {
  return call(app, "GET", "/api/me/app-logins", person);
}

function revoke(app: Base, person: Person | null, clientKey: string) {
  return call(app, "DELETE", `/api/me/app-logins/${clientKey}`, person);
}

function bearerRead(app: Base, path: string, token: string): Promise<Answer> {
  return fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(answerOf);
}

function exchange(app: Base, client: RegisteredApp, code: { code: string; verifier: string }): Promise<Answer> {
  return fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code.code, redirect_uri: RETURN_URL, code_verifier: code.verifier }),
  }).then(answerOf);
}

/** A code from the setup page's continue: account mode's (no Server) or, before the switch, server mode's on `serverId`. */
async function loginCode(app: Base, person: Person, client: RegisteredApp, serverId?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const answer = await call(app, "POST", serverId ? "/api/oauth/authorize/human" : "/api/oauth/authorize/account", person, {
    clientId: client.clientId,
    ...(serverId ? { serverId } : {}),
    returnUrl: RETURN_URL,
    scopes: LOGIN_SCOPES,
    oidc: true,
    nonce: `nonce-${randomUUID()}`,
    codeChallenge: challenge(verifier),
    codeChallengeMethod: "S256",
  });
  assert.equal(answer.status, 200, `fixture: continue (${answer.status}): ${answer.body}`);
  return { code: (JSON.parse(answer.body) as { code: string }).code, verifier };
}

/** A whole login (continue, then /token); its access token. */
async function login(app: Base, person: Person, client: RegisteredApp, serverId?: string) {
  const answer = await exchange(app, client, await loginCode(app, person, client, serverId));
  assert.equal(answer.status, 200, `fixture: exchange (${answer.status}): ${answer.body}`);
  return (JSON.parse(answer.body) as TokenBody).access_token;
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

/** The reviewed switch's write, with SQL (db/oauthClientLoginMode.test.ts). */
async function switchToAccountMode(clientId: string) {
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${clientId}`);
}

async function turnAccountLoginOn() {
  const values = { enabled: true, killSwitch: false, defaultEnabled: true };
  await getDb().insert(featureFlags)
    .values({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "app-login-revoke-test", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Every row a revoke could touch, ordered, for "nothing changed" comparisons. */
async function snapshot() {
  const db = getDb();
  return {
    requests: await db.select().from(oauthAccessRequests).orderBy(asc(oauthAccessRequests.id)),
    tokens: await db.select().from(oauthAccessTokens).orderBy(asc(oauthAccessTokens.id)),
    consents: await db.select().from(oauthUserConsents).orderBy(asc(oauthUserConsents.id)),
    declines: await db.select().from(oauthLinkPreviewDeclines).orderBy(asc(oauthLinkPreviewDeclines.id)),
    audit: await db.select().from(integrationAuditEvents).orderBy(asc(integrationAuditEvents.id)),
  };
}

async function consentsOf(userId: string, clientId: string) {
  return getDb().select().from(oauthUserConsents)
    .where(and(eq(oauthUserConsents.userId, userId), eq(oauthUserConsents.clientId, clientId)));
}

async function tokenRow(token: string) {
  const [row] = await getDb().select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash(token)));
  assert.ok(row);
  return row;
}

async function revokedAuditRows(clientId?: string) {
  return getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "oauth.app_login_revoked"),
    clientId ? eq(integrationAuditEvents.clientId, clientId) : undefined,
  ));
}

/**
 * APP and OTHER, published third-party Apps installed on A and B; REF, the
 * same, never switched. The person and a bystander are members of A and B.
 * Before APP switches: the person's server-mode login on A (its token and
 * consent) and an open server-mode code on A; the bystander's server-mode
 * login on A. Then APP and OTHER switch and the flag goes on: the person's
 * account login to APP and to OTHER, an open account code for APP, a
 * link-preview consent and a decline for APP on B (the prompt's own writes);
 * the bystander's account login to APP and an open account code; the
 * person's server-mode login to REF.
 */
async function seedRevoke(app: Base) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("revoke-owner");
  const person = await seedUser("revoke-person");
  const bystander = await seedUser("revoke-bystander");
  const publisher = await createServer("Revoke Publisher", `revoke-pub-${suffix}`, owner.id);
  const a = await createServer(`Revoke A ${suffix}`, `revoke-a-${suffix}`, owner.id);
  const b = await createServer(`Revoke B ${suffix}`, `revoke-b-${suffix}`, owner.id);
  for (const server of [a, b]) {
    await addMember(server.id, person.id, "member");
    await addMember(server.id, bystander.id, "member");
  }
  const client = await registerApp("revoke", publisher, owner, suffix, [a, b]);
  const other = await registerApp("other", publisher, owner, suffix, [a, b]);
  const ref = await registerApp("reference", publisher, owner, suffix, [a, b]);

  const preSwitch = {
    token: await login(app, person, client, a.id),
    openCode: await loginCode(app, person, client, a.id),
    bystanderToken: await login(app, bystander, client, a.id),
  };

  await switchToAccountMode(client.id);
  await switchToAccountMode(other.id);
  await turnAccountLoginOn();

  const tokens = {
    account: await login(app, person, client),
    other: await login(app, person, other),
    bystanderAccount: await login(app, bystander, client),
    ref: await login(app, person, ref, a.id),
  };
  const openAccountCode = await loginCode(app, person, client);
  const bystanderOpenCode = await loginCode(app, bystander, client);
  await grantOAuthUserConsent(getDb(), {
    userId: person.id, serverId: b.id, clientId: client.id, scopes: ["openid", "profile"], source: "preview_prompt", now: new Date(),
  });
  await getDb().insert(oauthLinkPreviewDeclines).values({ userId: person.id, serverId: a.id, clientId: client.id });
  return { suffix, owner, person, bystander, publisher, a, b, client, other, ref, preSwitch, tokens, openAccountCode, bystanderOpenCode };
}

/** Today's 401 of an unknown token on an identity endpoint. */
function unknownTokenAnswer(app: Base) {
  return bearerRead(app, "/api/oauth/userinfo", `slock_at_${randomBytes(32).toString("hex")}`);
}

test("T14: revoke ends every login the App holds of the person at once: account and pre-switch tokens 401, open codes access_denied, the account and per-Server consents revoked; other Apps and people untouched; audited with counts", async ({ app }) => {
  const f = await seedRevoke(app);
  // Witness: the person holds an account consent and two per-Server ones (a
  // login on A before the switch, the link-preview prompt on B).
  assert.deepEqual((await consentsOf(f.person.id, f.client.id)).map((row) => `${row.serverId}:${row.source}:${row.revokedAt}`).sort(),
    [`null:login:null`, `${f.a.id}:login:null`, `${f.b.id}:preview_prompt:null`].sort());
  const unknown = await unknownTokenAnswer(app);
  assert.equal(unknown.status, 401);
  for (const token of [f.tokens.account, f.preSwitch.token, f.tokens.other, f.tokens.bystanderAccount, f.preSwitch.bystanderToken, f.tokens.ref]) {
    assert.equal((await bearerRead(app, "/api/oauth/userinfo", token)).status, 200, "witness: live before the revoke");
  }
  const otherConsentsBefore = await consentsOf(f.person.id, f.other.id);
  const bystanderConsentsBefore = await consentsOf(f.bystander.id, f.client.id);
  const refConsentsBefore = await consentsOf(f.person.id, f.ref.id);
  const declinesBefore = await getDb().select().from(oauthLinkPreviewDeclines);

  const answer = await revoke(app, f.person, f.client.clientId);
  assert.deepEqual({ status: answer.status, body: answer.body }, { status: 204, body: "" });

  // The account-mode token and the server-mode token issued before the
  // switch: today's 401, on the very next request.
  assert.deepEqual(await bearerRead(app, "/api/oauth/userinfo", f.tokens.account), unknown, "account-mode token");
  assert.deepEqual(await bearerRead(app, "/api/oauth/userinfo", f.preSwitch.token), unknown, "pre-switch server-mode token");
  assert.deepEqual(await bearerRead(app, `/api/oauth/serverinfo?server_id=${f.a.id}`, f.preSwitch.token), unknown);
  for (const token of [f.tokens.account, f.preSwitch.token]) {
    assert.ok((await tokenRow(token)).revokedAt, "revoked in the row");
  }

  // Open codes: the revoke denied their requests, so each exchange answers
  // access_denied (the denied-request answer, as after an uninstall), not
  // invalid_grant: the code is still well-formed, unexpired and unused, the
  // person refused it. Nothing is minted.
  const tokensBefore = await getDb().select({ n: sql<number>`count(*)::int` }).from(oauthAccessTokens);
  for (const code of [f.openAccountCode, f.preSwitch.openCode]) {
    const refused = await exchange(app, f.client, code);
    assert.deepEqual({ status: refused.status, body: refused.body }, { status: 403, body: ACCESS_DENIED_BODY });
  }
  assert.deepEqual(await getDb().select({ n: sql<number>`count(*)::int` }).from(oauthAccessTokens), tokensBefore);
  const requests = await getDb().select().from(oauthAccessRequests)
    .where(and(eq(oauthAccessRequests.userId, f.person.id), eq(oauthAccessRequests.clientId, f.client.id)));
  // The two exchanged logins stay consumed; the two open codes are denied.
  assert.deepEqual(requests.map((row) => `${row.serverId}:${row.status}:${row.consumedAt !== null}`).sort(), [
    `${f.a.id}:approved:true`,
    `${f.a.id}:denied:false`,
    "null:approved:true",
    "null:denied:false",
  ].sort());
  for (const row of requests.filter((request) => request.status === "denied")) {
    assert.equal(row.resolvedByUserId, f.person.id);
    assert.equal(row.remember, false);
  }

  // Every consent of the person to APP: the account-mode one and both
  // per-Server ones (the login on A, the link-preview prompt on B: Q9).
  const consents = await consentsOf(f.person.id, f.client.id);
  assert.deepEqual(consents.map((row) => row.serverId).sort(), [null, f.a.id, f.b.id].sort());
  for (const row of consents) assert.ok(row.revokedAt, `consent on ${row.serverId ?? "no Server"} revoked`);
  // The link-preview decline is the person's own answer: kept.
  assert.deepEqual(await getDb().select().from(oauthLinkPreviewDeclines), declinesBefore);

  // Untouched: the person's other account-mode App, the person's server-mode
  // App, and the bystander's account-mode and server-mode logins to APP.
  for (const token of [f.tokens.other, f.tokens.ref, f.tokens.bystanderAccount, f.preSwitch.bystanderToken]) {
    assert.equal((await bearerRead(app, "/api/oauth/userinfo", token)).status, 200);
    assert.equal((await tokenRow(token)).revokedAt, null);
  }
  assert.deepEqual(await consentsOf(f.person.id, f.other.id), otherConsentsBefore);
  assert.deepEqual(await consentsOf(f.bystander.id, f.client.id), bystanderConsentsBefore);
  assert.deepEqual(await consentsOf(f.person.id, f.ref.id), refConsentsBefore);
  for (const row of [...otherConsentsBefore, ...bystanderConsentsBefore, ...refConsentsBefore]) assert.equal(row.revokedAt, null);
  // The bystander's open code for APP still works.
  assert.equal((await exchange(app, f.client, f.bystanderOpenCode)).status, 200);

  // One audit row: the person's own act, on no Server's page, with the counts:
  // two open requests (the account code, the pre-switch code on A), two
  // tokens (account, pre-switch), one account consent, two per-Server ones.
  const audit = await revokedAuditRows();
  assert.equal(audit.length, 1);
  const [row] = audit;
  assert.deepEqual({
    serverId: row!.serverId,
    clientId: row!.clientId,
    eventCategory: row!.eventCategory,
    outcome: row!.outcome,
    source: row!.source,
    actor: [row!.actorType, row!.actorId],
    subject: [row!.subjectType, row!.subjectId],
    target: [row!.targetType, row!.targetId],
    metadata: row!.metadata,
    diff: row!.diff,
  }, {
    serverId: null,
    clientId: f.client.id,
    eventCategory: "revocation",
    outcome: "success",
    source: "web",
    actor: ["human", f.person.id],
    subject: ["human", f.person.id],
    target: ["app", f.client.id],
    metadata: {
      clientKey: f.client.clientId,
      deniedPendingRequestCount: 2,
      revokedTokenCount: 2,
      revokedAccountConsentCount: 1,
      revokedServerConsentCount: 2,
    },
    diff: null,
  });

  // A second revoke finds nothing: 204, nothing written, no second audit row.
  const before = await snapshot();
  assert.deepEqual(await revoke(app, f.person, f.client.clientId), answer);
  assert.deepEqual(await snapshot(), before);
});

test("GET /api/me/app-logins: the caller's active account-mode consents only, newest first, camelCase, no-store; empty after a revoke, back after a new login", async ({ app }) => {
  const f = await seedRevoke(app);
  // Pin the order: OTHER's consent a minute older than APP's.
  await getDb().execute(sql`UPDATE "oauth_user_consents" SET "granted_at" = "granted_at" - interval '1 minute'
    WHERE "user_id" = ${f.person.id} AND "client_id" = ${f.other.id} AND "server_id" IS NULL`);
  const accountConsent = async (userId: string, clientId: string) => {
    const [row] = await getDb().select().from(oauthUserConsents)
      .where(and(eq(oauthUserConsents.userId, userId), eq(oauthUserConsents.clientId, clientId), isNull(oauthUserConsents.serverId)));
    assert.ok(row);
    return row;
  };
  const expected = async (client: RegisteredApp, name: string, userId = f.person.id) => {
    const row = await accountConsent(userId, client.id);
    return { id: row.id, clientId: client.clientId, name, logoUrl: null, scopes: row.scopes, grantedAt: row.grantedAt.toISOString() };
  };

  const listed = await listLogins(app, f.person);
  assert.equal(listed.status, 200, listed.body);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.match(listed.headers["content-type"] ?? "", /^application\/json/);
  // APP and OTHER (account mode), newest first; not REF, not APP's per-Server consents.
  assert.deepEqual(JSON.parse(listed.body), [await expected(f.client, "revoke App"), await expected(f.other, "other App")]);
  assert.deepEqual(Object.keys(JSON.parse(listed.body)[0]), ["id", "clientId", "name", "logoUrl", "scopes", "grantedAt"]);
  assert.deepEqual(JSON.parse(listed.body)[0].scopes, ["email", "openid", "profile"]);
  // The bystander sees only their own.
  assert.deepEqual(JSON.parse((await listLogins(app, f.bystander)).body), [await expected(f.client, "revoke App", f.bystander.id)]);

  assert.equal((await revoke(app, f.person, f.client.clientId)).status, 204);
  assert.deepEqual(JSON.parse((await listLogins(app, f.person)).body), [await expected(f.other, "other App")]);
  assert.equal((await revoke(app, f.person, f.other.clientId)).status, 204);
  const empty = await listLogins(app, f.person);
  assert.deepEqual({ status: empty.status, cacheControl: empty.headers["cache-control"], body: empty.body }, { status: 200, cacheControl: "no-store", body: "[]" });
  assert.equal(JSON.parse((await listLogins(app, f.bystander)).body).length, 1, "the bystander's login stays");

  // Revoking is not a ban: a new login is a fresh consent, listed again.
  const revokedAt = (await accountConsent(f.person.id, f.client.id)).revokedAt;
  assert.ok(revokedAt);
  const token = await login(app, f.person, f.client);
  assert.equal((await bearerRead(app, "/api/oauth/userinfo", token)).status, 200);
  const fresh = await accountConsent(f.person.id, f.client.id);
  assert.equal(fresh.revokedAt, null);
  assert.ok(fresh.grantedAt.getTime() >= revokedAt.getTime(), "granted afresh");
  assert.deepEqual(JSON.parse((await listLogins(app, f.person)).body), [await expected(f.client, "revoke App")]);
});

test("DELETE answers 204 and changes nothing, with no audit row, for an unknown key, a malformed one, an App the person never used and a server-mode App", async ({ app }) => {
  const f = await seedRevoke(app);
  const neverUsed = await registerApp("never-used", f.publisher, f.owner, f.suffix, [f.a]);
  await switchToAccountMode(neverUsed.id);
  const before = await snapshot();
  const answers: Answer[] = [];
  for (const key of [
    `unknown-${f.suffix}`,
    encodeURIComponent(f.client.clientId.toUpperCase()),
    "%00",
    encodeURIComponent("not a key!"),
    encodeURIComponent("a'b;--"),
    encodeURIComponent("✓"),
    "x".repeat(300),
    encodeURIComponent(f.client.id),
    neverUsed.clientId,
    // Server mode: the person's REF login stays as it is today.
    f.ref.clientId,
  ]) {
    const answer = await revoke(app, f.person, key);
    assert.deepEqual({ status: answer.status, body: answer.body }, { status: 204, body: "" }, key);
    answers.push(answer);
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0], "the same answer, whatever the key");
  assert.deepEqual(await snapshot(), before, "nothing written, no audit row");
  assert.equal((await bearerRead(app, "/api/oauth/userinfo", f.tokens.ref)).status, 200);
  // Revoking APP, which the person holds, answers the same bytes.
  assert.deepEqual(await revoke(app, f.person, f.client.clientId), answers[0]);
  assert.equal((await revokedAuditRows(f.client.id)).length, 1);
});

test("both routes need a session: none gets today's 401 bytes and writes nothing", async ({ app }) => {
  const f = await seedRevoke(app);
  // Today's answer of /api/me without a session.
  const reference = await call(app, "GET", "/api/me/notification-settings", null);
  assert.equal(reference.status, 401);
  const garbled: Person = { ...f.person, bearer: "not-a-session" };
  const garbledReference = await call(app, "GET", "/api/me/notification-settings", garbled);
  assert.equal(garbledReference.status, 401);
  const before = await snapshot();
  assert.deepEqual(await listLogins(app, null), reference);
  assert.deepEqual(await revoke(app, null, f.client.clientId), reference);
  assert.deepEqual(await listLogins(app, garbled), garbledReference);
  assert.deepEqual(await revoke(app, garbled, f.client.clientId), garbledReference);
  // An App's own access token is not a session either.
  const appToken: Person = { ...f.person, bearer: f.tokens.account };
  assert.deepEqual(await revoke(app, appToken, f.client.clientId), garbledReference);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await bearerRead(app, "/api/oauth/userinfo", f.tokens.account)).status, 200);
});

// Revoke vs exchange (T14). PGlite runs every transaction on one connection,
// one at a time, so two transactions never hold row locks at once here and
// the lock order itself cannot be exercised: concurrent calls are serialised
// before they reach the database. The order is argued in
// revokeAccountAppLogin's comment: both take the request row first (the
// exchange FOR UPDATE, the revoke's denial UPDATE), so in PostgreSQL the
// second waits for the first's commit and then sees its result. These tests
// pin what each order must leave, sequentially, and that a racing pair
// leaves one of those two states.
test("revoke then exchange: the open code is access_denied and nothing is minted or consented", async ({ app }) => {
  const f = await seedRevoke(app);
  assert.equal((await revoke(app, f.person, f.client.clientId)).status, 204);
  const before = await snapshot();
  const refused = await exchange(app, f.client, f.openAccountCode);
  assert.deepEqual({ status: refused.status, body: refused.body }, { status: 403, body: ACCESS_DENIED_BODY });
  const after = await snapshot();
  assert.deepEqual(after.tokens, before.tokens);
  assert.deepEqual(after.consents, before.consents);
  assert.deepEqual(after.requests, before.requests, "the denied request stays denied, not consumed");
});

test("exchange then revoke: the token the exchange just issued is revoked with its consent", async ({ app }) => {
  const f = await seedRevoke(app);
  const issued = await exchange(app, f.client, f.openAccountCode);
  assert.equal(issued.status, 200, issued.body);
  const token = (JSON.parse(issued.body) as TokenBody).access_token;
  assert.equal((await bearerRead(app, "/api/oauth/userinfo", token)).status, 200);
  assert.equal((await revoke(app, f.person, f.client.clientId)).status, 204);
  assert.deepEqual(await bearerRead(app, "/api/oauth/userinfo", token), await unknownTokenAnswer(app));
  for (const row of await consentsOf(f.person.id, f.client.id)) assert.ok(row.revokedAt);
  // The consumed request was not open: one denial (the pre-switch code), three tokens.
  const [audit] = await revokedAuditRows(f.client.id);
  assert.deepEqual(audit?.metadata, {
    clientKey: f.client.clientId,
    deniedPendingRequestCount: 1,
    revokedTokenCount: 3,
    revokedAccountConsentCount: 1,
    revokedServerConsentCount: 2,
  });
});

test("revoke and exchange sent together: whichever runs first, no live token or active consent is left", async ({ app }) => {
  const f = await seedRevoke(app);
  const [exchanged, revoked] = await Promise.all([
    exchange(app, f.client, f.openAccountCode),
    revoke(app, f.person, f.client.clientId),
  ]);
  assert.equal(revoked.status, 204);
  if (exchanged.status === 200) {
    const token = (JSON.parse(exchanged.body) as TokenBody).access_token;
    assert.deepEqual(await bearerRead(app, "/api/oauth/userinfo", token), await unknownTokenAnswer(app));
  } else {
    assert.deepEqual({ status: exchanged.status, body: exchanged.body }, { status: 403, body: ACCESS_DENIED_BODY });
  }
  const live = await getDb().select().from(oauthAccessTokens).where(and(
    eq(oauthAccessTokens.userId, f.person.id), eq(oauthAccessTokens.clientId, f.client.id), isNull(oauthAccessTokens.revokedAt),
  ));
  assert.deepEqual(live, []);
  for (const row of await consentsOf(f.person.id, f.client.id)) assert.ok(row.revokedAt);
  const open = await getDb().select().from(oauthAccessRequests).where(and(
    eq(oauthAccessRequests.userId, f.person.id), eq(oauthAccessRequests.clientId, f.client.id),
    eq(oauthAccessRequests.status, "approved"), isNull(oauthAccessRequests.consumedAt),
  ));
  assert.deepEqual(open, []);
});
