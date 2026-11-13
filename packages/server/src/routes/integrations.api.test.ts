import { vi } from "vitest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

import { and, eq, inArray } from "drizzle-orm";

import {
  agentCredentials,
  agents,
  appBotBindings,
  externalAppRegistrations,
  integrationAuditEvents,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthAppPermissionRevisions,
  oauthAppWebhookConfigs,
  oauthClientInstalls,
  oauthClientShareLinks,
  oauthClients,
  oauthGrants,
  serverAgentMembers,
  users,
} from "../db/schema";
import { getDb } from "../db/index";
import { expectedAppPermissionsBody, expectedAppPermissionsJson } from "../test/integration/appPermissions";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness";
import { installRecordingLogoStorage } from "../test/recordingLogoStorage";
import { approvePermissionReview, decidePublishReview, reviewRefusalCode } from "../test/marketplaceReviewFixture";
import { addMember, createServer } from "../services/serverService";
import * as oauthService from "../services/oauthService";
import {
  __resetOAuthServiceDbForTests,
  __setOAuthServiceDbForTests,
  authenticateOAuthClient,
  createOAuthClient,
  exchangeAccessRequest,
  getOAuthClientForServer,
  getIdentityByAccessToken,
  listAgentAvailableOAuthClients,
  listInstalledAppPromptCatalog,
  resolveOAuthClientForAgentMutation,
  rotateClientSecretForAgent,
  transferClientOwnershipForAgent,
  updateOAuthClientForAgent,
} from "../services/oauthService";
import * as agentService from "../services/agentService";
import { createAgent } from "../services/agentService";
import {
  __setAppWebhookEncryptionKeyForTests,
  configureAppWebhook,
} from "../services/appWebhookConfigService";
import {
  createAppOutboundPermissionRevision,
  updateAppInstallationGrant,
  updateAppInstallationSubscriptions,
} from "../services/appOutboundPermissionService";
import {
  getAppNotificationDeveloperState,
  getAppNotificationInstallationState,
} from "../services/appNotificationManagementService";
import {
  __setCdnStorageForTests,
  resetStorageForTests,
} from "../services/storageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const ONE_BY_ONE_GIF = Buffer.from(
  "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({
      email,
      name,
      displayName: name,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();
  return user;
}

async function seedRetiredBuiltInOAuthClient(input: {
  serverId: string;
  createdByUserId: string;
  clientId: string;
  name: string;
  description?: string | null;
  homepageUrl?: string | null;
  returnUrl?: string | null;
}) {
  const clientSecret = `retired_secret_${randomUUID()}`;
  const [client] = await getDb().insert(oauthClients).values({
    serverId: input.serverId,
    createdByUserId: input.createdByUserId,
    clientId: input.clientId,
    clientSecretHash: createHash("sha256").update(clientSecret).digest("hex"),
    clientSecret,
    appType: "slock_builtin",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    name: input.name,
    description: input.description ?? null,
    homepageUrl: input.homepageUrl ?? null,
    returnUrl: input.returnUrl ?? null,
  }).returning();
  return { client, clientSecret };
}

/** Seed a server-local OAuth client with a KNOWN secret — client credentials
 * are what the bot-status and bot-token routes authenticate (createOAuthClient
 * never returns its raw secret). */
async function seedOAuthClientWithSecret(input: {
  serverId: string;
  createdByUserId: string;
  clientId: string;
  name: string;
  description?: string | null;
  enableBot?: boolean;
}) {
  const clientSecret = `test_secret_${randomUUID()}`;
  const [client] = await getDb().insert(oauthClients).values({
    serverId: input.serverId,
    createdByUserId: input.createdByUserId,
    clientId: input.clientId,
    clientSecretHash: createHash("sha256").update(clientSecret).digest("hex"),
    clientSecret: null,
    name: input.name,
    description: input.description ?? null,
    appType: "server_local",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    enableBot: input.enableBot ?? false,
  }).returning();
  return { client, clientSecret };
}

function clientBasicAuth(clientId: string, secret: string) {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

test("new slock_builtin registration fails before persistence or audit", async ({ app: _app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`retired-create-${suffix}@slock.test`, `Retired Create ${suffix}`);
  const server = await createServer("Retired Create", `retired-create-${suffix}`, owner.id);
  const clientId = `retired-${suffix.slice(0, 8)}`;
  const beforeAudits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents);

  await assert.rejects(
    createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId,
      appType: "slock_builtin",
      name: "Retired App",
    }),
    /slock_builtin OAuth clients are retired/,
  );

  const created = await getDb().select({ id: oauthClients.id }).from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  const afterAudits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents);
  assert.deepEqual(created, []);
  assert.equal(afterAudits.length, beforeAudits.length);
});



test("marketplace install badge counts only active non-source installations and hides unpublished apps", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`marketplace-badge-${suffix}@slock.test`, `Marketplace Badge ${suffix}`);
  const sourceServer = await createServer("Marketplace Badge Source", `marketplace-badge-source-${suffix}`, owner.id);
  const installServers: Awaited<ReturnType<typeof createServer>>[] = [];
  for (let index = 0; index < 10; index += 1) {
    installServers.push(await createServer(
      `Marketplace Badge Install ${index}`,
      `marketplace-badge-install-${index}-${suffix}`,
      owner.id,
    ));
  }
  const { client } = await createOAuthClient({
    serverId: sourceServer.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `badge-${suffix.slice(0, 8)}`,
    name: "Badge Boundary App",
    description: "Exercises Marketplace install badge exclusions.",
    homepageUrl: "https://badge.example.test",
    returnUrl: "https://badge.example.test/callback",
  });
  await getDb().update(oauthClients).set({
    publishStatus: "published",
    humanMarketplaceVisible: true,
    publishReviewedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
  }).where(eq(oauthClients.id, client.id));

  await getDb().insert(oauthClientInstalls).values([
    {
      serverId: sourceServer.id,
      clientId: client.id,
      installedByUserId: owner.id,
      status: "active",
    },
    ...installServers.slice(0, 9).map((server) => ({
      serverId: server.id,
      clientId: client.id,
      installedByUserId: owner.id,
      status: "active" as const,
    })),
    {
      serverId: installServers[9]!.id,
      clientId: client.id,
      installedByUserId: owner.id,
      status: "suspended",
    },
  ]);

  const token = await tokenForHuman(owner.email);
  const readListing = async () => {
    const response = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": installServers[0]!.id,
      },
    });
    assert.equal(response.status, 200);
    const listings = await response.json() as Array<{
      id: string;
      privateShared: boolean;
      marketplaceInstallBadge: { kind: string; bucket?: string };
    }>;
    const listing = listings.find((item) => item.id === client.id);
    assert.ok(listing);
    return listing;
  };

  assert.deepEqual((await readListing()).marketplaceInstallBadge, { kind: "none" }, "source and suspended installs must not reach 10+");

  await getDb().update(oauthClientInstalls).set({ status: "active" }).where(and(
    eq(oauthClientInstalls.clientId, client.id),
    eq(oauthClientInstalls.serverId, installServers[9]!.id),
  ));
  assert.deepEqual((await readListing()).marketplaceInstallBadge, { kind: "bucket", bucket: "10_plus" });

  await getDb().update(oauthClients).set({
    publishStatus: "private",
    humanMarketplaceVisible: false,
  }).where(eq(oauthClients.id, client.id));
  const privateListing = await readListing();
  assert.equal(privateListing.privateShared, true);
  assert.deepEqual(privateListing.marketplaceInstallBadge, { kind: "none" });
});

test("POST and DELETE /api/integrations/clients/:clientId/logo manage registered app logos", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-logo-owner-${suffix}@slock.test`, `integrations-logo-owner-${suffix}`);
  const member = await seedUser(`integrations-logo-member-${suffix}@slock.test`, `integrations-logo-member-${suffix}`);
  const otherOwner = await seedUser(`integrations-logo-other-${suffix}@slock.test`, `integrations-logo-other-${suffix}`);
  const server = await createServer("Integrations Logo", `integrations-logo-${suffix}`, owner.id);
  const otherServer = await createServer("Integrations Logo Other", `integrations-logo-other-${suffix}`, otherOwner.id);
  await addMember(server.id, member.id, "member");
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `logo-${suffix.slice(0, 8)}`,
    name: "Logo App",
    description: "Logo upload",
    homepageUrl: "https://logo.example.test",
    returnUrl: "https://logo.example.test/callback",
  });
  const { client: builtInClient } = await seedRetiredBuiltInOAuthClient({
    serverId: otherServer.id,
    createdByUserId: otherOwner.id,
    clientId: `logo-bi-${suffix.slice(0, 8)}`,
    name: "Built-in Logo",
    description: "Built-in",
    homepageUrl: "https://builtin-logo.example.test",
    returnUrl: "https://builtin-logo.example.test/callback",
  });

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const otherOwnerToken = await tokenForHuman(otherOwner.email);
  const uploadLogo = (token: string, serverId: string, clientId: string) => {
    const formData = new FormData();
    formData.set("logo", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "logo.gif");
    return fetch(`${app.baseUrl}/api/integrations/clients/${clientId}/logo`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": serverId,
      },
      body: formData,
    });
  };

  const memberRes = await uploadLogo(memberToken, server.id, client.id);
  assert.equal(memberRes.status, 403);

  const wrongServerRes = await uploadLogo(otherOwnerToken, otherServer.id, client.id);
  assert.equal(wrongServerRes.status, 404);

  const builtInRes = await uploadLogo(otherOwnerToken, otherServer.id, builtInClient.id);
  assert.equal(builtInRes.status, 404);

  const ownerRes = await uploadLogo(ownerToken, server.id, client.id);
  assert.equal(ownerRes.status, 200);
  const uploaded = await ownerRes.json() as { id: string; logoUrl: string | null; logoStorageKey?: string | null };
  assert.equal(uploaded.id, client.id);
  assert.match(uploaded.logoUrl ?? "", new RegExp(`^/api/integration-logos/${client.id}/[0-9a-f]{32}\\.webp$`));
  assert.equal(uploaded.logoStorageKey, undefined);

  const listRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(listRes.status, 200);
  const listedClients = await listRes.json() as Array<{ id: string; logoUrl: string | null; logoStorageKey?: string | null }>;
  const listed = listedClients.find((item) => item.id === client.id);
  assert.ok(listed);
  assert.equal(listed.logoUrl, uploaded.logoUrl);
  assert.equal(listed.logoStorageKey, undefined);

  const logoRes = await fetch(`${app.baseUrl}${uploaded.logoUrl}`);
  assert.equal(logoRes.status, 200);
  assert.equal(logoRes.headers.get("content-type"), "image/webp");

  const clearRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/logo`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(clearRes.status, 200);
  const cleared = await clearRes.json() as { logoUrl: string | null; logoStorageKey?: string | null };
  assert.equal(cleared.logoUrl, null);
  assert.equal(cleared.logoStorageKey, undefined);
});

test("GET /api/integration-logos releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  const harness = await createHangingStorageTestHarness();
  try {
    const suffix = randomUUID();
    const owner = await seedUser(`integration-logo-abort-${suffix}@slock.test`, `integration-logo-abort-${suffix}`);
    const server = await createServer("Integration Logo Abort", `integration-logo-abort-${suffix}`, owner.id);
    const { client } = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `logo-abort-${suffix.slice(0, 8)}`,
      name: "Logo Abort App",
      description: "Exercises destination abort cleanup.",
      homepageUrl: "https://logo-abort.example.test",
      returnUrl: "https://logo-abort.example.test/callback",
    });
    const contentHash = "0123456789abcdef0123456789abcdef";
    await getDb().update(oauthClients).set({
      logoStorageKey: `integration-logos/${client.id}/${contentHash}.webp`,
    }).where(eq(oauthClients.id, client.id));
    __setCdnStorageForTests(harness.storage);

    await harness.abortDownload(
      `${app.baseUrl}/api/integration-logos/${client.id}/${contentHash}.webp`,
      undefined,
      (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/webp");
        assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
      },
    );
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});

test("App Notifications management exposes truthful state without replaying secrets", async ({ app }) => {
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));
  try {
    const suffix = randomUUID();
    const developer = await seedUser(`app-notifications-developer-${suffix}@slock.test`, `app-notifications-developer-${suffix}`);
    const developerMember = await seedUser(`app-notifications-member-${suffix}@slock.test`, `app-notifications-member-${suffix}`);
    const installer = await seedUser(`app-notifications-installer-${suffix}@slock.test`, `app-notifications-installer-${suffix}`);
    const developerServer = await createServer("App Notifications Developer", `app-notifications-developer-${suffix}`, developer.id);
    const installServer = await createServer("App Notifications Install", `app-notifications-install-${suffix}`, installer.id);
    await addMember(developerServer.id, developerMember.id, "member");
    const { client, clientSecret } = await createOAuthClient({
      serverId: developerServer.id,
      createdByUserId: developer.id,
      appType: "third_party_global",
      clientId: `notifications-${suffix.slice(0, 8)}`,
      name: "Notifications App",
      description: "Receives bounded Raft events",
      homepageUrl: "https://notifications.example.test",
      returnUrl: "https://notifications.example.test/callback",
    });
    await getDb().update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.id));

    const developerToken = await tokenForHuman(developer.email);
    const memberToken = await tokenForHuman(developerMember.email);
    const installerToken = await tokenForHuman(installer.email);
    const headers = (token: string, serverId: string) => ({
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverId,
      "Content-Type": "application/json",
    });

    const permissionRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`, {
      method: "PUT",
      headers: headers(developerToken, developerServer.id),
      body: JSON.stringify({ groups: ["server"], events: ["server.plan_changed"] }),
    });
    assert.equal(permissionRes.status, 200);

    const webhookRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/webhook`, {
      method: "PUT",
      headers: headers(developerToken, developerServer.id),
      body: JSON.stringify({ endpointUrl: "https://events.example.test/raft" }),
    });
    assert.equal(webhookRes.status, 200);
    const configured = await webhookRes.json() as { signing_secret: string };
    assert.match(configured.signing_secret, /^raft_webhook_secret_/);

    const memberRead = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications`, {
      headers: headers(memberToken, developerServer.id),
    });
    assert.equal(memberRead.status, 403);

    const developerRead = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications`, {
      headers: headers(developerToken, developerServer.id),
    });
    assert.equal(developerRead.status, 200);
    const developerState = await developerRead.json() as {
      current_groups: string[];
      current_events: string[];
      pending_revision: { groups: string[]; events: string[] } | null;
      webhook: { endpoint_url: string; enabled: boolean; signing_secret?: string };
    };
    assert.deepEqual(developerState.current_groups, []);
    assert.deepEqual(developerState.current_events, []);
    assert.deepEqual(developerState.pending_revision?.groups, ["server"]);
    assert.deepEqual(developerState.pending_revision?.events, ["server.plan_changed"]);
    assert.equal(developerState.webhook.endpoint_url, "https://events.example.test/raft");
    assert.equal(developerState.webhook.enabled, true);
    assert.equal("signing_secret" in developerState.webhook, false);
    assert.equal(JSON.stringify(developerState).includes(configured.signing_secret), false);

    const approved = await approvePermissionReview({
      clientId: client.id,
      reviewerUserId: developer.id,
    });
    assert.ok(approved);

    const marketplaceRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: headers(installerToken, installServer.id),
    });
    assert.equal(marketplaceRes.status, 200);
    const marketplace = await marketplaceRes.json() as Array<{
      id: string;
      appNotificationGroups: string[];
      appNotificationEvents: string[];
      appNotificationReviewPending: boolean;
    }>;
    const listing = marketplace.find((item) => item.id === client.id);
    assert.ok(listing);
    assert.deepEqual(listing.appNotificationGroups, ["server"]);
    assert.deepEqual(listing.appNotificationEvents, ["server.plan_changed"]);
    assert.equal(listing.appNotificationReviewPending, false);

    const installRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "POST",
      headers: headers(installerToken, installServer.id),
      body: await expectedAppPermissionsJson(client.id),
    });
    assert.equal(installRes.status, 200);
    const [installation] = await getDb().select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, installServer.id),
        eq(oauthClientInstalls.clientId, client.id),
        eq(oauthClientInstalls.status, "active"),
      ))
      .limit(1);
    assert.ok(installation);

    const mintGroups = (groups: string[]) => fetch(`${app.baseUrl}/api/oauth/installation-token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ installation_id: installation.id, groups }),
    });
    const installStateUrl = `${app.baseUrl}/api/integrations/marketplace/${client.id}/install/app-notifications`;
    const defaultInstallRead = await fetch(installStateUrl, { headers: headers(installerToken, installServer.id) });
    assert.equal(defaultInstallRead.status, 200);
    const defaultInstallState = await defaultInstallRead.json() as {
      approved_groups: string[];
      requested_events: string[];
      subscribed_events: string[];
      effective_events: string[];
      approval_required: boolean;
    };
    assert.deepEqual(defaultInstallState.approved_groups, ["server"]);
    assert.deepEqual(defaultInstallState.requested_events, ["server.plan_changed"]);
    assert.deepEqual(defaultInstallState.subscribed_events, []);
    assert.deepEqual(defaultInstallState.effective_events, []);
    assert.equal(defaultInstallState.approval_required, false);

    const ownerSubscriptionAttempt = await fetch(`${installStateUrl}/subscriptions`, {
      method: "PUT",
      headers: headers(installerToken, installServer.id),
      body: JSON.stringify({ events: ["server.plan_changed"] }),
    });
    assert.equal(ownerSubscriptionAttempt.status, 404);

    const updateSubscriptions = (events: string[]) => fetch(
      `${app.baseUrl}/api/oauth/installations/${installation.id}/subscriptions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
      },
    );
    const subscriptionRes = await updateSubscriptions(["server.plan_changed"]);
    assert.equal(subscriptionRes.status, 200);

    const eventExpansionRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`, {
      method: "PUT",
      headers: headers(developerToken, developerServer.id),
      body: JSON.stringify({
        groups: ["server"],
        events: ["server.plan_changed", "server.config_updated"],
      }),
    });
    assert.equal(eventExpansionRes.status, 200);
    assert.ok(await approvePermissionReview({ clientId: client.id, reviewerUserId: developer.id }));

    const effectiveRead = await fetch(installStateUrl, { headers: headers(installerToken, installServer.id) });
    assert.equal(effectiveRead.status, 200);
    const effectiveState = await effectiveRead.json() as {
      approved_groups: string[];
      requested_events: string[];
      subscribed_events: string[];
      effective_events: string[];
      approval_required: boolean;
    };
    assert.deepEqual(effectiveState.approved_groups, ["server"]);
    assert.deepEqual(effectiveState.requested_events, ["server.config_updated", "server.plan_changed"]);
    assert.deepEqual(effectiveState.subscribed_events, ["server.plan_changed"]);
    assert.deepEqual(effectiveState.effective_events, ["server.plan_changed"]);
    assert.equal(effectiveState.approval_required, false);

    const eventSubscriptionRes = await updateSubscriptions(["server.config_updated", "server.plan_changed"]);
    assert.equal(eventSubscriptionRes.status, 200);

    const groupExpansionRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`, {
      method: "PUT",
      headers: headers(developerToken, developerServer.id),
      body: JSON.stringify({
        groups: ["server", "agent"],
        events: ["server.plan_changed", "server.config_updated", "agent.model_changed"],
      }),
    });
    assert.equal(groupExpansionRes.status, 200);
    assert.ok(await approvePermissionReview({ clientId: client.id, reviewerUserId: developer.id }));

    const pendingInstallerRead = await fetch(installStateUrl, { headers: headers(installerToken, installServer.id) });
    assert.equal(pendingInstallerRead.status, 200);
    const pendingInstallerState = await pendingInstallerRead.json() as {
      requested_scopes: string[];
      requested_groups: string[];
      approved_groups: string[];
      effective_events: string[];
      approval_required: boolean;
    };
    assert.deepEqual(pendingInstallerState.requested_groups, ["agent", "server"]);
    assert.deepEqual(pendingInstallerState.approved_groups, ["server"]);
    assert.deepEqual(pendingInstallerState.effective_events, ["server.config_updated", "server.plan_changed"]);
    assert.equal(pendingInstallerState.approval_required, true);
    assert.equal((await mintGroups(["agent"])).status, 400, "declaration expansion alone cannot mint newly requested read authority");
    const oldAuthority = await mintGroups(["server"]);
    assert.equal(oldAuthority.status, 200, "previously approved access remains usable pending approval");
    const oldCredential = await oldAuthority.json() as { access_token: string };
    assert.equal((await fetch(`${app.baseUrl}/api/app-installation/agents`, { headers: { Authorization: `Bearer ${oldCredential.access_token}` } })).status, 403);


    const preApprovalSubscription = await updateSubscriptions([
      "agent.model_changed",
      "server.config_updated",
      "server.plan_changed",
    ]);
    assert.equal(preApprovalSubscription.status, 400);

    // Approve Update sends back the set the page read.
    const grantRes = await fetch(`${installStateUrl}/grant`, {
      method: "PUT",
      headers: headers(installerToken, installServer.id),
      body: JSON.stringify({
        expected_scopes: pendingInstallerState.requested_scopes,
        expected_groups: pendingInstallerState.requested_groups,
      }),
    });
    assert.equal(grantRes.status, 200);
    const agentAuthority = await mintGroups(["agent"]);
    assert.equal(agentAuthority.status, 200);
    const agentCredential = await agentAuthority.json() as { access_token: string };
    const appDirectory = await fetch(`${app.baseUrl}/api/app-installation/agents`, { headers: { Authorization: `Bearer ${agentCredential.access_token}` } });
    assert.equal(appDirectory.status, 200, "administrator grant enables App read without principal login");

    const finalSubscriptionRes = await updateSubscriptions([
      "agent.model_changed",
      "server.config_updated",
      "server.plan_changed",
    ]);
    assert.equal(finalSubscriptionRes.status, 200);

    const finalRead = await fetch(installStateUrl, { headers: headers(installerToken, installServer.id) });
    assert.equal(finalRead.status, 200);
    const finalState = await finalRead.json() as {
      approved_groups: string[];
      subscribed_events: string[];
      effective_events: string[];
      approval_required: boolean;
    };
    assert.deepEqual(finalState.approved_groups, ["agent", "server"]);
    assert.deepEqual(finalState.subscribed_events, ["agent.model_changed", "server.config_updated", "server.plan_changed"]);
    assert.deepEqual(finalState.effective_events, ["agent.model_changed", "server.config_updated", "server.plan_changed"]);
    assert.equal(finalState.approval_required, false);

    const contractionRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`, {
      method: "PUT",
      headers: headers(developerToken, developerServer.id),
      body: JSON.stringify({
        groups: ["server"],
        events: ["server.plan_changed", "server.config_updated"],
      }),
    });
    assert.equal(contractionRes.status, 200);
    const contractedRead = await fetch(installStateUrl, { headers: headers(installerToken, installServer.id) });
    assert.equal(contractedRead.status, 200);
    const contractedState = await contractedRead.json() as { approved_groups: string[]; approval_required: boolean };
    assert.deepEqual(contractedState.approved_groups, ["server"]);
    assert.equal(contractedState.approval_required, false);

    const reExpansionRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`, {
      method: "PUT",
      headers: headers(developerToken, developerServer.id),
      body: JSON.stringify({
        groups: ["server", "agent"],
        events: ["server.plan_changed", "server.config_updated", "agent.model_changed"],
      }),
    });
    assert.equal(reExpansionRes.status, 200);
    assert.ok(await approvePermissionReview({ clientId: client.id, reviewerUserId: developer.id }));
    const reExpandedRead = await fetch(installStateUrl, { headers: headers(installerToken, installServer.id) });
    assert.equal(reExpandedRead.status, 200);
    const reExpandedState = await reExpandedRead.json() as {
      requested_groups: string[];
      approved_groups: string[];
      approval_required: boolean;
    };
    assert.deepEqual(reExpandedState.requested_groups, ["agent", "server"]);
    assert.deepEqual(reExpandedState.approved_groups, ["server"]);
    assert.equal(reExpandedState.approval_required, true);
  } finally {
    __setAppWebhookEncryptionKeyForTests(null);
    await app.close();
  }
});

