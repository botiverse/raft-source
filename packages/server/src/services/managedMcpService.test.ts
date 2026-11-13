import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ManagedMcpCallRequest } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { integrationAuditEvents, managedMcpAssignments, managedMcpCredentials, managedMcpServers, users } from "../db/schema";
import { createAgent } from "./agentService";
import { createServer } from "./serverService";
import { getMcpAppView } from "./managedMcpAppService";
import { decryptManagedMcpHeaders, encryptManagedMcpHeaders } from "./managedMcpCredentialService";
import {
  applyManagedMcpAssignments,
  createManagedMcpServer,
  deleteManagedMcpServer,
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  listAgentManagedMcpCatalog,
  listManagedMcpServerCatalog,
  ManagedMcpServiceError,
  setManagedMcpAssignment,
  testManagedMcpConfiguration,
  updateManagedMcpServer,
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

async function seed() {
  const [user] = await getDb().insert(users).values({
    email: `mcp-${randomUUID()}@slock.test`,
    name: `mcp-${randomUUID().slice(0, 8)}`,
    displayName: "MCP Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP Test", `mcp-${randomUUID()}`, user.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: user.id });
  return { user, server, agent };
}

test("managed MCP catalog reads are secret-free and preserve omitted credentials", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Private MCP",
    endpointUrl: "https://example.com/mcp",
    headers: { Authorization: "Bearer top-secret" },
  });
  assert.equal(created.hasCredentials, true);
  assert.deepEqual(created.credentialHeaderNames, ["Authorization"]);
  assert.equal(JSON.stringify(created).includes("top-secret"), false);

  await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    description: "Updated without replacing credentials",
  });
  const catalog = await listAgentManagedMcpCatalog(server.id, agent.id);
  assert.equal(catalog.servers.length, 1);
  assert.equal(catalog.servers[0].hasCredentials, true);
  assert.deepEqual(catalog.recommendations.find((recommendation) => recommendation.id === "linear"), {
    id: "linear",
    name: "Linear",
    description: "Find, create, and update Linear issues, projects, and comments.",
    provider: "linear",
    authMode: "oauth",
    endpointUrl: "https://mcp.linear.app/mcp",
    credentialHeaderNames: [],
  });
  assert.equal(catalog.recommendations.find((recommendation) => recommendation.id === "notion")?.endpointUrl, "https://mcp.notion.com/mcp");
  assert.equal(JSON.stringify(catalog).includes("top-secret"), false);
});

test("managed MCP credential patches preserve, replace, add, and remove individual headers", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Patchable MCP",
    endpointUrl: "https://example.com/mcp",
    headers: { Authorization: "Bearer old", "X-Retained": "keep" },
  });

  const updated = await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    credentialPatch: {
      upsertHeaders: { Authorization: "Bearer new", "X-New": "fresh" },
      removeHeaderNames: ["X-Retained"],
    },
  });
  assert.deepEqual(updated.credentialHeaderNames, ["Authorization", "X-New"]);
  assert.equal(JSON.stringify(updated).includes("Bearer new"), false);

  const [credential] = await getDb().select().from(managedMcpCredentials).where(eq(
    managedMcpCredentials.mcpServerId,
    created.id,
  ));
  assert.deepEqual(decryptManagedMcpHeaders(credential.encryptedHeaders), {
    Authorization: "Bearer new",
    "X-New": "fresh",
  });
});

test("managed MCP configuration tests reject cross-origin stored header reuse before provider I/O", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Origin-bound test",
    endpointUrl: "https://example.com/mcp",
    headers: { Authorization: "Bearer origin-secret" },
  });

  await assert.rejects(
    () => testManagedMcpConfiguration({
      serverId: server.id,
      mcpServerId: created.id,
      endpointUrl: "https://attacker.example/mcp",
      authMode: "headers",
      credentialPatch: { upsertHeaders: {}, removeHeaderNames: [] },
    }),
    (error: unknown) => error instanceof ManagedMcpServiceError
      && error.code === "managed_mcp_auth_invalid"
      && /cannot be reused across endpoint origins/u.test(error.message),
  );
});

test("managed MCP endpoint origin changes cannot retain stored header credentials", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Origin-bound update",
    endpointUrl: "https://example.com/mcp",
    headers: { Authorization: "Bearer old-origin" },
  });
  const [beforeCredential] = await getDb().select().from(managedMcpCredentials).where(eq(
    managedMcpCredentials.mcpServerId,
    created.id,
  ));

  await assert.rejects(
    () => updateManagedMcpServer({
      serverId: server.id,
      userId: user.id,
      mcpServerId: created.id,
      endpointUrl: "https://api.example.net/mcp",
      credentialPatch: { upsertHeaders: {}, removeHeaderNames: [] },
    }),
    (error: unknown) => error instanceof ManagedMcpServiceError
      && error.code === "managed_mcp_auth_invalid",
  );

  const [unchangedServer] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, created.id));
  const [unchangedCredential] = await getDb().select().from(managedMcpCredentials).where(eq(
    managedMcpCredentials.mcpServerId,
    created.id,
  ));
  assert.equal(unchangedServer.endpointUrl, "https://example.com/mcp");
  assert.equal(unchangedCredential.encryptedHeaders, beforeCredential.encryptedHeaders);
  assert.deepEqual(decryptManagedMcpHeaders(unchangedCredential.encryptedHeaders), {
    Authorization: "Bearer old-origin",
  });

  const replaced = await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    endpointUrl: "https://api.example.net/mcp",
    credentialPatch: {
      upsertHeaders: { Authorization: "Bearer new-origin" },
      removeHeaderNames: [],
    },
  });
  assert.equal(replaced.endpointUrl, "https://api.example.net/mcp");
  const [replacedCredential] = await getDb().select().from(managedMcpCredentials).where(eq(
    managedMcpCredentials.mcpServerId,
    created.id,
  ));
  assert.deepEqual(decryptManagedMcpHeaders(replacedCredential.encryptedHeaders), {
    Authorization: "Bearer new-origin",
  });
});

