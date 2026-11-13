-- Object files (docs/development/first-party-apps.md, "Object files";
-- services/objectFiles.ts): core's `object_files`, the files of first-party
-- objects (an image hung on one of an app's parts, stored under core's
-- `objects/` prefix of the app-content bucket, read through
-- `GET /api/objects/:kind/:id/files/:fileId`), and its first user: a publish
-- check's screenshots (`app_artifacts.version_checks`) become two file ids
-- instead of Artifacts' own keys and sizes.
--
-- version_checks: its flag is off and nothing writes a screenshot yet, so
-- its key columns get no copy. They are not dropped here: 0551 shipped in
-- v1.21.49, whose Artifact delete returns desktop_key and phone_key, so they
-- stay (NULL, undeclared in schema.ts) until the release after this one
-- (0581 restores them where an earlier copy of this migration dropped them).
--
-- object_files is new and empty; its foreign key takes a SHARE ROW EXCLUSIVE
-- lock on `servers`: give up after 5 s rather than queue behind a long
-- transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "object_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"parent" text,
	"state" text NOT NULL,
	"uploaded_by_type" text NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "object_files_state" CHECK ("object_files"."state" IN ('unclaimed', 'claimed', 'deleted')),
	CONSTRAINT "object_files_parent" CHECK ("object_files"."state" = 'deleted' OR ("object_files"."parent" IS NULL) = ("object_files"."state" = 'unclaimed')),
	CONSTRAINT "object_files_deleted_at" CHECK (("object_files"."deleted_at" IS NULL) = ("object_files"."state" <> 'deleted')),
	CONSTRAINT "object_files_uploaded_by_type" CHECK ("object_files"."uploaded_by_type" IN ('user', 'agent')),
	CONSTRAINT "object_files_content_type" CHECK ("object_files"."content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
	CONSTRAINT "object_files_size" CHECK ("object_files"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "object_files" ADD CONSTRAINT "object_files_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_object_files_object_parent" ON "object_files" USING btree ("object_kind","object_id","parent");--> statement-breakpoint
CREATE INDEX "idx_object_files_unclaimed_created" ON "object_files" USING btree ("created_at") WHERE "object_files"."state" = 'unclaimed';--> statement-breakpoint
CREATE INDEX "idx_object_files_deleted" ON "object_files" USING btree ("deleted_at") WHERE "object_files"."state" = 'deleted';--> statement-breakpoint
CREATE INDEX "idx_object_files_server" ON "object_files" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" DROP CONSTRAINT "version_checks_desktop_shot";--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" DROP CONSTRAINT "version_checks_phone_shot";--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD COLUMN "desktop_file_id" uuid;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD COLUMN "phone_file_id" uuid;--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD CONSTRAINT "version_checks_desktop_file" CHECK ("app_artifacts"."version_checks"."desktop_file_id" IS NULL OR "app_artifacts"."version_checks"."status" = 'done');--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD CONSTRAINT "version_checks_phone_file" CHECK ("app_artifacts"."version_checks"."phone_file_id" IS NULL OR "app_artifacts"."version_checks"."status" = 'done');
