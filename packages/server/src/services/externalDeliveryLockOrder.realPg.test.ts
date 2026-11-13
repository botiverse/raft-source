import { applySlackAttachmentFallbackDeployment, parseSlackAttachmentFallbackDeployment } from "./slackAttachmentFallbackDeployment";
// Real-PostgreSQL teeth for the Slack Bridge outbound lock order
// (externalDeliveryWorkerService.ts: partition before delivery). PGlite runs
// every transaction on one connection, so a lock-order deadlock only shows on a
// real multi-connection Postgres. CI: `probe-concurrency-real-pg`, with
// CHANNEL_CONVERSION_REAL_PG_URL; locally: an empty PostgreSQL 17 database.
//
// Prod 2026-10-21 (15:39-17:07Z, four 40P01, each between two replicas'
// slack_bridge.outbound.tick): one tick recorded a provider outcome, locking the
// delivery and then the partition to advance the cursor; the other claimed the
// head through lockPartitionAndHead, partition then delivery.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import {
  channels,
  attachmentObjects, attachments, externalAttachmentTransferJobs, slackAttachmentPlanRollout,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  messages,
  servers,
  users,
} from "../db/schema";
import { lockOutcomePartitionAndDelivery, processExternalDeliveryPartitionHead } from "./externalDeliveryWorkerService";

const REAL_PG_URL = process.env.CHANNEL_CONVERSION_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 30_000;
const LEASE_OWNER = "tick-replica-a";
const LEASE_GENERATION = 1;

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

