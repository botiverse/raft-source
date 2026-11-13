import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { AgentApiIntegrationListResponse } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { and, eq } from "drizzle-orm";
import { actionCards, agents, channelAgents, channelHumans, channels, inboxNotificationFacts, managedMcpAssignments, managedMcpServers, messages, oauthClientKeyAliases, oauthClients, users } from "../db/schema";
import { tokenForHuman } from "../test/integration/credentials";
import { createOAuthClient } from "../services/oauthService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { listAgentManagedMcpCatalog, setManagedMcpAssignment } from "../services/managedMcpService";
import { createServer } from "../services/serverService";

// MCP Apps and Agent Login Apps are all Raft Apps, of different types. `raft integration list` lists
// the MCP Apps an Agent has next to its Agent Login services, in their own `mcpApps` array (older
// CLIs ignore it), with the state the Agent's Apps tab shows. Login on an MCP App says what it is.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed() {
  const suffix = randomUUID();
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `integration-mcp-${suffix}@slock.test`,
    name: `integration-mcp-${suffix}`,
    displayName: "Integration MCP Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Integration MCP", `integration-mcp-${suffix}`, user.id);
  const agent = await createAgent(server.id, `IntMcp${suffix.slice(0, 6)}`);
  const tools = [{ name: "search", inputSchema: { type: "object" as const } }, { name: "write", inputSchema: { type: "object" as const } }];
  // No sign-in needed: ready, every tool.
  const [open] = await db.insert(managedMcpServers).values({
    serverId: server.id, name: "Open Docs", description: "Docs search", homepageUrl: "https://docs.example.test",
    endpointUrl: "https://open.example.test/mcp", authMode: "none", toolCatalog: tools, catalogVersion: 1,
  }).returning();
  // Needs a key nobody has entered: login_required; restricted to one tool for this Agent.
  const [keyed] = await db.insert(managedMcpServers).values({
    serverId: server.id, name: "Team Notion", endpointUrl: "https://notion.example.test/mcp",
    authMode: "headers", requiredHeaderNames: ["X-Api-Key"], toolCatalog: tools, catalogVersion: 1,
  }).returning();
  await db.insert(managedMcpAssignments).values({
    serverId: server.id, agentId: agent.id, mcpServerId: keyed.id, enabled: true, allowedTools: ["search"],
  });
  // Revoked for this Agent: not its App, not listed.
  const [revoked] = await db.insert(managedMcpServers).values({
    serverId: server.id, name: "Revoked Wiki", endpointUrl: "https://wiki.example.test/mcp",
    authMode: "none", toolCatalog: tools, catalogVersion: 1,
  }).returning();
  await db.insert(managedMcpAssignments).values({
    serverId: server.id, agentId: agent.id, mcpServerId: revoked.id, enabled: false,
  });
  // Switched off on the server: listed as disabled, so the Agent can say why its tools are missing.
  const [disabled] = await db.insert(managedMcpServers).values({
    serverId: server.id, name: "Paused Tracker", endpointUrl: "https://tracker.example.test/mcp",
    authMode: "none", enabled: false, toolCatalog: tools, catalogVersion: 1,
  }).returning();
  const key = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "read", issuedVia: "computer", createdByUserId: null });
  // A conversation the Agent is in, for `login --target`.
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `apps-${suffix.slice(0, 8)}` }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  return { apiKey: key.apiKey, serverId: server.id, agentId: agent.id, userId: user.id, open, keyed, revoked, disabled, channel };
}