test("PATCH /api/integrations/clients/:clientId updates registered app metadata", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-owner-${suffix}@slock.test`, `integrations-owner-${suffix}`);
  const member = await seedUser(`integrations-member-${suffix}@slock.test`, `integrations-member-${suffix}`);
  const server = await createServer("Integrations Settings", `integrations-settings-${suffix}`, owner.id);
  await addMember(server.id, member.id, "member");
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `integrations-${suffix.slice(0, 8)}`,
    name: "Original App",
    description: "Original description",
    homepageUrl: "https://old.example.test",
    returnUrl: "https://old.example.test/callback",
    agentManifestUrl: "https://old.example.test/.well-known/slock-agent-manifest.json",
  });

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const patch = (token: string, body: unknown) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const memberRes = await patch(memberToken, { name: "Member Edit" });
  assert.equal(memberRes.status, 403);

  const ownerRes = await patch(ownerToken, {
    name: "Updated App",
    description: "Updated description",
    homepageUrl: "https://new.example.test",
    returnUrl: "https://new.example.test/oauth/callback",
    agentManifestUrl: "https://new.example.test/.well-known/slock-agent-manifest.json",
    category: "Infrastructure",
  });
  assert.equal(ownerRes.status, 200);
  const updated = await ownerRes.json() as {
    clientId: string;
    clientSecret?: string;
    name: string;
    description: string | null;
    homepageUrl: string | null;
    returnUrl: string | null;
    agentManifestUrl: string | null;
    category: string;
  };
  assert.equal(updated.clientId, client.clientId);
  assert.equal(updated.clientSecret, undefined);
  assert.equal(updated.name, "Updated App");
  assert.equal(updated.description, "Updated description");
  assert.equal(updated.homepageUrl, "https://new.example.test");
  assert.equal(updated.returnUrl, "https://new.example.test/oauth/callback");
  assert.equal(updated.agentManifestUrl, "https://new.example.test/.well-known/slock-agent-manifest.json");
  assert.equal(updated.category, "Infrastructure");

  const listRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(listRes.status, 200);
  const clients = await listRes.json() as Array<{ id: string; name: string; returnUrl: string | null; agentManifestUrl: string | null; category: string }>;
  const listed = clients.find((item) => item.id === client.id);
  assert.ok(listed);
  assert.equal(listed.name, "Updated App");
  assert.equal(listed.returnUrl, "https://new.example.test/oauth/callback");
  assert.equal(listed.agentManifestUrl, "https://new.example.test/.well-known/slock-agent-manifest.json");
  assert.equal(listed.category, "Infrastructure");

  const invalidRes = await patch(ownerToken, { name: " " });
  assert.equal(invalidRes.status, 400);

  const invalidManifestRes = await patch(ownerToken, { agentManifestUrl: "http://new.example.test/manifest.json" });
  assert.equal(invalidManifestRes.status, 400);

  const invalidCategoryRes = await patch(ownerToken, { category: "Automation" });
  assert.equal(invalidCategoryRes.status, 400);
});

test("POST /api/integrations/clients stores canonical categories, upgrades legacy values, and defaults omitted values to Other", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-category-${suffix}@slock.test`, `integrations-category-${suffix}`);
  const server = await createServer("Integrations Category", `integrations-category-${suffix}`, owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const create = (body: unknown) => fetch(`${app.baseUrl}/api/integrations/clients`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const categorizedRes = await create({
    name: "Storage App",
    clientId: `storage-${suffix.slice(0, 8)}`,
    category: "Infrastructure",
  });
  assert.equal(categorizedRes.status, 200);
  const categorized = await categorizedRes.json() as { client: { category: string } };
  assert.equal(categorized.client.category, "Infrastructure");

  const legacyAliasRes = await create({
    name: "Legacy Storage App",
    clientId: `legacy-storage-${suffix.slice(0, 8)}`,
    category: "Storage",
  });
  assert.equal(legacyAliasRes.status, 200);
  const legacyAliased = await legacyAliasRes.json() as { client: { id: string; category: string } };
  assert.equal(legacyAliased.client.category, "Infrastructure");

  const renamedAliasRes = await create({
    name: "Previous Infrastructure App",
    clientId: `previous-infra-${suffix.slice(0, 8)}`,
    category: "Infrastructure & Operations",
  });
  assert.equal(renamedAliasRes.status, 200);
  const renamedAliased = await renamedAliasRes.json() as { client: { category: string } };
  assert.equal(renamedAliased.client.category, "Infrastructure");

  const businessAliasRes = await create({
    name: "Previous Business App",
    clientId: `previous-business-${suffix.slice(0, 8)}`,
    category: "Business & Operations",
  });
  assert.equal(businessAliasRes.status, 200);
  const businessAliased = await businessAliasRes.json() as { client: { category: string } };
  assert.equal(businessAliased.client.category, "Business Ops");

  // Simulate a row written before the taxonomy upgrade. Every public OAuth
  // client projection must expose the canonical category during rollout.
  await getDb().update(oauthClients)
    .set({ category: "Scheduling" })
    .where(eq(oauthClients.id, legacyAliased.client.id));
  const listRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as Array<{ id: string; category: string }>;
  assert.equal(
    listed.find((client) => client.id === legacyAliased.client.id)?.category,
    "Productivity & Collaboration",
  );

  const defaultRes = await create({
    name: "Legacy Default App",
    clientId: `legacy-${suffix.slice(0, 8)}`,
  });
  assert.equal(defaultRes.status, 200);
  const defaulted = await defaultRes.json() as { client: { category: string } };
  assert.equal(defaulted.client.category, "Other");

  const invalidRes = await create({
    name: "Invalid Category App",
    clientId: `invalid-${suffix.slice(0, 8)}`,
    category: "Automation",
  });
  assert.equal(invalidRes.status, 400);
});

test("POST /api/integrations/clients/:clientId/regenerate-secret rotates a registered app secret once", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-rotate-owner-${suffix}@slock.test`, `integrations-rotate-owner-${suffix}`);
  const member = await seedUser(`integrations-rotate-member-${suffix}@slock.test`, `integrations-rotate-member-${suffix}`);
  const otherOwner = await seedUser(`integrations-rotate-other-${suffix}@slock.test`, `integrations-rotate-other-${suffix}`);
  const server = await createServer("Integrations Rotate", `integrations-rotate-${suffix}`, owner.id);
  const otherServer = await createServer("Integrations Rotate Other", `integrations-rotate-other-${suffix}`, otherOwner.id);
  await addMember(server.id, member.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `rotate-${suffix.slice(0, 8)}`,
    name: "Rotated App",
    description: "Secret rotation test app",
    homepageUrl: "https://rotate.example.test",
    returnUrl: "https://rotate.example.test/callback",
  });

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const otherOwnerToken = await tokenForHuman(otherOwner.email);
  const rotate = (token: string, serverId: string, clientRowId: string) => fetch(`${app.baseUrl}/api/integrations/clients/${clientRowId}/regenerate-secret`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverId,
    },
  });

  const memberRes = await rotate(memberToken, server.id, client.id);
  assert.equal(memberRes.status, 403);

  const wrongServerRes = await rotate(otherOwnerToken, otherServer.id, client.id);
  assert.equal(wrongServerRes.status, 404);

  const ownerRes = await rotate(ownerToken, server.id, client.id);
  assert.equal(ownerRes.status, 200);
  const rotated = await ownerRes.json() as {
    client: { id: string; clientId: string; clientSecret?: string };
    clientSecret: string;
  };
  assert.equal(rotated.client.id, client.id);
  assert.equal(rotated.client.clientId, client.clientId);
  assert.equal(rotated.client.clientSecret, undefined);
  assert.ok(rotated.clientSecret.startsWith("raft_secret_"));

  const oldAuth = await authenticateOAuthClient(client.clientId, clientSecret);
  assert.equal(oldAuth, null, "old client secret must stop authenticating after regeneration");
  const newAuth = await authenticateOAuthClient(client.clientId, rotated.clientSecret);
  assert.ok(newAuth, "new one-time client secret must authenticate");

  const [stored] = await getDb()
    .select({ clientSecret: oauthClients.clientSecret })
    .from(oauthClients)
    .where(eq(oauthClients.id, client.id));
  assert.equal(stored?.clientSecret, null, "plaintext client secret must not be stored at rest");

  const rotateAuditRows = await getDb()
    .select({ eventType: integrationAuditEvents.eventType, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.eventType, "client.secret_rotated"));
  assert.ok(rotateAuditRows.some((row) => {
    const metadata = row.metadata as { clientKey?: string; appType?: string };
    return metadata.clientKey === client.clientId && metadata.appType === "server_local";
  }));
});

test("integration list endpoints retire built-in rows while preserving ordinary member reads", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-builtin-owner-${suffix}@slock.test`, `integrations-builtin-owner-${suffix}`);
  const member = await seedUser(`integrations-builtin-member-${suffix}@slock.test`, `integrations-builtin-member-${suffix}`);
  const platformOwner = await seedUser(`integrations-builtin-platform-${suffix}@slock.test`, `integrations-builtin-platform-${suffix}`);
  const server = await createServer("Integrations Builtin", `integrations-builtin-${suffix}`, owner.id);
  const platformServer = await createServer("Integrations Builtin Platform", `integrations-builtin-platform-${suffix}`, platformOwner.id);
  await addMember(server.id, member.id, "member");
  const { client: localClient } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `local-${suffix.slice(0, 8)}`,
    name: "Local App",
    description: "Server-local",
    homepageUrl: "https://local.example.test",
    returnUrl: "https://local.example.test/callback",
  });
  const { client: builtInClient } = await seedRetiredBuiltInOAuthClient({
    serverId: platformServer.id,
    createdByUserId: platformOwner.id,
    clientId: `survey-${suffix.slice(0, 8)}`,
    name: "Slock Survey",
    description: "First-party surveys",
    homepageUrl: "https://survey.slock.test",
    returnUrl: "https://survey.slock.test/callback",
  });
  const { client: hiddenBuiltInClient } = await seedRetiredBuiltInOAuthClient({
    serverId: platformServer.id,
    createdByUserId: platformOwner.id,
    clientId: `agent-bi-${suffix.slice(0, 8)}`,
    name: "Slock Agent Internal",
    description: "Agent-only built-in",
    homepageUrl: "https://agent-internal.slock.test",
    returnUrl: "https://agent-internal.slock.test/callback",
  });
  await getDb().update(oauthClients).set({
    humanMarketplaceVisible: false,
  }).where(eq(oauthClients.id, hiddenBuiltInClient.id));

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const outsiderToken = await tokenForHuman(platformOwner.email);

  const memberHeaders = {
    Authorization: `Bearer ${memberToken}`,
    "X-Server-Id": server.id,
  };
  __setOAuthServiceDbForTests((() => {
    throw new Error("retired built-in compatibility route must not resolve a service database");
  }) as typeof getDb);
  let memberBuiltInRes: Response;
  try {
    memberBuiltInRes = await fetch(`${app.baseUrl}/api/integrations/built-in`, { headers: memberHeaders });
  } finally {
    __resetOAuthServiceDbForTests();
  }
  assert.equal(memberBuiltInRes.status, 200);
  const memberBuiltIns = await memberBuiltInRes.json() as Array<{ id: string; serverId?: string; createdByUserId?: string; returnUrl?: string }>;
  assert.deepEqual(memberBuiltIns, []);

  const memberClientsRes = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: memberHeaders });
  assert.equal(memberClientsRes.status, 200);
  const memberClients = await memberClientsRes.json() as Array<{ id: string; clientSecret?: string }>;
  assert.deepEqual(memberClients.map((client) => client.id), [localClient.id]);
  assert.equal(memberClients[0]?.clientSecret, undefined);

  const memberMarketplaceRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, { headers: memberHeaders });
  assert.equal(memberMarketplaceRes.status, 200);
  const memberMarketplace = await memberMarketplaceRes.json() as Array<{ id: string }>;
  assert.equal(memberMarketplace.some(({ id }) => id === builtInClient.id), false);
  assert.equal(memberMarketplace.some(({ id }) => id === hiddenBuiltInClient.id), false);

  const memberOverviewRes = await fetch(`${app.baseUrl}/api/integrations/overview`, { headers: memberHeaders });
  assert.equal(memberOverviewRes.status, 200);
  assert.ok(Array.isArray(await memberOverviewRes.json()));

  const outsiderClientsRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: {
      Authorization: `Bearer ${outsiderToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(outsiderClientsRes.status, 403);

  const memberCreateRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    method: "POST",
    headers: { ...memberHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Member-created app",
      returnUrl: "https://member.example.test/callback",
    }),
  });
  assert.equal(memberCreateRes.status, 403);

  const builtInRes = await fetch(`${app.baseUrl}/api/integrations/built-in`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(builtInRes.status, 200);
  const builtIns = await builtInRes.json() as Array<{ id: string; clientId: string; appType: string; name: string; homepageUrl: string | null; serverId?: string; createdByUserId?: string; returnUrl?: string }>;
  assert.deepEqual(builtIns, []);

  const clientsRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(clientsRes.status, 200);
  const clients = await clientsRes.json() as Array<{ id: string; appType: string; name: string }>;
  assert.deepEqual(clients.map((client) => client.id), [localClient.id]);
  assert.equal(clients[0]?.appType, "server_local");
});

test("retired built-in management and App Notifications routes perform no mutation or audit", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`retired-routes-${suffix}@slock.test`, `Retired Routes ${suffix}`);
  const server = await createServer("Retired Routes", `retired-routes-${suffix}`, owner.id);
  const { client } = await seedRetiredBuiltInOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `retired-routes-${suffix.slice(0, 8)}`,
    name: "Retired Routes App",
    returnUrl: "https://retired.example.test/callback",
  });
  const agent = await createAgent(server.id, "RetiredRoutesBot", {
    runtime: "claude",
    model: "sonnet",
  });
  const [pendingRequest] = await getDb().insert(oauthAccessRequests).values({
    serverId: server.id,
    principalType: "agent",
    agentId: agent.id,
    clientId: client.id,
    scopes: ["openid", "profile"],
    status: "pending",
    remember: true,
  }).returning();
  const [activeGrant] = await getDb().insert(oauthGrants).values({
    serverId: server.id,
    agentId: agent.id,
    clientId: client.id,
    scopes: ["openid", "profile"],
    grantedByUserId: owner.id,
  }).returning();
  const token = await tokenForHuman(owner.email);
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  };
  const beforeAudits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents);
  const before = await getDb().select().from(oauthClients).where(eq(oauthClients.id, client.id));

  const requests = await Promise.all([
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications`, { headers }),
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`, {
      method: "PUT", headers, body: JSON.stringify({ groups: ["agent"], events: ["agent.updated"] }),
    }),
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/webhook`, {
      method: "PUT", headers, body: JSON.stringify({ endpointUrl: "https://retired.example.test/webhook" }),
    }),
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/regenerate-secret`, { method: "POST", headers }),
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ name: "Must not change" }),
    }),
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/logo`, { method: "DELETE", headers }),
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, { method: "DELETE", headers }),
    fetch(`${app.baseUrl}/api/integrations/requests/${pendingRequest.id}/approve`, {
      method: "POST", headers, body: JSON.stringify({ remember: true }),
    }),
    fetch(`${app.baseUrl}/api/integrations/requests/${pendingRequest.id}/deny`, {
      method: "POST", headers, body: JSON.stringify({}),
    }),
    fetch(`${app.baseUrl}/api/integrations/grants/${activeGrant.id}/revoke`, {
      method: "POST", headers, body: JSON.stringify({}),
    }),
  ]);
  assert.deepEqual(requests.map((response) => response.status), [404, 403, 403, 404, 404, 404, 404, 404, 404, 404]);

  const after = await getDb().select().from(oauthClients).where(eq(oauthClients.id, client.id));
  const afterAudits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents);
  assert.deepEqual(after, before);
  assert.equal(afterAudits.length, beforeAudits.length);
  assert.deepEqual(
    await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, pendingRequest.id)),
    [pendingRequest],
  );
  assert.deepEqual(
    await getDb().select().from(oauthGrants).where(eq(oauthGrants.id, activeGrant.id)),
    [activeGrant],
  );
  assert.deepEqual(
    await getDb().select({ id: oauthAppPermissionRevisions.id }).from(oauthAppPermissionRevisions)
      .where(eq(oauthAppPermissionRevisions.clientId, client.id)),
    [],
  );
  assert.deepEqual(
    await getDb().select({ id: oauthAppWebhookConfigs.id }).from(oauthAppWebhookConfigs)
      .where(eq(oauthAppWebhookConfigs.clientId, client.id)),
    [],
  );
});