/** One partition whose head delivery is leased to the outcome-recording tick. */
async function seedLeasedHead() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `lock-order-${suffix}@raft.test`,
    name: `lock-order-${suffix}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: `lock-order-${suffix}`, slug: `lock-order-${suffix}`, ownerId: owner.id }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `lock-order-${suffix}`, type: "channel" }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "lock order",
    messageType: "chat",
  }).returning();
  const bindingId = `binding-${suffix}`;
  const bindingEpoch = 1;
  const [partition] = await db.insert(externalDeliveryPartitions).values({ bindingId, bindingEpoch }).returning();
  // The partition tail and its deliveries must change in one transaction: the
  // deferred assert_external_delivery_partition_tail_consistent trigger checks
  // last_enqueued_position against the delivery rows at commit (as the outbox
  // enqueue and the worker test fixture do).
  const [delivery] = await db.transaction(async (tx) => {
    await tx.update(externalDeliveryPartitions).set({ lastEnqueuedPosition: 1 })
      .where(eq(externalDeliveryPartitions.id, partition.id));
    return tx.insert(externalOutboundDeliveries).values({
      sourceMessageId: message.id,
      bindingId,
      bindingEpoch,
      partitionPosition: 1,
      enqueueRuntimeRevision: "runtime-r1",
      renderSnapshotSchema: "slack-bridge-render-snapshot.v4",
      renderSnapshot: {},
      renderSnapshotDigest: "1".repeat(64),
      // Unique across the table (idx_external_outbound_delivery_reconciliation_marker):
      // each test seeds its own head.
      reconciliationMarker: randomBytes(32).toString("base64url"),
    }).returning();
  });
  await db.update(externalOutboundDeliveries).set({
    state: "dispatching",
    leaseOwner: LEASE_OWNER,
    leaseGeneration: LEASE_GENERATION,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseOriginState: "queued",
  }).where(eq(externalOutboundDeliveries.id, delivery.id));
  return { partition, delivery: { ...delivery, bindingId, bindingEpoch }, owner, server, channel, message };
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
  throw new Error("the outcome transaction never queued behind the claiming tick's partition lock");
}

test("attachment plan fence rejects an old writer that was waiting on the plan transaction", async () => {
  await withRealPg(async () => {
    const seeded = await seedLeasedHead();
    const plan = new pg.Client({ connectionString: REAL_PG_URL });
    const old = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await Promise.all([plan.connect(), old.connect(), probe.connect()]);
    try {
      await plan.query("BEGIN");
      await plan.query("SELECT set_config('slock.attachment_plan', '1', true)");
      await plan.query("UPDATE external_outbound_deliveries SET attachment_fallback_plan_revision = 1 WHERE id = $1", [seeded.delivery.id]);
      const { rows } = await plan.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const oldResult = old.query("UPDATE external_outbound_deliveries SET state_reason = 'old-writer' WHERE id = $1", [seeded.delivery.id])
        .then(() => null, sqlState);
      await waitUntilBlockedBy(probe, rows[0]!.pid);
      await plan.query("COMMIT");
      assert.equal(await oldResult, "55000", "the queued update must re-evaluate the committed plan fence");
      await assert.rejects(plan.query("UPDATE external_outbound_deliveries SET state_reason = 'pooled-old' WHERE id = $1", [seeded.delivery.id]),
        (error: unknown) => sqlState(error) === "55000", "the transaction marker must not survive commit on a reused connection");
      await plan.query("BEGIN");
      await plan.query("SELECT set_config('slock.attachment_plan', '1', true)");
      await plan.query("UPDATE external_outbound_deliveries SET state_reason = 'rolled-back' WHERE id = $1", [seeded.delivery.id]);
      await plan.query("ROLLBACK");
      await assert.rejects(plan.query("UPDATE external_outbound_deliveries SET state_reason = 'after-rollback' WHERE id = $1", [seeded.delivery.id]),
        (error: unknown) => sqlState(error) === "55000");
      const current = await probe.query<{ state_reason: string | null }>("SELECT state_reason FROM external_outbound_deliveries WHERE id = $1", [seeded.delivery.id]);
      assert.equal(current.rows[0]?.state_reason, null);
    } finally {
      await Promise.all([plan.end(), old.end(), probe.end()]);
    }
  });
}, TEST_TIMEOUT_MS);

test("a waiting old file job cannot complete after a fallback plan commits", async () => {
  await withRealPg(async () => {
    const seeded = await seedLeasedHead();
    const db = getDb();
    const [object] = await db.insert(attachmentObjects).values({ originServerId: seeded.server.id,
      uploaderId: seeded.owner.id, uploaderType: "user", storageKey: `${seeded.server.id}/job-fence`,
      contentHash: "a".repeat(64), sizeBytes: 4, mimeType: "text/plain" }).returning();
    const [attachment] = await db.insert(attachments).values({ objectId: object.id, messageId: seeded.message.id,
      channelId: seeded.channel.id, uploaderId: seeded.owner.id, uploaderType: "user", filename: "job-fence.txt" }).returning();
    const [job] = await db.insert(externalAttachmentTransferJobs).values({ direction: "raft_outbound",
      outboundDeliveryId: seeded.delivery.id, sourceAttachmentId: attachment.id, frozenObjectId: object.id,
      frozenOriginServerId: seeded.server.id, frozenStorageKey: object.storageKey, frozenFilename: attachment.filename,
      frozenMimeType: object.mimeType, frozenSizeBytes: object.sizeBytes, frozenContentDigest: object.contentHash,
      phase: "complete" }).returning();
    const plan = new pg.Client({ connectionString: REAL_PG_URL });
    const old = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await Promise.all([plan.connect(), old.connect(), probe.connect()]);
    try {
      await plan.query("BEGIN");
      await plan.query("SELECT set_config('slock.attachment_plan', '1', true)");
      await plan.query("UPDATE external_outbound_deliveries SET attachment_fallback_plan_revision = 1 WHERE id = $1", [seeded.delivery.id]);
      await plan.query("SELECT id FROM external_attachment_transfer_jobs WHERE id = $1 FOR UPDATE", [job.id]);
      const { rows } = await plan.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const oldResult = old.query("UPDATE external_attachment_transfer_jobs SET phase = 'correlate', state = 'outcome_unknown', last_error_class = 'attachment_completion_started' WHERE id = $1", [job.id])
        .then(() => null, sqlState);
      await Promise.race([waitUntilBlockedBy(probe, rows[0]!.pid), oldResult.then(code => { throw new Error(`old job finished before the barrier: ${code}`); })]);
      await plan.query("COMMIT");
      assert.equal(await oldResult, "55000", "job trigger must observe the newly committed parent plan after waiting");
      const after = await probe.query<{ phase: string }>("SELECT phase FROM external_attachment_transfer_jobs WHERE id = $1", [job.id]);
      assert.equal(after.rows[0]?.phase, "complete", "old binary never reaches its completion provider call");
      await assert.rejects(old.query("DELETE FROM external_attachment_transfer_jobs WHERE id = $1", [job.id]),
        error => sqlState(error) === "55000");
    } finally { await Promise.all([plan.end(), old.end(), probe.end()]); }
  });
}, TEST_TIMEOUT_MS);

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
 * The claiming tick's side (lockPartitionAndHead's order): lock the partition,
 * let `outcome` start and queue behind it, then lock the head delivery.
 * Returns the SQLSTATE each side failed with, if any.
 */
async function raceClaimAgainst(
  seeded: Awaited<ReturnType<typeof seedLeasedHead>>,
  outcome: () => Promise<unknown>,
): Promise<{ claim: string | null; outcome: string | null }> {
  const claim = new pg.Client({ connectionString: REAL_PG_URL });
  const probe = new pg.Client({ connectionString: REAL_PG_URL });
  await claim.connect();
  await probe.connect();
  try {
    const { rows } = await claim.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await claim.query("BEGIN");
    await claim.query("SELECT id FROM external_delivery_partitions WHERE id = $1 FOR UPDATE", [seeded.partition.id]);
    const recorded = outcome().then(() => null, sqlState);
    await waitUntilBlockedBy(probe, rows[0]!.pid);
    let claimError: string | null = null;
    try {
      await claim.query("SELECT id FROM external_outbound_deliveries WHERE id = $1 FOR UPDATE", [seeded.delivery.id]);
      await claim.query("COMMIT");
    } catch (error) {
      claimError = sqlState(error);
      await claim.query("ROLLBACK");
    }
    return { claim: claimError, outcome: await recorded };
  } finally {
    await claim.end();
    await probe.end();
  }
}

test("recording an outcome queues behind a claiming tick instead of deadlocking", async () => {
  await withRealPg(async () => {
    const seeded = await seedLeasedHead();
    let locked: Awaited<ReturnType<typeof lockOutcomePartitionAndDelivery>> = null;
    const result = await raceClaimAgainst(seeded, () => getDb().transaction(async (tx) => {
      locked = await lockOutcomePartitionAndDelivery(tx, {
        deliveryId: seeded.delivery.id,
        bindingId: seeded.delivery.bindingId,
        bindingEpoch: seeded.delivery.bindingEpoch,
        leaseOwner: LEASE_OWNER,
        leaseGeneration: LEASE_GENERATION,
      });
    }));
    assert.deepEqual(result, { claim: null, outcome: null });
    assert.equal(locked!.id, seeded.delivery.id);
  });
}, TEST_TIMEOUT_MS);

test("the old delivery-then-partition outcome order deadlocks with the same claim", async () => {
  await withRealPg(async () => {
    const seeded = await seedLeasedHead();
    // The pre-fix outcome transaction: the delivery under its lease first, the
    // partition only when the provider accepted and the cursor advanced.
    const result = await raceClaimAgainst(seeded, () => getDb().transaction(async (tx) => {
      await tx.select({ id: externalOutboundDeliveries.id }).from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.id, seeded.delivery.id)).for("update");
      await tx.select({ id: externalDeliveryPartitions.id }).from(externalDeliveryPartitions)
        .where(eq(externalDeliveryPartitions.id, seeded.partition.id)).for("update");
    }));
    assert.ok(
      result.claim === "40P01" || result.outcome === "40P01",
      `expected one side to lose a deadlock, got ${JSON.stringify(result)}`,
    );
  });
}, TEST_TIMEOUT_MS);

for (const phase of ["authority_release", "attempt_start", "attempt_timeout"] as const) {
test(`an owned Slack claim handles pair queue contention without a false lease loss (${phase})`, async () => {
  await withRealPg(async () => {
    const seeded = await seedLeasedHead();
    const clock = new Date();
    const snapshot = { schema: "slack-bridge-render-snapshot.v4", sourceMessageId: seeded.message.id,
      sourceMessageSeq: seeded.message.seq, canonicalConversationId: seeded.channel.id, level: "top_level",
      canonicalRootMessageId: null, sourcePermalink: `https://app.slock.ai/s/${seeded.server.slug}/channel/${seeded.channel.id}?msg=${seeded.message.id}`,
      senderType: "user", senderId: seeded.owner.id, authorName: "Frozen author",
      authorPresentation: { displayName: "Frozen author", fallbackKind: "human", avatar: null },
      sanitizedText: "authority wait", externalMentions: [], attachments: [], enqueueRuntimeRevision: "runtime-r1",
      bindingAuthority: { provider: "slack", environment: "test", appRegistrationId: randomUUID(), installId: "install-test",
        workspaceId: "workspace-test", connectionEpoch: 1, bindingId: seeded.delivery.bindingId, bindingEpoch: 1,
        memberRevision: 1, contextRevision: 1, privacyClass: "public", raftChannelId: seeded.channel.id,
        providerAuthorityId: "workspace-test", providerConversationId: "conversation-test" } } as const;
    await getDb().update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null, leaseExpiresAt: null,
      leaseOriginState: null, leaseGeneration: 0, renderSnapshot: snapshot,
    }).where(eq(externalOutboundDeliveries.id, seeded.delivery.id));
    let entered!: () => void; let resume!: () => void;
    const enteredRuntime = new Promise<void>((resolve) => { entered = resolve; });
    const resumeRuntime = new Promise<void>((resolve) => { resume = resolve; });
    const runtime = { runtimeRevision: "runtime-r1", bindingAuthority: snapshot.bindingAuthority };
    let providerCalls = 0;
    const input = { db: getDb(), bindingId: seeded.delivery.bindingId, bindingEpoch: 1, leaseOwner: "authority-worker",
      dependencies: { now: () => clock,
        resolveCurrentRuntime: async () => {
          if (phase === "authority_release") { entered(); await resumeRuntime; return null; }
          return runtime;
        },
        leaseCredential: async () => {
          entered(); await resumeRuntime;
          return { handle: {}, credentialRevision: 1, ...runtime, ...snapshot.bindingAuthority };
        },
        dispatchProvider: async () => { providerCalls += 1; return { kind: "accepted" as const, providerMessageId: seeded.delivery.id }; },
      } };
    const worker = processExternalDeliveryPartitionHead(input);
    await enteredRuntime;
    const competitor = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await competitor.connect(); await probe.connect();
    try {
      await competitor.query("BEGIN");
      const { rows } = await competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await competitor.query("SELECT id FROM external_delivery_partitions WHERE id=$1 FOR UPDATE", [seeded.partition.id]);
      resume();
      await waitUntilBlockedBy(probe, rows[0]!.pid);
      if (phase === "attempt_timeout") {
        const result = await worker;
        assert.equal(result.kind === "blocked" ? result.reason : null, "pair_queue_lock_busy");
        const [delivery] = await getDb().select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, seeded.delivery.id));
        const [partition] = await getDb().select().from(externalDeliveryPartitions).where(eq(externalDeliveryPartitions.id, seeded.partition.id));
        assert.equal(delivery.state, "queued", "a lock timeout must not park work in dispatching for 60 seconds");
        assert.equal(delivery.leaseOwner, null);
        assert.equal(delivery.providerAttempts, 0);
        assert.equal(partition.authorityBlockedAt, null, "contention is not a permission or connection failure");
        assert.equal(providerCalls, 0);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await competitor.query("SELECT id FROM external_outbound_deliveries WHERE id=$1 FOR UPDATE NOWAIT", [seeded.delivery.id]);
      }
      await competitor.query("COMMIT");
      const result = phase === "attempt_timeout" ? await processExternalDeliveryPartitionHead(input) : await worker;
      assert.equal(result.kind, phase === "authority_release" ? "authority_blocked" : "attempted");
      const [delivery] = await getDb().select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, seeded.delivery.id));
      assert.equal(delivery.state, phase === "authority_release" ? "queued" : "accepted");
      assert.equal(providerCalls, phase === "authority_release" ? 0 : 1);
      assert.equal(delivery.providerAttempts, providerCalls);
    } finally {
      resume(); await competitor.query("ROLLBACK"); await competitor.end(); await probe.end(); await worker;
    }
  });
}, TEST_TIMEOUT_MS);
}

