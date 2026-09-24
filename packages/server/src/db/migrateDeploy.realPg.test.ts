// End-to-end non-TTY failure tooth for the deploy migration path (review
// requirement on #5713): the FULL `pnpm --filter @botiverse/raft-server
// db:migrate:deploy` invocation — preflight included, stdio piped exactly like
// ECS/CloudWatch (no TTY) — must print the structured [MIGRATION_FAILED] line
// with the real SQLSTATE, failing tag, server message and statement sentinel
// on the FIRST run. Deleting the catch/formatter in migrateDeploy.ts turns
// this RED (the child would exit 1 with no SQLSTATE anywhere in its output,
// which is precisely the disproven drizzle-kit/hanji behavior).
//
// Own gate (B1 precedent: never borrow another seam's semantics):
//   MIGRATE_DEPLOY_REAL_PG_URL      admin DSN of a disposable PostgreSQL
//   MIGRATE_DEPLOY_REAL_PG_REQUIRED "1" in Hosted — missing URL then FAILS, no skip
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import pg from "pg";

const ADMIN_URL = process.env.MIGRATE_DEPLOY_REAL_PG_URL;
const REQUIRED = process.env.MIGRATE_DEPLOY_REAL_PG_REQUIRED === "1";

const SENTINEL = "deploy_e2e_sqlstate_sentinel";

function writeFailingMigrations(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migrate-deploy-e2e-"));
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1700000000000, tag: "0000_e2e_ok", breakpoints: true },
        { idx: 1, version: "7", when: 1700000000001, tag: "0001_e2e_overflow", breakpoints: true },
      ],
    }),
  );
  writeFileSync(path.join(folder, "0000_e2e_ok.sql"), "CREATE TABLE e2e_fail (x integer);");
  writeFileSync(
    path.join(folder, "0001_e2e_overflow.sql"),
    `INSERT INTO e2e_fail (x) VALUES (2147483648) /* ${SENTINEL} */;`,
  );
  return folder;
}

