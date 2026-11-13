// Closed-server purge, the finish (closedServerPurgeFinish.ts, run by
// closedServerPurge.ts after a server's rows are deleted): a server in
// `rows_deleted` is picked up under delete mode's claim and every step runs,
// idempotent, to `done` with purged_at in one claim; a revoke that fails at
// the provider keeps that credential a day and is retried, up to
// REVOKE_ATTEMPTS, then our copy goes anyway; the system uninstall is audited
// as the system; and the kill switch, lease, stop rules, eligibility and
// per-server back-off still hold. No app, no network: the provider calls are
// fake revokers (closedServerPurgeRevoke.ts), fake steps where a test needs one.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { and, eq, inArray, ne } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentChannelReadCursors, agentMigrations, appOauthProfiles, channels, raftApps, externalAppCredentials, externalAppInstallServerGrants, externalAppInstalls, externalAppRegistrations, externalAppServerGrants, externalChannelBindings, integrationAuditEvents, managedMcpCredentials, managedMcpServers, oauthClientInstalls, oauthClients, oauthGrants, agentOperatorEvents, agentRuntimeProvisions, agents, featureFlags, reminders, serverFileUploadUsageMonths, serverInvites, servers, wechatBridgeBindings, workflowInstances, workflowTemplates } from "../db/schema";
import type { FirstPartyApp } from "../platform/apps";
import { close, DAY_MS, daysAgo, deleteFor, NOW, run as fixtureRun, seedServer } from "../test/closedServerPurgeFixture";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { setDefaultTraceTracer } from "../tracing/semanticTrace";
import { createAgent } from "./agentService";
import { CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, CLOSED_SERVER_PURGE_RUN_EVENT, countServer, type ClosedServerPurgeDeps } from "./closedServerPurge";
import { CREDENTIAL_REVOKE_EVENT, REVOKE_ATTEMPTS, revokeManagedMcpOAuthTokens, type ClosedServerPurgeRevokers } from "./closedServerPurgeRevoke";
import { encryptManagedMcpSecret } from "./managedMcpCredentialService";
import { CLOSED_SERVER_PURGE_FINISH_STEPS, type ClosedServerPurgeFinishStep } from "./closedServerPurgeFinish";
import { registerMachine } from "./machineService";
import { createSlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";

type Seed = ReturnType<typeof createSeed>;

// Managed MCP secrets are sealed with this deployment key (managedMcpCredentialService.ts).
const credentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
beforeAll(() => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterAll(() => {
  if (credentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = credentialKey;
});

const AVAILABLE = CLOSED_SERVER_PURGE_FINISH_STEPS;

/** Provider calls that succeed, recording what they were asked to revoke. */
function okRevokers(calls: string[] = []): ClosedServerPurgeRevokers {
  return {
    slackInstallToken: async (installId) => { calls.push(`slack:${installId}`); return { kind: "revoked" }; },
    managedMcpOAuth: async () => { calls.push("mcp"); return { kind: "revoked" }; },
  };
}

/** A run with the fake revokers (none of these tests reaches a provider). */
const run = (deps: ClosedServerPurgeDeps = {}, at: Date = NOW) => fixtureRun({ revokers: okRevokers(), ...deps }, at);
// 12:31Z the next day: past a day's wait, outside every quiet time.
const NEXT_DAY = new Date(NOW.getTime() + DAY_MS + 60_000);

/** An app that must not be called: the steps before rows_deleted are not redone. */
const noApp = { id: "fake-app", purgeServer: async () => { throw new Error("apps step redone"); } } as unknown as FirstPartyApp;

/**
 * A closed server (40 days) in delete mode with: a live hosted runtime, one
 * already deleted, a hosted agent mid-migration (optional), and a WeChat
 * binding; for server_rows: two reminders, two workflow templates (one named
 * by a workflow instance in the kept joint projection, RESTRICT), an invite, an agent's
 * operator event; and a file-upload quota month (billing, kept). `rowsDeleted`: left
 * in `rows_deleted` as an earlier version left it.
 */
async function seedFinish(seed: Seed, options: { rowsDeleted?: boolean; migrating?: boolean } = {}) {
  const base = await seedServer(seed);
  const db = getDb();
  const { owner, server } = base;
  const { machine: source } = await registerMachine(server.id, owner.id, "Source");
  const { machine: target } = await registerMachine(server.id, owner.id, "Target");
  const hosted = async (state: "active" | "deleted") => {
    const agent = await createAgent(server.id, `hosted-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: source.id });
    await db.insert(agentRuntimeProvisions).values({
      agentId: agent.id, serverId: server.id, provider: "antiproton", state, provisionedName: "n", provisionedInstructions: "i",
      encryptedCredential: state === "active" ? "sealed" : null,
    });
    return agent;
  };
  const live = await hosted("active");
  const gone = await hosted("deleted");
  const migrating = options.migrating ? await hosted("active") : null;
  if (migrating) {
    // Its deadlines an hour after NOW: active at NOW, expired the next day.
    const deadline = new Date(NOW.getTime() + 3_600_000);
    await db.insert(agentMigrations).values({
      serverId: server.id, agentId: migrating.id, sourceMachineId: source.id, targetMachineId: target.id, state: "in_transit",
      contractVersion: 2, grantKey: `finish-test:${randomUUID()}`, prepDeadlineAt: deadline, transferDeadlineAt: deadline,
      arrivalDeadlineAt: deadline, sourceMachineNameSnapshot: "Source", targetMachineNameSnapshot: "Target", initiatedByUserId: owner.id,
    } as typeof agentMigrations.$inferInsert);
  }
  const dm = await seed.channel({ server, members: [owner] });
  await db.insert(wechatBridgeBindings).values({
    serverId: server.id, userId: owner.id, agentId: live.id, dmChannelId: dm.id, ilinkBotId: `bot-${randomUUID()}` as never,
    ilinkUserId: `user-${randomUUID()}` as never, baseUrl: "https://ilink.example", encryptedBotToken: "sealed", envelopeKeyId: "k", aadVersion: 1,
  });
  const kept = base.skipped.joint[0]!;
  const reminder = async (title: string) => (await db.insert(reminders).values({ serverId: server.id, ownerAgentId: live.id, title, fireAt: NOW, createdByType: "human", createdById: owner.id }).returning())[0]!;
  await reminder("one");
  await reminder("two");
  const template = async (name: string) => (await db.insert(workflowTemplates).values({ serverId: server.id, name, steps: [], createdByType: "user", createdById: owner.id }).returning())[0]!;
  const [usedTemplate] = [await template("used"), await template("free")];
  await db.insert(workflowInstances).values({ templateId: usedTemplate!.id, serverId: server.id, channelId: kept, startedByType: "user", startedById: owner.id });
  await db.insert(serverInvites).values({ serverId: server.id, invitedEmail: "x@example.com", invitedByUserId: owner.id, tokenHash: randomUUID(), expiresAt: NOW });
  await db.insert(agentOperatorEvents).values({ serverId: server.id, agentId: live.id, actorKind: "system", kind: "system_restart" } as typeof agentOperatorEvents.$inferInsert);
  // The agent's read cursors: on the kept joint projection (stays) and on the storage server's canonical channel (goes).
  const [canonical] = await db.select({ id: channels.id }).from(channels).where(eq(channels.serverId, base.storage.id)).limit(1);
  await db.insert(agentChannelReadCursors).values([{ agentId: live.id, channelId: kept }, { agentId: live.id, channelId: canonical!.id }]);
  await db.update(agents).set({ description: "secret plans", envVars: { TOKEN: "x" }, runtimeConfig: {} as never, displayName: "Ada" }).where(eq(agents.id, live.id));
  await db.insert(serverFileUploadUsageMonths).values({ serverId: server.id, month: "2026-10", usedBytes: 10 });
  const suffix = randomUUID().slice(0, 8);
  // An app another server owns, installed here, with a grant to the agent.
  const [app] = await db.insert(oauthClients).values({ serverId: base.storage.id, clientId: `purge-app-${suffix}`, clientSecretHash: "hash", appType: "third_party_global", name: "App", createdByUserId: owner.id }).returning();
  await db.insert(oauthClientInstalls).values({ serverId: server.id, clientId: app!.id, installedByUserId: owner.id });
  await db.insert(oauthGrants).values({ serverId: server.id, agentId: live.id, clientId: app!.id, scopes: [], grantedByUserId: owner.id });
  // The Slack bridge: an install this server owns, its credential and grants, and a binding on the kept joint projection.
  const [slackClient] = await db.insert(oauthClients).values({ serverId: base.storage.id, clientId: `purge-slack-${suffix}`, clientSecretHash: "hash", appType: "slock_builtin", name: "Slack", createdByUserId: owner.id }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: slackClient!.id, provider: "slack", environment: "test", providerAppId: `A${suffix}`, providerOAuthClientId: `purge-${suffix}`,
    capabilityManifestVersion: 1, capabilityManifestHash: "manifest", requiredCapabilities: [],
  }).returning();
  const [serverGrant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id, registrationId: registration!.id, state: "active", grantEpoch: 1, grantedManifestVersion: 1,
    grantedManifestHash: "manifest", grantedCapabilities: [], grantedByType: "human", grantedById: owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id, registrationId: registration!.id, serverGrantId: serverGrant!.id, grantEpoch: 1, state: "active",
    connectionEpoch: 1, scopeRevision: 1, credentialRevision: 1, installedScopes: ["chat:write"], providerAppId: `A${suffix}`,
    providerTeamId: `T${suffix}`, authorityType: "team", providerAuthorityId: `T${suffix}`, botUserId: "U_BOT", providerBotId: "B_BOT",
  }).returning();
  await db.insert(externalAppCredentials).values({ installId: install!.id, state: "active", encryptedMaterial: "sealed", envelopeKeyId: "k", aadVersion: 1, credentialRevision: 1 });
  await db.insert(externalAppInstallServerGrants).values({
    installId: install!.id, serverId: server.id, registrationId: registration!.id, serverGrantId: serverGrant!.id, grantEpoch: 1,
    state: "active", authorizedByType: "human", authorizedById: owner.id,
  });
  await db.insert(externalChannelBindings).values({
    serverId: server.id, registrationId: registration!.id, installId: install!.id, channelId: kept, providerConversationId: `C${suffix}`,
    providerConversationKind: "public_channel", privacyClass: "public", state: "active", grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1,
    consentedByType: "human", consentedById: owner.id, consentedAt: NOW,
  });
  // A managed MCP App with an OAuth Connection (its authorization server publishes a revocation endpoint) and a header one.
  const [mcp] = await db.insert(managedMcpServers).values({ serverId: server.id, name: "Docs", endpointUrl: "https://mcp.example/mcp" } as typeof managedMcpServers.$inferInsert).returning();
  const [headerMcp] = await db.insert(managedMcpServers).values({ serverId: server.id, name: "Keys", endpointUrl: "https://keys.example/mcp" } as typeof managedMcpServers.$inferInsert).returning();
  await db.insert(managedMcpCredentials).values([
    { serverId: server.id, mcpServerId: mcp!.id, encryptedOAuth: encryptManagedMcpSecret(MCP_OAUTH) } as typeof managedMcpCredentials.$inferInsert,
    { serverId: server.id, mcpServerId: headerMcp!.id, encryptedHeaders: encryptManagedMcpSecret({ Authorization: "Bearer k" }) } as typeof managedMcpCredentials.$inferInsert,
  ]);
  await close(server.id, daysAgo(40));
  if (options.rowsDeleted) await db.update(servers).set({ purgeState: "rows_deleted" }).where(eq(servers.id, server.id));
  await deleteFor(server.id);
  return { ...base, agents: { live, gone, migrating }, app: app!, slack: { registration: registration!, serverGrant: serverGrant!, install: install! }, mcp: mcp! };
}

const MCP_OAUTH = {
  redirectUrl: "https://raft.example/cb",
  configuredClient: { clientId: "client-1", clientSecret: "s3cret", tokenEndpointAuthMethod: "client_secret_basic" as const },
  tokens: { access_token: "at-1", refresh_token: "rt-1", token_type: "bearer" },
  discoveryState: { authorizationServerUrl: "https://as.example", authorizationServerMetadata: { issuer: "https://as.example", authorization_endpoint: "https://as.example/a", token_endpoint: "https://as.example/t", response_types_supported: ["code"], revocation_endpoint: "https://as.example/revoke" } },
};

/** MCP_OAUTH whose stored revocation endpoint is on neither the token endpoint's nor the issuer's origin. */
const MISMATCHED_OAUTH = { ...MCP_OAUTH, discoveryState: { ...MCP_OAUTH.discoveryState, authorizationServerMetadata: { ...MCP_OAUTH.discoveryState.authorizationServerMetadata, revocation_endpoint: "https://collector.example/revoke" } } };

/** What the three revoke/uninstall steps leave of seedFinish's app, Slack and MCP rows. */
async function appRows(serverId: string) {
  const db = getDb();
  const n = async (rows: Promise<unknown[]>) => (await rows).length;
  return {
    installs: await n(db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.serverId, serverId))),
    grants: await n(db.select().from(oauthGrants).where(eq(oauthGrants.serverId, serverId))),
    slackInstalls: await n(db.select().from(externalAppInstalls).where(eq(externalAppInstalls.serverId, serverId))),
    slackBindings: await n(db.select().from(externalChannelBindings).where(eq(externalChannelBindings.serverId, serverId))),
    slackServerGrants: await n(db.select().from(externalAppServerGrants).where(eq(externalAppServerGrants.serverId, serverId))),
    mcpCredentials: await n(db.select().from(managedMcpCredentials).where(eq(managedMcpCredentials.serverId, serverId))),
    mcpServers: await n(db.select().from(managedMcpServers).where(eq(managedMcpServers.serverId, serverId))),
  };
}
const NO_APP_ROWS = { installs: 0, grants: 0, slackInstalls: 0, slackBindings: 0, slackServerGrants: 0, mcpCredentials: 0, mcpServers: 0 };

const revokeEvents = async (serverId: string) => getDb().select({ outcome: integrationAuditEvents.outcome, targetId: integrationAuditEvents.targetId, metadata: integrationAuditEvents.metadata })
  .from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, CREDENTIAL_REVOKE_EVENT)));

const provisionOf = async (agentId: string) =>
  (await getDb().select({ state: agentRuntimeProvisions.state, sealed: agentRuntimeProvisions.encryptedCredential, updatedAt: agentRuntimeProvisions.updatedAt })
    .from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId)))[0]!;
const serverRow = async (serverId: string) =>
  (await getDb().select({ state: servers.purgeState, purgedAt: servers.purgedAt, until: servers.purgeLeaseUntil, token: servers.purgeLeaseToken })
    .from(servers).where(eq(servers.id, serverId)))[0]!;
/** What server_rows deletes and keeps of seedFinish's rows. */
async function serverRows(serverId: string) {
  const db = getDb();
  return {
    reminders: (await db.select({ title: reminders.title }).from(reminders).where(eq(reminders.serverId, serverId))).map((row) => row.title).sort(),
    templates: (await db.select({ name: workflowTemplates.name }).from(workflowTemplates).where(eq(workflowTemplates.serverId, serverId))).map((row) => row.name).sort(),
    invites: (await db.select().from(serverInvites).where(eq(serverInvites.serverId, serverId))).length,
    operatorEvents: (await db.select().from(agentOperatorEvents).where(eq(agentOperatorEvents.serverId, serverId))).length,
    billing: (await db.select().from(serverFileUploadUsageMonths).where(eq(serverFileUploadUsageMonths.serverId, serverId))).length,
    agents: (await db.select().from(agents).where(eq(agents.serverId, serverId))).length,
    cursorsOnKept: (await db.select().from(agentChannelReadCursors).innerJoin(agents, eq(agents.id, agentChannelReadCursors.agentId))
      .innerJoin(channels, eq(channels.id, agentChannelReadCursors.channelId)).where(and(eq(agents.serverId, serverId), eq(channels.serverId, serverId)))).length,
    cursorsElsewhere: (await db.select().from(agentChannelReadCursors).innerJoin(agents, eq(agents.id, agentChannelReadCursors.agentId))
      .innerJoin(channels, eq(channels.id, agentChannelReadCursors.channelId)).where(and(eq(agents.serverId, serverId), ne(channels.serverId, serverId)))).length,
  };
}
const SEEDED_ROWS = { reminders: ["one", "two"], templates: ["free", "used"], invites: 1, operatorEvents: 1, billing: 1, cursorsOnKept: 1, cursorsElsewhere: 1 };
/** After server_rows: a row a kept row names stays (the template), as does one naming a kept channel (the cursor) and billing. */
const CLEARED_ROWS = { reminders: [], templates: ["used"], invites: 0, operatorEvents: 0, billing: 1, cursorsOnKept: 1, cursorsElsewhere: 0 };
const wechatBindings = async (serverId: string) => (await getDb().select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.serverId, serverId))).length;

function withTracer<T>(work: (sink: MemoryTraceSink) => Promise<T>): Promise<T> {
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink }));
  return work(sink).finally(() => setDefaultTraceTracer(null));
}
const eventsNamed = (sink: MemoryTraceSink, name: string) => sink.getAllLogEvents().filter((event) => event.name === name);

test("a server left in rows_deleted: the production finish runs every step and is done in one claim; a day later it is never a candidate", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true });
  const calls: string[] = [];
  const { result, sink } = await withTracer(async (sink) => ({ result: await run({ apps: [noApp], revokers: okRevokers(calls) }), sink }));
  const entry = result.purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.equal(entry.claimedState, "rows_deleted", "picked up where the earlier version left it");
  assert.deepEqual(await serverRow(s.server.id), { state: "done", purgedAt: NOW, until: null, token: null });

  // hosted_runtimes: through the agent-delete tombstone; the one already deleted is left as it is.
  assert.deepEqual({ ...(await provisionOf(s.agents.live.id)), updatedAt: undefined }, { state: "deleting", sealed: null, updatedAt: undefined });
  assert.equal((await provisionOf(s.agents.gone.id)).state, "deleted");
  assert.equal(entry.counts.hosted_runtimes_deletion_queued, 1);
  // wechat_bridge.
  assert.equal(await wechatBindings(s.server.id), 0);
  // server_rows: what a kept row names stays, a kept channel's rows stay, billing stays, the agents rows stay.
  assert.deepEqual({ ...(await serverRows(s.server.id)), agents: undefined }, { ...CLEARED_ROWS, agents: undefined });
  assert.ok((await serverRows(s.server.id)).agents >= 3, "the agents rows stay");
  assert.equal(entry.counts.server_rows_reminders, 2);
  // credential_revoke, app_installs, slack_bridge: revoked once each, then our side holds nothing.
  assert.deepEqual(calls.sort(), ["mcp", `slack:${s.slack.install.id}`].sort(), "one revoke per credential that has one: the OAuth Connection and the Slack install");
  assert.deepEqual(await appRows(s.server.id), NO_APP_ROWS, "a kept channel's Slack binding went too: it is the server's connection");
  assert.equal(entry.counts.app_installs_uninstalled, 1);
  assert.equal(entry.counts.app_grants_revoked, 1);
  assert.equal(entry.counts.slack_installs_deleted, 1);
  assert.equal(entry.counts.credentials_revoked, 2);
  const [uninstalled] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, s.server.id), inArray(integrationAuditEvents.eventType, ["marketplace.uninstalled", "private_share.uninstalled"])));
  assert.equal(uninstalled?.actorType, "system", "the system uninstalled it, never a made-up user");
  assert.equal(uninstalled?.actorId, null);
  assert.equal((uninstalled?.metadata as { reason?: string }).reason, "closed_server_purge");
  assert.deepEqual((await revokeEvents(s.server.id)).map((event) => event.outcome).sort(), ["success", "success"]);

  const [event] = eventsNamed(sink, CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT).filter((logged) => logged.attrs?.server_id === s.serverId);
  assert.equal(event!.attrs?.outcome, "done");
  const [finished] = eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT);
  assert.equal(finished!.attrs?.servers_done, 1);
  assert.equal(finished!.attrs?.servers_in_rows_deleted, 0, "it left rows_deleted");
  assert.ok(!(await run({ apps: [noApp] }, NEXT_DAY)).purged.some((purged) => purged.serverId === s.serverId), "done: never a candidate");
});

test("a revoke that fails at the provider keeps that credential and the server waits a day; retried once a run, after REVOKE_ATTEMPTS failures our copy goes all the same and the server is done", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true });
  let slackCalls = 0;
  const failing: ClosedServerPurgeRevokers = { ...okRevokers(), slackInstallToken: async () => { slackCalls += 1; return { kind: "failed", failure: "ratelimited" }; } };
  const days = Array.from({ length: REVOKE_ATTEMPTS }, (_, day) => new Date(NOW.getTime() + day * (DAY_MS + 60_000)));
  for (const [day, at] of days.entries()) {
    const entry = (await run({ revokers: failing }, at)).purged.find((purged) => purged.serverId === s.serverId)!;
    assert.equal(slackCalls, day + 1, "one attempt a run");
    if (day < REVOKE_ATTEMPTS - 1) {
      assert.equal(entry.outcome, "rows_deleted", `day ${day + 1}: waiting`);
      assert.equal(entry.counts.finish_waiting_slack_bridge, 1);
      assert.equal((await appRows(s.server.id)).slackInstalls, 1, "the install and its token stay for the retry");
      assert.equal((await serverRow(s.server.id)).until!.getTime(), at.getTime() + DAY_MS, "tried again a day later");
      assert.equal((await run({ revokers: failing }, at)).purged.some((purged) => purged.serverId === s.serverId), false, "not before then");
    } else {
      assert.equal(entry.outcome, "done", "given up: our copy deleted, done");
      assert.equal(entry.counts.credentials_revoke_gave_up, 1);
      assert.deepEqual(await appRows(s.server.id), NO_APP_ROWS);
    }
  }
  const slackEvents = (await revokeEvents(s.server.id)).filter((event) => event.targetId === s.slack.install.id);
  assert.deepEqual(slackEvents.map((event) => event.outcome), Array(REVOKE_ATTEMPTS).fill("failure"), "every failed attempt recorded");
  assert.deepEqual(slackEvents.map((event) => (event.metadata as { attempt: number }).attempt).sort(), Array.from({ length: REVOKE_ATTEMPTS }, (_, i) => i + 1));
  const last = slackEvents.find((event) => (event.metadata as { attempt: number }).attempt === REVOKE_ATTEMPTS)!;
  assert.equal((last.metadata as { gaveUp?: boolean }).gaveUp, true, "gaveUp is recorded on the last failure's own event");
  assert.equal((last.metadata as { failure?: string }).failure, "ratelimited", "with that failure");
  assert.equal(slackEvents.filter((event) => (event.metadata as { gaveUp?: boolean }).gaveUp).length, 1);
});

test("a Slack install another server also uses stays (with this server's grant it names); only this server's bridge rows go, and nothing is revoked", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true });
  const other = await seed.server({ owner: s.owner });
  const [otherGrant] = await getDb().insert(externalAppServerGrants).values({
    serverId: other.id, registrationId: s.slack.registration.id, state: "active", grantEpoch: 1, grantedManifestVersion: 1,
    grantedManifestHash: "manifest", grantedCapabilities: [], grantedByType: "human", grantedById: s.owner.id,
  }).returning();
  await getDb().insert(externalAppInstallServerGrants).values({
    installId: s.slack.install.id, serverId: other.id, registrationId: s.slack.registration.id, serverGrantId: otherGrant!.id, grantEpoch: 1,
    state: "active", authorizedByType: "human", authorizedById: s.owner.id,
  });
  const calls: string[] = [];
  const entry = (await run({ revokers: okRevokers(calls) })).purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.equal(entry.counts.slack_installs_shared_kept, 1);
  assert.ok(!calls.some((call) => call.startsWith("slack:")), "its token serves the other server");
  const rows = await appRows(s.server.id);
  assert.equal(rows.slackInstalls, 1, "the shared install stays");
  assert.equal(rows.slackServerGrants, 1, "with the grant it names (RESTRICT)");
  assert.equal(rows.slackBindings, 0);
  const otherGrants = await getDb().select().from(externalAppInstallServerGrants).where(eq(externalAppInstallServerGrants.serverId, other.id));
  assert.equal(otherGrants.length, 1, "the other server keeps its grant");
});

test("RFC 7009: the refresh token, then the access token, at the published revocation endpoint, as the Connection's client; no endpoint: nothing to call", async () => {
  const requests: Array<{ url: string; body: string; authorization?: string }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: String(init.body), authorization: (init.headers as Record<string, string>).authorization });
    return new Response("", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await revokeManagedMcpOAuthTokens(encryptManagedMcpSecret(MCP_OAUTH), { fetch }), { kind: "revoked" });
  assert.deepEqual(requests.map((request) => [request.url, new URLSearchParams(request.body).get("token_type_hint"), new URLSearchParams(request.body).get("token")]),
    [["https://as.example/revoke", "refresh_token", "rt-1"], ["https://as.example/revoke", "access_token", "at-1"]]);
  assert.equal(requests[0]!.authorization, `Basic ${Buffer.from("client-1:s3cret").toString("base64")}`, "client_secret_basic");
  const failing = (async () => new Response("", { status: 503 })) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await revokeManagedMcpOAuthTokens(encryptManagedMcpSecret(MCP_OAUTH), { fetch: failing }), { kind: "failed", failure: "http_503" });
  const noEndpoint = { ...MCP_OAUTH, discoveryState: { ...MCP_OAUTH.discoveryState, authorizationServerMetadata: { ...MCP_OAUTH.discoveryState.authorizationServerMetadata, revocation_endpoint: undefined } } };
  assert.deepEqual(await revokeManagedMcpOAuthTokens(encryptManagedMcpSecret(noEndpoint), { fetch }), { kind: "nothing_to_revoke" });

  // A revocation endpoint on neither the token endpoint's nor the issuer's origin: refused, nothing sent there.
  const before = requests.length;
  assert.deepEqual(await revokeManagedMcpOAuthTokens(encryptManagedMcpSecret(MISMATCHED_OAUTH), { fetch }), { kind: "refused", failure: "revocation_endpoint_origin_mismatch" });
  assert.equal(requests.length, before, "no request to the foreign endpoint");
  // The issuer's origin is enough (a token endpoint on another host of the same provider).
  const issuerOnly = { ...MCP_OAUTH, discoveryState: { ...MCP_OAUTH.discoveryState, authorizationServerMetadata: { ...MCP_OAUTH.discoveryState.authorizationServerMetadata, token_endpoint: "https://tokens.example/t" } } };
  assert.deepEqual(await revokeManagedMcpOAuthTokens(encryptManagedMcpSecret(issuerOnly), { fetch }), { kind: "revoked" });
});

test("a refused revoke (the revocation endpoint on a foreign origin) sends nothing, is recorded as a failure with its reason, is not retried, and the server is done", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true });
  await getDb().update(managedMcpCredentials).set({ encryptedOAuth: encryptManagedMcpSecret(MISMATCHED_OAUTH) })
    .where(eq(managedMcpCredentials.mcpServerId, s.mcp.id));
  const sent: string[] = [];
  const spy = (async (url: string) => { sent.push(String(url)); return new Response("", { status: 200 }); }) as unknown as typeof globalThis.fetch;
  const entry = (await run({ revokers: { ...okRevokers(), managedMcpOAuth: (encrypted) => revokeManagedMcpOAuthTokens(encrypted, { fetch: spy }) } }))
    .purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "done", "refused is final: nothing to wait for");
  assert.deepEqual(sent, [], "the tokens and the client secret went nowhere");
  assert.equal(entry.counts.credentials_refused, 1);
  assert.equal((await appRows(s.server.id)).mcpCredentials, 0, "our copy deleted");
  const [refused] = (await revokeEvents(s.server.id)).filter((event) => (event.metadata as { credentialKind: string }).credentialKind === "managed_mcp_oauth");
  assert.equal(refused!.outcome, "failure");
  assert.equal((refused!.metadata as { failure: string }).failure, "revocation_endpoint_origin_mismatch");
  assert.equal((refused!.metadata as { gaveUp?: boolean }).gaveUp, undefined, "distinguishable from a give-up");
});

test("with every step available: a full purge goes on from rows_deleted to done in one claim (purged_at set, lease cleared); done is never claimed again, and the finish run again changes nothing", async ({ seed }) => {
  const s = await seedFinish(seed);
  const { result, sink } = await withTracer(async (sink) => ({ result: await run({ finishSteps: AVAILABLE }), sink }));
  const entry = result.purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.equal(entry.claimedState, "apps");
  assert.ok((entry.counts.messages_deleted ?? 0) > 0, "the rows first");
  assert.equal(entry.counts.hosted_runtimes_deletion_queued, 1);
  assert.deepEqual({ ...(await serverRows(s.server.id)), agents: undefined }, { ...CLEARED_ROWS, agents: undefined });
  assert.deepEqual(await serverRow(s.server.id), { state: "done", purgedAt: NOW, until: null, token: null });
  // agent_tombstones: the rows stay, their content goes.
  const [tombstone] = await getDb().select().from(agents).where(eq(agents.id, s.agents.live.id));
  assert.deepEqual(
    { name: tombstone!.name, displayName: tombstone!.displayName, description: tombstone!.description, envVars: tombstone!.envVars, runtimeConfig: tombstone!.runtimeConfig, lastRuntimeError: tombstone!.lastRuntimeError, avatarUrl: tombstone!.avatarUrl },
    { name: `deleted-agent-${s.agents.live.id.replace(/-/g, "")}`, displayName: null, description: null, envVars: null, runtimeConfig: null, lastRuntimeError: null, avatarUrl: null },
  );
  assert.ok((entry.counts.agent_tombstones_scrubbed ?? 0) >= 3, "every agent of the server");
  const [finished] = eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT);
  assert.equal(finished!.attrs?.servers_done, 1);
  assert.equal(finished!.attrs?.servers_in_rows_deleted, 0, "passed through rows_deleted, not left there");

  assert.ok(!(await run({ finishSteps: AVAILABLE }, NEXT_DAY)).purged.some((purged) => purged.serverId === s.serverId), "done: not a candidate");

  // As if the commit that set `done` had been lost: the finish again.
  const live = await provisionOf(s.agents.live.id);
  await getDb().update(servers).set({ purgeState: "rows_deleted", purgedAt: null }).where(eq(servers.id, s.server.id));
  const rerun = (await run({ finishSteps: AVAILABLE, apps: [noApp] }, NEXT_DAY)).purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(rerun.outcome, "done");
  assert.equal(rerun.counts.hosted_runtimes_deletion_queued, 0);
  assert.equal(rerun.counts.wechat_bridge_bindings_removed, 0);
  assert.equal(rerun.counts.server_rows_deleted, 0);
  assert.equal(rerun.counts.agent_tombstones_scrubbed, 0, "a scrubbed tombstone is not touched again");
  assert.equal(rerun.counts.messages_deleted, undefined, "the delete's steps are not run again");
  assert.deepEqual(await provisionOf(s.agents.live.id), live, "the tombstone is not touched again");
  assert.equal((await serverRow(s.server.id)).state, "done");
});

test("a hosted agent mid-migration: its runtime is left, the step waits and the steps after it wait too; once the migration is over the finish completes", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true, migrating: true });
  const entry = (await run({ finishSteps: AVAILABLE })).purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "rows_deleted");
  assert.equal(entry.counts.finish_waiting_hosted_runtimes, 1);
  assert.equal(entry.counts.hosted_runtimes_skipped_migrating, 1);
  assert.equal(entry.counts.hosted_runtimes_deletion_queued, 1, "the other agent's runtime is queued");
  assert.equal((await provisionOf(s.agents.migrating!.id)).state, "active");
  assert.equal(await wechatBindings(s.server.id), 1, "the steps after it did not run");
  assert.deepEqual({ ...(await serverRows(s.server.id)), agents: undefined }, { ...SEEDED_ROWS, agents: undefined });
  assert.equal((await serverRow(s.server.id)).until!.getTime(), NOW.getTime() + DAY_MS);

  // The next day its deadlines have passed: no longer migrating.
  const later = (await run({ finishSteps: AVAILABLE }, NEXT_DAY)).purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(later.outcome, "done");
  assert.equal((await provisionOf(s.agents.migrating!.id)).state, "deleting");
  assert.equal(await wechatBindings(s.server.id), 0);
  assert.deepEqual({ ...(await serverRows(s.server.id)), agents: undefined }, { ...CLEARED_ROWS, agents: undefined });
});

test("the finish keeps delete mode's rules: kill switch, lease taken over, a stop rule, a reopened server, and one server's error backing off only that server", async ({ seed }) => {
  // Kill switch: set in the finish's first batch; the next batch sees it.
  const killed = await seedFinish(seed, { rowsDeleted: true });
  let switched = false;
  const killedEntry = (await run({
    finishSteps: AVAILABLE,
    hooks: {
      inBatch: async (serverId, state) => {
        if (serverId !== killed.serverId || state !== "rows_deleted" || switched) return;
        switched = true;
        await getDb().update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));
      },
    },
  })).purged.find((purged) => purged.serverId === killed.serverId)!;
  assert.equal(killedEntry.outcome, "flag_off");
  assert.deepEqual(await serverRow(killed.server.id), { state: "rows_deleted", purgedAt: null, until: null, token: null }, "lease released, not purged");
  assert.equal(await wechatBindings(killed.server.id), 1, "stopped before the next step");
  await getDb().update(featureFlags).set({ killSwitch: false }).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));

  // Lease taken over right after the claim; a reopened server; a stop rule.
  const taken = await seedFinish(seed, { rowsDeleted: true });
  const reopened = await seedFinish(seed, { rowsDeleted: true });
  const result = await run({
    finishSteps: AVAILABLE,
    hooks: {
      afterClaim: async (serverId) => {
        if (serverId === taken.serverId) await getDb().update(servers).set({ purgeLeaseToken: randomUUID() }).where(eq(servers.id, serverId));
        if (serverId === reopened.serverId) await getDb().update(servers).set({ deletedAt: null }).where(eq(servers.id, serverId));
      },
    },
  }, NEXT_DAY);
  assert.equal(result.purged.find((purged) => purged.serverId === taken.serverId)?.outcome, "lease_lost");
  assert.equal((await provisionOf(taken.agents.live.id)).state, "active", "lease lost: nothing done");
  assert.equal(result.purged.find((purged) => purged.serverId === reopened.serverId)?.outcome, "not_eligible");
  assert.equal((await provisionOf(reopened.agents.live.id)).state, "active", "reopened: nothing done");
  assert.equal((await serverRow(reopened.server.id)).state, null, "its progress cleared: a later close starts again");

  const stoppedServer = await seedFinish(seed, { rowsDeleted: true });
  const stopped = await run({ finishSteps: AVAILABLE, readGuards: async () => ({ slot: null, rwOverloadedRecently: true }) });
  assert.equal(stopped.stoppedReason, "rw_overloaded");
  assert.equal((await provisionOf(stoppedServer.agents.live.id)).state, "active", "stopped before any batch");
  assert.deepEqual(await serverRow(stoppedServer.server.id), { state: "rows_deleted", purgedAt: null, until: null, token: null });

  // A step's error: that server backs off a day in rows_deleted, the next server is finished.
  const [failing, next] = [await seedFinish(seed, { rowsDeleted: true }), await seedFinish(seed, { rowsDeleted: true })]
    .sort((a, b) => a.server.id.localeCompare(b.server.id));
  const throwing: ClosedServerPurgeFinishStep = {
    name: "fake",
    run: async ({ serverId }: { serverId: ServerId }) => {
      if (serverId === failing!.serverId) throw Object.assign(new Error("refused"), { name: "FakeStepRefused" });
      return "done";
    },
  };
  const errored = await run({ finishSteps: [...AVAILABLE, throwing] }, new Date(NEXT_DAY.getTime() + 60_000));
  const failed = errored.purged.find((purged) => purged.serverId === failing!.serverId)!;
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.errorClass, "FakeStepRefused");
  assert.deepEqual(await serverRow(failing!.server.id), { state: "rows_deleted", purgedAt: null, until: new Date(NEXT_DAY.getTime() + 60_000 + DAY_MS), token: null });
  assert.equal(errored.purged.find((purged) => purged.serverId === next!.serverId)?.outcome, "done");
});

test("count mode counts what server_rows will delete, with the same scope: a dry run of the first delete", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true });
  const counts: Record<string, number> = {};
  await countServer(getDb(), s.serverId, [], counts);
  const entry = (await run({ finishSteps: AVAILABLE })).purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "done");
  for (const table of ["reminders", "workflow_templates", "server_invites", "agent_operator_events", "agent_channel_read_cursors"]) {
    assert.equal(counts[`rows_${table}`], entry.counts[`server_rows_${table}`] ?? 0, table);
  }
  assert.equal(counts.rows_workflow_templates, 1, "the template a kept channel's workflow names is not counted");
  assert.equal(counts.rows_agent_channel_read_cursors, 1, "nor the cursor on the kept channel");
  assert.equal(counts.rows_server_file_upload_usage_months, undefined, "billing is never a server_rows table");
});

test("the Slack runtime's revokeInstallToken: auth.revoke with the install's unsealed token; a token Slack already rejects counts as revoked; no credential, nothing to call", async ({ seed }) => {
  const s = await seedFinish(seed);
  const answers: Array<Record<string, unknown>> = [{ ok: true, revoked: true }, { ok: false, error: "invalid_auth" }, { ok: false, error: "ratelimited" }];
  const requests: Array<{ url: string; authorization: string }> = [];
  const provider = createSlackBridgeProviderRuntime({
    db: getDb(),
    credentialCipher: { sealer: {} as never, unseal: (input) => (input.encryptedMaterial === "sealed" ? { accessToken: "xoxb-purge", tokenType: "bot" } : null) },
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), authorization: (init.headers as Record<string, string>).authorization! });
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  try {
    assert.deepEqual(await provider.revokeInstallToken(s.slack.install.id), { kind: "revoked" });
    assert.deepEqual(requests[0], { url: "https://slack.com/api/auth.revoke", authorization: "Bearer xoxb-purge" });
    assert.deepEqual(await provider.revokeInstallToken(s.slack.install.id), { kind: "revoked" }, "already dead at Slack");
    assert.deepEqual(await provider.revokeInstallToken(s.slack.install.id), { kind: "failed", failure: "ratelimited" });
    await getDb().delete(externalAppCredentials).where(eq(externalAppCredentials.installId, s.slack.install.id));
    assert.deepEqual(await provider.revokeInstallToken(s.slack.install.id), { kind: "no_credential" });
    assert.equal(requests.length, 3);
  } finally {
    await provider.stop();
  }
});

test("apps the closed server owns: one never shared (server_local, private, installed nowhere else, no share link) goes, its app root with it; a shared or published one stays; count mode counts the same", async ({ seed }) => {
  const s = await seedFinish(seed, { rowsDeleted: true });
  const db = getDb();
  const app = async (name: string, values: Partial<typeof oauthClients.$inferInsert> = {}) =>
    (await db.insert(oauthClients).values({ serverId: s.server.id, clientId: `${name}-${randomUUID().slice(0, 8)}`, clientSecretHash: "hash", name, createdByUserId: s.owner.id, ...values }).returning())[0]!;
  const local = await app("local");
  // Its app root and profile, as the oauth_clients trigger makes them (drizzle/0407).
  const [root] = await db.select({ id: appOauthProfiles.appId }).from(appOauthProfiles).where(eq(appOauthProfiles.oauthClientId, local.id));
  assert.ok(root && (await db.select().from(raftApps).where(eq(raftApps.id, root.id))).length === 1, "the app has its root");
  const installedElsewhere = await app("installed-elsewhere");
  await db.insert(oauthClientInstalls).values({ serverId: s.storage.id, clientId: installedElsewhere.id, installedByUserId: s.owner.id });
  const published = await app("published", { appType: "third_party_global", publishStatus: "published" });

  const counts: Record<string, number> = {};
  await countServer(getDb(), s.serverId, [], counts);
  assert.equal(counts.own_apps_deletable, 1);
  assert.equal(counts.own_apps_kept, 2);

  const entry = (await run()).purged.find((purged) => purged.serverId === s.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.equal(entry.counts.own_apps_deleted, 1);
  assert.equal(entry.counts.own_apps_kept_shared, 2);
  assert.equal(entry.counts.app_roots_deleted, 0, "its root went with it (the 0407 trigger); none was left over");
  const left = (await db.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.serverId, s.server.id))).map((row) => row.id).sort();
  assert.deepEqual(left, [installedElsewhere.id, published.id].sort());
  assert.equal((await db.select().from(raftApps).where(eq(raftApps.id, root!.id))).length, 0);
  assert.equal((await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, installedElsewhere.id))).length, 1, "the other server's install is untouched");
});
