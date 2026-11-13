import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import {
  agents,
  appBotBindings,
  integrationAuditEvents,
  notificationEvents,
  oauthClientInstalls,
  oauthClients,
  officialAppRegistry,
  officialAppAutoInstallStates,
  officialAppAutoInstallTransitions,
  servers,
  users,
} from "../db/schema";
import { getDb } from "../db/index";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import { PERMISSION_UPDATES_CHANGED_EVENT } from "@botiverse/raft-shared";
import { setListChangedRealtimeIO } from "./listChangedRealtime";
import {
  __setOfficialAppAutoInstallAttemptObserverForTests,
  __setBeforeOfficialAppAutoInstallWriteObserverForTests,
  autoInstallOfficialAppsForProvisionedServer,
  getOfficialAppInstallationProvenance,
  isApprovedOfficialAppClient,
  projectOfficialAppDiscovery,
  projectOfficialAppDiscoveryMany,
  reconcileOfficialDefaultAppForExistingServers,
} from "./officialAppAutoInstallService";
import { listMarketplaceOAuthClients } from "./oauthService";
import { expectedAppPermissionsJson } from "../test/integration/appPermissions";

const test = createApiTest();
const originalPublisherServerId = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
const originalExtraPublisherServerIds = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;

afterEach(() => {
  if (originalPublisherServerId === undefined) delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  else process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = originalPublisherServerId;
  if (originalExtraPublisherServerIds === undefined) delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  else process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = originalExtraPublisherServerIds;
  __setOfficialAppAutoInstallAttemptObserverForTests(null);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);
});

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@raft.test`,
    name: `${label}-${randomUUID()}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedPublishedApp(input: {
  sourceServerId: string;
  createdByUserId: string;
  clientKey?: string;
}) {
  const clientKey = input.clientKey ?? "raft-artifacts";
  const [client] = await getDb().insert(oauthClients).values({
    serverId: input.sourceServerId,
    createdByUserId: input.createdByUserId,
    clientId: clientKey,
    clientSecretHash: createHash("sha256").update(randomUUID()).digest("hex"),
    appType: "third_party_global",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    name: "Raft Artifacts",
    description: "Share durable artifacts",
  }).returning();
  return client;
}

async function seedRegistry(client: Awaited<ReturnType<typeof seedPublishedApp>>, input?: {
  autoInstall?: boolean;
  status?: "pending_review" | "approved" | "disabled";
  purpose?: string;
}) {
  const [entry] = await getDb().insert(officialAppRegistry).values({
    oauthClientId: client.id,
    clientKey: client.clientId,
    publisherServerId: client.serverId,
    autoInstall: input?.autoInstall ?? true,
    status: input?.status ?? "approved",
    purpose: input?.purpose ?? "Publish and retrieve durable Raft artifacts.",
  }).returning();
  return entry;
}

function humanHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("protected official trust root fails closed and third-party self-assertion cannot auto-install", async ({ app: _app }) => {
  const owner = await seedUser("official-fail-closed");
  const officialSource = await createServer("Official Source", `official-source-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: officialSource.id, createdByUserId: owner.id });
  await seedRegistry(client);
  const attemptedServerIds: string[] = [];
  __setOfficialAppAutoInstallAttemptObserverForTests((serverId) => attemptedServerIds.push(serverId));

  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  const missingTrustRootTarget = await createServer("Missing Root", `missing-root-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = randomUUID();
  const wrongTrustRootTarget = await createServer("Wrong Root", `wrong-root-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = "not-a-uuid";
  const invalidTrustRootTarget = await createServer("Invalid Root", `invalid-root-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = officialSource.id;
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(() => {
    process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = randomUUID();
  });
  const staleApprovalTarget = await createServer("Stale Approval", `stale-approval-${randomUUID()}`, owner.id);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = officialSource.id;
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(async (_serverId, tx) => {
    await tx.update(officialAppRegistry).set({ purpose: "Policy changed before install.", revision: 2 })
      .where(eq(officialAppRegistry.oauthClientId, client.id));
  });
  const staleRegistryTarget = await createServer("Stale Registry", `stale-registry-${randomUUID()}`, owner.id);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);

  const installs = await getDb().select({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.clientId, client.id),
    ));
  assert.deepEqual(installs.filter(({ serverId }) => [
    missingTrustRootTarget.id,
    wrongTrustRootTarget.id,
    invalidTrustRootTarget.id,
    staleApprovalTarget.id,
    staleRegistryTarget.id,
  ].includes(serverId)), []);
  assert.deepEqual(attemptedServerIds, [staleApprovalTarget.id, staleRegistryTarget.id]);
});

