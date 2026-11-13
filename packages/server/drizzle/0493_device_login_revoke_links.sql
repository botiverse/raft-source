-- Device-code login: one-time "this wasn't me" links mailed about a device
-- login (after its approval; later also when a device session mints an agent
-- credential or attaches a computer). A link cancels the grant before the
-- token phase, or revokes the session family the grant issued after it
-- (consumed_session_family_id, set by the token phase). Single use, 24 hours;
-- only the HMAC lookup hash of the token is stored.
CREATE TABLE "device_authorization_revoke_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_authorization_id" uuid NOT NULL,
	"token_lookup_hash" "bytea" NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_authorization_revoke_tokens_token_lookup_hash_unique" UNIQUE("token_lookup_hash")
);
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "consumed_session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "device_authorization_revoke_tokens" ADD CONSTRAINT "device_authorization_revoke_tokens_device_authorization_id_device_authorizations_id_fk" FOREIGN KEY ("device_authorization_id") REFERENCES "public"."device_authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_authorization_revoke_tokens_grant" ON "device_authorization_revoke_tokens" USING btree ("device_authorization_id");--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_consumed_session_family_id_session_families_id_fk" FOREIGN KEY ("consumed_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_authorizations_consumed_session_family" ON "device_authorizations" USING btree ("consumed_session_family_id");