import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";

import { getDb } from "../db/index";
import { externalAppRegistrations, featureFlagRules, featureFlags, oauthAccessTokens, oauthClientInstalls, oauthClients, serverMembers, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";
import { addMember, createServer, removeMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import {
  createOAuthClient,
  installMarketplaceOAuthClient,
  issueHumanAuthorizationCode,
  uninstallMarketplaceOAuthClient,
} from "../services/oauthService";

// RFC 079 phase 3a, PR 2: the account-mode read path. An account-mode token
// (server_id NULL) names its Server on every request, and each request is
// checked live against the App's audience (design §1 rows 8-14, §3.2, threats
// T1-T7, T10, T16, D14). Nothing mints one yet (PR 3), so each test seeds the
// token row directly, after switching the App with SQL as the reviewed switch
// would (db/oauthClientLoginMode.test.ts), and turns the kill switch on.
//
// Every refusal is compared whole (status, the headers in RECORDED_HEADERS,
// body text) with the answer the same endpoint gives a server-mode token
// today: the server-mode tokens are minted before the switch (the database
// mints none for an account-mode App after it; migration 0560), and a token
// minted before a switch keeps server mode's answers (D16).
const test = createApiTest({ skipAuthRateLimit: true });

const RETURN_URL = "https://account.example.test/login/raft/callback";
const SCOPES = ["openid", "profile", "email", "agent:read"];
const HOUR_MS = 60 * 60 * 1000;
const SERVER_ACCESS_DENIED_BODY = JSON.stringify({
  error: "server_access_denied",
  error_description: "This token cannot be used for this request on that Server.",
});
const RECORDED_HEADERS = ["cache-control", "content-type", "location", "pragma", "www-authenticate"] as const;

type Base = { baseUrl: string };
type Answer = { status: number; headers: Record<string, string>; body: string };

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
  return user!;
}

async function answerOf(res: Response): Promise<Answer> {
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: res.status, headers, body: await res.text() };
}

function read(app: Base, path: string, token: string): Promise<Answer> {
  return fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(answerOf);
}

function postEvent(app: Base, token: string): Promise<Answer> {
  return fetch(`${app.baseUrl}/api/oauth/agent-events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "event", summary: "account check", payload: {} }),
  }).then(answerOf);
}

function withServerId(path: string, serverId: string) {
  return `${path}?${new URLSearchParams({ server_id: serverId })}`;
}

/** A token string the server has never issued: today's 401 for an unknown token, per endpoint and mount. */
const UNKNOWN_TOKEN = "slock_at_not-a-token";

async function serverModeToken(app: Base, client: { clientId: string }, clientSecret: string, userId: string, serverId: string) {
  const { code } = await issueHumanAuthorizationCode({ clientKey: client.clientId, userId, serverId, returnUrl: RETURN_URL, scopes: SCOPES, approverSessionFamilyId: (await signInForTest(userId)).familyId });
  const res = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: client.clientId, clientSecret, grantType: "authorization_code", code }),
  });
  assert.equal(res.status, 200, `fixture: server-mode exchange (${res.status}): ${await res.clone().text()}`);
  return (await res.json() as { access_token: string }).access_token;
}

/** The reviewed switch's write, with SQL (db/oauthClientLoginMode.test.ts). */
async function switchToAccountMode(clientId: string) {
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${clientId}`);
}

/**
 * An account-mode token row as PR 3's exchange will write it: server-less, a
 * person's, at most an hour. Scopes default to SCOPES sorted, as a
 * server-mode exchange stores them.
 */
async function insertAccountToken(input: { userId: string; clientId: string; scopes?: string[]; createdAt?: Date }) {
  const raw = `slock_at_${randomBytes(32).toString("hex")}`;
  const createdAt = input.createdAt ?? new Date();
  const expiresAt = new Date(createdAt.getTime() + HOUR_MS);
  await getDb().execute(sql`
    INSERT INTO "oauth_access_tokens" ("id", "server_id", "principal_type", "user_id", "agent_id", "client_id", "token_hash", "scopes", "expires_at", "created_at")
    VALUES (${randomUUID()}, NULL, 'human', ${input.userId}, NULL, ${input.clientId}, ${createHash("sha256").update(raw).digest("hex")},
      ${JSON.stringify(input.scopes ?? [...SCOPES].sort())}::json, ${expiresAt.toISOString()}::timestamptz, ${createdAt.toISOString()}::timestamptz)
  `);
  return raw;
}

