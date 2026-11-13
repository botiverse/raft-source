import type pg from "pg";
import type { TaskConversationIndexSpec } from "./channels-task-conversation-indexes";

// The closure used by joint preservation includes deleted/detached descendants.
// The active thread/task indexes cannot cover it. Build on a direct/session
// endpoint after migrations, outside any transaction; interrupted invalid
// indexes are rebuilt by the lifecycle runner before the deploy guard runs.
export const CHANNELS_PARENT_CHANNEL_INDEX: TaskConversationIndexSpec = {
  name: "idx_channels_parent_channel",
  table: "channels",
  unique: false,
  columns: ["parent_channel_id"],
  predicate: "(parent_channel_id IS NOT NULL)",
  createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_channels_parent_channel"
    ON "public"."channels" USING btree ("parent_channel_id") WHERE parent_channel_id IS NOT NULL`,
};
export const CHANNELS_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT =
  process.env.CHANNELS_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const CHANNELS_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT =
  process.env.CHANNELS_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT?.trim() || "30s";

export async function parentChannelColumnExists(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='channels' AND column_name='parent_channel_id'
  ) AS "exists"`);
  return result.rows[0]?.exists === true;
}
