import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { oauthClientInstalls, oauthClients, serverAgentMembers, serverMembers, servers, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";
import { addMember, createServer, removeMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { createAgent } from "../services/agentService";
import {
  checkAppServerAccess,
  createOAuthClient,
  getIdentityByAccessToken,
  installMarketplaceOAuthClient,
  issueHumanAuthorizationCode,
  requestAgentAccess,
  uninstallMarketplaceOAuthClient,
  type AppServerAccessToken,
} from "../services/oauthService";

// RFC 079 task 1a: the Server-scoped identity endpoints (serverinfo, agents,
// membership, servers, agent-events) all go through checkAppServerAccess. A
// server-mode token reads only its own Server; any other server_id, known or
// not, gets one byte-identical 403, even when the person is a member there and
// the app is installed there.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const RETURN_URL = "https://access.example.test/login/raft/callback";
const SCOPES = ["openid", "profile", "agent:read", "agent:event:write"];

type Base = { baseUrl: string };
type Answer = { status: number; body: string; contentType: string | null; cacheControl: string | null };

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
  return user;
}

/**
 * A published third-party app installed on A and B through the Marketplace
 * path. The person is a member of A, B and C; C has no installation, so it is
 * outside the app's audience.
 */
async function seedAudience() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("access-owner");
  const person = await seedUser("access-person");
  const publisher = await createServer("Access Publisher", `access-pub-${suffix}`, owner.id);
  const a = await createServer("Access A", `access-a-${suffix}`, owner.id);
  const b = await createServer("Access B", `access-b-${suffix}`, owner.id);
  const c = await createServer("Access C", `access-c-${suffix}`, owner.id);
  for (const server of [a, b, c]) await addMember(server.id, person.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `access-${suffix}`,
    name: "Access App",
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
  return { owner, person, publisher, a, b, c, client, clientSecret };
}

type Audience = Awaited<ReturnType<typeof seedAudience>>;

/**
 * The same people and Servers with a server-local app of A in place of the
 * third-party one. A's owner registers it, so A's agents are granted it
 * without a person.
 */
async function withServerLocalAppOfA(f: Audience): Promise<Audience> {
  const { client, clientSecret } = await createOAuthClient({
    serverId: f.a.id,
    createdByUserId: f.owner.id,
    clientId: `access-local-${randomUUID().slice(0, 8)}`,
    name: "Access Local",
    returnUrl: RETURN_URL,
    allowedScopes: SCOPES,
  });
  assert.equal(client.appType, "server_local");
  return { ...f, client, clientSecret };
}

async function setAppEnabled(clientId: string, enabled: boolean) {
  await getDb().update(oauthClients).set({ enabled }).where(eq(oauthClients.id, clientId));
}

async function exchange(app: Base, f: Pick<Audience, "client" | "clientSecret">, body: Record<string, unknown>) {
  const res = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: f.client.clientId, clientSecret: f.clientSecret, ...body }),
  });
  assert.equal(res.status, 200, `token exchange failed (${res.status}): ${await res.clone().text()}`);
  return (await res.json() as { access_token: string }).access_token;
}

async function humanToken(app: Base, f: Audience, userId: string, serverId: string, scopes = SCOPES.slice(0, 3)) {
  const { code } = await issueHumanAuthorizationCode({ clientKey: f.client.clientId, userId, serverId, returnUrl: RETURN_URL, scopes, approverSessionFamilyId: (await signInForTest(userId)).familyId });
  return exchange(app, f, { grantType: "authorization_code", code });
}

async function agentToken(app: Base, f: Audience, agentId: string, serverSlug: string, scopes: string[], resource?: string) {
  const requested = await requestAgentAccess({ clientId: f.client.id, serverSlug, agentId, scopes });
  assert.equal(requested.status, "approved", "fixture: the installation's approved scopes auto-grant the agent");
  return exchange(app, f, {
    grantType: "urn:slock:grant-type:agent_request",
    requestId: requested.request.id,
    ...(resource ? { resource } : {}),
  });
}

async function read(app: Base, path: string, token: string): Promise<Answer> {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
  };
}

