-- Mobile app download entry (Settings section, Help signpost, QR, chooser).
--
-- Scoped to Botiverse first (@huxijin, #wg-download-mobile): the artifacts are
-- a TestFlight beta and an Android build, so the entry should not appear on
-- every server at once.
--
-- Mirrors 0218_runtime_account_usage_flag: the allowlist is resolved from the
-- servers table by slug at migration time rather than hardcoding an id, so this
-- is correct in every environment and a no-op where the slug does not exist.
--
-- `default_enabled` stays false: without a matching rule a server gets nothing.
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
	'mobile_download_v0',
	'Mobile app download entry: Settings section, Help signpost, QR and platform chooser; initial botiverse allowlist',
	true,
	false,
	'server',
	false,
	NULL,
	'mobile_download_v0'
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
WITH allowlist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" IN ('botiverse')
		AND "deleted_at" IS NULL
)
INSERT INTO "feature_flag_rules" (
	"id",
	"flag_key",
	"stage",
	"priority",
	"decision",
	"values",
	"percentage_basis_points",
	"variant"
)
SELECT
	'1dc1ec60-e1d4-4325-bff5-95615af7a2cf',
	'mobile_download_v0',
	'server',
	0,
	'allow',
	"server_ids",
	NULL,
	NULL
FROM allowlist
WHERE jsonb_array_length("server_ids") > 0
ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"updated_at" = now();
