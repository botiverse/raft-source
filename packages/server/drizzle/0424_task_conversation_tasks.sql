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
-- This one: tasks.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "conversation_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_channel_id_channels_id_fk" FOREIGN KEY ("conversation_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
-- The same rule for `tasks`: the unique index on conversation_channel_id
-- (every existing row is NULL) and the validation of its foreign key run here
-- only on a small table. On a large one this migration already holds
-- `tasks` (ADD COLUMN), so a scan here would block task writes for its whole
-- length; db:create-channels-task-conversation-indexes builds the index
-- CONCURRENTLY and validates the constraint (SHARE UPDATE EXCLUSIVE, writes
-- go on) afterwards. Until then the constraint is enforced for new writes
-- (NOT VALID), and a task's conversation is written once, under its row lock.
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.tasks'::regclass) <= 100000 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_tasks_conversation_channel_id" ON "tasks" USING btree ("conversation_channel_id");
    ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_conversation_channel_id_channels_id_fk";
  ELSE
    RAISE NOTICE 'tasks is large: run db:create-channels-task-conversation-indexes (CONCURRENTLY) to build idx_tasks_conversation_channel_id and validate tasks_conversation_channel_id_channels_id_fk';
  END IF;
END
$$;--> statement-breakpoint
-- A task moving channel (channel conversion) re-derives its canonical
-- conversation's parent channel, like messages_follow_parent_channel_id does
-- for a thread's parent message.
CREATE OR REPLACE FUNCTION "tasks_follow_conversation_parent_channel_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."conversation_channel_id" IS NOT NULL THEN
    UPDATE "channels"
    SET "parent_channel_id" = NEW."channel_id"
    WHERE "id" = NEW."conversation_channel_id"
      AND "type" = 'task'
      AND "parent_channel_id" IS DISTINCT FROM NEW."channel_id";
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "tasks_conversation_parent_channel_id_follow"
AFTER UPDATE OF "channel_id" ON "tasks"
FOR EACH ROW
WHEN (OLD."channel_id" IS DISTINCT FROM NEW."channel_id")
EXECUTE FUNCTION "tasks_follow_conversation_parent_channel_id"();
