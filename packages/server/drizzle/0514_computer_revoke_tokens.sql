-- One-time revoke links for one Computer (device-auth design v2 §3.1 step 6):
-- mailed with "You added X to Y", they revoke that Computer's key and the
-- runner credentials its machine minted. Only the token's HMAC lookup hash is
-- stored.
--
-- computer_revoke_tokens is new and empty: its table, index and foreign keys
-- cost nothing to build. The foreign keys to computers and device_login_grants
-- take a short SHARE ROW EXCLUSIVE lock on those tables (no scan of them); the
-- previous migration (session_families) has already committed its locks.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "computer_revoke_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"computer_id" uuid NOT NULL,
	"device_login_grant_id" uuid,
	"token_lookup_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_revoke_tokens_token_lookup_hash_unique" UNIQUE("token_lookup_hash")
);
--> statement-breakpoint
ALTER TABLE "computer_revoke_tokens" ADD CONSTRAINT "computer_revoke_tokens_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_revoke_tokens" ADD CONSTRAINT "computer_revoke_tokens_device_login_grant_id_device_login_grants_id_fk" FOREIGN KEY ("device_login_grant_id") REFERENCES "public"."device_login_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_revoke_tokens_computer" ON "computer_revoke_tokens" USING btree ("computer_id");