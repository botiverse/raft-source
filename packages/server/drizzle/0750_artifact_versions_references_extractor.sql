-- Links in an Artifact's content (#proj-workspace:#336, step 1): which
-- extractor read a version's links to other Artifacts into core's
-- object_references (next migration) while it was the current version
-- (apps/artifacts/references.ts). NULL: never read, which every existing
-- version is: the current one is read when it is first asked for
-- (ensureArtifactReferences), an older one never. No backfill.
--
-- Its own file, apart from object_references: that table's key to servers (a
-- hot table) must come in a file that touches no existing table.
--
-- Catalog-only on app_artifacts.versions: a nullable column with no default
-- rewrites and scans nothing under the ACCESS EXCLUSIVE lock. Cards and pushes
-- read this table, so give up after 2 s (the deploy retries) rather than queue
-- them behind a long transaction.
--
-- Rolling deploy: an older replica names its own columns, never this one; a
-- version it makes has no marker and is read when asked for.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."versions" ADD COLUMN "references_extractor" smallint;
