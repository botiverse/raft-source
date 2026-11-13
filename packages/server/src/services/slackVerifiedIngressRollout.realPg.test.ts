import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, getRootDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { createSeed } from "../test/integration/seed";
import { enqueueExternalInboundEvent, processExternalInboundEventOnce } from "./externalInboundWorkerService";
import { createSlackVerifiedIngressEnvCrypto } from "./slackVerifiedIngressEnvCrypto";
import { enqueueSlackVerifiedIngress } from "./slackVerifiedIngressInbox";
import { SLACK_INBOUND_HEAD_INDEX } from "./slackVerifiedIngressIndexContract";
import { SLACK_BOT_WAKE_INDEX } from "./slackBotWakeIndexContract";
import { evaluatePostMigrationIndexes, POST_MIGRATION_INDEXES, readObservedIndexes } from "../db/postMigrationIndexes";
import { parseSlackIngressReleaseRecord, SlackIngressRolloutUnavailable } from "./slackVerifiedIngressRolloutContracts";
import { applySlackVerifiedIngressDeployment } from "./slackVerifiedIngressDeployment";
import { readSlackIngressRollout, setSlackIngressConsumption, withSlackIngressAdmissionFence,
  withSlackIngressProtocol } from "./slackVerifiedIngressRollout";

const PG_URL = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_URL;
const REQUIRED = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_REQUIRED === "1";
const OPTIONS = { skip: !(PG_URL || REQUIRED), timeout: 60_000 };
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const RELEASE = parseSlackIngressReleaseRecord("00000000-0000-4000-8000-000000000022");
const NOW = new Date("2026-08-05T12:00:00Z");

test("the deployment index guard accepts the actual concurrent ingress index (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  await client.query(SLACK_INBOUND_HEAD_INDEX.createSql);
  const spec = POST_MIGRATION_INDEXES.find(item => item.name === SLACK_INBOUND_HEAD_INDEX.name);
  assert.ok(spec);
  const observed = await readObservedIndexes(async (text, values) => {
    const result = await client.query(text, values);
    return { rows: result.rows };
  }, [spec]);
  assert.equal(evaluatePostMigrationIndexes(observed, [spec])[0]?.state, "ok");
}));

test("the bot wake index is built concurrently and the catalog guard rejects a wrong definition (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const spec = POST_MIGRATION_INDEXES.find(item => item.name === SLACK_BOT_WAKE_INDEX.name);
  assert.ok(spec);
  const check = async () => evaluatePostMigrationIndexes(await readObservedIndexes(async (text, values) => {
    const result = await client.query(text, values); return { rows: result.rows };
  }, [spec]), [spec])[0]?.state;
  assert.notEqual(await check(), "ok");
  await client.query(`CREATE INDEX "${SLACK_BOT_WAKE_INDEX.name}" ON external_inbound_events(status)`);
  assert.notEqual(await check(), "ok");
  await client.query(`DROP INDEX "${SLACK_BOT_WAKE_INDEX.name}"`);
  await client.query(SLACK_BOT_WAKE_INDEX.createSql);
  assert.equal(await check(), "ok");
}));

function sqlState(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    const row = current as { code?: string; cause?: unknown };
    if (row.code) return row.code;
    current = row.cause;
  }
}

async function usingDatabase(run: (input: { url: string; client: pg.Client }) => Promise<void>) {
  assert.ok(PG_URL, "SLACK_VERIFIED_INGRESS_REAL_PG_URL is required");
  const name = `slack_rollout_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  let client: pg.Client | undefined;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`);
    const target = new globalThis.URL(PG_URL); target.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: target.toString() });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS }); }
    finally { await pool.end(); }
    await initDatabase(target.toString());
    const seed = createSeed(getDb());
    const owner = await seed.human(); const server = await seed.server({ owner });
    await getDb().insert(schema.channels).values({ id: "00000000-0000-4000-8000-000000000023", serverId: server.id, name: "rollout-test" });
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    await run({ url: target.toString(), client });
  } finally {
    await client?.query("ROLLBACK").catch(() => {}); await client?.end().catch(() => {});
    await closeDatabase().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {}); await admin.end();
  }
}

async function activate(client: pg.Client) {
  await client.query(SLACK_INBOUND_HEAD_INDEX.createSql);
  const state = await readSlackIngressRollout(getDb());
  return setSlackIngressConsumption({ db: getDb(), enabled: true, expectedGeneration: state.generation,
    releaseRecord: RELEASE, now: NOW });
}

