import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dbTest as test } from "../test/integration/dbTest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channels, jointChannels, jointChannelServers, messages, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { addHuman, createChannel, getOrCreateThread } from "./channelService";
import { createMessage } from "./messageService";
import {
  cancelChannelConversionJob,
  runChannelConversionJob,
  startChannelToJointConversion,
} from "./channelConversionService";
import { createServer as createServerService } from "./serverService";

// Conversion rollback hard-deletes the temporary joint rows and moves parent
// messages back to the source channel (channel_id is a key column), so it
// conflicts with the FOR KEY SHARE locks read-state resolution takes. Readers
// lock per thread in local-thread-id order: projection -> joint -> storage
// thread -> parent message, then the parent joint/projection. Rollback must
// take its conflicting locks in that same order, so while it waits it never
// holds a row that a waiting reader will ask for next (a deadlock cycle).

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const THREAD_COUNT = 4;

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

type ThreadRows = { localId: string; jointId: string; canonicalId: string; parentId: string };

// The rows a reader KEY SHAREs for one thread scope, in resolution order.
function readerLocksFor(rows: ThreadRows): Array<{ label: string; text: string; id: string }> {
  return [
    { label: "projection", text: "SELECT 1 FROM joint_channel_servers WHERE local_channel_id = $1 FOR KEY SHARE", id: rows.localId },
    { label: "joint", text: "SELECT 1 FROM joint_channels WHERE id = $1 FOR KEY SHARE", id: rows.jointId },
    { label: "storage thread", text: "SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE", id: rows.canonicalId },
    { label: "parent message", text: "SELECT 1 FROM messages WHERE id = $1 FOR KEY SHARE", id: rows.parentId },
  ];
}