type FlagState = "on" | "off" | "killed" | "missing";

async function setAccountLoginFlag(state: FlagState) {
  const db = getDb();
  if (state === "missing") {
    await db.delete(featureFlags).where(eq(featureFlags.key, OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY));
    return;
  }
  const values = { enabled: true, killSwitch: state === "killed", defaultEnabled: state !== "off" };
  await db.insert(featureFlags)
    .values({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "account-access-test", ...values })
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

/**
 * A published third-party App installed on A and B; the person is a member
 * of A, B and C (C has no installation, so it is outside the audience) and
 * not of the publisher's Server. Names sort B before A, so /servers' order is
 * the name's. Server-mode tokens for A and B are minted before the App
 * switches; then the account-mode token is seeded and the flag turned on.
 */
async function seedAccountApp(app: Base) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("account-owner");
  const person = await seedUser("account-person");
  const publisher = await createServer("Account Publisher", `account-pub-${suffix}`, owner.id);
  const a = await createServer(`Bravo ${suffix}`, `account-a-${suffix}`, owner.id);
  const b = await createServer(`Alpha ${suffix}`, `account-b-${suffix}`, owner.id);
  const c = await createServer(`Charlie ${suffix}`, `account-c-${suffix}`, owner.id);
  for (const server of [a, b, c]) await addMember(server.id, person.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `account-${suffix}`,
    name: "Account App",
    returnUrl: RETURN_URL,
    allowedScopes: SCOPES,
  });
  await getDb().update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, client.id));
  for (const server of [a, b]) {
    assert.ok(await installMarketplaceOAuthClient({
      serverId: server.id,
      clientId: client.id,
      installedByUserId: owner.id,
      expected: await currentAppPermissions(client.id),
    }));
  }
  const serverTokens = {
    a: await serverModeToken(app, client, clientSecret, person.id, a.id),
    b: await serverModeToken(app, client, clientSecret, person.id, b.id),
  };
  await switchToAccountMode(client.id);
  const accountToken = await insertAccountToken({ userId: person.id, clientId: client.id });
  await setAccountLoginFlag("on");
  return { suffix, owner, person, publisher, a, b, c, client, clientSecret, serverTokens, accountToken };
}

type Seeded = Awaited<ReturnType<typeof seedAccountApp>>;

const NAMED_ENDPOINTS = ["/api/oauth/serverinfo", "/api/oauth/agents", "/api/oauth/membership"] as const;
const ALL_ENDPOINTS = ["/api/oauth/userinfo", "/api/oauth/servers", ...NAMED_ENDPOINTS] as const;

/** Today's server_access_denied for each named endpoint: a server-mode token naming an unknown Server. */
async function deniedReferences(app: Base, f: Seeded) {
  const refs = new Map<string, Answer>();
  for (const path of NAMED_ENDPOINTS) {
    const ref = await read(app, withServerId(path, randomUUID()), f.serverTokens.a);
    assert.equal(ref.status, 403, `${path} reference: ${ref.body}`);
    assert.equal(ref.body, SERVER_ACCESS_DENIED_BODY);
    assert.equal(ref.headers["cache-control"], "no-store");
    refs.set(path, ref);
  }
  return refs;
}

/** Today's 401 for an unknown token, on each endpoint (named endpoints with A named, as the account token calls them). */
async function invalidReferences(app: Base, f: Seeded) {
  const refs = new Map<string, Answer>();
  for (const path of ALL_ENDPOINTS) {
    const call = (NAMED_ENDPOINTS as readonly string[]).includes(path) ? withServerId(path, f.a.id) : path;
    const ref = await read(app, call, UNKNOWN_TOKEN);
    assert.equal(ref.status, 401, `${path} reference: ${ref.body}`);
    assert.deepEqual(JSON.parse(ref.body), { error: "Invalid or expired access token" });
    refs.set(call, ref);
  }
  return refs;
}

/** Every endpoint with the account token answers exactly as for an unknown token. */
async function assertAccountTokenInvalid(app: Base, refs: Map<string, Answer>, token: string, label: string) {
  for (const [call, ref] of refs) assert.deepEqual(await read(app, call, token), ref, `${label}: ${call}`);
}

