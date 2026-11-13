-- The web session family that approved a one-time device-login grant, so a
-- security revoke of that session (a password change or reset, the account's
-- retirement, a device login's revoke link) also revokes the Computer key or
-- agent key the grant issued (services/approverSessionGrants.ts). No backfill:
-- grants approved before this keep NULL and never cascade.
--
-- A nullable column with no default: no table rewrite, no scan.
-- device_login_grants is young and small (0508), so its ACCESS EXCLUSIVE lock
-- (ADD COLUMN) and the plain index build are short. The foreign key is NOT
-- VALID: every existing value is NULL, so there is nothing to validate, and new
-- rows are checked as they are written; it takes a short SHARE ROW EXCLUSIVE
-- lock on session_families, no scan of it. ON DELETE SET NULL like the other
-- pointers to a family (a family row goes only with its user).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "device_login_grants" ADD COLUMN "approver_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "device_login_grants" ADD CONSTRAINT "device_login_grants_approver_session_family_id_session_families_id_fk" FOREIGN KEY ("approver_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_device_login_grants_approver_session_family" ON "device_login_grants" USING btree ("approver_session_family_id");
