ALTER TABLE "server_members" ADD COLUMN "setup_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "setup_deferred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "setup_completion_reason" text;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "setup_contract_version" text DEFAULT 'onboarding-setup-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_setup_status_valid" CHECK ("server_members"."setup_status" IN ('not_started', 'in_progress', 'deferred', 'complete'));--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_setup_completion_reason_valid" CHECK ("server_members"."setup_completion_reason" IS NULL OR "server_members"."setup_completion_reason" IN ('normal', 'grandfathered', 'complete_after_defer', 'admin_override'));--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_setup_completion_reason_requires_complete" CHECK ("server_members"."setup_completion_reason" IS NULL OR "server_members"."setup_status" = 'complete');--> statement-breakpoint
-- Grandfathering backfill (task #118 / A1 nail #2): pre-migration existing servers
-- with any live agent are already "set up". Mark all their members' durable setup
-- state complete with the migration-exclusive `grandfathered` reason (the service's
-- normal complete path never emits this reason). Members of agentless servers keep
-- the not_started column default. setup_contract_version is set by the column default.
UPDATE "server_members" sm
SET "setup_status" = 'complete', "setup_completion_reason" = 'grandfathered'
FROM "servers" s
WHERE sm."server_id" = s."id"
  AND s."deleted_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "agents" a
    WHERE a."server_id" = s."id" AND a."deleted_at" IS NULL
  );