test("unreviewed registry entries fail closed", async ({ app: _app }) => {
  const owner = await seedUser("official-reviewed-default");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const unreviewed = await seedPublishedApp({
    sourceServerId: source.id,
    createdByUserId: owner.id,
    clientKey: "unreviewed-official",
  });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(unreviewed, { status: "pending_review" });
  let attempts = 0;
  __setOfficialAppAutoInstallAttemptObserverForTests(() => attempts += 1);

  const target = await createServer("Unreviewed Target", `unreviewed-target-${randomUUID()}`, owner.id);
  assert.equal(attempts, 0);
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, unreviewed.id),
  ))).length, 0);
});

test("Server provisioning auto-installs an official default with a unique system transition", async ({ app }) => {
  const owner = await seedUser("official-provision");
  const token = await tokenForHuman(owner.email);
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  const existingTarget = await createServer("Existing Target", `existing-target-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(async (serverId, tx) => {
    if (serverId === existingTarget.id) return;
    await tx.update(oauthClients).set({ outboundCurrentGroups: ["server"] })
      .where(eq(oauthClients.id, client.id));
  });

  const target = await createServer("Target", `official-target-${randomUUID()}`, owner.id);
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(null);
  const [install] = await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ));
  assert.ok(install);
  assert.equal(install.installedBySystem, true);
  assert.equal(install.installedByUserId, null);
  assert.equal(install.installedByAgentId, null);
  assert.deepEqual(install.approvedGroups, ["server"], "write-point permission projection must use the fresh app revision");

  const provenance = await getOfficialAppInstallationProvenance(target.id, client.id);
  assert.equal(provenance?.installationId, install.id);
  assert.equal(provenance?.transitionSource, "auto_install");
  assert.equal(provenance?.actorType, "system");
  assert.equal(provenance?.revision, 1);

  const marketplace = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: humanHeaders(token, target.id),
  });
  assert.equal(marketplace.status, 200);
  const listing = (await marketplace.json() as Array<{ id: string; official: boolean; purpose: string }>)
    .find((candidate) => candidate.id === client.id);
  assert.equal(listing?.official, true);
  assert.equal(listing?.purpose, "Publish and retrieve durable Raft artifacts.");

  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, existingTarget.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 1, "a product-approved default-set event installs on an existing Server");
  const transitions = await getDb().select().from(officialAppAutoInstallTransitions).where(and(
    eq(officialAppAutoInstallTransitions.serverId, target.id),
    eq(officialAppAutoInstallTransitions.clientId, client.id),
  ));
  assert.equal(transitions.length, 1, "duplicate default events must not create audit ambiguity");
});

test("an official App that ships a bot comes with it: provisioning adds the bot as the system; a taken handle leaves it undecided and still installs", async ({ app: _app }) => {
  const owner = await seedUser("official-bot");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id, clientKey: `official-bot-${randomUUID().slice(0, 8)}` });
  await getDb().update(oauthClients).set({ enableBot: true }).where(eq(oauthClients.id, client.id));
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);

  const target = await createServer("Bot Target", `official-bot-target-${randomUUID()}`, owner.id);
  const [install] = await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ));
  assert.ok(install);
  assert.equal(install.botGrant, "granted");
  const [binding] = await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install.id));
  assert.equal(binding?.state, "active");
  const [bot] = await getDb().select().from(agents).where(eq(agents.id, binding!.agentId));
  assert.equal(bot?.serverId, target.id);
  assert.equal(bot?.managedByAppInstallId, install.id);
  const audits = (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "installation.bot_grant_updated")))
    .filter((row) => (row.metadata as Record<string, unknown>).installationId === install.id);
  assert.deepEqual(audits.map((row) => ({ source: row.source, actorType: row.actorType, actorId: row.actorId })), [{ source: "system", actorType: "system", actorId: null }]);
  // installation.bot_changed is written in the auto-install's transaction, as the system.
  const botChanged = (installationId: string) => getDb().select({ subjectType: notificationEvents.subjectType, provenance: notificationEvents.provenance })
    .from(notificationEvents)
    .where(and(eq(notificationEvents.eventType, "installation.bot_changed"), eq(notificationEvents.subjectId, installationId)));
  assert.deepEqual(await botChanged(install.id), [{ subjectType: "installation", provenance: { source: "app_bot_service", actor_type: "system" } }]);

  // The handle is taken on an existing Server the default reaches later: the App installs, the bot waits for an admin.
  await getDb().update(officialAppRegistry).set({ autoInstall: false }).where(eq(officialAppRegistry.oauthClientId, client.id));
  const existing = await createServer("Taken Handle", `official-bot-taken-${randomUUID()}`, owner.id);
  assert.equal((await getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.serverId, existing.id))).length, 0);
  await getDb().insert(agents).values({ serverId: existing.id, name: bot!.name, displayName: "Someone Else", status: "active", runtime: "external" });
  await getDb().update(officialAppRegistry).set({ autoInstall: true }).where(eq(officialAppRegistry.oauthClientId, client.id));
  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });
  const [taken] = await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, existing.id),
    eq(oauthClientInstalls.clientId, client.id),
  ));
  assert.ok(taken, "the App is installed");
  assert.equal(taken.botGrant, null, "the grant rolled back with its savepoint");
  assert.deepEqual(await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, taken.id)), []);
  assert.deepEqual(await botChanged(taken.id), [], "and its installation.bot_changed with it");
});

test("explicit uninstall is sticky across rename and default reconciliation; user install alone clears it", async ({ app }) => {
  const owner = await seedUser("official-cycle");
  const token: string = await tokenForHuman(owner.email);
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  const target = await createServer("Cycle Target", `cycle-target-${randomUUID()}`, owner.id);

  const uninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: humanHeaders(token, target.id),
  });
  assert.equal(uninstall.status, 200);
  await getDb().update(oauthClients).set({ name: "Raft Artifacts Renamed", updatedAt: new Date() })
    .where(eq(oauthClients.id, client.id));
  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);

  const [suppressed] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(suppressed?.state, "auto_suppressed");

  const reinstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "POST",
    headers: humanHeaders(token, target.id),
    body: await expectedAppPermissionsJson(client.id),
  });
  assert.equal(reinstall.status, 200);
  const [restored] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(restored?.state, "default_auto");
  const sources = (await getDb().select({ source: officialAppAutoInstallTransitions.transitionSource })
    .from(officialAppAutoInstallTransitions).where(and(
      eq(officialAppAutoInstallTransitions.serverId, target.id),
      eq(officialAppAutoInstallTransitions.clientId, client.id),
    ))).map(({ source }) => source);
  assert.deepEqual(sources, ["auto_install", "user_uninstall", "user_install"]);

  const secondUninstall = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: humanHeaders(token, target.id),
  });
  assert.equal(secondUninstall.status, 200);
  const [suppressedAgain] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(suppressedAgain?.state, "auto_suppressed");
});

test("migration reconciliation suppresses unknown absent rows and never resurrects them", async ({ app: _app }) => {
  const owner = await seedUser("official-migration");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const target = await createServer("Historical Target", `historical-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);

  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "suppress_unknown" });
  const [state] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(state?.state, "auto_suppressed");
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);
});

