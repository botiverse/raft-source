import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { oauthAccessRequests, oauthAccessTokens, oauthClientInstalls, oauthClients, oauthGrants, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  AgentAccessGrantError,
  AgentScopeNotApprovedError,
  approveAccessRequest,
  exchangeAccessRequest,
  grantAgentAccessOnBehalf,
  installMarketplaceOAuthClient,
  listGrantableAgentApps,
  listMarketplaceOAuthClients,
  requestAgentAccess,
} from "../services/oauthService";
import { getAppNotificationInstallationState } from "../services/appNotificationManagementService";
import { createAppOutboundPermissionRevision, updateAppInstallationGrant } from "../services/appOutboundPermissionService";
import { approvePermissionReview } from "../test/marketplaceReviewFixture";
import { AgentAudienceJwtError, issueAgentAudienceJwt } from "../services/agentAudienceJwtService";

// Task #2 (#proj-apps): an installed third-party app's login scopes count as
// approved only as installed; a scope the developer adds later waits for an
// admin's "Approve update" before any agent is granted it without a person.
const test = createApiTest();

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@raft.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedInstalledApp() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("approved-scopes-owner");
  const publisher = await createServer("Publisher", `scopes-pub-${suffix}`, owner.id);
  const server = await createServer("Installer", `scopes-inst-${suffix}`, owner.id);
  const agent = await createAgent(server.id, `ScopeBot${suffix.slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: owner.id,
  });
  const [client] = await getDb().insert(oauthClients).values({
    serverId: publisher.id,
    createdByUserId: owner.id,
    clientId: `scopes-app-${suffix}`,
    clientSecretHash: createHash("sha256").update(randomUUID()).digest("hex"),
    appType: "third_party_global",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    name: "Scopes App",
    allowedScopes: ["openid", "profile"],
  }).returning();
  const installed = await installMarketplaceOAuthClient({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    expected: { scopes: ["openid", "profile"], groups: [] },
  });
  assert.ok(installed);
  const [install] = await getDb().select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
  return { owner, server, agent, client, install };
}

test("an installed app's login scopes are approved as installed; scopes added later wait for Approve update", async ({ app: _app }) => {
  const { owner, server, agent, client, install } = await seedInstalledApp();
  // Installing records what the admin approved.
  assert.deepEqual(install.approvedScopes, ["openid", "profile"]);

  const ask = (scopes: string[]) => requestAgentAccess({ clientId: client.id, serverSlug: server.slug, agentId: agent.id, scopes });
  // Positive control: approved scopes are still granted with no person involved.
  assert.equal((await ask(["openid", "profile"])).status, "approved");

  // The developer adds a scope after the install.
  await getDb().update(oauthClients)
    .set({ allowedScopes: ["openid", "profile", "agent:notification:write"] })
    .where(eq(oauthClients.id, client.id));

  const widened = await ask(["openid", "profile", "agent:notification:write"]);
  assert.equal(widened.status, "pending", "a scope added after install must wait for a person");

  const state = await getAppNotificationInstallationState({ clientId: client.id, serverId: server.id });
  assert.ok(state);
  assert.equal(state.approvalRequired, true);
  assert.deepEqual(state.newScopes, ["agent:notification:write"]);

  // Approving the update works for an app with no outbound permission revision.
  const approved = await updateAppInstallationGrant({
    installationId: install.id,
    actorUserId: owner.id,
    expected: { scopes: state.requestedScopes, groups: state.requestedGroups },
  });
  assert.ok(approved);
  assert.deepEqual(approved.approvedScopes, ["openid", "profile", "agent:notification:write"]);
  const after = await getAppNotificationInstallationState({ clientId: client.id, serverId: server.id });
  assert.equal(after?.approvalRequired, false);
  assert.equal((await ask(["openid", "profile", "agent:notification:write"])).status, "approved");
});

test("no person can grant an agent a scope the installation has not approved, by approving, granting, reuse or exchange", async ({ app }) => {
  const { owner, server, agent, client, install } = await seedInstalledApp();
  const approvedSet = ["openid", "profile"];
  const widenedSet = ["openid", "profile", "agent:notification:write"];
  // The developer adds a scope after the install; the admin has not approved it.
  await getDb().update(oauthClients).set({ allowedScopes: widenedSet }).where(eq(oauthClients.id, client.id));
  const ask = (scopes: string[]) => requestAgentAccess({ clientId: client.id, serverSlug: server.slug, agentId: agent.id, scopes });

  // Approving the waiting request (agent creator or owner alike) is refused,
  // and the request keeps waiting.
  const widened = await ask(widenedSet);
  assert.equal(widened.status, "pending");
  await assert.rejects(
    approveAccessRequest({ serverId: server.id, requestId: widened.request.id, resolvedByUserId: owner.id, remember: true }),
    (error: unknown) => error instanceof AgentScopeNotApprovedError
      && JSON.stringify(error.unapprovedScopes) === JSON.stringify(["agent:notification:write"]),
  );
  const ownerToken = await tokenForHuman(owner.email);
  const viaRoute = await fetch(`${app.baseUrl}/api/integrations/requests/${widened.request.id}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ remember: true }),
  });
  assert.equal(viaRoute.status, 409);
  assert.deepEqual(await viaRoute.json(), {
    error: "Scopes not yet approved for this App's installation: agent:notification:write",
    code: "scope_not_approved",
    unapprovedScopes: ["agent:notification:write"],
  });
  const [stillPending] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, widened.request.id));
  assert.equal(stillPending?.status, "pending");
  assert.equal((await getDb().select().from(oauthGrants).where(eq(oauthGrants.agentId, agent.id))).length, 0);

  // Granting on the agent's behalf is refused too, and the picker offers only
  // what the installation approved.
  await assert.rejects(
    grantAgentAccessOnBehalf({ serverId: server.id, agentId: agent.id, clientId: client.id, scopes: widenedSet, grantedByUserId: owner.id }),
    (error: unknown) => error instanceof AgentAccessGrantError && error.status === 400,
  );
  assert.deepEqual((await listGrantableAgentApps(server.id)).find((row) => row.clientId === client.id)?.scopes, approvedSet);

  // A grant that already reaches past the approval (written before this
  // check) is not reused: the request waits instead of being auto-approved.
  await getDb().insert(oauthGrants).values({
    serverId: server.id, agentId: agent.id, clientId: client.id, scopes: widenedSet, grantedByUserId: owner.id, grantSource: "person",
  });
  assert.equal((await ask(widenedSet)).status, "pending");

  // An approved request that reaches past the approval (same origin) becomes
  // a token for the approved scopes only.
  const [approvedEarlier] = await getDb().insert(oauthAccessRequests).values({
    serverId: server.id, agentId: agent.id, clientId: client.id, scopes: widenedSet, status: "approved", remember: false, resolvedAt: new Date(),
  }).returning();
  const exchanged = await exchangeAccessRequest({ clientId: client.id, requestId: approvedEarlier!.id });
  assert.deepEqual(exchanged.scopes, approvedSet);
  const [stored] = await getDb().select({ scopes: oauthAccessTokens.scopes }).from(oauthAccessTokens).where(eq(oauthAccessTokens.requestId, approvedEarlier!.id));
  assert.deepEqual(stored?.scopes, approvedSet);

  // Once a server admin approves the App's permission update, the same
  // approval goes through.
  await getDb().update(oauthClientInstalls).set({ approvedScopes: widenedSet }).where(eq(oauthClientInstalls.id, install.id));
  const approved = await approveAccessRequest({ serverId: server.id, requestId: widened.request.id, resolvedByUserId: owner.id, remember: true });
  assert.equal(approved.request.status, "approved");
});

