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
-- This one: mobile_push_outbox.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Task conversation facts reach the phone push outbox (kind 'task'). Widening
-- an IN list: existing rows already satisfy it, so NOT VALID skips the scan.
ALTER TABLE "mobile_push_outbox" DROP CONSTRAINT "mobile_push_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "mobile_push_outbox" ADD CONSTRAINT "mobile_push_outbox_kind_check" CHECK ("mobile_push_outbox"."kind" IN ('channel', 'dm', 'thread', 'task')) NOT VALID;