function headers(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

test("⭐ integration list carries the MCP Apps this Agent has, typed mcp, with the Apps tab state", async ({ app }) => {
  const f = await seed();
  const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations`, { headers: headers(f.apiKey) });
  assert.equal(res.status, 200);
  const body = await res.json() as AgentApiIntegrationListResponse;

  assert.deepEqual(body.services, [], "MCP Apps are never rows in `services` (older CLIs render those as Agent Login)");
  assert.deepEqual(body.activeLogins, []);
  const byName = new Map((body.mcpApps ?? []).map((row) => [row.name, row]));
  assert.deepEqual([...byName.keys()].sort(), ["Open Docs", "Paused Tracker", "Revoked Wiki", "Team Notion"], "⭐ every App, including one this Agent lacks");
  assert.equal(byName.get("Revoked Wiki")?.grant, "revoked", "⭐ with whether this Agent has it");
  assert.equal(byName.get("Team Notion")?.grant, "granted");

  assert.deepEqual(byName.get("Open Docs"), {
    type: "mcp",
    id: f.open.id,
    name: "Open Docs",
    description: "Docs search",
    homepageUrl: "https://docs.example.test",
    state: "ready",
    access: "mcp_tools",
    toolCount: 2,
    toolNames: ["search", "write"],
    grant: "granted",
  });
  assert.equal(byName.get("Team Notion")?.state, "login_required");
  assert.deepEqual(byName.get("Team Notion")?.toolNames, ["search"], "only the tools this Agent may call");
  assert.equal(byName.get("Paused Tracker")?.state, "disabled");

  // The same answer as the Agent's Apps tab (one admission rule).
  const catalog = await listAgentManagedMcpCatalog(f.serverId, f.agentId);
  for (const row of body.mcpApps ?? []) {
    assert.equal(row.state, catalog.servers.find((server) => server.id === row.id)?.agentConnection?.status, `${row.name}: Apps tab state`);
  }
});

async function loginAs(app: { baseUrl: string }, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, { method: "POST", headers: headers(apiKey), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as { error: string; errorCode?: string; mcpApp?: { id: string; state: string; grant?: string }; actionCardMessageId?: string; reused?: boolean } };
}

async function openCards(agentId: string) {
  return (await getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, agentId)))
    .filter((card) => card.actionType === "integration:connect_mcp");
}

test("a reserved OAuth key never falls through to an MCP App with the same display name", async ({ app }) => {
  const f = await seed();
  const reservedKey = `reserved-${randomUUID().slice(0, 8)}`;
  await getDb().insert(oauthClientKeyAliases).values({ key: reservedKey, clientId: null, sourceServerId: f.serverId });
  await getDb().update(managedMcpServers).set({ name: reservedKey }).where(eq(managedMcpServers.id, f.open.id));
  const byId = await loginAs(app, f.apiKey, { service: f.open.id });
  assert.equal(byId.body.errorCode, "INTEGRATION_MCP_APP_READY", "the MCP App's own id still works");
  const ordinary = await loginAs(app, f.apiKey, { service: "PAUSED TRACKER" });
  assert.equal(ordinary.body.errorCode, "INTEGRATION_MCP_APP_DISABLED", "ordinary MCP names remain case insensitive");
  for (const service of [reservedKey, reservedKey.toUpperCase(), reservedKey[0].toUpperCase() + reservedKey.slice(1)]) {
    const refused = await loginAs(app, f.apiKey, { service, target: `#${f.channel.name}` });
    assert.deepEqual(refused, { status: 404, body: { error: "Registered service not found" } });
  }
  assert.deepEqual(await openCards(f.agentId), [], "no request is posted for a different App");
});

test("an unavailable OAuth key keeps its Marketplace identity instead of an MCP display name", async ({ app }) => {
  const f = await seed();
  const publisher = await createServer("Publisher", `publisher-${randomUUID()}`, f.userId);
  const { client } = await createOAuthClient({
    serverId: publisher.id, createdByUserId: f.userId, clientId: `market-${randomUUID().slice(0, 8)}`,
    appType: "third_party_global", name: "Marketplace App", returnUrl: "https://market.example.test/callback",
  });
  await getDb().update(oauthClients).set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true }).where(eq(oauthClients.id, client.id));
  await getDb().update(managedMcpServers).set({ name: client.clientId }).where(eq(managedMcpServers.id, f.open.id));
  for (const service of [client.clientId, client.clientId.toUpperCase(), client.clientId[0].toUpperCase() + client.clientId.slice(1)]) {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, {
      method: "POST", headers: headers(f.apiKey), body: JSON.stringify({ service }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string; service: { id: string } };
    assert.equal(body.status, "install_required");
    assert.equal(body.service.id, client.id);
  }
  assert.deepEqual(await openCards(f.agentId), []);
});

