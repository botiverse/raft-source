/**
 * Real-PostgreSQL lock-window probe for `0407_generic_app_root_foundation` (task #21, checkpoint 1).
 *
 * WHY THIS EXISTS, and why PGlite cannot stand in: 0407 takes write-blocking locks on two LIVE
 * tables -- `ALTER TABLE ... ADD FOREIGN KEY ... REFERENCES oauth_clients / managed_mcp_servers`
 * and `CREATE TRIGGER ... ON` those same tables -- and the deploy runner executes each migration
 * file in ONE transaction, so those locks are held until commit, i.e. across the whole backfill.
 * A legacy-path write arriving mid-migration therefore waits out the ENTIRE file, not one
 * statement. Measuring that needs genuinely concurrent connections, which PGlite does not have.
 *
 * Default-skipped, like every other `*.realPg.test.ts` here. Run it with:
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=probe -p 55433:5432 postgres:16-alpine
 *   MIGRATION_0407_LOCKS_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55433/postgres \
 *     pnpm --filter @botiverse/raft-server test:migration-0407-locks
 *
 * MEASURED 2026-09-16, PostgreSQL 16.14 (aarch64), 4 concurrent legacy-path writers,
 * migration run in one transaction with lock_timeout=5s / statement_timeout=60s:
 *
 *   oauth/mcp rows   migration ms   max blocked legacy write   baseline max
 *        500/  200         77                57                     50
 *      2,000/  800        174               160                     36
 *      8,000/3,000        507               501                     46
 *   deadlocks 0 · lock/statement timeouts 0 · backfill counts exact · orphans 0  (all three)
 *
 * Two readings that came out of it:
 *   1. blocked time ~= total migration duration (160~174, 501~507) -- confirms the locks are held
 *      to commit; it is one long wait, not many short ones.
 *   2. roughly linear, ~46 us/row on this hardware. Treat as a TREND for future scale warnings,
 *      NOT as a production SLA (@Huarong's boundary).
 *
 * ⚠️ VOID RESULT, recorded so nobody re-derives it: an earlier attempt at the 2k/8k scales used
 * `for spec in "2000 800"; set -- $spec`, and zsh does not word-split unquoted parameters, so the
 * counts became NaN/0 and the probe ran against an EMPTY database -- 40 ms, no blocking, entirely
 * healthy-looking. Only the `expect >= NaN` in the assertion output exposed it. Those numbers are
 * discarded; the table above is the re-run.
 *
 * Timeouts do reach the real execution path (verified in source, not assumed):
 * `scripts/migrate-deploy.ts` sets `lock_timeout` ONLY when `SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED
 * === "true"`, then reads `pg_settings` back and throws on mismatch; both deploy workflows set that
 * flag to 'true' with lock 5000ms / statement 60000ms. If that flag were ever false, migrations
 * would run WITHOUT lock_timeout -- the safety is conditional on it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { test } from "vitest";

const REAL_PG_URL_ENV = "MIGRATION_0407_LOCKS_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.MIGRATION_0407_LOCKS_REAL_PG_REQUIRED === "1";

// Production values; see the header note on how they reach the migration connection.
const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 60000;

// Deliberately modest: @yezizp confirmed the legacy tables are small, and @peng's scope is
// "prove it at the actual small scale", not build a load rig.
const OAUTH_ROWS = Number(process.env.MIGRATION_0407_LOCKS_OAUTH_ROWS ?? 500);
const MCP_ROWS = Number(process.env.MIGRATION_0407_LOCKS_MCP_ROWS ?? 200);
const WRITERS = 4;

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string }>;
};
const tags = journal.entries.map((e) => e.tag);
const TAIL = "0407_generic_app_root_foundation";
// Bound to 0407's own position rather than to the journal tail -- see the same re-point in
// `appRootFoundation.pglite.test.ts`. This probe measures 0407's lock window specifically.
const tailIndex = tags.indexOf(TAIL);
const sqlFor = (tag: string) => readFileSync(`${drizzleDir}/${tag}.sql`, "utf8");

const USER = "00000000-0000-4000-8000-000000000001";
const SERVER = "00000000-0000-4000-8000-0000000000a1";
const rowId = (n: number, prefix: string) =>
  `${prefix}${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`.slice(0, 36);

test(
  "0407 holds its legacy-table locks for the whole file, but the window stays small at this scale",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 300_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    assert.notEqual(tailIndex, -1, "this probe is bound to 0407, which must still be in the journal");

    const dbName = `probe_0407_${process.pid}_${randomBytes(4).toString("hex")}`;
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
      // State immediately BEFORE 0407, applied the way the runner applies it: one txn per file.
      for (const tag of tags.slice(0, tailIndex)) {
        await setup.query("BEGIN");
        await setup.query(sqlFor(tag));
        await setup.query("COMMIT");
      }
      await setup.query(
        `INSERT INTO users (id,email,name,password_hash)
         VALUES ($1,'probe@example.test','P','fixture-value-not-a-credential')`,
        [USER],
      );
      await setup.query(`INSERT INTO servers (id,name,slug,owner_id) VALUES ($1,'P','p',$2)`, [SERVER, USER]);
      for (let i = 0; i < OAUTH_ROWS; i++) {
        await setup.query(
          `INSERT INTO oauth_clients (id,server_id,client_id,client_secret_hash,name,created_by_user_id,app_type)
           VALUES ($1,$2,$3,'fixture-value-not-a-credential',$4,$5,'server_local')`,
          [rowId(i, "aaaaaaaa"), SERVER, `c-${i}`, `app ${i}`, USER],
        );
      }
      for (let i = 0; i < MCP_ROWS; i++) {
        await setup.query(
          `INSERT INTO managed_mcp_servers (id,server_id,name,endpoint_url) VALUES ($1,$2,$3,$4)`,
          [rowId(i, "bbbbbbbb"), SERVER, `mcp ${i}`, `https://example.test/${i}`],
        );
      }

      // What an OLD binary does during a rolling deploy: write the legacy tables directly.
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
              const id = rowId(100_000 + w * 10_000 + n++, "cccccccc");
              const started = Date.now();
              try {
                await c.query(
                  `INSERT INTO oauth_clients (id,server_id,client_id,client_secret_hash,name,created_by_user_id,app_type)
                   VALUES ($1,$2,$3,'fixture-value-not-a-credential',$4,$5,'server_local')`,
                  [id, SERVER, `w${w}-${n}`, `w${w}-${n}`, USER],
                );
                await c.query(`UPDATE oauth_clients SET name = name || '!' WHERE id = $1`, [id]);
                await c.query(`DELETE FROM oauth_clients WHERE id = $1`, [id]);
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

      const mig = new pg.Client({ connectionString: url, application_name: "migration-0407" });
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

      await new Promise((r) => setTimeout(r, 1500)); // let writes queued behind it drain
      stop = true;
      await Promise.all(writers);

      const blocked = samples.filter((s) => s.at + s.ms >= migStart && s.at <= migEnd);
      const maxBlocked = blocked.length ? Math.max(...blocked.map((s) => s.ms)) : 0;

      // The assertions that matter. Timings are reported, not asserted on wall-clock, because a
      // shared CI box would make an absolute-millisecond bound flaky -- and a flaky bound gets
      // relaxed until it means nothing.
      assert.equal(errors.filter((e) => e.code === "40P01").length, 0, "no deadlock");
      assert.equal(
        errors.filter((e) => e.code === "55P03" || e.code === "57014").length,
        0,
        "no lock_timeout / statement_timeout during concurrent legacy writes",
      );
      assert.equal(errors.length, 0, "no legacy-path write failed while 0407 ran");
      assert.ok(blocked.length > 0, "at least one legacy write must overlap the migration, or this proves nothing");

      const count = async (sql: string) => Number((await setup.query(sql)).rows[0].c);
      assert.equal(await count(`SELECT count(*)::int c FROM raft_apps WHERE kind='oauth_service'`), OAUTH_ROWS + 0, "oauth roots backfilled exactly");
      assert.equal(await count(`SELECT count(*)::int c FROM raft_apps WHERE kind='mcp'`), MCP_ROWS, "mcp roots backfilled exactly");
      assert.equal(
        await count(`SELECT count(*)::int c FROM raft_apps a
                     LEFT JOIN app_oauth_profiles o ON o.app_id = a.id
                     LEFT JOIN app_mcp_profiles m ON m.app_id = a.id
                     WHERE o.app_id IS NULL AND m.app_id IS NULL`),
        0,
        "no orphan roots",
      );

      // eslint-disable-next-line no-console -- the numbers are the deliverable
      console.log(
        `[0407 lock probe] rows=${OAUTH_ROWS}/${MCP_ROWS} migration=${migMs}ms ` +
          `maxBlockedLegacyWrite=${maxBlocked}ms overlapping=${blocked.length} deadlocks=0 timeouts=0`,
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
