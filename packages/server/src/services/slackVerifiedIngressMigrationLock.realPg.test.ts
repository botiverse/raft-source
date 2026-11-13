import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const PG_URL = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_URL;
const REQUIRED = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_REQUIRED === "1";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

test("migration waits on inbound before locking hot author tables (real PG)", { skip: !(PG_URL || REQUIRED), timeout: 90_000 }, async () => {
  assert.ok(PG_URL, "SLACK_VERIFIED_INGRESS_REAL_PG_URL is required");
  const dir = mkdtempSync(join(tmpdir(), "w4-migrations-"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>; [key: string]: unknown;
  };
  const migrationIndex = journal.entries.findIndex(entry => entry.tag === "0506_slack_verified_ingress");
  assert.ok(migrationIndex > 0, "the W4 migration must exist after its baseline");
  journal.entries = journal.entries.slice(0, migrationIndex);
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) symlinkSync(join(MIGRATIONS, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  const admin = new pg.Client({ connectionString: PG_URL });
  const name = `w4_lock_${process.pid}_${randomBytes(4).toString("hex")}`;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const target = new URL(PG_URL); target.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: target.toString() });
    try { await migrate(drizzle(pool), { migrationsFolder: dir }); } finally { await pool.end(); }
    const sql = readFileSync(join(MIGRATIONS, "0506_slack_verified_ingress.sql"), "utf8");
    const statements = sql.split("--> statement-breakpoint").filter(item => item.trim());
    const authorStatements = statements.filter(item => /ALTER TABLE "external_(?:actor_projections|message_author_facts)" (?:DROP CONSTRAINT|ADD COLUMN)/u.test(item));
    assert.equal(authorStatements.length, 5);
    const oldOrder = statements.filter(item => !authorStatements.includes(item));
    const firstInbound = oldOrder.findIndex(item => /REFERENCES "public"\."external_inbound_events"/u.test(item));
    assert.ok(firstInbound > 0);
    oldOrder.splice(firstInbound, 0, ...authorStatements);
    for (const [label, script, shouldRead] of [["current", statements, true], ["old order mutation", oldOrder, false]] as const) {
      const blocker = new pg.Client({ connectionString: target.toString() });
      const migrator = new pg.Client({ connectionString: target.toString() });
      const reader = new pg.Client({ connectionString: target.toString() });
      try {
        await Promise.all([blocker.connect(), migrator.connect(), reader.connect()]);
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE external_inbound_events IN ACCESS EXCLUSIVE MODE");
        await migrator.query("BEGIN");
        await migrator.query("SET LOCAL lock_timeout = '5s'");
        const pid = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const migrating = (async () => { for (const statement of script) await migrator.query(statement); })();
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
          if (result.rows[0]?.wait_event_type === "Lock") { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(waiting, true, `${label}: migration must actually be waiting for inbound`);
        await reader.query("SET statement_timeout = '300ms'");
        for (const table of ["external_actor_projections", "external_message_author_facts"]) {
          if (shouldRead) await reader.query(`SELECT 1 FROM ${table} LIMIT 1`);
          else await assert.rejects(reader.query(`SELECT 1 FROM ${table} LIMIT 1`), (error: unknown) => (error as { code?: string }).code === "57014");
        }
        await blocker.query("ROLLBACK");
        await migrating;
        await migrator.query("ROLLBACK");
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await migrator.query("ROLLBACK").catch(() => {});
        await Promise.all([blocker.end(), migrator.end(), reader.end()]);
      }
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