test("managed MCP runtime snapshots automatically expose enabled Server tools without an Agent assignment", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Docs",
    endpointUrl: "https://example.com/mcp",
  });
  await getDb().update(managedMcpServers).set({
    toolCatalog: [{
      name: "search",
      description: "Search docs",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    }],
    catalogVersion: 1,
  }).where(eq(managedMcpServers.id, created.id));

  const raw = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.equal(raw.catalogVersion, 1);
  const snapshot = { tools: appTools(raw) };
  assert.equal(snapshot.tools.length, 1);
  assert.equal(snapshot.tools[0].toolName, "search");
  assert.equal(snapshot.tools[0].configVersion, created.configVersion);
  assert.equal(snapshot.tools[0].assignmentVersion, 1);
  assert.match(snapshot.tools[0].runtimeName, /^mcp_/u);
});

test("managed MCP calls accept pre-rollout assignment versions and persist Agent usage before provider I/O", async () => {
  const { user, server, agent } = await seed();
  const otherAgent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, {
    creatorType: "user",
    creatorId: user.id,
  });
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Usage docs",
    endpointUrl: "https://example.com/mcp",
  });
  await getDb().update(managedMcpServers).set({
    toolCatalog: [
      { name: "search", inputSchema: { type: "object" } },
      { name: "fetch", inputSchema: { type: "object" } },
    ],
    catalogVersion: 1,
  }).where(eq(managedMcpServers.id, created.id));

  const observedUsageCounts: number[] = [];
  const callTool = async () => {
    const catalog = await listAgentManagedMcpCatalog(server.id, agent.id);
    observedUsageCounts.push(catalog.servers[0]?.usage?.invocationCount ?? 0);
    return { content: [{ type: "text" as const, text: "ok" }], isError: false };
  };
  await executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: created.id,
    toolName: "search",
    arguments: {},
    expectedConfigVersion: created.configVersion,
    expectedAssignmentVersion: 42,
  }, callTool);
  await executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: created.id,
    toolName: "fetch",
    arguments: {},
    expectedConfigVersion: created.configVersion,
    expectedAssignmentVersion: 1,
  }, callTool);
  await executeManagedMcpCall(server.id, otherAgent.id, {
    mcpServerId: created.id,
    toolName: "search",
    arguments: {},
    expectedConfigVersion: created.configVersion,
    expectedAssignmentVersion: 1,
  }, async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }));

  assert.deepEqual(observedUsageCounts, [1, 2]);
  const catalog = await listAgentManagedMcpCatalog(server.id, agent.id);
  const otherCatalog = await listAgentManagedMcpCatalog(server.id, otherAgent.id);
  assert.deepEqual(catalog.servers[0].usage && {
    invocationCount: catalog.servers[0].usage.invocationCount,
    lastToolName: catalog.servers[0].usage.lastToolName,
  }, {
    invocationCount: 2,
    lastToolName: "fetch",
  });
  assert.deepEqual(otherCatalog.servers[0].usage && {
    invocationCount: otherCatalog.servers[0].usage.invocationCount,
    lastToolName: otherCatalog.servers[0].usage.lastToolName,
  }, {
    invocationCount: 1,
    lastToolName: "search",
  });
  assert.match(catalog.servers[0].usage?.lastInvokedAt ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  const auditRows = await getDb().select({
    actorId: integrationAuditEvents.actorId,
    metadata: integrationAuditEvents.metadata,
  })
    .from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.eventType, "managed_mcp.tool_invocation_admitted"));
  assert.deepEqual(auditRows.filter((row) => row.actorId === agent.id).map((row) => row.metadata), [
    { toolName: "search" },
    { toolName: "fetch" },
  ]);
  assert.deepEqual(auditRows.filter((row) => row.actorId === otherAgent.id).map((row) => row.metadata), [
    { toolName: "search" },
  ]);
});

