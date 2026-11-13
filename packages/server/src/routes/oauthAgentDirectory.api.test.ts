import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, oauthAccessTokens, oauthClients, oauthGrants, serverAgentMembers, users } from "../db/schema";
import { createServer, removeMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient, issueHumanAuthorizationCode, requestAgentAccess } from "../services/oauthService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function setup() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `directory-${suffix}@raft.test`, name: `directory-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true,
  }).returning();
  const server = await createServer("Directory", `directory-${suffix}`, owner.id);
  const other = await createServer("Other", `other-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "DirectoryAgent", { runtime: "external", model: "external" });
  const foreign = await createAgent(other.id, "ForeignAgent", { runtime: "external", model: "external" });
  const deleted = await createAgent(server.id, "DeletedAgent", { runtime: "external", model: "external" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deleted.id));
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, clientId: `directory-${suffix.slice(0, 8)}`,
    name: "Directory only", returnUrl: "https://directory.example.test/callback",
    allowedScopes: ["openid", "profile", "agent:read"],
  });
  return { owner, server, other, agent, foreign, client, clientSecret };
}

async function token(baseUrl: string, f: Awaited<ReturnType<typeof setup>>, principal: "human" | "agent", scopes = ["openid", "profile", "agent:read"]) {
  const code = principal === "human"
    ? (await issueHumanAuthorizationCode({ clientKey: f.client.clientId, userId: f.owner.id, serverId: f.server.id, returnUrl: f.client.returnUrl!, scopes, approverSessionFamilyId: (await signInForTest(f.owner.id)).familyId })).code
    : (await requestAgentAccess({ clientId: f.client.id, serverSlug: f.server.slug, agentName: f.agent.name, scopes })).request.id;
  const response = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${f.client.clientId}:${f.clientSecret}`).toString("base64")}` },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: f.client.returnUrl }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { access_token: string }).access_token;
}

for (const principal of ["human", "agent"] as const) {
  test(`agent directory grants ${principal} a minimal Server-bound read without webhook or send authority`, async ({ app }) => {
    const f = await setup();
    const bearer = await token(app.baseUrl, f, principal);
    const headers = { Authorization: `Bearer ${bearer}` };
    for (const prefix of ["", `/oidc/${f.server.slug}`, `/oidc/${f.server.id}`]) {
      const response = await fetch(`${app.baseUrl}${prefix}/api/oauth/agents?server_id=${f.server.id}&agentId=${f.foreign.id}`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json() as { agents: Array<Record<string, unknown>> };
      assert.deepEqual(body.agents.map((a) => a.id), [f.agent.id]);
      assert.deepEqual(Object.keys(body.agents[0]).sort(), ["avatar_url", "display_name", "handle", "id", "picture"]);
      assert.equal(body.agents[0].handle, "DirectoryAgent");
      // Another Server's id cannot switch the directory (RFC 079 D12).
      const switched = await fetch(`${app.baseUrl}${prefix}/api/oauth/agents?server_id=${f.other.id}`, { headers });
      assert.equal(switched.status, 403);
      assert.equal("agents" in await switched.json(), false);
    }
    const crossServer = await fetch(`${app.baseUrl}/oidc/${f.other.slug}/api/oauth/agents`, { headers });
    assert.equal(crossServer.status, 401);
    assert.equal("agents" in await crossServer.json(), false);
    const write = await fetch(`${app.baseUrl}/api/oauth/agent-events`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "notification", summary: "must not send" }),
    });
    assert.equal(write.status, 403);
    const discovery = await (await fetch(`${app.baseUrl}/oidc/${f.server.slug}/api/oauth/.well-known/openid-configuration`)).json() as Record<string, unknown>;
    assert.ok((discovery.scopes_supported as string[]).includes("agent:read"));
    assert.ok(String(discovery.agents_endpoint).endsWith(`/oidc/${f.server.slug}/api/oauth/agents`));

    // Existing tokens retain only their own grant; declaring a scope cannot
    // silently upgrade older identity-only tokens.
    const identityOnly = await token(app.baseUrl, f, principal, ["openid", "profile"]);
    assert.equal((await fetch(`${app.baseUrl}/api/oauth/agents`, { headers: { Authorization: `Bearer ${identityOnly}` } })).status, 403);
    await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
    assert.equal((await fetch(`${app.baseUrl}/api/oauth/agents`, { headers })).status, 403);
    await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, f.client.id));
    if (principal === "human") await removeMember(f.server.id, f.owner.id);
    else await getDb().delete(serverAgentMembers).where(eq(serverAgentMembers.agentId, f.agent.id));
    assert.equal((await fetch(`${app.baseUrl}/api/oauth/agents`, { headers })).status, 401);
  });
}

test("webhook groups cannot grant the directory scope; missing, revoked and expired credentials disclose nothing", async ({ app }) => {
  const f = await setup();
  await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile"], outboundCurrentGroups: ["agent"] }).where(eq(oauthClients.id, f.client.id));
  await assert.rejects(() => issueHumanAuthorizationCode({
    clientKey: f.client.clientId, userId: f.owner.id, serverId: f.server.id,
    returnUrl: f.client.returnUrl!, scopes: ["agent:read"], approverSessionFamilyId: null,
  }));
  const identityOnly = await token(app.baseUrl, f, "human", ["openid", "profile"]);
  const read = (credential?: string) => fetch(`${app.baseUrl}/api/oauth/agents`, { headers: credential ? { Authorization: `Bearer ${credential}` } : {} });
  assert.equal((await read(identityOnly)).status, 403);
  for (const credential of [undefined, "not-a-token", f.clientSecret]) {
    const result = await read(credential);
    assert.equal(result.status, 401);
    assert.equal("agents" in await result.json(), false);
  }
  await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile", "agent:read"] }).where(eq(oauthClients.id, f.client.id));
  assert.equal((await read(identityOnly)).status, 403);
  const bearer = await token(app.baseUrl, f, "human");
  assert.equal((await read(bearer)).status, 200);
  await getDb().update(oauthAccessTokens).set({ expiresAt: new Date(0) }).where(eq(oauthAccessTokens.clientId, f.client.id));
  assert.equal((await read(bearer)).status, 401);
  const revokedToken = await token(app.baseUrl, f, "human");
  await getDb().update(oauthAccessTokens).set({ revokedAt: new Date() }).where(eq(oauthAccessTokens.clientId, f.client.id));
  assert.equal((await read(revokedToken)).status, 401);
  const renewed = await token(app.baseUrl, f, "agent");
  await getDb().update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.clientId, f.client.id));
  assert.equal((await read(renewed)).status, 401);
});

// Only its owner finds a personal assistant (agentFindableBy). An App reading
// the directory is not its owner, even signed in as them: the directory is the
// server's agents a member list shows (listedServerAgent), never an assistant.
for (const principal of ["human", "agent"] as const) {
  test(`agent directory never lists a personal assistant (${principal} token)`, async ({ app }) => {
    const f = await setup();
    const assistant = await createAgent(f.server.id, `assistant-${randomUUID().slice(0, 6)}`, {
      runtime: "external", model: "external", creatorType: "user", creatorId: f.owner.id, kind: "personal_assistant",
    });
    await getDb().update(agents).set({ assistantOwnerUserId: f.owner.id }).where(eq(agents.id, assistant.id));
    const bearer = await token(app.baseUrl, f, principal);
    const response = await fetch(`${app.baseUrl}/api/oauth/agents`, { headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<{ id: string }> };
    assert.deepEqual(body.agents.map((a) => a.id), [f.agent.id], "the assistant is absent; the ordinary agent stays");
  });
}
