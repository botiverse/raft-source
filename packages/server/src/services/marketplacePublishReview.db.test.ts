import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import {
  agentCredentials,
  agents,
  appBotBindings,
  externalAppRegistrations,
  integrationAuditEvents,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthAppLinkPreviews,
  oauthAppTextRevisions,
  oauthClientInstalls,
  oauthClients,
  oauthGrants,
  oauthLinkPreviewDeclines,
  oauthUserConsents,
  users,
} from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { createAgent } from "./agentService";
import { createOAuthClient } from "./oauthService";
import { addMember } from "./serverService";

// public.marketplace_decide_publish_review, called directly: the contract App
// Admin relies on (it decides every publish and offline review; Raft has no
// review route since #proj-apps task #19). The API tests that need a decided
// review (integrations.api.test.ts, oauthOfflineSource,
// appLinkPreviewActionEndpoint, appPermissionUpdateNotice, oauthUserConsents)
// call it through test/marketplaceReviewFixture.ts.

type Seed = ReturnType<typeof createSeed>;
type Args = {
  clientId: string | null;
  decision: string | null;
  expectedStatus: string | null;
  actorType: string | null;
  actorId: string | null;
  reason?: string | null;
};

async function decide(db: Database, args: Args): Promise<Record<string, unknown>> {
  const { rows } = await db.execute<{ result: Record<string, unknown> }>(sql`SELECT public.marketplace_decide_publish_review(
    ${args.clientId}::uuid, ${args.decision}::text, ${args.expectedStatus}::text,
    ${args.actorType}::text, ${args.actorId}::uuid, ${args.reason ?? null}::text
  ) AS result`);
  return rows[0]!.result;
}

/** The SQLSTATE the call fails with. */
async function refusal(db: Database, args: Args): Promise<string> {
  try {
    await decide(db, args);
  } catch (error) {
    for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    throw error;
  }
  assert.fail(`expected ${JSON.stringify(args)} to be refused`);
}

async function marketplaceApp(seed: Seed, db: Database, publishStatus: "publish_requested" | "in_review" | "unpublish_requested") {
  const publisher = await seed.human();
  const source = await seed.server({ owner: publisher });
  const { client } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: publisher.id,
    clientId: `review-${randomUUID().slice(0, 8)}`,
    name: "Review Fixture",
    description: "An App under marketplace review.",
    appType: "third_party_global",
    allowedScopes: ["openid", "profile", "identity", "email"],
  });
  await db.update(oauthClients).set({ publishStatus }).where(eq(oauthClients.id, client.id));
  return { publisher, source, client };
}

async function install(db: Database, input: { serverId: string; clientId: string; userId: string; scopes?: string[] }) {
  const [row] = await db.insert(oauthClientInstalls).values({
    serverId: input.serverId, clientId: input.clientId, installedByUserId: input.userId, approvedScopes: input.scopes ?? ["openid"],
  }).returning();
  return row!;
}

