import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { test } from "vitest";
import { getDb } from "../db";
import { oauthAccessRequests, oauthAccessTokens, oauthClientInstalls, oauthClients, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { decidePublishReview } from "../test/marketplaceReviewFixture";

// CI uses the production-schema PGlite harness. An optional loopback run
// creates and drops its own database to exercise the same HTTP flow in PG.
async function databaseFixture() {
  const input = process.env.OAUTH_OFFLINE_TEST_DATABASE_URL;
  if (!input) return { url: "pglite://", close: async () => {} };
  const root = new URL(input);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(root.hostname), "use isolated loopback PostgreSQL");
  const control = new pg.Client({ connectionString: input });
  await control.connect();
  const name = `oauth_offline_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  const close = async () => {
    try { if (created) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await control.end(); }
  };
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    root.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: root.toString() });
    await client.connect();
    try { await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); }
    finally { await client.end(); }
    return { url: root.toString(), close };
  } catch (error) { await close(); throw error; }
}

test("republish restores an old offline source's human login without reviving revoked credentials", async () => {
  const fixture = await databaseFixture();
  let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
  try {
    app = await openTestApp(fixture.url, 0);
    const baseUrl = app.baseUrl;
    const db = getDb();
    const [human] = await db.insert(users).values({
      email: "offline-source@example.test", name: "Offline source", displayName: "Offline source",
      passwordHash: await fixturePasswordHash("test-password"), emailVerified: true,
    }).returning();
    const source = await createServer("Source", "offline-source", human.id);
    const external = await createServer("External", "offline-external", human.id);
    const { client, clientSecret } = await createOAuthClient({
      serverId: source.id, createdByUserId: human.id, clientId: "synthetic-mail", name: "Synthetic Mail",
      description: "A synthetic App for testing offline source access.", appType: "third_party_global",
      allowedScopes: ["openid", "profile", "identity"], returnUrl: "https://offline.example.test/callback",
    });
    // Historical approved-offline state: private App still listed in Settings,
    // no source installation, and revoked credentials that must stay revoked.
    const [oldToken] = await db.insert(oauthAccessTokens).values({
      serverId: source.id, principalType: "human", userId: human.id, clientId: client.id,
      tokenHash: createHash("sha256").update("revoked-synthetic-token").digest("hex"), scopes: ["openid"],
      expiresAt: new Date(Date.now() + 60000), revokedAt: new Date(),
    }).returning();
    const [oldRequest] = await db.insert(oauthAccessRequests).values({
      serverId: source.id, principalType: "human", userId: human.id, clientId: client.id,
      status: "denied", scopes: ["openid"], resolvedAt: new Date(),
    }).returning();
    const bearer = await tokenForHuman(human.email!);
    const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
    const lookup = (serverId: string) => fetch(`${baseUrl}/api/oauth/clients/lookup?client_id=${client.clientId}&server_id=${serverId}`, { headers });
    assert.equal((await lookup(source.id)).status, 403);
    const listed = await fetch(`${baseUrl}/api/integrations/clients`, { headers: { ...headers, "X-Server-Id": source.id } });
    assert.equal(listed.status, 200);
    assert.ok((await listed.json() as Array<{ id: string }>).some(row => row.id === client.id));

    await db.update(oauthClients).set({ publishStatus: "publish_requested" }).where(eq(oauthClients.id, client.id));
    assert.equal((await lookup(source.id)).status, 403, "requesting republish alone does not restore access");
    await decidePublishReview({ clientId: client.id, reviewerUserId: human.id, decision: "approve" });
    const installs = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
    assert.equal(installs.length, 1);
    assert.equal(installs[0]!.serverId, source.id);
    assert.equal((await lookup(source.id)).status, 200);
    // Marketplace lookup may offer installation elsewhere, but never silently installs it.
    const authorize = await fetch(`${baseUrl}/api/oauth/authorize/human`, {
      method: "POST", headers,
      body: JSON.stringify({ clientId: client.clientId, serverId: source.id, scopes: ["openid", "profile"] }),
    });
    assert.equal(authorize.status, 200, await authorize.clone().text());
    const { code } = await authorize.json() as { code: string };
    const exchange = await fetch(`${baseUrl}/api/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, clientSecret, grantType: "authorization_code", code }),
    });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const token = await exchange.json() as { access_token: string };
    const identity = await fetch(`${baseUrl}/api/oauth/userinfo`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    assert.equal(identity.status, 200);
    const revokedIdentity = await fetch(`${baseUrl}/api/oauth/userinfo`, { headers: { Authorization: "Bearer revoked-synthetic-token" } });
    assert.equal(revokedIdentity.status, 401);
    assert.deepEqual((await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.id, oldToken.id)))[0], oldToken);
    assert.deepEqual((await db.select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, oldRequest.id)))[0], oldRequest);

    // Even when a published source was manually uninstalled, approving offline
    // restores basic source access without silently adding installation grants.
    await db.delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, installs[0]!.id));
    await db.update(oauthClients).set({ publishStatus: "unpublish_requested" }).where(eq(oauthClients.id, client.id));
    await decidePublishReview({ clientId: client.id, reviewerUserId: human.id, decision: "approve" });
    const forward = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
    assert.equal(forward.length, 1);
    assert.equal(forward[0]!.serverId, source.id);
    assert.deepEqual(forward[0]!.approvedGroups, []);
    assert.deepEqual(forward[0]!.subscribedEvents, []);
    assert.equal(forward[0]!.botGrant, null);
    assert.equal(forward[0]!.agentJwtEnabled, false);
    assert.equal((await lookup(source.id)).status, 200);
    assert.equal((await lookup(external.id)).status, 403);
  } finally {
    try { await app?.close(); } finally { await fixture.close(); }
  }
});
