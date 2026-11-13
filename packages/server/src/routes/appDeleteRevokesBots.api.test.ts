import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentCredentials, agents, oauthClientInstalls, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";

// Deleting an App must take its managed Bots, on every
// Server that installed it, with it — not leave their keys working.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
  return user;
}

/** An App made on Server A, installed on Server B with its Bot granted and a Bot key minted. */
async function installedAppWithBotKey(baseUrl: string) {
  const short = randomUUID().slice(0, 8);
  const sourceOwner = await seedUser("source-owner");
  const installerOwner = await seedUser("installer-owner");
  const source = await createServer("App Source", `app-source-${short}`, sourceOwner.id);
  const installer = await createServer("App Installer", `app-installer-${short}`, installerOwner.id);
  const { client, clientSecret } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: sourceOwner.id,
    clientId: `deleted-bot-app-${short}`,
    name: "Deleted Bot App",
    enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: installer.id,
    clientId: client.id,
    installedByUserId: installerOwner.id,
    status: "active",
    botGrant: "pending",
  }).returning();
  const installerToken = await tokenForHuman(installerOwner.email);
  const grant = await fetch(`${baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${installerToken}`, "X-Server-Id": installer.id, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(grant.status, 200, await grant.clone().text());
  const { bot } = await grant.json() as { bot: { agentId: string } };
  const minted = await fetch(`${baseUrl}/api/oauth/installations/${install.id}/bot-token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(minted.status, 200, await minted.clone().text());
  const { apiKey } = await minted.json() as { apiKey: string };
  return { source, sourceOwner, installer, client, install, botAgentId: bot.agentId, apiKey };
}

function whoami(baseUrl: string, apiKey: string) {
  return fetch(`${baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } });
}

test("⭐ deleting an App uninstalls its Bot on every installing Server: the Bot key stops working", async ({ app }) => {
  const f = await installedAppWithBotKey(app.baseUrl);
  assert.equal((await whoami(app.baseUrl, f.apiKey)).status, 200);

  const deleted = await fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${await tokenForHuman(f.sourceOwner.email)}`, "X-Server-Id": f.source.id },
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());

  assert.equal((await whoami(app.baseUrl, f.apiKey)).status, 401);
  // Uninstalled like an explicit uninstall: soft-deleted, every key revoked.
  const [bot] = await getDb().select({ deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, f.botAgentId));
  assert.ok(bot?.deletedAt, "the installing Server's Bot is soft-deleted");
  const keys = await getDb().select({ revokedAt: agentCredentials.revokedAt, reason: agentCredentials.revokedReason })
    .from(agentCredentials).where(eq(agentCredentials.agentId, f.botAgentId));
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(key.revokedAt);
    assert.equal(key.reason, "bot_uninstalled");
  }
});

test("⭐ an App-minted key whose agent no installation manages is refused", async ({ app }) => {
  const f = await installedAppWithBotKey(app.baseUrl);
  assert.equal((await whoami(app.baseUrl, f.apiKey)).status, 200);
  // The state an App deletion left behind before the fix: the installation's
  // cascade unlinked the Bot, the agent and its key untouched.
  await getDb().update(agents).set({ managedByAppInstallId: null }).where(eq(agents.id, f.botAgentId));
  const refused = await whoami(app.baseUrl, f.apiKey);
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: "App bot binding not active" });
});
