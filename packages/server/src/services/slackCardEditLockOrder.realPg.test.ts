// Real-PostgreSQL teeth for the card edit lock order (slackCardEditSync.ts:
// the source message, sync rows, the attempt start's authority rows, attempt
// rows, pair notice locks last). PGlite runs every transaction on one
// connection, so a lock wait or a deadlock only shows on a real
// multi-connection Postgres. CI: the real-PG job with
// CHANNEL_CONVERSION_REAL_PG_URL; locally: an empty PostgreSQL 17 database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { channels, externalCardEditAttempts, externalCardEditSyncs, externalChannelBindings } from "../db/schema";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { card, CONVERSATION, recordAudience, seedCardOnPair, seedJointSlackCardEditFixture, seedSlackCardEditFixture, TEAM, updateCard, type SlackCardEditFixture } from "../test/slackCardEditFixture";
import { applyMessageCardUpdate } from "./messageCardService";
import { addAgent, archiveChannel, removeAgent } from "./channelService";
import { updateFeatureFlag } from "./featureFlagService";
import { __setSlackCardEditBeforePairNoticeLockHookForTests, listSlackCardEditPanelNotices, readSlackCardEditSyncState, SLACK_CARD_EDIT_LEASE_MS } from "./slackCardEditSync";
import {
  __setSlackCardEditBeforeProviderIoAdmissionHookForTests,
  __setSlackCardEditBeforeSenderPostingCheckHookForTests,
  processSlackCardEditSyncOnce,
  type SlackCardEditWorkerDependencies,
} from "./slackCardEditWorkerService";
import { SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, type SlackJsonObject, type SlackWebApiRequest, type SlackWebApiTransportResult } from "./slackProviderAdapter";

const REAL_PG_URL = process.env.CHANNEL_CONVERSION_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;

async function withRealPg(run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("CHANNEL_CONVERSION_REAL_PG_REQUIRED=1 but CHANNEL_CONVERSION_REAL_PG_URL is unset");
    return;
  }
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  await migrateRealPgTestDatabase(pool, MIGRATIONS_FOLDER);
  await initDatabase(REAL_PG_URL);
  try {
    await run(pool);
  } finally {
    __setSlackCardEditBeforeProviderIoAdmissionHookForTests(null);
    __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
    await closeDatabase();
    await pool.end();
  }
}

/** Slack accepting every edit and reading back what it was last given, per ts. */
function slackDouble(appId: string) {
  const shown = new Map<string, number>();
  const requests: SlackWebApiRequest[] = [];
  const ok = (body: SlackJsonObject): SlackWebApiTransportResult => ({ kind: "response", status: 200, headers: {},
    body: { ok: true, ...body }, observedAuthority: { providerAppId: appId, providerAuthorityId: TEAM } });
  return {
    requests,
    transport: {
      evidence: "double" as const,
      async call(request: SlackWebApiRequest): Promise<SlackWebApiTransportResult> {
        requests.push(request);
        const ts = String(request.body.ts ?? request.body.latest);
        if (request.method === "chat.update") {
          shown.set(ts, (request.body.metadata as { event_payload: { card_revision: number } }).event_payload.card_revision);
          return ok({ channel: CONVERSATION, ts });
        }
        // A read-back that finds nothing readable (enough to see the call happen).
        if (request.method === "conversations.history" || request.method === "conversations.replies") return ok({ messages: [] });
        throw new Error(`unexpected Slack method ${request.method}`);
      },
    },
  };
}

/** A held connection's backend pid. */
async function pidOf(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]!.pid;
}

/** The backend pid of the transaction this runs in: a hook inside the worker's attempt start or read-back admission. */
async function ambientPid(): Promise<number> {
  const result = await getDb().execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return Number(result.rows[0]!.pid);
}

/**
 * The worker's backend pid, noted as its admission starts (inside its
 * transaction, before any authority lock); `gate`, if given, holds it there.
 */
