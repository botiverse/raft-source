import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { vi } from "vitest";

import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { expectedAppPermissionsBody } from "../test/integration/appPermissions";
import { getDb } from "../db/index";
import {
  agentCredentials,
  agents,
  appBotBindings,
  integrationAuditEvents,
  notificationEvents,
  notificationRecipients,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { getAppUrl } from "../config/appUrl";
import { addMember, createServer } from "../services/serverService";
import { createOAuthClient, createOAuthClientShareLink } from "../services/oauthService";
import { createAgent, deleteAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { registerMachine } from "../services/machineService";
import { deriveAppBotHandle } from "../services/appBotIdentityService";
import { drainAppNotificationDeliveries } from "../services/appNotificationDeliveryService";
import { __setAppWebhookEncryptionKeyForTests, configureAppWebhook } from "../services/appWebhookConfigService";

// Adding an App's bot to a Server in one step (frames f1-f5): the App lists
// say what the bot is for the current Server, the marketplace install can add
// or decline it in its own transaction, and "Don't add" only records a choice.

const test = createApiTest();

type BotOffer = { offered: true; grant: "pending" | "granted" | "revoked"; handle: string; agentId?: string };
type AppRow = { id: string; bot?: BotOffer };

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** A published marketplace App from its own Server, and a Server to install it on. */
async function seedMarketplaceBotApp(options: { enableBot?: boolean } = {}) {
  const short = randomUUID().slice(0, 8);
  const developer = await seedUser("bot-developer");
  const admin = await seedUser("bot-admin");
  const member = await seedUser("bot-member");
  const sourceServer = await createServer("Stamp Source", `stamp-source-${short}`, developer.id);
  const server = await createServer("Raft", `stamp-target-${short}`, admin.id);
  await addMember(server.id, member.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: sourceServer.id,
    createdByUserId: developer.id,
    appType: "third_party_global",
    clientId: `stamp-${short}`,
    name: "Stamp",
    description: "Code hosting, PR review and CI.",
    homepageUrl: "https://stamp.example.test",
    returnUrl: "https://stamp.example.test/callback",
    enableBot: options.enableBot ?? true,
  });
  await getDb().update(oauthClients).set({ publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, client.id));
  return {
    developer,
    admin,
    member,
    sourceServer,
    server,
    client,
    clientSecret,
    handle: deriveAppBotHandle(client.clientId),
    adminToken: await tokenForHuman(admin.email),
    memberToken: await tokenForHuman(member.email),
    developerToken: await tokenForHuman(developer.email),
  };
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
}

async function readInstall(serverId: string, clientId: string) {
  const [row] = await getDb().select({ id: oauthClientInstalls.id, status: oauthClientInstalls.status, botGrant: oauthClientInstalls.botGrant })
    .from(oauthClientInstalls)
    .where(and(eq(oauthClientInstalls.serverId, serverId), eq(oauthClientInstalls.clientId, clientId)))
    .limit(1);
  return row ?? null;
}

async function botGrantAudits(installationId: string) {
  const rows = await getDb().select({
    eventType: integrationAuditEvents.eventType,
    actorId: integrationAuditEvents.actorId,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.eventType, "installation.bot_grant_updated"))
    .orderBy(integrationAuditEvents.createdAt);
  return rows
    .filter((row) => (row.metadata as Record<string, unknown>).installationId === installationId)
    .map((row) => ({ actorId: row.actorId, botGrant: (row.metadata as Record<string, unknown>).botGrant }));
}

/**
 * installation.bot_changed rows about an installation, oldest first: who
 * acted, and which installations each is addressed to.
 */
async function botChangedEvents(installationId: string) {
  const events = await getDb().select({
    id: notificationEvents.id,
    subjectType: notificationEvents.subjectType,
    requiredGroups: notificationEvents.requiredGroups,
    provenance: notificationEvents.provenance,
  }).from(notificationEvents)
    .where(and(eq(notificationEvents.eventType, "installation.bot_changed"), eq(notificationEvents.subjectId, installationId)))
    .orderBy(notificationEvents.occurredAt);
  return Promise.all(events.map(async (event) => ({
    subjectType: event.subjectType,
    requiredGroups: event.requiredGroups,
    actorType: event.provenance.actor_type,
    recipients: (await getDb().select({ id: notificationRecipients.recipientId }).from(notificationRecipients)
      .where(eq(notificationRecipients.eventId, event.id))).map((row) => row.id),
  })));
}

function appAuth(clientKey: string, secret: string) {
  return { Authorization: `Basic ${Buffer.from(`${clientKey}:${secret}`).toString("base64")}`, "Content-Type": "application/json" };
}

async function lookupInstallation(baseUrl: string, clientKey: string, secret: string, serverId: string) {
  const res = await fetch(`${baseUrl}/api/oauth/installations/lookup`, {
    method: "POST",
    headers: appAuth(clientKey, secret),
    body: JSON.stringify({ server_id: serverId }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as { installation_id: string; bot: unknown };
}

test("App lists carry the bot offer for the current Server: pending, granted, revoked, absent without a bot", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const { client: noBotApp } = await createOAuthClient({
    serverId: fx.sourceServer.id,
    createdByUserId: fx.developer.id,
    appType: "third_party_global",
    clientId: `vault-${randomUUID().slice(0, 8)}`,
    name: "Vault",
    description: "Secrets for agents.",
    homepageUrl: "https://vault.example.test",
    returnUrl: "https://vault.example.test/callback",
  });
  await getDb().update(oauthClients).set({ publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, noBotApp.id));
  const marketplaceRow = async (clientId: string) => {
    const res = await fetch(`${app.baseUrl}/api/integrations/marketplace`, { headers: headers(fx.adminToken, fx.server.id) });
    assert.equal(res.status, 200);
    const row = (await res.json() as AppRow[]).find((item) => item.id === clientId);
    assert.ok(row, `marketplace lists ${clientId}`);
    return row;
  };

  // Before any install the listing already names the bot (f4), as pending.
  assert.deepEqual((await marketplaceRow(fx.client.id)).bot, { offered: true, grant: "pending", handle: fx.handle });
  assert.equal("bot" in await marketplaceRow(noBotApp.id), false, "an App with no bot has no bot field");

  // Installed without a choice: the null grant reads as pending.
  const installRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify(await expectedAppPermissionsBody(fx.client.id)),
  });
  assert.equal(installRes.status, 200, await installRes.clone().text());
  assert.equal((await readInstall(fx.server.id, fx.client.id))?.botGrant, null);
  assert.deepEqual((await marketplaceRow(fx.client.id)).bot, { offered: true, grant: "pending", handle: fx.handle });

  const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action }),
  });
  const granted = await setBotGrant("grant");
  assert.equal(granted.status, 200, await granted.clone().text());
  const { bot } = await granted.json() as { bot: { agentId: string } };
  const [botAgent] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, bot.agentId));
  assert.deepEqual((await marketplaceRow(fx.client.id)).bot, {
    offered: true,
    grant: "granted",
    handle: botAgent!.name,
    agentId: bot.agentId,
  });

  assert.equal((await setBotGrant("revoke")).status, 200);
  assert.deepEqual((await marketplaceRow(fx.client.id)).bot, { offered: true, grant: "revoked", handle: botAgent!.name });

  // The source Server's own list (registered apps, a source-owned App is
  // installed there by definition) carries the same field.
  const clientsRes = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: headers(fx.developerToken, fx.sourceServer.id) });
  assert.equal(clientsRes.status, 200);
  const clients = await clientsRes.json() as AppRow[];
  assert.deepEqual(clients.find((row) => row.id === fx.client.id)?.bot, { offered: true, grant: "pending", handle: fx.handle });
  assert.equal("bot" in clients.find((row) => row.id === noBotApp.id)!, false);
});

