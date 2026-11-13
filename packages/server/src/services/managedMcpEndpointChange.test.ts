/**
 * An App's endpoint changes, and a Connection's secret must never follow it to the new server.
 *
 * Two independent lines are pinned here:
 *   1. every write path (the MCP App PATCH and the original `PATCH /servers/:id`) clears every
 *      Connection's secrets through `applyMcpAppServerChange`, and keeps template Apps locked;
 *   2. the `authorized_endpoint_url` fence: even if some path moves the endpoint WITHOUT clearing
 *      (an older binary during a deploy), admission and the OAuth refresh path refuse the secret.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { managedMcpCredentials, managedMcpServers, users } from "../db/schema";
import { createAgent } from "./agentService";
import { createServer } from "./serverService";
import { decryptManagedMcpHeaders, encryptManagedMcpHeaders, encryptManagedMcpSecret } from "./managedMcpCredentialService";
import {
  __refreshManagedMcpCatalogWithLoaderForTest,
  createManagedMcpServer,
  executeManagedMcpCall,
  setManagedMcpAssignment,
  updateManagedMcpServer,
} from "./managedMcpService";
import { createManagedMcpHeaderConnection } from "./managedMcpConnectionService";
import { createMcpApp, updateMcpApp } from "./managedMcpAppService";
import { withManagedMcpOAuth } from "./managedMcpOAuthService";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";

const A = "https://a.example.test/mcp";
const B = "https://b.example.test/mcp";
const catalog = [{ name: "search", inputSchema: { type: "object" as const } }];
const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 31).toString("base64");
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

async function seedServer() {
  const [user] = await getDb().insert(users).values({
    email: `mcp-endpoint-${randomUUID()}@slock.test`,
    name: `mcp-endpoint-${randomUUID().slice(0, 8)}`,
    displayName: "Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP endpoint change", `mcp-endpoint-${randomUUID()}`, user.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, { creatorType: "user", creatorId: user.id });
  return { user, server, agent };
}

const connection = async (id: string) =>
  (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, id)))[0];
const appRow = async (id: string) =>
  (await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, id)))[0];

/** "Someone signed in to the new server": the catalogue is back and the App looks connected. */
async function catalogRepopulated(appId: string) {
  await getDb().update(managedMcpServers).set({ toolCatalog: catalog, oauthStatus: "connected" }).where(eq(managedMcpServers.id, appId));
}

function storage(accessToken: string): ManagedMcpOAuthStorage {
  return {
    redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
    clientInformation: { client_id: "fixture-client", token_endpoint_auth_method: "none" },
    tokens: { access_token: accessToken, token_type: "Bearer", refresh_token: `refresh-${accessToken}` },
  };
}

/** A header App at A with a default Connection and a second Connection B, Agent pinned to B. */
async function seedHeaderAppPinnedToB() {
  const f = await seedServer();
  const app = await createManagedMcpServer({
    serverId: f.server.id, userId: f.user.id, name: "Keyed", endpointUrl: A, authMode: "headers", headers: { "X-Api-Key": "default-key-for-a" },
  });
  await getDb().update(managedMcpServers).set({ toolCatalog: catalog, requiredHeaderNames: ["X-Api-Key"] }).where(eq(managedMcpServers.id, app.id));
  const pinned = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId: f.user.id, mcpServerId: app.id, name: "B", headers: { "X-Api-Key": "pinned-key-for-a" },
  }, { listTools: async () => catalog });
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: app.id, connectionId: pinned.id });
  return { ...f, appId: app.id, pinnedId: pinned.id };
}

/** An OAuth App at A, default and Connection B both signed in to A, Agent pinned to B. */
async function seedOAuthAppPinnedToB() {
  const f = await seedServer();
  const app = await createManagedMcpServer({ serverId: f.server.id, userId: f.user.id, name: "Signed", endpointUrl: A, authMode: "oauth" });
  await getDb().update(managedMcpCredentials)
    .set({ encryptedOAuth: encryptManagedMcpSecret(storage("default-token-for-a")), authStatus: "ready", authorizedEndpointUrl: A })
    .where(eq(managedMcpCredentials.mcpServerId, app.id));
  const [pinned] = await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: app.id, isServerDefault: false, name: "B", authKind: "oauth", authStatus: "ready", createdByUserId: f.user.id,
    encryptedOAuth: encryptManagedMcpSecret(storage("pinned-token-for-a")), authorizedEndpointUrl: A,
  }).returning();
  await catalogRepopulated(app.id);
  await setManagedMcpAssignment({ serverId: f.server.id, userId: f.user.id, agentId: f.agent.id, mcpServerId: app.id, connectionId: pinned.id });
  return { ...f, appId: app.id, pinnedId: pinned.id };
}

