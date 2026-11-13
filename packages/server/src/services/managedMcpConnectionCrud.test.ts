import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  actionCards,
  channelAgents,
  channels,
  managedMcpCredentials,
  managedMcpServers,
  messages,
  users,
} from "../db/schema";
import { createAgent } from "./agentService";
import { createServer } from "./serverService";
import { decryptManagedMcpHeaders } from "./managedMcpCredentialService";
import { ManagedMcpGatewayError } from "./managedMcpGateway";
import {
  createManagedMcpServer,
  executeManagedMcpCall,
  setManagedMcpAssignment,
} from "./managedMcpService";
import {
  createManagedMcpHeaderConnection,
  deleteManagedMcpConnection,
  describeManagedMcpDefaultImpact,
  listManagedMcpConnections,
  setServerDefaultConnection,
  updateManagedMcpConnection,
} from "./managedMcpConnectionService";
import { ensureMcpConnectionCard } from "./managedMcpConnectionCardService";
import { updateMcpApp } from "./managedMcpAppService";

const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 23).toString("base64");
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

const catalog = [{ name: "search", inputSchema: { type: "object" as const } }];
const handshakeOk = async () => catalog;

/** An API-key App whose default Connection sends `X-Api-Key: default-fixture-key`. */
async function seedHeaderApp(requiredHeaderNames: string[] | null = ["X-Api-Key"]) {
  const [user] = await getDb().insert(users).values({
    email: `mcp-conn-crud-${randomUUID()}@slock.test`,
    name: `mcp-conn-crud-${randomUUID().slice(0, 8)}`,
    displayName: "Connection Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP Connections", `mcp-conn-crud-${randomUUID()}`, user.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: user.id });
  const app = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "default-fixture-key" },
  });
  await getDb().update(managedMcpServers).set({ toolCatalog: catalog, requiredHeaderNames })
    .where(eq(managedMcpServers.id, app.id));
  const [defaultConnection] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, app.id));
  return { user, server, agent, appId: app.id, configVersion: app.configVersion, defaultConnectionId: defaultConnection.id };
}

type Seeded = Awaited<ReturnType<typeof seedHeaderApp>>;
const rows = async (f: Seeded) => getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, f.appId));

function caller(f: Seeded) {
  const sent: string[] = [];
  const call = (agentId: string) => executeManagedMcpCall(f.server.id, agentId, {
    mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: f.configVersion, expectedAssignmentVersion: 1,
  }, async (input) => { sent.push(String(input.headers["X-Api-Key"])); return { content: [], isError: false }; });
  return { sent, call };
}

test("⭐ a Connection whose handshake fails is never written", async () => {
  const f = await seedHeaderApp();
  for (const failure of [
    new ManagedMcpGatewayError("MCP endpoint rejected the configured credentials (401/403)", "managed_mcp_endpoint_auth_rejected"),
    new ManagedMcpGatewayError("MCP server could not be reached", "managed_mcp_unreachable"),
  ]) {
    await assert.rejects(createManagedMcpHeaderConnection({
      serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Bad key", headers: { "X-Api-Key": "wrong-fixture-key" },
    }, { listTools: async () => { throw failure; } }), { code: failure.code });
  }
  assert.deepEqual((await rows(f)).map((row) => row.id), [f.defaultConnectionId], "⭐ no row for a failed handshake");

  await assert.rejects(updateManagedMcpConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, connectionId: f.defaultConnectionId,
    headers: { "X-Api-Key": "wrong-fixture-key" },
  }, { listTools: async () => { throw new ManagedMcpGatewayError("MCP server could not be reached", "managed_mcp_unreachable"); } }));
  const [kept] = await rows(f);
  assert.deepEqual(decryptManagedMcpHeaders(kept.encryptedHeaders), { "X-Api-Key": "default-fixture-key" }, "a failed replacement keeps the old key");
});

