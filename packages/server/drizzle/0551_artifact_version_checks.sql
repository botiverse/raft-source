-- Publish check (task #proj-workspace:#130; docs/development/workspace-artifacts.md,
-- "Publish check"): `app_artifacts.version_checks`, at most one row per
-- version (its status, its screenshots' R2 keys and sizes, what it found),
-- going with its version (ON DELETE CASCADE, so with its item and server),
-- and the `artifact_publish_check_v0` flag row. A new, empty table behind a
-- new flag that is off, with no rules; no backfill (only pushes after the
-- flag is on record a check). Older server code never names it, so rolling
-- back leaves it unused. The foreign key takes a SHARE ROW EXCLUSIVE lock on
-- `versions`: give up after 5 s rather than queue a push behind a long
-- transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Server-scoped, default off, no rules: while off, nothing is checked.
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'artifact_publish_check_v0',
	'Publish check: screenshots and page errors of each pushed Artifact version',
	true,
	false,
	'server',
	false,
	NULL,
	'artifact_publish_check_v0'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE TABLE "app_artifacts"."version_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"desktop_key" text,
	"desktop_bytes" integer,
	"phone_key" text,
	"phone_bytes" integer,
	"findings" jsonb,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "version_checks_status" CHECK ("app_artifacts"."version_checks"."status" IN ('pending', 'running', 'done', 'failed', 'skipped')),
	CONSTRAINT "version_checks_skip_reason" CHECK (("app_artifacts"."version_checks"."status" = 'skipped') = ("app_artifacts"."version_checks"."skip_reason" IS NOT NULL) AND ("app_artifacts"."version_checks"."skip_reason" IS NULL OR "app_artifacts"."version_checks"."skip_reason" IN ('unchanged', 'server_daily_cap', 'platform_daily_cap'))),
	CONSTRAINT "version_checks_finished" CHECK (("app_artifacts"."version_checks"."finished_at" IS NULL) = ("app_artifacts"."version_checks"."status" IN ('pending', 'running'))),
	CONSTRAINT "version_checks_error_class" CHECK ("app_artifacts"."version_checks"."error_class" IS NULL OR "app_artifacts"."version_checks"."status" = 'failed'),
	CONSTRAINT "version_checks_desktop_shot" CHECK (("app_artifacts"."version_checks"."desktop_key" IS NULL) = ("app_artifacts"."version_checks"."desktop_bytes" IS NULL) AND ("app_artifacts"."version_checks"."desktop_key" IS NULL OR "app_artifacts"."version_checks"."status" = 'done')),
	CONSTRAINT "version_checks_phone_shot" CHECK (("app_artifacts"."version_checks"."phone_key" IS NULL) = ("app_artifacts"."version_checks"."phone_bytes" IS NULL) AND ("app_artifacts"."version_checks"."phone_key" IS NULL OR "app_artifacts"."version_checks"."status" = 'done')),
	CONSTRAINT "version_checks_findings" CHECK ("app_artifacts"."version_checks"."findings" IS NULL OR ("app_artifacts"."version_checks"."status" = 'done' AND octet_length("app_artifacts"."version_checks"."findings"::text) <= 65536))
);
--> statement-breakpoint
ALTER TABLE "app_artifacts"."version_checks" ADD CONSTRAINT "version_checks_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "app_artifacts"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_version_checks_version" ON "app_artifacts"."version_checks" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "idx_version_checks_created" ON "app_artifacts"."version_checks" USING btree ("created_at") WHERE "app_artifacts"."version_checks"."status" <> 'skipped';
