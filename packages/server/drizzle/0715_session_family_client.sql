ALTER TABLE "session_families" ADD COLUMN "client_platform" text;--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "client_version" text;--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "last_active_at" timestamp with time zone;