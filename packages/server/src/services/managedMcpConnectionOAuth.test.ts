import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getDb } from "../db/index";
import {
  actionCards,
  channelAgents,
  channels,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
  mcpAppTemplates,
  messages,
  users,
} from "../db/schema";
import { createAgent } from "./agentService";
import { addMember, createServer } from "./serverService";
import { decryptManagedMcpSecret, encryptManagedMcpSecret } from "./managedMcpCredentialService";
import { ManagedMcpGatewayError, normalizeManagedMcpClientError, startManagedMcpOAuth } from "./managedMcpGateway";
import {
  createManagedMcpServer,
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  setManagedMcpAssignment,
  RAFT_APPS_MCP_SERVER_ID,
} from "./managedMcpService";
import {
  __setManagedMcpOAuthGatewayForTests,
  disconnectManagedMcpOAuthConnection,
  getManagedMcpOAuthAttemptStatus,
  replacePendingManagedMcpOAuthAttempt,
  startManagedMcpOAuthConnection,
  withManagedMcpOAuth,
} from "./managedMcpOAuthService";
import { completeManagedMcpOAuthCallback, listManagedMcpConnections } from "./managedMcpConnectionService";
import { getMcpAppView } from "./managedMcpAppService";
import { ensureMcpConnectionCard, MCP_PENDING_GRANT_WINDOW_MS, projectMcpConnectionAuthorization } from "./managedMcpConnectionCardService";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";

/** The snapshot's App tools; the fixed Raft Apps tools (on every snapshot) are asserted on their own. */
const appTools = <T extends { mcpServerId: string }>(snapshot: { tools: T[] }): T[] => snapshot.tools.filter((tool) => tool.mcpServerId !== RAFT_APPS_MCP_SERVER_ID);

const REDIRECT_URL = "https://raft.example.test/api/mcp/oauth/callback";
const ENDPOINT = "https://oauth-app.example.test/mcp";
const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

