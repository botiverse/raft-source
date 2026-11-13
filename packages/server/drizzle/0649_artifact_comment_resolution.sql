-- Resolvable comment threads (#proj-workspace:#249; apps/artifacts/
-- resolutions.ts): a thread's root comment records when it was resolved and by
-- whom, the actor as the comment's own author is stored (a type and an id, no
-- foreign key: actors are polymorphic, resolved live). All three or none, and
-- only on a root (`reply_to` NULL): a reply is never resolved. A resolve's
-- optional note is a reply in the thread, so no text column.
--
-- Catalog-only on app_artifacts.comments: nullable columns with no default
-- rewrite nothing, and the CHECK is added NOT VALID, so nothing is scanned
-- under the ACCESS EXCLUSIVE lock; it binds new and updated rows from now on.
-- It stays NOT VALID, as versions_excerpt_blocks_shape does: the columns are
-- new, so every existing row has all three NULL and nothing needs validating.
-- Comment lists and writes read this table, so give up after 2 s (the deploy
-- retries) rather than queue them behind a long transaction.
--
-- No backfill: every existing thread is open.
--
-- Rolling deploy: an older replica names its own columns, never these. It
-- doesn't clear a resolution when it writes a reply, so a thread resolved on a
-- new replica and answered on an old one stays resolved until reopened; the
-- window is the deploy's.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD COLUMN "resolved_by_type" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD COLUMN "resolved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD CONSTRAINT "comments_resolution" CHECK (("app_artifacts"."comments"."resolved_at" IS NULL AND "app_artifacts"."comments"."resolved_by_type" IS NULL AND "app_artifacts"."comments"."resolved_by_id" IS NULL) OR ("app_artifacts"."comments"."resolved_at" IS NOT NULL AND "app_artifacts"."comments"."resolved_by_type" IN ('user', 'agent') AND "app_artifacts"."comments"."resolved_by_id" IS NOT NULL AND "app_artifacts"."comments"."reply_to" IS NULL)) NOT VALID;
