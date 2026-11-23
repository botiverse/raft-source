-- Live threads by name. resolveThreadByShortId (every `#channel:<short id>`
-- target) looks a thread up by `name = 'thread-<short id>'` within a server;
-- no index covered thread names (idx_channels_server_name_type is for
-- channel/private/joint only), so it read every channel row of the server:
-- 13,145 pages, 89 ms on production's largest server, ~11 calls/s.
-- Not unique: short ids can collide (the lookup has a fallback for that).
--
-- channels is hot: like 0659, built here only on a tiny table (tests, dev), by
-- physical size. On a larger one the migration only notes it, and
-- db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
-- Additive only: until it is built, the lookup scans as before.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.channels'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_channels_thread_server_name" ON "channels" USING btree ("server_id", "name") WHERE type = 'thread' AND deleted_at IS NULL;
  ELSE
    RAISE NOTICE 'channels is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_channels_thread_server_name';
  END IF;
END
$$;
