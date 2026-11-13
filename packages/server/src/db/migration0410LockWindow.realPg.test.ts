/**
 * Real-PostgreSQL rolling-deploy probe for the MCP Apps connection model:
 * `0409_managed_mcp_connection_model` and `0410_managed_mcp_connection_binding`.
 *
 * Both files alter LIVE tables that the binary in production keeps writing while a deploy rolls:
 *   0409  managed_mcp_credentials: DROP the one-credential-per-App UNIQUE index, add Connection
 *         columns (constant defaults, metadata-only), build the one-default-per-App index, backfill
 *         status from managed_mcp_servers
 *   0410  managed_mcp_assignments: add connection_mode (constant default) and bound_connection_id,
 *         FK + CHECK
 * The deploy runner executes each file in ONE transaction, so every lock is held until commit.
 *
 * Old-binary statements run concurrently and the assertions are about THEM:
 *   · its credential read (join on mcp_server_id, LIMIT 1) never fails
 *   · its assignment upsert (enabled / allowed_tools only) never fails, and never disturbs the new
 *     columns
 *   · its credential upsert, `ON CONFLICT (mcp_server_id)`, has no arbiter once 0409 has dropped the
 *     index. That failure is ACCEPTED (#wg-mcp, 2026-10-14: rare, retryable, no data at risk) and
 *     the probe asserts it is the only kind of failure, with the exact error, after 0409 commits.
 *   · no deadlock, no lock_timeout / statement_timeout
 *
 * Default-skipped. Run it with:
 *
 *   docker run -d --name pg0410 -e POSTGRES_PASSWORD=probe -p 55435:5432 postgres:16-alpine
 *   MIGRATION_0410_LOCKS_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55435/postgres \
 *     pnpm --filter @botiverse/raft-server test:migration-0410-locks
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { test } from "vitest";

const REAL_PG_URL_ENV = "MIGRATION_0410_LOCKS_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.MIGRATION_0410_LOCKS_REAL_PG_REQUIRED === "1";

// Production values; `scripts/migrate-deploy.ts` sets these only when
// SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED === "true", which both deploy workflows do.
const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 60000;

const MCP_ROWS = Number(process.env.MIGRATION_0410_LOCKS_MCP_ROWS ?? 2000);
const WRITERS = 4;

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string }>;
};
const tags = journal.entries.map((e) => e.tag);
const FIRST = "0409_managed_mcp_connection_model";
const SECOND = "0410_managed_mcp_connection_binding";
const firstIndex = tags.indexOf(FIRST);
const sqlFor = (tag: string) => readFileSync(`${drizzleDir}/${tag}.sql`, "utf8");

const USER = "00000000-0000-4000-8000-000000000001";
const SERVER = "00000000-0000-4000-8000-0000000000a1";

test(
  "0409–0410 keep the production binary's MCP reads and assignment writes working through the deploy",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 300_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    assert.notEqual(firstIndex, -1, "0409 must be in the journal");
    assert.equal(tags[firstIndex + 1], SECOND, "0410 must follow 0409 directly");

    const dbName = `probe_0410_${process.pid}_${randomBytes(4).toString("hex")}`;
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
    const workers: Array<Promise<void>> = [];

    try {
      for (const tag of tags.slice(0, firstIndex)) {
        await setup.query("BEGIN");
        await setup.query(sqlFor(tag));
        await setup.query("COMMIT");
      }
      await setup.query(
        `INSERT INTO users (id,email,name,password_hash)
         VALUES ($1,'probe0410@example.test','A','fixture-value-not-a-credential')`,
        [USER],
      );
      await setup.query(`INSERT INTO servers (id,name,slug,owner_id) VALUES ($1,'P','p',$2)`, [SERVER, USER]);

      // The production shape: one credential per MCP server, one Agent assignment per MCP server.
      const mcpIds: string[] = [];
      const agentIds: string[] = [];
      for (let i = 0; i < MCP_ROWS; i++) {
        const mcpId = randomUUID();
        const agentId = randomUUID();
        mcpIds.push(mcpId);
        agentIds.push(agentId);
        await setup.query(
          `INSERT INTO managed_mcp_servers (id,server_id,name,auth_mode,endpoint_url) VALUES ($1,$2,$3,'headers',$4)`,
          [mcpId, SERVER, `mcp ${i}`, `https://example.test/${i}`],
        );
        await setup.query(
          `INSERT INTO managed_mcp_credentials (id,server_id,mcp_server_id,header_names)
           VALUES (gen_random_uuid(),$1,$2,'["X-Api-Key"]'::jsonb)`,
          [SERVER, mcpId],
        );
        await setup.query(`INSERT INTO agents (id,server_id,name) VALUES ($1,$2,$3)`, [agentId, SERVER, `agent-${i}`]);
        await setup.query(
          `INSERT INTO managed_mcp_assignments (server_id,agent_id,mcp_server_id,enabled,allowed_tools)
           VALUES ($1,$2,$3,true,NULL)`,
          [SERVER, agentId, mcpId],
        );
      }

      const blocked: number[] = [];
      const spans: Array<{ start: number; end: number }> = [];
      const readOrAssignmentErrors: Array<{ code?: string; message?: string }> = [];
      const credentialUpsertErrors: Array<{ code?: string; message?: string; at: number }> = [];
      let migration0409CommittedAt = Number.POSITIVE_INFINITY;

      for (let w = 0; w < WRITERS; w++) {
        workers.push(
          (async () => {
            const c = new pg.Client({ connectionString: url, application_name: `prod-binary-${w}` });
            c.on("error", () => {});
            await c.connect();
            let n = 0;
            while (!stop) {
              const i = (n + w * 7) % mcpIds.length;
              const started = Date.now();
              try {
                // (a) Credential read, exactly as the production binary does it.
                await c.query(
                  `SELECT c.id FROM managed_mcp_servers s
                     LEFT JOIN managed_mcp_credentials c ON c.mcp_server_id = s.id
                    WHERE s.id = $1 LIMIT 1`,
                  [mcpIds[i]],
                );
                // (b) Assignment upsert, the only columns the production binary knows.
                await c.query(
                  `INSERT INTO managed_mcp_assignments (server_id,agent_id,mcp_server_id,enabled,allowed_tools)
                   VALUES ($1,$2,$3,true,'["search"]'::jsonb)
                   ON CONFLICT (agent_id, mcp_server_id) DO UPDATE SET
                     enabled = excluded.enabled,
                     allowed_tools = excluded.allowed_tools,
                     assignment_version = managed_mcp_assignments.assignment_version + 1,
                     updated_at = now()`,
                  [SERVER, agentIds[i], mcpIds[i]],
                );
              } catch (error) {
                readOrAssignmentErrors.push(error as { code?: string; message?: string });
              }
              try {
                // (c) Credential save, `ON CONFLICT (mcp_server_id)` as the production binary writes it.
                await c.query(
                  `INSERT INTO managed_mcp_credentials (id,server_id,mcp_server_id,header_names)
                   VALUES (gen_random_uuid(),$1,$2,'["X-Api-Key"]'::jsonb)
                   ON CONFLICT (mcp_server_id) DO UPDATE SET header_names = excluded.header_names, updated_at = now()`,
                  [SERVER, mcpIds[i]],
                );
              } catch (error) {
                credentialUpsertErrors.push({ ...(error as { code?: string; message?: string }), at: Date.now() });
              }
              const ended = Date.now();
              spans.push({ start: started, end: ended });
              if (ended - started > 50) blocked.push(ended - started);
              n++;
            }
            await c.end();
          })(),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      const mig = new pg.Client({ connectionString: url, application_name: "migration-0409-0410" });
      mig.on("error", () => {});
      await mig.connect();
      await mig.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await mig.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      const migStarted = Date.now();
      for (const tag of [FIRST, SECOND]) {
        await mig.query("BEGIN");
        await mig.query(sqlFor(tag));
        await mig.query("COMMIT");
        if (tag === FIRST) migration0409CommittedAt = Date.now();
      }
      const migEnded = Date.now();
      const migMs = migEnded - migStarted;
      await mig.end();
      await new Promise((resolve) => setTimeout(resolve, 300));
      stop = true;
      await Promise.all(workers);

      const overlapping = spans.filter((span) => span.start <= migEnded && span.end >= migStarted).length;
      assert.ok(overlapping > 0, "at least one production-binary round must overlap the migration, or this proves nothing");
      assert.deepEqual(readOrAssignmentErrors, [], "⭐ the production binary's reads and assignment writes never fail");
      // The accepted failure, and only it: no arbiter for ON CONFLICT (mcp_server_id) once 0409 has
      // committed. 42P10 = invalid_column_reference ("no unique or exclusion constraint matching").
      for (const error of credentialUpsertErrors) {
        assert.equal(error.code, "42P10", `unexpected credential-save failure: ${error.code} ${error.message}`);
        assert.ok(error.at >= migration0409CommittedAt, "credential saves only fail after 0409 committed");
      }

      // Every pre-existing credential is its App's server default; every assignment follows it,
      // and the production binary's later writes did not disturb the new columns.
      const notDefault = await setup.query(
        `SELECT count(*)::int AS n FROM managed_mcp_credentials WHERE NOT is_server_default`,
      );
      assert.equal(notDefault.rows[0].n, 0);
      const moved = await setup.query(
        `SELECT count(*)::int AS n FROM managed_mcp_assignments
          WHERE connection_mode <> 'default' OR bound_connection_id IS NOT NULL`,
      );
      assert.equal(moved.rows[0].n, 0);

      // eslint-disable-next-line no-console -- the numbers are the deliverable
      console.log(
        `[0409-0410 rolling probe] mcpRows=${MCP_ROWS} migration=${migMs}ms `
        + `maxBlocked=${blocked.length ? Math.max(...blocked) : 0}ms overlappingRounds=${overlapping} `
        + `credentialSaveFailuresAfter0409=${credentialUpsertErrors.length}`,
      );
    } finally {
      stop = true;
      await Promise.allSettled(workers);
      await setup.end().catch(() => {});
      const cleanup = new pg.Client({ connectionString: REAL_PG_URL });
      cleanup.on("error", () => {});
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanup.end();
    }
  },
);
