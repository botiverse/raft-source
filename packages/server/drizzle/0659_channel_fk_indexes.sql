-- Indexes for the foreign keys a channel delete checks (prep for the closed
-- server purge's delete mode, #13866). Deleting a channels row runs, per
-- referencing table, `... WHERE <col> = $1` for its ON DELETE action; none of
-- these columns led an index, so each delete scanned the whole table
-- (production read replica sizes):
--   inbox_notification_facts(source_channel_id)        7.7 GB, CASCADE
--     (its unique and receiver indexes lead with receiver_type);
--   agent_channel_read_cursors(channel_id)              226 MB, CASCADE
--     (primary key is (agent_id, channel_id));
--   reminders(target_channel_id), set rows only         174 MB, SET NULL;
--   user_channel_read_cursors(channel_id)                79 MB, CASCADE
--     (primary key is (user_id, channel_id));
--   inbox_suppression_states(target_channel_id)          28 MB, CASCADE
--     (primary key and lookup index lead with receiver_type / server_id);
--   action_cards(conversion_source_channel_id), set rows 16 MB, SET NULL.
--
-- Like 0647: built here only on a tiny table (tests, dev), by physical size.
-- On a larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
-- Additive only: until an index is built, a channel delete scans as before.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.inbox_notification_facts'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_inbox_notification_facts_source_channel" ON "inbox_notification_facts" USING btree ("source_channel_id");
  ELSE
    RAISE NOTICE 'inbox_notification_facts is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_inbox_notification_facts_source_channel';
  END IF;
  IF pg_relation_size('public.agent_channel_read_cursors'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_channel_read_cursors_channel" ON "agent_channel_read_cursors" USING btree ("channel_id");
  ELSE
    RAISE NOTICE 'agent_channel_read_cursors is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_channel_read_cursors_channel';
  END IF;
  IF pg_relation_size('public.reminders'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_reminders_target_channel" ON "reminders" USING btree ("target_channel_id") WHERE target_channel_id is not null;
  ELSE
    RAISE NOTICE 'reminders is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_reminders_target_channel';
  END IF;
  IF pg_relation_size('public.user_channel_read_cursors'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_user_channel_read_cursors_channel" ON "user_channel_read_cursors" USING btree ("channel_id");
  ELSE
    RAISE NOTICE 'user_channel_read_cursors is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_user_channel_read_cursors_channel';
  END IF;
  IF pg_relation_size('public.inbox_suppression_states'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_inbox_suppression_states_target" ON "inbox_suppression_states" USING btree ("target_channel_id");
  ELSE
    RAISE NOTICE 'inbox_suppression_states is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_inbox_suppression_states_target';
  END IF;
  IF pg_relation_size('public.action_cards'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_action_cards_conversion_source_channel" ON "action_cards" USING btree ("conversion_source_channel_id") WHERE conversion_source_channel_id is not null;
  ELSE
    RAISE NOTICE 'action_cards is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_action_cards_conversion_source_channel';
  END IF;
END
$$;
