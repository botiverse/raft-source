import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../../db/index.js";
import * as schema from "../../db/schema.js";
import { agents, servers, users } from "../../db/schema.js";
import type { Recurrence } from "../../services/recurrence.js";
import type { TimeProvider } from "./service.js";
import {
  ackAuthorizedReminderFire,
  createReminder,
  fireReminder,
} from "./service.js";

const REAL_PG_URL_ENV = "REMINDER_ACK_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.REMINDER_ACK_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const FIXED_CLOCK: TimeProvider = { now: () => FIXED_NOW };
const EVERY_15_MIN: Recurrence = {
  version: 1,
  rule: { kind: "interval", seconds: 900 },
};

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

async function waitForLockWaiter(observer: pg.Client, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if ((result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("competing fire did not reach a PostgreSQL row-lock wait");
}

function requireNonNull<T>(value: T, message: string): NonNullable<T> {
  assert.ok(value != null, message);
  return value as NonNullable<T>;
}

async function seedFiredRecurringReminder() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);

  const [user] = await db.insert(users).values({
    email: `reminder-ack-owner-${suffix}@slock.test`,
    name: `reminder-ack-owner-${suffix}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    name: `Reminder ACK Real PG ${suffix}`,
    slug: `reminder-ack-real-pg-${suffix}`,
    ownerId: user.id,
  }).returning();

  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `reminder-ack-agent-${suffix}`,
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();

  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "ack authority recurring",
    fireAt: new Date("2026-04-20T11:45:00.000Z"),
    payload: null,
    recurrence: EVERY_15_MIN,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const firstFire = await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK });
  assert.equal(firstFire.ok, true);
  return { server, agent, reminder, firstFire };
}

test(
  "real PostgreSQL reminder exact ACK locks the reminder row before reading fired events",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_rem_ack_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "reminder-ack-real-pg-admin" });
    let setupPool: pg.Pool | null = null;
    let observer: pg.Client | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "reminder-ack-real-pg-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = null;

      await initDatabase(testUrl);
      observer = new pg.Client({ connectionString: testUrl, application_name: "reminder-ack-real-pg-observer" });
      await observer.connect();
      const observerClient = observer;
      const { server, agent, reminder, firstFire } = await seedFiredRecurringReminder();
      assert.equal(firstFire.ok, true);
      const firstFireRow = firstFire.row;
      assert.equal(firstFireRow.version, reminder.version + 1);

      const competingFire: { current?: ReturnType<typeof fireReminder> } = {};
      const ack = await ackAuthorizedReminderFire({
        serverId: server.id,
        actingAgentId: agent.id,
        reminderId: reminder.id,
        sourceVersion: reminder.version,
        ackAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        opts: {
          beforeAckFiredEventsReadForTesting: async () => {
            competingFire.current = fireReminder(
              reminder.id,
              firstFireRow.version,
              { clock: { now: () => firstFireRow.fireAt } },
            );
            await waitForLockWaiter(observerClient);
          },
        },
      });

      assert.equal(ack.ok, true);
      assert.equal(ack.ok && ack.replayed, false);
      const fired = await requireNonNull(competingFire.current, "the competing fire must have been started");
      assert.equal(fired.ok, true);
      assert.equal(fired.ok && fired.row.version, firstFireRow.version + 1);
    } finally {
      await observer?.end().catch(() => {});
      await closeDatabase().catch(() => {});
      await setupPool?.end().catch(() => {});
      await admin
        .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [
          databaseName,
        ])
        .catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
);