async function waitUntilBlockedBy(observer: pg.Pool, blockerPid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1",
      [blockerPid],
    );
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("conversion rollback never waited on the reader's locks");
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "conversion rollback takes its locks in reader order, so a waiting rollback never blocks a reader's next lock",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_conversion_rollback_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "conversion-rollback-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let reader: pg.Client | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "conversion-rollback-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      // Scan order must follow the heap (rewritten below), not an index whose
      // HOT-updated entries still point at insertion order: only then does an
      // unordered rollback deterministically visit threads against key order.
      // Set before the app opens its pool; per-connection defaults.
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_indexscan = off`);
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_bitmapscan = off`);
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_indexonlyscan = off`);
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_mergejoin = off`);
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "conversion-rollback-observer", max: 1 });

      const db = getDb();
      const prefix = `conversion-rollback-${randomUUID().slice(0, 8)}`;
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
      const parents: string[] = [];
      for (let i = 0; i < THREAD_COUNT; i += 1) {
        const parent = await createMessage(channel.id, "user", owner.id, `parent ${i}`);
        const thread = await getOrCreateThread(parent.id, owner.id, "user");
        await createMessage(thread.id, "user", owner.id, `reply ${i}`);
        parents.push(parent.id);
      }

      const started = await startChannelToJointConversion({
        serverId: server.id,
        sourceChannelId: channel.id,
        createdByUserId: owner.id,
      });
      let job = started;
      while (job.phase !== "verify") {
        assert.notEqual(job.status, "failed", `conversion failed in ${job.phase}`);
        assert.notEqual(job.phase, "done", "conversion finished before the rollback window");
        job = await runChannelConversionJob(job.id, { maxPhases: 1 });
      }

      const mapping = await observer.query<ThreadRows>(`
        SELECT projection.local_channel_id::text AS "localId", joint_thread.id::text AS "jointId",
               canonical_thread.id::text AS "canonicalId", canonical_thread.parent_message_id::text AS "parentId"
          FROM joint_channel_servers projection
          JOIN joint_channels joint_thread ON joint_thread.id = projection.joint_channel_id
          JOIN channels canonical_thread ON canonical_thread.id = joint_thread.canonical_channel_id
         WHERE projection.server_id = $1 AND canonical_thread.type = 'thread'
         ORDER BY projection.local_channel_id
      `, [server.id]);
      const threads = mapping.rows;
      assert.equal(threads.length, THREAD_COUNT, "every thread is projected before verify");
      // 0317: the moved parents carry the joint_storage server_id.
      const movedServers = await observer.query<{ kind: string }>(`
        SELECT DISTINCT s.kind FROM messages m JOIN servers s ON s.id = m.server_id WHERE m.id = ANY($1::uuid[])
      `, [parents]);
      assert.deepEqual(movedServers.rows, [{ kind: "joint_storage" }], "moved parents carry the joint_storage server_id");

      // Heap order is arbitrary in production. Rewrite the rows in descending
      // key order so an unordered scan in the rollback visits the threads
      // against reader order, instead of passing by insertion accident.
      for (const row of [...threads].reverse()) {
        await observer.query("UPDATE joint_channel_servers SET status = status WHERE local_channel_id = $1", [row.localId]);
        await observer.query("UPDATE joint_channels SET status = status WHERE id = $1", [row.jointId]);
        await observer.query("UPDATE channels SET name = name WHERE id = $1", [row.canonicalId]);
        await observer.query("UPDATE messages SET content = content WHERE id = $1", [row.parentId]);
      }

      // A reader resolving every thread has locked only the first row of the
      // first thread (its projection) when the rollback arrives, and is about
      // to lock the rest of that thread and then every other thread in key
      // order. Covers both the order across threads and the order within one
      // thread (the table order of the rollback's FOR UPDATE OF list).
      const readerLocks = threads.flatMap((row) => readerLocksFor(row).map((lock) => ({ ...lock, thread: row.localId })));
      reader = new pg.Client({ connectionString: testUrl, application_name: "conversion-rollback-reader" });
      await reader.connect();
      const readerPid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await reader.query("BEGIN");
      await reader.query(readerLocks[0].text, [readerLocks[0].id]);

      const rollback = cancelChannelConversionJob(job.id);
      rollback.catch(() => {});
      await waitUntilBlockedBy(observer, readerPid);

      // Below deadlock_timeout: a wait here means the blocked rollback already
      // holds a row the reader needs, which is a deadlock cycle.
      await reader.query("SET LOCAL lock_timeout = '500ms'");
      for (const lock of readerLocks.slice(1)) {
        await assert.doesNotReject(
          reader.query(lock.text, [lock.id]),
          `a waiting rollback must not hold thread ${lock.thread}'s ${lock.label} ahead of reader order`,
        );
      }
      await reader.query("COMMIT");

      const canceled = await rollback;
      assert.equal(canceled.status, "canceled");
      const restoredParents = await db.select({ id: messages.id, channelId: messages.channelId, serverId: messages.serverId })
        .from(messages).where(inArray(messages.id, parents));
      assert.deepEqual(new Set(restoredParents.map((row) => row.channelId)), new Set([channel.id]), "parents return to the source");
      assert.deepEqual(new Set(restoredParents.map((row) => row.serverId)), new Set([server.id]), "parents' server_id returns to the origin server");
      // 0297's triggers follow the parents back through the rollback's own
      // transaction: the reattached local threads point at the source again.
      const localThreads = await db.select({ parentChannelId: channels.parentChannelId }).from(channels)
        .where(inArray(channels.id, threads.map((row) => row.localId)));
      assert.deepEqual(localThreads.map((row) => row.parentChannelId), threads.map(() => channel.id), "local threads' parent_channel_id follows the parents back");
      const leftovers = await db.select({ id: jointChannels.id }).from(jointChannels)
        .where(inArray(jointChannels.id, threads.map((row) => row.jointId)));
      assert.deepEqual(leftovers, [], "temporary thread joints are removed");
      const projections = await db.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
        .where(and(eq(jointChannelServers.serverId, server.id), inArray(jointChannelServers.localChannelId, threads.map((row) => row.localId))));
      assert.deepEqual(projections, [], "temporary thread projections are removed");
      const canonicalThreads = await db.select({ id: channels.id }).from(channels)
        .where(inArray(channels.id, threads.map((row) => row.canonicalId)));
      assert.deepEqual(canonicalThreads, [], "canonical thread copies are removed");
    } finally {
      if (reader) await reader.end().catch(() => {});
      if (app) await app.close();
      if (observer) await observer.end();
      if (setupPool) await setupPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => {});
      await admin.end();
    }
  },
  60_000,
);