function normalized(id: string) {
  return { db: getDb(), authority: { provider: "slack", environment: "test" as const,
    appRegistrationId: "registration", installId: "install", workspaceId: "T1", providerAuthorityId: "T1",
    providerConversationId: "C1", bindingId: "binding", bindingEpoch: 1, connectionEpoch: 1,
    runtimeRevision: "fixture", raftChannelId: "00000000-0000-4000-8000-000000000023", privacyClass: "public" as const },
    providerEventId: id, normalizedPayloadDigest: "a".repeat(64), encryptedPayload: "normalized-ciphertext",
    envelopeKeyId: "fixture-key", receivedAt: NOW, payloadExpiresAt: new Date(NOW.getTime() + 60_000) };
}

async function raw(id: string) {
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: "33333333-3333-4333-8333-333333333333",
    environment: "test" as const, providerAppId: "A1", providerAuthorityId: "T1",
    providerEventId: id, providerConversationId: "C1" };
  const crypto = createSlackVerifiedIngressEnvCrypto({ key: Buffer.alloc(32, 4), keyId: "fixture-key",
    registrationId: aad.registrationId, environment: aad.environment, providerAppId: aad.providerAppId });
  const bytes = Buffer.from("synthetic receipt");
  const sealed = await crypto.seal({ bytes, aad }); bytes.fill(0);
  return enqueueSlackVerifiedIngress({ db: getDb(), aad, rawDigest: "b".repeat(64), ...sealed,
    now: NOW, validateEndpoint: async () => true });
}

test("durable activation requires the real index and rejects actual legacy writes and rollback (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  assert.deepEqual(await readSlackIngressRollout(getDb()), { mode: "legacy", generation: 1 });
  await assert.rejects(raw("before-enable"), error => error instanceof SlackIngressRolloutUnavailable && error.reason === "not_enabled");
  await assert.rejects(setSlackIngressConsumption({ db: getDb(), enabled: true, expectedGeneration: 1, now: NOW }), /Human verification/);
  const request = { db: getDb(), enabled: true, expectedGeneration: 1, releaseRecord: RELEASE, now: NOW };
  await assert.rejects(setSlackIngressConsumption(request), error => error instanceof SlackIngressRolloutUnavailable && error.reason === "index_not_ready");
  await client.query(`CREATE INDEX "${SLACK_INBOUND_HEAD_INDEX.name}" ON external_inbound_events(provider)`);
  await assert.rejects(setSlackIngressConsumption(request), error => error instanceof SlackIngressRolloutUnavailable && error.reason === "index_not_ready");
  await client.query(`DROP INDEX "${SLACK_INBOUND_HEAD_INDEX.name}"`);
  await activate(client);
  const seeded = await withSlackIngressProtocol({ db: getDb(), purpose: "receive", run: tx => enqueueExternalInboundEvent({ ...normalized("current"), db: tx }) });
  const receipt = await raw("current-raw");
  await assert.rejects(enqueueExternalInboundEvent(normalized("legacy-enqueue")), error => sqlState(error) === "55000");
  await assert.rejects(processExternalInboundEventOnce({ db: getDb(), leaseOwner: "old-worker", providerScope: "slack",
    dependencies: { now: () => NOW } as never }), error => sqlState(error) === "55000");
  const oldWrites = [
    ["UPDATE external_inbound_events SET encrypted_payload = NULL WHERE id = $1", seeded.event.id],
    ["DELETE FROM external_inbound_events WHERE id = $1", seeded.event.id],
    ["UPDATE slack_verified_ingress_events SET encrypted_payload = NULL WHERE id = $1", receipt.id],
    ["DELETE FROM slack_verified_ingress_events WHERE id = $1", receipt.id],
  ] as const;
  for (const [query, id] of oldWrites) await assert.rejects(client.query(query, [id]), error => sqlState(error) === "55000");
  await assert.rejects(client.query("INSERT INTO slack_verified_ingress_events SELECT * FROM slack_verified_ingress_events LIMIT 1"),
    error => sqlState(error) === "55000");
  // The referencing tables block a bare TRUNCATE. Including them must still
  // be rejected by the explicit writer fence.
  await assert.rejects(client.query("TRUNCATE slack_verified_ingress_events"), error => sqlState(error) === "0A000");
  await assert.rejects(client.query("TRUNCATE slack_verified_ingress_events, slack_verified_ingress_replay_audits, slack_verified_ingress_file_facts"),
    error => sqlState(error) === "55000");
  await assert.rejects(client.query("UPDATE slack_verified_ingress_rollout SET minimum_writer_protocol = 0, generation = generation + 1"), error => sqlState(error) === "55000");
  await assert.rejects(client.query("DELETE FROM slack_verified_ingress_rollout"), error => sqlState(error) === "55000");
  const [kept] = await getDb().select().from(schema.externalInboundEvents).where(eq(schema.externalInboundEvents.id, seeded.event.id));
  assert.equal(kept.status, "queued"); assert.equal(kept.encryptedPayload, "normalized-ciphertext");
  const other = normalized("other-provider");
  await enqueueExternalInboundEvent({ ...other, authority: { ...other.authority, provider: "other" } });
  await client.query("ALTER TABLE slack_verified_ingress_events DISABLE TRIGGER slack_ingress_raw_writer_fence");
  await assert.rejects(readSlackIngressRollout(getDb()), error => error instanceof SlackIngressRolloutUnavailable && error.reason === "fence_missing");
  await client.query("ALTER TABLE slack_verified_ingress_events ENABLE TRIGGER slack_ingress_raw_writer_fence");
  assert.equal((await readSlackIngressRollout(getDb())).mode, "verified_active");
}));

