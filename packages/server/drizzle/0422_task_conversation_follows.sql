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
-- This one: thread_follows.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "thread_follows" ALTER COLUMN "parent_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_parent_present" CHECK ("thread_follows"."parent_message_id" IS NOT NULL OR "thread_follows"."parent_task_id" IS NOT NULL) NOT VALID;--> statement-breakpoint
-- The cascade from tasks: deleting a task finds its follows by this index
-- (built here only on a small table; else by the deploy step, CONCURRENTLY).
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.thread_follows'::regclass) <= 100000 THEN
    CREATE INDEX IF NOT EXISTS "idx_thread_follows_parent_task_id" ON "thread_follows" USING btree ("parent_task_id") WHERE parent_task_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'thread_follows is large: db:create-channels-task-conversation-indexes builds idx_thread_follows_parent_task_id (CONCURRENTLY)';
  END IF;
END
$$;
