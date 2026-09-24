import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { managedMcpServers, users } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { addMember, createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name: email.split("@")[0],
    displayName: email.split("@")[0],
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("managed MCP control plane is capability-gated and never returns credential values", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedUser(`mcp-owner-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-member-${randomUUID()}@slock.test`);
    const server = await createServer("Managed MCP API", `managed-mcp-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id, "member");
    const agent = await createAgent(server.id, "managed-mcp-agent", {
      creatorType: "user",
      creatorId: member.id,
    });
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);

    const memberRead = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(memberRead.status, 200);

    const forbiddenCreate = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ name: "Denied", endpointUrl: "https://example.com/mcp" }),
    });
    assert.equal(forbiddenCreate.status, 403);

    const emptyMemberServerCatalog = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(emptyMemberServerCatalog.status, 200);
    assert.deepEqual((await emptyMemberServerCatalog.json() as { servers: unknown[] }).servers, []);

    const create = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "Private MCP",
        endpointUrl: "https://example.com/mcp",
        headers: { Authorization: "Bearer route-secret" },
      }),
    });
    const createText = await create.text();
    assert.equal(create.status, 201, createText);
    const created = JSON.parse(createText) as Record<string, unknown>;
    assert.equal(created.hasCredentials, true);
    assert.deepEqual(created.credentialHeaderNames, ["Authorization"]);
    assert.equal(JSON.stringify(created).includes("route-secret"), false);
    assert.equal("encryptedHeaders" in created, false);

    const queryCredentialCreate = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "Query secret rejected",
        endpointUrl: "https://example.com/mcp?token=must-not-persist",
      }),
    });
    assert.equal(queryCredentialCreate.status, 400);
    const queryCredentialError = await queryCredentialCreate.json() as { code: string; error: string };
    assert.equal(queryCredentialError.code, "managed_mcp_endpoint_invalid");
    assert.equal(JSON.stringify(queryCredentialError).includes("must-not-persist"), false);

    await getDb().update(managedMcpServers).set({
      endpointUrl: "https://example.com/mcp?token=legacy-member-secret",
    }).where(eq(managedMcpServers.id, String(created.id)));

    const memberServerCatalog = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(memberServerCatalog.status, 200);
    const memberServerCatalogBody = await memberServerCatalog.json() as {
      servers: Array<Record<string, unknown>>;
    };
    assert.equal(memberServerCatalogBody.servers.length, 1);
    assert.equal(memberServerCatalogBody.servers[0]?.id, created.id);
    assert.equal(memberServerCatalogBody.servers[0]?.endpointUrl, "https://example.com/mcp");
    assert.equal(JSON.stringify(memberServerCatalogBody).includes("route-secret"), false);
    assert.equal(JSON.stringify(memberServerCatalogBody).includes("legacy-member-secret"), false);
    assert.equal(JSON.stringify(memberServerCatalogBody).includes("encryptedHeaders"), false);
    await getDb().update(managedMcpServers).set({
      endpointUrl: "https://example.com/mcp",
    }).where(eq(managedMcpServers.id, String(created.id)));

    const forbiddenPatch = await fetch(`${app.baseUrl}/api/mcp/servers/${created.id}`, {
      method: "PATCH",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ name: "Denied edit" }),
    });
    assert.equal(forbiddenPatch.status, 403);

    const forbiddenDelete = await fetch(`${app.baseUrl}/api/mcp/servers/${created.id}`, {
      method: "DELETE",
      headers: headers(memberToken, server.id),
    });
    assert.equal(forbiddenDelete.status, 403);

    const serverCatalog = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(serverCatalog.status, 200);
    const serverCatalogBody = await serverCatalog.json() as {
      servers: Array<Record<string, unknown>>;
      recommendations: Array<Record<string, unknown>>;
    };
    assert.equal(serverCatalogBody.servers.length, 1);
    assert.equal(serverCatalogBody.servers[0]?.assignment, null);
    assert.deepEqual(serverCatalogBody.recommendations.map((item) => item.id), ["notion", "linear"]);
    assert.equal(JSON.stringify(serverCatalogBody).includes("route-secret"), false);

    const catalog = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json() as Record<string, unknown>;
    assert.equal(JSON.stringify(catalogBody).includes("route-secret"), false);
    assert.equal(JSON.stringify(catalogBody).includes("encryptedHeaders"), false);

    const patchCredentials = await fetch(`${app.baseUrl}/api/mcp/servers/${created.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        credentialPatch: {
          upsertHeaders: { "X-New": "replacement-secret" },
          removeHeaderNames: ["Authorization"],
        },
      }),
    });
    const patchText = await patchCredentials.text();
    assert.equal(patchCredentials.status, 200, patchText);
    const patched = JSON.parse(patchText) as Record<string, unknown>;
    assert.deepEqual(patched.credentialHeaderNames, ["X-New"]);
    assert.equal(JSON.stringify(patched).includes("replacement-secret"), false);

    const notion = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "Notion",
        provider: "notion",
        authMode: "oauth",
        endpointUrl: "https://mcp.notion.com/mcp",
      }),
    });
    const notionText = await notion.text();
    assert.equal(notion.status, 201, notionText);
    const notionBody = JSON.parse(notionText) as Record<string, unknown>;
    assert.equal(notionBody.provider, "notion");
    assert.equal(notionBody.authMode, "oauth");
    assert.equal(notionBody.oauthStatus, "disconnected");
    assert.equal(JSON.stringify(notionBody).includes("encryptedOAuth"), false);

    const wrongNotionEndpoint = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "Notion impostor",
        provider: "notion",
        authMode: "oauth",
        endpointUrl: "https://example.com/mcp",
      }),
    });
    assert.equal(wrongNotionEndpoint.status, 409);
    assert.equal((await wrongNotionEndpoint.json() as { code: string }).code, "managed_mcp_auth_invalid");

    const invalidCallback = await fetch(`${app.baseUrl}/api/mcp/oauth/callback?state=invalid&code=invalid`);
    assert.equal(invalidCallback.status, 400);
    assert.equal(invalidCallback.headers.get("cache-control"), "no-store");
    assert.match(invalidCallback.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
    const invalidCallbackBody = await invalidCallback.text();
    assert.match(invalidCallbackBody, /<main>/u);
    assert.match(invalidCallbackBody, /RAFT/u);
    assert.match(invalidCallbackBody, /MCP was not connected/u);
    assert.match(invalidCallbackBody, /Close window/u);
    assert.match(invalidCallbackBody, /raft-managed-mcp-oauth-result/u);
    assert.match(invalidCallbackBody, /managed-mcp-oauth-result/u);
    assert.doesNotMatch(invalidCallbackBody, /setTimeout|setInterval/u);

    const clientMetadataResponse = await fetch(`${app.baseUrl}/api/mcp/oauth/client-metadata`);
    assert.equal(clientMetadataResponse.status, 200);
    assert.equal(clientMetadataResponse.headers.get("cache-control"), "no-store");
    const clientMetadata = await clientMetadataResponse.json() as {
      client_id: string;
      redirect_uris: string[];
    };
    const clientId = new URL(clientMetadata.client_id);
    assert.equal(clientId.pathname, "/api/mcp/oauth/client-metadata");
    assert.equal(clientMetadata.client_id, clientId.toString());
    assert.deepEqual(clientMetadata.redirect_uris, [
      new URL("/api/mcp/oauth/callback", clientId.origin).toString(),
    ]);

    const resetCalls: Array<{ agentId: string; mode: string; options: unknown }> = [];
    const orchestrator = app.app.get("agentOrchestrator") as {
      resetAgent: (agentId: string, mode: string, options: unknown) => Promise<void>;
    };
    orchestrator.resetAgent = async (agentId, mode, options) => {
      resetCalls.push({ agentId, mode, options });
    };
    const apply = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments`, {
      method: "PUT",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({
        assignments: [{ mcpServerId: created.id, enabled: true, allowedTools: null }],
      }),
    });
    assert.equal(apply.status, 200, await apply.text());
    assert.deepEqual(resetCalls, [{ agentId: agent.id, mode: "restart", options: { restartIfStopped: false } }]);

    const unsafeDraftTest = await fetch(`${app.baseUrl}/api/mcp/servers/test-configuration`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ endpointUrl: "http://127.0.0.1/mcp", headers: {} }),
    });
    assert.equal(unsafeDraftTest.status, 400);
    assert.equal((await unsafeDraftTest.json() as { code: string }).code, "managed_mcp_endpoint_invalid");
  } finally {
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});
