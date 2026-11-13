// Real-PostgreSQL teeth for the Slack Bridge row-lock order
// (slackBridgeRowLocks.ts). PGlite runs every transaction on one connection,
// so a lock-order deadlock only shows on a real multi-connection Postgres.
// CI: `probe-concurrency-real-pg`, with CHANNEL_CONVERSION_REAL_PG_URL (shared
// with the other lock-order teeth); locally: an empty PostgreSQL 17 database.
//
// Prod 2026-10-20 00:07:24Z: install-grant renewal held the install row and
// asked for the credential, while another task's credential-lease claim had
// locked the credential through `credentials JOIN installs FOR UPDATE` and
// asked for the install.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import {
  channels, externalAppIngressEndpoints, externalAppRegistrationSecrets, externalAppInstallServerGrants, externalChannelBindings,
  externalActorProjections, externalAddressabilityProjections,
  externalBindingAudienceSnapshots, externalDeliveryPartitions, featureFlags,
  externalAppCredentials,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  oauthClients,
  servers,
  users,
} from "../db/schema";
import { reconcileSlackChannelLifecycle, recordVerifiedSlackChannelDeletion } from "./slackBindingLifecycleService";
import { readSlackPairRecoveryFence } from "./slackBridgePairQueue";
import { prepareExternalBindingsForChannelConversion } from "./channelConversionPreparation";
import { parseSlackLifecycleClock } from "./slackChannelLifecycleObservation";
import { verifyAndAdmitSlackIngress } from "./externalAppIngressService";
import { lockSlackInstallCredential, lockSlackConversations, slackConversationAdvisoryKey } from "./slackBridgeRowLocks";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

const REAL_PG_URL = process.env.CHANNEL_CONVERSION_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const NOW = new Date();
const TEST_TIMEOUT_MS = 30_000;

async function withRealPg(run: () => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("CHANNEL_CONVERSION_REAL_PG_REQUIRED=1 but CHANNEL_CONVERSION_REAL_PG_URL is unset");
    return;
  }
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  await migrateRealPgTestDatabase(pool, MIGRATIONS_FOLDER);
  await initDatabase(REAL_PG_URL);
  try {
    await run();
  } finally {
    await closeDatabase();
    await pool.end();
  }
}

async function seedInstall() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `row-locks-${suffix}@raft.test`,
    name: `row-locks-${suffix}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: `row-locks-${suffix}`, slug: `row-locks-${suffix}`, ownerId: owner.id }).returning();
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `row-locks-${suffix}`,
    clientSecretHash: "x",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: [],
    createdByUserId: owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: `A_${suffix}`,
    providerOAuthClientId: `client-${suffix}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: "row-locks-v1",
    requiredCapabilities: ["channel_events"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    state: "active",
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "row-locks-v1",
    grantedCapabilities: ["channel_events"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 1,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: ["chat:write"],
    providerAppId: `A_${suffix}`,
    providerTeamId: `T_${suffix}`,
    authorityType: "team",
    providerAuthorityId: `T_${suffix}`,
    botUserId: `U_${suffix}`,
    providerBotId: `B_${suffix}`,
  }).returning();
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: "sealed-test-only",
    envelopeKeyId: "test-only",
    aadVersion: 1,
    credentialRevision: 1,
  });
  return install;
}

/** Resolves once some other backend is blocked on a lock held by `holderPid`. */
async function waitUntilBlockedBy(probe: pg.Client, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await probe.query<{ blocked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))) AS blocked",
      [holderPid],
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the claim never queued behind the renewal's install lock");
}

/** The SQLSTATE anywhere in the cause chain: drizzle wraps the pg error. */
function sqlState(error: unknown): string {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "error";
}

/**
 * The renewal's side: lock the install, let `claim` start and queue behind it,
 * then lock the credential (slackBridgeInstallGrantService's order). Returns
 * the SQLSTATE each side failed with, if any.
 */
