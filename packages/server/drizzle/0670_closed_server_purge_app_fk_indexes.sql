-- Indexes for the foreign keys to oauth_clients that the closed-server
-- purge's app_installs step makes Postgres check when it deletes an app the
-- closed server owned and never shared (services/closedServerPurgeFinish.ts
-- ownAppNeverSharedSql): each referencing table is looked up by client_id
-- for its ON DELETE CASCADE, and these four columns led no index, so each
-- deleted app scanned the table:
--   oauth_access_tokens(client_id), oauth_app_installation_tokens(client_id),
--   official_app_auto_install_transitions(client_id),
--   oauth_agent_auto_grant_blocks(client_id).
-- closedServerPurgeClassification.db.test.ts requires an index on every
-- column that references a table a purge row step clears.
--
-- Like 0659 and 0666: built here only on a tiny table (tests, dev), by
-- physical size. On a larger one the migration only notes it, and
-- db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
-- Additive only: until an index is built, a delete scans as before.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.oauth_access_tokens'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_client" ON "oauth_access_tokens" USING btree ("client_id");
  ELSE
    RAISE NOTICE 'oauth_access_tokens is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_access_tokens_client';
  END IF;
  IF pg_relation_size('public.oauth_app_installation_tokens'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_app_installation_tokens_client" ON "oauth_app_installation_tokens" USING btree ("client_id");
  ELSE
    RAISE NOTICE 'oauth_app_installation_tokens is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_app_installation_tokens_client';
  END IF;
  IF pg_relation_size('public.official_app_auto_install_transitions'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_official_app_auto_install_transitions_client" ON "official_app_auto_install_transitions" USING btree ("client_id");
  ELSE
    RAISE NOTICE 'official_app_auto_install_transitions is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_official_app_auto_install_transitions_client';
  END IF;
  IF pg_relation_size('public.oauth_agent_auto_grant_blocks'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_agent_auto_grant_blocks_client" ON "oauth_agent_auto_grant_blocks" USING btree ("client_id");
  ELSE
    RAISE NOTICE 'oauth_agent_auto_grant_blocks is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_agent_auto_grant_blocks_client';
  END IF;
END
$$;
