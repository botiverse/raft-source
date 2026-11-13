import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { actionCards, agents, channelAgents, channels, managedMcpAssignments, managedMcpCredentials, managedMcpServers, messages, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __setMcpConnectionCardProducerForTests, ensureMcpConnectionCard, resolveOpenMcpConnectionCard } from "../services/managedMcpConnectionCardService";
import { sendManagedMcpAgentApiError } from "./internalAgentApi";
import { ManagedMcpGatewayError } from "../services/managedMcpGateway";
import { ManagedMcpServiceError } from "../services/managedMcpService";
import { MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE } from "../services/managedMcpConnectionOwnership";
import { createServer } from "../services/serverService";
import { setPrivacyModeForTest } from "../config/privacyMode";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
  const mcpKey = await mintAgentCredential({ agentId: agent.id, scopes: ["mcp"], name: "mcp-test", issuedVia: "computer", createdByUserId: null });
  const readKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "read-test", issuedVia: "computer", createdByUserId: null });
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
  // The App's one tool, then the three Raft Apps tools every snapshot carries.
  assert.deepEqual(body.tools.map((tool) => tool.toolName), ["search", "raft_apps_list", "raft_app_tools", "raft_app_call"]);
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

// Managed MCP is the operator's own traffic (their server to the MCP services they connected),
// so RAFT_PRIVACY_MODE leaves it on: the catalog is served as with it off.
test("RAFT_PRIVACY_MODE: the managed MCP catalog is served unchanged", async ({ app }) => {
  const fixture = await seed();
  const headers = { Authorization: `Bearer ${fixture.mcpKey}`, "X-Slock-Agent-Active-Capabilities": "mcp" };
  const off = await (await fetch(`${app.baseUrl}/internal/agent-api/mcp/tools`, { headers })).json();
  setPrivacyModeForTest(true);
  try {
    const on = await fetch(`${app.baseUrl}/internal/agent-api/mcp/tools`, { headers });
    assert.equal(on.status, 200);
    const body = await on.json() as { tools: Array<{ toolName: string }> };
    assert.deepEqual(body, off);
    assert.equal(body.tools[0]?.toolName, "search");
  } finally {
    setPrivacyModeForTest(false);
  }
});

/**
 * ⭐ "A real refusal raises a card" — driven from the REAL agent-API route (task #21, @Huarong).
 *
 * `ensureMcpConnectionCard()` shipped with a definition, tests, and NO non-test caller. Every
 * producer test called the service directly and every DOM test started from a hand-made card, so
 * the one join that mattered — an actual Agent MCP call being refused, and a card appearing — was
 * unreachable in the product and invisible to the suite. These drive the HTTP route.
 */
async function registrySeed() {
  const suffix = randomUUID();
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `mcp-card-${suffix}@slock.test`,
    name: `mcp-card-${suffix}`,
    displayName: "Card Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP Card", `mcp-card-${suffix}`, user.id);
  const agent = await createAgent(server.id, `CardAgent${suffix.slice(0, 6)}`);
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `c-${suffix.slice(0, 8)}` }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [msg] = await db.insert(messages).values({
    channelId: channel.id, senderType: "agent", senderId: agent.id, content: "turn",
  }).returning();
  // Registry-managed, enabled, catalogued — so the ONLY thing missing is an authorized Connection.
  const [mcp] = await db.insert(managedMcpServers).values({
    serverId: server.id,
    name: "Registry Docs",
    endpointUrl: "https://registry-docs.example.test/mcp",
    enabled: true,
    sourceKind: "url",
    authMode: "headers",
    requiredHeaderNames: ["X-Api-Key"],
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }],
    catalogVersion: 1,
  }).returning();
  const key = await mintAgentCredential({ agentId: agent.id, scopes: ["mcp"], name: "mcp", issuedVia: "computer", createdByUserId: null });
  return { apiKey: key.apiKey, serverId: server.id, agentId: agent.id, userId: user.id, mcpServerId: mcp.id, msgId: msg.id, configVersion: mcp.configVersion };
}