async function raceRenewalAgainst(
  installId: string,
  claim: () => Promise<unknown>,
): Promise<{ renewal: string | null; claim: string | null }> {
  const renewal = new pg.Client({ connectionString: REAL_PG_URL });
  const probe = new pg.Client({ connectionString: REAL_PG_URL });
  await renewal.connect();
  await probe.connect();
  try {
    const { rows } = await renewal.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await renewal.query("BEGIN");
    await renewal.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [installId]);
    const claimed = claim().then(() => null, sqlState);
    await waitUntilBlockedBy(probe, rows[0]!.pid);
    let renewalError: string | null = null;
    try {
      await renewal.query("SELECT id FROM external_app_credentials WHERE install_id = $1 FOR UPDATE", [installId]);
      await renewal.query("COMMIT");
    } catch (error) {
      renewalError = sqlState(error);
      await renewal.query("ROLLBACK");
    }
    return { renewal: renewalError, claim: await claimed };
  } finally {
    await renewal.end();
    await probe.end();
  }
}

test("a credential claim queues behind an install-grant renewal instead of deadlocking", async () => {
  await withRealPg(async () => {
    const install = await seedInstall();
    let locked: Awaited<ReturnType<typeof lockSlackInstallCredential>> = null;
    const result = await raceRenewalAgainst(install.id, () => getDb().transaction(async (tx) => {
      locked = await lockSlackInstallCredential(tx, {
        installId: install.id,
        providerAppId: install.providerAppId,
        providerAuthorityId: install.providerAuthorityId,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
      }, NOW);
    }));
    assert.deepEqual(result, { renewal: null, claim: null });
    assert.equal(locked!.install.id, install.id);
    assert.equal(locked!.credential.installId, install.id);
  });
}, TEST_TIMEOUT_MS);

test("the old credentials JOIN installs FOR UPDATE claim deadlocks with the same renewal", async () => {
  await withRealPg(async () => {
    const install = await seedInstall();
    // The pre-fix claim (slackBridgeProviderRuntime selectCredential): one
    // join FOR UPDATE that takes the credential row, then waits for the install.
    const result = await raceRenewalAgainst(install.id, () => getDb().transaction(async (tx) => {
      await tx.execute(sqlOldJoinClaim(install.id));
    }));
    assert.ok(
      result.renewal === "40P01" || result.claim === "40P01",
      `expected one side to lose a deadlock, got ${JSON.stringify(result)}`,
    );
  });
}, TEST_TIMEOUT_MS);

function sqlOldJoinClaim(installId: string) {
  return sql`SELECT external_app_credentials.id
    FROM external_app_credentials
    INNER JOIN external_app_installs ON external_app_installs.id = external_app_credentials.install_id
    WHERE external_app_installs.id = ${installId} AND external_app_credentials.state = 'active'
    LIMIT 2 FOR UPDATE`;
}


