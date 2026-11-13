-- RFC 081 inbox items (#wg-ax:#17): app notices group into items by what
-- they are about.
--   object_ref          the notice's `object.ref` (an app's PR, an Artifact's
--                       id): its item is app:<app>/<object_ref>; NULL goes
--                       into the app's fallback item app:<app>.
--   related_channel_id  the conversation the notice names (`object.conversation`,
--                       resolved for the receiving agent at ingestion). No
--                       foreign key: channels is a hot table, and every
--                       listing checks the agent can still open it.
--   consumed_via        read | dismissed, set beside status = 'delivered' by
--                       the RFC 081 paths (inbox read, message read of one
--                       event, inbox dismiss); NULL for every other delivery.
--
-- Existing rows stay NULL: no backfill, no default, no NOT NULL (D9: events
-- from before launch age out on the old path). During the rolling deploy
-- older nodes insert without the columns.
--
-- Additive only. Nullable columns rewrite no rows. The CHECK is added NOT
-- VALID and stays so: the migration runs in one transaction, so a VALIDATE
-- here would scan the table under the ACCESS EXCLUSIVE lock the ADD COLUMNs
-- took. Every existing row is NULL in the new column, so none can violate
-- it, and every write from now on is checked. Bounded lock wait: give up
-- after 5 s (the deploy retries) rather than queue writes behind a long
-- transaction.
--
-- The partial index serves the item list and read (one agent's unconsumed
-- events by app and object, oldest first). Like 0647: built here only on a
-- small table (tests, dev), by physical size. On a larger one the migration
-- only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index
-- guard. Until it is built, idx_third_party_agent_events_agent_status serves.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD COLUMN "object_ref" text;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD COLUMN "related_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD COLUMN "consumed_via" text;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_consumed_via_known" CHECK ("third_party_agent_events"."consumed_via" is null or "third_party_agent_events"."consumed_via" in ('read', 'dismissed')) NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.third_party_agent_events'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_third_party_agent_events_agent_unconsumed_item" ON "third_party_agent_events" USING btree ("agent_id","client_id","system_app","object_ref","created_at") WHERE status in ('queued', 'delivering');
  ELSE
    RAISE NOTICE 'third_party_agent_events is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_third_party_agent_events_agent_unconsumed_item';
  END IF;
END
$$;
