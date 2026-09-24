CREATE TABLE "feature_flag_config_versions" (
	"scope" text PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"last_audit_event_id" text,
	CONSTRAINT "feature_flag_config_versions_scope_valid" CHECK ("feature_flag_config_versions"."scope" = 'global'),
	CONSTRAINT "feature_flag_config_versions_version_nonnegative" CHECK ("feature_flag_config_versions"."version" >= 0)
);
