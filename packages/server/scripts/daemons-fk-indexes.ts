import type pg from "pg";
import type { TaskConversationIndexSpec } from "./channels-task-conversation-indexes";

// Indexes behind the foreign keys to daemons that a machine delete follows
// (migration daemons_fk_indexes, #triage:67b94880). The migration builds them
// only on small tables; db:migrate:deploy then runs
//   pnpm --filter @botiverse/raft-server db:create-daemons-fk-indexes
// after the migrations and before the post-migration index guard: CREATE INDEX
// CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready (an invalid index left
// by an interrupted build is dropped CONCURRENTLY and built again). Idempotent.
// Run it against the DIRECT (non "-pooler") DATABASE_URL: timeouts are set with
// session-level set_config, which a transaction-mode pooler may not carry over.
export const DAEMONS_FK_INDEXES: readonly TaskConversationIndexSpec[] = [
  {
    // ON DELETE SET NULL; ~4.7M rows on production.
    name: "idx_agent_credentials_issued_by_machine",
    table: "agent_credentials",
    unique: false,
    columns: ["issued_by_machine_id"],
    predicate: "(issued_by_machine_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_issued_by_machine"
  ON "agent_credentials" USING btree ("issued_by_machine_id")
  WHERE issued_by_machine_id IS NOT NULL
`,
  },
  {
    // ON DELETE SET NULL.
    name: "idx_agents_daemon_id",
    table: "agents",
    unique: false,
    columns: ["daemon_id"],
    predicate: "(daemon_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agents_daemon_id"
  ON "agents" USING btree ("daemon_id")
  WHERE daemon_id IS NOT NULL
`,
  },
  {
    // ON DELETE CASCADE; ~2M rows on production.
    name: "idx_computer_outage_occurrences_machine",
    table: "computer_outage_occurrences",
    unique: false,
    columns: ["machine_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_computer_outage_occurrences_machine"
  ON "computer_outage_occurrences" USING btree ("machine_id")
`,
  },
];

export const DAEMONS_FK_INDEX_STATEMENT_TIMEOUT =
  process.env.DAEMONS_FK_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const DAEMONS_FK_INDEX_LOCK_TIMEOUT =
  process.env.DAEMONS_FK_INDEX_LOCK_TIMEOUT?.trim() || "30s";

/** False on a database whose migrations predate the indexed columns (a deploy test's own migrations folder). */
export async function daemonsFkColumnsExist(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) AS "count" FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('agent_credentials', 'issued_by_machine_id'), ('agents', 'daemon_id'), ('computer_outage_occurrences', 'machine_id'))`,
  );
  return Number(result.rows[0]?.count) === DAEMONS_FK_INDEXES.length;
}
