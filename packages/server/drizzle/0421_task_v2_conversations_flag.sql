-- Task v2 conversations (#wg-task-v2): tasks created with their own lazily
-- created conversation (no message in the channel) and tasks.source_message_id. Server-scoped, default off: every server
-- keeps the pre-v2 visible task message until FFA adds an allow rule
-- (/botiverse and /raft first, after release).
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
	'task_v2_conversations_v0',
	'Task v2: new tasks get their own conversation (nothing posted in the channel) and may be created from messages',
	true,
	false,
	'server',
	false,
	NULL,
	'task_v2_conversations_v0'
) ON CONFLICT ("key") DO NOTHING;
