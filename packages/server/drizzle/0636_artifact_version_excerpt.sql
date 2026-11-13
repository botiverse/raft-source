-- A Markdown version's excerpt, what its card shows (#proj-workspace:#217;
-- apps/artifacts/excerpt.ts). On the version's own row because every card
-- already reads that row: no query per card, nor one per page.
--
-- Part 1 of 2. Catalog-only on app_artifacts.versions: a nullable column with
-- no default rewrites nothing, and the CHECK is added NOT VALID, so nothing is
-- scanned under the ACCESS EXCLUSIVE lock; it binds new and updated rows from
-- now on. The next migration validates it under SHARE UPDATE EXCLUSIVE, which
-- reads and writes don't wait for (as 0629/0630). Cards and pushes read this
-- table, so give up after 2 s (the deploy retries) rather than queue them
-- behind a long transaction.
--
-- No backfill: the text is in object storage, which a migration can't read, and
-- nothing depends on it. An older version keeps its screenshots, or today's
-- card without either, until the next version.
--
-- Rolling deploy: an older replica names its own columns, never this one, and
-- every version it makes has no excerpt, which cards read as none.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."versions" ADD COLUMN "excerpt" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."versions" ADD CONSTRAINT "versions_excerpt_length" CHECK (char_length("app_artifacts"."versions"."excerpt") <= 1000) NOT VALID;
