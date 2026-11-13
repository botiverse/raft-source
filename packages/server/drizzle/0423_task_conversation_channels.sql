-- Task v2 conversations (#wg-task-v2), in four migrations, one table each
-- (task_conversation_follows, task_conversation_channels,
-- task_conversation_tasks, task_conversation_push_kind): each deploy phase is
-- its own transaction (src/db/migrationPhases.ts), so no table's lock is held
-- while the next one waits. A task's discussion is its own sub-conversation,
-- `channels.type = 'task'` with `channels.task_id`; `tasks.conversation_channel_id`
-- names the canonical one; thread_follows follow a task conversation through
-- `parent_task_id`. Every new column is NULL on existing rows, so constraints
-- are added NOT VALID (enforced for new writes, no scan under lock) and
-- validated by db:create-channels-task-conversation-indexes, which
-- db:migrate:deploy runs after the migrations, before the post-migration index
-- guard and before the new server starts; on a small table (tests, dev, fresh
-- environments) the migration builds its indexes itself.
-- This one: channels.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_task_id_matches_type" CHECK (("channels"."type" = 'task') = ("channels"."task_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
-- The partial indexes on `channels` (every thread is a channels row; the
-- task_id one serves the cascade from tasks) are
-- built here only on a small table (tests, dev, fresh environments). On a
-- large one a plain CREATE INDEX would block channel/thread writes for the
-- whole table scan, so the migration leaves them to
--   pnpm --filter @botiverse/raft-server db:create-channels-task-conversation-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready), run
-- once after this migration (it needs channels.task_id); the post-migration
-- index check (src/db/postMigrationIndexes.ts) reports them until then. Both
-- predicates match no existing row (type 'task' is new), and nothing creates
-- task conversations until task_v2_conversations_v0 is on for a server.
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.channels'::regclass) <= 100000 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_channels_active_task_parent" ON "channels" USING btree ("task_id","parent_channel_id") WHERE type = 'task' and deleted_at is null;
    CREATE INDEX IF NOT EXISTS "idx_channels_task_parent_channel" ON "channels" USING btree ("parent_channel_id","id") WHERE type = 'task' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS "idx_channels_task_id" ON "channels" USING btree ("task_id") WHERE task_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'channels is large: run db:create-channels-task-conversation-indexes (CONCURRENTLY) to build idx_channels_active_task_parent, idx_channels_task_parent_channel and idx_channels_task_id';
  END IF;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "channels_derive_parent_channel_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."type" = 'thread' AND NEW."parent_message_id" IS NOT NULL THEN
    NEW."parent_channel_id" := (
      SELECT parent_message."channel_id"
      FROM "messages" parent_message
      WHERE parent_message."id" = NEW."parent_message_id"
    );
  ELSIF NEW."type" = 'task' THEN
    -- A joint local projection names its server's local channel explicitly;
    -- the canonical conversation derives the task's channel.
    IF NEW."parent_channel_id" IS NULL THEN
      NEW."parent_channel_id" := (
        SELECT parent_task."channel_id"
        FROM "tasks" parent_task
        WHERE parent_task."id" = NEW."task_id"
      );
    END IF;
  ELSE
    NEW."parent_channel_id" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
