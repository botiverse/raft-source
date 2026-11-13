-- The server task board's Creator / Assignee filters and relation tabs
-- (GET /api/tasks/server board filters, GET /api/tasks/server/counts;
-- taskService.countServerTasks / listServerTasksPage) read one person's or
-- agent's tasks across every visible channel. Only claimed_by_id had an index,
-- and only for agent claims (idx_tasks_claimed_by_agent):
--   idx_tasks_created_by  (created_by_type, created_by_id): Creator filter,
--     created_by_me;
--   idx_tasks_claimed_by  (claimed_by_type, claimed_by_id), claimed rows only:
--     Assignee filter, assigned_to_me. "unassigned" reads through the channel
--     indexes, so unclaimed rows stay out of it.
--
-- Like 0609: built here only on a tiny table (tests, dev), by physical size.
-- On a larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.tasks'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_tasks_created_by" ON "tasks" USING btree ("created_by_type","created_by_id");
    CREATE INDEX IF NOT EXISTS "idx_tasks_claimed_by" ON "tasks" USING btree ("claimed_by_type","claimed_by_id") WHERE claimed_by_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'tasks is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_tasks_created_by and idx_tasks_claimed_by';
  END IF;
END
$$;
