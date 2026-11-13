-- Indexes the account-deletion flow needs on production-sized tables
-- (#triage:#142, EXPLAIN of every statement of the request, cancel and
-- cleanup on the read replica, 2026-11-05). Each read below was a full scan:
--   session_token_predecessors(family_id): the cascade from every deleted
--     session family (~2.3M rows), and the cleanup's delete by family;
--   tasks(claimed_by_id) agent claims: deleteAgent's release (~780k rows);
--   agents(creator_id) user-created, agents(assistant_owner_user_id): a
--     person's agents across servers (idx_agents_creator leads with server_id);
--   agent_runtime_profiles baseline / pending before / pending after machine:
--     the RESTRICT foreign keys checked when a Computer is deleted;
--   third_party_agent_events(access_token_id): the ON DELETE SET NULL from
--     oauth_access_tokens.
--
-- Like 0538: built here only on a tiny table (tests, dev), by physical size.
-- On a larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.session_token_predecessors'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_session_token_predecessors_family" ON "session_token_predecessors" USING btree ("family_id");
  ELSE
    RAISE NOTICE 'session_token_predecessors is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_session_token_predecessors_family';
  END IF;
  IF pg_relation_size('public.tasks'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_tasks_claimed_by_agent" ON "tasks" USING btree ("claimed_by_id") WHERE claimed_by_type = 'agent';
  ELSE
    RAISE NOTICE 'tasks is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_tasks_claimed_by_agent';
  END IF;
  IF pg_relation_size('public.agents'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agents_user_creator" ON "agents" USING btree ("creator_id") WHERE creator_type = 'user';
  ELSE
    RAISE NOTICE 'agents is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agents_user_creator';
  END IF;
  IF pg_relation_size('public.agents'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agents_assistant_owner" ON "agents" USING btree ("assistant_owner_user_id") WHERE assistant_owner_user_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'agents is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agents_assistant_owner';
  END IF;
  IF pg_relation_size('public.agent_runtime_profiles'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_runtime_profiles_baseline_machine" ON "agent_runtime_profiles" USING btree ("baseline_machine_id");
  ELSE
    RAISE NOTICE 'agent_runtime_profiles is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_runtime_profiles_baseline_machine';
  END IF;
  IF pg_relation_size('public.agent_runtime_profiles'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_runtime_profiles_pending_before_machine" ON "agent_runtime_profiles" USING btree ("pending_before_machine_id") WHERE pending_before_machine_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'agent_runtime_profiles is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_runtime_profiles_pending_before_machine';
  END IF;
  IF pg_relation_size('public.agent_runtime_profiles'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_runtime_profiles_pending_after_machine" ON "agent_runtime_profiles" USING btree ("pending_after_machine_id") WHERE pending_after_machine_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'agent_runtime_profiles is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_runtime_profiles_pending_after_machine';
  END IF;
  IF pg_relation_size('public.third_party_agent_events'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_third_party_agent_events_access_token" ON "third_party_agent_events" USING btree ("access_token_id") WHERE access_token_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'third_party_agent_events is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_third_party_agent_events_access_token';
  END IF;
END
$$;
