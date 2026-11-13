CREATE TABLE "oauth_link_preview_declines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"declined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every consent recorded so far came from a Login with Raft: the default
-- backfills existing rows with 'login'.
ALTER TABLE "oauth_user_consents" ADD COLUMN "source" text DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_link_preview_declines" ADD CONSTRAINT "oauth_link_preview_declines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_link_preview_declines" ADD CONSTRAINT "oauth_link_preview_declines_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_link_preview_declines" ADD CONSTRAINT "oauth_link_preview_declines_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_link_preview_declines_user_server_client" ON "oauth_link_preview_declines" USING btree ("user_id","server_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_link_preview_declines_client_server" ON "oauth_link_preview_declines" USING btree ("client_id","server_id");--> statement-breakpoint
ALTER TABLE "oauth_user_consents" ADD CONSTRAINT "oauth_user_consents_source_check" CHECK ("oauth_user_consents"."source" IN ('login', 'preview_prompt'));