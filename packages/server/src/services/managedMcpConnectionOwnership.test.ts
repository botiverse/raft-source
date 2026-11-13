import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, managedMcpAssignments, managedMcpCredentials, managedMcpServers, users } from "../db/schema";
import { createAgent } from "./agentService";
import { addMember, createServer } from "./serverService";
import { encryptManagedMcpHeaders } from "./managedMcpCredentialService";
import { projectMcpConnectionAuthorization } from "./managedMcpConnectionCardService";
import {
  MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE,
  MCP_CONNECTION_NOT_USABLE_MESSAGE,
  mcpAgentOwnerUserId,
  mcpConnectionUsableByAgent,
} from "./managedMcpConnectionOwnership";
import {
  applyManagedMcpAssignments,
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  isMcpConnectionAuthorized,
  listAgentManagedMcpCatalog,
  ManagedMcpServiceError,
  RAFT_APP_CALL_TOOL,
  RAFT_APPS_MCP_SERVER_ID,
  setManagedMcpAssignment,
} from "./managedMcpService";

// WHOSE Connection an Agent may use: the App's server default, or one its owner created. Enforced on
// the pin (write), on every call (admission) and on the candidates offered for pinning (read).

const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64");
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

const ENDPOINT = "https://docs.example.test/mcp";

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label, passwordHash: "hash", emailVerified: true,
  }).returning();
  return user;
}

/**
 * A server owned by `owner` with members Alice and Bob; an API-key App (made by the owner, so granted to
 * every Agent) whose ready default Connection the owner created, plus a personal Connection each for
 * Alice and Bob and one whose creator is unknown; and Alice's Agent.
 */
async function seed() {
  const owner = await seedUser("owner");
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const server = await createServer("Ownership", `own-${randomUUID()}`, owner.id);
  await addMember(server.id, alice.id, "member");
  await addMember(server.id, bob.id, "member");
  const [app] = await getDb().insert(managedMcpServers).values({
    serverId: server.id, name: "Docs", endpointUrl: ENDPOINT, authMode: "headers", sourceKind: "url", createdByUserId: owner.id,
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] as never,
  }).returning();
  const connection = async (name: string, key: string, createdByUserId: string | null, isServerDefault = false) => (await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: app.id, isServerDefault, authKind: "headers", authStatus: "ready", name, createdByUserId,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": key }), headerNames: ["X-Api-Key"], authorizedEndpointUrl: ENDPOINT,
  }).returning())[0];
  const defaultConnection = await connection("Team", "team-key", owner.id, true);
  const aliceConnection = await connection("Alice's", "alice-key", alice.id);
  const bobConnection = await connection("Bob's", "bob-key", bob.id);
  const orphanConnection = await connection("Orphan", "orphan-key", null);
  const aliceAgent = await createAgent(server.id, `alice-agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: alice.id });
  const sent: string[] = [];
  const call = (agentId: string) => executeManagedMcpCall(server.id, agentId, {
    mcpServerId: app.id, toolName: "search", arguments: {}, expectedConfigVersion: app.configVersion, expectedAssignmentVersion: 1,
  }, async (input) => { sent.push(String(input.headers["X-Api-Key"])); return { content: [], isError: false }; });
  const pin = (agentId: string, connectionId: string | null, userId = alice.id) =>
    setManagedMcpAssignment({ serverId: server.id, userId, agentId, mcpServerId: app.id, connectionId });
  const assignmentOf = async (agentId: string) =>
    (await getDb().select().from(managedMcpAssignments).where(eq(managedMcpAssignments.agentId, agentId)))[0] ?? null;
  return { owner, alice, bob, server, app, defaultConnection, aliceConnection, bobConnection, orphanConnection, aliceAgent, sent, call, pin, assignmentOf };
}

const notUsable = (error: unknown) => error instanceof ManagedMcpServiceError
  && error.code === "managed_mcp_connection_not_usable"
  && error.message === MCP_CONNECTION_NOT_USABLE_MESSAGE;

/** The call-time refusal for an unusable pin: still login_required (raises the Connect card), worded for the agent. */
const refusedAsNotUsable = (error: unknown) => error instanceof ManagedMcpServiceError
  && error.code === "managed_mcp_login_required"
  && error.message === MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE
  && error.agentFacing === true;

test("the owner: a personal assistant's owner, else the human creator, else nobody", () => {
  assert.equal(mcpAgentOwnerUserId({ assistantOwnerUserId: "a", creatorType: "user", creatorId: "c" }), "a");
  assert.equal(mcpAgentOwnerUserId({ assistantOwnerUserId: null, creatorType: "user", creatorId: "c" }), "c");
  assert.equal(mcpAgentOwnerUserId({ assistantOwnerUserId: null, creatorType: "agent", creatorId: "c" }), null);
  assert.equal(mcpAgentOwnerUserId({ assistantOwnerUserId: null, creatorType: null, creatorId: null }), null);
  assert.equal(mcpConnectionUsableByAgent({ isServerDefault: true, createdByUserId: null }, null), true, "the default is shared");
  assert.equal(mcpConnectionUsableByAgent({ isServerDefault: false, createdByUserId: "c" }, "c"), true);
  assert.equal(mcpConnectionUsableByAgent({ isServerDefault: false, createdByUserId: "x" }, "c"), false);
  assert.equal(mcpConnectionUsableByAgent({ isServerDefault: false, createdByUserId: null }, "c"), false, "unknown creator: default only");
  assert.equal(mcpConnectionUsableByAgent({ isServerDefault: false, createdByUserId: null }, null), false);
});

test("⭐ pin: an Agent may be pinned to its owner's Connection or the default, never to someone else's", async () => {
  const f = await seed();
  // Its owner's own Connection: pinned, and the call sends that key.
  await f.pin(f.aliceAgent.id, f.aliceConnection.id);
  await f.call(f.aliceAgent.id);
  assert.deepEqual(f.sent, ["alice-key"]);

  // ⭐ Another member's personal Connection: refused, whoever asks (even the server owner), and the
  // existing pin is left as it was.
  await assert.rejects(f.pin(f.aliceAgent.id, f.bobConnection.id), notUsable);
  await assert.rejects(f.pin(f.aliceAgent.id, f.bobConnection.id, f.owner.id), notUsable, "managing the server does not change whose Agent it is");
  await assert.rejects(f.pin(f.aliceAgent.id, f.orphanConnection.id), notUsable, "a Connection with no recorded creator is usable only as the default");
  assert.equal((await f.assignmentOf(f.aliceAgent.id))?.boundConnectionId, f.aliceConnection.id, "nothing was written");
  // The bulk path applies the same rule, and writes nothing.
  await assert.rejects(
    applyManagedMcpAssignments({ serverId: f.server.id, userId: f.alice.id, agentId: f.aliceAgent.id, assignments: [{ mcpServerId: f.app.id, connectionId: f.bobConnection.id }] }),
    notUsable,
  );
  assert.equal((await f.assignmentOf(f.aliceAgent.id))?.boundConnectionId, f.aliceConnection.id);

  // A missing id still gets the not-found answer (and another App's id the identical one, elsewhere).
  await assert.rejects(f.pin(f.aliceAgent.id, randomUUID()), { code: "managed_mcp_connection_not_found" });

  // The default, pinned explicitly or followed: always allowed.
  await f.pin(f.aliceAgent.id, f.defaultConnection.id);
  await f.call(f.aliceAgent.id);
  await f.pin(f.aliceAgent.id, null);
  await f.call(f.aliceAgent.id);
  assert.deepEqual(f.sent, ["alice-key", "team-key", "team-key"]);
});

test("⭐ a personal assistant uses its owner's Connections (the owner, not the creator, decides)", async () => {
  const f = await seed();
  // Created by Bob, but Alice's assistant: Alice is its owner.
  const assistant = await createAgent(f.server.id, `assistant-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: f.bob.id });
  await getDb().update(agents).set({ assistantOwnerUserId: f.alice.id }).where(eq(agents.id, assistant.id));
  await f.pin(assistant.id, f.aliceConnection.id);
  await f.call(assistant.id);
  assert.deepEqual(f.sent, ["alice-key"]);
  await assert.rejects(f.pin(assistant.id, f.bobConnection.id, f.bob.id), notUsable, "⭐ its creator's Connection is not its owner's");
});

