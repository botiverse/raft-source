// Real-Postgres wiring proof for the head-bound admission preflight. Gated
// behind MIGRATION_PREFLIGHT_REAL_PG_REQUIRED=1 + MIGRATION_PREFLIGHT_REAL_PG_URL
// (a throwaway localhost pg with a SUPERUSER DSN so the test can CREATE ROLE and
// seed drizzle bookkeeping).
//
// Exercises the exact mechanism the deploy relies on under Path B: a normal role
// whose baseline default statement_timeout is NOT the required value, connected
// through a migrator DSN that carries the libpq startup option
// `options=-c statement_timeout=60000`. That startup option is applied after the
// role default and WINS, so a fresh connection reads 60000 back — while the same
// role WITHOUT the option reads only its baseline and is REJECTED. This proves
// the operator-DSN delivery mechanism (not a role-level default), combined with
// the db head vs the exact manifest — the frozen 5-tooth contract end to end.
import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const enabled = process.env.MIGRATION_PREFLIGHT_REAL_PG_REQUIRED === "1";
const ADMIN_DSN = process.env.MIGRATION_PREFLIGHT_REAL_PG_URL || "";
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(serverRoot, "scripts", "migration-preflight.ts");
const QT = 'drizzle."__drizzle_migrations"';

// A 3-migration manifest. hash = full-file sha256 (what readMigrationFiles uses),
// created_at = journal `when`.
function makeManifest() {
  const entries = [
    { tag: "0000_a", when: 1000, sql: "CREATE TABLE mp_a (id int);" },
    { tag: "0001_b", when: 2000, sql: "CREATE TABLE mp_b (id int);" },
    { tag: "0002_c", when: 3000, sql: "CREATE TABLE mp_c (id int);" },
  ];
  const dir = mkdtempSync(path.join(tmpdir(), "mp-"));
  mkdirSync(path.join(dir, "meta"), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const e of entries) {
    writeFileSync(path.join(dir, `${e.tag}.sql`), e.sql);
    hashes[e.tag] = createHash("sha256").update(e.sql).digest("hex");
  }
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: entries.map((e, i) => ({ idx: i, version: "7", when: e.when, tag: e.tag, breakpoints: true })) }),
  );
  return { dir, entries, hashes };
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_DSN });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/**
 * Build the migrator DSN for a role. When `optionMs` is given, the timeout is
 * DELIVERED the Path-B way: as a libpq startup option `options=-c
 * statement_timeout=<ms>` on the connection string — encoded with %20/%3D (not
 * `+`) so pg-connection-string's decodeURIComponent restores the space. When
 * `optionMs` is null, NO option is carried, so the connection falls back to the
 * role's baseline default (the no-option rejection case).
 */
function migratorDsn(user: string, pass: string, optionMs: number | null): string {
  const u = new URL(ADMIN_DSN);
  u.username = user;
  u.password = pass;
  let s = u.toString();
  if (optionMs != null) {
    const opt = encodeURIComponent(`-c statement_timeout=${optionMs}`);
    s += (s.includes("?") ? "&" : "?") + "options=" + opt;
  }
  return s;
}