/** A bot bound to the installation, with one live credential. */
async function bot(db: Database, installation: { id: string; serverId: string }) {
  const agent = await createAgent(installation.serverId, `bot-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external" });
  await db.insert(appBotBindings).values({ installId: installation.id, serverId: installation.serverId, agentId: agent.id, handle: agent.name });
  await db.insert(agentCredentials).values({ agentId: agent.id, apiKeyHash: "fixture-value-not-a-credential", apiKeyPrefix: `p${randomUUID().slice(0, 7)}`, scopes: ["send"] });
  return agent;
}

async function lastAudit(db: Database, clientId: string, eventType: string) {
  const [row] = await db.select({
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
    eventCategory: integrationAuditEvents.eventCategory,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, clientId), eq(integrationAuditEvents.eventType, eventType)))
    .orderBy(desc(integrationAuditEvents.createdAt))
    .limit(1);
  return row ?? null;
}

test("offline approval removes the App from other Servers, tombstones their bots and denies open requests; the source Server keeps everything", async ({ db, seed }) => {
  const { publisher, source, client } = await marketplaceApp(seed, db, "unpublish_requested");
  const installer = await seed.human();
  const external = await seed.server({ owner: installer });
  const sourceInstall = await install(db, { serverId: source.id, clientId: client.id, userId: publisher.id });
  const externalInstall = await install(db, { serverId: external.id, clientId: client.id, userId: installer.id });
  const sourceBot = await bot(db, sourceInstall);
  const externalBot = await bot(db, externalInstall);
  const sourceWorker = await createAgent(source.id, "source-worker", { runtime: "claude", model: "sonnet" });
  const externalWorker = await createAgent(external.id, "external-worker", { runtime: "claude", model: "sonnet" });
  // An agent reviewer: App Admin lets admin agents review.
  const reviewerAgent = await createAgent(source.id, "reviewer-agent", { runtime: "claude", model: "sonnet" });

  const access = {} as Record<string, string>;
  for (const [where, serverId, agentId, userId] of [
    ["source", source.id, sourceWorker.id, publisher.id],
    ["external", external.id, externalWorker.id, installer.id],
  ] as const) {
    const [grant] = await db.insert(oauthGrants).values({ serverId, agentId, clientId: client.id, scopes: ["openid"], grantedByUserId: userId }).returning();
    const [token] = await db.insert(oauthAccessTokens).values({
      serverId, principalType: "human", userId, clientId: client.id, tokenHash: `fixture-${randomUUID()}`, scopes: ["openid"], expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const [pending] = await db.insert(oauthAccessRequests).values({ serverId, agentId, clientId: client.id, scopes: ["openid"], status: "pending", remember: true }).returning();
    const [approvedOpen] = await db.insert(oauthAccessRequests).values({ serverId, principalType: "human", userId, clientId: client.id, scopes: ["openid"], status: "approved" }).returning();
    const [exchanged] = await db.insert(oauthAccessRequests).values({ serverId, principalType: "human", userId, clientId: client.id, scopes: ["openid"], status: "approved", consumedAt: new Date() }).returning();
    const [consent] = await db.insert(oauthUserConsents).values({ userId, serverId, clientId: client.id, scopes: ["openid"] }).returning();
    await db.insert(oauthLinkPreviewDeclines).values({ userId, serverId, clientId: client.id });
    Object.assign(access, {
      [`${where}Grant`]: grant!.id, [`${where}Token`]: token!.id, [`${where}Pending`]: pending!.id,
      [`${where}ApprovedOpen`]: approvedOpen!.id, [`${where}Exchanged`]: exchanged!.id, [`${where}Consent`]: consent!.id,
    });
  }

  const result = await decide(db, {
    clientId: client.id, decision: "approve", expectedStatus: "unpublish_requested", actorType: "agent", actorId: reviewerAgent.id,
  });

  assert.deepEqual(result, {
    clientId: client.id,
    previousStatus: "unpublish_requested",
    status: "private",
    sourceInstallCreated: false,
    actionEndpointToReview: false,
    removedInstallIds: [externalInstall.id],
    removedBots: [{ agentId: externalBot.id, serverId: external.id }],
    deniedRequestCount: 2,
    revokedGrantCount: 1,
    revokedTokenCount: 1,
  });

  const [after] = await db.select().from(oauthClients).where(eq(oauthClients.id, client.id));
  const requestStatus = async (id: string) => (await db.select({ status: oauthAccessRequests.status, by: oauthAccessRequests.resolvedByUserId }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, id)))[0];
  const revoked = async (table: typeof oauthGrants | typeof oauthAccessTokens | typeof oauthUserConsents, id: string) =>
    Boolean((await db.select({ revokedAt: table.revokedAt }).from(table).where(eq(table.id, id)))[0]?.revokedAt);
  const botState = async (agentId: string) => ({
    deleted: Boolean((await db.select({ deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, agentId)))[0]?.deletedAt),
    credentials: (await db.select({ revokedReason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.agentId, agentId))).map((row) => row.revokedReason),
  });
  const declines = await db.select({ serverId: oauthLinkPreviewDeclines.serverId }).from(oauthLinkPreviewDeclines).where(eq(oauthLinkPreviewDeclines.clientId, client.id));
  assert.deepEqual({
    client: { publishStatus: after!.publishStatus, appType: after!.appType, listed: after!.humanMarketplaceVisible, reviewedBy: after!.publishReviewedByUserId, reviewed: Boolean(after!.publishReviewedAt) },
    installs: (await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id))),
    sourceBot: await botState(sourceBot.id),
    externalBot: await botState(externalBot.id),
    sourceRequests: [await requestStatus(access.sourcePending!), await requestStatus(access.sourceApprovedOpen!), await requestStatus(access.sourceExchanged!)],
    externalRequests: [await requestStatus(access.externalPending!), await requestStatus(access.externalApprovedOpen!), await requestStatus(access.externalExchanged!)],
    revoked: {
      source: [await revoked(oauthGrants, access.sourceGrant!), await revoked(oauthAccessTokens, access.sourceToken!), await revoked(oauthUserConsents, access.sourceConsent!)],
      external: [await revoked(oauthGrants, access.externalGrant!), await revoked(oauthAccessTokens, access.externalToken!), await revoked(oauthUserConsents, access.externalConsent!)],
    },
    declines: declines.map((row) => row.serverId),
  }, {
    // Reviewer columns name users only: an agent reviewer leaves them null.
    client: { publishStatus: "private", appType: "third_party_global", listed: false, reviewedBy: null, reviewed: true },
    installs: [sourceInstall],
    sourceBot: { deleted: false, credentials: [null] },
    externalBot: { deleted: true, credentials: ["bot_uninstalled"] },
    sourceRequests: [{ status: "pending", by: null }, { status: "approved", by: null }, { status: "approved", by: null }],
    // The approved request whose code was never exchanged is denied too.
    externalRequests: [{ status: "denied", by: null }, { status: "denied", by: null }, { status: "approved", by: null }],
    revoked: { source: [false, false, false], external: [true, true, true] },
    declines: [source.id],
  });
  // The binding was tombstoned before its installation row cascaded it away.
  assert.equal((await db.select().from(appBotBindings).where(eq(appBotBindings.installId, externalInstall.id))).length, 0);

  assert.deepEqual(await lastAudit(db, client.id, "app.offline_approved"), {
    actorType: "agent",
    actorId: reviewerAgent.id,
    eventCategory: "revocation",
    metadata: {
      clientKey: client.clientId, appType: "third_party_global", previousPublishStatus: "unpublish_requested", nextPublishStatus: "private",
      removedInstallCount: 1, revokedGrantCount: 1, revokedTokenCount: 1, deniedPendingRequestCount: 2,
    },
  });
});

test("offline approval restores a missing source installation with basic login and the App's text, creating the text revision an old App lacks", async ({ db, seed }) => {
  const { client } = await marketplaceApp(seed, db, "unpublish_requested");
  const reviewer = await seed.human();
  // An App from before text revisions and before scopes were recorded.
  await db.update(oauthClients).set({ allowedScopes: null, textCurrentRevisionId: null, localConfirmedTextRevisionId: null }).where(eq(oauthClients.id, client.id));
  const [before] = await db.select({ textRevision: oauthClients.textRevision }).from(oauthClients).where(eq(oauthClients.id, client.id));

  const result = await decide(db, { clientId: client.id, decision: "approve", expectedStatus: "unpublish_requested", actorType: "human", actorId: reviewer.id });
  assert.equal(result.sourceInstallCreated, false, "the offline path does not report the restore as an install");

  const [after] = await db.select().from(oauthClients).where(eq(oauthClients.id, client.id));
  const [revision] = await db.select().from(oauthAppTextRevisions).where(eq(oauthAppTextRevisions.id, after!.textCurrentRevisionId!));
  assert.deepEqual(
    { revision: revision!.revision, state: revision!.state, by: revision!.createdByType, name: revision!.name, description: revision!.description },
    { revision: before!.textRevision + 1, state: "active", by: "system", name: after!.name, description: after!.description },
  );
  assert.equal(after!.textRevision, before!.textRevision + 1);
  assert.equal(after!.localConfirmedTextRevisionId, revision!.id);
  assert.equal(after!.publishReviewedByUserId, reviewer.id);

  const [restored] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
  assert.deepEqual(
    { serverId: restored!.serverId, bySystem: restored!.installedBySystem, by: restored!.installedByUserId, scopes: restored!.approvedScopes, groups: restored!.approvedGroups, text: restored!.confirmedTextRevisionId },
    // The SQL default list is the shared one (RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES).
    { serverId: client.serverId, bySystem: true, by: null, scopes: effectiveAllowedOAuthScopes(null), groups: [], text: revision!.id },
  );
});

test("offline rejection keeps the App listed with the trimmed reason and removes nothing", async ({ db, seed }) => {
  const { source, client } = await marketplaceApp(seed, db, "unpublish_requested");
  const reviewer = await seed.human();
  const installer = await seed.human();
  const external = await seed.server({ owner: installer });
  await install(db, { serverId: source.id, clientId: client.id, userId: client.createdByUserId });
  await install(db, { serverId: external.id, clientId: client.id, userId: installer.id });

  const result = await decide(db, {
    clientId: client.id, decision: "reject", expectedStatus: "unpublish_requested", actorType: "human", actorId: reviewer.id, reason: "  keep listed for launch week\n",
  });
  assert.equal(result.status, "published");
  assert.deepEqual(result.removedBots, []);
  const [after] = await db.select().from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.deepEqual(
    { status: after!.publishStatus, listed: after!.humanMarketplaceVisible, reason: after!.publishRejectionReason },
    { status: "published", listed: true, reason: "keep listed for launch week" },
  );
  assert.equal((await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id))).length, 2);
  assert.deepEqual((await lastAudit(db, client.id, "app.offline_rejected"))?.metadata, {
    clientKey: client.clientId, appType: "third_party_global", previousPublishStatus: "unpublish_requested", nextPublishStatus: "published",
  });
});

test("publish approval sends a live action endpoint back to review with a new link-preview revision and installs the source with its permissions", async ({ db, seed }) => {
  const { client } = await marketplaceApp(seed, db, "in_review");
  const reviewer = await seed.human();
  const origin = `https://${randomUUID().slice(0, 8)}.example.test`;
  const [preview] = await db.insert(oauthAppLinkPreviews).values({
    clientId: client.id, origin, endpoint: `${origin}/preview`, paths: ["/x/*"], actionEndpoint: `${origin}/actions`, actionEndpointRejectReason: "older rejection",
  }).returning();
  await db.update(oauthClients).set({ outboundCurrentRevisionId: null, outboundCurrentGroups: ["messages.read"] }).where(eq(oauthClients.id, client.id));

  const result = await decide(db, { clientId: client.id, decision: "approve", expectedStatus: "in_review", actorType: "human", actorId: reviewer.id });
  assert.equal(result.status, "published");
  assert.equal(result.sourceInstallCreated, true);
  assert.equal(result.actionEndpointToReview, true);

  const [link] = await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id));
  assert.deepEqual(
    { live: link!.actionEndpoint, pending: link!.pendingActionEndpoint, requested: Boolean(link!.pendingActionEndpointRequestedAt), rejectReason: link!.actionEndpointRejectReason },
    { live: null, pending: `${origin}/actions`, requested: true, rejectReason: null },
  );
  assert.notEqual(link!.revision, preview!.revision, "outstanding card handles are voided");
  assert.equal((await lastAudit(db, client.id, "app.action_endpoint_requested"))?.metadata.clientKey, client.clientId);

  const [after] = await db.select().from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.deepEqual({ status: after!.publishStatus, listed: after!.humanMarketplaceVisible, reason: after!.publishRejectionReason }, { status: "published", listed: true, reason: null });
  const [sourceInstall] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
  assert.deepEqual(
    { serverId: sourceInstall!.serverId, by: sourceInstall!.installedByUserId, groups: sourceInstall!.approvedGroups, grantRevision: sourceInstall!.grantRevision, scopes: sourceInstall!.approvedScopes, text: sourceInstall!.confirmedTextRevisionId },
    { serverId: client.serverId, by: client.createdByUserId, groups: ["messages.read"], grantRevision: 0, scopes: effectiveAllowedOAuthScopes(client.allowedScopes), text: after!.textCurrentRevisionId },
  );
  assert.deepEqual((await lastAudit(db, client.id, "app.publish_approved"))?.metadata, {
    clientKey: client.clientId, appType: "third_party_global", previousPublishStatus: "in_review", nextPublishStatus: "published", installedCount: 1,
  });
});

