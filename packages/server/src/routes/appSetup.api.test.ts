import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { test as nativeTest } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { openTestApp } from "../test/integration/app";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { expectedAppPermissionsJson } from "../test/integration/appPermissions";
import { getDb } from "../db";
import { users, oauthClients, oauthClientInstalls, integrationAuditEvents, serverAgentMembers } from "../db/schema";
import { createServer, addMember } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { prepareActionCard, executeActionCard, bindMarketplaceAppName, ActionCardError } from "../services/actionCardsService";
import { asServerId } from "@botiverse/raft-shared";

const test = createApiTest();

async function fixture(baseUrl: string, setupUrl: string | null = "https://setup.example.test/configure?from=raft&server_id=untrusted") {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({ email: `setup-${suffix}@example.test`, name: `setup-${suffix}`, passwordHash: await fixturePasswordHash("fixture-only"), emailVerified: true }).returning();
  const source = await createServer("Publisher", `publisher-${suffix}`, owner.id);
  const target = await createServer("Installed", `installed-${suffix}`, owner.id);
  const created = await createOAuthClient({ serverId: source.id, createdByUserId: owner.id, name: "Setup App", clientId: `setup-${suffix}`, setupUrl, setupDescription: setupUrl ? "Choose a repository" : null });
  await getDb().update(oauthClients).set({ appType: "third_party_global", publishStatus: "published" }).where(eq(oauthClients.id, created.client.id));
  const token = await tokenForHuman(owner.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": target.id, "Content-Type": "application/json" };
  const sourceHeaders = { ...headers, "X-Server-Id": source.id };
  const install = async () => {
    const response = await fetch(`${baseUrl}/api/integrations/marketplace/${created.client.id}/install`, { method: "POST", headers, body: await expectedAppPermissionsJson(created.client.id) });
    assert.equal(response.status, 200, await response.clone().text());
    const [row] = await getDb().select().from(oauthClientInstalls).where(and(eq(oauthClientInstalls.clientId, created.client.id), eq(oauthClientInstalls.serverId, target.id)));
    assert.ok(row); return row;
  };
  const installation = await install();
  const read = () => fetch(`${baseUrl}/api/integrations/clients/${created.client.id}/setup`, { headers });
  const report = (revision: number, status: string, installationId = installation.id, credentials = created) => fetch(`${baseUrl}/api/oauth/installations/${installationId}/setup`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: credentials.client.clientId, clientSecret: credentials.clientSecret, revision, status }),
  });
  return { ...created, source, target, owner, headers, sourceHeaders, install, installation, read, report };
}