for (const eventType of ["channel_archive", "member_joined_channel", "app_uninstalled"] as const) {
  test(`signed ${eventType} waits for the install before locking the shared signing source`, async () => {
    await withRealPg(async () => {
      const db = getDb(); const install = await seedInstall();
      const [grant] = await db.select({ grantedById: externalAppServerGrants.grantedById }).from(externalAppServerGrants).where(eq(externalAppServerGrants.id, install.serverGrantId));
      await db.insert(externalAppInstallServerGrants).values({ installId: install.id, serverId: install.serverId,
        registrationId: install.registrationId, serverGrantId: install.serverGrantId, grantEpoch: 1, state: "active",
        authorizedByType: "human", authorizedById: grant!.grantedById });
      const [channel] = await db.insert(channels).values({ serverId: install.serverId, name: `lifecycle-${randomUUID()}`, type: "channel" }).returning();
      await db.insert(externalChannelBindings).values({ serverId: install.serverId, registrationId: install.registrationId,
        installId: install.id, channelId: channel.id, providerConversationId: "C_LIFECYCLE", providerConversationKind: "public_channel",
        privacyClass: "public", state: "active", grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1,
        consentedByType: "human", consentedById: grant!.grantedById, consentedAt: NOW });
      const requestUrl = `https://lifecycle.test/${install.id}`;
      await db.insert(externalAppIngressEndpoints).values({ registrationId: install.registrationId, environment: "test",
        exactRequestUrl: requestUrl, endpointRevision: 1, signingSecretRevision: 1 });
      await db.insert(externalAppRegistrationSecrets).values({ registrationId: install.registrationId, purpose: "signing_secret",
        encryptedSecretRef: "synthetic", envelopeKeyId: "key", secretRevision: 1, aadVersion: 1 });
      const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: install.providerAppId,
        team_id: install.providerAuthorityId, event_id: `Ev_${randomUUID()}`, event_time: Math.floor(NOW.getTime() / 1000),
        event: { type: eventType, channel: "C_LIFECYCLE", user: "U_NEW_MEMBER" } }));
      const timestampHeader = String(Math.floor(NOW.getTime() / 1000));
      const signatureHeader = `v0=${createHmac("sha256", "synthetic-signing-secret").update(`v0:${timestampHeader}:`).update(rawBody).digest("hex")}`;
      const holder = new pg.Client({ connectionString: REAL_PG_URL }); const probe = new pg.Client({ connectionString: REAL_PG_URL });
      await holder.connect(); await probe.connect(); let admission: Promise<unknown> | undefined;
      try {
        const { rows: [backend] } = await holder.query("SELECT pg_backend_pid() AS pid");
        await holder.query("BEGIN"); await holder.query("SELECT id FROM external_app_installs WHERE id=$1 FOR UPDATE", [install.id]);
        admission = verifyAndAdmitSlackIngress({ requestUrl, environment: "test", rawBody, timestampHeader, signatureHeader,
          secretResolver: { async resolveSigningSecret() { return "synthetic-signing-secret"; } },
          payloadSealer: { async sealNormalizedPayload() { assert.fail("metadata cannot relay a body"); } }, now: NOW });
        // Attach rejection immediately, including the expected mutation-failure run.
        void admission.catch(() => undefined);
        await waitUntilBlockedBy(probe, backend.pid);
        await holder.query("SELECT id FROM external_app_registrations WHERE id=$1 FOR UPDATE NOWAIT", [install.registrationId]);
        await holder.query("COMMIT");
        await admission;
      } finally {
        await holder.query("ROLLBACK"); await admission?.catch(() => undefined);
        await holder.end(); await probe.end();
      }
    });
  }, TEST_TIMEOUT_MS);
}

