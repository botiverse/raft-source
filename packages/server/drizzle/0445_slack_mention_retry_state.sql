SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD COLUMN "slack_human_mention_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD COLUMN "slack_mention_rate_limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_usergroup_identities" ADD COLUMN "mention_write_failures" jsonb DEFAULT '[]'::jsonb NOT NULL;