test("⭐ an Agent created by an agent has no owner: only the App's default Connection", async () => {
  const f = await seed();
  const child = await createAgent(f.server.id, `child-${randomUUID().slice(0, 8)}`, { creatorType: "agent", creatorId: f.aliceAgent.id });
  await assert.rejects(f.pin(child.id, f.aliceConnection.id), notUsable);
  await assert.rejects(f.pin(child.id, f.orphanConnection.id), notUsable);
  await f.call(child.id);
  await f.pin(child.id, f.defaultConnection.id);
  await f.call(child.id);
  assert.deepEqual(f.sent, ["team-key", "team-key"]);
  const view = await projectMcpConnectionAuthorization({ serverId: f.server.id, viewerUserId: f.owner.id, mcpServerId: f.app.id, agentId: child.id });
  assert.deepEqual(view.candidates.map((candidate) => candidate.connectionId), [f.defaultConnection.id]);
  assert.equal(view.newConnectionPinnable, false);
});

test("⭐ an existing pin that becomes unusable is refused on every call, says what to do, and never falls back to the default", async () => {
  const f = await seed();
  await f.pin(f.aliceAgent.id, f.aliceConnection.id);
  await f.call(f.aliceAgent.id);
  assert.deepEqual(f.sent, ["alice-key"]);

  const assertRefused = async (label: string) => {
    await assert.rejects(f.call(f.aliceAgent.id), refusedAsNotUsable, `${label}: the call`);
    assert.deepEqual(f.sent, ["alice-key"], `${label}: ⭐ nothing sent, in particular not the ready default's key`);
    // The same decision everywhere: the Agent's Apps tab, the Connect-card check, the runtime snapshot.
    const row = (await listAgentManagedMcpCatalog(f.server.id, f.aliceAgent.id)).servers.find((server) => server.id === f.app.id);
    assert.deepEqual({ mode: row?.agentConnection?.mode, status: row?.agentConnection?.status }, { mode: "pinned", status: "login_required" }, `${label}: the Apps tab`);
    assert.equal(await isMcpConnectionAuthorized(getDb(), f.server.id, f.aliceAgent.id, f.app.id), false, `${label}: the Connect-card check`);
    const snapshot = await getManagedMcpRuntimeSnapshot(f.server.id, f.aliceAgent.id);
    assert.ok(snapshot.unavailable?.some((entry) => entry.mcpServerId === f.app.id), `${label}: listed as needing a Connection`);
    // Through the Raft Apps tools too (their own admission), with the same words.
    await assert.rejects(executeManagedMcpCall(f.server.id, f.aliceAgent.id, {
      mcpServerId: RAFT_APPS_MCP_SERVER_ID, toolName: RAFT_APP_CALL_TOOL, arguments: { app: f.app.id, name: "search", arguments: {} },
      expectedConfigVersion: 1, expectedAssignmentVersion: 1,
    }, async () => { f.sent.push("raft-app-call"); return { content: [], isError: false }; }), refusedAsNotUsable, `${label}: raft_app_call`);
    assert.deepEqual(f.sent, ["alice-key"]);
  };

  // The Connection's recorded creator is someone else now.
  await getDb().update(managedMcpCredentials).set({ createdByUserId: f.bob.id }).where(eq(managedMcpCredentials.id, f.aliceConnection.id));
  await assertRefused("the Connection's creator differs");
  // Someone else's Connection that is ALSO signed out still says whose it is (signing in again would not help).
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.aliceConnection.id));
  await assert.rejects(f.call(f.aliceAgent.id), refusedAsNotUsable);
  await getDb().update(managedMcpCredentials).set({ createdByUserId: f.alice.id, authStatus: "ready" }).where(eq(managedMcpCredentials.id, f.aliceConnection.id));
  await f.call(f.aliceAgent.id);
  assert.deepEqual(f.sent, ["alice-key", "alice-key"]);
  f.sent.pop();

  // The Agent's owner changed (it is someone else's Agent now).
  await getDb().update(agents).set({ creatorId: f.bob.id }).where(eq(agents.id, f.aliceAgent.id));
  await assertRefused("the Agent's owner changed");

  // A refusal for another reason keeps the generic words.
  await getDb().update(agents).set({ creatorId: f.alice.id }).where(eq(agents.id, f.aliceAgent.id));
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.aliceConnection.id));
  await assert.rejects(f.call(f.aliceAgent.id), (error: unknown) => error instanceof ManagedMcpServiceError
    && error.code === "managed_mcp_login_required" && error.message !== MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE);
});

