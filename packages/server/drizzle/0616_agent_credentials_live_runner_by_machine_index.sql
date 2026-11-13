-- Runner credential reconcile on reconnect (#wg-rbac:#27,
-- revokeRunnerCredentialsNotHeld / countRunnerCredentialsNotHeld) reads one
-- Machine's live runner keys. idx_agent_credentials_issued_by_machine also
-- holds every revoked key of that Machine: on the production replica the
-- largest Machine had 350,525 rows there and the count took 3.18 s for 312
-- live ones. This index holds the live runner keys only. The old index stays:
-- it serves the machine-delete ON DELETE SET NULL, which must reach revoked
-- rows too.
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
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_live_runner_by_machine" ON "agent_credentials" USING btree ("issued_by_machine_id") WHERE revoked_at is null and issued_via = 'computer' and issued_by_machine_id is not null;
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_live_runner_by_machine';
  END IF;
END
$$;
