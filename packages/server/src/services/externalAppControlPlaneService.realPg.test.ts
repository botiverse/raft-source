import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalAppRegistrationSecrets,
  externalAppRegistrations,
  externalAppServerGrants,
  externalOAuthAttempts,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema";
import { slackConversationAdvisoryKey } from "./slackBridgeRowLocks";
import { createServer, deleteServer } from "./serverService";
import {
  beginExternalOAuthAttempt,
  claimExternalOAuthAttempt,
  completeExternalOAuthAttempt,
  ExternalAppControlPlaneError,
} from "./externalAppControlPlaneService";

const REAL_PG_URL_ENV = "SLACK_BRIDGE_OAUTH_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.SLACK_BRIDGE_OAUTH_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

async function waitForApplicationLock(
  observer: pg.Client,
  input: {
    waiterApplication: string;
    waiterQuery: string;
    blockerApplication: string;
    blockerQuery: string;
  },
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query<{ wait_event_type: string | null }>(`
      SELECT waiter.wait_event_type
      FROM pg_stat_activity AS waiter
      CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocked_by(pid)
      INNER JOIN pg_stat_activity AS blocker ON blocker.pid = blocked_by.pid
      WHERE waiter.datname = current_database()
        AND waiter.application_name = $1
        AND waiter.query ILIKE $2
        AND blocker.application_name = $3
        AND blocker.query ILIKE $4
    `, [
      input.waiterApplication,
      input.waiterQuery,
      input.blockerApplication,
      input.blockerQuery,
    ]);
    if (result.rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected real PostgreSQL lock wait: ${input.waiterApplication} ${input.waiterQuery} blocked by ${input.blockerApplication} ${input.blockerQuery}`,
  );
}

async function seedAndClaim() {
  const [owner] = await getDb().insert(users).values({
    email: `slack-oauth-real-pg-${randomUUID()}@raft.test`,
    name: `Slack OAuth Real PG ${randomUUID().slice(0, 8)}`,
    displayName: "Slack OAuth Real PG Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(
    "Slack OAuth Real PG",
    `slack-oauth-real-pg-${randomUUID()}`,
    owner.id,
  );
  const [client] = await getDb().insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-oauth-real-pg-${randomUUID()}`,
    clientSecretHash: "not-a-real-secret",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await getDb().insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_TEST_BRIDGE",
    providerOAuthClientId: "oauth-client-test",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-v1",
    requiredCapabilities: ["external_projection", "channel_events"],
  }).returning();
  const [grant] = await getDb().insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  await getDb().insert(externalAppRegistrationSecrets).values([
    {
      registrationId: registration.id,
      purpose: "signing_secret",
      encryptedSecretRef: "sealed:test-signing-secret-ref",
      envelopeKeyId: "test-envelope-key",
      secretRevision: 1,
    },
    {
      registrationId: registration.id,
      purpose: "manifest_manager",
      encryptedSecretRef: "sealed:test-manifest-manager-ref",
      envelopeKeyId: "test-envelope-key",
      secretRevision: 1,
    },
  ]);

  const redirectUri = "https://raft.test/api/external-apps/slack/oauth/callback";
  const begun = await beginExternalOAuthAttempt({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: grant.grantEpoch,
    requestingUserId: owner.id,
    redirectUri,
    requestedScopes: ["channels:history", "chat:write"],
    grantIntent: `install:${server.id}:${registration.id}`,
  });
  const claimed = await claimExternalOAuthAttempt({
    state: begun.state,
    expectedEnvironment: "test",
    expectedRedirectUri: redirectUri,
  });
  return { owner, server, registration, claimed };
}

