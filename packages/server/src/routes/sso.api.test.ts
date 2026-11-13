import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { featureFlags, serverMembers, serverMembershipDepartures, serverSsoConnections, sessionFamilies, ssoIdentities, users } from "../db/schema";
import { SERVER_SSO_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addMember, createServer, removeMember } from "../services/serverService";
import { SSO_SECRET_KEY_ENV } from "../services/sso/ssoConnectionSecret";
import { setSsoTxtResolverForTests } from "../services/sso/ssoDomains";
import { setSsoIdpFetchForTests } from "../services/sso/ssoIdpFetch";
import { seedBoundGuest } from "../test/guestFixture";

// SSO sign-in over OIDC end to end (rfcs/083-server-sso.md §5), against a
// fake identity provider: the owner's test sign-in activates the connection;
// a person signs in from discovery to tokens; a replayed callback, a foreign
// browser and an unverified email are refused.

const test = createApiTest();
const ISSUER = "https://idp.acme.test";
const CLIENT_ID = "raft-client";
const LEGAL = { acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion, privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion };

type Person = { sub: string; email: string; email_verified: boolean; name: string };

/** A minimal OIDC provider: discovery, JWKS and a token endpoint that answers the codes it handed out. */
function fakeIdp() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
  const codes = new Map<string, { nonce: string; person: Person; issuer: string }>();
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = (issuer: string, nonce: string, person: Person) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: "ES256", kid: "k1", typ: "JWT" })}.${b64({ iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce, ...person })}`;
    return `${body}.${sign("sha256", Buffer.from(body), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  return {
    /** What the person does at the IdP: sign in and be sent back with a code. */
    authorize(authorizationUrl: string, person: Person): { code: string; state: string } {
      const url = new URL(authorizationUrl);
      assert.equal(url.pathname, "/authorize");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = randomBytes(8).toString("hex");
      codes.set(code, { nonce: url.searchParams.get("nonce")!, person, issuer: url.origin });
      return { code, state: url.searchParams.get("state")! };
    },
    fetch: async (input: string | URL | Request, init?: { method?: string; body?: unknown }) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const issuer = url.origin;
      if (url.pathname === "/.well-known/openid-configuration") {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/jwks") return json({ keys: [jwk] });
      if (url.pathname === "/token") {
        const form = new URLSearchParams(String(init?.body ?? ""));
        assert.equal(form.get("client_secret"), "idp-secret");
        assert.ok(form.get("code_verifier"));
        const entry = codes.get(form.get("code") ?? "");
        if (!entry) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
        codes.delete(form.get("code")!);
        assert.equal(entry.issuer, issuer, "a code is redeemed at the IdP that issued it");
        return json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken(issuer, entry.nonce, entry.person) });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

const idp = fakeIdp();
const savedKey = process.env[SSO_SECRET_KEY_ENV];
beforeAll(() => {
  process.env[SSO_SECRET_KEY_ENV] = randomBytes(32).toString("base64");
  setSsoIdpFetchForTests(idp.fetch);
});
afterAll(() => {
  if (savedKey === undefined) delete process.env[SSO_SECRET_KEY_ENV];
  else process.env[SSO_SECRET_KEY_ENV] = savedKey;
  setSsoIdpFetchForTests(null);
  setSsoTxtResolverForTests(null);
});

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** A started leg: the state cookie and where the IdP was asked to send the person back. */
async function startLeg(baseUrl: string, startUrl: string): Promise<{ cookie: string; authorizeUrl: string }> {
  const url = new URL(startUrl);
  const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, { redirect: "manual" });
  assert.equal(response.status, 302, await response.text());
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.match(cookie, /^raft_sso_[0-9a-f]{16}=/u, "one cookie per leg");
  return { cookie, authorizeUrl: response.headers.get("location")! };
}

/** The completion-binding cookie each web callback left in "this browser", by completion code. */
const completionCookies = new Map<string, string>();

async function callback(baseUrl: string, cookie: string, code: string, state: string): Promise<URL> {
  const response = await fetch(`${baseUrl}/api/auth/sso/oidc/callback?${new URLSearchParams({ code, state })}`, { redirect: "manual", headers: { cookie } });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  const completion = response.headers.getSetCookie().find((line) => line.startsWith("raft_sso_done_"));
  if (completion && location.searchParams.get("code")) completionCookies.set(location.searchParams.get("code")!, completion.split(";")[0]!);
  return location;
}

/** POST /complete from the browser that got the code. */
function completeHere(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/sso/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: completionCookies.get(String(body.code)) ?? "" },
    body: JSON.stringify(body),
  });
}

