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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
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

// Lock-wait tooth for the production lock contract (#proj-o11y deadlock
// follow-up, 10-22): a live read holds a lock the migration needs, so the
// phased deploy path must give up after the 5s session `lock_timeout` (55P03),
// roll the phase back, and apply it on the bounded retry once the reader
// commits. Removing the `lock_timeout` set in migrate-deploy.ts makes the
// first attempt wait for the reader instead of failing, so no 55P03 / retry
// lines appear; removing 55P03 from the retryable set fails the deploy.
test("db:migrate:deploy times out behind a live read after 5s, rolls back, and succeeds on retry", async (t) => {
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
  const dbName = `migrate_deploy_lockwait_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const targetUrl = new URL(ADMIN_URL);
  targetUrl.pathname = `/${dbName}`;
  const reader = new pg.Client({ connectionString: targetUrl.toString() });
  const probe = new pg.Client({ connectionString: targetUrl.toString() });
  t.onTestFinished(async () => {
    await reader.end().catch(() => {});
    await probe.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await reader.connect();
  await probe.connect();
  await probe.query("CREATE TABLE lockwait_t (x integer)");

  const folder = mkdtempSync(path.join(tmpdir(), "migrate-deploy-lockwait-"));
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1700000000000, tag: "0000_lockwait_alter", breakpoints: true },
      ],
    }),
  );
  writeFileSync(
    path.join(folder, "0000_lockwait_alter.sql"),
    "ALTER TABLE lockwait_t ADD COLUMN y integer;",
  );

  // The live read: an open transaction that has read the table keeps its
  // ACCESS SHARE lock, which the ALTER's ACCESS EXCLUSIVE has to wait behind.
  await reader.query("BEGIN");
  await reader.query("SELECT count(*) FROM lockwait_t");

  const migratorUrl = new URL(targetUrl.toString());
  migratorUrl.searchParams.set("options", "-c statement_timeout=60000");
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const child = spawn("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: migratorUrl.toString(),
      SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
      SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "true",
      SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
      SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907",
      SERVER_MIGRATION_ADVISORY_LOCK_KEY: "246",
      // Retry delay is at least half the base: 2s keeps the retry clear of
      // the moment the reader commits below.
      SERVER_MIGRATION_RETRY_BASE_DELAY_MS: "2000",
      MIGRATIONS_FOLDER: folder,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => { exitCode = code; resolve(code); }),
  );
  t.onTestFinished(() => { child.kill("SIGKILL"); });

  const waiters = async (): Promise<number> => {
    const res = await probe.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND relation = 'lockwait_t'::regclass AND NOT granted`,
    );
    return res.rows[0].n as number;
  };
  const pollUntil = async (want: (n: number) => boolean, label: string): Promise<number> => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (want(await waiters())) return Date.now();
      if (exitCode !== undefined) {
        throw new Error(`deploy exited (${exitCode}) before ${label}; output:\n${output.slice(-2000)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}; output so far:\n${output.slice(-2000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  // First attempt queues behind the reader, then gives up on its own.
  const waitStarted = await pollUntil((n) => n > 0, "migration to queue behind the reader");
  const waitEnded = await pollUntil((n) => n === 0, "migration lock wait to end");
  const waitedMs = waitEnded - waitStarted;
  assert.ok(waitedMs >= 4_500, `lock wait ended after ${waitedMs}ms; expected the 5s lock_timeout`);
  assert.ok(waitedMs < 15_000, `lock wait lasted ${waitedMs}ms; lock_timeout not effective`);

  // The failed phase rolled back: the column is not there while the reader still holds its lock.
  const midway = await probe.query(
    "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'lockwait_t' AND column_name = 'y'",
  );
  assert.equal(midway.rows[0].n, 0, "timed-out attempt must not leave the column behind");

  await reader.query("COMMIT");

  const code = await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`deploy did not exit; output:\n${output.slice(-2000)}`)), 180_000),
    ),
  ]);
  assert.equal(code, 0, `deploy must succeed on retry; output tail:\n${output.slice(-2000)}`);
  assert.match(output, /\[MIGRATION_FAILED\] sqlstate=55P03 migration=0000_lockwait_alter/);
  assert.match(output, /\[MIGRATION_RETRY\] reason=sqlstate=55P03 attempt=1\//);
  assert.match(output, /\[MIGRATION_RETRY_SUCCEEDED\] attempt=2\//);
  assert.match(output, /\[MIGRATION_DEPLOY_OK\]/);

  const applied = await probe.query(
    "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'lockwait_t' AND column_name = 'y'",
  );
  assert.equal(applied.rows[0].n, 1, "retry must apply the migration");
  const journal = await probe.query("SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"");
  assert.equal(journal.rows[0].n, 1, "exactly one journal row after the retried phase");
});