test("external-registration-bound OAuth clients are hidden and immutable while ordinary third-party apps stay manageable", async ({ app }) => {
  const suffix = randomUUID();
  const sourceOwner = await seedUser(`platform-app-source-${suffix}@slock.test`, `Platform App Source ${suffix}`);
  const installOwner = await seedUser(`platform-app-install-${suffix}@slock.test`, `Platform App Install ${suffix}`);
  const sourceServer = await createServer("Platform App Source", `platform-app-source-${suffix}`, sourceOwner.id);
  const installServer = await createServer("Platform App Install", `platform-app-install-${suffix}`, installOwner.id);
  const { client: platformClient } = await createOAuthClient({
    serverId: sourceServer.id,
    createdByUserId: sourceOwner.id,
    clientId: `platform-${suffix.slice(0, 8)}`,
    appType: "third_party_global",
    name: "Platform Managed Bridge",
    description: "Hidden external-app identity anchor",
    homepageUrl: "https://platform.example.test",
    returnUrl: "https://platform.example.test/callback",
  });
  await getDb().update(oauthClients).set({
    publishStatus: "published",
    humanMarketplaceVisible: false,
  }).where(eq(oauthClients.id, platformClient.id));
  const platformInstalls = await getDb().insert(oauthClientInstalls).values([
    { serverId: sourceServer.id, clientId: platformClient.id, installedByUserId: sourceOwner.id },
    { serverId: installServer.id, clientId: platformClient.id, installedByUserId: installOwner.id },
  ]).returning();
  await getDb().insert(externalAppRegistrations).values({
    id: randomUUID(),
    oauthClientId: platformClient.id,
    provider: "slack",
    environment: "test",
    state: "active",
    providerAppId: `A_PLATFORM_${suffix}`,
    providerOAuthClientId: `platform-oauth-${suffix}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: `platform-manifest-${suffix}`,
    requiredCapabilities: ["channel_events"],
  });

  const sourceHeaders = {
    Authorization: `Bearer ${await tokenForHuman(sourceOwner.email)}`,
    "X-Server-Id": sourceServer.id,
    "Content-Type": "application/json",
  };
  const installHeaders = {
    Authorization: `Bearer ${await tokenForHuman(installOwner.email)}`,
    "X-Server-Id": installServer.id,
    "Content-Type": "application/json",
  };

  const clients = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: sourceHeaders });
  assert.equal(clients.status, 200);
  assert.equal((await clients.json() as Array<{ id: string }>).some(({ id }) => id === platformClient.id), false);
  const marketplace = await fetch(`${app.baseUrl}/api/integrations/marketplace`, { headers: installHeaders });
  assert.equal(marketplace.status, 200);
  assert.equal((await marketplace.json() as Array<{ id: string }>).some(({ id }) => id === platformClient.id), false);

  const sourceMutations: Array<[string, string, unknown?, number?]> = [
    ["PATCH", `/api/integrations/clients/${platformClient.id}`, { name: "mutated" }],
    ["POST", `/api/integrations/clients/${platformClient.id}/regenerate-secret`],
    ["POST", `/api/integrations/clients/${platformClient.id}/request-unpublish`],
    ["POST", `/api/integrations/clients/${platformClient.id}/share-links`, { targetServerSlug: installServer.slug }],
    ["GET", `/api/integrations/clients/${platformClient.id}/share-links`],
    ["GET", `/api/integrations/clients/${platformClient.id}/app-notifications`],
    ["PUT", `/api/integrations/clients/${platformClient.id}/app-notifications/permissions`, { groups: [], events: [] }, 403],
    ["PUT", `/api/integrations/clients/${platformClient.id}/app-notifications/webhook`, { endpointUrl: "https://events.example.test/bridge" }, 403],
    ["DELETE", `/api/integrations/clients/${platformClient.id}/logo`],
  ];
  for (const [method, path, body, expectedStatus = 404] of sourceMutations) {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: sourceHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${await response.clone().text()}`);
  }

  const installMutations: Array<[string, string]> = [
    ["GET", `/api/integrations/marketplace/${platformClient.id}/install/app-notifications`],
    ["PUT", `/api/integrations/marketplace/${platformClient.id}/install/app-notifications/grant`],
    ["DELETE", `/api/integrations/marketplace/${platformClient.id}/install`],
  ];
  for (const [method, path] of installMutations) {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: installHeaders,
      ...(method === "PUT" ? { body: JSON.stringify({ expected_scopes: [], expected_groups: [] }) } : {}),
    });
    assert.equal(response.status, 404, `${method} ${path}: ${await response.clone().text()}`);
  }

  assert.equal((await getDb().select().from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, platformClient.id))).length, platformInstalls.length);
  assert.equal((await getDb().select().from(oauthAppPermissionRevisions)
    .where(eq(oauthAppPermissionRevisions.clientId, platformClient.id))).length, 0);
  assert.equal((await getDb().select().from(oauthAppWebhookConfigs)
    .where(eq(oauthAppWebhookConfigs.clientId, platformClient.id))).length, 0);
  assert.equal((await getDb().select().from(oauthClientShareLinks)
    .where(eq(oauthClientShareLinks.clientId, platformClient.id))).length, 0);
  assert.equal(await createAppOutboundPermissionRevision({
    clientId: platformClient.id,
    actor: { type: "human", id: sourceOwner.id },
    groups: [],
    events: [],
  }), null);
  assert.equal(await configureAppWebhook({
    clientId: platformClient.id,
    actorUserId: sourceOwner.id,
    endpointUrl: "https://events.example.test/platform",
  }), null);
  assert.equal(await getAppNotificationDeveloperState({
    clientId: platformClient.id,
    sourceServerId: sourceServer.id,
  }), null);
  assert.equal(await getAppNotificationInstallationState({
    clientId: platformClient.id,
    serverId: installServer.id,
  }), null);
  assert.equal(await updateAppInstallationGrant({
    installationId: platformInstalls[1]!.id,
    actorUserId: installOwner.id,
    expected: { scopes: [], groups: [] },
  }), null);
  assert.equal(await updateAppInstallationSubscriptions({
    installationId: platformInstalls[1]!.id,
    clientId: platformClient.id,
    subscribedEvents: [],
    actor: { type: "human", id: installOwner.id },
  }), null);
  assert.equal((await listAgentAvailableOAuthClients(sourceServer.id))
    .some(({ id }) => id === platformClient.id), false);
  assert.equal(await getOAuthClientForServer({
    serverId: sourceServer.id,
    clientKey: platformClient.clientId,
  }), null);

  const rawPlatformToken = `platform-token-${suffix}`;
  await getDb().insert(oauthAccessTokens).values({
    serverId: sourceServer.id,
    principalType: "human",
    userId: sourceOwner.id,
    clientId: platformClient.id,
    tokenHash: createHash("sha256").update(rawPlatformToken).digest("hex"),
    scopes: ["openid", "profile"],
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(await getIdentityByAccessToken(rawPlatformToken), null);
  const [approvedRequest] = await getDb().insert(oauthAccessRequests).values({
    serverId: sourceServer.id,
    principalType: "human",
    userId: sourceOwner.id,
    clientId: platformClient.id,
    scopes: ["openid", "profile"],
    status: "approved",
    resolvedByUserId: sourceOwner.id,
    resolvedAt: new Date(),
  }).returning();
  await assert.rejects(
    exchangeAccessRequest({ clientId: platformClient.id, requestId: approvedRequest.id }),
    /Access request not found/,
  );

  const adminAgent = await createAgent(sourceServer.id, `platform-admin-${suffix.slice(0, 8)}`);
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, sourceServer.id),
    eq(serverAgentMembers.agentId, adminAgent.id),
  ));
  assert.equal((await resolveOAuthClientForAgentMutation({
    serverId: sourceServer.id,
    clientKey: platformClient.clientId,
    actorAgentId: adminAgent.id,
  })).status, "not_found");
  assert.equal((await rotateClientSecretForAgent({
    serverId: sourceServer.id,
    clientKey: platformClient.clientId,
    actorAgentId: adminAgent.id,
  })).status, "not_found");
  assert.equal((await updateOAuthClientForAgent({
    serverId: sourceServer.id,
    clientKey: platformClient.clientId,
    actorAgentId: adminAgent.id,
    description: "mutated",
  })).status, "not_found");
  assert.equal((await transferClientOwnershipForAgent({
    serverId: sourceServer.id,
    clientKey: platformClient.clientId,
    actorAgentId: adminAgent.id,
    targetAgentId: adminAgent.id,
  })).status, "not_found");

  const { client: ordinary } = await createOAuthClient({
    serverId: sourceServer.id,
    createdByUserId: sourceOwner.id,
    clientId: `ordinary-${suffix.slice(0, 8)}`,
    appType: "third_party_global",
    name: "Ordinary Third Party",
    description: "Positive control",
    homepageUrl: "https://ordinary.example.test",
    returnUrl: "https://ordinary.example.test/callback",
  });
  const ordinaryPatch = await fetch(`${app.baseUrl}/api/integrations/clients/${ordinary.id}`, {
    method: "PATCH",
    headers: sourceHeaders,
    body: JSON.stringify({ name: "Ordinary Third Party Updated" }),
  });
  assert.equal(ordinaryPatch.status, 200, await ordinaryPatch.clone().text());
  assert.equal((await resolveOAuthClientForAgentMutation({
    serverId: sourceServer.id,
    clientKey: ordinary.clientId,
    actorAgentId: adminAgent.id,
  })).status, "ok");
});