test("marketplace install with bot: true adds the bot in the same transaction, false declines it, absent leaves it pending", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const otherServers = await Promise.all(["decline", "later"].map((name) =>
    createServer(`Raft ${name}`, `stamp-${name}-${randomUUID().slice(0, 8)}`, fx.admin.id)));
  const install = async (serverId: string, bot?: unknown) => fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, serverId),
    body: JSON.stringify({ ...await expectedAppPermissionsBody(fx.client.id), ...(bot === undefined ? {} : { bot }) }),
  });

  // Not a boolean: refused before anything is written.
  const malformed = await install(fx.server.id, "yes");
  assert.equal(malformed.status, 400);
  assert.equal(await readInstall(fx.server.id, fx.client.id), null);

  // bot: true -> installed with the bot granted and created; open clients are
  // told so member lists show the new bot without a reload (#11295).
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const to = app.io.to.bind(app.io);
  const spy = vi.spyOn(app.io, "to").mockImplementation((...args) => {
    const room = String(args[0]);
    const target = to(...args as Parameters<typeof to>);
    return new Proxy(target, {
      get(inner, key, receiver) {
        if (key !== "emit") return Reflect.get(inner, key, receiver);
        return (event: string, ...payload: unknown[]) => {
          emitted.push({ room, event, payload: payload[0] });
          return Reflect.apply(inner.emit, inner, [event, ...payload]);
        };
      },
    });
  });
  let addRes: Response;
  try {
    addRes = await install(fx.server.id, true);
  } finally {
    spy.mockRestore();
  }
  assert.equal(addRes.status, 200, await addRes.clone().text());
  const added = await addRes.json() as { bot?: BotOffer; warnings?: string[] };
  const addedInstall = await readInstall(fx.server.id, fx.client.id);
  assert.equal(addedInstall?.status, "active");
  assert.equal(addedInstall?.botGrant, "granted");
  const [binding] = await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, addedInstall!.id));
  assert.equal(binding?.state, "active");
  const [botAgent] = await getDb().select().from(agents).where(eq(agents.id, binding!.agentId));
  assert.equal(botAgent?.managedByAppInstallId, addedInstall!.id);
  assert.equal(botAgent?.serverId, fx.server.id);
  assert.deepEqual(added.bot, { offered: true, grant: "granted", handle: botAgent!.name, agentId: botAgent!.id });
  assert.ok(
    emitted.some((entry) => entry.event === "agent:updated" && entry.room === `server:${fx.server.id}` && (entry.payload as { agentId?: string }).agentId === botAgent!.id),
    `install with bot: true refreshes member lists: ${JSON.stringify(emitted)}`,
  );
  assert.equal(added.warnings, undefined);
  // Audited as the grant route audits it, by the installing admin.
  assert.deepEqual(await botGrantAudits(addedInstall!.id), [{ actorId: fx.admin.id, botGrant: "granted" }]);
  // installation.bot_changed is in the install's transaction; a new
  // installation has subscribed to nothing yet, so it has no recipient.
  assert.deepEqual(await botChangedEvents(addedInstall!.id), [{ subjectType: "installation", requiredGroups: [], actorType: "human", recipients: [] }]);

  // bot: false -> installed, "revoked" recorded, no bot created, not asked again.
  const declineRes = await install(otherServers[0]!.id, false);
  assert.equal(declineRes.status, 200, await declineRes.clone().text());
  const declined = await declineRes.json() as { bot?: BotOffer };
  const declinedInstall = await readInstall(otherServers[0]!.id, fx.client.id);
  assert.equal(declinedInstall?.botGrant, "revoked");
  assert.deepEqual(declined.bot, { offered: true, grant: "revoked", handle: fx.handle });
  assert.deepEqual(await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, declinedInstall!.id)), []);
  assert.deepEqual(await getDb().select({ id: agents.id }).from(agents).where(eq(agents.managedByAppInstallId, declinedInstall!.id)), []);
  assert.deepEqual(await botGrantAudits(declinedInstall!.id), [{ actorId: fx.admin.id, botGrant: "revoked" }]);
  assert.equal((await botChangedEvents(declinedInstall!.id)).length, 1);

  // Absent -> today's behaviour: nothing decided, no audit.
  const laterRes = await install(otherServers[1]!.id);
  assert.equal(laterRes.status, 200);
  const later = await laterRes.json() as { bot?: BotOffer };
  const laterInstall = await readInstall(otherServers[1]!.id, fx.client.id);
  assert.equal(laterInstall?.botGrant, null);
  assert.deepEqual(later.bot, { offered: true, grant: "pending", handle: fx.handle });
  assert.deepEqual(await botGrantAudits(laterInstall!.id), []);
  assert.deepEqual(await botChangedEvents(laterInstall!.id), []);
});

