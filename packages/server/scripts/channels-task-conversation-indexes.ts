import pg from "pg";

// Task v2 indexes on large tables: the task conversation indexes on
// `channels` (migration task_conversation_channels; `channels` holds every
// thread), the ones on `tasks` (task_source_message_id,
// task_conversation_tasks) and on `thread_follows`
// (task_conversation_follows), including the indexes behind the two
// ON DELETE CASCADE foreign keys from tasks; then the validation of every
// constraint those migrations add NOT VALID. A plain CREATE INDEX / VALIDATE
// inside a migration holds a write lock for the whole table scan, so on a
// large table the migrations skip them (with a NOTICE) and every deploy runs
//   pnpm --filter @botiverse/raft-server db:create-channels-task-conversation-indexes
// inside db:migrate:deploy, after the migrations, before the post-migration
// index guard (verify-post-migration-indexes) and before the new server
// starts: CREATE INDEX
// CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready (an invalid index left
// by an interrupted build is dropped CONCURRENTLY and built again), then
// ALTER TABLE ... VALIDATE CONSTRAINT, which takes SHARE UPDATE EXCLUSIVE and
// lets writes go on. Every step is idempotent, so a rerun is a no-op.
// Empty/small databases (tests, dev, fresh environments) build the indexes
// inside the migrations as usual.
// Run it against the DIRECT (non "-pooler") DATABASE_URL: timeouts are set with
// session-level set_config, which a transaction-mode pooler may not carry over.

export type TaskConversationIndexSpec = {
  name: string;
  table: string;
  unique: boolean;
  columns: readonly string[];
  /** pg_get_expr(indpred) as PostgreSQL prints it; null for a full index. */
  predicate: string | null;
  createSql: string;
};

export const TASK_CONVERSATION_INDEXES: readonly TaskConversationIndexSpec[] = [
  {
    // The cascade from tasks (channels.task_id ON DELETE cascade): deleting a
    // task finds its conversations, live or soft-deleted, without a scan.
    name: "idx_channels_task_id",
    table: "channels",
    unique: false,
    columns: ["task_id"],
    predicate: "(task_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_channels_task_id"
  ON "channels" USING btree ("task_id")
  WHERE task_id IS NOT NULL
`,
  },
  {
    // The cascade from tasks (thread_follows.parent_task_id ON DELETE cascade).
    name: "idx_thread_follows_parent_task_id",
    table: "thread_follows",
    unique: false,
    columns: ["parent_task_id"],
    predicate: "(parent_task_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_thread_follows_parent_task_id"
  ON "thread_follows" USING btree ("parent_task_id")
  WHERE parent_task_id IS NOT NULL
`,
  },
  {
    // One live task conversation per (task, parent channel): the canonical
    // conversation and each joint server's local projection.
    name: "idx_channels_active_task_parent",
    table: "channels",
    unique: true,
    columns: ["task_id", "parent_channel_id"],
    predicate: "((type = 'task'::text) AND (deleted_at IS NULL))",
    createSql: `
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_channels_active_task_parent"
  ON "channels" USING btree ("task_id", "parent_channel_id")
  WHERE type = 'task' and deleted_at is null
`,
  },
  {
    // Task conversations under a parent channel (Files card, follow pruning,
    // inbox purge), like idx_channels_thread_parent_channel for threads.
    name: "idx_channels_task_parent_channel",
    table: "channels",
    unique: false,
    columns: ["parent_channel_id", "id"],
    predicate: "((type = 'task'::text) AND (deleted_at IS NULL))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_channels_task_parent_channel"
  ON "channels" USING btree ("parent_channel_id", "id")
  WHERE type = 'task' AND deleted_at IS NULL
`,
  },
  {
    // The tasks created from a message (migration task_source_message_id).
    name: "idx_tasks_source_message_id",
    table: "tasks",
    unique: false,
    columns: ["source_message_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_source_message_id"
  ON "tasks" USING btree ("source_message_id")
`,
  },
  {
    // One task per conversation (migration task_conversation_tasks).
    name: "idx_tasks_conversation_channel_id",
    table: "tasks",
    unique: true,
    columns: ["conversation_channel_id"],
    predicate: null,
    createSql: `
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_conversation_channel_id"
  ON "tasks" USING btree ("conversation_channel_id")
`,
  },
];

/**
 * Every constraint the task v2 migrations add NOT VALID (enforced for new
 * writes from the start): the `tasks` foreign keys (validated inline on a
 * small table), the foreign keys and checks on `channels` and
 * `thread_follows`, and the widened outbox kind check (it was validated
 * before task v2 widened it; the table is notification_outbox since migration
 * notification_outbox, the constraint keeps its name). VALIDATE CONSTRAINT is
 * idempotent and lets writes go on.
 */