test("⭐ login on an MCP App that needs a connection posts its Connect card at --target, once", async ({ app }) => {
  const f = await seed();
  // No --target: like an ordinary login without one, nothing is posted and the message says how.
  const noTarget = await loginAs(app, f.apiKey, { service: "team notion" });
  assert.equal(noTarget.status, 409);
  assert.equal(noTarget.body.errorCode, "INTEGRATION_MCP_TARGET_REQUIRED");
  assert.match(noTarget.body.error, new RegExp(`raft integration login --service "${f.keyed.id}" --target <channel-or-thread>`, "u"));
  assert.deepEqual(await openCards(f.agentId), []);

  const posted = await loginAs(app, f.apiKey, { service: "team notion", target: `#${f.channel.name}` });
  assert.equal(posted.status, 409, "a non-2xx, so an older CLI prints the message instead of misreading it");
  assert.equal(posted.body.errorCode, "INTEGRATION_MCP_CONNECTION_REQUESTED");
  assert.equal(posted.body.reused, false);
  assert.match(posted.body.error, /A request card was posted to #[^ ]+ for a person who can connect it/u);
  const cards = await openCards(f.agentId);
  assert.equal(cards.length, 1, "⭐ the App's Connect card, the same one a refused tool call raises");
  assert.equal((cards[0].payload as { mcpServerId?: string }).mcpServerId, f.keyed.id);
  assert.equal(cards[0].messageId, posted.body.actionCardMessageId);

  const again = await loginAs(app, f.apiKey, { service: f.keyed.id, target: `#${f.channel.name}` });
  assert.equal(again.body.reused, true);
  assert.equal((await openCards(f.agentId)).length, 1, "⭐ deduped: one open card per Agent and App");

  // A conversation that does not resolve for this Agent is the ordinary login's not-found answer.
  const notVisible = await loginAs(app, f.apiKey, { service: "team notion", target: "#no-such-conversation" });
  assert.equal(notVisible.status, 404);
  assert.match(notVisible.body.error, /^Nothing you can post in matches /u);
});

test("⭐ login on an MCP App this Agent lacks asks for access; a person's grant resolves the card", async ({ app }) => {
  const f = await seed();
  const posted = await loginAs(app, f.apiKey, { service: "Revoked Wiki", target: `#${f.channel.name}` });
  assert.equal(posted.body.errorCode, "INTEGRATION_MCP_CONNECTION_REQUESTED");
  assert.equal(posted.body.mcpApp?.grant, "revoked");
  assert.match(posted.body.error, /for a person who can grant you access to it/u);
  const [card] = await openCards(f.agentId);
  assert.equal(card.state, "prepared");

  // The card's Grant writes enabled: true (a person's explicit choice re-enables a revoked App).
  await setManagedMcpAssignment({ serverId: f.serverId, userId: f.userId, agentId: f.agentId, mcpServerId: f.revoked.id, enabled: true, connectionId: null });
  const [after] = await openCards(f.agentId);
  assert.equal(after.state, "executed", "⭐ admitted now (admitFromRows), so the card closes");
  const ready = await loginAs(app, f.apiKey, { service: "Revoked Wiki" });
  assert.equal(ready.body.errorCode, "INTEGRATION_MCP_APP_READY");
});

type Delivery = { agentId: string; payload: Record<string, unknown> };

/** The orchestrator surface the result reply uses, recording who was woken with what. */
function recordDeliveries(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
  const deliverMessage = async (agentId: string, payload: Record<string, unknown>) => {
    deliveries.push({ agentId, payload });
    return { status: "queued", reason: "test" };
  };
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<{ agentId: string; message: Record<string, unknown> }>) =>
      batch.map(({ agentId, message }) => deliverMessage(agentId, message)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
    resetAgent: async () => {},
    applyAgentConfig: async () => "not_pushed",
  });
  return deliveries;
}

async function resultReplies(agentName: string) {
  return (await getDb().select().from(messages).where(eq(messages.systemSubtype, "action_card.result_reply")))
    .filter((row) => row.content.startsWith(`@${agentName} `));
}

/** The Agent that asked is told in the card's thread, unread for it, and woken with that reply. */
async function assertAgentTold(f: Awaited<ReturnType<typeof seed>>, cardMessageId: string, deliveries: Delivery[]) {
  const [agent] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, f.agentId));
  const replies = await resultReplies(agent!.name);
  assert.equal(replies.length, 1, "exactly one result reply");
  const reply = replies[0]!;
  const [thread] = await getDb().select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, cardMessageId)));
  assert.equal(reply.channelId, thread?.id, "in the card's thread");
  assert.match(reply.content, /your action card .* was executed by/u);
  assert.match(reply.content, new RegExp(cardMessageId.slice(0, 8), "u"));
  const [fact] = await getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, reply.id),
    eq(inboxNotificationFacts.receiverType, "agent"),
    eq(inboxNotificationFacts.receiverId, f.agentId),
  ));
  assert.equal(fact?.unreadEligible, true, "unread for the Agent: it wakes it");
  assert.ok(deliveries.some((delivery) => delivery.agentId === f.agentId && delivery.payload.message_id === reply.id), "the Agent is woken with the reply");
}