test("a share-link install decides the bot as the marketplace install does: the invite offers it, true adds it, false declines it, absent leaves it pending", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const targets = await Promise.all(["add", "decline", "later"].map((name) =>
    createServer(`Raft ${name}`, `share-${name}-${randomUUID().slice(0, 8)}`, fx.admin.id)));
  const linkFor = async (slug: string) => {
    const share = await createOAuthClientShareLink({ serverId: fx.sourceServer.id, clientId: fx.client.id, targetServerSlug: slug, createdByUserId: fx.developer.id });
    assert.ok(share);
    return share.token;
  };
  const auth = { Authorization: `Bearer ${fx.adminToken}`, "Content-Type": "application/json" };
  const install = async (token: string, serverId: string, bot?: unknown) => fetch(`${app.baseUrl}/api/integration-invites/${token}/install`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ serverId, ...await expectedAppPermissionsBody(fx.client.id), ...(bot === undefined ? {} : { bot }) }),
  });

  // The invite page gets the offer it shows next to the permissions.
  const addToken = await linkFor(targets[0]!.slug);
  const inviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${addToken}`, { headers: auth });
  assert.equal(inviteRes.status, 200);
  const invite = await inviteRes.json() as { client: { bot?: BotOffer } };
  assert.deepEqual(invite.client.bot, { offered: true, grant: "pending", handle: fx.handle });

  // Not a boolean: refused before anything is written, the link unspent.
  const malformed = await install(addToken, targets[0]!.id, "yes");
  assert.equal(malformed.status, 400);
  assert.equal(await readInstall(targets[0]!.id, fx.client.id), null);

  // true -> installed with the bot granted and created, audited as the installing admin.
  const addRes = await install(addToken, targets[0]!.id, true);
  assert.equal(addRes.status, 200, await addRes.clone().text());
  const added = await addRes.json() as { client: { bot?: BotOffer }; warnings?: string[] };
  const addedInstall = await readInstall(targets[0]!.id, fx.client.id);
  assert.equal(addedInstall?.botGrant, "granted");
  const [binding] = await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, addedInstall!.id));
  assert.equal(binding?.state, "active");
  const [botAgent] = await getDb().select().from(agents).where(eq(agents.id, binding!.agentId));
  assert.equal(botAgent?.serverId, targets[0]!.id);
  assert.deepEqual(added.client.bot, { offered: true, grant: "granted", handle: botAgent!.name, agentId: botAgent!.id });
  assert.equal(added.warnings, undefined);
  assert.deepEqual(await botGrantAudits(addedInstall!.id), [{ actorId: fx.admin.id, botGrant: "granted" }]);
  assert.deepEqual(await botChangedEvents(addedInstall!.id), [{ subjectType: "installation", requiredGroups: [], actorType: "human", recipients: [] }]);

  // false -> installed, "revoked" recorded, no bot.
  const declineRes = await install(await linkFor(targets[1]!.slug), targets[1]!.id, false);
  assert.equal(declineRes.status, 200, await declineRes.clone().text());
  const declinedInstall = await readInstall(targets[1]!.id, fx.client.id);
  assert.equal(declinedInstall?.botGrant, "revoked");
  assert.deepEqual((await declineRes.json() as { client: { bot?: BotOffer } }).client.bot, { offered: true, grant: "revoked", handle: fx.handle });
  assert.deepEqual(await getDb().select({ id: agents.id }).from(agents).where(eq(agents.managedByAppInstallId, declinedInstall!.id)), []);
  assert.deepEqual(await botGrantAudits(declinedInstall!.id), [{ actorId: fx.admin.id, botGrant: "revoked" }]);
  assert.equal((await botChangedEvents(declinedInstall!.id)).length, 1);

  // Absent -> today's behaviour: nothing decided, no audit.
  const laterRes = await install(await linkFor(targets[2]!.slug), targets[2]!.id);
  assert.equal(laterRes.status, 200);
  const laterInstall = await readInstall(targets[2]!.id, fx.client.id);
  assert.equal(laterInstall?.botGrant, null);
  assert.deepEqual((await laterRes.json() as { client: { bot?: BotOffer } }).client.bot, { offered: true, grant: "pending", handle: fx.handle });
  assert.deepEqual(await botGrantAudits(laterInstall!.id), []);
  assert.deepEqual(await botChangedEvents(laterInstall!.id), []);
});

test("a share-link install with bot: true on a taken handle still installs, leaves the bot pending and warns; an App without a bot offers none", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  await getDb().insert(agents).values({ serverId: fx.server.id, name: fx.handle, displayName: "Someone Else", status: "active", runtime: "external" });
  const share = await createOAuthClientShareLink({ serverId: fx.sourceServer.id, clientId: fx.client.id, targetServerSlug: fx.server.slug, createdByUserId: fx.developer.id });
  assert.ok(share);
  const auth = { Authorization: `Bearer ${fx.adminToken}`, "Content-Type": "application/json" };
  const res = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ serverId: fx.server.id, ...await expectedAppPermissionsBody(fx.client.id), bot: true }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { client: { bot?: BotOffer }; warnings?: string[] };
  assert.deepEqual(body.warnings, ["app_bot_handle_conflict"]);
  assert.deepEqual(body.client.bot, { offered: true, grant: "pending", handle: fx.handle });
  const install = await readInstall(fx.server.id, fx.client.id);
  assert.equal(install?.status, "active", "the install commits");
  assert.equal(install?.botGrant, null, "the grant rolled back with its savepoint");
  assert.deepEqual(await botGrantAudits(install!.id), []);

  const plain = await seedMarketplaceBotApp({ enableBot: false });
  const plainShare = await createOAuthClientShareLink({ serverId: plain.sourceServer.id, clientId: plain.client.id, targetServerSlug: plain.server.slug, createdByUserId: plain.developer.id });
  assert.ok(plainShare);
  const plainAuth = { Authorization: `Bearer ${plain.adminToken}`, "Content-Type": "application/json" };
  const plainInvite = await fetch(`${app.baseUrl}/api/integration-invites/${plainShare.token}`, { headers: plainAuth });
  assert.equal("bot" in (await plainInvite.json() as { client: Record<string, unknown> }).client, false);
  const plainRes = await fetch(`${app.baseUrl}/api/integration-invites/${plainShare.token}/install`, {
    method: "POST",
    headers: plainAuth,
    body: JSON.stringify({ serverId: plain.server.id, ...await expectedAppPermissionsBody(plain.client.id), bot: true }),
  });
  assert.equal(plainRes.status, 200, await plainRes.clone().text());
  assert.equal("bot" in (await plainRes.json() as { client: Record<string, unknown> }).client, false);
  assert.equal((await readInstall(plain.server.id, plain.client.id))?.botGrant, null);
});

test("bot: true on an App without a bot installs it and ignores the option", async ({ app }) => {
  const fx = await seedMarketplaceBotApp({ enableBot: false });
  const res = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ ...await expectedAppPermissionsBody(fx.client.id), bot: true }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as Record<string, unknown>;
  assert.equal("bot" in body, false);
  assert.equal("warnings" in body, false);
  const install = await readInstall(fx.server.id, fx.client.id);
  assert.equal(install?.botGrant, null);
  assert.deepEqual(await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install!.id)), []);
});

test("bot: true on a taken handle still installs, leaves the bot pending and returns a warning code", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  // A member agent already holds the handle on this Server.
  const [squatter] = await getDb().insert(agents).values({
    serverId: fx.server.id,
    name: fx.handle,
    displayName: "Someone Else",
    status: "active",
    runtime: "external",
  }).returning({ id: agents.id });

  const res = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ ...await expectedAppPermissionsBody(fx.client.id), bot: true }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { bot?: BotOffer; warnings?: string[] };
  assert.deepEqual(body.warnings, ["app_bot_handle_conflict"]);
  assert.deepEqual(body.bot, { offered: true, grant: "pending", handle: fx.handle });

  const install = await readInstall(fx.server.id, fx.client.id);
  assert.equal(install?.status, "active", "the install commits");
  assert.equal(install?.botGrant, null, "the grant rolled back with its savepoint");
  assert.deepEqual(await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install!.id)), []);
  assert.deepEqual(await getDb().select({ id: agents.id }).from(agents).where(eq(agents.managedByAppInstallId, install!.id)), []);
  assert.deepEqual(await botGrantAudits(install!.id), []);
  const [kept] = await getDb().select({ name: agents.name, managedBy: agents.managedByAppInstallId }).from(agents).where(eq(agents.id, squatter!.id));
  assert.deepEqual(kept, { name: fx.handle, managedBy: null }, "the existing agent is untouched");

  // The section's add button meets the same conflict as a coded 409.
  const grantRes = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(grantRes.status, 409);
  assert.equal((await grantRes.json() as { code?: string }).code, "app_bot_handle_conflict");
  assert.equal((await readInstall(fx.server.id, fx.client.id))?.botGrant, null);
});

test("Don't add: revoke on an install that never had a bot only records revoked, and the bot can be added later", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const installRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify(await expectedAppPermissionsBody(fx.client.id)),
  });
  assert.equal(installRes.status, 200);
  const install = await readInstall(fx.server.id, fx.client.id);
  assert.equal(install?.botGrant, null);
  const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action }),
  });

  const revokeRes = await setBotGrant("revoke");
  assert.equal(revokeRes.status, 200, await revokeRes.clone().text());
  assert.deepEqual(await revokeRes.json(), { installationId: install!.id, botGrant: "revoked", bot: null });
  assert.equal((await readInstall(fx.server.id, fx.client.id))?.botGrant, "revoked");
  assert.deepEqual(await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install!.id)), []);
  assert.deepEqual(await getDb().select({ id: agents.id }).from(agents).where(eq(agents.managedByAppInstallId, install!.id)), []);
  assert.deepEqual(await botGrantAudits(install!.id), [{ actorId: fx.admin.id, botGrant: "revoked" }]);

  // Declining is not final: the section's add button still works.
  const grantRes = await setBotGrant("grant");
  assert.equal(grantRes.status, 200, await grantRes.clone().text());
  assert.equal((await grantRes.json() as { botGrant: string }).botGrant, "granted");
});

test("only admins decide the bot: a member can neither install with it nor decline it", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const memberInstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.memberToken, fx.server.id),
    body: JSON.stringify({ ...await expectedAppPermissionsBody(fx.client.id), bot: true }),
  });
  assert.equal(memberInstall.status, 403);
  assert.equal(await readInstall(fx.server.id, fx.client.id), null);

  // Valid-access witness: the admin installs, leaving the bot pending.
  const adminInstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify(await expectedAppPermissionsBody(fx.client.id)),
  });
  assert.equal(adminInstall.status, 200);

  for (const action of ["revoke", "grant"] as const) {
    const res = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
      method: "POST",
      headers: headers(fx.memberToken, fx.server.id),
      body: JSON.stringify({ action }),
    });
    assert.equal(res.status, 403, `member ${action}`);
  }
  const install = await readInstall(fx.server.id, fx.client.id);
  assert.equal(install?.botGrant, null);
  assert.deepEqual(await getDb().select({ id: agents.id }).from(agents).where(eq(agents.managedByAppInstallId, install!.id)), []);
});

async function installWithBot(baseUrl: string, fx: Awaited<ReturnType<typeof seedMarketplaceBotApp>>, serverId: string, bot?: boolean) {
  const res = await fetch(`${baseUrl}/api/integrations/marketplace/${fx.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, serverId),
    body: JSON.stringify({ ...await expectedAppPermissionsBody(fx.client.id), ...(bot === undefined ? {} : { bot }) }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const install = await readInstall(serverId, fx.client.id);
  assert.ok(install);
  return install;
}

