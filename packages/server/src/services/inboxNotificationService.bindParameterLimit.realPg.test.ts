/**
 * PostgreSQL binds at most 65,535 parameters per statement (the Bind message carries an Int16
 * count). A multi-row VALUES binds rows × columns, so recording one send's inbox facts and
 * for a large channel used to exceed it: 11 bind parameters per fact row (≈5,957
 * receivers). Past the limit node-postgres wraps the count and the
 * server rejects the statement with 08P01, which rolls back the message transaction.
 *
 * Opt-in real-PG gate following the repo's realPg pattern: set BIND_PARAMETER_LIMIT_REAL_PG_URL
 * (and _REQUIRED=1 in CI so a missing URL fails rather than skips).
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { chunkForBindParameters, insertParametersPerRow, PG_MAX_BIND_PARAMETERS } from "../db/bindParameterBudget";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { channels, inboxNotificationFacts, messages, notificationOutbox, servers, users } from "../db/schema";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import { recordInboxNotificationFacts, type InboxNotificationFactInput } from "./inboxNotificationService";
import {
  __resetNotificationDispatchRuntimeForTests,
  __setAfterNotificationClaimForTests,
  __setNotificationDispatchRuntimeForTests,
} from "./notifications/dispatcher";

const REAL_PG_URL_ENV = "BIND_PARAMETER_LIMIT_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.BIND_PARAMETER_LIMIT_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const RECEIVERS = 6_000;

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
  "real PG: one send to a 6,000-receiver channel records every fact inside one transaction",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 180_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_bind_limit_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "bind-limit-admin" });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationPool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName), max: 2 });
      await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();
      await initDatabase(databaseUrlFor(REAL_PG_URL, databaseName));
      const db = getDb();

      const suffix = randomUUID();
      const [owner] = await db.insert(users).values({
        email: `bind-limit-${suffix}@raft.test`, name: `bind-limit-${suffix}`, passwordHash: "x", emailVerified: true,
      }).returning();
      const [server] = await db.insert(servers).values({
        name: "Bind limit", slug: `bind-limit-${suffix}`, ownerId: owner.id,
      }).returning();
      const [channel] = await db.insert(channels).values({
        serverId: server.id, name: `bind-limit-${suffix}`, type: "channel",
      }).returning();
      const [message] = await db.insert(messages).values({
        channelId: channel.id, senderType: "user", senderId: owner.id, content: "to everyone", seq: 1,
      }).returning();

      // Real users: the mobile push outbox references users(id).
      const receiverIds: string[] = [];
      const userRows = Array.from({ length: RECEIVERS }, (_, index) => ({
        email: `bind-limit-${suffix}-${index}@raft.test`, name: `bl-${suffix.slice(0, 8)}-${index}`, passwordHash: "x", emailVerified: true,
      }));
      for (const chunk of chunkForBindParameters(userRows, insertParametersPerRow(users))) {
        receiverIds.push(...(await db.insert(users).values(chunk).returning({ id: users.id })).map((row) => row.id));
      }

      const activityAt = new Date();
      const facts: InboxNotificationFactInput[] = receiverIds.map((receiverId) => ({
        receiverType: "user",
        receiverId,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: message.id,
        messageSeq: message.seq,
        activityAt,
      }));
      // Precondition: an unchunked facts statement would be past the limit.
      assert.ok(RECEIVERS * 11 > PG_MAX_BIND_PARAMETERS);

      // The post-commit drain is captured, not run in the background.
      const scheduled: Array<() => Promise<void>> = [];
      __setNotificationDispatchRuntimeForTests({ schedule: (work) => { scheduled.push(work); } });

      const recorded = await db.transaction((tx) => recordInboxNotificationFacts(facts, tx));

      assert.equal(recorded, RECEIVERS);
      const [factCount] = await db.select({ n: sql<number>`count(*)::int` }).from(inboxNotificationFacts);
      assert.equal(factCount.n, RECEIVERS);

      // The same transaction wrote one notification row per receiver (chunked
      // like the facts), and one post-commit drain covers all of them.
      const outboxRows = await db
        .select({ id: notificationOutbox.id, eventKey: notificationOutbox.eventKey, status: notificationOutbox.status })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.messageId, message.id));
      assert.equal(outboxRows.length, RECEIVERS);
      assert.ok(outboxRows.every((row) => row.eventKey === `message:${message.id}` && row.status === "pending"));
      assert.equal(scheduled.length, 1, "one post-commit drain for the whole send");
      const claimedIds: string[] = [];
      __setAfterNotificationClaimForTests((rows) => { claimedIds.push(...rows.map((row) => row.id)); });
      await scheduled[0]!();
      assert.deepEqual(claimedIds.sort(), outboxRows.map((row) => row.id).sort(), "the drain claimed exactly the inserted rows");
      const [stillPending] = await db.select({ n: sql<number>`count(*)::int` }).from(notificationOutbox)
        .where(sql`${notificationOutbox.status} IN ('pending', 'processing')`);
      assert.equal(stillPending.n, 0, "every claimed row was settled");
    } finally {
      __setAfterNotificationClaimForTests(null);
      __resetNotificationDispatchRuntimeForTests();
      await closeDatabase().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  },
);