test("db:migrate:deploy non-TTY first run prints SQLSTATE + tag + statement on failure", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error(
        "MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing — this tooth must not silently skip in Hosted",
      );
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `migrate_deploy_e2e_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  const adminUrl = new URL(ADMIN_URL);
  const targetUrl = new URL(ADMIN_URL);
  targetUrl.pathname = `/${dbName}`;
  // Preflight contract: the migrator DSN delivers statement_timeout via libpq
  // `options=-c` on a direct connection, and the env pins the expected value.
  targetUrl.searchParams.set("options", "-c statement_timeout=60000");
  void adminUrl;

  const serverDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const migrationsFolder = writeFailingMigrations();

  const child = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    // Piped stdio = non-TTY by construction, the ECS/CloudWatch shape.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: targetUrl.toString(),
      SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
      MIGRATIONS_FOLDER: migrationsFolder,
    },
    timeout: 180_000,
  });

  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  assert.notEqual(child.status, 0, `deploy must exit non-zero on failure; output:\n${output}`);
  assert.match(output, /\[MIGRATION_FAILED\]/, `missing structured line; output:\n${output}`);
  assert.match(output, /sqlstate=22003/, `missing SQLSTATE; output:\n${output}`);
  assert.match(output, /migration=0001_e2e_overflow/, `missing failing tag; output:\n${output}`);
  assert.match(output, /out of range/, "missing server message");
  assert.ok(output.includes(SENTINEL), "missing real failing statement");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(output, /\x1b\[[0-9;]*m/, "output must be ANSI-free");
  assert.ok(!output.includes(String(adminUrl.password ?? "")), "no DSN secret in output");

  // Production rollback semantics, read back directly from the database the
  // full CLI ran against: the batch transaction rolled back completely — the
  // transiently created table is gone and NO partial journal row exists.
  const probe = new pg.Client({ connectionString: targetUrl.toString() });
  await probe.connect();
  try {
    const reg = await probe.query("SELECT to_regclass('e2e_fail') AS r");
    assert.equal(reg.rows[0].r, null, "failed batch table must be rolled back");
    const journal = await probe.query(
      "SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"",
    ).catch(() => ({ rows: [{ n: 0 }] }));
    assert.equal(journal.rows[0].n, 0, "no partial journal row after failure");
  } finally {
    await probe.end();
  }
});

test("db:migrate:deploy full run applies real repo migrations once, second run no-ops", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error(
        "MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing — this tooth must not silently skip in Hosted",
      );
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `migrate_deploy_ok_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  const targetUrl = new URL(ADMIN_URL);
  targetUrl.pathname = `/${dbName}`;
  targetUrl.searchParams.set("options", "-c statement_timeout=60000");

  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const env = {
    ...process.env,
    DATABASE_URL: targetUrl.toString(),
    SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
    SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "true",
    SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: "0244_ancient_ares,0245_complete_sharon_ventura",
    SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
    SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS: "0244_ancient_ares,0245_complete_sharon_ventura",
    SERVER_MIGRATION_LOCK_SCHEMA: "public",
    SERVER_MIGRATION_LOCK_RELATIONS: "users,server_members",
    SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907",
    SERVER_MIGRATION_ADVISORY_LOCK_KEY: "245",
    // No MIGRATIONS_FOLDER override: the REAL repo journal is the fixture.
  };
  delete (env as Record<string, unknown>).MIGRATIONS_FOLDER;

  const first = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 420_000,
  });
  const firstOut = `${first.stdout ?? ""}\n${first.stderr ?? ""}`;
  assert.equal(first.status, 0, `first full apply must succeed; output tail:\n${firstOut.slice(-2000)}`);
  assert.match(firstOut, /\[MIGRATION_DEPLOY_OK\]/);

  const probe = new pg.Client({ connectionString: targetUrl.toString() });
  await probe.connect();
  const count1 = await probe.query(
    "SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"",
  );
  assert.ok(count1.rows[0].n > 0, "first apply must record journal rows");

  const second = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 180_000,
  });
  const secondOut = `${second.stdout ?? ""}\n${second.stderr ?? ""}`;
  assert.equal(second.status, 0, `second run must no-op cleanly; output tail:\n${secondOut.slice(-2000)}`);
  assert.match(secondOut, /\[MIGRATION_DEPLOY_OK\]/);

  const count2 = await probe.query(
    "SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"",
  );
  assert.equal(count2.rows[0].n, count1.rows[0].n, "second run must not re-record or re-apply");
  await probe.end();
});

