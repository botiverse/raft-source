import { enableTestSlackIngress, writeSlackFixture } from "../test/integration/slackIngressRollout";
// This existing CI entry also runs the deletion-retirement PostgreSQL contract.
import "../db/slackDeletionRetirement.realPgContract";
/** Real PostgreSQL is required to exercise overlapping partition transactions. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, test } from "vitest";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { externalAppCredentials, externalAppInstalls, externalAppInstallServerGrants, externalAppServerGrants,
  externalActorProjections, externalAddressabilityProjections, externalChannelBindings, slackChannelDeletions, slackVerifiedIngressEvents, slackVerifiedIngressPartitions,
  slackVerifiedIngressReplayAudits, slackVerifiedIngressDedupe } from "../db/schema";
import { sealSlackVerifiedIngress } from "./slackVerifiedIngressCrypto";
import { enqueueSlackVerifiedIngress } from "./slackVerifiedIngressInbox";
import { claimSlackVerifiedIngressHead, claimSlackVerifiedIngressHeads, discardSlackVerifiedIngressClaim, deferUnrecognizedSlackIngressClaim, replayHeldSlackIngress } from "./slackVerifiedIngressWorker";
import { slackConversationAdvisoryKey } from "./slackBridgeRowLocks";
import { resolveExternalMentionFromDurableAuthority } from "./externalProjectionService";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { createSeed } from "../test/integration/seed";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge";
import { createSlackBridgeProvisioningControlPlane, slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES, type SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane";
import { hasNoRecoverableSlackPair, hasConfirmedSlackChannelDeletion, proveSlackVerifiedIngressDiscard } from "./slackVerifiedIngressPairProof";
import { loadSlackChannelDeletionEvidence } from "./slackChannelDeletionEvidence";
import { reconcileSlackChannelLifecycle, recordVerifiedSlackChannelDeletion } from "./slackBindingLifecycleService";
import type { SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";

const realPgUrl = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_URL;
const REQUIRED = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_REQUIRED === "1";
const DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
let createdDb: string | null = null;

afterAll(async () => {
  await closeDatabase().catch(() => {});
  if (!createdDb || !realPgUrl) return;
  const admin = new pg.Client({ connectionString: realPgUrl });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${createdDb}" WITH (FORCE)`);
  await admin.end();
});

async function isolatedDatabase(): Promise<string> {
  assert.ok(realPgUrl, "SLACK_VERIFIED_INGRESS_REAL_PG_URL is required");
  createdDb = `slack_inbox_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: realPgUrl });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query(`CREATE DATABASE "${createdDb}"`);
  await admin.end();
  const url = new globalThis.URL(realPgUrl);
  url.pathname = `/${createdDb}`;
  const migrator = new pg.Client({ connectionString: url.toString() });
  migrator.on("error", () => {});
  await migrator.connect();
  try {
    for (const entry of journal.entries) {
      await migrator.query("BEGIN");
      await migrator.query(readFileSync(`${DIR}/${entry.tag}.sql`, "utf8"));
      await migrator.query("COMMIT");
    }
  } finally {
    await migrator.end();
  }
  return url.toString();
}

const now = new Date("2026-08-05T12:00:00.000Z");
const key = Buffer.alloc(32, 7);
function event(id: string, channel = "C123"): SlackVerifiedIngressAad {
  return { purpose: "slack-verified-ingress", version: 1, registrationId: "11111111-1111-4111-8111-111111111111",
    environment: "test", providerAppId: "A123", providerAuthorityId: "T123",
    providerEventId: id, providerConversationId: channel };
}
function enqueue(aad: SlackVerifiedIngressAad) {
  const bytes = Buffer.from(`body ${aad.providerEventId}`);
  return enqueueSlackVerifiedIngress({ db: getDb(), aad,
    rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test-key", now,
    validateEndpoint: async () => true });
}

test("parallel PostgreSQL admission deduplicates and workers never overtake a leased head",
  { skip: !(realPgUrl || REQUIRED), timeout: 300_000 }, async () => {
    const databaseUrl = await isolatedDatabase();
    await initDatabase(databaseUrl);
    await enableTestSlackIngress();
    // One malformed event is held under the real protocol fence; a later
    // event can be claimed, and concurrent replay requests cannot duplicate it.
    const parked = await enqueue(event("Ev_PARK", "C_HELD"));
    await enqueue(event("Ev_AFTER_PARK", "C_HELD"));
    let clock = new Date(now);
    let parkedPartition = "";
    for (let n = 1; n <= 3; n++) {
      const heldClaim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "held-worker",
        leaseMs: 5_000, now: () => clock });
      assert.equal(heldClaim?.event.id, parked.id);
      parkedPartition = heldClaim!.partition.id;
      const retryAt = new Date(clock.getTime() + 1_000);
      assert.equal(await deferUnrecognizedSlackIngressClaim({ db: getDb(), partitionId: parkedPartition,
        eventId: parked.id, leaseOwner: "held-worker", leaseGeneration: heldClaim!.event.leaseGeneration,
        now: () => clock, retryAt, reason: "unsupported_event_format" }), n < 3 ? "retry" : "held");
      clock = retryAt;
    }
    const following = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "held-worker",
      leaseMs: 5_000, now: () => clock });
    assert.equal(following?.event.providerEventId, "Ev_AFTER_PARK");
    const replay = { db: getDb(), partitionId: parkedPartition, eventId: parked.id,
      now: () => clock, authorize: async () => ({ kind: "human" as const, id: "test-operator" }) };
    const replayResults = await Promise.all([replayHeldSlackIngress(replay), replayHeldSlackIngress(replay)]);
    assert.deepEqual(replayResults.sort(), [false, true]);
    const [replayed] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, parked.id));
    assert.equal(replayed.position, 3);
    assert.ok(replayed.encryptedPayload);
    const audits = await getDb().select().from(slackVerifiedIngressReplayAudits).where(eq(slackVerifiedIngressReplayAudits.eventId, parked.id));
    assert.equal(audits.length, 1, "concurrent replay records exactly one order exception");
    // Remove this test-only partition from further claims without retaining
    // test plaintext or bypassing the current writer protocol.
    // The audit has a restrictive FK to its event, so delete it first in this
    // disposable database; real replay audits are not cleared by this path.
    await getDb().delete(slackVerifiedIngressReplayAudits)
      .where(eq(slackVerifiedIngressReplayAudits.eventId, parked.id));
    for (const id of [parked.id, following!.event.id]) {
      await writeSlackFixture(() => getDb().update(slackVerifiedIngressEvents).set({ state: "discarded",
        outcomeReason: "test_finished", encryptedPayload: null, envelopeKeyId: null, leaseOwner: null, leaseExpiresAt: null })
        .where(eq(slackVerifiedIngressEvents.id, id)));
      await writeSlackFixture(() => getDb().delete(slackVerifiedIngressEvents)
        .where(eq(slackVerifiedIngressEvents.id, id)));
    }
    await getDb().delete(slackVerifiedIngressPartitions).where(eq(slackVerifiedIngressPartitions.id, parkedPartition));
    for (let i = 0; i < 8; i++) {
      await enqueue(event(`Ev_BATCH_${i}_FIRST`, `C_BATCH_${i}`));
      await enqueue(event(`Ev_BATCH_${i}_NEXT`, `C_BATCH_${i}`));
    }
    const batches = await Promise.all(["batch-a", "batch-b"].map(leaseOwner => claimSlackVerifiedIngressHeads({
      db: getDb(), leaseOwner, leaseMs: 10_000, now: () => now, limit: 4 })));
    const batchClaims = batches.flat();
    assert.equal(batchClaims.length, 8, "two workers claim distinct partitions concurrently");
    assert.equal(new Set(batchClaims.map(claim => claim.partition.id)).size, 8);
    assert.ok(batchClaims.every(claim => claim.event.providerEventId.endsWith("_FIRST")), "followers never overtake");
    for (let i = 0; i < 8; i++) {
      const partition = batchClaims.find(claim => claim.partition.providerConversationId === `C_BATCH_${i}`)!.partition;
      await writeSlackFixture(() => getDb().update(slackVerifiedIngressEvents).set({ state: "discarded",
        outcomeReason: "test_finished", encryptedPayload: null, envelopeKeyId: null, leaseOwner: null, leaseExpiresAt: null })
        .where(eq(slackVerifiedIngressEvents.partitionId, partition.id)));
      await writeSlackFixture(() => getDb().delete(slackVerifiedIngressEvents)
        .where(eq(slackVerifiedIngressEvents.partitionId, partition.id)));
      await getDb().delete(slackVerifiedIngressPartitions).where(eq(slackVerifiedIngressPartitions.id, partition.id));
    }
    const same = await Promise.all(Array.from({ length: 8 }, () => enqueue(event("Ev1"))));
    assert.equal(new Set(same.map((result) => result.id)).size, 1);
    assert.equal(same.filter((result) => result.kind === "receipt" && !result.duplicate).length, 1);
    await Promise.all([enqueue(event("Ev2")), enqueue(event("Ev3", "C_OTHER"))]);
    const events = await getDb().select().from(slackVerifiedIngressEvents);
    assert.equal(events.length, 3);
    const partitions = await getDb().select().from(slackVerifiedIngressPartitions);
    assert.equal(partitions.length, 2);
    const claims = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: `worker-${i}`, leaseMs: 10_000, now: () => now })));
    const claimed = claims.filter((value) => value !== null);
    assert.equal(claimed.length, 2);
    assert.deepEqual(new Set(claimed.map((value) => value.event.providerEventId)), new Set(["Ev1", "Ev3"]));
    assert.equal(await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "late-worker", leaseMs: 10_000, now: () => now }), null,
      "the second event cannot pass an already committed lease on the first");

    // Model a pair creation holding the same stable key across a reauth. This
    // exercises the actual discard helper's ordering, not the real pair writer
    // (which still needs wiring and a separate end-to-end concurrency test).
    await getDb().execute(sql`CREATE TABLE test_pair_exists (channel text PRIMARY KEY)`);
    await enqueue(event("Ev4", "C_LOCK"));
    const pending = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "discarder", leaseMs: 10_000, now: () => now });
    assert.ok(pending);
    assert.equal(pending.event.providerEventId, "Ev4");
    const creator = new pg.Client({ connectionString: databaseUrl });
    creator.on("error", () => {});
    await creator.connect();
    try {
      await creator.query("BEGIN");
      const lock = slackConversationAdvisoryKey({ registrationId: "11111111-1111-4111-8111-111111111111",
        providerAuthorityId: "T123", providerConversationId: "C_LOCK" });
      await creator.query("SELECT pg_advisory_xact_lock($1::bigint)", [lock.toString()]);
      await creator.query("INSERT INTO test_pair_exists(channel) VALUES ($1)", ["C_LOCK"]);
      let finished = false;
      const discard = discardSlackVerifiedIngressClaim({ db: getDb(), partitionId: pending.partition.id,
        eventId: pending.event.id, leaseOwner: "discarder", leaseGeneration: pending.event.leaseGeneration,
        now: () => now, reason: "no_recoverable_pair", proveDefinitiveAbsence: async (tx, partition) => {
          const result = await tx.execute(sql`SELECT channel FROM test_pair_exists WHERE channel = ${partition.providerConversationId}`);
          return result.rows.length === 0;
        } }).then((result) => { finished = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(finished, false, "discard must wait for the concurrent pair writer's key");
      await creator.query("COMMIT");
      assert.equal(await discard, false, "the committed pair defeats the absence proof");
      const [retained] = await getDb().select().from(slackVerifiedIngressEvents)
        .where(sql`${slackVerifiedIngressEvents.id} = ${pending.event.id}`);
      assert.ok(retained?.encryptedPayload, "uncertain or disproven absence must retain the payload");
    } finally {
      await creator.query("ROLLBACK").catch(() => {});
      await creator.end();
    }

    // Exercise the real saveChannelPairs path against the actual discard
    // helper. Hold the install row so the save holds its conversation key
    // while waiting; the discarder must not prove absence ahead of that save.
    const seed = createSeed(getDb());
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const channel = await seed.channel({ server, members: [owner] });
    const reg = "33333333-3333-4333-8333-333333333334";
    const oauthRedirectUri = "https://raft.example/api/slack-bridge/oauth/callback";
    const eventsRequestUrl = "https://bridge.example/api/slack-bridge/events";
    const bootstrap = {
      registrationId: reg, environment: "test" as const, providerAppId: "A_RACE",
      providerOAuthClientId: "race-client", oauthRedirectUri, eventsRequestUrl,
      capabilityManifestVersion: 1,
      capabilityManifestHash: slackBridgeProvisioningManifestHash({ oauthRedirectUri, eventsRequestUrl }),
      requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
      signingSecret: { encryptedSecretRef: "env:SLACK_BRIDGE_SIGNING_SECRET", envelopeKeyId: "env:process", secretRevision: 1 },
      oauthClientSecret: { encryptedSecretRef: "env:SLACK_BRIDGE_OAUTH_CLIENT_SECRET", envelopeKeyId: "env:process", secretRevision: 1 },
    };
    const provider: SlackBridgeProvisioningProvider = {
      async readInstallGrant() { return { kind: "unverified" }; },
      async readWorkspace() { return { oauth: "passed", directory: { kind: "fact", fact: {
        workspaceName: "Race workspace", channels: [{ id: "C_RACE", name: "race", privacyClass: "public", isMember: true }],
      } } }; },
      async readConversationAudience() { return { kind: "unverified" }; },
    };
    const controlPlane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap, provider });
    const request = { serverId: server.id, requestingUserId: owner.id, now: new Date() };
    await controlPlane.connect(request);
    const [grant] = await getDb().select().from(externalAppServerGrants)
      .where(eq(externalAppServerGrants.registrationId, reg));
    assert.ok(grant);
    const [install] = await getDb().insert(externalAppInstalls).values({
      serverId: server.id, registrationId: reg, serverGrantId: grant.id, grantEpoch: grant.grantEpoch,
      state: "active", installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES], providerAppId: "A_RACE",
      providerTeamId: "T_RACE", authorityType: "team", providerAuthorityId: "T_RACE",
      botUserId: "U_RACE", providerBotId: "B_RACE", workspaceName: "Race workspace",
    }).returning();
    assert.ok(install);
    await getDb().insert(externalAppInstallServerGrants).values({ installId: install.id, serverId: server.id,
      registrationId: reg, serverGrantId: grant.id, grantEpoch: grant.grantEpoch,
      authorizedByType: "human", authorizedById: owner.id });
    await getDb().insert(externalAppCredentials).values({ installId: install.id,
      encryptedMaterial: "sealed-test-material", envelopeKeyId: "test-key", credentialRevision: install.credentialRevision });
    const raceAad: SlackVerifiedIngressAad = { purpose: "slack-verified-ingress", version: 1,
      registrationId: reg, environment: "test", providerAppId: "A_RACE", providerAuthorityId: "T_RACE",
      providerEventId: "Ev_RACE", providerConversationId: "C_RACE" };
    const raceBytes = Buffer.from("race");
    await enqueueSlackVerifiedIngress({ db: getDb(), aad: raceAad, rawDigest: createHash("sha256").update(raceBytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes: raceBytes, key, aad: raceAad }),
      envelopeKeyId: "test-key", now, validateEndpoint: async () => true });
    const raceClaim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "race-discarder", leaseMs: 10_000, now: () => now });
    assert.equal(raceClaim?.event.providerEventId, "Ev_RACE");
    const holder = new pg.Client({ connectionString: databaseUrl });
    const observer = new pg.Client({ connectionString: databaseUrl });
    holder.on("error", () => {}); observer.on("error", () => {});
    await holder.connect(); await observer.connect();
    let saveOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    let proofOutcome: Promise<boolean> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [install.id]);
      saveOutcome = controlPlane.saveChannelPairs({ ...request, pairs: [{ raftChannelId: channel.id, slackChannelId: "C_RACE" }] })
        .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      const lock = slackConversationAdvisoryKey({ registrationId: reg, providerAuthorityId: "T_RACE", providerConversationId: "C_RACE" });
      let saveOwnsKey = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await observer.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [lock.toString()]);
        if (!result.rows[0].acquired) { saveOwnsKey = true; break; }
        await observer.query("SELECT pg_advisory_unlock($1::bigint)", [lock.toString()]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(saveOwnsKey, true, "real save must acquire the conversation key before the blocked install row");
      let discarded = false;
      proofOutcome = discardSlackVerifiedIngressClaim({ db: getDb(), partitionId: raceClaim!.partition.id,
        eventId: raceClaim!.event.id, leaseOwner: "race-discarder", leaseGeneration: raceClaim!.event.leaseGeneration,
        now: () => now, reason: "no_recoverable_pair", proveDefinitiveAbsence: proveSlackVerifiedIngressDiscard
      }).then((value) => { discarded = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(discarded, false, "discard must wait for the real pair creation");
      await holder.query("COMMIT");
      const saved = await saveOutcome;
      if (!saved.ok) throw saved.error;
      assert.equal(await proofOutcome, false, "the new actual pair defeats the absence proof");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await saveOutcome?.catch(() => {});
      await proofOutcome?.catch(() => {});
      await holder.end(); await observer.end();
    }
    // Both actual lifecycle writers must join the same serialization domain
    // before locking the install. This is an ordering check, not a claim that
    // other old or new writers have already been fenced.
    const [lifecycleBinding] = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.providerConversationId, "C_RACE"));
    assert.ok(lifecycleBinding);
    const lifecycleKey = slackConversationAdvisoryKey({ registrationId: reg,
      providerAuthorityId: "T_RACE", providerConversationId: "C_RACE" });
    const lifecycleHolder = new pg.Client({ connectionString: databaseUrl });
    const lifecycleObserver = new pg.Client({ connectionString: databaseUrl });
    lifecycleHolder.on("error", () => {});
    lifecycleObserver.on("error", () => {});
    await lifecycleHolder.connect(); await lifecycleObserver.connect();
    try {
      const holderPid = (await lifecycleHolder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const lifecycleOperations = [
        () => reconcileSlackChannelLifecycle({ serverId: server.id, registrationId: reg, installId: install.id,
          bindingId: lifecycleBinding.id, providerAuthorityId: "T_RACE", providerConversationId: "C_RACE",
          expectedConnectionEpoch: lifecycleBinding.connectionEpoch, expectedBindingEpoch: lifecycleBinding.bindingEpoch,
          event: { kind: "archived" }, now }),
        () => recordVerifiedSlackChannelDeletion({ registrationId: reg, environment: "test", providerAppId: "A_RACE",
          providerAuthorityId: "T_RACE", providerConversationId: "C_RACE", providerEventId: "Ev_RACE_DELETE",
          providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64), now }),
      ];
      for (const operation of lifecycleOperations) {
        await lifecycleHolder.query("BEGIN");
        await lifecycleHolder.query("SELECT pg_advisory_xact_lock($1::bigint)", [lifecycleKey.toString()]);
        let finished = false;
        const pending = operation().then((value) => { finished = true; return { value }; },
          (error: unknown) => { finished = true; return { error }; });
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !finished; attempt += 1) {
          const result = await getDb().execute(sql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE ${holderPid} = ANY (pg_blocking_pids(pid))
          ) AS blocked`);
          if ((result.rows[0] as { blocked: boolean }).blocked) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "lifecycle writer must wait for the stable conversation key");
        assert.equal(finished, false);
        await lifecycleHolder.query("COMMIT");
        const result = await pending;
        if ("error" in result) throw result.error;
        assert.ok(result.value);
      }
      for (const operation of lifecycleOperations) {
        await lifecycleHolder.query("BEGIN");
        await lifecycleHolder.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [install.id]);
        let finished = false;
        const pending = operation().then((value) => { finished = true; return { value }; },
          (error: unknown) => { finished = true; return { error }; });
        let ownsKey = false;
        for (let attempt = 0; attempt < 100 && !finished; attempt += 1) {
          const result = await lifecycleObserver.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [lifecycleKey.toString()]);
          if (!result.rows[0]!.acquired) { ownsKey = true; break; }
          await lifecycleObserver.query("SELECT pg_advisory_unlock($1::bigint)", [lifecycleKey.toString()]);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(ownsKey, true, "lifecycle writer must acquire the pair key before waiting for the install row");
        await lifecycleHolder.query("COMMIT");
        const result = await pending;
        if ("error" in result) throw result.error;
        assert.ok(result.value);
      }
    } finally {
      await lifecycleHolder.query("ROLLBACK").catch(() => {});
      await lifecycleHolder.end(); await lifecycleObserver.end();
    }
    // Recreate the released capture on the real schema to exercise the exact
    // retirement SQL against the actual signed-event writer in both orders.
    const oldMigration = readFileSync(`${DIR}/0486_slack_channel_deletion_evidence.sql`, "utf8")
      .split("--> statement-breakpoint");
    const captureFunction = oldMigration.find((part) => part.includes("CREATE FUNCTION capture_legacy_slack_channel_deletion()"));
    const captureTrigger = oldMigration.find((part) => part.includes("CREATE TRIGGER capture_legacy_slack_channel_deletion"));
    const retirementTag = journal.entries.find((entry) => entry.tag.endsWith("_slack_deletion_capture_retirement"))?.tag;
    assert.ok(captureFunction && captureTrigger && retirementTag);
    const retirementSql = readFileSync(`${DIR}/${retirementTag}.sql`, "utf8");
    const migrator = new pg.Client({ connectionString: databaseUrl });
    const retirementObserver = new pg.Client({ connectionString: databaseUrl });
    migrator.on("error", () => {}); retirementObserver.on("error", () => {});
    await migrator.connect(); await retirementObserver.connect();
    let releaseWriter = () => {};
    let firstWriter: Promise<Awaited<ReturnType<typeof recordVerifiedSlackChannelDeletion>>> | undefined;
    let secondWriter: Promise<Awaited<ReturnType<typeof recordVerifiedSlackChannelDeletion>>> | undefined;
    try {
      await getDb().delete(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
      await getDb().update(externalChannelBindings).set({ state: "active", stateReason: null })
        .where(eq(externalChannelBindings.id, lifecycleBinding.id));
      await migrator.query(captureFunction); await migrator.query(captureTrigger);
      let writerPid = 0;
      let writerReady = () => {};
      const ready = new Promise<void>((resolve) => { writerReady = resolve; });
      const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
      firstWriter = recordVerifiedSlackChannelDeletion({ registrationId: reg, environment: "test", providerAppId: "A_RACE",
        providerAuthorityId: "T_RACE", providerConversationId: "C_RACE", providerEventId: "Ev_RETIRE_FIRST",
        providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "c".repeat(64), now,
        verifySource: async (tx) => {
          const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          writerPid = Number((result.rows[0] as { pid: number }).pid);
          writerReady(); await release; return true;
        } });
      await Promise.race([ready, firstWriter.then(() => { throw new Error("writer ended before reaching the locked seam"); })]);
      await migrator.query("BEGIN");
      const migratorPid = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid as number;
      const retiring = migrator.query(retirementSql);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        blocked = (await retirementObserver.query("SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked", [writerPid, migratorPid])).rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "retirement must wait for the real signed writer");
      releaseWriter();
      assert.ok(await firstWriter); await retiring; await migrator.query("COMMIT");
      assert.equal((await getDb().select().from(slackChannelDeletions)).filter((row) => row.providerEventId === "Ev_RETIRE_FIRST").length, 1);

      await getDb().delete(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
      await getDb().update(externalChannelBindings).set({ state: "active", stateReason: null })
        .where(eq(externalChannelBindings.id, lifecycleBinding.id));
      await migrator.query(captureFunction); await migrator.query(captureTrigger);
      await migrator.query("BEGIN"); await migrator.query(retirementSql);
      let writerFinished = false;
      secondWriter = recordVerifiedSlackChannelDeletion({ registrationId: reg, environment: "test", providerAppId: "A_RACE",
        providerAuthorityId: "T_RACE", providerConversationId: "C_RACE", providerEventId: "Ev_RETIRE_SECOND",
        providerEventType: "channel_deleted", signingSecretRevision: 2, payloadSha256: "d".repeat(64), now })
        .then((value) => { writerFinished = true; return value; });
      blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked && !writerFinished; attempt += 1) {
        blocked = (await retirementObserver.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [migratorPid])).rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "the real signed writer must wait for retirement");
      await migrator.query("COMMIT"); assert.ok(await secondWriter);
      const finalFacts = await getDb().select().from(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
      assert.equal(finalFacts.filter((row) => row.providerEventId === "Ev_RETIRE_SECOND" && row.signingSecretRevision === 2).length, 1);
      assert.equal(finalFacts.filter((row) => row.sourceKind === "legacy_binding").length, 0, "removed trigger cannot fabricate a new legacy fact");

      // A legacy pause whose capture failed is turned into the same fact that
      // the actual inbound discard proof reads after retirement.
      await getDb().delete(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
      await migrator.query("BEGIN"); await migrator.query(retirementSql); await migrator.query("COMMIT");
      const backfilled = await getDb().select().from(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
      assert.equal(backfilled.length, 1); assert.equal(backfilled[0]!.sourceKind, "legacy_binding");
      assert.equal(await getDb().transaction((tx) => hasConfirmedSlackChannelDeletion(tx, raceClaim!.partition, raceClaim!.event)), true);
    } finally {
      releaseWriter(); await migrator.query("ROLLBACK").catch(() => {});
      await firstWriter?.catch(() => {}); await secondWriter?.catch(() => {});
      await migrator.end(); await retirementObserver.end();
    }
    // The rest of this test independently constructs deletion evidence.
    await getDb().delete(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
    const omissionHolder = new pg.Client({ connectionString: databaseUrl });
    omissionHolder.on("error", () => {});
    await omissionHolder.connect();
    let omission: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      await omissionHolder.query("BEGIN");
      const lock = slackConversationAdvisoryKey({ registrationId: reg, providerAuthorityId: "T_RACE", providerConversationId: "C_RACE" });
      await omissionHolder.query("SELECT pg_advisory_xact_lock($1::bigint)", [lock.toString()]);
      let finished = false;
      omission = controlPlane.saveChannelPairs({ ...request, pairs: [] })
        .then(() => { finished = true; return { ok: true as const }; },
          (error: unknown) => { finished = true; return { ok: false as const, error }; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(finished, false, "an omitted paused pair must take its own key before revocation");
      const [before] = await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.providerConversationId, "C_RACE"));
      assert.equal(before?.state, "paused");
      await omissionHolder.query("COMMIT");
      const result = await omission;
      if (!result.ok) throw result.error;
      const [after] = await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.providerConversationId, "C_RACE"));
      assert.equal(after?.state, "revoked");
    } finally {
      await omissionHolder.query("ROLLBACK").catch(() => {});
      await omission?.catch(() => {});
      await omissionHolder.end();
    }
    const provePair = proveSlackVerifiedIngressDiscard;
    assert.equal(await discardSlackVerifiedIngressClaim({ db: getDb(), partitionId: raceClaim!.partition.id,
      eventId: raceClaim!.event.id, leaseOwner: "race-discarder", leaseGeneration: raceClaim!.event.leaseGeneration,
      now: () => now, reason: "no_recoverable_pair", proveDefinitiveAbsence: provePair }), false,
    "a revoked binding still represents a recoverable pair");
    const [stillRetained] = await getDb().select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.id, raceClaim!.event.id));
    assert.ok(stillRetained?.encryptedPayload);

    const deletedScope = { registrationId: reg, environment: "test" as const, providerAppId: "A_RACE",
      providerAuthorityId: "T_RACE", providerConversationId: "C_RACE", sourceInstallId: install.id, observedAt: now };
    const [oldBinding] = await getDb().select({ id: externalChannelBindings.id }).from(externalChannelBindings)
      .where(eq(externalChannelBindings.providerConversationId, "C_RACE"));
    assert.ok(oldBinding);
    const deletion = () => getDb().transaction((tx) => hasConfirmedSlackChannelDeletion(tx, raceClaim!.partition, raceClaim!.event));
    assert.equal(await deletion(), false, "unknown evidence does not prove deletion");
    // A paused binding alone is not a deletion fact after migration.
    await getDb().update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted" })
      .where(eq(externalChannelBindings.id, oldBinding.id));
    await getDb().delete(slackChannelDeletions).where(eq(slackChannelDeletions.registrationId, reg));
    assert.equal(await loadSlackChannelDeletionEvidence(getDb(), deletedScope), null);
    assert.equal(await deletion(), false, "missing evidence cannot authorize deletion");
    await getDb().update(externalChannelBindings).set({ state: "revoked", stateReason: "binding_removed" })
      .where(eq(externalChannelBindings.id, oldBinding.id));
    assert.equal(await deletion(), false, "overwritten state without captured evidence stays unknown");
    await getDb().insert(slackChannelDeletions).values({ ...deletedScope, sourceKind: "legacy_binding",
      sourceKey: "legacy-1", sourceBindingId: oldBinding.id });
    assert.equal(await deletion(), true, "legacy binding evidence retains its real provenance");
    await getDb().insert(slackChannelDeletions).values({ ...deletedScope, sourceKind: "signed_event", sourceKey: "signed-1",
      providerEventId: "Ev_DELETE", providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64) });
    assert.equal(await deletion(), true);
    assert.equal(await getDb().transaction((tx) => hasConfirmedSlackChannelDeletion(tx, raceClaim!.partition,
      { ...raceClaim!.event, providerAppId: "A_OTHER" })), false, "another App's fact cannot authorize deletion");
    assert.equal(await discardSlackVerifiedIngressClaim({ db: getDb(), partitionId: raceClaim!.partition.id,
      eventId: raceClaim!.event.id, leaseOwner: "race-discarder", leaseGeneration: raceClaim!.event.leaseGeneration,
      now: () => now, reason: "destination_deleted", proveDefinitiveAbsence: proveSlackVerifiedIngressDiscard }), true);
    const [deletedReceipt] = await getDb().select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.id, raceClaim!.event.id));
    assert.equal(deletedReceipt?.outcomeReason, "destination_deleted");
    assert.equal(deletedReceipt?.encryptedPayload, null);

    const emptyAad = { ...raceAad, providerEventId: "Ev_EMPTY", providerConversationId: "C_EMPTY" };
    await enqueueSlackVerifiedIngress({ db: getDb(), aad: emptyAad,
      rawDigest: createHash("sha256").update(raceBytes).digest("hex"),
      encryptedPayload: sealSlackVerifiedIngress({ bytes: raceBytes, key, aad: emptyAad }),
      envelopeKeyId: "test-key", now, validateEndpoint: async () => true });
    const emptyClaim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "empty-discarder", leaseMs: 10_000, now: () => now });
    assert.equal(emptyClaim?.event.providerEventId, "Ev_EMPTY");
    assert.equal(await getDb().transaction((tx) => hasNoRecoverableSlackPair(tx, emptyClaim!.partition,
      { ...emptyClaim!.event, providerAppId: "A_OTHER" })), false, "a mismatched signed app is not an absence proof");
    assert.equal(await discardSlackVerifiedIngressClaim({ db: getDb(), partitionId: emptyClaim!.partition.id,
      eventId: emptyClaim!.event.id, leaseOwner: "empty-discarder", leaseGeneration: emptyClaim!.event.leaseGeneration,
      now: () => now, reason: "no_recoverable_pair", proveDefinitiveAbsence: provePair }), true);
    const [emptySettled] = await getDb().select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.id, emptyClaim!.event.id));
    assert.equal(emptySettled?.state, "discarded");
    assert.equal(emptySettled?.outcomeReason, "no_recoverable_pair");
    assert.equal(emptySettled?.encryptedPayload, null);

    const { expireSlackIngressDedupe, SLACK_INGRESS_TERMINAL_RETENTION_MS } = await import("./slackVerifiedIngressRetention");
    const old = new Date(now.getTime() - SLACK_INGRESS_TERMINAL_RETENTION_MS - 1);
    await getDb().insert(slackVerifiedIngressDedupe).values({ id: randomUUID(), appRegistrationId: event("x").registrationId,
      providerEventId: "Ev_EXPIRE_ONCE", providerAppId: "A123", environment: "test", providerAuthorityId: "T123",
      providerConversationId: "C123", rawDigest: "a".repeat(64), finishedAt: old });
    const retention = { db: getDb(), now, registrationId: event("x").registrationId, environment: "test" as const, limit: 1 };
    const expired = await Promise.all([expireSlackIngressDedupe(retention), expireSlackIngressDedupe(retention)]);
    assert.deepEqual(expired.sort(), [0, 1], "two workers cannot expire the same receipt twice");
    assert.equal((await getDb().select().from(slackVerifiedIngressDedupe)
      .where(eq(slackVerifiedIngressDedupe.providerEventId, "Ev_EXPIRE_ONCE"))).length, 0);

    // The CI PostgreSQL entry exercises the actual mention resolver against an
    // audience refresh's binding -> addressability order. This is deliberately
    // last: simulating protocol 3 changes a sticky singleton in this test DB.
    await getDb().execute(sql`UPDATE slack_verified_ingress_rollout SET minimum_writer_protocol = 3,
      generation = generation + 1, config_generation = config_generation + 1, config_digest = repeat('a', 64) WHERE id = 1`);
    const [remote] = await getDb().insert(externalActorProjections).values({ provider: "slack", appRegistrationId: reg,
      installId: install.id, workspaceId: "T_RACE", externalActorId: "UOTHER123", displayName: "Other bot", handles: ["otherbot"],
      actorKind: "remote", projectionRevision: 1, observedAt: now }).returning();
    const [bot] = await getDb().insert(externalActorProjections).values({ provider: "slack", appRegistrationId: reg,
      installId: install.id, workspaceId: "T_RACE", externalActorId: "BOTHER123", displayName: "Other bot", actorKind: "bot",
      projectionRevision: 1, observedAt: now, slackBotUserId: "UOTHER123", slackBotMappingRevision: 1,
      slackBotConnectionEpoch: lifecycleBinding.connectionEpoch, slackBotCredentialRevision: 1, slackBotScopeRevision: 1,
      slackBotMappingObservedAt: now, slackBotMappingExpiresAt: new Date(now.getTime() + 60_000) }).returning();
    await getDb().insert(externalAddressabilityProjections).values({ projectionId: remote!.id, provider: "slack",
      appRegistrationId: reg, installId: install.id, workspaceId: "T_RACE", connectionEpoch: lifecycleBinding.connectionEpoch,
      bindingId: lifecycleBinding.id, bindingEpoch: lifecycleBinding.bindingEpoch, conversationId: "C_RACE", memberRevision: 1,
      contextRevision: 1, state: "active", observedAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    const audience = new pg.Client({ connectionString: databaseUrl });
    const audienceErrors: Error[] = [];
    audience.on("error", error => audienceErrors.push(error)); await audience.connect();
    let mention: Promise<{ value: Awaited<ReturnType<typeof resolveExternalMentionFromDurableAuthority>> | null; error: unknown }> | undefined;
    try {
      await audience.query("BEGIN");
      const audiencePid = (await audience.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await audience.query("SELECT id FROM external_channel_bindings WHERE id = $1 FOR UPDATE", [lifecycleBinding.id]);
      mention = getDb().transaction(tx => resolveExternalMentionFromDurableAuthority({ executor: tx, rawHandle: "otherbot",
        explicitProjectionId: bot!.id, raftPrincipalCollision: false, now, context: { provider: "slack", appRegistrationId: reg,
          installId: install.id, workspaceId: "T_RACE", connectionEpoch: lifecycleBinding.connectionEpoch, bindingId: lifecycleBinding.id,
          bindingEpoch: lifecycleBinding.bindingEpoch, conversationId: "C_RACE", memberRevision: 1, contextRevision: 1 } }))
        .then(value => ({ value, error: null }), error => ({ value: null, error }));
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        blocked = (await audience.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [audiencePid])).rows[0]!.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, "mention resolver must wait on the binding before member locks");
      await audience.query("SET LOCAL lock_timeout = '3s'");
      await audience.query("SELECT id FROM external_addressability_projections WHERE projection_id = $1 FOR UPDATE", [remote!.id]);
      await audience.query("COMMIT");
      const result = await mention;
      if (result.error) throw result.error;
      assert.ok(result.value, "both transactions finish without deadlock, including revoked-authority fallback");
    } finally {
      await audience.query("ROLLBACK").catch(() => {});
      await mention?.catch(() => {});
      await audience.end();
      assert.deepEqual(audienceErrors, [], "unexpected mention-race PostgreSQL client errors");
    }
  });
