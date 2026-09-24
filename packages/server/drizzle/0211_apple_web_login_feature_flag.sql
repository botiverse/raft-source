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
	'apple_web_login_v0',
	'Apple web sign-in and account linking; requires an explicit platform=web allow rule while default and mobile stay fail-closed',
	true,
	false,
	'user',
	false,
	NULL,
	'apple_web_login_v0'
) ON CONFLICT ("key") DO NOTHING;
