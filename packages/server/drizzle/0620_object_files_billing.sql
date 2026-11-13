-- Who pays for an object file (services/objectFiles.ts; task #184): until now every file counted against the object's
-- own server (`server_id`), so a joint channel's member of another server
-- filled the host's total and spent the host's monthly upload quota.
--   billed_server_id  the server the bytes count against: the uploader's own
--                     server for what people and agents upload, the object's
--                     server for what the platform makes. Fixed at upload.
--                     NULL means `server_id`: rows from before, and rows an
--                     older build writes during the rolling deploy, so every
--                     read is coalesce(billed_server_id, server_id).
--   quota             how putObjectFile counted it: 'monthly' (an upload) or
--                     'exempt' (the platform's own: a publish check's
--                     screenshots, under no cap). NULL (before): an upload.
--   quota_month       the UTC month whose monthly file upload quota counted
--                     the bytes (NULL: none did), so the sweep can give an
--                     unclaimed upload's bytes back to that month once.
--
-- Nullable columns with no default: catalog only, no rewrite, no scan. No
-- foreign key from billed_server_id to servers: adding one would take a SHARE
-- ROW EXCLUSIVE lock on `servers`, which every request reads; servers are
-- only ever soft-deleted, so the id always names a row. The CHECK is NOT VALID
-- (no scan: every existing value is NULL; new rows are checked as written).
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock on object_files for the catalog
-- change only: give up after 2 s rather than queue reads behind a long
-- transaction. Backfill: 0621; the index: 0622.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "object_files" ADD COLUMN "billed_server_id" uuid;--> statement-breakpoint
ALTER TABLE "object_files" ADD COLUMN "quota" text;--> statement-breakpoint
ALTER TABLE "object_files" ADD COLUMN "quota_month" text;--> statement-breakpoint
ALTER TABLE "object_files" ADD CONSTRAINT "object_files_quota" CHECK ("object_files"."quota" IS NULL OR "object_files"."quota" IN ('monthly', 'exempt')) NOT VALID;
