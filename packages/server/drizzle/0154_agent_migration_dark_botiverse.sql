WITH botiverse AS (
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
	'ff7353c3-12ea-4e4c-bacd-1346cf3fa8df',
	'agent_migration_v0',
	'server',
	-10,
	'deny',
	"server_ids",
	NULL,
	NULL
FROM botiverse
WHERE jsonb_array_length("server_ids") > 0
ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"priority" = EXCLUDED."priority",
	"decision" = EXCLUDED."decision",
	"updated_at" = now();
