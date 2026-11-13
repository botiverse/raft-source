-- Platform file storage step 2c, part B: drop the legacy physical copies on
-- `attachments` (mime_type, size_bytes, storage_key, thumbnail_key,
-- content_hash, width, height) and idx_attachments_content_hash.
--
-- Part A (0452_attachments_legacy_physical_nullable through
-- 0454_attachments_object_id_not_null, shipped in v1.21.36) made them nullable,
-- stopped every writer and removed them from schema.ts, so no release since
-- then selects, inserts or updates them; the physical metadata lives only on
-- attachment_objects. The release running while this applies (v1.21.38) does
-- not name them, and neither does a rollback to any release from v1.21.36 on.
-- 0454 (object_id NOT NULL) runs before this one, so a database that still has
-- an attachment without an object stops at 0453 and never loses the only copy
-- of its metadata here.
--
-- schema-snapshot: unchanged (part A already removed the columns and the index
-- from schema.ts, so every snapshot since 0454 lacks them)
--
-- Locks: DROP COLUMN only marks the column dropped in the catalog and DROP
-- INDEX removes a catalog entry and its file: a brief ACCESS EXCLUSIVE on
-- attachments, no scan, no rewrite (the space comes back as rows are
-- rewritten). DROP COLUMN content_hash would drop the index too; it is named
-- so the intent is explicit, IF EXISTS for databases that never had it. The
-- lock wait is bounded so a long transaction makes the deploy retry instead
-- of queueing attachment reads behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DROP INDEX IF EXISTS "idx_attachments_content_hash";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "mime_type";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "size_bytes";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "storage_key";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "thumbnail_key";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "content_hash";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "width";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "height";
