CREATE TABLE "oauth_app_link_previews" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"endpoint" text NOT NULL,
	"paths" json NOT NULL,
	"revision" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_app_link_previews_origin_unique" UNIQUE("origin")
);
--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD CONSTRAINT "oauth_app_link_previews_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;