// ---------------------------------------------------------------------------
// Lock-watch scope tooth on real PostgreSQL (2026-09-11, v1.13.0 cut).
//
// WHY a real database: the claim under test is a statement about what Postgres
// reports through pg_locks/pg_stat_activity for a genuinely held lock. A fake
// query seam can only show that our code reads rows we handed it — it cannot
// show that a live holder is visible to the preflight.
//
// The v1.13.0 deadlock was on `messages`, which was NOT in
// SERVER_MIGRATION_LOCK_RELATIONS, so the guard that exists to refuse a
// contended start admitted a phase a live waiter already contended for.
//
// Property: admission is decided by the watched relation set.
//   - another connection holds a lock on the watched relation -> fail closed
//   - the SAME contention with the relation unwatched            -> admitted
// Removing `messages` from the watch list must therefore turn this RED, which is
// exactly the regression that produced the failed cut.
// ---------------------------------------------------------------------------
test("real PG: lock preflight refuses to start while a watched relation is contended", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error(
        "MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing — this tooth must not silently skip in Hosted",
      );
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `lock_watch_scope_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  const target = new URL(ADMIN_URL);
  target.pathname = `/${dbName}`;
  const dsn = target.toString();

  // Two real, concurrent sessions. The holder must keep its transaction OPEN
  // across the probe — an FK to a *different* table holds ShareRowExclusive on
  // the referenced parent until commit, which is exactly the lock class that
  // deadlocked the v1.13.0 cut.
  const holder = new pg.Client({ connectionString: dsn });
  const prober = new pg.Client({ connectionString: dsn });
  await holder.connect();
  await prober.connect();
  t.onTestFinished(async () => {
    await holder.end().catch(() => {});
    await prober.end().catch(() => {});
  });

  const { runMigrationLockPreflight } = await import("./migrationPhases.js");
  const query = (text: string, values?: readonly unknown[]) =>
    prober.query(text, values as unknown[] | undefined);

  await prober.query("CREATE TABLE messages (id uuid PRIMARY KEY)");
  await prober.query("CREATE TABLE child_ref (id uuid PRIMARY KEY, msg uuid)");
  await prober.query("CREATE TABLE server_members (id uuid PRIMARY KEY)");

  await holder.query("BEGIN");
  await holder.query(
    "ALTER TABLE child_ref ADD CONSTRAINT child_ref_msg_fk FOREIGN KEY (msg) REFERENCES messages(id) NOT VALID",
  );

  // Prove the contention is real before asserting on the preflight: without
  // this, a broken holder would make the tooth pass for the wrong reason.
  const held = await prober.query(
    `SELECT count(*)::int AS n FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'messages' AND l.mode = 'ShareRowExclusiveLock' AND l.granted
        AND l.pid <> pg_backend_pid()`,
  );
  assert.ok(
    held.rows[0].n > 0,
    "test setup must actually hold ShareRowExclusiveLock on messages, or the assertions below are vacuous",
  );

  // Watched: the contention is visible, so the preflight must refuse to start.
  // It reports either a waiting lock or a transaction older than the budget, so
  // hold long enough to be seen on the duration axis.
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Unwatched: the very same contention is invisible => admitted. This is the
  // v1.13.0 configuration (messages was absent from the watch list).
  await runMigrationLockPreflight(query, 1, "public", ["server_members"]);

  // Watched with a budget short enough that the holder is already "old".
  await assert.rejects(
    runMigrationLockPreflight(query, 1, "public", ["messages"]),
    /MIGRATION_LOCK_PREFLIGHT_BLOCKED/,
    "a watched relation with a live conflicting holder must block admission",
  );

  await holder.query("ROLLBACK");
});

test("real PG: lock preflight fails closed on a relation name that does not exist", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error(
        "MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing — this tooth must not silently skip in Hosted",
      );
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `lock_relation_resolution_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  const target = new URL(ADMIN_URL);
  target.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  t.onTestFinished(async () => {
    await client.end().catch(() => {});
  });

  const { runMigrationLockPreflight } = await import("./migrationPhases.js");
  const query = (text: string, values?: readonly unknown[]) =>
    client.query(text, values as unknown[] | undefined);

  await client.query("CREATE TABLE messages (id uuid PRIMARY KEY)");
  // The check is scoped to an established schema (see runMigrationLockPreflight):
  // on a fresh database the configured relations legitimately do not exist yet,
  // because the first phase's migrations create them. Mark the schema as
  // established the way the migrator does, so this tooth tests resolution rather
  // than re-testing the fresh-install exemption.
  await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  await client.query(
    "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );

  // A real table plus a name that does not exist. Against a live database the
  // ANY($2) match silently drops the unknown name, so without the resolution
  // check this reads as a clear window and the guard watches only half of what
  // the contract named.
  await assert.rejects(
    runMigrationLockPreflight(query, 5000, "public", ["messages", "not_a_real_table"]),
    /MIGRATION_LOCK_PREFLIGHT_RELATION_UNRESOLVED/,
    "a configured relation that does not exist must fail closed against a live database",
  );

  // All names real and uncontended => admitted.
  await runMigrationLockPreflight(query, 5000, "public", ["messages"]);
});
