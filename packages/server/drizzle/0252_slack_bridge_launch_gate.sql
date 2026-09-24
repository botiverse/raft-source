-- Slack Bridge flags are operator-owned and fail closed. Rows are seeded
-- idempotently, without allow rules, so an existing operator decision is never
-- overwritten and rollout still requires the audited feature-flag writer.
--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES
	('external_projection_directory', 'External projection directory for provider bridges', true, false, 'server', false, NULL, 'external_projection_directory'),
	('slack_binding_control_plane', 'Slack Bridge binding control plane', true, false, 'server', false, NULL, 'slack_binding_control_plane'),
	('slack_outbound_enqueue', 'Slack Bridge outbound enqueue', true, false, 'server', false, NULL, 'slack_outbound_enqueue'),
	('slack_provider_dispatch', 'Slack Bridge provider dispatch', true, false, 'server', false, NULL, 'slack_provider_dispatch'),
	('slack_custom_authorship', 'Slack Bridge customized authorship', true, false, 'server', false, NULL, 'slack_custom_authorship'),
	('slack_native_mentions', 'Slack Bridge native mention rendering', true, false, 'server', false, NULL, 'slack_native_mentions'),
	('slack_thread_delivery', 'Slack Bridge thread delivery', true, false, 'server', false, NULL, 'slack_thread_delivery'),
	('slack_private_binding', 'Slack Bridge private channel bindings', true, false, 'server', false, NULL, 'slack_private_binding'),
	('slack_event_ingress', 'Slack Bridge signed event ingress', true, false, 'server', false, NULL, 'slack_event_ingress'),
	('slack_inbound_projection', 'Slack Bridge inbound projection', true, false, 'server', false, NULL, 'slack_inbound_projection'),
	('slack_bridge_v0', 'Whole Slack Bridge launch and rollback gate', true, false, 'server', false, NULL, 'slack_bridge_v0')
ON CONFLICT ("key") DO NOTHING;
