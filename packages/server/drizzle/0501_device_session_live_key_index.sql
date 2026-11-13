-- The hourly sweep that revokes the keys of revoked device sessions
-- (deviceSessionKeys.ts revokeKeysOfRevokedDeviceSessions) reads the live
-- agent credentials that record a session family. The index from
-- device_session_issued_keys also holds every revoked one, and revoked runner
-- credentials (one per launch on a device-attached Computer) pile up there;
-- this one holds only the live ones, so the sweep stays small.
--
-- agent_credentials is large (~4.7M rows on production): the index is built
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
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_live_by_session_family" ON "agent_credentials" USING btree ("issued_by_session_family_id") WHERE issued_by_session_family_id is not null and revoked_at is null;
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_live_by_session_family';
  END IF;
END
$$;
