// CHANNEL_CONVERSION_REAL_PG_URL is an ADMIN url: the test creates a random
// database, migrates into it and drops it afterwards.
// CHANNEL_CONVERSION_REAL_PG_REQUIRED=1 fails instead of skipping.
//
// 1.23.0 incident: every replica runs the conversion worker on the same jobs,
// and each one waited on the conversion lock (ns 136) behind the replica
// running the phase, holding a pooled connection for the whole phase. Here:
// a phase holding the lock makes a second runner (and a worker pass) return
// busy at once, with nothing recorded; requests that must serialize with a
// phase (retry, cancel) are refused with the 409 "in progress" after a bounded
// wait instead of waiting the phase out; a phase failure that cannot get the
// lock is left for the next pass.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channelConversionJobs, channelConversionPhaseLedger, servers, users } from "../db/schema";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { addHuman, createChannel } from "./channelService";
import {
  ChannelConversionError,
  cancelChannelConversionJob,
  getChannelConversionJob,
  retryChannelConversionJob,
  runChannelConversionJob,
  setConversionPhaseUsersLockObserverForTest,
  startChannelToJointConversion,
  type ChannelConversionPhaseAttempt,
} from "./channelConversionService";
import { conversionCommandId, runConversionCommand } from "./channelConversionCommandService";
import { setChannelConversionLockProbeForTest } from "./channelConversionFenceService";
import { runChannelConversionWorkerPass } from "./channelConversionWorker";
import { createServer as createServerService } from "./serverService";
import { withTraceRoot } from "../tracing/semanticTrace";

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

