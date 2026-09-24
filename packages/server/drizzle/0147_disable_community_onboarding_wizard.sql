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
	'onboarding_owner_wizard_v0',
	'Owner onboarding wizard display gate',
	true,
	false,
	'server',
	true,
	NULL,
	'onboarding_owner_wizard_v0'
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
WITH denylist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" IN ('community', 'community-cn')
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
	'6eb3f9fa-aa8e-4217-b472-3025423b8598',
	'onboarding_owner_wizard_v0',
	'server',
	0,
	'deny',
	"server_ids",
	NULL,
	NULL
FROM denylist
WHERE jsonb_array_length("server_ids") > 0
ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"updated_at" = now();