for (const reclaimAfterMs of [61_000, 90_000]) {
  test(`a crashed first send is confirmed once using immutable I/O time after ${reclaimAfterMs}ms`, async () => {
    await withRealPg(async () => {
      const seeded = await seedLeasedHead();
      const { reconcileSlackOutboundDelivery, SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA } = await import("./slackProviderAdapter");
      const { loadSlackReconciliationEvidence, saveSlackReconciliationScan } = await import("./slackReconciliationStore");
      const { reconciledProviderReceipt } = await import("./externalProviderPreparation");
      const { externalDeliveryAttempts } = await import("../db/schema");
      const startedAt = new Date();
      let clock = startedAt;
      const snapshot = { schema: "slack-bridge-render-snapshot.v4", sourceMessageId: seeded.message.id,
        sourceMessageSeq: seeded.message.seq, canonicalConversationId: seeded.channel.id, level: "top_level",
        canonicalRootMessageId: null, sourcePermalink: `https://app.slock.ai/s/${seeded.server.slug}/channel/${seeded.channel.id}?msg=${seeded.message.id}`,
        senderType: "user", senderId: seeded.owner.id, authorName: "Frozen author",
        authorPresentation: { displayName: "Frozen author", fallbackKind: "human", avatar: null },
        sanitizedText: "preserve the first send", externalMentions: [], attachments: [], enqueueRuntimeRevision: "runtime-r1",
        bindingAuthority: { provider: "slack", environment: "test", appRegistrationId: randomUUID(), installId: "install-test",
          workspaceId: "workspace-test", connectionEpoch: 1, bindingId: seeded.delivery.bindingId, bindingEpoch: 1,
          memberRevision: 1, contextRevision: 1, privacyClass: "public", raftChannelId: seeded.channel.id,
          providerAuthorityId: "workspace-test", providerConversationId: "conversation-test" } } as const;
      await getDb().update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null, leaseExpiresAt: null,
        leaseOriginState: null, leaseGeneration: 0, renderSnapshot: snapshot,
      }).where(eq(externalOutboundDeliveries.id, seeded.delivery.id));
      const runtime = { runtimeRevision: "runtime-r1", bindingAuthority: snapshot.bindingAuthority };
      const authority = { installId: "install-test", providerAppId: "A_TEST", providerAuthorityId: "workspace-test",
        providerConversationId: "conversation-test", connectionEpoch: 1, credentialRevision: 1,
        bindingId: seeded.delivery.bindingId, bindingEpoch: 1 };
      const acceptedTs = (startedAt.getTime() / 1000).toFixed(6);
      let sends = 0;
      let sent!: () => void;
      const sentOnce = new Promise<void>((resolve) => { sent = resolve; });
      let finish!: (value: { kind: "accepted"; providerMessageId: string }) => void;
      const providerReply = new Promise<{ kind: "accepted"; providerMessageId: string }>((resolve) => { finish = resolve; });
      const dependencies: import("./externalDeliveryWorkerService").ExternalDeliveryWorkerDependencies = {
        now: () => clock,
        resolveCurrentRuntime: async () => runtime,
        leaseCredential: async () => ({ handle: {}, credentialRevision: 1, ...runtime, ...snapshot.bindingAuthority }),
        async prepareProvider(request) {
          if (!request.reconcileUnknownOutcome) return { ready: true, async dispatch() { sends += 1; sent(); return providerReply; } };
          const claim = { deliveryId: request.deliveryId, leaseOwner: request.leaseOwner, leaseGeneration: request.leaseGeneration };
          const evidence = await loadSlackReconciliationEvidence(getDb(), claim, clock);
          assert.ok(evidence);
          assert.notEqual(evidence.delivery.firstDispatchedAt?.toISOString(), startedAt.toISOString(),
            "the old planner field has moved to recovery time, reproducing the rollout hazard");
          const result = await reconcileSlackOutboundDelivery({
            authority, reconciliationMarker: request.reconciliationMarker, now: clock,
            firstAttemptAt: evidence.firstAttemptAt, providerAttempt: evidence.delivery.providerAttempts,
            scan: evidence.delivery.reconciliationScan,
            saveScan: (scan) => saveSlackReconciliationScan(getDb(), { ...claim, scan, now: clock, providerAttempt: evidence.delivery.providerAttempts }),
            leaseCredential: async () => ({ schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, leaseId: "read-test",
              ...authority, leaseExpiresAt: new Date(clock.getTime() + 60_000) }),
            releaseCredential: async () => {},
            transport: { evidence: "double", async call(call) {
              // A real provider applies the bounds. The original crash tests
              // returned a receipt regardless of oldest/latest and missed this.
              const visible = Number(acceptedTs) >= Number(call.body.oldest) && Number(acceptedTs) <= Number(call.body.latest);
              return { kind: "response", status: 200, headers: {}, body: { ok: true, has_more: false,
                messages: visible ? [{ ts: acceptedTs, app_id: authority.providerAppId, metadata: { event_type: "raft_message",
                  event_payload: { reconciliation_marker: request.reconciliationMarker } } }] : [] } };
            } },
          });
          if (result.kind === "found") return reconciledProviderReceipt({ kind: "accepted", providerMessageId: result.providerMessageId });
          return { ready: true, async dispatch() { sends += 1; return { kind: "accepted", providerMessageId: (clock.getTime() / 1000).toFixed(6) }; } };
        },
      };
      const firstInput = { db: getDb(), bindingId: seeded.delivery.bindingId, bindingEpoch: 1, leaseOwner: "first-worker", dependencies };
      // The old process would be dead. Complete its held promise only during
      // cleanup; the ordinary worker must reject this late, no-longer-owned result.
      const first = processExternalDeliveryPartitionHead(firstInput).catch((error: unknown) => {
        assert.match(String(error), /lost exact lease authority/);
      });
      await sentOnce;
      try {
        clock = new Date(startedAt.getTime() + reclaimAfterMs);
        const secondInput = { ...firstInput, leaseOwner: "replacement-worker" };
        assert.equal((await processExternalDeliveryPartitionHead(secondInput)).kind, "lease_reclaimed");
        // Existing production rows may already contain the reclaim timestamp,
        // even if a future planner starts preserving its original field.
        await getDb().update(externalOutboundDeliveries).set({ firstDispatchedAt: clock })
          .where(eq(externalOutboundDeliveries.id, seeded.delivery.id));
        const recovered = await processExternalDeliveryPartitionHead(secondInput);
        assert.equal(sends, 1, "a deployed replacement must not publish the already accepted message again");
        assert.equal(recovered.kind, "cursor_recovered");
        const [delivery] = await getDb().select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, seeded.delivery.id));
        const attempts = await getDb().select().from(externalDeliveryAttempts).where(eq(externalDeliveryAttempts.deliveryId, seeded.delivery.id));
        assert.equal(delivery.state, "accepted");
        assert.equal(delivery.providerMessageId, acceptedTs);
        assert.equal(delivery.providerAttempts, 1);
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]?.providerIoStartedAt.toISOString(), startedAt.toISOString());
        assert.equal(sends, 1, "a deployed replacement must not publish the already accepted message again");
      } finally {
        finish({ kind: "accepted", providerMessageId: acceptedTs });
        await first;
      }
    });
  }, TEST_TIMEOUT_MS);
}


