import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { test } from "vitest";

import { closeDatabase, getDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { agents, assistantDoorbells, assistantDoorbellSources, featureFlags, serverMembers, servers, thirdPartyAgentEvents, users } from "../db/schema";
import { PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "./featureFlagService";
import { drainAssistantDoorbells } from "./assistantService";

// The doorbell lock cycle of 10-26 02:35Z (#proj-o11y:058cb07b), on a real
// PostgreSQL: a producer transaction holds a source row and then inserts the
// doorbell row the drain is deleting, while the drain waits for that source.
// The drain must give up within its lock_timeout instead of deadlocking, so
// the producer (the user's request) commits and the doorbell stays queued.

const REAL_PG_URL_ENV = "ASSISTANT_DOORBELL_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.ASSISTANT_DOORBELL_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

async function waitForLockWait(observer: pg.Client, applicationName: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ waiting: boolean }>(`
      SELECT bool_or(wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1
    `, [applicationName]);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${applicationName} never waited on a row lock`);
}

async function replayLockCycle(path: "drop" | "claim"): Promise<void> {
  assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
  const databaseName = `slock_doorbell_${process.pid}_${randomBytes(4).toString("hex")}`;
  const serviceApplication = `doorbell-drain-service-${process.pid}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "doorbell-admin" });
  let producer: pg.Client | null = null;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrationPool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "doorbell-migrator"), max: 2 });
    await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    await migrationPool.end();
    await initDatabase(databaseUrlFor(REAL_PG_URL, databaseName, serviceApplication));

    const [owner] = await getDb().insert(users).values({
      email: `doorbell-real-pg-${randomUUID()}@test.invalid`,
      name: `DoorbellRealPg${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await getDb().insert(servers).values({
      name: "Doorbell Real PG",
      slug: `doorbell-real-pg-${randomUUID()}`,
      ownerId: owner.id,
    }).returning();
    // drop: the server has the assistant feature off, so resolveAssistantOwner
    // is null and the drain drops the doorbell (delete it, then its sources).
    // claim: the feature is on and the owner is a member, so the drain claims
    // it (the same delete order, then the event): production's 02:35Z path.
    // With an owner set, the orphan sweep that runs first leaves both alone.
    if (path === "claim") {
      await getDb().insert(featureFlags)
        .values({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled: true })
        .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled: true, killSwitch: false } });
      await getDb().insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
    }
    const [agent] = await getDb().insert(agents).values({
      serverId: server.id,
      name: "assistant-feature-off",
      assistantOwnerUserId: owner.id,
    }).returning();
    const sourceChannelId = randomUUID();
    await getDb().insert(assistantDoorbells).values({ agentId: agent.id, serverId: server.id, ownerUserId: owner.id });
    await getDb().insert(assistantDoorbellSources).values({ agentId: agent.id, sourceChannelId, maxSeq: 1 });

    // The producer, as recordAssistantDoorbells does twice in one transaction:
    // upsert a source (row lock held to commit) ...
    producer = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "doorbell-producer") });
    await producer.connect();
    await producer.query("BEGIN");
    await producer.query(
      `INSERT INTO assistant_doorbell_sources (agent_id, source_channel_id, max_seq, owner_action) VALUES ($1, $2, 2, false)
       ON CONFLICT (agent_id, source_channel_id) DO UPDATE SET max_seq = GREATEST(assistant_doorbell_sources.max_seq, EXCLUDED.max_seq)`,
      [agent.id, sourceChannelId],
    );

    // ... the drain deletes the doorbell and waits for that source ...
    const started = Date.now();
    const drain = drainAssistantDoorbells({ deliverer: { deliverMessage: async () => {} } as never });
    await waitForLockWait(producer, serviceApplication);

    // ... and the producer's second ring inserts the doorbell the drain holds.
    // Without the drain's lock_timeout this is a deadlock (40P01) after 1 s.
    await producer.query(
      `INSERT INTO assistant_doorbells (agent_id, server_id, owner_user_id) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO NOTHING`,
      [agent.id, server.id, owner.id],
    );
    await producer.query("COMMIT");
    assert.equal(await drain, 0, "the drain gave up without throwing");
    assert.ok(Date.now() - started < 1_000, "the drain timed out before deadlock_timeout");

    const [queued] = await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, agent.id));
    assert.ok(queued, "the doorbell stays queued for the next poll");
    const [source] = await getDb().select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, agent.id));
    assert.equal(source?.maxSeq, 2, "the producer's ring committed");

    assert.equal((await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, agent.id))).length, 0, "no event from the rolled-back claim");

    // Nothing holds a lock now: the next poll drops or sends it as before.
    assert.equal(await drainAssistantDoorbells({ deliverer: { deliverMessage: async () => {} } as never }), path === "claim" ? 1 : 0);
    assert.equal((await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, agent.id))).length, 0);
    assert.equal((await getDb().select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, agent.id))).length, 0);
  } finally {
    if (producer) await producer.end().catch(() => {});
    await closeDatabase().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

const REAL_PG = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 60_000 };

test("real PostgreSQL: the doorbell drop gives up its lock instead of deadlocking a producer that rings twice", REAL_PG, () => replayLockCycle("drop"));
test("real PostgreSQL: the doorbell claim gives up its lock instead of deadlocking a producer that rings twice", REAL_PG, () => replayLockCycle("claim"));
