import pg from "pg";

export const INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME =
  "idx_inbox_serving_rows_receiver_server_last_activity";
export const INBOX_SERVING_ROWS_INDEX_STATEMENT_TIMEOUT_MS = 1_800_000;
export const INBOX_SERVING_ROWS_INDEX_LOCK_TIMEOUT_MS = 30_000;

export const CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME}"
  ON "inbox_serving_rows" USING btree
    ("receiver_type", "receiver_id", "server_id", "last_activity_at")
`;

export type InboxServingRowsIndexStatus = {
  exists: boolean;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  accessMethod: string | null;
  columns: string[];
  predicate: string | null;
  definition: string | null;
};

type IndexRow = {
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  accessMethod: string;
  columns: string[] | string | null;
  predicate: string | null;
  definition: string | null;
};

function normalizeColumns(columns: string[] | string | null): string[] {
  if (!columns) return [];
  if (Array.isArray(columns)) return columns;
  return columns
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return databaseUrl;
}

export function getIndexCreationDatabaseUrl(): string {
  const databaseUrl = process.env.INBOX_SERVING_ROWS_INDEX_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "INBOX_SERVING_ROWS_INDEX_DATABASE_URL is required and must be a dedicated direct/session DSN",
    );
  }
  assertIndexCreationDatabaseUrlIsDirectSession(databaseUrl);
  return databaseUrl;
}

export function assertIndexCreationDatabaseUrlIsDirectSession(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("INBOX_SERVING_ROWS_INDEX_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("INBOX_SERVING_ROWS_INDEX_DATABASE_URL must use postgres:// or postgresql://");
  }
  if (parsed.hostname.toLowerCase().includes("pooler")) {
    throw new Error(
      "INBOX_SERVING_ROWS_INDEX_DATABASE_URL must use a direct/session endpoint, not a pooler host",
    );
  }
  const options = parsed.searchParams.get("options") ?? "";
  if (!/(?:^|\s)-c\s*statement_timeout=1800000(?:\s|$)/.test(options)) {
    throw new Error(
      "INBOX_SERVING_ROWS_INDEX_DATABASE_URL must set startup option statement_timeout=1800000",
    );
  }
  if (!/(?:^|\s)-c\s*lock_timeout=30000(?:\s|$)/.test(options)) {
    throw new Error(
      "INBOX_SERVING_ROWS_INDEX_DATABASE_URL must set startup option lock_timeout=30000",
    );
  }
}

export function createPool(databaseUrl = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 1 });
}

export function createIndexCreationPool(databaseUrl = getIndexCreationDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 1 });
}

export async function assertIndexCreationTimeouts(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit
     FROM pg_settings
     WHERE name IN ('statement_timeout', 'lock_timeout')`,
  );
  const settings = new Map(result.rows.map((row) => [row.name, row]));
  const statementTimeout = settings.get("statement_timeout");
  const lockTimeout = settings.get("lock_timeout");
  if (
    statementTimeout?.unit !== "ms"
    || Number(statementTimeout.setting) !== INBOX_SERVING_ROWS_INDEX_STATEMENT_TIMEOUT_MS
  ) {
    throw new Error(
      `index creation statement_timeout mismatch: expected ${INBOX_SERVING_ROWS_INDEX_STATEMENT_TIMEOUT_MS}ms, `
      + `got ${statementTimeout?.setting ?? "(missing)"}${statementTimeout?.unit ?? ""}`,
    );
  }
  if (
    lockTimeout?.unit !== "ms"
    || Number(lockTimeout.setting) !== INBOX_SERVING_ROWS_INDEX_LOCK_TIMEOUT_MS
  ) {
    throw new Error(
      `index creation lock_timeout mismatch: expected ${INBOX_SERVING_ROWS_INDEX_LOCK_TIMEOUT_MS}ms, `
      + `got ${lockTimeout?.setting ?? "(missing)"}${lockTimeout?.unit ?? ""}`,
    );
  }
}

export async function assertInboxServingRowsTableExists(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.inbox_serving_rows') IS NOT NULL AS "exists"`,
  );
  if (!result.rows[0]?.exists) {
    throw new Error("inbox_serving_rows is missing; run db:migrate before creating its receiver/server index");
  }
}

export async function readInboxServingRowsIndexStatus(
  client: pg.PoolClient,
): Promise<InboxServingRowsIndexStatus> {
  const result = await client.query<IndexRow>(
    `
      SELECT
        i.indisunique AS "isUnique",
        i.indisvalid AS "isValid",
        i.indisready AS "isReady",
        am.amname AS "accessMethod",
        array_agg(a.attname ORDER BY key.ordinality) AS "columns",
        pg_get_expr(i.indpred, i.indrelid) AS "predicate",
        pg_get_indexdef(idx.oid) AS "definition"
      FROM pg_class idx
      JOIN pg_namespace ns ON ns.oid = idx.relnamespace
      JOIN pg_index i ON i.indexrelid = idx.oid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_am am ON am.oid = idx.relam
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        ON key.attnum > 0
      JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = key.attnum
      WHERE ns.nspname = 'public'
        AND tbl.relname = 'inbox_serving_rows'
        AND idx.relname = $1
      GROUP BY
        i.indisunique,
        i.indisvalid,
        i.indisready,
        am.amname,
        i.indpred,
        i.indrelid,
        idx.oid
    `,
    [INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      exists: false,
      isUnique: false,
      isValid: false,
      isReady: false,
      accessMethod: null,
      columns: [],
      predicate: null,
      definition: null,
    };
  }
  return {
    exists: true,
    isUnique: row.isUnique,
    isValid: row.isValid,
    isReady: row.isReady,
    accessMethod: row.accessMethod,
    columns: normalizeColumns(row.columns),
    predicate: row.predicate,
    definition: row.definition,
  };
}

export function assertInboxServingRowsIndexReady(status: InboxServingRowsIndexStatus): void {
  const name = INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME;
  if (!status.exists) throw new Error(`${name} is missing`);
  if (status.isUnique) throw new Error(`${name} must not be unique`);
  if (!status.isValid || !status.isReady) {
    throw new Error(`${name} is not valid and ready`);
  }
  if (status.accessMethod !== "btree") {
    throw new Error(`${name} has unexpected access method: ${status.accessMethod ?? "(none)"}`);
  }
  if (status.columns.join(",") !== "receiver_type,receiver_id,server_id,last_activity_at") {
    throw new Error(`${name} has unexpected columns: ${status.columns.join(",")}`);
  }
  if (status.predicate !== null) {
    throw new Error(`${name} has unexpected predicate: ${status.predicate}`);
  }
}

export function describeInboxServingRowsIndexStatus(status: InboxServingRowsIndexStatus): string {
  const name = INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME;
  if (!status.exists) return `${name}: missing`;
  return [
    `${name}: exists`,
    `unique=${status.isUnique}`,
    `valid=${status.isValid}`,
    `ready=${status.isReady}`,
    `access=${status.accessMethod ?? "(none)"}`,
    `columns=${status.columns.join(",") || "(none)"}`,
    `predicate=${status.predicate ?? "(none)"}`,
  ].join(" ");
}