/** Every endpoint with the account token answers 200 (A named). */
async function assertAccountTokenLive(app: Base, f: Seeded, token = f.accountToken, label = "live") {
  for (const path of ALL_ENDPOINTS) {
    const call = (NAMED_ENDPOINTS as readonly string[]).includes(path) ? withServerId(path, f.a.id) : path;
    const answer = await read(app, call, token);
    assert.equal(answer.status, 200, `${label}: ${call}: ${answer.body}`);
  }
}

function serversBody(...entries: Array<{ id: string; slug: string; name: string; role: string }>) {
  return JSON.stringify({ servers: entries.map(({ id, slug, name, role }) => ({ id, slug, name, role })) });
}

test("T1, T2: an account-mode token reads each audience Server it names with server mode's answers; every other server_id gets server mode's one refusal, byte for byte", async ({ app }) => {
  const f = await seedAccountApp(app);

  // Witnesses: naming A or B answers exactly as that Server's server-mode token does.
  for (const [server, serverToken] of [[f.a, f.serverTokens.a], [f.b, f.serverTokens.b]] as const) {
    for (const path of NAMED_ENDPOINTS) {
      const want = await read(app, withServerId(path, server.id), serverToken);
      assert.equal(want.status, 200, `${path} ${server.name}: ${want.body}`);
      assert.deepEqual(await read(app, withServerId(path, server.id), f.accountToken), want, `${path} ${server.name}`);
    }
  }

  const refs = await deniedReferences(app, f);
  const named: Record<string, string> = {
    "Server C (member, no installation: outside the audience)": f.c.id,
    "the publisher's Server (not a member)": f.publisher.id,
    "an unknown id": randomUUID(),
    "Server A by slug": f.a.slug,
    "Server B by slug": f.b.slug,
    "Server A in upper case": f.a.id.toUpperCase(),
    "Server A in braces": `{${f.a.id}}`,
    "Server A without hyphens": f.a.id.replaceAll("-", ""),
    "an empty value": "",
    "a malformed value": "not-a-server",
    "a quoted value": "' or 1=1 --",
  };
  for (const path of NAMED_ENDPOINTS) {
    const ref = refs.get(path)!;
    for (const [label, value] of Object.entries(named)) {
      assert.deepEqual(await read(app, withServerId(path, value), f.accountToken), ref, `${path} ${label}`);
    }
    assert.deepEqual(await read(app, `${path}?server_id=${f.a.id}&server_id=${f.a.id}`, f.accountToken), ref, `${path} a repeated server_id`);
  }

  // /servers: the audience, A and B, by name (B is "Alpha"); never C.
  const listed = await read(app, "/api/oauth/servers", f.accountToken);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers["cache-control"], "private, max-age=60");
  assert.equal(listed.headers["content-type"], (await read(app, "/api/oauth/servers", f.serverTokens.a)).headers["content-type"]);
  assert.equal(listed.body, serversBody({ ...f.b, role: "member" }, { ...f.a, role: "member" }));
});

test("userinfo for an account-mode token: server mode's human claims in its order, without server_id, server_slug and server_role", async ({ app }) => {
  const f = await seedAccountApp(app);
  const serverMode = await read(app, "/api/oauth/userinfo", f.serverTokens.a);
  assert.equal(serverMode.status, 200, serverMode.body);
  const claims = JSON.parse(serverMode.body) as Record<string, unknown>;
  for (const key of ["server_id", "server_slug", "server_role"]) {
    assert.ok(key in claims, `witness: server mode carries ${key}`);
    delete claims[key];
  }
  const account = await read(app, "/api/oauth/userinfo", f.accountToken);
  assert.deepEqual(account, { ...serverMode, body: JSON.stringify(claims) });
  assert.equal(JSON.parse(account.body).email, f.person.email, "the email scope's claims stay");

  // Without the email scope, no email claims, as in server mode.
  const noEmail = await insertAccountToken({ userId: f.person.id, clientId: f.client.id, scopes: ["openid", "profile"] });
  const body = JSON.parse((await read(app, "/api/oauth/userinfo", noEmail)).body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["scope", "client_id", "client_name", "sub", "type", "preferred_username", "name", "avatar_url", "picture", "description"]);
  assert.equal(body.scope, "openid profile");
});