/** What the SDK builds: the state, and the client's scope when it has one (a fixed-scope client refuses any other). */
async function fakeAuthorizationUrl(provider: OAuthClientProvider): Promise<URL> {
  const url = new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(await provider.state!())}`);
  if (provider.clientMetadata.scope) url.searchParams.set("scope", provider.clientMetadata.scope);
  return url;
}

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 21).toString("base64");
  await openTestDatabase("pglite://");
  // The provider round-trips are faked; rows, attempts, leases and statuses are real.
  __setManagedMcpOAuthGatewayForTests({
    start: async (_endpoint, provider) => {
      await provider.saveCodeVerifier("fake-verifier");
      provider.redirectToAuthorization(await fakeAuthorizationUrl(provider));
      return "REDIRECT";
    },
    complete: async (_endpoint, provider, code) => {
      await provider.saveTokens({ access_token: `access-for-${code}`, token_type: "Bearer", workspace_name: "Fake Workspace" } as never);
    },
    listTools: async () => [{ name: "search", inputSchema: { type: "object" } }],
  });
});

afterEach(async () => {
  __setManagedMcpOAuthGatewayForTests(null);
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

test("an expired sign-in with no refresh token stored says so", async () => {
  const f = await seedOAuthApp();
  const second = await insertOAuthConnection(f, oauthStorage("expired-access-token"));
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: f.appId, connectionId: second.id });
  const { configVersion } = await appRow(f.appId);
  let tokenRequests = 0;
  await assert.rejects(executeManagedMcpCall(f.server.id, f.agent.id, {
    mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: configVersion, expectedAssignmentVersion: 1,
  }, undefined, async ({ provider }) => {
    try {
      await auth(provider as OAuthClientProvider, {
        serverUrl: new URL(ENDPOINT),
        fetchFn: async () => {
          tokenRequests += 1;
          return new Response("{}", { status: 500 });
        },
      });
    } catch (error) {
      throw normalizeManagedMcpClientError(error, false, "oauth");
    }
    return { content: [], isError: false };
  }), { code: "managed_mcp_login_required" });
  assert.equal(tokenRequests, 0, "nothing to renew with, so no token request");
  const expired = await connection(second.id);
  assert.equal(expired.authStatus, "expired");
  assert.equal(expired.lastError, "OAuth authorization expired and this Connection has no refresh token stored; reconnect required");
});

function oauthStorage(accessToken: string, refreshToken?: string): ManagedMcpOAuthStorage {
  return {
    redirectUrl: REDIRECT_URL,
    clientInformation: { client_id: "fake-client-id", token_endpoint_auth_method: "none" },
    tokens: { access_token: accessToken, token_type: "Bearer", ...(refreshToken ? { refresh_token: refreshToken } : {}) },
    discoveryState: {
      authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: { resource: ENDPOINT, authorization_servers: ["https://auth.example.test"] },
    },
  };
}

/** An OAuth App whose default Connection is signed in, plus an Agent. */
async function seedOAuthApp() {
  const [user] = await getDb().insert(users).values({
    email: `mcp-conn-oauth-${randomUUID()}@slock.test`,
    name: `mcp-conn-oauth-${randomUUID().slice(0, 8)}`,
    displayName: "OAuth Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP Connection OAuth", `mcp-conn-oauth-${randomUUID()}`, user.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: user.id });
  const app = await createManagedMcpServer({
    serverId: server.id, userId: user.id, name: "Docs", authMode: "oauth", endpointUrl: ENDPOINT,
  });
  await getDb().update(managedMcpCredentials)
    .set({ encryptedOAuth: encryptManagedMcpSecret(oauthStorage("default-access-token")), authStatus: "ready" })
    .where(eq(managedMcpCredentials.mcpServerId, app.id));
  await getDb().update(managedMcpServers)
    .set({ oauthStatus: "connected", toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] })
    .where(eq(managedMcpServers.id, app.id));
  const [defaultConnection] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, app.id));
  return { user, server, agent, appId: app.id, defaultConnectionId: defaultConnection.id };
}

/** A signed-in, non-default Connection created by `f.user` (the fixture Agent's owner). */
async function insertOAuthConnection(f: { server: { id: string }; appId: string; user: { id: string } }, storage: ManagedMcpOAuthStorage, name = "Second") {
  const [row] = await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: f.appId, isServerDefault: false, name, authKind: "oauth", authStatus: "ready", createdByUserId: f.user.id,
    encryptedOAuth: encryptManagedMcpSecret(storage),
  }).returning();
  return row;
}

const connection = async (id: string) =>
  (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, id)))[0];
const appRow = async (id: string) =>
  (await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, id)))[0];
const accessToken = (row: { encryptedOAuth: string | null }) =>
  (decryptManagedMcpSecret(row.encryptedOAuth!) as ManagedMcpOAuthStorage).tokens?.access_token;
const stateOf = (authorizationUrl: string) => new URL(authorizationUrl).searchParams.get("state")!;

test("⭐ a new Connection's sign-in writes a pending row, completes only that row, and leaves the default alone", async () => {
  const f = await seedOAuthApp();
  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "Second workspace" }, intent: { agentId: f.agent.id },
  });

  const pending = await connection(started.connectionId);
  assert.notEqual(pending.id, f.defaultConnectionId);
  assert.equal(pending.isServerDefault, false, "a new Connection is never the default when it is created");
  assert.equal(pending.authStatus, "pending");
  assert.equal(pending.name, "Second workspace");
  const [attempt] = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.id, started.attemptId));
  assert.equal(attempt.connectionId, pending.id, "the attempt names its Connection");
  assert.deepEqual(attempt.intent, { agentId: f.agent.id });
  assert.equal((await getManagedMcpOAuthAttemptStatus({ serverId: f.server.id, userId: f.user.id, attemptId: started.attemptId })).status, "pending");
  assert.equal((await connection(f.defaultConnectionId)).authStatus, "ready", "starting a sign-in elsewhere leaves the default usable");
  assert.equal((await appRow(f.appId)).oauthStatus, "connected", "and the App-level mirror of the default alone");

  const completion = await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "second-code" });
  assert.equal(completion.connectionId, pending.id);
  const signedIn = await connection(pending.id);
  assert.equal(signedIn.authStatus, "ready");
  assert.equal(accessToken(signedIn), "access-for-second-code");
  assert.equal(signedIn.accountLabel, "Fake Workspace");
  assert.equal(signedIn.isServerDefault, false, "a sign-in without makeDefault does not move the default");
  const untouched = await connection(f.defaultConnectionId);
  assert.equal(accessToken(untouched), "default-access-token", "⭐ the callback wrote only its own Connection");
  assert.equal(untouched.authStatus, "ready");
  assert.equal((await getManagedMcpOAuthAttemptStatus({ serverId: f.server.id, userId: f.user.id, attemptId: started.attemptId })).status, "connected");
});

test("⭐ reauthorizing a Connection reuses its row and replaces only its own pending sign-in", async () => {
  const f = await seedOAuthApp();
  const first = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "Second" },
  });
  await completeManagedMcpOAuthCallback({ state: stateOf(first.authorizationUrl), authorizationCode: "first-code" });
  // A pending sign-in on the default must survive a reauthorization of another Connection.
  const defaultAttempt = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
  });
  assert.equal(defaultAttempt.connectionId, f.defaultConnectionId, "no target means the App's default");
  const countRows = async () => (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, f.appId))).length;
  assert.equal(await countRows(), 2);

  const again = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { connectionId: first.connectionId },
  });
  const replaced = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { connectionId: first.connectionId },
  });
  assert.equal(again.connectionId, first.connectionId);
  assert.equal(await countRows(), 2, "⭐ reauthorize writes no new Connection");
  const status = (attemptId: string) => getManagedMcpOAuthAttemptStatus({ serverId: f.server.id, userId: f.user.id, attemptId });
  assert.equal((await status(again.attemptId)).status, "failed", "the older sign-in for the same Connection is replaced");
  assert.equal((await status(defaultAttempt.attemptId)).status, "pending", "another Connection's sign-in is not");

  await completeManagedMcpOAuthCallback({ state: stateOf(replaced.authorizationUrl), authorizationCode: "reauth-code" });
  assert.equal(accessToken(await connection(first.connectionId)), "access-for-reauth-code");
});

test("⭐ an old-shape attempt (no connection_id) completes against the App's default Connection", async () => {
  const f = await seedOAuthApp();
  const other = await insertOAuthConnection(f, oauthStorage("other-access-token"));
  await replacePendingManagedMcpOAuthAttempt({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId,
    configVersion: (await appRow(f.appId)).configVersion, state: "legacy-state",
  });
  const [legacy] = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.mcpServerId, f.appId));
  assert.ok(legacy.connectionId === null, "written the way an older binary writes it");

  const completion = await completeManagedMcpOAuthCallback({ state: "legacy-state", authorizationCode: "legacy-code" });
  assert.equal(completion.connectionId, f.defaultConnectionId);
  assert.equal(accessToken(await connection(f.defaultConnectionId)), "access-for-legacy-code");
  assert.equal(accessToken(await connection(other.id)), "other-access-token", "the other Connection is untouched");
  assert.equal((await appRow(f.appId)).oauthStatus, "connected");
});

test("⭐ an Agent pinned to a non-default OAuth Connection uses it, even while the default is expired", async () => {
  const f = await seedOAuthApp();
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.defaultConnectionId));
  await getDb().update(managedMcpServers).set({ oauthStatus: "error" }).where(eq(managedMcpServers.id, f.appId));
  const second = await insertOAuthConnection(f, oauthStorage("second-access-token"));
  const defaultAgent = await createAgent(f.server.id, `default-${randomUUID().slice(0, 8)}`);
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: f.appId, connectionId: second.id });

  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(f.server.id, f.agent.id)).map((tool) => tool.toolName), ["search"],
    "the pinned Agent is offered the tools");
  assert.deepEqual(appTools(await getManagedMcpRuntimeSnapshot(f.server.id, defaultAgent.id)).map((tool) => tool.toolName), ["search"],
    "an Agent on the expired default is offered them too: its call is refused, which raises the Connect card");

  const { configVersion } = await appRow(f.appId);
  const tokensSeen: Array<string | undefined> = [];
  const call = (agentId: string) => executeManagedMcpCall(f.server.id, agentId, {
    mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: configVersion, expectedAssignmentVersion: 1,
  }, undefined, async ({ provider }) => {
    tokensSeen.push((await provider.tokens())?.access_token);
    return { content: [], isError: false };
  });
  await call(f.agent.id);
  assert.deepEqual(tokensSeen, ["second-access-token"], "⭐ admitted, and with the pinned Connection's own tokens");
  await assert.rejects(call(defaultAgent.id), { code: "managed_mcp_login_required" });
  assert.equal(tokensSeen.length, 1);
});

test("⭐ a refresh failure marks only that Connection expired, and the Agent is told login_required", async () => {
  const f = await seedOAuthApp();
  const second = await insertOAuthConnection(f, oauthStorage("expired-access-token", "revoked-refresh-token"));
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: f.appId, connectionId: second.id });
  const { configVersion } = await appRow(f.appId);
  let providerCalls = 0;
  const call = () => executeManagedMcpCall(f.server.id, f.agent.id, {
    mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: configVersion, expectedAssignmentVersion: 1,
  }, undefined, async ({ provider }) => {
    providerCalls += 1;
    try {
      await auth(provider as OAuthClientProvider, {
        serverUrl: new URL(ENDPOINT),
        fetchFn: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        }),
      });
    } catch (error) {
      throw normalizeManagedMcpClientError(error, false, "oauth");
    }
    return { content: [], isError: false };
  });

  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  const expired = await connection(second.id);
  assert.equal(expired.authStatus, "expired", "⭐ the refreshed Connection is expired");
  assert.equal(expired.lastError, "OAuth renewal refused by the provider (invalid_grant); reconnect required");
  assert.equal((await connection(f.defaultConnectionId)).authStatus, "ready", "⭐ the default is not");
  const app = await appRow(f.appId);
  assert.equal(app.oauthStatus, "connected", "and neither is the App-level mirror of the default");
  assert.ok(app.lastCheckError === null);

  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  assert.equal(providerCalls, 1, "the next call is refused by admission, before provider I/O");
});

test("OAuth leases are per Connection: two Connections of one App run concurrently", async () => {
  const f = await seedOAuthApp();
  const second = await insertOAuthConnection(f, oauthStorage("second-access-token"));
  const events: string[] = [];
  let release!: () => void;
  let held!: () => void;
  const heldPromise = new Promise<void>((resolve) => { held = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withManagedMcpOAuth(f.server.id, f.appId, async () => {
    events.push("default-start");
    held();
    await gate;
    events.push("default-end");
  });
  await heldPromise;
  await withManagedMcpOAuth(f.server.id, f.appId, async () => {
    events.push("second-ran");
  }, undefined, second.id);
  release();
  await first;
  assert.deepEqual(events, ["default-start", "second-ran", "default-end"]);
});

test("disconnecting one Connection clears only its tokens and its pending sign-ins", async () => {
  const f = await seedOAuthApp();
  const second = await insertOAuthConnection(f, oauthStorage("second-access-token"));
  const pendingOnDefault = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
  });
  const pendingOnSecond = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { connectionId: second.id },
  });
  await disconnectManagedMcpOAuthConnection(f.server.id, f.appId, second.id);
  const cleared = await connection(second.id);
  assert.equal(accessToken(cleared), undefined);
  assert.equal((decryptManagedMcpSecret(cleared.encryptedOAuth!) as ManagedMcpOAuthStorage).clientInformation, undefined);
  assert.equal(cleared.authStatus, "needs_auth");
  const status = (attemptId: string) => getManagedMcpOAuthAttemptStatus({ serverId: f.server.id, userId: f.user.id, attemptId });
  assert.equal((await status(pendingOnSecond.attemptId)).status, "failed");
  assert.equal((await status(pendingOnDefault.attemptId)).status, "pending");
  assert.ok((await connection(f.defaultConnectionId)).encryptedOAuth !== null);
});

test("⭐ makeDefault after sign-in moves the default and closes the cards of Agents it admits", async () => {
  const f = await seedOAuthApp();
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.defaultConnectionId));
  await getDb().update(managedMcpServers).set({ oauthStatus: "error" }).where(eq(managedMcpServers.id, f.appId));
  const [channel] = await getDb().insert(channels).values({ serverId: f.server.id, name: `c-${randomUUID().slice(0, 8)}` }).returning();
  await getDb().insert(channelAgents).values({ channelId: channel.id, agentId: f.agent.id });
  const [message] = await getDb().insert(messages).values({
    channelId: channel.id, senderType: "agent", senderId: f.agent.id, content: "turn",
  }).returning();
  const card = await ensureMcpConnectionCard({
    serverId: f.server.id, agentId: f.agent.id, mcpServerId: f.appId, revision: 1, origin: { sourceMessageId: message.id },
  });
  assert.ok(card.cardMessageId !== null);
  const cardState = async () => (await getDb().select().from(actionCards).where(and(
    eq(actionCards.requesterAgentId, f.agent.id), eq(actionCards.messageId, card.cardMessageId!),
  )))[0].state;

  // Without makeDefault the new Connection is ready but nobody follows it: the card stays open.
  const plain = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { newConnectionName: "Plain" },
  });
  await completeManagedMcpOAuthCallback({ state: stateOf(plain.authorizationUrl), authorizationCode: "plain-code" });
  assert.equal(await cardState(), "prepared");

  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "Team" }, intent: { makeDefault: true },
  });
  await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "team-code" });
  assert.equal((await connection(started.connectionId)).isServerDefault, true, "⭐ the signed-in Connection is the default");
  assert.equal((await connection(f.defaultConnectionId)).isServerDefault, false);
  assert.equal((await appRow(f.appId)).oauthStatus, "connected", "the App mirror follows the new default");
  assert.equal(await cardState(), "executed", "⭐ the Agent following the default is admitted, so its card closes");
});

test("a failed start removes the Connection it created and leaves nothing pending", async () => {
  const f = await seedOAuthApp();
  __setManagedMcpOAuthGatewayForTests({
    start: async () => { throw new Error("authorization server unreachable"); },
  });
  await assert.rejects(startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { newConnectionName: "Doomed" },
  }));
  const rows = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, f.appId));
  assert.deepEqual(rows.map((row) => row.id), [f.defaultConnectionId]);
  const attempts = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.mcpServerId, f.appId));
  assert.ok(attempts.every((attempt) => attempt.status !== "pending"));
});

test("⭐ abandoned new-Connection sign-ins do not pile up: a retry reuses the row, expired orphans are removed", async () => {
  const f = await seedOAuthApp();
  const start = (name: string) => startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { newConnectionName: name },
  });
  const nonDefault = async () => (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, f.appId)))
    .filter((row) => !row.isServerDefault);

  // The popup is closed twice; each retry under the same name reuses the row.
  const first = await start("Team");
  const retry = await start("Team");
  assert.equal(retry.connectionId, first.connectionId, "⭐ a retry reuses the abandoned row");
  assert.equal((await nonDefault()).length, 1);
  const [replaced] = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.id, first.attemptId));
  assert.equal(replaced.status, "failed", "the retry's attempt replaces the abandoned one");

  // Other rows that must survive cleanup: a completed sign-in, a pinned row, a fresh row with a live attempt.
  const done = await start("Done");
  await completeManagedMcpOAuthCallback({ state: stateOf(done.authorizationUrl), authorizationCode: "done-code" });
  const pinned = await start("Pinned");
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: f.appId, connectionId: pinned.connectionId });
  const live = await start("Live");

  // Everything ages past the attempt TTL except "Live", whose attempt is still open.
  const longAgo = new Date(Date.now() - 60 * 60_000);
  for (const id of [first.connectionId, done.connectionId, pinned.connectionId]) {
    await getDb().update(managedMcpCredentials).set({ createdAt: longAgo }).where(eq(managedMcpCredentials.id, id));
    await getDb().update(managedMcpOAuthAttempts).set({ expiresAt: longAgo }).where(eq(managedMcpOAuthAttempts.connectionId, id));
  }
  await getDb().update(managedMcpCredentials).set({ createdAt: longAgo }).where(eq(managedMcpCredentials.id, live.connectionId));

  const next = await start("Another");
  const remaining = new Set((await nonDefault()).map((row) => row.id));
  assert.equal(remaining.has(first.connectionId), false, "⭐ the expired, never-completed row is removed");
  for (const [label, id] of [["completed", done.connectionId], ["pinned", pinned.connectionId], ["live attempt", live.connectionId], ["new", next.connectionId]] as const) {
    assert.ok(remaining.has(id), `${label} Connection is kept`);
  }
  assert.ok(remaining.has(f.defaultConnectionId) === false && (await connection(f.defaultConnectionId)) !== undefined, "the default is never touched");
});

/**
 * ⭐ D4 "Ready to grant": a sign-in started from an Agent's Connect card never grants by itself; the
 * card offers the new Connection to the person who signed it in until they Grant (or it gets old).
 */
test("⭐ pendingGrant: the viewer's own finished sign-in for this Agent, until the Agent uses it", async () => {
  const f = await seedOAuthApp();
  // The Agent is refused: its default's sign-in expired.
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.defaultConnectionId));
  const project = (viewerUserId: string) => projectMcpConnectionAuthorization({ serverId: f.server.id, viewerUserId, mcpServerId: f.appId, agentId: f.agent.id });

  const before = await project(f.user.id);
  assert.equal(before.viewerRole, "server_manager");
  assert.deepEqual(before.app, { name: "Docs", authKind: "oauth" });
  assert.equal(before.canAuthorizeNew, true);
  assert.equal(before.canSetServerDefault, true);
  assert.equal(before.pendingGrant, null);

  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "Kai's Docs" }, intent: { agentId: f.agent.id },
  });
  assert.equal((await project(f.user.id)).pendingGrant, null, "not while the sign-in is still pending");
  await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "card-code" });

  const after = await project(f.user.id);
  assert.deepEqual(after.pendingGrant, { connectionId: started.connectionId, name: "Kai's Docs" }, "⭐ Ready to grant");
  await assert.rejects(
    executeManagedMcpCall(f.server.id, f.agent.id, { mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: (await appRow(f.appId)).configVersion, expectedAssignmentVersion: 1 }),
    { code: "managed_mcp_login_required" },
    "⭐ the finished sign-in did not grant the Agent anything",
  );

  // Someone else (the Agent's own manager here) is not offered another person's sign-in.
  const [other] = await getDb().insert(users).values({
    email: `mcp-other-${randomUUID()}@slock.test`, name: `mcp-other-${randomUUID().slice(0, 8)}`, displayName: "Other", passwordHash: "hash", emailVerified: true,
  }).returning();
  await addMember(f.server.id, other.id, "member");
  const managed = await createAgent(f.server.id, `managed-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: other.id });
  const asAgentManager = await projectMcpConnectionAuthorization({ serverId: f.server.id, viewerUserId: other.id, mcpServerId: f.appId, agentId: managed.id });
  assert.equal(asAgentManager.viewerRole, "agent_manager");
  assert.equal(asAgentManager.canSetServerDefault, false, "⭐ an Agent manager may never move the default");
  assert.equal(asAgentManager.canAuthorizeNew, false);
  assert.equal(asAgentManager.pendingGrant, null);
  // Another server manager looking at the SAME Agent's card is not offered it either: it is the
  // signer's to grant or discard.
  const [admin] = await getDb().insert(users).values({
    email: `mcp-admin-${randomUUID()}@slock.test`, name: `mcp-admin-${randomUUID().slice(0, 8)}`, displayName: "Admin", passwordHash: "hash", emailVerified: true,
  }).returning();
  await addMember(f.server.id, admin.id, "admin");
  const asOtherAdmin = await project(admin.id);
  assert.equal(asOtherAdmin.viewerRole, "server_manager");
  assert.equal(asOtherAdmin.pendingGrant, null, "⭐ only the person who signed in is offered the pending grant");

  // Too old: no longer offered.
  await getDb().update(managedMcpOAuthAttempts)
    .set({ createdAt: new Date(Date.now() - MCP_PENDING_GRANT_WINDOW_MS - 60_000) })
    .where(eq(managedMcpOAuthAttempts.id, started.attemptId));
  assert.equal((await project(f.user.id)).pendingGrant, null, "an old sign-in is not offered");
  await getDb().update(managedMcpOAuthAttempts).set({ createdAt: new Date() }).where(eq(managedMcpOAuthAttempts.id, started.attemptId));

  // Granted: the Agent uses it, so there is nothing left to grant.
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: f.appId, enabled: true, connectionId: started.connectionId });
  assert.equal((await project(f.user.id)).pendingGrant, null, "⭐ once the Agent uses it, it is not offered again");
});