function noteWorkerAtAdmission(gate?: Promise<void>): Promise<number> {
  let noted!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => { noted = resolve; });
  __setSlackCardEditBeforeProviderIoAdmissionHookForTests(async () => {
    noted(await ambientPid());
    if (gate) await gate;
  });
  return pid;
}

/**
 * Runs a real writer in a transaction whose backend pid is known before it
 * starts: the writer's own transactions become savepoints of it, so its
 * locks, its waits and its commit are that session's.
 */
function startKnownWriter<T>(work: () => Promise<T>): { pid: Promise<number>; done: Promise<T> } {
  let notePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => { notePid = resolve; });
  const done = getDb().transaction(async () => {
    notePid(await ambientPid());
    return work();
  });
  done.catch(() => notePid(-1));
  return { pid, done };
}

/**
 * Waits until session `blocked` is blocked by session `by`: the intended pair
 * of actors, never just any session the blocker blocks (Cardy, #12736).
 */
async function waitForBlocked(pool: pg.Pool, pair: { blocked: number; by: number }, polls = 100): Promise<boolean> {
  for (let poll = 0; poll < polls; poll += 1) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [pair.blocked, pair.by]);
    if (rows[0]!.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * The sessions blocked by exactly this actor (pg_blocking_pids), once there is
 * one. Never a count of lock waits: other real-PG files run in parallel on the
 * same database, and their waits must not satisfy a barrier (Cardy, #12732).
 */
async function waitForBlockedBy(pool: pg.Pool, blockerPid: number): Promise<number[]> {
  for (let poll = 0; poll < 100; poll += 1) {
    const { rows } = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blockerPid]);
    if (rows.length > 0) return rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

function dependencies(fixture: SlackCardEditFixture, transport: SlackCardEditWorkerDependencies["transport"]): SlackCardEditWorkerDependencies {
  return {
    registrationId: fixture.registration.id,
    transport,
    async leaseCredential({ fence, now }) {
      return { schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, leaseId: randomUUID(), installId: fence.installId,
        providerAppId: fence.providerAppId, providerAuthorityId: fence.providerAuthorityId,
        connectionEpoch: fence.connectionEpoch, credentialRevision: fence.credentialRevision,
        leaseExpiresAt: new Date(now.getTime() + 60_000) };
    },
    async releaseCredential() {},
  };
}

test("two cards of one pair updated and edited concurrently all complete, with no deadlock and the pair's notices right", async () => {
  await withRealPg(async () => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    const second = await seedCardOnPair(fixture, { original: "accepted", ts: "1793700000.000200", position: 2 });
    const cards = [fixture, { ...fixture, ...second }];
    const slack = slackDouble(appId);
    const deps = dependencies(fixture, slack.transport);
    const step = (owner: string) => processSlackCardEditSyncOnce({ db, leaseOwner: owner, dependencies: deps });
    for (let round = 0; round < 8; round += 1) {
      // Card updates (message, sync, pair) race worker claims, attempt starts and outcomes (sync, ..., pair).
      await Promise.all([
        updateCard(cards[0]!, `A${round}`, new Date()),
        updateCard(cards[1]!, `B${round}`, new Date()),
        step("worker-a"), step("worker-b"), step("worker-c"),
      ]);
    }
    for (let index = 0; index < 40; index += 1) {
      const results = await Promise.all([step("worker-a"), step("worker-b")]);
      if (results.every((result) => result.kind === "empty")) break;
    }
    for (const card of cards) {
      const [state] = await readSlackCardEditSyncState(db, card.message.id);
      assert.deepEqual([state!.status.summary, state!.sync.latestRevision, state!.sync.shownRevision], ["confirmed", 9, 9]);
    }
    assert.deepEqual(await listSlackCardEditPanelNotices(db, [{ bindingId: fixture.binding.id, bindingEpoch: 1 }], new Date()), []);
  });
}, TEST_TIMEOUT_MS);

test("a card update arriving while the worker's outcome holds the sync row queues behind it, never deadlocking on the pair lock", async () => {
  await withRealPg(async () => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    await updateCard(fixture, "Ready", new Date());
    const slack = slackDouble(appId);
    let armed = false;
    let fired = false;
    let signal!: () => void;
    const go = new Promise<void>((resolve) => { signal = resolve; });
    // Started here, outside the worker's transaction: getDb() inside the hook
    // would join that transaction as a savepoint instead of racing it.
    const racing = (async () => { await go; return updateCard(fixture, "Shipped", new Date()); })();
    const call = slack.transport.call;
    slack.transport.call = async (request) => { const result = await call(request); armed = true; return result; };
    // The worker's outcome transaction holds the sync row; before it takes the
    // pair lock, the same card is updated (its message, then that sync row).
    __setSlackCardEditBeforePairNoticeLockHookForTests(async () => {
      if (!armed) return;
      armed = false;
      fired = true;
      signal();
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    try {
      const result = await processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: dependencies(fixture, slack.transport) });
      assert.equal(result.kind === "attempted" ? result.outcome : result.kind, "succeeded");
      assert.ok(fired, "the card update raced the outcome transaction");
      assert.equal(await racing, 3, "the card update completed after it (no 40P01)");
    } finally {
      __setSlackCardEditBeforePairNoticeLockHookForTests(null);
    }
    const [state] = await readSlackCardEditSyncState(db, fixture.message.id);
    assert.deepEqual([state!.sync.latestRevision, state!.sync.shownRevision, state!.status.summary], [3, 2, "pending"]);
  });
}, TEST_TIMEOUT_MS);

