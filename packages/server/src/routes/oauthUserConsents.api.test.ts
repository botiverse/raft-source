import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { oauthClientInstalls, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, users } from "../db/schema";
import { addMember } from "../services/serverService";
import { createOAuthClient, deleteLockedOAuthClient, lockDeletableOAuthClient } from "../services/oauthService";
import { decidePublishReview } from "../test/marketplaceReviewFixture";
import type { Database } from "../db";

// A person's Login with Raft consent (oauth_user_consents) outlives the
// one-hour access token, so every path that revokes the person's tokens for an
// App must revoke it too, and only the matching (person, Server, App) rows.
const test = createApiTest();
type Human = typeof users.$inferSelect;
type App = Awaited<ReturnType<typeof createOAuthClient>>;

/** The person approves Login with Raft: the request is approved and the App holds a code it has not exchanged yet. */
async function authorize(baseUrl: string, human: Human, serverId: string, app: App, scopes: string[]): Promise<string> {
  const response = await fetch(`${baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: app.client.clientId, serverId, scopes }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { code: string }).code;
}

function exchange(baseUrl: string, app: App, code: string) {
  return fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: app.client.clientId, clientSecret: app.clientSecret, grantType: "authorization_code", code }),
  });
}

async function login(baseUrl: string, human: Human, serverId: string, app: App, scopes: string[]) {
  const response = await exchange(baseUrl, app, await authorize(baseUrl, human, serverId, app, scopes));
  assert.equal(response.status, 200, await response.clone().text());
}

async function consentOf(db: Database, human: Human, serverId: string, clientId: string) {
  const rows = await db.select().from(oauthUserConsents).where(and(
    eq(oauthUserConsents.userId, human.id), eq(oauthUserConsents.serverId, serverId), eq(oauthUserConsents.clientId, clientId),
  ));
  assert.ok(rows.length <= 1);
  return rows[0] ?? null;
}

async function declined(db: Database, human: Human, serverId: string, clientId: string) {
  return (await db.select().from(oauthLinkPreviewDeclines).where(and(
    eq(oauthLinkPreviewDeclines.userId, human.id), eq(oauthLinkPreviewDeclines.serverId, serverId), eq(oauthLinkPreviewDeclines.clientId, clientId),
  ))).length === 1;
}

/** A link-preview decline: inserted directly, as the decline endpoint would. */
async function decline(db: Database, human: Human, serverId: string, clientId: string) {
  await db.insert(oauthLinkPreviewDeclines).values({ userId: human.id, serverId, clientId });
}

/** Consent rows another path must leave alone: inserted directly, active. */
async function control(db: Database, human: Human, serverId: string, clientId: string) {
  await db.insert(oauthUserConsents).values({ userId: human.id, serverId, clientId, scopes: ["openid", "profile"] });
  return async () => assert.equal((await consentOf(db, human, serverId, clientId))?.revokedAt, null, "an unrelated consent stays active");
}

async function thirdPartyApp(owner: Human, sourceServerId: string, clientKey: string): Promise<App> {
  return createOAuthClient({
    serverId: sourceServerId, createdByUserId: owner.id, clientId: clientKey, name: clientKey, appType: "third_party_global",
    allowedScopes: ["openid", "profile", "email"], returnUrl: "https://consent.example.test/callback",
  });
}

async function install(db: Database, app: App, serverId: string, installedBy: Human) {
  await db.insert(oauthClientInstalls).values({ clientId: app.client.id, serverId, installedByUserId: installedBy.id, approvedScopes: ["openid", "profile", "email"] });
}

test("each Login with Raft adds its scopes to the standing consent and keeps how and when it was first granted; after a revocation it starts afresh", async ({ app, db, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const local = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "consent-local", name: "Consent Local", allowedScopes: ["openid", "profile", "email"] });
  assert.equal(await consentOf(db, owner, server.id, local.client.id), null);

  await login(app.baseUrl, owner, server.id, local, ["openid", "profile"]);
  const first = await consentOf(db, owner, server.id, local.client.id);
  assert.deepEqual([...first!.scopes].sort(), ["openid", "profile"]); assert.equal(first!.revokedAt, null); assert.equal(first!.source, "login");

  await login(app.baseUrl, owner, server.id, local, ["openid", "email"]);
  const second = await consentOf(db, owner, server.id, local.client.id);
  assert.deepEqual(second!.scopes, ["email", "openid", "profile"], "a union over the logins while the consent is active");
  assert.deepEqual(second?.grantedAt, first!.grantedAt);
  assert.ok(second!.updatedAt >= first!.updatedAt);

  // A consent first granted by the link-preview prompt stays that way through a login.
  await db.update(oauthUserConsents).set({ source: "preview_prompt" }).where(eq(oauthUserConsents.id, first!.id));
  await login(app.baseUrl, owner, server.id, local, ["openid"]);
  assert.equal((await consentOf(db, owner, server.id, local.client.id))!.source, "preview_prompt");

  // Only revocation clears: the next login records its own scopes, time and source.
  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.id, first!.id));
  await login(app.baseUrl, owner, server.id, local, ["openid"]);
  const afresh = await consentOf(db, owner, server.id, local.client.id);
  assert.deepEqual(afresh!.scopes, ["openid"]); assert.equal(afresh!.revokedAt, null); assert.equal(afresh!.source, "login");
  assert.ok(afresh!.grantedAt > first!.grantedAt);
});

test("leaving or being removed from a Server revokes consents there only; logging in after rejoining re-consents", async ({ app, db, seed }) => {
  const owner = await seed.human(); const leaver = await seed.human(); const removed = await seed.human();
  const server = await seed.server({ owner, members: [leaver, removed] });
  const elsewhere = await seed.server({ owner: leaver });
  const local = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "consent-member", name: "Consent Member" });
  await login(app.baseUrl, leaver, server.id, local, ["openid", "profile"]);
  await login(app.baseUrl, removed, server.id, local, ["openid", "profile"]);
  const ownerStillConsents = await control(db, owner, server.id, local.client.id);
  const leaverElsewhere = await control(db, leaver, elsewhere.id, local.client.id);
  await decline(db, leaver, server.id, local.client.id); await decline(db, removed, server.id, local.client.id);
  await decline(db, owner, server.id, local.client.id); await decline(db, leaver, elsewhere.id, local.client.id);

  const left = await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, {
    method: "POST", headers: { Authorization: `Bearer ${await tokenForHuman(leaver.email)}`, "X-Server-Id": server.id },
  });
  assert.equal(left.status, 200);
  assert.ok((await consentOf(db, leaver, server.id, local.client.id))?.revokedAt instanceof Date);
  assert.equal(await declined(db, leaver, server.id, local.client.id), false, "leaving deletes the person's declines there");
  assert.equal((await consentOf(db, removed, server.id, local.client.id))?.revokedAt, null);
  assert.equal(await declined(db, removed, server.id, local.client.id), true);
  const removal = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${removed.id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id },
  });
  assert.equal(removal.status, 200);
  assert.ok((await consentOf(db, removed, server.id, local.client.id))?.revokedAt instanceof Date);
  assert.equal(await declined(db, removed, server.id, local.client.id), false, "removal deletes the person's declines there");
  await ownerStillConsents(); await leaverElsewhere();
  assert.equal(await declined(db, owner, server.id, local.client.id), true, "another member's decline stays");
  assert.equal(await declined(db, leaver, elsewhere.id, local.client.id), true, "the leaver's decline on another Server stays");

  await addMember(server.id, leaver.id);
  assert.ok((await consentOf(db, leaver, server.id, local.client.id))?.revokedAt instanceof Date, "rejoining alone does not restore consent");
  await login(app.baseUrl, leaver, server.id, local, ["openid", "profile"]);
  assert.equal((await consentOf(db, leaver, server.id, local.client.id))?.revokedAt, null);
});

test("an admin uninstalling an App revokes its consents on that Server only; logging in after reinstalling re-consents", async ({ app, db, seed }) => {
  const publisher = await seed.human(); const admin = await seed.human(); const member = await seed.human();
  const source = await seed.server({ owner: publisher, members: [member] });
  const target = await seed.server({ owner: admin, members: [member] });
  const vault = await thirdPartyApp(publisher, source.id, "consent-vault");
  const other = await thirdPartyApp(publisher, source.id, "consent-other");
  await install(db, vault, source.id, publisher); await install(db, vault, target.id, admin); await install(db, other, target.id, admin);
  await login(app.baseUrl, member, target.id, vault, ["openid", "profile"]);
  const sameAppOnSource = await control(db, member, source.id, vault.client.id);
  const otherAppOnTarget = await control(db, member, target.id, other.client.id);
  await decline(db, member, target.id, vault.client.id); await decline(db, admin, target.id, vault.client.id);
  await decline(db, member, source.id, vault.client.id); await decline(db, member, target.id, other.client.id);

  const uninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${vault.client.id}/install`, {
    method: "DELETE", headers: { Authorization: `Bearer ${await tokenForHuman(admin.email)}`, "X-Server-Id": target.id },
  });
  assert.equal(uninstall.status, 200, await uninstall.clone().text());
  assert.ok((await consentOf(db, member, target.id, vault.client.id))?.revokedAt instanceof Date);
  assert.equal(await declined(db, member, target.id, vault.client.id), false, "uninstall deletes the App's declines on that Server");
  assert.equal(await declined(db, admin, target.id, vault.client.id), false);
  await sameAppOnSource(); await otherAppOnTarget();
  assert.equal(await declined(db, member, source.id, vault.client.id), true, "the same App's decline on another Server stays");
  assert.equal(await declined(db, member, target.id, other.client.id), true, "another App's decline stays");

  await install(db, vault, target.id, admin);
  assert.ok((await consentOf(db, member, target.id, vault.client.id))?.revokedAt instanceof Date, "reinstalling alone does not restore consent");
  await login(app.baseUrl, member, target.id, vault, ["openid", "profile"]);
  assert.equal((await consentOf(db, member, target.id, vault.client.id))?.revokedAt, null);
});