test("managed MCP call admission rejects unavailable and cross-Server tools before provider I/O or usage audit", async () => {
  const { user, server, agent } = await seed();
  const toolCatalog = [{ name: "search", inputSchema: { type: "object" as const } }];
  const ready = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Ready docs",
    endpointUrl: "https://ready.example.com/mcp",
  });
  const disabled = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Disabled docs",
    endpointUrl: "https://disabled.example.com/mcp",
    enabled: false,
  });
  const disconnected = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Disconnected Notion",
    provider: "notion",
    authMode: "oauth",
    endpointUrl: "https://mcp.notion.com/mcp",
  });
  const otherServer = await createServer("Other MCP Test", `other-mcp-${randomUUID()}`, user.id);
  const foreign = await createManagedMcpServer({
    serverId: otherServer.id,
    userId: user.id,
    name: "Foreign docs",
    endpointUrl: "https://foreign.example.com/mcp",
  });
  for (const mcpServerId of [ready.id, disabled.id, disconnected.id, foreign.id]) {
    await getDb().update(managedMcpServers).set({ toolCatalog, catalogVersion: 1 })
      .where(eq(managedMcpServers.id, mcpServerId));
  }

  let providerIoCount = 0;
  const callTool = async () => {
    providerIoCount += 1;
    return { content: [{ type: "text" as const, text: "unexpected" }], isError: false };
  };
  const callOAuthTool = async () => {
    providerIoCount += 1;
    return { content: [{ type: "text" as const, text: "unexpected" }], isError: false };
  };
  const request = (mcpServerId: string, expectedConfigVersion: number): ManagedMcpCallRequest => ({
    mcpServerId,
    toolName: "search",
    arguments: {},
    expectedConfigVersion,
    expectedAssignmentVersion: 1,
  });
  const assertRejectedBeforeProvider = async (
    mcpServerId: string,
    expectedConfigVersion: number,
    expectedCode: ManagedMcpServiceError["code"],
  ) => {
    await assert.rejects(
      () => executeManagedMcpCall(
        server.id,
        agent.id,
        request(mcpServerId, expectedConfigVersion),
        callTool,
        callOAuthTool,
      ),
      (error: unknown) => error instanceof ManagedMcpServiceError && error.code === expectedCode,
    );
    assert.equal(providerIoCount, 0);
  };

  await assertRejectedBeforeProvider(disabled.id, disabled.configVersion, "managed_mcp_server_disabled");
  // A missing or expired sign-in is a Connection problem, judged per Agent: login_required (card).
  await assertRejectedBeforeProvider(disconnected.id, disconnected.configVersion, "managed_mcp_login_required");
  await assertRejectedBeforeProvider(ready.id, ready.configVersion + 1, "managed_mcp_config_stale");
  await assertRejectedBeforeProvider(foreign.id, foreign.configVersion, "managed_mcp_server_not_found");

  const usageRows = await getDb().select({ id: integrationAuditEvents.id })
    .from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.eventType, "managed_mcp.tool_invocation_admitted"));
  assert.deepEqual(usageRows, []);
});

test("deleting an MCP server revokes fresh discovery and stale runtime calls", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Revocable docs",
    endpointUrl: "https://example.com/mcp",
  });
  await getDb().update(managedMcpServers).set({
    toolCatalog: [{
      name: "search",
      description: "Search docs",
      inputSchema: { type: "object" },
    }],
    catalogVersion: 1,
  }).where(eq(managedMcpServers.id, created.id));
  const staleSnapshot = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.equal(appTools(staleSnapshot).length, 1);
  const staleTool = staleSnapshot.tools[0]!;

  await deleteManagedMcpServer(server.id, created.id);

  const freshSnapshot = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.deepEqual(appTools(freshSnapshot), []);
  await assert.rejects(
    () => executeManagedMcpCall(server.id, agent.id, {
      mcpServerId: staleTool.mcpServerId,
      toolName: staleTool.toolName,
      arguments: {},
      expectedConfigVersion: staleTool.configVersion,
      expectedAssignmentVersion: staleTool.assignmentVersion,
    }),
    (error: unknown) => error instanceof ManagedMcpServiceError
      && error.code === "managed_mcp_server_not_found",
  );
});

test("managed MCP assignments reject tools outside the current catalog", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Empty",
    endpointUrl: "https://example.com/mcp",
  });
  await assert.rejects(() => setManagedMcpAssignment({
    serverId: server.id,
    userId: user.id,
    agentId: agent.id,
    mcpServerId: created.id,
    enabled: true,
    allowedTools: ["not-present"],
  }), /outside the current catalog/u);
});

test("an OAuth App the agent has but cannot use yet is also listed as unavailable (reconnect_required), unless the agent's grant is off", async () => {
  const { user, server, agent } = await seed();
  const notion = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Notion",
    provider: "notion",
    authMode: "oauth",
    endpointUrl: "https://mcp.notion.com/mcp",
  });
  const toolCatalog = [{ name: "search", inputSchema: { type: "object" as const, properties: {} } }];
  await getDb().update(managedMcpServers).set({ toolCatalog, catalogVersion: 1, oauthStatus: "error" }).where(eq(managedMcpServers.id, notion.id));

  const broken = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  // The MCP App model keeps its tools offered (a call raises the Connect card); the list apart is
  // what lets an agent that reads it (raft-sdk) say it needs reconnecting.
  assert.deepEqual(appTools(broken).map((t) => t.toolName), ["search"]);
  assert.deepEqual(broken.unavailable, [{ mcpServerId: notion.id, serverName: "Notion", status: "reconnect_required" }]);

  // Signed in: a ready server-default Connection and the App's OAuth mirror connected.
  await getDb().update(managedMcpCredentials).set({ authStatus: "ready", authorizedEndpointUrl: "https://mcp.notion.com/mcp" }).where(eq(managedMcpCredentials.mcpServerId, notion.id));
  const [defaultConnection] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, notion.id));
  if (!defaultConnection) {
    await getDb().insert(managedMcpCredentials).values({
      serverId: server.id, mcpServerId: notion.id, isServerDefault: true, authKind: "oauth", authStatus: "ready", name: "Notion",
      authorizedEndpointUrl: "https://mcp.notion.com/mcp",
    });
  }
  await getDb().update(managedMcpServers).set({ oauthStatus: "connected" }).where(eq(managedMcpServers.id, notion.id));
  const connected = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.deepEqual(appTools(connected).map((t) => t.toolName), ["search"]);
  assert.equal("unavailable" in connected, false, "absent when nothing is unavailable");

  // An agent whose grant of this App is off is not told about it.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: notion.id, enabled: false, allowedTools: null });
  await getDb().update(managedMcpServers).set({ oauthStatus: "disconnected" }).where(eq(managedMcpServers.id, notion.id));
  assert.equal("unavailable" in await getManagedMcpRuntimeSnapshot(server.id, agent.id), false);
});