async function ownerHeaders(f: Awaited<ReturnType<typeof seed>>) {
  const [owner] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, f.userId));
  await getDb().insert(channelHumans).values({ channelId: f.channel.id, userId: f.userId }).onConflictDoNothing();
  return { Authorization: `Bearer ${await tokenForHuman(owner!.email)}`, "Content-Type": "application/json", "X-Server-Id": f.serverId };
}

test("⭐ the card's Grant (the assignment write) tells the Agent that asked, once: the card's mark-executed after it adds nothing (#triage:#170)", async ({ app }) => {
  const f = await seed();
  const deliveries = recordDeliveries(app.app);
  const posted = await loginAs(app, f.apiKey, { service: "Revoked Wiki", target: `#${f.channel.name}` });
  const cardMessageId = posted.body.actionCardMessageId!;
  assert.ok(cardMessageId);
  const owner = await ownerHeaders(f);

  // The card's Grant: the same assignment write the Apps tab makes. It closes the card.
  const granted = await fetch(`${app.baseUrl}/api/mcp/agents/${f.agentId}/assignments/${f.revoked.id}`, {
    method: "PUT", headers: owner, body: JSON.stringify({ enabled: true, connectionId: null }),
  });
  assert.equal(granted.status, 200, await granted.clone().text());
  const [card] = await openCards(f.agentId);
  assert.equal(card?.state, "executed");
  await assertAgentTold(f, cardMessageId, deliveries);

  // Then the card marks itself executed, as the web does after Grant: it finds the card done.
  const marked = await fetch(`${app.baseUrl}/api/actions/${cardMessageId}/mark-executed`, {
    method: "POST", headers: owner, body: JSON.stringify({ result: { kind: "mcp-connection", mcpServerId: f.revoked.id, agentId: f.agentId } }),
  });
  assert.equal(marked.status, 200, await marked.clone().text());
  const [agent] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal((await resultReplies(agent!.name)).length, 1, "still one reply");
});

test("⭐ granting from Settings (the bulk assignment write) also tells the Agent whose card it closes (#triage:#170)", async ({ app }) => {
  const f = await seed();
  const deliveries = recordDeliveries(app.app);
  const posted = await loginAs(app, f.apiKey, { service: "Revoked Wiki", target: `#${f.channel.name}` });
  const cardMessageId = posted.body.actionCardMessageId!;
  const owner = await ownerHeaders(f);
  const granted = await fetch(`${app.baseUrl}/api/mcp/agents/${f.agentId}/assignments`, {
    method: "PUT", headers: owner, body: JSON.stringify({ assignments: [{ mcpServerId: f.revoked.id, enabled: true }] }),
  });
  assert.equal(granted.status, 200, await granted.clone().text());
  const [card] = await openCards(f.agentId);
  assert.equal(card?.state, "executed");
  await assertAgentTold(f, cardMessageId, deliveries);
});

test("login on a ready or a disabled MCP App posts nothing and says why", async ({ app }) => {
  const f = await seed();
  const ready = await loginAs(app, f.apiKey, { service: f.open.id, target: `#${f.channel.name}` });
  assert.equal(ready.status, 409);
  assert.equal(ready.body.errorCode, "INTEGRATION_MCP_APP_READY");
  assert.match(ready.body.error, /already usable: call its MCP tools/u);
  const disabled = await loginAs(app, f.apiKey, { service: "Paused Tracker", target: `#${f.channel.name}` });
  assert.equal(disabled.body.errorCode, "INTEGRATION_MCP_APP_DISABLED");
  assert.match(disabled.body.error, /switched off on this Server/u);
  assert.deepEqual(await openCards(f.agentId), []);
  // A name that is no App at all stays the ordinary not-found.
  const unknown = await loginAs(app, f.apiKey, { service: "No Such App" });
  assert.equal(unknown.status, 404);
});
