import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agents,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpPersonalGrants,
  managedMcpServers,
  serverMembers,
  users,
} from "../db/schema";
import { seedBoundGuest } from "../test/guestFixture";
import { createAgent } from "./agentService";
import { addMember, createServer } from "./serverService";
import { encryptManagedMcpHeaders } from "./managedMcpCredentialService";
import { getMcpAppView } from "./managedMcpAppService";
import { setServerDefaultConnection } from "./managedMcpConnectionService";
import { postgresConstraintName, postgresErrorCode } from "./managedMcpConnectionCardService";
import {
  admitManagedMcpCall,
  admittedMcpConnectionId,
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  isMcpConnectionAuthorized,
  listAgentManagedMcpCatalog,
  ManagedMcpServiceError,
  MCP_CONNECTION_NOT_PINNABLE_MESSAGE,
  RAFT_APPS_MCP_SERVER_ID,
  setManagedMcpAssignment,
} from "./managedMcpService";

// RFC 087 §5: which account an Agent's MCP call uses. A member's personal Connection given to the
// Agent first (ready, for this endpoint, its owner still a member), else the admin layer as before
// (a pin: its shared Connection only, never the default; no pin: the default), else login_required.
// Every row is checked on the call (which key is sent) and against the other readers of the same
// decision: the Agent's Apps tab, the Connect-card check and the runtime snapshot.

const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 13).toString("base64");
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

type ConnectionValues = Partial<typeof managedMcpCredentials.$inferInsert>;

/**
 * A server owned by `owner` with members Alice and Bob. `app(...)` adds an API-key App (vouched unless
 * told otherwise) with a ready default "Team" Connection; `connection(...)` adds one sending `key`;
 * `personal(...)` a member's own; `give(...)` a personal grant, as the later agents API will write it.
 */
async function seed() {
  const owner = await seedUser("owner");
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const server = await createServer("Accounts", `accounts-${randomUUID()}`, owner.id);
  await addMember(server.id, alice.id, "member");
  await addMember(server.id, bob.id, "member");
  const db = getDb();
  const connection = async (appId: string, key: string, values: ConnectionValues = {}) => (await db.insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: appId, isServerDefault: false, authKind: "headers", authStatus: "ready", name: key, createdByUserId: owner.id,
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": key }), headerNames: ["X-Api-Key"], authorizedEndpointUrl: ENDPOINT, ...values,
  }).returning())[0];
  const app = async (name: string, options: { vouched?: boolean; authMode?: "headers" | "none" } = {}) => {
    const [row] = await db.insert(managedMcpServers).values({
      serverId: server.id, name, endpointUrl: ENDPOINT, authMode: options.authMode ?? "headers", sourceKind: "url", createdByUserId: owner.id,
      ...(options.vouched === false ? {} : { serverVouchedAt: new Date(), serverVouchedByUserId: owner.id }),
      toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] as never,
    }).returning();
    const team = options.authMode === "none" ? null : await connection(row.id, `${name}-team`, { isServerDefault: true });
    return { ...row, team };
  };
  const personal = (appId: string, key: string, owner: { id: string }, values: ConnectionValues = {}) =>
    connection(appId, key, { ownerKind: "personal", ownerUserId: owner.id, createdByUserId: owner.id, signedInByUserId: owner.id, ...values });
  const give = async (agentId: string, appId: string, connectionId: string, by: { id: string }) => {
    await db.insert(managedMcpPersonalGrants).values({ serverId: server.id, agentId, mcpServerId: appId, connectionId, grantedByUserId: by.id });
  };
  const pinRow = async (agentId: string, appId: string, boundConnectionId: string | null) => {
    await db.insert(managedMcpAssignments).values({ serverId: server.id, agentId, mcpServerId: appId, connectionMode: "pinned", boundConnectionId });
  };
  // Bob's Agent: the App's automatic grant comes only from the vouch (the owner created every App).
  const agent = async () => createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: bob.id });
  return { owner, alice, bob, server, db, app, connection, personal, give, pinRow, agent };
}

type Outcome = string | ManagedMcpServiceError["code"];