async function postEvent(app: Base, token: string, kind: string): Promise<Answer> {
  const res = await fetch(`${app.baseUrl}/api/oauth/agent-events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind, summary: "access check", payload: {} }),
  });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
  };
}

function withServerId(path: string, serverId: string) {
  return `${path}?${new URLSearchParams({ server_id: serverId })}`;
}

/** The pinned refusal: one code, no Server in it, not cacheable. */
function assertTheRefusal(answer: Answer, label: string) {
  assert.equal(answer.status, 403, `${label}: ${answer.body}`);
  assert.deepEqual(JSON.parse(answer.body), {
    error: "server_access_denied",
    error_description: "This token cannot be used for this request on that Server.",
  }, label);
  assert.equal(answer.cacheControl, "no-store", label);
}

async function liveIdentity(token: string): Promise<AppServerAccessToken> {
  const identity = await getIdentityByAccessToken(token);
  assert.ok(identity, "fixture: the token has a live identity");
  return identity;
}

const allowGuests = true;

test("a token for Server A cannot read Server B, even when the person is a member of B and the app is installed there; every refusal is byte-identical", async ({ app }) => {
  const f = await seedAudience();
  const tokenA = await humanToken(app, f, f.person.id, f.a.id);
  const tokenB = await humanToken(app, f, f.person.id, f.b.id);

  // Witnesses: the person can read B, with B's own token; A's token reads A,
  // and naming A explicitly answers exactly as naming nothing.
  for (const path of ["/api/oauth/serverinfo", "/api/oauth/agents"]) {
    const implicit = await read(app, path, tokenA);
    assert.equal(implicit.status, 200, `${path}: ${implicit.body}`);
    assert.deepEqual(await read(app, withServerId(path, f.a.id), tokenA), implicit, `${path} ?server_id=A`);
    assert.equal((await read(app, withServerId(path, f.b.id), tokenB)).status, 200, `${path} with B's token`);
  }
  assert.equal(JSON.parse((await read(app, "/api/oauth/serverinfo", tokenA)).body).id, f.a.id);
  assert.equal((await read(app, withServerId("/api/oauth/membership", f.a.id), tokenA)).status, 200);
  assert.equal((await read(app, withServerId("/api/oauth/membership", f.b.id), tokenB)).status, 200);

  const unknown = randomUUID();
  const named: Record<string, string> = {
    "Server B (member, installed)": f.b.id,
    "Server C (member, outside the audience)": f.c.id,
    "the publisher's Server": f.publisher.id,
    "an unknown id": unknown,
    "Server A by slug": f.a.slug,
    "Server B by slug": f.b.slug,
    "Server A in upper case": f.a.id.toUpperCase(),
    "an empty value": "",
    "a malformed value": "not-a-server",
    "a quoted value": "' or 1=1 --",
  };
  const refusals: Array<[string, Answer]> = [];
  for (const path of ["/api/oauth/serverinfo", "/api/oauth/agents", "/api/oauth/membership"]) {
    for (const [label, value] of Object.entries(named)) {
      refusals.push([`${path} ${label}`, await read(app, withServerId(path, value), tokenA)]);
    }
    refusals.push([`${path} a repeated server_id`, await read(app, `${path}?server_id=${f.a.id}&server_id=${f.a.id}`, tokenA)]);
  }
  // A missing scope is the same answer (check 3), not insufficient_scope.
  const identityOnly = await humanToken(app, f, f.person.id, f.a.id, ["openid", "profile"]);
  refusals.push(["/api/oauth/agents without agent:read", await read(app, "/api/oauth/agents", identityOnly)]);

  const [, reference] = refusals[0];
  assertTheRefusal(reference, refusals[0][0]);
  for (const [label, answer] of refusals) assert.deepEqual(answer, reference, label);
  for (const secret of [f.a.id, f.a.slug, f.b.id, f.b.slug, f.b.name, f.c.id, f.c.slug, f.c.name, unknown]) {
    assert.ok(!reference.body.includes(secret), "the refusal names no Server");
  }

  // The list for A's token is A alone, though the person is in B and C too.
  const listed = JSON.parse((await read(app, "/api/oauth/servers", tokenA)).body) as { servers: Array<{ id: string }> };
  assert.deepEqual(listed.servers.map((server) => server.id), [f.a.id]);
});

