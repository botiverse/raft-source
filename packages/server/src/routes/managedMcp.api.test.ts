import { listMcpAppTemplates } from "../services/mcpAppTemplates";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { managedMcpAssignments, managedMcpCredentials, managedMcpServers, mcpAppTemplates, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addMember, createServer } from "../services/serverService";
import { findMcpAppTemplate } from "../services/mcpAppTemplates";
import { setPrivacyModeForTest } from "../config/privacyMode";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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

    // ⭐ A guest has no viewAgents capability and does not get the Server's MCP catalogue.
    const guest = await seedUser(`mcp-guest-${randomUUID()}@slock.test`);
    await seedBoundGuest({ serverId: server.id, userId: guest.id });
    const guestServerCatalog = await fetch(`${app.baseUrl}/api/mcp/servers`, {
      headers: headers(await login(app.baseUrl, guest.email), server.id),
    });
    assert.equal(guestServerCatalog.status, 403);
    assert.equal((await guestServerCatalog.text()).includes("example.com/mcp"), false);
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
    // The legacy recommendations contract remains limited to these two providers.
    assert.deepEqual(serverCatalogBody.recommendations.map((item) => [item.id, item.endpointUrl]), [
      ["notion", "https://mcp.notion.com/mcp"],
      ["linear", "https://mcp.linear.app/mcp"],
    ]);
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

    // Task #91: the single-assignment route runs its whole write inside the membership fence; exercise its success path.
    const single = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${created.id}`, {
      method: "PUT",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ enabled: false, allowedTools: null }),
    });
    assert.equal(single.status, 200, await single.clone().text());
    assert.equal((await single.json() as { assignment: { enabled: boolean } | null }).assignment?.enabled, false);

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

/**
 * `GET /servers/:id/connection-authorization` is deliberately NOT behind a capability gate: the
 * projection derives the viewer's role itself. So the role scoping is the whole protection, and it
 * is pinned here over real HTTP. The pin route must also refuse a Connection from another App or
 * another Raft server with the same answer as an id that does not exist.
 */
test("connection authorization is scoped by viewer role, and a pin cannot cross Apps or servers", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const owner = await seedUser(`mcp-scope-owner-${randomUUID()}@slock.test`);
    const manager = await seedUser(`mcp-scope-mgr-${randomUUID()}@slock.test`);
    const observer = await seedUser(`mcp-scope-obs-${randomUUID()}@slock.test`);
    const server = await createServer("Scope", `scope-${randomUUID()}`, owner.id);
    const otherServer = await createServer("Elsewhere", `elsewhere-${randomUUID()}`, owner.id);
    await addMember(server.id, manager.id, "member");
    await addMember(server.id, observer.id, "member");
    const agent = await createAgent(server.id, "scoped-agent", { creatorType: "user", creatorId: manager.id });

    const insertApp = async (serverId: string, name: string) => (await db.insert(managedMcpServers).values({
      serverId, name, endpointUrl: `https://${name.toLowerCase()}.example.test/mcp`, authMode: "headers", sourceKind: "url",
      toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] as never,
    }).returning())[0];
    const insertConnection = async (serverId: string, mcpServerId: string, isServerDefault: boolean) => (await db.insert(managedMcpCredentials).values({
      serverId, mcpServerId, headerNames: ["X-Api-Key"], isServerDefault, authKind: "headers", authStatus: "ready", name: "Team",
    }).returning())[0];
    const mine = await insertApp(server.id, "Mine");
    const mineDefault = await insertConnection(server.id, mine.id, true);
    const otherApp = await insertApp(server.id, "Other");
    const otherAppConnection = await insertConnection(server.id, otherApp.id, true);
    const foreign = await insertApp(otherServer.id, "Foreign");
    const foreignConnection = await insertConnection(otherServer.id, foreign.id, true);

    const managerToken = await login(app.baseUrl, manager.email);
    const observerToken = await login(app.baseUrl, observer.email);
    const projectionUrl = `${app.baseUrl}/api/mcp/servers/${mine.id}/connection-authorization?agentId=${agent.id}`;

    // ① The observer is told nothing actionable: no candidates, no ids.
    const asObserver = await fetch(projectionUrl, { headers: headers(observerToken, server.id) });
    assert.equal(asObserver.status, 200);
    const observerBody = await asObserver.json() as { viewerRole: string; candidates?: unknown[] };
    assert.equal(observerBody.viewerRole, "observer");
    assert.ok(!observerBody.candidates || observerBody.candidates.length === 0, "an observer gets no candidates");
    assert.ok(!JSON.stringify(observerBody).includes(mineDefault.id), "⭐ and no Connection id anywhere in the body");

    // ② The Agent's manager sees the App's Connections, and nothing from another App.
    const asManager = await fetch(projectionUrl, { headers: headers(managerToken, server.id) });
    const managerBody = await asManager.json() as { viewerRole: string; candidates: Array<{ connectionId: string }> };
    assert.equal(managerBody.viewerRole, "agent_manager");
    assert.deepEqual(managerBody.candidates.map((c) => c.connectionId), [mineDefault.id]);

    // The Agent's App catalogue: everyone sees each App's state; only a manager sees the Connection name.
    const catalogUrl = `${app.baseUrl}/api/mcp/agents/${agent.id}`;
    type CatalogBody = { servers: Array<{ id: string; agentConnection?: { mode: string; status: string; connectionName: string | null } }> };
    const catalogAs = async (token: string) => ((await (await fetch(catalogUrl, { headers: headers(token, server.id) })).json()) as CatalogBody)
      .servers.find((s) => s.id === mine.id)?.agentConnection;
    // `grant`: an App with no recorded creator is granted automatically to every Agent.
    assert.deepEqual(await catalogAs(managerToken), { mode: "default", status: "ready", connectionName: "Team", grant: "automatic" });
    assert.deepEqual(await catalogAs(observerToken), { mode: "default", status: "ready", connectionName: null, grant: "automatic" },
      "⭐ an observer sees the state but not which Connection");

    // ③ Pinning to another App's Connection, another server's, or a made-up id: same refusal, no write.
    const pinUrl = `${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${mine.id}`;
    const answers = [];
    for (const connectionId of [otherAppConnection.id, foreignConnection.id, randomUUID()]) {
      const res = await fetch(pinUrl, { method: "PUT", headers: headers(managerToken, server.id), body: JSON.stringify({ connectionId }) });
      answers.push({ status: res.status, code: (await res.json() as { code?: string }).code });
    }
    assert.deepEqual(answers, Array(3).fill({ status: 404, code: "managed_mcp_connection_not_found" }),
      "⭐ indistinguishable answers, so the route cannot be used to probe Connection ids");
    const pinned = await db.select().from(managedMcpAssignments).where(eq(managedMcpAssignments.agentId, agent.id));
    assert.equal(pinned.length, 0, "nothing was written");
  } finally {
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});