test("a pause committed while the attempt start waits on the binding's writer is seen: no attempt row, no chat.update", async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    await updateCard(fixture, "Ready", new Date());
    const slack = slackDouble(appId);
    const writer = await pool.connect();
    const distractor = await pool.connect();
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    try {
      // A lifecycle writer's order: the installation, then the binding, FOR UPDATE.
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM external_app_installs WHERE id = $1 FOR UPDATE", [fixture.install.id]);
      await writer.query("SELECT id FROM external_channel_bindings WHERE id = $1 FOR UPDATE", [fixture.binding.id]);
      const writerPid = await pidOf(writer);
      // A distractor blocked by the same holder: an unrelated session waiting on the binding row. (Not
      // the installation row: a second waiter there queues behind the first, so the worker would be
      // reported blocked by the distractor rather than by the holder.)
      const distractorPid = await pidOf(distractor);
      await distractor.query("BEGIN");
      const distracting = distractor.query("SELECT id FROM external_channel_bindings WHERE id = $1 FOR UPDATE", [fixture.binding.id]);
      assert.ok(await waitForBlocked(pool, { blocked: distractorPid, by: writerPid }), "the distractor waits on the holder");
      // The worker, held at the start of its admission: its pid is known, and it is not waiting yet.
      const workerAdmitting = noteWorkerAtAdmission(workerGate);
      const stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: dependencies(fixture, slack.transport) });
      const workerPid = await workerAdmitting;
      assert.equal(await waitForBlocked(pool, { blocked: workerPid, by: writerPid }, 10), false,
        "the distractor alone does not satisfy the worker's barrier");
      releaseWorker();
      assert.ok(await waitForBlocked(pool, { blocked: workerPid, by: writerPid }), "the attempt start waits on the writer's installation lock");
      await writer.query("UPDATE external_channel_bindings SET state = 'paused', state_reason = 'operator_paused' WHERE id = $1",
        [fixture.binding.id]);
      await writer.query("COMMIT");
      await distracting;
      await distractor.query("ROLLBACK");
      const result = await stepping;
      assert.deepEqual(result.kind === "waiting" ? result.reason : result.kind, "binding_inactive");
    } finally {
      releaseWorker();
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
      await distractor.query("ROLLBACK").catch(() => undefined);
      distractor.release();
    }
    assert.deepEqual(await db.select().from(externalCardEditAttempts)
      .where(eq(externalCardEditAttempts.sourceMessageId, fixture.message.id)), [], "no attempt row");
    assert.deepEqual(slack.requests, [], "no chat.update");
    const [sync] = await db.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
    assert.equal(sync!.holdReason, "binding_inactive");
    await db.update(externalChannelBindings).set({ state: "active", stateReason: null })
      .where(eq(externalChannelBindings.id, fixture.binding.id));
  });
}, TEST_TIMEOUT_MS);