test("⭐ pendingGrant: a server manager's sign-in for someone else's Agent is not offered, because it could not be pinned", async () => {
  const f = await seedOAuthApp();
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.defaultConnectionId));
  const [admin] = await getDb().insert(users).values({
    email: `mcp-signer-${randomUUID()}@slock.test`, name: `mcp-signer-${randomUUID().slice(0, 8)}`, displayName: "Admin", passwordHash: "hash", emailVerified: true,
  }).returning();
  await addMember(f.server.id, admin.id, "admin");
  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: admin.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "Admin's Docs" }, intent: { agentId: f.agent.id },
  });
  await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "admin-code" });
  const view = await projectMcpConnectionAuthorization({ serverId: f.server.id, viewerUserId: admin.id, mcpServerId: f.appId, agentId: f.agent.id });
  assert.equal(view.viewerRole, "server_manager");
  assert.equal(view.newConnectionPinnable, false, "the admin is not this Agent's owner");
  assert.equal(view.pendingGrant, null, "⭐ not offered as Ready to grant");
  assert.ok(!view.candidates.some((candidate) => candidate.connectionId === started.connectionId), "nor as a candidate");
  await assert.rejects(
    setManagedMcpAssignment({ serverId: f.server.id, userId: admin.id, agentId: f.agent.id, mcpServerId: f.appId, enabled: true, connectionId: started.connectionId }),
    { code: "managed_mcp_connection_not_usable" },
  );
});

