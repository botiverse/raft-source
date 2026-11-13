-- The one-time device-login grant (computer_attach) whose attach token issued
-- a Computer's key, so the key can be revoked per machine (device-auth design
-- v2 §3.1; key_issued_by_session_family_id stays NULL for those).
--
-- Its own migration, after device_login_grants: the ACCESS EXCLUSIVE lock on
-- computers is taken with no other lock held, for two statements. The column
-- is nullable (no rewrite) and the foreign key is NOT VALID: every existing
-- value is NULL, so there is nothing to validate, and new rows are checked as
-- they are written. No index on the column: grants are never deleted (so the
-- ON DELETE SET NULL never runs), and grant -> computer is read from
-- device_login_grants.consumed_computer_id.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "key_issued_by_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_key_issued_by_grant_id_device_login_grants_id_fk" FOREIGN KEY ("key_issued_by_grant_id") REFERENCES "public"."device_login_grants"("id") ON DELETE set null ON UPDATE no action NOT VALID;