async function boundAgentId(installId: string) {
  const [binding] = await getDb().select({ agentId: appBotBindings.agentId, state: appBotBindings.state })
    .from(appBotBindings).where(eq(appBotBindings.installId, installId));
  return binding ?? null;
}

async function marketplaceBot(baseUrl: string, token: string, serverId: string, clientId: string) {
  const res = await fetch(`${baseUrl}/api/integrations/marketplace`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200);
  return (await res.json() as AppRow[]).find((row) => row.id === clientId)?.bot;
}

test("an App's bot can't be archived as an agent: its lifecycle belongs to the App installation", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const install = await installWithBot(app.baseUrl, fx, fx.server.id, true);
  const binding = await boundAgentId(install.id);
  assert.equal(binding?.state, "active");

  const res = await fetch(`${app.baseUrl}/api/agents/${binding!.agentId}`, {
    method: "DELETE",
    headers: headers(fx.adminToken, fx.server.id),
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { code?: string; error?: string };
  assert.equal(body.code, "app_bot_lifecycle_managed");
  assert.match(body.error ?? "", /Settings > Apps/);
  const [agent] = await getDb().select({ deletedAt: agents.deletedAt, status: agents.status }).from(agents).where(eq(agents.id, binding!.agentId));
  assert.equal(agent?.deletedAt, null, "the bot agent is not archived");
  assert.equal((await boundAgentId(install.id))?.state, "active");

  // Valid-access witness: the same admin archives an ordinary agent.
  const { machine } = await registerMachine(fx.server.id, fx.admin.id, "bot-archive-witness");
  const ordinary = await createAgent(fx.server.id, "Ordinary", { runtime: "codex", model: "gpt-5-codex", machineId: machine.id });
  const witness = await fetch(`${app.baseUrl}/api/agents/${ordinary.id}`, { method: "DELETE", headers: headers(fx.adminToken, fx.server.id) });
  assert.equal(witness.status, 200, await witness.clone().text());
});

test("re-adding never resurrects an archived bot: the grant refuses with a clear code and changes nothing", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const install = await installWithBot(app.baseUrl, fx, fx.server.id, true);
  const { agentId } = (await boundAgentId(install.id))!;
  const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action }),
  });

  // A bot archived before the archive refusal existed (or by any other path):
  // its binding still points at the deleted agent.
  await deleteAgent(agentId);
  // Live binding, deleted agent: not reported as granted.
  assert.deepEqual(await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id), { offered: true, grant: "pending", handle: fx.handle });
  const activeRes = await setBotGrant("grant");
  assert.equal(activeRes.status, 409);
  assert.equal((await activeRes.json() as { code?: string }).code, "app_bot_agent_deleted");

  // Removed, then re-added: the disabled binding is not re-activated onto the deleted agent.
  assert.equal((await setBotGrant("revoke")).status, 200);
  const res = await setBotGrant("grant");
  assert.equal(res.status, 409);
  const body = await res.json() as { code?: string; error?: string };
  assert.equal(body.code, "app_bot_agent_deleted");
  assert.match(body.error ?? "", /reinstall/);
  assert.equal((await readInstall(fx.server.id, fx.client.id))?.botGrant, "revoked", "the refused grant rolled back");
  // Its installation.bot_changed rolled back with it: the install's grant and the revoke only.
  assert.equal((await botChangedEvents(install.id)).length, 2);
  assert.equal((await boundAgentId(install.id))?.state, "disabled", "the binding stays disabled");
  const [agent] = await getDb().select({ deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, agentId));
  assert.ok(agent?.deletedAt, "the agent stays archived");
});