/**
 * WHOSE Connection an Agent may use, over HTTP: the App's default, or one the Agent's owner created.
 * Managing an Agent (or the whole server) never lets someone pin it to another person's Connection.
 */
test("⭐ a pin to another person's Connection is refused 403 managed_mcp_connection_not_usable; own and default pins work", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const owner = await seedUser(`mcp-own-owner-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-own-member-${randomUUID()}@slock.test`);
    const server = await createServer("Ownership", `ownership-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id, "member");
    const agent = await createAgent(server.id, "members-agent", { creatorType: "user", creatorId: member.id });
    const [mcp] = await db.insert(managedMcpServers).values({
      serverId: server.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp", authMode: "headers", sourceKind: "url", createdByUserId: owner.id,
      toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] as never,
    }).returning();
    const insertConnection = async (name: string, createdByUserId: string, isServerDefault = false) => (await db.insert(managedMcpCredentials).values({
      serverId: server.id, mcpServerId: mcp.id, headerNames: ["X-Api-Key"], isServerDefault, authKind: "headers", authStatus: "ready", name, createdByUserId,
    }).returning())[0];
    const teamDefault = await insertConnection("Team", owner.id, true);
    const ownersPersonal = await insertConnection("Owner's own", owner.id);
    const membersOwn = await insertConnection("Member's own", member.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    const pin = async (token: string, connectionId: string | null) => {
      const res = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${mcp.id}`, {
        method: "PUT", headers: headers(token, server.id), body: JSON.stringify({ connectionId }),
      });
      return { status: res.status, body: await res.json() as { code?: string; error?: string } };
    };
    const bound = async () => (await db.select().from(managedMcpAssignments).where(eq(managedMcpAssignments.agentId, agent.id)))[0]?.boundConnectionId ?? null;
    const refusal = {
      status: 403,
      body: { code: "managed_mcp_connection_not_usable", error: "This Connection belongs to someone else. An agent can use the App's default Connection or one its owner created." },
    };

    // The member pins their own Agent to their own Connection.
    assert.equal((await pin(memberToken, membersOwn.id)).status, 200);
    assert.equal(await bound(), membersOwn.id);
    // ⭐ ... but not to the server owner's personal one; nor may the server owner put it there.
    assert.deepEqual(await pin(memberToken, ownersPersonal.id), refusal);
    assert.deepEqual(await pin(ownerToken, ownersPersonal.id), refusal, "⭐ managing the server does not make it the Agent's owner's");
    const bulk = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments`, {
      method: "PUT", headers: headers(memberToken, server.id), body: JSON.stringify({ assignments: [{ mcpServerId: mcp.id, connectionId: ownersPersonal.id }] }),
    });
    assert.deepEqual({ status: bulk.status, body: await bulk.json() }, refusal, "the bulk route refuses it the same way");
    assert.equal(await bound(), membersOwn.id, "nothing was written");
    // The default, pinned or followed: allowed.
    assert.equal((await pin(memberToken, teamDefault.id)).status, 200);
    assert.equal((await pin(memberToken, null)).status, 200);
    assert.equal(await bound(), null);

    // The picker offers only what this Agent may use, to the Agent's manager and a server manager alike.
    const candidatesAs = async (token: string) => {
      const res = await fetch(`${app.baseUrl}/api/mcp/servers/${mcp.id}/connection-authorization?agentId=${agent.id}`, { headers: headers(token, server.id) });
      const body = await res.json() as { candidates: Array<{ connectionId: string }>; newConnectionPinnable: boolean };
      return { ids: body.candidates.map((candidate) => candidate.connectionId).sort(), newConnectionPinnable: body.newConnectionPinnable };
    };
    const usable = [teamDefault.id, membersOwn.id].sort();
    assert.deepEqual(await candidatesAs(memberToken), { ids: usable, newConnectionPinnable: true });
    assert.deepEqual(await candidatesAs(ownerToken), { ids: usable, newConnectionPinnable: false }, "⭐ not the owner's personal Connection");
  } finally {
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});

/**
 * Per-Connection OAuth over HTTP: the start route is admin-only, and the attempt-status route is
 * visible only to the user who started the sign-in (anyone else gets the not-found answer).
 */
test("OAuth per Connection: start is gated, and an attempt's status is visible only to its starter", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const { __setManagedMcpOAuthGatewayForTests } = await import("../services/managedMcpOAuthService");
  __setManagedMcpOAuthGatewayForTests({
    start: async (_endpoint, provider) => {
      provider.redirectToAuthorization(new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(await provider.state!())}`));
      return "REDIRECT";
    },
    complete: async (_endpoint, provider, code) => {
      await provider.saveTokens({ access_token: `access-for-${code}`, token_type: "Bearer" });
    },
    listTools: async () => [{ name: "search", inputSchema: { type: "object" } }],
  });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser(`mcp-attempt-owner-${randomUUID()}@slock.test`);
    const admin = await seedUser(`mcp-attempt-admin-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-attempt-member-${randomUUID()}@slock.test`);
    const server = await createServer("Attempts", `attempts-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await addMember(server.id, member.id, "member");
    const [mcp] = await getDb().insert(managedMcpServers).values({
      serverId: server.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp", authMode: "oauth", sourceKind: "url",
    }).returning();
    const ownerToken = await login(app.baseUrl, owner.email);
    const adminToken = await login(app.baseUrl, admin.email);
    const memberToken = await login(app.baseUrl, member.email);
    const startUrl = `${app.baseUrl}/api/mcp/apps/${mcp.id}/connections/oauth/start`;

    const denied = await fetch(startUrl, { method: "POST", headers: headers(memberToken, server.id), body: JSON.stringify({ name: "Mine" }) });
    assert.equal(denied.status, 403);

    const started = await fetch(startUrl, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({ name: "Team" }) });
    const startedText = await started.text();
    assert.equal(started.status, 200, startedText);
    const { authorizationUrl, attemptId, connectionId } = JSON.parse(startedText) as { authorizationUrl: string; attemptId: string; connectionId: string };
    const [pending] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, connectionId));
    assert.equal(pending.authStatus, "pending");

    const statusAs = async (token: string, id = attemptId) => {
      const res = await fetch(`${app.baseUrl}/api/mcp/oauth/attempts/${id}`, { headers: headers(token, server.id) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    assert.deepEqual(await statusAs(ownerToken), { status: 200, body: { attemptId, status: "pending", connectionId } });
    const asOtherAdmin = await statusAs(adminToken);
    const unknown = await statusAs(ownerToken, randomUUID());
    assert.equal(asOtherAdmin.status, 404, "⭐ another admin cannot read someone else's sign-in");
    assert.deepEqual(asOtherAdmin, unknown, "and gets the same answer as for an id that does not exist");

    const state = new URL(authorizationUrl).searchParams.get("state")!;
    // The start response binds the sign-in to the starting browser with an HttpOnly cookie
    // scoped to the callback, living as long as the attempt; the body never carries the state.
    const [binding] = started.headers.getSetCookie();
    assert.match(binding ?? "", /^raft_mcp_oauth_[0-9a-f]{16}=/u);
    assert.match(binding!, /; Path=\/api\/mcp\/oauth\/callback; Max-Age=600; HttpOnly; SameSite=Lax/u);
    assert.equal("state" in JSON.parse(startedText), false);
    const bindingCookie = binding!.split(";")[0]!;

    // ⭐ Someone else opening the link (no cookie, or another sign-in's cookie) cannot finish it.
    const otherStart = await fetch(startUrl, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({ name: "Other" }) });
    assert.equal(otherStart.status, 200);
    const otherCookie = otherStart.headers.getSetCookie()[0]!.split(";")[0]!;
    for (const cookie of [undefined, otherCookie, `${bindingCookie.split("=")[0]}=not-the-state`]) {
      // Each refusal fails its attempt, so every case starts a fresh one.
      const fresh = await fetch(startUrl, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({ connectionId }) });
      assert.equal(fresh.status, 200);
      const freshBody = await fresh.json() as { authorizationUrl: string; attemptId: string };
      const freshState = new URL(freshBody.authorizationUrl).searchParams.get("state")!;
      const freshCookieName = fresh.headers.getSetCookie()[0]!.split("=")[0]!;
      const forged = cookie?.endsWith("=not-the-state") ? `${freshCookieName}=not-the-state` : cookie;
      const refused = await fetch(`${app.baseUrl}/api/mcp/oauth/callback?state=${encodeURIComponent(freshState)}&code=attacker-code`,
        forged ? { headers: { Cookie: forged } } : {});
      assert.equal(refused.status, 400, `callback with cookie ${forged ?? "(none)"}`);
      assert.deepEqual(await statusAs(ownerToken, freshBody.attemptId), { status: 200, body: { attemptId: freshBody.attemptId, status: "failed", connectionId } });
    }

    // The starting browser finishes a sign-in, and the binding is cleared after its one use.
    const restarted = await fetch(startUrl, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({ connectionId }) });
    const restartedBody = await restarted.json() as { authorizationUrl: string; attemptId: string };
    const restartedState = new URL(restartedBody.authorizationUrl).searchParams.get("state")!;
    const restartedCookie = restarted.headers.getSetCookie()[0]!.split(";")[0]!;
    const callback = await fetch(`${app.baseUrl}/api/mcp/oauth/callback?state=${encodeURIComponent(restartedState)}&code=team-code`,
      { headers: { Cookie: restartedCookie } });
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), new RegExp(`attemptId:"${restartedBody.attemptId}"`, "u"), "the result page names its attempt");
    assert.match(callback.headers.getSetCookie()[0] ?? "", new RegExp(`^${restartedCookie.split("=")[0]}=; Path=/api/mcp/oauth/callback; Max-Age=0`, "u"));
    assert.deepEqual(await statusAs(ownerToken, restartedBody.attemptId), { status: 200, body: { attemptId: restartedBody.attemptId, status: "connected", connectionId } });

  } finally {
    __setManagedMcpOAuthGatewayForTests(null);
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});

test("Connections and the server default are managed by integration managers only", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser(`mcp-default-owner-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-default-member-${randomUUID()}@slock.test`);
    const server = await createServer("Defaults", `defaults-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id, "member");
    await createAgent(server.id, "default-follower", { creatorType: "user", creatorId: member.id });
    const [mcp] = await getDb().insert(managedMcpServers).values({
      serverId: server.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp", authMode: "headers", sourceKind: "url",
      requiredHeaderNames: ["X-Api-Key"],
    }).returning();
    const insert = async (name: string, isServerDefault: boolean) => (await getDb().insert(managedMcpCredentials).values({
      serverId: server.id, mcpServerId: mcp.id, headerNames: ["X-Api-Key"], isServerDefault, authKind: "headers", authStatus: "ready", name,
    }).returning())[0];
    const first = await insert("First", true);
    const second = await insert("Second", false);
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    const base = `${app.baseUrl}/api/mcp/apps/${mcp.id}`;

    for (const [method, path, payload] of [
      ["POST", "/connections", { name: "Mine", headers: { "X-Api-Key": "fixture" } }],
      ["PATCH", `/connections/${second.id}`, { name: "Renamed" }],
      ["DELETE", `/connections/${second.id}`, undefined],
      ["PUT", "/default", { connectionId: second.id }],
      ["GET", `/default/impact?connectionId=${second.id}`, undefined],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: headers(memberToken, server.id), ...(payload ? { body: JSON.stringify(payload) } : {}) });
      assert.equal(res.status, 403, `${method} ${path}`);
    }

    const incomplete = await fetch(`${base}/connections`, {
      method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({ name: "Wrong", headers: { Authorization: "Bearer fixture" } }),
    });
    assert.equal(incomplete.status, 400);
    assert.equal((await incomplete.json() as { code: string }).code, "managed_mcp_headers_incomplete");

    const impact = await fetch(`${base}/default/impact?connectionId=${second.id}`, { headers: headers(ownerToken, server.id) });
    assert.equal(impact.status, 200);
    assert.equal((await impact.json() as { agentsChangingNow: number }).agentsChangingNow, 1);

    const moved = await fetch(`${base}/default`, { method: "PUT", headers: headers(ownerToken, server.id), body: JSON.stringify({ connectionId: second.id }) });
    const movedBody = await moved.json() as { defaultConnectionId: string; previousDefaultConnectionId: string; connections: Array<{ id: string; isServerDefault: boolean }> };
    assert.equal(moved.status, 200);
    assert.equal(movedBody.defaultConnectionId, second.id);
    assert.equal(movedBody.previousDefaultConnectionId, first.id);
    assert.deepEqual(movedBody.connections.filter((c) => c.isServerDefault).map((c) => c.id), [second.id]);

    const removed = await fetch(`${base}/connections/${first.id}`, { method: "DELETE", headers: headers(ownerToken, server.id) });
    assert.equal(removed.status, 204);
    const again = await fetch(`${base}/connections/${first.id}`, { method: "DELETE", headers: headers(ownerToken, server.id) });
    assert.equal(again.status, 404);
  } finally {
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});

