-- A person's departure from a server revokes the agent credentials they issued
-- for the server's agents (agentCredentialService.ts revokeAgentCredentialsIssuedBy),
-- inside the removal's transaction. Its lookup by issuer had no index and
-- scanned all of agent_credentials; on a large server it hit the statement
-- timeout and the removal rolled back with a 500 (#wg-rbac:#18). This index
-- holds only the live ones.
--
-- agent_credentials is large (~4.8M rows on production): the index is built
-- here only on a tiny table (tests, dev), by physical size, since reltuples is
-- -1 or stale on a table never analysed and would pass a large one as small.
-- On a larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.agent_credentials'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_live_by_creator" ON "agent_credentials" USING btree ("created_by_user_id") WHERE revoked_at is null;
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_live_by_creator';
  END IF;
END
$$;