async function setup(baseUrl: string) {
  await getDb().insert(featureFlags)
    .values({ key: SERVER_SSO_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: true } });
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `owner-${suffix}@slock.test`, name: `owner-${suffix}`, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Acme", `acme-${suffix}`, owner!.id);
  const token = await login(baseUrl, owner!.email);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/api/servers/${server.id}/sso${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  assert.equal((await call("PUT", "/connection", { protocol: "oidc", displayName: "Acme SSO", issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "idp-secret" })).status, 201);
  const domain = (await call("POST", "/domains", { domain: "acme.test" })).body!.domain;
  setSsoTxtResolverForTests(async () => [[domain.record.value]]);
  assert.equal((await call("POST", `/domains/${domain.id}/verify`)).body!.domain.verified, true);
  await getDb().update(serverSsoConnections).set({ autoJoin: true }).where(eq(serverSsoConnections.serverId, server.id));
  return { server, owner: owner!, token, call };
}

test("the owner's test sign-in activates the connection and writes no person", async ({ app }) => {
  const { server, call } = await setup(app.baseUrl);
  const tester = { sub: "admin-at-idp", email: "it@acme.test", email_verified: true, name: "IT" };

  const { url } = (await call("POST", "/test")).body!;
  const leg = await startLeg(app.baseUrl, url);
  assert.equal(new URL(leg.authorizeUrl).searchParams.get("prompt"), "login");
  const answer = idp.authorize(leg.authorizeUrl, tester);
  const back = await callback(app.baseUrl, leg.cookie, answer.code, answer.state);
  assert.equal(back.searchParams.get("sso_test"), "ok");
  assert.equal(back.searchParams.get("server"), server.id);

  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal(connection!.status, "active");
  assert.ok(connection!.lastTestedAt);
  assert.equal((await getDb().select().from(users).where(eq(users.email, tester.email))).length, 0, "no account");
  assert.equal((await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.connectionId, connection!.id))).length, 0, "no identity");
});

test("a co-owner's test sign-in activates the connection; a tester demoted before the answer lands activates nothing", async ({ app }) => {
  const { server } = await setup(app.baseUrl);
  const suffix = randomUUID();
  const [coOwner] = await getDb().insert(users).values({
    email: `co-${suffix}@slock.test`, name: `co-${suffix}`, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: coOwner!.id, role: "owner" });
  const token = await login(app.baseUrl, coOwner!.email);
  const startTest = async () => (await fetch(`${app.baseUrl}/api/servers/${server.id}/sso/test`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  }).then((r) => r.json()) as { url: string }).url;
  const tester = { sub: "admin-at-idp", email: "it@acme.test", email_verified: true, name: "IT" };

  // An owner by membership (not servers.owner_id) holds manageSso, so their test counts.
  await getDb().update(serverSsoConnections).set({ status: "draft" }).where(eq(serverSsoConnections.serverId, server.id));
  const leg = await startLeg(app.baseUrl, await startTest());
  const answer = idp.authorize(leg.authorizeUrl, tester);
  assert.equal((await callback(app.baseUrl, leg.cookie, answer.code, answer.state)).searchParams.get("sso_test"), "ok");
  const [active] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal(active!.status, "active");

  // Demoted while at the IdP: the answer no longer counts.
  await getDb().update(serverSsoConnections).set({ status: "draft" }).where(eq(serverSsoConnections.serverId, server.id));
  const second = await startLeg(app.baseUrl, await startTest());
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, coOwner!.id)));
  const again = idp.authorize(second.authorizeUrl, tester);
  assert.equal((await callback(app.baseUrl, second.cookie, again.code, again.state)).searchParams.get("sso_test"), "failed");
  const [still] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal(still!.status, "draft");
});

