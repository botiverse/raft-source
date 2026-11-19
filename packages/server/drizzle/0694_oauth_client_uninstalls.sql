-- When each Server last uninstalled each App by a person's action (#proj-apps;
-- db/schema.ts oauthClientUninstalls): GET /api/integrations/marketplace's
-- `uninstalledHereAt`. Filled from the audit log by the next migration
-- (oauth_client_uninstalls_backfill), then written with each uninstall.
--
-- A new, empty table: nothing is scanned or rewritten. The foreign keys take
-- SHARE ROW EXCLUSIVE on servers, users (hot) and oauth_clients until this
-- file commits, so it touches only the new table and gives up after 2 s (the
-- deploy retries). Rolling deploy: an older replica never reads or writes it.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "oauth_client_uninstalls" (
	"server_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"uninstalled_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid,
	CONSTRAINT "oauth_client_uninstalls_server_id_client_id_pk" PRIMARY KEY("server_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_client_uninstalls" ADD CONSTRAINT "oauth_client_uninstalls_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_uninstalls" ADD CONSTRAINT "oauth_client_uninstalls_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_uninstalls" ADD CONSTRAINT "oauth_client_uninstalls_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_client_uninstalls_client" ON "oauth_client_uninstalls" USING btree ("client_id");