test("lifecycle writers acquire the stable conversation lock before the install row", async () => {
  await withRealPg(async () => {
    const db = getDb();
    const install = await seedInstall();
    const [server] = await db.select().from(servers).where(eq(servers.id, install.serverId));
    const [channel] = await db.insert(channels).values({ serverId: server.id,
      name: `lock-${randomUUID()}`, type: "channel" }).returning();
    await db.insert(externalAppInstallServerGrants).values({ installId: install.id, serverId: server.id,
      registrationId: install.registrationId, serverGrantId: install.serverGrantId!, grantEpoch: install.grantEpoch,
      authorizedByType: "human", authorizedById: server.ownerId });
    const conversationId = `C_${randomUUID()}`;
    const [binding] = await db.insert(externalChannelBindings).values({ serverId: server.id,
      registrationId: install.registrationId, installId: install.id, channelId: channel.id,
      providerConversationId: conversationId, providerConversationKind: "public_channel", privacyClass: "public",
      grantEpoch: install.grantEpoch, connectionEpoch: install.connectionEpoch, bindingEpoch: 1,
      consentedByType: "human", consentedById: server.ownerId, consentedAt: NOW }).returning();
    const key = slackConversationAdvisoryKey({ registrationId: install.registrationId,
      providerAuthorityId: install.providerAuthorityId, providerConversationId: conversationId });
    const clock = (index: number) => {
      const parsed = parseSlackLifecycleClock(`${Math.floor(NOW.getTime() / 1000)}.${String(index).padStart(6, "0")}`);
      assert.ok(parsed); return parsed;
    };
    const coordinate = { serverId: server.id, registrationId: install.registrationId, installId: install.id,
      bindingId: binding.id, providerAuthorityId: install.providerAuthorityId, providerConversationId: conversationId,
      expectedConnectionEpoch: install.connectionEpoch, now: NOW };
    const operations = [
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 1, event: { kind: "archived" }, eventClock: clock(1) }),
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 2, event: { kind: "available", name: "verified-restored" }, eventClock: clock(2) }),
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 3, event: { kind: "renamed", name: "new-name" }, eventClock: clock(3) }),
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 3, event: { kind: "member_joined", userId: "U_NEW" }, eventClock: clock(4) }),
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 3, event: { kind: "member_left", userId: "U_NEW" }, eventClock: clock(5) }),
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 3, event: { kind: "member_left", userId: install.botUserId! }, eventClock: clock(6) }),
      () => reconcileSlackChannelLifecycle({ ...coordinate, expectedBindingEpoch: 4, event: { kind: "member_joined", userId: install.botUserId! }, eventClock: clock(7) }),
      () => recordVerifiedSlackChannelDeletion({ registrationId: install.registrationId, environment: "test",
        providerAppId: install.providerAppId, providerAuthorityId: install.providerAuthorityId,
        providerConversationId: conversationId, providerEventId: `Ev_${randomUUID()}`,
        providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64), now: NOW }),
    ];
    const holder = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await holder.connect(); await probe.connect();
    try {
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      for (const [index, operation] of operations.entries()) {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [key.toString()]);
        const pending = operation().then((value) => ({ value }), (error: unknown) => ({ error }));
        await waitUntilBlockedBy(probe, pid);
        await holder.query("COMMIT");
        const result = await pending;
        if ("error" in result) throw result.error;
        assert.ok(result.value);
        if (index < operations.length - 1) {
          assert.ok("kind" in result.value && result.value.kind === "applied", "the actual lifecycle mutation must apply");
        } else {
          assert.ok("paused" in result.value && result.value.paused, "the actual deletion must pause the pair");
        }
      }
      for (const operation of operations) {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [install.id]);
        const pending = operation().then((value) => ({ value }), (error: unknown) => ({ error }));
        let ownsKey = false;
        for (let i = 0; i < 100; i += 1) {
          const { rows } = await probe.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [key.toString()]);
          if (!rows[0]!.acquired) { ownsKey = true; break; }
          await probe.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(ownsKey, true, "conversation lock must precede the install row");
        await holder.query("COMMIT");
        const result = await pending;
        if ("error" in result) throw result.error;
        assert.ok(result.value);
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end(); await probe.end();
    }
  });
}, TEST_TIMEOUT_MS);

test("member lifecycle locks addressability before actor", async () => {
  await withRealPg(async () => {
    const db = getDb(); const install = await seedInstall();
    const [server] = await db.select().from(servers).where(eq(servers.id, install.serverId));
    await db.insert(externalAppInstallServerGrants).values({ installId: install.id, serverId: server.id,
      registrationId: install.registrationId, serverGrantId: install.serverGrantId!, grantEpoch: install.grantEpoch,
      authorizedByType: "human", authorizedById: server.ownerId });
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: `member-order-${randomUUID()}`, type: "channel" }).returning();
    const [binding] = await db.insert(externalChannelBindings).values({ serverId: server.id, registrationId: install.registrationId,
      installId: install.id, channelId: channel.id, providerConversationId: `C_${randomUUID()}`,
      providerConversationKind: "public_channel", privacyClass: "public", grantEpoch: install.grantEpoch,
      connectionEpoch: install.connectionEpoch, bindingEpoch: 1, consentedByType: "human", consentedById: server.ownerId, consentedAt: NOW }).returning();
    const [actor] = await db.insert(externalActorProjections).values({ provider: "slack", appRegistrationId: install.registrationId,
      installId: install.id, workspaceId: install.providerAuthorityId, externalActorId: "U_MEMBER_ORDER",
      displayName: "Synthetic member", actorKind: "human", projectionRevision: 1, observedAt: new Date(NOW.getTime() - 60_000) }).returning();
    const [address] = await db.insert(externalAddressabilityProjections).values({ projectionId: actor.id, provider: "slack",
      appRegistrationId: install.registrationId, installId: install.id, workspaceId: install.providerAuthorityId,
      connectionEpoch: 1, bindingId: binding.id, bindingEpoch: 1, conversationId: binding.providerConversationId,
      memberRevision: 1, contextRevision: 1, state: "active", observedAt: new Date(NOW.getTime() - 60_000),
      expiresAt: new Date(NOW.getTime() + 60_000) }).returning();
    const holder = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await holder.connect(); await probe.connect();
    try {
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM external_addressability_projections WHERE id=$1 FOR UPDATE", [address.id]);
      const actual = reconcileSlackChannelLifecycle({ db, serverId: server.id, registrationId: install.registrationId,
        installId: install.id, bindingId: binding.id, providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId, expectedConnectionEpoch: 1, expectedBindingEpoch: 1,
        event: { kind: "member_left", userId: actor.externalActorId }, now: NOW })
        .then(value => ({ value, error: null as string | null }), error => ({ value: null, error: sqlState(error) }));
      await waitUntilBlockedBy(probe, pid);
      await holder.query("SELECT id FROM external_actor_projections WHERE id=$1 FOR UPDATE NOWAIT", [actor.id]);
      await holder.query("COMMIT");
      const result = await actual;
      assert.equal(result.error, null);
      assert.equal(result.value?.kind, "applied");

    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end(); await probe.end();
    }
  });
}, TEST_TIMEOUT_MS);