export const TASK_V2_NOT_VALID_CONSTRAINTS: readonly { table: "tasks" | "channels" | "thread_follows" | "notification_outbox"; name: string }[] = [
  { table: "tasks", name: "tasks_source_message_id_messages_id_fk" },
  { table: "tasks", name: "tasks_conversation_channel_id_channels_id_fk" },
  { table: "channels", name: "channels_task_id_tasks_id_fk" },
  { table: "channels", name: "channels_task_id_matches_type" },
  { table: "thread_follows", name: "thread_follows_parent_task_id_tasks_id_fk" },
  { table: "thread_follows", name: "thread_follows_parent_present" },
  { table: "notification_outbox", name: "mobile_push_outbox_kind_check" },
];

export const TASK_CONVERSATION_INDEX_STATEMENT_TIMEOUT =
  process.env.CHANNELS_TASK_CONVERSATION_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const TASK_CONVERSATION_INDEX_LOCK_TIMEOUT =
  process.env.CHANNELS_TASK_CONVERSATION_INDEX_LOCK_TIMEOUT?.trim() || "30s";

export type TaskConversationIndexStatus = {
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

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return databaseUrl;
}

export function createPool(databaseUrl = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 1 });
}

export async function taskIdColumnExists(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'task_id'
     ) AS "exists"`,
  );
  return Boolean(result.rows[0]?.exists);
}

export async function assertTaskIdColumnExists(client: pg.PoolClient) {
  if (!(await taskIdColumnExists(client))) {
    throw new Error("channels.task_id is missing; it is added by the task_conversation_channels migration, so run this script after deploying it, or let that migration build the indexes on a small table");
  }
}

export async function readTaskConversationIndexStatus(
  client: pg.PoolClient,
  spec: Pick<TaskConversationIndexSpec, "name" | "table">,
): Promise<TaskConversationIndexStatus> {
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
        AND tbl.relname = $2
        AND idx.relname = $1
      GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid
    `,
    [spec.name, spec.table],
  );
  const row = result.rows[0];
  if (!row) return { exists: false, isUnique: false, isValid: false, isReady: false, columns: [], predicate: null };
  return {
    exists: true,
    isUnique: row.isUnique,
    isValid: row.isValid,
    isReady: row.isReady,
    columns: normalizeColumns(row.columns),
    predicate: row.predicate,
  };
}

export function assertTaskConversationIndexReady(spec: TaskConversationIndexSpec, status: TaskConversationIndexStatus) {
  if (!status.exists) throw new Error(`${spec.name} is missing`);
  if (status.isUnique !== spec.unique) throw new Error(`${spec.name} must ${spec.unique ? "" : "not "}be unique`);
  if (!status.isValid || !status.isReady) {
    throw new Error(`${spec.name} exists but is not ready/valid; drop the invalid index concurrently before retrying`);
  }
  if (status.columns.join(",") !== spec.columns.join(",")) {
    throw new Error(`${spec.name} has unexpected columns: ${status.columns.join(",")}`);
  }
  if ((status.predicate ?? "").replace(/[()\s]/g, "") !== (spec.predicate ?? "").replace(/[()\s]/g, "")) {
    throw new Error(`${spec.name} has unexpected predicate: ${status.predicate}`);
  }
}

export function describeTaskConversationIndexStatus(name: string, status: TaskConversationIndexStatus): string {
  if (!status.exists) return `${name}: missing`;
  return [
    `${name}: exists`,
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
  return columns.replace(/^\{|\}$/g, "").split(",").map((column) => column.trim()).filter(Boolean);
}

// A table's earlier name, for a database whose migrations stop before the rename.
const PREVIOUS_TABLE_NAMES: Readonly<Record<string, string>> = { notification_outbox: "mobile_push_outbox" };

/**
 * Whether a constraint exists and is validated (pg_constraint.convalidated),
 * and on which table (`notification_outbox`, or `mobile_push_outbox` before
 * the rename: the name a VALIDATE must use).
 */
export async function readConstraintValidated(
  client: pg.PoolClient,
  constraint: { table: string; name: string },
): Promise<{ exists: boolean; validated: boolean; table: string }> {
  const tables = [constraint.table, ...(PREVIOUS_TABLE_NAMES[constraint.table] ? [PREVIOUS_TABLE_NAMES[constraint.table]!] : [])];
  const result = await client.query<{ validated: boolean; table: string }>(
    `SELECT c.convalidated AS "validated", tbl.relname AS "table"
       FROM pg_constraint c
       JOIN pg_class tbl ON tbl.oid = c.conrelid
       JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public' AND tbl.relname = ANY($1::text[]) AND c.conname = $2
      ORDER BY tbl.relname = $3 DESC
      LIMIT 1`,
    [tables, constraint.name, constraint.table],
  );
  const row = result.rows[0];
  return row ? { exists: true, validated: row.validated, table: row.table } : { exists: false, validated: false, table: constraint.table };
}