test("MCP Apps over HTTP: templates, probe and App writes are manager-only; PATCH refuses foreign sections", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser(`mcp-apps-owner-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-apps-member-${randomUUID()}@slock.test`);
    const server = await createServer("Apps", `apps-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id, "member");
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}) => fetch(`${app.baseUrl}/api/mcp${path}`, {
      method: init.method ?? "GET",
      headers: headers(token, server.id),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    await getDb().update(mcpAppTemplates).set({ endpointUrl: "https://fixture-user@mcp.example.test/mcp" })
      .where(eq(mcpAppTemplates.key, "atlassian"));
    const templates = await api(ownerToken, "/app-templates");
    assert.equal(templates.status, 200);
    const templateBody = await templates.json() as { templates: Array<{ key: string; endpointUrl: string; maintainedByRaft: boolean; installed: boolean }> };
    assert.deepEqual(templateBody.templates.map((template) => template.key), (await listMcpAppTemplates()).map((template) => template.key));
    assert.ok(templateBody.templates.every((template) => template.maintainedByRaft));
    assert.ok(templateBody.templates.every((template) => template.installed === false), "nothing installed yet");
    assert.equal(templateBody.templates.some((template) => template.key === "atlassian"), false, "an unusable endpoint is not offered");
    assert.equal((await api(memberToken, "/app-templates")).status, 403);

    assert.equal((await api(memberToken, "/probe", { method: "POST", body: { endpointUrl: "https://example.com/mcp" } })).status, 403);
    const blocked = await api(ownerToken, "/probe", { method: "POST", body: { endpointUrl: "https://127.0.0.1/mcp" } });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json() as { code: string }).code, "managed_mcp_endpoint_blocked");

    assert.equal((await api(memberToken, "/apps", { method: "POST", body: { source: { kind: "template", templateKey: "linear" }, profile: { name: "Linear" } } })).status, 403);
    const locked = await api(ownerToken, "/apps", { method: "POST", body: { source: { kind: "template", templateKey: "linear", endpointUrl: "https://evil.example.test/mcp" }, profile: { name: "Linear" } } });
    assert.equal(locked.status, 409);
    assert.equal((await locked.json() as { code: string }).code, "managed_mcp_template_field_locked");
    const created = await api(ownerToken, "/apps", { method: "POST", body: { source: { kind: "template", templateKey: "linear" }, profile: { name: "Linear" } } });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    // The picker needs a marker for Apps the server already has: installed templates annotate so.
    const after = await api(ownerToken, "/app-templates");
    const afterBody = await after.json() as { templates: Array<{ key: string; installed: boolean }> };
    assert.equal(afterBody.templates.find((template) => template.key === "linear")?.installed, true);
    assert.equal(afterBody.templates.find((template) => template.key === "notion")?.installed, false);
    const view = JSON.parse(createdText) as { id: string; server: { endpointUrl: string } };
    assert.equal(view.server.endpointUrl, "https://mcp.linear.app/mcp");

    const listed = await api(memberToken, "/apps");
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { apps: Array<{ id: string; kind: string }> }).apps.map((item) => [item.id, item.kind]), [[view.id, "mcp"]]);
    assert.equal((await api(memberToken, `/apps/${view.id}`)).status, 200);

    // RAFT_PRIVACY_MODE: a Raft template's logo is the web's own /app-logos/ copy, never
    // app.raft.build; off: the stored URL as is.
    const logos = async () => ({
      template: (await (await api(ownerToken, "/app-templates")).json() as { templates: Array<{ key: string; logoUrl: string | null }> })
        .templates.find((template) => template.key === "linear")?.logoUrl,
      list: (await (await api(memberToken, "/apps")).json() as { apps: Array<{ logoUrl: string | null }> }).apps[0]?.logoUrl,
      detail: (await (await api(memberToken, `/apps/${view.id}`)).json() as { profile: { logoUrl: string | null } }).profile.logoUrl,
    });
    assert.deepEqual(await logos(), {
      template: "https://app.raft.build/app-logos/linear.svg",
      list: "https://app.raft.build/app-logos/linear.svg",
      detail: "https://app.raft.build/app-logos/linear.svg",
    });
    setPrivacyModeForTest(true);
    try {
      assert.deepEqual(await logos(), { template: "/app-logos/linear.svg", list: "/app-logos/linear.svg", detail: "/app-logos/linear.svg" });
    } finally {
      setPrivacyModeForTest(false);
    }

    const foreign = await api(ownerToken, `/apps/${view.id}`, { method: "PATCH", body: { returnUrl: "https://x.example.test/cb" } });
    assert.equal(foreign.status, 400);
    assert.equal((await foreign.json() as { code: string }).code, "managed_mcp_app_section_not_supported");
    const moved = await api(ownerToken, `/apps/${view.id}`, { method: "PATCH", body: { endpointUrl: "https://evil.example.test/mcp" } });
    assert.equal(moved.status, 409);
    assert.equal((await moved.json() as { code: string }).code, "managed_mcp_template_field_locked");
    assert.equal((await api(memberToken, `/apps/${view.id}`, { method: "PATCH", body: { profile: { name: "Mine" } } })).status, 403);

    assert.equal((await api(memberToken, `/apps/${view.id}`, { method: "DELETE" })).status, 403);
    assert.equal((await api(ownerToken, `/apps/${view.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await api(ownerToken, `/apps/${view.id}`)).status, 404);

    // The probe has its own rate limit on top of the capability gate.
    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const res = await api(ownerToken, "/probe", { method: "POST", body: { endpointUrl: "https://127.0.0.1/mcp" } });
      limited = res.status === 429;
    }
    assert.ok(limited, "the probe is rate-limited");
  } finally {
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});

