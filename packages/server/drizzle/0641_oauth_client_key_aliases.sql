-- RFC 084 step 1: old and reserved App client ids. One new, empty table (no
-- NOT VALID / VALIDATE split). Older server code never names it, so rolling back
-- leaves it unused. The foreign key takes SHARE ROW EXCLUSIVE on `oauth_clients`:
-- give up after 2 s rather than queue reads behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "oauth_client_key_aliases" (
	"key" text PRIMARY KEY NOT NULL,
	"client_id" uuid,
	"source_server_id" uuid NOT NULL,
	"reclaimable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_client_key_aliases" ADD CONSTRAINT "oauth_client_key_aliases_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_client_key_aliases_client" ON "oauth_client_key_aliases" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_client_key_aliases_source_server" ON "oauth_client_key_aliases" USING btree ("source_server_id","created_at");