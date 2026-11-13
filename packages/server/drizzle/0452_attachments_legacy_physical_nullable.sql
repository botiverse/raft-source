-- Platform file storage step 2c, part 1 of 3 (PR A): stop writing the legacy
-- physical copies on `attachments` and make object_id required.
--
-- Since step 2b every reader takes mime_type, size_bytes, storage_key,
-- thumbnail_key, content_hash, width and height only from attachment_objects;
-- the writers of this release stop copying them onto `attachments`, so the
-- three NOT NULL ones become nullable. The columns stay (the previous release
-- still writes them during the rollout); a later release drops them once no
-- running code names them. Existing values are left as they are.
--
-- object_id becomes required in three steps so no scan runs under an ACCESS
-- EXCLUSIVE lock on this large table (every release since the object backfill
-- sets object_id; production has 0 NULL rows):
--   this migration   CHECK (object_id IS NOT NULL) NOT VALID: enforced for new
--                    and updated rows from now on, no scan;
--   next migration   VALIDATE CONSTRAINT: scans under SHARE UPDATE EXCLUSIVE,
--                    which reads and writes do not wait for;
--   last migration   SET NOT NULL, which PostgreSQL proves from the validated
--                    CHECK without a scan, then drops the CHECK.
-- Each migration is its own transaction (src/db/migrationPhases.ts).
--
-- Locks here: DROP NOT NULL and ADD CONSTRAINT ... NOT VALID are catalog-only
-- (brief ACCESS EXCLUSIVE on attachments, no rewrite, no scan). The lock wait
-- is bounded so a long transaction makes the deploy retry instead of queueing
-- attachment reads behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "mime_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "size_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "storage_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_object_id_not_null" CHECK ("attachments"."object_id" IS NOT NULL) NOT VALID;
