ALTER TABLE "oauth_app_link_previews" ADD COLUMN "action_endpoint" text;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "pending_action_endpoint" text;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "pending_action_endpoint_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "action_endpoint_reject_reason" text;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD CONSTRAINT "oauth_app_link_previews_pending_action_endpoint" CHECK (("oauth_app_link_previews"."pending_action_endpoint" IS NULL) = ("oauth_app_link_previews"."pending_action_endpoint_requested_at" IS NULL));