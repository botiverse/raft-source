import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { oauthAccessRequests, oauthAccessTokens, oauthClientInstalls, oauthClients, oauthUserConsents, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import {
  OAuthInstallationSuspendedError,
  createOAuthClient,
  installMarketplaceOAuthClient,
  listAgentAvailableOAuthClients,
  listGrantableAgentApps,
  requestAgentAccess,
} from "../services/oauthService";

// Login with Raft honours the installation, not only the app: a suspended
// installation closes every login path on that Server (lookup, human code,
// token exchange, live identity, agent request), and a human login to a
// third-party app is granted only the scopes that Server's admin approved.
// Server-local apps have no installation gate and are unaffected.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const RETURN_URL = "https://gates.example.test/login/raft/callback";

type Base = { baseUrl: string };

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
  return { ...user, bearer: await tokenForHuman(user.email) };
}

/** A published third-party app installed through the real Marketplace path, which records approved_scopes. */
async function seedThirdPartyInstall(allowedScopes: string[]) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("gates-owner");
  const member = await seedUser("gates-member");
  const publisher = await createServer("Gates Publisher", `gates-pub-${suffix}`, owner.id);
  const server = await createServer("Gates Installer", `gates-inst-${suffix}`, owner.id);
  await addMember(server.id, member.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `gates-${suffix}`,
    name: "Gates App",
    returnUrl: RETURN_URL,
    allowedScopes,
  });
  await getDb().update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, client.id));
  assert.ok(await installMarketplaceOAuthClient({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    expected: await currentAppPermissions(client.id),
  }));
  const [install] = await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.clientId, client.id),
    eq(oauthClientInstalls.serverId, server.id),
  ));
  return { owner, member, server, client, clientSecret, install };
}

function authorize(app: Base, bearer: string, body: Record<string, unknown>) {
  return fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function oidcAuthorizeBody(clientKey: string, serverId: string, scopes: string[]) {
  const verifier = randomBytes(32).toString("base64url");
  return {
    clientId: clientKey,
    serverId,
    scopes,
    returnUrl: RETURN_URL,
    oidc: true,
    nonce: `nonce-${randomUUID()}`,
    codeChallenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    codeChallengeMethod: "S256",
  };
}

async function authorizedCode(app: Base, bearer: string, clientKey: string, serverId: string, scopes: string[]) {
  const res = await authorize(app, bearer, { clientId: clientKey, serverId, returnUrl: RETURN_URL, scopes });
  assert.equal(res.status, 200, `authorize failed (${res.status}): ${await res.clone().text()}`);
  return await res.json() as { code: string; scopes: string[] };
}

function exchange(app: Base, clientKey: string, clientSecret: string, code: string) {
  return fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: clientKey, clientSecret, grantType: "authorization_code", code }),
  });
}

async function exchangedToken(app: Base, clientKey: string, clientSecret: string, code: string) {
  const res = await exchange(app, clientKey, clientSecret, code);
  assert.equal(res.status, 200, `token exchange failed (${res.status}): ${await res.clone().text()}`);
  return await res.json() as { access_token: string; scope: string; id_token?: string };
}