test("agent login to a third-party app needs its identity scopes in the installer's approved set", async ({ app: _app }) => {
  const { server, agent, client, install } = await seedInstalledApp();
  // Positive control.
  assert.ok((await issueAgentAudienceJwt({ serverId: server.id, agentId: agent.id, service: client.clientId })).access_token);

  // An install that approved only openid (the app added profile later).
  await getDb().update(oauthClientInstalls).set({ approvedScopes: ["openid"] }).where(eq(oauthClientInstalls.id, install.id));
  await assert.rejects(
    issueAgentAudienceJwt({ serverId: server.id, agentId: agent.id, service: client.clientId }),
    (error: unknown) => error instanceof AgentAudienceJwtError && error.reason === "scope_not_approved",
  );
});


test("marketplace permission notices follow each active installation, not platform review or another Server", async ({ app }) => {
  const { owner, server, client, install } = await seedInstalledApp();
  const read = async (serverId: string) => (await listMarketplaceOAuthClients(serverId)).find((row) => row.id === client.id)!;
  assert.equal((await read(server.id)).permissionApprovalRequired, false);
  // Platform review and this Server's approval are distinct steps.
  await createAppOutboundPermissionRevision({ clientId: client.id, actor: { type: "human", id: owner.id }, groups: ["agent"], events: [] });
  assert.equal((await read(server.id)).permissionApprovalRequired, false, "a platform-pending request is not yet an installation update");
  await approvePermissionReview({ clientId: client.id, reviewerUserId: owner.id });
  assert.equal((await read(server.id)).permissionApprovalRequired, true);
  assert.equal((await getAppNotificationInstallationState({ clientId: client.id, serverId: server.id }))?.approvalRequired, true);
  const second = await createServer("New installer", `scope-new-${randomUUID().slice(0, 8)}`, owner.id);
  await installMarketplaceOAuthClient({ serverId: second.id, clientId: client.id, installedByUserId: owner.id,
    expected: { scopes: ["openid", "profile"], groups: ["agent"] } });
  assert.equal((await read(second.id)).permissionApprovalRequired, false, "a newer installation already approved the group");
  const third = await createServer("Not installed", `scope-none-${randomUUID().slice(0, 8)}`, owner.id);
  assert.equal((await read(third.id)).permissionApprovalRequired, false, "an uninstalled listing is not an update request");
  const token = await tokenForHuman(owner.email);
  const summary = (serverId: string, bearer = token) => fetch(`${app.baseUrl}/api/integrations/permission-updates`, {
    headers: { Authorization: `Bearer ${bearer}`, "X-Server-Id": serverId },
  });
  const pendingResponse = await summary(server.id);
  assert.equal(pendingResponse.status, 200);
  assert.equal(pendingResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await pendingResponse.json(), { count: 1, needsAdminReview: true });
  assert.deepEqual(await (await summary(second.id)).json(), { count: 0, needsAdminReview: false });
  const member = await seedUser("permission-notice-member");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  assert.equal((await summary(server.id, await tokenForHuman(member.email))).status, 403);
  await updateAppInstallationGrant({ installationId: install.id, actorUserId: owner.id, expected: { scopes: ["openid", "profile"], groups: ["agent"] } });
  assert.deepEqual(await (await summary(server.id)).json(), { count: 0, needsAdminReview: false });
  const approved = await read(server.id);
  assert.equal(approved.permissionApprovalRequired, false);
  assert.equal("installApprovedGroups" in approved, false, "internal projection columns do not leak into the response");
  assert.equal("installApprovedScopes" in approved, false);
  // Login-scope-only changes use the same rule, including empty group sets.
  await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile", "email"] }).where(eq(oauthClients.id, client.id));
  assert.equal((await read(server.id)).permissionApprovalRequired, true);
  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, install.id));
  assert.equal((await read(server.id)).permissionApprovalRequired, false, "a suspended installation cannot approve an update");
});