test("⭐ an OAuth App with no signed-in Connection can be granted; its first call is refused login_required", async () => {
  const { user, server, agent } = await seed();
  const notion = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Notion",
    provider: "notion",
    authMode: "oauth",
    endpointUrl: "https://mcp.notion.com/mcp",
  });

  // Not signed in, so its tools are unknown: none of its own; the Raft Apps tools reach it (and raise the card).
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)), []);
  // Granting (single and batch) no longer waits for a Connection: admission decides at call time.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: notion.id, enabled: false, allowedTools: null });
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: notion.id, enabled: true, allowedTools: null });
  await applyManagedMcpAssignments({
    serverId: server.id,
    userId: user.id,
    agentId: agent.id,
    assignments: [{ mcpServerId: notion.id, enabled: true, allowedTools: null }],
  });
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)), []);
  const [row] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, notion.id));
  await assert.rejects(executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: notion.id, toolName: "list_tools", arguments: {}, expectedConfigVersion: row.configVersion, expectedAssignmentVersion: 1,
  }), { code: "managed_mcp_login_required" });
});

test("managed MCP assignment batches validate before committing and then apply together", async () => {
  const { user, server, agent } = await seed();
  const first = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "First",
    endpointUrl: "https://first.example.com/mcp",
  });
  const second = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Second",
    endpointUrl: "https://second.example.com/mcp",
  });

  await assert.rejects(() => applyManagedMcpAssignments({
    serverId: server.id,
    userId: user.id,
    agentId: agent.id,
    assignments: [
      { mcpServerId: first.id, enabled: true, allowedTools: null },
      { mcpServerId: second.id, enabled: true, allowedTools: ["missing"] },
    ],
  }), /outside the current catalog/);
  let catalog = await listAgentManagedMcpCatalog(server.id, agent.id);
  assert.equal(catalog.servers.find((entry) => entry.id === first.id)?.assignment, null);

  catalog = await applyManagedMcpAssignments({
    serverId: server.id,
    userId: user.id,
    agentId: agent.id,
    assignments: [
      { mcpServerId: first.id, enabled: true, allowedTools: null },
      { mcpServerId: second.id, enabled: false, allowedTools: null },
    ],
  });
  assert.equal(catalog.servers.find((entry) => entry.id === first.id)?.assignment?.enabled, true);
  assert.equal(catalog.servers.find((entry) => entry.id === second.id)?.assignment?.enabled, false);
});

test("runtime-affecting server updates invalidate the discovered catalog", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Mutable",
    endpointUrl: "https://example.com/mcp",
  });
  await getDb().update(managedMcpServers).set({
    toolCatalog: [{ name: "old_tool", inputSchema: { type: "object" } }],
    catalogVersion: 1,
    lastCheckedAt: new Date(),
  }).where(eq(managedMcpServers.id, created.id));

  const renamed = await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    description: "Metadata-only update",
  });
  assert.equal(renamed.toolCatalog.length, 1);
  assert.equal(renamed.catalogVersion, 1);
  assert.equal(renamed.configVersion, created.configVersion);

  const reconfigured = await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    headers: {},
  });
  assert.deepEqual(reconfigured.toolCatalog, []);
  assert.equal(reconfigured.catalogVersion, 2);
  assert.equal(reconfigured.lastCheckedAt, null);
});

test("unchanged masked credential patches do not invalidate runtime configuration", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Stable credentials",
    endpointUrl: "https://example.com/mcp",
    headers: { Authorization: "Bearer stable" },
  });
  await getDb().update(managedMcpServers).set({
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
    catalogVersion: 1,
  }).where(eq(managedMcpServers.id, created.id));

  const unchanged = await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    description: "Metadata only",
    credentialPatch: { upsertHeaders: {}, removeHeaderNames: [] },
  });
  assert.equal(unchanged.configVersion, created.configVersion);
  assert.equal(unchanged.catalogVersion, 1);
  assert.equal(unchanged.toolCatalog.length, 1);
});

test("credential preparation fails before create or update can mutate server state", async () => {
  const { user, server } = await seed();
  delete process.env.SLOCK_MCP_CREDENTIAL_KEY;

  await assert.rejects(() => createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Must not persist",
    endpointUrl: "https://example.com/mcp",
    headers: { Authorization: "Bearer secret" },
  }), /must be configured/u);
  assert.equal((await getDb().select().from(managedMcpServers)).length, 0);

  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Stable",
    endpointUrl: "https://example.com/mcp",
  });
  delete process.env.SLOCK_MCP_CREDENTIAL_KEY;

  await assert.rejects(() => updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: created.id,
    description: "Must not apply",
    headers: { Authorization: "Bearer replacement" },
  }), /must be configured/u);
  const [unchanged] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, created.id));
  assert.equal(unchanged.description, null);
  assert.equal(unchanged.configVersion, created.configVersion);
});