test("without the server-mode binding, the checks alone still refuse a Server outside the audience, or a Server the principal may not act on", async ({ db }) => {
  void db;
  const f = await seedAudience();
  const outsider = await seedUser("access-outsider");
  // The binding check is the first gate; a token identity re-pointed at
  // another Server shows the availability and membership checks on their own,
  // which is what an account-mode token (not bound to a Server) will rely on.
  const identity = { clientRecordId: f.client.id, principalType: "human" as const, humanId: f.person.id, agentId: null, serverId: f.a.id, scopes: ["openid"] };
  assert.equal((await checkAppServerAccess({ token: identity, serverId: f.a.id, requiredScopes: [], allowGuests })).ok, true);
  assert.equal((await checkAppServerAccess({ token: { ...identity, serverId: f.b.id }, serverId: f.b.id, requiredScopes: [], allowGuests })).ok, true, "B is in the audience and the person is a member");
  assert.equal((await checkAppServerAccess({ token: { ...identity, serverId: f.c.id }, serverId: f.c.id, requiredScopes: [], allowGuests })).ok, false, "C: member, but outside the audience");
  const unknown = randomUUID();
  assert.equal((await checkAppServerAccess({ token: { ...identity, serverId: unknown }, serverId: unknown, requiredScopes: [], allowGuests })).ok, false, "unknown Server");
  assert.equal((await checkAppServerAccess({ token: { ...identity, humanId: outsider.id }, serverId: f.a.id, requiredScopes: [], allowGuests })).ok, false, "not a member of A");
  assert.equal((await checkAppServerAccess({ token: identity, serverId: f.a.id, requiredScopes: ["agent:read"], allowGuests })).ok, false, "scope not in the token");

  // A server-local app is available on its source Server only.
  const local = await createOAuthClient({
    serverId: f.a.id,
    createdByUserId: f.owner.id,
    clientId: `access-local-${randomUUID().slice(0, 8)}`,
    name: "Access Local",
    returnUrl: RETURN_URL,
  });
  const localIdentity = { ...identity, clientRecordId: local.client.id };
  assert.equal((await checkAppServerAccess({ token: localIdentity, serverId: f.a.id, requiredScopes: [], allowGuests })).ok, true);
  assert.equal((await checkAppServerAccess({ token: { ...localIdentity, serverId: f.b.id }, serverId: f.b.id, requiredScopes: [], allowGuests })).ok, false, "a server-local app outside its source Server");
});

test("/servers and /membership answer exactly id, slug, name and role, live, with a 60 s private cache bound; /membership requires server_id", async ({ app }) => {
  const f = await seedAudience();
  const token = await humanToken(app, f, f.person.id, f.a.id);

  const servers1 = await read(app, "/api/oauth/servers", token);
  assert.equal(servers1.status, 200);
  assert.equal(servers1.cacheControl, "private, max-age=60");
  assert.deepEqual(JSON.parse(servers1.body), { servers: [{ id: f.a.id, slug: f.a.slug, name: f.a.name, role: "member" }] });

  const membership = await read(app, withServerId("/api/oauth/membership", f.a.id), token);
  assert.equal(membership.status, 200);
  assert.equal(membership.cacheControl, "private, max-age=60");
  assert.deepEqual(JSON.parse(membership.body), { id: f.a.id, slug: f.a.slug, name: f.a.name, role: "member" });

  // Read live: a role change and a rename show on the next request.
  await getDb().update(serverMembers).set({ role: "admin" })
    .where(and(eq(serverMembers.serverId, f.a.id), eq(serverMembers.userId, f.person.id)));
  await getDb().update(servers).set({ name: "Access A renamed" }).where(eq(servers.id, f.a.id));
  assert.deepEqual(JSON.parse((await read(app, withServerId("/api/oauth/membership", f.a.id), token)).body), { id: f.a.id, slug: f.a.slug, name: "Access A renamed", role: "admin" });
  assert.deepEqual(JSON.parse((await read(app, "/api/oauth/servers", token)).body).servers[0].role, "admin");

  const missing = await read(app, "/api/oauth/membership", token);
  assert.equal(missing.status, 400);
  assert.deepEqual(JSON.parse(missing.body), { error: "invalid_request", error_description: "server_id is required" });

  for (const path of ["/api/oauth/servers", withServerId("/api/oauth/membership", f.a.id)]) {
    assert.equal((await fetch(`${app.baseUrl}${path}`)).status, 401, path);
    assert.equal((await read(app, path, "slock_at_not-a-token")).status, 401, path);
  }
  // Not on the Server-scoped mount: it serves only what its discovery advertises.
  for (const path of ["servers", `membership?server_id=${f.a.id}`]) {
    assert.equal((await read(app, `/oidc/${f.a.slug}/api/oauth/${path}`, token)).status, 404, path);
  }
});