test("publish approval brings an existing source installation's scopes up to date only for a human owner or admin of the App's Server", async ({ db, seed }) => {
  const scopesAfter = async (who: "outsider" | "agent" | "admin") => {
    const { publisher, source, client } = await marketplaceApp(seed, db, "publish_requested");
    const sourceInstall = await install(db, { serverId: source.id, clientId: client.id, userId: publisher.id, scopes: ["openid"] });
    let actor: { type: "human" | "agent"; id: string };
    if (who === "agent") {
      actor = { type: "agent", id: (await createAgent(source.id, `admin-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" })).id };
    } else {
      const human = await seed.human();
      if (who === "admin") await addMember(source.id, human.id, "admin");
      actor = { type: "human", id: human.id };
    }
    const result = await decide(db, { clientId: client.id, decision: "approve", expectedStatus: "publish_requested", actorType: actor.type, actorId: actor.id });
    assert.equal(result.sourceInstallCreated, false);
    const [row] = await db.select({ scopes: oauthClientInstalls.approvedScopes }).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, sourceInstall.id));
    const audit = await lastAudit(db, client.id, "installation.outbound_grant_updated");
    const current = effectiveAllowedOAuthScopes(client.allowedScopes);
    return {
      scopes: row!.scopes,
      audited: audit ? { actorType: audit.actorType, scopes: audit.metadata.approvedScopes } : null,
      current,
    };
  };
  const outsider = await scopesAfter("outsider");
  assert.deepEqual(outsider, { scopes: ["openid"], audited: null, current: outsider.current });
  const agent = await scopesAfter("agent");
  assert.deepEqual(agent, { scopes: ["openid"], audited: null, current: agent.current });
  const admin = await scopesAfter("admin");
  assert.deepEqual(admin, { scopes: admin.current, audited: { actorType: "human", scopes: admin.current }, current: admin.current });
});

test("publish rejection keeps the App type and records the reason; approval without a description is refused and changes nothing", async ({ db, seed }) => {
  const { publisher, source, client } = await marketplaceApp(seed, db, "publish_requested");
  const reviewer = await seed.human();
  await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, client.id));
  await decide(db, { clientId: client.id, decision: "reject", expectedStatus: "publish_requested", actorType: "human", actorId: reviewer.id, reason: "Remain local" });
  const [rejected] = await db.select().from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.deepEqual({ appType: rejected!.appType, status: rejected!.publishStatus, reason: rejected!.publishRejectionReason }, { appType: "server_local", status: "rejected", reason: "Remain local" });
  assert.deepEqual((await lastAudit(db, client.id, "app.publish_rejected"))?.metadata, {
    clientKey: client.clientId, appType: "server_local", previousPublishStatus: "publish_requested", nextPublishStatus: "rejected",
  });

  // Whitespace by JavaScript's trim(), non-breaking and ideographic spaces included.
  const blank = (await createOAuthClient({ serverId: source.id, createdByUserId: publisher.id, name: "Blank", appType: "third_party_global" })).client;
  await db.update(oauthClients).set({ publishStatus: "publish_requested", description: "  　\n" }).where(eq(oauthClients.id, blank.id));
  assert.equal(await refusal(db, { clientId: blank.id, decision: "approve", expectedStatus: "publish_requested", actorType: "human", actorId: reviewer.id }), "RVW06");
  const [unchanged] = await db.select({ status: oauthClients.publishStatus }).from(oauthClients).where(eq(oauthClients.id, blank.id));
  assert.equal(unchanged!.status, "publish_requested");
  assert.equal((await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, blank.id))).length, 0);
});

test("every argument is validated and every refusal has its own SQLSTATE", async ({ db, seed }) => {
  const { publisher, source, client } = await marketplaceApp(seed, db, "publish_requested");
  const reviewer = await seed.human();
  const retired = await seed.human();
  await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));
  const goneAgent = await createAgent(source.id, "gone-agent", { runtime: "claude", model: "sonnet" });
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, goneAgent.id));
  const ok: Args = { clientId: client.id, decision: "approve", expectedStatus: "publish_requested", actorType: "human", actorId: reviewer.id };

  const privateApp = (await createOAuthClient({ serverId: source.id, createdByUserId: publisher.id, name: "Private", appType: "third_party_global" })).client;
  const platformApp = (await createOAuthClient({ serverId: source.id, createdByUserId: publisher.id, name: "Platform", appType: "third_party_global" })).client;
  await db.update(oauthClients).set({ publishStatus: "publish_requested" }).where(eq(oauthClients.id, platformApp.id));
  await db.insert(externalAppRegistrations).values({
    id: randomUUID(), oauthClientId: platformApp.id, provider: "slack", environment: "test", state: "active",
    providerAppId: `A_${randomUUID().slice(0, 8)}`, providerOAuthClientId: `platform-${randomUUID().slice(0, 8)}`,
    capabilityManifestVersion: 1, capabilityManifestHash: `manifest-${randomUUID().slice(0, 8)}`, requiredCapabilities: ["channel_events"],
  });

  const cases: Array<[string, Args, string]> = [
    ["no client", { ...ok, clientId: null }, "RVW01"],
    ["no actor", { ...ok, actorId: null }, "RVW01"],
    ["unknown decision", { ...ok, decision: "publish" }, "RVW01"],
    ["no decision", { ...ok, decision: null }, "RVW01"],
    ["expected status not a request", { ...ok, expectedStatus: "published" }, "RVW01"],
    ["unknown actor type", { ...ok, actorType: "user" }, "RVW01"],
    ["reason with approve", { ...ok, reason: "fine" }, "RVW01"],
    ["reason over 1000 characters", { ...ok, decision: "reject", reason: "x".repeat(1001) }, "RVW01"],
    ["unknown human", { ...ok, actorId: randomUUID() }, "RVW01"],
    ["retired human", { ...ok, actorId: retired.id }, "RVW01"],
    ["deleted agent", { ...ok, actorType: "agent", actorId: goneAgent.id }, "RVW01"],
    ["a user id as an agent", { ...ok, actorType: "agent", actorId: reviewer.id }, "RVW01"],
    ["unknown App", { ...ok, clientId: randomUUID() }, "RVW02"],
    ["platform-managed App", { ...ok, clientId: platformApp.id }, "RVW03"],
    ["no open request", { ...ok, clientId: privateApp.id, expectedStatus: "publish_requested" }, "RVW04"],
    ["request moved to review since shown", { ...ok, expectedStatus: "in_review" }, "RVW05"],
    ["a publish request shown as an offline request", { ...ok, expectedStatus: "unpublish_requested" }, "RVW05"],
  ];
  for (const [name, args, code] of cases) {
    assert.equal(await refusal(db, args), code, name);
  }
  const [untouched] = await db.select({ status: oauthClients.publishStatus, reviewedAt: oauthClients.publishReviewedAt }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.deepEqual(untouched, { status: "publish_requested", reviewedAt: null });
  assert.equal(await lastAudit(db, client.id, "app.publish_approved"), null);

  // A reason of exactly 1000 characters is accepted.
  await decide(db, { ...ok, decision: "reject", reason: "y".repeat(1000) });
  const [rejected] = await db.select({ reason: oauthClients.publishRejectionReason }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(rejected!.reason?.length, 1000);
});