test("a membership removal racing the attempt start, committed first, is seen: no attempt row, no chat.update", async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    await updateCard(fixture, "Ready", new Date());
    const slack = slackDouble(appId);
    const writer = await pool.connect();
    try {
      // The membership writer's statement (channelService.removeAgent), held open.
      await writer.query("BEGIN");
      await writer.query("DELETE FROM channel_agents WHERE channel_id = $1 AND agent_id = $2", [fixture.channel.id, fixture.agent.id]);
      const workerAdmitting = noteWorkerAtAdmission();
      const stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: dependencies(fixture, slack.transport) });
      assert.ok(await waitForBlocked(pool, { blocked: await workerAdmitting, by: await pidOf(writer) }),
        "the attempt start waits on the sender's membership row");
      await writer.query("COMMIT");
      const result = await stepping;
      assert.equal(result.kind === "ended" ? result.reason : result.kind, "sender_removed");
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    assert.deepEqual(await db.select().from(externalCardEditAttempts)
      .where(eq(externalCardEditAttempts.sourceMessageId, fixture.message.id)), [], "no attempt row");
    assert.deepEqual(slack.requests, [], "no chat.update");
  });
}, TEST_TIMEOUT_MS);

// A thread card's posting authority is its parent channel's membership.
for (const conversation of ["channel", "thread"] as const) test(`a member removed, re-added and removed again around the attempt start (a ${conversation} card): the row the verdict rests on is locked, so the second removal waits for the attempt`, async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId, conversation });
    await updateCard(fixture, "Ready", new Date());
    const slack = slackDouble(appId);
    const base = dependencies(fixture, slack.transport);
    const attemptsHeld = await pool.connect();
    let reachCheck!: () => void;
    const atCheck = new Promise<void>((resolve) => { reachCheck = resolve; });
    let resumeCheck!: () => void;
    const resumed = new Promise<void>((resolve) => { resumeCheck = resolve; });
    let workerPid = 0;
    try {
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(async () => { workerPid = await ambientPid(); reachCheck(); await resumed; });
      const stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: {
        ...base,
        async leaseCredential(input) {
          // The first check saw a member; removed (the real writer, committed) while the credential is leased.
          await removeAgent(fixture.channel.id, fixture.agent.id);
          // The attempt insert is held, so the attempt start stays open after its check.
          await attemptsHeld.query("BEGIN");
          await attemptsHeld.query("LOCK TABLE external_card_edit_attempts IN SHARE MODE");
          return base.leaseCredential(input);
        },
      } });
      await atCheck;
      // Re-added (committed, outside the attempt start) right before its posting check.
      assert.equal(await addAgent(fixture.channel.id, fixture.agent.id), true);
      resumeCheck();
      assert.deepEqual(await waitForBlockedBy(pool, await pidOf(attemptsHeld)), [workerPid],
        "the attempt start passed its check and waits on the held attempt insert");
      let removedAgain = false;
      const removal = startKnownWriter(() => removeAgent(fixture.channel.id, fixture.agent.id));
      const removed = removal.done.then(() => { removedAgain = true; });
      assert.ok(await waitForBlocked(pool, { blocked: await removal.pid, by: workerPid }),
        "the second removal waits on the membership row the verdict locked");
      assert.equal(removedAgain, false, "no removal commits between the verdict and the attempt row");
      await attemptsHeld.query("COMMIT");
      const result = await stepping;
      await removed;
      assert.equal(result.kind, "attempted");
    } finally {
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
      await attemptsHeld.query("ROLLBACK").catch(() => undefined);
      attemptsHeld.release();
    }
    // Admitted before the removal committed: an in-flight request, the stated limitation.
    assert.equal((await db.select().from(externalCardEditAttempts)
      .where(eq(externalCardEditAttempts.sourceMessageId, fixture.message.id))).length, 1);
    assert.equal(slack.requests.filter((request) => request.method === "chat.update").length, 1);
  });
}, TEST_TIMEOUT_MS);

