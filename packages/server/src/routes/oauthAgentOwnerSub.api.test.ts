import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agents, oauthClients, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import { createOAuthClient, installMarketplaceOAuthClient, requestAgentAccess } from "../services/oauthService";
import { addMember, createServer, removeMember } from "../services/serverService";

// #proj-apps:#75: an Agent's ID token and userinfo carry `owner_sub`, the
// `sub` its owner gets at login, from Raft's one owner rule (findAgentOwner):
// a personal assistant's person, else the person who created it. Absent when
// an agent created it, or that person is retired or off the Agent's Server.
// `sub` keeps its meaning (the Agent's id), and discovery lists the claim.
const test = createApiTest({ skipAuthRateLimit: true });

type Base = { baseUrl: string };
type RegisteredApp = { id: string; clientId: string; clientSecret: string };

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

async function registerApp(publisher: { id: string }, owner: { id: string }, suffix: string, installOn: { id: string }): Promise<RegisteredApp> {
  const { client, clientSecret } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `owner-sub-${suffix}`,
    name: "Owner Sub App",
    returnUrl: "https://owner-sub.example.test/callback",
    allowedScopes: ["openid", "profile"],
  });
  await getDb().update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, client.id));
  assert.ok(await installMarketplaceOAuthClient({
    serverId: installOn.id,
    clientId: client.id,
    installedByUserId: owner.id,
    expected: await currentAppPermissions(client.id),
  }));
  return { id: client.id, clientId: client.clientId, clientSecret };
}

/** The Agent's login at the Server's issuer: the ID token's claims and the access token. */
async function agentLogin(app: Base, client: RegisteredApp, server: { id: string; slug: string }, agentId: string) {
  // As the Agent asks for itself (`raft integration login`): a personal assistant is found only so.
  const requested = await requestAgentAccess({ clientId: client.id, serverSlug: server.slug, agentId, scopes: ["openid", "profile"], initiatedByAgent: true });
  assert.equal(requested.status, "approved");
  const res = await fetch(`${app.baseUrl}/oidc/${server.slug}/api/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "urn:slock:grant-type:agent_request", request_id: requested.request.id }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const token = JSON.parse(body) as { access_token: string; id_token: string };
  const claims = JSON.parse(Buffer.from(token.id_token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  return { claims, accessToken: token.access_token };
}

async function userinfo(app: Base, server: { slug: string }, accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${app.baseUrl}/oidc/${server.slug}/api/oauth/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body) as Record<string, unknown>;
}

test("an Agent's ID token and userinfo carry owner_sub only while it has an owner; sub stays the Agent's", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const admin = await seedUser("owner-sub-admin");
  const creator = await seedUser("owner-sub-creator");
  const assisted = await seedUser("owner-sub-assisted");
  const server = await createServer(`Owner Sub ${suffix}`, `owner-sub-${suffix}`, admin.id);
  await addMember(server.id, creator.id, "member");
  await addMember(server.id, assisted.id, "member");
  const client = await registerApp(server, admin, suffix, server);

  const discovery = await (await fetch(`${app.baseUrl}/oidc/${server.slug}/.well-known/openid-configuration`)).json() as { claims_supported: string[] };
  assert.ok(discovery.claims_supported.includes("owner_sub"));

  // Created by a person: owner_sub is that person's id; sub is the Agent's.
  const made = await createAgent(server.id, `made-${suffix}`, { runtime: "external", model: "external", creatorType: "user", creatorId: creator.id });
  const login = await agentLogin(app, client, server, made.id);
  assert.equal(login.claims.type, "agent");
  assert.equal(login.claims.sub, made.id);
  assert.equal(login.claims.owner_sub, creator.id);
  assert.equal((await userinfo(app, server, login.accessToken)).owner_sub, creator.id);

  // A personal assistant: the person it assists, ahead of its creator.
  await getDb().update(agents).set({ assistantOwnerUserId: assisted.id }).where(eq(agents.id, made.id));
  assert.equal((await agentLogin(app, client, server, made.id)).claims.owner_sub, assisted.id);
  await getDb().update(agents).set({ assistantOwnerUserId: null }).where(eq(agents.id, made.id));

  // Created by an agent: no owner, no claim.
  const agentMade = await createAgent(server.id, `agent-made-${suffix}`, { runtime: "external", model: "external", creatorType: "agent", creatorId: made.id });
  const agentMadeLogin = await agentLogin(app, client, server, agentMade.id);
  assert.equal("owner_sub" in agentMadeLogin.claims, false);
  assert.equal("owner_sub" in await userinfo(app, server, agentMadeLogin.accessToken), false);

  // The owner leaves the Server: userinfo (read live) drops it, and so does a new ID token.
  await removeMember(server.id, creator.id);
  assert.equal("owner_sub" in await userinfo(app, server, login.accessToken), false);
  assert.equal("owner_sub" in (await agentLogin(app, client, server, made.id)).claims, false);

  // The owner is back but retired (account deleted): still no claim.
  await addMember(server.id, creator.id, "member");
  assert.equal((await agentLogin(app, client, server, made.id)).claims.owner_sub, creator.id);
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, creator.id));
  assert.equal("owner_sub" in (await agentLogin(app, client, server, made.id)).claims, false);
});
