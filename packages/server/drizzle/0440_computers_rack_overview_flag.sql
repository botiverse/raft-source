-- Computers overview, rack layout (#proj-uiux, direction C-A): every computer
-- as one row with its agents as avatar slots. Server-scoped, default off: the
-- Computers page stays as it is until FFA adds an allow rule.
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
	'computers_rack_overview_v0',
	'Computers overview in the rack layout: one row per computer with its agents as slots',
	true,
	false,
	'server',
	false,
	NULL,
	'computers_rack_overview_v0'
) ON CONFLICT ("key") DO NOTHING;
