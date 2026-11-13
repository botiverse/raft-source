-- Drafts (artin, #triage:#127): the web sidebar row beside Saved that lists
-- every unsent composer draft and opens it where it was typed. Server-scoped,
-- default off; on for the botiverse and raft servers only, to try it before a
-- wider rollout. Drafts themselves keep being stored either way (per device,
-- in the browser): the flag gates only the row and its page.
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt",
	"pre_auth_evaluable"
) VALUES (
	'drafts_section_v0',
	'Drafts: the web sidebar row beside Saved listing unsent composer drafts',
	true,
	false,
	'server',
	false,
	NULL,
	'drafts_section_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
WITH allowlist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" IN ('botiverse', 'raft')
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
	'a22df6a4-c4c9-4cd8-8861-afaafe130f2c',
	'drafts_section_v0',
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
