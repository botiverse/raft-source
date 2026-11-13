-- An Artifact's original message (xxchan, #proj-workspace:2e5a5da3,
-- docs/development/workspace-artifacts.md): `app_artifacts.items`
-- `origin_message_id`, the message through which it entered a conversation
-- (saved from its attachment, or the first share's message), and
-- `origin_via`, how. Set once and never moved. Only an app_artifacts table,
-- behind workspace_artifacts_v0.
--
-- No foreign key to public.messages (Tenny, review of #11613): adding one
-- would lock messages until this transaction commits, and core's message
-- deletes would depend on an app table. A deleted message leaves the id
-- dangling; readers never show it. The backfill only reads core's
-- attachments (a plain join), so nothing in public is locked against writes.
--
-- Bounded lock wait: the columns, checks and backfill lock
-- app_artifacts.items (one row per Artifact) briefly; give up after 5s (the
-- deploy retries) rather than queue its writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "origin_message_id" uuid;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "origin_via" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_origin_via" CHECK ("app_artifacts"."items"."origin_via" IS NULL OR "app_artifacts"."items"."origin_via" IN ('attachment', 'share'));--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_origin_message_via" CHECK ("app_artifacts"."items"."origin_message_id" IS NULL OR "app_artifacts"."items"."origin_via" IS NOT NULL);--> statement-breakpoint
-- Backfill: an Artifact saved from an attachment came in through that
-- attachment's message (the earliest save when several name it).
UPDATE "app_artifacts"."items" AS i
SET "origin_message_id" = s."message_id", "origin_via" = 'attachment'
FROM (
  SELECT DISTINCT ON (saves."item_id") saves."item_id", a."message_id"
  FROM "app_artifacts"."attachment_saves" AS saves
  JOIN "public"."attachments" AS a ON a."id" = saves."attachment_id"
  WHERE a."message_id" IS NOT NULL
  ORDER BY saves."item_id", saves."created_at", saves."attachment_id"
) AS s
WHERE i."id" = s."item_id" AND i."origin_via" IS NULL;