async function seedJob(prefix: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${prefix}-owner@slock.test`,
    name: `${prefix}-owner`,
    displayName: `${prefix}-owner`,
    passwordHash: "not-used-by-this-test",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServerService(`${prefix} host`, `${prefix}-host`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, `${prefix}-room`, "convert me", "channel");
  await addHuman(channel.id, owner.id);
  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: channel.id, createdByUserId: owner.id });
  return { owner, server, channel, job };
}

/**
 * Hold the conversion lock inside a real phase: the next exclusive acquire of
 * this source's lock (the first runner's try) parks on a gate while holding it.
 */
function holdNextPhaseLock(serverId: string, sourceChannelId: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  let armed = true;
  // In-transaction lock arrivals after the hold (any runner that opened a phase transaction).
  const counts = { arrivalsWhileHeld: 0 };
  setChannelConversionLockProbeForTest({
    serverId,
    sourceChannelId,
    onArrival: () => { if (!armed) counts.arrivalsWhileHeld += 1; },
    onRequested: () => {},
    onAcquired: async (mode) => {
      if (!armed || mode !== "exclusive") return;
      armed = false;
      signalHeld();
      await gate;
    },
  });
  return { held, counts, release: () => { release(); setChannelConversionLockProbeForTest(null); } };
}

/** The conversion lock's two advisory keys, as planService derives them (ns 136). */
function conversionLockKeys(serverId: string, sourceChannelId: string): [number, number] {
  const serverKey = Number.parseInt(serverId.replace(/-/g, "").slice(0, 8), 16) | 0;
  return [serverKey, createHash("sha256").update(`136:${sourceChannelId}`).digest().readInt32BE(0)];
}

async function waitForAdvisoryWaiter(pool: pg.Pool, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pendingAdvisoryWaiters(pool) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the competing session never queued on the conversion lock");
}

async function pendingAdvisoryWaiters(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
  return Number(result.rows[0]?.n ?? 0);
}

async function committedPhases(jobId: string, phase: string): Promise<number> {
  const rows = await getDb().select({ id: channelConversionPhaseLedger.id }).from(channelConversionPhaseLedger)
    .where(and(eq(channelConversionPhaseLedger.jobId, jobId), eq(channelConversionPhaseLedger.phase, phase), eq(channelConversionPhaseLedger.status, "committed")));
  return rows.length;
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "real PostgreSQL: a running phase makes other runners busy at once, and bounds request waits",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    process.env.JWT_SECRET ||= "channel-conversion-trylock-test-secret";
    const databaseName = `slock_conversion_trylock_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "channel-conversion-trylock-admin" });
    await admin.connect();
    let opened = false;
    let observer: pg.Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = databaseUrlFor(REAL_PG_URL, databaseName);
      const setup = new pg.Pool({ connectionString: url, max: 1 });
      try { await migrate(drizzle(setup, { schema }), { migrationsFolder: MIGRATIONS_FOLDER }); } finally { await setup.end(); }
      await openTestDatabase(url);
      opened = true;
      observer = new pg.Pool({ connectionString: url, max: 1, application_name: "channel-conversion-trylock-observer" });

      // 1. Two runners on one job: the first runs the phase, the second is busy.
      {
        const { server, channel, job } = await seedJob(`trylock-${randomUUID().slice(0, 8)}`);
        assert.equal(job.status, "pending");
        const startPhase = job.phase;
        const hold = holdNextPhaseLock(server.id, channel.id);
        const firstAttempts: ChannelConversionPhaseAttempt[] = [];
        const first = runChannelConversionJob(job.id, { maxPhases: 1, onPhaseAttempt: (a) => firstAttempts.push(a) });
        void first.catch(() => {});
        try {
          await within(hold.held, 5_000, "the first runner's lock");
          const before = (await getChannelConversionJob(job.id))!;
          // The retry route's call: no phase limit. It must not spin or wait.
          const secondAttempts: ChannelConversionPhaseAttempt[] = [];
          const second = await within(timed(() => runChannelConversionJob(job.id, { onPhaseAttempt: (a) => secondAttempts.push(a) })), 5_000, "the second runner");
          assert.ok(second.ms < 500, `the second runner returned busy in ${second.ms.toFixed(0)} ms, not at once`);
          assert.deepEqual(secondAttempts, [{ phase: startPhase, lockAcquired: false }]);
          assert.equal(second.value.status, before.status);
          assert.equal(second.value.phase, startPhase);
          assert.equal(second.value.error, null, "busy records no failure");
          assert.equal(second.value.updatedAt.getTime(), before.updatedAt.getTime(), "busy writes no progress");
          // A whole worker pass on the same job: busy too, at once, and its
          // span says so per job (phase, hashed job id, lock_acquired).
          const sink = new MemoryTraceSink();
          const tracer = new BasicTracer({ sink });
          const pass = await within(timed(() => withTraceRoot(tracer, "server.channel_conversion_worker.pass", { surface: "server", kind: "internal" },
            () => runChannelConversionWorkerPass())), 5_000, "the worker pass");
          assert.ok(pass.ms < 500, `the worker pass took ${pass.ms.toFixed(0)} ms behind a running phase`);
          const passSpan = sink.getAllSpans().find((span) => span.name === "server.channel_conversion_worker.pass");
          const jobEvent = passSpan?.events.find((event) => event.name === "server.channel_conversion_worker.job");
          assert.ok(jobEvent, "the pass records the job it found busy");
          assert.equal(jobEvent.attrs?.lock_acquired, "busy");
          assert.equal(jobEvent.attrs?.phase, startPhase);
          assert.match(String(jobEvent.attrs?.job_id_hash), /^[0-9a-f]{16}$/);
          assert.ok(!JSON.stringify(jobEvent.attrs).includes(job.id), "never the raw job id");
          // Neither left a transaction waiting on the lock.
          assert.equal(await pendingAdvisoryWaiters(observer), 0, "no runner is parked on the conversion lock");
          const [stillRunning] = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.id, job.id));
          assert.notEqual(stillRunning.status, "failed");
        } finally {
          hold.release();
        }
        const done = await within(first, 15_000, "the first runner");
        assert.deepEqual(firstAttempts, [{ phase: startPhase, lockAcquired: true }]);
        assert.notEqual(done.phase, startPhase, "the first runner ran the phase");
        assert.notEqual(done.status, "failed");
        assert.equal(await committedPhases(job.id, startPhase), 1, "exactly one runner committed the phase");
      }

      // 1b. An audience phase holds the lock: a busy pass never reads the
      // channel's people, never locks their users rows, never opens a transaction.
      {
        const { server, channel, job } = await seedJob(`audience-${randomUUID().slice(0, 8)}`);
        let current = (await getChannelConversionJob(job.id))!;
        for (let i = 0; i < 12 && current.phase !== "audience_cutover"; i += 1) {
          current = await runChannelConversionJob(job.id, { maxPhases: 1 });
        }
        assert.equal(current.phase, "audience_cutover");
        assert.notEqual(current.status, "failed");
        const hold = holdNextPhaseLock(server.id, channel.id);
        const first = runChannelConversionJob(job.id, { maxPhases: 1 });
        void first.catch(() => {});
        const usersLocked: string[] = [];
        try {
          await within(hold.held, 5_000, "the audience phase's lock");
          setConversionPhaseUsersLockObserverForTest((jobId) => { usersLocked.push(jobId); });
          const attempts: ChannelConversionPhaseAttempt[] = [];
          const second = await within(timed(() => runChannelConversionJob(job.id, { onPhaseAttempt: (a) => attempts.push(a) })), 5_000, "the busy audience pass");
          const pass = await within(timed(() => runChannelConversionWorkerPass()), 5_000, "the worker pass");
          assert.deepEqual(attempts, [{ phase: "audience_cutover", lockAcquired: false }]);
          assert.ok(second.ms < 500 && pass.ms < 500, `busy audience passes took ${second.ms.toFixed(0)} / ${pass.ms.toFixed(0)} ms`);
          assert.deepEqual(usersLocked, [], "a busy pass takes no users row lock");
          assert.equal(hold.counts.arrivalsWhileHeld, 0, "a busy pass opens no phase transaction");
          assert.equal(await pendingAdvisoryWaiters(observer), 0);
        } finally {
          setConversionPhaseUsersLockObserverForTest(null);
          hold.release();
        }
        const done = await within(first, 30_000, "the audience phase");
        assert.equal(done.status, "done");
      }

      // 1c. A phase that fails records its failure under the lock it holds:
      // a competitor queued on the lock (another replica) cannot slip in
      // between the failure and its record and keep the job from failing.
      {
        const { server, channel, job } = await seedJob(`failrecord-${randomUUID().slice(0, 8)}`);
        let current = (await getChannelConversionJob(job.id))!;
        for (let i = 0; i < 12 && current.phase !== "audience_cutover"; i += 1) {
          current = await runChannelConversionJob(job.id, { maxPhases: 1 });
        }
        assert.equal(current.phase, "audience_cutover");
        const hold = holdNextPhaseLock(server.id, channel.id);
        const failing = runChannelConversionJob(job.id, { maxPhases: 1, failBeforePhase: "residual_cleanup" });
        void failing.catch(() => {});
        const competitor = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName), application_name: "conversion-competitor" });
        await competitor.connect();
        let competitorDone: Promise<unknown> | null = null;
        try {
        try {
          await within(hold.held, 5_000, "the failing phase's lock");
          await competitor.query("BEGIN");
          const [k1, k2] = conversionLockKeys(server.id, channel.id);
          // Queued behind the phase; once granted, held for longer than the bounded wait.
          competitorDone = competitor.query("SELECT pg_advisory_xact_lock($1, $2)", [k1, k2])
            .then(() => new Promise((resolve) => setTimeout(resolve, 3_000)))
            .then(() => competitor.query("COMMIT"));
          void competitorDone.catch(() => {});
          await waitForAdvisoryWaiter(observer);
        } finally {
          hold.release();
        }
        const failed = await within(failing, 15_000, "the failing phase");
        assert.equal(failed.status, "failed", "the failure is recorded, not deferred behind the competitor");
        } finally {
          if (competitorDone) await within((competitorDone as Promise<unknown>).catch(() => {}), 10_000, "the competitor");
          await competitor.end();
        }
      }

      // 2. Retry and cancel while a phase holds the lock: the 409 "in progress" after the bounded wait.
      {
        const { owner, server, channel, job } = await seedJob(`bounded-${randomUUID().slice(0, 8)}`);
        const hold = holdNextPhaseLock(server.id, channel.id);
        const phase = runChannelConversionJob(job.id, { maxPhases: 1 });
        void phase.catch(() => {});
        try {
          await within(hold.held, 5_000, "the phase's lock");
          const isBusy = (error: unknown) => error instanceof ChannelConversionError && error.code === "channel_conversion_in_progress";
          const cancel = await within(timed(() => runConversionCommand({
            id: conversionCommandId(undefined), serverId: server.id, sourceChannelId: channel.id,
            requestedByUserId: owner.id, kind: "cancel", jobId: job.id,
          }).then(() => null, (error: unknown) => error)), 6_000, "cancel");
          assert.ok(isBusy(cancel.value), `cancel: ${String(cancel.value)}`);
          assert.ok(cancel.ms >= 1_500 && cancel.ms < 4_000, `cancel was refused after ${cancel.ms.toFixed(0)} ms`);
          const retry = await within(timed(() => retryChannelConversionJob(job.id).then(() => null, (error: unknown) => error)), 6_000, "retry");
          assert.ok(isBusy(retry.value), `retry: ${String(retry.value)}`);
          assert.ok(retry.ms >= 1_500 && retry.ms < 4_000, `retry was refused after ${retry.ms.toFixed(0)} ms`);
          // A phase failure that cannot get the lock leaves the job for the next pass.
          const current = (await getChannelConversionJob(job.id))!;
          const deferred = await within(timed(() => runChannelConversionJob(job.id, { failBeforePhase: current.phase })), 6_000, "deferred failure");
          assert.ok(deferred.ms < 4_000);
          assert.notEqual(deferred.value.status, "failed", "a failure that could not get the lock is not recorded yet");
        } finally {
          hold.release();
        }
        await within(phase, 15_000, "the phase");
        // Once the phase is over, cancel goes through.
        const canceled = await within(cancelChannelConversionJob(job.id), 10_000, "cancel after the phase");
        assert.equal(canceled.status, "canceled");
      }
    } finally {
      setChannelConversionLockProbeForTest(null);
      if (observer) await observer.end();
      if (opened) await closeTestDatabase();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  },
  90_000,
);
