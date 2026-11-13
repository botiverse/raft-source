// Real PostgreSQL 17 proof for the per-migration transaction timeout in
// scripts/migrate-deploy.ts (#botiverse-raft-deployment:3e5ec8cc). PGlite does
// not enforce transaction_timeout, so this needs a real server.
//
// It drives the full `db:migrate:deploy` command against a throwaway database:
//   1. a migration that outlives its declared limit is killed, the run fails
//      with `[MIGRATION_FAILED] reason=transaction_timeout`, and the migration
//      before it stays applied;
//   2. after the limit is raised, a rerun applies only the killed migration;
//   3. every applied migration logs a `[MIGRATION_FILE]` timing line.
// It also pins the PostgreSQL behaviour the runner relies on: a SET LOCAL
// inside a running transaction does not change that transaction's limit.
//
// Same gate as migrateDeploy.realPg.test.ts:
//   MIGRATE_DEPLOY_REAL_PG_URL      admin DSN of a disposable PostgreSQL 17
//   MIGRATE_DEPLOY_REAL_PG_REQUIRED "1" in Hosted: a missing URL fails, no skip
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { MIGRATION_TRANSACTION_TIMEOUT_FROM } from "./migrationPhases";

const ADMIN_URL = process.env.MIGRATE_DEPLOY_REAL_PG_URL;
const REQUIRED = process.env.MIGRATE_DEPLOY_REAL_PG_REQUIRED === "1";
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const tag = (offset: number, name: string) =>
  `${String(MIGRATION_TRANSACTION_TIMEOUT_FROM + offset).padStart(4, "0")}_${name}`;
const FIRST = tag(0, "tt_first");
const SLOW = tag(1, "tt_slow");

function writeMigrations(folder: string, slowLimit: string): void {
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1700000000000, tag: FIRST, breakpoints: true },
        { idx: 1, version: "7", when: 1700000000001, tag: SLOW, breakpoints: true },
      ],
    }),
  );
  // Counts its own runs: a rerun of an applied migration would leave 2 rows.
  writeFileSync(
    path.join(folder, `${FIRST}.sql`),
    "CREATE TABLE tt_runs (tag text NOT NULL);--> statement-breakpoint\nINSERT INTO tt_runs VALUES ('first');",
  );
  writeFileSync(
    path.join(folder, `${SLOW}.sql`),
    `-- migration: transaction_timeout=${slowLimit}\nSELECT pg_sleep(1.5);--> statement-breakpoint\nINSERT INTO tt_runs VALUES ('slow');`,
  );
}

function deploy(databaseUrl: string, folder: string) {
  const child = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MIGRATIONS_FOLDER: folder,
      SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
      SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "true",
      SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
      SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907",
      SERVER_MIGRATION_ADVISORY_LOCK_KEY: "611",
    },
    timeout: 180_000,
  });
  return { status: child.status, output: `${child.stdout ?? ""}\n${child.stderr ?? ""}` };
}

test("a migration over its transaction_timeout fails alone and reruns from the start", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) throw new Error("MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing");
    t.skip();
    return;
  }
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const version = Number((await admin.query("SHOW server_version_num")).rows[0]?.server_version_num ?? 0);
  if (version < 170000) {
    await admin.end();
    throw new Error(`transaction_timeout needs PostgreSQL 17; this server is ${version}`);
  }
  const dbName = `migration_tt_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const target = new URL(ADMIN_URL);
  target.pathname = `/${dbName}`;
  target.searchParams.set("options", "-c statement_timeout=60000");
  const folder = mkdtempSync(path.join(tmpdir(), "migration-tt-"));

  writeMigrations(folder, "500ms");
  const first = deploy(target.toString(), folder);
  assert.notEqual(first.status, 0, `an over-limit migration must fail the deploy:\n${first.output}`);
  assert.match(
    first.output,
    new RegExp(`\\[MIGRATION_FAILED\\] reason=transaction_timeout migration=${SLOW} limit_ms=500 source=declared`),
    first.output,
  );
  assert.match(first.output, new RegExp(`\\[MIGRATION_FILE\\] migration=${FIRST} .* transaction_timeout_ms=30000 source=default`), first.output);

  const db = new pg.Client({ connectionString: target.toString() });
  await db.connect();
  try {
    const applied = await db.query('SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"');
    assert.equal(applied.rows[0].n, 1, "only the migration before the killed one is journaled");
    assert.deepEqual((await db.query("SELECT tag FROM tt_runs")).rows.map((r) => r.tag), ["first"]);
  } finally {
    await db.end();
  }

  writeMigrations(folder, "10s");
  const second = deploy(target.toString(), folder);
  assert.equal(second.status, 0, `the rerun must apply the raised migration:\n${second.output}`);
  assert.match(second.output, new RegExp(`\\[MIGRATION_FILE\\] migration=${SLOW} .* transaction_timeout_ms=10000 source=declared`), second.output);
  assert.doesNotMatch(second.output, new RegExp(`\\[MIGRATION_FILE\\] migration=${FIRST} `), "the applied migration must not run again");

  const after = new pg.Client({ connectionString: target.toString() });
  await after.connect();
  try {
    assert.deepEqual((await after.query("SELECT tag FROM tt_runs ORDER BY tag")).rows.map((r) => r.tag), ["first", "slow"]);
  } finally {
    await after.end();
  }
});

test("PostgreSQL fixes transaction_timeout at BEGIN; SET LOCAL inside does not raise it", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) throw new Error("MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing");
    t.skip();
    return;
  }
  const client = new pg.Client({ connectionString: ADMIN_URL });
  client.on("error", () => {});
  await client.connect();
  await client.query("SELECT set_config('transaction_timeout', '300ms', false)");
  await client.query("BEGIN");
  await client.query("SET LOCAL transaction_timeout = '10s'");
  await assert.rejects(client.query("SELECT pg_sleep(1)"), (error: { code?: string }) => {
    assert.equal(error.code, "25P04");
    return true;
  });
  await client.end().catch(() => {});
});