test("explicit assignment limits discovery and execution before provider I/O", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({ serverId: server.id, userId: user.id, name: "Audit", endpointUrl: "https://example.com/mcp" });
  await getDb().update(managedMcpServers).set({ toolCatalog: [
    { name: "read", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } },
  ] }).where(eq(managedMcpServers.id, created.id));
  let calls = 0;
  const call = (toolName: string) => executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: created.id, toolName, arguments: {}, expectedConfigVersion: created.configVersion, expectedAssignmentVersion: 1,
  }, async () => { calls++; return { content: [], isError: false }; });
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: ["read"] });
  await assert.rejects(call("write"), { code: "managed_mcp_tool_not_allowed" });
  assert.equal(calls, 0);
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)).map(t => t.toolName), ["read"]);

  await call("read");
  assert.equal(calls, 1);
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: false, allowedTools: ["read"] });
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)), []);
  // Switched off for this Agent: its own answer, not a tool restriction and not a Connection problem.
  await assert.rejects(call("read"), { code: "managed_mcp_app_off" });
  assert.equal(calls, 1);

  // An empty allowlist denies every tool; null restores the catalog default.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: [] });
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)), []);
  await assert.rejects(call("read"), { code: "managed_mcp_tool_not_allowed" });
  assert.equal(calls, 1);
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: null });
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)).map(t => t.toolName), ["read", "write"]);
  await call("write");
  assert.equal(calls, 2);
});

/**
 * 0342 ADDS three narrower indexes alongside the existing `UNIQUE (mcp_server_id)`; it does NOT
 * replace it. Until the contract migration drops that index, at most one Connection per MCP remains
 * true for everyone -- which is what keeps the rolling window safe. Hand-created servers write
 * UNOWNED credentials, and the partial `_unowned` index is what will keep their cardinality at
 * exactly one AFTER the contract phase. This is the regression guard for that, because "we loosened
 * a unique index" is the kind of change whose damage shows up as silent duplicate rows, not errors.
 *
 * It is also what keeps their `ON CONFLICT (mcp_server_id) WHERE owner_user_id IS NULL` inferrable:
 * drop the predicate from the index or from the statement and they stop matching each other.
 */
test("0342 keeps hand-created servers at exactly one credential across repeated connection edits", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: `cardinality-${randomUUID().slice(0, 8)}`,
    provider: "custom",
    authMode: "headers",
    endpointUrl: "https://cardinality.example.test/mcp",
    headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });

  const countCredentials = async () => (await getDb()
    .select({ id: managedMcpCredentials.id })
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, created.id))).length;
  assert.equal(await countCredentials(), 1);

  // Each of these changes the connection, so each takes the upsert path.
  for (const endpointUrl of [
    "https://cardinality-2.example.test/mcp",
    "https://cardinality-3.example.test/mcp",
    "https://cardinality-4.example.test/mcp",
  ]) {
    await updateManagedMcpServer({
      serverId: server.id,
      userId: user.id,
      mcpServerId: created.id,
      endpointUrl,
      headers: { "X-Api-Key": "fixture-value-not-a-credential" },
    });
    assert.equal(await countCredentials(), 1, `${endpointUrl} must update the credential, not add one`);
  }

  // The App's own credential is its server-default Connection, written explicitly.
  const [row] = await getDb().select().from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, created.id));
  assert.equal(row.isServerDefault, true, "the App's credential is its server-default Connection");
  assert.equal(row.authKind, "headers");
});


/**
 * One admission rule for every MCP App (Connections + per-Agent mode). These pin the behaviours a
 * reviewer asked for explicitly: no fallback for a dead pin, auth-less Apps need nothing, a missing
 * default is a Connection problem, and a tool restriction keeps working on the default.
 */
test("⭐ admission: default, pinned, dead pin without fallback, auth-less App", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  await getDb().update(managedMcpServers).set({ toolCatalog: [
    { name: "search", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } },
  ] }).where(eq(managedMcpServers.id, created.id));
  const sent: string[] = [];
  const call = (toolName = "search") => executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: created.id, toolName, arguments: {}, expectedConfigVersion: created.configVersion, expectedAssignmentVersion: 1,
  }, async (input) => { sent.push(String(input.headers["X-Api-Key"])); return { content: [], isError: false }; });

  // No assignment: the App's server default, as before Connections existed.
  await call();
  assert.deepEqual(sent, ["fixture-value-not-a-credential"]);

  // A tool restriction on top of "follow the default" keeps working (the migrated shape).
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: ["search"] });
  await call("search");
  await assert.rejects(call("write"), { code: "managed_mcp_tool_not_allowed" });
  assert.equal(sent.length, 2);

  // A second Connection, pinned to this Agent: the Agent now sends THAT credential.
  const [second] = await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: created.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Second", createdByUserId: user.id,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "second-fixture-value" }), headerNames: ["X-Api-Key"],
  }).returning();
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: ["search"], connectionId: second.id });
  await call();
  assert.equal(sent.at(-1), "second-fixture-value", "a pinned Agent uses its pinned Connection, not the default");

  // ⭐ The pinned Connection is deleted while a default still exists: refused, never the default.
  await getDb().delete(managedMcpCredentials).where(eq(managedMcpCredentials.id, second.id));
  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  assert.equal(sent.at(-1), "second-fixture-value", "nothing was sent with the default's credential");

  // Back to the default, then the default is removed: a Connection problem.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: null, connectionId: null });
  await call();
  await getDb().update(managedMcpCredentials).set({ isServerDefault: false }).where(eq(managedMcpCredentials.mcpServerId, created.id));
  await assert.rejects(call(), { code: "managed_mcp_login_required" });

  // An App that needs no credential needs no Connection.
  const open = await createManagedMcpServer({ serverId: server.id, userId: user.id, name: "Open", endpointUrl: "https://open.example.test/mcp" });
  await getDb().update(managedMcpServers).set({ toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] })
    .where(eq(managedMcpServers.id, open.id));
  let openCalls = 0;
  await executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: open.id, toolName: "search", arguments: {}, expectedConfigVersion: open.configVersion, expectedAssignmentVersion: 1,
  }, async () => { openCalls++; return { content: [], isError: false }; });
  assert.equal(openCalls, 1);
});

