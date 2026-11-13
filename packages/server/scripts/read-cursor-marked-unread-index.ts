import type pg from "pg";
import type { TaskConversationIndexSpec } from "./channels-task-conversation-indexes";

// The index behind a person's conversations marked unread (migration
// read_cursor_marked_unread_index). The migration builds it only on a small
// table; db:migrate:deploy then runs
//   pnpm --filter @botiverse/raft-server db:create-read-cursor-marked-unread-index
// after the migrations and before the post-migration index guard: CREATE INDEX
// CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready (an invalid index left
// by an interrupted build is dropped CONCURRENTLY and built again). Idempotent.
// Run it against the DIRECT (non "-pooler") DATABASE_URL: timeouts are set with
// session-level set_config, which a transaction-mode pooler may not carry over.
export const READ_CURSOR_MARKED_UNREAD_INDEX: TaskConversationIndexSpec = {
  name: "idx_user_channel_read_cursors_marked_unread",
  table: "user_channel_read_cursors",
  unique: false,
  columns: ["user_id"],
  predicate: "marked_unread",
  createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_user_channel_read_cursors_marked_unread"
  ON "user_channel_read_cursors" USING btree ("user_id")
  WHERE marked_unread
`,
};

export const READ_CURSOR_MARKED_UNREAD_INDEX_STATEMENT_TIMEOUT =
  process.env.READ_CURSOR_MARKED_UNREAD_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const READ_CURSOR_MARKED_UNREAD_INDEX_LOCK_TIMEOUT =
  process.env.READ_CURSOR_MARKED_UNREAD_INDEX_LOCK_TIMEOUT?.trim() || "30s";

/** False on a database whose migrations predate the column (a deploy test's own migrations folder). */
export async function readCursorMarkedUnreadColumnExists(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) AS "count" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_channel_read_cursors' AND column_name = 'marked_unread'`,
  );
  return Number(result.rows[0]?.count) === 1;
}
