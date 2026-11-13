-- A runner key renewal (#wg-rbac:#27) does not revoke the old key: it pulls
-- the old key's expires_at in to at most 5 minutes out, and auth refuses it
-- from then on. Those rows are never revoked, so the retention sweep's revoked
-- rule never reaches them: one row per agent per renewal piles up. The hourly
-- retention sweep (agentCredentialRetention.ts) now also deletes runner keys
-- that are not revoked and expired over 30 days ago, oldest first, through
-- this index.
--
-- agent_credentials is large: like 0607, the index is built here only on a
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
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_expired_computer" ON "agent_credentials" USING btree ("expires_at") WHERE expires_at is not null and revoked_at is null and issued_via = 'computer';
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_expired_computer';
  END IF;
END
$$;
