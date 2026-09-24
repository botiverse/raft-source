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
	'mobile_push_delivery_v0',
	'Mobile push delivery gate; the kill switch suppresses provider calls while preserving inbox facts and terminal outbox receipts',
	true,
	false,
	'server',
	true,
	NULL,
	'mobile_push_delivery_v0'
) ON CONFLICT ("key") DO NOTHING;