test("marketplace publish review and install keeps third-party apps out of server-local install semantics", async ({ app }) => {

  try {
    const suffix = randomUUID();
    const publisher = await seedUser(`integrations-publisher-${suffix}@slock.test`, `Publisher ${suffix}`);
    const installer = await seedUser(`integrations-installer-${suffix}@slock.test`, `Installer ${suffix}`);
    const reviewer = await seedUser(`integrations-reviewer-${suffix}@slock.test`, `Reviewer ${suffix}`);
    const member = await seedUser(`integrations-market-member-${suffix}@slock.test`, `Member ${suffix}`);
    const publisherServer = await createServer("Publisher Server", `publisher-${suffix}`, publisher.id);
    const installerServer = await createServer("Installer Server", `installer-${suffix}`, installer.id);
    await addMember(publisherServer.id, reviewer.id, "admin");
    await addMember(installerServer.id, member.id, "member");
    const publisherAgent = await createAgent(publisherServer.id, "PublisherBot", {
      runtime: "claude",
      model: "sonnet",
    });
    const agent = await createAgent(installerServer.id, "MarketplaceBot", {
      runtime: "claude",
      model: "sonnet",
    });

    const { client, clientSecret } = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: publisher.id,
      clientId: `market-${suffix.slice(0, 8)}`,
      name: "Market @Mention App",
      description: "Reads agent-visible context and must not ping @someone",
      homepageUrl: "https://market.example.test",
      returnUrl: "https://market.example.test/callback",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile", "identity", "agent:event:write"],
    });

    const publisherToken = await tokenForHuman(publisher.email);
    const installerToken = await tokenForHuman(installer.email);
    const reviewerToken = await tokenForHuman(reviewer.email);
    const memberToken = await tokenForHuman(member.email);

    const blankDescriptionTarget = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: publisher.id,
      clientId: `blank-${suffix.slice(0, 8)}`,
      name: "Blank Description App",
      homepageUrl: "https://blank-description.example.test",
      returnUrl: "https://blank-description.example.test/callback",
    });
    const blankDescriptionRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${blankDescriptionTarget.client.id}/request-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "Productivity & Collaboration",
        dataAccessSummary: "Profile",
      }),
    });
    assert.equal(blankDescriptionRequestRes.status, 400);
    const blankDescriptionRequestBody = await blankDescriptionRequestRes.json() as { error: string };
    assert.match(blankDescriptionRequestBody.error, /description is required/);
    const [blankDescriptionAfterRequest] = await getDb()
      .select({ publishStatus: oauthClients.publishStatus })
      .from(oauthClients)
      .where(eq(oauthClients.id, blankDescriptionTarget.client.id));
    assert.equal(blankDescriptionAfterRequest?.publishStatus, "private");
    await getDb()
      .update(oauthClients)
      .set({ publishStatus: "publish_requested", updatedAt: new Date() })
      .where(eq(oauthClients.id, blankDescriptionTarget.client.id));
    // Publishing without a description is refused (RVW06) and changes nothing.
    await assert.rejects(
      decidePublishReview({ clientId: blankDescriptionTarget.client.id, reviewerUserId: reviewer.id, decision: "approve" }),
      (error: unknown) => reviewRefusalCode(error) === "RVW06",
    );
    const [blankDescriptionAfterReview] = await getDb()
      .select({ appType: oauthClients.appType, publishStatus: oauthClients.publishStatus })
      .from(oauthClients)
      .where(eq(oauthClients.id, blankDescriptionTarget.client.id));
    assert.equal(blankDescriptionAfterReview?.appType, "server_local");
    assert.equal(blankDescriptionAfterReview?.publishStatus, "publish_requested");
    await getDb()
      .delete(oauthClients)
      .where(eq(oauthClients.id, blankDescriptionTarget.client.id));

    const requestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "Infrastructure",
        dataAccessSummary: "Legacy free-text must be ignored",
      }),
    });
    assert.equal(requestRes.status, 200);
    const requested = await requestRes.json() as { id: string; publishStatus: string; category: string; dataAccessSummary: string | null; allowedScopes: string[] | null; appType: string };
    assert.equal(requested.id, client.id);
    assert.equal(requested.appType, "server_local");
    assert.equal(requested.publishStatus, "publish_requested");
    assert.equal(requested.category, "Productivity & Collaboration");
    assert.equal(requested.dataAccessSummary, null);
    assert.deepEqual(requested.allowedScopes, ["agent:event:write", "identity", "openid", "profile"]);

    const repeatRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "Automation",
        dataAccessSummary: "This repeated submit should not replace the queued request",
      }),
    });
    assert.equal(repeatRequestRes.status, 200);
    const repeatRequested = await repeatRequestRes.json() as { id: string; publishStatus: string; category: string; dataAccessSummary: string | null };
    assert.equal(repeatRequested.id, client.id);
    assert.equal(repeatRequested.publishStatus, "publish_requested");
    assert.equal(repeatRequested.category, "Productivity & Collaboration");
    assert.equal(repeatRequested.dataAccessSummary, null);

    const updatePendingRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Market @Mention App Updated",
        description: "Updated while marketplace review is pending",
        homepageUrl: "https://market.example.test/updated",
        returnUrl: "https://market.example.test/callback",
      }),
    });
    assert.equal(updatePendingRes.status, 200);
    const updatedPending = await updatePendingRes.json() as { id: string; name: string; description: string | null; homepageUrl: string | null; publishStatus: string };
    assert.equal(updatedPending.id, client.id);
    assert.equal(updatedPending.name, "Market @Mention App Updated");
    assert.equal(updatedPending.description, "Updated while marketplace review is pending");
    assert.equal(updatedPending.homepageUrl, "https://market.example.test/updated");
    assert.equal(updatedPending.publishStatus, "publish_requested");
    const updateAuditRows = await getDb()
      .select({ eventType: integrationAuditEvents.eventType, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.eventType, "app.updated"));
    assert.ok(updateAuditRows.some((row) => {
      const metadata = row.metadata as { clientKey?: string; appType?: string; changedFields?: string[] };
      return metadata.clientKey === client.clientId
        && metadata.appType === "server_local"
        && metadata.changedFields?.includes("name")
        && metadata.changedFields.includes("description")
        && metadata.changedFields.includes("homepageUrl");
    }));

    const deleteTarget = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: publisher.id,
      clientId: `delete-${suffix.slice(0, 8)}`,
      name: "Delete Pending App",
      description: "Temporary app under review",
      homepageUrl: "https://delete-pending.example.test",
      returnUrl: "https://delete-pending.example.test/callback",
    });
    const deleteRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${deleteTarget.client.id}/request-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "Productivity & Collaboration",
        dataAccessSummary: "Temporary app under review",
      }),
    });
    assert.equal(deleteRequestRes.status, 200);
    const deletePendingRes = await fetch(`${app.baseUrl}/api/integrations/clients/${deleteTarget.client.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(deletePendingRes.status, 200);
    const deletePendingBody = await deletePendingRes.json() as { id: string; publishStatus: string };
    assert.equal(deletePendingBody.id, deleteTarget.client.id);
    assert.equal(deletePendingBody.publishStatus, "publish_requested");
    const deleteTargetRows = await getDb()
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.id, deleteTarget.client.id));
    assert.equal(deleteTargetRows.length, 0);
    const deleteAuditRows = await getDb()
      .select({ eventType: integrationAuditEvents.eventType, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.eventType, "app.deleted"));
    assert.ok(deleteAuditRows.some((row) => {
      const metadata = row.metadata as { clientKey?: string; appType?: string; publishStatus?: string };
      return metadata.clientKey === deleteTarget.client.clientId
        && metadata.appType === "server_local"
        && metadata.publishStatus === "publish_requested";
    }));

    // Raft has no review route: App Admin decides (#proj-apps task #19).
    const publishReviewRoute = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/review-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "published" }),
    });
    assert.equal(publishReviewRoute.status, 404);

    const { client: approved } = await decidePublishReview({ clientId: client.id, reviewerUserId: reviewer.id, decision: "approve" });
    assert.equal(approved.id, client.id);
    assert.equal(approved.appType, "third_party_global");
    assert.equal(approved.publishStatus, "published");

    const updatePublishedRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Market @Mention App Updated",
        description: "Updated after marketplace publish",
        homepageUrl: "https://market.example.test/updated",
        returnUrl: "https://market.example.test/callback",
      }),
    });
    assert.equal(updatePublishedRes.status, 200);
    const updatedPublished = await updatePublishedRes.json() as { id: string; appType: string; publishStatus: string; description: string | null };
    assert.equal(updatedPublished.id, client.id);
    assert.equal(updatedPublished.appType, "third_party_global");
    assert.equal(updatedPublished.publishStatus, "published");
    assert.equal(updatedPublished.description, "Updated after marketplace publish");

    const deletePublishedRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(deletePublishedRes.status, 404);

    const offlineRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-unpublish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(offlineRequestRes.status, 200);
    const offlineRequested = await offlineRequestRes.json() as { id: string; appType: string; publishStatus: string };
    assert.equal(offlineRequested.id, client.id);
    assert.equal(offlineRequested.appType, "third_party_global");
    assert.equal(offlineRequested.publishStatus, "unpublish_requested");

    const repeatOfflineRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-unpublish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(repeatOfflineRequestRes.status, 200);
    const repeatOfflineRequested = await repeatOfflineRequestRes.json() as { id: string; publishStatus: string };
    assert.equal(repeatOfflineRequested.id, client.id);
    assert.equal(repeatOfflineRequested.publishStatus, "unpublish_requested");

    const offlineAuditRows = await getDb()
      .select({ eventType: integrationAuditEvents.eventType, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.eventType, "app.offline_requested"));
    assert.ok(offlineAuditRows.some((row) => {
      const metadata = row.metadata as { clientKey?: string; previousPublishStatus?: string };
      return metadata.clientKey === client.clientId && metadata.previousPublishStatus === "published";
    }));

    const publisherInstallRows = await getDb()
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, publisherServer.id),
        eq(oauthClientInstalls.clientId, client.id),
      ));
    assert.equal(publisherInstallRows.length, 1);

    const publisherMarketplaceRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(publisherMarketplaceRes.status, 200);
    const publisherMarketplace = await publisherMarketplaceRes.json() as Array<{ id: string; installedAt: string | null }>;
    assert.ok(publisherMarketplace.find((item) => item.id === client.id)?.installedAt);

    const publisherAgentRequest = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret,
        serverSlug: publisherServer.slug,
        agentName: publisherAgent.name,
        scopes: ["openid", "profile", "identity"],
      }),
    });
    assert.equal(publisherAgentRequest.status, 200);

    const publisherHumanAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: publisherServer.id,
        scopes: ["openid", "profile"],
      }),
    });
    assert.equal(publisherHumanAuthorize.status, 200);

    const marketplaceBeforeInstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(marketplaceBeforeInstallRes.status, 200);
    const marketplaceBeforeInstall = await marketplaceBeforeInstallRes.json() as Array<{ id: string; installedAt: string | null; publisherName: string | null; publisherServerName: string | null; description: string | null }>;
    const listing = marketplaceBeforeInstall.find((item) => item.id === client.id);
    assert.ok(listing);
    assert.equal(listing.installedAt, null);
    assert.equal(listing.publisherName, publisher.displayName);
    assert.equal(listing.publisherServerName, publisherServer.name);
    assert.equal(listing.description, "Updated after marketplace publish");

    const agentRequestBeforeInstall = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret,
        serverSlug: installerServer.slug,
        agentName: agent.name,
        scopes: ["openid", "profile", "identity"],
      }),
    });
    assert.equal(agentRequestBeforeInstall.status, 404);

    const memberInstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(memberInstallRes.status, 403);

    const installRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
        "Content-Type": "application/json",
      },
      body: await expectedAppPermissionsJson(client.id),
    });
    assert.equal(installRes.status, 200);
    const installed = await installRes.json() as { id: string; appType: string };
    assert.equal(installed.id, client.id);
    assert.equal(installed.appType, "third_party_global");

    const installRows = await getDb()
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(eq(oauthClientInstalls.clientId, client.id));
    assert.equal(installRows.length, 2);

    const { client: offlineRejected } = await decidePublishReview({
      clientId: client.id, reviewerUserId: reviewer.id, decision: "reject", reason: "keep listed for launch week",
    });
    assert.equal(offlineRejected.id, client.id);
    assert.equal(offlineRejected.appType, "third_party_global");
    assert.equal(offlineRejected.publishStatus, "published");
    assert.equal(offlineRejected.publishRejectionReason, "keep listed for launch week");

    const offlineRequestAgainRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-unpublish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(offlineRequestAgainRes.status, 200);
    const offlineRequestedAgain = await offlineRequestAgainRes.json() as { publishStatus: string };
    assert.equal(offlineRequestedAgain.publishStatus, "unpublish_requested");

    const agentRequestAfterInstall = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret,
        serverSlug: installerServer.slug,
        agentName: agent.name,
        scopes: ["openid", "profile", "identity"],
      }),
    });
    assert.equal(agentRequestAfterInstall.status, 200);
    const agentRequest = await agentRequestAfterInstall.json() as {
      requestId: string;
      status: string;
      client: { appType: string; name: string; description: string | null };
    };
    assert.equal(agentRequest.status, "approved");
    assert.equal(agentRequest.client.appType, "third_party_global");
    assert.equal(agentRequest.client.name, "Market @Mention App Updated");

    const marketplaceAfterInstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(marketplaceAfterInstallRes.status, 200);
    const marketplaceAfterInstall = await marketplaceAfterInstallRes.json() as Array<{ id: string; installedAt: string | null }>;
    assert.ok(marketplaceAfterInstall.find((item) => item.id === client.id)?.installedAt);

    const [standingGrant] = await getDb().select().from(oauthGrants).where(and(
      eq(oauthGrants.serverId, installerServer.id),
      eq(oauthGrants.agentId, agent.id),
      eq(oauthGrants.clientId, client.id),
    ));
    assert.ok(standingGrant);
    const [activeToken] = await getDb().insert(oauthAccessTokens).values({
      serverId: installerServer.id,
      principalType: "agent",
      agentId: agent.id,
      clientId: client.id,
      grantId: standingGrant.id,
      tokenHash: `token-${suffix}`,
      scopes: ["openid", "profile", "identity"],
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const [pendingRequest] = await getDb().insert(oauthAccessRequests).values({
      serverId: installerServer.id,
      principalType: "agent",
      agentId: agent.id,
      clientId: client.id,
      scopes: ["openid", "profile"],
      status: "pending",
      remember: true,
    }).returning();

    const memberUninstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${memberToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(memberUninstallRes.status, 403);

    const uninstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(uninstallRes.status, 200);
    const uninstalled = await uninstallRes.json() as { clientId: string; revokedGrantCount: number; revokedTokenCount: number; deniedPendingRequestCount: number };
    assert.equal(uninstalled.clientId, client.id);
    assert.equal(uninstalled.revokedGrantCount, 1);
    assert.equal(uninstalled.revokedTokenCount, 1);
    // Every request that could still produce a token is denied (#10678): the
    // pending one, and the auto-approved one whose code was never exchanged.
    assert.equal(uninstalled.deniedPendingRequestCount, 2);
    const requestStates = await getDb().select({ id: oauthAccessRequests.id, status: oauthAccessRequests.status })
      .from(oauthAccessRequests).where(inArray(oauthAccessRequests.id, [pendingRequest.id, agentRequest.requestId]));
    assert.deepEqual(requestStates.map((row) => row.status), ["denied", "denied"]);

    const installRowsAfterUninstall = await getDb()
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(eq(oauthClientInstalls.clientId, client.id));
    assert.equal(installRowsAfterUninstall.length, 1);

    const [revokedGrant] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.id, standingGrant.id));
    assert.equal(revokedGrant?.revokedByUserId, installer.id);
    assert.ok(revokedGrant?.revokedAt);
    const [revokedToken] = await getDb().select().from(oauthAccessTokens).where(eq(oauthAccessTokens.id, activeToken.id));
    assert.ok(revokedToken?.revokedAt);
    const [deniedRequest] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, pendingRequest.id));
    assert.equal(deniedRequest?.status, "denied");
    assert.equal(deniedRequest?.remember, false);

    const marketplaceAfterUninstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(marketplaceAfterUninstallRes.status, 200);
    const marketplaceAfterUninstall = await marketplaceAfterUninstallRes.json() as Array<{ id: string; installedAt: string | null }>;
    assert.equal(marketplaceAfterUninstall.find((item) => item.id === client.id)?.installedAt, null);

    const agentRequestAfterUninstall = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret,
        serverSlug: installerServer.slug,
        agentName: agent.name,
        scopes: ["openid", "profile", "identity"],
      }),
    });
    assert.equal(agentRequestAfterUninstall.status, 404);

    const reinstallBeforeOfflineApprovalRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
        "Content-Type": "application/json",
      },
      body: await expectedAppPermissionsJson(client.id),
    });
    assert.equal(reinstallBeforeOfflineApprovalRes.status, 200);

    const [publisherGrantBeforeOfflineApproval] = await getDb().insert(oauthGrants).values({
      serverId: publisherServer.id,
      agentId: publisherAgent.id,
      clientId: client.id,
      scopes: ["openid", "profile", "identity"],
      grantedByUserId: publisher.id,
    }).returning();
    const [publisherTokenBeforeOfflineApproval] = await getDb().insert(oauthAccessTokens).values({
      serverId: publisherServer.id,
      principalType: "agent",
      agentId: publisherAgent.id,
      clientId: client.id,
      grantId: publisherGrantBeforeOfflineApproval.id,
      tokenHash: `publisher-offline-token-${suffix}`,
      scopes: ["openid", "profile", "identity"],
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const [publisherPendingBeforeOfflineApproval] = await getDb().insert(oauthAccessRequests).values({
      serverId: publisherServer.id,
      principalType: "agent",
      agentId: publisherAgent.id,
      clientId: client.id,
      scopes: ["openid", "profile"],
      status: "pending",
      remember: true,
    }).returning();
    const [installerGrantBeforeOfflineApproval] = await getDb().insert(oauthGrants).values({
      serverId: installerServer.id,
      agentId: agent.id,
      clientId: client.id,
      scopes: ["openid", "profile", "identity"],
      grantedByUserId: installer.id,
    }).returning();
    const [installerTokenBeforeOfflineApproval] = await getDb().insert(oauthAccessTokens).values({
      serverId: installerServer.id,
      principalType: "agent",
      agentId: agent.id,
      clientId: client.id,
      grantId: installerGrantBeforeOfflineApproval.id,
      tokenHash: `installer-offline-token-${suffix}`,
      scopes: ["openid", "profile", "identity"],
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const [installerPendingBeforeOfflineApproval] = await getDb().insert(oauthAccessRequests).values({
      serverId: installerServer.id,
      principalType: "agent",
      agentId: agent.id,
      clientId: client.id,
      scopes: ["openid", "profile"],
      status: "pending",
      remember: true,
    }).returning();

    const [sourceInstallBeforeOffline] = await getDb().select().from(oauthClientInstalls)
      .where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, publisherServer.id)));
    assert.ok(sourceInstallBeforeOffline);
    const [externalInstallBeforeOffline] = await getDb().select().from(oauthClientInstalls)
      .where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, installerServer.id)));
    assert.ok(externalInstallBeforeOffline);
    const sourceBot = await createAgent(publisherServer.id, "SourceOfflineBot", { runtime: "external", model: "external" });
    const externalBot = await createAgent(installerServer.id, "ExternalOfflineBot", { runtime: "external", model: "external" });
    const [sourceBinding] = await getDb().insert(appBotBindings).values({
      installId: sourceInstallBeforeOffline.id, serverId: publisherServer.id, agentId: sourceBot.id, handle: sourceBot.name,
    }).returning();
    await getDb().insert(appBotBindings).values({
      installId: externalInstallBeforeOffline.id, serverId: installerServer.id, agentId: externalBot.id, handle: externalBot.name,
    });

    const { client: offlineApproved } = await decidePublishReview({ clientId: client.id, reviewerUserId: reviewer.id, decision: "approve" });
    assert.equal(offlineApproved.id, client.id);
    assert.equal(offlineApproved.appType, "third_party_global");
    assert.equal(offlineApproved.publishStatus, "private");
    assert.equal(offlineApproved.humanMarketplaceVisible, false);

    const installRowsAfterOfflineApproval = await getDb()
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(eq(oauthClientInstalls.clientId, client.id));
    assert.deepEqual(installRowsAfterOfflineApproval, [{ id: sourceInstallBeforeOffline.id }]);
    const [sourceInstallAfterOffline] = await getDb().select().from(oauthClientInstalls)
      .where(eq(oauthClientInstalls.id, sourceInstallBeforeOffline.id));
    assert.deepEqual(sourceInstallAfterOffline, sourceInstallBeforeOffline, "source install and its consent remain unchanged");
    assert.deepEqual((await getDb().select().from(appBotBindings).where(eq(appBotBindings.id, sourceBinding.id)))[0], sourceBinding);
    assert.equal((await getDb().select().from(agents).where(eq(agents.id, sourceBot.id)))[0]?.deletedAt, null);
    assert.ok((await getDb().select().from(agents).where(eq(agents.id, externalBot.id)))[0]?.deletedAt);
    assert.equal((await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, externalInstallBeforeOffline.id))).length, 0);

    const [revokedPublisherGrant] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.id, publisherGrantBeforeOfflineApproval.id));
    assert.equal(revokedPublisherGrant?.revokedByUserId, null);
    assert.equal(revokedPublisherGrant?.revokedAt, null);
    const [revokedInstallerGrant] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.id, installerGrantBeforeOfflineApproval.id));
    assert.equal(revokedInstallerGrant?.revokedByUserId, reviewer.id);
    assert.ok(revokedInstallerGrant?.revokedAt);
    const [revokedPublisherToken] = await getDb().select().from(oauthAccessTokens).where(eq(oauthAccessTokens.id, publisherTokenBeforeOfflineApproval.id));
    assert.equal(revokedPublisherToken?.revokedAt, null);
    const [revokedInstallerToken] = await getDb().select().from(oauthAccessTokens).where(eq(oauthAccessTokens.id, installerTokenBeforeOfflineApproval.id));
    assert.ok(revokedInstallerToken?.revokedAt);
    const [deniedPublisherRequest] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, publisherPendingBeforeOfflineApproval.id));
    assert.equal(deniedPublisherRequest?.status, "pending");
    assert.equal(deniedPublisherRequest?.remember, true);
    assert.equal(deniedPublisherRequest?.resolvedByUserId, null);
    const [deniedInstallerRequest] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, installerPendingBeforeOfflineApproval.id));
    assert.equal(deniedInstallerRequest?.status, "denied");
    assert.equal(deniedInstallerRequest?.remember, false);
    assert.equal(deniedInstallerRequest?.resolvedByUserId, reviewer.id);

    const marketplaceAfterOfflineApprovalRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(marketplaceAfterOfflineApprovalRes.status, 200);
    const marketplaceAfterOfflineApproval = await marketplaceAfterOfflineApprovalRes.json() as Array<{ id: string }>;
    assert.equal(marketplaceAfterOfflineApproval.some((item) => item.id === client.id), false);

    const installAfterOfflineApprovalRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
        "Content-Type": "application/json",
      },
      body: await expectedAppPermissionsJson(client.id),
    });
    assert.equal(installAfterOfflineApprovalRes.status, 404);

    const publisherAgentRequestAfterOfflineApproval = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret,
        serverSlug: publisherServer.slug,
        agentName: publisherAgent.name,
        scopes: ["openid", "profile", "identity"],
      }),
    });
    assert.equal(publisherAgentRequestAfterOfflineApproval.status, 200);
    // The actual human login lookup and authorization must agree with the
    // source-owned row shown in Settings, while another Server remains denied.
    const sourceLookup = await fetch(`${app.baseUrl}/api/oauth/clients/lookup?client_id=${client.clientId}&server_id=${publisherServer.id}`, {
      headers: { Authorization: `Bearer ${publisherToken}` },
    });
    assert.equal(sourceLookup.status, 200);
    const otherLookup = await fetch(`${app.baseUrl}/api/oauth/clients/lookup?client_id=${client.clientId}&server_id=${installerServer.id}`, {
      headers: { Authorization: `Bearer ${installerToken}` },
    });
    assert.equal(otherLookup.status, 403);
    const humanAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: { Authorization: `Bearer ${publisherToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, serverId: publisherServer.id, scopes: ["openid", "profile"] }),
    });
    assert.equal(humanAuthorize.status, 200, await humanAuthorize.text());
    assert.ok((await listAgentAvailableOAuthClients(publisherServer.id)).some((item) => item.id === client.id));
    assert.equal((await listAgentAvailableOAuthClients(installerServer.id)).some((item) => item.id === client.id), false);

    const offlineDecisionAuditRows = await getDb()
      .select({ eventType: integrationAuditEvents.eventType, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.eventType, "app.offline_approved"));
    const offlineApprovalAuditFound = offlineDecisionAuditRows.some((row) => {
      const metadata = row.metadata as {
        clientKey?: string;
        previousPublishStatus?: string;
        nextPublishStatus?: string;
        removedInstallCount?: number;
        revokedGrantCount?: number;
        revokedTokenCount?: number;
        deniedPendingRequestCount?: number;
      };
      return metadata.clientKey === client.clientId
        && metadata.previousPublishStatus === "unpublish_requested"
        && metadata.nextPublishStatus === "private"
        && metadata.removedInstallCount === 1
        && typeof metadata.revokedGrantCount === "number"
        && metadata.revokedGrantCount >= 1
        && typeof metadata.revokedTokenCount === "number"
        && metadata.revokedTokenCount >= 1
        && typeof metadata.deniedPendingRequestCount === "number"
        && metadata.deniedPendingRequestCount >= 1;
    });
    assert.ok(offlineApprovalAuditFound, JSON.stringify(offlineDecisionAuditRows.map((row) => row.metadata)));

    const publisherClientsRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
      },
    });
    assert.equal(publisherClientsRes.status, 200);
    const publisherClients = await publisherClientsRes.json() as Array<{ id: string; appType: string; publishStatus: string }>;
    assert.deepEqual(publisherClients.map((item) => item.id), [client.id]);
    assert.equal(publisherClients[0]?.appType, "third_party_global");
    assert.equal(publisherClients[0]?.publishStatus, "private");

    const republishRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "Productivity & Collaboration",
        dataAccessSummary: "Profile and agent-readable content",
      }),
    });
    assert.equal(republishRequestRes.status, 200);
    const republishRequested = await republishRequestRes.json() as {
      publishStatus: string;
      humanMarketplaceVisible: boolean;
    };
    assert.equal(republishRequested.publishStatus, "publish_requested");
    assert.equal(republishRequested.humanMarketplaceVisible, false);

    const { client: republished } = await decidePublishReview({ clientId: client.id, reviewerUserId: reviewer.id, decision: "approve" });
    assert.equal(republished.appType, "third_party_global");
    assert.equal(republished.publishStatus, "published");
    assert.equal(republished.humanMarketplaceVisible, true);

    const marketplaceAfterRepublishRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "X-Server-Id": installerServer.id,
      },
    });
    assert.equal(marketplaceAfterRepublishRes.status, 200);
    const marketplaceAfterRepublish = await marketplaceAfterRepublishRes.json() as Array<{ id: string }>;
    assert.equal(marketplaceAfterRepublish.some((item) => item.id === client.id), true);

    const installsAfterRepublish = await getDb()
      .select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(eq(oauthClientInstalls.clientId, client.id));
    assert.equal(installsAfterRepublish.length, 1);

    const lifecycleAuditRows = await getDb()
      .select({
        eventType: integrationAuditEvents.eventType,
        serverId: integrationAuditEvents.serverId,
        actorId: integrationAuditEvents.actorId,
        metadata: integrationAuditEvents.metadata,
      })
      .from(integrationAuditEvents)
      .where(and(
        eq(integrationAuditEvents.clientId, client.id),
        inArray(integrationAuditEvents.eventType, [
          "app.publish_requested",
          "app.publish_approved",
          "app.offline_requested",
          "app.offline_approved",
          "app.offline_rejected",
          "marketplace.installed",
          "marketplace.uninstalled",
        ]),
      ));
    const lifecycleEventTypes = lifecycleAuditRows.map((row) => row.eventType);
    for (const eventType of [
      "app.publish_requested",
      "app.publish_approved",
      "app.offline_requested",
      "app.offline_approved",
      "app.offline_rejected",
      "marketplace.installed",
      "marketplace.uninstalled",
    ]) {
      assert.ok(lifecycleEventTypes.includes(eventType), `${eventType} should be visible in the app audit trail`);
    }
    assert.ok(lifecycleAuditRows.some((row) => {
      const metadata = row.metadata as { clientKey?: string; targetServerId?: string };
      return row.eventType === "marketplace.installed"
        && row.serverId === installerServer.id
        && row.actorId === installer.id
        && metadata.clientKey === client.clientId
        && metadata.targetServerId === installerServer.id;
    }));
    assert.ok(lifecycleAuditRows.some((row) => {
      const metadata = row.metadata as { installedCount?: number; nextPublishStatus?: string };
      return row.eventType === "app.publish_approved"
        && row.actorId === reviewer.id
        && metadata.nextPublishStatus === "published"
        && metadata.installedCount === 1;
    }));
  } finally {
    await app.close();
  }
});

