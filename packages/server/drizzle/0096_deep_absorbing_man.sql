CREATE TABLE "share_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"source" text DEFAULT 'selected_messages' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/png' NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_artifacts" ADD CONSTRAINT "share_artifacts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_artifacts" ADD CONSTRAINT "share_artifacts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_artifacts" ADD CONSTRAINT "share_artifacts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_share_artifacts_server_created" ON "share_artifacts" USING btree ("server_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_share_artifacts_channel_created" ON "share_artifacts" USING btree ("channel_id","created_at" DESC);