test("/servers orders the audience by name, then id; serverinfo, agents and membership without server_id get /membership's 400", async ({ app }) => {
  const f = await seedAccountApp(app);
  // Two more audience Servers named exactly as B: the tie is broken by id. An admin role shows as is.
  const twins = [];
  for (const label of ["d", "e"]) {
    const server = await createServer(f.b.name, `account-${label}-${f.suffix}`, f.owner.id);
    await addMember(server.id, f.person.id, "admin");
    assert.ok(await installMarketplaceOAuthClient({
      serverId: server.id,
      clientId: f.client.id,
      installedByUserId: f.owner.id,
      expected: await currentAppPermissions(f.client.id),
    }));
    twins.push({ ...server, role: "admin" });
  }
  const alphas = [{ ...f.b, role: "member" }, ...twins].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.equal((await read(app, "/api/oauth/servers", f.accountToken)).body, serversBody(...alphas, { ...f.a, role: "member" }));

  // The reference: /membership without server_id, for a server-mode token.
  const missing = await read(app, "/api/oauth/membership", f.serverTokens.a);
  assert.equal(missing.status, 400);
  assert.equal(missing.body, JSON.stringify({ error: "invalid_request", error_description: "server_id is required" }));
  assert.deepEqual(await read(app, "/api/oauth/membership", f.accountToken), missing, "membership");
  assert.deepEqual(await read(app, "/api/oauth/serverinfo", f.accountToken), missing, "serverinfo");
  // agents sends no-store on every answer, its 401 and 403 included; the rest is the same.
  assert.deepEqual(await read(app, "/api/oauth/agents", f.accountToken), { ...missing, headers: { ...missing.headers, "cache-control": "no-store" } }, "agents");
});

test("T3: guests never count (D7): a guest Server is refused and left out of /servers, a guest-only person has no live token; promotion is read live", async ({ app }) => {
  const f = await seedAccountApp(app);
  const refs = await deniedReferences(app, f);
  const invalid = await invalidReferences(app, f);

  await setRole(f.b.id, f.person.id, "guest");
  for (const path of NAMED_ENDPOINTS) {
    assert.deepEqual(await read(app, withServerId(path, f.b.id), f.accountToken), refs.get(path), `${path} B as a guest`);
    assert.equal((await read(app, withServerId(path, f.a.id), f.accountToken)).status, 200, `${path} A`);
  }
  assert.equal((await read(app, "/api/oauth/servers", f.accountToken)).body, serversBody({ ...f.a, role: "member" }));

  // Promoted on B: the same token reads B on its next request.
  await setRole(f.b.id, f.person.id, "member");
  for (const path of NAMED_ENDPOINTS) {
    assert.equal((await read(app, withServerId(path, f.b.id), f.accountToken)).status, 200, `${path} B promoted`);
  }

  // A guest on every audience Server holds no live account-mode token (D14 with D7).
  const guest = await seedUser("account-guest");
  await seedBoundGuest({ serverId: f.a.id, userId: guest.id });
  await addMember(f.c.id, guest.id, "member");
  const guestToken = await insertAccountToken({ userId: guest.id, clientId: f.client.id });
  await assertAccountTokenInvalid(app, invalid, guestToken, "guest-only");
  await setRole(f.a.id, guest.id, "member");
  await assertAccountTokenLive(app, f, guestToken, "guest promoted on A");
});

