import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { managedMcpAssignments, managedMcpCredentials, managedMcpServers, users } from "../db/schema";
import { createAgent } from "./agentService";
import { addMember, createServer } from "./serverService";
import { encryptManagedMcpHeaders } from "./managedMcpCredentialService";
import { getMcpAppView } from "./managedMcpAppService";
import {
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  isMcpConnectionAuthorized,
  listAgentManagedMcpCatalog,
  ManagedMcpServiceError,
  RAFT_APPS_MCP_SERVER_ID,
} from "./managedMcpService";

/** The snapshot's App tools; the fixed Raft Apps tools (on every snapshot) are asserted on their own. */
const appTools = <T extends { mcpServerId: string }>(snapshot: { tools: T[] }): T[] => snapshot.tools.filter((tool) => tool.mcpServerId !== RAFT_APPS_MCP_SERVER_ID);

// One admission decision (`admitFromRows`) answers an Agent's catalogue, the call path and the
// Connect-card check. For every state below, what the Agent's Apps tab shows must be what a call gets.

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
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label, passwordHash: "hash", emailVerified: true,
  }).returning();
  return user;
}

const ENDPOINT = "https://docs.example.test/mcp";

async function seed() {
  const owner = await seedUser("owner");
  const member = await seedUser("member");
  const server = await createServer("Agreement", `agree-${randomUUID()}`, owner.id);
  await addMember(server.id, member.id, "member");
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: owner.id });
  return { owner, member, server, agent };
}

/** An API-key App with one ready default Connection, created by `createdBy`. */
async function headersApp(serverId: string, createdBy: string | null, name: string) {
  const [app] = await getDb().insert(managedMcpServers).values({
    serverId, name, endpointUrl: ENDPOINT, authMode: "headers", sourceKind: "url", createdByUserId: createdBy,
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] as never,
  }).returning();
  const [connection] = await getDb().insert(managedMcpCredentials).values({
    serverId, mcpServerId: app.id, isServerDefault: true, authKind: "headers", authStatus: "ready", name: `${name} key`,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "fixture" }), headerNames: ["X-Api-Key"], authorizedEndpointUrl: ENDPOINT,
  }).returning();
  return { app, connection };
}

type Outcome = "ok" | ManagedMcpServiceError["code"];

async function callOutcome(serverId: string, agentId: string, app: { id: string; configVersion: number }): Promise<Outcome> {
  try {
    await executeManagedMcpCall(serverId, agentId, {
      mcpServerId: app.id, toolName: "search", arguments: {}, expectedConfigVersion: app.configVersion, expectedAssignmentVersion: 1,
    }, async () => ({ content: [], isError: false }));
    return "ok";
  } catch (error) {
    if (error instanceof ManagedMcpServiceError) return error.code;
    throw error;
  }
}

/** What the Agent's Apps tab says a call would get, from the catalogue alone. */
function viewOutcome(connection: { mode: string; status: string } | undefined): Outcome {
  assert.ok(connection, "the App is in the catalogue");
  if (connection.status === "disabled") return "managed_mcp_server_disabled";
  if (connection.mode === "off") return "managed_mcp_app_off";
  return connection.status === "ready" ? "ok" : "managed_mcp_login_required";
}

