-- What a person's web (full) session issued records that session's family:
-- the `sk_agent_*` keys it minted (POST /api/agents/:id/credentials, and the
-- bootstrap tokens it issued, copied onto the key they are exchanged for), the
-- Computer keys it attached or adopted, and the legacy `sk_machine_*` keys it
-- registered or rotated. A security revoke of that session (a password change
-- or reset, the account's retirement) revokes them
-- (services/webSessionIssuedKeys.ts); a plain logout or expiry never does.
-- These are separate from the device-session columns of
-- device_session_issued_keys, which follow any revoke. No backfill: keys
-- issued before this keep NULL and never cascade.
--
-- Nullable columns with no default: no table rewrite, no scan. The foreign
-- keys are added NOT VALID (no scan; every existing value is NULL, so there is
-- nothing to validate; new rows are checked as they are written), each taking
-- a short SHARE ROW EXCLUSIVE lock on session_families. ON DELETE SET NULL like
-- the other pointers to a family (a family row goes only with its user).
--
-- agent_credentials is large (~4.7M rows on production) and the others may
-- grow: each partial index (the cascade's lookup by family and the ON DELETE
-- SET NULL) is built here only on a tiny table (tests, dev), by physical size,
-- since reltuples is -1 or stale on a table never analysed and would pass a
-- large one as small. On a larger one the migration only notes it, and
-- db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
--
-- Lock order keeps the hot table's ACCESS EXCLUSIVE short: daemons, computers
-- and agent_bootstrap_tokens first, and only then agent_credentials, so its
-- lock never waits on another table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "key_issued_by_web_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "daemons" ADD CONSTRAINT "daemons_key_issued_by_web_session_family_id_session_families_id_fk" FOREIGN KEY ("key_issued_by_web_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "key_issued_by_web_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_key_issued_by_web_session_family_id_session_families_id_fk" FOREIGN KEY ("key_issued_by_web_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_bootstrap_tokens" ADD COLUMN "issued_by_web_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_issued_by_web_session_family_id_session_families_id_fk" FOREIGN KEY ("issued_by_web_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "issued_by_web_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_issued_by_web_session_family_id_session_families_id_fk" FOREIGN KEY ("issued_by_web_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.daemons'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_daemons_key_issued_by_web_session_family" ON "daemons" USING btree ("key_issued_by_web_session_family_id") WHERE key_issued_by_web_session_family_id is not null;
  ELSE
    RAISE NOTICE 'daemons is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_daemons_key_issued_by_web_session_family';
  END IF;
  IF pg_relation_size('public.computers'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_computers_key_issued_by_web_session_family" ON "computers" USING btree ("key_issued_by_web_session_family_id") WHERE key_issued_by_web_session_family_id is not null;
  ELSE
    RAISE NOTICE 'computers is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_computers_key_issued_by_web_session_family';
  END IF;
  IF pg_relation_size('public.agent_bootstrap_tokens'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_bootstrap_tokens_issued_by_web_session_family" ON "agent_bootstrap_tokens" USING btree ("issued_by_web_session_family_id") WHERE issued_by_web_session_family_id is not null;
  ELSE
    RAISE NOTICE 'agent_bootstrap_tokens is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_bootstrap_tokens_issued_by_web_session_family';
  END IF;
  IF pg_relation_size('public.agent_credentials'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_credentials_issued_by_web_session_family" ON "agent_credentials" USING btree ("issued_by_web_session_family_id") WHERE issued_by_web_session_family_id is not null;
  ELSE
    RAISE NOTICE 'agent_credentials is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_credentials_issued_by_web_session_family';
  END IF;
END
$$;