test("⭐ candidates are the default and the owner's own; an unusable pin stays present so it can be cleared", async () => {
  const f = await seed();
  const project = (viewerUserId: string) => projectMcpConnectionAuthorization({ serverId: f.server.id, viewerUserId, mcpServerId: f.app.id, agentId: f.aliceAgent.id });
  const ids = (view: Awaited<ReturnType<typeof project>>) => view.candidates.map((candidate) => candidate.connectionId).sort();
  const usable = [f.defaultConnection.id, f.aliceConnection.id].sort();

  const asOwner = await project(f.alice.id);
  assert.equal(asOwner.viewerRole, "agent_manager");
  assert.deepEqual(ids(asOwner), usable, "⭐ not Bob's, not the orphan");
  assert.equal(asOwner.newConnectionPinnable, true);
  // A server manager may manage every Connection in the App's settings, but is offered only these for this Agent.
  const asServerManager = await project(f.owner.id);
  assert.equal(asServerManager.viewerRole, "server_manager");
  assert.deepEqual(ids(asServerManager), usable);
  assert.equal(asServerManager.newConnectionPinnable, false, "a Connection the server manager creates would not be this Agent's owner's");

  await f.pin(f.aliceAgent.id, f.aliceConnection.id);
  assert.deepEqual((await project(f.alice.id)).binding, { present: true, visibleToViewer: true, connectionId: f.aliceConnection.id });

  // An old pin to Bob's Connection (written before this rule): reported present but not visible,
  // for every viewer, so the UI offers a way out; the id is not handed out.
  await getDb().update(managedMcpAssignments).set({ boundConnectionId: f.bobConnection.id }).where(eq(managedMcpAssignments.agentId, f.aliceAgent.id));
  for (const viewer of [f.alice.id, f.owner.id]) {
    const view = await project(viewer);
    assert.deepEqual(view.binding, { present: true, visibleToViewer: false, connectionId: null });
    assert.deepEqual(ids(view), usable);
  }
  // ⭐ Clearing it never requires being able to see it.
  await f.pin(f.aliceAgent.id, null);
  assert.deepEqual((await project(f.alice.id)).binding, { present: false, visibleToViewer: false, connectionId: null });
  await f.call(f.aliceAgent.id);
  assert.deepEqual(f.sent, ["team-key"]);
});
