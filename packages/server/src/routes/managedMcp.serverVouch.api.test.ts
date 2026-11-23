import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { integrationAuditEvents, managedMcpServers, serverMembers, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createMcpApp, getMcpAppView } from "../services/managedMcpAppService";
import { createManagedMcpServer, listAgentManagedMcpCatalog, setManagedMcpAssignment } from "../services/managedMcpService";
import { describeManagedMcpDefaultImpact } from "../services/managedMcpConnectionService";
import { listServerAuditEvents } from "../services/integrationAuditService";

// An MCP App its Server vouched for (managed_mcp_servers.server_vouched_at): every agent there is
// granted it automatically, whatever its creator's role now. Who vouches (an owner or admin creating
// it in their own session, or PUT /api/mcp/apps/:appId/server-vouch), what does not (a member, a
// creation that is not a person's own act), and that every reader of the rule agrees.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

/** An owner, an admin and a member, each with an agent, oldest first. */
async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("mcp-vouch-owner");
  const admin = await seedUser("mcp-vouch-admin");
  const member = await seedUser("mcp-vouch-member");
  const server = await createServer("MCP Vouch", `mcp-vouch-${suffix}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, member.id, "member");
  const agent = (label: string, creatorId: string) =>
    createAgent(server.id, `${label}${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId });
  const ownersAgent = await agent("OwnersBot", owner.id);
  const adminsAgent = await agent("AdminsBot", admin.id);
  const membersAgent = await agent("MembersBot", member.id);
  return { suffix, owner, admin, member, server, ownersAgent, adminsAgent, membersAgent };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function headersFor(f: Seeded, email: string) {
  return { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" };
}

/** An App made through the service (no person's session): never vouched unless asked and allowed. */
function serviceApp(f: Seeded, userId: string, name: string, vouchAsCreator = false) {
  return createMcpApp({ serverId: f.server.id, userId, source: { kind: "template", templateKey: "linear" }, profile: { name }, vouchAsCreator });
}

async function vouchOf(appId: string) {
  const [row] = await getDb().select({ at: managedMcpServers.serverVouchedAt, by: managedMcpServers.serverVouchedByUserId })
    .from(managedMcpServers).where(eq(managedMcpServers.id, appId));
  return row;
}

async function vouchEvents(appId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.targetType, "managed_mcp_server"), eq(integrationAuditEvents.targetId, appId)))
    .orderBy(asc(integrationAuditEvents.createdAt))
    .then((rows) => rows.filter((row) => row.eventType.startsWith("app.server_")));
}

/** The App view a member reads (GET /api/mcp/apps/:appId). */
async function viewOf(baseUrl: string, f: Seeded, appId: string, email = f.member.email) {
  const res = await fetch(`${baseUrl}/api/mcp/apps/${appId}`, { headers: await headersFor(f, email) });
  assert.equal(res.status, 200);
  return await res.json() as Awaited<ReturnType<typeof getMcpAppView>>;
}

/** The Agent's own view (GET /api/mcp/agents/:agentId): how it holds the App. */
async function grantOf(baseUrl: string, f: Seeded, agentId: string, appId: string) {
  const res = await fetch(`${baseUrl}/api/mcp/agents/${agentId}`, { headers: await headersFor(f, f.owner.email) });
  assert.equal(res.status, 200);
  const catalog = await res.json() as Awaited<ReturnType<typeof listAgentManagedMcpCatalog>>;
  return catalog.servers.find((server) => server.id === appId)?.agentConnection?.grant;
}

async function vouchRequest(baseUrl: string, f: Seeded, appId: string, body: unknown, email: string) {
  return fetch(`${baseUrl}/api/mcp/apps/${appId}/server-vouch`, {
    method: "PUT", headers: await headersFor(f, email), body: JSON.stringify(body),
  });
}

