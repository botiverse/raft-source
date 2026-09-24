ALTER TABLE "server_members" ADD COLUMN "setup_modal_reminder_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "onboarding_dm_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "onboarding_dm_sent_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "onboarding_agent_id" uuid;