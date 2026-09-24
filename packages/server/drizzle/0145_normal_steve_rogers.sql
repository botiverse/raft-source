ALTER TABLE "inbox_target_mute_states" ALTER COLUMN "mute_from_seq" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_target_mute_states" ADD COLUMN "activity_muted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_target_mute_states" ADD COLUMN "prefs_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "notification_prefs_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_channel_read_cursors" ADD COLUMN "read_state_version" integer DEFAULT 0 NOT NULL;