test("⭐ a Connection must supply exactly the App's header set", async () => {
  const f = await seedHeaderApp(["X-Api-Key", "X-Team"]);
  let handshakes = 0;
  const create = (headers: Record<string, string>) => createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Team", headers,
  }, { listTools: async () => { handshakes += 1; return catalog; } });
  await assert.rejects(create({ "X-Api-Key": "fixture-key" }), { code: "managed_mcp_headers_incomplete" });
  await assert.rejects(create({ "X-Api-Key": "fixture-key", "X-Team": "t", "X-Extra": "e" }), { code: "managed_mcp_headers_incomplete" });
  assert.equal(handshakes, 0, "an incomplete set is refused before the server is contacted");
  const created = await create({ "x-api-key": "fixture-key", "X-TEAM": "fixture-team" });
  assert.deepEqual(created.headerNames.map((name) => name.toLowerCase()), ["x-api-key", "x-team"]);
  assert.equal(JSON.stringify(created).includes("fixture-key"), false, "values are never returned");

  // An App created before header names were recorded is held to its default Connection's names.
  const legacy = await seedHeaderApp(null);
  await assert.rejects(createManagedMcpHeaderConnection({
    serverId: legacy.server.id, userId: legacy.user.id, mcpServerId: legacy.appId, name: "Other", headers: { Authorization: "Bearer fixture" },
  }, { listTools: handshakeOk }), { code: "managed_mcp_headers_incomplete" });
});

test("an App that needs no credential takes no Connection", async () => {
  const f = await seedHeaderApp();
  const open = await createManagedMcpServer({ serverId: f.server.id, userId: f.user.id, name: "Open", endpointUrl: "https://open.example.test/mcp" });
  await assert.rejects(createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: open.id, name: "Pointless", headers: { "X-Api-Key": "fixture" },
  }, { listTools: handshakeOk }), { code: "managed_mcp_connection_not_needed" });
});

test("⭐ a second Connection: pinned Agents use it, makeDefault moves the default and the catalogue", async () => {
  const f = await seedHeaderApp();
  const pinnedAgent = await createAgent(f.server.id, `pinned-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: f.user.id });
  const second = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Second", headers: { "X-Api-Key": "second-fixture-key" },
  }, { listTools: handshakeOk });
  assert.equal(second.isServerDefault, false);
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: pinnedAgent.id, mcpServerId: f.appId, connectionId: second.id });
  const { sent, call } = caller(f);
  await call(f.agent.id);
  await call(pinnedAgent.id);
  assert.deepEqual(sent, ["default-fixture-key", "second-fixture-key"]);

  const third = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Third", headers: { "X-Api-Key": "third-fixture-key" }, makeDefault: true,
  }, { listTools: async () => [{ name: "search", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }] });
  assert.equal(third.isServerDefault, true);
  const views = await listManagedMcpConnections(f.server.id, f.appId);
  assert.deepEqual(views.filter((view) => view.isServerDefault).map((view) => view.id), [third.id], "one default");
  const [app] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, f.appId));
  assert.deepEqual(app.toolCatalog.map((tool) => tool.name), ["search", "write"], "the default's handshake is the App catalogue");
  await call(f.agent.id);
  await call(pinnedAgent.id);
  assert.deepEqual(sent.slice(2), ["third-fixture-key", "second-fixture-key"], "⭐ followers moved, the pin did not");

  const renamed = await updateManagedMcpConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, connectionId: second.id, name: "Renamed",
  });
  assert.equal(renamed.name, "Renamed");
});

test("⭐ deleting a pinned Connection refuses its Agents with no fallback to the default", async () => {
  const f = await seedHeaderApp();
  const second = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Second", headers: { "X-Api-Key": "second-fixture-key" },
  }, { listTools: handshakeOk });
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: f.appId, connectionId: second.id });
  await deleteManagedMcpConnection({ serverId: f.server.id, mcpServerId: f.appId, connectionId: second.id });
  const { sent, call } = caller(f);
  await assert.rejects(call(f.agent.id), { code: "managed_mcp_login_required" });
  assert.deepEqual(sent, [], "⭐ the default's key was not sent in its place");

  const follower = await createAgent(f.server.id, `follower-${randomUUID().slice(0, 8)}`);
  await deleteManagedMcpConnection({ serverId: f.server.id, mcpServerId: f.appId, connectionId: f.defaultConnectionId });
  await assert.rejects(call(follower.id), { code: "managed_mcp_login_required" }, "no default: followers are refused too");
  await assert.rejects(
    deleteManagedMcpConnection({ serverId: f.server.id, mcpServerId: f.appId, connectionId: f.defaultConnectionId }),
    { code: "managed_mcp_connection_not_found" },
  );
});

test("⭐ the default-change impact counts only Agents that follow the default", async () => {
  const f = await seedHeaderApp();
  const second = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Second", headers: { "X-Api-Key": "second-fixture-key" },
  }, { listTools: handshakeOk });
  const explicitFollower = await createAgent(f.server.id, `explicit-${randomUUID().slice(0, 8)}`);
  const pinned = await createAgent(f.server.id, `pinned-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: f.user.id });
  const off = await createAgent(f.server.id, `off-${randomUUID().slice(0, 8)}`);
  const assign = (agentId: string, extra: { enabled?: boolean; connectionId?: string | null }) =>
    setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId, mcpServerId: f.appId, ...extra });
  await assign(explicitFollower.id, { enabled: true, connectionId: null });
  await assign(pinned.id, { connectionId: second.id });
  await assign(off.id, { enabled: false });

  const impact = await describeManagedMcpDefaultImpact({ serverId: f.server.id, mcpServerId: f.appId, connectionId: second.id });
  assert.deepEqual(impact, {
    currentDefaultConnectionId: f.defaultConnectionId,
    agentsChangingNow: 2,
    agentsTotal: 4,
    agentsFollowingDefault: 2,
    pinnedUnchanged: 1,
    offUnchanged: 1,
    futureAgentsInherit: true,
  });
  const unchanged = await describeManagedMcpDefaultImpact({ serverId: f.server.id, mcpServerId: f.appId, connectionId: f.defaultConnectionId });
  assert.equal(unchanged.agentsChangingNow, 0, "keeping the current default changes nothing");
  await assert.rejects(
    describeManagedMcpDefaultImpact({ serverId: f.server.id, mcpServerId: f.appId, connectionId: randomUUID() }),
    { code: "managed_mcp_connection_not_found" },
  );
});

