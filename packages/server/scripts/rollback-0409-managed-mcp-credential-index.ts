import pg from "pg";

// Rollback-only helper for 0409 (MCP Apps connections). 0409 dropped the
// one-credential-per-App unique index because an App may now have several
// Connections. Binaries from before 0409 save credentials with
// `ON CONFLICT (mcp_server_id)`, which needs a NON-partial unique index on
// exactly that column (the partial `idx_managed_mcp_credentials_default` is
// not an arbiter for it), so after rolling back past 0409 every credential
// save fails with 42P10 until this index is back.
//
// The index and multiple Connections exclude each other:
//   restore  run BEFORE pressing rollback (or after it, once extra Connections are removed). Refuses while any
//            App has more than one Connection (those need a human decision).
//   drop     run if the rollback is called off, or before rolling forward again; otherwise the new binary
//            cannot create a second Connection (23505).
// Not a migration: nothing on the normal deploy path runs this.
export const ROLLBACK_0409_INDEX_NAME = "idx_managed_mcp_credentials_server";
export const ROLLBACK_0409_STATEMENT_TIMEOUT =
  process.env.ROLLBACK_0409_STATEMENT_TIMEOUT?.trim() || "10min";
// CONCURRENTLY also waits for every older open transaction in the database; those waits block no
// writer, so a short lock_timeout would only make the restore fail on a busy primary.
export const ROLLBACK_0409_LOCK_TIMEOUT = process.env.ROLLBACK_0409_LOCK_TIMEOUT?.trim() || "2min";

export const CREATE_ROLLBACK_0409_INDEX_SQL = `
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${ROLLBACK_0409_INDEX_NAME}"
  ON "managed_mcp_credentials" USING btree ("mcp_server_id")
`;
export const DROP_ROLLBACK_0409_INDEX_SQL = `DROP INDEX CONCURRENTLY IF EXISTS "${ROLLBACK_0409_INDEX_NAME}"`;

export type Rollback0409Duplicate = { mcpServerId: string; connections: number; defaults: number };
export type Rollback0409IndexStatus = { exists: boolean; isUnique: boolean; isValid: boolean; columns: string[]; predicate: string | null };

type Queryable = Pick<pg.ClientBase, "query">;

export async function findAppsWithSeveralConnections(client: Queryable): Promise<Rollback0409Duplicate[]> {
  const result = await client.query<{ mcpServerId: string; connections: number; defaults: number }>(
    `SELECT mcp_server_id::text AS "mcpServerId",
            count(*)::int AS "connections",
            (count(*) FILTER (WHERE is_server_default))::int AS "defaults"
       FROM managed_mcp_credentials
      GROUP BY mcp_server_id
     HAVING count(*) > 1
      ORDER BY count(*) DESC, mcp_server_id`,
  );
  return result.rows;
}

export async function readRollback0409IndexStatus(client: Queryable): Promise<Rollback0409IndexStatus> {
  const result = await client.query<{ isUnique: boolean; isValid: boolean; columns: string[] | string | null; predicate: string | null }>(
    `SELECT i.indisunique AS "isUnique",
            i.indisvalid AND i.indisready AS "isValid",
            array_agg(a.attname ORDER BY key.ordinality) AS "columns",
            pg_get_expr(i.indpred, i.indrelid) AS "predicate"
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index i ON i.indexrelid = idx.oid
       JOIN pg_class tbl ON tbl.oid = i.indrelid
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = key.attnum
      WHERE ns.nspname = 'public' AND tbl.relname = 'managed_mcp_credentials' AND idx.relname = $1
      GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid`,
    [ROLLBACK_0409_INDEX_NAME],
  );
  const row = result.rows[0];
  if (!row) return { exists: false, isUnique: false, isValid: false, columns: [], predicate: null };
  const columns = Array.isArray(row.columns)
    ? row.columns
    : (row.columns ?? "").replace(/^\{|\}$/g, "").split(",").map((c) => c.trim()).filter(Boolean);
  return { exists: true, isUnique: row.isUnique, isValid: row.isValid, columns, predicate: row.predicate };
}

export function isRestoredIndex(status: Rollback0409IndexStatus): boolean {
  return status.exists && status.isUnique && status.isValid
    && status.columns.join(",") === "mcp_server_id" && status.predicate === null;
}

export function describeRollback0409Status(status: Rollback0409IndexStatus, duplicates: Rollback0409Duplicate[]): string {
  const index = status.exists
    ? `${ROLLBACK_0409_INDEX_NAME}: exists unique=${status.isUnique} valid=${status.isValid} columns=${status.columns.join(",")} predicate=${status.predicate ?? "(none)"}`
    : `${ROLLBACK_0409_INDEX_NAME}: missing`;
  const dups = duplicates.length === 0
    ? "apps with several connections: 0"
    : `apps with several connections: ${duplicates.length}\n${duplicates
      .map((d) => `  mcp_server_id=${d.mcpServerId} connections=${d.connections} defaults=${d.defaults}`)
      .join("\n")}`;
  return `${index}\n${dups}`;
}

async function setTimeouts(client: Queryable): Promise<void> {
  await client.query(`SELECT set_config('statement_timeout', $1, false)`, [ROLLBACK_0409_STATEMENT_TIMEOUT]);
  await client.query(`SELECT set_config('lock_timeout', $1, false)`, [ROLLBACK_0409_LOCK_TIMEOUT]);
}

export type RestoreOutcome =
  | { kind: "already_present" }
  | { kind: "created" }
  | { kind: "refused_duplicates"; duplicates: Rollback0409Duplicate[] };

/** Restore the pre-0409 unique index. Never deletes or edits credential rows. */
export async function restoreRollback0409Index(client: Queryable): Promise<RestoreOutcome> {
  const before = await readRollback0409IndexStatus(client);
  if (isRestoredIndex(before)) return { kind: "already_present" };
  const duplicates = await findAppsWithSeveralConnections(client);
  if (duplicates.length > 0) return { kind: "refused_duplicates", duplicates };
  await setTimeouts(client);
  // A failed earlier CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would skip.
  if (before.exists) await client.query(DROP_ROLLBACK_0409_INDEX_SQL);
  try {
    await client.query(CREATE_ROLLBACK_0409_INDEX_SQL);
  } catch (error) {
    // A Connection inserted during the build (23505) leaves an invalid index behind: clean it up.
    await client.query(DROP_ROLLBACK_0409_INDEX_SQL).catch((cleanupError: unknown) => {
      console.error(
        `could not drop the invalid ${ROLLBACK_0409_INDEX_NAME} after a failed build; ` +
          `re-run --restore (it drops an invalid index first): ${String(cleanupError)}`,
      );
    });
    throw error;
  }
  const after = await readRollback0409IndexStatus(client);
  if (!isRestoredIndex(after)) {
    throw new Error(`${ROLLBACK_0409_INDEX_NAME} was created but is not a valid unique index on (mcp_server_id)`);
  }
  return { kind: "created" };
}

/** Drop the restored index again before rolling forward to a 0409+ binary. */
export async function dropRollback0409Index(client: Queryable): Promise<{ kind: "dropped" | "absent" }> {
  const before = await readRollback0409IndexStatus(client);
  if (!before.exists) return { kind: "absent" };
  await setTimeouts(client);
  await client.query(DROP_ROLLBACK_0409_INDEX_SQL);
  return { kind: "dropped" };
}
