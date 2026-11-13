-- Add nullable bot-mapping authority to existing rows; old writers and readers
-- continue to use the existing columns. CHECK constraints validate existing
-- rows before commit. ALTER TABLE takes ACCESS EXCLUSIVE locks, so reads and
-- writes can wait; a lock wait over five seconds aborts and rolls back the
-- migration. Retry through the normal migration procedure after contention clears.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_mention_facts" DROP CONSTRAINT "external_mention_fact_values_valid";--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_mapping_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_mapping_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_mapping_conflict" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_user_id" text;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_connection_epoch" integer;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_credential_revision" integer;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_scope_revision" integer;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_mapping_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "slack_bot_mapping_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_mention_facts" ADD COLUMN "slack_bot_mapping_revision" integer;--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD CONSTRAINT "external_actor_slack_bot_mapping_revision" CHECK ("external_actor_projections"."slack_bot_mapping_revision" >= 0);--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD CONSTRAINT "external_actor_slack_bot_mapping_valid" CHECK (
    ("external_actor_projections"."slack_bot_mapping_conflict" = false AND "external_actor_projections"."slack_bot_user_id" IS NULL AND "external_actor_projections"."slack_bot_connection_epoch" IS NULL AND "external_actor_projections"."slack_bot_credential_revision" IS NULL
      AND "external_actor_projections"."slack_bot_scope_revision" IS NULL AND "external_actor_projections"."slack_bot_mapping_observed_at" IS NULL AND "external_actor_projections"."slack_bot_mapping_expires_at" IS NULL)
    OR ("external_actor_projections"."provider" = 'slack' AND "external_actor_projections"."actor_kind" = 'bot' AND "external_actor_projections"."slack_bot_user_id" IS NOT NULL
      AND "external_actor_projections"."slack_bot_mapping_revision" > 0 AND "external_actor_projections"."slack_bot_user_id" ~ '^[UW][A-Z0-9]{2,159}$'
      AND "external_actor_projections"."slack_bot_connection_epoch" IS NOT NULL AND "external_actor_projections"."slack_bot_connection_epoch" > 0
      AND "external_actor_projections"."slack_bot_credential_revision" IS NOT NULL AND "external_actor_projections"."slack_bot_credential_revision" > 0
      AND "external_actor_projections"."slack_bot_scope_revision" IS NOT NULL AND "external_actor_projections"."slack_bot_scope_revision" > 0
      AND "external_actor_projections"."slack_bot_mapping_observed_at" IS NOT NULL AND "external_actor_projections"."slack_bot_mapping_expires_at" IS NOT NULL
      AND "external_actor_projections"."slack_bot_mapping_expires_at" > "external_actor_projections"."slack_bot_mapping_observed_at"));--> statement-breakpoint
ALTER TABLE "external_mention_facts" ADD CONSTRAINT "external_mention_fact_values_valid" CHECK (length(btrim("external_mention_facts"."provider")) > 0
      AND length(btrim("external_mention_facts"."app_registration_id")) > 0
      AND length(btrim("external_mention_facts"."install_id")) > 0
      AND length(btrim("external_mention_facts"."workspace_id")) > 0
      AND length(btrim("external_mention_facts"."external_actor_id")) > 0
      AND length(btrim("external_mention_facts"."binding_id")) > 0
      AND length(btrim("external_mention_facts"."conversation_id")) > 0
      AND length(btrim("external_mention_facts"."handle_at_send_time")) > 0
      AND ("external_mention_facts"."slack_bot_mapping_revision" IS NULL OR "external_mention_facts"."slack_bot_mapping_revision" > 0)
      AND "external_mention_facts"."connection_epoch" > 0 AND "external_mention_facts"."binding_epoch" > 0
      AND "external_mention_facts"."member_revision" > 0 AND "external_mention_facts"."context_revision" > 0
      AND "external_mention_facts"."freshness_expires_at" > "external_mention_facts"."freshness_observed_at"
      AND "external_mention_facts"."resolution_reason" IN ('explicit_projection', 'unique_dangling_handle'));