/** What one call to the App gets: the key it sent (`<none>` for an App without accounts), or the refusal's code. */
async function callWith(serverId: string, agentId: string, app: { id: string; configVersion: number }): Promise<Outcome> {
  let sent: Outcome = "<not sent>";
  try {
    await executeManagedMcpCall(serverId, agentId, {
      mcpServerId: app.id, toolName: "search", arguments: {}, expectedConfigVersion: app.configVersion, expectedAssignmentVersion: 1,
    }, async (input) => { sent = input.headers["X-Api-Key"] ?? "<none>"; return { content: [], isError: false }; });
    return sent;
  } catch (error) {
    if (error instanceof ManagedMcpServiceError) {
      assert.equal(sent, "<not sent>", "a refused call sends nothing");
      return error.code;
    }
    throw error;
  }
}

/**
 * The call's outcome, after checking every other reader of the decision agrees with it: the Apps tab
 * (mode / status), the Connect-card check, the admitted Connection, and the runtime snapshot.
 */
async function resolve(serverId: string, agentId: string, app: { id: string; configVersion: number }): Promise<Outcome> {
  const called = await callWith(serverId, agentId, app);
  const admitted = called !== "managed_mcp_login_required" && called !== "managed_mcp_app_off" && called !== "managed_mcp_server_disabled";
  const view = (await listAgentManagedMcpCatalog(serverId, agentId)).servers.find((row) => row.id === app.id)?.agentConnection;
  assert.ok(view, "the App is in the Agent's catalogue");
  const viewed = view.status === "disabled" ? "managed_mcp_server_disabled"
    : view.mode === "off" ? "managed_mcp_app_off"
      : view.status === "ready" ? "admitted" : "managed_mcp_login_required";
  assert.equal(viewed, admitted ? "admitted" : called, "the Apps tab says what a call gets");
  assert.equal(await isMcpConnectionAuthorized(getDb(), serverId, agentId, app.id), admitted, "the Connect-card check agrees");
  const snapshot = await getManagedMcpRuntimeSnapshot(serverId, agentId);
  const offered = snapshot.tools.some((tool) => tool.mcpServerId === app.id);
  assert.equal(offered, called !== "managed_mcp_app_off" && called !== "managed_mcp_server_disabled", "the runtime is offered the tools exactly when the Agent has the App");
  const unavailable = snapshot.unavailable?.some((entry) => entry.mcpServerId === app.id) ?? false;
  assert.equal(unavailable, called === "managed_mcp_login_required", "listed as needing a Connection exactly when the call asks for one");
  return called;
}

