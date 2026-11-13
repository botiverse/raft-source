-- Agent read progress (agentReadProgressService.ts, contract in
-- packages/shared/src/agentReadProgress.ts): the web shows each agent's avatar
-- on the last message it has read and moves it live, from frames sent only to
-- the connections viewing the conversation. Server-scoped, default off, no
-- rules: while off a `read_progress:watch` is refused and nothing is pushed.
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
	'agent_read_progress_v0',
	'Agent read progress: live agent read positions for the viewers of a conversation',
	true,
	false,
	'server',
	false,
	NULL,
	'agent_read_progress_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
