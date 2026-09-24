-- Typed Computer/App references in the Web composer and message pipeline.
--
-- Initial rollout is restricted to the two servers named by @artin. Resolve
-- slugs to ids at migration time so the same migration remains correct in
-- every environment and stays fail-closed where neither server exists.
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
	'composer_resource_references_v0',
	'Composer Computer and App typed references; initial botiverse and slock-android allowlist',
	true,
	false,
	'server',
	false,
	NULL,
	'composer_resource_references_v0'
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
	'8c22d77e-e88b-44b1-a125-10ed5861144b',
	'composer_resource_references_v0',
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
