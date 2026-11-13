-- Indexes for the foreign keys the closed-server purge's credential_revoke,
-- app_installs and slack_bridge steps (services/closedServerPurgeFinish.ts)
-- make Postgres check, and the columns two of their deletes find rows by:
-- deleting a row runs, per referencing table, `... WHERE <col> = $1` for that
-- key's ON DELETE action, and none of these columns led an index, so each
-- deleted row scanned the referencing table. closedServerPurgeClassification.db.test.ts
-- requires an index on every column that references a table a purge row
-- step clears, and on the column it deletes by.
--   oauth_access_tokens(server_id, request_id, grant_id), set rows only
--   oauth_client_share_links(target_server_id, created_by_agent_id), set rows only
--   oauth_link_preview_declines(server_id), oauth_user_consents(server_id)
--   slack_usergroup_identities(server_id), external_oauth_attempts(server_grant_id)
--   managed_mcp_assignments(bound_connection_id), managed_mcp_oauth_attempts(mcp_server_id)
--   provider_probe_intents(connection_id)
--   official_app_auto_install_transitions(installation_id), agents(managed_by_app_install_id), set rows only
--
-- Like 0659 and 0665: built here only on a tiny table (tests, dev), by
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
    CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_server" ON "oauth_access_tokens" USING btree ("server_id") WHERE server_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'oauth_access_tokens is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_access_tokens_server';
  END IF;
  IF pg_relation_size('public.oauth_access_tokens'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_request" ON "oauth_access_tokens" USING btree ("request_id") WHERE request_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'oauth_access_tokens is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_access_tokens_request';
  END IF;
  IF pg_relation_size('public.oauth_access_tokens'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_grant" ON "oauth_access_tokens" USING btree ("grant_id") WHERE grant_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'oauth_access_tokens is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_access_tokens_grant';
  END IF;
  IF pg_relation_size('public.oauth_client_share_links'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_client_share_links_target_server" ON "oauth_client_share_links" USING btree ("target_server_id") WHERE target_server_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'oauth_client_share_links is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_client_share_links_target_server';
  END IF;
  IF pg_relation_size('public.oauth_client_share_links'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_client_share_links_created_by_agent" ON "oauth_client_share_links" USING btree ("created_by_agent_id") WHERE created_by_agent_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'oauth_client_share_links is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_client_share_links_created_by_agent';
  END IF;
  IF pg_relation_size('public.oauth_link_preview_declines'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_link_preview_declines_server" ON "oauth_link_preview_declines" USING btree ("server_id");
  ELSE
    RAISE NOTICE 'oauth_link_preview_declines is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_link_preview_declines_server';
  END IF;
  IF pg_relation_size('public.oauth_user_consents'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_user_consents_server" ON "oauth_user_consents" USING btree ("server_id") WHERE server_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'oauth_user_consents is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_user_consents_server';
  END IF;
  IF pg_relation_size('public.slack_usergroup_identities'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_slack_usergroup_identities_server" ON "slack_usergroup_identities" USING btree ("server_id");
  ELSE
    RAISE NOTICE 'slack_usergroup_identities is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_slack_usergroup_identities_server';
  END IF;
  IF pg_relation_size('public.managed_mcp_assignments'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_managed_mcp_assignments_bound_connection" ON "managed_mcp_assignments" USING btree ("bound_connection_id") WHERE bound_connection_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'managed_mcp_assignments is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_managed_mcp_assignments_bound_connection';
  END IF;
  IF pg_relation_size('public.managed_mcp_oauth_attempts'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_managed_mcp_oauth_attempts_mcp_server" ON "managed_mcp_oauth_attempts" USING btree ("mcp_server_id");
  ELSE
    RAISE NOTICE 'managed_mcp_oauth_attempts is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_managed_mcp_oauth_attempts_mcp_server';
  END IF;
  IF pg_relation_size('public.provider_probe_intents'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_provider_probe_intents_connection" ON "provider_probe_intents" USING btree ("connection_id");
  ELSE
    RAISE NOTICE 'provider_probe_intents is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_provider_probe_intents_connection';
  END IF;
  IF pg_relation_size('public.official_app_auto_install_transitions'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_official_app_auto_install_transitions_installation" ON "official_app_auto_install_transitions" USING btree ("installation_id") WHERE installation_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'official_app_auto_install_transitions is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_official_app_auto_install_transitions_installation';
  END IF;
  IF pg_relation_size('public.agents'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agents_managed_by_app_install" ON "agents" USING btree ("managed_by_app_install_id") WHERE managed_by_app_install_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'agents is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agents_managed_by_app_install';
  END IF;
  IF pg_relation_size('public.external_oauth_attempts'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_external_oauth_attempts_server_grant" ON "external_oauth_attempts" USING btree ("server_grant_id");
  ELSE
    RAISE NOTICE 'external_oauth_attempts is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_external_oauth_attempts_server_grant';
  END IF;
END
$$;