test("a concurrent audience change fences a stale bot-recovery proof on real PostgreSQL", async () => {
  await withRealPg(async () => {
    const db = getDb(); const install = await seedInstall();
    const [server] = await db.select().from(servers).where(eq(servers.id, install.serverId));
    await db.insert(externalAppInstallServerGrants).values({ installId: install.id, serverId: server.id,
      registrationId: install.registrationId, serverGrantId: install.serverGrantId!, grantEpoch: install.grantEpoch,
      authorizedByType: "human", authorizedById: server.ownerId });
    await db.insert(featureFlags).values({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, randomizationUnit: "server", salt: "test", defaultEnabled: true })
      .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: true, killSwitch: false } });
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: `recovery-race-${randomUUID()}`, type: "channel" }).returning();
    const [binding] = await db.insert(externalChannelBindings).values({ serverId: server.id, registrationId: install.registrationId,
      installId: install.id, channelId: channel.id, providerConversationId: `C_${randomUUID()}`,
      providerConversationKind: "public_channel", privacyClass: "public", state: "paused", stateReason: "provider_bot_removed",
      grantEpoch: install.grantEpoch, connectionEpoch: install.connectionEpoch, bindingEpoch: 1,
      slackLifecycleObservation: { audienceEventRevision: 0 }, consentedByType: "human", consentedById: server.ownerId, consentedAt: NOW }).returning();
    const [actor] = await db.insert(externalActorProjections).values({ provider: "slack", appRegistrationId: install.registrationId,
      installId: install.id, workspaceId: install.providerAuthorityId, externalActorId: "U_RECOVERY_RACE",
      displayName: "Synthetic member", actorKind: "human", projectionRevision: 1, observedAt: new Date(NOW.getTime() - 60_000) }).returning();
    await db.insert(externalAddressabilityProjections).values({ projectionId: actor.id, provider: "slack", appRegistrationId: install.registrationId,
      installId: install.id, workspaceId: install.providerAuthorityId, connectionEpoch: 1, bindingId: binding.id,
      bindingEpoch: 1, conversationId: binding.providerConversationId, memberRevision: 1, contextRevision: 1, state: "active",
      observedAt: new Date(NOW.getTime() - 60_000), expiresAt: new Date(NOW.getTime() + 60_000) });
    const digest = (label: string) => createHash("sha256").update(JSON.stringify([label, [actor.externalActorId]])).digest("hex");
    await db.insert(externalBindingAudienceSnapshots).values({ bindingId: binding.id, bindingEpoch: 1, audienceRevision: 1,
      externalMemberCount: 1, raftMemberCount: 1, externalAudienceDigest: digest("slack-external-audience"),
      raftAudienceDigest: digest("raft-authorized-provider-audience"), status: "matched", observedAt: new Date(NOW.getTime() - 30_000),
      expiresAt: new Date(NOW.getTime() + 60_000) });
    const [partition] = await db.insert(externalDeliveryPartitions).values({ bindingId: binding.id, bindingEpoch: 1 }).returning();
    const coordinate = { db, serverId: server.id, registrationId: install.registrationId, installId: install.id,
      bindingId: binding.id, providerAuthorityId: install.providerAuthorityId, providerConversationId: binding.providerConversationId,
      expectedConnectionEpoch: 1, expectedBindingEpoch: 1, event: { kind: "available" as const, name: "current" }, now: NOW };
    const holder = new pg.Client({ connectionString: REAL_PG_URL }); const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await holder.connect(); await probe.connect();
    try {
      const priorFence = await readSlackPairRecoveryFence(db, { bindingId: binding.id, bindingEpoch: 1 });
      assert.ok(priorFence);
      // A separate transaction reports a bot failure after the proof began.
      // The earlier no-wait observation cannot authorize clearing it.
      await holder.query("UPDATE external_delivery_partitions SET authority_blocked_at=$2, authority_blocked_reason=$3 WHERE id=$1",
        [partition.id, NOW, "binding_paused_bot_removed"]);
      const newerWait = await reconcileSlackChannelLifecycle({ ...coordinate, verifiedAudience: { bindingEpoch: 1, credentialRevision: 1,
        audienceEventRevision: 0, revision: 1, queueFence: priorFence } });
      assert.equal(newerWait.kind, "fence_mismatch");
      assert.equal((await db.select().from(externalDeliveryPartitions).where(eq(externalDeliveryPartitions.id, partition.id)))[0]!.authorityBlockedReason, "binding_paused_bot_removed");
      const queueFence = await readSlackPairRecoveryFence(db, { bindingId: binding.id, bindingEpoch: 1 });
      assert.ok(queueFence);
      await holder.query("BEGIN");
      await holder.query("UPDATE external_channel_bindings SET slack_lifecycle_observation = $2::jsonb WHERE id=$1", [binding.id, JSON.stringify({ audienceEventRevision: 1 })]);
      const stale = reconcileSlackChannelLifecycle({ ...coordinate, verifiedAudience: { bindingEpoch: 1, credentialRevision: 1,
        audienceEventRevision: 0, revision: 1, queueFence } });
      void stale.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const whileLocked = await Promise.race([stale, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("recovery waited for a busy binding")), 2_000);
        })]);
        assert.equal(whileLocked.kind, "fence_mismatch");
      } finally { if (timer) clearTimeout(timer); }
      await holder.query("COMMIT");
      const afterCommit = await reconcileSlackChannelLifecycle({ ...coordinate, verifiedAudience: { bindingEpoch: 1, credentialRevision: 1,
        audienceEventRevision: 0, revision: 1, queueFence } });
      assert.ok(afterCommit.kind === "applied" || afterCommit.kind === "unchanged");
      assert.equal((await db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id)))[0]!.state, "paused");
      assert.equal((await db.select().from(externalDeliveryPartitions).where(eq(externalDeliveryPartitions.id, partition.id)))[0]!.authorityBlockedReason, "binding_paused_bot_removed");

      const freshAt = new Date(NOW.getTime() + 1_000);
      await reconcileSlackChannelLifecycle({ ...coordinate, now: freshAt, verifiedAudience: { bindingEpoch: 1, credentialRevision: 1,
        audienceEventRevision: 1, revision: 1, queueFence } });
      assert.equal((await db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id)))[0]!.state, "active");
      assert.equal((await db.select().from(externalDeliveryPartitions).where(eq(externalDeliveryPartitions.id, partition.id)))[0]!.authorityBlockedReason, null);
    } finally {
      await holder.query("ROLLBACK").catch(() => {}); await holder.end(); await probe.end();
    }
  });
}, TEST_TIMEOUT_MS);

