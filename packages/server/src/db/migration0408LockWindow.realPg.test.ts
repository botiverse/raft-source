/**
 * Real-PostgreSQL lock-window probe for `0408_managed_mcp_app_profile` (MCP Apps).
 *
 * 0408 alters a LIVE table: eleven `ADD COLUMN` (all nullable, no default, so metadata-only in
 * PG11+), two `ADD CONSTRAINT ... CHECK` (each a full scan under ACCESS EXCLUSIVE), and two small
 * backfill UPDATEs, all on `managed_mcp_servers`. The deploy runner executes each migration file in
 * ONE transaction, so every lock it takes is held until commit. `managed_mcp_servers` holds one row
 * per configured MCP server, so the scan and the backfill are short; this probe is the evidence.
 *
 * It replaces the registry-provenance version of 0408 (the official-registry import was removed
 * before release). Treat any numbers it prints as a TREND for future scale warnings, NOT an SLA.
 *
 * Default-skipped. Run it with:
 *
 *   docker run -d --name pg0408 -e POSTGRES_PASSWORD=probe -p 55434:5432 postgres:16-alpine
 *   MIGRATION_0408_LOCKS_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55434/postgres \
 *     pnpm --filter @botiverse/raft-server test:migration-0408-locks
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { test } from "vitest";

const REAL_PG_URL_ENV = "MIGRATION_0408_LOCKS_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.MIGRATION_0408_LOCKS_REAL_PG_REQUIRED === "1";

// Production values; `scripts/migrate-deploy.ts` sets these only when
// SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED === "true", which both deploy workflows do.
const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 60000;

const MCP_ROWS = Number(process.env.MIGRATION_0408_LOCKS_MCP_ROWS ?? 2000);
const WRITERS = 4;

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string }>;
};
const tags = journal.entries.map((e) => e.tag);
const TAIL = "0408_managed_mcp_app_profile";
const tailIndex = tags.indexOf(TAIL);
const sqlFor = (tag: string) => readFileSync(`${drizzleDir}/${tag}.sql`, "utf8");

const USER = "00000000-0000-4000-8000-000000000001";
const SERVER = "00000000-0000-4000-8000-0000000000a1";

test(
  "0408 holds its managed_mcp_servers locks for the whole file, and the window stays small",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 300_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    assert.notEqual(tailIndex, -1, "this probe is bound to 0408, which must be in the journal");

    const dbName = `probe_0408_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    admin.on("error", () => {});
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = REAL_PG_URL.replace(/\/[^/]*$/, `/${dbName}`);

    const setup = new pg.Client({ connectionString: url });
    setup.on("error", () => {});
    await setup.connect();
    let stop = false;
    const writers: Array<Promise<void>> = [];

    try {
      for (const tag of tags.slice(0, tailIndex)) {
        await setup.query("BEGIN");
        await setup.query(sqlFor(tag));
        await setup.query("COMMIT");
      }
      await setup.query(
        `INSERT INTO users (id,email,name,password_hash)
         VALUES ($1,'probe0280@example.test','P','fixture-value-not-a-credential')`,
        [USER],
      );
      await setup.query(`INSERT INTO servers (id,name,slug,owner_id) VALUES ($1,'P','p',$2)`, [SERVER, USER]);
      for (let i = 0; i < MCP_ROWS; i++) {
        await setup.query(
          `INSERT INTO managed_mcp_servers (id,server_id,name,endpoint_url) VALUES (gen_random_uuid(),$1,$2,$3)`,
          [SERVER, `mcp ${i}`, `https://example.test/${i}`],
        );
      }

      // What an OLD binary does during a rolling deploy: write managed_mcp_servers directly.
      const samples: Array<{ at: number; ms: number }> = [];
      const errors: Array<{ code?: string }> = [];
      for (let w = 0; w < WRITERS; w++) {
        writers.push(
          (async () => {
            const c = new pg.Client({ connectionString: url, application_name: `legacy-writer-${w}` });
            c.on("error", () => {});
            await c.connect();
            let n = 0;
            while (!stop) {
              const name = `w${w}-${n++}`;
              const started = Date.now();
              try {
                const inserted = await c.query(
                  `INSERT INTO managed_mcp_servers (id,server_id,name,endpoint_url) VALUES (gen_random_uuid(),$1,$2,$3) RETURNING id`,
                  [SERVER, name, `https://example.test/${name}`],
                );
                const id = inserted.rows[0].id;
                await c.query(`UPDATE managed_mcp_servers SET enabled = NOT enabled WHERE id = $1`, [id]);
                await c.query(`DELETE FROM managed_mcp_servers WHERE id = $1`, [id]);
                samples.push({ at: started, ms: Date.now() - started });
              } catch (err) {
                errors.push({ code: (err as { code?: string }).code });
              }
            }
            await c.end();
          })(),
        );
      }
      await new Promise((r) => setTimeout(r, 1500));

      const mig = new pg.Client({ connectionString: url, application_name: "migration-0408" });
      mig.on("error", () => {});
      await mig.connect();
      await mig.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await mig.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const migStart = Date.now();
      await mig.query("BEGIN");
      await mig.query(sqlFor(TAIL));
      await mig.query("COMMIT");
      const migMs = Date.now() - migStart;
      const migEnd = Date.now();
      await mig.end();

      await new Promise((r) => setTimeout(r, 1500));
      stop = true;
      await Promise.all(writers);

      const blocked = samples.filter((s) => s.at + s.ms >= migStart && s.at <= migEnd);
      const maxBlocked = blocked.length ? Math.max(...blocked.map((s) => s.ms)) : 0;

      assert.equal(errors.filter((e) => e.code === "40P01").length, 0, "no deadlock");
      assert.equal(
        errors.filter((e) => e.code === "55P03" || e.code === "57014").length,
        0,
        "no lock_timeout / statement_timeout during concurrent managed_mcp_servers writes",
      );
      assert.equal(errors.length, 0, "no legacy-path write failed while 0408 ran");
      assert.ok(blocked.length > 0, "at least one write must overlap the migration, or this proves nothing");

      // The columns landed, the CHECKs are enforced, and the backfill classified existing rows.
      const cols = await setup.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='managed_mcp_servers' AND column_name = ANY($1) ORDER BY column_name`,
        [[
          "auth_probe", "category", "homepage_url", "last_latency_ms", "logo_storage_key", "logo_url",
          "required_header_names", "server_info", "source_kind", "template_key", "when_to_use",
        ]],
      );
      assert.equal(cols.rows.length, 11, "all eleven App profile columns are present");
      const legacy = await setup.query(
        // Only the rows seeded BEFORE the migration ("mcp N"). Rows the writers insert after commit
        // play an old binary, which does not know source_kind, so they are NULL by design.
        `SELECT count(*)::int AS n FROM managed_mcp_servers
         WHERE server_id=$1 AND name LIKE 'mcp %' AND source_kind IS DISTINCT FROM 'url'`,
        [SERVER],
      );
      assert.equal(legacy.rows[0].n, 0, "every pre-existing custom row was backfilled as source_kind='url'");
      await assert.rejects(
        () => setup.query(
          `INSERT INTO managed_mcp_servers (id,server_id,name,endpoint_url,source_kind)
           VALUES (gen_random_uuid(),$1,'bad','https://example.test/bad','registry')`,
          [SERVER],
        ),
        "the CHECK must refuse a source kind other than 'url' or 'template'",
      );

      // eslint-disable-next-line no-console -- the numbers are the deliverable
      console.log(
        `[0408 lock probe] mcpRows=${MCP_ROWS} migration=${migMs}ms ` +
          `maxBlockedWrite=${maxBlocked}ms overlapping=${blocked.length} deadlocks=0 timeouts=0`,
      );
    } finally {
      stop = true;
      await Promise.allSettled(writers);
      await setup.end().catch(() => {});
      const cleanup = new pg.Client({ connectionString: REAL_PG_URL });
      cleanup.on("error", () => {});
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanup.end();
    }
  },
);
