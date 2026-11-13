-- Indexes behind three foreign keys to daemons (#triage:67b94880). Deleting a
-- machine runs each FK action as `... WHERE <col> = $1`; without an index that
-- is a full scan, and on production agent_credentials (~4.7M rows, ON DELETE
-- SET NULL) plus computer_outage_occurrences (~2M rows, CASCADE) it ran past
-- the 15 s statement timeout: DELETE /machines/:id returned 500 179 times in 72
-- hours, and repeated clicks queued behind the first delete's row lock.
--
-- A plain CREATE INDEX holds a write lock for the whole scan, so these are
-- built here only on a small table (tests, dev, fresh environments). On a
-- larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-daemons-fk-indexes
-- after the migrations and before the post-migration index guard: CREATE INDEX
-- CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready (scripts/daemons-fk-indexes.ts).
-- The threshold is lower than other migrations' 100k because agents (~89k rows)
-- takes a status update on every turn.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.agent_credentials'::regclass) <= 10000 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_issued_by_machine" ON "agent_credentials" USING btree ("issued_by_machine_id") WHERE issued_by_machine_id is not null;
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-daemons-fk-indexes (CONCURRENTLY) to build idx_agent_credentials_issued_by_machine';
  END IF;
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.agents'::regclass) <= 10000 THEN
    CREATE INDEX IF NOT EXISTS "idx_agents_daemon_id" ON "agents" USING btree ("daemon_id") WHERE daemon_id is not null;
  ELSE
    RAISE NOTICE 'agents is large: run db:create-daemons-fk-indexes (CONCURRENTLY) to build idx_agents_daemon_id';
  END IF;
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.computer_outage_occurrences'::regclass) <= 10000 THEN
    CREATE INDEX IF NOT EXISTS "idx_computer_outage_occurrences_machine" ON "computer_outage_occurrences" USING btree ("machine_id");
  ELSE
    RAISE NOTICE 'computer_outage_occurrences is large: run db:create-daemons-fk-indexes (CONCURRENTLY) to build idx_computer_outage_occurrences_machine';
  END IF;
END
$$;
