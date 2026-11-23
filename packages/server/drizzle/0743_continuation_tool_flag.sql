-- The continuation answer tool (#wg-ax:#5, beside continuations_pilot_v0): a
-- Claude agent's managed MCP server also lists the daemon-local
-- `answer_continuation` tool, which runs the agent's own `cont <id> [choice]`
-- for it, and a paused command's text names that tool. Server-scoped,
-- default off, no rules: every agent keeps answering with `cont` in a shell
-- until FFA adds an allow rule. The Server sends it on `agent:start`
-- (`AgentConfig.continuationTool`); the daemon reads it at each launch.
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
	'continuation_tool_v0',
	'Continuation answer tool: Claude agents can answer a paused raft command with the answer_continuation MCP tool',
	true,
	false,
	'server',
	false,
	NULL,
	'continuation_tool_v0'
) ON CONFLICT ("key") DO NOTHING;
