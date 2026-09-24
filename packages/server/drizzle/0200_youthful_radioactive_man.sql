ALTER TABLE "attachments" ADD COLUMN "message_position" integer;
--> statement-breakpoint
-- Rolling phase 1: preserve availability for old writers, then give every
-- already-linked row a deterministic (not fidelity-claiming) ordinal.
WITH "ranked_attachments" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "message_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) - 1 AS "message_position"
  FROM "attachments"
  WHERE "message_id" IS NOT NULL
)
UPDATE "attachments"
SET "message_position" = "ranked_attachments"."message_position"
FROM "ranked_attachments"
WHERE "attachments"."id" = "ranked_attachments"."id"
  AND "attachments"."message_position" IS NULL;
-- Phase 2 intentionally follows only after all old writers are retired:
-- validate linked rows have positions, then add the partial unique
-- (message_id, message_position) index.
