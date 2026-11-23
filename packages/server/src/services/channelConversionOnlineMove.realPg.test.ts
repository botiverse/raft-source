import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, inArray, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import {
  channelConversionJobs, channels, featureFlagRules, featureFlags, jointChannelServers, messages, servers, users,
} from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { openTestApp as startTestApp } from "../test/integration/app";
import { isOnlineMoveCanonicalSql, onlineMoveCanonicalForRoot, onlineMoveJobsSql, onlineMovePairSql } from "./channelConversionReadScope";
import { cancelChannelConversionJob, ChannelConversionBusyError, ChannelConversionError, startChannelToJointConversion } from "./channelConversionService";
import { addHuman, createChannel, getMessageStorageChannelIdWithExecutor, getOrCreateThread, getOrCreateThreadForChannel, jointThreadProjectionRowsQuery, lockAndResolveMessageStorage } from "./channelService";
import { CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY } from "./featureFlagService";
import { createMessage } from "./messageService";
import { createServer as createServerService } from "./serverService";

// channel_conversion_online_move_v1 on a real, multi-connection Postgres
// (PGlite serializes transactions):
//  (a) the online start gives up (lock_timeout) instead of stalling writers
//      when a writer holds one of the rows it rewrites, and leaves nothing;
//  (b) a cancel changes the route back only under the source row's FOR
//      UPDATE: it waits for a writer resolving storage under FOR KEY SHARE,
//      which reads the online route, and a later writer reads the source;
//  (c) the route predicate is an index lookup (EXPLAIN).

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

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntilAnyBlocked(observer: pg.Pool, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query(`
      SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND cardinality(pg_blocking_pids(pid)) > 0
       LIMIT 1`);
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} never waited on a lock`);
}

async function waitUntilBlockedCount(observer: pg.Pool, count: number, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query(`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND cardinality(pg_blocking_pids(pid)) > 0`);
    if (Number((result.rows[0] as { blocked?: number }).blocked) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} never waited on a lock`);
}

