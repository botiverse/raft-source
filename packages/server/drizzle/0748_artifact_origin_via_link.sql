-- An Artifact's original message may also be the first message in its home
-- conversation that links it (`origin_via` 'link', apps/artifacts/linkOrigin.ts;
-- README "Original message"): the items_origin_via CHECK takes the new value.
-- Only an app_artifacts table; no data changes (no backfill here: existing
-- rows already satisfy the wider check).
--
-- Bounded lock wait: replacing the check locks app_artifacts.items (one row
-- per Artifact) while the new check scans it; give up after 5s (the deploy
-- retries) rather than queue its writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" DROP CONSTRAINT "items_origin_via";--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_origin_via" CHECK ("app_artifacts"."items"."origin_via" IS NULL OR "app_artifacts"."items"."origin_via" IN ('attachment', 'share', 'link'));
