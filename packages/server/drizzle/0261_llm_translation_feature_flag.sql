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
	'llm_translation_v0',
	'Gate server-side OpenAI-compatible translation to Pro plans',
	true,
	false,
	'server',
	false,
	NULL,
	'llm_translation_v0'
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "feature_flag_rules" (
	"id",
	"flag_key",
	"stage",
	"priority",
	"decision",
	"values",
	"percentage_basis_points",
	"variant"
) VALUES (
	'0d4a704c-b5b6-4c55-98f4-2f7c2ecb9e0a',
	'llm_translation_v0',
	'plan',
	0,
	'allow',
	'["pro"]'::jsonb,
	NULL,
	NULL
) ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"updated_at" = now();