test("⭐ resolution table (§5): personal first, then the admin layer, then login_required", async () => {
  const f = await seed();
  const docs = await f.app("Docs");
  const ops = await f.connection(docs.id, "ops-key");
  const alices = await f.personal(docs.id, "alice-key", f.alice);
  const expire = (id: string) => f.db.update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, id));
  const ready = (id: string) => f.db.update(managedMcpCredentials).set({ authStatus: "ready" }).where(eq(managedMcpCredentials.id, id));

  // No personal grant: today's admin layer.
  const plain = await f.agent();
  assert.equal(await resolve(f.server.id, plain.id, docs), "Docs-team", "no grant, no pin: the default");

  // ⭐ A ready personal grant wins over the default, and over a shared pin.
  const followsDefault = await f.agent();
  await f.give(followsDefault.id, docs.id, alices.id, f.alice);
  const pinned = await f.agent();
  await f.give(pinned.id, docs.id, alices.id, f.alice);
  await f.pinRow(pinned.id, docs.id, ops.id);
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "alice-key", "personal ready → personal");
  assert.equal(await resolve(f.server.id, pinned.id, docs), "alice-key", "personal ready → personal, over the pin");
  assert.equal(await admittedMcpConnectionId(f.db, f.server.id, followsDefault.id, docs.id), alices.id);

  // ⭐ Personal expired: each falls back to its own shared account.
  await expire(alices.id);
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "Docs-team", "personal expired → the default");
  assert.equal(await resolve(f.server.id, pinned.id, docs), "ops-key", "personal expired → the shared pin");
  await ready(alices.id);

  // Personal authorized for another endpoint: never sent, falls back.
  await f.db.update(managedMcpCredentials).set({ authorizedEndpointUrl: "https://elsewhere.example.test/mcp" }).where(eq(managedMcpCredentials.id, alices.id));
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "Docs-team", "personal for another endpoint → the default");
  await f.db.update(managedMcpCredentials).set({ authorizedEndpointUrl: ENDPOINT }).where(eq(managedMcpCredentials.id, alices.id));

  // ⭐ The owner turned into a guest, left, or was retired: falls back; back as a member, personal again.
  await seedBoundGuest({ serverId: f.server.id, userId: f.alice.id });
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "Docs-team", "owner became a guest → the default");
  assert.equal(await resolve(f.server.id, pinned.id, docs), "ops-key", "owner became a guest → the shared pin");
  await f.db.delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.alice.id)));
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "Docs-team", "owner left → the default");
  await addMember(f.server.id, f.alice.id, "member");
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "alice-key", "a member again → personal");
  await f.db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.alice.id));
  assert.equal(await resolve(f.server.id, followsDefault.id, docs), "Docs-team", "owner's account retired → the default");
  await f.db.update(users).set({ retiredAt: null }).where(eq(users.id, f.alice.id));

  // ⭐ An unusable shared pin is refused and never falls back to the ready default, with or without a
  // personal grant that cannot be used either.
  const deadPin = await f.agent();
  await f.pinRow(deadPin.id, docs.id, null);
  assert.equal(await resolve(f.server.id, deadPin.id, docs), "managed_mcp_login_required", "pin to nothing → refused, not the default");
  const expiredPin = await f.agent();
  await f.pinRow(expiredPin.id, docs.id, ops.id);
  await expire(ops.id);
  assert.equal(await resolve(f.server.id, expiredPin.id, docs), "managed_mcp_login_required", "pin to an expired shared Connection → refused");
  await f.give(expiredPin.id, docs.id, alices.id, f.alice);
  await expire(alices.id);
  assert.equal(await resolve(f.server.id, expiredPin.id, docs), "managed_mcp_login_required", "personal expired over an unusable pin → refused, not the default");
  await ready(alices.id);
  assert.equal(await resolve(f.server.id, expiredPin.id, docs), "alice-key", "the personal one ready again");
  await ready(ops.id);

  // ⭐ A pin to a shared Connection someone other than the Agent's owner created: usable now.
  assert.equal((await f.db.select().from(agents).where(eq(agents.id, plain.id)))[0]?.creatorId, f.bob.id);
  await f.pinRow(plain.id, docs.id, ops.id);
  assert.equal(await resolve(f.server.id, plain.id, docs), "ops-key", "the owner's shared Connection, pinned to Bob's Agent");

  // A personal Connection written as a pin (no write path makes one) is not a shared account: refused.
  const personalPin = await f.agent();
  await f.pinRow(personalPin.id, docs.id, alices.id);
  assert.equal(await resolve(f.server.id, personalPin.id, docs), "managed_mcp_login_required");
});

test("⭐ App access: explicit off beats a personal grant; a personal grant alone gives access but no shared fallback", async () => {
  const f = await seed();
  // Not vouched, created by the owner: Bob's Agents have it only if someone grants it.
  const notes = await f.app("Notes", { vouched: false });
  const alices = await f.personal(notes.id, "alice-key", f.alice);

  // ⭐ An explicit off refuses before any account is looked at, even with a ready personal grant.
  const off = await f.agent();
  await f.give(off.id, notes.id, alices.id, f.alice);
  await f.db.insert(managedMcpAssignments).values({ serverId: f.server.id, agentId: off.id, mcpServerId: notes.id, enabled: false });
  assert.equal(await resolve(f.server.id, off.id, notes), "managed_mcp_app_off");

  // ⭐ No other grant: the personal grant gives the Agent the App and its member's account.
  const only = await f.agent();
  assert.equal(await resolve(f.server.id, only.id, notes), "managed_mcp_app_off", "nothing yet");
  await f.give(only.id, notes.id, alices.id, f.alice);
  assert.equal(await resolve(f.server.id, only.id, notes), "alice-key");
  const row = (await listAgentManagedMcpCatalog(f.server.id, only.id)).servers.find((server) => server.id === notes.id);
  assert.equal(row?.agentConnection?.grant, "person", "a member's grant is a person's grant");
  const view = await getMcpAppView(f.server.id, notes.id, f.owner.id);
  assert.ok(view.agentAccess.agentIds.includes(only.id), "the App's Agents list names it");
  assert.ok(view.agentAccess.exceptAgentIds.includes(off.id), "and excepts the one switched off");

  // ⭐ ... but the admins never gave it the shared account: an unusable personal one is login_required,
  // not the default (which the admins gave only to the Agents that have the App).
  await f.db.update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, alices.id));
  assert.equal(await resolve(f.server.id, only.id, notes), "managed_mcp_login_required");
  // Its owner gone: their choice no longer gives access.
  await f.db.update(managedMcpCredentials).set({ authStatus: "ready" }).where(eq(managedMcpCredentials.id, alices.id));
  await seedBoundGuest({ serverId: f.server.id, userId: f.alice.id });
  assert.equal(await resolve(f.server.id, only.id, notes), "managed_mcp_app_off");
});