test("installation setup links carry exact context; reading/visiting never completes setup or changes grants", async ({ app }) => {
  const f = await fixture(app.baseUrl);
  const before = f.installation;
  const first = await f.read();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control") ?? "", /no-store/);
  const state = await first.json() as { status: string; url: string; revision: number; canConfigure: boolean };
  assert.equal(state.status, "pending"); assert.equal(state.canConfigure, true); assert.equal(state.revision, 1);
  const link = new URL(state.url);
  assert.equal(link.origin, "https://setup.example.test");
  assert.equal(link.searchParams.get("installation_id"), before.id);
  assert.equal(link.searchParams.get("server_id"), f.target.id);
  assert.equal(link.searchParams.get("setup_revision"), "1");
  assert.equal(link.searchParams.get("from"), "raft");
  assert.equal((await f.read()).status, 200);
  assert.deepEqual((await getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, before.id)))[0], before);

  const [member] = await getDb().insert(users).values({ email: "setup-member@example.test", name: "setup-member", passwordHash: await fixturePasswordHash("fixture-only"), emailVerified: true }).returning();
  await addMember(f.target.id, member.id, "member");
  const memberRead = await fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}/setup`, { headers: { ...f.headers, Authorization: `Bearer ${await tokenForHuman(member.email)}` } });
  assert.equal(memberRead.status, 200);
  const memberState = await memberRead.json() as { url: string | null; canConfigure: boolean; status: string };
  assert.equal(memberState.status, "pending"); assert.equal(memberState.url, null); assert.equal(memberState.canConfigure, false);
  const unauthenticatedReport = await fetch(`${app.baseUrl}/api/oauth/installations/${before.id}/setup`, { method: "PUT", headers: f.headers, body: JSON.stringify({ revision: 1, status: "complete" }) });
  assert.equal(unauthenticatedReport.status, 401, "human login is not App backend authentication");
});

test("only the owning App can report setup; revision changes, replay and uninstall are bounded", async ({ app }) => {
  const f = await fixture(app.baseUrl);
  const other = await createOAuthClient({ serverId: f.source.id, createdByUserId: f.owner.id, name: "Other App", setupUrl: "https://other.example.test/setup" });
  assert.equal((await f.report(1, "complete", f.installation.id, other)).status, 404);
  assert.equal((await f.report(1, "anything")).status, 400);
  const patch = await fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}`, { method: "PATCH", headers: f.sourceHeaders, body: JSON.stringify({ setupUrl: "https://setup.example.test/second" }) });
  assert.equal(patch.status, 200, await patch.clone().text());
  assert.equal((await f.report(1, "complete")).status, 409);
  const complete = await f.report(2, "complete"); assert.equal(complete.status, 200, await complete.clone().text());
  const completed = await complete.json();
  assert.deepEqual(await (await f.report(2, "complete")).json(), completed);
  const audit = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "installation.setup_updated"));
  assert.equal(audit.length, 1, "same completion is idempotent including audit");
  const [after] = await getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, f.installation.id));
  assert.deepEqual(after.approvedGroups, f.installation.approvedGroups);
  assert.deepEqual(after.subscribedEvents, f.installation.subscribedEvents);
  assert.equal(after.grantRevision, f.installation.grantRevision);
  assert.equal(after.botGrant, f.installation.botGrant);
  assert.equal(after.agentJwtEnabled, f.installation.agentJwtEnabled);
  await fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}`, { method: "PATCH", headers: f.sourceHeaders, body: JSON.stringify({ setupDescription: "Clarified instructions" }) });
  assert.equal((await (await f.read()).json() as { status: string }).status, "complete", "wording changes do not require configuration again");
  assert.equal((await f.report(2, "pending")).status, 200);
  assert.equal((await (await f.read()).json() as { status: string }).status, "pending");
  const uninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install`, { method: "DELETE", headers: f.headers });
  assert.equal(uninstall.status, 200);
  assert.equal((await f.report(2, "complete")).status, 404);
  const reinstalled = await f.install(); assert.notEqual(reinstalled.id, f.installation.id);
  assert.equal((await (await f.read()).json() as { status: string }).status, "pending");
  assert.equal((await f.report(2, "complete")).status, 404);
});