for (const concurrentCreate of [false, true]) test(
  concurrentCreate ? "OAuth retries when an install appears while registration is locked (real PG)"
    : "OAuth completion locks the server before concurrent deletion can commit (real PG)",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_slack_oauth_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "slack-oauth-real-pg-admin",
    });
    let databaseInitialized = false;
    let holder: pg.Client | undefined;
    let observer: pg.Client | undefined;
    let completion: ReturnType<typeof completeExternalOAuthAttempt> | undefined;
    let deletion: ReturnType<typeof deleteServer> | undefined;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const setupUrl = databaseUrlFor(REAL_PG_URL, databaseName, "slack-oauth-real-pg-setup");
      const setupPool = new pg.Pool({ connectionString: setupUrl, max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();

      const serviceUrl = databaseUrlFor(REAL_PG_URL, databaseName, "slack-oauth-real-pg-completion");
      await initDatabase(serviceUrl);
      databaseInitialized = true;
      const seeded = await seedAndClaim();

      holder = new pg.Client({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "slack-oauth-real-pg-holder"),
      });
      observer = new pg.Client({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "slack-oauth-real-pg-observer"),
      });
      await Promise.all([holder.connect(), observer.connect()]);

      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM external_app_registrations WHERE id = $1 FOR UPDATE",
        [seeded.registration.id],
      );

      completion = completeExternalOAuthAttempt({
        attemptId: seeded.claimed.attemptId,
        providerAppId: seeded.registration.providerAppId,
        providerTeamId: "T_TEST_WORKSPACE",
        providerUserId: "U_TEST_OWNER",
        botUserId: "U_TEST_BOT",
        providerBotId: "B_TEST_BOT",
        workspaceName: "Test Workspace",
        installedScopes: ["chat:write", "channels:history"],
        sealedCredential: {
          encryptedMaterial: "sealed:test-only-ciphertext",
          envelopeKeyId: "test-envelope-key",
          aadVersion: 1,
        },
      });
      await waitForApplicationLock(observer, {
        waiterApplication: "slack-oauth-real-pg-completion",
        waiterQuery: "%external_app_registrations%for update%",
        blockerApplication: "slack-oauth-real-pg-holder",
        blockerQuery: "%external_app_registrations%for update%",
      });

      const concurrentInstallId = randomUUID();
      if (concurrentCreate) {
        await holder.query(`INSERT INTO external_app_installs
          (id, server_id, registration_id, server_grant_id, grant_epoch, state,
           provider_app_id, provider_team_id, authority_type, provider_authority_id, bot_user_id, provider_bot_id)
          SELECT $1, server_id, registration_id, id, grant_epoch, 'active', $2,
            'T_TEST_WORKSPACE', 'team', 'T_TEST_WORKSPACE', 'U_TEST_BOT', 'B_TEST_BOT'
          FROM external_app_server_grants WHERE registration_id = $3 AND server_id = $4`,
          [concurrentInstallId, seeded.registration.providerAppId, seeded.registration.id, seeded.server.id]);
      } else {
      deletion = deleteServer(seeded.server.id);
      // Joint membership mirroring takes the server row before its J locks.
      // Deletion now waits at this initial SELECT, before the tombstone UPDATE;
      // still prove it is blocked by the real in-flight OAuth completion.
      await waitForApplicationLock(observer, {
        waiterApplication: "slack-oauth-real-pg-completion",
        waiterQuery: "%select%servers%for update%",
        blockerApplication: "slack-oauth-real-pg-completion",
        blockerQuery: "%external_app_registrations%for update%",
      });
      }

      await holder.query("COMMIT");
      await completion;
      const deletionResult = await deletion;
      if (!concurrentCreate) assert.equal(deletionResult?.newlyDeleted, true);

      const [install] = await getDb().select().from(externalAppInstalls);
      const [credential] = await getDb().select().from(externalAppCredentials);
      const [attempt] = await getDb().select().from(externalOAuthAttempts);
      const [server] = await getDb().select().from(servers).where(eq(servers.id, seeded.server.id));
      assert.equal(install?.state, "active");
      assert.equal(credential?.state, "active");
      // #11004 removed the per-member Slack identity link from OAuth
      // completion (private channels share the public authority path), so
      // completion no longer writes external_human_identity_links. The lock
      // ordering this test guards is unchanged: install, credential and
      // consumed attempt still commit before the concurrent deletion.
      assert.equal(attempt?.status, "consumed");
      if (concurrentCreate) {
        assert.equal(install.id, concurrentInstallId);
        assert.equal(install.connectionEpoch, 2);
        assert.equal(server?.deletedAt, null);
      } else assert.ok(server?.deletedAt);
    } finally {
      await holder?.query("ROLLBACK").catch(() => {});
      await completion?.catch(() => {});
      await deletion?.catch(() => {});
      await Promise.all([
        holder?.end().catch(() => {}),
        observer?.end().catch(() => {}),
      ]);
      if (databaseInitialized) await closeDatabase();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
);

