-- Unified notifications, contract step 2 (step 1: notification_outbox_contract,
-- native_notifications_drop, notification_level_versions_backfill). Lands
-- only once the release carrying step 1 is the oldest image serving or
-- available for rollback. Two migrations, each its own deploy phase and
-- transaction (src/db/migrationPhases.ts): notification_outbox_fk_indexes,
-- notification_outbox_legacy_columns_drop. (server_members.server_push_muted
-- and its sync trigger stay until the RisingWave owner confirms
-- rw_server_members tolerates the upstream column drop.)
--
-- This one: gives the ON DELETE CASCADE checks from channels
-- (source_channel_id) and users (receiver_id) indexes of their own, then
-- retires the old (receiver_type, receiver_id, source_channel_id, message_id)
-- unique key idx_mobile_push_outbox_unique_fact. Until now that key was the
-- only index those checks could use (the event-key index is partial), so it
-- goes only once both new indexes exist: without them every hard channel or
-- user delete would scan the whole outbox.
--
-- Same split as the event-key index (migration notification_outbox): on a
-- small outbox (<= 100k rows, a fresh or test database) everything happens
-- here; on a large one (production, ~7.4M rows) this only says so, and
-- db:create-notification-outbox-fk-indexes, which db:migrate:deploy runs
-- after the migrations, builds both indexes CONCURRENTLY and then drops the
-- old key CONCURRENTLY; the post-migration index guard checks both new
-- indexes. The step 1 release (still serving during this deploy) never
-- names the old key: its enqueue's ON CONFLICT DO NOTHING has no target and
-- conflicts on the event-key index.
--
-- The old key is retired by name; if it is absent but a unique index of the
-- same columns exists under another name (a hand-rebuilt copy), this stops
-- rather than leaving it silently; absent altogether is said in a NOTICE.
-- Small-table locks: CREATE INDEX takes SHARE (writes wait for the build of
-- a small table), DROP INDEX a brief ACCESS EXCLUSIVE; lock_timeout bounds
-- the wait for either.
--
-- "Large" is pg_class.reltuples > 100k. A table never analyzed (a restored
-- branch before autovacuum's ANALYZE) has reltuples -1, which says nothing:
-- then the rows are counted, up to 100,001 and no further, so a big table is
-- never indexed here without CONCURRENTLY.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
DECLARE
  estimate real;
  same_shape text[];
BEGIN
  SELECT reltuples INTO estimate FROM pg_class WHERE oid = 'public.notification_outbox'::regclass;
  IF estimate > 100000
     OR (estimate < 0 AND (SELECT count(*) FROM (SELECT 1 FROM "notification_outbox" LIMIT 100001) AS bounded) > 100000) THEN
    RAISE NOTICE 'notification_outbox is large: db:create-notification-outbox-fk-indexes (CONCURRENTLY) builds idx_notification_outbox_source_channel and idx_notification_outbox_receiver, then drops idx_mobile_push_outbox_unique_fact';
    RETURN;
  END IF;
  CREATE INDEX IF NOT EXISTS "idx_notification_outbox_source_channel" ON "notification_outbox" USING btree ("source_channel_id");
  CREATE INDEX IF NOT EXISTS "idx_notification_outbox_receiver" ON "notification_outbox" USING btree ("receiver_id");
  SELECT coalesce(array_agg(idx.relname::text ORDER BY idx.relname), ARRAY[]::text[]) INTO same_shape
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
   WHERE i.indrelid = 'public.notification_outbox'::regclass
     AND i.indisunique
     AND (
       SELECT array_agg(a.attname::text ORDER BY k.ord)
         FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     ) = ARRAY['receiver_type', 'receiver_id', 'source_channel_id', 'message_id'];
  IF cardinality(array_remove(same_shape, 'idx_mobile_push_outbox_unique_fact')) > 0 THEN
    RAISE EXCEPTION 'notification_outbox has a unique index on (receiver_type, receiver_id, source_channel_id, message_id) under another name: %. It is the retired key idx_mobile_push_outbox_unique_fact; drop it by hand after checking it is that copy',
      array_to_string(array_remove(same_shape, 'idx_mobile_push_outbox_unique_fact'), ', ');
  END IF;
  IF 'idx_mobile_push_outbox_unique_fact' = ANY (same_shape) THEN
    DROP INDEX "idx_mobile_push_outbox_unique_fact";
  ELSE
    RAISE NOTICE 'notification_outbox_fk_indexes: idx_mobile_push_outbox_unique_fact does not exist; nothing to drop';
  END IF;
END
$$;