test("private shared app invites install canonical third-party clients without marketplace discovery", async ({ app }) => {
  const suffix = randomUUID();
  const publisher = await seedUser(`integrations-share-publisher-${suffix}@slock.test`, `Share Publisher ${suffix}`);
  const installer = await seedUser(`integrations-share-installer-${suffix}@slock.test`, `Share Installer ${suffix}`);
  const member = await seedUser(`integrations-share-member-${suffix}@slock.test`, `Share Member ${suffix}`);
  const outsider = await seedUser(`integrations-share-outsider-${suffix}@slock.test`, `Share Outsider ${suffix}`);
  const publisherServer = await createServer("Private Share Publisher", `share-publisher-${suffix}`, publisher.id);
  const installerServer = await createServer("Private Share Installer", `share-installer-${suffix}`, installer.id);
  const outsiderServer = await createServer("Private Share Outsider", `share-outsider-${suffix}`, outsider.id);
  await addMember(publisherServer.id, member.id, "member");
  await addMember(installerServer.id, member.id, "member");

  const agent = await createAgent(installerServer.id, "PrivateShareBot", {
    runtime: "claude",
    model: "sonnet",
  });
  const { client, clientSecret } = await createOAuthClient({
    serverId: publisherServer.id,
    createdByUserId: publisher.id,
    clientId: `share-${suffix.slice(0, 8)}`,
    name: "Private Shared App",
    description: "Invite-only app",
    homepageUrl: "https://private-share.example.test",
    returnUrl: "https://private-share.example.test/callback",
    allowedScopes: ["openid", "profile", "identity", "agent:event:write", "agent:notification:write"],
  });

  const publisherToken = await tokenForHuman(publisher.email);
  const installerToken = await tokenForHuman(installer.email);
  const memberToken = await tokenForHuman(member.email);
  const outsiderToken = await tokenForHuman(outsider.email);

  const marketplaceBeforeShareRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "X-Server-Id": installerServer.id,
    },
  });
  assert.equal(marketplaceBeforeShareRes.status, 200);
  const marketplaceBeforeShare = await marketplaceBeforeShareRes.json() as Array<{ id: string }>;
  assert.equal(marketplaceBeforeShare.some((item) => item.id === client.id), false);

  const memberShareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${memberToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targetServerSlug: installerServer.slug }),
  });
  assert.equal(memberShareRes.status, 403);

  // A link always names its one target Server.
  const untargetedShareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresInDays: 14 }),
  });
  assert.equal(untargetedShareRes.status, 400);
  assert.equal((await untargetedShareRes.json() as { code: string }).code, "share_link_target_required");
  assert.equal((await getDb().select({ id: oauthClientShareLinks.id }).from(oauthClientShareLinks)
    .where(eq(oauthClientShareLinks.clientId, client.id))).length, 0, "a refused create stores nothing");

  const shareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    // Typed loosely: stored trimmed and lowercased.
    body: JSON.stringify({ expiresInDays: 14, targetServerSlug: ` ${installerServer.slug.toUpperCase()} ` }),
  });
  assert.equal(shareRes.status, 200);
  const shareText = await shareRes.clone().text();
  const share = await shareRes.json() as {
    client: { id: string; appType: string; publishStatus: string; humanMarketplaceVisible: boolean; clientSecret?: string };
    link: { id: string; targetServerSlug: string | null; expiresAt: string | null; revokedAt: string | null; consumedAt: string | null };
    token: string;
  };
  assert.equal(share.link.targetServerSlug, installerServer.slug);
  assert.equal(share.link.consumedAt, null);
  assert.equal(shareText.includes(installerServer.id), false, "creation never echoes the resolved target id");
  assert.equal(shareText.includes(installerServer.name), false, "creation never echoes the resolved target name");
  assert.equal(share.client.id, client.id);
  assert.equal(share.client.appType, "third_party_global");
  assert.equal(share.client.publishStatus, "private");
  assert.equal(share.client.humanMarketplaceVisible, false);
  assert.equal(share.client.clientSecret, undefined);
  assert.match(share.token, /^raft_share_[0-9a-f]{64}$/);
  assert.equal(share.link.revokedAt, null);

  const shareLinkRows = await getDb().select({ id: oauthClientShareLinks.id, targetServerId: oauthClientShareLinks.targetServerId })
    .from(oauthClientShareLinks).where(eq(oauthClientShareLinks.clientId, client.id));
  assert.deepEqual(shareLinkRows, [{ id: share.link.id, targetServerId: installerServer.id }], "the slug resolved to the target Server at creation");

  const activeShareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
    },
  });
  assert.equal(activeShareRes.status, 200);
  const activeShare = await activeShareRes.json() as { links: Array<{ id: string; targetServerSlug: string | null; token?: string; targetServerId?: string }> };
  assert.deepEqual(activeShare.links.map((link) => [link.id, link.targetServerSlug]), [[share.link.id, installerServer.slug]]);
  assert.equal(activeShare.links[0]?.token, undefined);
  assert.equal(activeShare.links[0]?.targetServerId, undefined);

  const publisherMarketplaceRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
    },
  });
  assert.equal(publisherMarketplaceRes.status, 200);
  // Listed for the publisher only as its own installation (Installed tab,
  // Review permissions; #triage:59b61529): a private share, never in the
  // Marketplace tab.
  const publisherMarketplace = await publisherMarketplaceRes.json() as Array<{ id: string; privateShared: boolean; installStatus: string | null }>;
  const publisherOwnRow = publisherMarketplace.find((item) => item.id === client.id);
  assert.equal(publisherOwnRow?.privateShared, true);
  assert.equal(publisherOwnRow?.installStatus, "active");

  const publisherUninstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
    },
  });
  assert.equal(publisherUninstallRes.status, 404);

  const sourceInstallRows = await getDb()
    .select({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, client.id));
  assert.deepEqual(sourceInstallRows.map((row) => row.serverId), [publisherServer.id]);

  const marketplaceBeforeInstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "X-Server-Id": installerServer.id,
    },
  });
  assert.equal(marketplaceBeforeInstallRes.status, 200);
  const marketplaceBeforeInstall = await marketplaceBeforeInstallRes.json() as Array<{ id: string }>;
  assert.equal(marketplaceBeforeInstall.some((item) => item.id === client.id), false);

  const agentRequestBeforeInstall = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      serverSlug: installerServer.slug,
      agentName: agent.name,
      scopes: ["openid", "profile", "identity"],
    }),
  });
  assert.equal(agentRequestBeforeInstall.status, 404);

  // Someone outside the target sees exactly what a bad token gets; a plain
  // member of the target is told whom to ask.
  const badTokenInviteRes = await fetch(`${app.baseUrl}/api/integration-invites/raft_share_${"0".repeat(64)}`, {
    headers: { Authorization: `Bearer ${installerToken}` },
  });
  assert.equal(badTokenInviteRes.status, 404);
  const invalidInvite = await badTokenInviteRes.json();
  assert.deepEqual(invalidInvite, { error: "This private app invite is invalid or has expired", code: "private_app_invite_invalid" });
  const outsiderInviteBeforeRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}`, {
    headers: { Authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(outsiderInviteBeforeRes.status, 404);
  assert.deepEqual(await outsiderInviteBeforeRes.json(), invalidInvite);
  const adminRequired = {
    error: `An owner or admin of ${installerServer.name} needs to install this app`,
    code: "private_app_invite_admin_required",
    targetServer: { name: installerServer.name, slug: installerServer.slug },
  };
  const memberInviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  assert.equal(memberInviteRes.status, 403);
  assert.deepEqual(await memberInviteRes.json(), adminRequired);

  const inviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}`, {
    headers: { Authorization: `Bearer ${installerToken}` },
  });
  assert.equal(inviteRes.status, 200);
  const invite = await inviteRes.json() as {
    client: { id: string; appType: string; publishStatus: string; publisherName: string | null; sourceServerName: string | null; allowedScopes: string[] | null; clientSecret?: string };
    manageableServers: Array<{ id: string; role: string; installedAt: string | null }>;
  };
  assert.equal(invite.client.id, client.id);
  assert.equal(invite.client.appType, "third_party_global");
  assert.equal(invite.client.publishStatus, "private");
  assert.equal(invite.client.publisherName, publisher.displayName);
  assert.equal(invite.client.sourceServerName, publisherServer.name);
  assert.deepEqual(invite.client.allowedScopes, ["agent:event:write", "agent:notification:write", "identity", "openid", "profile"]);
  assert.equal(invite.client.clientSecret, undefined);
  assert.deepEqual(invite.manageableServers.map((server) => server.id), [installerServer.id]);
  assert.equal(invite.manageableServers[0]?.role, "owner");
  assert.equal(invite.manageableServers[0]?.installedAt, null);

  const refusedInstalls: Array<[string, string, number, unknown]> = [
    [memberToken, installerServer.id, 403, adminRequired], // the target, without owner/admin
    [outsiderToken, outsiderServer.id, 404, invalidInvite], // an owner, of another Server
  ];
  for (const [token, serverId, status, body] of refusedInstalls) {
    const res = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverId, ...await expectedAppPermissionsBody(client.id) }),
    });
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), body);
  }
  assert.deepEqual((await getDb().select({ serverId: oauthClientInstalls.serverId }).from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, client.id))).map((row) => row.serverId), [publisherServer.id]);

  const installRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ serverId: installerServer.id, ...await expectedAppPermissionsBody(client.id) }),
  });
  assert.equal(installRes.status, 200);
  const installedInvite = await installRes.json() as {
    client: { id: string; installedAt: string | null };
    manageableServers: Array<{ id: string; installedAt: string | null }>;
  };
  assert.equal(installedInvite.client.id, client.id);
  assert.ok(installedInvite.client.installedAt);
  assert.ok(installedInvite.manageableServers[0]?.installedAt);

  // Single use: the install spent the link.
  const [usedLink] = await getDb().select().from(oauthClientShareLinks).where(eq(oauthClientShareLinks.id, share.link.id));
  assert.ok(usedLink?.consumedAt);
  assert.ok(usedLink?.revokedAt);
  const reinstallRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ serverId: installerServer.id, ...await expectedAppPermissionsBody(client.id) }),
  });
  assert.equal(reinstallRes.status, 404);
  assert.deepEqual(await reinstallRes.json(), invalidInvite);
  const usedInviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}`, {
    headers: { Authorization: `Bearer ${installerToken}` },
  });
  assert.equal(usedInviteRes.status, 404);
  const linksAfterUseRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    headers: { Authorization: `Bearer ${publisherToken}`, "X-Server-Id": publisherServer.id },
  });
  assert.deepEqual(await linksAfterUseRes.json(), { links: [] });

  const installedRows = await getDb()
    .select({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, client.id));
  assert.deepEqual(installedRows.map((row) => row.serverId).sort(), [installerServer.id, publisherServer.id].sort());

  const marketplaceAfterInstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "X-Server-Id": installerServer.id,
    },
  });
  assert.equal(marketplaceAfterInstallRes.status, 200);
  const marketplaceAfterInstall = await marketplaceAfterInstallRes.json() as Array<{ id: string; installedAt: string | null; privateShared: boolean }>;
  const installedListing = marketplaceAfterInstall.find((item) => item.id === client.id);
  assert.ok(installedListing?.installedAt);
  assert.equal(installedListing?.privateShared, true);

  const outsiderMarketplaceRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
    headers: {
      Authorization: `Bearer ${outsiderToken}`,
      "X-Server-Id": outsiderServer.id,
    },
  });
  assert.equal(outsiderMarketplaceRes.status, 200);
  const outsiderMarketplace = await outsiderMarketplaceRes.json() as Array<{ id: string }>;
  assert.equal(outsiderMarketplace.some((item) => item.id === client.id), false);

  const agentRequestAfterInstall = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      serverSlug: installerServer.slug,
      agentName: agent.name,
      scopes: ["openid", "profile", "identity"],
    }),
  });
  assert.equal(agentRequestAfterInstall.status, 200);

  const humanAuthorizeAfterInstall = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      clientId: client.clientId,
      serverId: installerServer.id,
      scopes: ["openid", "profile"],
    }),
  });
  assert.equal(humanAuthorizeAfterInstall.status, 200);

  // A revoked link is refused; revoking leaves the installation it made alone.
  const outsiderShareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targetServerSlug: outsiderServer.slug }),
  });
  assert.equal(outsiderShareRes.status, 200);
  const outsiderShare = await outsiderShareRes.json() as { link: { id: string }; token: string };
  const outsiderInviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${outsiderShare.token}`, {
    headers: { Authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(outsiderInviteRes.status, 200);
  const revokeShareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links/${outsiderShare.link.id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
    },
  });
  assert.equal(revokeShareRes.status, 200);

  const inviteAfterRevokeRes = await fetch(`${app.baseUrl}/api/integration-invites/${outsiderShare.token}`, {
    headers: { Authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(inviteAfterRevokeRes.status, 404);
  assert.deepEqual(await inviteAfterRevokeRes.json(), invalidInvite);

  const agentRequestAfterRevoke = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      serverSlug: installerServer.slug,
      agentName: agent.name,
      scopes: ["openid", "profile", "identity"],
    }),
  });
  assert.equal(agentRequestAfterRevoke.status, 200);

  const uninstallRes = await fetch(`${app.baseUrl}/api/integrations/marketplace/${client.id}/install`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${installerToken}`,
      "X-Server-Id": installerServer.id,
    },
  });
  assert.equal(uninstallRes.status, 200);
  const privateShareUninstalled = await uninstallRes.json() as { revokedGrantCount: number; revokedTokenCount: number; deniedPendingRequestCount: number };

  const installRowsAfterUninstall = await getDb()
    .select({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, client.id));
  assert.deepEqual(installRowsAfterUninstall.map((row) => row.serverId), [publisherServer.id]);

  const agentRequestAfterUninstall = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      serverSlug: installerServer.slug,
      agentName: agent.name,
      scopes: ["openid", "profile", "identity"],
    }),
  });
  assert.equal(agentRequestAfterUninstall.status, 404);

  const publisherClientsRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
    },
  });
  assert.equal(publisherClientsRes.status, 200);
  const publisherClients = await publisherClientsRes.json() as Array<{ id: string; appType: string; publishStatus: string }>;
  assert.deepEqual(publisherClients.map((item) => item.id), [client.id]);
  assert.equal(publisherClients[0]?.appType, "third_party_global");
  assert.equal(publisherClients[0]?.publishStatus, "private");

  const deleteSharedAppRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
    },
  });
  assert.equal(deleteSharedAppRes.status, 200);

  const installRowsAfterDelete = await getDb()
    .select({ serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, client.id));
  assert.deepEqual(installRowsAfterDelete, []);

  const auditRows = await getDb()
    .select({
      eventType: integrationAuditEvents.eventType,
      serverId: integrationAuditEvents.serverId,
      actorId: integrationAuditEvents.actorId,
      metadata: integrationAuditEvents.metadata,
    })
    .from(integrationAuditEvents)
    .where(inArray(integrationAuditEvents.eventType, [
      "private_share.link_created",
      "private_share.installed",
      "private_share.link_revoked",
      "private_share.uninstalled",
      "app.deleted",
    ]));
  assert.deepEqual(auditRows.map((row) => row.eventType).sort(), [
    "app.deleted",
    "private_share.installed",
    "private_share.link_created",
    "private_share.link_created",
    "private_share.link_revoked",
    "private_share.uninstalled",
  ]);
  const linkCreatedAudit = auditRows.find((row) => row.eventType === "private_share.link_created" && row.metadata.shareLinkId === share.link.id);
  assert.equal(linkCreatedAudit?.serverId, publisherServer.id);
  assert.equal(linkCreatedAudit?.actorId, publisher.id);
  assert.equal(linkCreatedAudit?.metadata.clientKey, client.clientId);
  assert.equal(linkCreatedAudit?.metadata.targetServerSlug, installerServer.slug);
  assert.equal("targetServerId" in (linkCreatedAudit?.metadata ?? {}), false, "the source Server's audit never says whether the slug resolved");
  assert.equal("token" in (linkCreatedAudit?.metadata ?? {}), false);
  assert.equal("tokenHash" in (linkCreatedAudit?.metadata ?? {}), false);

  const installedAudit = auditRows.find((row) => row.eventType === "private_share.installed");
  assert.equal(installedAudit?.serverId, installerServer.id);
  assert.equal(installedAudit?.actorId, installer.id);
  assert.equal(installedAudit?.metadata.sourceServerId, publisherServer.id);
  assert.equal(installedAudit?.metadata.targetServerId, installerServer.id);

  const uninstalledAudit = auditRows.find((row) => row.eventType === "private_share.uninstalled");
  assert.equal(uninstalledAudit?.serverId, installerServer.id);
  assert.equal(uninstalledAudit?.metadata.revokedGrantCount, privateShareUninstalled.revokedGrantCount);
  assert.equal(uninstalledAudit?.metadata.revokedTokenCount, privateShareUninstalled.revokedTokenCount);
  assert.equal(uninstalledAudit?.metadata.deniedPendingRequestCount, privateShareUninstalled.deniedPendingRequestCount);

  const deletedAudit = auditRows.find((row) => row.eventType === "app.deleted");
  assert.equal(deletedAudit?.serverId, publisherServer.id);
  assert.equal(deletedAudit?.actorId, publisher.id);
  assert.equal(deletedAudit?.metadata.clientKey, client.clientId);
  assert.equal(deletedAudit?.metadata.appType, "third_party_global");
});

test("private shared app publish request is idempotent after share converts it to third-party global", async ({ app }) => {
  const suffix = randomUUID();
  const publisher = await seedUser(`integrations-share-publish-${suffix}@slock.test`, `Share Publish ${suffix}`);
  const publisherServer = await createServer("Private Share Publish", `share-publish-${suffix}`, publisher.id);
  const { client } = await createOAuthClient({
    serverId: publisherServer.id,
    createdByUserId: publisher.id,
    clientId: `share-publish-${suffix.slice(0, 8)}`,
    name: "Private Shared Publish App",
    description: "Invite-only app requesting public review",
    homepageUrl: "https://private-share-publish.example.test",
    returnUrl: "https://private-share-publish.example.test/callback",
    category: "Productivity & Collaboration",
    allowedScopes: ["openid", "profile"],
  });

  const publisherToken = await tokenForHuman(publisher.email);

  const shareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresInDays: 14, targetServerSlug: `share-publish-elsewhere-${suffix.slice(0, 8)}` }),
  });
  assert.equal(shareRes.status, 200);
  const share = await shareRes.json() as {
    client: { id: string; appType: string; publishStatus: string; humanMarketplaceVisible: boolean };
  };
  assert.equal(share.client.id, client.id);
  assert.equal(share.client.appType, "third_party_global");
  assert.equal(share.client.publishStatus, "private");
  assert.equal(share.client.humanMarketplaceVisible, false);

  const requestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      category: "Productivity & Collaboration",
      dataAccessSummary: "Profile and invite-installed server context",
    }),
  });
  assert.equal(requestRes.status, 200);
  const requested = await requestRes.json() as {
    id: string;
    appType: string;
    publishStatus: string;
    category: string;
    dataAccessSummary: string | null;
  };
  assert.equal(requested.id, client.id);
  assert.equal(requested.appType, "third_party_global");
  assert.equal(requested.publishStatus, "publish_requested");
  assert.equal(requested.category, "Productivity & Collaboration");
  assert.equal(requested.dataAccessSummary, null);

  const repeatRequestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publisherToken}`,
      "X-Server-Id": publisherServer.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      category: "Automation",
      dataAccessSummary: "Repeated submit must not rewrite the queued review request",
    }),
  });
  assert.equal(repeatRequestRes.status, 200);
  const repeatRequested = await repeatRequestRes.json() as {
    id: string;
    appType: string;
    publishStatus: string;
    category: string;
    dataAccessSummary: string | null;
  };
  assert.equal(repeatRequested.id, client.id);
  assert.equal(repeatRequested.appType, "third_party_global");
  assert.equal(repeatRequested.publishStatus, "publish_requested");
  assert.equal(repeatRequested.category, "Productivity & Collaboration");
  assert.equal(repeatRequested.dataAccessSummary, null);
});