test("protocol 2 is an explicit irreversible floor and fences protocol 1 writers (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  await assert.rejects(applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 1, releaseRecord: RELEASE, minimumWriterProtocol: 2 } }),
  /requires active protocol-1 ingress/);
  assert.equal((await client.query("SELECT minimum_writer_protocol FROM slack_verified_ingress_rollout")).rows[0].minimum_writer_protocol, 0);
  await activate(client);
  const before = await raw("protocol-one");
  await client.query(SLACK_BOT_WAKE_INDEX.createSql);
  assert.equal((await client.query("SELECT minimum_writer_protocol FROM slack_verified_ingress_rollout")).rows[0].minimum_writer_protocol, 1);
  await assert.rejects(applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 1, releaseRecord: RELEASE, minimumWriterProtocol: 2 } }), /new verified release record/);
  const newRelease = parseSlackIngressReleaseRecord("00000000-0000-4000-8000-000000000024");
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 1, releaseRecord: newRelease, minimumWriterProtocol: 2 } }), "applied");
  await client.query("BEGIN");
  await client.query("SELECT set_config('raft.slack_ingress_protocol', '1', true)");
  await assert.rejects(client.query("UPDATE slack_verified_ingress_events SET state = state WHERE id = $1", [before.id]),
    error => sqlState(error) === "55000");
  await client.query("ROLLBACK");
  await assert.rejects(client.query("UPDATE slack_verified_ingress_rollout SET minimum_writer_protocol = 1, generation = generation + 1"),
    error => sqlState(error) === "55000");
  assert.equal((await raw("protocol-two")).kind, "receipt");
  await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW, config: { enabled: false, generation: 2 } });
  assert.equal((await client.query("SELECT minimum_writer_protocol FROM slack_verified_ingress_rollout")).rows[0].minimum_writer_protocol, 2);
}));

test("protocol 3 requires active protocol 2 and a distinct release, then fences protocol 2 (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const two = parseSlackIngressReleaseRecord("00000000-0000-4000-8000-000000000024");
  const three = parseSlackIngressReleaseRecord("00000000-0000-4000-8000-000000000025");
  const elevate = (generation: number, releaseRecord: typeof RELEASE) => applySlackVerifiedIngressDeployment({
    db: getDb(), now: NOW, config: { enabled: true, generation, releaseRecord, minimumWriterProtocol: 3 },
  });
  await assert.rejects(elevate(1, three), /requires active protocol-2 ingress/);
  await activate(client);
  await client.query(SLACK_BOT_WAKE_INDEX.createSql);
  await assert.rejects(elevate(1, three), /requires active protocol-2 ingress/);
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 1, releaseRecord: two, minimumWriterProtocol: 2 } }), "applied");
  const before = await raw("protocol-two-before-three");
  await assert.rejects(elevate(2, two), /new verified release record/);
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: false, generation: 2 } }), "applied");
  await assert.rejects(elevate(3, three), /requires active protocol-2 ingress/);
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 3, releaseRecord: two, minimumWriterProtocol: 2 } }), "applied");
  assert.equal(await elevate(4, three), "applied");
  assert.equal(await elevate(4, three), "unchanged");
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 4, releaseRecord: two, minimumWriterProtocol: 2 } }), "conflict");
  await client.query("BEGIN");
  await client.query("SELECT set_config('raft.slack_ingress_protocol', '2', true)");
  await assert.rejects(client.query("UPDATE slack_verified_ingress_events SET state = state WHERE id = $1", [before.id]),
    error => sqlState(error) === "55000");
  await client.query("ROLLBACK");
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), now: NOW,
    config: { enabled: true, generation: 5, releaseRecord: three } }), "applied");
  assert.equal((await client.query("SELECT minimum_writer_protocol FROM slack_verified_ingress_rollout")).rows[0].minimum_writer_protocol, 3);
}));

