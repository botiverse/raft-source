import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { actionCards, messages, oauthClientInstalls, oauthClients, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { ActionCardError, bindMarketplaceAppName, executeActionCard, prepareActionCard } from "../services/actionCardsService";
import { createOAuthClientShareLink } from "../services/oauthService";

// Installing an app or approving its update
// records exactly the login scopes and data groups the admin was shown, and
// only while they still equal the app's declaration. Each of the five entry
// points is covered: marketplace install, approve update, the agent's install
// card, the install button on the human login page, and the private share
// invite page.
const test = createApiTest();

async function seedApp(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const publisher = await createServer("Publisher", `v85-pub-${suffix}`, owner.id);
  const server = await createServer("Installer", `v85-inst-${suffix}`, owner.id);
  const [client] = await getDb().insert(oauthClients).values({
    serverId: publisher.id,
    createdByUserId: owner.id,
    clientId: `v85-app-${suffix}`,
    clientSecretHash: createHash("sha256").update(randomUUID()).digest("hex"),
    appType: "third_party_global",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    name: "Shown Scopes App",
    returnUrl: "https://v85.example.test/callback",
    allowedScopes: ["openid", "profile"],
    outboundCurrentGroups: ["channel"],
  }).returning();
  const token = await tokenForHuman(owner.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  // The developer edits the app while an admin is looking at it.
  const developerSets = (values: { allowedScopes?: string[]; outboundCurrentGroups?: string[] }) => getDb()
    .update(oauthClients).set(values).where(eq(oauthClients.id, client.id));
  const installRows = () => getDb().select().from(oauthClientInstalls)
    .where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, server.id)));
  return { owner, server, client, headers, developerSets, installRows };
}

const shown = (scopes: string[], groups: string[]) => JSON.stringify({ expected_scopes: scopes, expected_groups: groups });

test("marketplace install records the shown set and rejects a set that changed after it was shown", async ({ app }) => {
  const f = await seedApp("v85-market");
  const install = (body?: string) => fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install`, {
    method: "POST",
    headers: f.headers,
    ...(body === undefined ? {} : { body }),
  });

  const missing = await install();
  assert.equal(missing.status, 400);
  assert.equal((await missing.json() as { code: string }).code, "EXPECTED_PERMISSIONS_REQUIRED");

  // The admin was shown openid + profile; the developer then adds a scope.
  await f.developerSets({ allowedScopes: ["openid", "profile", "agent:notification:write"] });
  const added = await install(shown(["openid", "profile"], ["channel"]));
  assert.equal(added.status, 409);
  const addedBody = await added.json() as { code: string; current_scopes: string[]; current_groups: string[] };
  assert.equal(addedBody.code, "APP_PERMISSIONS_CHANGED");
  assert.deepEqual(addedBody.current_scopes, ["openid", "profile", "agent:notification:write"]);
  assert.deepEqual(addedBody.current_groups, ["channel"]);

  // Fewer scopes than shown is a mismatch too: only an exact match passes.
  await f.developerSets({ allowedScopes: ["openid"] });
  assert.equal((await install(shown(["openid", "profile"], ["channel"]))).status, 409);

  // A data group added after it was shown.
  await f.developerSets({ allowedScopes: ["openid", "profile"], outboundCurrentGroups: ["channel", "agent"] });
  assert.equal((await install(shown(["openid", "profile"], ["channel"]))).status, 409);
  assert.equal((await f.installRows()).length, 0, "no rejected attempt installed the app");

  // Positive control: confirming what is current installs and records it.
  const ok = await install(shown(["profile", "openid"], ["agent", "channel"]));
  assert.equal(ok.status, 200, await ok.clone().text());
  const [row] = await f.installRows();
  assert.deepEqual(row?.approvedScopes, ["openid", "profile"]);
  assert.deepEqual(row?.approvedGroups, ["channel", "agent"]);
});

test("approve update records the shown set and rejects a scope added after the page loaded", async ({ app }) => {
  const f = await seedApp("v85-approve");
  const installed = await fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install`, {
    method: "POST", headers: f.headers, body: shown(["openid", "profile"], ["channel"]),
  });
  assert.equal(installed.status, 200, await installed.clone().text());

  await f.developerSets({ allowedScopes: ["openid", "profile", "email"] });
  const stateRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install/app-notifications`, { headers: f.headers });
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json() as { requested_scopes: string[]; requested_groups: string[]; new_scopes: string[] };
  assert.deepEqual(state.new_scopes, ["email"]);

  // Between the page loading and the click, the developer adds another scope.
  await f.developerSets({ allowedScopes: ["openid", "profile", "email", "agent:notification:write"] });
  const approve = (body?: string) => fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install/app-notifications/grant`, {
    method: "PUT", headers: f.headers, ...(body === undefined ? {} : { body }),
  });
  const missing = await approve();
  assert.equal(missing.status, 400);
  assert.equal((await missing.json() as { code: string }).code, "EXPECTED_PERMISSIONS_REQUIRED");
  const stale = await approve(shown(state.requested_scopes, state.requested_groups));
  assert.equal(stale.status, 409);
  const staleBody = await stale.json() as { code: string; current_scopes: string[] };
  assert.equal(staleBody.code, "APP_PERMISSIONS_CHANGED");
  assert.deepEqual(staleBody.current_scopes, ["openid", "profile", "email", "agent:notification:write"]);
  assert.deepEqual((await f.installRows())[0]?.approvedScopes, ["openid", "profile"], "nothing was approved");

  // Positive control: approving the reloaded set records exactly it.
  const ok = await approve(shown(["openid", "profile", "email", "agent:notification:write"], ["channel"]));
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual((await f.installRows())[0]?.approvedScopes, ["openid", "profile", "email", "agent:notification:write"]);
});

