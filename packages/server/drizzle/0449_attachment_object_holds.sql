-- Platform file storage step 2a: explicit holds on attachment_objects.
-- A row in attachment_object_holds says "this holder keeps these bytes alive"
-- (holder types today: a linked, non-revoked `attachment` row and a pending
-- `upload_reservation`). The new table starts empty; existing data gets its
-- holds from the batched, resumable backfill
--   pnpm --filter @botiverse/raft-server db:attachment-object-holds backfill
-- run after this release is deployed. Nothing deletes bytes on the basis of
-- holds in this release.
--
-- Locks: ADD COLUMN without a default is catalog-only (brief ACCESS EXCLUSIVE
-- on attachment_objects); the FK takes SHARE ROW EXCLUSIVE on attachment_objects
-- and validates only the new, empty table. No attachments table is touched.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "attachment_object_holds" (
	"holder_type" text NOT NULL,
	"holder_id" text NOT NULL,
	"object_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_object_holds_holder_type_holder_id_object_id_pk" PRIMARY KEY("holder_type","holder_id","object_id"),
	CONSTRAINT "attachment_object_holds_holder_type" CHECK ("attachment_object_holds"."holder_type" IN ('attachment', 'upload_reservation'))
);
--> statement-breakpoint
ALTER TABLE "attachment_objects" ADD COLUMN "unheld_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachment_object_holds" ADD CONSTRAINT "attachment_object_holds_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachment_object_holds_object" ON "attachment_object_holds" USING btree ("object_id");