import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, featureFlags, oauthAccessTokens, servers, oauthClientInstalls, serverMembers, serverSsoConnections, serverSsoDomains, sessionFamilies, ssoIdentities, users } from "../db/schema";
import { PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { attachComputer } from "../services/computerCredentialService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { forgetSsoRequirementCache, socketsFailingSso } from "../services/sso/ssoEnforcement";
import { createOAuthClient, hashSecret } from "../services/oauthService";

// "Require SSO" (rfcs/083-server-sso.md §6.2), at the account: a person a
// requiring Server manages (an email on its verified domain, or an SSO
// identity) needs a session its connection signed in within the max age on
// every surface (any HTTP route, in any Server; every socket; App tokens);
// the owner and outside collaborators are untouched.

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest();
const DAY_MS = 24 * 60 * 60 * 1000;

async function person(email: string) {
  const [user] = await getDb().insert(users).values({
    email, name: `p-${randomUUID()}`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** The person's newest session family, marked as signed in by `connectionId` at `at` (what an SSO sign-in writes). */
async function markSsoSession(userId: string, connectionId: string | null, at: Date | null): Promise<string> {
  const [family] = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
    .where(eq(sessionFamilies.userId, userId)).orderBy(desc(sessionFamilies.createdAt)).limit(1);
  await getDb().update(sessionFamilies).set({ ssoConnectionId: connectionId, ssoAuthenticatedAt: at }).where(eq(sessionFamilies.id, family!.id));
  return family!.id;
}

async function setFlag(key: string, defaultEnabled: boolean) {
  await getDb().insert(featureFlags)
    .values({ key, randomizationUnit: "server", salt: "test", defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled } });
}

async function setup(baseUrl: string) {
  await setFlag(SERVER_SSO_FEATURE_FLAG_KEY, true);
  // The platform reviewed these Servers' requirement.
  await setFlag(SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY, true);
  const tag = randomUUID().slice(0, 8);
  const domain = `acme-${tag}.test`;
  const owner = await person(`owner-${tag}@${domain}`);
  const alice = await person(`alice-${tag}@${domain}`);
  const outsider = await person(`bob-${tag}@elsewhere.test`);
  const server = await createServer("Acme", `acme-${tag}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: alice.id, role: "member" },
    { serverId: server.id, userId: outsider.id, role: "member" },
  ]);
  const [connection] = await getDb().insert(serverSsoConnections).values({
    serverId: server.id, protocol: "oidc", status: "active", displayName: "Acme",
    config: { protocol: "oidc", issuer: "https://acme.okta.com", clientId: "raft" },
  }).returning();
  await getDb().insert(serverSsoDomains).values({ serverId: server.id, domain, verificationToken: randomUUID(), verifiedAt: new Date() });
  const [ownerToken, aliceToken, outsiderToken] = await Promise.all([login(baseUrl, owner.email), login(baseUrl, alice.email), login(baseUrl, outsider.email)]);
  const inServer = (token: string) => fetch(`${baseUrl}/api/notification-levels`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id } });
  const rules = (token: string, body: unknown) => fetch(`${baseUrl}/api/servers/${server.id}/sso/rules`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id }, body: JSON.stringify(body),
  });
  return { server, connection: connection!, owner, alice, outsider, ownerToken, aliceToken, outsiderToken, inServer, rules };
}

function socketAnswer(baseUrl: string, token: string, serverId: string): Promise<{ connected: boolean; error: string | null; socket: any }> {
  const socket = clientIo(baseUrl, { auth: { token, serverId }, transports: ["websocket"], autoConnect: false, reconnection: false });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ connected: false, error: "timeout", socket }), 4_000);
    socket.once("rooms:joined", () => { clearTimeout(timer); resolve({ connected: true, error: null, socket }); });
    socket.once("connect_error", (err: Error) => { clearTimeout(timer); resolve({ connected: false, error: err.message, socket }); });
    socket.connect();
  });
}

async function requireSso(connectionId: string, on = true) {
  await getDb().update(serverSsoConnections).set({ required: on }).where(eq(serverSsoConnections.id, connectionId));
  forgetSsoRequirementCache();
}

test("require SSO: managed people need an SSO session everywhere; the owner and outsiders do not", async ({ app }) => {
  const s = await setup(app.baseUrl);
  assert.equal((await s.inServer(s.aliceToken)).status, 200, "not required yet");
  const turnedOn = await s.rules(s.ownerToken, { required: true, sessionMaxAgeDays: 7 });
  assert.equal(turnedOn.status, 200, await turnedOn.text());

  const blocked = await s.inServer(s.aliceToken);
  assert.equal(blocked.status, 403);
  const body = (await blocked.json()) as { code: string; signInUrl: string };
  assert.equal(body.code, "SSO_REQUIRED");
  assert.match(body.signInUrl, new RegExp(`/api/auth/sso/servers/${s.server.id}/start$`, "u"));
  // The account, not one Server: her own Server and account routes are refused too.
  const own = await createServer("Alice's", `alice-${randomUUID().slice(0, 8)}`, s.alice.id);
  const elsewhere = await fetch(`${app.baseUrl}/api/notification-levels`, { headers: { Authorization: `Bearer ${s.aliceToken}`, "X-Server-Id": own.id } });
  assert.equal(elsewhere.status, 403);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${s.aliceToken}` } })).status, 403);
  assert.equal((await fetch(`${app.baseUrl}/api/servers`, { headers: { Authorization: `Bearer ${s.aliceToken}` } })).status, 403);
  // Signing out still works.
  assert.notEqual((await fetch(`${app.baseUrl}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${s.aliceToken}`, "Content-Type": "application/json" }, body: "{}" })).status, 403);

  assert.equal((await s.inServer(s.outsiderToken)).status, 200, "an email off the verified domains is not managed");
  assert.equal((await s.inServer(s.ownerToken)).status, 200, "the owner is never managed by their own Server");

  const aliceToken = await login(app.baseUrl, s.alice.email);
  const inServerAs = (token: string) => fetch(`${app.baseUrl}/api/notification-levels`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": s.server.id } });
  await markSsoSession(s.alice.id, s.connection.id, new Date());
  assert.equal((await inServerAs(aliceToken)).status, 200, "an SSO session of this connection");
  await markSsoSession(s.alice.id, s.connection.id, new Date(Date.now() - 8 * DAY_MS));
  assert.equal((await inServerAs(aliceToken)).status, 403, "older than the max age");
  await markSsoSession(s.alice.id, randomUUID(), new Date());
  assert.equal((await inServerAs(aliceToken)).status, 403, "another connection's sign-in");

  // Managed through an SSO identity: moving the email off the domain does not escape it.
  await getDb().insert(ssoIdentities).values({ connectionId: s.connection.id, subject: `sub-${randomUUID()}`, userId: s.alice.id, emailAtLink: s.alice.email });
  await getDb().update(users).set({ email: `alice-${randomUUID().slice(0, 6)}@elsewhere.test` }).where(eq(users.id, s.alice.id));
  forgetSsoRequirementCache();
  await markSsoSession(s.alice.id, null, null);
  assert.equal((await inServerAs(aliceToken)).status, 403);

  await requireSso(s.connection.id, false);
  assert.equal((await inServerAs(aliceToken)).status, 200, "off again");
});