test("⭐ changing an Agent's Connection leaves its tool restriction and on/off state alone", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  await getDb().update(managedMcpServers).set({ toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] })
    .where(eq(managedMcpServers.id, created.id));
  const [second] = await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: created.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Second", createdByUserId: user.id,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "second" }), headerNames: ["X-Api-Key"],
  }).returning();
  const row = async () => (await getDb().select().from(managedMcpAssignments)
    .where(eq(managedMcpAssignments.agentId, agent.id)))[0];

  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: ["search"] });
  // Only the Connection is sent, the way the binding control sends it.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, connectionId: second.id });
  let current = await row();
  assert.deepEqual(current.allowedTools, ["search"], "⭐ the restriction survives a Connection change");
  assert.equal(current.connectionMode, "pinned");
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, connectionId: null });
  current = await row();
  assert.deepEqual(current.allowedTools, ["search"]);
  assert.equal(current.connectionMode, "default");

  // Switched off, then the Connection changes: it stays off.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: false });
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, connectionId: second.id });
  assert.equal((await row()).enabled, false, "⭐ choosing a Connection does not switch an Agent back on");
});

test("a pin can only name a Connection of the same App on the same Raft server", async () => {
  const { user, server, agent } = await seed();
  const mine = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Mine", endpointUrl: "https://mine.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  const other = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Other", endpointUrl: "https://other.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  const [otherConnection] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, other.id));
  await assert.rejects(
    setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: mine.id, connectionId: otherConnection.id }),
    { code: "managed_mcp_connection_not_found" },
  );
  await assert.rejects(
    setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: mine.id, connectionId: randomUUID() }),
    { code: "managed_mcp_connection_not_found" },
    "a missing id and another App's id get the identical answer",
  );
});

test("an App with several Connections is listed once, described by its server default", async () => {
  const { user, server } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: created.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Second",
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Other": "x" }), headerNames: ["X-Other"],
  });
  const catalog = await listManagedMcpServerCatalog(server.id);
  const rows = catalog.servers.filter((s) => s.id === created.id);
  assert.equal(rows.length, 1, "one row per App, not one per Connection");
  assert.deepEqual(rows[0].credentialHeaderNames, ["X-Api-Key"], "the default Connection describes the App");
});

test("switching an App to no auth returns its pinned Agents to the default instead of leaving dead pins", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  const [connection] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, created.id));
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, connectionId: connection.id });
  await updateManagedMcpServer({ serverId: server.id, userId: user.id, mcpServerId: created.id, authMode: "none" });
  const [assignment] = await getDb().select().from(managedMcpAssignments).where(eq(managedMcpAssignments.agentId, agent.id));
  assert.equal(assignment.connectionMode, "default");
  assert.equal(assignment.boundConnectionId, null);
});

test("⭐ an Agent's catalogue reports its mode and Connection state per App, names only when asked", async () => {
  const { user, server, agent } = await seed();
  const created = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "fixture-value-not-a-credential" },
  });
  const open = await createManagedMcpServer({ serverId: server.id, userId: user.id, name: "Open", endpointUrl: "https://open.example.test/mcp" });
  const [defaultConnection] = await getDb().update(managedMcpCredentials).set({ name: "Team Docs" })
    .where(eq(managedMcpCredentials.mcpServerId, created.id)).returning();
  const [second] = await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: created.id, isServerDefault: false, authKind: "headers", authStatus: "ready", name: "Second", createdByUserId: user.id,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "second" }), headerNames: ["X-Api-Key"],
  }).returning();
  const state = async (includeConnectionNames = true, appId = created.id) =>
    (await listAgentManagedMcpCatalog(server.id, agent.id, { includeConnectionNames })).servers.find((s) => s.id === appId)?.agentConnection;

  assert.deepEqual(await state(), { mode: "default", status: "ready", connectionName: "Team Docs", grant: "automatic" }, "no assignment follows the default");
  assert.deepEqual(await state(false), { mode: "default", status: "ready", connectionName: null, grant: "automatic" }, "an observer gets no name");
  assert.deepEqual(await state(true, open.id), { mode: "default", status: "ready", connectionName: null, grant: "automatic" }, "an auth-less App needs no Connection");

  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, connectionId: second.id });
  assert.deepEqual(await state(), { mode: "pinned", status: "ready", connectionName: "Second", grant: "automatic" });
  const agentsSummary = async () => {
    const { pinned, noConnection } = (await getMcpAppView(server.id, created.id, user.id)).agentsSummary;
    return { pinned, noConnection };
  };
  assert.deepEqual(await agentsSummary(), { pinned: 1, noConnection: 0 });

  // ⭐ A dead pin is refused even though a ready default exists: the row says so instead of "ready",
  // and both the Agent's row and the App's summary read it as "no connection selected", not a pin.
  await getDb().delete(managedMcpCredentials).where(eq(managedMcpCredentials.id, second.id));
  assert.deepEqual(await state(), { mode: "pinned", status: "login_required", connectionName: null, connectionMissing: true, grant: "automatic" });
  assert.deepEqual(await agentsSummary(), { pinned: 0, noConnection: 1 });

  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, connectionId: null });
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, defaultConnection.id));
  assert.deepEqual(await state(), { mode: "default", status: "authorization_expired", connectionName: "Team Docs", grant: "automatic" });

  await getDb().update(managedMcpCredentials).set({ isServerDefault: false }).where(eq(managedMcpCredentials.id, defaultConnection.id));
  assert.deepEqual(await state(), { mode: "default", status: "login_required", connectionName: null, grant: "automatic" }, "no server default");

  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: false });
  assert.equal((await state())?.mode, "off");
});

