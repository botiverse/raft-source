-- idx_user_channel_read_cursors_marked_unread: a person's conversations marked
-- unread (0479), read on every sidebar summary and Activity load
-- (loadMarkedUnreadScopes). Partial: only marked rows, normally none.
--
-- Migrations run inside a transaction, so CREATE INDEX CONCURRENTLY cannot run
-- here, and a plain CREATE INDEX holds a write lock on user_channel_read_cursors
-- (written on every read report) for the whole scan. As in daemons_fk_indexes,
-- it is built here only on a small table (tests, dev, fresh environments). On a
-- larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-read-cursor-marked-unread-index
-- after the migrations and before the post-migration index guard (which lists
-- it): CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready
-- (scripts/read-cursor-marked-unread-index.ts).
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.user_channel_read_cursors'::regclass) <= 10000 THEN
    CREATE INDEX IF NOT EXISTS "idx_user_channel_read_cursors_marked_unread" ON "user_channel_read_cursors" USING btree ("user_id") WHERE marked_unread;
  ELSE
    RAISE NOTICE 'user_channel_read_cursors is large: run db:create-read-cursor-marked-unread-index (CONCURRENTLY) to build idx_user_channel_read_cursors_marked_unread';
  END IF;
END
$$;