test("a person signs in from discovery to tokens, joining the Server; the leg is single use", async ({ app }) => {
  const { server, call } = await setup(app.baseUrl);
  const tested = (await call("POST", "/test")).body!;
  const testLeg = await startLeg(app.baseUrl, tested.url);
  const testAnswer = idp.authorize(testLeg.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await callback(app.baseUrl, testLeg.cookie, testAnswer.code, testAnswer.state);

  const discovered = await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "Ann@ACME.test" }),
  }).then((r) => r.json()) as { connections: Array<{ displayName: string; startUrl: string }> };
  assert.equal(discovered.connections.length, 1);
  assert.equal(discovered.connections[0]!.displayName, "Acme SSO");
  const [connectionRow] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.doesNotMatch(decodeURIComponent(discovered.connections[0]!.startUrl), new RegExp(connectionRow!.id, "u"), "the start link names no connection");
  const again = await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zed@acme.test" }),
  }).then((r) => r.json()) as { connections: Array<{ startUrl: string }> };
  assert.notEqual(again.connections[0]!.startUrl, discovered.connections[0]!.startUrl, "two links to one connection cannot be compared");
  assert.doesNotMatch(JSON.stringify(discovered), new RegExp(server.id, "u"), "discovery names no Server");

  const ann: Person = { sub: `ann-${randomUUID()}`, email: "ann@acme.test", email_verified: true, name: "Ann" };
  const leg = await startLeg(app.baseUrl, discovered.connections[0]!.startUrl);
  const answer = idp.authorize(leg.authorizeUrl, ann);

  // Another browser (no state cookie) cannot finish this leg.
  const foreign = await callback(app.baseUrl, "raft_sso_state=someone-else", answer.code, answer.state);
  assert.equal(foreign.searchParams.get("error"), "sso_state_mismatch");

  const back = await callback(app.baseUrl, leg.cookie, answer.code, answer.state);
  assert.equal(back.searchParams.get("auth_callback"), "sso");
  const code = back.searchParams.get("code")!;
  assert.ok(code);
  const replay = await callback(app.baseUrl, leg.cookie, answer.code, answer.state);
  assert.equal(replay.searchParams.get("error"), "sso_link_expired", "a callback is used once");

  const complete = (body: Record<string, unknown>) => completeHere(app.baseUrl, body);
  const needsTerms = await complete({ code });
  assert.equal(needsTerms.status, 409);
  assert.equal(((await needsTerms.json()) as { code: string }).code, "legal_acceptance_required");
  const done = await complete({ code, ...LEGAL });
  assert.equal(done.status, 200, await done.clone().text());
  const tokens = await done.json() as { accessToken: string; refreshToken: string; createdAccount: boolean; joined: string };
  assert.ok(tokens.accessToken && tokens.refreshToken);
  assert.equal(tokens.createdAccount, true);
  assert.equal(tokens.joined, "joined");
  assert.equal((await complete({ code, ...LEGAL })).status, 400, "the completion code is used once");

  const [person] = await getDb().select().from(users).where(eq(users.email, "ann@acme.test"));
  const [membership] = await getDb().select().from(serverMembers).where(eq(serverMembers.userId, person!.id));
  assert.equal(membership!.serverId, server.id);
  assert.equal(membership!.role, "member");
  const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, person!.id));
  assert.equal(families.length, 1);
  assert.ok(families[0]!.ssoConnectionId && families[0]!.ssoAuthenticatedAt, "the session was signed in by SSO");
  const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  assert.equal(me.status, 200);
});

