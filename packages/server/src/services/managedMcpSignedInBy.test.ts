import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { getDb } from "../db/index";
import { managedMcpCredentials, managedMcpServers, notificationOutbox, users } from "../db/schema";
import { addMember, createServer, removeMember } from "./serverService";
import { decryptManagedMcpSecret } from "./managedMcpCredentialService";
import { createManagedMcpServer, updateManagedMcpServer } from "./managedMcpService";
import {
  __setManagedMcpOAuthGatewayForTests,
  disconnectManagedMcpOAuthConnection,
  startManagedMcpOAuthConnection,
} from "./managedMcpOAuthService";
import {
  completeManagedMcpOAuthCallback,
  createManagedMcpHeaderConnection,
  listManagedMcpConnections,
  updateManagedMcpConnection,
} from "./managedMcpConnectionService";
import { getMcpAppView } from "./managedMcpAppService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "./emailService";
import { departedSignInNoticeText, noticeConnectionsOfDepartedMember } from "./managedMcpSignedInBy";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";

// Connections signed in with a person's own account: who signed in is recorded on every write of
// the secret, the manager-only view marks one whose signer has left, and leaving tells the
// server's admins (and the person, for OAuth ones). Nothing is revoked on leaving.

const REDIRECT_URL = "https://raft.example.test/api/mcp/oauth/callback";
const ENDPOINT = "https://oauth-app.example.test/mcp";
const catalog = [{ name: "search", inputSchema: { type: "object" as const } }];
const handshakeOk = async () => catalog;
const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
let emails: EmailDelivery[] = [];

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 29).toString("base64");
  await openTestDatabase("pglite://");
  emails = [];
  __setEmailDeliveryObserverForTests((delivery) => emails.push(delivery));
  __setManagedMcpOAuthGatewayForTests({
    start: async (_endpoint, provider) => {
      await provider.saveCodeVerifier("fake-verifier");
      provider.redirectToAuthorization(new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(await provider.state!())}`));
      return "REDIRECT";
    },
    complete: async (_endpoint, provider, code) => {
      await provider.saveTokens({ access_token: `access-for-${code}`, token_type: "Bearer", workspace_name: "Acme" } as never);
    },
    listTools: async () => catalog,
  });
});

afterEach(async () => {
  __setManagedMcpOAuthGatewayForTests(null);
  __setEmailDeliveryObserverForTests(null);
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

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

/** A server with an owner, two admins and a member; an OAuth App (Notion) and an API-key App (Docs). */
async function seedServer() {
  const owner = await seedUser("Olive");
  const admin = await seedUser("Ada");
  const otherAdmin = await seedUser("Bea");
  const member = await seedUser("Max");
  const server = await createServer("Acme Server", `signed-in-by-${randomUUID()}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, otherAdmin.id, "admin");
  await addMember(server.id, member.id, "member");
  const oauthApp = await createManagedMcpServer({ serverId: server.id, userId: owner.id, name: "Notion", authMode: "oauth", endpointUrl: ENDPOINT });
  const headerApp = await createManagedMcpServer({
    serverId: server.id, userId: owner.id, name: "Docs", endpointUrl: "https://docs.example.test/mcp",
    authMode: "headers", headers: { "X-Api-Key": "owner-key" },
  });
  await getDb().update(managedMcpServers).set({ requiredHeaderNames: ["X-Api-Key"], toolCatalog: catalog }).where(eq(managedMcpServers.id, headerApp.id));
  return { owner, admin, otherAdmin, member, server, oauthAppId: oauthApp.id, headerAppId: headerApp.id };
}
type Seeded = Awaited<ReturnType<typeof seedServer>>;

const row = async (id: string) => (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, id)))[0]!;
const defaultOf = async (appId: string) =>
  (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, appId)))
    .find((connection) => connection.isServerDefault)!;
const stateOf = (authorizationUrl: string) => new URL(authorizationUrl).searchParams.get("state")!;

/** Signs `userId` in on a Connection of the OAuth App (a new one when `connectionId` is omitted). */
async function signIn(f: Seeded, userId: string, connectionId?: string, name = "Work") {
  const started = await startManagedMcpOAuthConnection({
    serverId: f.server.id, userId, mcpServerId: f.oauthAppId, redirectUrl: REDIRECT_URL,
    connection: connectionId ? { connectionId } : { newConnectionName: name },
  });
  await completeManagedMcpOAuthCallback({ state: stateOf(started.authorizationUrl), authorizationCode: `code-${randomUUID()}` });
  return started.connectionId;
}

