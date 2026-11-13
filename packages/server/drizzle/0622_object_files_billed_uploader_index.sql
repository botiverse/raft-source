-- What a server is billed for, and each uploader's share of it (0620;
-- services/objectFiles.ts putObjectFile's caps: the billed server's total,
-- an uploader's drafts and an uploader's total there, all one read under the
-- billed server's lock). The read is
--   (billed_server_id = $1 OR (billed_server_id IS NULL AND server_id = $1))
-- (coalesce(billed_server_id, server_id) = $1, written so each arm can use a
-- plain index: this one, and idx_object_files_server for rows still NULL).
--
-- Like 0607: built here only on a tiny table (tests, dev), by physical size.
-- On a larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.object_files'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_object_files_billed_uploader" ON "object_files" USING btree ("billed_server_id","uploaded_by_type","uploaded_by_id");
  ELSE
    RAISE NOTICE 'object_files is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_object_files_billed_uploader';
  END IF;
END
$$;
