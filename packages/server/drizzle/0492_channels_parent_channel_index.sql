-- Full joint-family closure includes soft-deleted threads and detached task
-- conversations. The active-only parent indexes cannot serve that traversal.
-- Build normally only for tiny tables (tests/dev); physical size avoids trusting
-- stale reltuples on an unanalysed large table. Large tables are built after
-- migration COMMIT by db:create-channels-parent-channel-index, CONCURRENTLY,
-- then verified by the existing post-migration index guard.
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.channels'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_channels_parent_channel"
      ON "public"."channels" USING btree ("parent_channel_id")
      WHERE parent_channel_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'channels is large: run db:create-channels-parent-channel-index (CONCURRENTLY) to build idx_channels_parent_channel';
  END IF;
END
$$;
