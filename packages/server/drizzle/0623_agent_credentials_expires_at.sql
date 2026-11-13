-- Runner credentials expire when issued, and are renewed (#wg-rbac:#27):
--   expires_at                 from then on the key is refused with 401
--                              agent_credential_expired. NULL never expires:
--                              every existing row, and every new one except a
--                              runner credential minted for a daemon that
--                              declared runner-credential-renew:v1 (7 days).
--   replaced_by_credential_id  the credential a renewal issued in place of
--                              this one; a second renewal is refused (409).
--
-- Nullable columns with no default: catalog only, no rewrite, no scan, no
-- backfill. No index (auth reads expires_at off the row it found by prefix;
-- a renewal reads replaced_by_credential_id off the row it locked by id) and
-- no foreign key (validating one would scan the table, ~5M rows).
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock on agent_credentials, which
-- every agent request reads, for the catalog change only: give up after 2 s
-- rather than queue reads behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "replaced_by_credential_id" uuid;
