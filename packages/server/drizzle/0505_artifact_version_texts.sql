-- Public Artifacts' readable text (task #110, Tenny's decisions;
-- docs/development/workspace-artifacts.md): `app_artifacts.version_texts`,
-- one row per version of a public Artifact, so the signed-out `meta` and
-- `index.md` answer without reading object storage. A new, empty table, only
-- app_artifacts, behind workspace_artifacts_v0; no backfill (the first
-- signed-out view of each version fills its row). Older server code never
-- names it, so rolling back leaves it unused. The foreign key takes a SHARE
-- ROW EXCLUSIVE lock on `versions`: give up after 5 s rather than queue a
-- push behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "app_artifacts"."version_texts" (
	"version_id" text PRIMARY KEY NOT NULL,
	"extractor" smallint NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"truncated" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_texts_description_length" CHECK (char_length("app_artifacts"."version_texts"."description") <= 1000),
	CONSTRAINT "version_texts_body_length" CHECK (octet_length("app_artifacts"."version_texts"."body") <= 262144)
);
--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_texts" ADD CONSTRAINT "version_texts_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "app_artifacts"."versions"("id") ON DELETE cascade ON UPDATE no action;