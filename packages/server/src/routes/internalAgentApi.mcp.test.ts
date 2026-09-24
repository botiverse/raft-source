import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { managedMcpServers, users } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seed() {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `mcp-agent-api-${suffix}@slock.test`,
    name: `mcp-agent-api-${suffix}`,
    displayName: "MCP Agent API Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP Agent API", `mcp-agent-api-${suffix}`, user.id);
  const agent = await createAgent(server.id, `McpAgent${suffix.slice(0, 6)}`);
  const [mcpServer] = await getDb().insert(managedMcpServers).values({
    serverId: server.id,
    name: "Docs",
    endpointUrl: "https://example.com/mcp",
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
    catalogVersion: 1,
  }).returning();
  const mcpKey = await mintAgentCredential({ agentId: agent.id, scopes: ["mcp"], name: "mcp-test", createdByUserId: null });
  const readKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "read-test", createdByUserId: null });
  return { mcpKey: mcpKey.apiKey, readKey: readKey.apiKey, mcpServerId: mcpServer.id };
}

test("agent-api managed MCP snapshot is credential-bound and capability-gated", async ({ app }) => {
  const fixture = await seed();
  const denied = await fetch(`${app.baseUrl}/internal/agent-api/mcp/tools`, {
    headers: { Authorization: `Bearer ${fixture.readKey}` },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { requiredCapability?: string }).requiredCapability, "mcp");

  const response = await fetch(`${app.baseUrl}/internal/agent-api/mcp/tools`, {
    headers: {
      Authorization: `Bearer ${fixture.mcpKey}`,
      "X-Slock-Agent-Active-Capabilities": "mcp",
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { catalogVersion: number; tools: Array<Record<string, unknown>> };
  assert.equal(body.catalogVersion, 1);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].mcpServerId, fixture.mcpServerId);
  assert.equal(body.tools[0].toolName, "search");
  assert.equal(body.tools[0].assignmentVersion, 1);
  assert.equal("endpointUrl" in body.tools[0], false);
  assert.equal("headers" in body.tools[0], false);

  const invalidCall = await fetch(`${app.baseUrl}/internal/agent-api/mcp/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.mcpKey}`,
      "X-Slock-Agent-Active-Capabilities": "mcp",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mcpServerId: "not-a-uuid", toolName: "search", arguments: {} }),
  });
  assert.equal(invalidCall.status, 400);
});