test("pause preserves receipt custody and transaction-local protocol never leaks (real PG)", OPTIONS, async () => usingDatabase(async ({ client, url }) => {
  await activate(client);
  const seeded = await withSlackIngressProtocol({ db: getDb(), purpose: "receive",
    run: tx => enqueueExternalInboundEvent({ ...normalized("before-pause"), db: tx }) });
  const paused = await setSlackIngressConsumption({ db: getDb(), enabled: false, expectedGeneration: 2, now: NOW });
  assert.deepEqual(paused, { mode: "verified_paused", generation: 3 });
  const received = await raw("while-paused"); assert.equal(received.kind, "receipt");
  await assert.rejects(withSlackIngressProtocol({ db: getDb(), purpose: "claim", run: async () => true }),
    error => error instanceof SlackIngressRolloutUnavailable && error.reason === "paused");
  await withSlackIngressProtocol({ db: getDb(), purpose: "settle", run: async () => true });
  const single = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(single, { schema });
    const inside = await withSlackIngressProtocol({ db, purpose: "settle",
      run: tx => tx.execute<{ protocol: string }>(sql`SELECT current_setting('raft.slack_ingress_protocol', true) AS protocol`) });
    assert.equal(inside.rows[0]?.protocol, "1");
    assert.notEqual((await single.query<{ protocol: string | null }>("SELECT current_setting('raft.slack_ingress_protocol', true) AS protocol")).rows[0]?.protocol, "1");
  } finally { await single.end(); }
  const readOnly = new pg.Pool({ connectionString: url, options: "-c default_transaction_read_only=on", max: 1 });
  try { assert.equal((await readSlackIngressRollout(drizzle(readOnly, { schema }))).mode, "verified_paused"); }
  finally { await readOnly.end(); }
  await assert.rejects(client.query("UPDATE external_inbound_events SET status = 'dead' WHERE id = $1", [seeded.event.id]),
    error => sqlState(error) === "55000");
}));

test("cutover rejects an in-flight legacy acknowledgement and stale snapshots cannot bypass the floor (real PG)", OPTIONS, async () => usingDatabase(async ({ client, url }) => {
  const seed = await enqueueExternalInboundEvent(normalized("before-cutover"));
  await client.query(SLACK_INBOUND_HEAD_INDEX.createSql);
  const stale = new pg.Client({ connectionString: url }); await stale.connect();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const request = withSlackIngressAdmissionFence({ fenceDb: getRootDb(), run: async mode => {
    assert.equal(mode, "legacy"); entered(); await waiting; return mode;
  } });
  const rejected = assert.rejects(request, error => error instanceof SlackIngressRolloutUnavailable && error.reason === "admission_changed");
  try {
    await started;
    await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await stale.query("SELECT minimum_writer_protocol FROM slack_verified_ingress_rollout");
    // Activation does not hold a second pool connection across the HTTP work.
    await activate(client); release(); await rejected;
    await assert.rejects(stale.query("UPDATE external_inbound_events SET encrypted_payload = NULL WHERE id = $1", [seed.event.id]),
      error => sqlState(error) === "40001");
    assert.equal((await readSlackIngressRollout(getDb())).mode, "verified_active");
  } finally {
    release(); await rejected;
    await stale.query("ROLLBACK").catch(() => {}); await stale.end();
  }
}));

test("admission uses a single-connection pool without pinning a second connection (real PG)", OPTIONS, async () => usingDatabase(async ({ client, url }) => {
  const single = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 500 });
  try {
    const db = drizzle(single, { schema });
    await withSlackIngressAdmissionFence({ fenceDb: db, run: async mode => {
      assert.equal(mode, "legacy"); await db.execute(sql`SELECT 1`);
    } });
    await activate(client);
    await withSlackIngressAdmissionFence({ fenceDb: db, run: async mode => {
      assert.equal(mode, "verified_active");
      // A receive transaction must not nest behind an admission-held shared lock.
      await withSlackIngressProtocol({ db, purpose: "receive", run: async tx => { await tx.execute(sql`SELECT 1`); } });
    } });
  } finally { await single.end(); }
}));

