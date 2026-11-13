SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "user_ignore_receipt" jsonb;