test("require SSO: a requirement the platform has not reviewed (or no longer does) manages no one, and the setting comes back with the review", async ({ app }) => {
  const s = await setup(app.baseUrl);
  const aliceAccount = () => fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${s.aliceToken}` } });
  await requireSso(s.connection.id);
  assert.equal((await s.inServer(s.aliceToken)).status, 403, "reviewed and required");
  assert.equal((await aliceAccount()).status, 403, "everywhere, not only in the Server");
  try {
    await setFlag(SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY, false);
    forgetSsoRequirementCache();
    assert.equal((await s.inServer(s.aliceToken)).status, 200, "review withdrawn: required stays set but manages no one");
    assert.equal((await aliceAccount()).status, 200, "and no request outside the Server is refused either");
    const socket = await socketAnswer(app.baseUrl, s.aliceToken, s.server.id);
    socket.socket.close();
    assert.equal(socket.connected, true, socket.error ?? "");
    const [row] = await getDb().select({ required: serverSsoConnections.required }).from(serverSsoConnections).where(eq(serverSsoConnections.id, s.connection.id));
    assert.equal(row!.required, true, "the setting is kept");
  } finally {
    await setFlag(SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY, true);
    forgetSsoRequirementCache();
  }
  assert.equal((await s.inServer(s.aliceToken)).status, 403, "the review restored: enforced again at once");
});

test("require SSO: when the email is on a requiring domain, only that domain's connection counts", async ({ app }) => {
  const a = await setup(app.baseUrl);
  const b = await setup(app.baseUrl);
  await requireSso(a.connection.id);
  await requireSso(b.connection.id);
  // Alice (on A's domain) also has an identity under B's connection, e.g. from an earlier email.
  await getDb().insert(ssoIdentities).values({ connectionId: b.connection.id, subject: `sub-${randomUUID()}`, userId: a.alice.id, emailAtLink: "old@example.test" });
  forgetSsoRequirementCache();
  const token = await login(app.baseUrl, a.alice.email);
  const me = () => fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  await markSsoSession(a.alice.id, b.connection.id, new Date());
  const refused = await me();
  assert.equal(refused.status, 403, "B's IdP does not satisfy A's domain");
  assert.match(((await refused.json()) as { signInUrl: string }).signInUrl, new RegExp(a.server.id, "u"));
  await markSsoSession(a.alice.id, a.connection.id, new Date());
  assert.equal((await me()).status, 200);
});

test("require SSO: owners by membership are exempt, a former owner is not; a deleted Server manages no one", async ({ app }) => {
  const s = await setup(app.baseUrl);
  await requireSso(s.connection.id);
  const me = (token: string) => fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  // Alice becomes a co-owner; the creator (still servers.owner_id, on the domain) leaves.
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, s.server.id), eq(serverMembers.userId, s.alice.id)));
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, s.server.id), eq(serverMembers.userId, s.owner.id)));
  assert.equal((await me(s.aliceToken)).status, 200, "a co-owner is exempt");
  assert.equal((await me(s.ownerToken)).status, 403, "the creator who left is managed like anyone on the domain");

  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, s.server.id));
  forgetSsoRequirementCache();
  assert.equal((await me(s.ownerToken)).status, 200, "a deleted Server requires nothing");
});

test("require SSO: a socket handshake reads fresh, never a cache from before the rule (another replica)", async ({ app }) => {
  const s = await setup(app.baseUrl);
  // Warm this process's cache while nothing is required, then require SSO without telling it.
  assert.equal((await s.inServer(s.aliceToken)).status, 200);
  await getDb().update(serverSsoConnections).set({ required: true }).where(eq(serverSsoConnections.id, s.connection.id));
  const refused = await socketAnswer(app.baseUrl, s.aliceToken, s.server.id);
  refused.socket.close();
  assert.deepEqual([refused.connected, refused.error], [false, "SSO_REQUIRED"]);
});

test("require SSO: the periodic socket re-check finds the sockets that no longer pass", async ({ app }) => {
  const s = await setup(app.baseUrl);
  const aliceFamily = await markSsoSession(s.alice.id, null, null);
  const outsiderFamily = await markSsoSession(s.outsider.id, null, null);
  const sockets = [{ userId: s.alice.id, familyId: aliceFamily }, { userId: s.outsider.id, familyId: outsiderFamily }];
  assert.deepEqual(await socketsFailingSso(sockets), [], "nothing required yet");
  await requireSso(s.connection.id);
  assert.deepEqual(await socketsFailingSso(sockets), [sockets[0]], "only the managed person's");
});

test("require SSO: every socket of a managed person is refused, whichever Server it opens for", async ({ app }) => {
  const s = await setup(app.baseUrl);
  await requireSso(s.connection.id);
  const own = await createServer("Alice's", `alice-${randomUUID().slice(0, 8)}`, s.alice.id);
  for (const serverId of [s.server.id, own.id]) {
    const refused = await socketAnswer(app.baseUrl, s.aliceToken, serverId);
    refused.socket.close();
    assert.deepEqual([refused.connected, refused.error], [false, "SSO_REQUIRED"], serverId);
  }
  const outsider = await socketAnswer(app.baseUrl, s.outsiderToken, s.server.id);
  outsider.socket.close();
  assert.equal(outsider.connected, true, outsider.error ?? "");
  await markSsoSession(s.alice.id, s.connection.id, new Date());
  const accepted = await socketAnswer(app.baseUrl, s.aliceToken, own.id);
  accepted.socket.close();
  assert.equal(accepted.connected, true, accepted.error ?? "");
});

test("require SSO: an App token counts only with the SSO sign-in it was approved from, like a device login", async ({ app }) => {
  const s = await setup(app.baseUrl);
  const { client } = await createOAuthClient({ serverId: s.server.id, createdByUserId: s.owner.id, clientId: `sso-app-${randomUUID().slice(0, 8)}`, name: "SSO App" });
  await getDb().insert(oauthClientInstalls).values({ clientId: client.id, serverId: s.server.id, installedByUserId: s.owner.id }).onConflictDoNothing();
  const token = async (issuedBySessionFamilyId: string | null) => {
    const raw = `slock_at_${randomUUID().replaceAll("-", "")}`;
    await getDb().insert(oauthAccessTokens).values({
      serverId: s.server.id, principalType: "human", userId: s.alice.id, clientId: client.id, tokenHash: hashSecret(raw),
      scopes: ["openid", "profile"], expiresAt: new Date(Date.now() + 60 * 60 * 1000), issuedBySessionFamilyId,
    });
    return raw;
  };
  const userinfo = async (raw: string) => (await fetch(`${app.baseUrl}/api/oauth/userinfo`, { headers: { Authorization: `Bearer ${raw}` } })).status;
  const plainFamily = await markSsoSession(s.alice.id, null, null);
  const beforeColumn = await token(null);
  const fromPassword = await token(plainFamily);
  assert.equal(await userinfo(fromPassword), 200, "nothing required yet");

  await requireSso(s.connection.id);
  assert.equal(await userinfo(beforeColumn), 401, "a token from before the column");
  assert.equal(await userinfo(fromPassword), 401, "approved from a password session");
  const ssoFamily = await markSsoSession(s.alice.id, s.connection.id, new Date());
  const fromSso = await token(ssoFamily);
  assert.equal(await userinfo(fromSso), 200);
  // Signing out of the web later does not end it (it expires on its own); its sign-in passing the max age does.
  await getDb().update(sessionFamilies).set({ revokedAt: new Date() }).where(eq(sessionFamilies.id, ssoFamily));
  assert.equal(await userinfo(fromSso), 200, "the approving session was signed out afterwards");
  await getDb().update(sessionFamilies).set({ ssoAuthenticatedAt: new Date(Date.now() - 8 * DAY_MS) }).where(eq(sessionFamilies.id, ssoFamily));
  assert.equal(await userinfo(fromSso), 401, "its SSO sign-in passed the max age");
});

test("require SSO: a device or app login approved from an SSO session inherits its SSO facts, never another person's", async ({ app }) => {
  const s = await setup(app.baseUrl);
  const at = new Date(Date.now() - DAY_MS);
  const approver = await markSsoSession(s.alice.id, s.connection.id, at);
  const facts = async (familyId: string) => (await getDb().select({ connectionId: sessionFamilies.ssoConnectionId, at: sessionFamilies.ssoAuthenticatedAt })
    .from(sessionFamilies).where(eq(sessionFamilies.id, familyId)))[0]!;
  const device = await createSession(await proofForDeviceLogin(s.alice.id, approver));
  assert.deepEqual(await facts(device.familyId), { connectionId: s.connection.id, at }, "the approver's sign-in time, not now");
  const foreign = await createSession(await proofForDeviceLogin(s.outsider.id, approver));
  assert.deepEqual(await facts(foreign.familyId), { connectionId: null, at: null });
});

test("require SSO: Agents, Computers and App bots use their own credentials and never meet it; an assistant acts as its owner and is held to the owner's (docs/development/sso.md)", async ({ app }) => {
  const s = await setup(app.baseUrl);
  // An admin (still managed: only owners are exempt) may attach a Computer and add an App's bot.
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, s.server.id), eq(serverMembers.userId, s.alice.id)));

  // Her agent's key.
  const agent = await createAgent(s.server.id, `alice-agent-${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external", creatorType: "user", creatorId: s.alice.id });
  const agentKey = (await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], issuedVia: "human", createdByUserId: s.alice.id, name: "sso" })).apiKey;
  assert.match(agentKey, /^sk_agent_/u);
  // Her assistant's key: it acts as her, so her organization's rule holds it too.
  await setFlag(PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, true);
  const assistant = await createAgent(s.server.id, "assistant", { runtime: "external", model: "external", kind: "personal_assistant" });
  await getDb().update(agents).set({ assistantOwnerUserId: s.alice.id }).where(eq(agents.id, assistant.id));
  const assistantKey = (await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], issuedVia: "human", createdByUserId: s.alice.id, name: "sso" })).apiKey;
  // Her Computer's key.
  const computer = await attachComputer({ userId: s.alice.id, serverSlug: s.server.slug, name: "alice-laptop" });
  assert.ok(computer.ok, JSON.stringify(computer));
  assert.match(computer.apiKey, /^sk_computer_/u);
  // An App she installed, its bot added by her session, and the App's bot key.
  const { client, clientSecret } = await createOAuthClient({
    serverId: s.server.id, createdByUserId: s.owner.id, clientId: `sso-bot-${randomUUID().slice(0, 8)}`, name: "SSO Bot App", enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: s.server.id, clientId: client.id, installedByUserId: s.alice.id, status: "active", botGrant: "pending",
  }).returning();
  const grant = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST", headers: { Authorization: `Bearer ${s.aliceToken}`, "X-Server-Id": s.server.id, "Content-Type": "application/json" }, body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(grant.status, 200, await grant.clone().text());
  const minted = await fetch(`${app.baseUrl}/api/oauth/installations/${install!.id}/bot-token`, {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(minted.status, 200, await minted.clone().text());
  const botKey = ((await minted.json()) as { apiKey: string }).apiKey;
  assert.match(botKey, /^sk_agent_/u);

  const call = (path: string, key: string) => fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const credentials: Array<[string, () => Promise<number>]> = [
    ["agent key", async () => (await call("/internal/agent-api/", agentKey)).status],
    ["Computer key", async () => (await call("/internal/computer/self", computer.apiKey)).status],
    ["App bot key", async () => (await call("/internal/agent-api/", botKey)).status],
  ];
  const asAssistant: Array<[string, () => Promise<Response>]> = [
    ["assistant on the agent API", () => call("/internal/agent-api/", assistantKey)],
    ["assistant on her own route", () => fetch(`${app.baseUrl}/api/notification-levels`, { headers: { Authorization: `Bearer ${assistantKey}`, "X-Server-Id": s.server.id } })],
  ];

  assert.equal((await s.inServer(s.aliceToken)).status, 200, "not required yet");
  for (const [label, status] of credentials) assert.equal(await status(), 200, `${label}, not required yet`);
  for (const [label, request] of asAssistant) assert.equal((await request()).status, 200, `${label}, not required yet`);

  const turnedOn = await s.rules(s.ownerToken, { required: true, sessionMaxAgeDays: 7 });
  assert.equal(turnedOn.status, 200, await turnedOn.text());
  forgetSsoRequirementCache();

  const blocked = await s.inServer(s.aliceToken);
  assert.equal(blocked.status, 403, "control: her own password session is refused");
  assert.equal(((await blocked.json()) as { code: string }).code, "SSO_REQUIRED");
  for (const [label, status] of credentials) assert.equal(await status(), 200, `${label}, required`);
  for (const [label, request] of asAssistant) {
    const refused = await request();
    assert.equal(refused.status, 403, `${label}: her only session is a password one`);
    assert.equal(((await refused.json()) as { code: string }).code, "assistant_owner_sso_required", label);
  }

  // She signs in with SSO: her assistant may act for her again, until that sign-in passes the max age.
  await login(app.baseUrl, s.alice.email);
  const family = await markSsoSession(s.alice.id, s.connection.id, new Date());
  for (const [label, request] of asAssistant) assert.equal((await request()).status, 200, `${label}, she signed in with SSO`);
  // She signs out (the session family revoked): her assistant stops with it.
  await getDb().update(sessionFamilies).set({ revokedAt: new Date() }).where(eq(sessionFamilies.id, family));
  for (const [label, request] of asAssistant) assert.equal((await request()).status, 403, `${label}, she signed out`);
  await getDb().update(sessionFamilies).set({ revokedAt: null, ssoAuthenticatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(sessionFamilies.id, family));
  for (const [label, request] of asAssistant) assert.equal((await request()).status, 403, `${label}, her SSO sign-in is past the max age`);
});
