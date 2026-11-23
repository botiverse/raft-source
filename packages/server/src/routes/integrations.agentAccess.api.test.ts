import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppAgentAccess } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, oauthClients, oauthGrants, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient, installMarketplaceOAuthClient, requestAgentAccess, revokeGrant } from "../services/oauthService";

// Which of a Server's agents can use each Raft App: GET /integrations/clients (this Server's own
// Apps) and GET /integrations/marketplace (an App installed here), the rule requestAgentAccess
// applies to a request no agent made itself.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const SCOPES = ["agent:notification:write"];

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

/** An owner and a plain member, each with an agent (owner's first), plus a deleted agent and a personal assistant. */
async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("access-owner");
  const member = await seedUser("access-member");
  const server = await createServer("Agent Access", `agent-access-${suffix}`, owner.id);
  await addMember(server.id, member.id, "member");
  const agent = async (label: string, creatorId: string, createdAt: string) => {
    const created = await createAgent(server.id, `${label}${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId });
    await getDb().update(agents).set({ createdAt: new Date(createdAt) }).where(eq(agents.id, created.id));
    return created;
  };
  const ownersAgent = await agent("OwnersBot", owner.id, "2026-01-01T00:00:00Z");
  const membersAgent = await agent("MembersBot", member.id, "2026-01-02T00:00:00Z");
  const gone = await agent("GoneBot", owner.id, "2026-01-03T00:00:00Z");
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
  const assistant = await agent("AssistantBot", member.id, "2026-01-04T00:00:00Z");
  await getDb().update(agents).set({ assistantOwnerUserId: member.id }).where(eq(agents.id, assistant.id));
  return { suffix, owner, member, server, ownersAgent, membersAgent };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function accessFrom(baseUrl: string, f: Seeded, path: "/integrations/clients" | "/integrations/marketplace", clientId: string, email = f.member.email) {
  const res = await fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": f.server.id } });
  assert.equal(res.status, 200, "any member of the Server reads it");
  const rows = await res.json() as Array<{ id: string; agentAccess: AppAgentAccess | null }>;
  const row = rows.find((candidate) => candidate.id === clientId);
  assert.ok(row, `${path} lists ${clientId}`);
  return row.agentAccess;
}

function localApp(f: Seeded, createdByUserId: string, key: string, vouchAsCreator = false) {
  return createOAuthClient({ serverId: f.server.id, createdByUserId, clientId: `${key}-${f.suffix}`, name: `App ${key}`, allowedScopes: SCOPES, vouchAsCreator });
}

test("a server-local App: its server vouch decides, an active grant adds an agent, a person's revoke excepts one", async ({ app }) => {
  const f = await seed();
  const all = { allAgents: true, agentIds: [f.ownersAgent.id, f.membersAgent.id], exceptAgentIds: [] };

  const byOwner = await localApp(f, f.owner.id, "local-owner", true);
  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/clients", byOwner.client.id), all,
    "a vouched App covers every listed agent; deleted agents and personal assistants are never named");
  // The owner's own App nobody vouched for covers only the owner's agents: the owner's role is not read.
  const unvouched = await localApp(f, f.owner.id, "local-owner-plain");
  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/clients", unvouched.client.id),
    { allAgents: false, agentIds: [f.ownersAgent.id], exceptAgentIds: [f.membersAgent.id] });

  // A plain member's App covers only that member's agents...
  const byMember = await localApp(f, f.member.id, "local-member");
  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/clients", byMember.client.id),
    { allAgents: false, agentIds: [f.membersAgent.id], exceptAgentIds: [f.ownersAgent.id] });
  // ...until a person grants another agent.
  const res = await fetch(`${app.baseUrl}/api/integrations/agents/${f.ownersAgent.id}/grants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(f.owner.email)}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: byMember.client.id, scopes: SCOPES }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/clients", byMember.client.id), all);

  // A person revokes the owner's App for one agent: that agent is excepted, though the rule would grant it.
  const requested = await requestAgentAccess({ clientId: byOwner.client.id, serverSlug: f.server.slug, agentId: f.membersAgent.id, scopes: SCOPES });
  assert.equal(requested.status, "approved");
  assert.ok(await revokeGrant({ serverId: f.server.id, grantId: (await grantIdOf(f.membersAgent.id, byOwner.client.id))!, revokedByUserId: f.owner.id }));
  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/clients", byOwner.client.id),
    { allAgents: false, agentIds: [f.ownersAgent.id], exceptAgentIds: [f.membersAgent.id] });
});

async function grantIdOf(agentId: string, clientId: string): Promise<string | undefined> {
  const [grant] = await getDb().select({ id: oauthGrants.id }).from(oauthGrants)
    .where(and(eq(oauthGrants.agentId, agentId), eq(oauthGrants.clientId, clientId), isNull(oauthGrants.revokedAt)));
  return grant?.id;
}

test("an installed third-party App covers every agent but a blocked one; an App not installed here has none", async ({ app }) => {
  const f = await seed();
  const publisherOwner = await seedUser("access-publisher");
  const publisher = await createServer("Publisher", `access-pub-${f.suffix}`, publisherOwner.id);
  const published = async (key: string) => {
    const { client } = await createOAuthClient({
      serverId: publisher.id, createdByUserId: publisherOwner.id, appType: "third_party_global",
      clientId: `${key}-${f.suffix}`, name: `Published ${key}`, allowedScopes: SCOPES,
    });
    await getDb().update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true }).where(eq(oauthClients.id, client.id));
    return client;
  };
  const installed = await published("installed");
  const notInstalled = await published("listed");
  assert.ok(await installMarketplaceOAuthClient({
    serverId: f.server.id, clientId: installed.id, installedByUserId: f.owner.id, expected: await currentAppPermissions(installed.id),
  }));

  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/marketplace", installed.id),
    { allAgents: true, agentIds: [f.ownersAgent.id, f.membersAgent.id], exceptAgentIds: [] });
  assert.equal(await accessFrom(app.baseUrl, f, "/integrations/marketplace", notInstalled.id), null);

  const requested = await requestAgentAccess({ clientId: installed.id, serverSlug: f.server.slug, agentId: f.ownersAgent.id, scopes: SCOPES });
  assert.equal(requested.status, "approved");
  assert.ok(await revokeGrant({ serverId: f.server.id, grantId: (await grantIdOf(f.ownersAgent.id, installed.id))!, revokedByUserId: f.owner.id }));
  assert.deepEqual(await accessFrom(app.baseUrl, f, "/integrations/marketplace", installed.id, f.owner.email),
    { allAgents: false, agentIds: [f.membersAgent.id], exceptAgentIds: [f.ownersAgent.id] });
});