test("deployment config converges monotonically without undoing the custody floor (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { applySlackVerifiedIngressDeployment, parseSlackVerifiedIngressDeployment } = await import("./slackVerifiedIngressDeployment");
  await client.query(SLACK_INBOUND_HEAD_INDEX.createSql);
  const enabled = parseSlackVerifiedIngressDeployment({ SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true",
    SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "2", SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: RELEASE });
  assert.ok(enabled);
  const results = await Promise.all([applySlackVerifiedIngressDeployment({ db: getDb(), config: enabled, now: NOW }),
    applySlackVerifiedIngressDeployment({ db: getDb(), config: enabled, now: NOW })]);
  assert.deepEqual(results.sort(), ["applied", "unchanged"]);
  assert.equal((await readSlackIngressRollout(getDb())).mode, "verified_active");
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), config: { enabled: false, generation: 1 }, now: NOW }), "older_config");
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), config: { enabled: false, generation: 2 }, now: NOW }), "conflict");
  assert.equal(await applySlackVerifiedIngressDeployment({ db: getDb(), config: { enabled: false, generation: 3 }, now: NOW }), "applied");
  const paused = await readSlackIngressRollout(getDb()); assert.equal(paused.mode, "verified_paused");
  await assert.rejects(setSlackIngressConsumption({ db: getDb(), enabled: true, expectedGeneration: paused.generation,
    releaseRecord: RELEASE, now: NOW }), error => sqlState(error) === "55000");
  await assert.rejects(client.query("UPDATE slack_verified_ingress_rollout SET config_generation = 2, generation = generation + 1 WHERE id = 1"),
    error => sqlState(error) === "55000");
  assert.equal((await readSlackIngressRollout(getDb())).mode, "verified_paused");
}));

test("materialized heads back off across concurrent workers and preserve followers (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { claimSlackVerifiedIngressHead, materializeSlackVerifiedIngressClaim } = await import("./slackVerifiedIngressWorker");
  await activate(client);
  const first = await raw("Ev_BACKOFF");
  await raw("Ev_FOLLOWER");
  const db = getDb();
  const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "initial", leaseMs: 5_000, now: () => NOW });
  assert.equal(claim?.event.id, first.id);
  const authority = { ...normalized("unused").authority, appRegistrationId: claim!.partition.appRegistrationId };
  assert.equal(await materializeSlackVerifiedIngressClaim({ db, partitionId: claim!.partition.id, eventId: claim!.event.id,
    leaseOwner: "initial", leaseGeneration: claim!.event.leaseGeneration, now: () => NOW, authority,
    normalizedPayloadDigest: "a".repeat(64), encryptedPayload: "sealed-normalized", envelopeKeyId: "fixture-key",
    payloadSchemaVersion: 1, payloadExpiresAt: new Date(NOW.getTime() + 600_000), validateCurrentAuthority: async () => true }), true);
  let clock = NOW;
  for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const outcomes = await Promise.all(["worker-a", "worker-b"].map(leaseOwner =>
      claimSlackVerifiedIngressHead({ db, leaseOwner, leaseMs: 5_000, now: () => clock })));
    assert.deepEqual(outcomes, [null, null]);
    const [row] = await db.select().from(schema.slackVerifiedIngressEvents).where(eq(schema.slackVerifiedIngressEvents.id, first.id));
    assert.equal(row.nextAttemptAt.getTime() - row.updatedAt.getTime(), delay);
    assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "early", leaseMs: 5_000,
      now: () => new Date(row.nextAttemptAt.getTime() - 1) }), null);
    clock = row.nextAttemptAt;
  }
}));


test("retention indexes cannot start while verified ingress is enabled (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  await activate(client);
  const migration = readFileSync(`${MIGRATIONS}/0507_slack_ingress_retention_indexes.sql`, "utf8");
  const guard = migration.split("--> statement-breakpoint")[0]!;
  await assert.rejects(client.query(guard), /disable Slack verified ingress/);
}));