test("existing Apps need no setup; unsafe destinations and inactive installations fail closed", async ({ app }) => {
  const f = await fixture(app.baseUrl, null);
  const state = await (await f.read()).json() as { status: string; url: string | null };
  assert.equal(state.status, "not_required"); assert.equal(state.url, null);
  assert.equal((await f.report(1, "complete")).status, 409);
  for (const setupUrl of ["javascript:alert(1)", "https://user:pass@example.test/setup", "http://example.test/setup", "https://example.test/setup#token"]) {
    const patch = await fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}`, { method: "PATCH", headers: f.sourceHeaders, body: JSON.stringify({ setupUrl }) });
    assert.equal(patch.status, 400, setupUrl);
  }
  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, f.installation.id));
  assert.equal((await f.read()).status, 404); assert.equal((await f.report(1, "complete")).status, 404);
  await getDb().update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.id, f.installation.id));
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, f.client.id));
  assert.equal((await f.read()).status, 404);
  assert.equal((await f.report(1, "complete")).status, 401);
});


test("Agent list and owner update preserve setup declaration and the selected Server installation", async ({ app }) => {
  const f = await fixture(app.baseUrl);
  const agent = await createAgent(f.target.id, "SetupReader", { runtime: "external", model: "external" });
  const sourceAgent = await createAgent(f.source.id, "SetupOwner", { runtime: "external", model: "external" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, f.source.id), eq(serverAgentMembers.agentId, sourceAgent.id)));
  const keyFor = async (id: string) => (await mintAgentCredential({ agentId: id, scopes: ["read"], name: "setup-test", issuedVia: "computer", createdByUserId: null })).apiKey;
  const sourceInstallResponse = await fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install`, { method: "POST", headers: f.sourceHeaders, body: await expectedAppPermissionsJson(f.client.id) });
  assert.equal(sourceInstallResponse.status, 200, await sourceInstallResponse.clone().text());
  const [sourceInstall] = await getDb().select().from(oauthClientInstalls).where(and(eq(oauthClientInstalls.clientId, f.client.id), eq(oauthClientInstalls.serverId, f.source.id)));
  assert.equal((await f.report(1, "complete", sourceInstall.id)).status, 200);
  const list = await fetch(`${app.baseUrl}/internal/agent-api/integrations`, { headers: { Authorization: `Bearer ${await keyFor(agent.id)}` } });
  assert.equal(list.status, 200);
  const rows = await list.json() as { services: Array<{ clientId: string; setup: { status: string; url: string } }> };
  const item = rows.services.find((row) => row.clientId === f.client.clientId)!;
  assert.equal(item.setup.status, "pending", "completion in publisher Server is not completion in target Server");
  assert.equal(new URL(item.setup.url).searchParams.get("installation_id"), f.installation.id);
  const ownerHeaders = { Authorization: `Bearer ${await keyFor(sourceAgent.id)}`, "Content-Type": "application/json" };
  const update = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, { method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ clientKey: f.client.clientId, setupUrl: "https://setup.example.test/agent-edited", setupDescription: "Connect your account" }) });
  assert.equal(update.status, 200, await update.clone().text());
  const status = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?client=${f.client.clientId}`, { headers: ownerHeaders });
  assert.equal(status.status, 200, await status.clone().text());
  const ownerState = await status.json() as { app: { setupUrl: string; setup: { status: string; revision: number } } };
  assert.equal(ownerState.app.setupUrl, "https://setup.example.test/agent-edited");
  assert.equal(ownerState.app.setup.status, "pending"); assert.equal(ownerState.app.setup.revision, 2);
});

test("installation cards disclose server-owned setup requirements and reject changed declarations", async ({ app }) => {
  const f = await fixture(app.baseUrl);
  await fetch(`${app.baseUrl}/api/integrations/marketplace/${f.client.id}/install`, { method: "DELETE", headers: f.headers });
  const agent = await createAgent(f.target.id, "SetupCardRequester", { runtime: "external", model: "external" });
  const channel = await createChannel(f.target.id, "setup-review", undefined, "channel");
  await addAgent(channel.id, agent.id); await addHuman(channel.id, f.owner.id);
  const prepare = () => prepareActionCard({ serverId: f.target.id, requesterAgentId: agent.id, targetChannelId: channel.id,
    action: { type: "integration:install_marketplace_app", clientId: f.client.id, clientKey: f.client.clientId,
      ...bindMarketplaceAppName(f.client.name), agentId: agent.id, agentName: agent.name, scopes: ["openid"],
      setupUrl: "https://attacker.example.test/not-canonical", setupRevision: 999 } });
  const card = await prepare();
  const action = card.metadata.action;
  assert.equal(action.type, "integration:install_marketplace_app");
  if (action.type !== "integration:install_marketplace_app") throw new Error("wrong card");
  assert.equal(action.setupUrl, f.client.setupUrl); assert.equal(action.setupRevision, 1);
  await fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}`, { method: "PATCH", headers: f.sourceHeaders, body: JSON.stringify({ setupUrl: "https://setup.example.test/revised" }) });
  await assert.rejects(executeActionCard({ webSessionFamilyId: null, messageId: card.messageId, serverId: asServerId(f.target.id), userId: f.owner.id }),
    (error: unknown) => error instanceof ActionCardError && error.code === "APP_SETUP_CHANGED");
  assert.equal((await f.read()).status, 404, "stale approval did not install the App");
  const fresh = await prepare();
  const receipt = await executeActionCard({ webSessionFamilyId: null, messageId: fresh.messageId, serverId: asServerId(f.target.id), userId: f.owner.id });
  const result = receipt.metadata.result;
  assert.equal(result?.kind, "marketplace-app-installation");
  if (result?.kind !== "marketplace-app-installation") throw new Error("wrong result");
  assert.ok(result.setupUrl);
  assert.equal(new URL(result.setupUrl).pathname, "/revised");
  assert.equal(new URL(result.setupUrl).searchParams.get("server_id"), f.target.id);
});