test("T4, T5: a suspended or removed installation takes its Server out of the audience at once; the token stays, the other Server still answers; a refused Server-bound token is never read as an account-mode one", async ({ app }) => {
  const f = await seedAccountApp(app);
  const refs = await deniedReferences(app, f);
  const invalid = await invalidReferences(app, f);

  // Suspended on B: B refused, A answers.
  await setInstall(f.client.id, f.b.id, { status: "suspended" });
  for (const path of NAMED_ENDPOINTS) {
    assert.deepEqual(await read(app, withServerId(path, f.b.id), f.accountToken), refs.get(path), `${path} B suspended`);
  }
  assert.equal((await read(app, "/api/oauth/servers", f.accountToken)).body, serversBody({ ...f.a, role: "member" }));
  await assertAccountTokenLive(app, f, f.accountToken, "B suspended");
  await setInstall(f.client.id, f.b.id, { status: "active" });

  // Suspended on A only: A's server-mode token has no live identity (401, as
  // before; suspension revokes nothing). The App is in account mode and B
  // still holds the person, yet that row stays server mode's (design rule 5).
  await setInstall(f.client.id, f.a.id, { status: "suspended" });
  await assertAccountTokenInvalid(app, invalid, f.serverTokens.a, "A's server-mode token while A is suspended");
  assert.equal((await read(app, withServerId("/api/oauth/serverinfo", f.b.id), f.accountToken)).status, 200);

  // Suspended on B as well: no audience Server is left (D14).
  await setInstall(f.client.id, f.b.id, { status: "suspended" });
  await assertAccountTokenInvalid(app, invalid, f.accountToken, "every installation suspended");
  await setInstall(f.client.id, f.a.id, { status: "active" });
  await setInstall(f.client.id, f.b.id, { status: "active" });
  assert.equal((await read(app, "/api/oauth/servers", f.accountToken)).body, serversBody({ ...f.b, role: "member" }, { ...f.a, role: "member" }));

  // Uninstalled from B: B refused; the account-mode token is not revoked, and A answers.
  assert.ok(await uninstallMarketplaceOAuthClient({ serverId: f.b.id, clientId: f.client.id, revokedByUserId: f.owner.id }));
  for (const path of NAMED_ENDPOINTS) {
    assert.deepEqual(await read(app, withServerId(path, f.b.id), f.accountToken), refs.get(path), `${path} B uninstalled`);
  }
  const [row] = await getDb().select({ revokedAt: oauthAccessTokens.revokedAt }).from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.tokenHash, createHash("sha256").update(f.accountToken).digest("hex")));
  assert.equal(row?.revokedAt, null);
  assert.equal((await read(app, "/api/oauth/servers", f.accountToken)).body, serversBody({ ...f.a, role: "member" }));
  await assertAccountTokenLive(app, f, f.accountToken, "B uninstalled");
});

test("T6, D14: leaving a Server refuses it at once; with no audience Server left every endpoint answers the unknown token's 401; rejoining restores it (Q10)", async ({ app }) => {
  const f = await seedAccountApp(app);
  const refs = await deniedReferences(app, f);
  const invalid = await invalidReferences(app, f);

  await removeMember(f.b.id, f.person.id);
  for (const path of NAMED_ENDPOINTS) {
    assert.deepEqual(await read(app, withServerId(path, f.b.id), f.accountToken), refs.get(path), `${path} B left`);
  }
  assert.equal((await read(app, "/api/oauth/servers", f.accountToken)).body, serversBody({ ...f.a, role: "member" }));

  // Leaving A too: still a member of C, which is outside the audience.
  await removeMember(f.a.id, f.person.id);
  await assertAccountTokenInvalid(app, invalid, f.accountToken, "no audience Server left");

  // Rejoining A within the token's hour brings it back (accepted, RFC 079 §5.5).
  await addMember(f.a.id, f.person.id, "member");
  await assertAccountTokenLive(app, f, f.accountToken, "rejoined A");
});

test("T7: a scope one Server approved never reaches another: agents needs agent:read in the token and in that Server's installation now", async ({ app }) => {
  const f = await seedAccountApp(app);
  const refs = await deniedReferences(app, f);
  const agents = (serverId: string, token = f.accountToken) => read(app, withServerId("/api/oauth/agents", serverId), token);

  await setInstall(f.client.id, f.b.id, { approvedScopes: SCOPES.filter((scope) => scope !== "agent:read") });
  assert.equal((await agents(f.a.id)).status, 200);
  assert.deepEqual(await agents(f.b.id), refs.get("/api/oauth/agents"), "agent:read not approved on B");
  // serverinfo and membership need no scope: B still answers them.
  assert.equal((await read(app, withServerId("/api/oauth/serverinfo", f.b.id), f.accountToken)).status, 200);
  assert.equal((await read(app, withServerId("/api/oauth/membership", f.b.id), f.accountToken)).status, 200);

  // Approved on B again: read live.
  await setInstall(f.client.id, f.b.id, { approvedScopes: SCOPES });
  assert.equal((await agents(f.b.id)).status, 200);

  // A token without agent:read is refused wherever the installation approves it.
  const identityOnly = await insertAccountToken({ userId: f.person.id, clientId: f.client.id, scopes: ["openid", "profile"] });
  assert.deepEqual(await agents(f.a.id, identityOnly), refs.get("/api/oauth/agents"), "agent:read not in the token");
});

