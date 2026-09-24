// Real PostgreSQL concurrency proof for the 0245 production deadlock repair.
// Set MIGRATION_PHASES_REAL_PG_URL to an isolated PostgreSQL 16 database. The
// test deliberately reproduces the old users -> server_members DDL order
// against the online server_members -> users read order, then repeats the same
// schedule with a commit boundary before 0245.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  runMigrationPhases,
} from "./migrationPhases.js";

const LOCK_RELEASE_BOUNDARY_TAG = "0244_ancient_ares";
const LOCK_SENSITIVE_MIGRATION_TAG = "0245_complete_sharon_ventura";
const DATABASE_URL = process.env.MIGRATION_PHASES_REAL_PG_URL;
const REQUIRED = process.env.MIGRATION_PHASES_REAL_PG_REQUIRED === "1";

async function waitForLockWait(observer: pg.Client, marker: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await observer.query(
      `SELECT count(*)::int AS waiting
         FROM pg_stat_activity
        WHERE query LIKE $1
          AND wait_event_type = 'Lock'`,
      [`%${marker}%`],
    );
    if (result.rows[0]?.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`did not observe PostgreSQL lock wait for ${marker}`);
}

async function finish(client: pg.Client): Promise<void> {
  await client.query("ROLLBACK").catch(() => {});
  await client.end().catch(() => {});
}

test("0245 phased DDL removes the users/server_members deadlock cycle", async (t) => {
  if (!DATABASE_URL) {
    if (REQUIRED) throw new Error("MIGRATION_PHASES_REAL_PG_REQUIRED=1 but MIGRATION_PHASES_REAL_PG_URL is missing");
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  const suffix = `${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
  const users = `phase_users_${suffix}`;
  const members = `phase_server_members_${suffix}`;
  const q = (name: string) => `"${name}"`;
  const open = async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query("SET deadlock_timeout = '100ms'");
    await client.query("SET lock_timeout = '5000ms'");
    return client;
  };

  await admin.query(`CREATE TABLE ${q(users)} (id integer PRIMARY KEY)`);
  await admin.query(`CREATE TABLE ${q(members)} (id integer PRIMARY KEY, user_id integer)`);
  t.onTestFinished(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${q(members)}, ${q(users)}`).catch(() => {});
    await admin.end().catch(() => {});
  });

  // Old all-in-one transaction: online request holds server_members, then asks
  // for users; migration holds users, then asks for server_members. PostgreSQL
  // must break this cycle with SQLSTATE 40P01.
  const oldReader = await open();
  const oldMigration = await open();
  try {
    await oldReader.query("BEGIN");
    await oldReader.query(`SELECT id FROM ${q(members)} /* old_reader_members */`);
    await oldMigration.query("BEGIN");
    await oldMigration.query(`ALTER TABLE ${q(users)} ADD COLUMN old_probe integer /* old_migration_users */`);
    const oldMembers = oldMigration.query(
      `ALTER TABLE ${q(members)} ADD COLUMN old_probe integer /* old_migration_members */`,
    );
    await waitForLockWait(admin, "old_migration_members");
    const oldUsers = oldReader.query(`SELECT id FROM ${q(users)} /* old_reader_users */`);
    const outcomes = await Promise.allSettled([oldMembers, oldUsers]);
    const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.ok(errors.some(({ reason }) => reason?.code === "40P01"), "old lock order must reproduce 40P01");
  } finally {
    await finish(oldReader);
    await finish(oldMigration);
  }

  // Phased transaction: users DDL commits before 0245 starts. The same reader
  // can therefore acquire users while 0245 waits for its server_members lock;
  // after the reader commits, 0245 completes without a deadlock.
  const phasedReader = await open();
  const phaseOne = await open();
  const phaseTwo = await open();
  try {
    await phasedReader.query("BEGIN");
    await phasedReader.query(`SELECT id FROM ${q(members)} /* phased_reader_members */`);
    await phaseOne.query("BEGIN");
    await phaseOne.query(`ALTER TABLE ${q(users)} ADD COLUMN phased_probe integer /* phased_users */`);
    await phaseOne.query("COMMIT");
    await phaseTwo.query("BEGIN");
    const phaseTwoMembers = phaseTwo.query(
      `ALTER TABLE ${q(members)} ADD COLUMN phased_probe integer /* phased_members */`,
    );
    await waitForLockWait(admin, "phased_members");
    await phasedReader.query(`SELECT id FROM ${q(users)} /* phased_reader_users */`);
    await phasedReader.query("COMMIT");
    const phasedResult = await Promise.race([
      phaseTwoMembers.then(() => "completed" as const),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("phased DDL did not complete")), 5_000)),
    ]);
    assert.equal(phasedResult, "completed");
    await phaseTwo.query("COMMIT");
  } finally {
    await finish(phasedReader);
    await finish(phaseOne);
    await finish(phaseTwo);
  }
});


