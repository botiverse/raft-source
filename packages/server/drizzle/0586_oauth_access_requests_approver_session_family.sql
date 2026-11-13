-- The web session family that issued a person's Login with Raft code
-- (oauth_access_requests, POST /authorize/human and /authorize/account), so
-- the code dies with that sign-in: the token exchange refuses it unless the
-- family is still live, and every revoke of the family denies the codes it
-- issued that nobody has exchanged yet (services/sessionService.ts). No
-- backfill: a person's code issued before this keeps NULL and is refused
-- (codes live ten minutes; the app asks again).
--
-- A nullable column with no default: no table rewrite, no scan. The foreign
-- key is NOT VALID (no scan; every existing value is NULL, so there is nothing
-- to validate; new rows are checked as they are written) and takes a short
-- SHARE ROW EXCLUSIVE lock on session_families. ON DELETE SET NULL like the
-- other pointers to a family (a family row goes only with its user).
--
-- The partial index (the ON DELETE SET NULL's lookup when a family goes) is
-- built here only on a tiny table (tests, dev), by physical size, since
-- reltuples is -1 or stale on a table never analysed and would pass a large
-- one as small. On a larger one the migration only notes it, and
-- db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD COLUMN "approver_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD CONSTRAINT "oauth_access_requests_approver_session_family_id_session_families_id_fk" FOREIGN KEY ("approver_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.oauth_access_requests'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_oauth_access_requests_approver_session_family" ON "oauth_access_requests" USING btree ("approver_session_family_id") WHERE approver_session_family_id is not null;
  ELSE
    RAISE NOTICE 'oauth_access_requests is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_oauth_access_requests_approver_session_family';
  END IF;
END
$$;