test("a server-local App's audience is its own Server: the person's other Servers are refused; disabled, it has no audience", async ({ app }) => {
  const f = await seedAccountApp(app);
  const refs = await deniedReferences(app, f);
  const invalid = await invalidReferences(app, f);
  const { client, clientSecret } = await createOAuthClient({
    serverId: f.a.id,
    createdByUserId: f.owner.id,
    clientId: `account-local-${f.suffix}`,
    name: "Account Local",
    returnUrl: RETURN_URL,
    allowedScopes: SCOPES,
  });
  assert.equal(client.appType, "server_local");
  const serverToken = await serverModeToken(app, client, clientSecret, f.person.id, f.a.id);
  await switchToAccountMode(client.id);
  const token = await insertAccountToken({ userId: f.person.id, clientId: client.id });

  for (const path of NAMED_ENDPOINTS) {
    assert.deepEqual(await read(app, withServerId(path, f.a.id), token), await read(app, withServerId(path, f.a.id), serverToken), `${path} A`);
    for (const server of [f.b, f.c]) {
      assert.deepEqual(await read(app, withServerId(path, server.id), token), refs.get(path), `${path} ${server.name}`);
    }
  }
  assert.equal((await read(app, "/api/oauth/servers", token)).body, serversBody({ ...f.a, role: "member" }));

  // Disabled: server mode's login predicates do not read `enabled` for a
  // server-local App, the identity endpoints do (check 1). No audience: the
  // unknown token's 401 (T16).
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, client.id));
  await assertAccountTokenInvalid(app, invalid, token, "disabled server-local App");
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, client.id));
  await assertAccountTokenLive(app, f, token, "server-local App enabled again");
});

test("T10 (D21): on a Server-scoped mount an account-mode token gets the 401 of a token issued for another Server; servers and membership stay 404 there", async ({ app }) => {
  const f = await seedAccountApp(app);
  const scopedCalls = ["/userinfo", "/serverinfo", `/serverinfo?server_id=${f.a.id}`, "/agents", `/agents?server_id=${f.a.id}`];
  // The reference on each mount: a server-mode token of the other Server.
  const mounts: Array<[string, string]> = [
    [`/oidc/${f.a.id}`, f.serverTokens.b],
    [`/oidc/${f.a.slug}`, f.serverTokens.b],
    [`/oidc/${f.b.id}`, f.serverTokens.a],
    [`/oidc/${f.b.slug}`, f.serverTokens.a],
    [`/oidc/${f.c.id}`, f.serverTokens.a],
  ];
  for (const [mount, otherServerToken] of mounts) {
    for (const call of scopedCalls) {
      const path = `${mount}/api/oauth${call}`;
      const ref = await read(app, path, otherServerToken);
      assert.equal(ref.status, 401, `${path} reference: ${ref.body}`);
      assert.deepEqual(JSON.parse(ref.body), { error: "Access token was issued for a different Server than this issuer" });
      assert.deepEqual(await read(app, path, f.accountToken), ref, path);
    }
    for (const call of ["/servers", `/membership?server_id=${f.a.id}`]) {
      const path = `${mount}/api/oauth${call}`;
      const ref = await read(app, path, otherServerToken);
      assert.equal(ref.status, 404, path);
      assert.deepEqual(await read(app, path, f.accountToken), ref, path);
    }
  }
  // The same token on the root mount: live.
  await assertAccountTokenLive(app, f);
});

