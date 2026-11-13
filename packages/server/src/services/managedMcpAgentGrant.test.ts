import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { managedMcpCredentials, managedMcpServers, users } from "../db/schema";
import { createAgent } from "./agentService";
import { addMember, createServer } from "./serverService";
import { encryptManagedMcpHeaders } from "./managedMcpCredentialService";
import { getMcpAppView } from "./managedMcpAppService";
import { describeManagedMcpDefaultImpact } from "./managedMcpConnectionService";
import {
  applyManagedMcpAssignments,
  createManagedMcpServer,
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  isMcpConnectionAuthorized,
  listAgentManagedMcpCatalog,
  setManagedMcpAssignment,
  RAFT_APPS_MCP_SERVER_ID,
} from "./managedMcpService";

/** The snapshot's App tools; the fixed Raft Apps tools (on every snapshot) are asserted on their own. */
const appTools = <T extends { mcpServerId: string }>(snapshot: { tools: T[] }): T[] => snapshot.tools.filter((tool) => tool.mcpServerId !== RAFT_APPS_MCP_SERVER_ID);

const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  return user;
}

/**
 * An owner (manageExternalAuth), and a member who does NOT manage external auth. Each has created
 * one Agent. Apps get a one-tool catalogue so the runtime snapshot shows whether they are offered.
 */
async function seed() {
  const owner = await seedUser("owner");
  const member = await seedUser("member");
  const server = await createServer("Grant Test", `grant-${randomUUID()}`, owner.id);
  await addMember(server.id, member.id, "member");
  const ownersAgent = await createAgent(server.id, `owners-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: owner.id });
  const membersAgent = await createAgent(server.id, `members-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: member.id });
  const app = async (createdBy: string | null, name = `App ${randomUUID().slice(0, 6)}`) => {
    const created = await createManagedMcpServer({ serverId: server.id, userId: owner.id, name, endpointUrl: "https://open.example.test/mcp" });
    await getDb().update(managedMcpServers).set({
      createdByUserId: createdBy,
      toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
    }).where(eq(managedMcpServers.id, created.id));
    return created;
  };
  return { owner, member, server, ownersAgent, membersAgent, app };
}

async function grantOf(serverId: string, agentId: string, appId: string) {
  const row = (await listAgentManagedMcpCatalog(serverId, agentId)).servers.find((server) => server.id === appId);
  return { grant: row?.agentConnection?.grant, mode: row?.agentConnection?.mode };
}

async function offered(serverId: string, agentId: string, appId: string) {
  return appTools(await getManagedMcpRuntimeSnapshot(serverId, agentId)).some((tool) => tool.mcpServerId === appId);
}

function call(serverId: string, agentId: string, app: { id: string; configVersion: number }) {
  return executeManagedMcpCall(serverId, agentId, {
    mcpServerId: app.id, toolName: "search", arguments: {}, expectedConfigVersion: app.configVersion, expectedAssignmentVersion: 1,
  }, async () => ({ content: [], isError: false }));
}

test("⭐ an App made by someone who manages external auth is granted automatically to every Agent", async () => {
  const { owner, server, ownersAgent, membersAgent, app } = await seed();
  const byOwner = await app(owner.id);
  for (const agent of [ownersAgent, membersAgent]) {
    assert.deepEqual(await grantOf(server.id, agent.id, byOwner.id), { grant: "automatic", mode: "default" });
    assert.equal(await offered(server.id, agent.id, byOwner.id), true);
    await call(server.id, agent.id, byOwner);
  }
});

test("⭐ an App made by someone without manageExternalAuth is granted automatically only to their own Agents", async () => {
  const { member, server, ownersAgent, membersAgent, app } = await seed();
  const byMember = await app(member.id);

  // The creator's own Agent: automatic, as for an ordinary App.
  assert.deepEqual(await grantOf(server.id, membersAgent.id, byMember.id), { grant: "automatic", mode: "default" });
  assert.equal(await offered(server.id, membersAgent.id, byMember.id), true);
  await call(server.id, membersAgent.id, byMember);

  // Someone else's Agent: not granted. No tools, a call is refused as "off" (never a Connection card).
  assert.deepEqual(await grantOf(server.id, ownersAgent.id, byMember.id), { grant: "not_granted", mode: "off" });
  assert.equal(await offered(server.id, ownersAgent.id, byMember.id), false);
  await assert.rejects(call(server.id, ownersAgent.id, byMember), { code: "managed_mcp_app_off" });
  assert.equal(await isMcpConnectionAuthorized(getDb(), server.id, ownersAgent.id, byMember.id), false);

  // A person grants it: the Agent has it, and the source says a person granted it.
  await setManagedMcpAssignment({ serverId: server.id, userId: member.id, agentId: ownersAgent.id, mcpServerId: byMember.id, enabled: true });
  assert.deepEqual(await grantOf(server.id, ownersAgent.id, byMember.id), { grant: "person", mode: "default" });
  assert.equal(await offered(server.id, ownersAgent.id, byMember.id), true);
  await call(server.id, ownersAgent.id, byMember);
});

test("⭐ an App with no recorded creator stays granted to every Agent (legacy rows keep today's behaviour)", async () => {
  const { server, ownersAgent, membersAgent, app } = await seed();
  const legacy = await app(null);
  for (const agent of [ownersAgent, membersAgent]) {
    assert.deepEqual(await grantOf(server.id, agent.id, legacy.id), { grant: "automatic", mode: "default" });
    assert.equal(await offered(server.id, agent.id, legacy.id), true);
  }
});

