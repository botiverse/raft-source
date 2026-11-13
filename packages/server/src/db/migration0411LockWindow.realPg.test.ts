/**
 * Real-PostgreSQL lock-window probe for `0411_action_card_open_dedupe` (task #21).
 *
 * Required by @Huarong, and the reason is a claim I made without measuring: the migration's own
 * comment called it "index-only", which reads as harmless. It is not. A plain
 * `CREATE UNIQUE INDEX` scans `action_cards` and, because the migrator wraps each file in ONE
 * transaction, holds a lock that blocks writes to that table until the file commits. The runtime
 * dedupe probe (`connectionCardConcurrency.realPg.test.ts`) proves the invariant works; it says
 * nothing about what the migration costs while it is being created.
 *
 * ⚠️ The cost shape is worth stating precisely, because "partial index" invites the wrong intuition:
 *   · the index is partial on `dedupe_key IS NOT NULL AND state = 'prepared'`
 *   · `dedupe_key` is added by this same migration, so EVERY existing row has NULL
 *   ⇒ the resulting index is EMPTY, but building it still requires a full heap scan to evaluate the
 *     predicate. Cost tracks table size; index size does not.
 *
 * `CREATE INDEX CONCURRENTLY` is not available on this path: it cannot run inside a transaction
 * block and the migrator wraps every file in one. Making it a post-step is the alternative, and
 * that is a deploy-plumbing decision rather than something to assume.
 *
 * ⚠️ CORRECTION, because I got this wrong and it changes what the numbers mean (@Huarong):
 * `lock_timeout = 5s` bounds how long the migration WAITS TO ACQUIRE a lock. It does NOT bound how
 * long it HOLDS one once acquired. So "≈4.5s at 10M rows, approaching the 5s lock_timeout" was not
 * a safety margin at all -- the build could hold its lock far longer and nothing in that setting
 * would stop it. The only automatic ceiling here is the migration's 60s `statement_timeout`, and the
 * concurrent writers set no lock timeout of their own, so they simply wait.
 *
 * ⇒ The meaningful bound is therefore an explicit WRITE-BLOCKING BUDGET, asserted below, not a
 *   comparison against `lock_timeout`.
 *
 * ⛔ What this probe does NOT establish: production cardinality. It measures a curve at chosen
 * scales; which point applies is a question for whoever can read production. Reported as a TREND,
 * never as an SLA.
 *
 * Default-skipped. Run it with:
 *
 *   docker run -d --name pg0411 -e POSTGRES_PASSWORD=probe -p 55440:5432 postgres:16-alpine
 *   MIGRATION_0411_LOCKS_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55440/postgres \
 *     pnpm --filter @botiverse/raft-server test:migration-0411-locks
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { test } from "vitest";

const REAL_PG_URL_ENV = "MIGRATION_0411_LOCKS_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.MIGRATION_0411_LOCKS_REAL_PG_REQUIRED === "1";

// Production values; `scripts/migrate-deploy.ts` sets these only when
// SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED === "true", which both deploy workflows do.
const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 60000;

const WRITERS = 4;

/**
 * Write-blocking budgets, set by @Manjusaka (SRE DRI) rather than by me.
 *
 * ⚠️ `lock_timeout` cannot serve as this bound: it limits how long a statement WAITS to acquire a
 * lock, not how long it HOLDS one. How long this migration stands in front of user writes can only
 * be answered by measuring, so it is measured and ASSERTED here.
 *
 * Two tiers, each with its own reason:
 *   20k rows   ≤ 250ms   JUDGEMENT tier -- production cardinality (reltuples ~= 19.6k @ 2026-09-17).
 *                        Derived from the user-visible "complete within 3s" budget on the write
 *                        path; a single migration should not consume more than ~1/10 of it.
 *   200k rows  ≤ 1000ms  EARLY-WARNING tier -- 10x growth. Exists so "is this still safe once the
 *                        table is 200k?" has an answer that goes RED, instead of nobody noticing
 *                        until 1M.
 *
 * ⛔ If either tier fails, the remedy is NOT a larger budget. It is to go back to building this
 * index with `CREATE UNIQUE INDEX CONCURRENTLY` as a post-migration step; that implementation exists
 * in git history (`5b0d302d2`) and was removed only because the measured cost justified an
 * exception.
 *
 * ⛔ `MIGRATION_0411_MAX_BLOCKED_WRITE_MS` is for LOCAL DIAGNOSIS ONLY. CI must never set it --
 * otherwise the budget becomes a number that can be quietly widened until it stops meaning anything,
 * which is the failure mode this assertion exists to prevent.
 */
const BUDGET_TIERS: Array<{ rows: number; budgetMs: number; label: string }> = [
  { rows: 20_000, budgetMs: 250, label: "judgement (production-representative)" },
  { rows: 200_000, budgetMs: 1_000, label: "early-warning (10x growth)" },
];

const BUDGET_OVERRIDE_MS = process.env.MIGRATION_0411_MAX_BLOCKED_WRITE_MS
  ? Number(process.env.MIGRATION_0411_MAX_BLOCKED_WRITE_MS)
  : null;

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string }>;
};
const tags = journal.entries.map((e) => e.tag);
const TAIL = "0411_action_card_open_dedupe";
const tailIndex = tags.indexOf(TAIL);
const sqlFor = (tag: string) => readFileSync(`${drizzleDir}/${tag}.sql`, "utf8");

const USER = "00000000-0000-4000-8000-0000000000c1";
const SERVER = "00000000-0000-4000-8000-0000000000c2";
const AGENT = "00000000-0000-4000-8000-0000000000c3";
const CHANNEL = "00000000-0000-4000-8000-0000000000c4";