test("⭐ an Agent's catalogue and the call path agree in every admission state", async () => {
  const { owner, member, server, agent } = await seed();
  const db = getDb();
  // `pin`: how a pinned Agent reads on its Apps tab and in the App's Agents summary.
  const cases: Array<{ label: string; expect: Outcome; pin?: "pinned" | "noConnection"; arrange: () => Promise<{ id: string; configVersion: number }> }> = [
    { label: "granted automatically, ready default", expect: "ok", arrange: async () => (await headersApp(server.id, owner.id, "Auto")).app },
    { label: "legacy NULL creator", expect: "ok", arrange: async () => (await headersApp(server.id, null, "Legacy")).app },
    {
      label: "server-disabled App", expect: "managed_mcp_server_disabled",
      arrange: async () => {
        const { app } = await headersApp(server.id, owner.id, "Disabled");
        await db.update(managedMcpServers).set({ enabled: false }).where(eq(managedMcpServers.id, app.id));
        return app;
      },
    },
    {
      label: "revoked", expect: "managed_mcp_app_off",
      arrange: async () => {
        const { app } = await headersApp(server.id, owner.id, "Revoked");
        await db.insert(managedMcpAssignments).values({ serverId: server.id, agentId: agent.id, mcpServerId: app.id, enabled: false });
        return app;
      },
    },
    { label: "never granted (creator without manageExternalAuth)", expect: "managed_mcp_app_off", arrange: async () => (await headersApp(server.id, member.id, "Member's")).app },
    {
      label: "pinned to a ready Connection", pin: "pinned", expect: "ok",
      arrange: async () => {
        const { app } = await headersApp(server.id, owner.id, "Pinned");
        const [second] = await db.insert(managedMcpCredentials).values({
          serverId: server.id, mcpServerId: app.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Second", createdByUserId: owner.id,
          encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "second" }), headerNames: ["X-Api-Key"],
        }).returning();
        await db.insert(managedMcpAssignments).values({ serverId: server.id, agentId: agent.id, mcpServerId: app.id, connectionMode: "pinned", boundConnectionId: second.id });
        return app;
      },
    },
    {
      label: "pinned to another person's Connection (written before the ownership rule)", pin: "noConnection", expect: "managed_mcp_login_required",
      arrange: async () => {
        const { app } = await headersApp(server.id, owner.id, "Someone else's");
        const [members] = await db.insert(managedMcpCredentials).values({
          serverId: server.id, mcpServerId: app.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Member's", createdByUserId: member.id,
          encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "members" }), headerNames: ["X-Api-Key"], authorizedEndpointUrl: ENDPOINT,
        }).returning();
        await db.insert(managedMcpAssignments).values({ serverId: server.id, agentId: agent.id, mcpServerId: app.id, connectionMode: "pinned", boundConnectionId: members.id });
        return app;
      },
    },
    {
      label: "pinned to another App's Connection", pin: "noConnection", expect: "managed_mcp_login_required",
      arrange: async () => {
        const { app } = await headersApp(server.id, owner.id, "Cross pin");
        const { connection: foreign } = await headersApp(server.id, owner.id, "Other App");
        await db.insert(managedMcpAssignments).values({ serverId: server.id, agentId: agent.id, mcpServerId: app.id, connectionMode: "pinned", boundConnectionId: foreign.id });
        return app;
      },
    },
    {
      label: "default authorized for another endpoint", expect: "managed_mcp_login_required",
      arrange: async () => {
        const { app, connection } = await headersApp(server.id, owner.id, "Moved");
        await db.update(managedMcpCredentials).set({ authorizedEndpointUrl: "https://elsewhere.example.test/mcp" }).where(eq(managedMcpCredentials.id, connection.id));
        return app;
      },
    },
    {
      label: "default sign-in expired", expect: "managed_mcp_login_required",
      arrange: async () => {
        const { app, connection } = await headersApp(server.id, owner.id, "Expired");
        await db.update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, connection.id));
        return app;
      },
    },
    {
      label: "OAuth default ready but the App's mirror says not connected", expect: "managed_mcp_login_required",
      arrange: async () => {
        const { app } = await headersApp(server.id, owner.id, "Mirror");
        await db.update(managedMcpServers).set({ authMode: "oauth", oauthStatus: "disconnected" }).where(eq(managedMcpServers.id, app.id));
        await db.update(managedMcpCredentials).set({ authKind: "oauth", authorizedEndpointUrl: ENDPOINT }).where(eq(managedMcpCredentials.mcpServerId, app.id));
        return app;
      },
    },
  ];
  const arranged = [];
  for (const entry of cases) arranged.push({ ...entry, app: await entry.arrange() });
  const catalogue = await listAgentManagedMcpCatalog(server.id, agent.id);
  const snapshot = { tools: appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)) };
  for (const entry of arranged) {
    const view = catalogue.servers.find((row) => row.id === entry.app.id)?.agentConnection;
    const called = await callOutcome(server.id, agent.id, entry.app);
    assert.equal(called, entry.expect, `${entry.label}: the call`);
    assert.equal(viewOutcome(view), called, `${entry.label}: the Apps tab says what a call gets`);
    assert.equal(await isMcpConnectionAuthorized(db, server.id, agent.id, entry.app.id), called === "ok", `${entry.label}: the Connect-card check agrees`);
    if (entry.pin) {
      // ⭐ A pin the call refuses as not this Agent's or not this App's is "no connection selected" on both pages.
      assert.equal(view?.connectionMissing === true, entry.pin === "noConnection", `${entry.label}: the Apps tab row`);
      const { pinned, noConnection } = (await getMcpAppView(server.id, entry.app.id, owner.id)).agentsSummary;
      assert.deepEqual({ pinned, noConnection }, entry.pin === "pinned" ? { pinned: 1, noConnection: 0 } : { pinned: 0, noConnection: 1 }, `${entry.label}: the App's Agents summary`);
    }
    if (called === "managed_mcp_server_disabled" || called === "managed_mcp_app_off") {
      assert.ok(!snapshot.tools.some((tool) => tool.mcpServerId === entry.app.id), `${entry.label}: not offered to the runtime`);
    }
  }
});

test("⭐ a server-disabled App reads as disabled on the Agent's Apps tab, not ready", async () => {
  const { owner, server, agent } = await seed();
  const { app } = await headersApp(server.id, owner.id, "Docs");
  await getDb().update(managedMcpServers).set({ enabled: false }).where(eq(managedMcpServers.id, app.id));
  const row = (await listAgentManagedMcpCatalog(server.id, agent.id)).servers.find((item) => item.id === app.id);
  assert.equal(row?.agentConnection?.status, "disabled");
  assert.equal(row?.agentConnection?.grant, "automatic", "the grant is unchanged; the App itself is off");
});

test("the catalogue never reads Connection secrets, and still says whether the default has one", async () => {
  const { owner, server, agent } = await seed();
  const { app } = await headersApp(server.id, owner.id, "Docs");
  const row = (await listAgentManagedMcpCatalog(server.id, agent.id)).servers.find((item) => item.id === app.id);
  assert.equal(row?.hasCredentials, true);
  await getDb().update(managedMcpCredentials).set({ encryptedHeaders: null }).where(eq(managedMcpCredentials.mcpServerId, app.id));
  const cleared = (await listAgentManagedMcpCatalog(server.id, agent.id)).servers.find((item) => item.id === app.id);
  assert.equal(cleared?.hasCredentials, false);
});
