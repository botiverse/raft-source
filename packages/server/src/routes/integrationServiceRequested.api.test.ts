// integration_service_requested (AppFather, 2026-11-15): which services agents ask for that the
// server cannot give them. The event is added next to answers that must stay exactly as they were.
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { getDb } from "../db/index";
import { managedMcpServers, oauthClients, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { recordServiceNotOfferedUnlessMcpApp, recordUnresolvedServiceLookup } from "../services/integrationServiceRequested";
import * as oauthService from "../services/oauthService";
import { createOAuthClient } from "../services/oauthService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function memoryProductEventSink() {
  const rows: ProductEventRow[] = [];
  return {
    rows,
    sink: {
      enqueue(batch: readonly ProductEventRow[]) {
        rows.push(...batch.filter((row) => row.event === "integration_service_requested"));
      },
      async flush() {},
    } satisfies ProductEventSink,
  };
}

/** The event is written after the response: wait for `count` rows, then a little longer for strays. */
async function settle(rows: readonly ProductEventRow[], count: number): Promise<void> {
  for (let i = 0; i < 200 && rows.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function seed() {
  const suffix = randomUUID();
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `svc-req-${suffix}@slock.test`, name: `svc-req-${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const server = await createServer("Service requests", `svc-req-${suffix}`, user!.id);
  const agent = await createAgent(server.id, `SvcReq${suffix.slice(0, 6)}`);
  const [mcpApp] = await db.insert(managedMcpServers).values({
    // No recorded creator: vouched, as migration 0732 does for legacy Apps (fail-closed rule).
    serverVouchedAt: new Date(),
    serverId: server.id, name: "Team Notion", endpointUrl: "https://notion.example.test/mcp", authMode: "none",
    toolCatalog: [{ name: "search", inputSchema: { type: "object" as const } }], catalogVersion: 1,
  }).returning();
  const publisher = await createServer("Publisher", `svc-req-pub-${suffix}`, user!.id);
  const { client } = await createOAuthClient({
    serverId: publisher.id, createdByUserId: user!.id, clientId: `market-${suffix.slice(0, 8)}`,
    appType: "third_party_global", name: `Market ${suffix.slice(0, 8)}`, returnUrl: "https://market.example.test/callback",
  });
  await db.update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true }).where(eq(oauthClients.id, client.id));
  const key = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "read", issuedVia: "computer", createdByUserId: null });
  const headers = { Authorization: `Bearer ${key.apiKey}`, "Content-Type": "application/json" };
  return { serverId: server.id, agentId: agent.id, mcpApp: mcpApp!, marketKey: client.clientId, headers };
}

test("login: a name nothing answers to is recorded as the listed service or `other`, once a day, and the answer is unchanged", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const f = await seed();
  const login = async (service: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, { method: "POST", headers: f.headers, body: JSON.stringify({ service }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  // Recording the event leaves the refusal as it is: the plain not-found.
  assert.deepEqual(await login("Google Mail"), { status: 404, body: { error: "Registered service not found", code: "service_not_found", errorCode: "service_not_found" } });
  assert.deepEqual(await login("gmail"), { status: 404, body: { error: "Registered service not found", code: "service_not_found", errorCode: "service_not_found" } }, "the same service again today");
  assert.deepEqual(await login("acme-internal-crm"), { status: 404, body: { error: "Registered service not found", code: "service_not_found", errorCode: "service_not_found" } });
  assert.deepEqual(await login("another-unlisted-thing"), { status: 404, body: { error: "Registered service not found", code: "service_not_found", errorCode: "service_not_found" } }, "a second unlisted name is the same `other`");
  // A public Marketplace app the server lacks.
  const install = await login(f.marketKey);
  assert.equal(install.status, 200);
  assert.equal(install.body.status, "install_required");
  // An MCP App on the server is not a missing service.
  assert.equal((await login("team notion")).body.errorCode, "INTEGRATION_MCP_APP_READY");
  // No service at all is a bad request, not a request for a service.
  assert.equal((await login("")).status, 400);

  await settle(store.rows, 3);
  assert.deepEqual(store.rows.map((row) => [row.source, row.server_id, row.analytics_id, row.properties]), [
    ["server", f.serverId, null, { service: "gmail", outcome: "not_offered", command: "login" }],
    ["server", f.serverId, null, { service: "other", outcome: "not_offered", command: "login" }],
    ["server", f.serverId, null, { service: "other", outcome: "not_installed", command: "login" }],
  ]);
  assert.equal(JSON.stringify(store.rows).includes("acme"), false, "what the agent typed is not on any row");
});

test("lookup: `--service` on the list records the same way and still answers resolvedServiceId null", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const f = await seed();
  const lookup = async (service: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations?service=${encodeURIComponent(service)}`, { headers: f.headers });
    assert.equal(res.status, 200);
    return (await res.json() as { resolvedServiceId?: string | null }).resolvedServiceId;
  };

  assert.equal(await lookup("slack"), null);
  assert.equal(await lookup("Slack"), null, "again today");
  assert.equal(await lookup(f.marketKey), null);
  assert.equal(await lookup("Team Notion"), null, "an MCP App here: the lookup has no id for it, and it is not missing");
  assert.equal(await lookup(f.mcpApp.id), null);

  await settle(store.rows, 2);
  assert.deepEqual(store.rows.map((row) => row.properties).sort((a, b) => String(a.outcome).localeCompare(String(b.outcome))), [
    { service: "other", outcome: "not_installed", command: "lookup" },
    { service: "slack", outcome: "not_offered", command: "lookup" },
  ]);
  // A plain list asks for nothing.
  const before = store.rows.length;
  assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/integrations`, { headers: f.headers })).status, 200);
  await settle(store.rows, before + 1);
  assert.equal(store.rows.length, before);
});

test("a server that turned product analytics off records nothing; the older login route skips an MCP App's name", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const f = await seed();
  const input = { serverId: f.serverId, agentId: f.agentId, clientKeyMatched: false, command: "login" as const };

  await recordServiceNotOfferedUnlessMcpApp(store.sink, { ...input, rawService: "Team Notion" });
  assert.equal(store.rows.length, 0, "the name is one of this agent's MCP Apps");
  await recordServiceNotOfferedUnlessMcpApp(store.sink, { ...input, rawService: "figma" });
  assert.deepEqual(store.rows.map((row) => row.properties), [{ service: "figma", outcome: "not_offered", command: "login" }]);

  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, f.serverId));
  const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, { method: "POST", headers: f.headers, body: JSON.stringify({ service: "jira" }) });
  assert.deepEqual([res.status, await res.json()], [404, { error: "Registered service not found", code: "service_not_found", errorCode: "service_not_found" }]);
  await settle(store.rows, 2);
  assert.equal(store.rows.length, 1, "nothing for the opted-out server");
});

test("a repeated lookup skips the classifier's reads once today's row exists; an MCP App's name never blocks a later one", async ({ app }) => {
  assert.ok(app.baseUrl, "the fixture brings the database up");
  const store = memoryProductEventSink();
  const f = await seed();
  const suspendedReads = vi.spyOn(oauthService, "listSuspendedThirdPartyOAuthClients");
  const marketplaceReads = vi.spyOn(oauthService, "listPublicMarketplaceOAuthClients");
  try {
    const lookup = (rawService: string) => recordUnresolvedServiceLookup(store.sink, {
      serverId: f.serverId, agentId: f.agentId, rawService, clientKeyMatched: false,
      mcpApps: [{ type: "mcp", id: f.mcpApp.id, name: "Team Notion" } as never],
    });
    // The agent's own MCP App: one read, no row, and nothing kept that could block a later name.
    await lookup("Team Notion");
    assert.deepEqual([suspendedReads.mock.calls.length, marketplaceReads.mock.calls.length, store.rows.length], [1, 0, 0]);
    await lookup("acme-internal-crm");
    assert.deepEqual([suspendedReads.mock.calls.length, marketplaceReads.mock.calls.length], [2, 1]);
    assert.deepEqual(store.rows.map((row) => row.properties), [{ service: "other", outcome: "not_offered", command: "lookup" }]);
    // The retry, and another unlisted name: no reads, no second row.
    await lookup("acme-internal-crm");
    await lookup("another-unlisted-thing");
    assert.deepEqual([suspendedReads.mock.calls.length, marketplaceReads.mock.calls.length, store.rows.length], [2, 1, 1]);
    // A listed service has its own key.
    await lookup("slack");
    await lookup("Slack");
    assert.deepEqual([suspendedReads.mock.calls.length, marketplaceReads.mock.calls.length], [3, 2]);
    assert.deepEqual(store.rows.map((row) => row.properties.service), ["other", "slack"]);
  } finally {
    suspendedReads.mockRestore();
    marketplaceReads.mockRestore();
  }
});
