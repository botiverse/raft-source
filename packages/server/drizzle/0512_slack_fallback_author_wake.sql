-- Disable W4 and drain already-isolated unresolved authors before this change:
-- older automatic requeues lost their original position and cannot be reconstructed.
DO $slack_author_wake_guard$
DECLARE enabled boolean;
BEGIN
  SELECT consumers_enabled INTO enabled FROM slack_verified_ingress_rollout WHERE id = 1 FOR SHARE;
  IF enabled IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'disable Slack verified ingress before author wake migration'; END IF;
  IF EXISTS (SELECT 1 FROM slack_verified_ingress_events WHERE state IN ('queued','processing','materialized','held')
    AND (outcome_reason = 'actor_identity_pending' OR last_isolation_reason = 'actor_identity_pending')) THEN
    RAISE EXCEPTION 'drain legacy unresolved Slack authors before author wake migration';
  END IF;
END
$slack_author_wake_guard$;--> statement-breakpoint
CREATE TABLE "slack_ingress_author_wake_signals" (
	"registration_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"signaled_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_ingress_author_wake_shape" CHECK (length(btrim("slack_ingress_author_wake_signals"."registration_id")) BETWEEN 1 AND 320
    AND length(btrim("slack_ingress_author_wake_signals"."binding_id")) BETWEEN 1 AND 160 AND length(btrim("slack_ingress_author_wake_signals"."install_id")) BETWEEN 1 AND 160
    AND length(btrim("slack_ingress_author_wake_signals"."workspace_id")) BETWEEN 1 AND 320 AND length(btrim("slack_ingress_author_wake_signals"."actor_id")) BETWEEN 1 AND 160
    AND "slack_ingress_author_wake_signals"."expires_at" > "slack_ingress_author_wake_signals"."signaled_at")
);--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_events" ADD COLUMN "pending_author_install_id" text;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_events" ADD COLUMN "pending_author_workspace_id" text;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_events" ADD COLUMN "pending_author_binding_id" text;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_events" ADD COLUMN "pending_author_actor_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_ingress_author_wake" ON "slack_ingress_author_wake_signals" USING btree ("registration_id","binding_id","install_id","workspace_id","actor_id");--> statement-breakpoint
CREATE INDEX "idx_slack_ingress_author_wake_expiry" ON "slack_ingress_author_wake_signals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_slack_ingress_pending_author" ON "slack_verified_ingress_events" USING btree ("app_registration_id","pending_author_binding_id","pending_author_install_id","pending_author_workspace_id","pending_author_actor_id","partition_id","position") WHERE "slack_verified_ingress_events"."state" = 'held' AND "slack_verified_ingress_events"."outcome_reason" = 'actor_identity_pending';--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_events" ADD CONSTRAINT "slack_ingress_pending_author_shape" CHECK (
    ("slack_verified_ingress_events"."pending_author_install_id" IS NULL AND "slack_verified_ingress_events"."pending_author_workspace_id" IS NULL AND "slack_verified_ingress_events"."pending_author_binding_id" IS NULL AND "slack_verified_ingress_events"."pending_author_actor_id" IS NULL)
    OR ("slack_verified_ingress_events"."pending_author_install_id" IS NOT NULL AND "slack_verified_ingress_events"."pending_author_workspace_id" IS NOT NULL
      AND "slack_verified_ingress_events"."pending_author_binding_id" IS NOT NULL AND "slack_verified_ingress_events"."pending_author_actor_id" IS NOT NULL
      AND length(btrim("slack_verified_ingress_events"."pending_author_install_id")) BETWEEN 1 AND 160 AND length(btrim("slack_verified_ingress_events"."pending_author_workspace_id")) BETWEEN 1 AND 320
      AND length(btrim("slack_verified_ingress_events"."pending_author_binding_id")) BETWEEN 1 AND 160 AND length(btrim("slack_verified_ingress_events"."pending_author_actor_id")) BETWEEN 1 AND 160)) NOT VALID;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD COLUMN "profile_fallback" text;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD CONSTRAINT "external_message_author_fallback_valid" CHECK ("external_message_author_facts"."profile_fallback" IS NULL OR
    ("external_message_author_facts"."profile_fallback" = 'unresolved' AND "external_message_author_facts"."provider" = 'slack' AND "external_message_author_facts"."actor_kind" = 'unknown')) NOT VALID;