test("agent lifecycle remains read-only and makes zero official install attempts", async ({ app: _app }) => {
  const owner = await seedUser("official-agent-event");
  const server = await createServer("Agent Event", `agent-event-${randomUUID()}`, owner.id);
  let attempts = 0;
  __setOfficialAppAutoInstallAttemptObserverForTests(() => attempts += 1);
  await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`);
  assert.equal(attempts, 0);
});

test("default reconciliation excludes exact internal Server kinds before any install attempt", async ({ app: _app }) => {
  const owner = await seedUser("official-internal-exclusion");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const internal = await createServer("Internal Storage", `internal-storage-${randomUUID()}`, owner.id);
  await getDb().update(servers).set({ kind: "joint_storage" }).where(eq(servers.id, internal.id));
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);

  const attemptedServerIds: string[] = [];
  __setOfficialAppAutoInstallAttemptObserverForTests((serverId) => attemptedServerIds.push(serverId));
  await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });

  assert.equal(attemptedServerIds.includes(internal.id), false);
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, internal.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);
});

test("concurrent auto-install and explicit uninstall serialize to suppression with no half-install", async ({ app }) => {
  const owner = await seedUser("official-race");
  const token = await tokenForHuman(owner.email);
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  const target = await createServer("Race Target", `race-target-${randomUUID()}`, owner.id);

  // Preserve default-auto state while making the installation absent, so the
  // automatic path reaches its write point and races the explicit opt-out.
  await getDb().delete(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ));
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const atWrite = new Promise<void>((resolve) => { announceWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseWrite = resolve; });
  __setBeforeOfficialAppAutoInstallWriteObserverForTests(async (serverId) => {
    if (serverId !== target.id) return;
    announceWrite();
    await release;
  });

  const automatic = reconcileOfficialDefaultAppForExistingServers({
    clientKey: client.clientId,
    unknownState: "default_auto",
  });
  await atWrite;
  const explicitUninstall = fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: humanHeaders(token, target.id),
  });
  releaseWrite();
  const [, uninstallResponse] = await Promise.all([automatic, explicitUninstall]);
  assert.equal(uninstallResponse.status, 200);

  const [state] = await getDb().select().from(officialAppAutoInstallStates).where(and(
    eq(officialAppAutoInstallStates.serverId, target.id),
    eq(officialAppAutoInstallStates.clientId, client.id),
  ));
  assert.equal(state?.state, "auto_suppressed");
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, client.id),
  ))).length, 0);
});

test("marketplace official-app discovery reads the registry once for the whole list, with the single-app answers", async ({ app: _app }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const owner = await seedUser("official-discovery-batch");
  const source = await createServer("Official Discovery", `official-discovery-${randomUUID()}`, owner.id);
  const thirdParty = await createServer("Third Party", `third-party-${randomUUID()}`, owner.id);
  const viewer = await createServer("Viewer", `viewer-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  const approved = await Promise.all(["one", "two", "three"].map(async (key) => {
    const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id, clientKey: `official-${key}-${randomUUID().slice(0, 6)}` });
    await seedRegistry(client, { purpose: `Purpose ${key}` });
    return client;
  }));
  const pending = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id, clientKey: `official-pending-${randomUUID().slice(0, 6)}` });
  await seedRegistry(pending, { status: "pending_review" });
  const unregistered = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id, clientKey: `official-none-${randomUUID().slice(0, 6)}` });
  const selfAsserted = await seedPublishedApp({ sourceServerId: thirdParty.id, createdByUserId: owner.id, clientKey: `third-party-${randomUUID().slice(0, 6)}` });
  await seedRegistry(selfAsserted);
  const all = [...approved, pending, unregistered, selfAsserted];

  const inputs = all.map((client) => ({ clientId: client.id, sourceServerId: client.serverId, clientKey: client.clientId }));
  const batch = await projectOfficialAppDiscoveryMany(inputs);
  for (const input of inputs) assert.deepEqual(batch.get(input.clientId), await projectOfficialAppDiscovery(input), input.clientKey);
  assert.deepEqual(approved.map((client) => batch.get(client.id)?.official), [true, true, true]);
  assert.deepEqual([pending, unregistered, selfAsserted].map((client) => batch.get(client.id)?.official), [false, false, false]);

  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let registryReads = 0;
  pg.query = ((...args: unknown[]) => {
    if (typeof args[0] === "string" && /from "official_app_registry"/.test(args[0])) registryReads += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  let listed: Awaited<ReturnType<typeof listMarketplaceOAuthClients>>;
  try {
    listed = await listMarketplaceOAuthClients(viewer.id);
  } finally {
    pg.query = originalQuery;
  }
  assert.ok(listed.filter((client) => all.some((seeded) => seeded.id === client.id)).length >= 5);
  assert.equal(registryReads, 1, "one registry read for the whole marketplace list");
});

