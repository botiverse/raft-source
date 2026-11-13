-- These indexes are built only while W4 consumers are disabled. Hold the
-- policy row until commit so an enablement cannot race the index build.
DO $slack_retention_guard$
DECLARE enabled boolean;
BEGIN
  SELECT consumers_enabled INTO enabled FROM slack_verified_ingress_rollout WHERE id = 1 FOR UPDATE;
  IF enabled IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'disable Slack verified ingress before building retention indexes';
  END IF;
END
$slack_retention_guard$;--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_dedupe_retention" ON "slack_verified_ingress_dedupe" USING btree ("app_registration_id","environment","finished_at","id");--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_isolation_retention" ON "slack_verified_ingress_events" USING btree ("held_at","id") WHERE "slack_verified_ingress_events"."state" IN ('quarantined', 'review_required');
