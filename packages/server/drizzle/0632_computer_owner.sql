-- Computer owner v1 (#wg-rbac:#32): who Raft records as a Computer's owner.
-- NULL = a Public Computer, the default for every row. No backfill: existing
-- Computers stay Public, and connecting one never sets it
-- (services/computerOwnerService.ts). A separate column from the connector
-- (daemons.user_id, computers.attached_by_user_id), which a transfer never
-- changes.
--
-- A nullable column with no default: catalog only, no table rewrite, no scan.
-- The foreign key is added NOT VALID (no scan of daemons; every existing value
-- is NULL, so there is nothing to validate; new values are checked as they are
-- written). ON DELETE SET NULL: an owner whose users row goes leaves a Public
-- Computer (users rows are retired, not deleted, so account deletion clears it
-- itself: accountDeletion/cleanup.ts `clear_computer_ownership`).
--
-- No index: the lookups by owner (a member leaving one server, an account
-- deletion) read daemons by server (idx_daemons_server) or are rare, and
-- daemons is small. daemons and users are hot tables: give up after 2 s rather
-- than queue reads behind a long transaction; daemons first, then the foreign
-- key's SHARE ROW EXCLUSIVE lock on users.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "daemons" ADD CONSTRAINT "daemons_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;