// An archive is the card update route's boundary too (Cardy, #12710 review of 9753fd25).
for (const conversation of ["channel", "thread"] as const) test(`an archive racing the attempt start (a ${conversation} card): the root channel row is locked, so the real archive writer waits for the attempt`, async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId, conversation });
    await updateCard(fixture, "Ready", new Date());
    const slack = slackDouble(appId);
    let reachCheck!: () => void;
    const atCheck = new Promise<void>((resolve) => { reachCheck = resolve; });
    let resumeCheck!: () => void;
    const resumed = new Promise<void>((resolve) => { resumeCheck = resolve; });
    let workerPid = 0;
    let stepping: ReturnType<typeof processSlackCardEditSyncOnce> | undefined;
    try {
      // Paused after its archive check, with the root row locked and the attempt not yet inserted.
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(async () => { workerPid = await ambientPid(); reachCheck(); await resumed; });
      stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: dependencies(fixture, slack.transport) });
      await atCheck;
      let archived = false;
      const archive = startKnownWriter(() => archiveChannel(fixture.channel.id, fixture.owner.id));
      const archiving = archive.done.then(() => { archived = true; });
      assert.ok(await waitForBlocked(pool, { blocked: await archive.pid, by: workerPid }),
        "the archive waits on the root channel row the attempt start locked");
      assert.equal(archived, false, "no archive commits between the check and the attempt row");
      resumeCheck();
      const result = await stepping;
      await archiving;
      assert.equal(result.kind, "attempted");
    } finally {
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
      resumeCheck();
      await stepping?.catch(() => undefined);
    }
    // Admitted before the archive committed: an in-flight request, the stated limitation.
    assert.equal((await db.select().from(externalCardEditAttempts)
      .where(eq(externalCardEditAttempts.sourceMessageId, fixture.message.id))).length, 1);
    assert.equal(slack.requests.filter((request) => request.method === "chat.update").length, 1);
  });
}, TEST_TIMEOUT_MS);

// Time passing while the final check waits on a lock (peng, #12710 review of bbc374e7; his real-PG repro).
for (const expiring of ["worker lease", "matched audience"] as const) test(`the ${expiring} running out while the final check waits on the root channel lock: no attempt row, no chat.update`, async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    const start = new Date();
    let clock = start;
    if (expiring === "matched audience") await recordAudience(fixture, "matched", { expiresAt: new Date(start.getTime() + 10_000) });
    await updateCard(fixture, "Ready", start);
    const slack = slackDouble(appId);
    const base = dependencies(fixture, slack.transport);
    const writer = await pool.connect();
    try {
      // A channel writer holding the root row (archiveChannel's or conversion's lock).
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [fixture.channel.id]);
      const workerAdmitting = noteWorkerAtAdmission();
      const stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: { ...base,
        now: () => clock,
        // The credential outlives the worker lease, so only the lease (or the audience) runs out.
        async leaseCredential(input) {
          const credential = await base.leaseCredential(input);
          return credential && { ...credential, leaseExpiresAt: new Date(input.now.getTime() + 120_000) };
        },
      } });
      assert.ok(await waitForBlocked(pool, { blocked: await workerAdmitting, by: await pidOf(writer) }),
        "the final check waits on the root channel row");
      clock = new Date(start.getTime() + (expiring === "worker lease" ? SLACK_CARD_EDIT_LEASE_MS + 1 : 11_000));
      await writer.query("COMMIT");
      const result = await stepping;
      assert.equal(result.kind === "waiting" ? result.reason : result.kind,
        expiring === "worker lease" ? "lease_lost" : "slack_audience_not_matched");
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    assert.deepEqual(await db.select().from(externalCardEditAttempts)
      .where(eq(externalCardEditAttempts.sourceMessageId, fixture.message.id)), [], "no attempt row");
    assert.deepEqual(slack.requests, [], "no chat.update");
  });
}, TEST_TIMEOUT_MS);