test("creating: an owner or admin in their own session vouches (both create routes); a member's App and a service create do not", async ({ app }) => {
  const f = await seed();

  const res = await fetch(`${app.baseUrl}/api/mcp/apps`, {
    method: "POST", headers: await headersFor(f, f.admin.email),
    body: JSON.stringify({ source: { kind: "template", templateKey: "linear" }, profile: { name: `Admin made ${f.suffix}` } }),
  });
  assert.equal(res.status, 201);
  const created = await res.json() as { id: string; serverVouched: boolean; serverVouchedAt: string | null };
  assert.equal(created.serverVouched, true);
  assert.ok(created.serverVouchedAt);
  assert.equal((await vouchOf(created.id))?.by, f.admin.id);
  const [event] = await vouchEvents(created.id);
  assert.equal(event?.eventType, "app.server_vouched");
  assert.equal(event.eventCategory, "membership");
  assert.equal(event.actorType, "human");
  assert.equal(event.actorId, f.admin.id);
  assert.equal(event.clientId, null);
  assert.deepEqual(event.metadata, { appName: `Admin made ${f.suffix}`, reason: "created_by_admin" });
  assert.equal(await grantOf(app.baseUrl, f, f.membersAgent.id, created.id), "automatic", "another member's agent has it");

  // The legacy create route vouches the same way.
  const legacy = await fetch(`${app.baseUrl}/api/mcp/servers`, {
    method: "POST", headers: await headersFor(f, f.owner.email),
    body: JSON.stringify({ name: `Legacy ${f.suffix}`, endpointUrl: "https://legacy.example.test/mcp" }),
  });
  assert.equal(legacy.status, 201);
  const legacyId = (await legacy.json() as { id: string }).id;
  assert.equal((await vouchOf(legacyId))?.by, f.owner.id);
  assert.equal((await viewOf(app.baseUrl, f, legacyId)).serverVouched, true);

  // A member holds no manageExternalAuth: never vouched, even asked to.
  const byMember = await serviceApp(f, f.member.id, `Member made ${f.suffix}`, true);
  assert.equal(byMember.serverVouched, false);
  assert.equal((await vouchOf(byMember.id))?.at, null);
  assert.equal(await grantOf(app.baseUrl, f, f.ownersAgent.id, byMember.id), "not_granted");
  assert.equal(await grantOf(app.baseUrl, f, f.membersAgent.id, byMember.id), "automatic", "the creator's own agent");

  // Not a person's own act (no vouchAsCreator): an owner's App is not vouched, and reaches only the owner's agents.
  const notOwnAct = await createManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, name: `Not own ${f.suffix}`, endpointUrl: "https://open.example.test/mcp" });
  assert.equal((await vouchOf(notOwnAct.id))?.at, null);
  assert.equal((await vouchEvents(notOwnAct.id)).length, 0);
  assert.equal(await grantOf(app.baseUrl, f, f.adminsAgent.id, notOwnAct.id), "not_granted");
  assert.equal(await grantOf(app.baseUrl, f, f.ownersAgent.id, notOwnAct.id), "automatic");
});

test("the rule: vouched reaches every agent whatever the creator's role now; not vouched, only the creator's; a revoke still excepts; every reader agrees", async ({ app }) => {
  const f = await seed();
  const vouched = await serviceApp(f, f.admin.id, `Vouched ${f.suffix}`, true);
  const plain = await serviceApp(f, f.admin.id, `Plain ${f.suffix}`);
  const all = [f.ownersAgent.id, f.adminsAgent.id, f.membersAgent.id];

  assert.deepEqual((await viewOf(app.baseUrl, f, vouched.id)).agentAccess, { allAgents: true, agentIds: all, exceptAgentIds: [] });
  const plainView = await viewOf(app.baseUrl, f, plain.id);
  assert.equal(plainView.serverVouched, false);
  assert.deepEqual(plainView.agentAccess,
    { allAgents: false, agentIds: [f.adminsAgent.id], exceptAgentIds: [f.ownersAgent.id, f.membersAgent.id] },
    "an admin's App nobody vouched for: only the admin's own agents, though the admin has the authority");
  assert.equal(plainView.agentsSummary.off, 2);
  assert.equal(await grantOf(app.baseUrl, f, f.membersAgent.id, plain.id), "not_granted");
  assert.equal(await grantOf(app.baseUrl, f, f.adminsAgent.id, plain.id), "automatic");

  // The creator demoted, then gone: the vouch holds, in every reader.
  const membership = and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id));
  await getDb().update(serverMembers).set({ role: "member" }).where(membership);
  assert.equal(await grantOf(app.baseUrl, f, f.ownersAgent.id, vouched.id), "automatic");
  await getDb().delete(serverMembers).where(membership);
  const after = await viewOf(app.baseUrl, f, vouched.id);
  assert.deepEqual(after.agentAccess, { allAgents: true, agentIds: all, exceptAgentIds: [] });
  assert.equal(after.agentsSummary.off, 0);
  assert.equal(after.agentsSummary.usingDefault, 3);
  assert.equal((await describeManagedMcpDefaultImpact({ serverId: f.server.id, mcpServerId: vouched.id, connectionId: null })).offUnchanged, 0);
  for (const agentId of all) assert.equal(await grantOf(app.baseUrl, f, agentId, vouched.id), "automatic");

  // A person's revoke excepts that agent from the vouch.
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.owner.id, agentId: f.ownersAgent.id, mcpServerId: vouched.id, enabled: false });
  const revoked = await viewOf(app.baseUrl, f, vouched.id);
  assert.deepEqual(revoked.agentAccess, { allAgents: false, agentIds: [f.adminsAgent.id, f.membersAgent.id], exceptAgentIds: [f.ownersAgent.id] });
  assert.equal(revoked.agentsSummary.off, 1);
  assert.equal(await grantOf(app.baseUrl, f, f.ownersAgent.id, vouched.id), "revoked");
  assert.equal((await describeManagedMcpDefaultImpact({ serverId: f.server.id, mcpServerId: vouched.id, connectionId: null })).offUnchanged, 1);
});

