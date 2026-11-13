-- schema-snapshot: unchanged (schema.ts does not declare the four columns: version_checks_keep_shot_columns kept them outside it for one release)
-- app_artifacts.version_checks drops its old screenshot columns, the release
-- after the one that kept them (task #proj-workspace:#159;
-- version_checks_keep_shot_columns says why they stayed). desktop_file_id and
-- phone_file_id hold the screenshots. Nothing has read or written these four
-- since then, neither v1.21.55 nor v1.21.56, the rollback targets: schema.ts
-- does not declare them, and no raw SQL names them.
--
-- IF EXISTS: a database made from another history may not have them. Their
-- old CHECKs went with object_files. Catalog only, no rewrite, but ACCESS
-- EXCLUSIVE: an Artifact card page and the publish check read this table, so
-- give up after 2s (the deploy retries) rather than queue them behind a long
-- transaction. One statement, so the lock is taken once.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks"
  DROP COLUMN IF EXISTS "desktop_key",
  DROP COLUMN IF EXISTS "desktop_bytes",
  DROP COLUMN IF EXISTS "phone_key",
  DROP COLUMN IF EXISTS "phone_bytes";