test("⭐ revoking blocks the automatic grant for that Agent until someone grants it again", async () => {
  const { owner, server, ownersAgent, membersAgent, app } = await seed();
  const byOwner = await app(owner.id);
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: membersAgent.id, mcpServerId: byOwner.id, enabled: false });
  assert.deepEqual(await grantOf(server.id, membersAgent.id, byOwner.id), { grant: "revoked", mode: "off" });
  assert.equal(await offered(server.id, membersAgent.id, byOwner.id), false);
  await assert.rejects(call(server.id, membersAgent.id, byOwner), { code: "managed_mcp_app_off" });
  // Only that Agent.
  assert.equal(await offered(server.id, ownersAgent.id, byOwner.id), true);

  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: membersAgent.id, mcpServerId: byOwner.id, enabled: true });
  assert.deepEqual(await grantOf(server.id, membersAgent.id, byOwner.id), { grant: "automatic", mode: "default" });
  await call(server.id, membersAgent.id, byOwner);
});

test("choosing a Connection for an Agent that does not have the App does not grant it", async () => {
  const { owner, member, server, ownersAgent, app } = await seed();
  const byMember = await app(member.id);
  await getDb().update(managedMcpServers).set({ authMode: "headers" }).where(eq(managedMcpServers.id, byMember.id));
  const [connection] = await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: byMember.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Key", createdByUserId: owner.id,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "fixture" }), headerNames: ["X-Api-Key"],
  }).returning();
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, mcpServerId: byMember.id, connectionId: connection.id });
  assert.equal(await offered(server.id, ownersAgent.id, byMember.id), false);
  assert.equal((await grantOf(server.id, ownersAgent.id, byMember.id)).mode, "off");
  // The bulk path applies the same rule.
  await applyManagedMcpAssignments({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, assignments: [{ mcpServerId: byMember.id, connectionId: null }] });
  assert.equal(await offered(server.id, ownersAgent.id, byMember.id), false);
});

test("App summaries and default-change impact count Agents without the App as off", async () => {
  const { owner, member, server, membersAgent, app } = await seed();
  const byMember = await app(member.id);
  const view = await getMcpAppView(server.id, byMember.id, owner.id);
  // Two Agents: the member's own has it, the owner's does not.
  assert.deepEqual({ total: view.agentsSummary.total, usingDefault: view.agentsSummary.usingDefault, off: view.agentsSummary.off }, { total: 2, usingDefault: 1, off: 1 });
  const impact = await describeManagedMcpDefaultImpact({ serverId: server.id, mcpServerId: byMember.id, connectionId: null });
  assert.equal(impact.agentsFollowingDefault, 1);
  assert.equal(impact.offUnchanged, 1);
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: membersAgent.id, mcpServerId: byMember.id, enabled: false });
  assert.equal((await getMcpAppView(server.id, byMember.id, owner.id)).agentsSummary.off, 2);
});

test("⭐ switching an OAuth App back on for an Agent pinned to a signed-in Connection works while the default is not signed in", async () => {
  const { owner, server, ownersAgent, app } = await seed();
  const notion = await app(owner.id);
  await getDb().update(managedMcpServers).set({ authMode: "oauth", oauthStatus: "disconnected" }).where(eq(managedMcpServers.id, notion.id));
  // A server default that is not signed in, and a second Connection that is.
  await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: notion.id, isServerDefault: true, authKind: "oauth", authStatus: "needs_auth", name: "Default",
  });
  const [ready] = await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: notion.id, isServerDefault: false, authKind: "oauth", authStatus: "ready", name: "Mine", createdByUserId: owner.id,
    authorizedEndpointUrl: "https://open.example.test/mcp",
  }).returning();
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, mcpServerId: notion.id, connectionId: ready.id, enabled: false });

  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, mcpServerId: notion.id, enabled: true });
  assert.deepEqual(await grantOf(server.id, ownersAgent.id, notion.id), { grant: "automatic", mode: "pinned" });
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, mcpServerId: notion.id, enabled: false });
  await applyManagedMcpAssignments({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, assignments: [{ mcpServerId: notion.id, enabled: true }] });
  assert.equal((await grantOf(server.id, ownersAgent.id, notion.id)).mode, "pinned");

  // ⭐ Granting it to follow the unsigned default is accepted too (zero-connection decision): the
  // Agent is offered the App, and admission refuses the call with login_required, which raises the card.
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, mcpServerId: notion.id, enabled: false });
  await setManagedMcpAssignment({ serverId: server.id, userId: owner.id, agentId: ownersAgent.id, mcpServerId: notion.id, enabled: true, connectionId: null });
  assert.deepEqual(await grantOf(server.id, ownersAgent.id, notion.id), { grant: "automatic", mode: "default" });
  assert.equal(await offered(server.id, ownersAgent.id, notion.id), true, "the granted App is offered to the Agent");
  assert.equal(await isMcpConnectionAuthorized(getDb(), server.id, ownersAgent.id, notion.id), false, "but its calls are not admitted");
  await assert.rejects(
    executeManagedMcpCall(server.id, ownersAgent.id, {
      mcpServerId: notion.id, toolName: "search", arguments: {}, expectedConfigVersion: (await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, notion.id)))[0].configVersion, expectedAssignmentVersion: 1,
    }),
    { code: "managed_mcp_login_required" },
    "⭐ the first call asks for a Connection (the card), it is not answered by a refused grant",
  );
});