async function waitUntilBlockedBy(observer: pg.Pool, blockerPid: number, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query("SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1", [blockerPid]);
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} never waited on a lock`);
}

async function seedFixture(prefix: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${prefix}-owner@slock.test`, name: `${prefix}-owner`, displayName: `${prefix}-owner`,
    passwordHash: "not-used-by-this-test", emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServerService(`${prefix} host`, `${prefix}-host`, owner!.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.insert(featureFlags).values({
    key: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: false,
    randomizationUnit: "server", salt: "online-move-real-pg",
  }).onConflictDoNothing();
  await db.insert(featureFlagRules).values({
    flagKey: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id],
  });
  const channel = async (name: string) => {
    const created = await createChannel(server.id, `${prefix}-${name}`, "online move", "channel");
    await addHuman(created.id, owner!.id);
    const parent = await createMessage(created.id, "user", owner!.id, "parent history");
    const thread = await getOrCreateThread(parent.id, owner!.id, "user");
    await createMessage(thread.id, "user", owner!.id, "thread history");
    return { channel: created, parent, thread };
  };
  return { owner: owner!, server, channel };
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "real PostgreSQL: an online start aborts cleanly on a held root, a cancel changes the route under the source row lock, threads started meanwhile are not missed, and the route is an index lookup",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_online_move_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "online-move-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "online-move-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "online-move-observer", max: 2 });
      const f = await seedFixture(`online-move-${randomUUID().slice(0, 8)}`);

      // (a) A transaction holds the source row FOR KEY SHARE for longer than
      //     the start may wait (a mark-read, or anything resolving storage
      //     without the conversion lock). The start gives up after its
      //     lock_timeout and leaves the channel exactly as it was.
      {
        const fixture = await f.channel("held-root");
        const holder = await observer.connect();
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.channel.id]);
          const startedAt = Date.now();
          await assert.rejects(
            settleWithin(startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id }), "online start"),
            (error: unknown) => error instanceof ChannelConversionError && error.code === "channel_conversion_online_start_busy",
          );
          const elapsed = Date.now() - startedAt;
          assert.ok(elapsed >= 1_500 && elapsed < 6_000, `the start waited its lock_timeout and gave up (${elapsed}ms)`);
        } finally {
          await holder.query("ROLLBACK");
          holder.release();
        }
        assert.deepEqual(await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, fixture.channel.id)), [], "no job");
        assert.deepEqual(await getDb().select().from(jointChannelServers)
          .where(inArray(jointChannelServers.localChannelId, [fixture.channel.id, fixture.thread.id])), [], "no joint rows");
        assert.deepEqual(await getDb().select({ id: channels.id }).from(channels).where(like(channels.name, "joint-storage-convert-%")), [], "no canonical channel");
        const [thread] = await getDb().select().from(channels).where(eq(channels.id, fixture.thread.id));
        assert.equal(thread!.parentMessageId, fixture.parent.id, "the thread is untouched");
        const [parent] = await getDb().select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, fixture.parent.id));
        assert.equal(parent!.threadId, fixture.thread.id);
        assert.equal(await onlineMoveCanonicalForRoot(getDb(), fixture.channel.id), null);
        assert.equal(await getMessageStorageChannelIdWithExecutor(getDb(), fixture.channel.id), fixture.channel.id, "the route is unchanged");
        // Nothing left behind: a start without the conflicting lock succeeds.
        const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
        assert.equal(job.phase, "online_move");
      }

      // (b) Cancel: a writer resolving storage holds the source row FOR KEY
      //     SHARE and reads the online route; the cancel waits for it (its
      //     FOR UPDATE), then returns the route to the source.
      {
        const fixture = await f.channel("cancel");
        const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
        assert.equal(job.phase, "online_move");
        const writerResolved = gate();
        const releaseWriter = gate();
        const writer = getDb().transaction(async (tx) => {
          const storage = await lockAndResolveMessageStorage(tx, fixture.channel.id);
          writerResolved.open();
          await releaseWriter.opened;
          return storage;
        });
        void writer.catch(() => {});
        let cancel: ReturnType<typeof cancelChannelConversionJob> | undefined;
        try {
          await settleWithin(writerResolved.opened, "writer resolving its storage");
          let cancelSettled = false;
          cancel = cancelChannelConversionJob(job.id);
          void cancel.then(() => { cancelSettled = true; }, () => { cancelSettled = true; });
          await waitUntilAnyBlocked(observer, "the cancel");
          assert.equal(cancelSettled, false, "the cancel waits for the writer before changing the route");
          const [during] = await getDb().select({ phase: channelConversionJobs.phase }).from(channelConversionJobs).where(eq(channelConversionJobs.id, job.id));
          assert.equal(during!.phase, "online_move");
          releaseWriter.open();
          assert.equal(await settleWithin(writer, "writer"), job.canonicalChannelId, "the writer stores in the route it resolved under its lock");
          const canceled = await settleWithin(cancel, "cancel after the writer committed");
          assert.equal(canceled.status, "canceled");
        } finally {
          releaseWriter.open();
          await settleWithin(writer.catch(() => undefined), "writer cleanup");
          if (cancel) await settleWithin(cancel.catch(() => undefined), "cancel cleanup");
        }
        assert.equal(await getDb().transaction((tx) => lockAndResolveMessageStorage(tx, fixture.channel.id)), fixture.channel.id, "after the cancel, the route is the source");
      }

      // (d) A thread started while a start runs is not missed. The thread's
      //     creator takes the root row FOR KEY SHARE first: here it holds it
      //     while it waits on its parent message (another connection holds
      //     that row), so the start's FOR UPDATE on the root waits for it;
      //     once the thread commits (a plain one: no move yet), the start
      //     reads it and turns it joint like every other thread.
      {
        const fixture = await f.channel("thread-vs-start");
        const parent = await createMessage(fixture.channel.id, "user", f.owner.id, "parent of a racing thread");
        const holder = await observer.connect();
        let creator: Promise<{ id: string }> | undefined;
        let start: ReturnType<typeof startChannelToJointConversion> | undefined;
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM messages WHERE id = $1 FOR UPDATE", [parent.id]);
          creator = getOrCreateThreadForChannel(fixture.channel.id, parent.id, f.owner.id, "user");
          void creator.catch(() => {});
          await waitUntilAnyBlocked(observer, "the thread creator");
          let startSettled = false;
          start = startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
          void start.then(() => { startSettled = true; }, () => { startSettled = true; });
          await waitUntilBlockedCount(observer, 2, "the start behind the thread creator");
          assert.equal(startSettled, false, "the start waits for the thread's transaction");
          await holder.query("ROLLBACK");
          const thread = await settleWithin(creator, "thread creator");
          const job = await settleWithin(start, "start after the thread committed");
          assert.equal(job.phase, "online_move");
          const [local] = await getDb().select().from(channels).where(eq(channels.id, thread.id));
          assert.equal(local!.parentMessageId, null, "the racing thread became the host's projection");
          const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, thread.id));
          assert.ok(projection, "the racing thread has its joint rows");
          const [parentAfter] = await getDb().select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, parent.id));
          assert.notEqual(parentAfter!.threadId, thread.id, "the parent points at the canonical thread");
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          holder.release();
          if (creator) await settleWithin(creator.catch(() => undefined), "creator cleanup");
          if (start) await settleWithin(start.catch(() => undefined), "start cleanup");
        }
      }

      // (e) A thread started while a cancel runs is not missed either: made
      //     joint under the root's FOR KEY SHARE. The cancel takes the root
      //     FOR UPDATE last, waiting at most 500 ms: it answers busy and
      //     changes nothing while the thread's transaction holds the root; once
      //     that committed, a cancel restores the thread with the others.
      {
        const fixture = await f.channel("thread-vs-cancel");
        const parent = await createMessage(fixture.channel.id, "user", f.owner.id, "parent of a thread racing the cancel");
        const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
        assert.equal(job.phase, "online_move");
        const holder = await observer.connect();
        let creator: Promise<{ id: string; canonicalThreadChannelId: string }> | undefined;
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM messages WHERE id = $1 FOR UPDATE", [parent.id]);
          creator = getOrCreateThreadForChannel(fixture.channel.id, parent.id, f.owner.id, "user");
          void creator.catch(() => {});
          await waitUntilAnyBlocked(observer, "the thread creator");
          await assert.rejects(
            settleWithin(cancelChannelConversionJob(job.id), "cancel behind the thread creator"),
            (error: unknown) => error instanceof ChannelConversionBusyError,
            "the cancel gives up on the root the thread's transaction holds",
          );
          const [still] = await getDb().select({ phase: channelConversionJobs.phase }).from(channelConversionJobs).where(eq(channelConversionJobs.id, job.id));
          assert.equal(still!.phase, "online_move", "a cancel that gave up changed nothing");
          await holder.query("ROLLBACK");
          const thread = await settleWithin(creator, "thread creator");
          assert.notEqual(thread.id, thread.canonicalThreadChannelId, "made joint: the move was still on");
          assert.equal((await settleWithin(cancelChannelConversionJob(job.id), "cancel")).status, "canceled");
          const [local] = await getDb().select().from(channels).where(eq(channels.id, thread.id));
          assert.equal(local!.parentMessageId, parent.id, "the cancel restored the racing thread");
          assert.deepEqual(await getDb().select().from(channels).where(eq(channels.id, thread.canonicalThreadChannelId)), []);
          assert.deepEqual(await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, thread.id)), []);
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          holder.release();
          if (creator) await settleWithin(creator.catch(() => undefined), "creator cleanup");
        }
      }

      // (f) Mark-read (readMutationSequencer) against the online start, in
      //     both of the readers' lock orders. Read mutations take no
      //     conversion lock: a reader of one thread locks it FOR KEY SHARE,
      //     then its parent channel; a whole-scope read (global_read_all)
      //     locks the roots, then the threads. The start holds the source FOR
      //     UPDATE and its threads only FOR NO KEY UPDATE, so neither order
      //     closes a cycle.
      {
        const fixture = await f.channel("read-vs-start-thread-first");
        const reader = await observer.connect();
        try {
          await reader.query("BEGIN");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.thread.id]);
          const job = await settleWithin(
            startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id }),
            "start while a reader holds a thread",
          );
          assert.equal(job.phase, "online_move", "the start never waits on a reader's thread lock");
          await reader.query("SET LOCAL lock_timeout = '500ms'");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.channel.id]);
          await reader.query("COMMIT");
        } finally {
          await reader.query("ROLLBACK").catch(() => undefined);
          reader.release();
        }
      }
      {
        const fixture = await f.channel("read-vs-start-root-first");
        const reader = await observer.connect();
        let start: ReturnType<typeof startChannelToJointConversion> | undefined;
        try {
          await reader.query("BEGIN");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.channel.id]);
          start = startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
          void start.catch(() => {});
          await waitUntilAnyBlocked(observer, "the start behind a reader holding the root");
          await reader.query("SET LOCAL lock_timeout = '500ms'");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.thread.id]);
          await reader.query("COMMIT");
          assert.equal((await settleWithin(start, "start after the reader")).phase, "online_move");
        } finally {
          await reader.query("ROLLBACK").catch(() => undefined);
          reader.release();
          if (start) await settleWithin(start.catch(() => undefined), "start cleanup");
        }
      }

      // (g) Mark-read against the online cancel, both orders. The cancel takes
      //     its locks in the per-thread reader's order and the source last:
      //     a thread reader is never waiting on it. A whole-scope reader
      //     holding the root makes the cancel give up (busy, nothing changed)
      //     before the reader's next lock would wait, never the other way.
      {
        const fixture = await f.channel("read-vs-cancel-thread-first");
        const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
        const rows = (await observer.query<{ projectionId: string; jointId: string; canonicalId: string; parentId: string }>(`
          SELECT projection.local_channel_id::text AS "projectionId", joint_thread.id::text AS "jointId",
                 canonical_thread.id::text AS "canonicalId", canonical_thread.parent_message_id::text AS "parentId"
            FROM joint_channel_servers projection
            JOIN joint_channels joint_thread ON joint_thread.id = projection.joint_channel_id
            JOIN channels canonical_thread ON canonical_thread.id = joint_thread.canonical_channel_id
           WHERE projection.local_channel_id = $1`, [fixture.thread.id])).rows[0]!;
        const reader = await observer.connect();
        const readerPid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        let cancel: ReturnType<typeof cancelChannelConversionJob> | undefined;
        try {
          await reader.query("BEGIN");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.thread.id]);
          await reader.query("SELECT 1 FROM joint_channel_servers WHERE local_channel_id = $1 FOR KEY SHARE", [rows.projectionId]);
          await reader.query("SELECT 1 FROM joint_channels WHERE id = $1 FOR KEY SHARE", [rows.jointId]);
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [rows.canonicalId]);
          await reader.query("SELECT 1 FROM messages WHERE id = $1 FOR KEY SHARE", [rows.parentId]);
          cancel = cancelChannelConversionJob(job.id);
          void cancel.catch(() => {});
          await waitUntilBlockedBy(observer, readerPid, "the cancel behind a thread reader");
          await reader.query("SET LOCAL lock_timeout = '500ms'");
          // The parent level, then the parent channel: never held by the waiting cancel.
          await reader.query("SELECT 1 FROM joint_channels WHERE id = $1 FOR KEY SHARE", [job.jointChannelId]);
          await reader.query("SELECT 1 FROM joint_channel_servers WHERE local_channel_id = $1 FOR KEY SHARE", [fixture.channel.id]);
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.channel.id]);
          await reader.query("COMMIT");
          assert.equal((await settleWithin(cancel, "cancel after the reader")).status, "canceled");
        } finally {
          await reader.query("ROLLBACK").catch(() => undefined);
          reader.release();
          if (cancel) await settleWithin(cancel.catch(() => undefined), "cancel cleanup");
        }
      }
      {
        const fixture = await f.channel("read-vs-cancel-root-first");
        const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
        const [canonicalThread] = await getDb().select({ id: channels.id }).from(channels)
          .where(eq(channels.parentMessageId, fixture.parent.id));
        const reader = await observer.connect();
        try {
          await reader.query("BEGIN");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.channel.id]);
          const cancel = cancelChannelConversionJob(job.id);
          void cancel.catch(() => {});
          await waitUntilAnyBlocked(observer, "the cancel behind a reader holding the root");
          // The reader's thread statement (local thread, storage thread, parent
          // message): it waits for the cancel at most until the cancel gives up.
          await reader.query("SET LOCAL lock_timeout = '3s'");
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [fixture.thread.id]);
          await reader.query("SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", [canonicalThread!.id]);
          await reader.query("SELECT 1 FROM messages WHERE id = $1 FOR KEY SHARE", [fixture.parent.id]);
          await assert.rejects(settleWithin(cancel, "cancel"), (error: unknown) => error instanceof ChannelConversionBusyError,
            "the cancel, not the reader, gives up");
          await reader.query("COMMIT");
        } finally {
          await reader.query("ROLLBACK").catch(() => undefined);
          reader.release();
        }
        const [still] = await getDb().select({ phase: channelConversionJobs.phase }).from(channelConversionJobs).where(eq(channelConversionJobs.id, job.id));
        assert.equal(still!.phase, "online_move", "the cancel that gave up changed nothing");
        assert.equal((await cancelChannelConversionJob(job.id)).status, "canceled", "and a later cancel goes through");
      }

      // (h) A thread on a message sent during the move, started as a cancel
      //     commits: the creator read the parent in the canonical channel
      //     before the cancel moved it back. Under its locks it reads the
      //     parent again and starts over, making a plain thread on the host,
      //     not one on the storage server.
      {
        const fixture = await f.channel("thread-vs-cancel-moved-parent");
        const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: fixture.channel.id, createdByUserId: f.owner.id });
        const canonicalId = job.canonicalChannelId!;
        const moved = await createMessage(canonicalId, "user", f.owner.id, "sent during the move");
        const other = await createMessage(canonicalId, "user", f.owner.id, "also sent during the move");
        const holder = await observer.connect();
        let cancel: ReturnType<typeof cancelChannelConversionJob> | undefined;
        let creator: Promise<{ id: string; serverId: string }> | undefined;
        try {
          // Hold the cancel inside its transaction after it took the root FOR
          // UPDATE: it waits to move `other` back.
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM messages WHERE id = $1 FOR SHARE", [other.id]);
          cancel = cancelChannelConversionJob(job.id);
          void cancel.catch(() => {});
          await waitUntilBlockedCount(observer, 1, "the cancel holding the root");
          creator = getOrCreateThread(moved.id, f.owner.id, "user");
          void creator.catch(() => {});
          await waitUntilBlockedCount(observer, 2, "the thread creator behind the cancel");
          await holder.query("ROLLBACK");
          assert.equal((await settleWithin(cancel, "cancel")).status, "canceled");
          const thread = await settleWithin(creator, "thread creator");
          assert.equal(thread.serverId, f.server.id, "a plain thread on the host server");
          const [row] = await getDb().select().from(channels).where(eq(channels.id, thread.id));
          assert.equal(row!.serverId, f.server.id);
          assert.equal(row!.parentMessageId, moved.id);
          assert.equal(row!.parentChannelId, fixture.channel.id, "under the source, where the cancel moved its parent");
          assert.deepEqual(await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, thread.id)), []);
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          holder.release();
          if (cancel) await settleWithin(cancel.catch(() => undefined), "cancel cleanup");
          if (creator) await settleWithin(creator.catch(() => undefined), "creator cleanup");
        }
      }

      // (c) The route predicate is an index lookup (planner told to avoid a
      //     sequential scan: the table is tiny here). Both indexes that can
      //     serve it do: idx_channel_conversion_jobs_phase (phase =
      //     'online_move': only in-flight online moves hold that phase) and
      //     the partial unique idx_channel_conversion_jobs_active_source (one
      //     active job per source), shown with the first dropped in a
      //     rolled-back transaction.
      {
        const explain = async (dropPhaseIndex: boolean) => {
          let plan = "";
          await getDb().transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL enable_seqscan = off`);
            if (dropPhaseIndex) await tx.execute(sql`DROP INDEX idx_channel_conversion_jobs_phase`);
            const explained = await tx.execute(sql`EXPLAIN ${onlineMoveJobsSql(sql`ARRAY[${randomUUID()}::uuid]`)}`);
            plan = explained.rows.map((row) => String((row as Record<string, unknown>)["QUERY PLAN"])).join("\n");
            tx.rollback();
          }).catch((error: unknown) => {
            if (!(error instanceof Error && /rollback/i.test(error.message))) throw error;
          });
          return plan;
        };
        const plan = await explain(false);
        const activeSourcePlan = await explain(true);
        const explainSql = async (statement: ReturnType<typeof sql>) => {
          let text = "";
          await getDb().transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL enable_seqscan = off`);
            const explained = await tx.execute(sql`EXPLAIN ${statement}`);
            text = explained.rows.map((row) => String((row as Record<string, unknown>)["QUERY PLAN"])).join("\n");
          });
          return text;
        };
        // The pair lookup (source or canonical) and the canonical-id check
        // (lockJointTaskWriteAuthority) read the phase index too.
        const pairPlan = await explainSql(onlineMovePairSql(sql`${randomUUID()}::uuid`));
        const canonicalPlan = await explainSql(sql`SELECT ${isOnlineMoveCanonicalSql(sql`${randomUUID()}::uuid`)}`);
        console.log(`[online move pair EXPLAIN]\n${pairPlan}\n[online move canonical check EXPLAIN]\n${canonicalPlan}`);
        // The joint thread projection lookup (every thread send's route, every
        // joint thread read) with the online-move COALESCE in its parent-joint
        // join, for a joint thread outside any online move: the jobs probe is a
        // phase-index scan per row, which finds nothing.
        const projectionThread = await f.channel("projection-explain");
        await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: projectionThread.channel.id, createdByUserId: f.owner.id });
        const built = jointThreadProjectionRowsQuery({ localThreadChannelId: projectionThread.thread.id }).toSQL();
        const projectionPlan = (await observer.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${built.sql}`, built.params as unknown[]))
          .rows.map((row) => String((row as Record<string, unknown>)["QUERY PLAN"])).join("\n");
        console.log(`[joint thread projection lookup EXPLAIN ANALYZE, a thread in an online move]\n${projectionPlan}`);
        assert.match(projectionPlan, /idx_channel_conversion_jobs_phase/, "the online-move probe reads the phase index");
        for (const [label, text] of [["pair", pairPlan], ["canonical check", canonicalPlan]] as const) {
          assert.match(text, /idx_channel_conversion_jobs_phase/, `${label} reads the phase index`);
          assert.doesNotMatch(text, /Seq Scan/, `${label} never scans the table`);
        }
        console.log(`[online move route EXPLAIN]\n${plan}\n[without idx_channel_conversion_jobs_phase]\n${activeSourcePlan}`);
        assert.match(plan, /Index (Only )?Scan|Bitmap Index Scan/);
        assert.doesNotMatch(plan, /Seq Scan/);
        assert.match(activeSourcePlan, /idx_channel_conversion_jobs_active_source/);
        assert.doesNotMatch(activeSourcePlan, /Seq Scan/);
      }
    } finally {
      if (app) await app.close();
      if (observer) await observer.end();
      if (setupPool) await setupPool.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);

