import pg from "pg";

export const RANDOM_ID_INDEX_NAME = "idx_messages_user_random_id";
export const RANDOM_ID_INDEX_STATEMENT_TIMEOUT =
  process.env.MESSAGE_RANDOM_ID_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const RANDOM_ID_INDEX_LOCK_TIMEOUT =
  process.env.MESSAGE_RANDOM_ID_INDEX_LOCK_TIMEOUT?.trim() || "30s";

export const CREATE_RANDOM_ID_INDEX_SQL = `
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${RANDOM_ID_INDEX_NAME}"
  ON "messages" USING btree ("sender_id", "random_id")
  WHERE sender_type = 'user' and random_id is not null
`;

export type RandomIdIndexStatus = {
  exists: boolean;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  columns: string[];
  predicate: string | null;
  definition: string | null;
};

type IndexRow = {
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  columns: string[] | string | null;
  predicate: string | null;
  definition: string | null;
};

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

export async function assertRandomIdColumnExists(client: pg.PoolClient) {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'messages'
          AND column_name = 'random_id'
      ) AS "exists"
    `,
  );
  if (!result.rows[0]?.exists) {
    throw new Error(
      `messages.random_id is missing; run db:migrate before ${RANDOM_ID_INDEX_NAME}`,
    );
  }
}

export async function readRandomIdIndexStatus(
  client: pg.PoolClient,
): Promise<RandomIdIndexStatus> {
  const result = await client.query<IndexRow>(
    `
      SELECT
        i.indisunique AS "isUnique",
        i.indisvalid AS "isValid",
        i.indisready AS "isReady",
        array_agg(a.attname ORDER BY key.ordinality) AS "columns",
        pg_get_expr(i.indpred, i.indrelid) AS "predicate",
        pg_get_indexdef(idx.oid) AS "definition"
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
      GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid, idx.oid
    `,
    [RANDOM_ID_INDEX_NAME],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      exists: false,
      isUnique: false,
      isValid: false,
      isReady: false,
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
    columns: normalizeColumns(row.columns),
    predicate: row.predicate,
    definition: row.definition,
  };
}

export function assertRandomIdIndexReady(status: RandomIdIndexStatus) {
  if (!status.exists) {
    throw new Error(`${RANDOM_ID_INDEX_NAME} is missing`);
  }
  if (!status.isUnique) {
    throw new Error(`${RANDOM_ID_INDEX_NAME} exists but is not unique`);
  }
  if (!status.isValid || !status.isReady) {
    throw new Error(
      `${RANDOM_ID_INDEX_NAME} exists but is not ready/valid; drop the invalid index concurrently before retrying`,
    );
  }
  if (status.columns.join(",") !== "sender_id,random_id") {
    throw new Error(
      `${RANDOM_ID_INDEX_NAME} has unexpected columns: ${status.columns.join(",")}`,
    );
  }
  const predicate = normalizePredicate(status.predicate);
  if (
    !predicate.includes("sender_type") ||
    !predicate.includes("'user'") ||
    !predicate.includes("random_id is not null")
  ) {
    throw new Error(
      `${RANDOM_ID_INDEX_NAME} has unexpected predicate: ${status.predicate ?? "(none)"}`,
    );
  }
}

export function describeRandomIdIndexStatus(status: RandomIdIndexStatus): string {
  if (!status.exists) return `${RANDOM_ID_INDEX_NAME}: missing`;
  return [
    `${RANDOM_ID_INDEX_NAME}: exists`,
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

function normalizePredicate(predicate: string | null): string {
  return (predicate ?? "")
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/::text/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