// The attempt start's commit can wait on the pair notice lock after its checks (peng, Cardy, #12710 review of 49fcea31).
test("the matched audience running out while the attempt start waits on the pair notice lock: no chat.update; the attempt closed as not sent", async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    const start = new Date();
    let clock = start;
    await recordAudience(fixture, "matched", { expiresAt: new Date(start.getTime() + 10_000) });
    await updateCard(fixture, "Ready", start);
    const slack = slackDouble(appId);
    const base = dependencies(fixture, slack.transport);
    const noticeHolder = await pool.connect();
    let stepping: ReturnType<typeof processSlackCardEditSyncOnce> | undefined;
    try {
      const workerAdmitting = noteWorkerAtAdmission();
      stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: { ...base,
        now: () => clock,
        async leaseCredential(input) {
          // After the first check: another transaction holds this pair's notice lock.
          await noticeHolder.query("BEGIN");
          await noticeHolder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`card-edit-pair-notices:${fixture.binding.id}:${fixture.binding.bindingEpoch}`]);
          const credential = await base.leaseCredential(input);
          return credential && { ...credential, leaseExpiresAt: new Date(input.now.getTime() + 120_000) };
        },
      } });
      assert.ok(await waitForBlocked(pool, { blocked: await workerAdmitting, by: await pidOf(noticeHolder) }),
        "the attempt start passed its checks and waits on the pair notice lock");
      clock = new Date(start.getTime() + 11_000);
      await noticeHolder.query("COMMIT");
      const result = await stepping;
      assert.equal(result.kind === "waiting" ? result.reason : result.kind, "slack_audience_not_matched");
    } finally {
      await noticeHolder.query("ROLLBACK").catch(() => undefined);
      noticeHolder.release();
      await stepping?.catch(() => undefined);
    }
    assert.deepEqual(slack.requests, [], "no chat.update");
    assert.deepEqual((await db.select().from(externalCardEditAttempts)
      .where(eq(externalCardEditAttempts.sourceMessageId, fixture.message.id))).map((attempt) => [attempt.state, attempt.outcomeReason]),
    [["failed", "not_sent_audience_expired"]]);
  });
}, TEST_TIMEOUT_MS);

// A read-back admitted before the master switch goes off is already in flight (peng, #12710 review of 49fcea31).
for (const conversation of ["channel", "thread"] as const) test(`the master switch turned off while a ${conversation} card's read-back is admitted: the real flag writer waits for the admission; the read is in flight`, async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId, conversation });
    const now = new Date();
    await updateCard(fixture, "Ready", now);
    await db.update(externalCardEditSyncs).set({ uncertainAt: now, readbackStage: 1, readbackDueAt: now, quietUntil: null, nextAttemptAt: now })
      .where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
    const slack = slackDouble(appId);
    let reachCheck!: () => void;
    const atCheck = new Promise<void>((resolve) => { reachCheck = resolve; });
    let resumeCheck!: () => void;
    const resumed = new Promise<void>((resolve) => { resumeCheck = resolve; });
    let workerPid = 0;
    let stepping: ReturnType<typeof processSlackCardEditSyncOnce> | undefined;
    try {
      // Paused inside the read-back's admission, its flag locks held.
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(async () => { workerPid = await ambientPid(); reachCheck(); await resumed; });
      stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: dependencies(fixture, slack.transport) });
      await atCheck;
      let switchedOff = false;
      const writer = startKnownWriter(() => updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: false }));
      const switching = writer.done.then(() => { switchedOff = true; });
      assert.ok(await waitForBlocked(pool, { blocked: await writer.pid, by: workerPid }),
        "the flag writer waits on the read-back admission's shared lock of the master switch");
      assert.equal(switchedOff, false, "the switch is not turned off while the read-back is being admitted");
      resumeCheck();
      const result = await stepping;
      await switching;
      assert.equal(result.kind, "read_back");
      assert.deepEqual(slack.requests.map((request) => request.method),
        [conversation === "thread" ? "conversations.replies" : "conversations.history"], "admitted first: the read is in flight");
    } finally {
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
      resumeCheck();
      await stepping?.catch(() => undefined);
      await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: true });
    }
  });
}, TEST_TIMEOUT_MS);