test("server mode keeps today's guest rule: a guest's login reads its Server as before; allowGuests: false refuses it", async ({ app }) => {
  const f = await seedAudience();
  const guest = await seedUser("access-guest");
  await seedBoundGuest({ serverId: f.a.id, userId: guest.id });
  const token = await humanToken(app, f, guest.id, f.a.id);

  const userinfo = await read(app, "/api/oauth/userinfo", token);
  assert.equal(userinfo.status, 200);
  assert.equal(JSON.parse(userinfo.body).server_role, "guest");
  assert.equal((await read(app, "/api/oauth/serverinfo", token)).status, 200);
  assert.equal((await read(app, "/api/oauth/agents", token)).status, 200);
  assert.deepEqual(JSON.parse((await read(app, "/api/oauth/servers", token)).body).servers, [{ id: f.a.id, slug: f.a.slug, name: f.a.name, role: "guest" }]);
  assert.equal(JSON.parse((await read(app, withServerId("/api/oauth/membership", f.a.id), token)).body).role, "guest");

  const identity = await liveIdentity(token);
  const allowed = await checkAppServerAccess({ token: identity, serverId: f.a.id, requiredScopes: [], allowGuests: true });
  assert.ok(allowed.ok && allowed.server.role === "guest");
  assert.equal((await checkAppServerAccess({ token: identity, serverId: f.a.id, requiredScopes: [], allowGuests: false })).ok, false);
});

test("an agent token names only its own Server, even where it also has a membership row and the app is installed", async ({ app }) => {
  const f = await seedAudience();
  const agent = await createAgent(f.a.id, "AccessAgent", { runtime: "external", model: "external" });
  // Not a state Raft creates today; it shows the own-Server rule holds anyway.
  await getDb().insert(serverAgentMembers).values({ serverId: f.b.id, agentId: agent.id });
  const token = await agentToken(app, f, agent.id, f.a.slug, ["openid", "profile", "agent:read"]);

  assert.equal((await read(app, "/api/oauth/serverinfo", token)).status, 200);
  assert.deepEqual(JSON.parse((await read(app, "/api/oauth/servers", token)).body).servers, [{ id: f.a.id, slug: f.a.slug, name: f.a.name, role: "member" }]);
  assert.equal(JSON.parse((await read(app, withServerId("/api/oauth/membership", f.a.id), token)).body).role, "member");
  for (const path of ["/api/oauth/serverinfo", "/api/oauth/agents", "/api/oauth/membership"]) {
    for (const serverId of [f.b.id, f.c.id, randomUUID()]) {
      assertTheRefusal(await read(app, withServerId(path, serverId), token), `${path} ${serverId}`);
    }
  }
  // Without the binding, the query itself refuses B: B is not the agent's Server.
  const identity = await liveIdentity(token);
  assert.equal((await checkAppServerAccess({ token: identity, serverId: f.a.id, requiredScopes: [], allowGuests })).ok, true);
  assert.equal((await checkAppServerAccess({ token: { ...identity, serverId: f.b.id }, serverId: f.b.id, requiredScopes: [], allowGuests })).ok, false);
});

