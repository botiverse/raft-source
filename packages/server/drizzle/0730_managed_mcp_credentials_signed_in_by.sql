-- Whose account an MCP App Connection acts as: managed_mcp_credentials.signed_in_by_user_id, the
-- person who last completed its OAuth sign-in or saved its API key (written by the server from this
-- release on, cleared when the secret is removed). Read with server membership to mark a Connection
-- signed in by someone who has left (services/managedMcpSignedInBy.ts); account deletion revokes the
-- OAuth ones (accountDeletion/cleanup.ts `revoke_managed_mcp_sign_ins`).
--
-- The backfill is a best guess: created_by_user_id is who first set the Connection up. A later
-- re-sign-in or key change by someone else was not recorded, so those rows name the creator. Only
-- rows that hold a secret are filled (API-key values, or OAuth state not sent back to needs_auth);
-- a Connection never signed in, or signed out, stays NULL.
--
-- A nullable column with no default: catalog only. managed_mcp_credentials holds one row per
-- Connection and is expected small; it is read by every MCP App call, so give up after 2 s rather
-- than queue those calls (the deploy retries). The backfill runs in batches of 1000 rows, as
-- object_files_billed_server_backfill does. The file is one transaction, so the batches bound each
-- statement, not the lock; only on a table up to 16 MB, otherwise the rows stay NULL (no
-- Connection is marked, as before). The foreign key comes last and NOT VALID: its SHARE ROW
-- EXCLUSIVE lock on users (hot) is taken only at the end, with no scan (every value came from
-- created_by_user_id, itself a key to users).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "signed_in_by_user_id" uuid;--> statement-breakpoint
DO $$
DECLARE
  done integer;
BEGIN
  IF pg_relation_size('public.managed_mcp_credentials'::regclass) <= 16777216 THEN
    LOOP
      UPDATE "managed_mcp_credentials" AS c SET "signed_in_by_user_id" = c."created_by_user_id"
      WHERE c."id" IN (
        SELECT "id" FROM "managed_mcp_credentials"
        WHERE "signed_in_by_user_id" IS NULL
          AND "created_by_user_id" IS NOT NULL
          AND ("encrypted_headers" IS NOT NULL OR ("encrypted_oauth" IS NOT NULL AND "auth_status" <> 'needs_auth'))
        ORDER BY "id"
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
      );
      GET DIAGNOSTICS done = ROW_COUNT;
      EXIT WHEN done = 0;
    END LOOP;
  ELSE
    RAISE NOTICE 'managed_mcp_credentials is large: signed_in_by_user_id left NULL';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_signed_in_by_user_id_users_id_fk" FOREIGN KEY ("signed_in_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;