async function cardsFor(agentId: string) {
  return getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, agentId));
}

async function callTool(app: { baseUrl: string }, apiKey: string, body: Record<string, unknown>) {
  return fetch(`${app.baseUrl}/internal/agent-api/mcp/call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("agent-api: a refused MCP call with a real origin raises exactly one card, and a retry reuses it", async ({ app }) => {
  const f = await registrySeed();
  const body = {
    mcpServerId: f.mcpServerId,
    toolName: "search",
    arguments: {},
    expectedConfigVersion: f.configVersion,
    expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  };

  assert.deepEqual(await cardsFor(f.agentId), [], "no card before the first refusal");

  const first = await callTool(app, f.apiKey, body);
  assert.equal(first.status, 409);
  const firstBody = await first.json() as { code?: string; connectionRequested?: boolean };
  assert.equal(firstBody.code, "managed_mcp_login_required");
  assert.equal(firstBody.connectionRequested, true, "the runtime may say a request is waiting only when one is");
  const afterFirst = await cardsFor(f.agentId);
  assert.equal(afterFirst.length, 1, "⭐ a real refused call must raise a card — this is the join that was missing");
  assert.equal(afterFirst[0].actionType, "integration:connect_mcp");

  // A tool call can repeat every few seconds. The refusal must stay a refusal and NOT post again.
  const second = await callTool(app, f.apiKey, body);
  assert.equal(second.status, 409);
  assert.equal(
    (await second.json() as { connectionRequested?: boolean }).connectionRequested, true,
    "a reused open card is still a request waiting for a human",
  );
  assert.equal(
    (await cardsFor(f.agentId)).length, 1,
    "a retry must reuse the open card rather than posting a second message",
  );
});

test("a connect card's title names the App and the Agent by display name; the row keeps ids only, and the done card keeps the names", async ({ app }) => {
  const f = await registrySeed();
  await getDb().update(agents).set({ displayName: "Kai" }).where(eq(agents.id, f.agentId));
  const refused = await callTool(app, f.apiKey, {
    mcpServerId: f.mcpServerId,
    toolName: "search",
    arguments: {},
    expectedConfigVersion: f.configVersion,
    expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  });
  assert.equal(refused.status, 409);
  const [card] = await cardsFor(f.agentId);
  assert.deepEqual(
    card.payload,
    { type: "integration:connect_mcp", mcpServerId: f.mcpServerId, agentId: f.agentId, reason: "login_required", revision: f.configVersion },
    "⭐ the durable row stays ids only: the names are on the card as shown",
  );

  type Stored = { state: string; action: unknown; presentation: { card: { title: { key: string; params?: unknown }; result?: { elements: Record<string, { props: { text: { params: unknown } } }> } } } };
  const stored = async () => {
    const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, card.messageId));
    return row.actionMetadata as unknown as Stored;
  };
  const named = { key: "actionCard.title.connectMcp", params: { app: "Registry Docs", agent: { kind: "agent", id: f.agentId, fallback: "Kai" } } };
  const prepared = await stored();
  assert.deepEqual(prepared.action, card.payload);
  const { key, params } = prepared.presentation.card.title;
  assert.deepEqual({ key, params }, named);

  // Closed by a grant made elsewhere: the card is rebuilt from what it shows, whatever the App is called by then.
  await getDb().update(managedMcpServers).set({ name: "Renamed Docs" }).where(eq(managedMcpServers.id, f.mcpServerId));
  await resolveOpenMcpConnectionCard(getDb(), { serverId: f.serverId, agentId: f.agentId, mcpServerId: f.mcpServerId, userId: f.userId, authorized: true });
  const done = await stored();
  assert.equal(done.state, "executed");
  const doneTitle = done.presentation.card.title;
  assert.deepEqual({ key: doneTitle.key, params: doneTitle.params }, named);
  assert.deepEqual(done.presentation.card.result?.elements.summary?.props.text.params, { agent: named.params.agent }, "the done line's Agent keeps its name for a peer server's copy");
});

test("a connect card for an App this server doesn't have, or an agent with no display name, still posts: the fixed title, or its name", async ({ app }) => {
  const f = await registrySeed();
  await getDb().update(agents).set({ displayName: null }).where(eq(agents.id, f.agentId));
  const [{ name: agentName }] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, f.agentId));
  const titleOf = async () => {
    const [card] = await cardsFor(f.agentId);
    const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, card.messageId));
    return (row.actionMetadata as unknown as { presentation: { card: { title: { key: string; params?: { agent?: { fallback?: string } } } } } }).presentation.card.title;
  };
  const body = {
    mcpServerId: f.mcpServerId,
    toolName: "search",
    arguments: {},
    expectedConfigVersion: f.configVersion,
    expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  };
  await callTool(app, f.apiKey, body);
  assert.equal((await titleOf()).params?.agent?.fallback, agentName);

  const other = await registrySeed();
  const card = await ensureMcpConnectionCard({ serverId: f.serverId, agentId: f.agentId, mcpServerId: other.mcpServerId, revision: 1, origin: { sourceMessageId: f.msgId } });
  assert.ok(card.cardMessageId);
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, card.cardMessageId));
  assert.equal((row.actionMetadata as unknown as { presentation: { card: { title: { key: string } } } }).presentation.card.title.key, "actionCard.verb.connectMcp", "⭐ another server's App is not named here");
});

test("agent-api: a refusal with no origin, or an origin the agent cannot claim, posts NO card", async ({ app }) => {
  const f = await registrySeed();
  const base = {
    mcpServerId: f.mcpServerId,
    toolName: "search",
    arguments: {},
    expectedConfigVersion: f.configVersion,
    expectedAssignmentVersion: 1,
  };

  // Background work: no originating turn at all.
  const noOrigin = await callTool(app, f.apiKey, base);
  assert.equal(noOrigin.status, 409);
  const noOriginBody = await noOrigin.json() as { code?: string; connectionRequested?: boolean };
  assert.equal(noOriginBody.code, "managed_mcp_login_required");
  assert.equal(
    noOriginBody.connectionRequested, false,
    "⭐ no card was raised, so the runtime must not tell the model one is waiting",
  );
  assert.deepEqual(await cardsFor(f.agentId), [], "⭐ background work is refused WITHOUT guessing a channel to post into");

  // A message id the acting Agent has no claim to — belongs to another server's conversation.
  const other = await registrySeed();
  const foreign = await callTool(app, f.apiKey, { ...base, origin: { sourceMessageId: other.msgId } });
  assert.equal(foreign.status, 409);
  assert.deepEqual(
    await cardsFor(f.agentId), [],
    "⭐ a caller-supplied origin that fails server-side validation is treated as absent, not obeyed",
  );
  assert.deepEqual(await cardsFor(other.agentId), [], "and it must not post into the other conversation either");
});

test("⭐ a tool restriction is NOT a connection problem: no card, and a different refusal code", async ({ app }) => {
  const f = await registrySeed();
  const db = getDb();
  // Authorized for this MCP, but only for "search". Asking for "write" is a tool restriction, and
  // no Connection can widen it.
  const [cred] = await db.insert(managedMcpCredentials).values({
    serverId: f.serverId, mcpServerId: f.mcpServerId, headerNames: ["X-Api-Key"],
    isServerDefault: true, authKind: "headers", authStatus: "ready",
  }).returning();
  await db.insert(managedMcpAssignments).values({
    serverId: f.serverId, agentId: f.agentId, mcpServerId: f.mcpServerId,
    enabled: true, allowedTools: ["search"], connectionMode: "pinned", boundConnectionId: cred.id,
  });

  const res = await callTool(app, f.apiKey, {
    mcpServerId: f.mcpServerId,
    toolName: "write",
    arguments: {},
    expectedConfigVersion: f.configVersion,
    expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  });
  assert.equal(res.status, 409);
  assert.equal(
    (await res.json() as { code?: string }).code,
    "managed_mcp_tool_not_allowed",
    "⭐ a tool restriction must not be reported as a missing Connection",
  );
  assert.deepEqual(
    await cardsFor(f.agentId), [],
    "⭐ and must raise NO Connect card: completing one would not widen allowedTools, so the card "
    + "would be 'resolved' without unblocking anything and regenerate on the next call",
  );
});

/**
 * ⚠️ The ordering case I reasoned about in a comment and then did not test (@Huarong).
 *
 * `executeManagedMcpCall` checks the tool allowlist BEFORE `enabled`, deliberately: when a call is
 * blocked by BOTH, the honest answer is the one a Connection cannot fix. The existing teeth only
 * cover `enabled: true` + restricted, so a future reordering would silently reopen the loop this
 * ordering exists to prevent — Connect card raised, "completed" against a valid Connection, retry
 * still refused by the allowlist, new card next call.
 */
test("official assignment BOTH disabled and tool-restricted still answers tool_not_allowed with no card", async ({ app }) => {
  const f = await registrySeed();
  const db = getDb();
  const [cred] = await db.insert(managedMcpCredentials).values({
    serverId: f.serverId, mcpServerId: f.mcpServerId, headerNames: ["X-Api-Key"],
    isServerDefault: true, authKind: "headers", authStatus: "ready",
  }).returning();
  // Disabled AND restricted. Either alone would refuse; only the ordering decides which answer.
  await db.insert(managedMcpAssignments).values({
    serverId: f.serverId, agentId: f.agentId, mcpServerId: f.mcpServerId,
    enabled: false, allowedTools: ["search"], connectionMode: "pinned", boundConnectionId: cred.id,
  });

  const res = await callTool(app, f.apiKey, {
    mcpServerId: f.mcpServerId,
    toolName: "write",
    arguments: {},
    expectedConfigVersion: f.configVersion,
    expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  });
  assert.equal(res.status, 409);
  assert.equal(
    (await res.json() as { code?: string }).code,
    "managed_mcp_tool_not_allowed",
    "⭐ blocked by both, the answer must be the one a Connection cannot fix — swap the order and this flips",
  );
  assert.deepEqual(
    await cardsFor(f.agentId), [],
    "⭐ and no Connect card: authorizing one would not widen allowedTools, so it could be completed without unblocking",
  );
});

/**
 * ⭐ Card production is best-effort; the REFUSAL is the contract (@Huarong, self-reported gap).
 *
 * The route swallows producer failures and rethrows the original error. With a direct import that
 * catch branch was unreachable from a route test, so it was implemented and never executed — which
 * by this week's standard is indistinguishable from an empty assertion.
 *
 * Two things must hold when the producer throws: the caller still gets `managed_mcp_login_required`
 * (a denial must never become a success because bookkeeping failed), and the caller does NOT get
 * the card-plumbing error instead (its own refusal must not be replaced by an unrelated one).
 */
test("⭐ when the card producer throws, the caller still gets the original login_required", async ({ app }) => {
  const f = await registrySeed();
  let called = 0;
  __setMcpConnectionCardProducerForTests(async () => {
    called += 1;
    throw new Error("card plumbing exploded");
  });
  try {
    const res = await callTool(app, f.apiKey, {
      mcpServerId: f.mcpServerId,
      toolName: "search",
      arguments: {},
      expectedConfigVersion: f.configVersion,
      expectedAssignmentVersion: 1,
      origin: { sourceMessageId: f.msgId },
    });
    assert.equal(called, 1, "the producer really was invoked, or this proves nothing");
    assert.equal(res.status, 409, "a failed card must not change the HTTP outcome");
    const body = await res.json() as { code?: string; error?: string; connectionRequested?: boolean };
    assert.equal(body.connectionRequested, false, "a card that failed to post is not a request");
    assert.equal(
      body.code, "managed_mcp_login_required",
      "⭐ the ORIGINAL refusal survives — bookkeeping failure must never turn a denial into a success",
    );
    assert.ok(
      !JSON.stringify(body).includes("card plumbing exploded"),
      "⭐ nor may the caller's refusal be replaced by the card-plumbing error",
    );
    assert.deepEqual(await cardsFor(f.agentId), [], "and no card exists, since production failed");
  } finally {
    __setMcpConnectionCardProducerForTests(null);
  }
});

async function snapshotOf(app: { baseUrl: string }, apiKey: string) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/mcp/tools`, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Slock-Agent-Active-Capabilities": "mcp" },
  });
  assert.equal(res.status, 200);
  return await res.json() as {
    tools: Array<{ mcpServerId: string; toolName: string; configVersion: number }>;
    unavailable?: Array<{ mcpServerId: string }>;
  };
}