for (const { operation, churn } of [
  { operation: "oauth", churn: 0 }, { operation: "disconnect", churn: 0 },
  { operation: "oauth", churn: 1 }, { operation: "disconnect", churn: 3 },
] as const) test(churn === 0 ? `${operation} and Slack lifecycle complete without deadlock (real PG)`
  : `${operation} ${churn === 1 ? "retries a changed conversation set" : "stops after three consecutive conversation-set races"} (real PG)`,
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 45_000 }, async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_slack_race_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    let holder: pg.Client | undefined;
    let observer: pg.Client | undefined;
    const holders: pg.Client[] = [];
    let opened = false;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const setupUrl = databaseUrlFor(REAL_PG_URL, databaseName, "oauth-race-setup");
      const pool = new pg.Pool({ connectionString: setupUrl, max: 2 });
      await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await pool.end();
      await initDatabase(databaseUrlFor(REAL_PG_URL, databaseName, "oauth-race-service"));
      opened = true;
      const seeded = await seedAndClaim();
      const [grant] = await getDb().select().from(schema.externalAppServerGrants)
        .where(eq(schema.externalAppServerGrants.registrationId, seeded.registration.id));
      const [install] = await getDb().insert(schema.externalAppInstalls).values({
        serverId: seeded.server.id, registrationId: seeded.registration.id, serverGrantId: grant.id,
        grantEpoch: grant.grantEpoch, state: "active", connectionEpoch: 1, scopeRevision: 1,
        credentialRevision: 1, installedScopes: ["chat:write", "channels:history"],
        providerAppId: seeded.registration.providerAppId, providerTeamId: "T_TEST_WORKSPACE",
        authorityType: "team", providerAuthorityId: "T_TEST_WORKSPACE", botUserId: "U_TEST_BOT", providerBotId: "B_TEST_BOT",
      }).returning();
      await getDb().insert(schema.externalAppInstallServerGrants).values({ installId: install.id,
        serverId: seeded.server.id, registrationId: seeded.registration.id, serverGrantId: grant.id,
        grantEpoch: grant.grantEpoch, state: "active", authorizedByType: "human", authorizedById: seeded.owner.id });
      const [channel] = await getDb().insert(schema.channels).values({ serverId: seeded.server.id,
        name: `oauth-race-${randomUUID()}`, type: "channel" }).returning();
      const [binding] = await getDb().insert(schema.externalChannelBindings).values({ serverId: seeded.server.id,
        registrationId: seeded.registration.id, installId: install.id, channelId: channel.id,
        providerConversationId: "C_TEST_RACE", providerConversationKind: "public_channel", privacyClass: "public",
        state: "active", grantEpoch: grant.grantEpoch, connectionEpoch: install.connectionEpoch, bindingEpoch: 1,
        consentedByType: "human", consentedById: seeded.owner.id, consentedAt: new Date() }).returning();
      if (churn === 0) {
        const { createFeatureFlagRule } = await import("./featureFlagService");
        const { SLACK_BRIDGE_FEATURE_FLAG_KEYS } = await import("@botiverse/raft-shared");
        const { slackBridgeInstallGrantHash } = await import("./slackBridgeInstallGrantService");
        await createFeatureFlagRule({ flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, stage: "server",
          decision: "allow", values: [seeded.server.id] });
        await getDb().insert(schema.externalAppCredentials).values({ installId: install.id, state: "active",
          encryptedMaterial: "sealed-test", envelopeKeyId: "test-key", credentialRevision: install.credentialRevision });
        await getDb().insert(schema.externalAppInstallGrantReceipts).values({ registrationId: seeded.registration.id,
          installId: install.id, receiptRevision: 1, connectionEpoch: install.connectionEpoch, scopeRevision: install.scopeRevision,
          credentialRevision: install.credentialRevision, providerAppId: install.providerAppId,
          providerAuthorityId: install.providerAuthorityId, botUserId: install.botUserId!, providerBotId: install.providerBotId!,
          grantedScopes: install.installedScopes, grantHash: slackBridgeInstallGrantHash({ providerAppId: install.providerAppId,
            providerAuthorityId: install.providerAuthorityId, botUserId: install.botUserId!, providerBotId: install.providerBotId!,
            grantedScopes: install.installedScopes }), observationSource: "token_introspection", status: "valid",
          observedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) });
        const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
        await enableTestSlackIngress();
      }
      const { reconcileSlackChannelLifecycle } = await import("./slackBindingLifecycleService");
      let disconnect: (() => Promise<unknown>) | undefined;
      if (operation === "disconnect") {
        await getDb().update(schema.oauthClients).set({ clientId: `slack-bridge:${seeded.registration.id}`,
          allowedScopes: [], description: "Raft first-party Slack Bridge control plane", publishStatus: "published",
          humanMarketplaceVisible: false, category: "Other" }).where(eq(schema.oauthClients.id, seeded.registration.oauthClientId));
        await getDb().insert(schema.externalAppRegistrationSecrets).values({ registrationId: seeded.registration.id,
          purpose: "oauth_client_secret", encryptedSecretRef: "sealed:test-oauth", envelopeKeyId: "test-envelope-key", secretRevision: 1 });
        const { createSlackBridgeProvisioningControlPlane } = await import("./slackBridgeProvisioningControlPlane");
        const secret = { envelopeKeyId: "test-envelope-key", secretRevision: 1 };
        const plane = createSlackBridgeProvisioningControlPlane({ bootstrap: {
          registrationId: seeded.registration.id, environment: "test", providerAppId: seeded.registration.providerAppId,
          providerOAuthClientId: seeded.registration.providerOAuthClientId, oauthRedirectUri: "https://raft.test/oauth/callback",
          eventsRequestUrl: "https://raft.test/slack/events", capabilityManifestVersion: 1, capabilityManifestHash: "manifest-v1",
          requiredCapabilities: ["external_projection", "channel_events"],
          signingSecret: { ...secret, encryptedSecretRef: "sealed:test-signing-secret-ref" },
          oauthClientSecret: { ...secret, encryptedSecretRef: "sealed:test-oauth" },
        }, provider: {} as never });
        disconnect = () => plane.disconnect({ serverId: seeded.server.id, requestingUserId: seeded.owner.id,
          expectedConnectionEpoch: install.connectionEpoch, now: new Date() });
      }
      if (churn === 0 || operation === "disconnect") {
        await getDb().insert(schema.externalAppIngressEndpoints).values({ registrationId: seeded.registration.id,
          environment: "test", exactRequestUrl: "https://raft.test/slack/events", signingSecretRevision: 1 });
      }
      let rawClaim: Awaited<ReturnType<typeof import("./slackVerifiedIngressWorker")["claimSlackVerifiedIngressHead"]>> = null;
      let productionPrepared: Extract<Awaited<ReturnType<ReturnType<typeof import("./slackVerifiedIngressPrepare")["createSlackVerifiedIngressPreparer"]>>>, { kind: "materialize" }> | null = null;
      if (churn === 0) {
        const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
        const { sealSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
        const { claimSlackVerifiedIngressHead } = await import("./slackVerifiedIngressWorker");
        const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
          registrationId: seeded.registration.id, environment: "test" as const, providerAppId: seeded.registration.providerAppId,
          providerAuthorityId: install.providerAuthorityId, providerConversationId: binding.providerConversationId,
          providerEventId: `Ev_MATERIALIZE_${operation}` };
        const envelope = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
          event_id: aad.providerEventId, event: { type: "reaction_added", user: install.botUserId, reaction: "thumbsup",
            event_ts: "1785758340.000001", item: { type: "message", channel: aad.providerConversationId, ts: "1785758339.000001" } } };
        const bytes = Buffer.from(JSON.stringify(envelope));
        await enqueueSlackVerifiedIngress({ db: getDb(), aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
          encryptedPayload: sealSlackVerifiedIngress({ bytes, key: Buffer.alloc(32, 9), aad }), envelopeKeyId: "test",
          now: new Date(), validateEndpoint: async () => true });
        rawClaim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "lock-race-materializer", leaseMs: 600_000,
          now: () => new Date(), scope: { registrationId: seeded.registration.id, environment: "test" } });
        assert.ok(rawClaim);
        const { createSlackVerifiedIngressPreparer } = await import("./slackVerifiedIngressPrepare");
        const prepare = createSlackVerifiedIngressPreparer({ db: getDb(), now: () => new Date(),
          runtimeResolver: { async resolveCurrentRuntime() { throw new Error("not used for a self reaction"); } },
          payloadSealer: { async sealNormalizedPayload(input) { return { encryptedPayload: input.plaintext,
            envelopeKeyId: "test", aadVersion: 1 }; } } });
        const candidate = await prepare(envelope, aad, rawClaim.event.receivedAt);
        assert.equal(candidate.kind, "materialize");
        if (candidate.kind !== "materialize") throw new Error("expected actual production preparer");
        productionPrepared = candidate;
      }
      holder = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "oauth-race-holder") });
      observer = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "oauth-race-observer") });
      holders.push(holder);
      await Promise.all([holder.connect(), observer.connect()]);
      let pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [install.id]);
      const lifecycle = churn === 0 ? reconcileSlackChannelLifecycle({ serverId: seeded.server.id, registrationId: seeded.registration.id,
        installId: install.id, bindingId: binding.id, providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId, expectedConnectionEpoch: install.connectionEpoch,
        expectedBindingEpoch: binding.bindingEpoch, event: { kind: "archived" }, now: new Date() })
        .then(value => ({ value }), error => ({ error })) : null;
      const waiters = async (count: number) => {
        for (let i = 0; i < 150; i += 1) {
          const rows = count === 1
            ? await observer!.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid])
            : await observer!.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = 'oauth-race-service' AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0");
          if (Number(rows.rows[0]!.n) >= count) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(`expected ${count} real waiters on install lock`);
      };
      if (lifecycle) await waiters(1);
      let oauthOutcome: { value?: unknown; error?: unknown } | undefined;
      const second = operation === "oauth" ? completeExternalOAuthAttempt({ attemptId: seeded.claimed.attemptId,
        providerAppId: seeded.registration.providerAppId, providerTeamId: "T_TEST_WORKSPACE", providerUserId: "U_TEST_OWNER",
        botUserId: "U_TEST_BOT", providerBotId: "B_TEST_BOT", installedScopes: ["chat:write", "channels:history"],
        sealedCredential: { encryptedMaterial: "sealed:test-only", envelopeKeyId: "test-only", aadVersion: 1 } }) : disconnect!();
      const oauth = second.then(value => (oauthOutcome = { value }), error => (oauthOutcome = { error }));
      try { await waiters(lifecycle ? 2 : 1); } catch (error) {
        const state = await observer!.query("SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked, left(query, 180) AS query FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'oauth-race-service'");
        throw new Error(`OAuth did not join the lock wait: ${oauthOutcome ? String(oauthOutcome.error ?? "completed") : "still running"}; ${JSON.stringify(state.rows)}`, { cause: error });
      }
      let signedReceipt: Promise<{ value?: unknown; error?: unknown }> | null = null;
      let materializer: Promise<{ value?: unknown; error?: unknown }> | null = null;
      if (churn === 0) {
        const { verifyAndAdmitSlackIngress } = await import("./externalAppIngressService");
        const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
        const now = new Date(); const timestampHeader = String(Math.floor(now.getTime() / 1000));
        const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: seeded.registration.providerAppId,
          team_id: install.providerAuthorityId, event_id: `Ev_LOCK_${operation}`, event: { type: "message",
            channel: binding.providerConversationId, user: "U_AUTHOR", ts: "1785758340.000001", text: "test" } }));
        const secret = "synthetic-signing-secret";
        const signatureHeader = `v0=${createHmac("sha256", secret).update(`v0:${timestampHeader}:`).update(rawBody).digest("hex")}`;
        const key = Buffer.alloc(32, 9);
        signedReceipt = verifyAndAdmitSlackIngress({ requestUrl: "https://raft.test/slack/events", environment: "test",
          rawBody, timestampHeader, signatureHeader, now,
          secretResolver: { async resolveSigningSecret() { return secret; } },
          payloadSealer: { async sealNormalizedPayload() { throw new Error("unused"); } },
          verifiedIngressCrypto: { async seal(input) { return { encryptedPayload: sealSlackVerifiedIngress({ ...input, key }), envelopeKeyId: "test" }; },
            async open(input) { return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad }); } },
        }).then(value => ({ value }), error => ({ error }));
        const { materializeSlackVerifiedIngressClaim } = await import("./slackVerifiedIngressWorker");
        materializer = materializeSlackVerifiedIngressClaim({ db: getDb(), partitionId: rawClaim!.partition.id,
          eventId: rawClaim!.event.id, leaseOwner: "lock-race-materializer", leaseGeneration: rawClaim!.event.leaseGeneration,
          now: () => new Date(), ...productionPrepared!,
        }).then(value => ({ value }), error => ({ error }));
        await waiters(4);
        const waitingOnConversation = await observer.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'oauth-race-service'
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'
            AND query ILIKE '%pg_advisory_xact_lock%'`);
        assert.equal(Number(waitingOnConversation.rows[0]!.n), 3,
          "OAuth/disconnect, signed receipt and materializer must wait on the lifecycle conversation key");
      }
      if (churn === 1) {
        const key = BigInt.asUintN(64, slackConversationAdvisoryKey({ registrationId: seeded.registration.id,
          providerAuthorityId: install.providerAuthorityId, providerConversationId: "C_CHANGED_1" }));
        await observer.query(`CREATE FUNCTION require_current_conversation_lock() RETURNS trigger LANGUAGE plpgsql AS $body$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND granted
              AND locktype = 'advisory' AND classid = ${(key >> 32n).toString()}::oid
              AND objid = ${(key & 0xffffffffn).toString()}::oid AND objsubid = 1) THEN
              RAISE EXCEPTION 'current conversation lock was not held';
            END IF;
            RETURN NEW;
          END $body$;
          CREATE TRIGGER require_current_conversation_lock BEFORE UPDATE OF state ON external_channel_bindings
          FOR EACH ROW EXECUTE FUNCTION require_current_conversation_lock()`);
      }
      for (let change = 0; change < churn; change++) {
        // Queue the next holder behind this attempt before releasing the old
        // holder. PostgreSQL gives it the install before our clean retry.
        let next: pg.Client | undefined;
        let nextLock: Promise<pg.QueryResult> | undefined;
        if (change + 1 < churn) {
          next = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, `oauth-race-holder-${change + 1}`) });
          holders.push(next); await next.connect(); await next.query("BEGIN");
          nextLock = next.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [install.id]);
          await waitForApplicationLock(observer, { waiterApplication: `oauth-race-holder-${change + 1}`,
            waiterQuery: "%external_app_installs%", blockerApplication: "oauth-race-service",
            blockerQuery: "%external_app_installs%" });
        }
        await holder.query("UPDATE external_channel_bindings SET provider_conversation_id = $1 WHERE id = $2", [`C_CHANGED_${change + 1}`, binding.id]);
        await holder.query("COMMIT");
        if (next && nextLock) {
          await nextLock; holder = next;
          pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          await waiters(1);
        }
      }
      if (churn === 0) await holder.query("COMMIT");
      const outcomes = await Promise.all([...(lifecycle ? [lifecycle, oauth] : [oauth]), ...(signedReceipt ? [signedReceipt] : []),
        ...(materializer ? [materializer] : [])]);
      const sqlState = (error: unknown) => { for (let current = error, i = 0; current && i < 6; i += 1) {
        const value = current as { code?: string; cause?: unknown }; if (value.code === "40P01") return value.code; current = value.cause;
      } return null; };
      for (const outcome of outcomes) assert.notEqual("error" in outcome ? sqlState(outcome.error) : null, "40P01",
        "actual control-plane and lifecycle calls must not deadlock");
      if (churn === 3) {
        assert.ok(oauthOutcome?.error instanceof ExternalAppControlPlaneError);
        assert.equal(oauthOutcome.error.code, "external_app_install_conflict");
      } else {
        for (const outcome of outcomes) if ("error" in outcome) throw outcome.error;
        if (signedReceipt) {
          const result = await signedReceipt;
          assert.equal((result.value as { kind?: string })?.kind, "event", "a valid signed receipt must be durably accepted");
          const stored = await getDb().select().from(schema.slackVerifiedIngressEvents)
            .where(eq(schema.slackVerifiedIngressEvents.providerEventId, `Ev_LOCK_${operation}`));
          assert.equal(stored.length, 1); assert.ok(stored[0]?.encryptedPayload);
        }
      }
      const [finished] = await getDb().select().from(schema.externalAppInstalls).where(eq(schema.externalAppInstalls.id, install.id));
      assert.equal(finished.connectionEpoch, install.connectionEpoch + (churn === 3 ? 0 : 1));
      assert.equal(finished.state, operation === "oauth" || churn === 3 ? "active" : "revoked");
      const [finalBinding] = await getDb().select().from(schema.externalChannelBindings).where(eq(schema.externalChannelBindings.id, binding.id));
      assert.equal(finalBinding.state, churn === 3 ? "active" : operation === "oauth" ? "paused" : "revoked");

    } finally {
      await Promise.all(holders.map(async client => { await client.query("ROLLBACK").catch(() => {}); await client.end().catch(() => {}); }));
      await observer?.end().catch(() => {});
      if (opened) await closeDatabase();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