test("agent-events keeps today's answers (RFC 079 §5.4: unchanged in server mode); the shared checks refuse only what had no answer before", async ({ app }) => {
  const f = await seedAudience();
  const agent = await createAgent(f.a.id, "AccessEventAgent", { runtime: "external", model: "external" });
  const ownResource = `urn:raft:server:${f.a.id}:agent-inbound`;
  const eventToken = await agentToken(app, f, agent.id, f.a.slug, ["agent:event:write"], ownResource);

  const delivered = await postEvent(app, eventToken, "event");
  assert.ok(delivered.status === 202 || delivered.status === 200, `witness: ${delivered.body}`);

  // The kind's scope: today's insufficient_scope, naming the scope.
  const missingScope = await postEvent(app, eventToken, "notification");
  assert.equal(missingScope.status, 403);
  assert.deepEqual(JSON.parse(missingScope.body), { error: "insufficient_scope", required_scope: "agent:notification:write" });

  // A resource naming another Server (possible only with scopes that need no
  // resource), or none: today's answer, which names only the token's own
  // resource. The resource is checked before the kind, as today.
  const unbound = await agentToken(app, f, agent.id, f.a.slug, ["openid"]);
  const tokens = [unbound];
  for (const serverId of [f.b.id, randomUUID()]) {
    tokens.push(await agentToken(app, f, agent.id, f.a.slug, ["openid"], `urn:raft:server:${serverId}:agent-inbound`));
  }
  for (const token of tokens) {
    for (const kind of ["event", "not-a-kind"]) {
      const answer = await postEvent(app, token, kind);
      assert.equal(answer.status, 403, kind);
      assert.deepEqual(JSON.parse(answer.body), { error: "resource-bound token required", resource: ownResource }, kind);
    }
  }
  const invalidKind = await postEvent(app, eventToken, "not-a-kind");
  assert.equal(invalidKind.status, 400);
  assert.deepEqual(JSON.parse(invalidKind.body), { error: "kind must be event or notification" });

  // New: a disabled app had no answer here before (the token lookup never
  // read `enabled`). It gets the one Server-access refusal, the same bytes as
  // serverinfo's; enabling it again restores delivery.
  const humanTokenA = await humanToken(app, f, f.person.id, f.a.id);
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
  const disabled = await postEvent(app, eventToken, "event");
  assertTheRefusal(disabled, "agent-events, disabled app");
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, f.client.id));
  assert.deepEqual(await read(app, withServerId("/api/oauth/serverinfo", f.b.id), humanTokenA), disabled);
  const restored = await postEvent(app, eventToken, "event");
  assert.ok(restored.status === 202 || restored.status === 200, `restored: ${restored.body}`);
});

test("suspension, uninstall, leaving, a disabled app and a retired account: today's live re-checks hold, and the shared checks refuse the same states", async ({ app }) => {
  const f = await seedAudience();
  const token = await humanToken(app, f, f.person.id, f.a.id);
  const identity = await liveIdentity(token);
  const check = async (token: AppServerAccessToken = identity) => (await checkAppServerAccess({ token, serverId: token.serverId, requiredScopes: [], allowGuests })).ok;
  const paths = ["/api/oauth/serverinfo", "/api/oauth/agents", "/api/oauth/servers", withServerId("/api/oauth/membership", f.a.id)];
  const statuses = async (bearer: string) => Promise.all(paths.map(async (path) => (await read(app, path, bearer)).status));
  assert.deepEqual(await statuses(token), [200, 200, 200, 200]);
  assert.equal(await check(), true);

  const [install] = await getDb().select().from(oauthClientInstalls)
    .where(and(eq(oauthClientInstalls.clientId, f.client.id), eq(oauthClientInstalls.serverId, f.a.id)));

  // Suspended: the token loses its live identity (401, as before), and the
  // checks refuse the Server too. Restoring brings both back.
  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual(await statuses(token), [401, 401, 401, 401]);
  assert.equal(await check(), false);
  await getDb().update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual(await statuses(token), [200, 200, 200, 200]);

  // A disabled third-party app is unavailable for login; here too. /servers
  // lists nothing. (userinfo: the test after this one.)
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
  assert.equal(await check(), false);
  assertTheRefusal(await read(app, "/api/oauth/serverinfo", token), "disabled app");
  assert.deepEqual(JSON.parse((await read(app, "/api/oauth/servers", token)).body), { servers: [] });
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, f.client.id));

  // A retired account may not act on any Server.
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.person.id));
  assert.equal(await check(), false);
  assertTheRefusal(await read(app, withServerId("/api/oauth/membership", f.a.id), token), "retired account");
  await getDb().update(users).set({ retiredAt: null }).where(eq(users.id, f.person.id));
  assert.deepEqual(await statuses(token), [200, 200, 200, 200]);

  // Uninstalled from B: B's token is revoked (401, as before), and B is out
  // of the audience for the checks.
  const tokenB = await humanToken(app, f, f.person.id, f.b.id);
  const identityB = await liveIdentity(tokenB);
  assert.ok(await uninstallMarketplaceOAuthClient({ serverId: f.b.id, clientId: f.client.id, revokedByUserId: f.owner.id }));
  assert.equal((await read(app, "/api/oauth/serverinfo", tokenB)).status, 401);
  assert.equal(await check(identityB), false);

  // The person leaves A: their tokens there are revoked (401, as before), and
  // the checks find no membership.
  await removeMember(f.a.id, f.person.id);
  assert.deepEqual(await statuses(token), [401, 401, 401, 401]);
  assert.equal(await check(), false);
});