test("Agent registration approval carries setup declaration and rejects invalid setup input", async ({ app }) => {
  const f = await fixture(app.baseUrl);
  const agent = await createAgent(f.source.id, "SetupRegister", { runtime: "external", model: "external" });
  const channel = await createChannel(f.source.id, "setup-registration", undefined, "channel");
  await addAgent(channel.id, agent.id); await addHuman(channel.id, f.owner.id);
  const prepare = (setupUrl: string, setupDescription = "Select a repository") => prepareActionCard({
    serverId: f.source.id, requesterAgentId: agent.id, targetChannelId: channel.id,
    action: { type: "integration:register_app", name: "Registered setup", clientKey: "registered-setup", category: "Developer Tools",
      returnUrl: "https://registered.example.test/callback", scopes: ["openid"], setupUrl, setupDescription },
  });
  for (const url of ["http://registered.example.test/setup", "https://registered.example.test/setup#secret"]) {
    await assert.rejects(prepare(url), (error: unknown) => error instanceof ActionCardError && error.status === 400);
  }
  await assert.rejects(prepare("https://registered.example.test/setup", "two\nlines"), (error: unknown) => error instanceof ActionCardError && error.status === 400);
  const card = await prepare("https://registered.example.test/setup");
  await executeActionCard({ webSessionFamilyId: null, messageId: card.messageId, serverId: asServerId(f.source.id), userId: f.owner.id });
  const [registered] = await getDb().select().from(oauthClients).where(eq(oauthClients.clientId, "registered-setup"));
  assert.equal(registered.setupUrl, "https://registered.example.test/setup");
  assert.equal(registered.setupDescription, "Select a repository");
});

// Optional native PostgreSQL run: a disposable loopback database, all versioned
// migrations, real HTTP writes and concurrent completion. No production DSN.
nativeTest.skipIf(!process.env.APP_SETUP_TEST_DATABASE_URL)("native PG: migrated setup completion serializes replay and preserves declaration CAS", async () => {
  const root = new URL(process.env.APP_SETUP_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(root.hostname));
  const control = new pg.Client({ connectionString: root.toString() });
  await control.connect();
  const name = `app_setup_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
  let client: pg.Client | undefined;
  try {
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    root.pathname = `/${name}`;
    client = new pg.Client({ connectionString: root.toString() }); await client.connect();
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    app = await openTestApp(root.toString(), 0);
    const f = await fixture(app.baseUrl);
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.report(1, "complete")));
    assert.ok(responses.every(response => response.status === 200));
    const bodies = await Promise.all(responses.map(response => response.json()));
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    const audit = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "installation.setup_updated"));
    assert.equal(audit.length, 1);
    // Run the edit and an old completion concurrently. Whichever locks first,
    // the final declaration cannot inherit the old completion.
    const patch = fetch(`${app.baseUrl}/api/integrations/clients/${f.client.id}`, { method: "PATCH", headers: f.sourceHeaders, body: JSON.stringify({ setupUrl: "https://setup.example.test/new-config" }) });
    const [edited, oldReport] = await Promise.all([patch, f.report(1, "complete")]);
    assert.equal(edited.status, 200); assert.ok([200, 409].includes(oldReport.status));
    const state = await (await f.read()).json() as { status: string; revision: number };
    assert.equal(state.status, "pending"); assert.equal(state.revision, 2);
    assert.equal((await f.report(1, "complete")).status, 409);
    assert.equal((await f.report(2, "complete")).status, 200);
    await assert.rejects(client.query("UPDATE oauth_clients SET setup_revision=0 WHERE id=$1", [f.client.id]), /oauth_clients_setup_revision_positive/);
    await assert.rejects(client.query("UPDATE oauth_client_installs SET setup_completed_at=NULL WHERE id=$1", [f.installation.id]), /oauth_client_installs_setup_completion_valid/);
  } finally {
    try { await app?.close(); await client?.end(); }
    finally { try { if (created) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await control.end(); } }
  }
});
