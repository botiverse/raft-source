-- Unified notifications, contract step 2 (see notification_outbox_fk_indexes
-- for when this may land): notification_outbox drops dispatcher_version
-- (DEFAULT 2 since step 1; no dispatcher reads it any more) and the legacy
-- per-row counters written only by binaries before v1.21.43. The release
-- carrying step 1, and every later one, no longer declares them in schema.ts,
-- so none of them names them in an INSERT or a SELECT.
--
-- schema-snapshot: unchanged (step 1 already removed the columns from
-- schema.ts, so every snapshot since notification_outbox_contract lacks them)
--
-- ~7.4M rows: DROP COLUMN only marks the column dropped in the catalog (no
-- scan, no rewrite; the space comes back as rows are rewritten). The table is
-- locked ACCESS EXCLUSIVE once, up front, for all six; lock_timeout bounds
-- the wait so a long drain transaction makes the deploy retry instead of
-- queueing enqueues behind it. A column that is already gone is named in a
-- NOTICE, never skipped silently.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "notification_outbox" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['dispatcher_version', 'attempted_count', 'sent_count', 'skipped_count', 'revoked_count', 'dropped_count'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.notification_outbox'::regclass AND attname = col AND attnum > 0 AND NOT attisdropped
    ) THEN
      EXECUTE format('ALTER TABLE "notification_outbox" DROP COLUMN %I', col);
    ELSE
      RAISE NOTICE 'notification_outbox_legacy_columns_drop: notification_outbox.% does not exist; nothing to drop', col;
    END IF;
  END LOOP;
END
$$;