test("⭐ creating a URL App and refreshing an App spend the same outbound budget as the probe", async () => {
  const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser(`mcp-budget-owner-${randomUUID()}@slock.test`);
    const server = await createServer("Budget", `budget-${randomUUID()}`, owner.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    const api = (path: string, init: { method?: string; body?: unknown } = {}) => fetch(`${app.baseUrl}/api/mcp${path}`, {
      method: init.method ?? "GET",
      headers: headers(ownerToken, server.id),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const created = await api("/apps", { method: "POST", body: { source: { kind: "template", templateKey: "linear" }, profile: { name: "Linear" } } });
    assert.equal(created.status, 201);
    const appId = (await created.json() as { id: string }).id;

    // Spend the budget through the probe (blocked URLs are refused before any I/O but still count).
    let probes = 0;
    while (probes < 20 && (await api("/probe", { method: "POST", body: { endpointUrl: "https://127.0.0.1/mcp" } })).status !== 429) probes += 1;
    assert.ok(probes < 20, "the probe is rate-limited");

    const urlCreate = await api("/apps", { method: "POST", body: { source: { kind: "url", endpointUrl: "https://127.0.0.1/mcp" }, profile: { name: "Pasted" } } });
    assert.equal(urlCreate.status, 429, "⭐ a URL-source create shares the probe's budget");
    assert.equal((await urlCreate.json() as { code: string }).code, "managed_mcp_probe_rate_limited");
    assert.equal((await api(`/apps/${appId}/refresh`, { method: "POST" })).status, 429, "⭐ so does refresh");
    const templateCreate = await api("/apps", { method: "POST", body: { source: { kind: "template", templateKey: "notion" }, profile: { name: "Notion" } } });
    assert.equal(templateCreate.status, 201, "a template create makes no outbound call and is not limited");
  } finally {
    await app.close();
    if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
  }
});

/**
 * Granting, revoking or choosing an MCP App's Connection for one Agent follows the ordinary App
 * grant rule (`canManageAgentAccess`): the Agent's creator, or someone with manageExternalAuth.
 */
test("⭐ an MCP App is granted or revoked for an Agent by its creator or someone who manages external auth", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser(`mcp-grant-owner-${randomUUID()}@slock.test`);
    const admin = await seedUser(`mcp-grant-admin-${randomUUID()}@slock.test`);
    const creator = await seedUser(`mcp-grant-creator-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-grant-member-${randomUUID()}@slock.test`);
    const server = await createServer("Grant gate", `grant-gate-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await addMember(server.id, creator.id, "member");
    await addMember(server.id, member.id, "member");
    const agent = await createAgent(server.id, "grant-gate-agent", { creatorType: "user", creatorId: creator.id });
    const [mcpApp] = await getDb().insert(managedMcpServers).values({
      serverId: server.id, name: "Open", endpointUrl: "https://open.example.test/mcp", authMode: "none", sourceKind: "url", createdByUserId: owner.id,
    }).returning();
    const put = async (email: string, body: unknown, path = `/assignments/${mcpApp.id}`) => {
      const token = await login(app.baseUrl, email);
      const res = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}${path}`, { method: "PUT", headers: headers(token, server.id), body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as { error?: string; code?: string } };
    };
    const enabled = async () => (await getDb().select().from(managedMcpAssignments).where(eq(managedMcpAssignments.agentId, agent.id)))[0]?.enabled;

    // A member who did not create the Agent: refused, both routes, nothing written.
    const denied = await put(member.email, { enabled: false });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "manageExternalAuth capability or agent creator authority required");
    assert.equal((await put(member.email, { assignments: [{ mcpServerId: mcpApp.id, enabled: false }] }, "/assignments")).status, 403);
    assert.equal(await enabled(), undefined);

    // The Agent's creator (a plain member) may revoke and grant again.
    assert.equal((await put(creator.email, { enabled: false })).status, 200);
    assert.equal(await enabled(), false);
    assert.equal((await put(creator.email, { enabled: true })).status, 200);
    assert.equal(await enabled(), true);

    // An admin (manageExternalAuth) may too, on someone else's Agent, through either route.
    assert.equal((await put(admin.email, { assignments: [{ mcpServerId: mcpApp.id, enabled: false }] }, "/assignments")).status, 200);
    assert.equal(await enabled(), false);
  } finally {
    await app.close();
  }
});