for (const tier of BUDGET_TIERS) {
  const CARD_ROWS = tier.rows;
  const budgetMs = BUDGET_OVERRIDE_MS ?? tier.budgetMs;

  test(
  `0411 stays within the ${tier.label} budget: ${tier.rows} rows, max blocked write <= ${tier.budgetMs}ms`,
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 900_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    assert.notEqual(tailIndex, -1, "this probe is bound to 0411, which must be in the journal");

    const dbName = `probe_0411_${process.pid}_${randomBytes(4).toString("hex")}`;
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
         VALUES ($1,'probe0283@example.test','P','fixture-value-not-a-credential')`,
        [USER],
      );
      await setup.query(`INSERT INTO servers (id,name,slug,owner_id) VALUES ($1,'P','p0411',$2)`, [SERVER, USER]);
      await setup.query(`INSERT INTO agents (id,server_id,name) VALUES ($1,$2,'probe-agent')`, [AGENT, SERVER]);
      await setup.query(`INSERT INTO channels (id,server_id,name) VALUES ($1,$2,'probe-channel')`, [CHANNEL, SERVER]);

      // Seed action_cards at scale. Each card needs its own message (message_id is UNIQUE), so this
      // is generated set-wise rather than row-by-row.
      await setup.query(
        `INSERT INTO messages (id, channel_id, sender_type, sender_id, content)
         SELECT gen_random_uuid(), $1, 'agent', $2, 'seed ' || g
           FROM generate_series(1, $3) g`,
        [CHANNEL, AGENT, CARD_ROWS],
      );
      await setup.query(
        `INSERT INTO action_cards (id, server_id, message_id, requester_agent_id, action_type, payload, state)
         SELECT gen_random_uuid(), $1, m.id, $2, 'agent:create', '{"type":"agent:create","name":"x"}'::jsonb, 'prepared'
           FROM messages m WHERE m.channel_id = $3`,
        [SERVER, AGENT, CHANNEL],
      );
      const seeded = await setup.query(`SELECT count(*)::int n FROM action_cards`);
      assert.equal(seeded.rows[0].n, CARD_ROWS, "the table must really be at the intended scale");

      // Concurrent writers doing what an OLD binary does to this table during a rolling deploy.
      const samples: Array<{ at: number; ms: number }> = [];
      const errors: Array<{ code?: string }> = [];
      for (let w = 0; w < WRITERS; w++) {
        writers.push((async () => {
          const c = new pg.Client({ connectionString: url, application_name: `card-writer-${w}` });
          c.on("error", () => {});
          await c.connect();
          while (!stop) {
            const started = Date.now();
            try {
              const msg = await c.query(
                `INSERT INTO messages (id, channel_id, sender_type, sender_id, content)
                 VALUES (gen_random_uuid(),$1,'agent',$2,'live') RETURNING id`,
                [CHANNEL, AGENT],
              );
              await c.query(
                `INSERT INTO action_cards (id, server_id, message_id, requester_agent_id, action_type, payload, state)
                 VALUES (gen_random_uuid(),$1,$2,$3,'agent:create','{"type":"agent:create","name":"y"}'::jsonb,'prepared')`,
                [SERVER, msg.rows[0].id, AGENT],
              );
              samples.push({ at: started, ms: Date.now() - started });
            } catch (err) {
              errors.push({ code: (err as { code?: string }).code });
            }
          }
          await c.end();
        })());
      }
      await new Promise((r) => setTimeout(r, 1500));

      const mig = new pg.Client({ connectionString: url, application_name: "migration-0411" });
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
        "no lock_timeout / statement_timeout on concurrent action-card writes",
      );
      assert.deepEqual(errors, [], "no concurrent action-card write may fail while 0411 runs");
      assert.ok(blocked.length > 0, "at least one write must overlap the migration, or this proves nothing");
      // ⭐ The budget is asserted, not just reported. A printed number regresses silently; this one
      // has to fail. Both tier values are owned by @Manjusaka (SRE DRI) -- see BUDGET_TIERS.
      assert.ok(
        maxBlocked <= budgetMs,
        `max blocked write ${maxBlocked}ms exceeds the ${budgetMs}ms ${tier.label} budget at `
        + `${CARD_ROWS} rows. ⛔ The remedy is NOT a larger budget: rebuild this index with `
        + `CREATE UNIQUE INDEX CONCURRENTLY as a post-migration step (see 5b0d302d2).`,
      );

      // The index landed and is EMPTY, which is the point: every pre-existing row has a NULL
      // dedupe_key, so the build cost is the heap scan, not the index.
      const idx = await setup.query(
        `SELECT indexrelid::regclass::text AS name, pg_relation_size(indexrelid) AS bytes
           FROM pg_index WHERE indexrelid = 'idx_action_cards_open_dedupe'::regclass`,
      );
      assert.equal(idx.rows[0].name, "idx_action_cards_open_dedupe", "the index must exist after the migration");
      const nulls = await setup.query(`SELECT count(*)::int n FROM action_cards WHERE dedupe_key IS NOT NULL`);
      assert.equal(nulls.rows[0].n, 0, "no existing card is constrained: every row keeps a NULL dedupe_key");

      // eslint-disable-next-line no-console -- the numbers are the deliverable
      console.log(
        `[0411 lock probe] tier=${tier.label} cardRows=${CARD_ROWS} migration=${migMs}ms `
        + `maxBlockedWrite=${maxBlocked}ms budget=${budgetMs}ms overlapping=${blocked.length} `
        + `indexBytes=${idx.rows[0].bytes} deadlocks=0 timeouts=0`,
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
}