test("an App without accounts (auth none) is unaffected by personal grants", async () => {
  const f = await seed();
  const open = await f.app("Open", { authMode: "none" });
  // No write path makes these for an auth-less App; written directly to show they change nothing.
  const stray = await f.personal(open.id, "alice-key", f.alice);
  const agent = await f.agent();
  await f.give(agent.id, open.id, stray.id, f.alice);
  assert.equal(await resolve(f.server.id, agent.id, open), "<none>", "admitted with no credential");
  assert.equal(await admittedMcpConnectionId(f.db, f.server.id, agent.id, open.id), null);
  const closed = await f.app("Closed", { authMode: "none", vouched: false });
  const strayClosed = await f.personal(closed.id, "alice-key-2", f.alice);
  await f.give(agent.id, closed.id, strayClosed.id, f.alice);
  assert.equal(await resolve(f.server.id, agent.id, closed), "managed_mcp_app_off", "nor does it grant an auth-less App");
});

test("the Raft Apps tool (raft_app_call) admits through the same personal step", async () => {
  const f = await seed();
  const docs = await f.app("Docs");
  const alices = await f.personal(docs.id, "alice-key", f.alice);
  const agent = await f.agent();
  await f.give(agent.id, docs.id, alices.id, f.alice);
  const sent: string[] = [];
  await executeManagedMcpCall(f.server.id, agent.id, {
    mcpServerId: RAFT_APPS_MCP_SERVER_ID, toolName: "raft_app_call", arguments: { app: docs.id, name: "search", arguments: {} },
    expectedConfigVersion: 1, expectedAssignmentVersion: 1,
  }, async (input) => { sent.push(String(input.headers["X-Api-Key"])); return { content: [], isError: false }; });
  assert.deepEqual(sent, ["alice-key"]);
});

test("admission names the account kind it used", () => {
  const connection = (id: string, ownerKind: "shared" | "personal", values: { authStatus?: string; isServerDefault?: boolean } = {}) =>
    ({ id, ownerKind, authStatus: values.authStatus ?? "ready", isServerDefault: values.isServerDefault ?? false });
  const base = {
    requiresCredential: true,
    sharedAccess: true,
    assignment: null,
    boundCredential: null,
    defaultCredential: connection("team", "shared", { isServerDefault: true }),
  };
  assert.deepEqual(admitManagedMcpCall({ ...base, personal: { ...connection("mine", "personal"), ownerIsMember: true } }),
    { allowed: true, credentialId: "mine", accountKind: "personal" });
  assert.deepEqual(admitManagedMcpCall({ ...base, personal: { ...connection("mine", "personal", { authStatus: "expired" }), ownerIsMember: true } }),
    { allowed: true, credentialId: "team", accountKind: "shared" });
  assert.deepEqual(admitManagedMcpCall({ ...base, personal: { ...connection("mine", "personal"), ownerIsMember: false } }),
    { allowed: true, credentialId: "team", accountKind: "shared" });
  assert.deepEqual(admitManagedMcpCall({ ...base, sharedAccess: false, personal: null }), { allowed: false, reason: "login_required" });
  assert.deepEqual(admitManagedMcpCall({ ...base, requiresCredential: false, personal: null }), { allowed: true, credentialId: null, accountKind: null });
  // A shared slot holding a personal Connection is never admitted.
  assert.deepEqual(admitManagedMcpCall({ ...base, personal: null, defaultCredential: connection("x", "personal", { isServerDefault: true }) }),
    { allowed: false, reason: "login_required" });
});