test("a disabled server-local app is unavailable on every identity endpoint, for a person and an agent: the one refusal, an empty /servers, userinfo 401; enabling it again restores every answer", async ({ app }) => {
  const f = await seedAudience();
  const l = await withServerLocalAppOfA(f);
  const agent = await createAgent(f.a.id, "AccessLocalAgent", { runtime: "external", model: "external" });
  const tokens = {
    person: await humanToken(app, l, f.person.id, f.a.id),
    agent: await agentToken(app, l, agent.id, f.a.slug, ["openid", "profile", "agent:read"]),
  };
  const eventToken = await agentToken(app, l, agent.id, f.a.slug, ["agent:event:write"], `urn:raft:server:${f.a.id}:agent-inbound`);
  const scoped = ["/api/oauth/serverinfo", "/api/oauth/agents", withServerId("/api/oauth/membership", f.a.id)];
  const answers = async () => {
    const out: Record<string, Answer> = {};
    for (const [who, token] of Object.entries(tokens)) {
      for (const path of [...scoped, "/api/oauth/servers", "/api/oauth/userinfo"]) out[`${who} ${path}`] = await read(app, path, token);
    }
    return out;
  };

  // Witnesses: enabled, every endpoint answers.
  const enabled = await answers();
  for (const [label, answer] of Object.entries(enabled)) assert.equal(answer.status, 200, `${label}: ${answer.body}`);
  assert.deepEqual(JSON.parse(enabled["person /api/oauth/servers"].body).servers.map((s: { id: string }) => s.id), [f.a.id]);
  const delivered = await postEvent(app, eventToken, "event");
  assert.ok(delivered.status === 202 || delivered.status === 200, `witness: ${delivered.body}`);

  await setAppEnabled(l.client.id, false);
  // The token lookup still finds a live identity (login does not read
  // `enabled` for a server-local app); the shared check refuses it.
  assert.equal((await checkAppServerAccess({ token: await liveIdentity(tokens.person), serverId: f.a.id, requiredScopes: [], allowGuests })).ok, false);
  const reference = await read(app, withServerId("/api/oauth/serverinfo", f.b.id), tokens.person);
  assertTheRefusal(reference, "fixture: the refusal for another Server");
  const invalid = await read(app, "/api/oauth/userinfo", "slock_at_not-a-token");
  const disabled = await answers();
  for (const who of Object.keys(tokens)) {
    for (const path of scoped) assert.deepEqual(disabled[`${who} ${path}`], reference, `${who} ${path}`);
    const listed = disabled[`${who} /api/oauth/servers`];
    assert.equal(listed.status, 200);
    assert.deepEqual(JSON.parse(listed.body), { servers: [] }, `${who} /servers`);
    assert.deepEqual(disabled[`${who} /api/oauth/userinfo`], invalid, `${who} userinfo`);
  }
  // agent-events: today's checks pass, then the same refusal.
  assert.deepEqual(await postEvent(app, eventToken, "event"), reference, "agent-events");

  await setAppEnabled(l.client.id, true);
  assert.deepEqual(await answers(), enabled);
  const restored = await postEvent(app, eventToken, "event");
  assert.ok(restored.status === 202 || restored.status === 200, `restored: ${restored.body}`);
});