async function addKey(f: Seeded, userId: string, name = "Prod key") {
  const created = await createManagedMcpHeaderConnection({
    serverId: f.server.id, userId, mcpServerId: f.headerAppId, name, headers: { "X-Api-Key": `key-${name}` },
  }, { listTools: handshakeOk });
  return created.id;
}

const departedNotices = async (serverId: string) => getDb()
  .select({ receiverId: notificationOutbox.receiverId, category: notificationOutbox.category, eventKey: notificationOutbox.eventKey, payload: notificationOutbox.payload })
  .from(notificationOutbox)
  .where(like(notificationOutbox.eventKey, `mcp_connections_departed:${serverId}:%`));

test("every write of a Connection's secret records who it acts as; renaming does not, and removing the secret clears it", async () => {
  const f = await seedServer();
  // App creation with an API key: whoever saved it. An OAuth App's first Connection is not signed in yet.
  assert.equal((await defaultOf(f.headerAppId)).signedInByUserId, f.owner.id);
  assert.equal((await defaultOf(f.oauthAppId)).signedInByUserId, null);

  // OAuth: a new Connection's sign-in, then someone else signing the same Connection in again.
  const work = await signIn(f, f.admin.id);
  assert.equal((await row(work)).signedInByUserId, f.admin.id);
  await signIn(f, f.otherAdmin.id, work);
  assert.equal((await row(work)).signedInByUserId, f.otherAdmin.id, "a re-sign-in acts as the new person");
  // The App's default, signed in through the original route.
  await signIn(f, f.admin.id, (await defaultOf(f.oauthAppId)).id);
  assert.equal((await defaultOf(f.oauthAppId)).signedInByUserId, f.admin.id);

  // API keys: added, renamed (no change), replaced by someone else.
  const key = await addKey(f, f.admin.id);
  assert.equal((await row(key)).signedInByUserId, f.admin.id);
  await updateManagedMcpConnection({ serverId: f.server.id, userId: f.owner.id, mcpServerId: f.headerAppId, connectionId: key, name: "Renamed" }, { listTools: handshakeOk });
  assert.equal((await row(key)).signedInByUserId, f.admin.id, "a rename is not a new key");
  await updateManagedMcpConnection({
    serverId: f.server.id, userId: f.otherAdmin.id, mcpServerId: f.headerAppId, connectionId: key, headers: { "X-Api-Key": "replaced" },
  }, { listTools: handshakeOk });
  assert.equal((await row(key)).signedInByUserId, f.otherAdmin.id);
  // The original single-credential edit of the App's default key.
  await updateManagedMcpServer({ serverId: f.server.id, userId: f.admin.id, mcpServerId: f.headerAppId, headers: { "X-Api-Key": "edited" } });
  assert.equal((await defaultOf(f.headerAppId)).signedInByUserId, f.admin.id);

  // Signing out deletes the tokens: the Connection acts as nobody.
  await disconnectManagedMcpOAuthConnection(f.server.id, f.oauthAppId, work);
  assert.equal((await row(work)).signedInByUserId, null);
  // A new endpoint drops every OAuth sign-in of the App.
  await updateManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, mcpServerId: f.oauthAppId, endpointUrl: "https://oauth-app.example.test/v2/mcp" });
  assert.equal((await defaultOf(f.oauthAppId)).signedInByUserId, null);
});

test("signedInBy.departed is read from membership: still a member, left, rejoined, retired; nobody recorded is null", async () => {
  const f = await seedServer();
  const work = await signIn(f, f.admin.id);
  const key = await addKey(f, f.otherAdmin.id);
  await getDb().update(managedMcpCredentials).set({ signedInByUserId: null }).where(eq(managedMcpCredentials.id, (await defaultOf(f.headerAppId)).id));
  const signedInBy = async (appId: string, id: string) =>
    (await listManagedMcpConnections(f.server.id, appId)).find((connection) => connection.id === id)!.signedInBy;

  assert.deepEqual(await signedInBy(f.oauthAppId, work), { userId: f.admin.id, departed: false });
  assert.equal(await signedInBy(f.headerAppId, (await defaultOf(f.headerAppId)).id), null);

  await removeMember(f.server.id, f.admin.id, { reason: "left", actorUserId: f.admin.id });
  assert.deepEqual(await signedInBy(f.oauthAppId, work), { userId: f.admin.id, departed: true });
  assert.equal((await row(work)).authStatus, "ready", "leaving revokes nothing");
  assert.ok((decryptManagedMcpSecret((await row(work)).encryptedOAuth!) as ManagedMcpOAuthStorage).tokens, "nor deletes its tokens");
  await addMember(f.server.id, f.admin.id, "member");
  assert.deepEqual(await signedInBy(f.oauthAppId, work), { userId: f.admin.id, departed: false }, "rejoining clears it");

  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.otherAdmin.id));
  assert.deepEqual(await signedInBy(f.headerAppId, key), { userId: f.otherAdmin.id, departed: true }, "a retired account has left");
});