test("auto-join never brings back someone an owner or admin removed; leaving on one's own, another Server's removal and being added again do not count", async ({ app }) => {
  const { server, owner, token, call } = await setup(app.baseUrl);
  const tested = (await call("POST", "/test")).body!;
  const testLeg = await startLeg(app.baseUrl, tested.url);
  const t = idp.authorize(testLeg.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await callback(app.baseUrl, testLeg.cookie, t.code, t.state);
  const ann: Person = { sub: `ann-${randomUUID()}`, email: `ann-${randomUUID().slice(0, 8)}@acme.test`, email_verified: true, name: "Ann" };
  const signIn = async () => {
    const startUrl = (await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: ann.email }),
    }).then((r) => r.json()) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
    const leg = await startLeg(app.baseUrl, startUrl);
    const answer = idp.authorize(leg.authorizeUrl, ann);
    const code = (await callback(app.baseUrl, leg.cookie, answer.code, answer.state)).searchParams.get("code")!;
    const done = await completeHere(app.baseUrl, { code, ...LEGAL });
    assert.equal(done.status, 200, await done.clone().text());
    return await done.json() as { accessToken: string; joined: string };
  };
  const isMember = async (userId: string) => (await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, userId)))).length === 1;

  assert.equal((await signIn()).joined, "joined");
  const [person] = await getDb().select().from(users).where(eq(users.email, ann.email));
  const annId = person!.id;
  await getDb().update(users).set({ name: `ann-${annId.slice(0, 8)}`, profileSetupCompletedAt: new Date() }).where(eq(users.id, annId));

  // Leaving on her own: SSO brings her back.
  const first = await signIn();
  const left = await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, { method: "POST", headers: { Authorization: `Bearer ${first.accessToken}`, "X-Server-Id": server.id } });
  assert.equal(left.status, 200, await left.text());
  assert.equal((await signIn()).joined, "joined", "leaving on one's own is not a removal");

  // Removed by the owner: SSO signs her in but does not add her back.
  const removed = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${annId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id } });
  assert.ok(removed.status < 300, await removed.text());
  const afterRemoval = await signIn();
  assert.equal(afterRemoval.joined, "rejoin_needs_invite");
  assert.ok(afterRemoval.accessToken, "the sign-in itself stands");
  assert.equal(await isMember(annId), false);

  // Being added again (an invite, a direct add) clears it.
  await addMember(server.id, annId, "member");
  const [departure] = await getDb().select().from(serverMembershipDepartures)
    .where(and(eq(serverMembershipDepartures.serverId, server.id), eq(serverMembershipDepartures.userId, annId)));
  assert.equal(departure, undefined);
  assert.equal((await signIn()).joined, "already_member");

  // Left as a Guest: auto-join does not make her a member (promotion is an admin's call).
  await seedBoundGuest({ serverId: server.id, userId: annId });
  const asGuest = await signIn();
  assert.equal((await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, { method: "POST", headers: { Authorization: `Bearer ${asGuest.accessToken}`, "X-Server-Id": server.id } })).status, 200);
  const [guestDeparture] = await getDb().select().from(serverMembershipDepartures)
    .where(and(eq(serverMembershipDepartures.serverId, server.id), eq(serverMembershipDepartures.userId, annId)));
  assert.deepEqual([guestDeparture?.reason, guestDeparture?.role], ["left", "guest"]);
  assert.equal((await signIn()).joined, "rejoin_needs_invite");
  await addMember(server.id, annId, "member");

  // An owner's removal arriving just after she left (the DELETE had already passed its check): the stricter one wins.
  const beforeRace = await signIn();
  assert.equal((await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, { method: "POST", headers: { Authorization: `Bearer ${beforeRace.accessToken}`, "X-Server-Id": server.id } })).status, 200);
  await removeMember(server.id, annId, { reason: "removed", actorUserId: owner.id });
  assert.equal((await signIn()).joined, "rejoin_needs_invite", "the late removal upgraded her `left`");
  // And the other way round: a leave finding no membership does not rewrite a removal.
  await removeMember(server.id, annId, { reason: "left", actorUserId: annId });
  assert.equal((await signIn()).joined, "rejoin_needs_invite");
  await addMember(server.id, annId, "member");

  // Another Server's removal is that Server's: here it changes nothing.
  const other = await createServer("Other", `other-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembershipDepartures).values({ serverId: other.id, userId: annId, reason: "removed", actorUserId: owner.id });
  const second = await signIn();
  assert.equal((await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, { method: "POST", headers: { Authorization: `Bearer ${second.accessToken}`, "X-Server-Id": server.id } })).status, 200);
  assert.equal((await signIn()).joined, "joined");
});

test("an IdP that does not vouch for the email links no one", async ({ app }) => {
  const { call } = await setup(app.baseUrl);
  const tested = (await call("POST", "/test")).body!;
  const testLeg = await startLeg(app.baseUrl, tested.url);
  const t = idp.authorize(testLeg.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await callback(app.baseUrl, testLeg.cookie, t.code, t.state);

  const startUrl = (await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "bob@acme.test" }),
  }).then((r) => r.json()) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
  const leg = await startLeg(app.baseUrl, startUrl);
  const answer = idp.authorize(leg.authorizeUrl, { sub: "bob", email: "bob@acme.test", email_verified: false, name: "Bob" });
  const code = (await callback(app.baseUrl, leg.cookie, answer.code, answer.state)).searchParams.get("code")!;
  const refused = await completeHere(app.baseUrl, { code, ...LEGAL });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { code: string }).code, "email_unverified");
  assert.equal((await getDb().select().from(users).where(eq(users.email, "bob@acme.test"))).length, 0);
});



test("a web completion code opened in another browser signs no one in there; it is refused the same whether or not it exists (login CSRF)", async ({ app }) => {
  const { call } = await setup(app.baseUrl);
  const tested = (await call("POST", "/test")).body!;
  const testLeg = await startLeg(app.baseUrl, tested.url);
  const t = idp.authorize(testLeg.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await callback(app.baseUrl, testLeg.cookie, t.code, t.state);

  // The attacker signs in as themselves and sends the callback link to someone else.
  const startUrl = (await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "eve@acme.test" }),
  }).then((r) => r.json()) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
  const leg = await startLeg(app.baseUrl, startUrl);
  const answer = idp.authorize(leg.authorizeUrl, { sub: `eve-${randomUUID()}`, email: "eve@acme.test", email_verified: true, name: "Eve" });
  const code = (await callback(app.baseUrl, leg.cookie, answer.code, answer.state)).searchParams.get("code")!;
  const bound = completionCookies.get(code) ?? "";
  assert.match(bound, /^raft_sso_done_[0-9a-f]{16}=/u, "the callback binds the code to this browser");

  const elsewhere = async (body: Record<string, unknown>, cookie: string) => {
    const response = await fetch(`${app.baseUrl}/api/auth/sso/complete`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ ...body, ...LEGAL }),
    });
    return { status: response.status, code: ((await response.json()) as { code: string }).code };
  };
  const refused = { status: 400, code: "browser_mismatch" };
  assert.deepEqual(await elsewhere({ code }, ""), refused, "no cookie");
  assert.deepEqual(await elsewhere({ code }, `${bound.split("=")[0]}=forged`), refused, "a forged cookie");
  assert.deepEqual(await elsewhere({ code: "no-such-code" }, ""), refused, "an unknown code: the same answer");
  // A web code with a made-up PKCE verifier still needs this browser.
  assert.deepEqual(await elsewhere({ code, codeVerifier: "x".repeat(43) }, ""), { status: 400, code: "browser_mismatch" });
  assert.equal((await getDb().select().from(users).where(eq(users.email, "eve@acme.test"))).length, 0);

  // That last attempt reached the code and spent it; a fresh sign-in in the
  // right browser completes, so a refusal elsewhere costs the owner nothing else.
  const second = await startLeg(app.baseUrl, startUrl);
  const again = idp.authorize(second.authorizeUrl, { sub: `eve-${randomUUID()}`, email: "eve@acme.test", email_verified: true, name: "Eve" });
  const secondCode = (await callback(app.baseUrl, second.cookie, again.code, again.state)).searchParams.get("code")!;
  assert.deepEqual(await elsewhere({ code: secondCode }, ""), refused);
  assert.equal((await completeHere(app.baseUrl, { code: secondCode, ...LEGAL })).status, 200, "a refusal from another browser does not spend the code");
});

test("a completion code completes once even when two requests race; an admin cannot start a test", async ({ app }) => {
  const { server, call } = await setup(app.baseUrl);
  const tested = (await call("POST", "/test")).body!;
  const testLeg = await startLeg(app.baseUrl, tested.url);
  const t = idp.authorize(testLeg.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await callback(app.baseUrl, testLeg.cookie, t.code, t.state);

  const startUrl = ssoStartLink(await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "cy@acme.test" }),
  }).then((r) => r.json()));
  const leg = await startLeg(app.baseUrl, startUrl);
  const answer = idp.authorize(leg.authorizeUrl, { sub: `cy-${randomUUID()}`, email: "cy@acme.test", email_verified: true, name: "Cy" });
  const code = (await callback(app.baseUrl, leg.cookie, answer.code, answer.state)).searchParams.get("code")!;
  const complete = () => completeHere(app.baseUrl, { code, ...LEGAL });
  const statuses = (await Promise.all([complete(), complete(), complete()])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400, 400], "exactly one request gets tokens");
  const [person] = await getDb().select().from(users).where(eq(users.email, "cy@acme.test"));
  assert.equal((await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, person!.id))).length, 1);

  const suffix = randomUUID();
  const [admin] = await getDb().insert(users).values({
    email: `admin-${suffix}@slock.test`, name: `admin-${suffix}`, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin!.id, role: "admin" });
  const adminToken = await login(app.baseUrl, admin!.email);
  const refused = await fetch(`${app.baseUrl}/api/servers/${server.id}/sso/test`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "X-Server-Id": server.id },
  });
  assert.equal(refused.status, 403);
});

test("turning server_sso_v1 off stops a leg already at the IdP", async ({ app }) => {
  const { call } = await setup(app.baseUrl);
  const tested = (await call("POST", "/test")).body!;
  const leg = await startLeg(app.baseUrl, tested.url);
  const t = idp.authorize(leg.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await getDb().update(featureFlags).set({ defaultEnabled: false }).where(eq(featureFlags.key, SERVER_SSO_FEATURE_FLAG_KEY));
  const back = await callback(app.baseUrl, leg.cookie, t.code, t.state);
  assert.equal(back.searchParams.get("sso_test"), "failed");
  await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, SERVER_SSO_FEATURE_FLAG_KEY));
});

function ssoStartLink(body: unknown): string {
  return (body as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
}

test("promoting a draft that points at another IdP clears the people linked to the old one", async ({ app }) => {
  const { server, call } = await setup(app.baseUrl);
  const first = (await call("POST", "/test")).body!;
  const t1 = await startLeg(app.baseUrl, first.url);
  const a1 = idp.authorize(t1.authorizeUrl, { sub: "it", email: "it@acme.test", email_verified: true, name: "IT" });
  await callback(app.baseUrl, t1.cookie, a1.code, a1.state);

  // Dee signs in through the first IdP and is linked.
  const leg = await startLeg(app.baseUrl, ssoStartLink(await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "dee@acme.test" }),
  }).then((r) => r.json())));
  const answer = idp.authorize(leg.authorizeUrl, { sub: "dee-old", email: "dee@acme.test", email_verified: true, name: "Dee" });
  const code = (await callback(app.baseUrl, leg.cookie, answer.code, answer.state)).searchParams.get("code")!;
  assert.equal((await completeHere(app.baseUrl, { code, ...LEGAL })).status, 200);
  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal((await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.connectionId, connection!.id))).length, 1);

  // The owner moves the connection to another IdP and tests the draft.
  assert.equal((await call("PUT", "/connection", { protocol: "oidc", displayName: "Acme SSO", issuer: "https://idp2.acme.test", clientId: CLIENT_ID, clientSecret: "idp-secret" })).status, 200);
  const second = (await call("POST", "/test")).body!;
  assert.equal(second.testsDraft, true);
  const t2 = await startLeg(app.baseUrl, second.url);
  assert.equal(new URL(t2.authorizeUrl).origin, "https://idp2.acme.test");
  const a2 = idp.authorize(t2.authorizeUrl, { sub: "it2", email: "it@acme.test", email_verified: true, name: "IT" });
  assert.equal((await callback(app.baseUrl, t2.cookie, a2.code, a2.state)).searchParams.get("sso_test"), "ok");
  const [after] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.id, connection!.id));
  assert.equal(after!.config.protocol === "oidc" && after!.config.issuer, "https://idp2.acme.test");
  assert.equal((await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.connectionId, connection!.id))).length, 0, "old links are gone");
});