test("⭐ a personal grant names a personal Connection of the same App, on the Agent's Server (database guard)", async () => {
  const f = await seed();
  const docs = await f.app("Docs");
  const other = await f.app("Other");
  const alices = await f.personal(docs.id, "alice-key", f.alice);
  const alicesOther = await f.personal(other.id, "alice-other", f.alice);
  const agent = await f.agent();
  const violates = (constraint: string) => (error: unknown) => postgresConstraintName(error) === constraint;
  const guard = violates("managed_mcp_personal_grants_connection_guard");
  await assert.rejects(f.give(agent.id, docs.id, docs.team!.id, f.alice), guard, "a shared Connection");
  await assert.rejects(f.give(agent.id, docs.id, alicesOther.id, f.alice), guard, "another App's personal Connection");
  const elsewhere = await createServer("Elsewhere", `elsewhere-${randomUUID()}`, f.owner.id);
  const foreignAgent = await createAgent(elsewhere.id, `foreign-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: f.owner.id });
  await assert.rejects(f.give(foreignAgent.id, docs.id, alices.id, f.alice), guard, "an Agent of another Server");
  await f.give(agent.id, docs.id, alices.id, f.alice);
  await assert.rejects(
    f.db.update(managedMcpPersonalGrants).set({ connectionId: docs.team!.id }).where(eq(managedMcpPersonalGrants.agentId, agent.id)),
    guard, "nor moved onto one",
  );
  await assert.rejects(f.give(agent.id, docs.id, alices.id, f.alice), (error: unknown) => postgresErrorCode(error) === "23505", "one personal account per Agent and App");
  // Deleting the Connection deletes its grants.
  await f.db.delete(managedMcpCredentials).where(eq(managedMcpCredentials.id, alices.id));
  assert.equal((await f.db.select().from(managedMcpPersonalGrants)).length, 0);

  // ⭐ Owner kind and owner are fixed at insert (trigger managed_mcp_credentials_owner_immutable).
  const immutable = violates("managed_mcp_credentials_owner_immutable");
  const mine = await f.personal(docs.id, "alice-key-2", f.alice);
  await assert.rejects(f.db.update(managedMcpCredentials).set({ ownerUserId: f.bob.id }).where(eq(managedMcpCredentials.id, mine.id)), immutable, "not handed to another member");
  await assert.rejects(f.db.update(managedMcpCredentials).set({ ownerKind: "shared", ownerUserId: null }).where(eq(managedMcpCredentials.id, mine.id)), immutable, "not made shared");
  await assert.rejects(f.db.update(managedMcpCredentials).set({ ownerKind: "personal", ownerUserId: f.alice.id }).where(eq(managedMcpCredentials.id, docs.team!.id)), immutable, "a shared one not made personal");
  await f.db.update(managedMcpCredentials).set({ name: "renamed", ownerKind: "personal", ownerUserId: f.alice.id }).where(eq(managedMcpCredentials.id, mine.id));

  // The Connection's own CHECK: personal iff an owner, and never the default.
  const ownerKindValid = violates("managed_mcp_credentials_owner_kind_valid");
  await assert.rejects(f.connection(docs.id, "x", { ownerKind: "personal", ownerUserId: null }), ownerKindValid);
  await assert.rejects(f.connection(docs.id, "x", { ownerKind: "shared", ownerUserId: f.alice.id }), ownerKindValid);
  await assert.rejects(f.connection(other.id, "x", { ownerKind: "personal", ownerUserId: f.alice.id, isServerDefault: true }), ownerKindValid);
});

test("⭐ a personal Connection is never pinned nor made the default by the admin routes' services", async () => {
  const f = await seed();
  const docs = await f.app("Docs");
  const alices = await f.personal(docs.id, "alice-key", f.alice);
  const agent = await f.agent();
  await assert.rejects(
    setManagedMcpAssignment({ serverId: f.server.id, userId: f.owner.id, agentId: agent.id, mcpServerId: docs.id, connectionId: alices.id }),
    (error: unknown) => error instanceof ManagedMcpServiceError && error.code === "managed_mcp_connection_not_usable" && error.message === MCP_CONNECTION_NOT_PINNABLE_MESSAGE,
  );
  await assert.rejects(
    f.db.transaction((tx) => setServerDefaultConnection(tx, { serverId: f.server.id, mcpServerId: docs.id, connectionId: alices.id, userId: f.owner.id })),
    { code: "managed_mcp_connection_not_usable" },
  );
  assert.equal((await f.db.select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, docs.team!.id)))[0]?.isServerDefault, true, "the default is unchanged");
});