async function snapshotTools(app: { baseUrl: string }, apiKey: string) {
  return (await snapshotOf(app, apiKey)).tools;
}

/**
 * ⭐ An App nobody has connected yet: its tools are visible to the Agent and the first call raises the
 * Connect card (yezizp, #wg-mcp b3f9feed default 1).
 *
 * Before: an OAuth App following a default that was not signed in offered no tools at all, and an App
 * that never had a Connection has no tool list to offer. The Agent had nothing to call, so nothing was
 * refused and nobody was ever asked to connect it.
 */
test("⭐ an App with no usable Connection is offered to the Agent, and the first call raises the card", async ({ app }) => {
  const f = await registrySeed();
  const db = getDb();
  // OAuth, never signed in, so its tools were never read.
  const [fresh] = await db.insert(managedMcpServers).values({
    serverId: f.serverId,
    name: "Fresh Notes",
    endpointUrl: "https://fresh-notes.example.test/mcp",
    enabled: true,
    sourceKind: "url",
    authMode: "oauth",
    oauthStatus: "disconnected",
    toolCatalog: [],
    catalogVersion: 0,
  }).returning();
  // OAuth with a known tool list whose default Connection's sign-in expired.
  const [expired] = await db.insert(managedMcpServers).values({
    serverId: f.serverId,
    name: "Expired Notes",
    endpointUrl: "https://expired-notes.example.test/mcp",
    enabled: true,
    sourceKind: "url",
    authMode: "oauth",
    oauthStatus: "error",
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
    catalogVersion: 1,
  }).returning();
  await db.insert(managedMcpCredentials).values({
    serverId: f.serverId, mcpServerId: expired.id, isServerDefault: true, authKind: "oauth", authStatus: "expired",
  });

  const tools = await snapshotTools(app, f.apiKey);
  assert.deepEqual(
    tools.filter((tool) => tool.mcpServerId === fresh.id).map((tool) => tool.toolName), [],
    "an App with no known tools has none of its own to offer (the Raft Apps tools reach it)",
  );
  assert.deepEqual(
    tools.filter((tool) => tool.mcpServerId === expired.id).map((tool) => tool.toolName), ["search"],
    "⭐ an OAuth App whose default is not signed in still offers its tools",
  );

  for (const target of [
    { id: fresh.id, toolName: "list_tools", arguments: {} },
    { id: fresh.id, toolName: "call_tool", arguments: { name: "anything" } },
    { id: expired.id, toolName: "search", arguments: {} },
    { id: expired.id, toolName: "call_tool", arguments: { name: "search" } },
  ]) {
    const res = await callTool(app, f.apiKey, {
      mcpServerId: target.id,
      toolName: target.toolName,
      arguments: target.arguments,
      expectedConfigVersion: 1,
      expectedAssignmentVersion: 1,
      origin: { sourceMessageId: f.msgId },
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string; connectionRequested?: boolean };
    assert.equal(body.code, "managed_mcp_login_required", `${target.toolName}: refused for want of a Connection`);
    assert.equal(body.connectionRequested, true, `${target.toolName}: and a card was raised`);
  }
  const cards = await cardsFor(f.agentId);
  assert.deepEqual(
    cards.map((card) => (card.payload as { mcpServerId?: string }).mcpServerId).sort(),
    [fresh.id, expired.id].sort(),
    "⭐ one Connect card per App, on the first call",
  );

  // ⭐ Connected after the session started: the session still knows only list_tools / call_tool,
  // and they keep working (the proxy looks each call up in the current snapshot).
  await db.insert(managedMcpCredentials).values({
    serverId: f.serverId, mcpServerId: fresh.id, isServerDefault: true, authKind: "oauth", authStatus: "ready",
  });
  await db.update(managedMcpServers).set({ oauthStatus: "connected", toolCatalog: [{ name: "notion-search", description: "Search", inputSchema: { type: "object" } }], catalogVersion: 1 })
    .where(eq(managedMcpServers.id, fresh.id));
  assert.deepEqual(
    (await snapshotTools(app, f.apiKey)).filter((tool) => tool.mcpServerId === fresh.id).map((tool) => tool.toolName),
    ["notion-search"],
    "the App's own tools, for a new session",
  );
  const listed = await callTool(app, f.apiKey, {
    mcpServerId: fresh.id, toolName: "list_tools", arguments: {}, expectedConfigVersion: 1, expectedAssignmentVersion: 1,
  });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json() as { isError?: boolean; structuredContent?: { tools?: Array<{ name: string }> } };
  assert.deepEqual(listedBody.structuredContent?.tools?.map((tool) => tool.name), ["notion-search"], "⭐ an earlier session's per-App list_tools returns the current catalogue");
  // A snapshot from before list_tools existed may still name the old stand-in: it answers like list_tools.
  const legacy = await callTool(app, f.apiKey, {
    mcpServerId: fresh.id, toolName: "request_connection", arguments: {}, expectedConfigVersion: 1, expectedAssignmentVersion: 1,
  });
  assert.equal(legacy.status, 200);
});

test("the per-App list_tools / call_tool of an earlier snapshot are refused for an App without auth, or an Agent limited to no tools", async ({ app }) => {
  const f = await registrySeed();
  const db = getDb();
  const [open] = await db.insert(managedMcpServers).values({
    serverId: f.serverId, name: "Open", endpointUrl: "https://open.example.test/mcp", enabled: true,
    sourceKind: "url", authMode: "none", toolCatalog: [], catalogVersion: 0,
  }).returning();
  const [limited] = await db.insert(managedMcpServers).values({
    serverId: f.serverId, name: "Limited", endpointUrl: "https://limited.example.test/mcp", enabled: true,
    sourceKind: "url", authMode: "oauth", oauthStatus: "disconnected", toolCatalog: [], catalogVersion: 0,
  }).returning();
  await db.insert(managedMcpAssignments).values({
    serverId: f.serverId, agentId: f.agentId, mcpServerId: limited.id, enabled: true, allowedTools: [],
  });
  const ids = new Set((await snapshotTools(app, f.apiKey)).map((tool) => tool.mcpServerId));
  assert.equal(ids.has(open.id), false, "an auth-less App needs no Connection to ask for");
  assert.equal(ids.has(limited.id), false, "an Agent limited to named tools is offered none");
  const res = await callTool(app, f.apiKey, {
    mcpServerId: limited.id, toolName: "list_tools", arguments: {}, expectedConfigVersion: 1, expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  });
  assert.equal((await res.json() as { code?: string }).code, "managed_mcp_tool_not_allowed", "nor may it call them");
  assert.deepEqual(await cardsFor(f.agentId), []);
});

test("⭐ an unreachable MCP server is a 503 that keeps its code, never a 502", () => {
  // A 502 body is replaced by Cloudflare's HTML error page before it reaches the daemon, which then
  // has no `code` and cannot tell the model that one later retry is reasonable.
  let status = 0;
  let body: unknown = null;
  const res = {
    status(code: number) { status = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as unknown as Parameters<typeof sendManagedMcpAgentApiError>[1];

  sendManagedMcpAgentApiError(new ManagedMcpGatewayError("MCP server could not be reached", "managed_mcp_unreachable"), res);

  assert.equal(status, 503);
  // The agent-facing words (managedMcpAgentErrors), also as suggestedNextAction for raft-sdk.
  const agentText = "This MCP connector can't be reached right now; try again in a minute, and if it keeps failing, tell the person who asked.";
  assert.deepEqual(body, { error: agentText, code: "managed_mcp_unreachable", suggestedNextAction: agentText });

  sendManagedMcpAgentApiError(new ManagedMcpGatewayError("blocked", "managed_mcp_endpoint_blocked"), res);
  assert.equal(status, 403);
  assert.deepEqual(body, {
    error: "This MCP connector was blocked by the server's network security check. Ask a server administrator to check its network or proxy settings; do not retry until this is resolved.",
    code: "managed_mcp_endpoint_blocked",
    suggestedNextAction: "This MCP connector was blocked by the server's network security check. Ask a server administrator to check its network or proxy settings; do not retry until this is resolved.",
  });
});

test("⭐ a call refused because the pinned Connection is someone else's tells the agent what fixes it, and stays login_required", () => {
  let status = 0;
  let body: unknown = null;
  const res = {
    status(code: number) { status = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as unknown as Parameters<typeof sendManagedMcpAgentApiError>[1];

  // As `executeManagedMcpCall` throws it for an unusable pin (`connectionRefusal`).
  sendManagedMcpAgentApiError(new ManagedMcpServiceError(MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE, "managed_mcp_login_required", true), res, { serverName: "Docs", isCall: true });

  assert.equal(status, 409);
  // Same code, so the runtime and the Connect card behave as for any login_required; its own words.
  assert.deepEqual(body, {
    error: MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE,
    code: "managed_mcp_login_required",
    suggestedNextAction: MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE,
    connectionRequested: false,
  });
});

test("agent-api managed MCP: a disconnected connector is listed as unavailable, and a stale call reads as an agent can act on", async ({ app }) => {
  const fixture = await seed();
  const headers = { Authorization: `Bearer ${fixture.mcpKey}`, "X-Slock-Agent-Active-Capabilities": "mcp", "Content-Type": "application/json" };
  const [docs] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, fixture.mcpServerId));
  const [notion] = await getDb().insert(managedMcpServers).values({
    serverId: docs!.serverId,
    name: "Notion",
    provider: "notion",
    authMode: "oauth",
    oauthStatus: "error",
    endpointUrl: "https://mcp.notion.com/mcp",
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
    catalogVersion: 1,
  }).returning();

  const tools = await fetch(`${app.baseUrl}/internal/agent-api/mcp/tools`, { headers });
  assert.equal(tools.status, 200);
  const body = await tools.json() as { tools: Array<{ serverName: string }>; unavailable?: unknown };
  // MCP Apps keep a not-connected App's tools offered (a call raises the Connect card); it is also listed apart.
  assert.ok(body.tools.some((t) => t.serverName === "Notion"), "the not-connected App's tools stay callable");
  assert.deepEqual(body.unavailable, [{ mcpServerId: notion!.id, serverName: "Notion", status: "reconnect_required" }], "survives response validation");

  const stale = await fetch(`${app.baseUrl}/internal/agent-api/mcp/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mcpServerId: fixture.mcpServerId, toolName: "search", arguments: {}, expectedConfigVersion: 999, expectedAssignmentVersion: 1 }),
  });
  assert.equal(stale.status, 409);
  const staleText = "\"search\" is no longer offered by \"Docs\"; don't call it again. If you still need it, tell the person who asked.";
  assert.deepEqual(await stale.json(), { code: "managed_mcp_config_stale", error: staleText, suggestedNextAction: staleText }, "raft-sdk shows suggestedNextAction");
});

/**
 * ⭐ Test env: an Agent started before the Notion App existed had zero managed tools, so nothing it
 * could call reached the App. The Raft Apps tools are on every snapshot; a refusal through them
 * raises the App's own Connect card.
 */
test("⭐ Raft Apps tools reach an App created after the session's snapshot, and raise that App's card", async ({ app }) => {
  const f = await registrySeed();
  const db = getDb();
  const before = await snapshotTools(app, f.apiKey);
  assert.deepEqual(before.filter((tool) => tool.mcpServerId === "7a17a995-0000-4000-8000-000000000000").map((tool) => tool.toolName), ["raft_apps_list", "raft_app_tools", "raft_app_call"]);

  // Created after that snapshot, never signed in.
  const [late] = await db.insert(managedMcpServers).values({
    serverId: f.serverId, name: "Late Notion", endpointUrl: "https://late-notion.example.test/mcp", enabled: true,
    sourceKind: "url", authMode: "oauth", oauthStatus: "disconnected", toolCatalog: [], catalogVersion: 0,
  }).returning();
  const raft = (toolName: string, args: Record<string, unknown>) => callTool(app, f.apiKey, {
    mcpServerId: "7a17a995-0000-4000-8000-000000000000", toolName, arguments: args, expectedConfigVersion: 1, expectedAssignmentVersion: 1,
    origin: { sourceMessageId: f.msgId },
  });
  const listed = await raft("raft_apps_list", {});
  assert.equal(listed.status, 200);
  assert.match((await listed.json() as { content: Array<{ text: string }> }).content[0]!.text, /"Late Notion" \(id [^)]+\): 0 tools; not connected for you yet: run `raft integration login --service/u);

  for (const [toolName, args] of [["raft_app_tools", { app: "Late Notion" }], ["raft_app_call", { app: late.id, name: "notion-search" }]] as const) {
    const res = await raft(toolName, args);
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string; connectionRequested?: boolean };
    assert.equal(body.code, "managed_mcp_login_required", `${toolName}: refused for want of a Connection`);
    assert.equal(body.connectionRequested, true, `${toolName}: and a card was raised`);
  }
  const cards = (await cardsFor(f.agentId)).map((card) => (card.payload as { mcpServerId?: string }).mcpServerId);
  assert.deepEqual(cards, [late.id], "⭐ one card, the App's own (never the reserved Raft Apps id)");

  // Connected afterwards: the same session lists its tools.
  await db.insert(managedMcpCredentials).values({ serverId: f.serverId, mcpServerId: late.id, isServerDefault: true, authKind: "oauth", authStatus: "ready" });
  await db.update(managedMcpServers).set({ oauthStatus: "connected", toolCatalog: [{ name: "notion-search", inputSchema: { type: "object" } }], catalogVersion: 1 })
    .where(eq(managedMcpServers.id, late.id));
  const tools = await raft("raft_app_tools", { app: "Late Notion" });
  assert.equal(tools.status, 200);
  assert.deepEqual((await tools.json() as { structuredContent?: { tools?: Array<{ name: string }> } }).structuredContent?.tools?.map((tool) => tool.name), ["notion-search"]);

  // An App this Agent lacks: told how to ask, and no card (connecting would not grant it).
  await db.insert(managedMcpAssignments).values({ serverId: f.serverId, agentId: f.agentId, mcpServerId: late.id, enabled: false })
    .onConflictDoUpdate({ target: [managedMcpAssignments.agentId, managedMcpAssignments.mcpServerId], set: { enabled: false } });
  const denied = await raft("raft_app_call", { app: "Late Notion", name: "notion-search" });
  const deniedBody = await denied.json() as { code?: string; error?: string };
  assert.equal(deniedBody.code, "managed_mcp_app_off");
  assert.match(deniedBody.error ?? "", /Ask a person for it: raft integration login --service/u);
});

test("an MCP refusal names its code on the request span, so a 503 splits by cause", () => {
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    status() { return this; },
    json() { return this; },
  } as unknown as Parameters<typeof sendManagedMcpAgentApiError>[1];

  sendManagedMcpAgentApiError(new ManagedMcpGatewayError("MCP server could not be reached", "managed_mcp_unreachable"), res);
  assert.equal(Object.values(locals).includes("managed_mcp_unreachable"), true);

  sendManagedMcpAgentApiError(new Error("unexpected"), res, { isCall: true });
  assert.equal(Object.values(locals).includes("managed_mcp_internal_error"), true);
});