test("signedInBy is on the manager's App view only", async () => {
  const f = await seedServer();
  await signIn(f, f.admin.id);
  const managerView = await getMcpAppView(f.server.id, f.oauthAppId, f.owner.id);
  assert.ok(managerView.connections.some((connection) => connection.signedInBy?.userId === f.admin.id));
  const memberView = await getMcpAppView(f.server.id, f.oauthAppId, f.member.id);
  assert.deepEqual(memberView.connections, []);
});

test("leaving: one notice to each other owner and admin, one email to the person listing only the OAuth Connections", async () => {
  const f = await seedServer();
  const work = await signIn(f, f.admin.id);
  await addKey(f, f.admin.id);
  await removeMember(f.server.id, f.admin.id, { reason: "left", actorUserId: f.admin.id });

  const rows = await departedNotices(f.server.id);
  assert.deepEqual(rows.map((notice) => notice.receiverId).sort(), [f.owner.id, f.otherAdmin.id].sort(), "owners and admins, not the person, not members");
  assert.equal(new Set(rows.map((notice) => notice.eventKey)).size, 1);
  const payload = rows[0]!.payload as { title: string; body: string; event: string };
  assert.equal(payload.event, "system_notice");
  assert.match(payload.body, /Ada has left Acme Server/);
  assert.match(payload.body, /Notion › Work \(Acme\), signed in by Ada, who has left/);
  assert.match(payload.body, /Docs › Prod key, added by Ada, who has left/);
  assert.match(payload.body, /Settings › Apps/);

  assert.equal(emails.length, 1);
  assert.equal(emails[0]!.to, f.admin.email);
  assert.match(emails[0]!.subject, /still connected to Acme Server/);
  assert.match(emails[0]!.text!, /Notion › Work \(Acme\)/);
  assert.doesNotMatch(emails[0]!.text!, /Docs/, "an API key is not listed to the person");
  assert.match(emails[0]!.text!, /revoke the access yourself/);
  assert.equal((await row(work)).authStatus, "ready");
});

test("leaving with only API-key Connections: the notice, no email; with none: nothing", async () => {
  const f = await seedServer();
  await addKey(f, f.admin.id);
  await removeMember(f.server.id, f.admin.id, { reason: "removed", actorUserId: f.owner.id });
  assert.equal((await departedNotices(f.server.id)).length, 2);
  assert.equal(emails.length, 0);

  await removeMember(f.server.id, f.member.id, { reason: "left", actorUserId: f.member.id });
  assert.ok((await departedNotices(f.server.id)).every((notice) => !notice.eventKey!.includes(f.member.id)));
  assert.equal(emails.length, 0);
});

test("the same departure told twice sends one notice per admin; a failing email never throws", async () => {
  const f = await seedServer();
  await signIn(f, f.admin.id);
  await removeMember(f.server.id, f.admin.id, { reason: "left", actorUserId: f.admin.id });
  const [first] = await departedNotices(f.server.id);
  const departedAt = new Date(Number(first!.eventKey!.split(":").at(-1)));
  await noticeConnectionsOfDepartedMember({ serverId: f.server.id, userId: f.admin.id, departedAt }, {
    sendLeftEmail: async () => { throw new Error("mail down"); },
  });
  assert.equal((await departedNotices(f.server.id)).length, 2);
});

test("the account deletion notice says when OAuth Connections stop, and not for API keys", () => {
  const text = departedSignInNoticeText({
    personName: "Ada",
    serverName: "Acme Server",
    stopsOn: new Date("2026-11-23T10:00:00Z"),
    connections: [
      { appName: "Notion", connectionName: "Notion", accountLabel: "Acme", authKind: "oauth" },
      { appName: "Docs", connectionName: "Prod key", accountLabel: null, authKind: "headers" },
    ],
  });
  assert.equal(text.title, "Ada is deleting their account");
  assert.match(text.body, /Notion \(Acme\), signed in by Ada: this stops on November 23, 2026 \(UTC\)/);
  assert.match(text.body, /Docs › Prod key, added by Ada\./);
});