test("an install card binds the app's set when prepared and refuses to install a different one", async ({ app: _app }) => {
  const f = await seedApp("v85-card");
  const agent = await createAgent(f.server.id, `V85Card${randomUUID().slice(0, 4)}`, { runtime: "external", model: "external" });
  const channel = await createChannel(f.server.id, `v85-card-${randomUUID().slice(0, 6)}`, undefined, "channel");
  await addAgent(channel.id, agent.id);
  await addHuman(channel.id, f.owner.id);
  const prepare = () => prepareActionCard({
    serverId: f.server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:install_marketplace_app",
      clientId: f.client.id,
      clientKey: f.client.clientId,
      ...bindMarketplaceAppName(f.client.name),
      agentId: agent.id,
      agentName: agent.name,
      // Only the agent's login scopes; the card must still bind the app's whole set.
      scopes: ["openid"],
      // An agent can't choose the bound set: the server overwrites it.
      installScopes: ["openid"],
      installGroups: [],
    },
  });
  const execute = (messageId: string) => executeActionCard({ webSessionFamilyId: null, messageId, serverId: asServerId(f.server.id), userId: f.owner.id });
  const permissionsChanged = (error: unknown) => error instanceof ActionCardError
    && error.status === 409 && error.code === "APP_PERMISSIONS_CHANGED";

  const card = await prepare();
  const action = card.metadata.action;
  if (action.type !== "integration:install_marketplace_app") throw new Error("wrong card");
  assert.deepEqual(action.installScopes, ["openid", "profile"]);
  assert.deepEqual(action.installGroups, ["channel"]);

  await f.developerSets({ allowedScopes: ["openid", "profile", "agent:notification:write"] });
  await assert.rejects(execute(card.messageId), permissionsChanged);
  assert.equal((await f.installRows()).length, 0, "the stale card did not install the app");

  // A card prepared before the binding existed can't be executed either.
  const legacy = await prepare();
  await getDb().update(actionCards)
    .set({ payload: sql`${actionCards.payload} - 'installScopes' - 'installGroups'` })
    .where(eq(actionCards.messageId, legacy.messageId));
  await getDb().update(messages)
    .set({ actionMetadata: sql`jsonb_set(${messages.actionMetadata}::jsonb, '{action}', (${messages.actionMetadata}::jsonb->'action') - 'installScopes' - 'installGroups')::json` })
    .where(eq(messages.id, legacy.messageId));
  await assert.rejects(execute(legacy.messageId), permissionsChanged);
  assert.equal((await f.installRows()).length, 0);

  // Positive control: a fresh card installs exactly the set it shows.
  const fresh = await prepare();
  await execute(fresh.messageId);
  const [row] = await f.installRows();
  assert.deepEqual(row?.approvedScopes, ["openid", "profile", "agent:notification:write"]);
  assert.deepEqual(row?.approvedGroups, ["channel"]);
});