function bearerGet(app: Base, path: string, token: string) {
  return fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

function lookup(app: Base, bearer: string, clientKey: string, serverId: string) {
  return fetch(`${app.baseUrl}/api/oauth/clients/lookup?${new URLSearchParams({ client_id: clientKey, server_id: serverId })}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

async function humanRequestCount(clientId: string) {
  return (await getDb().select({ id: oauthAccessRequests.id }).from(oauthAccessRequests).where(and(
    eq(oauthAccessRequests.clientId, clientId),
    eq(oauthAccessRequests.principalType, "human"),
  ))).length;
}

async function setInstall(installId: string, values: Partial<typeof oauthClientInstalls.$inferInsert>) {
  await getDb().update(oauthClientInstalls).set(values).where(eq(oauthClientInstalls.id, installId));
}

test("a suspended installation closes every Login with Raft path on its Server, live, and reopens when restored", async ({ app }) => {
  const f = await seedThirdPartyInstall(["openid", "profile", "agent:read"]);
  const clientKey = f.client.clientId;
  const agent = await createAgent(f.server.id, "GatesAgent", { runtime: "external", model: "external" });
  const agentKey = (await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "gates", issuedVia: "computer", createdByUserId: null })).apiKey;
  const agentApi = (path: string, body?: Record<string, unknown>) => fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${agentKey}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const appAgentRequest = () => fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: clientKey, clientSecret: f.clientSecret, serverSlug: f.server.slug, agentName: agent.name, scopes: ["openid", "profile"] }),
  });

  // Positive controls while active: every path below works before suspension.
  const earlyCode = (await authorizedCode(app, f.member.bearer, clientKey, f.server.id, ["openid", "profile"])).code;
  // Without openid the exchange reads no identity, so only the exchange's own
  // installation re-check stands between this code and a token.
  const earlyProfileCode = (await authorizedCode(app, f.member.bearer, clientKey, f.server.id, ["profile"])).code;
  const live = await exchangedToken(app, clientKey, f.clientSecret,
    (await authorizedCode(app, f.member.bearer, clientKey, f.server.id, ["openid", "profile"])).code);
  assert.equal((await bearerGet(app, "/api/oauth/userinfo", live.access_token)).status, 200);
  assert.equal((await lookup(app, f.member.bearer, clientKey, f.server.id)).status, 200);
  assert.equal((await appAgentRequest()).status, 200);
  const activeLogin = await agentApi("/integrations/login", { service: clientKey });
  assert.equal(activeLogin.status, 200, await activeLogin.clone().text());
  assert.ok((await listAgentAvailableOAuthClients(f.server.id)).some((client) => client.id === f.client.id));
  assert.ok((await listGrantableAgentApps(f.server.id)).some((client) => client.clientId === f.client.id));

  await setInstall(f.install.id, { status: "suspended" });

  // Lookup: says suspended (this is a public Marketplace app, so falling
  // through would wrongly answer install_required), and never "ready".
  const suspendedLookup = await lookup(app, f.member.bearer, clientKey, f.server.id);
  assert.equal(suspendedLookup.status, 200);
  const suspendedBody = await suspendedLookup.json() as { availability: string; installation?: unknown };
  assert.equal(suspendedBody.availability, "suspended");
  assert.equal(suspendedBody.installation, undefined, "a suspended installation offers no install");

  // Human authorization, legacy and OIDC: refused, and no code is issued.
  const requestsBefore = await humanRequestCount(f.client.id);
  for (const body of [
    { clientId: clientKey, serverId: f.server.id, returnUrl: RETURN_URL, scopes: ["openid", "profile"] },
    oidcAuthorizeBody(clientKey, f.server.id, ["openid", "profile"]),
  ]) {
    const refused = await authorize(app, f.member.bearer, body);
    assert.equal(refused.status, 403);
    const refusedBody = await refused.json() as { error: string; errorCode: string };
    assert.equal(refusedBody.error, "installation_suspended");
    assert.equal(refusedBody.errorCode, "OAUTH_INSTALLATION_SUSPENDED");
  }
  assert.equal(await humanRequestCount(f.client.id), requestsBefore, "no authorization code was issued");

  // A code issued before the suspension does not exchange after it.
  for (const code of [earlyProfileCode, earlyCode]) {
    const lateExchange = await exchange(app, clientKey, f.clientSecret, code);
    assert.equal(lateExchange.status, 400);
    const lateBody = await lateExchange.json() as { error: string; error_description: string };
    assert.equal(lateBody.error, "invalid_grant");
    assert.match(lateBody.error_description, /suspended/);
  }

  // An existing token loses its live identity on this Server, like a lost membership.
  for (const path of ["/api/oauth/userinfo", "/api/oauth/serverinfo", "/api/oauth/agents"]) {
    assert.equal((await bearerGet(app, path, live.access_token)).status, 401, path);
  }

  // Agents: the app's own request, the agent's login, and the listings.
  const appRequest = await appAgentRequest();
  assert.equal(appRequest.status, 403);
  assert.equal((await appRequest.json() as { error: string }).error, "installation_suspended");
  await assert.rejects(
    requestAgentAccess({ clientId: f.client.id, serverSlug: f.server.slug, agentId: agent.id, scopes: ["openid", "profile"], initiatedByAgent: true }),
    (error: unknown) => error instanceof OAuthInstallationSuspendedError,
  );
  const agentLogin = await agentApi("/integrations/login", { service: clientKey });
  assert.equal(agentLogin.status, 403);
  const agentLoginBody = await agentLogin.json() as { errorCode: string; error: string; status?: string };
  assert.equal(agentLoginBody.errorCode, "INTEGRATION_INSTALLATION_SUSPENDED");
  assert.equal(agentLoginBody.status, undefined, "not answered as install_required");
  const agentList = await agentApi("/integrations");
  assert.equal(agentList.status, 200);
  assert.ok(!(await agentList.json() as { services: Array<{ clientId: string }> }).services.some((service) => service.clientId === clientKey));
  assert.ok(!(await listAgentAvailableOAuthClients(f.server.id)).some((client) => client.id === f.client.id));
  assert.ok(!(await listGrantableAgentApps(f.server.id)).some((client) => client.clientId === f.client.id));
  // The agent JWT already refused a suspended installation; it still does.
  assert.equal((await agentApi("/integrations/token", { service: clientKey })).status, 403);

  // Suspension is a live gate, not a revocation: restoring the installation
  // brings the same token and the lookup back.
  await setInstall(f.install.id, { status: "active" });
  assert.equal((await bearerGet(app, "/api/oauth/userinfo", live.access_token)).status, 200);
  assert.equal((await (await lookup(app, f.member.bearer, clientKey, f.server.id)).json() as { availability: string }).availability, "ready");
});

test("a server-local app has no installation gate: its source installation's status and approved scopes don't touch human login", async ({ app }) => {
  const owner = await seedUser("gates-local-owner");
  const server = await createServer("Gates Local", `gates-local-${randomUUID().slice(0, 8)}`, owner.id);
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `gates-local-${randomUUID().slice(0, 8)}`,
    name: "Gates Local App",
    returnUrl: RETURN_URL,
    allowedScopes: ["openid", "profile", "agent:read"],
  });
  // A source installation (App Notifications) that is suspended and approved nothing.
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedBySystem: true,
    status: "suspended",
    approvedScopes: [],
  });

  const lookupBody = await (await lookup(app, owner.bearer, client.clientId, server.id)).json() as { availability: string };
  assert.equal(lookupBody.availability, "ready");
  const authorized = await authorizedCode(app, owner.bearer, client.clientId, server.id, ["openid", "profile", "agent:read"]);
  assert.deepEqual(authorized.scopes, ["agent:read", "openid", "profile"]);
  const token = await exchangedToken(app, client.clientId, clientSecret, authorized.code);
  assert.equal(token.scope, "agent:read openid profile");
  assert.equal((await bearerGet(app, "/api/oauth/userinfo", token.access_token)).status, 200);
  assert.equal((await bearerGet(app, "/api/oauth/agents", token.access_token)).status, 200);
});

test("a human login to a third-party app is granted only the scopes this Server's admin approved", async ({ app }) => {
  const f = await seedThirdPartyInstall(["openid", "profile"]);
  const clientKey = f.client.clientId;
  assert.deepEqual(f.install.approvedScopes, ["openid", "profile"], "fixture: installed with its scopes at the time");
  // The developer adds agent:read after the install (the known Vault case);
  // this Server's admin has not approved the update.
  await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile", "agent:read"] }).where(eq(oauthClients.id, f.client.id));

  const authorized = await authorizedCode(app, f.member.bearer, clientKey, f.server.id, ["openid", "profile", "agent:read"]);
  assert.deepEqual(authorized.scopes, ["openid", "profile"], "the unapproved scope is dropped, not refused");
  const [request] = await getDb().select({ scopes: oauthAccessRequests.scopes }).from(oauthAccessRequests)
    .where(eq(oauthAccessRequests.id, authorized.code));
  assert.deepEqual(request.scopes, ["openid", "profile"]);

  const token = await exchangedToken(app, clientKey, f.clientSecret, authorized.code);
  assert.equal(token.scope, "openid profile", "the token response says which scopes were granted (RFC 6749 §5.1)");
  assert.ok(token.id_token, "openid is granted, so the login still carries an ID token");
  const [stored] = await getDb().select({ scopes: oauthAccessTokens.scopes }).from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.requestId, authorized.code));
  assert.deepEqual(stored.scopes, ["openid", "profile"]);
  const [consent] = await getDb().select({ scopes: oauthUserConsents.scopes }).from(oauthUserConsents).where(and(
    eq(oauthUserConsents.userId, f.member.id),
    eq(oauthUserConsents.serverId, f.server.id),
    eq(oauthUserConsents.clientId, f.client.id),
  ));
  assert.deepEqual(consent.scopes, ["openid", "profile"], "the consent records what was granted, not what was asked");
  const userinfo = await (await bearerGet(app, "/api/oauth/userinfo", token.access_token)).json() as { scope: string };
  assert.equal(userinfo.scope, "openid profile");
  assert.equal((await bearerGet(app, "/api/oauth/agents", token.access_token)).status, 403, "agent:read was not granted");

  // Once the admin approves the update, the same request is granted in full.
  await setInstall(f.install.id, { approvedScopes: ["openid", "profile", "agent:read"] });
  const approved = await authorizedCode(app, f.member.bearer, clientKey, f.server.id, ["openid", "profile", "agent:read"]);
  assert.deepEqual(approved.scopes, ["agent:read", "openid", "profile"]);
  const widened = await exchangedToken(app, clientKey, f.clientSecret, approved.code);
  assert.equal(widened.scope, "agent:read openid profile");
  assert.equal((await bearerGet(app, "/api/oauth/agents", widened.access_token)).status, 200);
});

test("openid outside the approved scopes is refused with invalid_scope for the app's callback; an empty approved set grants nothing", async ({ app }) => {
  const f = await seedThirdPartyInstall(["openid", "profile"]);
  const clientKey = f.client.clientId;
  const outsider = await seedUser("gates-outsider");
  const requestsBefore = await humanRequestCount(f.client.id);

  await setInstall(f.install.id, { approvedScopes: ["profile"] });
  for (const body of [
    { clientId: clientKey, serverId: f.server.id, returnUrl: RETURN_URL, scopes: ["openid", "profile"] },
    oidcAuthorizeBody(clientKey, f.server.id, ["openid", "profile"]),
  ]) {
    const refused = await authorize(app, f.member.bearer, body);
    assert.equal(refused.status, 400);
    const refusedBody = await refused.json() as {
      error: string;
      errorCode: string;
      error_description: string;
      unapprovedScopes: string[];
      returnUrl: string | null;
    };
    assert.equal(refusedBody.error, "invalid_scope");
    assert.equal(refusedBody.errorCode, "OAUTH_SCOPE_NOT_APPROVED");
    assert.deepEqual(refusedBody.unapprovedScopes, ["openid"]);
    assert.match(refusedBody.error_description, /openid/);
    assert.equal(refusedBody.returnUrl, RETURN_URL, "the registered callback, for the setup page's error redirect");
  }
  // A non-member learns nothing about the installation: the one refusal (RFC 079 2a).
  assert.equal((await authorize(app, outsider.bearer, { clientId: clientKey, serverId: f.server.id, returnUrl: RETURN_URL, scopes: ["openid", "profile"] })).status, 403);
  // A request that never asked for openid gets its approved part.
  assert.deepEqual((await authorizedCode(app, f.member.bearer, clientKey, f.server.id, ["profile"])).scopes, ["profile"]);

  // Legacy rows: approved_scopes is NOT NULL and was backfilled (0377), so the
  // only legacy shape is an empty set. It approves nothing: refused, including
  // the default scopes when the request names none.
  await setInstall(f.install.id, { approvedScopes: [] });
  for (const scopes of [["openid", "profile"], undefined, ["profile"]]) {
    const refused = await authorize(app, f.member.bearer, { clientId: clientKey, serverId: f.server.id, returnUrl: RETURN_URL, ...(scopes ? { scopes } : {}) });
    assert.equal(refused.status, 400, `scopes ${JSON.stringify(scopes)}`);
    const refusedBody = await refused.json() as { errorCode: string; unapprovedScopes: string[] };
    assert.equal(refusedBody.errorCode, "OAUTH_SCOPE_NOT_APPROVED");
    assert.deepEqual(refusedBody.unapprovedScopes, scopes ?? ["openid", "profile"]);
  }
  assert.equal(await humanRequestCount(f.client.id), requestsBefore + 1, "only the profile-only login issued a code");
});
