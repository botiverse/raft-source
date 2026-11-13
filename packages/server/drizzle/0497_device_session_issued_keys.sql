-- Device-login revoke links reach what the session handed out: the agent
-- credentials it minted and the Computer keys it holds record its session
-- family (only for a `device` family; NULL otherwise), so the link revokes
-- them with the session (deviceAuthService revokeDeviceLoginByLink).
--
-- agent_credentials is large (~4.7M rows on production): the columns are
-- nullable (no rewrite), the foreign keys are added NOT VALID (no scan; every
-- existing value is NULL), and the partial indexes the ON DELETE SET NULL and
-- the revoke cascade use are built here only on a tiny table (tests, dev): by
-- physical size, since reltuples is -1 or stale on a table never analysed and
-- would pass a large one as small. On a larger one
-- the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
--
-- Lock order keeps the hot table's ACCESS EXCLUSIVE short: computers (column,
-- then its FK, which also takes session_families) first, and only then
-- agent_credentials, so its lock never waits on another table. The FKs stay
-- NOT VALID on purpose: every existing row is NULL, so there is nothing to
-- validate, and new rows are checked as they are written.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "key_issued_by_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_key_issued_by_session_family_id_session_families_id_fk" FOREIGN KEY ("key_issued_by_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "issued_by_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_issued_by_session_family_id_session_families_id_fk" FOREIGN KEY ("issued_by_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.agent_credentials'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_issued_by_session_family" ON "agent_credentials" USING btree ("issued_by_session_family_id") WHERE issued_by_session_family_id is not null;
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_issued_by_session_family';
  END IF;
  IF pg_relation_size('public.computers'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_computers_key_issued_by_session_family" ON "computers" USING btree ("key_issued_by_session_family_id") WHERE key_issued_by_session_family_id is not null;
  ELSE
    RAISE NOTICE 'computers is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_computers_key_issued_by_session_family';
  END IF;
END
$$;