test("publish review and private sharing remain compatible in either order", async ({ app }) => {

  try {
    const suffix = randomUUID();
    const publisher = await seedUser(`integrations-review-share-publisher-${suffix}@slock.test`, `Review Share Publisher ${suffix}`);
    const installer = await seedUser(`integrations-review-share-installer-${suffix}@slock.test`, `Review Share Installer ${suffix}`);
    const reviewer = await seedUser(`integrations-review-share-reviewer-${suffix}@slock.test`, `Review Share Reviewer ${suffix}`);
    const publisherServer = await createServer("Review Then Share Publisher", `review-share-publisher-${suffix}`, publisher.id);
    const installerServer = await createServer("Review Then Share Installer", `review-share-installer-${suffix}`, installer.id);
    await addMember(publisherServer.id, reviewer.id, "admin");

    const localOnly = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: publisher.id,
      clientId: `local-reject-${suffix.slice(0, 8)}`,
      name: "Local Only Rejected App",
      description: "Never shared outside its source server",
      homepageUrl: "https://local-only-rejected.example.test",
      returnUrl: "https://local-only-rejected.example.test/callback",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile"],
    });
    const reviewThenShare = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: publisher.id,
      clientId: `review-share-${suffix.slice(0, 8)}`,
      name: "Review Then Share App",
      description: "Requests public review before creating a private invite",
      homepageUrl: "https://review-then-share.example.test",
      returnUrl: "https://review-then-share.example.test/callback",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile"],
    });

    const publisherToken = await tokenForHuman(publisher.email);
    const installerToken = await tokenForHuman(installer.email);

    for (const clientId of [localOnly.client.id, reviewThenShare.client.id]) {
      const requestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${clientId}/request-publish`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${publisherToken}`,
          "X-Server-Id": publisherServer.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.equal(requestRes.status, 200);
    }

    const { client: localRejected } = await decidePublishReview({
      clientId: localOnly.client.id, reviewerUserId: reviewer.id, decision: "reject", reason: "Remain local",
    });
    assert.equal(localRejected.appType, "server_local");
    assert.equal(localRejected.publishStatus, "rejected");

    const shareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${reviewThenShare.client.id}/share-links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresInDays: 14, targetServerSlug: installerServer.slug }),
    });
    assert.equal(shareRes.status, 200);
    const share = await shareRes.json() as {
      token: string;
      client: { appType: string; publishStatus: string; humanMarketplaceVisible: boolean };
    };
    assert.equal(share.client.appType, "third_party_global");
    assert.equal(share.client.publishStatus, "publish_requested");
    assert.equal(share.client.humanMarketplaceVisible, false);

    const inviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}`, {
      headers: { Authorization: `Bearer ${installerToken}` },
    });
    assert.equal(inviteRes.status, 200);

    const installRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverId: installerServer.id, ...await expectedAppPermissionsBody(reviewThenShare.client.id) }),
    });
    assert.equal(installRes.status, 200);

    const requestedRows = await getDb()
      .select({ appType: oauthClients.appType, publishStatus: oauthClients.publishStatus })
      .from(oauthClients)
      .where(eq(oauthClients.id, reviewThenShare.client.id));
    assert.deepEqual(requestedRows, [{ appType: "third_party_global", publishStatus: "publish_requested" }]);

    const installedRows = await getDb()
      .select({ serverId: oauthClientInstalls.serverId })
      .from(oauthClientInstalls)
      .where(eq(oauthClientInstalls.clientId, reviewThenShare.client.id));
    assert.deepEqual(installedRows.map((row) => row.serverId).sort(), [publisherServer.id, installerServer.id].sort());
  } finally {
    await app.close();
  }
});

test("private share installs survive marketplace review and keep invite installs available", async ({ app }) => {

  try {
    const suffix = randomUUID();
    const publisher = await seedUser(`integrations-share-review-publisher-${suffix}@slock.test`, `Share Review Publisher ${suffix}`);
    const installedOwner = await seedUser(`integrations-share-review-installed-${suffix}@slock.test`, `Share Review Installed ${suffix}`);
    const pendingOwner = await seedUser(`integrations-share-review-pending-${suffix}@slock.test`, `Share Review Pending ${suffix}`);
    const outsider = await seedUser(`integrations-share-review-outsider-${suffix}@slock.test`, `Share Review Outsider ${suffix}`);
    const reviewer = await seedUser(`integrations-share-review-reviewer-${suffix}@slock.test`, `Share Review Reviewer ${suffix}`);
    const publisherServer = await createServer("Share Review Publisher", `share-review-publisher-${suffix}`, publisher.id);
    const installedServer = await createServer("Share Review Installed", `share-review-installed-${suffix}`, installedOwner.id);
    const pendingServer = await createServer("Share Review Pending", `share-review-pending-${suffix}`, pendingOwner.id);
    const outsiderServer = await createServer("Share Review Outsider", `share-review-outsider-${suffix}`, outsider.id);
    await addMember(publisherServer.id, reviewer.id, "admin");
    const installedAgent = await createAgent(installedServer.id, "ShareReviewBot", {
      runtime: "claude",
      model: "sonnet",
    });
    const { client, clientSecret } = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: publisher.id,
      clientId: `share-review-${suffix.slice(0, 8)}`,
      name: "Private Shared Review App",
      description: "Invite-installed app requesting public marketplace review",
      homepageUrl: "https://private-share-review.example.test",
      returnUrl: "https://private-share-review.example.test/callback",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile", "identity"],
    });

    const publisherToken = await tokenForHuman(publisher.email);
    const installedToken = await tokenForHuman(installedOwner.email);
    const pendingToken = await tokenForHuman(pendingOwner.email);
    const outsiderToken = await tokenForHuman(outsider.email);

    const createShare = async (targetServerSlug: string) => {
      const res = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${publisherToken}`,
          "X-Server-Id": publisherServer.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresInDays: 14, targetServerSlug }),
      });
      assert.equal(res.status, 200);
      return await res.json() as { token: string };
    };
    // One link per target Server; both stay active side by side.
    const share = await createShare(installedServer.slug);
    const pendingShare = await createShare(pendingServer.slug);

    const installRes = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverId: installedServer.id, ...await expectedAppPermissionsBody(client.id) }),
    });
    assert.equal(installRes.status, 200);

    const humanAuthorizeRes = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: installedServer.id,
        scopes: ["openid", "profile"],
      }),
    });
    assert.equal(humanAuthorizeRes.status, 200);

    const requestRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/request-publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(requestRes.status, 200);
    const requested = await requestRes.json() as { appType: string; publishStatus: string };
    assert.equal(requested.appType, "third_party_global");
    assert.equal(requested.publishStatus, "publish_requested");

    const renameRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Private Shared Review App Renamed" }),
    });
    assert.equal(renameRes.status, 200);

    const requestedInviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${pendingShare.token}`, {
      headers: { Authorization: `Bearer ${pendingToken}` },
    });
    assert.equal(requestedInviteRes.status, 200);
    const requestedInvite = await requestedInviteRes.json() as { client: { id: string; name: string; publishStatus: string } };
    assert.equal(requestedInvite.client.id, client.id);
    assert.equal(requestedInvite.client.name, "Private Shared Review App Renamed");
    assert.equal(requestedInvite.client.publishStatus, "publish_requested");

    const installWhileRequestedRes = await fetch(`${app.baseUrl}/api/integration-invites/${pendingShare.token}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pendingToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverId: pendingServer.id, ...await expectedAppPermissionsBody(client.id) }),
    });
    assert.equal(installWhileRequestedRes.status, 200);

    const assertInstalledListing = async (token: string, serverId: string) => {
      const res = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": serverId,
        },
      });
      assert.equal(res.status, 200);
      const items = await res.json() as Array<{ id: string; name: string; installedAt: string | null; privateShared: boolean }>;
      const item = items.find((entry) => entry.id === client.id);
      assert.ok(item?.installedAt);
      assert.equal(item?.name, "Private Shared Review App Renamed");
      assert.equal(item?.privateShared, true);
    };
    await assertInstalledListing(installedToken, installedServer.id);
    await assertInstalledListing(pendingToken, pendingServer.id);

    const outsiderMarketplaceRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${outsiderToken}`,
        "X-Server-Id": outsiderServer.id,
      },
    });
    assert.equal(outsiderMarketplaceRes.status, 200);
    const outsiderMarketplace = await outsiderMarketplaceRes.json() as Array<{ id: string }>;
    assert.equal(outsiderMarketplace.some((entry) => entry.id === client.id), false);

    const agentRequestWhileRequestedRes = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret,
        serverSlug: installedServer.slug,
        agentName: installedAgent.name,
        scopes: ["openid", "profile", "identity"],
      }),
    });
    assert.equal(agentRequestWhileRequestedRes.status, 200);
    assert.ok(await authenticateOAuthClient(client.clientId, clientSecret));

    const beforeReject = {
      installs: await getDb().select({ id: oauthClientInstalls.id }).from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id)),
      grants: await getDb().select({ id: oauthGrants.id }).from(oauthGrants).where(and(eq(oauthGrants.clientId, client.id), eq(oauthGrants.serverId, installedServer.id))),
      tokens: await getDb().select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(and(eq(oauthAccessTokens.clientId, client.id), eq(oauthAccessTokens.serverId, installedServer.id))),
    };
    assert.equal(beforeReject.installs.length, 3);
    assert.ok(beforeReject.grants.length > 0);

    const { client: rejected } = await decidePublishReview({
      clientId: client.id, reviewerUserId: reviewer.id, decision: "reject", reason: "Not ready for public discovery",
    });
    assert.equal(rejected.appType, "third_party_global");
    assert.equal(rejected.publishStatus, "rejected");
    assert.equal(rejected.humanMarketplaceVisible, false);

    const replacementShareRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/share-links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publisherToken}`,
        "X-Server-Id": publisherServer.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresInDays: 14, targetServerSlug: outsiderServer.slug }),
    });
    assert.equal(replacementShareRes.status, 200);
    const replacementShare = await replacementShareRes.json() as { token: string };

    const rejectedInviteRes = await fetch(`${app.baseUrl}/api/integration-invites/${replacementShare.token}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    assert.equal(rejectedInviteRes.status, 200);
    const rejectedInvite = await rejectedInviteRes.json() as { client: { id: string; name: string; publishStatus: string } };
    assert.equal(rejectedInvite.client.id, client.id);
    assert.equal(rejectedInvite.client.name, "Private Shared Review App Renamed");
    assert.equal(rejectedInvite.client.publishStatus, "rejected");

    await assertInstalledListing(installedToken, installedServer.id);
    await assertInstalledListing(pendingToken, pendingServer.id);
    assert.ok(await authenticateOAuthClient(client.clientId, clientSecret));

    const afterReject = {
      installs: await getDb().select({ id: oauthClientInstalls.id }).from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id)),
      grants: await getDb().select({ id: oauthGrants.id }).from(oauthGrants).where(and(eq(oauthGrants.clientId, client.id), eq(oauthGrants.serverId, installedServer.id))),
      tokens: await getDb().select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(and(eq(oauthAccessTokens.clientId, client.id), eq(oauthAccessTokens.serverId, installedServer.id))),
    };
    assert.deepEqual(afterReject.installs.map((row) => row.id).sort(), beforeReject.installs.map((row) => row.id).sort());
    assert.deepEqual(afterReject.grants.map((row) => row.id).sort(), beforeReject.grants.map((row) => row.id).sort());
    assert.deepEqual(afterReject.tokens.map((row) => row.id).sort(), beforeReject.tokens.map((row) => row.id).sort());

    const outsiderMarketplaceAfterRejectRes = await fetch(`${app.baseUrl}/api/integrations/marketplace`, {
      headers: {
        Authorization: `Bearer ${outsiderToken}`,
        "X-Server-Id": outsiderServer.id,
      },
    });
    assert.equal(outsiderMarketplaceAfterRejectRes.status, 200);
    const outsiderMarketplaceAfterReject = await outsiderMarketplaceAfterRejectRes.json() as Array<{ id: string }>;
    assert.equal(outsiderMarketplaceAfterReject.some((entry) => entry.id === client.id), false);
  } finally {
    await app.close();
  }
});

test("integration request and grant mutations are scoped to the active server", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-scope-owner-${suffix}@slock.test`, `integrations-scope-owner-${suffix}`);
  const otherOwner = await seedUser(`integrations-scope-other-${suffix}@slock.test`, `integrations-scope-other-${suffix}`);
  const server = await createServer("Integrations Scope", `integrations-scope-${suffix}`, owner.id);
  const otherServer = await createServer("Integrations Scope Other", `integrations-scope-other-${suffix}`, otherOwner.id);
  const agent = await createAgent(server.id, "IntegrationsScopeBot", {
    runtime: "claude",
    model: "sonnet",
  });
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `scope-${suffix.slice(0, 8)}`,
    name: "Scope App",
    description: "Scope checks",
    homepageUrl: "https://scope.example.test",
    returnUrl: "https://scope.example.test/callback",
  });
  const [request] = await getDb().insert(oauthAccessRequests).values({
    serverId: server.id,
    principalType: "agent",
    agentId: agent.id,
    clientId: client.id,
    scopes: ["openid", "profile"],
    status: "pending",
    remember: true,
  }).returning();
  const [grant] = await getDb().insert(oauthGrants).values({
    serverId: server.id,
    agentId: agent.id,
    clientId: client.id,
    scopes: ["openid", "profile"],
    grantedByUserId: owner.id,
  }).returning();

  const ownerToken = await tokenForHuman(owner.email);
  const otherOwnerToken = await tokenForHuman(otherOwner.email);
  const mutate = (path: string, token: string, serverId: string, body?: unknown) => fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  const wrongApprove = await mutate(`/api/integrations/requests/${request.id}/approve`, otherOwnerToken, otherServer.id, { remember: true });
  assert.equal(wrongApprove.status, 404);
  const wrongDeny = await mutate(`/api/integrations/requests/${request.id}/deny`, otherOwnerToken, otherServer.id);
  assert.equal(wrongDeny.status, 404);
  const wrongRevoke = await mutate(`/api/integrations/grants/${grant.id}/revoke`, otherOwnerToken, otherServer.id);
  assert.equal(wrongRevoke.status, 404);

  const [requestAfterWrongServer] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, request.id));
  assert.equal(requestAfterWrongServer?.status, "pending");
  assert.equal(requestAfterWrongServer?.resolvedByUserId, null);
  const [grantAfterWrongServer] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.id, grant.id));
  assert.equal(grantAfterWrongServer?.revokedAt, null);

  const approve = await mutate(`/api/integrations/requests/${request.id}/approve`, ownerToken, server.id, { remember: true });
  assert.equal(approve.status, 200);
  const revoke = await mutate(`/api/integrations/grants/${grant.id}/revoke`, ownerToken, server.id);
  assert.equal(revoke.status, 200);
});

test("DELETE /api/integrations/clients/:clientId removes a server-local app and revokes issued access", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`integrations-delete-owner-${suffix}@slock.test`, `integrations-delete-owner-${suffix}`);
  const member = await seedUser(`integrations-delete-member-${suffix}@slock.test`, `integrations-delete-member-${suffix}`);
  const otherOwner = await seedUser(`integrations-delete-other-${suffix}@slock.test`, `integrations-delete-other-${suffix}`);
  const server = await createServer("Integrations Delete", `integrations-delete-${suffix}`, owner.id);
  const otherServer = await createServer("Integrations Delete Other", `integrations-delete-other-${suffix}`, otherOwner.id);
  await addMember(server.id, member.id, "member");
  const agent = await createAgent(server.id, "IntegrationsDeleteBot", {
    runtime: "claude",
    model: "sonnet",
  });
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `delete-${suffix.slice(0, 8)}`,
    name: "Delete App",
    description: "Delete me",
    homepageUrl: "https://delete.example.test",
    returnUrl: "https://delete.example.test/callback",
  });
  const { client: builtInClient } = await seedRetiredBuiltInOAuthClient({
    serverId: otherServer.id,
    createdByUserId: otherOwner.id,
    clientId: `builtin-${suffix.slice(0, 8)}`,
    name: "Built-in App",
    description: "Platform-owned",
    homepageUrl: "https://builtin.example.test",
    returnUrl: "https://builtin.example.test/callback",
  });

  const requested = await fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      serverSlug: server.slug,
      agentName: agent.name,
      scopes: ["openid", "profile", "identity"],
    }),
  });
  assert.equal(requested.status, 200);
  const requestBody = await requested.json() as { requestId: string };

  const token = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      grantType: "urn:slock:grant-type:agent_request",
      requestId: requestBody.requestId,
    }),
  });
  assert.equal(token.status, 200);
  const tokenBody = await token.json() as { access_token: string };

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const otherOwnerToken = await tokenForHuman(otherOwner.email);
  const del = (tokenValue: string, serverId: string) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${tokenValue}`,
      "X-Server-Id": serverId,
    },
  });

  const memberRes = await del(memberToken, server.id);
  assert.equal(memberRes.status, 403);

  const wrongServerRes = await del(otherOwnerToken, otherServer.id);
  assert.equal(wrongServerRes.status, 404);

  const builtInDelete = await fetch(`${app.baseUrl}/api/integrations/clients/${builtInClient.id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${otherOwnerToken}`,
      "X-Server-Id": otherServer.id,
    },
  });
  assert.equal(builtInDelete.status, 404);
  const builtInRows = await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, builtInClient.id));
  assert.equal(builtInRows.length, 1);

  const ownerRes = await del(ownerToken, server.id);
  assert.equal(ownerRes.status, 200);
  const deleted = await ownerRes.json() as { id: string; clientId: string; clientSecret?: string };
  assert.equal(deleted.id, client.id);
  assert.equal(deleted.clientId, client.clientId);
  assert.equal(deleted.clientSecret, undefined);

  const clientRows = await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(clientRows.length, 0);

  const grants = await getDb()
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(eq(oauthGrants.clientId, client.id));
  assert.equal(grants.length, 0);

  const tokens = await getDb()
    .select({ id: oauthAccessTokens.id })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.clientId, client.id));
  assert.equal(tokens.length, 0);

  const userinfo = await fetch(`${app.baseUrl}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  assert.equal(userinfo.status, 401);

  const secondDelete = await del(ownerToken, server.id);
  assert.equal(secondDelete.status, 404);
});