test("userinfo answers a disabled app (third-party and server-local) and a retired account exactly as it answers a lost membership; restoring brings 200 back", async ({ app }) => {
  const f = await seedAudience();
  const l = await withServerLocalAppOfA(f);
  const userinfo = (token: string, prefix = "") => read(app, `${prefix}/api/oauth/userinfo`, token);

  // Today's answer when the live membership re-check fails: the row is gone,
  // the token is not revoked. Every token without a live identity gets it.
  const leaver = await seedUser("access-leaver");
  await addMember(f.a.id, leaver.id, "member");
  const leaverToken = await humanToken(app, f, leaver.id, f.a.id);
  assert.equal((await userinfo(leaverToken)).status, 200);
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.a.id), eq(serverMembers.userId, leaver.id)));
  const lostMembership = await userinfo(leaverToken);
  assert.equal(lostMembership.status, 401);
  assert.deepEqual(JSON.parse(lostMembership.body), { error: "Invalid or expired access token" });
  assert.deepEqual(await userinfo("slock_at_not-a-token"), lostMembership);
  // Also on the Server-scoped mounts, A's and another Server's (each mount
  // sends its own headers, so the reference is per mount).
  const mounts = ["", `/oidc/${f.a.slug}`, `/oidc/${f.b.slug}`];
  const lostOn = new Map<string, Answer>();
  for (const prefix of mounts) {
    const answer = await userinfo(leaverToken, prefix);
    assert.equal(answer.body, lostMembership.body, `lost membership ${prefix}`);
    lostOn.set(prefix, answer);
  }

  const agent = await createAgent(f.a.id, "AccessUserinfoAgent", { runtime: "external", model: "external" });
  const byApp = {
    thirdParty: {
      clientId: f.client.id,
      person: await humanToken(app, f, f.person.id, f.a.id),
      agent: await agentToken(app, f, agent.id, f.a.slug, ["openid", "profile"]),
    },
    serverLocal: {
      clientId: l.client.id,
      person: await humanToken(app, l, f.person.id, f.a.id),
      agent: await agentToken(app, l, agent.id, f.a.slug, ["openid", "profile"]),
    },
  };
  const all = Object.entries(byApp).flatMap(([kind, t]) => [[`${kind} person`, t.person], [`${kind} agent`, t.agent]] as const);
  const before = new Map<string, Answer>();
  for (const [label, token] of all) {
    const answer = await userinfo(token);
    assert.equal(answer.status, 200, `${label}: ${answer.body}`);
    before.set(label, answer);
  }
  const assertRestored = async () => {
    for (const [label, token] of all) assert.deepEqual(await userinfo(token), before.get(label), `restored ${label}`);
  };

  // A disabled app: each of its tokens, person or agent, on every mount.
  for (const [kind, t] of Object.entries(byApp)) {
    await setAppEnabled(t.clientId, false);
    for (const token of [t.person, t.agent]) {
      for (const prefix of mounts) assert.deepEqual(await userinfo(token, prefix), lostOn.get(prefix), `${kind} disabled ${prefix}`);
    }
    // The other app is untouched: the refusal is this app's state.
    for (const [label, token] of all) {
      if (!label.startsWith(kind)) assert.equal((await userinfo(token)).status, 200, `${label} while ${kind} is disabled`);
    }
    await setAppEnabled(t.clientId, true);
    await assertRestored();
  }

  // A retired account: the person's tokens for both apps; the agent's are not the person's.
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.person.id));
  for (const [label, token] of all) {
    const answer = await userinfo(token);
    if (label.endsWith("person")) assert.deepEqual(answer, lostMembership, `retired ${label}`);
    else assert.deepEqual(answer, before.get(label), `${label} while the person is retired`);
  }
  await getDb().update(users).set({ retiredAt: null }).where(eq(users.id, f.person.id));
  await assertRestored();
});
