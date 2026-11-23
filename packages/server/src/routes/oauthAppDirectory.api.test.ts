import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import { getDb } from "../db/index";
import { channels, featureFlags, oauthClientInstalls, oauthClients, serverMembers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import {
  createOAuthClient,
  installMarketplaceOAuthClient,
  issueHumanAuthorizationCode,
  requestAgentAccess,
} from "../services/oauthService";
import { addMember, createServer, removeMember } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";

// GET /api/oauth/apps sends a Server's App list to another App's backend, so
// what it leaves out matters as much as what it returns: unpublished names, and
// everything to anyone but a member the Server's admins approved it for.
const test = createApiTest({ skipAuthRateLimit: true });

const RETURN_URL = "https://menu.example.test/callback";
const SCOPES = ["openid", "profile", "app:read"];
const DENIED = { error: "server_access_denied", error_description: "This token cannot be used for this request on that Server." };

type Base = { baseUrl: string };
type Server = { id: string; slug: string };
type DirectoryEntry = Record<string, unknown>;

/** A Guest is bound to one channel of the Server (server_members_guest_has_channel). */
async function makeGuest(serverId: string, userId: string) {
  const [channel] = await getDb().select({ id: channels.id }).from(channels).where(eq(channels.serverId, serverId)).limit(1);
  assert.ok(channel, "the Server has a channel to bind the Guest to");
  await getDb().update(serverMembers).set({ role: "guest", guestChannelId: channel.id })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** A third-party App published from `publisher` and installed on `installOn`. */
async function publishedApp(input: {
  publisher: Server;
  ownerId: string;
  name: string;
  installOn: Server[];
  homepageUrl?: string | null;
  allowedScopes?: string[];
}) {
  const { client, clientSecret } = await createOAuthClient({
    serverId: input.publisher.id,
    createdByUserId: input.ownerId,
    appType: "third_party_global",
    clientId: `dir-${randomUUID().slice(0, 12)}`,
    name: input.name,
    returnUrl: RETURN_URL,
    allowedScopes: input.allowedScopes ?? ["openid", "profile"],
  });
  await getDb().update(oauthClients).set({
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    homepageUrl: input.homepageUrl === undefined ? `https://${client.clientId}.example.test/` : input.homepageUrl,
  }).where(eq(oauthClients.id, client.id));
  for (const server of input.installOn) {
    assert.ok(await installMarketplaceOAuthClient({
      serverId: server.id,
      clientId: client.id,
      installedByUserId: input.ownerId,
      expected: await currentAppPermissions(client.id),
    }));
  }
  return { client, clientSecret };
}

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("dir-owner");
  const person = await seedUser("dir-person");
  const publisher = await createServer("Publisher", `dir-pub-${suffix}`, owner.id);
  const server = await createServer("Directory", `dir-${suffix}`, owner.id);
  const other = await createServer("Other", `dir-other-${suffix}`, owner.id);
  await addMember(server.id, person.id, "member");
  const caller = await publishedApp({ publisher, ownerId: owner.id, name: "Caller", installOn: [server], allowedScopes: SCOPES });
  return { owner, person, publisher, server, other, ...caller };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function humanToken(app: Base, f: Seeded, input: { userId?: string; scopes?: string[] } = {}) {
  const userId = input.userId ?? f.person.id;
  const { code } = await issueHumanAuthorizationCode({
    clientKey: f.client.clientId,
    userId,
    serverId: f.server.id,
    returnUrl: RETURN_URL,
    scopes: input.scopes ?? SCOPES,
    approverSessionFamilyId: (await signInForTest(userId)).familyId,
  });
  const response = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: f.client.clientId, clientSecret: f.clientSecret, grantType: "authorization_code", code }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { access_token: string }).access_token;
}

function readApps(app: Base, token: string, path = "/api/oauth/apps") {
  return fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function listedNames(app: Base, token: string) {
  const response = await readApps(app, token);
  assert.equal(response.status, 200);
  return (await response.json() as { apps: DirectoryEntry[] }).apps.map((entry) => entry.name);
}

async function assertDenied(response: Response) {
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), DENIED);
}