/** Reset drizzle bookkeeping and seed the given (hash, created_at) rows. */
async function seed(rows: Array<{ hash: string; createdAt: number }>) {
  await withAdmin(async (c) => {
    await c.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await c.query('CREATE SCHEMA drizzle');
    await c.query(`CREATE TABLE ${QT} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    for (const r of rows) await c.query(`INSERT INTO ${QT} (hash, created_at) VALUES ($1, $2)`, [r.hash, r.createdAt]);
  });
}

/** Drop a role, first revoking its grants / owned objects (else DROP ROLE
 * errors with 2BP01 dependent_objects_still_exist). */
async function dropRole(name: string) {
  await withAdmin(async (c) => {
    const ex = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
    if (ex.rowCount) {
      await c.query(`DROP OWNED BY ${name} CASCADE`);
      await c.query(`DROP ROLE ${name}`);
    }
  });
}

/**
 * Create a NORMAL role with a baseline role-level default statement_timeout.
 * Under Path B this baseline is deliberately NOT the required value — it stands
 * in for the serving/pooler default (e.g. 15s). The required 60s is delivered by
 * the DSN's `options=-c` at connect time, which overrides this baseline; without
 * the option the connection reads only this baseline and must be rejected.
 */
async function makeRole(name: string, pass: string, baselineMs: number) {
  await dropRole(name);
  await withAdmin(async (c) => {
    await c.query(`CREATE ROLE ${name} LOGIN PASSWORD '${pass}'`);
    await c.query(`GRANT USAGE ON SCHEMA drizzle TO ${name}`);
    await c.query(`GRANT SELECT ON ${QT} TO ${name}`);
    await c.query(`ALTER ROLE ${name} SET statement_timeout = ${baselineMs}`);
  });
}

function runPreflight(dsn: string, migrationsFolder: string, timeoutMs: string) {
  const env = { ...process.env, DATABASE_URL: dsn, SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: timeoutMs, MIGRATIONS_FOLDER: migrationsFolder };
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath], { cwd: serverRoot, env, encoding: "utf8" });
}

test("real-pg tooth 1: head==target (timeout moot) -> ADMIT no-op", { skip: !enabled }, async () => {
  const { dir, entries, hashes } = makeManifest();
  try {
    await seed(entries.map((e) => ({ hash: hashes[e.tag], createdAt: e.when })));
    await makeRole("mp_t1", "pw1", 15000);
    const r = runPreflight(migratorDsn("mp_t1", "pw1", 60000), dir, "60000");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_OK\] admit=AT_TARGET_NOOP/);
  } finally {
    await dropRole("mp_t1");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real-pg tooth 2: behind + NO options=-c (baseline 15s wins) -> REJECT", { skip: !enabled }, async () => {
  const { dir, entries, hashes } = makeManifest();
  try {
    await seed([{ hash: hashes["0000_a"], createdAt: 1000 }]); // only first applied
    await makeRole("mp_t2", "pw2", 15000);
    // No options=-c on the DSN: the connection reads only the role baseline (15s),
    // so the required 60s is not delivered and the preflight must fail closed.
    const r = runPreflight(migratorDsn("mp_t2", "pw2", null), dir, "60000");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_ABORT\] EFFECTIVE_MISMATCH expected=60000 actual=15000/);
  } finally {
    await dropRole("mp_t2");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real-pg tooth 3: behind + options=-c 60s overrides baseline -> ADMIT migrate", { skip: !enabled }, async () => {
  const { dir, entries, hashes } = makeManifest();
  try {
    await seed([{ hash: hashes["0000_a"], createdAt: 1000 }]);
    // Baseline default is 15s; the DSN's options=-c statement_timeout=60000 is
    // applied at startup and WINS, so a fresh connection reads 60000 back.
    await makeRole("mp_t3", "pw3", 15000);
    const r = runPreflight(migratorDsn("mp_t3", "pw3", 60000), dir, "60000");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_OK\] admit=BEHIND_MIGRATE/);
  } finally {
    await dropRole("mp_t3");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real-pg tooth 4: diverged head (unknown hash) -> REJECT, no write", { skip: !enabled }, async () => {
  const { dir } = makeManifest();
  try {
    await seed([{ hash: "f".repeat(64), createdAt: 2500 }]); // unknown hash, within range
    await makeRole("mp_t4", "pw4", 15000);
    const r = runPreflight(migratorDsn("mp_t4", "pw4", 60000), dir, "60000");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_ABORT\] HEAD_DIVERGED/);
    // admission-only: the bookkeeping table is untouched (still exactly the seeded row)
    await withAdmin(async (c) => {
      const n = await c.query(`SELECT count(*)::int n FROM ${QT}`);
      assert.equal(n.rows[0].n, 1, "preflight must not write DB");
    });
  } finally {
    await dropRole("mp_t4");
    rmSync(dir, { recursive: true, force: true });
  }
});
