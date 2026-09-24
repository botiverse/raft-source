import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import * as schema from "../db/schema.js";
import { sessionFamilies, sessions, users } from "../db/schema.js";
import { createSession, refreshSession, refreshSessionWithTrace } from "./sessionService.js";
import { retireStagingSelfAccount } from "./userService.js";

const URL_ENV = "STAGING_SELF_ACCOUNT_RETIREMENT_REAL_PG_URL";
const ADMIN_URL = process.env[URL_ENV];
const REQUIRED = process.env.STAGING_SELF_ACCOUNT_RETIREMENT_REAL_PG_REQUIRED === "1";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

function dbUrl(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl); parsed.pathname = `/${databaseName}`; return parsed.toString();
}
function ident(value: string): string { assert.match(value, /^[a-z0-9_]+$/); return `"${value}"`; }
async function waitForWaiters(observer: pg.Client, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let maximum = 0;
  while (Date.now() < deadline) {
    const result = await observer.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND (wait_event_type='Lock' OR wait_event IN ('transactionid','tuple'))`);
    const locks = await observer.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM pg_locks
      WHERE pid<>pg_backend_pid() AND NOT granted
        AND locktype IN ('transactionid','tuple')`);
    maximum = Math.max(maximum, result.rows[0]?.count ?? 0, locks.rows[0]?.count ?? 0);
    if (maximum >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${count} lock waiters (maximum observed ${maximum})`);
}

test("real PostgreSQL retirement wins queued session issuance and refresh at the user-row frontier", {
  skip: !(ADMIN_URL || REQUIRED),
}, async () => {
  assert.ok(ADMIN_URL);
  const name = `slock_retire_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  let setup: pg.Pool | null = null;
  let blocker: pg.Client | null = null;
  const priorBranch = process.env.SLOCK_RELEASE_BRANCH;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${ident(name)}`);
    const url = dbUrl(ADMIN_URL, name);
    setup = new pg.Pool({ connectionString: url, max: 2 });
    await migrate(drizzle(setup, { schema }), { migrationsFolder: MIGRATIONS });
    await setup.end(); setup = null;
    await initDatabase(url); process.env.SLOCK_RELEASE_BRANCH = "staging";
    const capability = "real-pg-retirement-capability";
    const [user] = await getDb().insert(users).values({
      email: `retire-${randomBytes(4).toString("hex")}@mail.build`, name: `retire_${randomBytes(4).toString("hex")}`,
      passwordHash: "test-only", emailVerified: true,
      stagingSelfAccountCapabilityHash: createHash("sha256").update(capability).digest("hex"),
    }).returning();
    const original = await createSession(user.id);
    const durableOriginal = await createSession(user.id);

    blocker = new pg.Client({ connectionString: url }); await blocker.connect();
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const retirement = retireStagingSelfAccount(user.id, user.id, capability);
    await waitForWaiters(blocker, 1);
    const issuanceRejected = assert.rejects(createSession(user.id), /USER_RETIRED/);
    const refresh = refreshSession(original.refreshToken);
    const durableRefresh = refreshSessionWithTrace(durableOriginal.refreshToken, { attemptId: "race-attempt", installationId: "race-install" });
    await waitForWaiters(blocker, 4);
    await blocker.query("COMMIT");

    const receipt = await retirement;
    assert.equal(receipt?.terminalState, "retired");
    await issuanceRejected;
    assert.equal(await refresh, null);
    assert.equal((await durableRefresh).refreshed, null);
    assert.equal((await getDb().select().from(sessions).where(eq(sessions.userId, user.id))).length, 0);
    const activeFamilies = await getDb().select().from(sessionFamilies)
      .where(eq(sessionFamilies.userId, user.id));
    assert.equal(activeFamilies.filter((family) => family.revokedAt === null).length, 0);
  } finally {
    if (priorBranch === undefined) delete process.env.SLOCK_RELEASE_BRANCH; else process.env.SLOCK_RELEASE_BRANCH = priorBranch;
    if (blocker) { try { await blocker.query("ROLLBACK"); } catch {} await blocker.end(); }
    await closeDatabase(); if (setup) await setup.end();
    await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`); await admin.end();
  }
});