// RAFT_OFFICIAL_PUBLISHER_SERVER_IDS (#raft-botiverse:64bb75ea): more official
// publishers beside the primary root. Official = the publisher is on the
// allow-list AND the approved registry row is published from the App's own
// Server. Auto-install still follows only RAFT_OFFICIAL_PUBLISHER_SERVER_ID.

async function officialStatus(client: { id: string; serverId: string; clientId: string }) {
  const discovery = await projectOfficialAppDiscovery({ clientId: client.id, sourceServerId: client.serverId, clientKey: client.clientId });
  return { approved: await isApprovedOfficialAppClient(client.id), ...discovery };
}

test("an App published from a Server outside the official publisher allow-list is not official, even with an approved row", async ({ app: _app }) => {
  const owner = await seedUser("official-allow-list-outside");
  const primary = await createServer("Raft", `raft-${randomUUID()}`, owner.id);
  const extra = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const outside = await createServer("Outside", `outside-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: outside.id, createdByUserId: owner.id, clientKey: "outside-app" });
  await seedRegistry(client, { autoInstall: false, purpose: "Not an official publisher." });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = primary.id;
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = extra.id;

  assert.deepEqual(await officialStatus(client), { approved: false, official: false, purpose: "" });
  const forShare = await getDb().transaction((tx) => isApprovedOfficialAppClient(client.id, tx, { forShare: true }));
  assert.equal(forShare, false);
});

test("an App on an extra official publisher Server with an approved row from that Server is official", async ({ app: _app }) => {
  const owner = await seedUser("official-allow-list-extra");
  const primary = await createServer("Raft", `raft-${randomUUID()}`, owner.id);
  const extra = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const otherExtra = await createServer("Other", `other-${randomUUID()}`, owner.id);
  const stamp = await seedPublishedApp({ sourceServerId: extra.id, createdByUserId: owner.id, clientKey: "stamp-like" });
  await seedRegistry(stamp, { autoInstall: false, purpose: "PR approval cards." });
  const pending = await seedPublishedApp({ sourceServerId: extra.id, createdByUserId: owner.id, clientKey: "pending-extra" });
  await seedRegistry(pending, { autoInstall: false, status: "pending_review" });
  const primaryApp = await seedPublishedApp({ sourceServerId: primary.id, createdByUserId: owner.id, clientKey: "primary-app" });
  await seedRegistry(primaryApp, { autoInstall: false, purpose: "Primary root app." });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = primary.id;
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = ` ${otherExtra.id} , ${extra.id},${extra.id} `;

  assert.deepEqual(await officialStatus(stamp), { approved: true, official: true, purpose: "PR approval cards." });
  assert.deepEqual(await officialStatus(primaryApp), { approved: true, official: true, purpose: "Primary root app." }, "the primary root stays official");
  assert.deepEqual(await officialStatus(pending), { approved: false, official: false, purpose: "" }, "only approved rows count");
  const forShare = await getDb().transaction((tx) => isApprovedOfficialAppClient(stamp.id, tx, { forShare: true }));
  assert.equal(forShare, true);

  // The allow-list is the primary (if valid) plus the extra list (if valid).
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  assert.equal((await officialStatus(stamp)).official, true);
  assert.equal((await officialStatus(primaryApp)).official, false);
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = primary.id;
  assert.deepEqual(await officialStatus(stamp), { approved: false, official: false, purpose: "" }, "unset: no extra publisher");
});

test("an allow-listed App whose registry row names another publisher Server is not official", async ({ app: _app }) => {
  const owner = await seedUser("official-allow-list-mismatch");
  const primary = await createServer("Raft", `raft-${randomUUID()}`, owner.id);
  const extra = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: extra.id, createdByUserId: owner.id, clientKey: "mismatched-app" });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = primary.id;
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = extra.id;

  // The registry's identity FK already refuses this row; drop it inside a
  // rolled-back transaction so the check itself is what is exercised.
  class Rollback extends Error {}
  let observed: unknown;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE official_app_registry DROP CONSTRAINT official_app_registry_client_identity_fk`);
    await tx.insert(officialAppRegistry).values({
      oauthClientId: client.id,
      clientKey: client.clientId,
      publisherServerId: primary.id,
      autoInstall: false,
      status: "approved",
      purpose: "Claims the primary root.",
    });
    observed = {
      approved: await isApprovedOfficialAppClient(client.id, tx),
      approvedForShare: await isApprovedOfficialAppClient(client.id, tx, { forShare: true }),
      discovery: (await projectOfficialAppDiscoveryMany([{ clientId: client.id, sourceServerId: client.serverId, clientKey: client.clientId }], tx)).get(client.id),
    };
    throw new Rollback();
  }).catch((error) => {
    if (!(error instanceof Rollback)) throw error;
  });
  assert.deepEqual(observed, { approved: false, approvedForShare: false, discovery: { official: false, purpose: "" } });
});

