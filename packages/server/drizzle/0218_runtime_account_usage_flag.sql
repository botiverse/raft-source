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
	'runtime_account_usage_v0',
	'Private Computer runtime OAuth account health and provider usage summaries; initial botiverse and slock-android allowlist',
	true,
	false,
	'server',
	false,
	NULL,
	'runtime_account_usage_v0'
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
WITH allowlist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" IN ('botiverse', 'slock-android')
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
	'4ec35023-e944-478a-8f83-3f41651fe30c',
	'runtime_account_usage_v0',
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
