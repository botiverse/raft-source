CREATE TABLE "session_refresh_rotation_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"predecessor_token_hash" text NOT NULL,
	"predecessor_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"successor_session_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"successor_token_ciphertext" text NOT NULL,
	"successor_token_iv" text NOT NULL,
	"successor_token_auth_tag" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_refresh_rotation_receipts" ADD CONSTRAINT "session_refresh_rotation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_refresh_rotation_receipts" ADD CONSTRAINT "session_refresh_rotation_receipts_family_id_session_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_refresh_rotation_receipts" ADD CONSTRAINT "session_refresh_rotation_receipts_successor_session_id_sessions_id_fk" FOREIGN KEY ("successor_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_refresh_rotation_receipts_predecessor" ON "session_refresh_rotation_receipts" USING btree ("predecessor_token_hash");--> statement-breakpoint
CREATE INDEX "idx_session_refresh_rotation_receipts_expiry" ON "session_refresh_rotation_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_session_refresh_rotation_receipts_family" ON "session_refresh_rotation_receipts" USING btree ("family_id","expires_at");