test("a developer turning the bot off sends granted Servers back to pending, so turning it on asks them again", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const declined = await createServer("Raft declined", `stamp-declined-${randomUUID().slice(0, 8)}`, fx.admin.id);
  const granted = await installWithBot(app.baseUrl, fx, fx.server.id, true);
  await installWithBot(app.baseUrl, fx, declined.id, false);
  const { agentId } = (await boundAgentId(granted.id))!;
  await mintAgentCredential({ agentId, scopes: ["send"], name: "bot-off-test", issuedVia: "app", createdByUserId: null });
  const setEnableBot = (enableBot: boolean) => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}`, {
    method: "PATCH",
    headers: headers(fx.developerToken, fx.sourceServer.id),
    body: JSON.stringify({ enableBot }),
  });

  assert.equal((await setEnableBot(false)).status, 200);
  assert.equal((await readInstall(fx.server.id, fx.client.id))?.botGrant, "pending", "granted -> pending, not the admin's revoked");
  assert.equal((await readInstall(declined.id, fx.client.id))?.botGrant, "revoked", "an admin's decline is kept");
  // The reset is a bot_grant change like any other: audited (the developer
  // turned it off) and announced to that installation, in the same transaction.
  assert.deepEqual(await botGrantAudits(granted.id), [
    { actorId: fx.admin.id, botGrant: "granted" },
    { actorId: fx.developer.id, botGrant: "pending" },
  ]);
  assert.equal((await botChangedEvents(granted.id)).length, 2);
  const declinedInstall = (await readInstall(declined.id, fx.client.id))!;
  assert.equal((await botGrantAudits(declinedInstall.id)).length, 1, "the declined installation is untouched");
  assert.equal((await botChangedEvents(declinedInstall.id)).length, 1);
  assert.equal((await boundAgentId(granted.id))?.state, "disabled");
  const liveKeys = await getDb().select({ id: agentCredentials.id }).from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)));
  assert.deepEqual(liveKeys, [], "the bot's keys are revoked");
  assert.equal(await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id), undefined, "no bot while the App ships none");

  assert.equal((await setEnableBot(true)).status, 200);
  const prompted = await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id);
  assert.equal(prompted?.grant, "pending", "the Server that had the bot is asked again");
  assert.equal(prompted?.agentId, undefined);
  assert.equal((await marketplaceBot(app.baseUrl, fx.adminToken, declined.id, fx.client.id))?.grant, "revoked");

  // Adding it again brings back the same bot.
  const regrant = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(regrant.status, 200, await regrant.clone().text());
  assert.equal((await regrant.json() as { bot: { agentId: string } }).bot.agentId, agentId);
});

test("bot.grant reads granted only while the install and the binding are active", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const install = await installWithBot(app.baseUrl, fx, fx.server.id, true);
  const { agentId } = (await boundAgentId(install.id))!;
  assert.deepEqual(await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id),
    { offered: true, grant: "granted", handle: fx.handle, agentId });

  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual(await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id),
    { offered: true, grant: "pending", handle: fx.handle }, "a suspended install is not granted");

  await getDb().update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.id, install.id));
  await getDb().update(appBotBindings).set({ state: "disabled", disabledAt: new Date() }).where(eq(appBotBindings.installId, install.id));
  assert.deepEqual(await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id),
    { offered: true, grant: "pending", handle: fx.handle }, "a disabled binding is not granted");

  await getDb().update(appBotBindings).set({ state: "active", disabledAt: null }).where(eq(appBotBindings.installId, install.id));
  assert.equal((await marketplaceBot(app.baseUrl, fx.adminToken, fx.server.id, fx.client.id))?.grant, "granted");
});

// Layer 3 (#proj-apps #35): the App itself learns where its bot stands, from
// the lookup, from a refused bot-token / bot-status, and from
// installation.bot_changed.

async function seedBotlessApp(fx: Awaited<ReturnType<typeof seedMarketplaceBotApp>>) {
  const { client, clientSecret } = await createOAuthClient({
    serverId: fx.sourceServer.id,
    createdByUserId: fx.developer.id,
    appType: "third_party_global",
    clientId: `vault-${randomUUID().slice(0, 8)}`,
    name: "Vault",
    description: "Secrets for agents.",
    homepageUrl: "https://vault.example.test",
    returnUrl: "https://vault.example.test/callback",
  });
  await getDb().update(oauthClients).set({ publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, client.id));
  return { client, clientSecret };
}

test("the installation lookup tells the App its bot: not_added (undecided or pending), added with agent_id, declined; null for an App without one", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const install = await installWithBot(app.baseUrl, fx, fx.server.id);
  const lookup = () => lookupInstallation(app.baseUrl, fx.client.clientId, fx.clientSecret, fx.server.id);
  const addUrl = `${getAppUrl()}/s/${fx.server.slug}/apps?app_bot=${fx.client.clientId}`;
  // The web origin, the Server's slug, and the public client_id the App authenticates with.
  assert.match(addUrl, /^https?:\/\/[^/]+\/s\/stamp-target-[0-9a-f]{8}\/apps\?app_bot=stamp-[0-9a-f]{8}$/);

  assert.equal(install.botGrant, null);
  assert.deepEqual((await lookup()).bot, { handle: fx.handle, state: "not_added", add_url: addUrl });
  await getDb().update(oauthClientInstalls).set({ botGrant: "pending" }).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual((await lookup()).bot, { handle: fx.handle, state: "not_added", add_url: addUrl });

  const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action }),
  });
  assert.equal((await setBotGrant("grant")).status, 200);
  const { agentId } = (await boundAgentId(install.id))!;
  assert.deepEqual((await lookup()).bot, { handle: fx.handle, state: "added", agent_id: agentId, add_url: addUrl });

  // Granted but not live (binding disabled): not added, as the App lists say.
  await getDb().update(appBotBindings).set({ state: "disabled" }).where(eq(appBotBindings.installId, install.id));
  assert.deepEqual((await lookup()).bot, { handle: fx.handle, state: "not_added", add_url: addUrl });
  await getDb().update(appBotBindings).set({ state: "active" }).where(eq(appBotBindings.installId, install.id));

  assert.equal((await setBotGrant("revoke")).status, 200);
  assert.deepEqual((await lookup()).bot, { handle: fx.handle, state: "declined", add_url: addUrl });

  const botless = await seedBotlessApp(fx);
  const botlessInstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${botless.client.id}/install`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify(await expectedAppPermissionsBody(botless.client.id)),
  });
  assert.equal(botlessInstall.status, 200, await botlessInstall.clone().text());
  const botlessLookup = await lookupInstallation(app.baseUrl, botless.client.clientId, botless.clientSecret, fx.server.id);
  assert.equal(botlessLookup.bot, null);
});

