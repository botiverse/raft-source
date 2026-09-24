import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import * as schema from "../db/schema.js";
import { agents, channels, servers, users } from "../db/schema.js";
import { setLocalChannelArchivedByAgent } from "./channelService.js";

const REAL_PG_URL_ENV = "CHANNEL_LIFECYCLE_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_LIFECYCLE_REAL_PG_REQUIRED === "1";
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

test(
  "agent channel lifecycle admits exactly one real-PostgreSQL transition under concurrent retries",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task72_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "task72-channel-lifecycle-admin",
    });
    let setupPool: pg.Pool | undefined;
    let databaseInitialized = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "task72-channel-lifecycle-setup",
        max: 2,
      });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });

      await initDatabase(testUrl);
      databaseInitialized = true;
      const db = getDb();
      const [owner] = await db.insert(users).values({
        email: "task72-real-pg-owner@slock.test",
        name: "task72-real-pg-owner",
        displayName: "Task 72 Owner",
        passwordHash: "not-used-by-this-test",
        emailVerified: true,
      }).returning();
      const [server] = await db.insert(servers).values({
        name: "Task 72 Real PG",
        slug: `task72-real-pg-${randomBytes(4).toString("hex")}`,
        ownerId: owner.id,
      }).returning();
      const [agent] = await db.insert(agents).values({
        serverId: server.id,
        name: "task72-real-pg-agent",
      }).returning();
      const [channel] = await db.insert(channels).values({
        serverId: server.id,
        name: "task72-real-pg-channel",
        type: "channel",
      }).returning();

      const archiveResults = await Promise.all(Array.from(
        { length: 32 },
        () => setLocalChannelArchivedByAgent(channel.id, agent.id, true),
      ));
      assert.equal(
        archiveResults.filter((result) => result.changed).length,
        1,
        "exactly one concurrent archive retry owns the transition",
      );
      assert.ok(archiveResults.every((result) => result.channel.archivedAt instanceof Date));
      assert.ok(archiveResults.every((result) => result.channel.archivedByAgentId === agent.id));

      const unarchiveResults = await Promise.all(Array.from(
        { length: 32 },
        () => setLocalChannelArchivedByAgent(channel.id, agent.id, false),
      ));
      assert.equal(
        unarchiveResults.filter((result) => result.changed).length,
        1,
        "exactly one concurrent unarchive retry owns the transition",
      );
      assert.ok(unarchiveResults.every((result) => result.channel.archivedAt === null));
      assert.ok(unarchiveResults.every((result) => result.channel.archivedByAgentId === null));
    } finally {
      if (databaseInitialized) await closeDatabase();
      if (setupPool) await setupPool.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