// A deletion committed after a read-back's admission meets a read already in flight (peng, #12710 review of aaac2983).
test("a card message deleted while its read-back is admitted: the deletion waits on the source row the admission holds; the read is in flight", async () => {
  await withRealPg(async (pool) => {
    const db = getDb();
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedSlackCardEditFixture(db, { providerAppId: appId });
    const now = new Date();
    await updateCard(fixture, "Ready", now);
    await db.update(externalCardEditSyncs).set({ uncertainAt: now, readbackStage: 1, readbackDueAt: now, quietUntil: null, nextAttemptAt: now })
      .where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
    const slack = slackDouble(appId);
    let reachCheck!: () => void;
    const atCheck = new Promise<void>((resolve) => { reachCheck = resolve; });
    let resumeCheck!: () => void;
    const resumed = new Promise<void>((resolve) => { resumeCheck = resolve; });
    let workerPid = 0;
    let stepping: ReturnType<typeof processSlackCardEditSyncOnce> | undefined;
    try {
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(async () => { workerPid = await ambientPid(); reachCheck(); await resumed; });
      stepping = processSlackCardEditSyncOnce({ db, leaseOwner: "worker-a", dependencies: dependencies(fixture, slack.transport) });
      await atCheck;
      let deleted = false;
      // The deletion's row write, on its own connection.
      const deleter = await pool.connect();
      const deleterPid = await pidOf(deleter);
      const deleting = deleter.query("UPDATE messages SET deleted_at = now() WHERE id = $1", [fixture.message.id])
        .then(() => { deleted = true; }).finally(() => deleter.release());
      assert.ok(await waitForBlocked(pool, { blocked: deleterPid, by: workerPid }),
        "the deletion waits on the source row the read-back's admission holds");
      assert.equal(deleted, false);
      resumeCheck();
      const result = await stepping;
      await deleting;
      assert.equal(result.kind, "read_back");
      assert.deepEqual(slack.requests.map((request) => request.method), ["conversations.history"], "admitted first: the read is in flight");
    } finally {
      __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
      resumeCheck();
      await stepping?.catch(() => undefined);
    }
  });
}, TEST_TIMEOUT_MS);

test("a joint card's update takes its sender's joint posting authority before the message row, as a send does", async () => {
  await withRealPg(async (pool) => {
    const fixture = await seedJointSlackCardEditFixture(getDb(), { providerAppId: `A_LOCK_${randomUUID().slice(0, 8)}` });
    // A writer of the host projection's row (the archive writer's lock).
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [fixture.channel.id]);
      const holderPid = await pidOf(holder);
      const update = startKnownWriter(() => applyMessageCardUpdate({
        messageId: fixture.message.id, senderAgentId: fixture.agent.id, card: card("Shipped"), content: "Build 1.19.0 · Shipped",
        jointPostingAuthorityChannelId: fixture.channel.id,
      }));
      assert.ok(await waitForBlocked(pool, { blocked: await update.pid, by: holderPid }), "the update waits on the projection's row");
      // While it waits there, it holds no lock on the message row: the joint
      // authority (channel, server, membership rows) comes before it.
      const probe = await pool.connect();
      try {
        await probe.query("BEGIN");
        const { rows } = await probe.query("SELECT id FROM messages WHERE id = $1 FOR UPDATE NOWAIT", [fixture.message.id]);
        assert.equal(rows.length, 1, "the message row is free");
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }
      await holder.query("ROLLBACK");
      const outcome = await update.done;
      assert.equal(outcome.kind === "updated" ? outcome.answer.revision : outcome.kind, 2);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });
}, TEST_TIMEOUT_MS);

