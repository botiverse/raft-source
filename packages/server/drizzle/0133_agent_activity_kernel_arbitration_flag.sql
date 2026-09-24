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
	'agent_activity_kernel_arbitration_v0',
	'Default-dark rollout gate for kernel-arbitrated agent activity serving-map writes',
	true,
	false,
	'server',
	false,
	NULL,
	'agent_activity_kernel_arbitration_v0'
) ON CONFLICT ("key") DO NOTHING;