test("a Login with Raft approved before an uninstall or a marketplace removal cannot consent after it", async ({ app, db, seed }) => {
  const publisher = await seed.human(); const admin = await seed.human(); const member = await seed.human();
  const source = await seed.server({ owner: publisher }); const target = await seed.server({ owner: admin, members: [member] });
  const vault = await thirdPartyApp(publisher, source.id, "consent-open-code");
  await install(db, vault, source.id, publisher); await install(db, vault, target.id, admin);

  // Uninstall while the App still holds an unexchanged code.
  const code = await authorize(app.baseUrl, member, target.id, vault, ["openid", "profile"]);
  const uninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${vault.client.id}/install`, {
    method: "DELETE", headers: { Authorization: `Bearer ${await tokenForHuman(admin.email)}`, "X-Server-Id": target.id },
  });
  assert.equal(uninstall.status, 200, await uninstall.clone().text());
  assert.notEqual((await exchange(app.baseUrl, vault, code)).status, 200, "the open code dies with the installation");
  await install(db, vault, target.id, admin);
  assert.equal(await consentOf(db, member, target.id, vault.client.id), null, "reinstalling does not bring a consent back");

  // The same for a marketplace removal approved while a code is open.
  const second = await authorize(app.baseUrl, member, target.id, vault, ["openid", "profile"]);
  await db.update(oauthClients).set({ publishStatus: "unpublish_requested" }).where(eq(oauthClients.id, vault.client.id));
  assert.ok(await decidePublishReview({ clientId: vault.client.id, reviewerUserId: publisher.id, decision: "approve" }));
  assert.notEqual((await exchange(app.baseUrl, vault, second)).status, 200);
  assert.equal(await consentOf(db, member, target.id, vault.client.id), null);
});

test("approving an App's marketplace removal revokes consents on the Servers it leaves, not its own", async ({ db, seed }) => {
  const publisher = await seed.human(); const admin = await seed.human();
  const source = await seed.server({ owner: publisher }); const target = await seed.server({ owner: admin });
  const vault = await thirdPartyApp(publisher, source.id, "consent-offline");
  await install(db, vault, source.id, publisher); await install(db, vault, target.id, admin);
  const publisherConsent = await control(db, publisher, source.id, vault.client.id);
  await db.insert(oauthUserConsents).values({ userId: admin.id, serverId: target.id, clientId: vault.client.id, scopes: ["openid", "profile"] });
  await decline(db, admin, target.id, vault.client.id); await decline(db, publisher, source.id, vault.client.id);

  await db.update(oauthClients).set({ publishStatus: "unpublish_requested" }).where(eq(oauthClients.id, vault.client.id));
  assert.ok(await decidePublishReview({ clientId: vault.client.id, reviewerUserId: publisher.id, decision: "approve" }));
  assert.ok((await consentOf(db, admin, target.id, vault.client.id))?.revokedAt instanceof Date);
  assert.equal(await declined(db, admin, target.id, vault.client.id), false, "marketplace removal deletes the declines on the Servers it leaves");
  await publisherConsent();
  assert.equal(await declined(db, publisher, source.id, vault.client.id), true, "the source Server's decline stays");
});

test("deleting an App deletes the consents to it", async ({ db, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const local = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "consent-deleted", name: "Consent Deleted" });
  const kept = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "consent-kept", name: "Consent Kept" });
  await db.insert(oauthUserConsents).values({ userId: owner.id, serverId: server.id, clientId: local.client.id, scopes: ["openid", "profile"] });
  const keptConsent = await control(db, owner, server.id, kept.client.id);
  assert.ok(await db.transaction(async (tx) => {
    const locked = await lockDeletableOAuthClient(tx, { serverId: server.id, clientId: local.client.id });
    return locked && deleteLockedOAuthClient(tx, locked, { serverId: server.id, deletedByUserId: owner.id });
  }));
  assert.equal(await consentOf(db, owner, server.id, local.client.id), null);
  await keptConsent();
});