test("auto-install follows only the primary root: an extra-publisher official default is never installed", async ({ app: _app }) => {
  const owner = await seedUser("official-allow-list-auto-install");
  const primary = await createServer("Raft", `raft-${randomUUID()}`, owner.id);
  const extra = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const existing = await createServer("Existing", `existing-${randomUUID()}`, owner.id);
  const primaryDefault = await seedPublishedApp({ sourceServerId: primary.id, createdByUserId: owner.id, clientKey: "primary-default" });
  await seedRegistry(primaryDefault, { autoInstall: true });
  const extraDefault = await seedPublishedApp({ sourceServerId: extra.id, createdByUserId: owner.id, clientKey: "extra-default" });
  await seedRegistry(extraDefault, { autoInstall: true });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = primary.id;
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = extra.id;
  assert.equal(await isApprovedOfficialAppClient(extraDefault.id), true, "the extra-publisher App is official");

  const target = await createServer("Target", `target-${randomUUID()}`, owner.id);
  const installedOn = async (serverId: string) => (await getDb().select({ clientId: oauthClientInstalls.clientId })
    .from(oauthClientInstalls).where(eq(oauthClientInstalls.serverId, serverId)))
    .map(({ clientId }) => clientId)
    .filter((clientId) => clientId === primaryDefault.id || clientId === extraDefault.id);
  assert.deepEqual(await installedOn(target.id), [primaryDefault.id]);

  const reconciled = await reconcileOfficialDefaultAppForExistingServers({ clientKey: extraDefault.clientId, unknownState: "default_auto" });
  assert.ok(reconciled.length > 0 && reconciled.every((result) => result.status === "not_configured"));
  assert.deepEqual(await installedOn(existing.id), []);
  assert.equal((await getDb().select().from(officialAppAutoInstallStates)
    .where(eq(officialAppAutoInstallStates.clientId, extraDefault.id))).length, 0);
});

