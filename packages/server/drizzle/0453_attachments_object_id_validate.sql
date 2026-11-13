-- Platform file storage step 2c, part 2 of 3: validate the object_id CHECK
-- added NOT VALID by the previous migration. VALIDATE CONSTRAINT takes SHARE
-- UPDATE EXCLUSIVE on attachments: it scans the table while reads, inserts and
-- updates continue (it only conflicts with DDL, VACUUM and other VALIDATEs).
-- It fails, and the deploy stops before the new server starts, if any row
-- has a NULL object_id. Production check before deploy:
--   SELECT count(*) FROM attachments WHERE object_id IS NULL;   -- expect 0
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "attachments" VALIDATE CONSTRAINT "attachments_object_id_not_null";