test("a writer holding the host projection FOR UPDATE that then references the card message (a mention action's add: its inbox fact's foreign key) and a card update of it both complete", async () => {
  await withRealPg(async (pool) => {
    const fixture = await seedJointSlackCardEditFixture(getDb(), { providerAppId: `A_LOCK_${randomUUID().slice(0, 8)}` });
    const holder = await pool.connect();
    try {
      // mentionActionService's add: the projection row FOR UPDATE first.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [fixture.channel.id]);
      const holderPid = await pidOf(holder);
      const update = startKnownWriter(() => applyMessageCardUpdate({
        messageId: fixture.message.id, senderAgentId: fixture.agent.id, card: card("Shipped"), content: "Build 1.19.0 · Shipped",
        jointPostingAuthorityChannelId: fixture.channel.id,
      }));
      assert.ok(await waitForBlocked(pool, { blocked: await update.pid, by: holderPid }), "the update waits on the projection's row");
      // Then the inbox fact for the mentioned message: its foreign key check
      // takes FOR KEY SHARE on the message row. Granted: the waiting update
      // holds no message lock (an update holding it would deadlock here).
      await holder.query("SELECT id FROM messages WHERE id = $1 FOR KEY SHARE", [fixture.message.id]);
      await holder.query("COMMIT");
      const outcome = await update.done;
      assert.equal(outcome.kind === "updated" ? outcome.answer.revision : outcome.kind, 2);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });
}, TEST_TIMEOUT_MS);

test("a joint card's update, its Slack edit and an archive of the host projection queued between them all complete: no deadlock", async () => {
  await withRealPg(async (pool) => {
    const appId = `A_LOCK_${randomUUID().slice(0, 8)}`;
    const fixture = await seedJointSlackCardEditFixture(getDb(), { providerAppId: appId });
    const slack = slackDouble(appId);
    const update = (state: string) => applyMessageCardUpdate({
      messageId: fixture.message.id, senderAgentId: fixture.agent.id, card: card(state), content: `Build 1.19.0 · ${state}`,
      jointPostingAuthorityChannelId: fixture.channel.id,
    });
    assert.equal((await update("Ready")).kind, "updated", "revision 2: the edit the worker sends");

    // 1. The worker's attempt start holds the message FOR SHARE and the sync
    //    row, and is held at its admission, before its authority rows.
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const workerPid = noteWorkerAtAdmission(workerGate);
    const worker = processSlackCardEditSyncOnce({ db: getDb(), leaseOwner: "worker-three-party", dependencies: dependencies(fixture, slack.transport) });
    try {
      const wpid = await workerPid;
      // 2. The card update: the projection FOR SHARE (its joint authority),
      //    then the message FOR UPDATE, which waits for the worker.
      const updating = startKnownWriter(() => update("Shipped"));
      const upid = await updating.pid;
      assert.ok(await waitForBlocked(pool, { blocked: upid, by: wpid }), "the update waits on the worker's message lock");
      // 3. An archive of the joint: its projection rows FOR UPDATE, queued
      //    behind the update's FOR SHARE.
      const archiving = startKnownWriter(() => archiveChannel(fixture.channel.id, fixture.owner.id));
      const apid = await archiving.pid;
      assert.ok(await waitForBlocked(pool, { blocked: apid, by: upid }), "the archive waits on the update's projection lock");
      // 4. The worker asks for the projection FOR SHARE: it joins the
      //    update's shared lock (PostgreSQL does not queue a shared request
      //    behind a waiting writer while only shared lockers hold the row).
      releaseWorker();
      const [edited, updated, archived] = await Promise.allSettled([worker, updating.done, archiving.done]);
      assert.equal(edited.status === "fulfilled" ? (edited.value.kind === "attempted" ? edited.value.outcome : edited.value.kind) : String(edited.reason), "succeeded");
      assert.equal(updated.status === "fulfilled" ? (updated.value.kind === "updated" ? updated.value.answer.revision : updated.value.kind) : String(updated.reason), 3);
      assert.equal(archived.status, "fulfilled", archived.status === "rejected" ? String(archived.reason) : "");
      const [projection] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, fixture.channel.id));
      assert.ok(projection!.archivedAt, "the archive went ahead after them");
    } finally {
      releaseWorker();
      __setSlackCardEditBeforeProviderIoAdmissionHookForTests(null);
    }
  });
}, TEST_TIMEOUT_MS);
