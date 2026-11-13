-- The Tasks page's sorted board walks (GET /api/tasks/server?sort=).
--   tasks.last_activity_at  set to now() when a task is created, when its
--     status, assignee, title or description changes, and when a chat message
--     is posted in its own conversation (taskService). Nullable, no default,
--     no backfill: tasks is large (hundreds of thousands of rows), and adding
--     a nullable column without a default rewrites no rows. Readers use
--     COALESCE(last_activity_at, updated_at), so older rows sort by their
--     last write. During the rolling deploy older nodes write without it.
--   idx_tasks_channel_activity  (channel_id, COALESCE(last_activity_at,
--     updated_at) DESC, id DESC): sort=activity, each visible channel's tasks
--     newest activity first, in the keyset's order.
--   idx_tasks_channel_created  (channel_id, created_at DESC, id DESC): the
--     same for sort=created.
--
-- Bounded lock wait for the ADD COLUMN: give up after 2 s (the deploy
-- retries) rather than queue writes behind a long transaction.
--
-- Like 0647: the indexes are built here only on a tiny table (tests, dev), by
-- physical size. On a larger one the migration only notes them, and
-- db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS; an invalid index left by an
-- interrupted build is dropped CONCURRENTLY and built again; then
-- indisvalid/indisready; scripts/device-session-key-indexes.ts) before the
-- post-migration index guard. Until they are built the sorted walks read each
-- channel's rows through the existing channel indexes and sort them.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.tasks'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_tasks_channel_activity" ON "tasks" USING btree ("channel_id",COALESCE("last_activity_at", "updated_at") DESC,"id" DESC);
    CREATE INDEX IF NOT EXISTS "idx_tasks_channel_created" ON "tasks" USING btree ("channel_id","created_at" DESC,"id" DESC);
  ELSE
    RAISE NOTICE 'tasks is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_tasks_channel_activity and idx_tasks_channel_created';
  END IF;
END
$$;