test("canAuthorizeNew: an App without auth needs no Connection; an API-key one is a server manager's to add", async () => {
  const f = await seedOAuthApp();
  const project = () => projectMcpConnectionAuthorization({ serverId: f.server.id, viewerUserId: f.user.id, mcpServerId: f.appId, agentId: f.agent.id });
  await getDb().update(managedMcpServers).set({ authMode: "none" }).where(eq(managedMcpServers.id, f.appId));
  const none = await project();
  assert.equal(none.canAuthorizeNew, false);
  assert.equal(none.canSetServerDefault, false);
  await getDb().update(managedMcpServers).set({ authMode: "headers" }).where(eq(managedMcpServers.id, f.appId));
  assert.equal((await project()).canAuthorizeNew, true, "an API-key Connection is a server manager's to add (in the App's settings)");
});

/**
 * ⭐ An App may run with several Connections, each pinned to its own Agent, and no default at all.
 * Nothing makes a default except an explicit choice: a new Connection's sign-in without makeDefault
 * leaves the App without one and every pin where it was.
 */
test("⭐ three Connections pinned to three Agents and no default: authorizing a fourth unchecked leaves no default and the pins alone", async () => {
  const f = await seedOAuthApp();
  await getDb().delete(managedMcpCredentials).where(eq(managedMcpCredentials.id, f.defaultConnectionId));
  const pins: Array<{ agentId: string; connectionId: string }> = [];
  for (const name of ["A", "B", "C"]) {
    const connection = await insertOAuthConnection(f, oauthStorage(`token-${name}`), name);
    const agent = await createAgent(f.server.id, `pinned-${name}-${randomUUID().slice(0, 6)}`, { creatorType: "user", creatorId: f.user.id });
    await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: agent.id, mcpServerId: f.appId, enabled: true, connectionId: connection.id });
    pins.push({ agentId: agent.id, connectionId: connection.id });
  }
  const defaults = async () => (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, f.appId)))
    .filter((row) => row.isServerDefault).map((row) => row.id);
  assert.deepEqual(await defaults(), []);

  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "D" }, intent: { agentId: f.agent.id },
  });
  await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "fourth" });
  assert.equal((await connection(started.connectionId)).authStatus, "ready");
  assert.deepEqual(await defaults(), [], "⭐ still no default");
  const assignments = await getDb().select().from(managedMcpAssignments).where(eq(managedMcpAssignments.mcpServerId, f.appId));
  for (const pin of pins) {
    const row = assignments.find((assignment) => assignment.agentId === pin.agentId);
    assert.deepEqual({ mode: row?.connectionMode, bound: row?.boundConnectionId }, { mode: "pinned", bound: pin.connectionId }, "⭐ each pin untouched");
  }
});


