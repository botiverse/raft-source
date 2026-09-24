ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_failure_stage" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_failure_code" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_retry_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_retry_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_last_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_remediation_lease_id" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "auto_start_remediation_lease_expires_at" timestamp with time zone;