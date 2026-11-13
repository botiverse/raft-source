-- Account deletion cancel link (services/accountDeletion/requests.ts):
--   account_deletion_requests.cancel_token_hash  the HMAC lookup hash of the
--                              one-time link in the "requested" email that
--                              cancels that request without signing in. The
--                              raw token is never stored; the hash is cleared
--                              once used. Null on earlier requests.
--   idx_account_deletion_requests_cancel_token  the link's lookup, unique
--                              over the hashes that are set.
--
-- A nullable column with no default: catalog-only, no rewrite or scan. The
-- table is small (one row per deletion request), so the index is built here.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "cancel_token_hash" "bytea";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_deletion_requests_cancel_token" ON "account_deletion_requests" USING btree ("cancel_token_hash") WHERE cancel_token_hash IS NOT NULL;