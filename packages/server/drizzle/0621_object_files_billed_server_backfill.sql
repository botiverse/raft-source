-- Backfill object_files.billed_server_id (0620) with the object's own server,
-- the server every existing file was counted against. Correctness does not
-- depend on it: every read is coalesce(billed_server_id, server_id), which
-- also covers rows an older build writes during the rolling deploy. It runs
-- before 0622 builds the index on the column, so these updates touch no index
-- of it (HOT where the page has room).
--
-- object_files is young (comment images and publish-check screenshots, both
-- behind flags) and expected small. In batches of 1000 rows, each batch's rows
-- taken FOR UPDATE SKIP LOCKED so a row an upload or claim holds is skipped,
-- not waited on (it stays NULL and reads the same). Only on a table up to
-- 16 MB by physical size (reltuples is -1 or stale on a table never analysed);
-- on a larger one the migration only notes it and leaves the rows NULL, read
-- as their home server all the same. Bounded by lock_timeout 2s,
-- statement_timeout 30s and the migration's default transaction_timeout.
-- schema-snapshot: unchanged (data only: no DDL)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
DECLARE
  done integer;
BEGIN
  IF pg_relation_size('public.object_files'::regclass) <= 16777216 THEN
    LOOP
      UPDATE "object_files" AS f SET "billed_server_id" = f."server_id"
      WHERE f."id" IN (
        SELECT "id" FROM "object_files"
        WHERE "billed_server_id" IS NULL
        ORDER BY "id"
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
      );
      GET DIAGNOSTICS done = ROW_COUNT;
      EXIT WHEN done = 0;
    END LOOP;
  ELSE
    RAISE NOTICE 'object_files is large: billed_server_id left NULL (read as server_id through coalesce)';
  END IF;
END
$$;