test("⭐ setting a default closes the cards of Agents it admits, and only those", async () => {
  const f = await seedHeaderApp();
  const second = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Second", headers: { "X-Api-Key": "second-fixture-key" },
  }, { listTools: handshakeOk });
  const pinned = await createAgent(f.server.id, `pinned-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: f.user.id });
  // Pinned to a Connection that is then deleted: refused whatever the default is.
  const doomed = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, name: "Doomed", headers: { "X-Api-Key": "doomed-fixture-key" },
  }, { listTools: handshakeOk });
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: pinned.id, mcpServerId: f.appId, connectionId: doomed.id });
  await deleteManagedMcpConnection({ serverId: f.server.id, mcpServerId: f.appId, connectionId: doomed.id });
  await getDb().transaction((tx) => setServerDefaultConnection(tx, {
    serverId: f.server.id, mcpServerId: f.appId, connectionId: null, userId: f.user.id,
  }));

  const [channel] = await getDb().insert(channels).values({ serverId: f.server.id, name: `c-${randomUUID().slice(0, 8)}` }).returning();
  const cardFor = async (agentId: string) => {
    await getDb().insert(channelAgents).values({ channelId: channel.id, agentId });
    const [message] = await getDb().insert(messages).values({ channelId: channel.id, senderType: "agent", senderId: agentId, content: "turn" }).returning();
    const card = await ensureMcpConnectionCard({ serverId: f.server.id, agentId, mcpServerId: f.appId, revision: 1, origin: { sourceMessageId: message.id } });
    return async () => (await getDb().select().from(actionCards).where(eq(actionCards.messageId, card.cardMessageId!)))[0].state;
  };
  const followerCard = await cardFor(f.agent.id);
  const pinnedCard = await cardFor(pinned.id);

  const result = await getDb().transaction((tx) => setServerDefaultConnection(tx, {
    serverId: f.server.id, mcpServerId: f.appId, connectionId: second.id, userId: f.user.id,
  }));
  assert.equal(result.resolvedCards, 1);
  assert.equal(await followerCard(), "executed", "⭐ the follower is admitted now, so its card closes");
  assert.equal(await pinnedCard(), "prepared", "⭐ the dead pin is still refused, so its card stays open");
});

test("⭐ a key replacement is refused if the endpoint changed during its handshake (same fence as create)", async () => {
  const f = await seedHeaderApp();
  await getDb().update(managedMcpServers).set({ sourceKind: "url" }).where(eq(managedMcpServers.id, f.appId));
  await assert.rejects(updateManagedMcpConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, connectionId: f.defaultConnectionId,
    headers: { "X-Api-Key": "key-validated-for-docs" },
  }, {
    listTools: async () => {
      // While the handshake against docs.example.test is in flight, the App moves to another origin.
      await updateMcpApp({ serverId: f.server.id, userId: f.user.id, appId: f.appId, patch: { endpointUrl: "https://other.example.test/mcp" } });
      return catalog;
    },
  }), { code: "managed_mcp_config_stale" });
  const [row] = await rows(f);
  assert.ok(row.encryptedHeaders === null, "⭐ the key validated for the old server was not stored");
  assert.equal(row.authStatus, "needs_auth", "the move's needs_auth stands; nothing was marked ready");
});

test("⭐ an App with no recorded header names never accepts arbitrary names once its default is gone", async () => {
  const legacy = await seedHeaderApp(null);
  const create = (name: string, headers: Record<string, string>) => createManagedMcpHeaderConnection({
    serverId: legacy.server.id, userId: legacy.user.id, mcpServerId: legacy.appId, name, headers,
  }, { listTools: handshakeOk });
  const second = await create("Second", { "X-Api-Key": "second-key" });
  await deleteManagedMcpConnection({ serverId: legacy.server.id, mcpServerId: legacy.appId, connectionId: legacy.defaultConnectionId });

  // The names come from the Connections that remain.
  await assert.rejects(create("Other", { Authorization: "Bearer fixture" }), { code: "managed_mcp_headers_incomplete" });
  await create("Third", { "X-Api-Key": "third-key" });

  // With no Connection left to take them from, the admin must set them on the App.
  for (const row of await rows(legacy)) {
    await deleteManagedMcpConnection({ serverId: legacy.server.id, mcpServerId: legacy.appId, connectionId: row.id });
  }
  assert.ok(second.id);
  await assert.rejects(create("Any", { "X-Whatever": "fixture" }), { code: "managed_mcp_header_names_unset" });
  await getDb().update(managedMcpServers).set({ sourceKind: "url" }).where(eq(managedMcpServers.id, legacy.appId));
  await updateMcpApp({ serverId: legacy.server.id, userId: legacy.user.id, appId: legacy.appId, patch: { requiredHeaderNames: ["X-Api-Key"] } });
  await assert.rejects(create("Any", { "X-Whatever": "fixture" }), { code: "managed_mcp_headers_incomplete" });
  await create("Keyed", { "X-Api-Key": "fixture" });
});

test("⭐ an open connect card past its 30 days is not reused: a fresh one is posted, and only the fresh one is resolved", async () => {
  const f = await seedHeaderApp();
  // No default: the Agent is refused, so it is asked to connect.
  await getDb().transaction((tx) => setServerDefaultConnection(tx, {
    serverId: f.server.id, mcpServerId: f.appId, connectionId: null, userId: f.user.id,
  }));
  const [channel] = await getDb().insert(channels).values({ serverId: f.server.id, name: `c-${randomUUID().slice(0, 8)}` }).returning();
  await getDb().insert(channelAgents).values({ channelId: channel.id, agentId: f.agent.id });
  const ensure = async () => {
    const [turn] = await getDb().insert(messages).values({ channelId: channel.id, senderType: "agent", senderId: f.agent.id, content: "turn" }).returning();
    return ensureMcpConnectionCard({ serverId: f.server.id, agentId: f.agent.id, mcpServerId: f.appId, revision: 1, origin: { sourceMessageId: turn.id } });
  };
  const preparedDaysAgo = (messageId: string, days: number) =>
    getDb().update(actionCards).set({ createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }).where(eq(actionCards.messageId, messageId));
  const card = async (messageId: string) => (await getDb().select().from(actionCards).where(eq(actionCards.messageId, messageId)))[0]!;

  const first = await ensure();
  assert.ok(first.cardMessageId);
  await preparedDaysAgo(first.cardMessageId, 29);
  assert.deepEqual(await ensure(), { cardMessageId: first.cardMessageId, reused: true }, "29 days: still the open card");

  await preparedDaysAgo(first.cardMessageId, 31);
  const fresh = await ensure();
  assert.equal(fresh.reused, false, "⭐ 31 days: nobody can complete it, so it is not the answer");
  assert.ok(fresh.cardMessageId && fresh.cardMessageId !== first.cardMessageId);
  const old = await card(first.cardMessageId);
  assert.equal(old.state, "prepared", "the old card stays as it was (it reads as expired)");
  assert.equal(old.dedupeKey, null, "it gave up the open-card key to the fresh one");
  assert.ok((await card(fresh.cardMessageId)).dedupeKey);
  assert.deepEqual(await ensure(), { cardMessageId: fresh.cardMessageId, reused: true }, "the fresh card is the open one now");

  // Authorizing the Agent closes the fresh card, never the expired one.
  await getDb().transaction((tx) => setServerDefaultConnection(tx, {
    serverId: f.server.id, mcpServerId: f.appId, connectionId: f.defaultConnectionId, userId: f.user.id,
  }));
  assert.equal((await card(fresh.cardMessageId)).state, "executed");
  assert.equal((await card(first.cardMessageId)).state, "prepared");
});
