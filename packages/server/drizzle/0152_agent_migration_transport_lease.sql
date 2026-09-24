ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_session_id" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_provider" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "source_transport_url" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "target_transport_url" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_lease_source" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_max_bytes" integer;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "source_transport_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "target_transport_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_provisioning_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_provisioned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_provision_failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_lost_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_teardown_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_error_code" text;
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN IF NOT EXISTS "transport_error_message" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_agent_migrations_active_agent";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_migrations_active_agent" ON "agent_migrations" ("agent_id")
	WHERE "state" IN ('provisioning', 'prep', 'ready', 'in_transit', 'arriving');