function writeCanonicalPhaseFixture(users: string, members: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migration-phase-canonical-"));
  mkdirSync(path.join(folder, "meta"));
  const entries = [
    { idx: 0, version: "7", when: 243, tag: "0243_fixture_users", breakpoints: true },
    { idx: 1, version: "7", when: 244, tag: LOCK_RELEASE_BOUNDARY_TAG, breakpoints: true },
    { idx: 2, version: "7", when: 245, tag: LOCK_SENSITIVE_MIGRATION_TAG, breakpoints: true },
  ];
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  writeFileSync(
    path.join(folder, "0243_fixture_users.sql"),
    `ALTER TABLE "${users}" ADD COLUMN phase_runner_users integer /* phase_runner_users */;`,
  );
  writeFileSync(path.join(folder, `${LOCK_RELEASE_BOUNDARY_TAG}.sql`), "SELECT 1;");
  writeFileSync(
    path.join(folder, `${LOCK_SENSITIVE_MIGRATION_TAG}.sql`),
    `ALTER TABLE "${members}" ADD COLUMN phase_runner_members integer /* phase_runner_members */;`,
  );
  return folder;
}

test("canonical Drizzle phase runner commits before 0245 and preserves journal order", async (t) => {
  if (!DATABASE_URL) {
    if (REQUIRED) throw new Error("MIGRATION_PHASES_REAL_PG_REQUIRED=1 but MIGRATION_PHASES_REAL_PG_URL is missing");
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  const suffix = `${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
  const users = `canonical_phase_users_${suffix}`;
  const members = `canonical_phase_members_${suffix}`;
  const migrationSchema = `canonical_phase_drizzle_${suffix}`;
  const quote = (name: string) => `"${name}"`;
  const folder = writeCanonicalPhaseFixture(users, members);
  const reader = new pg.Client({ connectionString: DATABASE_URL });
  const migration = new pg.Client({ connectionString: DATABASE_URL });
  await admin.query(`CREATE TABLE ${quote(users)} (id integer PRIMARY KEY)`);
  await admin.query(`CREATE TABLE ${quote(members)} (id integer PRIMARY KEY, user_id integer)`);
  await reader.connect();
  await migration.connect();
  await reader.query("SET lock_timeout = '5000ms'");
  await migration.query("SET lock_timeout = '5000ms'");
  t.onTestFinished(async () => {
    await finish(reader);
    await finish(migration);
    await admin.query(`DROP TABLE IF EXISTS ${quote(members)}, ${quote(users)}`).catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(migrationSchema)} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  });

  await reader.query("BEGIN");
  await reader.query(`SELECT id FROM ${quote(members)} /* canonical_reader_members */`);
  const db = drizzle(migration);
  const apply = runMigrationPhases(
    folder,
    [LOCK_RELEASE_BOUNDARY_TAG, LOCK_SENSITIVE_MIGRATION_TAG],
    async (phase, phaseFolder) => {
      if (!phase.tags.includes(LOCK_SENSITIVE_MIGRATION_TAG)) {
        await migrate(db, { migrationsFolder: phaseFolder, migrationsSchema: migrationSchema });
        return;
      }
      const phaseApply = migrate(db, { migrationsFolder: phaseFolder, migrationsSchema: migrationSchema });
      await waitForLockWait(admin, "phase_runner_members");
      await reader.query(`SELECT id FROM ${quote(users)} /* canonical_reader_users */`);
      await reader.query("COMMIT");
      await phaseApply;
    },
  );
  await apply;

  const journal = await admin.query(
    `SELECT count(*)::int AS count FROM ${quote(migrationSchema)}."__drizzle_migrations"`,
  );
  assert.equal(journal.rows[0]?.count, 3, "each canonical phase must record one journal row");
  const columns = await admin.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = $1 AND column_name = 'phase_runner_members'`,
    [members],
  );
  assert.equal(columns.rowCount, 1, "0245 must commit after the reader releases server_members");
});
