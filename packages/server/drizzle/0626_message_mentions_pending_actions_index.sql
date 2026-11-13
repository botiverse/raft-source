-- A sender's pending mention actions (GET /internal/agent-api/mention-actions/pending,
-- listPendingMentionActionsForSender) read message_mentions by server and the
-- last 7 days, for mentions that reached nobody at send. No index led with
-- server_id or created_at, so a busy sender's lookup scanned the whole table
-- (~12.1M rows, 6.9 GB; avg 1.5 s, up to the 15 s timeout; #triage:#142).
-- The partial index holds only those mentions (~2.5% of rows).
--
-- message_mentions is large: like 0607, the index is built here only on a tiny
-- table (tests, dev), by physical size. On a larger one the migration only
-- notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.message_mentions'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_message_mentions_pending_actions" ON "message_mentions" USING btree ("server_id", "created_at" DESC) WHERE source = 'send_path' and not notifiable_at_send;
  ELSE
    RAISE NOTICE 'message_mentions is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_message_mentions_pending_actions';
  END IF;
END
$$;
