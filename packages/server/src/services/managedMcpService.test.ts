import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { ManagedMcpCallRequest } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { integrationAuditEvents, managedMcpCredentials, managedMcpServers, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { createServer } from "./serverService.js";
import { decryptManagedMcpHeaders } from "./managedMcpCredentialService.js";
import {
  applyManagedMcpAssignments,
  createManagedMcpServer,
  deleteManagedMcpServer,
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  listAgentManagedMcpCatalog,
  ManagedMcpServiceError,
  setManagedMcpAssignment,
  testManagedMcpConfiguration,
  updateManagedMcpServer,
} from "./managedMcpService.js";


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

  const snapshot = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.equal(snapshot.catalogVersion, 1);
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
  await assertRejectedBeforeProvider(disconnected.id, disconnected.configVersion, "managed_mcp_auth_invalid");
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
  assert.equal(staleSnapshot.tools.length, 1);
  const staleTool = staleSnapshot.tools[0]!;

  await deleteManagedMcpServer(server.id, created.id);

  const freshSnapshot = await getManagedMcpRuntimeSnapshot(server.id, agent.id);
  assert.deepEqual(freshSnapshot.tools, []);
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

test("managed MCP assignments reject disconnected OAuth connections", async () => {
  const { user, server, agent } = await seed();
  const notion = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: "Notion",
    provider: "notion",
    authMode: "oauth",
    endpointUrl: "https://mcp.notion.com/mcp",
  });

  assert.deepEqual((await getManagedMcpRuntimeSnapshot(server.id, agent.id)).tools, []);
  await assert.rejects(() => setManagedMcpAssignment({
    serverId: server.id,
    userId: user.id,
    agentId: agent.id,
    mcpServerId: notion.id,
    enabled: true,
    allowedTools: null,
  }), /must be connected before assignment/u);
  await assert.rejects(() => applyManagedMcpAssignments({
    serverId: server.id,
    userId: user.id,
    agentId: agent.id,
    assignments: [{ mcpServerId: notion.id, enabled: true, allowedTools: null }],
  }), /must be connected before assignment/u);
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
  assert.deepEqual((await getManagedMcpRuntimeSnapshot(server.id, agent.id)).tools.map(t => t.toolName), ["read"]);

  await call("read");
  assert.equal(calls, 1);
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: false, allowedTools: ["read"] });
  assert.deepEqual((await getManagedMcpRuntimeSnapshot(server.id, agent.id)).tools, []);
  await assert.rejects(call("read"), { code: "managed_mcp_tool_not_allowed" });
  assert.equal(calls, 1);

  // An empty allowlist denies every tool; null restores the catalog default.
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: [] });
  assert.deepEqual((await getManagedMcpRuntimeSnapshot(server.id, agent.id)).tools, []);
  await assert.rejects(call("read"), { code: "managed_mcp_tool_not_allowed" });
  assert.equal(calls, 1);
  await setManagedMcpAssignment({ serverId: server.id, userId: user.id, agentId: agent.id, mcpServerId: created.id, enabled: true, allowedTools: null });
  assert.deepEqual((await getManagedMcpRuntimeSnapshot(server.id, agent.id)).tools.map(t => t.toolName), ["read", "write"]);
  await call("write");
  assert.equal(calls, 2);
});
