import pg from "pg";

// Sync horizon "late" reads (migration messages_insert_xid): the partial index
// on messages.insert_xid. messages is large and on every send path, so the
// migration only adds the column and its trigger; every deploy runs
//   pnpm --filter @botiverse/raft-server db:create-messages-insert-xid-index
// inside db:migrate:deploy, after the migrations and before the post-migration
// index guard (verify-post-migration-indexes, src/db/postMigrationIndexes.ts):
// CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready (an
// invalid index left by an interrupted build is dropped CONCURRENTLY and built
// again). Idempotent: a rerun on a ready index is one catalog read.
// Readers work without it (only clients that know a horizon send the late arm,
// and it is bounded by LIMIT); the index keeps that arm a range scan.
// Run it against the DIRECT (non "-pooler") DATABASE_URL: timeouts are set with
// session-level set_config, which a transaction-mode pooler may not carry over.
export const INSERT_XID_INDEX_NAME = "idx_messages_insert_xid";
export const INSERT_XID_INDEX_COLUMNS = "insert_xid";
export const INSERT_XID_INDEX_PREDICATE = "(insert_xid IS NOT NULL)";
export const INSERT_XID_INDEX_STATEMENT_TIMEOUT =
  process.env.MESSAGES_INSERT_XID_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const INSERT_XID_INDEX_LOCK_TIMEOUT =
  process.env.MESSAGES_INSERT_XID_INDEX_LOCK_TIMEOUT?.trim() || "30s";

export const CREATE_INSERT_XID_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INSERT_XID_INDEX_NAME}"
  ON "messages" USING btree ("insert_xid")
  WHERE insert_xid IS NOT NULL
`;

export type InsertXidIndexStatus = {
  exists: boolean;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  columns: string[];
  predicate: string | null;
};

type IndexRow = {
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  columns: string[] | string | null;
  predicate: string | null;
};

type Queryable = Pick<pg.PoolClient, "query">;

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function createPool(databaseUrl = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 1 });
}

/** False on a database whose migrations predate messages_insert_xid (a deploy test's own migrations folder). */
export async function insertXidColumnExists(client: Queryable): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'insert_xid'
     ) AS "exists"`,
  );
  return result.rows[0]?.exists === true;
}

export async function readInsertXidIndexStatus(client: Queryable): Promise<InsertXidIndexStatus> {
  const result = await client.query<IndexRow>(
    `
      SELECT
        i.indisunique AS "isUnique",
        i.indisvalid AS "isValid",
        i.indisready AS "isReady",
        array_agg(a.attname ORDER BY key.ordinality) AS "columns",
        pg_get_expr(i.indpred, i.indrelid) AS "predicate"
      FROM pg_class idx
      JOIN pg_namespace ns ON ns.oid = idx.relnamespace
      JOIN pg_index i ON i.indexrelid = idx.oid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        ON true
      JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = key.attnum
      WHERE ns.nspname = 'public'
        AND tbl.relname = 'messages'
        AND idx.relname = $1
      GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid
    `,
    [INSERT_XID_INDEX_NAME],
  );
  const row = result.rows[0];
  if (!row) {
    return { exists: false, isUnique: false, isValid: false, isReady: false, columns: [], predicate: null };
  }
  return {
    exists: true,
    isUnique: row.isUnique,
    isValid: row.isValid,
    isReady: row.isReady,
    columns: normalizeColumns(row.columns),
    predicate: row.predicate,
  };
}

export function assertInsertXidIndexReady(status: InsertXidIndexStatus) {
  if (!status.exists) {
    throw new Error(`${INSERT_XID_INDEX_NAME} is missing`);
  }
  if (status.isUnique) {
    throw new Error(`${INSERT_XID_INDEX_NAME} must not be unique`);
  }
  if (!status.isValid || !status.isReady) {
    throw new Error(
      `${INSERT_XID_INDEX_NAME} exists but is not ready/valid; drop the invalid index concurrently before retrying`,
    );
  }
  if (status.columns.join(",") !== INSERT_XID_INDEX_COLUMNS) {
    throw new Error(`${INSERT_XID_INDEX_NAME} has unexpected columns: ${status.columns.join(",")}`);
  }
  if (status.predicate !== INSERT_XID_INDEX_PREDICATE) {
    throw new Error(`${INSERT_XID_INDEX_NAME} has unexpected predicate: ${status.predicate}`);
  }
}

export function describeInsertXidIndexStatus(status: InsertXidIndexStatus): string {
  if (!status.exists) return `${INSERT_XID_INDEX_NAME}: missing`;
  return [
    `${INSERT_XID_INDEX_NAME}: exists`,
    `unique=${status.isUnique}`,
    `valid=${status.isValid}`,
    `ready=${status.isReady}`,
    `columns=${status.columns.join(",") || "(none)"}`,
    `predicate=${status.predicate ?? "(none)"}`,
  ].join(" ");
}

function normalizeColumns(columns: string[] | string | null): string[] {
  if (!columns) return [];
  if (Array.isArray(columns)) return columns;
  return columns
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}