test("T16: a disabled App, a platform-managed App and a retired account answer the unknown token's 401 on every endpoint; restoring brings 200 back", async ({ app }) => {
  const f = await seedAccountApp(app);
  const invalid = await invalidReferences(app, f);
  await assertAccountTokenLive(app, f);

  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
  await assertAccountTokenInvalid(app, invalid, f.accountToken, "disabled App");
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, f.client.id));
  await assertAccountTokenLive(app, f, f.accountToken, "App enabled again");

  // An App a platform registration manages is no Connected App (oauthClientManagementPolicy).
  await getDb().insert(externalAppRegistrations).values({
    oauthClientId: f.client.id,
    provider: "slack",
    environment: "test",
    providerAppId: `A${f.suffix}`,
    providerOAuthClientId: `oauth-${f.suffix}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: "account-access-test",
  });
  await assertAccountTokenInvalid(app, invalid, f.accountToken, "platform-managed App");
  await getDb().delete(externalAppRegistrations).where(eq(externalAppRegistrations.oauthClientId, f.client.id));
  await assertAccountTokenLive(app, f, f.accountToken, "registration removed");

  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.person.id));
  await assertAccountTokenInvalid(app, invalid, f.accountToken, "retired account");
  await getDb().update(users).set({ retiredAt: null }).where(eq(users.id, f.person.id));
  await assertAccountTokenLive(app, f, f.accountToken, "account restored");
});

test("revoked and expired account-mode tokens answer the unknown token's 401", async ({ app }) => {
  const f = await seedAccountApp(app);
  const invalid = await invalidReferences(app, f);
  const revoked = await insertAccountToken({ userId: f.person.id, clientId: f.client.id });
  await getDb().update(oauthAccessTokens).set({ revokedAt: new Date() })
    .where(eq(oauthAccessTokens.tokenHash, createHash("sha256").update(revoked).digest("hex")));
  await assertAccountTokenInvalid(app, invalid, revoked, "revoked");
  const expired = await insertAccountToken({ userId: f.person.id, clientId: f.client.id, createdAt: new Date(Date.now() - 2 * HOUR_MS) });
  await assertAccountTokenInvalid(app, invalid, expired, "expired");
});

test("the kill switch (Q12): off, killed, missing or unreadable, every account-mode token answers the unknown token's 401; it is evaluated per person, with no Server", async ({ app }) => {
  const f = await seedAccountApp(app);
  const invalid = await invalidReferences(app, f);
  await assertAccountTokenLive(app, f);

  for (const state of ["off", "killed", "missing"] as const) {
    await setAccountLoginFlag(state);
    await assertAccountTokenInvalid(app, invalid, f.accountToken, `flag ${state}`);
    // Server-mode tokens never read it.
    assert.equal((await read(app, "/api/oauth/userinfo", f.serverTokens.a)).status, 200, `server mode, flag ${state}`);
    await setAccountLoginFlag("on");
    await assertAccountTokenLive(app, f, f.accountToken, `flag on after ${state}`);
  }

  // An evaluation that fails is off: the flag table is unreadable for a moment.
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await getDb().execute(sql`ALTER TABLE "feature_flags" RENAME TO "feature_flags_unreadable"`);
    try {
      assert.deepEqual(await read(app, "/api/oauth/userinfo", f.accountToken), invalid.get("/api/oauth/userinfo"));
    } finally {
      await getDb().execute(sql`ALTER TABLE "feature_flags_unreadable" RENAME TO "feature_flags"`);
    }
    assert.ok(errors.mock.calls.some(([message]) => String(message).startsWith("[oauth-account-login] feature flag evaluation failed")));
  } finally {
    errors.mockRestore();
  }
  await assertAccountTokenLive(app, f, f.accountToken, "flag readable again");

  // Per person: default off with a user rule for this person only.
  await setAccountLoginFlag("off");
  await getDb().insert(featureFlagRules).values({ flagKey: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, stage: "user", decision: "allow", values: [f.person.id] });
  await assertAccountTokenLive(app, f, f.accountToken, "a user rule for the person");
  const other = await seedUser("account-other");
  await addMember(f.a.id, other.id, "member");
  await assertAccountTokenInvalid(app, invalid, await insertAccountToken({ userId: other.id, clientId: f.client.id }), "another person, no rule");
});

test("a server-less token of an App not in account mode (only possible with the database guards off) is invalid", async ({ app }) => {
  const f = await seedAccountApp(app);
  const invalid = await invalidReferences(app, f);
  await assertAccountTokenLive(app, f);
  const db = getDb();
  await db.execute(sql`ALTER TABLE "oauth_clients" DISABLE TRIGGER "oauth_clients_login_mode_forward_only"`);
  try {
    await db.execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'server' WHERE "id" = ${f.client.id}`);
    await assertAccountTokenInvalid(app, invalid, f.accountToken, "App back in server mode");
    await switchToAccountMode(f.client.id);
  } finally {
    await db.execute(sql`ALTER TABLE "oauth_clients" ENABLE TRIGGER "oauth_clients_login_mode_forward_only"`);
  }
  await assertAccountTokenLive(app, f, f.accountToken, "account mode again");
});

test("agent-events: an account-mode token gets the 403 a server-mode person's token gets", async ({ app }) => {
  const f = await seedAccountApp(app);
  const ref = await postEvent(app, f.serverTokens.a);
  assert.equal(ref.status, 403);
  assert.deepEqual(JSON.parse(ref.body), { error: "agent token required" });
  assert.deepEqual(await postEvent(app, f.accountToken), ref);
});
