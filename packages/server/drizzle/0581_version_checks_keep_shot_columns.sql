-- schema-snapshot: unchanged (columns kept for the release before this one; schema.ts does not declare them)
-- app_artifacts.version_checks keeps its old screenshot columns for one more
-- release (#botiverse-raft-deployment:1176b89a, Arkbriar and Gogo).
-- artifact_version_checks (0551) shipped in v1.21.49, and that release's
-- Artifact delete returns desktop_key and phone_key from this table in the
-- same transaction (deleteItemChecks, whatever the flag). The prune job reads
-- them too. Dropping them in the release after it would fail every Artifact
-- delete on a task still serving v1.21.49 during the rollout, and for good
-- after a rollback. 0555 no longer drops them; this puts them back where 0555
-- already ran (staging) and is a no-op elsewhere. Nothing reads or writes
-- them from this release on: they stay NULL. Their old CHECKs (0551's
-- version_checks_desktop_shot / _phone_shot) stay dropped; v1.21.49 writes no
-- check rows (its flag is off), so nothing depends on them. The release after
-- this one drops the four columns.
--
-- Adding nullable columns without a default rewrites no rows; bounded lock
-- wait: give up after 5s (the deploy retries) rather than queue writes behind
-- a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD COLUMN IF NOT EXISTS "desktop_key" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD COLUMN IF NOT EXISTS "desktop_bytes" integer;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD COLUMN IF NOT EXISTS "phone_key" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD COLUMN IF NOT EXISTS "phone_bytes" integer;
