-- Platform file storage step 2c, part 3 of 3: object_id NOT NULL. The CHECK
-- validated by the previous migration proves no row is NULL, so SET NOT NULL
-- skips the table scan (PostgreSQL 12+) and, like dropping the now redundant
-- CHECK, only changes the catalog (brief ACCESS EXCLUSIVE, no rewrite).
--
-- The application model (schema.ts) no longer declares the legacy physical
-- columns or idx_attachments_content_hash, so drizzle-kit generated their
-- DROP here; they are deliberately kept for one release (nullable, unwritten:
-- see the first part) and dropped by a later migration, so the previous
-- release's code, which still names them, keeps working during the rollout
-- and on rollback.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "object_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_object_id_not_null";
