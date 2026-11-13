-- Which personal assistant published an Artifact (#proj-assistant:#31;
-- apps/artifacts/publishAs.ts): set when the Artifact is made through an
-- assistant and never changed, null for every other Artifact. An assistant may
-- push a new version only to an Artifact that carries its own id here. The
-- author can't answer that: an assistant may publish as its owner.
--
-- Catalog-only on app_artifacts.items: a nullable column with no default
-- rewrites nothing and scans nothing under the ACCESS EXCLUSIVE lock. Every read
-- and push of an Artifact reads this table, so give up after 2 s (the deploy
-- retries) rather than queue them behind a long transaction.
--
-- No index: it is read from the item row a push has already found, never
-- searched by. No foreign key, as the table's other actor columns. No backfill:
-- no Artifact was published by an assistant before this.
--
-- Rolling deploy: an older replica names its own columns, never this one, and
-- the items it makes have none, which is right (it has no assistant publish).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "published_by_assistant_agent_id" uuid;
