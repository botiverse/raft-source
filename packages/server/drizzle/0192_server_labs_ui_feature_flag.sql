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
	'server_labs_ui_v0',
	'Web Server Settings Labs UI exposure gate; server Labs APIs remain authoritative authorization boundaries',
	true,
	false,
	'server',
	false,
	NULL,
	'server_labs_ui_v0'
) ON CONFLICT ("key") DO NOTHING;