test("bot-token and bot-status refusals say why: not_added and declined carry add_url; a suspended installation is installation_suspended, without one", async ({ app }) => {
  const fx = await seedMarketplaceBotApp();
  const install = await installWithBot(app.baseUrl, fx, fx.server.id);
  const addUrl = `${getAppUrl()}/s/${fx.server.slug}/apps?app_bot=${fx.client.clientId}`;
  const botToken = async (clientKey = fx.client.clientId, secret = fx.clientSecret, installationId = install.id) => {
    const res = await fetch(`${app.baseUrl}/api/oauth/installations/${installationId}/bot-token`, {
      method: "POST", headers: appAuth(clientKey, secret), body: JSON.stringify({}),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const botStatus = async () => {
    const res = await fetch(`${app.baseUrl}/api/oauth/installations/${install.id}/bot-status`, {
      method: "PUT", headers: appAuth(fx.client.clientId, fx.clientSecret), body: JSON.stringify({ text: "Indexing" }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const notGranted = { error: "Bot grant not active for this installation", code: "bot_not_granted" };

  assert.deepEqual(await botToken(), { status: 403, body: { ...notGranted, state: "not_added", add_url: addUrl } });
  assert.deepEqual(await botStatus(), { status: 403, body: { ...notGranted, state: "not_added", add_url: addUrl } });

  const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
    method: "POST",
    headers: headers(fx.adminToken, fx.server.id),
    body: JSON.stringify({ action }),
  });
  assert.equal((await setBotGrant("revoke")).status, 200);
  assert.deepEqual(await botToken(), { status: 403, body: { ...notGranted, state: "declined", add_url: addUrl } });
  assert.deepEqual(await botStatus(), { status: 403, body: { ...notGranted, state: "declined", add_url: addUrl } });

  // Granted, binding disabled: bot-status's other 403 carries the same detail.
  assert.equal((await setBotGrant("grant")).status, 200);
  await getDb().update(appBotBindings).set({ state: "disabled" }).where(eq(appBotBindings.installId, install.id));
  assert.deepEqual(await botStatus(), {
    status: 403,
    body: { error: "Bot grant not active for this installation", code: "bot_not_active", state: "not_added", add_url: addUrl },
  });
  await getDb().update(appBotBindings).set({ state: "active" }).where(eq(appBotBindings.installId, install.id));
  assert.equal((await botToken()).status, 200, "valid-access witness: the live bot gets its key");

  // Suspended: never not_added, and no link (adding the bot would not help).
  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual(await botToken(), { status: 403, body: { ...notGranted, state: "installation_suspended" } });
  // bot-status keeps answering a suspended installation as not found, as before.
  assert.deepEqual(await botStatus(), { status: 404, body: { error: "Active installation not found", code: "installation_not_found" } });

  // An App without a bot: not added, and no link to a bot that does not exist.
  const botless = await seedBotlessApp(fx);
  const [botlessInstall] = await getDb().insert(oauthClientInstalls).values({
    serverId: fx.server.id, clientId: botless.client.id, installedByUserId: fx.admin.id,
  }).returning();
  assert.deepEqual(await botToken(botless.client.clientId, botless.clientSecret, botlessInstall!.id), {
    status: 403, body: { ...notGranted, state: "not_added" },
  });
});

test("installation.bot_changed: subscribed without a group, emitted with every bot change, delivered to the App's own installation only", async ({ app }) => {
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));
  try {
    const fx = await seedMarketplaceBotApp();
    const other = await createServer("Raft other", `stamp-other-${randomUUID().slice(0, 8)}`, fx.admin.id);
    assert.ok(await configureAppWebhook({ clientId: fx.client.id, actorUserId: fx.developer.id, endpointUrl: "https://hooks.example.com/raft" }));
    const install = await installWithBot(app.baseUrl, fx, fx.server.id);
    const otherInstall = await installWithBot(app.baseUrl, fx, other.id);
    const subscribe = (installationId: string, events: string[]) => fetch(`${app.baseUrl}/api/oauth/installations/${installationId}/subscriptions`, {
      method: "PUT", headers: appAuth(fx.client.clientId, fx.clientSecret), body: JSON.stringify({ events }),
    });

    // The App declares no events and the installer approved no group: the
    // installation's own event is still subscribable; any other is not.
    const [row] = await getDb().select({ approvedGroups: oauthClientInstalls.approvedGroups }).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
    assert.deepEqual(row?.approvedGroups, []);
    const refused = await subscribe(install.id, ["server.member_added"]);
    assert.equal(refused.status, 400, "a group-gated event still needs its group");
    for (const installationId of [install.id, otherInstall.id]) {
      const res = await subscribe(installationId, ["installation.bot_changed"]);
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual((await res.json() as { subscribed_events: string[] }).subscribed_events, ["installation.bot_changed"]);
    }
    // The installer's App Notifications settings list the events they approve groups for; this one has none.
    const installerView = await fetch(`${app.baseUrl}/api/integrations/marketplace/${fx.client.id}/install/app-notifications`, {
      headers: headers(fx.adminToken, fx.server.id),
    });
    assert.equal(installerView.status, 200);
    assert.deepEqual((await installerView.json() as { subscribed_events: string[] }).subscribed_events, []);

    const posts: Array<{ installation_id: string; event: Record<string, unknown> }> = [];
    const drain = () => drainAppNotificationDeliveries({
      post: async ({ body }) => {
        posts.push(JSON.parse(body));
        return { status: 204 };
      },
    });
    const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
      method: "POST",
      headers: headers(fx.adminToken, fx.server.id),
      body: JSON.stringify({ action }),
    });

    // Added: addressed to this installation alone, not the same App's other one.
    assert.equal((await setBotGrant("grant")).status, 200);
    const { agentId } = (await boundAgentId(install.id))!;
    assert.deepEqual(await botChangedEvents(install.id), [{ subjectType: "installation", requiredGroups: [], actorType: "human", recipients: [install.id] }]);
    assert.deepEqual(await botChangedEvents(otherInstall.id), []);
    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.equal(posts[0]!.installation_id, install.id);
    assert.deepEqual(
      { type: posts[0]!.event.type, server_id: posts[0]!.event.server_id, subject: posts[0]!.event.subject, provenance: posts[0]!.event.provenance, data: posts[0]!.event.data },
      {
        type: "installation.bot_changed",
        server_id: fx.server.id,
        subject: { type: "installation", id: install.id },
        provenance: { actor_type: "human", source: "app_bot_service" },
        data: { state: "added", handle: fx.handle, agent_id: agentId },
      },
    );

    // Removed: declined, no agent_id.
    assert.equal((await setBotGrant("revoke")).status, 200);
    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.deepEqual(posts[1]!.event.data, { state: "declined", handle: fx.handle });

    // A grant that fails (the handle is taken on the other Server) rolls its event back with it.
    await getDb().insert(agents).values({ serverId: other.id, name: fx.handle, displayName: "Someone Else", status: "active", runtime: "external" });
    const conflict = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/install/bot`, {
      method: "POST", headers: headers(fx.adminToken, other.id), body: JSON.stringify({ action: "grant" }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await botChangedEvents(otherInstall.id), []);

    // Never while suspended: queued before the suspension, it is suppressed
    // at send; changed during it (the developer turns the bot off), it gets
    // no recipient at all.
    assert.equal((await setBotGrant("grant")).status, 200);
    await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, install.id));
    assert.deepEqual(await drain(), { claimed: 1, delivered: 0, retried: 0, suppressed: 1, deadLettered: 0 });
    const turnedOff = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}`, {
      method: "PATCH", headers: headers(fx.developerToken, fx.sourceServer.id), body: JSON.stringify({ enableBot: false }),
    });
    assert.equal(turnedOff.status, 200);
    const changes = await botChangedEvents(install.id);
    assert.equal(changes.length, 4);
    assert.deepEqual(changes[3]!.recipients, [], "a suspended installation is not a recipient");
    assert.deepEqual(await drain(), { claimed: 0, delivered: 0, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.equal(posts.length, 2);
  } finally {
    __setAppWebhookEncryptionKeyForTests(null);
  }
});
