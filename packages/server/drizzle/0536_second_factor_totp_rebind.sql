-- Re-binding an authenticator app without dropping the confirmed one
-- (services/secondFactor/management.ts): the new secret waits in
-- user_totp.pending_secret_ciphertext (encrypted like secret_ciphertext) until
-- a code from it confirms it, then replaces secret_ciphertext in one update.
--   pending_secret_ciphertext  the unconfirmed replacement secret, or NULL
--   pending_created_at         when it was set up (written with it)
--
-- Two nullable columns with no default on a small table: no rewrite, no scan,
-- a short ACCESS EXCLUSIVE lock. No constraint to validate, no backfill.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "user_totp" ADD COLUMN "pending_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "user_totp" ADD COLUMN "pending_created_at" timestamp with time zone;