test("lists the Server's published, active Apps by name, with exactly the agreed fields", async ({ app }) => {
  const f = await seed();
  const listed = await publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name: "Atlas", installOn: [f.server] });
  await getDb().update(oauthClients).set({ logoUrl: "https://cdn.example.test/atlas.png" }).where(eq(oauthClients.id, listed.client.id));
  // Still on the Marketplace while its removal waits for review.
  const leaving = await publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name: "Leaving", installOn: [f.server] });
  await getDb().update(oauthClients).set({ publishStatus: "unpublish_requested" }).where(eq(oauthClients.id, leaving.client.id));
  const token = await humanToken(app, f);

  for (const path of ["/api/oauth/apps", `/api/oauth/apps?server_id=${f.server.id}`, `/oidc/${f.server.slug}/api/oauth/apps`]) {
    const response = await readApps(app, token, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { apps } = await response.json() as { apps: DirectoryEntry[] };
    assert.deepEqual(apps.map((entry) => entry.name), ["Atlas", "Caller", "Leaving"]);
    assert.deepEqual(apps[0], {
      client_id: listed.client.clientId,
      name: "Atlas",
      picture: "https://cdn.example.test/atlas.png",
      homepage_url: `https://${listed.client.clientId}.example.test/`,
    });
  }
});

test("leaves out unpublished, hidden, suspended, disabled, uninstalled and server-local Apps", async ({ app }) => {
  const f = await seed();
  const db = getDb();
  const installed = (name: string) => publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name, installOn: [f.server] });
  for (const publishStatus of ["private", "publish_requested", "in_review", "rejected"] as const) {
    const { client } = await installed(`Unpublished ${publishStatus}`);
    await db.update(oauthClients).set({ publishStatus }).where(eq(oauthClients.id, client.id));
  }
  const hidden = await installed("Hidden");
  await db.update(oauthClients).set({ humanMarketplaceVisible: false }).where(eq(oauthClients.id, hidden.client.id));
  const suspended = await installed("Suspended");
  await db.update(oauthClientInstalls).set({ status: "suspended" })
    .where(and(eq(oauthClientInstalls.clientId, suspended.client.id), eq(oauthClientInstalls.serverId, f.server.id)));
  const disabled = await installed("Disabled");
  await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, disabled.client.id));
  await publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name: "Elsewhere", installOn: [f.other] });
  await createOAuthClient({
    serverId: f.server.id,
    createdByUserId: f.owner.id,
    clientId: `dir-local-${randomUUID().slice(0, 8)}`,
    name: "Server local",
    returnUrl: RETURN_URL,
  });

  assert.deepEqual(await listedNames(app, await humanToken(app, f)), ["Caller"]);
});