test("PUT server-vouch: owners and admins in their own session, idempotent and audited; nobody else, no other Server's App", async ({ app }) => {
  const f = await seed();
  const target = await serviceApp(f, f.member.id, `Target ${f.suffix}`);
  const id = target.id;

  const memberTry = await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.member.email);
  assert.equal(memberTry.status, 403);
  assert.equal((await memberTry.json() as { code: string }).code, "managed_mcp_forbidden");

  // An agent's own credential (its creator an owner) is refused before the route: never delegable.
  const { apiKey } = await mintAgentCredential({ agentId: f.ownersAgent.id, scopes: ["read", "send"], name: "mcp-vouch-test", issuedVia: "computer", createdByUserId: null });
  const agentTry = await fetch(`${app.baseUrl}/api/mcp/apps/${id}/server-vouch`, {
    method: "PUT", headers: { Authorization: `Bearer ${apiKey}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ vouched: true }),
  });
  assert.ok(agentTry.status === 401 || agentTry.status === 403, `agent credential refused (${agentTry.status})`);

  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: "yes" }, f.admin.email)).status, 400);
  assert.equal((await vouchRequest(app.baseUrl, f, id, {}, f.admin.email)).status, 400);
  assert.equal((await vouchOf(id))?.at, null, "nothing written by a refusal");

  const on = await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.admin.email);
  assert.equal(on.status, 200);
  const body = await on.json() as { id: string; serverVouched: boolean; serverVouchedAt: string | null };
  assert.equal(body.id, id);
  assert.equal(body.serverVouched, true);
  assert.ok(body.serverVouchedAt);
  assert.equal((await vouchOf(id))?.by, f.admin.id);
  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.owner.email)).status, 200, "again: no change");
  assert.equal((await vouchOf(id))?.by, f.admin.id, "the first voucher stays");
  assert.equal(await grantOf(app.baseUrl, f, f.ownersAgent.id, id), "automatic");
  // The owner's agent gets an assignment row (a Connection choice): it keeps the App after the vouch ends.
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.owner.id, agentId: f.ownersAgent.id, mcpServerId: id, connectionId: null });

  const off = await vouchRequest(app.baseUrl, f, id, { vouched: false }, f.owner.email);
  assert.equal(off.status, 200);
  assert.equal((await off.json() as { serverVouched: boolean }).serverVouched, false);
  assert.deepEqual(await vouchOf(id), { at: null, by: null });
  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: false }, f.owner.email)).status, 200);
  // Future automatic grants stop; the assignment already written stays (now a person's grant).
  assert.equal(await grantOf(app.baseUrl, f, f.adminsAgent.id, id), "not_granted");
  assert.equal(await grantOf(app.baseUrl, f, f.ownersAgent.id, id), "person");
  assert.deepEqual((await viewOf(app.baseUrl, f, id)).agentAccess,
    { allAgents: false, agentIds: [f.ownersAgent.id, f.membersAgent.id], exceptAgentIds: [f.adminsAgent.id] });

  const events = await vouchEvents(id);
  assert.deepEqual(events.map((event) => [event.eventType, event.actorId, (event.metadata as { reason?: string }).reason]), [
    ["app.server_vouched", f.admin.id, "vouched"],
    ["app.server_unvouched", f.owner.id, "unvouched"],
  ]);
  // The server's own audit page shows them: a decision its admins make about their agents' access.
  const page = await listServerAuditEvents(f.server.id, { limit: 200 });
  const onPage = page.events.filter((event) => event.eventType.startsWith("app.server_") && event.targetId === id).map((event) => event.eventType);
  assert.deepEqual([...onPage].sort(), ["app.server_unvouched", "app.server_vouched"]);

  // Another Server's App, and an id that names no App: not found here.
  const otherOwner = await seedUser("mcp-vouch-other");
  const other = await createServer("MCP Vouch Other", `mcp-vouch-other-${f.suffix}`, otherOwner.id);
  const elsewhere = await createManagedMcpServer({ serverId: other.id, userId: otherOwner.id, name: "Elsewhere", endpointUrl: "https://open.example.test/mcp" });
  assert.equal((await vouchRequest(app.baseUrl, f, elsewhere.id, { vouched: true }, f.owner.email)).status, 404);
  assert.equal((await vouchOf(elsewhere.id))?.at, null);
  assert.equal((await vouchRequest(app.baseUrl, f, randomUUID(), { vouched: true }, f.owner.email)).status, 404);
  assert.equal((await vouchRequest(app.baseUrl, f, "not-a-uuid", { vouched: true }, f.owner.email)).status, 404);
});