test("server-local permission save atomically installs its source and grants installation reads", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`local-${suffix}@slock.test`, `local-${suffix}`);
  const member = await seedUser(`local-member-${suffix}@slock.test`, `local-member-${suffix}`);
  const server = await createServer("Local App", `local-${suffix}`, owner.id);
  const foreign = await createServer("Other Server", `other-${suffix}`, owner.id);
  await addMember(server.id, member.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, name: "Local App", clientId: `local-${suffix}`,
  });
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const headers = (token: string, serverId = server.id) => ({
    Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json",
  });
  const localAgent = await createAgent(server.id, "LocalAppVisible", { runtime: "external", model: "sonnet" });
  const foreignAgent = await createAgent(foreign.id, "LocalAppHidden", { runtime: "codex" });
  // Another person's personal assistant: only its owner finds it, never an App.
  const assistant = await createAgent(server.id, "LocalAppAssistant", { runtime: "codex", creatorType: "user", creatorId: member.id, kind: "personal_assistant" });
  await getDb().update(agents).set({ assistantOwnerUserId: member.id }).where(eq(agents.id, assistant.id));
  const permissionUrl = `${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions`;
  const save = (token: string, serverId = server.id, groups = ["agent"], events = groups.includes("agent") ? ["agent.status_changed"] : []) => fetch(permissionUrl, {
    method: "PUT", headers: headers(token, serverId),
    body: JSON.stringify({ groups, events }),
  });
  const installs = () => getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
  assert.equal((await save(memberToken)).status, 403);
  assert.equal((await save(ownerToken, foreign.id)).status, 403);
  assert.equal((await installs()).length, 0, "unauthorized saves must not create an installation");
  assert.equal((await save(ownerToken, server.id, ["agent"], [])).status, 200);
  assert.equal((await getDb().select().from(oauthAppWebhookConfigs).where(eq(oauthAppWebhookConfigs.clientId, client.id))).length, 0, "read-only App needs no webhook configuration");
  assert.equal((await getDb().select().from(oauthGrants).where(eq(oauthGrants.clientId, client.id))).length, 0, "App read needs no principal login grant");
  await getDb().update(agents).set({ avatarUrl: "pixel:random:installation-picture" }).where(eq(agents.id, localAgent.id));
  const [installation] = await installs();
  assert.ok(installation, "permission save must create the missing source installation");
  assert.equal(installation.serverId, server.id);
  assert.deepEqual(installation.approvedGroups, ["agent"]);
  const [savedClient] = await getDb().select().from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(savedClient.appType, "server_local", "installation must not change distribution");
  assert.equal(installation.approvedRequestRevisionId, savedClient.outboundCurrentRevisionId);
  assert.equal(savedClient.outboundPendingRevisionId, null);
  const readState = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications`, { headers: headers(ownerToken) });
  const state = await readState.json() as { source_installation: { installation_id: string; status: string; approved_groups: string[] } };
  assert.equal(state.source_installation.installation_id, installation.id);
  assert.equal(state.source_installation.status, "active");
  assert.deepEqual(state.source_installation.approved_groups, ["agent"]);
  const auth = { Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" };
  const mint = () => fetch(`${app.baseUrl}/api/oauth/installation-token`, {
    method: "POST", headers: auth, body: JSON.stringify({ installation_id: installation.id, groups: ["agent"] }),
  });
  const minted = await mint();
  assert.equal(minted.status, 200);
  const credential = await minted.json() as { access_token: string; installation_id: string; server_id: string };
  assert.equal(credential.installation_id, installation.id);
  assert.equal(credential.server_id, server.id);
  const read = () => fetch(`${app.baseUrl}/api/app-installation/agents`, { headers: { Authorization: `Bearer ${credential.access_token}` } });
  const { client: botClient } = await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, name: "Directory Bot App",
    clientId: `directory-bot-${suffix}`, enableBot: true,
  });
  const [botInstall] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id, clientId: botClient.id, installedByUserId: owner.id, status: "active", botGrant: "pending",
  }).returning();
  const setBot = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${botClient.id}/install/bot`, {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ action }),
  });
  const grant = await setBot("grant");
  assert.equal(grant.status, 200, await grant.clone().text());
  const bot = (await grant.json() as { bot: { agentId: string } }).bot;
  const agentRead = await read();
  assert.equal(agentRead.status, 200);
  const projected = await agentRead.json() as { agents: Array<{ id: string; avatar_url: string | null; runtime: string; model: string; is_app_bot: boolean }> };
  assert.ok(projected.agents.some((agent) => agent.id === localAgent.id));
  assert.equal(projected.agents.some((agent) => agent.id === foreignAgent.id), false);
  assert.equal(projected.agents.some((agent) => agent.id === assistant.id), false, "a personal assistant is not in an App's agent list");
  const localProjection = projected.agents.find((agent) => agent.id === localAgent.id)!;
  const botProjection = projected.agents.find((agent) => agent.id === bot.agentId)!;
  assert.deepEqual([localProjection.runtime, localProjection.model], [botProjection.runtime, botProjection.model], "the same runtime and model do not identify a Bot");
  assert.equal(localProjection.is_app_bot, false, "ordinary external Agent is not an App Bot");
  assert.equal(botProjection.is_app_bot, true, "an active managed Bot is marked");
  assert.equal(JSON.stringify(botProjection).includes(botInstall!.id), false, "do not disclose the managing installation");
  assert.equal("managed_by_app_install_id" in botProjection, false);
  assert.equal((await setBot("revoke")).status, 200);
  const disabled = await (await read()).json() as typeof projected;
  assert.equal(disabled.agents.some((agent) => agent.id === bot.agentId), false, "disabled Bots remain hidden");
  assert.equal((await setBot("grant")).status, 200);
  const reenabled = await (await read()).json() as typeof projected;
  assert.equal(reenabled.agents.find((agent) => agent.id === bot.agentId)?.is_app_bot, true);
  assert.match(localProjection.avatar_url!, /^https?:\/\//);
  const storedAvatar = await getDb().select({ avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.id, localAgent.id));
  assert.equal(storedAvatar[0].avatarUrl, "pixel:random:installation-picture", "normalization is a response projection, not a storage rewrite");
  const avatar = await fetch(`${app.baseUrl}${new URL(localProjection.avatar_url!).pathname}`);
  assert.equal(avatar.status, 200);
  assert.match(await avatar.text(), /<svg/);
  for (const [raw, expected] of [[null, null], ["https://[invalid", null], ["pixel:", null], ["https://images.example.test/avatar.png", "https://images.example.test/avatar.png"], ["/api/avatars/example.png", "/api/avatars/example.png"]] as const) {
    await getDb().update(agents).set({ avatarUrl: raw }).where(eq(agents.id, localAgent.id));
    const body = await (await read()).json() as { agents: typeof projected.agents };
    const entry = body.agents.find((agent) => agent.id === localAgent.id)!;
    if (expected === null) assert.equal(entry.avatar_url, null);
    else if (expected.startsWith("/")) assert.equal(new URL(entry.avatar_url!).pathname, expected);
    else assert.equal(entry.avatar_url, expected);
  }
  // Selecting events is a later, independent step; directory access already works.
  assert.equal((await save(ownerToken)).status, 200);

  const subscribe = await fetch(`${app.baseUrl}/api/oauth/installations/${installation.id}/subscriptions`, {
    method: "PUT", headers: auth, body: JSON.stringify({ events: ["agent.status_changed"] }),
  });
  assert.equal(subscribe.status, 200);
  const repeats = await Promise.all([save(ownerToken), save(ownerToken), save(ownerToken)]);
  assert.deepEqual(repeats.map((res) => res.status), [200, 200, 200]);
  assert.equal((await installs()).length, 1);
  assert.equal((await installs())[0].id, installation.id);
  assert.deepEqual((await installs())[0].subscribedEvents, ["agent.status_changed"]);
  assert.equal((await save(ownerToken, server.id, [])).status, 200);
  assert.equal((await read()).status, 401, "narrowing invalidates the old installation credential immediately");
  assert.equal((await save(ownerToken)).status, 200);
  assert.equal((await read()).status, 401, "re-expansion must not revive the revoked token");
  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, installation.id));
  assert.equal((await save(ownerToken)).status, 200);
  assert.equal((await installs())[0].status, "suspended", "permission save must preserve suspension");
  assert.equal((await mint()).status, 404);
  await getDb().update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.id, installation.id));
  assert.equal((await mint()).status, 200);
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, client.id));
  assert.equal((await mint()).status, 404);
  await getDb().update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, client.id));
  const deleted = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, { method: "DELETE", headers: headers(ownerToken) });
  assert.equal(deleted.status, 200);
  assert.equal((await installs()).length, 0);
  assert.equal((await read()).status, 401);
});

// task #319 — `whenToUse`: the Web PATCH path runs the same shared validator
// as the agent `app update` route. Pin the happy path and each rejection class
// so the two surfaces cannot drift apart.
test("PATCH /api/integrations/clients/:id applies the shared whenToUse validator", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`when-to-use-${suffix}@slock.test`, `When To Use ${suffix}`);
  const server = await createServer("When To Use", `when-to-use-${suffix}`, owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `when-to-use-${suffix.slice(0, 8)}`,
    name: "When To Use App",
    description: "demo",
    returnUrl: "https://example.test/callback",
  });

  const headers = (token: string) => ({
    "Authorization": `Bearer ${token}`,
    "X-Server-Id": server.id,
    "content-type": "application/json",
  });
  const patch = (body: Record<string, unknown>) =>
    fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
      method: "PATCH",
      headers: headers(ownerToken),
      body: JSON.stringify(body),
    });

  for (const bad of [
    "a".repeat(161),
    "first line\nsecond line",
    "install @acme/metrics for usage stats",
  ]) {
    const res = await patch({ whenToUse: bad });
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(bad.slice(0, 40))}`);
    assert.match((await res.json() as { error?: string }).error ?? "", /whenToUse/);
  }

  const ok = await patch({ whenToUse: "use `me.files` when attachments need sharing" });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await ok.json() as { whenToUse?: string | null }).whenToUse, "use `me.files` when attachments need sharing");

  const [stored] = await getDb().select({ whenToUse: oauthClients.whenToUse }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(stored.whenToUse, "use `me.files` when attachments need sharing");

  const cleared = await patch({ whenToUse: "" });
  assert.equal(cleared.status, 200);
  const [afterClear] = await getDb().select({ whenToUse: oauthClients.whenToUse }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(afterClear.whenToUse, null);

  // The create path shares the same validator — a typed-in value must either
  // land in the column or be refused, never silently dropped.
  const badCreate = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    method: "POST",
    headers: headers(ownerToken),
    body: JSON.stringify({ name: "Bad Create", whenToUse: "install @acme/metrics now" }),
  });
  assert.equal(badCreate.status, 400);
  const goodCreate = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    method: "POST",
    headers: headers(ownerToken),
    body: JSON.stringify({ name: "Good Create", whenToUse: "when approvals pile up" }),
  });
  const goodCreateText = await goodCreate.text();
  assert.equal(goodCreate.status, 200, goodCreateText);
  const createdBody = JSON.parse(goodCreateText) as { client?: { id: string; whenToUse?: string | null } };
  assert.equal(createdBody.client?.whenToUse, "when approvals pile up");
  const [createdStored] = await getDb().select({ whenToUse: oauthClients.whenToUse }).from(oauthClients).where(eq(oauthClients.id, createdBody.client!.id));
  assert.equal(createdStored.whenToUse, "when approvals pile up");
});

// task #319 — the prompt catalog that rides agent:start config. Same app set
// as `services`, narrowed to non-empty whenToUse, inert-rendered server-side
// so the daemon renders it verbatim.
test("listInstalledAppPromptCatalog returns only enabled apps with a non-empty whenToUse, inert-rendered", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`catalog-${suffix}@slock.test`, `Catalog ${suffix}`);
  const server = await createServer("Catalog", `catalog-${suffix}`, owner.id);

  const { client: hinted } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `hinted-${suffix.slice(0, 8)}`,
    name: "Hinted @alice App",
    description: "Ask `@acme/metrics` first",
    returnUrl: "https://hinted.example.test/callback",
    whenToUse: "ping @alice when the queue backs up",
  });
  await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `plain-${suffix.slice(0, 8)}`,
    name: "No Hint",
    returnUrl: "https://plain.example.test/callback",
  });
  const { client: disabled } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `stopped-${suffix.slice(0, 8)}`,
    name: "Stopped",
    returnUrl: "https://stopped.example.test/callback",
    whenToUse: "should never ship",
  });
  await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, disabled.id));

  const catalog = await listInstalledAppPromptCatalog(server.id);
  assert.equal(catalog.length, 1);
  const entry = catalog[0]!;
  // name/description/whenToUse are already inert-rendered: bare @alice is the
  // plain token user:alice, backticked @acme/metrics survives verbatim.
  assert.equal(entry.name, "Hinted user:alice App");
  assert.equal(entry.description, "Ask `@acme/metrics` first");
  assert.equal(entry.whenToUse, "ping user:alice when the queue backs up");
  // The id agents pass to `raft integration invoke --service`.
  assert.equal(entry.service, `hinted-${suffix.slice(0, 8)}`);
});

test("POST /api/integrations/clients/:clientId/install/bot creates and manages app-owned bot", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`bot-owner-${suffix}@slock.test`, `bot-owner-${suffix}`);
  const member = await seedUser(`bot-member-${suffix}@slock.test`, `bot-member-${suffix}`);
  const server = await createServer("App Bot Server", `app-bot-${suffix.slice(0, 8)}`, owner.id);
  await addMember(server.id, member.id, "member");

  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `bot-app-${suffix.slice(0, 8)}`,
    name: "Bot App",
    enableBot: true,
  });

  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "pending",
  }).returning();

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

  const call = (token: string, body: unknown) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // No capability → 403
  const memberRes = await call(memberToken, { action: "grant" });
  assert.equal(memberRes.status, 403);

  // Grant → creates managed bot
  const grantRes = await call(ownerToken, { action: "grant" });
  assert.equal(grantRes.status, 200);
  const grantBody = await grantRes.json() as { botGrant: string; bot: { agentId: string; state: string; handle: string } };
  assert.equal(grantBody.botGrant, "granted");
  assert.equal(grantBody.bot.state, "active");
  assert.ok(grantBody.bot.agentId);

  const [botAgent] = await getDb().select().from(agents).where(eq(agents.id, grantBody.bot.agentId));
  assert.ok(botAgent);
  assert.equal(botAgent.managedByAppInstallId, install.id);
  assert.equal(botAgent.status, "active");

  const [binding] = await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install.id));
  assert.ok(binding);
  assert.equal(binding.state, "active");
  assert.equal(binding.generation, 1);
  assert.equal(binding.handle, grantBody.bot.handle);

  // Billing exclusion
  const { getServerBillingUsage } = await import("../services/planService");
  const usage = await getServerBillingUsage(getDb(), server.id);
  assert.equal(usage.agents, 0, "managed bot excluded from seat count");

  // List endpoint resolves the owning app (yezizp's "Unknown app" bug: the
  // panel renders from list data, and only the detail route had the join).
  const listRes = await fetch(`${app.baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as Array<{ id: string; managedByApp?: { name: string; logoUrl: string | null } | null }>;
  const listedBot = listBody.find((a) => a.id === grantBody.bot.agentId);
  assert.ok(listedBot, "bot appears in the agent list");
  assert.equal(listedBot.managedByApp?.name, "Bot App", "list endpoint resolves managedByApp");

  // Avatar fences: neither an admin nor the bot itself may override the app
  // logo the identity follows (Cardy's write-path finding).
  const tinyPng = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d994d0000000049454e44ae426082", "hex");
  const adminAvatarRes = await fetch(`${app.baseUrl}/api/agents/${grantBody.bot.agentId}/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "image/png" },
    body: tinyPng,
  });
  assert.equal(adminAvatarRes.status, 403, "admin avatar upload must be fenced for managed bots");
  const adminAvatarBody = await adminAvatarRes.json() as { code?: string };
  assert.equal(adminAvatarBody.code, "app_bot_avatar_managed", "403 must come from the bot fence, not the capability check");

  // The JSON PATCH path is fenced too (Cardy: it returned 200 and wrote).
  const patchRes = await fetch(`${app.baseUrl}/api/agents/${grantBody.bot.agentId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ avatarUrl: "https://cdn.example/override.png" }),
  });
  assert.equal(patchRes.status, 403, "JSON PATCH avatarUrl must be fenced for managed bots");
  const patchBody = await patchRes.json() as { code?: string };
  assert.equal(patchBody.code, "app_bot_avatar_managed");
  const [unchanged] = await getDb().select({ avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.id, grantBody.bot.agentId));
  assert.equal(unchanged?.avatarUrl ?? null, null, "no avatar row write slipped through");

  // P4b: the app publishes the bot's status with client credentials; the
  // detail read carries it, and the bot's name/description follow the app's
  // live values (not the grant-time snapshot).
  const statusRes = await fetch(`${app.baseUrl}/api/oauth/installations/${install.id}/bot-status`, {
    method: "PUT",
    headers: { Authorization: clientBasicAuth(client.clientId, clientSecret), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Indexing 2,341 packages" }),
  });
  assert.equal(statusRes.status, 200, "bot-status accepts the app's client credentials");
  const detailRes = await fetch(`${app.baseUrl}/api/agents/${grantBody.bot.agentId}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
  });
  const detailBody = await detailRes.json() as { managedByApp?: { botStatusText?: string | null } };
  assert.equal(detailBody.managedByApp?.botStatusText, "Indexing 2,341 packages", "detail carries the app-published status");

  // App rename propagates: update the client's name, the managedByApp join
  // must reflect the new value without a re-grant.
  await getDb().update(oauthClients).set({ name: "Bot App Renamed", description: "Now tracks PyPI too" }).where(eq(oauthClients.id, client.id));
  const detail2Res = await fetch(`${app.baseUrl}/api/agents/${grantBody.bot.agentId}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
  });
  const detail2Body = await detail2Res.json() as { managedByApp?: { name?: string; description?: string | null } };
  assert.equal(detail2Body.managedByApp?.name, "Bot App Renamed", "bot identity follows the app's live name");
  assert.equal(detail2Body.managedByApp?.description, "Now tracks PyPI too", "bot identity follows the app's live description");

  // Clearing the status publishes silence, not a stale line.
  const clearRes = await fetch(`${app.baseUrl}/api/oauth/installations/${install.id}/bot-status`, {
    method: "PUT",
    headers: { Authorization: clientBasicAuth(client.clientId, clientSecret), "Content-Type": "application/json" },
    body: JSON.stringify({ text: null }),
  });
  assert.equal(clearRes.status, 200);
  const detail3Res = await fetch(`${app.baseUrl}/api/agents/${grantBody.bot.agentId}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
  });
  const detail3Body = await detail3Res.json() as { managedByApp?: { botStatusText?: string | null } };
  assert.equal(detail3Body.managedByApp?.botStatusText ?? null, null, "cleared status stays cleared");

  // A revoked grant must refuse the write atomically — the grant is a
  // condition of the UPDATE, so a revoke that lands mid-request still wins.
  await getDb().update(oauthClientInstalls).set({ botGrant: "revoked" }).where(eq(oauthClientInstalls.id, install.id));
  const revokedRes = await fetch(`${app.baseUrl}/api/oauth/installations/${install.id}/bot-status`, {
    method: "PUT",
    headers: { Authorization: clientBasicAuth(client.clientId, clientSecret), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "should not land" }),
  });
  assert.equal(revokedRes.status, 403, "revoked grant must refuse bot-status");
  const [revokedRow] = await getDb().select({ botStatusText: oauthClientInstalls.botStatusText }).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.equal(revokedRow?.botStatusText ?? null, null, "revoked write must leave no status behind");
  // A disabled binding cannot publish either — the grant is restored first
  // so this isolates the binding-state gate from the revoked-grant refusal.
  await getDb().update(oauthClientInstalls).set({ botGrant: "granted" }).where(eq(oauthClientInstalls.id, install.id));
  await getDb().update(appBotBindings).set({ state: "disabled", disabledAt: new Date() }).where(eq(appBotBindings.installId, install.id));
  const disabledRes = await fetch(`${app.baseUrl}/api/oauth/installations/${install.id}/bot-status`, {
    method: "PUT", headers: { Authorization: clientBasicAuth(client.clientId, clientSecret), "Content-Type": "application/json" }, body: JSON.stringify({ text: "DISABLED WRITE" })
  });
  const [disabledRow] = await getDb().select({ text: oauthClientInstalls.botStatusText }).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.ok(disabledRes.status === 403 && disabledRow.text === null, `disabled binding status=${disabledRes.status} persisted=${disabledRow.text}`);
  await getDb().update(appBotBindings).set({ state: "active", disabledAt: null }).where(eq(appBotBindings.installId, install.id));
  await getDb().update(oauthClientInstalls).set({ botGrant: "granted" }).where(eq(oauthClientInstalls.id, install.id));

  // Deterministic interleaving (Cardy's probe): pause the status UPDATE after
  // its reads, complete a real revoke over HTTP, then release — the write
  // must not land on the revoked install.
  const database = getDb(); const originalUpdate = database.update.bind(database);
  let reached!: () => void; let release!: () => void;
  const atWrite = new Promise<void>(r => { reached = r; });
  const resume = new Promise<void>(r => { release = r; });
  const spy = vi.spyOn(database, 'update').mockImplementation((...args) => {
    const builder = originalUpdate(...args as Parameters<typeof originalUpdate>);
    if (args[0] !== oauthClientInstalls) return builder;
    return new Proxy(builder, { get(target, key, receiver) {
      if (key !== 'set') return Reflect.get(target, key, receiver);
      return (values: Record<string, unknown>) => {
        const query = target.set(values as never);
        if (values.botStatusText !== 'LATE AFTER REVOKE') return query;
        return new Proxy(query, { get(q, field, rec) {
          if (field !== 'where') return Reflect.get(q, field, rec);
          return (...conditions: Parameters<typeof q.where>) => {
            const built = q.where(...conditions);
            return new Proxy(built, { get(b, prop, rec2) {
              if (prop !== 'returning') return Reflect.get(b, prop, rec2);
              return (...cols: Parameters<typeof b.returning>) => { reached(); return resume.then(() => b.returning(...cols)); };
            }});
          };
        }});
      };
    }});
  });
  const late = fetch(`${app.baseUrl}/api/oauth/installations/${install.id}/bot-status`, {
    method: 'PUT', headers: { Authorization: clientBasicAuth(client.clientId, clientSecret), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'LATE AFTER REVOKE' })
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([atWrite, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('status write hook not reached')), 5000); })]);
    if (timer) clearTimeout(timer);
    const revoked = await call(ownerToken, { action: 'revoke' }); assert.equal(revoked.status, 200);
    release(); const lateRes = await late;
    const [after] = await database.select({ grant: oauthClientInstalls.botGrant, text: oauthClientInstalls.botStatusText }).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
    assert.equal(lateRes.status, 403, `late write must refuse 403, got ${lateRes.status}`);
    assert.ok(after.text !== 'LATE AFTER REVOKE', `stored=${after.text}`);
  } finally { if (timer) clearTimeout(timer); release(); spy.mockRestore(); await late.catch(() => {}); }
  await getDb().update(oauthClientInstalls).set({ botGrant: "granted" }).where(eq(oauthClientInstalls.id, install.id));

  // App edits must notify open bot profiles (Cardy's probe): PATCH the client
  // and an agent:updated must reach the room, so open panels re-read.
  const events: string[] = []; const to = app.io.to.bind(app.io);
  const notifySpy = vi.spyOn(app.io, 'to').mockImplementation((...args) => {
    const room = to(...args as Parameters<typeof to>);
    return new Proxy(room, { get(target, key, receiver) {
      if (key !== 'emit') return Reflect.get(target, key, receiver);
      return (event: string, ...payload: unknown[]) => { events.push(event); return Reflect.apply(target.emit, target, [event, ...payload]); };
    }});
  });
  try {
    const edit = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'X-Server-Id': server.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New open-window name', description: null }) });
    assert.equal(edit.status, 200);
    const fresh = await fetch(`${app.baseUrl}/api/agents/${grantBody.bot.agentId}`, { headers: { Authorization: `Bearer ${ownerToken}`, 'X-Server-Id': server.id } });
    const data = await fresh.json() as { managedByApp: { name: string } };
    assert.equal(data.managedByApp.name, 'New open-window name');
    assert.ok(events.includes('agent:updated'), `App edit succeeded and a fresh GET is current, but emitted events=${JSON.stringify(events)}`);
  } finally { notifySpy.mockRestore(); }

  // Revoke → disabled
  const revokeRes = await call(ownerToken, { action: "revoke" });
  assert.equal(revokeRes.status, 200);
  const [disabled] = await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install.id));
  assert.equal(disabled?.state, "disabled");
  assert.ok(disabled?.disabledAt);
});

// The Bot key is bought with the App's own client
// credentials on its own installation, never with a delegated access token;
// rotation is explicit and every outcome is audited.
test("POST /api/oauth/installations/:installationId/bot-token issues the Bot key to its own App only, rotates explicitly, audits", async ({ app }) => {
  const suffix = randomUUID();
  const short = suffix.slice(0, 8);
  const owner = await seedUser(`bot-token-owner-${suffix}@slock.test`, `bot-token-owner-${suffix}`);
  const server = await createServer("App Bot Token Server", `app-bot-token-${short}`, owner.id);
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `bot-app-${short}`,
    name: "Bot App",
    enableBot: true,
  });
  const { client: other, clientSecret: otherSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `other-app-${short}`,
    name: "Other App",
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "pending",
  }).returning();
  const ownerToken = await tokenForHuman(owner.email);
  const setBotGrant = (action: "grant" | "revoke") => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const basic = (key: string, secret: string) => `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
  const appAuth = basic(client.clientId, clientSecret);
  const exchange = (authorization: string, body: Record<string, unknown> = {}, installationId: string = install.id) =>
    fetch(`${app.baseUrl}/api/oauth/installations/${installationId}/bot-token`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const whoami = (apiKey: string) => fetch(`${app.baseUrl}/internal/agent-api/`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const grantRes = await setBotGrant("grant");
  assert.equal(grantRes.status, 200, await grantRes.clone().text());
  const { bot } = await grantRes.json() as { bot: { agentId: string } };

  // A live delegated access token for this App on this Server is not enough:
  // that was the hole, on the new route and on the retired one.
  const rawToken = `oauth-token-${suffix}`;
  await getDb().insert(oauthAccessTokens).values({
    serverId: server.id,
    principalType: "human",
    userId: owner.id,
    clientId: client.id,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    scopes: ["openid", "profile"],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  assert.equal((await exchange(`Bearer ${rawToken}`)).status, 401);
  const retired = await fetch(`${app.baseUrl}/api/app-bot/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${rawToken}` },
  });
  assert.equal(retired.status, 404);
  assert.equal((await exchange(basic(client.clientId, "wrong-secret"))).status, 401);
  // Another App's valid credentials cannot reach this installation.
  const crossApp = await exchange(basic(other.clientId, otherSecret));
  assert.equal(crossApp.status, 404);
  assert.equal((await crossApp.json() as { code: string }).code, "installation_not_found");

  // 1. First issue.
  const firstRes = await exchange(appAuth);
  assert.equal(firstRes.status, 200, await firstRes.clone().text());
  const first = await firstRes.json() as { apiKey: string; agentId: string; scopes: string[]; rotated: boolean };
  assert.ok(first.apiKey.startsWith("sk_agent_"));
  assert.equal(first.agentId, bot.agentId);
  assert.equal(first.rotated, false);
  assert.deepEqual([...first.scopes].sort(), ["channels", "mentions", "read", "send"]);
  assert.equal((await whoami(first.apiKey)).status, 200);

  // 2. A second call without rotate is refused and does not log the first key out.
  const again = await exchange(appAuth);
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code: string }).code, "credential_exists");
  assert.equal((await whoami(first.apiKey)).status, 200);

  // 3. Explicit rotation replaces the key.
  const rotatedRes = await exchange(appAuth, { rotate: true });
  assert.equal(rotatedRes.status, 200);
  const rotated = await rotatedRes.json() as { apiKey: string; rotated: boolean };
  assert.equal(rotated.rotated, true);
  assert.equal((await whoami(first.apiKey)).status, 401);
  assert.equal((await whoami(rotated.apiKey)).status, 200);
  // Both keys record the App origin and no person.
  const botCredentials = await getDb().select().from(agentCredentials).where(eq(agentCredentials.agentId, bot.agentId));
  assert.equal(botCredentials.length, 2);
  for (const row of botCredentials) {
    assert.equal(row.issuedVia, "app");
    assert.equal(row.createdByUserId, null);
    assert.equal(row.issuedByMachineId, null);
    assert.equal(row.name, `app-bot:${client.id}`);
  }

  // 4. Revoking the bot grant kills the key and refuses new ones.
  assert.equal((await setBotGrant("revoke")).status, 200);
  assert.equal((await whoami(rotated.apiKey)).status, 401);
  const refused = await exchange(appAuth, { rotate: true });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { code: string }).code, "bot_not_granted");

  const auditRows = await getDb().select({
    clientId: integrationAuditEvents.clientId,
    eventType: integrationAuditEvents.eventType,
    outcome: integrationAuditEvents.outcome,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents)
    .where(inArray(integrationAuditEvents.eventType, ["app_bot.credential", "installation.bot_grant_updated"]))
    .orderBy(integrationAuditEvents.createdAt);
  const summary = auditRows.map((row) => {
    const metadata = row.metadata as Record<string, unknown>;
    return `${row.clientId === client.id ? "app" : "other"}:${row.eventType}:${metadata.result ?? metadata.botGrant}:${row.outcome}`;
  });
  assert.deepEqual(summary, [
    "app:installation.bot_grant_updated:granted:success",
    "other:app_bot.credential:installation_not_found:failure",
    "app:app_bot.credential:issued:success",
    "app:app_bot.credential:credential_exists:failure",
    "app:app_bot.credential:rotated:success",
    "app:installation.bot_grant_updated:revoked:success",
    "app:app_bot.credential:bot_not_granted:failure",
  ]);
  const rotatedAudit = auditRows.find((row) => (row.metadata as Record<string, unknown>).result === "rotated")!;
  assert.equal((rotatedAudit.metadata as Record<string, unknown>).revokedCount, 1);
});

