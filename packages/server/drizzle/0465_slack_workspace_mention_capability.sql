SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD COLUMN "slack_mention_capability" jsonb;
