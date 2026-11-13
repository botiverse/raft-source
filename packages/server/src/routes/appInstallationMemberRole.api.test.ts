import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { seedBoundGuest } from "../test/guestFixture";
import { oauthAccessTokens, oauthAppPermissionRevisions, oauthClientInstalls, oauthClients, oauthUserConsents, serverMembers, users } from "../db/schema";
import { createOAuthClient } from "../services/oauthService";
import { mintAppInstallationCredential } from "../services/appInstallationCredentialService";
import { addMember, removeMember } from "../services/serverService";

const test = createApiTest({ skipAuthRateLimit: true });

test("installation can read only current roles of its own App's signed-in consenting humans", async ({ app, db, seed }) => {
  const owner = await seed.human(), person = await seed.human(), never = await seed.human();
  const server = await seed.server({ owner, members: [person, never] });
  const other = await seed.server({ owner, members: [person] });
  const suffix = randomUUID().slice(0, 8);
  const client = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, appType: "third_party_global", name: "Role fixture", clientId: `role-${suffix}`, allowedScopes: ["openid", "profile"] });
  const [revision] = await db.insert(oauthAppPermissionRevisions).values({ clientId: client.client.id, revision: 1, requestedGroups: ["server", "agent"], requestedEvents: [], state: "active", createdByType: "human", createdById: owner.id }).returning();
  await db.update(oauthClients).set({ outboundRequestRevision: 1, outboundCurrentRevisionId: revision!.id, outboundCurrentGroups: ["server", "agent"], outboundCurrentEvents: [] }).where(eq(oauthClients.id, client.client.id));
  const [install] = await db.insert(oauthClientInstalls).values({ serverId: server.id, clientId: client.client.id, installedByUserId: owner.id, approvedRequestRevisionId: revision!.id, approvedGroups: ["server", "agent"], approvedScopes: ["openid", "profile"], grantRevision: 1 }).returning();
  const [otherInstall] = await db.insert(oauthClientInstalls).values({ serverId: other.id, clientId: client.client.id, installedByUserId: owner.id, approvedRequestRevisionId: revision!.id, approvedGroups: ["server", "agent"], approvedScopes: ["openid", "profile"], grantRevision: 1 }).returning();
  const mint = async (installationId: string, groups: string[]) => {
    const value = await mintAppInstallationCredential({ clientId: client.client.id, installationId, requestedGroups: groups });
    assert.ok(value); return value.token;
  };
  const token = await mint(install!.id, ["server"]), foreignToken = await mint(otherInstall!.id, ["server"]), noServer = await mint(install!.id, ["agent"]);
  const read = (sub: string, credential = token) => fetch(`${app.baseUrl}/api/app-installation/members/${sub}/role`, { headers: { Authorization: `Bearer ${credential}` } });
  const response = async (sub: string, credential = token) => { const result = await read(sub, credential); return { status: result.status, body: await result.json(), cache: result.headers.get("cache-control") }; };
  const none = { status: 200, body: { role: null }, cache: "private, no-store" };
  assert.deepEqual(await response(never.id), none);
  const otherClient = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, appType: "third_party_global", name: "Other fixture", clientId: `other-${suffix}` });
  await db.insert(oauthAccessTokens).values({ clientId: otherClient.client.id, userId: never.id, principalType: "human", serverId: server.id, tokenHash: randomUUID(), scopes: ["openid"], expiresAt: new Date(Date.now() + 1000) });
  await db.insert(oauthUserConsents).values({ clientId: otherClient.client.id, userId: never.id, serverId: server.id, scopes: ["openid"], source: "login" });
  assert.deepEqual(await response(never.id), none, "a login to a different App must not grant this App a lookup");
  assert.deepEqual(await response(randomUUID()), none);
  assert.deepEqual(await response("not-a-uuid"), none);
  assert.equal((await read(person.id, "invalid")).status, 401);
  assert.equal((await read(person.id, noServer)).status, 403);

  // Exercise the actual human code-exchange path; the one-hour login token is
  // not used by the installation reader and need not remain unexpired.
  const bearer = await tokenForHuman(person.email);
  const auth = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.client.clientId, serverId: server.id, scopes: ["openid"] }) });
  assert.equal(auth.status, 200, await auth.clone().text());
  const { code } = await auth.json() as { code: string };
  const exchange = await fetch(`${app.baseUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.client.clientId, clientSecret: client.clientSecret, grantType: "authorization_code", code }) });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  assert.deepEqual(await response(person.id), { status: 200, body: { role: "member" }, cache: "private, no-store" });
  assert.deepEqual(await response(person.id, foreignToken), none, "a login on another Server cannot bootstrap a Server-mode identity");
  await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, person.id)));
  assert.deepEqual((await response(person.id)).body, { role: "admin" }, "role is reread, not cached at login");
  await db.update(oauthAccessTokens).set({ expiresAt: new Date("2020-01-01T00:00:00Z") }).where(and(eq(oauthAccessTokens.clientId, client.client.id), eq(oauthAccessTokens.userId, person.id)));
  assert.deepEqual((await response(person.id)).body, { role: "admin" }, "expiration is not user revocation");
  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(and(eq(oauthUserConsents.clientId, client.client.id), eq(oauthUserConsents.userId, person.id)));
  assert.deepEqual(await response(person.id), none);
  await db.update(oauthAccessTokens).set({ revokedAt: new Date() }).where(and(eq(oauthAccessTokens.clientId, client.client.id), eq(oauthAccessTokens.userId, person.id)));
  // Preview-only re-consent does not turn the revoked historical token into a login.
  await db.update(oauthUserConsents).set({ revokedAt: null, source: "preview_prompt" }).where(and(eq(oauthUserConsents.clientId, client.client.id), eq(oauthUserConsents.userId, person.id)));
  assert.deepEqual(await response(person.id), none);
  await db.update(oauthAccessTokens).set({ revokedAt: null }).where(and(eq(oauthAccessTokens.clientId, client.client.id), eq(oauthAccessTokens.userId, person.id)));
  await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, person.id));
  assert.deepEqual(await response(person.id), none);
  await db.update(users).set({ retiredAt: null }).where(eq(users.id, person.id));
  await removeMember(server.id, person.id);
  assert.deepEqual(await response(person.id), none);
  await addMember(server.id, person.id);
  assert.deepEqual(await response(person.id), none, "rejoining alone must not revive a revoked login");
  await db.update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, install!.id));
  assert.equal((await read(person.id)).status, 401, "installation failures are not user-level misses");
});

test("account-mode sign-in is scoped to the installation and excludes guests and revoked consent", async ({ app, db, seed }) => {
  const owner = await seed.human(), person = await seed.human();
  const server = await seed.server({ owner, members: [person] });
  const suffix = randomUUID().slice(0, 8);
  const client = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, appType: "third_party_global", name: "Account role fixture", clientId: `account-role-${suffix}` });
  const [revision] = await db.insert(oauthAppPermissionRevisions).values({ clientId: client.client.id, revision: 1, requestedGroups: ["server"], requestedEvents: [], state: "active", createdByType: "human", createdById: owner.id }).returning();
  await db.update(oauthClients).set({ loginMode: "account", outboundRequestRevision: 1, outboundCurrentRevisionId: revision!.id, outboundCurrentGroups: ["server"], outboundCurrentEvents: [] }).where(eq(oauthClients.id, client.client.id));
  const [install] = await db.insert(oauthClientInstalls).values({ serverId: server.id, clientId: client.client.id, installedByUserId: owner.id, approvedRequestRevisionId: revision!.id, approvedGroups: ["server"], grantRevision: 1 }).returning();
  const credential = await mintAppInstallationCredential({ clientId: client.client.id, installationId: install!.id, requestedGroups: ["server"] });
  assert.ok(credential);
  const read = async () => {
    const res = await fetch(`${app.baseUrl}/api/app-installation/members/${person.id}/role`, { headers: { Authorization: `Bearer ${credential.token}` } });
    assert.equal(res.status, 200); return await res.json();
  };
  const before = new Date("2020-01-01T00:00:00Z"), expires = new Date("2020-01-01T01:00:00Z");
  await db.insert(oauthAccessTokens).values({ clientId: client.client.id, userId: person.id, principalType: "human", serverId: null, tokenHash: randomUUID(), scopes: ["openid"], createdAt: before, expiresAt: expires });
  await db.insert(oauthUserConsents).values({ clientId: client.client.id, userId: person.id, serverId: null, scopes: ["openid"], source: "login", grantedAt: before });
  assert.deepEqual(await read(), { role: "member" });
  await seedBoundGuest({ serverId: server.id, userId: person.id });
  assert.deepEqual(await read(), { role: null }, "account-mode does not grant guests an audience");
  await db.update(serverMembers).set({ role: "admin", guestChannelId: null }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, person.id)));
  assert.deepEqual(await read(), { role: "admin" });
  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(and(eq(oauthUserConsents.clientId, client.client.id), eq(oauthUserConsents.userId, person.id)));
  assert.deepEqual(await read(), { role: null });
});