test("registered clients belong to one Connection, survive sign-out, and never appear in views", async () => {
  const f = await seedOAuthApp();
  const client = { clientId: "private-client", clientSecret: "private-secret", tokenEndpointAuthMethod: "client_secret_post" as const };
  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { newConnectionName: "Registered" }, oauthClient: client,
  });
  const stored = () => connection(started.connectionId);
  const state = async () => decryptManagedMcpSecret((await stored()).encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.deepEqual((await state()).configuredClient, client);
  assert.equal(accessToken(await connection(f.defaultConnectionId)), "default-access-token");
  const views = await listManagedMcpConnections(f.server.id, f.appId);
  assert.equal(views.find((row) => row.id === started.connectionId)?.hasConfiguredOAuthClient, true);
  assert.ok(!JSON.stringify(views).includes("private-client"));
  assert.ok(!JSON.stringify(views).includes("private-secret"));
  await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "registered" });
  await disconnectManagedMcpOAuthConnection(f.server.id, f.appId, started.connectionId);
  assert.deepEqual((await state()).configuredClient, client);
  assert.equal((await state()).tokens, undefined);
  const again = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { connectionId: started.connectionId },
  });
  assert.deepEqual((await state()).configuredClient, client, "omission keeps this Connection's client");
  await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { connectionId: started.connectionId }, oauthClient: null,
  });
  assert.equal((await state()).configuredClient, undefined);
  await assert.rejects(completeManagedMcpOAuthCallback({ state: stateOf(again.authorizationUrl), authorizationCode: "old" }));
  assert.equal(accessToken(await connection(f.defaultConnectionId)), "default-access-token");
});

