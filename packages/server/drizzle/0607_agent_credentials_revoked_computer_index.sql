-- Every managed runner launch mints an agent credential (issued_via =
-- 'computer') and revokes it when the launch ends, but nothing ever deleted
-- the revoked ones: ~3.8M of production's ~5M rows (2.1 GB heap). The hourly
-- retention sweep (agentCredentialRetention.ts) deletes those revoked over 30
-- days ago, oldest first, through this index of revoked runner keys.
--
-- agent_credentials is large: like 0538, the index is built here only on a
-- tiny table (tests, dev), by physical size. On a larger one the migration
-- only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.agent_credentials'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_revoked_computer" ON "agent_credentials" USING btree ("revoked_at") WHERE revoked_at is not null and issued_via = 'computer';
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_revoked_computer';
  END IF;
END
$$;