test("bot recovery skips a binding held by real channel conversion instead of deadlocking", async () => {
  await withRealPg(async () => {
    const db = getDb(); const install = await seedInstall();
    const [server] = await db.select().from(servers).where(eq(servers.id, install.serverId));
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: `conversion-race-${randomUUID()}`, type: "channel" }).returning();
    const [binding] = await db.insert(externalChannelBindings).values({ serverId: server.id, registrationId: install.registrationId,
      installId: install.id, channelId: channel.id, providerConversationId: `C_${randomUUID()}`,
      providerConversationKind: "public_channel", privacyClass: "public", state: "active", stateReason: null,
      privacyFreshUntil: new Date(NOW.getTime() + 60_000), grantEpoch: install.grantEpoch, connectionEpoch: install.connectionEpoch,
      bindingEpoch: 1, slackLifecycleObservation: { audienceEventRevision: 0 }, consentedByType: "human",
      consentedById: server.ownerId, consentedAt: NOW }).returning();
    await db.insert(externalDeliveryPartitions).values({ bindingId: binding.id, bindingEpoch: 1,
      authorityBlockedAt: NOW, authorityBlockedReason: "slack_not_in_channel" });
    const queueFence = await readSlackPairRecoveryFence(db, { bindingId: binding.id, bindingEpoch: 1 });
    assert.ok(queueFence);
    const holder = new pg.Client({ connectionString: REAL_PG_URL }); const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await holder.connect(); await probe.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let conversion: Promise<number> | undefined;
    let recovery: ReturnType<typeof reconcileSlackChannelLifecycle> | undefined;
    try {
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM external_channel_bindings WHERE id=$1 FOR UPDATE", [binding.id]);
      conversion = db.transaction((tx) => prepareExternalBindingsForChannelConversion(tx, server.id, channel.id, false));
      void conversion.catch(() => undefined);
      await waitUntilBlockedBy(probe, pid);
      recovery = reconcileSlackChannelLifecycle({ db, serverId: server.id, registrationId: install.registrationId,
        installId: install.id, bindingId: binding.id, providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId, expectedConnectionEpoch: install.connectionEpoch,
        expectedBindingEpoch: binding.bindingEpoch, event: { kind: "available", name: "current" }, now: NOW,
        verifiedAudience: { bindingEpoch: 1, credentialRevision: 1, audienceEventRevision: 0, revision: 1, queueFence } });
      void recovery.catch(() => undefined);
      const result = await Promise.race([recovery, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("recovery waited for a binding while holding the partition")), 2_000);
      })]);
      assert.equal(result.kind, "fence_mismatch");
      await holder.query("COMMIT");
      assert.equal(await conversion, 0, "the real conversion check completes after recovery yields");
    } finally {
      if (timer) clearTimeout(timer);
      await holder.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([conversion, recovery].filter((pending) => pending !== undefined));
      await holder.end(); await probe.end();
    }
  });
}, TEST_TIMEOUT_MS);