test("an App without an https home page is not listed, and a picture must be https", async ({ app }) => {
  const f = await seed();
  for (const [name, homepageUrl] of [
    ["No page", null],
    ["Plain http", "http://plain.example.test/"],
    ["Credentials", "https://user:secret@creds.example.test/"],
    ["Script", "javascript:alert(1)"],
    ["Not a URL", "not a url"],
  ] as const) {
    await publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name, installOn: [f.server], homepageUrl });
  }
  const http = await publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name: "Http picture", installOn: [f.server] });
  await getDb().update(oauthClients).set({ logoUrl: "http://cdn.example.test/a.png" }).where(eq(oauthClients.id, http.client.id));
  const own = await publishedApp({ publisher: f.publisher, ownerId: f.owner.id, name: "Own picture", installOn: [f.server] });
  await getDb().update(oauthClients).set({ logoUrl: "/api/integrations/logos/own.png" }).where(eq(oauthClients.id, own.client.id));
  vi.stubEnv("SERVER_URL", "https://api.raft.test");
  try {
    const response = await readApps(app, await humanToken(app, f));
    const { apps } = await response.json() as { apps: DirectoryEntry[] };
    assert.deepEqual(apps.map((entry) => [entry.name, entry.picture]), [
      ["Caller", null],
      ["Http picture", null],
      ["Own picture", "https://api.raft.test/api/integrations/logos/own.png"],
    ]);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("refuses a token without the scope, another Server, a guest and an Agent", async ({ app }) => {
  const f = await seed();
  await assertDenied(await readApps(app, await humanToken(app, f, { scopes: ["openid", "profile"] })));

  const token = await humanToken(app, f);
  await assertDenied(await readApps(app, token, `/api/oauth/apps?server_id=${f.other.id}`));
  await assertDenied(await readApps(app, token, `/api/oauth/apps?server_id=${f.server.slug}`));

  await makeGuest(f.server.id, f.person.id);
  await assertDenied(await readApps(app, token));

  const agent = await createAgent(f.server.id, "DirectoryAgent", { runtime: "external", model: "external" });
  const local = await createOAuthClient({
    serverId: f.server.id,
    createdByUserId: f.owner.id,
    clientId: `dir-agent-${randomUUID().slice(0, 8)}`,
    vouchAsCreator: true,
    name: "Agent login",
    returnUrl: RETURN_URL,
    allowedScopes: SCOPES,
  });
  const { request } = await requestAgentAccess({ clientId: local.client.id, serverSlug: f.server.slug, agentName: agent.name, scopes: SCOPES });
  const exchange = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${local.client.clientId}:${local.clientSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code: request.id, redirect_uri: RETURN_URL }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const { access_token: agentToken, scope } = await exchange.json() as { access_token: string; scope: string };
  assert.ok(scope.split(" ").includes("app:read"));
  await assertDenied(await readApps(app, agentToken));
});

test("a person who left the Server gets the lost-membership 401", async ({ app }) => {
  const f = await seed();
  const token = await humanToken(app, f);
  await removeMember(f.server.id, f.person.id);
  const response = await readApps(app, token);
  assert.equal(response.status, 401);
});

test("an account-mode token reads only a Server whose installation approved app:read", async ({ app }) => {
  const f = await seed();
  const suffix = randomUUID().slice(0, 8);
  const approving = await createServer("Approving", `dir-a-${suffix}`, f.owner.id);
  const unapproved = await createServer("Unapproved", `dir-b-${suffix}`, f.owner.id);
  const notInstalled = await createServer("Not installed", `dir-c-${suffix}`, f.owner.id);
  for (const server of [approving, unapproved, notInstalled]) await addMember(server.id, f.person.id, "member");
  const account = await publishedApp({
    publisher: f.publisher, ownerId: f.owner.id, name: "Account", installOn: [approving, unapproved], allowedScopes: SCOPES,
  });
  await getDb().update(oauthClientInstalls).set({ approvedScopes: ["openid", "profile"] })
    .where(and(eq(oauthClientInstalls.clientId, account.client.id), eq(oauthClientInstalls.serverId, unapproved.id)));
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${account.client.id}`);
  const values = { enabled: true, killSwitch: false, defaultEnabled: true };
  await getDb().insert(featureFlags)
    .values({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "app-directory-test", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });

  // The same token, carrying the scope, names each Server in turn.
  const raw = `slock_at_${randomBytes(32).toString("hex")}`;
  await getDb().execute(sql`
    INSERT INTO "oauth_access_tokens" ("id", "server_id", "principal_type", "user_id", "agent_id", "client_id", "token_hash", "scopes", "expires_at", "created_at")
    VALUES (${randomUUID()}, NULL, 'human', ${f.person.id}, NULL, ${account.client.id}, ${createHash("sha256").update(raw).digest("hex")},
      ${JSON.stringify([...SCOPES].sort())}::json, ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz)
  `);

  const allowed = await readApps(app, raw, `/api/oauth/apps?server_id=${approving.id}`);
  assert.equal(allowed.status, 200, await allowed.clone().text());
  assert.deepEqual((await allowed.json() as { apps: DirectoryEntry[] }).apps.map((entry) => entry.name), ["Account"]);

  await assertDenied(await readApps(app, raw, `/api/oauth/apps?server_id=${unapproved.id}`));
  await assertDenied(await readApps(app, raw, `/api/oauth/apps?server_id=${notInstalled.id}`));
  await assertDenied(await readApps(app, raw, `/api/oauth/apps?server_id=${f.other.id}`));

  const unnamed = await readApps(app, raw);
  assert.equal(unnamed.status, 400);

  await makeGuest(approving.id, f.person.id);
  await assertDenied(await readApps(app, raw, `/api/oauth/apps?server_id=${approving.id}`));
});