test("the login page's install button gets the app's whole set and installs only that set", async ({ app }) => {
  const f = await seedApp("v85-login");
  const lookup = await fetch(
    `${app.baseUrl}/api/oauth/clients/lookup?client_id=${encodeURIComponent(f.client.clientId)}&server_id=${encodeURIComponent(f.server.id)}&scope=openid`,
    { headers: f.headers },
  );
  assert.equal(lookup.status, 200, await lookup.clone().text());
  const entry = await lookup.json() as { availability: string; allowedScopes: string[]; appNotificationGroups: string[] };
  assert.equal(entry.availability, "install_required");
  // The human only asked for openid, but installing approves all of these.
  assert.deepEqual(entry.allowedScopes, ["openid", "profile"]);
  assert.deepEqual(entry.appNotificationGroups, ["channel"]);

  const install = () => fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install`, {
    method: "POST", headers: f.headers, body: shown(entry.allowedScopes, entry.appNotificationGroups),
  });
  await f.developerSets({ outboundCurrentGroups: ["channel", "server"] });
  assert.equal((await install()).status, 409, "a group added after the page loaded");
  assert.equal((await f.installRows()).length, 0);

  // Positive control: back to what the page showed.
  await f.developerSets({ outboundCurrentGroups: ["channel"] });
  assert.equal((await install()).status, 200);
  assert.deepEqual((await f.installRows())[0]?.approvedScopes, ["openid", "profile"]);
});

test("private share invite install records the shown set and rejects a set that changed after it was shown", async ({ app }) => {
  const f = await seedApp("v85-invite");
  const share = await createOAuthClientShareLink({ serverId: f.client.serverId, clientId: f.client.id, targetServerSlug: f.server.slug, createdByUserId: f.owner.id });
  assert.ok(share);
  const { Authorization } = f.headers;

  // The invite page gets the data groups it must show, next to the scopes.
  const inviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}`, { headers: { Authorization } });
  assert.equal(inviteRes.status, 200);
  const invite = await inviteRes.json() as { client: { allowedScopes: string[]; appNotificationGroups: string[] } };
  assert.deepEqual(invite.client.appNotificationGroups, ["channel"]);

  const install = (fields: Record<string, unknown>) => fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
    method: "POST",
    headers: { Authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: f.server.id, ...fields }),
  });

  const missing = await install({});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json() as { code: string }).code, "EXPECTED_PERMISSIONS_REQUIRED");

  // The admin was shown openid + profile and channel; the developer then adds a group.
  await f.developerSets({ outboundCurrentGroups: ["channel", "agent"] });
  const stale = await install({ expected_scopes: ["openid", "profile"], expected_groups: ["channel"] });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json() as { code: string; current_scopes: string[]; current_groups: string[] };
  assert.equal(staleBody.code, "APP_PERMISSIONS_CHANGED");
  assert.deepEqual(staleBody.current_scopes, ["openid", "profile"]);
  assert.deepEqual(staleBody.current_groups, ["channel", "agent"]);
  assert.equal((await f.installRows()).length, 0, "the rejected attempt did not install the app");

  // Positive control: confirming what is current installs and records it.
  const ok = await install({ expected_scopes: ["openid", "profile"], expected_groups: ["agent", "channel"] });
  assert.equal(ok.status, 200, await ok.clone().text());
  const [row] = await f.installRows();
  assert.deepEqual(row?.approvedScopes, ["openid", "profile"]);
  assert.deepEqual(row?.approvedGroups, ["channel", "agent"]);
});
