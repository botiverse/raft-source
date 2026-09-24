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
	'read_receipts_v0',
	'Read receipts rollout gate',
	true,
	false,
	'server',
	false,
	NULL,
	'read_receipts_v0'
) ON CONFLICT ("key") DO NOTHING;