test("one invalid item makes the extra publisher list add nothing, warning once per value", async ({ app: _app }) => {
  const owner = await seedUser("official-allow-list-invalid");
  const primary = await createServer("Raft", `raft-${randomUUID()}`, owner.id);
  const extra = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const extraApp = await seedPublishedApp({ sourceServerId: extra.id, createdByUserId: owner.id, clientKey: "extra-app" });
  await seedRegistry(extraApp, { autoInstall: false });
  const primaryApp = await seedPublishedApp({ sourceServerId: primary.id, createdByUserId: owner.id, clientKey: "primary-app" });
  await seedRegistry(primaryApp, { autoInstall: false });
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = primary.id;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const allowListWarnings = () => warn.mock.calls.filter(([message]) => typeof message === "string"
    && message.includes("RAFT_OFFICIAL_PUBLISHER_SERVER_IDS")).length;
  try {
    process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = `${extra.id},not-a-uuid`;
    assert.equal((await officialStatus(extraApp)).official, false);
    assert.equal((await officialStatus(extraApp)).approved, false);
    assert.equal((await officialStatus(primaryApp)).official, true, "the primary root still counts");
    assert.equal(allowListWarnings(), 1, "one warning for the value, not one per call");

    process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = `${extra.id},`;
    assert.equal((await officialStatus(extraApp)).official, false, "an empty item is invalid");
    assert.equal(allowListWarnings(), 2, "a changed value warns again");

    process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = extra.id;
    assert.equal((await officialStatus(extraApp)).official, true);
    delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
    assert.equal((await officialStatus(extraApp)).official, false);
    assert.equal(allowListWarnings(), 2, "valid and unset values do not warn");
  } finally {
    warn.mockRestore();
  }
});

test("permission-updates:changed: an official App's auto-install pings the server it lands on once it commits; a rolled-back one pings nothing", async ({ app }) => {
  const owner = await seedUser("official-ping");
  const source = await createServer("Botiverse", `botiverse-${randomUUID()}`, owner.id);
  const client = await seedPublishedApp({ sourceServerId: source.id, createdByUserId: owner.id });
  const existing = await createServer("Existing", `official-ping-existing-${randomUUID()}`, owner.id);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  await seedRegistry(client);
  const frames: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => {
    if (event === PERMISSION_UPDATES_CHANGED_EVENT) frames.push(`${room} ${JSON.stringify(payload)}`);
    return true;
  } }) } as never);
  const ping = (serverId: string) => `server:${serverId} ${JSON.stringify({ serverId })}`;
  try {
    await assert.rejects(getDb().transaction(async (tx) => {
      const [result] = await autoInstallOfficialAppsForProvisionedServer(existing.id, tx as never);
      assert.equal(result?.status, "installed");
      assert.deepEqual(frames, [], "nothing while the transaction is open");
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(frames.splice(0), [], "a rolled-back auto-install pings nothing");

    const target = await createServer("Target", `official-ping-target-${randomUUID()}`, owner.id);
    assert.deepEqual(frames.splice(0), [ping(target.id)], "provisioning installs it: that server, once");

    await reconcileOfficialDefaultAppForExistingServers({ clientKey: client.clientId, unknownState: "default_auto" });
    assert.ok(frames.includes(ping(existing.id)), "the existing-server rollout pings each server it installs on");
    assert.ok(!frames.includes(ping(target.id)), "already installed there: no ping");
  } finally {
    setListChangedRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});
