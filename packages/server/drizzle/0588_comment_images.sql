-- Images in Artifact comments (docs/development/first-party-apps.md, "Object
-- files"; apps/artifacts/commentImages.ts): core's object_files keep each
-- image's pixel size, read from its header when it is stored (null for the
-- files stored before: a publish check's screenshots), and an Artifact
-- comment or review draft keeps its images (`images`, core's metadata of
-- each, in order; none for every existing row).
--
-- Additive only: nullable columns and columns with a constant default
-- rewrite no rows; the CHECK reads object_files once (a few screenshots per
-- Artifact). Bounded lock wait: give up after 5 s (the deploy retries)
-- rather than queue writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "object_files" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "object_files" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comment_drafts" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "object_files" ADD CONSTRAINT "object_files_dimensions" CHECK (("object_files"."width" IS NULL) = ("object_files"."height" IS NULL) AND ("object_files"."width" IS NULL OR ("object_files"."width" > 0 AND "object_files"."height" > 0)));