/**
 * ⭐ list_tools / call_tool: an App connected after a session started can be used without a restart
 * (the runtime read tools/list before the App had tools). Both go through the same call path as a
 * native tool; call_tool in particular cannot reach a tool the Agent may not use.
 */
async function headersAppWithTools(serverId: string, userId: string) {
  const created = await createManagedMcpServer({
    serverId, userId, name: "Docs", endpointUrl: "https://docs.example.com/mcp", headers: { Authorization: "Bearer docs-secret" },
  });
  await getDb().update(managedMcpServers).set({ toolCatalog: [
    { name: "read", description: "Read a page", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "write", inputSchema: { type: "object" } },
  ] }).where(eq(managedMcpServers.id, created.id));
  return created;
}

test("new snapshots carry no per-App list_tools / call_tool: an App offers only its own tools", async () => {
  const { user, server, agent } = await seed();
  const docs = await headersAppWithTools(server.id, user.id);
  const tools = (await getManagedMcpRuntimeSnapshot(server.id, agent.id)).tools;
  assert.deepEqual(tools.filter((tool) => tool.mcpServerId === docs.id).map((tool) => tool.toolName), ["read", "write"]);
});

test("⭐ the per-App list_tools / call_tool of an earlier snapshot still work: listing, and calling through the normal path", async () => {
  const { user, server, agent } = await seed();
  const docs = await headersAppWithTools(server.id, user.id);
  const upstream: Array<{ name: string; arguments: unknown; headers: unknown }> = [];
  const call = (toolName: string, args: Record<string, unknown> = {}) => executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: docs.id, toolName, arguments: args, expectedConfigVersion: docs.configVersion, expectedAssignmentVersion: 1,
  }, async (input) => { upstream.push({ name: input.name, arguments: input.arguments, headers: input.headers }); return { content: [{ type: "text", text: "page" }], isError: false }; });

  const listed = await call("list_tools");
  assert.deepEqual((listed.structuredContent as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name), ["read", "write"]);
  assert.match((listed.content[0] as { text: string }).text, /2 tools you may call with raft_app_call/u);
  assert.equal(upstream.length, 0, "listing is not a provider call");

  const result = await call("call_tool", { name: "read", arguments: { id: "p1" } });
  assert.deepEqual(result.content, [{ type: "text", text: "page" }]);
  assert.deepEqual(upstream, [{ name: "read", arguments: { id: "p1" }, headers: { Authorization: "Bearer docs-secret" } }], "⭐ the real tool, with the admitted Connection's credential");
  const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, docs.id));
  assert.deepEqual(audits.map((event) => (event.metadata as { toolName?: string }).toolName), ["read"], "usage is recorded for the real tool");

  await assert.rejects(call("call_tool", { name: "delete_everything" }), (error: unknown) => error instanceof ManagedMcpServiceError
    && error.code === "managed_mcp_tool_not_allowed" && /"Docs" has no tool named "delete_everything"; call raft_app_tools/u.test(error.message));
  await assert.rejects(call("call_tool", { name: "call_tool" }), { code: "managed_mcp_tool_not_allowed" }, "it cannot call itself");
  await assert.rejects(call("call_tool", {}), { code: "managed_mcp_tool_not_allowed" });
  assert.equal(upstream.length, 1);
});

test("⭐ the per-App call_tool cannot bypass allowedTools; list_tools shows only the allowed tools", async () => {
  const { user, server, agent } = await seed();
  const docs = await headersAppWithTools(server.id, user.id);
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: docs.id, enabled: true, allowedTools: ["read"] });
  let upstream = 0;
  const call = (toolName: string, args: Record<string, unknown> = {}) => executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: docs.id, toolName, arguments: args, expectedConfigVersion: docs.configVersion, expectedAssignmentVersion: 1,
  }, async () => { upstream += 1; return { content: [], isError: false }; });

  assert.deepEqual(((await call("list_tools")).structuredContent as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name), ["read"]);
  await assert.rejects(call("call_tool", { name: "write" }), { code: "managed_mcp_tool_not_allowed" }, "⭐ a restricted tool is refused through call_tool");
  assert.equal(upstream, 0);
  await call("call_tool", { name: "read" });
  assert.equal(upstream, 1);

  // Limited to no tools at all: none of the App's tools are offered.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: docs.id, allowedTools: [] });
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(server.id, agent.id)).filter((tool) => tool.mcpServerId === docs.id), []);
});

/**
 * ⭐ The Raft Apps tools (raft_apps_list / raft_app_tools / raft_app_call) are on every snapshot, so an
 * Agent whose session started before an App existed can still reach it.
 */