test("POST /api/integrations/clients/:clientId/install/bot lazily creates the source installation for a server-local app", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`bot-lazy-owner-${suffix}@slock.test`, `bot-lazy-owner-${suffix}`);
  const server = await createServer("App Bot Lazy Server", `app-bot-lazy-${suffix.slice(0, 8)}`, owner.id);

  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `bot-lazy-${suffix.slice(0, 8)}`,
    name: "Lazy Bot App",
    enableBot: true,
  });

  // No oauthClientInstalls row exists yet — a source-owned app has never been
  // "installed" via marketplace. The grant route must materialize it.
  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { installationId: string; botGrant: string; bot: { agentId: string } | null };
  assert.equal(body.botGrant, "granted");
  assert.ok(body.bot?.agentId);

  const [install] = await getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, body.installationId));
  assert.ok(install, "source installation row materialized on grant");
  assert.equal(install.serverId, server.id);
  assert.equal(install.clientId, client.id);
  assert.equal(install.botGrant, "granted");

  // GET /clients exposes botGrant + enableBot so the editor can render state.
  const listRes = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  });
  const listed = await listRes.json() as Array<{ id: string; enableBot: boolean; botGrant: string | null }>;
  const row = listed.find((entry) => entry.id === client.id);
  assert.ok(row);
  assert.equal(row.enableBot, true);
  assert.equal(row.botGrant, "granted");

  // Real HTTP regression (Cardy): an unrelated PATCH must return the
  // install-joined editor row, not the bare update result — the editor
  // replaces its row with the response and would otherwise lose botGrant.
  const patchRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ description: "unrelated edit" }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { id: string; description: string | null; installationId: string | null; botGrant: string | null };
  assert.equal(patched.id, client.id);
  assert.equal(patched.installationId, body.installationId);
  assert.equal(patched.botGrant, "granted", "PATCH response carries the install-joined grant state");
});

// Regression guard: an App bot's stored avatar IS its App's logo
// (agentService.syncAppBotAvatarsToLogo). Every surface renders
// agent.avatarUrl, so drift here is the bot showing the generated avatar in its
// DM header while its profile panel shows the logo.
test("an App bot's avatar equals its App logo after bot creation, logo change, logo removal and App deletion, on every server, and each bot's server is told", async ({ app }) => {
  const suffix = randomUUID();
  const short = suffix.slice(0, 8);
  const owner = await seedUser(`bot-avatar-owner-${suffix}@slock.test`, `bot-avatar-owner-${suffix}`);
  const otherOwner = await seedUser(`bot-avatar-other-${suffix}@slock.test`, `bot-avatar-other-${suffix}`);
  const server = await createServer("App Bot Avatar Server", `app-bot-avatar-${short}`, owner.id);
  const otherServer = await createServer("App Bot Avatar Other", `app-bot-avatar-o-${short}`, otherOwner.id);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `bot-avatar-${short}`,
    name: "Avatar Bot App",
    enableBot: true,
  });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
  const logoRoute = `${app.baseUrl}/api/integrations/clients/${client.id}/logo`;
  const uploadLogo = async (background: string) => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
    const formData = new FormData();
    formData.set("logo", new Blob([new Uint8Array(image)], { type: "image/png" }), "logo.png");
    const res = await fetch(logoRoute, { method: "POST", headers, body: formData });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const assertBotsFollowLogo = async (agentIds: string[], step: string, expectLogo: boolean) => {
    const [stored] = await getDb().select({ logoUrl: oauthClients.logoUrl }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(Boolean(stored?.logoUrl), expectLogo, `${step}: app logo ${expectLogo ? "set" : "cleared"}`);
    const rows = await getDb().select({ id: agents.id, avatarUrl: agents.avatarUrl }).from(agents).where(inArray(agents.id, agentIds));
    assert.equal(rows.length, agentIds.length);
    for (const row of rows) {
      assert.equal(row.avatarUrl, stored?.logoUrl ?? null, `${step}: bot ${row.id} avatar must be the app logo`);
    }
    // The agent directory serializer (what the DM header and message rows read).
    const listRes = await fetch(`${app.baseUrl}/api/agents`, { headers });
    assert.equal(listRes.status, 200);
    const listed = (await listRes.json() as Array<{ id: string; avatarUrl: string | null }>).find((agent) => agent.id === agentIds[0]);
    assert.equal(listed?.avatarUrl, stored?.logoUrl ?? null, `${step}: GET /api/agents emits the logo as the bot avatar`);
    return stored?.logoUrl ?? null;
  };

  // (a) Bot creation copies the current logo: through the grant route on the
  // App's own server, and on another server that installed the App.
  await uploadLogo("#d33f49");
  const grantRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(grantRes.status, 200, await grantRes.clone().text());
  const { bot } = await grantRes.json() as { bot: { agentId: string } };
  const [otherInstall] = await getDb().insert(oauthClientInstalls).values({
    serverId: otherServer.id,
    clientId: client.id,
    installedByUserId: otherOwner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const { createManagedAppBot } = await import("../services/appBotIdentityService");
  const otherBot = await getDb().transaction((tx) =>
    createManagedAppBot(tx, { installId: otherInstall!.id, serverId: otherServer.id }),
  );
  const botIds = [bot.agentId, otherBot.agentId];
  const firstLogo = await assertBotsFollowLogo(botIds, "bot creation", true);

  // From here every write must tell each moved bot's own server to re-read it,
  // once (agent:updated after commit; the profile-write broadcast contract).
  const pushes: string[] = [];
  const to = app.io.to.bind(app.io);
  const pushSpy = vi.spyOn(app.io, "to").mockImplementation((...args) => {
    const room = to(...args as Parameters<typeof to>);
    return new Proxy(room, { get(target, key, receiver) {
      if (key !== "emit") return Reflect.get(target, key, receiver);
      return (event: string, ...payload: unknown[]) => {
        if (event === "agent:updated") pushes.push(`${String(args[0])} ${(payload[0] as { agentId?: string } | undefined)?.agentId}`);
        return Reflect.apply(target.emit, target, [event, ...payload]);
      };
    }});
  });
  const assertEachBotTold = (step: string) => {
    assert.deepEqual(
      pushes.splice(0).sort(),
      [`server:${server.id} ${bot.agentId}`, `server:${otherServer.id} ${otherBot.agentId}`].sort(),
      `${step}: one agent:updated per bot, to the bot's own server`,
    );
  };
  try {
    // (b) A logo change moves every bound bot, on every server.
    await uploadLogo("#2f6fdd");
    const secondLogo = await assertBotsFollowLogo(botIds, "logo change", true);
    assert.notEqual(secondLogo, firstLogo, "the second upload is a different logo");
    assertEachBotTold("logo change");

    // (c) Logo removal clears the bot avatar (the generated avatar everywhere).
    const clearRes = await fetch(logoRoute, { method: "DELETE", headers });
    assert.equal(clearRes.status, 200);
    await assertBotsFollowLogo(botIds, "logo removal", false);
    assertEachBotTold("logo removal");

    // (d) App deletion deletes the logo object: the bots must not keep pointing at it.
    await uploadLogo("#1a7f37");
    await assertBotsFollowLogo(botIds, "logo before deletion", true);
    assertEachBotTold("logo before deletion");
    const deleteRes = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, { method: "DELETE", headers });
    assert.equal(deleteRes.status, 200, await deleteRes.clone().text());
    const [gone] = await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(gone, undefined, "the App is deleted");
    const afterDelete = await getDb().select({ avatarUrl: agents.avatarUrl }).from(agents).where(inArray(agents.id, botIds));
    assert.deepEqual(afterDelete.map((row) => row.avatarUrl), [null, null], "App deletion: the bots fall back to the generated avatar");
    assertEachBotTold("App deletion");
  } finally {
    pushSpy.mockRestore();
  }
});

// Regression guard: an App's old logo object is deleted only after the change
// commits. If anything after the logo write fails in the same transaction, the
// change rolls back and the App and its bots still point at the old logo, so
// its object must still exist.
test("a web logo upload, logo clear or App deletion that rolls back deletes no logo object; once committed it deletes the old one", async ({ app }) => {
  const suffix = randomUUID();
  const short = suffix.slice(0, 8);
  const owner = await seedUser(`logo-commit-owner-${suffix}@slock.test`, `logo-commit-owner-${suffix}`);
  const server = await createServer("App Logo Commit Server", `app-logo-commit-${short}`, owner.id);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `logo-commit-${short}`,
    name: "Logo Commit App",
    enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const { createManagedAppBot } = await import("../services/appBotIdentityService");
  const bot = await getDb().transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId: server.id }));
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
  const appRoute = `${app.baseUrl}/api/integrations/clients/${client.id}`;
  const uploadLogo = async (background: string) => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
    const formData = new FormData();
    formData.set("logo", new Blob([new Uint8Array(image)], { type: "image/png" }), "logo.png");
    return fetch(`${appRoute}/logo`, { method: "POST", headers, body: formData });
  };
  const clearLogo = () => fetch(`${appRoute}/logo`, { method: "DELETE", headers });
  const deleteApp = () => fetch(appRoute, { method: "DELETE", headers });
  const stored = async () => {
    const [row] = await getDb().select({ logoUrl: oauthClients.logoUrl, logoStorageKey: oauthClients.logoStorageKey })
      .from(oauthClients).where(eq(oauthClients.id, client.id));
    const [botRow] = await getDb().select({ avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.id, bot.agentId));
    return { app: row ?? null, botAvatarUrl: botRow?.avatarUrl ?? null };
  };

  // Upload and clear: make the bot avatar sync that follows the logo write
  // fail. App deletion has nothing after its write: fail right after it, as a
  // failed commit would.
  const failNextBotSync = () => vi.spyOn(agentService, "syncAppBotAvatarsToLogo")
    .mockRejectedValueOnce(new Error("injected failure after the logo write"));
  const failAfterNextAppDeletion = () => {
    const deleteLocked = oauthService.deleteLockedOAuthClient;
    return vi.spyOn(oauthService, "deleteLockedOAuthClient").mockImplementationOnce(async (...args) => {
      await deleteLocked(...args);
      throw new Error("injected failure after the App deletion write");
    });
  };

  const bucket = installRecordingLogoStorage();
  try {
    assert.equal((await uploadLogo("#d33f49")).status, 200);
    const before = await stored();
    const oldKey = before.app?.logoStorageKey;
    assert.ok(oldKey && bucket.objects.has(oldKey), "the first logo is stored");
    assert.equal(before.botAvatarUrl, before.app?.logoUrl, "the bot shows the logo");

    for (const [step, injectFailure, request] of [
      ["logo upload", failNextBotSync, () => uploadLogo("#2f6fdd")],
      ["logo clear", failNextBotSync, clearLogo],
      ["App deletion", failAfterNextAppDeletion, deleteApp],
    ] as const) {
      const injected = injectFailure();
      try {
        assert.equal((await request()).status, 500, `${step}: the injected failure fails the request`);
      } finally {
        injected.mockRestore();
      }
      assert.deepEqual(await stored(), before, `${step} rolled back: the App and its bot keep the old logo`);
      assert.deepEqual(bucket.deletes, [], `${step} rolled back: no logo object is deleted`);
      assert.ok(bucket.objects.has(oldKey), `${step} rolled back: the old logo object still exists`);
    }

    // Committed, each change deletes the object it left unreferenced.
    assert.equal((await uploadLogo("#2f6fdd")).status, 200);
    const replacedBy = (await stored()).app?.logoStorageKey;
    assert.ok(replacedBy && replacedBy !== oldKey);
    assert.deepEqual(bucket.deletes.splice(0), [oldKey], "logo upload: the replaced object is deleted");
    assert.equal((await clearLogo()).status, 200);
    assert.deepEqual(bucket.deletes.splice(0), [replacedBy], "logo clear: the removed object is deleted");
    assert.equal((await uploadLogo("#1a7f37")).status, 200);
    const lastKey = (await stored()).app?.logoStorageKey;
    assert.ok(lastKey);
    assert.equal((await deleteApp()).status, 200);
    assert.equal((await stored()).app, null, "the App is deleted");
    assert.deepEqual(bucket.deletes.splice(0), [lastKey], "App deletion: the App's logo object is deleted");
  } finally {
    bucket.restore();
  }
});

test("PATCH /api/integrations/clients/:id with enableBot=false disables the bot and puts granted installs back to pending", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`bot-off-owner-${suffix}@slock.test`, `bot-off-owner-${suffix}`);
  const server = await createServer("App Bot Off Server", `app-bot-off-${suffix.slice(0, 8)}`, owner.id);

  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `bot-off-${suffix.slice(0, 8)}`,
    name: "Bot Off App",
    enableBot: true,
  });

  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const { createManagedAppBot } = await import("../services/appBotIdentityService");
  await getDb().transaction((tx) =>
    createManagedAppBot(tx, { installId: install.id, serverId: server.id }),
  );

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enableBot: false }),
  });
  assert.equal(res.status, 200);

  const [row] = await getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  // Not "revoked": that is a Server admin's own "Don't add"; a re-enable must ask again.
  assert.equal(row.botGrant, "pending", "a developer disable puts the grant back to pending");
  const [binding] = await getDb().select().from(appBotBindings).where(eq(appBotBindings.installId, install.id));
  assert.equal(binding?.state, "disabled", "managed bot disabled when enableBot is turned off");
  assert.ok(binding?.disabledAt);
});

test("GET /api/agents/:id exposes managedByApp attribution for an app-managed bot", async ({ app }) => {
  const suffix = randomUUID();
  const owner = await seedUser(`bot-attr-owner-${suffix}@slock.test`, `bot-attr-owner-${suffix}`);
  const server = await createServer("App Bot Attr Server", `app-bot-attr-${suffix.slice(0, 8)}`, owner.id);

  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `bot-attr-${suffix.slice(0, 8)}`,
    name: "Attributed Bot App",
    enableBot: true,
  });

  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const { createManagedAppBot } = await import("../services/appBotIdentityService");
  const bot = await getDb().transaction((tx) =>
    createManagedAppBot(tx, { installId: install.id, serverId: server.id }),
  );

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/agents/${bot.agentId}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    managedByAppInstallId: string | null;
    managedByApp: { clientId: string; name: string } | null;
  };
  assert.equal(body.managedByAppInstallId, install.id);
  assert.ok(body.managedByApp);
  assert.equal(body.managedByApp.clientId, client.id);
  assert.equal(body.managedByApp.name, "Attributed Bot App");
});
