-- Unified notifications (see notification_outbox): a thread's (or task
-- conversation's) notification level, written by PUT /notification-levels.
-- NULL = never set: the level derives from the follow state (a manual follow
-- still on = all, unfollowed = mentions, otherwise default), so no existing
-- row needs a backfill. A nullable column without a default is catalog-only;
-- the check is added NOT VALID (every existing row is NULL and passes) and
-- validated by db:create-notification-outbox-event-key-index after the
-- migrations, which takes SHARE UPDATE EXCLUSIVE and lets writes go on.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "thread_follows" ADD COLUMN "notification_level" text;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_notification_level_check" CHECK ("thread_follows"."notification_level" IS NULL OR "thread_follows"."notification_level" IN ('default', 'all', 'mentions', 'none')) NOT VALID;
