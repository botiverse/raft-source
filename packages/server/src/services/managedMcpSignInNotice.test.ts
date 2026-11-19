import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDb } from "../db/index";
import { managedMcpCredentials, managedMcpServers, notificationOutbox, users } from "../db/schema";
import { createAgent } from "./agentService";
import { addMember, createServer } from "./serverService";
import { encryptManagedMcpSecret } from "./managedMcpCredentialService";
import { normalizeManagedMcpClientError } from "./managedMcpGateway";
import { createManagedMcpServer, executeManagedMcpCall, setManagedMcpAssignment } from "./managedMcpService";
import { __setManagedMcpOAuthGatewayForTests } from "./managedMcpOAuthService";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";
import {
  __resetMcpSignInNoticeMemoForTests,
  mcpSignInNoticeEventKey,
  notifyMcpConnectionNeedsSignIn,
  type McpSignInNoticeConnection,
} from "./managedMcpSignInNotice";

// #proj-apps:#70: when an MCP App's OAuth Connection needs signing in again, the people who can
// sign it in again are told once per expiry, whether the expiry is written by a call or found by
// admission refusing one.

const REDIRECT_URL = "https://raft.example.test/api/mcp/oauth/callback";
const ENDPOINT = "https://oauth-app.example.test/mcp";
const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 21).toString("base64");
  await openTestDatabase("pglite://");
  __resetMcpSignInNoticeMemoForTests();
  __setManagedMcpOAuthGatewayForTests({
    start: async () => "REDIRECT",
    complete: async () => undefined,
    listTools: async () => [{ name: "search", inputSchema: { type: "object" } }],
  });
});

