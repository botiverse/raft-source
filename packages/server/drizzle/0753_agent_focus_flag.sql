-- Focus, part 1 (flag for the state, the agent API and `raft focus` /
-- `raft unfocus`): an agent keeps up to three conversations (a thread, a DM
-- or a task conversation) in focus, stored in agent_focus_targets.
-- Server-scoped, default off, no rules: the routes answer 404
-- AGENT_FOCUS_DISABLED until FFA adds an allow rule. Delivery does not read
-- the state yet (the daemon half comes later), so staging's default-on keeps
-- it off too (FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS).
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
	'agent_focus_v0',
	'Focus: an agent keeps up to three threads, DMs or task conversations in focus with raft focus and raft unfocus',
	true,
	false,
	'server',
	false,
	NULL,
	'agent_focus_v0'
) ON CONFLICT ("key") DO NOTHING;