function recorder() {
  const sent: Array<{ endpoint: string; credential: string }> = [];
  return {
    sent,
    call: (f: { server: { id: string }; agent: { id: string }; appId: string }, configVersion: number) => executeManagedMcpCall(
      f.server.id, f.agent.id,
      { mcpServerId: f.appId, toolName: "search", arguments: {}, expectedConfigVersion: configVersion, expectedAssignmentVersion: 1 },
      async (input) => { sent.push({ endpoint: input.endpoint, credential: String(input.headers["X-Api-Key"]) }); return { content: [], isError: false }; },
      async (input) => {
        sent.push({ endpoint: input.endpoint, credential: String((await input.provider.tokens())?.access_token) });
        return { content: [], isError: false };
      },
    ),
  };
}

test("⭐ legacy PATCH /servers moves an API-key App: the pinned Connection's key is cleared and never sent to the new host", async () => {
  const f = await seedHeaderAppPinnedToB();
  const rec = recorder();
  await rec.call(f, (await appRow(f.appId)).configVersion);
  assert.deepEqual(rec.sent, [{ endpoint: A, credential: "pinned-key-for-a" }], "control: the pin works before the move");

  await updateManagedMcpServer({
    serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, endpointUrl: B, headers: { "X-Api-Key": "default-key-for-b" },
  });
  const moved = await connection(f.pinnedId);
  assert.ok(moved.encryptedHeaders === null, "⭐ the pinned Connection's key for A is gone");
  assert.equal(moved.authStatus, "needs_auth");
  await catalogRepopulated(f.appId);

  await assert.rejects(rec.call(f, (await appRow(f.appId)).configVersion), { code: "managed_mcp_login_required" });
  assert.equal(rec.sent.length, 1, "⭐ nothing was sent to B on behalf of the pinned Agent");
});

test("⭐ legacy PATCH /servers moves an OAuth App: every Connection's tokens are cleared, the pin is refused, no token reaches B", async () => {
  const f = await seedOAuthAppPinnedToB();
  const rec = recorder();
  await rec.call(f, (await appRow(f.appId)).configVersion);
  assert.deepEqual(rec.sent, [{ endpoint: A, credential: "pinned-token-for-a" }], "control: the pin works before the move");

  await updateManagedMcpServer({ serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, endpointUrl: B });
  const moved = await connection(f.pinnedId);
  assert.ok(moved.encryptedOAuth === null, "⭐ the non-default Connection's tokens (and refresh token) are gone");
  assert.equal(moved.authStatus, "needs_auth");
  const after = await appRow(f.appId);
  assert.equal(after.endpointUrl, B);
  assert.deepEqual(after.toolCatalog, []);
  await catalogRepopulated(f.appId);

  await assert.rejects(rec.call(f, (await appRow(f.appId)).configVersion), { code: "managed_mcp_login_required" });
  assert.equal(rec.sent.length, 1, "⭐ nothing was sent to B on behalf of the pinned Agent");
});

test("⭐ legacy PATCH /servers cannot move a template App or switch it to a custom provider", async () => {
  const f = await seedServer();
  const notion = await createMcpApp({ serverId: f.server.id, userId: f.user.id, source: { kind: "template", templateKey: "notion" }, profile: { name: "Notion" } });
  const before = await appRow(notion.id);
  for (const patch of [
    { provider: "custom" as const, endpointUrl: "https://evil.example.test/mcp" },
    { endpointUrl: "https://evil.example.test/mcp" },
    { provider: "custom" as const },
    { authMode: "headers" as const, headers: { Authorization: "Bearer x" } },
  ]) {
    await assert.rejects(
      updateManagedMcpServer({ serverId: f.server.id, userId: f.user.id, mcpServerId: notion.id, ...patch }),
      { code: "managed_mcp_template_field_locked" },
      JSON.stringify(patch),
    );
  }
  // A recommended App that older binaries do not know by provider is locked by its source too.
  const [custom] = await getDb().insert(managedMcpServers).values({
    serverId: f.server.id, name: "Templated", provider: "custom", authMode: "oauth", endpointUrl: "https://tpl.example.test/mcp",
    sourceKind: "template", templateKey: "tpl",
  }).returning();
  await assert.rejects(
    updateManagedMcpServer({ serverId: f.server.id, userId: f.user.id, mcpServerId: custom.id, endpointUrl: "https://evil.example.test/mcp" }),
    { code: "managed_mcp_template_field_locked" },
  );
  const after = await appRow(notion.id);
  assert.equal(after.endpointUrl, before.endpointUrl);
  assert.equal(after.provider, "notion");
  assert.equal(after.configVersion, before.configVersion, "a refused update writes nothing");
  // Non-locked fields still go through.
  const renamed = await updateManagedMcpServer({ serverId: f.server.id, userId: f.user.id, mcpServerId: notion.id, name: "Notion HQ", provider: "notion" });
  assert.equal(renamed.name, "Notion HQ");
});