afterEach(async () => {
  __setManagedMcpOAuthGatewayForTests(null);
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
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

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  return user!;
}

/** An OAuth App whose default Connection (signed in by the owner) is ready; an admin and a member. */
async function seedOAuthApp() {
  const owner = await seedUser("mcp-notice-owner");
  const admin = await seedUser("mcp-notice-admin");
  const member = await seedUser("mcp-notice-member");
  const server = await createServer("Notice Server", `mcp-notice-${randomUUID()}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, member.id, "member");
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: owner.id });
  const app = await createManagedMcpServer({ serverId: server.id, userId: owner.id, name: "Docs", authMode: "oauth", endpointUrl: ENDPOINT });
  await getDb().update(managedMcpCredentials)
    .set({ encryptedOAuth: encryptManagedMcpSecret(oauthStorage("default-access-token")), authStatus: "ready", createdByUserId: owner.id })
    .where(eq(managedMcpCredentials.mcpServerId, app.id));
  await getDb().update(managedMcpServers)
    .set({ oauthStatus: "connected", toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] })
    .where(eq(managedMcpServers.id, app.id));
  const [defaultConnection] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, app.id));
  return { owner, admin, member, server, agent, appId: app.id, defaultConnection: defaultConnection! };
}

const connection = async (id: string) =>
  (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, id)))[0]!;
const configVersionOf = async (id: string) =>
  (await getDb().select({ v: managedMcpServers.configVersion }).from(managedMcpServers).where(eq(managedMcpServers.id, id)))[0]!.v;

/** Receivers of this Connection's sign-in notices, by event key. */
async function notices(connectionId: string) {
  const rows = await getDb().select({ receiverId: notificationOutbox.receiverId, eventKey: notificationOutbox.eventKey, category: notificationOutbox.category, payload: notificationOutbox.payload })
    .from(notificationOutbox)
    .where(like(notificationOutbox.eventKey, `mcp_connection_signin:${connectionId}:%`));
  return rows;
}
const receivers = (rows: Array<{ receiverId: string }>) => rows.map((row) => row.receiverId).sort();

test("a refresh failure on a call notifies whoever signed the Connection in, once; later refused calls add nothing", async () => {
  const f = await seedOAuthApp();
  const [second] = await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: f.appId, isServerDefault: false, name: "Second", authKind: "oauth", authStatus: "ready",
    createdByUserId: f.owner.id, encryptedOAuth: encryptManagedMcpSecret(oauthStorage("expired-access-token", "revoked-refresh-token")),
  }).returning();
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.owner.id, agentId: f.agent.id, mcpServerId: f.appId, connectionId: second!.id });
  const configVersion = await configVersionOf(f.appId);
  const call = () => executeManagedMcpCall(f.server.id, f.agent.id, {
    mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: configVersion, expectedAssignmentVersion: 1,
  }, undefined, async ({ provider }) => {
    try {
      await auth(provider as OAuthClientProvider, {
        serverUrl: new URL(ENDPOINT),
        fetchFn: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } }),
      });
    } catch (error) {
      throw normalizeManagedMcpClientError(error, false, "oauth");
    }
    return { content: [], isError: false };
  });

  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  const expired = await connection(second!.id);
  assert.equal(expired.authStatus, "expired");
  const first = await notices(second!.id);
  assert.deepEqual(receivers(first), [f.owner.id], "the signer only: not the default Connection, so no other admin");
  assert.equal(first[0]!.eventKey, mcpSignInNoticeEventKey(second!.id, expired.credentialVersion));
  assert.equal(first[0]!.category, "system_notice");
  const payload = first[0]!.payload as { title: string; body: string };
  assert.equal(payload.title, "Sign in to Docs again");
  assert.match(payload.body, /Notice Server/u);

  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  assert.equal((await notices(second!.id)).length, 1, "one notice per expiry");
});

test("a refused call on a default Connection that expired before this shipped notifies the signer and every admin who can sign it in", async () => {
  const f = await seedOAuthApp();
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.defaultConnection.id));
  await getDb().update(managedMcpServers).set({ oauthStatus: "error" }).where(eq(managedMcpServers.id, f.appId));
  const configVersion = await configVersionOf(f.appId);
  let reached = 0;
  const call = () => executeManagedMcpCall(f.server.id, f.agent.id, {
    mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: configVersion, expectedAssignmentVersion: 1,
  }, undefined, async () => {
    reached += 1;
    return { content: [], isError: false };
  });

  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  assert.equal(reached, 0, "refused at admission, as before");
  assert.deepEqual(receivers(await notices(f.defaultConnection.id)), [f.owner.id, f.admin.id].sort(), "no plain member");

  // A restarted process has no memo: the outbox key still keeps it to one notice.
  __resetMcpSignInNoticeMemoForTests();
  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  assert.equal((await notices(f.defaultConnection.id)).length, 2);

  // Signed in again (credential_version moves) and expired again: a new notice.
  await getDb().update(managedMcpCredentials)
    .set({ credentialVersion: f.defaultConnection.credentialVersion + 1, authStatus: "expired" })
    .where(eq(managedMcpCredentials.id, f.defaultConnection.id));
  await assert.rejects(call(), { code: "managed_mcp_login_required" });
  assert.equal((await notices(f.defaultConnection.id)).length, 4);
});

test("a signer who can no longer sign it in again is replaced by the Server's owners", async () => {
  const f = await seedOAuthApp();
  const lapsed: McpSignInNoticeConnection = {
    id: randomUUID(), authStatus: "expired", credentialVersion: 1, isServerDefault: false, createdByUserId: f.member.id, authorizedEndpointUrl: ENDPOINT,
  };
  await notifyMcpConnectionNeedsSignIn({ trigger: "admission", serverId: f.server.id, mcpServerId: f.appId, connection: lapsed });
  assert.deepEqual(receivers(await notices(lapsed.id)), [f.owner.id]);

  const gone: McpSignInNoticeConnection = { ...lapsed, id: randomUUID(), createdByUserId: null };
  await notifyMcpConnectionNeedsSignIn({ trigger: "admission", serverId: f.server.id, mcpServerId: f.appId, connection: gone });
  assert.deepEqual(receivers(await notices(gone.id)), [f.owner.id]);
});

test("a Connection that was never signed in, or whose sign-in is under way, is not a sign-in-again notice", async () => {
  const f = await seedOAuthApp();
  for (const state of [
    { authStatus: "needs_auth", authorizedEndpointUrl: null },
    { authStatus: "pending", authorizedEndpointUrl: null },
    { authStatus: "ready", authorizedEndpointUrl: ENDPOINT },
  ]) {
    const id = randomUUID();
    await notifyMcpConnectionNeedsSignIn({
      trigger: "admission", serverId: f.server.id, mcpServerId: f.appId,
      connection: { id, credentialVersion: 1, isServerDefault: true, createdByUserId: f.owner.id, ...state },
    });
    assert.equal((await notices(id)).length, 0, state.authStatus);
  }
  const moved = randomUUID();
  await notifyMcpConnectionNeedsSignIn({
    trigger: "oauth_write", serverId: f.server.id, mcpServerId: f.appId,
    connection: { id: moved, authStatus: "needs_auth", authorizedEndpointUrl: ENDPOINT, credentialVersion: 1, isServerDefault: false, createdByUserId: f.owner.id },
  });
  assert.deepEqual(receivers(await notices(moved)), [f.owner.id], "signed in before, sent back by an address change");
});