test("a consumed old callback cannot exchange against a replacement client's state or poison its status", async () => {
  const f = await seedOAuthApp();
  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { connectionId: f.defaultConnectionId },
  });
  const row = await connection(f.defaultConnectionId);
  const storage = decryptManagedMcpSecret(row.encryptedOAuth!) as ManagedMcpOAuthStorage;
  // Model the newer sign-in which acquired the lease while this callback was waiting for it.
  storage.authorizationState = "newer-sign-in";
  storage.configuredClient = { clientId: "new-client", tokenEndpointAuthMethod: "none" };
  await getDb().update(managedMcpCredentials).set({ encryptedOAuth: encryptManagedMcpSecret(storage) }).where(eq(managedMcpCredentials.id, row.id));
  let exchanges = 0;
  __setManagedMcpOAuthGatewayForTests({ complete: async () => { exchanges++; } });
  await assert.rejects(completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: "stale" }), /replaced/);
  assert.equal(exchanges, 0);
  assert.equal((await connection(row.id)).authStatus, "pending");
});


test("a Google Workspace MCP App takes only the Client ID and secret; Raft fixes the rest", async () => {
  const f = await seedOAuthApp();
  await getDb().update(managedMcpServers).set({ endpointUrl: "https://docsmcp.googleapis.com/mcp/v1" }).where(eq(managedMcpServers.id, f.appId));
  const start = (oauthClient: unknown) => startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
    connection: { connectionId: f.defaultConnectionId }, oauthClient: oauthClient as never,
  });

  await assert.rejects(start(null), { code: "managed_mcp_oauth_client_registration_unsupported" }, "Google has no automatic registration");
  await assert.rejects(start(undefined), { code: "managed_mcp_oauth_client_registration_unsupported" }, "keeping no client is refused before any network request too");
  await assert.rejects(start({ clientId: "web-client", tokenEndpointAuthMethod: "none" }), { code: "managed_mcp_credential_invalid" }, "a Web client needs its secret");

  await start({ clientId: "web-client", clientSecret: "web-secret", tokenEndpointAuthMethod: "client_secret_basic", scope: "openid", requestOfflineAccess: false });
  const storage = decryptManagedMcpSecret((await connection(f.defaultConnectionId)).encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.deepEqual(storage.configuredClient, {
    clientId: "web-client",
    clientSecret: "web-secret",
    tokenEndpointAuthMethod: "client_secret_post",
    scope: "https://www.googleapis.com/auth/documents",
    requestOfflineAccess: true,
  }, "the method, offline access and Docs' least-privilege scope are fixed, whatever was sent");

  // A client saved before the policy existed is brought in line when it is kept, without re-entering its secret.
  const legacy = await insertOAuthConnection(f, {
    redirectUrl: REDIRECT_URL,
    configuredClient: { clientId: "legacy", clientSecret: "legacy-secret", tokenEndpointAuthMethod: "client_secret_basic", scope: "openid" },
  }, "Legacy");
  await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { connectionId: legacy.id },
  });
  assert.deepEqual((decryptManagedMcpSecret((await connection(legacy.id)).encryptedOAuth!) as ManagedMcpOAuthStorage).configuredClient, {
    clientId: "legacy", clientSecret: "legacy-secret", tokenEndpointAuthMethod: "client_secret_post", scope: "https://www.googleapis.com/auth/documents", requestOfflineAccess: true,
  });
});

test("with Raft's Google client configured, a Google Connection signs in with it unless the user brings their own", async () => {
  const saved = { id: process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID, secret: process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET };
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID = "raft-client.apps.googleusercontent.com";
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET = "raft-secret";
  try {
    const f = await seedOAuthApp();
    await getDb().update(managedMcpServers).set({ endpointUrl: "https://docsmcp.googleapis.com/mcp/v1" }).where(eq(managedMcpServers.id, f.appId));
    let seenClient: unknown;
    __setManagedMcpOAuthGatewayForTests({
      start: async (_endpoint, provider) => {
        seenClient = { info: await provider.clientInformation(), method: provider.clientMetadata.token_endpoint_auth_method };
        provider.redirectToAuthorization(await fakeAuthorizationUrl(provider));
        return "REDIRECT";
      },
    });
    const start = (oauthClient?: unknown) => startManagedMcpOAuthConnection({
      serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
      connection: { newConnectionName: `Docs ${randomUUID().slice(0, 4)}` },
      ...(oauthClient === undefined ? {} : { oauthClient: oauthClient as never }),
    });
    const stored = async (connectionId: string) => decryptManagedMcpSecret((await connection(connectionId)).encryptedOAuth!) as ManagedMcpOAuthStorage;

    const first = await start();
    const raft = await stored(first.connectionId);
    assert.equal(raft.raftClient, "google");
    assert.equal(raft.raftClientScope, "https://www.googleapis.com/auth/documents", "Raft's client requests the policy's scopes");
    assert.doesNotMatch(JSON.stringify(raft), /raft-secret/u);
    assert.equal(raft.configuredClient, undefined, "the secret is read from the deployment, never stored per Connection");
    assert.deepEqual(seenClient, {
      info: { client_id: "raft-client.apps.googleusercontent.com", client_secret: "raft-secret", token_endpoint_auth_method: "client_secret_post" },
      method: "client_secret_post",
    });
    assert.match(new URL((await start(null)).authorizationUrl).search, /state=/u, "choosing automatic means Raft's client, not a refusal");

    const own = await start({ clientId: "own", clientSecret: "own-secret", tokenEndpointAuthMethod: "client_secret_post" });
    const ownStorage = await stored(own.connectionId);
    assert.equal(ownStorage.raftClient, undefined);
    assert.equal(ownStorage.raftClientScope, undefined);
    assert.equal(ownStorage.configuredClient?.clientId, "own");
  } finally {
    if (saved.id === undefined) delete process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID; else process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET; else process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET = saved.secret;
  }
});

