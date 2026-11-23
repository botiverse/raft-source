import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dbTest as test } from "../test/integration/dbTest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channels, jointChannels, jointChannelServers, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { addHuman, createChannel, lockAndResolveMessageStorage } from "./channelService";
import { startChannelToJointConversion } from "./channelConversionService";
import { createServer as createServerService } from "./serverService";

// The pairing that keeps a message writer from inserting into a route a
// conversion has just changed (lockAndResolveMessageStorage): the writer locks
// the local channel row FOR KEY SHARE and resolves storage under it; a route
// change locks the same row FOR UPDATE first. FOR KEY SHARE conflicts only
// with FOR UPDATE, so each side waits for the other, in either order.
//
// These cases fail if either side is weakened:
//  - the helper without its lock: (a) the FOR UPDATE and the conversion start
//    no longer wait for the writer, and (b) the writer no longer waits for the
//    route change and reads the old route;
//  - the route change taking less than FOR UPDATE (FOR NO KEY UPDATE, FOR
//    SHARE): (a2) pins the real conversion start, which must wait on the
//    writer, and (b)'s writer would not wait and would read the old route.
// PGlite serializes transactions, so only a real multi-connection Postgres
// can interleave them.

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

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
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

/** Waits until backend `pid` is blocked on a lock; throws if it never is. */
async function waitUntilBlocked(observer: pg.Pool, pid: number, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid]);
    if ((result.rows[0] as { blocked?: boolean } | undefined)?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} never waited on a lock`);
}

/** Waits until any backend other than the observer is blocked on a lock. */
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

function sqlState(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function seedFixture(prefix: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${prefix}-owner@slock.test`,
    name: `${prefix}-owner`,
    displayName: `${prefix}-owner`,
    passwordHash: "not-used-by-this-test",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServerService(`${prefix} host`, `${prefix}-host`, owner!.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = async (name: string) => {
    const created = await createChannel(server.id, `${prefix}-${name}`, "route lock", "channel");
    await addHuman(created.id, owner!.id);
    return created;
  };
  return { owner: owner!, server, channel };
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "real PostgreSQL: a writer's storage resolution and a route change's FOR UPDATE wait on each other, in either order",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_route_lock_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "route-lock-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "route-lock-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "route-lock-observer", max: 1 });

      const prefix = `route-lock-${randomUUID().slice(0, 8)}`;
      const f = await seedFixture(prefix);

      // (a) Writer first: while a writer's transaction holds the helper's
      //     lock, a FOR UPDATE on the row cannot be had; once it commits, it can.
      {
        const source = await f.channel("writer-first");
        const writerResolved = gate();
        const releaseWriter = gate();
        const writer = getDb().transaction(async (tx) => {
          const storage = await lockAndResolveMessageStorage(tx, source.id);
          writerResolved.open();
          await releaseWriter.opened;
          return storage;
        });
        void writer.catch(() => {});
        let conversion: ReturnType<typeof startChannelToJointConversion> | undefined;
        try {
          await settleWithin(writerResolved.opened, "writer resolving its storage");

          // (a1) A route changer's FOR UPDATE is refused while the writer holds
          //      the row (lock_timeout instead of blocking the harness).
          await assert.rejects(
            getDb().transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
              await tx.execute(sql`SELECT id FROM channels WHERE id = ${source.id} FOR UPDATE`);
            }),
            (error: unknown) => sqlState(error) === "55P03",
            "FOR UPDATE must not be granted while the writer holds FOR KEY SHARE",
          );

          // (a2) The real conversion start ("source_lock": FOR UPDATE) waits
          //      for the writer too.
          let conversionSettled = false;
          conversion = startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: source.id, createdByUserId: f.owner.id });
          void conversion.then(() => { conversionSettled = true; }, () => { conversionSettled = true; });
          await waitUntilAnyBlocked(observer, "the conversion start");
          assert.equal(conversionSettled, false, "the conversion start must wait for the writer's transaction");

          releaseWriter.open();
          assert.equal(await settleWithin(writer, "writer"), source.id);
          assert.equal((await settleWithin(conversion, "conversion start after the writer committed")).status, "pending");

          // After the writer committed, FOR UPDATE is granted at once.
          await getDb().transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
            await tx.execute(sql`SELECT id FROM channels WHERE id = ${source.id} FOR UPDATE`);
          });
        } finally {
          releaseWriter.open();
          await settleWithin(writer.catch(() => undefined), "writer cleanup");
          if (conversion) await settleWithin(conversion.catch(() => undefined), "conversion cleanup");
        }
      }

      // (b) Route change first: a transaction holding the row FOR UPDATE makes
      //     the channel a joint projection of another channel (the smallest
      //     change the resolver reads: the row's type and its active
      //     projection). A writer resolving meanwhile waits, and then stores
      //     in the new route, never the old one.
      {
        const source = await f.channel("changer-first");
        const canonical = await f.channel("canonical");
        const routeChanged = gate();
        const commitChange = gate();
        const changer = getDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM channels WHERE id = ${source.id} FOR UPDATE`);
          const [joint] = await tx.insert(jointChannels).values({
            canonicalChannelId: canonical.id, createdByServerId: f.server.id, createdByUserId: f.owner.id,
          }).returning();
          await tx.insert(jointChannelServers).values({
            jointChannelId: joint!.id, serverId: f.server.id, localChannelId: source.id,
            role: "host", status: "active", joinedByUserId: f.owner.id,
          });
          await tx.update(channels).set({ type: "joint" }).where(eq(channels.id, source.id));
          routeChanged.open();
          await commitChange.opened;
        });
        void changer.catch(() => {});
        let writer: Promise<string> | undefined;
        try {
          await settleWithin(routeChanged.opened, "route change before commit");
          const writerPid = gate();
          let pid = 0;
          let writerSettled = false;
          writer = getDb().transaction(async (tx) => {
            const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
            pid = Number((result.rows[0] as { pid?: unknown }).pid);
            writerPid.open();
            return lockAndResolveMessageStorage(tx, source.id);
          });
          void writer.then(() => { writerSettled = true; }, () => { writerSettled = true; });
          await settleWithin(writerPid.opened, "writer starting");
          await waitUntilBlocked(observer, pid, "the writer's storage resolution");
          assert.equal(writerSettled, false, "the writer must wait for the route change to commit");

          commitChange.open();
          await settleWithin(changer, "route change");
          assert.equal(await settleWithin(writer, "writer after the route change"), canonical.id,
            "the writer must store in the route committed before it resolved");
        } finally {
          commitChange.open();
          await settleWithin(changer.catch(() => undefined), "route change cleanup");
          if (writer) await settleWithin(writer.catch(() => undefined), "writer cleanup");
        }
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
