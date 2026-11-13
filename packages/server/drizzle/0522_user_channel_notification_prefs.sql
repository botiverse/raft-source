-- Unified notifications (see notification_outbox): the explicit per-user
-- channel (or DM) notification level. No row = default (inherit the server
-- level), so the table starts empty and nothing changes for anyone. A new,
-- empty table: its foreign keys are validated instantly; lock_timeout bounds
-- the wait for the referenced tables' locks.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "user_channel_notification_prefs" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"level" text NOT NULL,
	"prefs_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_channel_notification_prefs_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id"),
	CONSTRAINT "user_channel_notification_prefs_level_check" CHECK ("user_channel_notification_prefs"."level" IN ('all', 'mentions', 'none'))
);
--> statement-breakpoint
ALTER TABLE "user_channel_notification_prefs" ADD CONSTRAINT "user_channel_notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_notification_prefs" ADD CONSTRAINT "user_channel_notification_prefs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_notification_prefs" ADD CONSTRAINT "user_channel_notification_prefs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_channel_notification_prefs_server" ON "user_channel_notification_prefs" USING btree ("user_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_user_channel_notification_prefs_channel" ON "user_channel_notification_prefs" USING btree ("channel_id");