test("author wake migration refuses enabled ingress and undrained legacy author holds (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { claimSlackVerifiedIngressHead, deferUnrecognizedSlackIngressClaim } = await import("./slackVerifiedIngressWorker");
  const guard = readFileSync(`${MIGRATIONS}/0512_slack_fallback_author_wake.sql`, "utf8").split("--> statement-breakpoint")[0]!;
  await activate(client);
  await assert.rejects(client.query(guard), /disable Slack verified ingress/);
  const event = await raw("Ev_LEGACY_AUTHOR");
  const db = getDb();
  let clock = new Date(NOW);
  for (let n = 0; n < 3; n++) {
    const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "author", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, event.id);
    await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: event.id,
      leaseOwner: "author", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
      retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending",
      pendingAuthor: { installId: "I1", workspaceId: "T1", bindingId: "B1", actorId: "U1" },
      validatePendingAuthor: async () => true });
    clock = new Date(clock.getTime() + 1_001);
  }
  await setSlackIngressConsumption({ db, enabled: false, expectedGeneration: 2, now: clock });
  await assert.rejects(client.query(guard), /drain legacy unresolved Slack authors/);
}));

test("author wake guard does not deadlock an older author writer (real PG)", OPTIONS, async () => usingDatabase(async ({ client, url }) => {
  const oldWriter = new pg.Client({ connectionString: url });
  await oldWriter.connect();
  try {
    await oldWriter.query("BEGIN");
    await oldWriter.query("LOCK TABLE external_message_author_facts IN ROW EXCLUSIVE MODE");
    await client.query("BEGIN");
    const guard = readFileSync(`${MIGRATIONS}/0512_slack_fallback_author_wake.sql`, "utf8").split("--> statement-breakpoint")[0]!;
    await client.query(guard);
    const migrationTableLock = client.query("LOCK TABLE external_message_author_facts IN ACCESS EXCLUSIVE MODE");
    await oldWriter.query("SET LOCAL statement_timeout = '3s'");
    await oldWriter.query("SELECT consumers_enabled FROM slack_verified_ingress_rollout WHERE id = 1 FOR SHARE");
    await oldWriter.query("COMMIT");
    await migrationTableLock;
    await client.query("ROLLBACK");
  } finally { await oldWriter.query("ROLLBACK").catch(() => {}); await oldWriter.end(); }
}));