test("⭐ an Agent with no Apps gets the three Raft Apps tools; an App added and connected afterwards is callable through raft_app_call", async () => {
  const { user, server, agent } = await seed();
  const snapshot = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.deepEqual(snapshot.tools.map((tool) => [tool.mcpServerId, tool.toolName, tool.runtimeName]), [
    [RAFT_APPS_MCP_SERVER_ID, "raft_apps_list", "raft_apps_list"],
    [RAFT_APPS_MCP_SERVER_ID, "raft_app_tools", "raft_app_tools"],
    [RAFT_APPS_MCP_SERVER_ID, "raft_app_call", "raft_app_call"],
  ], "⭐ present with zero Apps");
  for (const tool of snapshot.tools) {
    assert.match(tool.description ?? "", /Use this when an MCP App's own tools are not in your tool list/u, `${tool.toolName}: says when to use it`);
  }
  assert.match(snapshot.tools[0]!.description ?? "", /If there are none, it returns an empty list and says no MCP Apps are available: there is nothing to request\./u);
  // The proxy's native name is r<8 hex>_<toolName>; within its 48-character limit.
  assert.ok(snapshot.tools.every((tool) => `r12345678_${tool.toolName}`.length <= 48));

  const raft = (toolName: string, args: Record<string, unknown> = {}, upstream: Array<{ name: string; arguments: unknown }> = []) => executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: RAFT_APPS_MCP_SERVER_ID, toolName, arguments: args, expectedConfigVersion: 1, expectedAssignmentVersion: 1,
  }, async (input) => { upstream.push({ name: input.name, arguments: input.arguments }); return { content: [{ type: "text", text: "page" }], isError: false }; });

  // ⭐ Empty state, stated plainly.
  const empty = await raft("raft_apps_list");
  assert.equal((empty.content[0] as { text: string }).text, "No MCP Apps are available to you on this Raft Server. There is nothing to request.");
  assert.deepEqual(empty.structuredContent, { apps: [] });
  await assert.rejects(raft("raft_app_tools", { app: "Docs" }), (error: unknown) => error instanceof ManagedMcpServiceError
    && error.code === "managed_mcp_server_not_found" && /No MCP Apps are available to you on this Raft Server\. There is nothing to request\./u.test(error.message));

  // Added and connected after the snapshot above: no new snapshot is taken.
  const docs = await headersAppWithTools(server.id, user.id);
  const listed = await raft("raft_apps_list");
  assert.deepEqual((listed.structuredContent as { apps: Array<{ id: string; grant: string; state: string }> }).apps.map((app) => [app.id, app.grant, app.state]), [[docs.id, "granted", "ready"]]);
  const tools = await raft("raft_app_tools", { app: "Docs" });
  assert.deepEqual((tools.structuredContent as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name), ["read", "write"]);
  const upstream: Array<{ name: string; arguments: unknown }> = [];
  const result = await raft("raft_app_call", { app: docs.id, name: "read", arguments: { id: "p1" } }, upstream);
  assert.deepEqual(result.content, [{ type: "text", text: "page" }]);
  assert.deepEqual(upstream, [{ name: "read", arguments: { id: "p1" } }], "⭐ the App's real tool, through the native path");
  const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, docs.id));
  assert.deepEqual(audits.map((event) => (event.metadata as { toolName?: string }).toolName), ["read"], "usage is the App's, under the real tool");
  await assert.rejects(raft("raft_app_call", { app: "Docs", name: "nope" }), (error: unknown) => error instanceof ManagedMcpServiceError
    && /"Docs" has no tool named "nope"; call raft_app_tools/u.test(error.message));
  await assert.rejects(raft("raft_apps_nope"), { code: "managed_mcp_tool_not_allowed" });
});

test("⭐ raft_app_call cannot bypass allowedTools; a revoked App says how to ask for it, without a card", async () => {
  const { user, server, agent } = await seed();
  const docs = await headersAppWithTools(server.id, user.id);
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: docs.id, enabled: true, allowedTools: ["read"] });
  let upstream = 0;
  const raft = (toolName: string, args: Record<string, unknown>) => executeManagedMcpCall(server.id, agent.id, {
    mcpServerId: RAFT_APPS_MCP_SERVER_ID, toolName, arguments: args, expectedConfigVersion: 1, expectedAssignmentVersion: 1,
  }, async () => { upstream += 1; return { content: [], isError: false }; });

  assert.deepEqual(((await raft("raft_app_tools", { app: "Docs" })).structuredContent as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name), ["read"]);
  await assert.rejects(raft("raft_app_call", { app: "Docs", name: "write" }), { code: "managed_mcp_tool_not_allowed" }, "⭐ a restricted tool is refused");
  assert.equal(upstream, 0);
  await raft("raft_app_call", { app: "Docs", name: "read" });
  assert.equal(upstream, 1);

  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: docs.id, enabled: false });
  await assert.rejects(raft("raft_app_call", { app: "Docs", name: "read" }), (error: unknown) => error instanceof ManagedMcpServiceError
    && error.code === "managed_mcp_app_off"
    && error.message.includes(`You do not have the MCP App "Docs" (revoked). Ask a person for it: raft integration login --service "${docs.id}" --target <channel-or-thread>`)
    && error.app?.id === docs.id);
  const listed = await raft("raft_apps_list", {});
  assert.match((listed.content[0] as { text: string }).text, new RegExp(`- "Docs" \\(id ${docs.id}\\): 1 tool; you do not have it yet: run \`raft integration login --service "${docs.id}" --target <channel-or-thread>\` to ask a person for it`, "u"));
  assert.equal(upstream, 1);
});
