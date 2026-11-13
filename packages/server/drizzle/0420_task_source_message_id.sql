-- Task v2: tasks.source_message_id, the chat message a task was created from
-- (one message, many tasks). Safe on a large `tasks` table:
--  - the column is nullable with no default (metadata-only);
--  - the foreign key is added NOT VALID: every existing row is NULL, new
--    writes are checked, and nothing scans `tasks` under this migration's
--    lock; it is validated below on a small table, else by the script;
--  - no backfill: a task from before task v2 hangs under its host message,
--    and every reader falls back to `message_id` when `source_message_id` is
--    NULL (taskService task DTO, messageTaskProjection, raft task view);
--  - idx_tasks_source_message_id is built here only on a small table; on a
--    large one a plain CREATE INDEX would block task writes for the whole
--    scan, so it is left to
--      pnpm --filter @botiverse/raft-server db:create-channels-task-conversation-indexes
--    (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then VALIDATE CONSTRAINT), and
--    the post-migration index check (src/db/postMigrationIndexes.ts) reports
--    it until then.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.tasks'::regclass) <= 100000 THEN
    CREATE INDEX IF NOT EXISTS "idx_tasks_source_message_id" ON "tasks" USING btree ("source_message_id");
    ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_source_message_id_messages_id_fk";
  ELSE
    RAISE NOTICE 'tasks is large: run db:create-channels-task-conversation-indexes (CONCURRENTLY) to build idx_tasks_source_message_id and validate tasks_source_message_id_messages_id_fk';
  END IF;
END
$$;