test("a killed wake worker rolls back and the next worker restores the original head (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { claimSlackVerifiedIngressHead, deferSlackVerifiedIngressClaim, deferUnrecognizedSlackIngressClaim, requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
  await activate(client);
  const first = await raw("Ev_WAKE_CRASH");
  await raw("Ev_WAKE_AFTER");
  const db = getDb();
  let clock = new Date(NOW);
  const author = { installId: "I1", workspaceId: "T1", bindingId: "B1", actorId: "U1" };
  for (let n = 0; n < 3; n++) {
    const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "first", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, first.id);
    assert.equal(await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: first.id,
      leaseOwner: "first", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
      retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending", pendingAuthor: author,
      validatePendingAuthor: async () => true }), n === 2 ? "held" : "retry");
    clock = new Date(clock.getTime() + 1_001);
  }
  const registrationId = "33333333-3333-4333-8333-333333333333";
  await db.insert(schema.slackIngressAuthorWakeSignals).values({ registrationId, ...author,
    signaledAt: clock, expiresAt: new Date(clock.getTime() + 24 * 60 * 60_000) });
  const pendingNewer = await claimSlackVerifiedIngressHead({ db, leaseOwner: "newer", leaseMs: 30_000, now: () => clock });
  assert.ok(pendingNewer);
  assert.equal(await deferSlackVerifiedIngressClaim({ db, partitionId: pendingNewer.partition.id, eventId: pendingNewer.event.id,
    leaseOwner: "newer", leaseGeneration: pendingNewer.event.leaseGeneration, now: () => clock,
    retryAt: new Date(clock.getTime() + 60_000), reason: "binding_temporarily_unavailable" }), true);
  await client.query(`CREATE FUNCTION test_w4_pause_wake() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.state = 'held' AND NEW.state = 'queued' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`);
  await client.query(`CREATE TRIGGER test_w4_pause_wake BEFORE UPDATE ON slack_verified_ingress_events
    FOR EACH ROW EXECUTE FUNCTION test_w4_pause_wake()`);
  const scope = { db, registrationId, environment: "test" as const, now: clock };
  const pending = requeueDueSlackActor(scope).then(() => false, () => true);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await client.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event = 'PgSleep' AND pid <> pg_backend_pid()`);
    if (rows.rows.length) { pid = Number(rows.rows[0].pid); break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(pid, "wake worker must reach its update before it is killed");
  await client.query("SELECT pg_terminate_backend($1)", [pid]);
  assert.equal(await pending, true, "killed worker must not report a committed wake");
  await client.query("DROP TRIGGER test_w4_pause_wake ON slack_verified_ingress_events");
  await client.query("DROP FUNCTION test_w4_pause_wake()");
  const [held] = await db.select().from(schema.slackVerifiedIngressEvents).where(eq(schema.slackVerifiedIngressEvents.id, first.id));
  assert.equal(held.state, "held"); assert.equal(held.position, 1);
  assert.equal((await db.select().from(schema.slackIngressAuthorWakeSignals)).length, 1);
  assert.equal(await claimSlackVerifiedIngressHead({ db, leaseOwner: "newer", leaseMs: 30_000, now: () => clock }), null);
  assert.equal(await requeueDueSlackActor(scope), true);
  assert.equal(await requeueDueSlackActor(scope), false, "replay is idempotent");
  const recovered = await claimSlackVerifiedIngressHead({ db, leaseOwner: "restarted", leaseMs: 30_000, now: () => clock });
  assert.equal(recovered?.event.id, first.id); assert.equal(recovered?.event.position, 1);
}));

test("before a wake signal the older matching author still fences a later message (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { claimSlackVerifiedIngressHead, deferUnrecognizedSlackIngressClaim, materializeSlackVerifiedIngressClaim } = await import("./slackVerifiedIngressWorker");
  await activate(client);
  const first = await raw("Ev_ORDER_OLD");
  await raw("Ev_ORDER_NEW");
  const other = await raw("Ev_ORDER_OTHER");
  const db = getDb(); let clock = new Date(NOW);
  for (let n = 0; n < 3; n++) {
    const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "old", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, first.id);
    await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: first.id,
      leaseOwner: "old", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
      retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending",
      pendingAuthor: { installId: "install", workspaceId: "T1", bindingId: "binding", actorId: "U1" },
      validatePendingAuthor: async () => true });
    clock = new Date(clock.getTime() + 1_001);
  }
  const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "new", leaseMs: 30_000, now: () => clock });
  assert.ok(claim);
  const source = normalized("Ev_ORDER_NEW");
  const request = { db, partitionId: claim.partition.id, eventId: claim.event.id, leaseOwner: "new",
    leaseGeneration: claim.event.leaseGeneration, now: () => clock, authority: { ...source.authority, provider: "slack" as const,
      appRegistrationId: "33333333-3333-4333-8333-333333333333" }, normalizedPayloadDigest: source.normalizedPayloadDigest,
    encryptedPayload: source.encryptedPayload, envelopeKeyId: source.envelopeKeyId,
    payloadSchemaVersion: 1 as const, payloadExpiresAt: new Date(clock.getTime() + 60_000),
    validateCurrentAuthority: async () => true };
  assert.equal(await materializeSlackVerifiedIngressClaim({ ...request, orderedActorId: "U1" }), "author_wait");
  assert.equal((await db.select().from(schema.externalInboundEvents)).length, 0);
  const next = await claimSlackVerifiedIngressHead({ db, leaseOwner: "other", leaseMs: 30_000, now: () => clock });
  assert.equal(next?.event.id, other.id);
  assert.equal(await materializeSlackVerifiedIngressClaim({ ...request, eventId: next!.event.id, leaseOwner: "other",
    leaseGeneration: next!.event.leaseGeneration, orderedActorId: "U2" }), true);
}));

test("an old wake signal does not spin a still-unresolved author (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { claimSlackVerifiedIngressHead, deferUnrecognizedSlackIngressClaim, requeueDueSlackActor } = await import("./slackVerifiedIngressWorker");
  await activate(client);
  const event = await raw("Ev_WAKE_ONCE"); const db = getDb(); let clock = new Date(NOW);
  const pendingAuthor = { installId: "I1", workspaceId: "T1", bindingId: "B1", actorId: "U1" };
  async function hold() {
    for (let n = 0; n < 3; n++) {
      const claim = await claimSlackVerifiedIngressHead({ db, leaseOwner: "worker", leaseMs: 30_000, now: () => clock });
      assert.equal(claim?.event.id, event.id);
      await deferUnrecognizedSlackIngressClaim({ db, partitionId: claim!.partition.id, eventId: event.id,
        leaseOwner: "worker", leaseGeneration: claim!.event.leaseGeneration, now: () => clock,
        retryAt: new Date(clock.getTime() + 1_000), reason: "actor_identity_pending", pendingAuthor,
        validatePendingAuthor: async () => true });
      clock = new Date(clock.getTime() + 1_001);
    }
  }
  await hold();
  const registrationId = "33333333-3333-4333-8333-333333333333";
  await db.insert(schema.slackIngressAuthorWakeSignals).values({ registrationId, ...pendingAuthor,
    signaledAt: clock, expiresAt: new Date(clock.getTime() + 86_400_000) });
  const scope = { db, registrationId, environment: "test" as const, now: clock };
  assert.equal(await requeueDueSlackActor(scope), true);
  await hold();
  assert.equal(await requeueDueSlackActor({ ...scope, now: clock }), false);
}));

test("legacy commit crossing activation is reused on verified retry (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const registrationId = "33333333-3333-4333-8333-333333333333";
  const channelId = "00000000-0000-4000-8000-000000000023";
  const [owner] = await getDb().select({ id: schema.users.id }).from(schema.users).limit(1);
  assert.ok(owner);
  const [message] = await getDb().insert(schema.messages).values({ channelId, senderType: "user",
    senderId: owner.id, content: "synthetic already delivered" }).returning();
  assert.ok(message);
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let queuedId = ""; let committedId = "";
  const request = withSlackIngressAdmissionFence({ fenceDb: getRootDb(), run: async mode => {
    assert.equal(mode, "legacy");
    const add = async (id: string) => {
      const input = normalized(id);
      return enqueueExternalInboundEvent({ ...input, authority: { ...input.authority, appRegistrationId: registrationId } });
    };
    const queued = await add("Ev_CUTOVER_QUEUED"); queuedId = queued.event.id;
    const committed = await add("Ev_CUTOVER_COMMITTED"); committedId = committed.event.id;
    await getDb().update(schema.externalInboundEvents).set({ status: "committed", committedMessageId: message.id,
      encryptedPayload: null, envelopeKeyId: null, payloadExpiresAt: null, payloadErasedAt: NOW,
      payloadTombstoneDigest: "c".repeat(64) }).where(eq(schema.externalInboundEvents.id, committedId));
    entered(); await waiting; return "legacy result";
  } });
  const rejected = assert.rejects(request, error => error instanceof SlackIngressRolloutUnavailable && error.reason === "admission_changed");
  try {
    await Promise.race([started, rejected.then(() => { throw new Error("legacy admission ended before the barrier"); })]);
    await activate(client);
    release(); await rejected;
    const queuedRetry = await raw("Ev_CUTOVER_QUEUED");
    const committedRetry = await raw("Ev_CUTOVER_COMMITTED");
    assert.equal(queuedRetry.kind, "legacy"); assert.equal(queuedRetry.id, queuedId);
    assert.equal(committedRetry.kind, "legacy"); assert.equal(committedRetry.id, committedId);
    if (committedRetry.kind !== "legacy") throw new Error("expected legacy response");
    assert.equal(committedRetry.state, "committed"); assert.equal(committedRetry.committedMessageId, message.id);
    assert.equal((await getDb().select().from(schema.externalInboundEvents)).length, 2);
    assert.equal((await getDb().select().from(schema.slackVerifiedIngressEvents)).length, 0);
    assert.equal((await getDb().select().from(schema.messages).where(eq(schema.messages.channelId, channelId))).length, 1);
  } finally { release(); await rejected.catch(() => {}); }
}));

test("already-running admission selects durable mode after another replica enables it (real PG)", OPTIONS, async () => usingDatabase(async ({ client }) => {
  const { createSlackVerifiedIngressAdmission } = await import("./slackVerifiedIngressAdmission");
  const crypto = createSlackVerifiedIngressEnvCrypto({ key: Buffer.alloc(32, 4), keyId: "fixture-key",
    registrationId: "33333333-3333-4333-8333-333333333333", environment: "test", providerAppId: "A1" });
  const observed: boolean[] = [];
  const existingReplica = createSlackVerifiedIngressAdmission({ getFenceDb: getRootDb, crypto, admit: async request => {
    observed.push(Boolean(request.verifiedIngressCrypto)); return {} as never;
  } });
  await existingReplica({} as never);
  await activate(client);
  await existingReplica({} as never);
  assert.deepEqual(observed, [false, true]);
}));