test("newer attachment deployment configuration wins against a waiting old instance", async () => {
  await withRealPg(async () => {
    const db = getDb();
    const [before] = await db.select().from(slackAttachmentPlanRollout);
    const generation = (before?.configGeneration ?? 0) + 1;
    const enable = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "true",
      SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(generation), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@test-verifier" });
    const pause = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "false",
      SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(generation + 1) });
    assert.ok(enable && pause);
    await applySlackAttachmentFallbackDeployment({ db, config: enable, now: new Date() });
    const holder = new pg.Client({ connectionString: REAL_PG_URL });
    const probe = new pg.Client({ connectionString: REAL_PG_URL });
    await Promise.all([holder.connect(), probe.connect()]);
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM slack_attachment_plan_rollout FOR UPDATE");
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const newer = applySlackAttachmentFallbackDeployment({ db, config: pause, now: new Date() });
      await waitUntilBlockedBy(probe, rows[0]!.pid);
      const older = applySlackAttachmentFallbackDeployment({ db, config: enable, now: new Date() });
      await holder.query("COMMIT");
      await Promise.all([newer, older]);
      const [state] = await db.select().from(slackAttachmentPlanRollout);
      assert.equal(state.configGeneration, generation + 1); assert.equal(state.enabled, false);
      assert.equal(state.minimumWriterVersion, 1);
      assert.equal(state.verifiedBy, "@test-verifier");
      assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: enable, now: new Date() }), "older_config");
      await assert.rejects(holder.query("UPDATE slack_attachment_plan_rollout SET enabled = true"), error => sqlState(error) === "55000");
    } finally { await Promise.all([holder.end(), probe.end()]); }
  });
}, TEST_TIMEOUT_MS);
