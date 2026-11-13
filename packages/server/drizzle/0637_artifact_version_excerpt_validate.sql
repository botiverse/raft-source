-- app_artifacts.versions.excerpt, part 2 of 2: validate the CHECK the previous
-- migration added NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE:
-- it scans while reads, inserts and updates continue, in its own deploy
-- transaction after part 1's ACCESS EXCLUSIVE lock is released. Every row older
-- than part 1 has no excerpt, and a newer one was bound by the CHECK, so it
-- holds.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."versions" VALIDATE CONSTRAINT "versions_excerpt_length";