test("stable conversation advisory lock serializes cross-install existence decisions", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withRealPg(async () => {
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const table = `cardy_pair_probe_${suffix}`;
    const key = { registrationId: `reg-${suffix}`, providerAuthorityId: "T_SAME", providerConversationId: "C_SAME" };
    assert.notEqual(slackConversationAdvisoryKey({ ...key, providerConversationId: "C_OTHER" }), slackConversationAdvisoryKey(key));
    assert.notEqual(slackConversationAdvisoryKey({ registrationId: "ab", providerAuthorityId: "c", providerConversationId: "d" }),
      slackConversationAdvisoryKey({ registrationId: "a", providerAuthorityId: "bc", providerConversationId: "d" }));
    await db.execute(sql.raw(`CREATE TABLE ${table} (install_id text NOT NULL, conversation_id text NOT NULL)`));
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await probe.connect();
    let signalLocked!: (pid: number) => void;
    let releaseWriter!: () => void;
    const locked = new Promise<number>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let seen = false;
    try {
      const writer = db.transaction(async (tx) => {
        await lockSlackConversations(tx, [key]);
        await tx.execute(sql.raw(`INSERT INTO ${table} VALUES ('new-install', 'C_SAME')`));
        const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        signalLocked(Number(result.rows[0]?.pid));
        await release;
      });
      const pid = await locked;
      const proof = db.transaction(async (tx) => {
        // This models a proof under the same actual channel key after an install change.
        await lockSlackConversations(tx, [key]);
        const rows = await tx.execute(sql.raw(`SELECT install_id FROM ${table} WHERE conversation_id = 'C_SAME'`));
        seen = rows.rows.some((row) => row.install_id === "new-install");
      });
      await waitUntilBlockedBy(probe, pid);
      releaseWriter();
      await Promise.all([writer, proof]);
      assert.equal(seen, true, "proof must see the committed pair instead of discarding a concurrent event");
    } finally {
      releaseWriter();
      await probe.end();
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
    }
  });
});
test("lifecycle locks registration before the server grant shared with another workspace renewal", async () => {
  await withRealPg(async () => {
    const db = getDb(); const install = await seedInstall();
    const [server] = await db.select().from(servers).where(eq(servers.id, install.serverId));
    const suffix = randomUUID().slice(0, 8);
    const [other] = await db.insert(externalAppInstalls).values({ serverId: server.id, registrationId: install.registrationId,
      serverGrantId: install.serverGrantId, grantEpoch: 1, state: "active", connectionEpoch: 1, scopeRevision: 1,
      credentialRevision: 1, installedScopes: ["chat:write"], providerAppId: install.providerAppId,
      providerTeamId: `T_SECOND_${suffix}`, authorityType: "team", providerAuthorityId: `T_SECOND_${suffix}`,
      botUserId: `U_SECOND_${suffix}`, providerBotId: `B_SECOND_${suffix}` }).returning();
    await db.insert(externalAppCredentials).values({ installId: other.id, state: "active", encryptedMaterial: "synthetic",
      envelopeKeyId: "test", aadVersion: 1, credentialRevision: 1 });
    for (const row of [install, other]) await db.insert(externalAppInstallServerGrants).values({
      installId: row.id, serverId: server.id, registrationId: install.registrationId, serverGrantId: install.serverGrantId!,
      grantEpoch: 1, state: "active", authorizedByType: "human", authorizedById: server.ownerId });
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: `two-workspaces-${suffix}`, type: "channel" }).returning();
    const [binding] = await db.insert(externalChannelBindings).values({ serverId: server.id, registrationId: install.registrationId,
      installId: install.id, channelId: channel.id, providerConversationId: `C_${suffix}`, providerConversationKind: "public_channel",
      privacyClass: "public", state: "active", grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1,
      consentedByType: "human", consentedById: server.ownerId, consentedAt: NOW }).returning();
    const renewal = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await renewal.connect(); await probe.connect();
    let lifecycle: Promise<{ value?: Awaited<ReturnType<typeof reconcileSlackChannelLifecycle>>; error?: string }> | undefined;
    try {
      const pid = (await renewal.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await renewal.query("BEGIN");
      // Actual renewal transaction prefix: its own install, shared registration,
      // its own credential, then server-grant authority. Two installs are essential.
      await renewal.query("SELECT id FROM external_app_installs WHERE id=$1 FOR UPDATE", [other.id]);
      await renewal.query("SELECT id FROM external_app_registrations WHERE id=$1 FOR UPDATE", [install.registrationId]);
      await renewal.query("SELECT id FROM external_app_credentials WHERE install_id=$1 FOR UPDATE", [other.id]);
      lifecycle = reconcileSlackChannelLifecycle({ db, serverId: server.id, registrationId: install.registrationId,
        installId: install.id, bindingId: binding.id, providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId, expectedConnectionEpoch: 1, expectedBindingEpoch: 1,
        event: { kind: "renamed", name: "after-renewal" }, now: NOW }).then(value => ({ value }), error => ({ error: sqlState(error) }));
      await waitUntilBlockedBy(probe, pid);
      let renewalError: string | null = null;
      try {
        await renewal.query("SELECT id FROM external_app_server_grants WHERE id=$1 FOR UPDATE", [install.serverGrantId]);
        await renewal.query("COMMIT");
      } catch (error) { renewalError = sqlState(error); await renewal.query("ROLLBACK"); }
      const result = await lifecycle;
      assert.deepEqual({ renewal: renewalError, lifecycle: result.error ?? null }, { renewal: null, lifecycle: null });
      assert.equal(result.value?.kind, "applied");
    } finally {
      await renewal.query("ROLLBACK").catch(() => {}); await lifecycle;
      await renewal.end(); await probe.end();
    }
  });
}, TEST_TIMEOUT_MS);