const ONE_BY_ONE_GIF = Buffer.from("R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");

/** An MCP App's logo works like an ordinary App's: same upload, same storage, same public URL. */
test("⭐ POST and DELETE /api/mcp/apps/:appId/logo manage an MCP App's logo like an ordinary App's", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser(`mcp-logo-owner-${randomUUID()}@slock.test`);
    const member = await seedUser(`mcp-logo-member-${randomUUID()}@slock.test`);
    const otherOwner = await seedUser(`mcp-logo-other-${randomUUID()}@slock.test`);
    const server = await createServer("MCP logo", `mcp-logo-${randomUUID()}`, owner.id);
    const otherServer = await createServer("MCP logo other", `mcp-logo-other-${randomUUID()}`, otherOwner.id);
    await addMember(server.id, member.id, "member");
    const [mcpApp] = await getDb().insert(managedMcpServers).values({
      serverId: server.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp", authMode: "none", sourceKind: "url", createdByUserId: owner.id,
    }).returning();
    const [templateApp] = await getDb().insert(managedMcpServers).values({
      serverId: server.id, name: "Linear", endpointUrl: "https://mcp.linear.app/mcp", authMode: "oauth", provider: "linear",
      sourceKind: "template", templateKey: "linear", createdByUserId: owner.id,
    }).returning();
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    const otherToken = await login(app.baseUrl, otherOwner.email);
    const upload = (token: string, serverId: string, appId: string, file: Blob = new Blob([ONE_BY_ONE_GIF], { type: "image/gif" })) => {
      const formData = new FormData();
      formData.set("logo", file, "logo.gif");
      return fetch(`${app.baseUrl}/api/mcp/apps/${appId}/logo`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId }, body: formData,
      });
    };
    const clear = (token: string, appId: string) => fetch(`${app.baseUrl}/api/mcp/apps/${appId}/logo`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });

    assert.equal((await upload(memberToken, server.id, mcpApp.id)).status, 403, "a member does not manage Apps");
    assert.equal((await upload(otherToken, otherServer.id, mcpApp.id)).status, 404, "another server's App is not found");
    const badFormat = await upload(ownerToken, server.id, mcpApp.id, new Blob(["not an image"], { type: "text/plain" }));
    assert.equal(badFormat.status, 400, "the ordinary App logo formats only");

    const uploaded = await upload(ownerToken, server.id, mcpApp.id);
    assert.equal(uploaded.status, 200);
    const view = await uploaded.json() as { id: string; profile: { logoUrl: string | null } };
    assert.match(view.profile.logoUrl ?? "", new RegExp(`^/api/integration-logos/${mcpApp.id}/[0-9a-f]{32}\\.webp$`));
    assert.ok(!JSON.stringify(view).includes("logoStorageKey"), "the storage key is never returned");
    const served = await fetch(`${app.baseUrl}${view.profile.logoUrl}`);
    assert.equal(served.status, 200, "served by the same public logo route as an ordinary App");
    assert.equal(served.headers.get("content-type"), "image/webp");

    const listed = await fetch(`${app.baseUrl}/api/mcp/apps`, { headers: headers(memberToken, server.id) });
    const listedApp = (await listed.json() as { apps: Array<{ id: string; logoUrl: string | null }> }).apps.find((item) => item.id === mcpApp.id);
    assert.equal(listedApp?.logoUrl, view.profile.logoUrl, "the App lists show it");

    assert.equal((await clear(memberToken, mcpApp.id)).status, 403);
    const cleared = await clear(ownerToken, mcpApp.id);
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as { profile: { logoUrl: string | null } }).profile.logoUrl, null);
    assert.equal((await fetch(`${app.baseUrl}${view.profile.logoUrl}`)).status, 404, "the old file is no longer served");

    // A Raft template's App goes back to the template's own logo.
    assert.equal((await upload(ownerToken, server.id, templateApp.id)).status, 200);
    const reset = await (await clear(ownerToken, templateApp.id)).json() as { profile: { logoUrl: string | null } };
    assert.equal(reset.profile.logoUrl, (await findMcpAppTemplate("linear"))?.logoUrl ?? null, "the template's own logo");
  } finally {
    await app.close();
  }
});
