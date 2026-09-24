import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalAppRegistrationSecrets,
  externalAppRegistrations,
  externalAppServerGrants,
  externalHumanIdentityLinks,
  externalOAuthAttempts,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema.js";
import { createServer, deleteServer } from "./serverService.js";
import {
  beginExternalOAuthAttempt,
  claimExternalOAuthAttempt,
  completeExternalOAuthAttempt,
  ExternalAppControlPlaneError,
} from "./externalAppControlPlaneService.js";

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

test(
  "OAuth completion locks the server before concurrent deletion can commit (real PG)",
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

      deletion = deleteServer(seeded.server.id);
      await waitForApplicationLock(observer, {
        waiterApplication: "slack-oauth-real-pg-completion",
        waiterQuery: "%update%servers%deleted_at%",
        blockerApplication: "slack-oauth-real-pg-completion",
        blockerQuery: "%external_app_registrations%for update%",
      });

      await holder.query("COMMIT");
      await completion;
      const deletionResult = await deletion;
      assert.equal(deletionResult?.newlyDeleted, true);

      const [install] = await getDb().select().from(externalAppInstalls);
      const [credential] = await getDb().select().from(externalAppCredentials);
      const [identityLink] = await getDb().select().from(externalHumanIdentityLinks);
      const [attempt] = await getDb().select().from(externalOAuthAttempts);
      const [server] = await getDb().select().from(servers).where(eq(servers.id, seeded.server.id));
      assert.equal(install?.state, "active");
      assert.equal(credential?.state, "active");
      assert.equal(identityLink?.state, "active");
      assert.equal(attempt?.status, "consumed");
      assert.ok(server?.deletedAt);
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
