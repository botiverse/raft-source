import assert from "node:assert/strict";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentCredentials, agents, integrationAuditEvents, oauthAccessRequests, oauthAccessTokens, oauthClients, oauthGrants, serverAgentMembers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createOAuthClient, revokeGrant, grantAgentAccessOnBehalf } from "../services/oauthService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("Agent JWT issuance is built in, binds the authenticated actor, requires live local authorization, and never creates a raw code", async () => {
  const previousUrl = process.env.SERVER_URL;
  process.env.SERVER_URL = "https://raft.example.test";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const suffix = randomUUID();
    const [owner] = await getDb().insert(users).values({ name: `jwt-${suffix}`, email: `jwt-${suffix}@raft.test`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
    const server = await createServer("JWT Server", `jwt-${suffix}`, owner.id);
    const foreign = await createServer("Foreign Server", `foreign-${suffix}`, owner.id);
    const agent = await createAgent(server.id, "JwtAgent", { runtime: "external", model: "external" });
    const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "jwt-test", issuedVia: "computer", createdByUserId: null });
    const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `jwt-${suffix.slice(0, 8)}`, name: "JWT RP", allowedScopes: ["openid", "profile"], returnUrl: "https://rp.example.test/callback" });
    const { client: foreignClient } = await createOAuthClient({ serverId: foreign.id, createdByUserId: owner.id, clientId: `other-${suffix.slice(0, 8)}`, name: "Foreign RP", allowedScopes: ["openid", "profile"] });
    const post = (body: Record<string, unknown> = { service: client.clientId }, token = credential.apiKey) => fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    assert.equal((await post(undefined, "invalid-agent-key")).status, 401);
    assert.equal((await post({ service: foreignClient.clientId })).status, 403, "another Server's private App is not available here");
    for (const field of ["agentId", "serverId", "audience", "issuer", "expires_in", "scopes", "claims"]) {
      assert.equal((await post({ service: client.clientId, [field]: "override" })).status, 400, field);
    }
    const response = await post();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const issued = await response.json() as { access_token: string; audience: string; expires_in: number };
    const [h, p, sig] = issued.access_token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const keys = await (await fetch(`${app.baseUrl}/oidc/${server.slug}/api/oauth/jwks`)).json() as { keys: JsonWebKey[] };
    const key = keys.keys.find((item) => (item as JsonWebKey & { kid: string }).kid === header.kid)!;
    assert.equal(verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), true);
    assert.equal(header.typ, "at+jwt");
    assert.equal(header.alg, "ES256");
    assert.equal(claims.iss, `https://raft.example.test/oidc/${server.slug}`);
    assert.equal(claims.aud, client.clientId);
    assert.equal(claims.sub, agent.id);
    assert.equal(claims.server_id, server.id);
    assert.equal(claims.type, "agent");
    assert.equal(claims.token_use, "agent_access");
    assert.equal(claims.login, `raft-agent-${agent.id}`);
    assert.equal(claims.login.length, 47);
    assert.equal(claims.preferred_username, agent.name);
    assert.equal(Number.isSafeInteger(claims.exp), true, "exp is mandatory and must be numeric integer seconds");
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(claims.nbf, claims.iat);
    assert.equal(issued.expires_in, 300);
    assert.equal("email" in claims, false);
    assert.equal((await fetch(`${app.baseUrl}/api/oauth/userinfo`, { headers: { Authorization: `Bearer ${issued.access_token}` } })).status, 401, "audience JWT grants no Raft API access");
    const second = await (await post()).json() as { access_token: string };
    assert.notEqual(second.access_token, issued.access_token);
    const initialGrants = await getDb().select().from(oauthGrants);
    assert.equal(initialGrants.length, 1, "reuse first-use grant");
    assert.equal(initialGrants[0].grantSource, "agent_login");
    assert.equal((await getDb().select().from(oauthAccessRequests)).length, 0);
    assert.equal((await getDb().select().from(oauthAccessTokens)).length, 0);
    const audit = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent.jwt_issued"));
    assert.equal(audit.length, 2);
    assert.equal(audit[0].metadata?.jti, claims.jti);
    assert.equal(JSON.stringify(audit).includes(issued.access_token), false);

    await getDb().update(agents).set({ status: "stopped" }).where(eq(agents.id, agent.id));
    assert.equal((await post()).status, 403);
    await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, agent.id));
    await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, client.id));
    assert.equal((await post()).status, 403);
    await getDb().update(oauthClients).set({ enabled: true, allowedScopes: ["openid"] }).where(eq(oauthClients.id, client.id));
    assert.equal((await post()).status, 403);
    await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile"], appType: "third_party_global" }).where(eq(oauthClients.id, client.id));
    assert.equal((await post()).status, 403, "a published App needs an active installation on this Server");
    await getDb().update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, client.id));
    await getDb().delete(serverAgentMembers).where(eq(serverAgentMembers.agentId, agent.id));
    assert.equal((await post()).status, 403);
    await getDb().insert(serverAgentMembers).values({ serverId: server.id, agentId: agent.id });
    const [activeGrant] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.agentId, agent.id));
    await revokeGrant({ serverId: server.id, grantId: activeGrant.id, revokedByUserId: owner.id });
    await getDb().delete(oauthGrants).where(eq(oauthGrants.id, activeGrant.id));
    assert.equal((await post()).status, 403, "sticky pair revoke survives grant history cleanup");
    await grantAgentAccessOnBehalf({ serverId: server.id, agentId: agent.id, clientId: client.id, scopes: ["openid", "profile"], grantedByUserId: owner.id });
    assert.equal((await post()).status, 200, "a person's explicit regrant restores issuance");
    await getDb().update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.agentId, agent.id));
    assert.equal((await post()).status, 403, "do not silently recreate revoked grant");
    assert.equal((await getDb().select().from(oauthGrants)).length, 1);
    await getDb().update(agentCredentials).set({ revokedAt: new Date() }).where(eq(agentCredentials.id, credential.credentialId));
    assert.equal((await post()).status, 401);
  } finally {
    if (previousUrl === undefined) delete process.env.SERVER_URL; else process.env.SERVER_URL = previousUrl;
    await app.close();
  }
});