test("⭐ both PATCH routes share the rules: the MCP App PATCH also clears a non-default OAuth Connection", async () => {
  const f = await seedOAuthAppPinnedToB();
  await getDb().update(managedMcpServers).set({ sourceKind: "url" }).where(eq(managedMcpServers.id, f.appId));
  await updateMcpApp({ serverId: f.server.id, userId: f.user.id, appId: f.appId, patch: { endpointUrl: "https://a.example.test/v2/mcp" } });
  const moved = await connection(f.pinnedId);
  assert.ok(moved.encryptedOAuth === null, "even a same-origin move invalidates OAuth tokens");
  assert.equal(moved.authStatus, "needs_auth");
});

test("⭐ fence: an endpoint moved WITHOUT clearing (older binary) never lets a pinned OAuth Connection send or refresh its token", async () => {
  const f = await seedOAuthAppPinnedToB();
  // What an older binary's `PATCH /servers/:id` did: move the App, touch only the default.
  await getDb().update(managedMcpServers).set({ endpointUrl: B }).where(eq(managedMcpServers.id, f.appId));
  const rec = recorder();
  await assert.rejects(rec.call(f, (await appRow(f.appId)).configVersion), { code: "managed_mcp_login_required" });
  assert.equal(rec.sent.length, 0, "⭐ admission refused before any provider I/O");

  // The refresh path (any OAuth operation under the lease) refuses too, before the SDK runs.
  let operations = 0;
  await assert.rejects(
    withManagedMcpOAuth(f.server.id, f.appId, async () => { operations += 1; }, undefined, f.pinnedId),
    { code: "managed_mcp_oauth_required" },
  );
  assert.equal(operations, 0, "⭐ the token (and refresh token) never reach B or B's authorization server");
  assert.equal((await connection(f.pinnedId)).authStatus, "needs_auth", "and the Connection now says so");
});

test("⭐ fence: an API-key Connection is bound to its origin; a same-origin move keeps it, a new origin refuses it", async () => {
  const f = await seedHeaderAppPinnedToB();
  const rec = recorder();
  await getDb().update(managedMcpServers).set({ endpointUrl: "https://a.example.test/v2/mcp" }).where(eq(managedMcpServers.id, f.appId));
  await rec.call(f, (await appRow(f.appId)).configVersion);
  assert.equal(rec.sent.length, 1, "same origin: the key is still for this host");

  await getDb().update(managedMcpServers).set({ endpointUrl: B }).where(eq(managedMcpServers.id, f.appId));
  await assert.rejects(rec.call(f, (await appRow(f.appId)).configVersion), { code: "managed_mcp_login_required" });
  assert.equal(rec.sent.length, 1, "⭐ the key for A is not sent to B");
  assert.equal(decryptManagedMcpHeaders((await connection(f.pinnedId)).encryptedHeaders)["X-Api-Key"], "pinned-key-for-a");

  // The catalogue refresh sends the default's key too; it is fenced the same way.
  let loads = 0;
  await assert.rejects(
    __refreshManagedMcpCatalogWithLoaderForTest(f.server.id, f.appId, async () => { loads += 1; return catalog; }),
    { code: "managed_mcp_login_required" },
  );
  assert.equal(loads, 0);

  // A row with no recorded endpoint (written before the fence existed) is trusted as before.
  await getDb().update(managedMcpCredentials).set({ authorizedEndpointUrl: null, encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "legacy" }) })
    .where(eq(managedMcpCredentials.id, f.pinnedId));
  await rec.call(f, (await appRow(f.appId)).configVersion);
  assert.equal(rec.sent.at(-1)?.credential, "legacy");
});

test("⭐ legacy PATCH /servers key change is fenced: a concurrent cross-origin move refuses it, and nothing keyed for A is stored", async () => {
  const f = await seedHeaderAppPinnedToB();
  const defaultConnection = async () => (await getDb().select().from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, f.appId))).find((row) => row.isServerDefault)!;

  // Control: with nothing in between, the key change lands and is stamped with the URL it was entered for.
  await updateManagedMcpServer({ serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, headers: { "X-Api-Key": "rotated-key-for-a" } });
  const rotated = await defaultConnection();
  assert.deepEqual(decryptManagedMcpHeaders(rotated.encryptedHeaders), { "X-Api-Key": "rotated-key-for-a" });
  assert.equal(rotated.authorizedEndpointUrl, A);

  // Admin A reads the App at A; admin B moves it to another origin before A's write.
  await assert.rejects(updateManagedMcpServer(
    { serverId: f.server.id, userId: f.user.id, mcpServerId: f.appId, headers: { "X-Api-Key": "late-key-for-a" } },
    { afterRead: async () => { await updateMcpApp({ serverId: f.server.id, userId: f.user.id, appId: f.appId, patch: { endpointUrl: B } }); } },
  ), { code: "managed_mcp_config_stale" });

  const after = await defaultConnection();
  assert.ok(after.encryptedHeaders === null, "⭐ the key entered for A was not stored after the move to B");
  assert.equal(after.authStatus, "needs_auth", "the move's needs_auth stands; nothing was marked ready");
  assert.ok(after.authorizedEndpointUrl !== B, "⭐ no key was ever stamped as authorized for B");
});