test("a deployment listing only some Google services offers Raft's client for those alone; the others keep their own client", async () => {
  const keys = ["MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID", "MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET", "MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID = "raft-client.apps.googleusercontent.com";
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET = "raft-secret";
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES = "docs,sheets,slides,calendar";
  try {
    const f = await seedOAuthApp();
    const gmail = await createManagedMcpServer({
      serverId: f.server.id, userId: f.user.id, name: "Gmail", authMode: "oauth", endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    });
    await getDb().update(managedMcpServers).set({ endpointUrl: "https://docsmcp.googleapis.com/mcp/v1" }).where(eq(managedMcpServers.id, f.appId));
    const start = (mcpServerId: string, oauthClient?: unknown) => startManagedMcpOAuthConnection({
      serverId: f.server.id, userId: f.user.id, mcpServerId, redirectUrl: REDIRECT_URL,
      connection: { newConnectionName: `Google ${randomUUID().slice(0, 4)}` },
      ...(oauthClient === undefined ? {} : { oauthClient: oauthClient as never }),
    });
    const stored = async (connectionId: string) => decryptManagedMcpSecret((await connection(connectionId)).encryptedOAuth!) as ManagedMcpOAuthStorage;

    // The App view the web reads: Docs offers Sign in with Raft, Gmail the own-client form.
    assert.equal((await getMcpAppView(f.server.id, f.appId, f.user.id)).server.raftOAuthClient, true);
    assert.equal((await getMcpAppView(f.server.id, gmail.id, f.user.id)).server.raftOAuthClient, false);

    const docs = await start(f.appId);
    assert.equal((await stored(docs.connectionId)).raftClient, "google", "a listed service signs in with Raft's client");

    await assert.rejects(start(gmail.id), { code: "managed_mcp_oauth_client_registration_unsupported" }, "an unlisted service never gets Raft's client");
    await assert.rejects(start(gmail.id, null), { code: "managed_mcp_oauth_client_registration_unsupported" });
    const own = await start(gmail.id, { clientId: "own", clientSecret: "own-secret", tokenEndpointAuthMethod: "client_secret_post" });
    const ownStorage = await stored(own.connectionId);
    assert.equal(ownStorage.raftClient, undefined);
    assert.equal(ownStorage.configuredClient?.clientId, "own", "its own client still signs in");
    assert.equal(ownStorage.configuredClient?.scope, "https://www.googleapis.com/auth/gmail.modify");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("Airtable signs in by dynamic registration through the real SDK, also when reconnecting a metadata-URL client", async () => {
  // Airtable's real metadata advertises both client metadata documents and registration.
  const registrations: unknown[] = [];
  const authServer = (host: string) => ({
    issuer: `https://${host}/oauth2/v1`,
    authorization_endpoint: `https://${host}/oauth2/v1/authorize`,
    token_endpoint: `https://${host}/oauth2/v1/token`,
    registration_endpoint: `https://${host}/oauth2/v1/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      const mcpHost = url.hostname;
      const asHost = mcpHost === "mcp.airtable.com" ? "airtable.com" : "auth.example.test";
      return Response.json({ resource: `https://${mcpHost}/mcp`, authorization_servers: [`https://${asHost}/oauth2/v1`] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return Response.json(authServer(url.hostname));
    if (url.pathname === "/oauth2/v1/register") {
      registrations.push(JSON.parse(String(init?.body)));
      return Response.json({ client_id: "airtable-registered-client", redirect_uris: [REDIRECT_URL], token_endpoint_auth_method: "none" }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  __setManagedMcpOAuthGatewayForTests({ start: (endpoint, provider) => startManagedMcpOAuth(endpoint, provider, fakeFetch) });
  const f = await seedOAuthApp();
  const start = async (connection: Parameters<typeof startManagedMcpOAuthConnection>[0]["connection"]) => new URL((await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection,
  })).authorizationUrl);

  // Control: an ordinary server advertising both uses Raft's metadata URL and registers nothing.
  await getDb().update(managedMcpServers).set({ endpointUrl: "https://mcp.example-both.test/mcp" }).where(eq(managedMcpServers.id, f.appId));
  const other = await start({ newConnectionName: "Other" });
  assert.equal(other.searchParams.get("client_id"), "https://raft.example.test/api/mcp/oauth/client-metadata");
  assert.equal(registrations.length, 0);

  await getDb().update(managedMcpServers).set({ endpointUrl: "https://mcp.airtable.com/mcp" }).where(eq(managedMcpServers.id, f.appId));
  const fresh = await start({ newConnectionName: "Airtable" });
  assert.equal(fresh.searchParams.get("client_id"), "airtable-registered-client", "the authorization uses the registered client");
  assert.equal(registrations.length, 1);
  assert.deepEqual((registrations[0] as { redirect_uris: string[] }).redirect_uris, [REDIRECT_URL]);

  // A Connection that signed in before this fix still holds the metadata-URL client: reconnecting registers.
  const legacy = await insertOAuthConnection(f, {
    redirectUrl: REDIRECT_URL,
    clientInformation: { client_id: "https://raft.example.test/api/mcp/oauth/client-metadata" },
  }, "Legacy Airtable");
  const reconnect = await start({ connectionId: legacy.id });
  assert.equal(reconnect.searchParams.get("client_id"), "airtable-registered-client");
  assert.equal(registrations.length, 2);
  const stored = decryptManagedMcpSecret((await connection(legacy.id)).encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.equal(stored.clientInformation?.client_id, "airtable-registered-client");
  assert.equal(stored.clientMetadataUrl, undefined);
});

test("a template's client mode decides between automatic registration and a registered client", async () => {
  const f = await seedOAuthApp();
  await getDb().update(managedMcpServers).set({ templateKey: "asana" }).where(eq(managedMcpServers.id, f.appId));
  const setMode = (mode: "automatic" | "registered" | "either") =>
    getDb().update(mcpAppTemplates).set({ oauthClientMode: mode }).where(eq(mcpAppTemplates.key, "asana"));
  const start = (oauthClient: unknown, connection: Parameters<typeof startManagedMcpOAuthConnection>[0]["connection"] = { newConnectionName: `Asana ${randomUUID().slice(0, 4)}` }) =>
    startManagedMcpOAuthConnection({
      serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection,
      ...(oauthClient === undefined ? {} : { oauthClient: oauthClient as never }),
    });
  const own = { clientId: "asana-own", tokenEndpointAuthMethod: "none" };

  // Default: either. Both paths stay open, as before the column existed.
  assert.equal((await getMcpAppView(f.server.id, f.appId, f.user.id)).server.oauthClientMode, "either");
  await start(null);
  await start(own);

  await setMode("registered");
  assert.equal((await getMcpAppView(f.server.id, f.appId, f.user.id)).server.oauthClientMode, "registered");
  await assert.rejects(start(null), { code: "managed_mcp_oauth_client_registration_unsupported" });
  await assert.rejects(start(undefined), { code: "managed_mcp_oauth_client_registration_unsupported" }, "a new Connection with no client is refused too");
  const registered = await start(own);
  const stored = decryptManagedMcpSecret((await connection(registered.connectionId)).encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.deepEqual(stored.configuredClient, own, "method, scope and the optional secret stay the user's: no provider rules apply");

  await setMode("automatic");
  await assert.rejects(start(own), { code: "managed_mcp_credential_invalid" });
  await start(null);
  await start(undefined, { connectionId: registered.connectionId });

  // An older template App names its template only in `provider`; it follows that template's mode.
  await getDb().update(managedMcpServers).set({ templateKey: null, sourceKind: null, provider: "notion" }).where(eq(managedMcpServers.id, f.appId));
  await getDb().update(mcpAppTemplates).set({ oauthClientMode: "registered" }).where(eq(mcpAppTemplates.key, "notion"));
  assert.equal((await getMcpAppView(f.server.id, f.appId, f.user.id)).server.oauthClientMode, "registered");
  await assert.rejects(start(null), { code: "managed_mcp_oauth_client_registration_unsupported" });
  // An App added by URL has no template to follow.
  await getDb().update(managedMcpServers).set({ sourceKind: "url", provider: "custom" }).where(eq(managedMcpServers.id, f.appId));
  await start(null);
});

test("an in-flight refresh cannot restore credentials after client replacement or sign-out", async () => {
  for (const [operation, normalized] of [["replace", false], ["replace", true], ["disconnect", false], ["disconnect", true]] as const) {
    const f = await seedOAuthApp();
    await assert.rejects(withManagedMcpOAuth(f.server.id, f.appId, async (_server, provider) => {
      if (operation === "replace") {
        await startManagedMcpOAuthConnection({
          serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL,
          connection: { connectionId: f.defaultConnectionId },
          oauthClient: { clientId: "replacement", tokenEndpointAuthMethod: "none" },
        });
      } else {
        await disconnectManagedMcpOAuthConnection(f.server.id, f.appId, f.defaultConnectionId);
      }
      try {
        await provider.saveTokens({ access_token: "stale-refresh", token_type: "Bearer" });
      } catch (error) {
        throw normalized ? normalizeManagedMcpClientError(error, false, "oauth") : error;
      }
    }), { code: normalized ? "managed_mcp_unreachable" : "managed_mcp_oauth_invalid_state" });
    const current = await connection(f.defaultConnectionId);
    const storage = decryptManagedMcpSecret(current.encryptedOAuth!) as ManagedMcpOAuthStorage;
    assert.equal(storage.tokens, undefined);
    assert.equal(storage.configuredClient?.clientId, operation === "replace" ? "replacement" : undefined);
    assert.deepEqual({ status: current.authStatus, error: current.lastError }, {
      status: operation === "replace" ? "pending" : "needs_auth",
      error: null,
    }, "a rejected stale refresh must not overwrite the newer Connection status");
    const [app] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, f.appId));
    assert.equal(app.oauthStatus, operation === "replace" ? "pending" : "disconnected", "the default Connection's App mirror stays unchanged");
  }
});

test("a failed callback records which step failed and the provider's reason on the Connection", async () => {
  const fakeStart: Parameters<typeof __setManagedMcpOAuthGatewayForTests>[0] & object = {
    start: async (_endpoint, provider) => {
      provider.redirectToAuthorization(await fakeAuthorizationUrl(provider));
      return "REDIRECT";
    },
  };
  // Google answers a Web client sent without its secret with invalid_client at the token endpoint.
  const f = await seedOAuthApp();
  __setManagedMcpOAuthGatewayForTests({
    ...fakeStart,
    complete: async () => {
      throw new ManagedMcpGatewayError("MCP OAuth token exchange failed; check the client configuration and reconnect", "managed_mcp_unreachable", {
        cause: new InvalidClientError("The OAuth client was not found."),
      });
    },
  });
  const tokenAttempt = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { connectionId: f.defaultConnectionId },
  });
  await assert.rejects(completeManagedMcpOAuthCallback({ state: stateOf(tokenAttempt.authorizationUrl), authorizationCode: "code" }));
  assert.equal((await connection(f.defaultConnectionId)).lastError, "OAuth token exchange failed: invalid_client: The OAuth client was not found.");

  // Tokens issued, but the project has not enabled the Docs MCP API: Google's 403 names it.
  const disabled = JSON.stringify({ error: { code: 403, message: "Google Docs MCP API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } });
  __setManagedMcpOAuthGatewayForTests({
    ...fakeStart,
    complete: async (_endpoint, provider) => { await provider.saveTokens({ access_token: "issued", token_type: "Bearer" }); },
    listTools: async () => { throw normalizeManagedMcpClientError(new StreamableHTTPError(403, `Error POSTing to endpoint: ${disabled}`), false, "oauth"); },
  });
  const toolsAttempt = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, redirectUrl: REDIRECT_URL, connection: { connectionId: f.defaultConnectionId },
  });
  await assert.rejects(completeManagedMcpOAuthCallback({ state: stateOf(toolsAttempt.authorizationUrl), authorizationCode: "code" }));
  const refused = await connection(f.defaultConnectionId);
  assert.equal(refused.lastError, "Signed in, but the MCP server refused the request: HTTP 403: Google Docs MCP API has not been used in project 123 before or it is disabled.");
  assert.equal((await appRow(f.appId)).lastCheckError, refused.lastError, "the default Connection's App mirror says the same");
});
