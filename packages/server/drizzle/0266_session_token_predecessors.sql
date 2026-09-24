CREATE TABLE "session_token_predecessors" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_token_predecessors" ADD CONSTRAINT "session_token_predecessors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_token_predecessors" ADD CONSTRAINT "session_token_predecessors_family_id_session_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_token_predecessors_expiry" ON "session_token_predecessors" USING btree ("expires_at");